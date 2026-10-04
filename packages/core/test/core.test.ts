import { describe, it, expect } from 'vitest';
import { parseMdx, sequence, convert, parsePdx, decodeAdpcm, writeSf2 } from '../src/index.js';
import { packControl, decodePacket, type CtlItem } from '../src/opm68ctl.js';
import { newPitchLfo, newAmpLfo, setPitchLfo, setAmpLfo, stepPitchLfo, stepAmpLfo, amLfoAtt, MxRandom } from '../src/sequencer.js';

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

describe('OPM68 control notes', () => {
  /** Control packets (tick -> decoded items) from an opm68 MIDI. */
  const packets = (m: Uint8Array) => {
    const a = Array.from(m); const byPos = new Map<number, number[]>();
    // scan note-ons on keys < 15 in order; packets are contiguous runs starting with key 0
    let cur: number[] | null = null; const out: CtlItem[][] = [];
    for (let k = 0; k + 2 < a.length; k++) {
      if ((a[k] & 0xf0) === 0x90 && a[k + 1] < 15 && a[k + 2] > 0) {
        const key = a[k + 1], v = a[k + 2] - 1;
        if (key === 0) { cur = [v]; byPos.set(out.length, cur); out.push([]); }
        else if (cur) cur[key] = v;
      }
    }
    return [...byPos.values()].map((b) => decodePacket(b));
  };
  it('sends the raw portamento value instead of pitch bend', () => {
    const src = mdx([0xfd, 0x00, 0xf2, 0xb0, 0x00, 0xa0, 47, 0xf1, 0]);
    const items = packets(convert(src, null, { fmMode: 'opm68' }).midi).flat();
    expect(items).toContainEqual({ k: 'porta', v: -0x5000 });
    const bends = (m: Uint8Array) => Array.from(m).filter((b) => b === 0xe0).length;
    expect(bends(convert(src, null, { fmMode: 'opm68', opm68PortaNotes: false }).midi)).toBeGreaterThan(bends(convert(src, null, { fmMode: 'opm68' }).midi) + 5);
  });
  it('sends detune, both LFOs, delay, clock and volume', () => {
    // FF 200, F3 +32, EC tri per 8 amp 0x200, EB saw per 4 amp 0x100, E9 4, FB v12
    const src = mdx([0xff, 200, 0xfd, 0x00, 0xf3, 0x00, 0x20, 0xec, 0x02, 0x00, 0x08, 0x02, 0x00, 0xeb, 0x00, 0x00, 0x04, 0x01, 0x00, 0xe9, 4, 0xfb, 12, 0xa0, 47, 0xf1, 0]);
    const items = packets(convert(src, null, { fmMode: 'opm68' }).midi).flat();
    expect(items).toContainEqual({ k: 'detune', v: 32 });
    expect(items).toContainEqual({ k: 'plfo', mode: 4, per: 8, amp: 0x200 });
    expect(items).toContainEqual({ k: 'alfo', mode: 2, per: 4, amp: 0x100 });
    expect(items).toContainEqual({ k: 'delay', v: 4 });
    expect(items).toContainEqual({ k: 'clock', v: 56 });
    expect(items.filter((x) => x.k === 'vol')).toEqual([{ k: 'vol', v: 0x0a }]); // v8 then v12 in the same clock: the last wins
  });
  it('keeps low notes as they are (control keys stay below MIDI 15)', () => {
    const r = convert(mdx([0xfd, 0x00, 0x80, 47, 0xf1, 0]), null, { fmMode: 'opm68' });
    const a = Array.from(r.midi);
    expect(a.some((b, k) => b === 0x90 && a[k + 1] === 15 && a[k + 2] === 1)).toBe(true);
  });
  it('splits packets that do not fit into the next clock', () => {
    const m = new Map<number, CtlItem[]>([[0, [
      { k: 'plfo', mode: 2, per: 30000, amp: -30000 }, { k: 'alfo', mode: 3, per: 30000, amp: 30000 },
      { k: 'detune', v: -5 }, { k: 'clock', v: 56 }, { k: 'vol', v: 21 }, { k: 'delay', v: 200 },
    ]]]);
    const p = packControl(m);
    expect([...p.keys()]).toEqual([0, 1]);
    for (const b of p.values()) expect(b.length).toBeLessThanOrEqual(15);
    expect([...p.values()].flatMap((b) => decodePacket(b)).map((x) => x.k).sort()).toEqual(['alfo', 'clock', 'delay', 'detune', 'plfo', 'vol']);
  });
});

describe('MXDRV LFO model', () => {
  it('pitch LFO triangle starts at +delta and turns after per/2 clocks', () => {
    const l = newPitchLfo(); const r = new MxRandom();
    setPitchLfo(l, 2, 4, 0x100); // delta = 1 KF per clock
    const kf: number[] = [];
    for (let i = 0; i < 8; i++) { stepPitchLfo(l, r); kf.push(l.val >> 16); }
    expect(kf).toEqual([2, 3, 2, 1, 0, -1, 0, 1]);
  });
  it('amplitude LFO sawtooth ramps the attenuation and restarts', () => {
    const l = newAmpLfo(); const r = new MxRandom();
    setAmpLfo(l, 0, 4, 0x400); // +4 TL per clock, restart every 4 clocks
    const att: number[] = [];
    for (let i = 0; i < 8; i++) { stepAmpLfo(l, r); att.push(amLfoAtt(l)); }
    expect(att).toEqual([4, 8, 12, 0, 4, 8, 12, 0]);
  });
  it('emits the amplitude LFO as expression (CC11) outside OPM68', () => {
    const r = convert(mdx([0xfd, 0x00, 0xeb, 0x00, 0x00, 0x04, 0x04, 0x00, 0xa0, 47, 0xf1, 0]), null, { fmMode: 'vopm' });
    const a = Array.from(r.midi);
    const cc11 = a.map((b, k) => (b === 0xb0 && a[k + 1] === 11 ? a[k + 2] : -1)).filter((x) => x >= 0);
    expect(new Set(cc11).size).toBeGreaterThan(3);
  });
});
