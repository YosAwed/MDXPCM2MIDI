// Export MDX voices as a VOPM / MiOPMdrv ".OPM" sound bank.

import type { OpmVoice } from './mdx.js';
import type { OpmLfo } from './sequencer.js';

/**
 * Assign VOPM program slots (0-127) to MDX voice numbers. Voice numbers are kept
 * as-is when they all fit, otherwise used voices are packed in ascending order.
 */
export function assignOpmSlots(voiceNumbers: number[]): Map<number, number> {
  const nums = [...new Set(voiceNumbers)].sort((a, b) => a - b);
  const map = new Map<number, number>();
  if (nums.every((n) => n < 128)) for (const n of nums) map.set(n, n);
  else nums.slice(0, 128).forEach((n, i) => map.set(n, i));
  return map;
}

export interface OpmBankOptions {
  name?: string;
  lfo?: OpmLfo | null;
  /** only write these voices (MDX voice number -> slot); default: all voices with their own number */
  slots?: Map<number, number>;
}

// MDX stores operators in register order M1, M2, C1, C2; .OPM lists M1, C1, M2, C2.
const OP_ORDER: [string, number][] = [['M1', 0], ['C1', 2], ['M2', 1], ['C2', 3]];

/** Carrier operators per algorithm, as indices in register order (M1, M2, C1, C2). */
export const CARRIERS: number[][] = [[3], [3], [3], [3], [2, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];

/** Return a copy of the voice with MXDRV volume attenuation added to the carrier TLs. */
export function applyVolume(v: OpmVoice, att: number): OpmVoice {
  const cs = CARRIERS[v.con] ?? [3];
  return { ...v, ops: v.ops.map((o, i) => (cs.includes(i) ? { ...o, tl: Math.min(127, o.tl + att) } : o)) };
}

export interface OpmEntry { slot: number; voice: OpmVoice; name: string }

export function writeOpmBank(voices: Map<number, OpmVoice>, opts: OpmBankOptions = {}): string {
  const slots = opts.slots ?? assignOpmSlots([...voices.keys()].filter((n) => n < 128));
  const entries: OpmEntry[] = [];
  for (const [num, slot] of slots) { const v = voices.get(num); if (v) entries.push({ slot, voice: v, name: `MDX @${num}` }); }
  return writeOpmEntries(entries, opts);
}

export function writeOpmEntries(entries: OpmEntry[], opts: { name?: string; lfo?: OpmLfo | null } = {}): string {
  const bySlot = new Map(entries.map((e) => [e.slot, e]));
  const lfo = opts.lfo;
  const L: string[] = [
    `//MiOPMdrv sound bank Paramer Ver2002.04.22`,
    `// ${opts.name ?? 'MDX'} - converted by MDXPCM2MIDI`,
    `//LFO: LFRQ AMD PMD WF NFRQ`,
    `//@:[Num] [Name]`,
    `//CH: PAN FL CON AMS PMS SLOT NE`,
    `//[OPname]: AR D1R D2R RR D1L TL KS MUL DT1 DT2 AMS-EN`,
    '',
  ];
  const pad = (n: number) => String(n).padStart(3, ' ');
  for (let slot = 0; slot < 128; slot++) {
    const e = bySlot.get(slot);
    if (!e) {
      L.push(`@:${slot} no Name`, `LFO:  0   0   0   0   0`, `CH: 64   0   0   0   0 120   0`);
      for (const [nm] of OP_ORDER) L.push(`${nm}: 31   0   0  15   0 127   0   1   0   0   0`);
      L.push('');
      continue;
    }
    const v = e.voice;
    L.push(`@:${slot} ${e.name}`);
    L.push(`LFO:${pad(lfo?.lfrq ?? 0)} ${pad(lfo?.amd ?? 0)} ${pad(lfo?.pmd ?? 0)} ${pad(lfo?.wave ?? 0)}   0`);
    L.push(`CH: 64 ${pad(v.fl)} ${pad(v.con)} ${pad(lfo?.ams ?? 0)} ${pad(lfo?.pms ?? 0)} ${pad((v.slotMask & 15) << 3)}   0`);
    for (const [nm, i] of OP_ORDER) {
      const o = v.ops[i];
      L.push(`${nm}:${[o.ar, o.d1r, o.d2r, o.rr, o.d1l, o.tl, o.ks, o.mul, o.dt1, o.dt2, o.ame << 7].map(pad).join(' ')}`);
    }
    L.push('');
  }
  return L.join('\r\n');
}
