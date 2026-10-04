import sys,bisect
# regcmp.py mx.log ours.log ch secs
mxl,ol,ch,secs=sys.argv[1],sys.argv[2],int(sys.argv[3]),float(sys.argv[4])
code2idx={c:i for i,c in enumerate([0,1,2,4,5,6,8,9,10,12,13,14])}
B=None; tick_t={}; t=0.0; last=None
kc=kf=None; mxp=[]; mxtl=[[],[],[],[]]
rows=[tuple(map(int,l.split())) for l in open(mxl)]
# tempo map: time of each tick
cur_t=0.0; prev_tick=None; tempoB=200
times={}
for k,r,v in rows:
    if prev_tick is None: prev_tick=k; times[k]=0.0
    while prev_tick<k:
        cur_t+=256*(256-tempoB)*1e-6; prev_tick+=1; times[prev_tick]=cur_t
    if r==0x12: tempoB=v
    if r==0x28+ch: kc=v
    if r==0x30+ch: kf=v>>2
    if r in (0x28+ch,0x30+ch) and kc is not None and kf is not None:
        oct_,c=kc>>4,kc&15
        if c in code2idx: mxp.append((times[k],(oct_*12+code2idx[c])*64+kf))
    for rs in range(4):
        if r==0x60+rs*8+ch: mxtl[rs].append((times[k],v))
op=[];otl=[[],[],[],[]]
for l in open(ol):
    a,kind,v=l.split(); a=float(a); v=int(v)
    if kind=='p': op.append((a,v))
    if kind[0]=='t' and len(kind)==2: otl[int(kind[1])].append((a,v))
def sample(seq,tt):
    i=bisect.bisect_right([x[0] for x in seq],tt)-1
    return seq[i][1] if i>=0 else None
# sample once per MDX clock, in the middle of the clock: values that change every clock (fast LFOs)
# compare exactly instead of failing on sub-clock timing jitter
ticks=sorted(times)
mids=[(times[ticks[i]]+times[ticks[i+1]])/2 for i in range(len(ticks)-1) if times[ticks[i]]>=0.05 and times[ticks[i]]<secs]
def score(seq_a,seq_b,off):
    ta=[x[0] for x in seq_a]; tb=[x[0] for x in seq_b]
    bad=0;n=0;first=[]
    for tt in mids:
        ia=bisect.bisect_right(ta,tt)-1; ib=bisect.bisect_right(tb,tt+off)-1
        if ia>=0 and ib>=0 and seq_a[ia][1]!=0:  # 0 = MXDRV's initial KC/KF before the first note
            n+=1
            if seq_a[ia][1]!=seq_b[ib][1]:
                bad+=1
                if len(first)<8: first.append((round(tt,3),seq_a[ia][1],seq_b[ib][1]))
    return bad,n,first
best=min(((score(mxp,op,o)[0]+(score(mxtl[3],otl[3],o)[0] if otl[3] else 0),o) for o in [x*0.0005 for x in range(-240,241)]))
off=best[1]
b,n,f=score(mxp,op,off)
print('pitch: offset %.4fs mismatch %d/%d (%.2f%%) first:'%(off,b,n,100*b/max(n,1)),f)
for rs,name in enumerate(('M1','M2','C1','C2')):
    if otl[rs] and mxtl[rs]:
        b,n,f=score(mxtl[rs],otl[rs],off); print('TL(%s): mismatch %d/%d (%.2f%%) first:'%(name,b,n,100*b/max(n,1)),f)
