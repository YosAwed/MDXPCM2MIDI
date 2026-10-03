// MDX -> MIDI conversion: maps sequencer events onto SMF tracks.

import { parseMdx, CHANNEL_NAMES, type MdxFile, type OpmVoice } from './mdx.js';
import { sequence, type SeqResult, type PcmKey } from './sequencer.js';
import { Track, writeSmf } from './smf.js';
import { defaultProgramFor, defaultDrumFor } from './gm.js';
import { assignOpmSlots, writeOpmBank } from './opm.js';

export type PcmMode = 'sf2' | 'gm';
/** 'gm': guess GM programs. 'vopm': program change = slot in the exported .OPM bank (for VOPM). */
export type FmMode = 'gm' | 'vopm';

export interface ConvertOptions {
  loops?: number;               // default 2
  fadeSeconds?: number;         // fade out at end of looping songs (default 0 = none)
  fmMode?: FmMode;              // default 'gm'
  volumeMode?: 'cc7' | 'velocity'; // how MDX volume is expressed (default 'cc7')
  pcmMode?: PcmMode;            // 'sf2': keys map to generated SoundFont; 'gm': GM drum map (default 'gm')
  bendRange?: number;           // semitones (default 12)
  ticksPerClock?: number;       // MIDI ticks per MDX clock (default 10 -> 480 PPQN)
  programMap?: Record<number, number>; // OPM voice number -> GM program (0-127)
  drumMap?: Record<number, number>;    // PDX sample index (bank*96+n) -> GM drum key
}

export interface PcmKeyAssignment extends PcmKey { midiKey: number }

export interface ConvertResult {
  midi: Uint8Array;
  title: string;
  pdxName: string;
  pcm8: boolean;
  durationSec: number;
  loopSec: number | null;
  warnings: string[];
  usedChannels: string[];
  voices: OpmVoice[];
  programs: Record<number, number>;
  opmBank: string;              // VOPM/MiOPMdrv .OPM text with the voices used by this song
  opmSlots: Record<number, number>; // MDX voice number -> program slot in opmBank
  pcmKeys: PcmKeyAssignment[];  // for building the SoundFont (sf2 mode)
  seq: SeqResult;
}

const PCM_MIDI_CH_SF2 = [9, 8, 10, 11, 12, 13, 14, 15];
export const PDX_SF2_BANK_MELODIC = 127; // CC0 value used on non-drum channels for the PDX kit

export function convertMdx(input: Uint8Array | MdxFile, options: ConvertOptions = {}): ConvertResult {
  const mdx = input instanceof Uint8Array ? parseMdx(input) : input;
  const loops = options.loops ?? 2;
  const pcmMode = options.pcmMode ?? 'gm';
  const bendRange = options.bendRange ?? 12;
  const S = options.ticksPerClock ?? 10;
  const seq = sequence(mdx, { loops });
  const fmMode = options.fmMode ?? 'gm';
  const usedVoices = seq.events.filter((e) => e.type === 'voice' && seq.usedChannels[e.ch]).map((e) => (e as { voice: number }).voice).filter((v) => mdx.voices.has(v));
  const slotMap = assignOpmSlots(usedVoices.length ? usedVoices : [...mdx.voices.keys()]);
  const opmBank = writeOpmBank(mdx.voices, { name: mdx.title, lfo: seq.opmLfo, slots: slotMap });
  const warnings = [...seq.warnings];

  // PCM key assignment
  const base = seq.pcmKeys.length <= 92 ? 36 : 0;
  const pcmKeys: PcmKeyAssignment[] = seq.pcmKeys.map((k, i) => {
    let midiKey: number;
    if (pcmMode === 'sf2') midiKey = Math.min(127, base + i);
    else {
      const idx = k.bank * 96 + k.sample;
      midiKey = options.drumMap?.[idx] ?? defaultDrumFor(idx);
    }
    return { ...k, midiKey };
  });
  if (pcmMode === 'sf2' && seq.pcmKeys.length > 128) warnings.push('ADPCMの音色が128種を超えたため一部が重なります');

  const conductor = new Track();
  conductor.text(0, 0x03, mdx.title || 'MDX');
  conductor.text(0, 0x01, `Converted from MDX by MDXPCM2MIDI${mdx.pdxName ? ` (PDX: ${mdx.pdxName})` : ''}`);
  conductor.meta(0, 0x58, [4, 2, 24, 8]);

  // tempo map for duration calculation
  const tempos: { t: number; us: number }[] = [];
  const programs: Record<number, number> = {};
  const tracks = new Map<number, Track>();
  const midiChOf = (ch: number) => {
    if (ch < 8) return ch;
    const j = ch - 8;
    return pcmMode === 'sf2' ? PCM_MIDI_CH_SF2[j] : 9;
  };
  const trackFor = (ch: number) => {
    let tr = tracks.get(ch);
    if (!tr) {
      tr = new Track();
      const mc = midiChOf(ch);
      tr.text(0, 0x03, `${ch < 8 ? 'FM' : 'ADPCM'} ${CHANNEL_NAMES[ch]}`);
      // RPN pitch bend range
      if (ch < 8) tr.add(0, [0xb0 | mc, 101, 0, 0xb0 | mc, 100, 0, 0xb0 | mc, 6, bendRange, 0xb0 | mc, 38, 0], 1);
      if (ch >= 8 && pcmMode === 'sf2' && mc !== 9) tr.add(0, [0xb0 | mc, 0, PDX_SF2_BANK_MELODIC, 0xb0 | mc, 32, 0, 0xc0 | mc, 0], 1);
      tr.add(0, [0xb0 | mc, 11, 127], 1); lastCc.set(`${ch}:11`, 127);
      tracks.set(ch, tr);
    }
    return tr;
  };
  const lastCc = new Map<string, number>();
  const cc = (tr: Track, ch: number, T: number, mc: number, num: number, val: number) => {
    const k = `${ch}:${num}`;
    if (lastCc.get(k) === val) return;
    lastCc.set(k, val);
    tr.add(T, [0xb0 | mc, num, val], 3);
  };
  const ccFromAtt = (att: number) => Math.max(0, Math.min(127, Math.round(127 * Math.pow(10, (-0.75 * att) / 40))));

  let fadeStart: number | null = null;
  const volumeMode = options.volumeMode ?? 'cc7';
  const chVel = new Map<number, number>();
  for (const e of seq.events) {
    const T = e.t * S;
    if (e.ch === -1) {
      if (e.type === 'tempo') {
        if (tempos.length && tempos[tempos.length - 1].us === 12288 * (256 - e.timerB)) continue;
        const us = 12288 * (256 - e.timerB);
        tempos.push({ t: e.t, us });
        conductor.meta(T, 0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255], 1);
      } else if (e.type === 'loopPoint') {
        conductor.text(T, 0x06, 'loopStart');
      } else if (e.type === 'fade') {
        if (fadeStart === null) fadeStart = e.t;
      }
      continue;
    }
    if (!seq.usedChannels[e.ch]) continue; // channel never plays a note
    emit(e);
  }

  function emit(e: (typeof seq.events)[number]) {
    if (e.ch < 0) return;
    const tr = trackFor(e.ch);
    const mc = midiChOf(e.ch);
    const T = e.t * S;
    switch (e.type) {
      case 'noteOn': {
        const key = e.ch < 8 ? e.key : pcmKeys[e.key].midiKey;
        if (key < 0 || key > 127) { warnings.push(`音域外のノート ${key} を省略`); return; }
        const vel = volumeMode === 'velocity' ? Math.max(1, chVel.get(e.ch) ?? 100) : 100;
        tr.add(T, [0x90 | mc, key, vel], 6);
        break;
      }
      case 'noteOff': {
        const key = e.ch < 8 ? e.key : pcmKeys[e.key].midiKey;
        if (key < 0 || key > 127) return;
        tr.add(T, [0x80 | mc, key, 0], 2);
        break;
      }
      case 'voice': {
        if (!mdx.voices.has(e.voice)) {
          // MXDRV keeps the previous voice when @n is not defined
          const w = `音色 @${e.voice} がMDXに定義されていないため無視しました`;
          if (!warnings.includes(w)) warnings.push(w);
          break;
        }
        const prog = fmMode === 'vopm'
          ? (slotMap.get(e.voice) ?? 0)
          : options.programMap?.[e.voice] ?? defaultProgramFor(mdx.voices.get(e.voice));
        programs[e.voice] = prog;
        tr.add(T, [0xc0 | mc, prog & 127], 3);
        break;
      }
      case 'volume':
        if (volumeMode === 'velocity') chVel.set(e.ch, ccFromAtt(e.att));
        else cc(tr, e.ch, T, mc, 7, ccFromAtt(e.att));
        break;
      case 'pan': {
        const v = [64, 0, 127, 64][e.pan];
        cc(tr, e.ch, T, mc, 10, v);
        cc(tr, e.ch, T, mc, 11, e.pan === 0 ? 0 : 127);
        break;
      }
      case 'pitch': {
        let v = Math.round(8192 + (e.semis / bendRange) * 8192);
        v = Math.max(0, Math.min(16383, v));
        tr.add(T, [0xe0 | mc, v & 127, v >> 7], 4);
        break;
      }
    }
  }

  // fade: explicit E7 or requested fade at the end of looping songs
  let endT = seq.endTick;
  const fadeSec = options.fadeSeconds ?? 0;
  const clockSec = (t: number) => clockToSec(tempos, t);
  if (fadeStart !== null || (fadeSec > 0 && seq.loopTick !== null)) {
    let from: number;
    if (fadeStart !== null) { from = fadeStart; endT = Math.min(endT, fadeStart + 48 * 8); }
    else { from = secToClock(tempos, Math.max(0, clockSec(endT) - fadeSec)); }
    const steps = 32;
    for (const [ch, tr] of tracks) {
      const mc = midiChOf(ch);
      for (let i = 1; i <= steps; i++) {
        const t = Math.round(from + ((endT - from) * i) / steps);
        tr.add(t * S, [0xb0 | mc, 11, Math.round(127 * (1 - i / steps))], 3);
      }
    }
  }
  // close everything at endT
  for (const [ch, tr] of tracks) {
    const mc = midiChOf(ch);
    tr.events = tr.events.filter((ev) => ev.tick <= endT * S);
    tr.add(endT * S, [0xb0 | mc, 123, 0], 9);
  }
  conductor.meta(endT * S, 0x01, Array.from(new TextEncoder().encode('end')), 9);

  const ordered = [...tracks.entries()].sort((a, b) => a[0] - b[0]).map(([, tr]) => tr);
  const midi = writeSmf([conductor, ...ordered], 48 * S);
  return {
    midi, title: mdx.title, pdxName: mdx.pdxName, pcm8: mdx.pcm8,
    durationSec: clockSec(endT), loopSec: seq.loopTick !== null ? clockSec(seq.loopTick) : null,
    warnings, usedChannels: [...tracks.keys()].sort((a, b) => a - b).map((c) => CHANNEL_NAMES[c]),
    voices: [...mdx.voices.values()], programs, pcmKeys, seq,
    opmBank, opmSlots: Object.fromEntries(slotMap),
  };
}

function clockToSec(tempos: { t: number; us: number }[], t: number): number {
  let sec = 0, lastT = 0, us = 12288 * (256 - 200);
  for (const tp of tempos) {
    if (tp.t >= t) break;
    sec += ((tp.t - lastT) * us) / 48 / 1e6;
    lastT = tp.t; us = tp.us;
  }
  return sec + ((t - lastT) * us) / 48 / 1e6;
}
function secToClock(tempos: { t: number; us: number }[], s: number): number {
  let lo = 0, hi = 1 << 24;
  while (lo < hi) { const m = (lo + hi) >> 1; if (clockToSec(tempos, m) < s) lo = m + 1; else hi = m; }
  return lo;
}
