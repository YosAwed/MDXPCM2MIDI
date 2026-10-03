// Tiny VOPM stand-in: plays MIDI ch1-8 on a YM2151 (ymfm) using a .OPM bank.
#include "ymfm_opm.h"
#include <cstdio>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <algorithm>
struct Op { int ar,d1r,d2r,rr,d1l,tl,ks,mul,dt1,dt2,ame; };
struct Voice { int lfrq=0,amd=0,pmd=0,wf=0,nfrq=0, pan=64,fl=0,con=0,ams=0,pms=0,slot=120,ne=0; Op op[4]{}; bool ok=false; };
struct Chip : ymfm::ymfm_interface {};
int main(int argc, char** argv) {
  if (argc < 4) { fprintf(stderr, "opmrender bank.opm events.txt out.raw\n"); return 1; }
  std::vector<Voice> bank(128);
  { std::ifstream f(argv[1]); std::string line; int cur=-1;
    while (std::getline(f, line)) {
      if (line.rfind("//",0)==0) continue;
      std::istringstream ss(line); std::string tag; ss >> tag;
      if (tag.rfind("@:",0)==0) { cur = atoi(tag.c_str()+2); if(cur>=0&&cur<128) bank[cur].ok=true; else cur=-1; }
      else if (cur<0) continue;
      else if (tag=="LFO:") ss>>bank[cur].lfrq>>bank[cur].amd>>bank[cur].pmd>>bank[cur].wf>>bank[cur].nfrq;
      else if (tag=="CH:") ss>>bank[cur].pan>>bank[cur].fl>>bank[cur].con>>bank[cur].ams>>bank[cur].pms>>bank[cur].slot>>bank[cur].ne;
      else { int k = tag=="M1:"?0: tag=="C1:"?1: tag=="M2:"?2: tag=="C2:"?3:-1; if(k<0) continue;
        Op&o=bank[cur].op[k]; ss>>o.ar>>o.d1r>>o.d2r>>o.rr>>o.d1l>>o.tl>>o.ks>>o.mul>>o.dt1>>o.dt2>>o.ame; }
    } }
  Chip intf; ymfm::ym2151 chip(intf); chip.reset();
  auto w = [&](int r, int v){ chip.write_address(r); chip.write_data(v & 255); };
  const double CLK = 4000000.0;
  // operator register offsets in register order M1,M2,C1,C2 ; file index order M1,C1,M2,C2
  const int regOfs[4] = {0, 16, 8, 24}; // file op k -> register slot offset
  struct Ch { int prog=0, vol=127, expr=127, pan=64, note=-1, bend=8192, rng=2, rpnL=127, rpnM=127; } ch[8];
  auto applyVoice = [&](int c) {
    Voice&v = bank[ch[c].prog]; if(!v.ok) return;
    int rl = ch[c].expr==0 ? 0 : (ch[c].pan<43?1: ch[c].pan>85?2:3);
    w(0x20+c, (rl<<6) | (v.fl<<3) | v.con);
    w(0x38+c, (v.pms<<4) | v.ams);
    w(0x18, v.lfrq); w(0x19, v.amd&127); w(0x19, 0x80|(v.pmd&127)); w(0x1b, v.wf&3);
    static const int carriers[8] = {8,8,8,8,10,14,14,15}; // bitmask over register order M1(1),M2(2),C1(4),C2(8)
    double gain = (ch[c].vol/127.0)*(ch[c].expr/127.0);
    int att = gain<=0 ? 127 : (int)std::lround(-40*std::log10(gain)/0.75);
    for (int k=0;k<4;k++){ Op&o=v.op[k]; int r=regOfs[k]+c; int regIdx = regOfs[k]/8; // 0 M1,1 M2,2 C1,3 C2
      int tl = o.tl + ((carriers[v.con]>>regIdx)&1 ? att : 0); if(tl>127) tl=127;
      w(0x40+r, (o.dt1<<4)|o.mul); w(0x60+r, tl); w(0x80+r,(o.ks<<6)|o.ar);
      w(0xa0+r,(o.ame?0x80:0)|o.d1r); w(0xc0+r,(o.dt2<<6)|o.d2r); w(0xe0+r,(o.d1l<<4)|o.rr); }
  };
  auto setPitch = [&](int c) {
    if (ch[c].note<0) return;
    double semis = ch[c].note + (ch[c].bend-8192)/8192.0*ch[c].rng;
    double f = 440.0*std::pow(2.0,(semis-69)/12.0);
    double s = 56 + 12*std::log2(f/440.0/(CLK/3579545.0)); // OPM semitone index (A4 = 56 at 3.58MHz)
    if (s<0) s=0; if (s>8*12-1) s=8*12-1;
    int si=(int)std::floor(s); int kf=(int)std::lround((s-si)*64); if(kf>63){kf=0;si++;}
    static const int code[12]={0,1,2,4,5,6,8,9,10,12,13,14};
    w(0x28+c, ((si/12)<<4)|code[si%12]); w(0x30+c, kf<<2);
  };
  for (int c=0;c<8;c++) w(0x08,c);
  std::ifstream ev(argv[2]); FILE* out=fopen(argv[3],"wb");
  long pos=0; ymfm::ym2151::output_data od;
  long s; std::string type; int c,a,b;
  while (ev >> s >> type >> c >> a >> b) {
    for (; pos<s; pos++) { chip.generate(&od); int16_t lr[2]={(int16_t)std::clamp(od.data[0],-32768,32767),(int16_t)std::clamp(od.data[1],-32768,32767)}; fwrite(lr,2,2,out); }
    if (type=="end") break;
    if (type=="prog") { ch[c].prog=a; applyVoice(c); }
    else if (type=="on") { if(ch[c].note>=0) w(0x08,c); ch[c].note=a; applyVoice(c); setPitch(c); w(0x08,(bank[ch[c].prog].slot&0x78)|c); }
    else if (type=="off") { if(ch[c].note==a){ w(0x08,c); } }
    else if (type=="bend") { ch[c].bend=a+8192; setPitch(c); }
    else if (type=="cc") {
      if(a==7) ch[c].vol=b; else if(a==11) ch[c].expr=b; else if(a==10) ch[c].pan=b;
      else if(a==101) ch[c].rpnM=b; else if(a==100) ch[c].rpnL=b; else if(a==6 && ch[c].rpnM==0&&ch[c].rpnL==0) ch[c].rng=b;
      if(a==7||a==11||a==10) applyVoice(c);
    }
  }
  fclose(out); return 0;
}
