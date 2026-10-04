# Compare the FM notes / control notes / pan of an arrange-layout .flp (all playlist items expanded)
# with the one-pattern .flp of the same song.
import sys,struct,glob,os
def events(path):
    b=open(path,'rb').read(); hl=struct.unpack_from('<I',b,4)[0]; ppq=struct.unpack_from('<H',b,12)[0]; nch=struct.unpack_from('<H',b,10)[0]
    p=8+hl+8; out=[]
    while p<len(b):
        id=b[p];p+=1
        if id==0xac:n=3
        elif id<64:n=1
        elif id<128:n=2
        elif id<192:n=4
        else:
            n=0;sh=0
            while True:
                x=b[p];p+=1;n|=(x&127)<<sh;sh+=7
                if not x&128:break
        out.append((id,b[p:p+n]));p+=n
    return ppq,nch,out
def flat(path):
    ppq,nch,ev=events(path); pats={}; cur=None; pl=None; chans={}; lastch=None
    for id,d in ev:
        if id==65: cur=int.from_bytes(d,'little'); pats.setdefault(cur,{'n':[],'c':[]})
        elif id==224 and cur is not None: pats[cur]['n']+= [struct.unpack_from('<IHHIHH8B',d,o) for o in range(0,len(d),24)]
        elif id==223 and cur is not None: pats[cur]['c']+= [struct.unpack_from('<IBBBBI',d,o) for o in range(0,len(d),12)]
        elif id==233: pl=d
        elif id==64: lastch=int.from_bytes(d,'little'); chans[lastch]={}
        elif id==21 and lastch is not None: chans[lastch]['type']=d[0]
        elif id==203 and lastch is not None: chans[lastch]['name']=d.decode('utf-16le').rstrip('\0')
        elif id==196 and lastch is not None: chans[lastch]['path']=d.decode('utf-16le').rstrip('\0')
    sz=88 if len(pl)%88==0 else 60
    notes=[];ctrl=[]
    for o in range(0,len(pl),sz):
        pos,base,item,ln,tr=struct.unpack_from('<IHHIH',pl,o)
        P=pats[item-base]
        for n in P['n']: notes.append((pos+n[0],n[2],n[4],n[3],n[13],n[12]))  # pos ch key len vel pan
        for c in P['c']: ctrl.append((pos+c[0],c[3],c[5]))
    return ppq,nch,sorted(notes),sorted(ctrl),chans,len(pl)//sz,len(pats)
# usage: python3 scripts/flp_compare.py <dir>...  (each dir holds X.flp from --flp and X_arrange.flp from --flp-arrange)
ok=True
for d in sys.argv[1:]:
    a=glob.glob(d+'/*_arrange.flp')[0]; o=a.replace('_arrange','')
    p1,_,n1,c1,ch1,_,_=flat(o); p2,nch,n2,c2,ch2,items,npat=flat(a)
    fmch={k for k,v in ch2.items() if v.get('name','').startswith('FM')}
    f1=[(x[0],x[1],x[2],x[3],x[4]) for x in n1 if x[1] in fmch]; f2=[(x[0],x[1],x[2],x[3],x[4]) for x in n2 if x[1] in fmch]
    smp=[k for k,v in ch2.items() if v.get('type')==0]
    pcm=[x for x in n2 if x[1] in smp]
    same = f1==f2 and c1==c2 and p1==p2
    ok&=same
    print(os.path.basename(d), 'ppq',p1,p2,'FMnotes',len(f1),len(f2),'ctrl',len(c1),len(c2),'IDENTICAL' if same else 'DIFF', '| samplers',len(smp),'pcm notes',len(pcm),'chans',nch, 'items',items,'pats',npat)
    if not same:
        import itertools
        s1=set(f1);s2=set(f2); print('  only orig',sorted(s1-s2)[:5],' only arr',sorted(s2-s1)[:5])
print('ALL OK' if ok else 'MISMATCH')
