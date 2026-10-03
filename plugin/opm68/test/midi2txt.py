import mido, sys
m = mido.MidiFile(sys.argv[1]); chans = set(int(x) for x in sys.argv[3].split(',')) if len(sys.argv) > 3 else set(range(8))
t = 0.0; out = open(sys.argv[2], 'w')
for msg in m:
    t += msg.time
    if msg.is_meta or not hasattr(msg, 'channel') or msg.channel not in chans: continue
    b = msg.bytes()
    if len(b) == 2: b.append(0)
    out.write(f"{int(t*48000)} {b[0]} {b[1]} {b[2]}\n")
