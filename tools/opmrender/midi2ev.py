import mido, sys
m = mido.MidiFile(sys.argv[1]); SR = 4000000/64
t = 0.0
out = open(sys.argv[2], 'w')
for msg in m:  # merged, time in seconds
    t += msg.time
    if msg.is_meta: continue
    if msg.channel > 7: continue
    s = int(t*SR)
    if msg.type == 'note_on' and msg.velocity > 0: out.write(f"{s} on {msg.channel} {msg.note} {msg.velocity}\n")
    elif msg.type in ('note_off','note_on'): out.write(f"{s} off {msg.channel} {msg.note} 0\n")
    elif msg.type == 'program_change': out.write(f"{s} prog {msg.channel} {msg.program} 0\n")
    elif msg.type == 'control_change': out.write(f"{s} cc {msg.channel} {msg.control} {msg.value}\n")
    elif msg.type == 'pitchwheel': out.write(f"{s} bend {msg.channel} {msg.pitch} 0\n")
out.write(f"{int((t+1.5)*SR)} end 0 0 0\n")
