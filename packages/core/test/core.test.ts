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

describe('opm bank', () => {
  it('writes VOPM bank with operator order M1 C1 M2 C2 and keeps @numbers as slots', async () => {
    const { writeOpmBank, assignOpmSlots, parseMdx } = await import('../src/index.js');
    const d = mdx([0xfd, 0x00, 0xa0, 47, 0xf1, 0]);
    const m = parseMdx(d);
    const v = m.voices.get(0)!;
    v.ops[0].tl = 10; v.ops[1].tl = 20; v.ops[2].tl = 30; v.ops[3].tl = 40; v.ops[3].ame = 1;
    const txt = writeOpmBank(m.voices, { slots: assignOpmSlots([0]) });
    const lines = txt.split('\r\n');
    const at = lines.indexOf('@:0 MDX @0');
    expect(at).toBeGreaterThan(0);
    const tl = (s: string) => +s.trim().split(/\s+/)[6];
    expect(lines[at + 3].startsWith('M1:') && tl(lines[at + 3])).toBe(10);
    expect(lines[at + 4].startsWith('C1:') && tl(lines[at + 4])).toBe(30);
    expect(lines[at + 5].startsWith('M2:') && tl(lines[at + 5])).toBe(20);
    expect(lines[at + 6].trim().split(/\s+/)[11]).toBe('128');
    expect(lines.filter((l) => l.startsWith('@:'))).toHaveLength(128);
  });
  it('packs voice numbers >= 128 into free slots', async () => {
    const { assignOpmSlots } = await import('../src/index.js');
    expect([...assignOpmSlots([200, 3, 150])]).toEqual([[3, 0], [150, 1], [200, 2]]);
  });
  it('uses bank slots as program numbers in vopm mode', () => {
    const r = convert(mdx([0xfd, 0x00, 0xa0, 47, 0xf1, 0]), null, { fmMode: 'vopm' });
    expect(r.opmSlots).toEqual({ 0: 0 });
    // program change 0xC0 0x00 present
    const s = Array.from(r.midi).join(',');
    expect(s.includes('192,0')).toBe(true);
  });
});
