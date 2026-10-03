// Virtual MXDRV sequencer: runs all channels on a shared 1-clock timeline and
// emits driver-agnostic events. Channel-to-channel sync (EF/EE), repeats,
// loops and tempo changes are resolved here.

import type { MdxFile } from './mdx.js';

export type SeqEvent =
  | { t: number; ch: number; type: 'noteOn'; note: number; key: number }
  | { t: number; ch: number; type: 'noteOff'; key: number }
  | { t: number; ch: number; type: 'voice'; voice: number }
  | { t: number; ch: number; type: 'volume'; att: number } // OPM TL attenuation (0.75 dB steps)
  | { t: number; ch: number; type: 'pan'; pan: number }   // 0 off, 1 L, 2 R, 3 C
  | { t: number; ch: number; type: 'pitch'; semis: number } // offset from note in semitones
  // nativePitch only: the player applies portamento / detune / pitch LFO itself
  | { t: number; ch: number; type: 'porta'; perTick: number }   // portamento (1/16384 semitone per clock) for the note starting now
  | { t: number; ch: number; type: 'retrig'; perTick: number }  // tie: restart portamento and LFO of the held note
  | { t: number; ch: number; type: 'detune'; value: number }    // 1/64 semitone
  | { t: number; ch: number; type: 'lfo'; on: boolean; wave: number; period: number; amp: number; delay: number }
  | { t: number; ch: -1; type: 'tempo'; timerB: number }
  | { t: number; ch: -1; type: 'fade'; speed: number }
  | { t: number; ch: -1; type: 'loopPoint' };

/** Information attached to ADPCM note-ons. */
export interface PcmKey { bank: number; sample: number; freq: number }

export interface OpmLfo { wave: number; sync: number; lfrq: number; pmd: number; amd: number; pms: number; ams: number }

export interface SeqOptions {
  loops?: number;       // how many times looping channels should play the loop body (default 2)
  maxTicks?: number;    // safety cap
  /** Emit portamento / detune / pitch LFO as parameter events instead of folding them into 'pitch'. */
  nativePitch?: boolean;
}

export interface SeqResult {
  events: SeqEvent[];
  endTick: number;
  loopTick: number | null;  // tick where first loop started (for the longest loop channel)
  warnings: string[];
  opmLfo: OpmLfo | null;    // first OPM hardware LFO setting (EA) found in the song
  pcmKeys: PcmKey[];        // distinct ADPCM (bank,sample,freq) used; noteOn.key indexes into this for PCM channels
  isPcm: boolean[];
  usedChannels: boolean[];
}

const VOLTAB = [0x2a, 0x28, 0x25, 0x22, 0x20, 0x1d, 0x1a, 0x18, 0x15, 0x12, 0x10, 0x0d, 0x0a, 0x08, 0x05, 0x02];
/** MDX note 0 == o0 d+ ; o4a = 440Hz = MIDI 69. */
export const MDX_NOTE_TO_MIDI = 15;

interface Ch {
  idx: number;
  pcm: boolean;
  pos: number;
  wait: number;
  ended: boolean;
  syncWait: boolean;
  syncPending: boolean;
  loops: number;
  vol: number;
  q: number;
  keyOnDelay: number;
  noKeyOff: boolean;      // F7 seen: next note's key-off disabled
  tiePrev: boolean;       // previous note had its key-off disabled
  detune: number;         // 1/64 semitone
  portaNext: number;      // pending portamento (1/16384 semitone per tick)
  porta: number;
  portaAcc: number;
  bank: number;
  freq: number;
  curKey: number | null;  // MIDI key (FM) or PCM key index
  offAt: number;          // tick for key-off (-1: none)
  onAt: number;           // pending delayed key-on tick (-1: none)
  pendKey: number;
  pendNote: number;
  lfo: { wave: number; period: number; amp: number; on: boolean; phase: number; delay: number; delayCnt: number };
  lastPitch: number;
  repeat: Map<number, number>;
  cmdGuard: number;
  visited: Map<number, number>;
}

export function sequence(mdx: MdxFile, opts: SeqOptions = {}): SeqResult {
  const d = mdx.data;
  const loopsWanted = Math.max(1, opts.loops ?? 2);
  const maxTicks = opts.maxTicks ?? 48 * 4 * 1200; // ~1200 bars
  const portaEv = opts.nativePitch === true;
  const events: SeqEvent[] = [];
  const warnings: string[] = [];
  const warnOnce = new Set<string>();
  const warn = (m: string) => { if (!warnOnce.has(m)) { warnOnce.add(m); warnings.push(m); } };
  const pcmKeys: PcmKey[] = [];
  const pcmKeyIdx = new Map<string, number>();
  const nch = mdx.channelOffsets.length;
  const isPcm = Array.from({ length: nch }, (_, i) => i >= 8);
  const used = new Array(nch).fill(false);

  const chs: Ch[] = mdx.channelOffsets.map((off, idx) => ({
    idx, pcm: idx >= 8, pos: off, wait: 0, ended: off >= d.length, syncWait: false, syncPending: false, loops: 0,
    vol: 8, q: 8, keyOnDelay: 0, noKeyOff: false, tiePrev: false, detune: 0, portaNext: 0, porta: 0, portaAcc: 0,
    bank: 0, freq: 4, curKey: null, offAt: -1, onAt: -1, pendKey: 0, pendNote: 0,
    lfo: { wave: 0, period: 0, amp: 0, on: false, phase: 0, delay: 0, delayCnt: 0 }, lastPitch: 0,
    repeat: new Map(), cmdGuard: 0, visited: new Map(),
  }));

  let t = 0;
  let loopTick: number | null = null;
  let opmLfo: OpmLfo | null = null;
  const u8 = (p: number) => (p < d.length ? d[p] : 0xf1);
  const s16 = (p: number) => { const v = (u8(p) << 8) | u8(p + 1); return v & 0x8000 ? v - 0x10000 : v; };

  const emitVol = (c: Ch) => {
    const att = c.vol & 0x80 ? c.vol & 0x7f : VOLTAB[c.vol & 15];
    events.push({ t, ch: c.idx, type: 'volume', att });
  };
  const keyOff = (c: Ch, at: number) => {
    if (c.curKey !== null) {
      events.push({ t: at, ch: c.idx, type: 'noteOff', key: c.curKey });
      c.curKey = null;
    }
  };

  const doNote = (c: Ch, note: number, len: number) => {
    used[c.idx] = true;
    let key: number;
    if (c.pcm) {
      const k = `${c.bank}:${note}:${c.freq}`;
      let ki = pcmKeyIdx.get(k);
      if (ki === undefined) { ki = pcmKeys.length; pcmKeys.push({ bank: c.bank, sample: note, freq: c.freq }); pcmKeyIdx.set(k, ki); }
      key = ki;
    } else {
      key = note + MDX_NOTE_TO_MIDI;
    }
    // gate time
    let gate: number;
    if (c.q <= 8) gate = Math.max(1, (len * c.q) >> 3);
    else gate = Math.max(1, len - (256 - c.q));
    const thisNoKeyOff = c.noKeyOff;
    c.noKeyOff = false;
    // portamento
    const hadPorta = c.porta !== 0;
    c.porta = c.portaNext; c.portaNext = 0; c.portaAcc = 0;
    c.lfo.delayCnt = c.lfo.delay; c.lfo.phase = 0;

    if (c.tiePrev && !c.pcm && c.curKey === key) {
      // tie: keep the note sounding (the portamento offset restarts from the note)
      if (portaEv && (c.porta !== 0 || hadPorta || c.lfo.on)) events.push({ t, ch: c.idx, type: 'retrig', perTick: c.porta });
    } else {
      if (c.curKey !== null) keyOff(c, t);
      if (c.keyOnDelay > 0 && c.keyOnDelay < len) {
        c.onAt = t + c.keyOnDelay; c.pendKey = key; c.pendNote = note;
      } else {
        events.push({ t, ch: c.idx, type: 'noteOn', note, key });
        if (portaEv && c.porta !== 0) events.push({ t, ch: c.idx, type: 'porta', perTick: c.porta });
        c.curKey = key;
      }
    }
    c.tiePrev = thisNoKeyOff;
    c.offAt = thisNoKeyOff ? -1 : t + gate;
    c.wait = len;
  };

  const step = (c: Ch) => {
    // execute commands until something consumes time
    let guard = 0;
    while (!c.ended && !c.syncWait && c.wait === 0) {
      if (++guard > 20000) { warn(`ch ${c.idx}: 時間を消費しない無限ループを検出したため停止`); c.ended = true; break; }
      const p = c.pos;
      if (p >= d.length) { warn(`ch ${c.idx}: データ終端を越えた`); c.ended = true; break; }
      const cmd = d[p];
      if (!c.visited.has(p)) c.visited.set(p, t);
      if (cmd <= 0x7f) { // rest
        if (c.curKey !== null) keyOff(c, t);
        c.tiePrev = false; c.offAt = -1;
        c.wait = cmd + 1; c.pos = p + 1;
        continue;
      }
      if (cmd <= 0xdf) { // note
        doNote(c, cmd - 0x80, u8(p + 1) + 1);
        c.pos = p + 2;
        continue;
      }
      switch (cmd) {
        case 0xff: events.push({ t, ch: -1, type: 'tempo', timerB: u8(p + 1) }); c.pos = p + 2; break;
        case 0xfe: c.pos = p + 3; break; // OPM register write (ignored)
        case 0xfd:
          if (c.pcm) c.bank = u8(p + 1); else events.push({ t, ch: c.idx, type: 'voice', voice: u8(p + 1) });
          c.pos = p + 2; break;
        case 0xfc: events.push({ t, ch: c.idx, type: 'pan', pan: u8(p + 1) & 3 }); c.pos = p + 2; break;
        case 0xfb: c.vol = u8(p + 1); emitVol(c); c.pos = p + 2; break;
        case 0xfa: // volume down
          if (c.vol & 0x80) { if ((c.vol & 0x7f) < 0x7f) c.vol++; } else if (c.vol > 0) c.vol--;
          emitVol(c); c.pos = p + 1; break;
        case 0xf9: // volume up
          if (c.vol & 0x80) { if ((c.vol & 0x7f) > 0) c.vol--; } else if (c.vol < 15) c.vol++;
          emitVol(c); c.pos = p + 1; break;
        case 0xf8: c.q = u8(p + 1); c.pos = p + 2; break;
        case 0xf7: c.noKeyOff = true; c.pos = p + 1; break;
        case 0xf6: { // repeat start: count, 0
          c.pos = p + 3;
          c.repeat.set(c.pos, u8(p + 1));
          break;
        }
        case 0xf5: { // repeat end: offset back to loop body
          const target = p + 3 + s16(p + 1);
          let rem = c.repeat.get(target);
          if (rem === undefined) rem = u8(target - 2);
          rem--;
          if (rem > 0) {
            c.repeat.set(target, rem); c.pos = target;
            // [ ... ]255 is commonly used as an endless loop: treat each pass as a song loop
            if (u8(target - 2) === 0xff) {
              c.loops++;
              if (c.loops === 1) { const lt = c.visited.get(target - 3) ?? 0; if (loopTick === null || lt < loopTick) loopTick = lt; }
            }
          }
          else { c.repeat.delete(target); c.pos = p + 3; }
          break;
        }
        case 0xf4: { // repeat escape: on the last iteration jump past the matching F5
          if (s16(p + 1) === 0) { c.pos = p + 3; break; } // null escape emitted by some compilers
          const f5 = p + 3 + s16(p + 1) - 1; // offset points at the F5 operand
          if (u8(f5) === 0xf5) {
            const body = f5 + 3 + s16(f5 + 1);
            const rem = c.repeat.get(body) ?? u8(body - 2);
            if (rem <= 1) { c.repeat.delete(body); c.pos = f5 + 3; break; }
          } else {
            warn(`ch ${c.idx}: F4 の飛び先が F5 ではない (0x${f5.toString(16)})`);
          }
          c.pos = p + 3;
          break;
        }
        case 0xf3: {
          const dt = s16(p + 1);
          if (portaEv && dt !== c.detune) {
            for (let i = events.length - 1; i >= 0 && events[i].t === t; i--) {
              if (events[i].ch === c.idx && events[i].type === 'detune') { events.splice(i, 1); break; }
            }
            events.push({ t, ch: c.idx, type: 'detune', value: dt });
          }
          c.detune = dt; c.pos = p + 3; break;
        }
        case 0xf2: c.portaNext = s16(p + 1); c.pos = p + 3; break;
        case 0xf1: {
          if (u8(p + 1) === 0) { c.ended = true; keyOff(c, t); c.pos = p + 2; break; }
          const target = p + 3 + s16(p + 1);
          c.loops++;
          if (c.loops === 1) { const lt = c.visited.get(target) ?? 0; if (loopTick === null || lt < loopTick) loopTick = lt; }
          c.pos = target;
          break;
        }
        case 0xf0: c.keyOnDelay = u8(p + 1); c.pos = p + 2; break;
        case 0xef: { // sync send
          const tgt = chs[u8(p + 1)];
          if (tgt) { if (tgt.syncWait) tgt.syncWait = false; else tgt.syncPending = true; }
          c.pos = p + 2; break;
        }
        case 0xee: // sync wait
          c.pos = p + 1;
          if (c.syncPending) c.syncPending = false; else c.syncWait = true;
          break;
        case 0xed: if (c.pcm) c.freq = u8(p + 1); c.pos = p + 2; break; // FM ch: noise freq (ignored)
        case 0xec: { // pitch LFO
          const m = u8(p + 1);
          if (m === 0x80) { c.lfo.on = false; c.pos = p + 2; }
          else if (m === 0x81) { c.lfo.on = true; c.pos = p + 2; }
          else { c.lfo.wave = m & 3; c.lfo.period = (u8(p + 2) << 8) | u8(p + 3); c.lfo.amp = s16(p + 4); c.lfo.on = true; c.pos = p + 6; }
          emitLfo(c);
          break;
        }
        case 0xeb: { // amplitude LFO (ignored for now)
          const m = u8(p + 1);
          c.pos = (m === 0x80 || m === 0x81) ? p + 2 : p + 6; break;
        }
        case 0xea: { // OPM hardware LFO: EA wave LFRQ PMD AMD PMS/AMS
          const m = u8(p + 1);
          if (m === 0x80 || m === 0x81) { c.pos = p + 2; break; }
          if (!opmLfo) opmLfo = { wave: m & 3, sync: (m >> 6) & 1, lfrq: u8(p + 2), pmd: u8(p + 3) & 0x7f, amd: u8(p + 4) & 0x7f, pms: (u8(p + 5) >> 4) & 7, ams: u8(p + 5) & 3 };
          c.pos = p + 6; break;
        }
        case 0xe9: c.lfo.delay = u8(p + 1); c.pos = p + 2; emitLfo(c); break;
        case 0xe8: c.pos = p + 1; break; // PCM8 mode enable
        case 0xe7: { // fade out: E7 01 speed
          events.push({ t, ch: -1, type: 'fade', speed: u8(p + 2) });
          c.pos = p + 3; break;
        }
        default:
          warn(`ch ${c.idx}: 未知のコマンド 0x${cmd.toString(16)} @0x${p.toString(16)} — チャンネル停止`);
          c.ended = true;
      }
    }
  };

  const lastLfo = new Map<number, string>();
  function emitLfo(c: Ch) {
    if (!portaEv || c.pcm) return;
    const l = c.lfo, k = `${l.on}|${l.wave}|${l.period}|${l.amp}|${l.delay}`;
    if (lastLfo.get(c.idx) === k) return;
    lastLfo.set(c.idx, k);
    // several LFO commands in the same clock collapse into one event (one control note per key and time)
    for (let i = events.length - 1; i >= 0 && events[i].t === t; i--) {
      const x = events[i];
      if (x.ch === c.idx && x.type === 'lfo') { events.splice(i, 1); break; }
    }
    events.push({ t, ch: c.idx, type: 'lfo', on: l.on, wave: l.wave, period: l.period, amp: l.amp, delay: l.delay });
  }

  const pitchOf = (c: Ch): number => {
    let semis = c.detune / 64 + (portaEv ? 0 : c.portaAcc / 16384);
    if (c.lfo.on && c.lfo.period > 0 && c.lfo.delayCnt <= 0 && c.curKey !== null) {
      const per = c.lfo.period, ph = c.lfo.phase % (per * 4);
      const a = c.lfo.amp / 16384; // amplitude: per-tick delta (same unit as portamento)
      let v: number;
      switch (c.lfo.wave) {
        case 0: v = a * ((ph % per) - per / 2); break;            // sawtooth
        case 1: v = ((Math.floor(ph / per) & 1) ? -1 : 1) * a * per / 2; break; // square
        case 2: { const x = ph % (per * 2); v = a * (x < per ? x : 2 * per - x) - a * per / 2; break; } // triangle
        default: v = 0;
      }
      semis += v;
    }
    return semis;
  };

  const allDone = () => chs.every((c) => c.ended || c.loops >= loopsWanted);
  while (t < maxTicks) {
    // key-offs and delayed key-ons scheduled for this tick
    for (const c of chs) {
      if (c.offAt === t) { keyOff(c, t); c.offAt = -1; }
      if (c.onAt === t) {
        events.push({ t, ch: c.idx, type: 'noteOn', note: c.pendNote, key: c.pendKey });
        if (portaEv && c.porta !== 0) events.push({ t, ch: c.idx, type: 'porta', perTick: c.porta });
        c.curKey = c.pendKey; c.onAt = -1;
      }
    }
    for (const c of chs) step(c);
    // sync may have released a channel processed earlier in this tick
    for (const c of chs) if (!c.ended && !c.syncWait && c.wait === 0) step(c);

    if (allDone()) break;
    if (chs.every((c) => c.ended || c.syncWait)) {
      if (chs.some((c) => c.syncWait)) warn('同期待ち(EE)のまま全チャンネルが停止');
      break;
    }
    // per-tick modulation
    for (const c of chs) {
      if (c.pcm || c.curKey === null) continue;
      if (c.porta) c.portaAcc += c.porta;
      if (c.lfo.on) { if (c.lfo.delayCnt > 0) c.lfo.delayCnt--; else c.lfo.phase++; }
      const p = Math.round(pitchOf(c) * 4096) / 4096;
      if (!portaEv && p !== c.lastPitch) { events.push({ t, ch: c.idx, type: 'pitch', semis: p }); c.lastPitch = p; }
    }
    t++;
    for (const c of chs) if (c.wait > 0) c.wait--;
  }
  if (t >= maxTicks) warn('最大長に達したため打ち切り');
  for (const c of chs) keyOff(c, t);
  if (loopTick !== null) events.push({ t: loopTick, ch: -1, type: 'loopPoint' });
  events.sort((a, b) => a.t - b.t);
  return { events, endTick: t, loopTick, warnings, opmLfo, pcmKeys, isPcm, usedChannels: used };
}
