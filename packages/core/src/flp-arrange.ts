// FL Studio project, "arrange" layout (experimental; the one-pattern layout of flp.ts stays as it is).
//
//  - FM: one OPM68 per MDX channel as before (MDX 1ch = OPM 1ch, mono), but the notes are split into
//    patterns by timbre: one playlist track per (MDX channel, voice), and on that track one clip per phrase
//    (a run of notes separated by a rest of a bar or more, also cut at the loop point). Identical phrases
//    share one pattern. All patterns of a channel feed the same OPM68 at the same positions as before,
//    so playback is unchanged (control-note packets go with the pattern of the note they precede).
//  - ADPCM: no sforzando / SF2. Every used PDX sample (bank, number, rate) becomes a WAV file played by
//    FL's own Sampler, one channel and one playlist track per sample. A note lasts until the next note of
//    the same ADPCM channel (MXDRV plays one sample per channel) or the end of the sample.
//
// The template is the same as for flp.ts (8 OPM68 channels "FM A".."FM H" + one "ADPCM" channel). If it
// also holds a channel of FL's Sampler, that channel is used as the model for the sample channels;
// otherwise one is derived from the "ADPCM" channel (plugin removed, channel type 0, sample path added).

import { parsePdx, decodePdxSample } from './pdx.js';
import {
  FLP, parseFlp, writeFlp, evText, readText, evDword, encodeNotes, readSmf, cleanTitle,
  wrapperRecords, setWrapperRecord, setDpfState, OPM68_ID,
  type FlpEvent, type FlpNote,
} from './flp.js';

export interface ArrangeSample {
  /** MIDI key the converter gave this sample on the ADPCM tracks (sf2 mode). */
  midiKey: number;
  bank: number; sample: number; freq: number;
  pcm: Int16Array | null; rate: number;
}
export interface ArrangeInput {
  template: Uint8Array;
  /** The converter's SMF (OPM68 mode, pcmMode 'sf2'). */
  midi: Uint8Array;
  banks: Record<string, string>;
  title?: string;
  name?: string;
  samples?: ArrangeSample[];
  /** Path FL should load a sample WAV from (the file name is given). Default: the name itself. */
  samplePath?: (file: string) => string;
  /** Rest (MDX clocks) that ends a phrase. Default 192 (one 4/4 bar). */
  phraseRest?: number;
}
export interface ArrangeResult {
  flp: Uint8Array;
  wavs: { file: string; data: Uint8Array }[];
  warnings: string[];
  stats: { tracks: number; clips: number; patterns: number; samplers: number };
}

const FM_LETTERS = 'ABCDEFGH';
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array) => String.fromCharCode(...b);

/** 16-bit mono PCM WAV. */
export function writeWav(pcm: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(out.buffer);
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  s(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); s(8, 'WAVE');
  s(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  s(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
  return out;
}

/** OPM68 bank text -> slot -> MDX voice number ("@:3 MDX @12 att0"). */
function slotVoices(text: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of text.split(/\r?\n/)) { const r = /^@:(\d+)\s+MDX @(\d+)/.exec(l); if (r) m.set(+r[1], +r[2]); }
  return m;
}

interface Ev { clock: number; kind: 'note' | 'ctl' | 'pan'; key?: number; len?: number; vel?: number; pan?: number; bytes?: number[]; capSec?: number }
interface Clip { track: number; start: number; events: Ev[] }

export function buildFlpArrange(input: ArrangeInput): ArrangeResult {
  const warnings: string[] = [];
  const flp = parseFlp(input.template);
  const ev = flp.events;
  const smf = readSmf(input.midi);
  const S = smf.division / 48; // SMF ticks per MDX clock
  const REST = input.phraseRest ?? 192;

  // ---- template channels
  type Ch = { index: number; name: string; at: number; end: number; type: number; opm68: boolean };
  const chans: Ch[] = [];
  ev.forEach((e, i) => {
    if (e.id === FLP.NewChannel) { if (chans.length) chans[chans.length - 1].end = i; chans.push({ index: u16(e.data, 0), name: '', at: i, end: -1, type: -1, opm68: false }); }
    else if (!chans.length) return;
    const c = chans[chans.length - 1];
    if (e.id === FLP.NewPattern && c.end < 0) c.end = i; // patterns never sit between channels, but be safe
    else if (e.id === 21 && c.type < 0) c.type = e.data[0];
    else if (e.id === 203 && !c.name) c.name = readText(e);
    else if (e.id === FLP.PluginData && wrapperRecords(e.data)?.some((r) => r.id === 0x3a && ascii(r.data) === OPM68_ID)) c.opm68 = true;
  });
  // a channel block ends at the next channel or at the first event that is not channel data (mixer, arrangement)
  if (chans.length) {
    const last = chans[chans.length - 1];
    if (last.end < 0) { let i = last.at + 1; while (i < ev.length && ev[i].id !== 99 /* arrangement */ && ev[i].id !== 241) i++; last.end = i; }
    // the event just before the arrangement (99) after the last channel is still channel/global data; stop at 143 (FX?)
  }
  const fmChan = [...FM_LETTERS].map((L, i) => chans.find((c) => c.name.trim().toUpperCase() === `FM ${L}`) ?? chans.filter((c) => c.opm68)[i]);
  const pcmModel = chans.find((c) => c.type === 0) ?? chans.find((c) => /ADPCM|PCM/i.test(c.name));

  // ---- tempo (same policy as flp.ts)
  const tempos: { tick: number; us: number }[] = [];
  for (const t of smf.tracks) for (const e of t.events) if (e.bytes[0] === 0xff && e.bytes[1] === 0x51) tempos.push({ tick: e.tick, us: (e.bytes[2] << 16) | (e.bytes[3] << 8) | e.bytes[4] });
  tempos.sort((a, b) => a.tick - b.tick);
  const us0 = tempos[0]?.us ?? 500000;
  const variable = tempos.some((t) => t.us !== us0);
  const ppq = variable ? 960 : flp.ppq;
  const secAt = (tick: number) => {
    let s = 0, lt = 0, us = us0;
    for (const t of tempos) { if (t.tick >= tick) break; s += ((t.tick - lt) * us) / smf.division / 1e6; lt = t.tick; us = t.us; }
    return s + ((tick - lt) * us) / smf.division / 1e6;
  };
  const pos = variable ? (tick: number) => Math.round(((secAt(tick) * 1e6) / us0) * ppq) : (tick: number) => Math.round((tick * ppq) / smf.division);
  const posC = (clock: number) => pos(clock * S);
  if (variable) warnings.push(`曲中でテンポが変わるため、FLのテンポを最初の値に固定し、ノート位置を実時間に合わせて配置しました (PPQ ${ppq})`);
  let loopClock: number | null = null;
  for (const e of smf.tracks[0]?.events ?? []) if (e.bytes[0] === 0xff && e.bytes[1] === 0x06 && String.fromCharCode(...e.bytes.slice(2)) === 'loopStart') loopClock = e.tick / S;

  // ---- playlist tracks and clips
  const trackNames: string[] = [];
  const clips: Clip[] = [];
  /** Split one track's notes (sorted) into phrases; returns note index -> clip. */
  function phrases(track: number, notes: Ev[], endOf: (n: Ev) => number): Clip[] {
    const out: Clip[] = [];
    let end = -Infinity, cur: Clip | null = null;
    for (const n of notes) {
      const crossLoop = cur && loopClock !== null && cur.events[0].clock < loopClock && n.clock >= loopClock;
      if (!cur || n.clock - end >= REST || crossLoop) { cur = { track, start: n.clock, events: [] }; out.push(cur); }
      cur.events.push(n);
      end = Math.max(end, endOf(n));
    }
    return out;
  }

  // ---- FM
  const usedFm: boolean[] = [];
  for (const t of smf.tracks) {
    const m = /^FM ([A-H])$/.exec(t.name.trim());
    if (!m) continue;
    const ci = FM_LETTERS.indexOf(m[1]);
    if (!fmChan[ci]) { warnings.push(`テンプレートに ${t.name} 用のチャンネルがないため省略しました`); continue; }
    usedFm[ci] = true;
    const voices = slotVoices(input.banks[m[1]] ?? '');
    const notes: Ev[] = [], ctl = new Map<number, number[]>(), pans: Ev[] = [];
    const open = new Map<number, { tick: number; vel: number }[]>();
    for (const e of t.events) {
      const st = e.bytes[0] & 0xf0, k = e.bytes[1];
      if (st === 0x90 && e.bytes[2] > 0) {
        (open.get(k) ?? open.set(k, []).get(k)!).push({ tick: e.tick, vel: e.bytes[2] });
      } else if (st === 0x80 || st === 0x90) {
        // (like flp.ts, a note-on without its note-off, e.g. cut at the song end, is dropped)
        const on = open.get(k)?.shift();
        if (!on) continue;
        if (k < 15) { const c = Math.round(on.tick / S); const p = ctl.get(c) ?? []; p[k] = on.vel - 1; ctl.set(c, p); }
        else notes.push({ clock: on.tick / S, kind: 'note', key: k, len: (e.tick - on.tick) / S, vel: on.vel });
      } else if (st === 0xb0 && k === 10) {
        const v = e.bytes[2];
        pans.push({ clock: e.tick / S, kind: 'pan', pan: Math.round(v <= 64 ? (v / 64) * 6400 : 6400 + ((v - 64) / 63) * 6400) });
      }
    }
    notes.sort((a, b) => a.clock - b.clock || a.key! - b.key!);
    // tracks by voice (velocity = bank slot + 1)
    const bySlot = new Map<number, Ev[]>();
    for (const n of notes) (bySlot.get(n.vel!) ?? bySlot.set(n.vel!, []).get(n.vel!)!).push(n);
    const noteClip = new Map<Ev, Clip>();
    for (const [vel, ns] of [...bySlot].sort((a, b) => a[1][0].clock - b[1][0].clock)) {
      const v = voices.get(vel - 1);
      const tr = trackNames.push(`FM ${m[1]} ${v !== undefined ? `@${v}` : `slot ${vel - 1}`}`) - 1;
      for (const c of phrases(tr, ns, (n) => n.clock + n.len!)) { clips.push(c); for (const n of c.events) noteClip.set(n, c); }
    }
    // control packets and pan go with the next note of the channel (the last note's clip after the end)
    const owner = (clock: number) => {
      let lo = 0, hi = notes.length;
      while (lo < hi) { const md = (lo + hi) >> 1; if (notes[md].clock < clock) lo = md + 1; else hi = md; }
      const n = notes[Math.min(lo, notes.length - 1)];
      return n ? noteClip.get(n)! : undefined;
    };
    for (const [c, bytes] of ctl) {
      const cl = owner(c);
      if (!cl) continue;
      cl.events.push({ clock: c, kind: 'ctl', bytes });
      if (c < cl.start) cl.start = c;
    }
    for (const p of pans) { const cl = owner(p.clock); if (cl) { cl.events.push(p); if (p.clock < cl.start) cl.start = p.clock; } }
  }

  // ---- ADPCM -> Sampler channels
  const samples = input.samples ?? [];
  const byKey = new Map<number, number>();
  samples.forEach((s, i) => byKey.set(s.midiKey, i));
  const pcmTrackOf = new Map<number, number>(); // sample index -> playlist track
  const usedSamples: number[] = [];
  const pcmNotes: { sample: number; ev: Ev }[] = [];
  for (const t of smf.tracks) {
    const m = /^ADPCM ([P-W])$/.exec(t.name.trim());
    if (!m) continue;
    let vol = 127, expr = 127, pan = 64;
    const ons: { tick: number; key: number; vel: number; pan: number }[] = [];
    let mc = 0;
    for (const e of t.events) {
      const st = e.bytes[0] & 0xf0;
      if (st === 0xb0) {
        mc = e.bytes[0] & 15;
        if (e.bytes[1] === 7) vol = e.bytes[2];
        else if (e.bytes[1] === 11) expr = e.bytes[2];
        else if (e.bytes[1] === 10) pan = e.bytes[2];
      } else if (st === 0x90 && e.bytes[2] > 0) {
        // MIDI CC7/CC11 are amplitude-like (the converter maps attenuation to 127*10^(-dB/40)); FL velocity is 0..128
        ons.push({ tick: e.tick, key: e.bytes[1], vel: Math.max(1, Math.round((vol * expr) / 127 * 128 / 127)), pan: pan <= 64 ? pan : Math.round(64 + ((pan - 64) / 63) * 64) });
      }
    }
    void mc;
    let endTick = t.events.length ? t.events[t.events.length - 1].tick : 0;
    ons.forEach((o, i) => {
      const si = byKey.get(o.key);
      if (si === undefined || !samples[si].pcm) return;
      const s = samples[si];
      const next = i + 1 < ons.length ? ons[i + 1].tick : endTick;
      // MXDRV plays one sample per ADPCM channel: the next note cuts it; FL also stops it at the note end
      const lenTick = Math.max(S, next - o.tick);
      if (!usedSamples.includes(si)) usedSamples.push(si);
      pcmNotes.push({ sample: si, ev: { clock: o.tick / S, kind: 'note', key: 60, len: lenTick / S, vel: o.vel, pan: o.pan, capSec: s.pcm!.length / s.rate } });
    });
  }
  usedSamples.sort((a, b) => samples[a].bank * 96 + samples[a].sample - (samples[b].bank * 96 + samples[b].sample) || samples[a].freq - samples[b].freq);
  for (const si of usedSamples) {
    const s = samples[si];
    const tr = trackNames.push(`PCM ${s.bank ? `${s.bank}:` : ''}${s.sample}${usedSamples.some((x) => x !== si && samples[x].sample === s.sample && samples[x].bank === s.bank) ? ` f${s.freq}` : ''}`) - 1;
    pcmTrackOf.set(si, tr);
    const ns = pcmNotes.filter((p) => p.sample === si).map((p) => p.ev).sort((a, b) => a.clock - b.clock);
    clips.push(...phrases(tr, ns, (n) => n.clock + n.len!));
  }

  // ---- channel rack: Sampler channels
  const wavs: ArrangeResult['wavs'] = [];
  const stem = (input.name || 'mdx').replace(/[\\/:*?"<>|]/g, '_');
  const samplerIndex = new Map<number, number>(); // sample -> FL channel index
  const newChannelBlocks: FlpEvent[][] = [];
  if (usedSamples.length) {
    if (!pcmModel) warnings.push('テンプレートに ADPCM / Sampler チャンネルがないため ADPCM を省略しました');
    else {
      const model = ev.slice(pcmModel.at, pcmModel.end);
      const isSampler = pcmModel.type === 0;
      let nextIndex = Math.max(...chans.map((c) => c.index)) + 1;
      usedSamples.forEach((si, i) => {
        const s = samples[si];
        const file = `${stem}_${s.bank ? `b${s.bank}_` : ''}${String(s.sample).padStart(2, '0')}_f${s.freq}.wav`;
        wavs.push({ file, data: writeWav(s.pcm!, s.rate) });
        const index = i === 0 && !isSampler ? pcmModel.index : nextIndex++;
        samplerIndex.set(si, index);
        const blk: FlpEvent[] = [];
        let named = false;
        for (const e of model) {
          if (e.id === FLP.NewChannel) { blk.push({ id: e.id, data: Uint8Array.of(index & 255, index >> 8) }); continue; }
          if (!isSampler && (e.id === FLP.PluginName || e.id === FLP.PluginData)) continue;
          if (e.id === 21) { blk.push({ id: 21, data: Uint8Array.of(0) }); continue; }
          // 132 (cut, cut by): the template gives every channel its own group; keep that for each sample
          // (the note lengths already end a sample where MXDRV's next key-on on that ADPCM channel would)
          if (e.id === 132) { const g = 32 + i; blk.push({ id: 132, data: Uint8Array.of(g & 255, g >> 8, g & 255, g >> 8) }); continue; }
          if (e.id === 196) continue; // sample path: written after the name
          if (e.id === 203 || (isSampler && e.id === 192)) {
            if (named) continue;
            named = true;
            blk.push(evText(203, trackNames[pcmTrackOf.get(si)!]));
            blk.push(evText(196, input.samplePath ? input.samplePath(file) : file));
            continue;
          }
          blk.push({ id: e.id, data: e.data.slice() });
        }
        if (!named) { blk.splice(2, 0, evText(203, trackNames[pcmTrackOf.get(si)!]), evText(196, input.samplePath ? input.samplePath(file) : file)); }
        newChannelBlocks.push(blk);
      });
      // replace the model (sforzando "ADPCM") channel by the first sampler; the others go after the last channel
      if (!isSampler) {
        ev.splice(pcmModel.at, pcmModel.end - pcmModel.at, ...newChannelBlocks[0]);
        const shift = newChannelBlocks[0].length - (pcmModel.end - pcmModel.at);
        for (const c of chans) { if (c.at > pcmModel.at) { c.at += shift; c.end += shift; } }
        pcmModel.end = pcmModel.at + newChannelBlocks[0].length;
        newChannelBlocks.shift();
      }
      const lastCh = chans.reduce((a, c) => (c.at > a.at ? c : a));
      ev.splice(lastCh.end, 0, ...newChannelBlocks.flat());
      flp.channels = chans.length + newChannelBlocks.length;
    }
  } else if (pcmModel && pcmModel.type !== 0 && !chans.some((c) => c.type === 0)) {
    // no ADPCM in this song: drop nothing, the template channel just stays empty
  }

  // ---- patterns (identical clips share one pattern)
  const bar = ppq * 4;
  type Pat = { id: number; name: string; notes: FlpNote[]; ctrls: { pos: number; ch: number; v: number }[]; len: number };
  const pats: Pat[] = [];
  const patByKey = new Map<string, Pat>();
  const items: { pos: number; pat: Pat; track: number; len: number }[] = [];
  const nameCount = new Map<number, number>();
  clips.sort((a, b) => a.start - b.start || a.track - b.track);
  for (const c of clips) {
    const firstNote = Math.min(...c.events.filter((e) => e.kind === 'note').map((e) => e.clock));
    const p0 = Math.floor(posC(Math.min(firstNote, c.start)) / bar) * bar;
    const start = Math.min(p0, posC(c.start));
    const notes: FlpNote[] = [], ctrls: Pat['ctrls'] = [];
    const isPcm = trackNames[c.track].startsWith('PCM');
    const fl = isPcm ? samplerIndex.get([...pcmTrackOf].find(([, t]) => t === c.track)![0]) : fmChan[FM_LETTERS.indexOf(trackNames[c.track][3])]?.index;
    if (fl === undefined) continue;
    let end = 0;
    for (const e of c.events) {
      const p = posC(e.clock) - start;
      if (e.kind === 'note') {
        let len = Math.max(1, posC(e.clock + e.len!) - posC(e.clock));
        // FL runs at the first tempo: positions are in that time base in both tempo modes
        if (e.capSec !== undefined) len = Math.max(1, Math.min(len, Math.ceil((e.capSec * 1e6 * ppq) / us0)));
        notes.push({ pos: p, len, key: e.key!, vel: e.vel!, channel: fl, pan: e.pan ?? 64 });
        end = Math.max(end, p + len);
      } else if (e.kind === 'ctl') {
        const half = Math.max(1, posC(e.clock + 0.5) - posC(e.clock));
        e.bytes!.forEach((b, key) => { if (b !== undefined) notes.push({ pos: p, len: half, key, vel: b + 1, channel: fl }); });
      } else ctrls.push({ pos: p, ch: fl, v: e.pan! });
    }
    notes.sort((a, b) => a.pos - b.pos || a.key - b.key);
    ctrls.sort((a, b) => a.pos - b.pos);
    const len = Math.max(ppq, Math.ceil(end / ppq) * ppq);
    const key = `${fl}|${len}|` + notes.map((n) => `${n.pos},${n.len},${n.key},${n.vel},${n.pan}`).join(';') + '|' + ctrls.map((x) => `${x.pos},${x.v}`).join(';');
    let pat = patByKey.get(key);
    if (!pat) {
      const k = (nameCount.get(c.track) ?? 0) + 1; nameCount.set(c.track, k);
      pat = { id: pats.length + 1, name: `${trackNames[c.track]} #${k}`, notes, ctrls, len };
      pats.push(pat); patByKey.set(key, pat);
    }
    items.push({ pos: start, pat, track: c.track, len });
  }

  // ---- write patterns: replace the template's pattern 1, keep its other data
  const pi = ev.findIndex((e) => e.id === FLP.NewPattern);
  if (pi < 0) throw new Error('テンプレートにパターンがありません (Pattern 1 にノートを1つ置いて保存してください)');
  let pe = pi + 1;
  while (pe < ev.length && ev[pe].id !== FLP.NewChannel && ev[pe].id !== FLP.NewPattern) pe++;
  const keep = ev.slice(pi + 1, pe).filter((e) => e.id !== FLP.PatternNotes && e.id !== FLP.PatternControllers && e.id !== FLP.PatternName);
  const patEvents: FlpEvent[] = [];
  for (const p of pats) {
    patEvents.push({ id: FLP.NewPattern, data: Uint8Array.of(p.id & 255, p.id >> 8) }, evText(FLP.PatternName, p.name));
    if (p.ctrls.length) {
      const d = new Uint8Array(p.ctrls.length * 12); const dv = new DataView(d.buffer);
      p.ctrls.forEach((c, i) => { const o = i * 12; dv.setUint32(o, c.pos, true); d[o + 4] = 1; d[o + 6] = c.ch; dv.setUint32(o + 8, c.v, true); });
      patEvents.push({ id: FLP.PatternControllers, data: d });
    }
    patEvents.push({ id: FLP.PatternNotes, data: encodeNotes(p.notes) });
    if (p.id === 1) patEvents.push(...keep);
  }
  ev.splice(pi, pe - pi, ...patEvents);

  // ---- OPM68 banks (mono), as in flp.ts (bank file names like the converter's: song.opm or song_chX.opm)
  const bankTexts = new Set(Object.values(input.banks));
  const bankName = (L: string) => `${input.name || 'mdx'}${bankTexts.size > 1 ? `_ch${L}` : ''}.opm`;
  let chNo = -1;
  for (const e of ev) {
    if (e.id === FLP.NewChannel) { chNo = u16(e.data, 0); continue; }
    if (e.id !== FLP.PluginData || chNo < 0) continue;
    const i = fmChan.findIndex((c) => c?.index === chNo);
    if (i < 0) continue;
    const text = input.banks[FM_LETTERS[i]];
    const recs = wrapperRecords(e.data);
    const st = recs?.find((r) => r.id === 0x35);
    if (!text || !st || !recs?.some((r) => r.id === 0x3a && ascii(r.data) === OPM68_ID)) continue;
    const ns = setDpfState(st.data, text, bankName(FM_LETTERS[i]), { mono: '1' });
    if (!ns) { warnings.push(`FM ${FM_LETTERS[i]}: OPM68 の状態形式が想定外のため音色を埋め込めませんでした`); continue; }
    e.data = setWrapperRecord(e.data, 0x35, ns);
    chNo = -1;
  }

  // ---- tempo, title
  const title = input.title ? cleanTitle(input.title) : '';
  for (const e of ev) {
    if (e.id === FLP.FineTempo) e.data = evDword(FLP.FineTempo, Math.round((60e6 / us0) * 1000)).data;
    if (e.id === FLP.Title && title) e.data = evText(FLP.Title, title).data;
  }

  // ---- playlist: one item per clip; template item 0 gives the unknown tail bytes
  const plIdx = ev.findIndex((e) => e.id === FLP.Playlist);
  if (plIdx < 0) throw new Error('テンプレートにプレイリストがありません');
  const tpl = ev[plIdx].data;
  const size = tpl.length % 88 === 0 ? 88 : tpl.length % 60 === 0 ? 60 : 32;
  const item0 = tpl.slice(0, size);
  items.sort((a, b) => a.pos - b.pos || a.track - b.track);
  const pl = new Uint8Array(items.length * size);
  const pdv = new DataView(pl.buffer);
  items.forEach((it, i) => {
    const o = i * size;
    pl.set(item0, o);
    pdv.setUint32(o, it.pos, true);
    pdv.setUint16(o + 4, 0x5000, true);
    pdv.setUint16(o + 6, 0x5000 + it.pat.id, true);
    pdv.setUint32(o + 8, it.len, true);
    pdv.setUint16(o + 12, 499 - it.track, true);
    pdv.setInt32(o + 24, -1, true); pdv.setInt32(o + 28, -1, true); // start / end offset: whole pattern
  });
  ev[plIdx] = { id: FLP.Playlist, data: pl };

  // ---- playlist track names (TrackData 238 is followed by an optional TrackName 239)
  let tn = 0;
  for (let i = 0; i < ev.length && tn < trackNames.length; i++) {
    if (ev[i].id !== 238) continue;
    const no = u32(ev[i].data, 0) - 1; // 1-based track number
    if (no !== tn) continue;
    if (ev[i + 1]?.id === 239) ev[i + 1] = evText(239, trackNames[tn]);
    else ev.splice(i + 1, 0, evText(239, trackNames[tn]));
    tn++;
  }
  if (tn < trackNames.length) warnings.push(`プレイリストのトラック名を ${trackNames.length - tn} 本設定できませんでした`);

  flp.ppq = ppq;
  return { flp: writeFlp(flp), wavs, warnings, stats: { tracks: trackNames.length, clips: items.length, patterns: pats.length, samplers: usedSamples.length } };
}

/** Decoded PDX samples for the converter's ADPCM keys (ConvertResult.pcmKeys). */
export function arrangeSamplesFromPdx(keys: { midiKey: number; bank: number; sample: number; freq: number }[], pdx: Uint8Array | null): ArrangeSample[] {
  const bank = pdx ? parsePdx(pdx) : null;
  return keys.map((k) => {
    const raw = bank ? bank.samples[k.bank * 96 + k.sample] ?? (k.bank > 0 ? bank.samples[k.sample] : null) : null;
    if (!raw) return { ...k, pcm: null, rate: 15625 };
    const { pcm, rate } = decodePdxSample(raw, k.freq);
    return { ...k, pcm, rate };
  });
}
