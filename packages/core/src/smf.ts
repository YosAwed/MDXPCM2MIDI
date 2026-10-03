// Minimal Standard MIDI File (format 1) writer.

export interface MidiEvent { tick: number; order: number; bytes: number[] }

export class Track {
  events: MidiEvent[] = [];
  private seq = 0;
  /** Add one event; several channel messages may be concatenated and are split here. */
  add(tick: number, bytes: number[], order = 5) {
    if (bytes[0] >= 0xf0) { this.events.push({ tick, order: order * 1e7 + this.seq++, bytes }); return; }
    for (let i = 0; i < bytes.length;) {
      const hi = bytes[i] & 0xf0;
      const n = hi === 0xc0 || hi === 0xd0 ? 2 : 3;
      this.events.push({ tick, order: order * 1e7 + this.seq++, bytes: bytes.slice(i, i + n) });
      i += n;
    }
  }
  meta(tick: number, type: number, data: number[], order = 0) {
    this.add(tick, [0xff, type, ...vlq(data.length), ...data], order);
  }
  text(tick: number, type: number, s: string) {
    this.meta(tick, type, Array.from(new TextEncoder().encode(s)));
  }
}

export function vlq(n: number): number[] {
  const out = [n & 0x7f];
  n >>>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>>= 7; }
  return out;
}

export function writeSmf(tracks: Track[], division: number): Uint8Array {
  const chunks: number[] = [];
  const push32 = (v: number) => chunks.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  chunks.push(0x4d, 0x54, 0x68, 0x64); push32(6);
  chunks.push(0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (division >> 8) & 255, division & 255);
  for (const tr of tracks) {
    const ev = [...tr.events].sort((a, b) => a.tick - b.tick || a.order - b.order);
    const body: number[] = [];
    let last = 0;
    for (const e of ev) {
      body.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(0x4d, 0x54, 0x72, 0x6b); push32(body.length);
    for (const b of body) chunks.push(b);
  }
  return Uint8Array.from(chunks);
}
