// MDX -> MIDI conversion: maps sequencer events onto SMF tracks.

import { parseMdx, CHANNEL_NAMES, type MdxFile, type OpmVoice } from './mdx.js';
import { sequence, type SeqResult, type PcmKey } from './sequencer.js';
import { Track, writeSmf } from './smf.js';
import { defaultProgramFor, defaultDrumFor } from './gm.js';
import { assignOpmSlots, writeOpmBank, writeOpmEntries, applyVolume, type OpmEntry } from './opm.js';

export type PcmMode = 'sf2' | 'gm';
/** 'gm': guess GM programs. 'vopm': program change = slot in the exported .OPM bank (for VOPM). */
export type FmMode = 'gm' | 'vopm';

export interface ConvertOptions {
  loops?: number;               // default 2
  fadeSeconds?: number;         // fade out at end of looping songs (default 0 = none)
  fmMode?: FmMode;              // default 'gm'
  /**
   * How MDX volume (v / @v / ( )) is expressed on FM channels.
   * 'bake' (default for vopm): add the attenuation to the carrier TLs inside the .OPM voices,
   *   exactly like MXDRV, and select (voice, volume) pairs by program change.
   * 'cc7' (default for gm): channel volume. 'velocity': note-on velocity.
   */
  volumeMode?: 'cc7' | 'velocity' | 'bake';
  /** VOPM: send NRPN to set the OPM clock to 4 MHz like the X68000 (default true) */
  vopmClock4MHz?: boolean;
  /** VOPM: keep VOPM's built-in lowpass filter on (default false = off, closer to the X68000) */
  vopmLowpass?: boolean;
  /** VOPM: put every FM track on MIDI channel 1 (default true). FL Studio keeps each note's MIDI
   *  channel on import, and VOPMex keeps separate state per MIDI channel, so notes on ch2-8 would
   *  not use the voice shown in the editor. Default false: FL merges tracks sharing a channel. */
  vopmChannel1?: boolean;
  /** Silence inserted before the music, in beats (default 4 in VOPM mode, else 0). Setup events
   *  (RPN/NRPN, initial program, bank) stay at tick 0 so a DAW that swallows time-0 program
   *  changes as the "initial preset" still sees a real program change before the first note. */
  leadInBeats?: number;
  /** VOPM: voices with a MUL=0 operator (x0.5 on a real OPM) are written with every MUL doubled and
   *  their notes transposed down an octave, because VOPM does not reproduce MUL=0 as x0.5
   *  (bass voices then sound an octave too high). Default true in VOPM mode. */
  vopmMul0Fix?: boolean;
  pcmMode?: PcmMode;            // 'sf2': keys map to generated SoundFont; 'gm': GM drum map (default 'gm')
  bendRange?: number;           // semitones (default 12)
  ticksPerClock?: number;       // MIDI ticks per MDX clock (default 10 -> 480 PPQN)
  programMap?: Record<number, number>; // OPM voice number -> GM program (0-127)
  drumMap?: Record<number, number>;    // PDX sample index (bank*96+n) -> GM drum key
}

export interface PcmKeyAssignment extends PcmKey { midiKey: number }

export interface ChannelUsage {
  /** MDX voice number (FM) or -1 */
  voice: number;
  /** MXDRV volume attenuation in effect (0.75 dB steps) */
  att: number;
  /** MIDI program sent (VOPM slot or GM program), -1 if none */
  program: number;
  /** ADPCM: index into pcmKeys */
  pcmKey?: number;
  notes: number;
  firstSec: number;
  lastSec: number;
}

export interface ChannelReport {
  ch: string;            // MDX channel name A–H, P–W
  midiCh: number;        // 1-based MIDI channel
  kind: 'FM' | 'ADPCM';
  notes: number;
  usage: ChannelUsage[];
  /** FM: when the MDX voice (@n) actually changes between notes, in playback order */
  voiceTimeline: { sec: number; voice: number }[];
}

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
  opmSlots: Record<number, number>; // MDX voice number -> program slot in opmBank (not used in bake mode)
  /** VOPM banks. One shared bank, or one per FM channel when the song needs more than 128 (voice, volume) pairs. */
  opmBanks: { label: string; channels: string; text: string; voices: number }[];
  pcmKeys: PcmKeyAssignment[];  // for building the SoundFont (sf2 mode)
  seq: SeqResult;
  /** which voice/program/volume each channel uses, for reports */
  channels: ChannelReport[];
  fmMode: FmMode;
  volumeMode: 'cc7' | 'velocity' | 'bake';
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
  const warnings = [...seq.warnings];
  const volumeMode = options.volumeMode ?? (fmMode === 'vopm' ? 'bake' : 'cc7');
  const bake = fmMode === 'vopm' && volumeMode === 'bake';
  const mul0Fix = new Set<number>();
  let opmVoices = mdx.voices;
  if (fmMode === 'vopm' && options.vopmMul0Fix !== false) {
    opmVoices = new Map();
    for (const [n, v] of mdx.voices) {
      if (v.ops.some((o) => o.mul === 0) && v.ops.every((o) => o.mul <= 7)) {
        mul0Fix.add(n);
        opmVoices.set(n, { ...v, ops: v.ops.map((o) => ({ ...o, mul: o.mul === 0 ? 1 : o.mul * 2 })) });
      } else opmVoices.set(n, v);
    }
    const bad = [...mdx.voices].filter(([, v]) => v.ops.some((o) => o.mul === 0) && !v.ops.every((o) => o.mul <= 7)).map(([n]) => `@${n}`);
    if (bad.length) warnings.push(`MUL=0 を含むが補正できない音色があります (${bad.join(', ')}): VOPM では1オクターブ高く聞こえる可能性`);
  }
  let opmBank = writeOpmBank(opmVoices, { name: mdx.title, lfo: seq.opmLfo, slots: slotMap });
  let opmBanks: ConvertResult['opmBanks'] = [{ label: 'all', channels: 'ABCDEFGH', text: opmBank, voices: slotMap.size }];

  // --- volume baking: collect the (voice, attenuation) pairs each FM channel plays ---
  const VOLTAB = [0x2a, 0x28, 0x25, 0x22, 0x20, 0x1d, 0x1a, 0x18, 0x15, 0x12, 0x10, 0x0d, 0x0a, 0x08, 0x05, 0x02];
  const comboSlot: Map<string, number>[] = Array.from({ length: 8 }, () => new Map());
  const quant = new Array(8).fill(1);
  const qAtt = (ch: number, att: number) => Math.min(127, Math.round(att / quant[ch]) * quant[ch]);
  if (bake) {
    const perCh: Set<string>[] = Array.from({ length: 8 }, () => new Set());
    const cur = Array.from({ length: 8 }, () => ({ voice: -1, att: VOLTAB[8] }));
    const comboOrder: string[][] = Array.from({ length: 8 }, () => []);
    const collect = () => {
      for (const s of perCh) s.clear();
      for (const o of comboOrder) o.length = 0;
      for (const c of cur) { c.voice = -1; c.att = VOLTAB[8]; }
      for (const e of seq.events) {
        if (e.ch < 0 || e.ch >= 8) continue;
        if (e.type === 'voice' && mdx.voices.has(e.voice)) cur[e.ch].voice = e.voice;
        else if (e.type === 'volume') cur[e.ch].att = e.att;
        else if (e.type === 'noteOn' && cur[e.ch].voice >= 0) {
          const k = `${cur[e.ch].voice}:${qAtt(e.ch, cur[e.ch].att)}`;
          if (!perCh[e.ch].has(k)) { perCh[e.ch].add(k); comboOrder[e.ch].push(k); }
        }
      }
    };
    collect();
    // make every channel fit into 128 programs (coarser volume steps if needed)
    for (let ch = 0; ch < 8; ch++) while (perCh[ch].size > 128 && quant[ch] < 16) { quant[ch]++; collect(); }
    if (quant.some((q) => q > 1)) warnings.push('音量の段階が多いため一部チャンネルの音量を量子化しました');
    const all: string[] = [];
    for (const o of comboOrder) for (const k of o) if (!all.includes(k)) all.push(k);
    const entryFor = (k: string, slot: number): OpmEntry => {
      const [v, a] = k.split(':').map(Number);
      return { slot, voice: applyVolume(opmVoices.get(v)!, a), name: `MDX @${v} att${a}` };
    };
    if (all.length <= 128) {
      all.forEach((k, i) => { for (const m of comboSlot) m.set(k, i); });
      opmBank = writeOpmEntries(all.map(entryFor), { name: mdx.title, lfo: seq.opmLfo });
      opmBanks = [{ label: 'all', channels: 'ABCDEFGH', text: opmBank, voices: all.length }];
    } else {
      opmBanks = [];
      for (let ch = 0; ch < 8; ch++) {
        if (!comboOrder[ch].length) continue;
        comboOrder[ch].forEach((k, i) => comboSlot[ch].set(k, i));
        const text = writeOpmEntries(comboOrder[ch].map(entryFor), { name: `${mdx.title} ch${CHANNEL_NAMES[ch]}`, lfo: seq.opmLfo });
        opmBanks.push({ label: CHANNEL_NAMES[ch], channels: CHANNEL_NAMES[ch], text, voices: comboOrder[ch].length });
      }
      opmBank = opmBanks[0]?.text ?? opmBank;
      warnings.push('(音色×音量)の組が128を超えたため、FMチャンネルごとに別の .opm を出力しました');
    }
  }
  const curVoice = new Array(16).fill(-1), curAtt = new Array(16).fill(VOLTAB[8]), curProg = new Array(16).fill(-1);
  const usage = new Map<number, Map<string, ChannelUsage & { t0: number; t1: number }>>();
  const sounding = new Map<string, number>();
  let lastUsage: (ChannelUsage & { t0: number; t1: number }) | null = null;
  const timeline = new Map<number, { t: number; voice: number }[]>();
  const bakeState = Array.from({ length: 8 }, () => ({ voice: -1, att: VOLTAB[8], prog: -1 }));

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
  const vopmCh1 = fmMode === 'vopm' && options.vopmChannel1 === true;
  const midiChOf = (ch: number) => {
    if (ch < 8) return vopmCh1 ? 0 : ch;
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
      if (bake && ch < 8) tr.add(0, [0xb0 | mc, 7, 127], 1); // volume lives in the voices
      if (fmMode === 'vopm' && ch < 8) {
        // VOPM NRPN #0 = OPM clock (112+ -> 4 MHz), #2 = lowpass filter (0-63 off). Sent before the RPN.
        const clk = options.vopmClock4MHz === false ? 0 : 127;
        const lpf = options.vopmLowpass ? 127 : 0;
        tr.add(0, [0xb0 | mc, 99, 0, 0xb0 | mc, 98, 0, 0xb0 | mc, 6, clk, 0xb0 | mc, 99, 0, 0xb0 | mc, 98, 2, 0xb0 | mc, 6, lpf], 0);
      }
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

  // usage is recorded before the bake branch decides the program; fixProgram patches it in
  function recordUsage(ch: number, t: number, pcmKey?: number) {
    let m = usage.get(ch);
    if (!m) { m = new Map(); usage.set(ch, m); }
    const prog = ch < 8 ? curProg[ch] : -1;
    const k = ch < 8 ? `${curVoice[ch]}|${curAtt[ch]}|${bake ? '?' : prog}` : `p${pcmKey}|${curAtt[ch]}`;
    let u = m.get(k);
    if (!u) { u = { voice: ch < 8 ? curVoice[ch] : -1, att: curAtt[ch], program: prog, pcmKey, notes: 0, firstSec: 0, lastSec: 0, t0: t, t1: t }; m.set(k, u); }
    u.notes++; u.t1 = t;
    if (ch < 8) {
      let tl = timeline.get(ch);
      if (!tl) { tl = []; timeline.set(ch, tl); }
      if (!tl.length || tl[tl.length - 1].voice !== curVoice[ch]) tl.push({ t, voice: curVoice[ch] });
    }
    lastUsage = u;
  }
  function fixProgram(_ch: number, _t: number, prog: number) { if (lastUsage) lastUsage.program = prog; }

  function emit(e: (typeof seq.events)[number]) {
    if (e.ch < 0) return;
    const tr = trackFor(e.ch);
    const mc = midiChOf(e.ch);
    const T = e.t * S;
    if (e.type === 'voice' && mdx.voices.has(e.voice)) curVoice[e.ch] = e.voice;
    if (e.type === 'volume') curAtt[e.ch] = e.att;
    switch (e.type) {
      case 'noteOn': {
        let key = e.ch < 8 ? e.key : pcmKeys[e.key].midiKey;
        if (key < 0 || key > 127) { warnings.push(`音域外のノート ${key} を省略`); return; }
        recordUsage(e.ch, e.t, e.ch < 8 ? undefined : e.key);
        if (e.ch < 8 && mul0Fix.has(curVoice[e.ch])) {
          const k2 = key - 12;
          if (k2 >= 0) { sounding.set(`${e.ch}:${key}`, k2); key = k2; }
        }
        if (bake && e.ch < 8) {
          const st = bakeState[e.ch];
          if (st.voice >= 0) {
            const slot = comboSlot[e.ch].get(`${st.voice}:${qAtt(e.ch, st.att)}`);
            if (slot !== undefined && slot !== st.prog) { tr.add(T, [0xc0 | mc, slot], 3); st.prog = slot; }
            fixProgram(e.ch, e.t, st.prog);
          }
          tr.add(T, [0x90 | mc, key, 127], 6);
          break;
        }
        const vel = volumeMode === 'velocity' ? Math.max(1, chVel.get(e.ch) ?? 100) : 100;
        tr.add(T, [0x90 | mc, key, vel], 6);
        break;
      }
      case 'noteOff': {
        let key = e.ch < 8 ? e.key : pcmKeys[e.key].midiKey;
        const sk = `${e.ch}:${key}`;
        if (sounding.has(sk)) { key = sounding.get(sk)!; sounding.delete(sk); }
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
        if (bake && e.ch < 8) { bakeState[e.ch].voice = e.voice; programs[e.voice] = -1; break; }
        const prog = fmMode === 'vopm'
          ? (slotMap.get(e.voice) ?? 0)
          : options.programMap?.[e.voice] ?? defaultProgramFor(mdx.voices.get(e.voice));
        programs[e.voice] = prog;
        curProg[e.ch] = prog;
        tr.add(T, [0xc0 | mc, prog & 127], 3);
        break;
      }
      case 'volume':
        if (bake && e.ch < 8) { bakeState[e.ch].att = e.att; break; }
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

  // lead-in: shift musical events, keep setup (order < 2 at tick 0) in place
  const lead = Math.round((options.leadInBeats ?? (fmMode === 'vopm' ? 4 : 0)) * 48 * S);
  if (lead > 0) {
    for (const tr of [conductor, ...tracks.values()]) {
      for (const ev of tr.events) {
        const setup = ev.tick === 0 && ev.order < 2e7;
        if (!setup) ev.tick += lead;
      }
    }
    // also put a copy of each track's first program change at tick 0: if the DAW swallows that one
    // as the initial preset, the original (now at the end of the lead-in) is still sent as an event
    for (const tr of tracks.values()) {
      const first = tr.events.filter((e) => (e.bytes[0] & 0xf0) === 0xc0).sort((a, b) => a.tick - b.tick || a.order - b.order)[0];
      if (first) tr.add(0, [...first.bytes], 1);
    }
  }
  const ordered = [...tracks.entries()].sort((a, b) => a[0] - b[0]).map(([, tr]) => tr);
  const midi = writeSmf([conductor, ...ordered], 48 * S);
  const channels: ChannelReport[] = [...usage.entries()].sort((a, b) => a[0] - b[0]).map(([ch, m]) => {
    const list = [...m.values()].map(({ t0, t1, ...u }) => ({ ...u, firstSec: clockSec(t0), lastSec: clockSec(t1) }));
    list.sort((a, b) => a.firstSec - b.firstSec);
    return { ch: CHANNEL_NAMES[ch], midiCh: midiChOf(ch) + 1, kind: ch < 8 ? 'FM' : 'ADPCM', notes: list.reduce((a, u) => a + u.notes, 0), usage: list,
      voiceTimeline: (timeline.get(ch) ?? []).map((x) => ({ sec: clockSec(x.t), voice: x.voice })) };
  });
  return {
    channels, fmMode, volumeMode,
    midi, title: mdx.title, pdxName: mdx.pdxName, pcm8: mdx.pcm8,
    durationSec: clockSec(endT), loopSec: seq.loopTick !== null ? clockSec(seq.loopTick) : null,
    warnings, usedChannels: [...tracks.keys()].sort((a, b) => a - b).map((c) => CHANNEL_NAMES[c]),
    voices: [...mdx.voices.values()], programs, pcmKeys, seq,
    opmBank, opmBanks, opmSlots: Object.fromEntries(slotMap),
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
