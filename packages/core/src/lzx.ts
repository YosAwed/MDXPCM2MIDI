// LZX-packed MDX (X68000 "LZX 0.32" / "LZX 0.42").
//
// The MDX body after the title / PDX name is a self-extracting 68000 program:
//   +0  bra.s start / bra.s ...      +4 "LZX 0.xx"      +$14 word: unpacked size
//   stub that moves the data up and jumps to the depacker at the end of the file.
// The stub's `lea (d8,pc,a6.l),a6` (4DFB E8xx) gives the start of the packed stream.
// The depacker is a plain LZ77 with a bit stream (flags MSB first, refilled 8 bits at a time):
//   1                      literal byte
//   0 0 b b  off8          copy (bb + 2) bytes from offset off8 - 256      (-256..-1)
//   0 1  hi lo             offset = (0xFFFF0000 | hi:lo) >> 3 (signed, -8192..-1)
//                          lo & 7 != 0: copy (lo & 7) + 2 bytes
//                          else next byte n: n != 0 copy n + 1 bytes, n == 0 end of stream
// (After the stream come relocation data for executables and the depacker itself; MDX does not use them.)

export function isLzx(d: Uint8Array, base: number): boolean {
  return d.length >= base + 12 && d[base + 4] === 0x4c && d[base + 5] === 0x5a && d[base + 6] === 0x58 && d[base + 7] === 0x20;
}

/** Unpacks the LZX body starting at `base` (the MDX data after the PDX name). */
export function unlzx(d: Uint8Array, base: number): Uint8Array {
  const z = d.subarray(base);
  let src = -1;
  for (let k = 8; k + 3 < Math.min(z.length, 0x100); k++) {
    if (z[k] === 0x4d && z[k + 1] === 0xfb && z[k + 2] === 0xe8) { src = k + 2 + z[k + 3]; break; }
  }
  if (src < 0) throw new Error('LZX: 展開ルーチンが見つかりません');
  const size = (z[0x14] << 8) | z[0x15];
  const out = new Uint8Array(size || 0x10000);
  let o = 0, p = src;
  const byte = () => { if (p >= z.length) throw new Error('LZX: データが途中で終わっています'); return z[p++]; };
  let flags = byte(), left = 8;
  const bit = () => { if (--left < 0) { flags = byte(); left = 7; } const b = (flags >> 7) & 1; flags = (flags << 1) & 0xff; return b; };
  let grow = out;
  const put = (v: number) => {
    if (o >= grow.length) { const n = new Uint8Array(grow.length * 2); n.set(grow); grow = n; }
    grow[o++] = v;
  };
  for (;;) {
    if (bit()) { put(byte()); continue; }
    let off: number, cnt: number;
    if (!bit()) {
      const n = (bit() << 1) | bit();
      off = byte() - 256; cnt = n + 2;
    } else {
      const hi = byte(), lo = byte();
      off = ((0xffff0000 | (hi << 8) | lo) >> 3) & 0xffff; // arithmetic shift of the 32-bit value
      off = (off ^ 0x8000) - 0x8000;
      if (lo & 7) cnt = (lo & 7) + 2;
      else { const n = byte(); if (n === 0) break; cnt = n + 1; }
    }
    const s = o + off;
    if (s < 0) throw new Error('LZX: 不正な参照');
    for (let i = 0; i < cnt; i++) put(grow[s + i]);
  }
  if (size && o !== size) throw new Error(`LZX: 展開サイズが一致しません (${o} / ${size})`);
  return grow.slice(0, o);
}
