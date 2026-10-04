// OPM68 control-note packets.
//
// In OPM68 mode the converter sends MXDRV's per-channel driver state (portamento, detune, software
// LFOs, volume, clock length) to the OPM68 plugin as short silent notes on keys 0-14. MDX's lowest
// note is MIDI 15 (o0 d+), so these keys never collide with music. All control data for one channel
// at one MDX clock forms a packet: byte i is carried by key i (value = velocity - 1, 7 bits).
//
//   byte 0      header: bits 0-3 = packet length - 1 (1..15 bytes)
//   byte 1..    items: tag byte (bits 4-6 type, bits 0-3 param) + varints
//
//   type 0 PORTA   param bit0: stop without resetting the offset; varint s = F2 value (1/256 KF per clock)
//   type 1 DETUNE  varint s = F3 value (1/64 semitone), applied from the note command
//   type 2 PLFO    param = mode (0 off, 1 on/restart, 2-5 set wave 0-3, +8 amplitude x256);
//                  set modes are followed by varint u period and varint s amplitude
//   type 3 ALFO    same as PLFO, for the amplitude LFO (EB)
//   type 4 DELAY   varint u = E9 LFO delay
//   type 5 CLOCK   varint u = 256 - TimerB (the MDX clock is that many 256 us units)
//   type 6 VOLUME  varint u = MXDRV attenuation (voices are not volume-baked in this mode)
//
// varint: base-63 digits (0..62), least significant first, bit 6 (+64) = more bytes follow, so every
// byte stays <= 126 (velocity <= 127); signed values are zigzag-encoded.
// Items that do not fit in one packet move to the next clock.

export type CtlItem =
  | { k: 'porta'; v: number; keep?: boolean }
  | { k: 'detune'; v: number }
  | { k: 'plfo' | 'alfo'; mode: number; per: number; amp: number }
  | { k: 'delay'; v: number }
  | { k: 'clock'; v: number }
  | { k: 'vol'; v: number };

export const CTL_KEYS = 15;
const PRIORITY: Record<CtlItem['k'], number> = { porta: 0, detune: 1, vol: 2, clock: 3, plfo: 4, alfo: 5, delay: 6 };

const varint = (u: number): number[] => {
  const out: number[] = [];
  u = Math.max(0, Math.floor(u));
  do { const g = u % 63; u = Math.floor(u / 63); out.push(u ? g + 64 : g); } while (u);
  return out;
};
const zigzag = (s: number) => (s >= 0 ? s * 2 : -s * 2 - 1);

/** EC/EB mode byte -> packet mode (0 off, 1 on, 2-5 wave, +8 x256). */
export const lfoMode = (m: number) => (m & 0x80 ? m & 1 : 2 + (m & 3) + (m >= 4 ? 8 : 0));

export function encodeItem(it: CtlItem): number[] {
  switch (it.k) {
    case 'porta': return [0x00 | (it.keep ? 1 : 0), ...varint(zigzag(it.keep ? 0 : it.v))];
    case 'detune': return [0x10, ...varint(zigzag(it.v))];
    case 'plfo': case 'alfo': {
      const tag = (it.k === 'plfo' ? 0x20 : 0x30) | it.mode;
      return it.mode >= 2 ? [tag, ...varint(it.per & 0xffff), ...varint(zigzag(it.amp))] : [tag];
    }
    case 'delay': return [0x40, ...varint(it.v)];
    case 'clock': return [0x50, ...varint(it.v)];
    case 'vol': return [0x60, ...varint(it.v)];
  }
}

/** Packs the items of one channel (tick -> items) into packets (tick -> bytes, header included). */
export function packControl(items: Map<number, CtlItem[]>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const ticks = [...items.keys()].sort((a, b) => a - b);
  let carry: CtlItem[] = [];
  let i = 0;
  let t = ticks.length ? ticks[0] : 0;
  while (i < ticks.length || carry.length) {
    if (!carry.length) t = ticks[i];
    const own = ticks[i] === t ? items.get(ticks[i++])! : [];
    const queue = [...carry, ...[...own].sort((a, b) => PRIORITY[a.k] - PRIORITY[b.k])];
    const bytes: number[] = [];
    carry = [];
    for (const it of queue) {
      const b = encodeItem(it);
      if (!carry.length && bytes.length + b.length <= CTL_KEYS - 1) bytes.push(...b);
      else carry.push(it);
    }
    if (bytes.length) out.set(t, [bytes.length, ...bytes]); // header: length - 1 (= payload length)
    t++;
  }
  return out;
}

/** Decoder (used by tests; the plugin has its own C++ version). */
export function decodePacket(bytes: number[]): CtlItem[] {
  const n = (bytes[0] & 15) + 1;
  let p = 1;
  const rd = () => { let v = 0, mul = 1, b: number; do { b = bytes[p++]; v += (b & 63) * mul; mul *= 63; } while (b & 64); return v; };
  const s = (u: number) => (u & 1 ? -(u + 1) / 2 : u / 2);
  const items: CtlItem[] = [];
  while (p < n) {
    const tag = bytes[p++], type = tag >> 4, param = tag & 15;
    if (type === 0) { const v = s(rd()); items.push(param & 1 ? { k: 'porta', v: 0, keep: true } : { k: 'porta', v }); }
    else if (type === 1) items.push({ k: 'detune', v: s(rd()) });
    else if (type === 2 || type === 3) {
      const k = type === 2 ? 'plfo' : 'alfo';
      if (param >= 2) { const per = rd(), amp = s(rd()); items.push({ k, mode: param, per, amp }); }
      else items.push({ k, mode: param, per: 0, amp: 0 });
    } else if (type === 4) items.push({ k: 'delay', v: rd() });
    else if (type === 5) items.push({ k: 'clock', v: rd() });
    else if (type === 6) items.push({ k: 'vol', v: rd() });
    else break;
  }
  return items;
}
