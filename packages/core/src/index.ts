export * from './mdx.js';
export { unlzx, isLzx } from './lzx.js';
export * from './sequencer.js';
export * from './convert.js';
export * from './pdx.js';
export * from './sf2.js';
export * from './gm.js';
export * from './opm.js';
export * from './report.js';
export * from './opm68ctl.js';
export * from './flp.js';
export * from './flp-arrange.js';
export { writeSmf, Track } from './smf.js';

import { convertMdx, PDX_SF2_BANK_MELODIC, type ConvertOptions, type ConvertResult } from './convert.js';
import { parsePdx, decodePdxSample } from './pdx.js';
import { writeSf2, type Sf2Sample } from './sf2.js';

export interface FullResult extends ConvertResult {
  sf2: Uint8Array | null;
  missingSamples: number[];
}

/** Convert MDX (+ optional PDX). With a PDX, ADPCM channels use the generated SoundFont. */
export function convert(mdx: Uint8Array, pdx?: Uint8Array | null, options: ConvertOptions = {}): FullResult {
  const opts: ConvertOptions = { ...options, pcmMode: options.pcmMode ?? (pdx ? 'sf2' : 'gm') };
  const res = convertMdx(mdx, opts);
  let sf2: Uint8Array | null = null;
  const missing: number[] = [];
  if (pdx && opts.pcmMode === 'sf2' && res.pcmKeys.length > 0) {
    const bank = parsePdx(pdx);
    const samples: Sf2Sample[] = [];
    for (const k of res.pcmKeys) {
      const idx = k.bank * 96 + k.sample;
      // Plain MXDRV ignores @n on the ADPCM channel; fall back to bank 0 when the bank doesn't exist.
      const raw = bank.samples[idx] ?? (k.bank > 0 ? bank.samples[k.sample] : null);
      if (!raw) { missing.push(idx); continue; }
      const { pcm, rate } = decodePdxSample(raw, k.freq);
      samples.push({ name: `${res.pdxName || 'pdx'}_${idx}_f${k.freq}`.slice(0, 20), pcm, rate, key: k.midiKey });
    }
    if (missing.length) res.warnings.push(`PDXに存在しないサンプル: ${[...new Set(missing)].join(', ')}`);
    const name = (res.pdxName || 'PDX').slice(0, 16);
    sf2 = writeSf2(samples, {
      name,
      presets: [
        { name: `${name} Kit`, bank: 128, program: 0 },
        { name: `${name} Melodic`, bank: PDX_SF2_BANK_MELODIC, program: 0 },
      ],
    });
  }
  return { ...res, sf2, missingSamples: missing };
}
