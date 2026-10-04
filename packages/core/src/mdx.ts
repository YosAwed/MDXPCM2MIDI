// MDX (MXDRV) file parser: header, voice table, channel data offsets.

export interface OpmOperator {
  dt1: number; mul: number; tl: number; ks: number; ar: number;
  ame: number; d1r: number; dt2: number; d2r: number; d1l: number; rr: number;
}

export interface OpmVoice {
  number: number;
  fl: number;   // feedback
  con: number;  // algorithm
  slotMask: number;
  ops: OpmOperator[]; // order as stored (M1, M2, C1, C2 in register order)
}

export interface MdxFile {
  title: string;
  pdxName: string;     // without extension, as written in file ('' if none)
  base: number;        // absolute offset that all offsets are relative to
  data: Uint8Array;
  voices: Map<number, OpmVoice>;
  channelOffsets: number[]; // absolute offsets, 9 or 16 channels
  pcm8: boolean;       // 16-channel (PCM8 extended) layout
}

export class MdxParseError extends Error {}

const sjis = (() => {
  try { return new TextDecoder('shift_jis'); } catch { return null; }
})();

export function decodeSjis(bytes: Uint8Array): string {
  if (sjis) return sjis.decode(bytes);
  return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : '?')).join('');
}

const u16 = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1];

export function parseMdx(data: Uint8Array): MdxFile {
  // Title ends with CR LF EOF (0x0d 0x0a 0x1a).
  let i = 0;
  while (i + 2 < data.length && !(data[i] === 0x0d && data[i + 1] === 0x0a && data[i + 2] === 0x1a)) i++;
  if (i + 2 >= data.length) throw new MdxParseError('MDX title terminator (0D 0A 1A) not found');
  const title = decodeSjis(data.subarray(0, i)).trim();
  i += 3;
  const pdxStart = i;
  while (i < data.length && data[i] !== 0) i++;
  if (i >= data.length) throw new MdxParseError('PDX name terminator not found');
  let pdxName = decodeSjis(data.subarray(pdxStart, i)).trim();
  pdxName = pdxName.replace(/\.pdx$/i, '');
  const base = i + 1;
  if (base + 20 > data.length) throw new MdxParseError('MDX body too short');

  if (isLzx(data, base)) {
    throw new MdxParseError('LZX圧縮されたMDXです(未対応)。展開済みのMDXを使ってください');
  }
  const voiceOff = u16(data, base);
  const firstCh = u16(data, base + 2);
  // PCM8 extended layout: 1 voice word + 16 channel words = 34 bytes header.
  const pcm8 = firstCh === 0x22;
  const nch = pcm8 ? 16 : 9;
  const channelOffsets: number[] = [];
  for (let c = 0; c < nch; c++) {
    const off = u16(data, base + 2 + c * 2);
    channelOffsets.push(base + off);
  }

  const voices = new Map<number, OpmVoice>();
  let vp = base + voiceOff;
  while (vp + 27 <= data.length) {
    const v = parseVoice(data, vp);
    if (!voices.has(v.number)) voices.set(v.number, v);
    vp += 27;
  }
  return { title, pdxName, base, data, voices, channelOffsets, pcm8 };
}

function isLzx(d: Uint8Array, base: number): boolean {
  // LZX-packed MDX embeds a 68000 depacker ("bra" + "LZX x.xx" signature) right after the header.
  for (let i = base; i < Math.min(d.length - 3, base + 16); i++) {
    if (d[i] === 0x4c && d[i + 1] === 0x5a && d[i + 2] === 0x58 && d[i + 3] === 0x20) return true;
  }
  return false;
}

function parseVoice(d: Uint8Array, p: number): OpmVoice {
  const flcon = d[p + 1];
  const ops: OpmOperator[] = [];
  // carriers in MDX (register) order M1, M2, C1, C2; MXDRV adds the volume to a carrier's TL and
  // saturates at 0x7f, so a carrier TL byte >= 0x80 means silent (not TL & 0x7f)
  const carriers = [8, 8, 8, 8, 12, 14, 14, 15][flcon & 7];
  for (let k = 0; k < 4; k++) {
    const dtmul = d[p + 3 + k], tl = d[p + 7 + k], ksar = d[p + 11 + k];
    const amed1r = d[p + 15 + k], dt2d2r = d[p + 19 + k], d1lrr = d[p + 23 + k];
    ops.push({
      dt1: (dtmul >> 4) & 7, mul: dtmul & 15, tl: tl >= 0x80 && (carriers >> k) & 1 ? 127 : tl & 127,
      ks: ksar >> 6, ar: ksar & 31, ame: amed1r >> 7, d1r: amed1r & 31,
      dt2: dt2d2r >> 6, d2r: dt2d2r & 31, d1l: d1lrr >> 4, rr: d1lrr & 15,
    });
  }
  return { number: d[p], fl: (flcon >> 3) & 7, con: flcon & 7, slotMask: d[p + 2], ops };
}

export const CHANNEL_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W'];
