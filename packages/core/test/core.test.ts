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

describe('volume baking (vopm)', () => {
  it('adds MXDRV volume attenuation to carrier TLs and switches programs per volume', () => {
    // voice 0 is CON=2 (carrier C2 only). v15 (att 2) then v0 (att 0x2a)
    const r = convert(mdx([0xfd, 0x00, 0xfb, 15, 0xa0, 47, 0xfb, 0, 0xa0, 47, 0xf1, 0]), null, { fmMode: 'vopm' });
    expect(r.opmBanks).toHaveLength(1);
    const L = r.opmBanks[0].text.split('\r\n');
    const tlOf = (slot: number, op: string) => +L[L.findIndex((l) => l.startsWith(`@:${slot} `)) + ({ M1: 3, C1: 4, M2: 5, C2: 6 } as Record<string, number>)[op]].trim().split(/\s+/)[6];
    expect(tlOf(0, 'C2')).toBe(2);
    expect(tlOf(1, 'C2')).toBe(0x2a);
    expect(tlOf(1, 'M1')).toBe(0); // modulators untouched
    const progs = Array.from(r.midi).map((b, i, a) => (b === 0xc0 ? a[i + 1] : -1)).filter((x) => x >= 0);
    expect(progs).toEqual([0, 0, 1]); // initial program is also sent at tick 0 (lead-in)
  });
});

describe('VOPM MUL=0 fix', () => {
  it('doubles MULs and transposes notes down an octave for voices with MUL=0', () => {
    const r = convert(mdx([0xfd, 0x00, 0xa0, 47, 0xf1, 0]), null, { fmMode: 'vopm' });
    const L = r.opmBanks[0].text.split('\r\n');
    const i = L.findIndex((l) => l.startsWith('@:0 '));
    expect(+L[i + 3].trim().split(/\s+/)[8]).toBe(1); // M1 MUL 0 -> 1
    const notes = Array.from(r.midi).map((b, k, a) => (b === 0x90 && a[k + 2] === 127 ? a[k + 1] : -1)).filter((x) => x >= 0);
    expect(notes[0]).toBe(0x20 + 15 - 12);
    const off = convert(mdx([0xfd, 0x00, 0xa0, 47, 0xf1, 0]), null, { fmMode: 'vopm', vopmMul0Fix: false });
    const n2 = Array.from(off.midi).map((b, k, a) => (b === 0x90 && a[k + 2] === 127 ? a[k + 1] : -1)).filter((x) => x >= 0);
    expect(n2[0]).toBe(0x20 + 15);
  });
});

describe('OPM68 pitch control notes', () => {
  const ctls = (m: Uint8Array) => { const a = Array.from(m); return a.map((b, k) => (b === 0x90 && a[k + 1] < 12 ? [a[k + 1], a[k + 2] - 1] : null)).filter((x): x is number[] => !!x); };
  const v14 = (c: number[][], k: number) => c.find((x) => x[0] === k)![1] * 127 + c.find((x) => x[0] === k + 1)![1];
  const tick = 12288 * 56 / 48 / 1e6; // tempo 200
  it('sends portamento as control notes 0/1 instead of pitch bend', () => {
    const src = mdx([0xfd, 0x00, 0xf2, 0x04, 0x00, 0xa0, 47, 0xf1, 0]);
    const c = ctls(convert(src, null, { fmMode: 'opm68' }).midi);
    expect((v14(c, 0) - 8064) / 32).toBeCloseTo(1 / 16 / tick, 1);
    const bends = (m: Uint8Array) => Array.from(m).filter((b) => b === 0xe0).length;
    expect(bends(convert(src, null, { fmMode: 'opm68', opm68PortaNotes: false }).midi)).toBeGreaterThan(bends(convert(src, null, { fmMode: 'opm68' }).midi) + 5);
  });
  it('sends detune and pitch LFO parameters', () => {
    // F3 detune +32 (half a semitone), EC triangle period 8 amp 0x200, E9 delay 4
    const src = mdx([0xfd, 0x00, 0xf3, 0x00, 0x20, 0xec, 0x02, 0x00, 0x08, 0x02, 0x00, 0xe9, 4, 0xa0, 47, 0xf1, 0]);
    const c = ctls(convert(src, null, { fmMode: 'opm68' }).midi);
    expect((v14(c, 2) - 8064) / 64).toBe(0.5);
    expect(c.find((x) => x[0] === 4)![1]).toBe(3);
    expect(v14(c, 5) / 2000).toBeCloseTo(8 * tick, 3);
    expect((v14(c, 7) - 8064) / 256).toBeCloseTo((0x200 / 16384) * 4, 2);
    expect(v14(c, 9) / 2000).toBeCloseTo(4 * tick, 3);
  });
});
