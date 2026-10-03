import { describe, it, expect } from 'vitest';
import { parseMdx, sequence, convert, parsePdx, decodeAdpcm, writeSf2 } from '../src/index.js';

/** Build a minimal 9-channel MDX. Channel A gets `chA`, others just end. */
function mdx(chA: number[], title = 'TEST', pdx = ''): Uint8Array {
  const head = [...new TextEncoder().encode(title), 0x0d, 0x0a, 0x1a, ...new TextEncoder().encode(pdx), 0];
  const voice = [0, 0x3a, 0x0f, ...new Array(24).fill(0)];
  const end = [0xf1, 0x00];
  const body: number[] = [];
  const hdr = 2 + 9 * 2;
  let off = hdr;
  const offs: number[] = [];
  const chans = [chA, ...new Array(8).fill(end)];
  for (const c of chans) { offs.push(off); off += c.length; }
  const voiceOff = off;
  body.push(voiceOff >> 8, voiceOff & 255);
  for (const o of offs) body.push(o >> 8, o & 255);
  for (const c of chans) body.push(...c);
  body.push(...voice);
  return Uint8Array.from([...head, ...body]);
}

describe('mdx', () => {
  it('parses header', () => {
    const m = parseMdx(mdx([0xf1, 0], 'Hello', 'drums'));
    expect(m.title).toBe('Hello');
    expect(m.pdxName).toBe('drums');
    expect(m.channelOffsets).toHaveLength(9);
    expect(m.voices.size).toBe(1);
  });

  it('expands repeats with escape', () => {
    // [ c4 | d4 ]3 e4 : F6 03 00, note, F4 -> F5, note, F5 back, note, end
    const body = [
      0xf6, 0x03, 0x00,          // 0: repeat start (body at 3)
      0xa0, 47,                  // 3: note
      0xf4, 0x00, 0x03,          // 5: escape -> target F5 operand (8+3-1 = 10)
      0xa2, 47,                  // 8: note
      0xf5, 0xff, 0xf6,          // 10: back to 3 (13 + -10 = 3)
      0xa4, 47,                  // 13
      0xf1, 0x00,
    ];
    const r = sequence(parseMdx(mdx(body)));
    const notes = r.events.filter((e) => e.type === 'noteOn').map((e) => (e as { note: number }).note);
    expect(notes).toEqual([0x20, 0x22, 0x20, 0x22, 0x20, 0x24]);
    expect(r.endTick).toBe(48 * 6);
  });

  it('writes a valid SMF', () => {
    const r = convert(mdx([0xff, 200, 0xa0, 47, 0xf1, 0]));
    expect(Array.from(r.midi.subarray(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    expect(r.durationSec).toBeGreaterThan(0);
  });

  it('rejects LZX packed MDX', () => {
    const d = mdx([0xf1, 0]);
    const base = d.indexOf(0, 8) + 1;
    d.set([0x60, 0x26, 0x60, 0x32, 0x4c, 0x5a, 0x58, 0x20], base);
    expect(() => parseMdx(d)).toThrow(/LZX/);
  });
});

describe('pdx / sf2', () => {
  it('parses a PDX with a short header and decodes ADPCM', () => {
    const pdx = new Uint8Array(16 + 4);
    const dv = new DataView(pdx.buffer);
    dv.setUint32(0, 16); dv.setUint32(4, 4); // entry 0
    pdx.set([0x08, 0x80, 0x77, 0x11], 16);
    const p = parsePdx(pdx);
    expect(p.samples[0]?.length).toBe(4);
    expect(decodeAdpcm(p.samples[0]!)).toHaveLength(8);
  });
  it('writes a RIFF sfbk', () => {
    const sf = writeSf2([{ name: 's', pcm: new Int16Array(100), rate: 15625, key: 36 }]);
    expect(new TextDecoder().decode(sf.subarray(8, 12))).toBe('sfbk');
    expect(new DataView(sf.buffer).getUint32(4, true)).toBe(sf.length - 8);
  });
});
