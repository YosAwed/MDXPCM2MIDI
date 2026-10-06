// Minimal SoundFont 2.01 writer for one-shot sample kits.

export interface Sf2Sample { name: string; pcm: Int16Array; rate: number; key: number }

class Buf {
  a: number[] = [];
  u8(v: number) { this.a.push(v & 255); }
  u16(v: number) { this.a.push(v & 255, (v >> 8) & 255); }
  s16(v: number) { this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v: number) { this.a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }
  str(s: string, len: number) { for (let i = 0; i < len; i++) this.u8(i < s.length ? s.charCodeAt(i) & 0x7f : 0); }
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.length & 1;
  const out = new Uint8Array(8 + body.length + pad);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}
function list(type: string, parts: Uint8Array[]): Uint8Array {
  const len = 4 + parts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(len);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  let o = 4;
  for (const p of parts) { body.set(p, o); o += p.length; }
  return body;
}
const zstr = (s: string) => {
  const b = Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
  b.push(0); if (b.length & 1) b.push(0);
  return Uint8Array.from(b);
};
const fromBuf = (b: Buf) => Uint8Array.from(b.a);

export interface Sf2Options {
  name?: string;
  /** presets to create, all pointing at the same kit instrument */
  presets?: { name: string; bank: number; program: number }[];
  releaseSeconds?: number;
  /** SF2 exclusiveClass (generator 57) for every zone: a new note stops the sounding one. 0 = none */
  exclusiveClass?: number;
}

export function writeSf2(samples: Sf2Sample[], opts: Sf2Options = {}): Uint8Array {
  const name = opts.name ?? 'PDX';
  const presets = opts.presets ?? [{ name: `${name} Kit`, bank: 128, program: 0 }];
  const release = Math.round(1200 * Math.log2(opts.releaseSeconds ?? 4));

  // sample data
  const total = samples.reduce((s, x) => s + x.pcm.length + 46, 0);
  const smpl = new Uint8Array(total * 2);
  const sdv = new DataView(smpl.buffer);
  const starts: number[] = [];
  let pos = 0;
  for (const s of samples) {
    starts.push(pos);
    for (let i = 0; i < s.pcm.length; i++) sdv.setInt16((pos + i) * 2, s.pcm[i], true);
    pos += s.pcm.length + 46;
  }

  const phdr = new Buf(), pbag = new Buf(), pgen = new Buf();
  presets.forEach((p, i) => {
    phdr.str(p.name, 20); phdr.u16(p.program); phdr.u16(p.bank); phdr.u16(i); phdr.u32(0); phdr.u32(0); phdr.u32(0);
    pbag.u16(i); pbag.u16(0);
    pgen.u16(41); pgen.u16(0); // instrument 0
  });
  phdr.str('EOP', 20); phdr.u16(0); phdr.u16(0); phdr.u16(presets.length); phdr.u32(0); phdr.u32(0); phdr.u32(0);
  pbag.u16(presets.length); pbag.u16(0);
  pgen.u32(0);
  const pmod = new Buf(); for (let i = 0; i < 10; i++) pmod.u8(0);

  const inst = new Buf(), ibag = new Buf(), igen = new Buf();
  inst.str(`${name} Kit`, 20); inst.u16(0);
  inst.str('EOI', 20); inst.u16(samples.length);
  let g = 0;
  samples.forEach((s, i) => {
    ibag.u16(g); ibag.u16(0);
    igen.u16(43); igen.u8(s.key); igen.u8(s.key); g++;      // keyRange
    igen.u16(38); igen.s16(release); g++;                   // releaseVolEnv
    igen.u16(54); igen.u16(0); g++;                         // sampleModes: no loop
    if (opts.exclusiveClass) { igen.u16(57); igen.u16(opts.exclusiveClass); g++; } // exclusiveClass
    igen.u16(58); igen.u16(s.key); g++;                     // overridingRootKey
    igen.u16(53); igen.u16(i); g++;                         // sampleID
  });
  ibag.u16(g); ibag.u16(0);
  igen.u32(0);
  const imod = new Buf(); for (let i = 0; i < 10; i++) imod.u8(0);

  const shdr = new Buf();
  samples.forEach((s, i) => {
    const st = starts[i], en = st + s.pcm.length;
    shdr.str(s.name, 20); shdr.u32(st); shdr.u32(en); shdr.u32(st); shdr.u32(en);
    shdr.u32(s.rate); shdr.u8(s.key); shdr.u8(0); shdr.u16(0); shdr.u16(1);
  });
  shdr.str('EOS', 20); for (let i = 0; i < 26; i++) shdr.u8(0);

  const info = list('INFO', [
    chunk('ifil', Uint8Array.from([2, 0, 1, 0])),
    chunk('isng', zstr('EMU8000')),
    chunk('INAM', zstr(name)),
    chunk('ISFT', zstr('MDXPCM2MIDI')),
  ]);
  const sdta = list('sdta', [chunk('smpl', smpl)]);
  const pdta = list('pdta', [
    chunk('phdr', fromBuf(phdr)), chunk('pbag', fromBuf(pbag)), chunk('pmod', fromBuf(pmod)), chunk('pgen', fromBuf(pgen)),
    chunk('inst', fromBuf(inst)), chunk('ibag', fromBuf(ibag)), chunk('imod', fromBuf(imod)), chunk('igen', fromBuf(igen)),
    chunk('shdr', fromBuf(shdr)),
  ]);
  const riffBody = list('sfbk', [chunk('LIST', info), chunk('LIST', sdta), chunk('LIST', pdta)]);
  return chunk('RIFF', riffBody);
}
