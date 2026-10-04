// FL Studio project (.flp) reader / writer.
//
// File layout: "FLhd" u32 len(6) { i16 format, u16 channel count, u16 PPQ } "FLdt" u32 len { events }.
// Event ids: 0-63 one byte of data, 64-127 two bytes, 128-191 four bytes, 192-255 a varint length
// (7 bits per byte, LSB first) followed by that many bytes. All little-endian.
// Exception seen in FL Studio 2026 (26.1.6) files: event 0xAC carries 3 bytes, not 4.

export interface FlpEvent { id: number; data: Uint8Array }
export interface Flp { format: number; channels: number; ppq: number; events: FlpEvent[] }

export const FLP = {
  // byte
  Looped: 26,
  // word
  NewChannel: 64, NewPattern: 65, Tempo: 66, CurrentPattern: 67, ChannelType: 85, PPQ: 80,
  // dword
  FineTempo: 156, PatternLength: 164,
  // text / data
  ChannelName: 192 + 11, // TEXT+11 (old) ; FL 2023+ uses 203 = plugin display name
  PatternName: 193, Title: 194, Version: 199,
  PluginName: 201, // TEXT+9: internal plugin name ("Fruity Wrapper")
  PluginData: 213, // DATA+5: plugin state (wrapper chunk for VST/CLAP)
  PatternControllers: 223, PatternNotes: 224,
  Playlist: 233,
} as const;

const ODD_SIZES: Record<number, number> = { 0xac: 3 };

function u32(b: Uint8Array, o: number) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8); }
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function parseFlp(buf: Uint8Array): Flp {
  if (ascii(buf, 0, 4) !== 'FLhd') throw new Error('FLPではありません (FLhd がない)');
  const hlen = u32(buf, 4);
  const format = (u16(buf, 8) << 16) >> 16, channels = u16(buf, 10), ppq = u16(buf, 12);
  let p = 8 + hlen;
  if (ascii(buf, p, 4) !== 'FLdt') throw new Error('FLPではありません (FLdt がない)');
  const dlen = u32(buf, p + 4);
  p += 8;
  const end = Math.min(buf.length, p + dlen);
  const events: FlpEvent[] = [];
  while (p < end) {
    const id = buf[p++];
    let n: number;
    if (id in ODD_SIZES) n = ODD_SIZES[id];
    else if (id < 64) n = 1;
    else if (id < 128) n = 2;
    else if (id < 192) n = 4;
    else { n = 0; let sh = 0, b: number; do { b = buf[p++]; n |= (b & 127) << sh; sh += 7; } while (b & 128); }
    events.push({ id, data: buf.slice(p, p + n) });
    p += n;
  }
  return { format, channels, ppq, events };
}

export function writeFlp(f: Flp): Uint8Array {
  const parts: number[] = [];
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (const e of f.events) {
    const head: number[] = [e.id];
    if (e.id >= 192) { let n = e.data.length; do { let b = n & 127; n >>>= 7; if (n) b |= 128; head.push(b); } while (n); }
    else {
      const want = ODD_SIZES[e.id] ?? (e.id < 64 ? 1 : e.id < 128 ? 2 : 4);
      if (e.data.length !== want) throw new Error(`FLP event ${e.id}: ${e.data.length} bytes (expected ${want})`);
    }
    const h = Uint8Array.from(head);
    chunks.push(h, e.data);
    size += h.length + e.data.length;
  }
  void parts;
  const out = new Uint8Array(22 + size);
  const dv = new DataView(out.buffer);
  out.set([0x46, 0x4c, 0x68, 0x64], 0); dv.setUint32(4, 6, true);
  dv.setInt16(8, f.format, true); dv.setUint16(10, f.channels, true); dv.setUint16(12, f.ppq, true);
  out.set([0x46, 0x4c, 0x64, 0x74], 14); dv.setUint32(18, size, true);
  let p = 22;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export const evWord = (id: number, v: number): FlpEvent => ({ id, data: Uint8Array.of(v & 255, (v >> 8) & 255) });
export const evDword = (id: number, v: number): FlpEvent => {
  const d = new Uint8Array(4); new DataView(d.buffer).setUint32(0, v >>> 0, true); return { id, data: d };
};
export const evU8 = (id: number, v: number): FlpEvent => ({ id, data: Uint8Array.of(v & 255) });
/** FL 11.5+ stores text as UTF-16LE with a terminating 0. */
export function evText(id: number, s: string): FlpEvent {
  const d = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); d[i * 2] = c & 255; d[i * 2 + 1] = c >> 8; }
  return { id, data: d };
}
export function readText(e: FlpEvent): string {
  let s = '';
  for (let i = 0; i + 1 < e.data.length; i += 2) { const c = e.data[i] | (e.data[i + 1] << 8); if (!c) break; s += String.fromCharCode(c); }
  return s;
}

/** One piano-roll note as stored in a PatternNotes event (24 bytes). */
export interface FlpNote {
  pos: number; len: number; key: number; vel: number; channel: number;
  pan?: number; fine?: number; release?: number; midiCh?: number; modX?: number; modY?: number; flags?: number; group?: number;
}
export function encodeNotes(notes: FlpNote[]): Uint8Array {
  const d = new Uint8Array(notes.length * 24);
  const dv = new DataView(d.buffer);
  notes.forEach((n, i) => {
    const o = i * 24;
    dv.setUint32(o, n.pos, true);
    dv.setUint16(o + 4, n.flags ?? 0x4000, true);
    dv.setUint16(o + 6, n.channel, true);
    dv.setUint32(o + 8, n.len, true);
    dv.setUint16(o + 12, n.key, true);
    dv.setUint16(o + 14, n.group ?? 0, true);
    d[o + 16] = n.fine ?? 120;
    d[o + 17] = 0;
    d[o + 18] = n.release ?? 64;
    d[o + 19] = n.midiCh ?? 0;
    d[o + 20] = n.pan ?? 64;
    d[o + 21] = n.vel;
    d[o + 22] = n.modX ?? 128;
    d[o + 23] = n.modY ?? 128;
  });
  return d;
}
export function decodeNotes(d: Uint8Array): FlpNote[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out: FlpNote[] = [];
  for (let o = 0; o + 24 <= d.length; o += 24) {
    out.push({
      pos: dv.getUint32(o, true), flags: dv.getUint16(o + 4, true), channel: dv.getUint16(o + 6, true),
      len: dv.getUint32(o + 8, true), key: dv.getUint16(o + 12, true), group: dv.getUint16(o + 14, true),
      fine: d[o + 16], release: d[o + 18], midiCh: d[o + 19], pan: d[o + 20], vel: d[o + 21], modX: d[o + 22], modY: d[o + 23],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SMF reader (only what the FLP builder needs)

export interface SmfTrack { name: string; events: { tick: number; bytes: number[] }[] }
export function readSmf(b: Uint8Array): { division: number; tracks: SmfTrack[] } {
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (ascii(b, 0, 4) !== 'MThd') throw new Error('MIDIではありません');
  const ntr = (b[10] << 8) | b[11], division = (b[12] << 8) | b[13];
  let p = 8 + be32(4);
  const tracks: SmfTrack[] = [];
  for (let t = 0; t < ntr && p < b.length; t++) {
    const len = be32(p + 4), end = p + 8 + len;
    let q = p + 8, tick = 0, run = 0, name = '';
    const events: SmfTrack['events'] = [];
    const vl = () => { let v = 0, x: number; do { x = b[q++]; v = (v << 7) | (x & 127); } while (x & 128); return v; };
    while (q < end) {
      tick += vl();
      let st = b[q];
      if (st & 0x80) q++; else st = run;
      if (st === 0xff) {
        const type = b[q++], n = vl();
        const data = Array.from(b.subarray(q, q + n)); q += n;
        if (type === 0x03 && !name) name = new TextDecoder().decode(Uint8Array.from(data));
        events.push({ tick, bytes: [0xff, type, ...data] });
      } else if (st === 0xf0 || st === 0xf7) { const n = vl(); q += n; }
      else {
        run = st;
        const n = (st & 0xf0) === 0xc0 || (st & 0xf0) === 0xd0 ? 1 : 2;
        events.push({ tick, bytes: [st, ...Array.from(b.subarray(q, q + n))] }); q += n;
      }
    }
    tracks.push({ name, events });
    p = end;
  }
  return { division, tracks };
}

// ---------------------------------------------------------------------------------------------
// Building a project from a template (8 x OPM68 "FM A".."FM H" + optional "ADPCM" channel)

export interface FlpBuildInput {
  template: Uint8Array;
  /** The converter's SMF (OPM68 mode). */
  midi: Uint8Array;
  /** .opm text per FM channel letter (A-H). */
  banks: Record<string, string>;
  title?: string;
  /** File stem for the bank names shown in OPM68 (e.g. "kna14"). */
  name?: string;
  /** MIDI velocity -> FL note velocity (FL keeps 0..128 and imports MIDI 1..127 unchanged). FL sends it to
   *  plugins as value/128; OPM68 0.6+ recovers the value exactly (plugin/opm68/dpf-velocity.patch). */
  velocity?: (v: number) => number;
}
export interface FlpBuildResult { flp: Uint8Array; warnings: string[]; notes: number; ppq: number }

const OPM68_ID = 'jp.mdxpcm2midi.opm68';

const FM_LETTERS = 'ABCDEFGH';

/** FL wrapper chunk: 24-byte header, then records { u32 id, u64 length, data }. */
function wrapperRecords(d: Uint8Array): { id: number; start: number; data: Uint8Array }[] | null {
  if (d.length < 24) return null;
  const out: { id: number; start: number; data: Uint8Array }[] = [];
  let p = 24;
  while (p + 12 <= d.length) {
    const id = u32(d, p), n = u32(d, p + 4) + u32(d, p + 8) * 2 ** 32;
    if (p + 12 + n > d.length) return null;
    out.push({ id, start: p, data: d.subarray(p + 12, p + 12 + n) });
    p += 12 + n;
  }
  return p === d.length ? out : null;
}
function setWrapperRecord(d: Uint8Array, id: number, data: Uint8Array): Uint8Array {
  const recs = wrapperRecords(d)!;
  const parts: Uint8Array[] = [d.subarray(0, 24)];
  for (const r of recs) {
    const body = r.id === id ? data : r.data;
    const h = new Uint8Array(12); const dv = new DataView(h.buffer);
    dv.setUint32(0, r.id, true); dv.setUint32(4, body.length, true);
    parts.push(h, body);
  }
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let p = 0; for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}
/** Replace the "bankdata"/"bankfile" values of a DPF state blob (keeps parameters and the 4-byte prefix). */
function setDpfBank(state: Uint8Array, bankText: string, bankFile: string): Uint8Array | null {
  const enc = new TextEncoder();
  const begin = enc.encode('__dpf_state_begin__\0'), endMark = enc.encode('__dpf_state_end__\0');
  const find = (pat: Uint8Array, from = 0) => {
    outer: for (let i = from; i + pat.length <= state.length; i++) { for (let j = 0; j < pat.length; j++) if (state[i + j] !== pat[j]) continue outer; return i; }
    return -1;
  };
  const b = find(begin), e = find(endMark);
  if (b < 0 || e < 0) return null;
  // key\0value\0 pairs between the markers
  const pairs: [string, string][] = [];
  const dec = new TextDecoder();
  let p = b + begin.length;
  const z = (from: number) => { let i = from; while (i < e && state[i] !== 0) i++; return i; };
  while (p < e) { const k1 = z(p); const v1 = z(k1 + 1); pairs.push([dec.decode(state.subarray(p, k1)), dec.decode(state.subarray(k1 + 1, v1))]); p = v1 + 1; }
  const set = (k: string, v: string) => { const i = pairs.findIndex((x) => x[0] === k); if (i >= 0) pairs[i][1] = v; else pairs.push([k, v]); };
  set('bankdata', bankText.replace(/\0/g, ''));
  set('bankfile', bankFile);
  const mid = enc.encode(pairs.map(([k, v]) => `${k}\0${v}\0`).join(''));
  const out = new Uint8Array(b + begin.length + mid.length + (state.length - e));
  out.set(state.subarray(0, b + begin.length), 0);
  out.set(mid, b + begin.length);
  out.set(state.subarray(e), b + begin.length + mid.length);
  return out;
}

export function buildFlp(input: FlpBuildInput): FlpBuildResult {
  const warnings: string[] = [];
  const flp = parseFlp(input.template);
  const ev = flp.events;
  const smf = readSmf(input.midi);
  const velMap = input.velocity ?? ((v: number) => v);

  // --- channels in the template
  type Ch = { index: number; name: string; at: number; opm68: number /* event index of plugin data */ };
  const chans: Ch[] = [];
  ev.forEach((e, i) => {
    if (e.id === FLP.NewChannel) chans.push({ index: u16(e.data, 0), name: '', at: i, opm68: -1 });
    else if (chans.length && e.id === 203 && !chans[chans.length - 1].name) chans[chans.length - 1].name = readText(e);
    else if (chans.length && e.id === FLP.PluginData && chans[chans.length - 1].opm68 < 0) {
      const recs = wrapperRecords(e.data);
      if (recs?.some((r) => r.id === 0x3a && ascii(r.data, 0, r.data.length) === OPM68_ID)) chans[chans.length - 1].opm68 = i;
    }
  });
  const fmChan: (Ch | undefined)[] = [...FM_LETTERS].map((L, i) =>
    chans.find((c) => c.name.trim().toUpperCase() === `FM ${L}`) ?? chans.filter((c) => c.opm68 >= 0)[i]);
  const pcmChan = chans.find((c) => /ADPCM|PCM/i.test(c.name));

  // --- tempo
  const tempos: { tick: number; us: number }[] = [];
  for (const t of smf.tracks) for (const e of t.events) if (e.bytes[0] === 0xff && e.bytes[1] === 0x51) tempos.push({ tick: e.tick, us: (e.bytes[2] << 16) | (e.bytes[3] << 8) | e.bytes[4] });
  tempos.sort((a, b) => a.tick - b.tick);
  const us0 = tempos[0]?.us ?? 500000;
  const variable = tempos.some((t) => t.us !== us0);
  // One tempo: keep musical time. Several: FL gets the first tempo and positions are warped to real time
  // at a finer PPQ (OPM68 times its driver clock from the control packets, so the sound is unaffected).
  const ppq = variable ? 960 : flp.ppq;
  const secAt = (tick: number) => {
    let s = 0, lt = 0, us = us0;
    for (const t of tempos) { if (t.tick >= tick) break; s += ((t.tick - lt) * us) / smf.division / 1e6; lt = t.tick; us = t.us; }
    return s + ((tick - lt) * us) / smf.division / 1e6;
  };
  const pos = variable
    ? (tick: number) => Math.round((secAt(tick) * 1e6 / us0) * ppq)
    : (tick: number) => Math.round((tick * ppq) / smf.division);
  if (variable) warnings.push(`曲中でテンポが変わるため、FLのテンポを最初の値に固定し、ノート位置を実時間に合わせて配置しました (PPQ ${ppq})`);

  // --- notes and pan
  const notes: FlpNote[] = [];
  const ctrls: { pos: number; channel: number; value: number }[] = [];
  let panOffWarned = false;
  for (const t of smf.tracks) {
    const m = /^(FM|ADPCM) ([A-HP-W])$/.exec(t.name.trim());
    if (!m) continue;
    const isFm = m[1] === 'FM';
    const target = isFm ? fmChan[FM_LETTERS.indexOf(m[2])] : pcmChan;
    if (!target) { warnings.push(`テンプレートに ${t.name} 用のチャンネルがないため省略しました`); continue; }
    const open = new Map<number, { tick: number; vel: number }[]>();
    for (const e of t.events) {
      const st = e.bytes[0] & 0xf0, mc = e.bytes[0] & 15;
      if (st === 0x90 && e.bytes[2] > 0) {
        const k = mc * 128 + e.bytes[1];
        (open.get(k) ?? open.set(k, []).get(k)!).push({ tick: e.tick, vel: e.bytes[2] });
      } else if (st === 0x80 || (st === 0x90 && e.bytes[2] === 0)) {
        const k = mc * 128 + e.bytes[1];
        const on = open.get(k)?.shift();
        if (!on) continue;
        const p0 = pos(on.tick), p1 = Math.max(p0 + 1, pos(e.tick));
        notes.push({ pos: p0, len: p1 - p0, key: e.bytes[1], vel: velMap(on.vel), channel: target.index, midiCh: isFm ? 0 : mc });
      } else if (st === 0xb0 && e.bytes[1] === 10 && isFm) {
        const v = e.bytes[2];
        ctrls.push({ pos: pos(e.tick), channel: target.index, value: Math.round(v <= 64 ? (v / 64) * 6400 : 6400 + ((v - 64) / 63) * 6400) });
      } else if (st === 0xb0 && e.bytes[1] === 11 && isFm && e.bytes[2] === 0 && !panOffWarned) {
        panOffWarned = true;
        warnings.push('パン p0 (発音オフ) はFLPでは表現できないため無視しました');
      }
    }
  }
  notes.sort((a, b) => a.pos - b.pos || a.channel - b.channel || a.key - b.key);
  ctrls.sort((a, b) => a.pos - b.pos || a.channel - b.channel);
  const endPos = notes.reduce((a, n) => Math.max(a, n.pos + n.len), 0);

  // --- pattern 1: replace notes / controllers
  const pi = ev.findIndex((e) => e.id === FLP.NewPattern);
  if (pi < 0) throw new Error('テンプレートにパターンがありません (Pattern 1 にノートを1つ置いて保存してください)');
  let pe = pi + 1;
  while (pe < ev.length && ev[pe].id !== FLP.NewChannel && ev[pe].id !== FLP.NewPattern) pe++;
  const block = ev.slice(pi + 1, pe).filter((e) => e.id !== FLP.PatternNotes && e.id !== FLP.PatternControllers);
  const cdata = new Uint8Array(ctrls.length * 12);
  const cdv = new DataView(cdata.buffer);
  ctrls.forEach((c, i) => { const o = i * 12; cdv.setUint32(o, c.pos, true); cdata[o + 4] = 1; cdata[o + 6] = c.channel; cdv.setUint32(o + 8, c.value, true); });
  const fresh: FlpEvent[] = [];
  if (ctrls.length) fresh.push({ id: FLP.PatternControllers, data: cdata });
  fresh.push({ id: FLP.PatternNotes, data: encodeNotes(notes) });
  ev.splice(pi + 1, pe - pi - 1, ...fresh, ...block);

  // --- OPM68 banks
  // (indices shifted by the splice: find plugin events again in channel order)
  let chNo = -1;
  for (const e of ev) {
    if (e.id === FLP.NewChannel) { chNo = u16(e.data, 0); continue; }
    if (e.id !== FLP.PluginData || chNo < 0) continue;
    const i = fmChan.findIndex((c) => c?.index === chNo);
    if (i < 0) continue;
    const text = input.banks[FM_LETTERS[i]];
    if (!text) continue;
    const recs = wrapperRecords(e.data);
    const st = recs?.find((r) => r.id === 0x35);
    if (!recs?.some((r) => r.id === 0x3a && ascii(r.data, 0, r.data.length) === OPM68_ID) || !st) continue;
    const ns = setDpfBank(st.data, text, `${input.name || 'mdx'}_${FM_LETTERS[i]}.opm`);
    if (!ns) { warnings.push(`FM ${FM_LETTERS[i]}: OPM68 の状態形式が想定外のため音色を埋め込めませんでした`); continue; }
    e.data = setWrapperRecord(e.data, 0x35, ns);
    chNo = -1; // one plugin per channel
  }

  // --- tempo, title, playlist length
  const bpm = 60e6 / us0;
  const title = input.title ? cleanTitle(input.title) : '';
  for (const e of ev) {
    if (e.id === FLP.FineTempo) e.data = evDword(FLP.FineTempo, Math.round(bpm * 1000)).data;
    if (e.id === FLP.Title && title) e.data = evText(FLP.Title, title).data;
  }
  const bar = ppq * 4, patLen = Math.max(bar, Math.ceil(endPos / bar) * bar);
  let placed = false;
  for (const e of ev) {
    if (e.id !== FLP.Playlist) continue;
    const size = e.data.length % 88 === 0 ? 88 : e.data.length % 60 === 0 ? 60 : 32;
    const dv = new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    for (let o = 0; o + size <= e.data.length; o += size) {
      const item = dv.getUint16(o + 6, true), base = dv.getUint16(o + 4, true);
      if (base === 0x5000 && item === 0x5001) {
        dv.setUint32(o, Math.round((dv.getUint32(o, true) * ppq) / flp.ppq), true);
        dv.setUint32(o + 8, patLen, true);
        placed = true;
      }
    }
  }
  if (!placed) warnings.push('プレイリストに Pattern 1 が見つからないため、配置は手動で行ってください');
  flp.ppq = ppq;
  return { flp: writeFlp(flp), warnings, notes: notes.length, ppq };
}

/** MDX titles carry X68000 console escapes (ESC E, ESC [..m) and control codes. */
export function cleanTitle(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b./g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}
