// Virtual MXDRV sequencer: runs all channels on a shared 1-clock timeline and
// emits driver-agnostic events. Channel-to-channel sync (EF/EE), repeats,
// loops and tempo changes are resolved here.

import type { MdxFile } from './mdx.js';

export type SeqEvent =
  | { t: number; ch: number; type: 'noteOn'; note: number; key: number; legato?: boolean } // legato: tie to another note (no key-on, LFOs keep running)
  | { t: number; ch: number; type: 'noteOff'; key: number; legato?: boolean } // legato: ends the note a legato noteOn replaced
  | { t: number; ch: number; type: 'voice'; voice: number }
  | { t: number; ch: number; type: 'volume'; att: number } // OPM TL attenuation (0.75 dB steps)
  | { t: number; ch: number; type: 'pan'; pan: number }   // 0 off, 1 L, 2 R, 3 C
  | { t: number; ch: number; type: 'pitch'; semis: number } // offset from note in semitones
  | { t: number; ch: number; type: 'reg'; reg: number; data: number } // y command (FE): OPM register write
  | { t: number; ch: number; type: 'amlfo'; att: number }  // MXDRV amplitude-LFO attenuation added to the volume (0..127)
  // nativePitch only: the player runs MXDRV's portamento / detune / LFOs itself
  | { t: number; ch: number; type: 'porta'; raw: number; keep?: boolean } // F2 value (1/256 KF per clock) for the note (or tie) starting now; keep: stop without resetting the offset
  | { t: number; ch: number; type: 'detune'; value: number }   // 1/64 semitone
  | { t: number; ch: number; type: 'plfo'; mode: number; per: number; amp: number } // EC: mode = raw byte (0x80 off / 0x81 on / wave)
  | { t: number; ch: number; type: 'alfo'; mode: number; per: number; amp: number } // EB
  | { t: number; ch: number; type: 'lfodelay'; delay: number } // E9
  | { t: number; ch: -1; type: 'tempo'; timerB: number }
  | { t: number; ch: -1; type: 'fade'; speed: number }
  | { t: number; ch: -1; type: 'loopPoint' };

/** Information attached to ADPCM note-ons. */
export interface PcmKey { bank: number; sample: number; freq: number }

export interface OpmLfo { wave: number; sync: number; lfrq: number; pmd: number; amd: number; pms: number; ams: number }

export interface SeqOptions {
  loops?: number;       // how many times looping channels should play the loop body (default 2)
  maxTicks?: number;    // safety cap
  /** Emit portamento / detune / LFO parameters as events instead of folding them into 'pitch' / 'amlfo'. */
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
  /** How often each command byte (>= 0xE0) was executed, keyed by byte. */
  cmdCounts: Record<number, number>;
}

const CH_NAME = (i: number) => 'ABCDEFGHPQRSTUVW'[i] ?? String(i);
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
  detune: number;         // 1/64 semitone (F3)
  noteDetune: number;     // detune latched by the last note command ($0012)
  portaNext: number;      // pending portamento (F2 value: 1/256 KF per clock)
  porta: number;          // active for the current note until the next command fetch
  portaStop: boolean;
  portaAcc: number;       // 1/65536 KF (MXDRV $000c)
  bank: number;
  freq: number;
  curKey: number | null;  // MIDI key (FM) or PCM key index
  offAt: number;          // tick for key-off (-1: none)
  onAt: number;           // pending delayed key-on tick (-1: none)
  pendKey: number;
  pendNote: number;
  plfo: PitchLfo;
  alfo: AmpLfo;
  lfoDelay: number;       // E9 ($0024)
  lfoDelayCnt: number;    // $0025
  lastPitch: number;
  lastAm: number;
  repeat: Map<number, number>;
  cmdGuard: number;
  visited: Map<number, number>;
}

// ---- MXDRV 2.06 software LFOs (EC pitch / EB amplitude), stepped once per clock ----
export interface PitchLfo { on: boolean; wave: number; per: number; perInit: number; delta0: number; init: number; cnt: number; delta: number; val: number }
export interface AmpLfo { on: boolean; wave: number; per: number; delta0: number; init: number; cnt: number; delta: number; val: number }
export const newPitchLfo = (): PitchLfo => ({ on: false, wave: 0, per: 0, perInit: 0, delta0: 0, init: 0, cnt: 0, delta: 0, val: 0 });
export const newAmpLfo = (): AmpLfo => ({ on: false, wave: 0, per: 0, delta0: 0, init: 0, cnt: 0, delta: 0, val: 0 });
const w16 = (v: number) => { v &= 0xffff; return v & 0x8000 ? v - 0x10000 : v; };
/** MXDRV's LFO random generator (shared by all channels). */
export class MxRandom {
  seed = 0x1234;
  next(): number { const d0 = (this.seed * 0xc549 + 0x0c) >>> 0; this.seed = d0 & 0xffff; return d0 >>> 8; }
}
/** EC command. `m` is the mode byte (0x80 = MPOF, 0x81 = MPON, else wave (+4: amplitude x256)). */
export function setPitchLfo(l: PitchLfo, m: number, per: number, amp: number) {
  if (m & 0x80) { if (m & 1) { l.on = true; resetPitchLfo(l); } else { l.on = false; l.val = 0; } return; }
  const wave = m & 3;
  l.on = true; l.wave = wave; l.per = per & 0xffff;
  l.perInit = wave === 1 ? l.per : wave === 3 ? 1 : l.per >> 1;
  let d = w16(amp) * 256; if (m >= 4) d *= 256;
  l.delta0 = d | 0; l.init = wave === 2 ? l.delta0 : 0;
  resetPitchLfo(l);
}
export function resetPitchLfo(l: PitchLfo) { l.cnt = l.perInit; l.delta = l.delta0; l.val = l.init; }
export function stepPitchLfo(l: PitchLfo, rnd: MxRandom) {
  const dec = () => { l.cnt = (l.cnt - 1) & 0xffff; return l.cnt === 0; };
  switch (l.wave) {
    case 0: l.val = (l.val + l.delta) | 0; if (dec()) { l.cnt = l.per; l.val = -l.val | 0; } break;          // sawtooth
    case 1: l.val = l.delta; if (dec()) { l.cnt = l.per; l.delta = -l.delta | 0; } break;                   // square
    case 2: l.val = (l.val + l.delta) | 0; if (dec()) { l.cnt = l.per; l.delta = -l.delta | 0; } break;     // triangle
    default: if (dec()) { l.val = Math.imul(w16(rnd.next()), w16(l.delta)); l.cnt = l.per; }                // random
  }
}
/** EB command. */
export function setAmpLfo(l: AmpLfo, m: number, per: number, amp: number) {
  if (m & 0x80) { if (m & 1) { l.on = true; resetAmpLfo(l); } else { l.on = false; l.val = 0; } return; }
  const wave = m & 3;
  l.on = true; l.wave = wave; l.per = per & 0xffff; l.delta0 = w16(amp);
  const x = w16(wave & 1 ? -l.delta0 : -Math.imul(l.delta0, w16(per)));
  l.init = x < 0 ? 0 : x;
  resetAmpLfo(l);
}
export function resetAmpLfo(l: AmpLfo) { l.cnt = l.per; l.delta = l.delta0; l.val = l.init; }
export function stepAmpLfo(l: AmpLfo, rnd: MxRandom) {
  const dec = () => { l.cnt = (l.cnt - 1) & 0xffff; return l.cnt === 0; };
  switch (l.wave) {
    case 0: l.val = w16(l.val + l.delta); if (dec()) { l.cnt = l.per; l.val = l.init; } break;
    case 1: if (dec()) { l.cnt = l.per; l.val = w16(l.val + l.delta); l.delta = w16(-l.delta); } break;
    case 2: l.val = w16(l.val + l.delta); if (dec()) { l.cnt = l.per; l.delta = w16(-l.delta); } break;
    default: if (dec()) { l.val = w16(Math.imul(l.delta, w16(rnd.next()))); l.cnt = l.per; }
  }
}
/** Attenuation the amplitude LFO adds to the volume (MXDRV adds the high byte; overflow mutes). */
export const amLfoAtt = (l: AmpLfo) => (l.on ? (l.val >> 8) & 0xff : 0);

export function sequence(mdx: MdxFile, opts: SeqOptions = {}): SeqResult {
  const d = mdx.data;
  const loopsWanted = Math.max(1, opts.loops ?? 2);
  const maxTicks = opts.maxTicks ?? 48 * 4 * 1200; // ~1200 bars
  const portaEv = opts.nativePitch === true;
  const cmdCounts: Record<number, number> = {};
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
    vol: 8, q: 8, keyOnDelay: 0, noKeyOff: false, tiePrev: false, detune: 0, noteDetune: 0, portaNext: 0, porta: 0, portaStop: false, portaAcc: 0,
    bank: 0, freq: 4, curKey: null, offAt: -1, onAt: -1, pendKey: 0, pendNote: 0,
    plfo: newPitchLfo(), alfo: newAmpLfo(), lfoDelay: 0, lfoDelayCnt: 0, lastPitch: 0, lastAm: 0,
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
  const keyOff = (c: Ch, at: number, legato = false) => {
    if (c.curKey !== null) {
      events.push({ t: at, ch: c.idx, type: 'noteOff', key: c.curKey, ...(legato ? { legato } : {}) });
      c.curKey = null;
    }
  };

  const pushPorta = (c: Ch) => {
    replaceSameTick(c.idx, 'porta');
    events.push({ t, ch: c.idx, type: 'porta', raw: c.porta });
  };
  /** Drop an earlier event of the same kind for this channel in the current clock (one control note per key and time). */
  const replaceSameTick = (ch: number, type: SeqEvent['type']) => {
    for (let i = events.length - 1; i >= 0 && events[i].t === t; i--) {
      if (events[i].ch === ch && events[i].type === type) { events.splice(i, 1); break; }
    }
  };
  /** Key-on (not a tie): with an LFO delay set, MXDRV zeroes both LFOs and restarts them after the delay. */
  const lfoKeyOn = (c: Ch) => {
    if (c.pcm) return;
    c.lfoDelayCnt = c.lfoDelay;
    if (c.lfoDelay === 0) return;
    c.plfo.val = 0; c.alfo.val = 0;
    lfoDelayTick(c);
  };
  const lfoDelayTick = (c: Ch) => {
    c.lfoDelayCnt = (c.lfoDelayCnt - 1) & 0xff;
    if (c.lfoDelayCnt === 0) { if (c.plfo.on) resetPitchLfo(c.plfo); if (c.alfo.on) resetAmpLfo(c.alfo); }
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
    // portamento: MXDRV clears the accumulated offset on every note command (ties included)
    const hadPorta = c.portaAcc !== 0 || c.porta !== 0 || c.portaStop;
    c.portaStop = false;
    if (!c.pcm && c.detune !== c.noteDetune) {
      c.noteDetune = c.detune;
      if (portaEv) { replaceSameTick(c.idx, 'detune'); events.push({ t, ch: c.idx, type: 'detune', value: c.detune }); }
    }
    c.porta = c.portaNext; c.portaNext = 0; c.portaAcc = 0;

    if (c.tiePrev && !c.pcm && c.curKey === key) {
      // tie: keep the note sounding; LFOs keep running
      if (portaEv && (c.porta !== 0 || hadPorta)) pushPorta(c);
    } else if (c.tiePrev && !c.pcm && c.curKey !== null) {
      // tie (&) into a different note: MXDRV changes the pitch without a key-on (slur); LFOs keep running
      events.push({ t, ch: c.idx, type: 'noteOn', note, key, legato: true });
      keyOff(c, t, true);
      if (portaEv && (c.porta !== 0 || hadPorta)) pushPorta(c);
      c.curKey = key;
    } else {
      if (c.curKey !== null) keyOff(c, t);
      if (c.keyOnDelay > 0 && c.keyOnDelay < len) {
        c.onAt = t + c.keyOnDelay; c.pendKey = key; c.pendNote = note;
      } else {
        events.push({ t, ch: c.idx, type: 'noteOn', note, key });
        if (portaEv && c.porta !== 0) pushPorta(c);
        c.curKey = key;
        lfoKeyOn(c);
      }
    }
    c.tiePrev = thisNoKeyOff;
    c.offAt = thisNoKeyOff ? -1 : t + gate;
    c.wait = len;
  };

  const step = (c: Ch) => {
    // execute commands until something consumes time
    let guard = 0;
    if (!c.ended && !c.syncWait && c.wait === 0) { // MXDRV drops the portamento flag when it fetches the next command
      if (c.porta) c.portaStop = true;
      c.porta = 0;
    }
    while (!c.ended && !c.syncWait && c.wait === 0) {
      if (++guard > 20000) { warn(`ch ${c.idx}: 時間を消費しない無限ループを検出したため停止`); c.ended = true; break; }
      const p = c.pos;
      if (p >= d.length) { warn(`ch ${c.idx}: データ終端を越えた`); c.ended = true; break; }
      const cmd = d[p];
      if (cmd >= 0xe0) cmdCounts[cmd] = (cmdCounts[cmd] ?? 0) + 1;
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
        case 0xfe: // y: direct OPM register write (y$12 is MXDRV's tempo, like @t)
          if (u8(p + 1) === 0x12) events.push({ t, ch: -1, type: 'tempo', timerB: u8(p + 2) });
          else if (!c.pcm) events.push({ t, ch: c.idx, type: 'reg', reg: u8(p + 1), data: u8(p + 2) });
          c.pos = p + 3; break;
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
        case 0xf3: c.detune = s16(p + 1); c.pos = p + 3; break; // takes effect from the next note command
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
        case 0xec: case 0xeb: { // pitch / amplitude LFO
          const m = u8(p + 1);
          const per = m & 0x80 ? 0 : (u8(p + 2) << 8) | u8(p + 3), amp = m & 0x80 ? 0 : s16(p + 4);
          c.pos = m & 0x80 ? p + 2 : p + 6;
          if (c.pcm) break;
          if (cmd === 0xec) setPitchLfo(c.plfo, m, per, amp); else setAmpLfo(c.alfo, m, per, amp);
          if (portaEv) {
            const type = cmd === 0xec ? 'plfo' : 'alfo';
            // MP/MA (set) followed by MPON/MPOF in the same clock (common: "MP..., MD, MPON"): the set
            // carries the parameters, so keep it. ON after a set is the same as the set (both restart);
            // OFF is kept as a second event so a later MPON still finds the parameters.
            let prevSet = false;
            for (let i = events.length - 1; i >= 0 && events[i].t === t; i--) {
              const e = events[i];
              if (e.ch === c.idx && e.type === type) { prevSet = (e as { mode: number }).mode < 0x80; break; }
            }
            if (!(prevSet && m & 0x80)) replaceSameTick(c.idx, type);
            if (!(prevSet && m === 0x81)) events.push({ t, ch: c.idx, type, mode: m, per, amp });
          }
          break;
        }
        case 0xea: { // OPM hardware LFO: EA wave LFRQ PMD AMD PMS/AMS
          const m = u8(p + 1);
          if (m === 0x80 || m === 0x81) { c.pos = p + 2; break; }
          if (!opmLfo) opmLfo = { wave: m & 3, sync: (m >> 6) & 1, lfrq: u8(p + 2), pmd: u8(p + 3) & 0x7f, amd: u8(p + 4) & 0x7f, pms: (u8(p + 5) >> 4) & 7, ams: u8(p + 5) & 3 };
          c.pos = p + 6; break;
        }
        case 0xe9:
          c.lfoDelay = u8(p + 1); c.pos = p + 2;
          if (portaEv && !c.pcm) { replaceSameTick(c.idx, 'lfodelay'); events.push({ t, ch: c.idx, type: 'lfodelay', delay: c.lfoDelay }); }
          break;
        case 0xe8: c.pos = p + 1; break; // PCM8 mode enable
        case 0xe7: { // fade out: E7 01 speed
          events.push({ t, ch: -1, type: 'fade', speed: u8(p + 2) });
          c.pos = p + 3; break;
        }
        default:
          // MXDRV 2.06 treats E0-E6 (undefined) like the end of the track
          warn(`ch ${CH_NAME(c.idx)}: MXDRV 2.06 では未定義のコマンド 0x${cmd.toString(16).toUpperCase()} (オフセット 0x${p.toString(16)}) — MXDRV と同じくこのチャンネルを終了`);
          c.ended = true;
      }
    }
    if (c.portaStop) { // the fetched command was not a note: the portamento stops where it is
      c.portaStop = false;
      if (portaEv && !c.pcm) { replaceSameTick(c.idx, 'porta'); events.push({ t, ch: c.idx, type: 'porta', raw: 0, keep: true }); }
    }
  };

  const rnd = new MxRandom();
  /** Pitch offset in 1/64 semitone, as MXDRV computes it (integer KF). */
  const pitchKf = (c: Ch) => c.noteDetune + (portaEv ? 0 : (c.portaAcc >> 16)) + (portaEv ? 0 : (c.plfo.val >> 16));
  /** Per-clock modulation, done before the channel's commands like MXDRV's L001050. */
  const modulate = (c: Ch) => {
    if (c.pcm || c.ended) return;
    const keyOnPending = c.onAt > t;
    if (c.porta && !keyOnPending) c.portaAcc = (c.portaAcc + c.porta * 256) | 0;
    if (c.lfoDelay !== 0) {
      if (keyOnPending) return;
      if (c.lfoDelayCnt !== 0) { lfoDelayTick(c); return; }
    }
    if (c.plfo.on) stepPitchLfo(c.plfo, rnd);
    if (c.alfo.on) stepAmpLfo(c.alfo, rnd);
  };

  const allDone = () => chs.every((c) => c.ended || c.loops >= loopsWanted);
  while (t < maxTicks) {
    for (const c of chs) modulate(c);
    // key-offs and delayed key-ons scheduled for this tick
    for (const c of chs) {
      if (c.offAt === t) { keyOff(c, t); c.offAt = -1; }
      if (c.onAt === t) {
        events.push({ t, ch: c.idx, type: 'noteOn', note: c.pendNote, key: c.pendKey });
        if (portaEv && c.porta !== 0) pushPorta(c);
        c.curKey = c.pendKey; c.onAt = -1;
        lfoKeyOn(c);
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
    // resulting pitch / amplitude-LFO offsets for this clock
    if (!portaEv) for (const c of chs) {
      if (c.pcm) continue;
      const p = pitchKf(c) / 64;
      if (p !== c.lastPitch) { events.push({ t, ch: c.idx, type: 'pitch', semis: p }); c.lastPitch = p; }
      const a = amLfoAtt(c.alfo);
      if (a !== c.lastAm) { events.push({ t, ch: c.idx, type: 'amlfo', att: a }); c.lastAm = a; }
    }
    t++;
    for (const c of chs) if (c.wait > 0) c.wait--;
  }
  if (t >= maxTicks) warn('最大長に達したため打ち切り');
  for (const c of chs) keyOff(c, t);
  if (loopTick !== null) events.push({ t: loopTick, ch: -1, type: 'loopPoint' });
  events.sort((a, b) => a.t - b.t);
  return { events, endTick: t, loopTick, warnings, opmLfo, pcmKeys, isPcm, usedChannels: used, cmdCounts };
}
