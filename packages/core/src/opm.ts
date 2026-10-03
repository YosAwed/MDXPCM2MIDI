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

export function writeOpmBank(voices: Map<number, OpmVoice>, opts: OpmBankOptions = {}): string {
  const slots = opts.slots ?? assignOpmSlots([...voices.keys()].filter((n) => n < 128));
  const bySlot = new Map<number, OpmVoice>();
  for (const [num, slot] of slots) { const v = voices.get(num); if (v) bySlot.set(slot, v); }
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
    const v = bySlot.get(slot);
    const num = [...slots].find(([, s]) => s === slot)?.[0];
    if (!v) {
      L.push(`@:${slot} no Name`, `LFO:  0   0   0   0   0`, `CH: 64   0   0   0   0 120   0`);
      for (const [nm] of OP_ORDER) L.push(`${nm}: 31   0   0  15   0 127   0   1   0   0   0`);
      L.push('');
      continue;
    }
    L.push(`@:${slot} MDX @${num}`);
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
