// PDX (X68000 ADPCM sample bank) parser and MSM6258 ADPCM decoder.

export interface PdxFile {
  samples: (Uint8Array | null)[]; // index = bank*96 + n
}

export function parsePdx(data: Uint8Array): PdxFile {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Header = consecutive (offset,length) u32 BE pairs. Normally 96 entries, but
  // some tools write shorter headers and EX-PDX has multiple banks; the header
  // ends where the first sample data begins.
  let headerEnd = Math.min(data.length, 96 * 8 * 16);
  const samples: (Uint8Array | null)[] = [];
  for (let i = 0; i * 8 + 8 <= headerEnd; i++) {
    const off = dv.getUint32(i * 8), len = dv.getUint32(i * 8 + 4);
    if (len > 0 && off >= 8 && off < headerEnd) headerEnd = off;
    if (i * 8 + 8 > headerEnd) break;
    if (len === 0 || off + len > data.length || off < (i + 1) * 8) { samples.push(null); continue; }
    samples.push(data.subarray(off, off + len));
  }
  return { samples };
}

const STEP = [
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
  190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552,
];
const ADJ = [-1, -1, -1, -1, 2, 4, 6, 8];

/** Decode OKI MSM6258 4-bit ADPCM (low nibble first) to 16-bit PCM. */
export function decodeAdpcm(src: Uint8Array): Int16Array {
  const out = new Int16Array(src.length * 2);
  let sig = 0, idx = 0, o = 0;
  const nib = (n: number) => {
    const step = STEP[idx];
    let diff = step >> 3;
    if (n & 1) diff += step >> 2;
    if (n & 2) diff += step >> 1;
    if (n & 4) diff += step;
    sig += n & 8 ? -diff : diff;
    if (sig > 2047) sig = 2047; else if (sig < -2048) sig = -2048;
    idx += ADJ[n & 7];
    if (idx < 0) idx = 0; else if (idx > 48) idx = 48;
    out[o++] = sig << 4;
  };
  for (let i = 0; i < src.length; i++) { nib(src[i] & 15); nib(src[i] >> 4); }
  return out;
}

export const ADPCM_RATES = [3906, 5208, 7812, 10417, 15625];

/** Decode a PDX sample according to the MXDRV/PCM8 frequency code. */
export function decodePdxSample(src: Uint8Array, freq: number): { pcm: Int16Array; rate: number } {
  if (freq === 5) { // PCM8: 16-bit signed big-endian
    const n = src.length >> 1, pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = (src[i * 2] << 8) | src[i * 2 + 1]; pcm[i] = v & 0x8000 ? v - 0x10000 : v; }
    return { pcm, rate: 15625 };
  }
  if (freq === 6) { // PCM8: 8-bit signed
    const pcm = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) pcm[i] = ((src[i] << 24) >> 24) << 8;
    return { pcm, rate: 15625 };
  }
  return { pcm: decodeAdpcm(src), rate: ADPCM_RATES[freq] ?? 15625 };
}

/** Output rate of {@link x68AdpcmOutput}: the X68000 ADPCM / PCM8 output chain runs at 62.5 kHz (x68sound). */
export const X68_ADPCM_OUT_RATE = 62500;

/**
 * The X68000's analog ADPCM output as x68sound (portable_mdx) models it, so that a decoded sample sounds like
 * MXDRV's: the MSM6258 output is held at 62.5 kHz (10-bit DAC for ADPCM), goes through two DC-blocking high-pass
 * stages (~320 Hz and ~60 Hz) that restart at every key-on, and through the 2nd-order low-pass of the mixer
 * (-4 dB at 4 kHz, -12 dB at 7 kHz). Without it the samples are bassier and brighter than on the real machine.
 */
export function x68AdpcmOutput(pcm: Int16Array, rate: number, adpcm = true): { pcm: Int16Array; rate: number } {
  const R = X68_ADPCM_OUT_RATE;
  const n = Math.ceil((pcm.length * R) / rate);
  const tail = 128; // let the low-pass ring out
  const out = new Int16Array(n + tail);
  const a1 = 1 - 1 / 32 - 1 / 1024, a2 = 1 - 1 / 256 - 1 / 512 - 1 / 4096;
  const b1 = 1537 / 1024, b2 = 617 / 1024, lpGain = 4 / (1 - b1 + b2);
  let xp = 0, h1 = 0, h1p = 0, h2 = 0, l1 = 0, l2 = 0, u1 = 0, u2 = 0;
  for (let i = 0; i < n + tail; i++) {
    let x = 0;
    if (i < n) {
      const v = pcm[Math.min(pcm.length - 1, Math.floor((i * rate) / R))];
      x = adpcm ? (v >> 6) << 6 : v; // 12-bit decoder value << 4 -> drop the 2 LSBs like the 10-bit DAC
    }
    if (i < n) { h1 = x - xp + a1 * h1; xp = x; h2 = h1 - h1p + a2 * h2; h1p = h1; } else h2 = 0; // ADPCM stops: no input
    const y = (h2 + 2 * u1 + u2 + b1 * l1 - b2 * l2) / lpGain;
    u2 = u1; u1 = h2; l2 = l1; l1 = y * lpGain;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(y)));
  }
  return { pcm: out, rate: R };
}
