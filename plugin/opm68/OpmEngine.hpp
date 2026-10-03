// YM2151 (ymfm) driven by MIDI, with MXDRV-compatible pitch and volume.
#pragma once
#include "OpmBank.hpp"
#include "ymfm/ymfm_opm.h"
#include <cmath>
#include <algorithm>
#include <cstdint>

class OpmEngine {
public:
    struct Chip : ymfm::ymfm_interface {};

    OpmEngine() : fChip(fIntf) { reset(); }

    // ---- configuration ----
    void setBank(const OpmBank& b) { fBank = b; for (int c = 0; c < 8; c++) fCh[c].loaded = -2; }
    const OpmBank& bank() const { return fBank; }
    void setClock4MHz(bool v) { if (v != f4MHz) { f4MHz = v; } }
    bool clock4MHz() const { return f4MHz; }
    double chipRate() const { return (f4MHz ? 4000000.0 : 3579545.0) / 64.0; }
    void setMono(bool v) { fMono = v; }
    void setDefaultBend(int semis) { fDefaultBend = semis; }
    /** When on, note velocity 1..127 selects bank slot 0..126 for that note (survives DAW MIDI import,
     *  unlike program changes). Program changes are then ignored. */
    void setVelocityProgram(bool v) { fVelProg = v; }

    void reset()
    {
        fChip.reset();
        for (int c = 0; c < 8; c++) { fCh[c] = ChState(); write(0x08, c); }
        fProgram = 0; fVol = 127; fExpr = 127; fPan = 64; fBend = 0; fBendRange = fDefaultBend;
        fRpnMsb = fRpnLsb = 127; fAge = 0;
        fLfoVoice = -1; fLastOn = -1; fCtlAny = false; for (int& x : fCtl) x = -1;
        fDetune = 0; fLfoWave = 0; fLfoPeriod = fLfoDepth = fLfoDelay = 0;
    }

    // ---- MIDI ----
    int program() const { return fProgram; }
    void programChange(int p) { if (!fVelProg) fProgram = p & 127; }
    int lastProgram() const { return fLastProg; }

    void noteOn(int note, int vel)
    {
        if (vel == 0) { noteOff(note); return; }
        if (note < kCtlKeys) { controlNote(note, vel); return; }
        int prog = fVelProg ? std::clamp(vel - 1, 0, 126) : fProgram;
        const OpmVoice& v = fBank.voice[prog];
        if (!v.valid) return;
        fLastProg = prog;
        int c = allocate(note);
        ChState& ch = fCh[c];
        write(0x08, c);                 // key off now, key on after one chip sample
        ch.note = note; ch.held = true; ch.age = ++fAge;
        ch.portaRate = 0; ch.portaOff = 0; ch.onTime = fNow; fLastOn = c;
        loadVoice(c, prog);
        setPitch(c);
        ch.pendingKeyOn = true;
    }

    void noteOff(int note)
    {
        if (note < kCtlKeys) return;
        for (int c = 0; c < 8; c++) {
            if (fCh[c].held && fCh[c].note == note) {
                fCh[c].held = false;
                if (fCh[c].pendingKeyOn) fCh[c].pendingKeyOn = false;
                write(0x08, c);
                setPitch(c); // the pitch LFO stops at key-off (portamento stays where it is)
            }
        }
    }

    void allNotesOff() { for (int c = 0; c < 8; c++) { fCh[c].held = false; fCh[c].pendingKeyOn = false; write(0x08, c); } }

    void controlChange(int cc, int val)
    {
        switch (cc) {
        case 7: fVol = val; refreshLevels(); break;
        case 11: fExpr = val; refreshLevels(); break;
        case 10: fPan = val; refreshLevels(); break;
        case 101: fRpnMsb = val; break;
        case 100: fRpnLsb = val; break;
        case 6: if (fRpnMsb == 0 && fRpnLsb == 0) fBendRange = std::clamp(val, 0, 48); break;
        case 120: case 123: allNotesOff(); break;
        case 121: fVol = 127; fExpr = 127; fPan = 64; fBend = 0; refreshLevels(); break;
        }
    }

    void pitchBend(int value14) { fBend = value14 - 8192; for (int c = 0; c < 8; c++) if (fCh[c].note >= 0) setPitch(c); }

    // ---- audio ----
    // Produce one chip sample (stereo, float)
    void generate(float& l, float& r)
    {
        ymfm::ym2151::output_data out;
        fChip.generate(&out);
        l = out.data[0] / 32768.0f;
        r = out.data[1] / 32768.0f;
        ++fNow;
        resolveControl();
        // portamento: integrate while the key is held (MXDRV stops accumulating at key-off)
        const bool tick = (fNow & 31) == 0;
        const bool lfo = fLfoWave > 0 && fLfoWave <= 3;
        for (int c = 0; c < 8; c++) {
            ChState& ch = fCh[c];
            if (!ch.held) continue;
            if (ch.portaRate != 0) ch.portaOff += ch.portaRate / chipRate();
            if (tick && (ch.portaRate != 0 || lfo)) setPitch(c);
        }
        for (int c = 0; c < 8; c++) {
            if (fCh[c].pendingKeyOn) {
                fCh[c].pendingKeyOn = false;
                const OpmVoice& v = fBank.voice[fCh[c].loaded >= 0 ? fCh[c].loaded : 0];
                write(0x08, ((v.slot >> 3) & 0x0f) << 3 | c);
            }
        }
    }

private:
    struct ChState { int note = -1; bool held = false; bool pendingKeyOn = false; unsigned age = 0; int loaded = -2; int levelKey = -1;
                     double portaRate = 0, portaOff = 0; uint64_t onTime = 0; };

    // ---- pitch control notes ----
    // DAWs (FL Studio) deliver pitch-bend automation only at block rate and scale it by their own
    // pitch range, which distorts MXDRV's fast portamento and vibrato. The converter therefore sends
    // portamento, detune and the MXDRV pitch LFO as short silent "control notes" on keys 0-11, placed
    // at the same time as the MDX commands; notes reach the plugin sample-accurately.
    // velocity-1 = 7-bit value; pairs (key, key+1) = MSB/LSB of a 14-bit value v (0..16128).
    //   0,1  portamento rate (v-8064)/32 semitones/s for the note starting now (or the held note with 11)
    //   2,3  detune (v-8064)/64 semitones                       (sticky)
    //   4    pitch LFO: 0 off, 1 saw, 2 square, 3 triangle      (sticky)
    //   5,6  LFO period v/2 ms;  7,8 LFO depth (v-8064)/256 semitones;  9,10 LFO delay v/2 ms (sticky)
    //   11   tie: restart portamento / LFO of the held note
    static constexpr int kCtlKeys = 12;
    void controlNote(int key, int vel) { fCtl[key] = std::clamp(vel - 1, 0, 126); fCtlAt[key] = fNow; fCtlAny = true; }
    int ctl14(int k) { if (fCtl[k] < 0 || fCtl[k + 1] < 0) return -1; int v = fCtl[k] * 127 + fCtl[k + 1]; fCtl[k] = fCtl[k + 1] = -1; return v; }
    void resolveControl()
    {
        if (!fCtlAny) return;
        // half of a 14-bit pair: give the other half a moment, then drop it
        for (int k : { 0, 2, 5, 7, 9 })
            if ((fCtl[k] < 0) != (fCtl[k + 1] < 0)) {
                uint64_t at = fCtl[k] >= 0 ? fCtlAt[k] : fCtlAt[k + 1];
                if (fNow - at <= 256) return;
                fCtl[k] = fCtl[k + 1] = -1;
            }
        fCtlAny = false;
        int v;
        if ((v = ctl14(2)) >= 0) fDetune = (v - 8064) / 64.0;
        if (fCtl[4] >= 0) { fLfoWave = fCtl[4]; fCtl[4] = -1; }
        if ((v = ctl14(5)) >= 0) fLfoPeriod = v / 2000.0;
        if ((v = ctl14(7)) >= 0) fLfoDepth = (v - 8064) / 256.0;
        if ((v = ctl14(9)) >= 0) fLfoDelay = v / 2000.0;
        const bool retrig = fCtl[11] >= 0; fCtl[11] = -1;
        double rate = 0; bool hasRate = false;
        if ((v = ctl14(0)) >= 0) { rate = (v - 8064) / 32.0; hasRate = true; }
        int c = -1;
        if (fLastOn >= 0 && fCh[fLastOn].held && fNow - fCh[fLastOn].onTime <= 64) c = fLastOn;
        else if (retrig || hasRate) { unsigned best = 0; for (int i = 0; i < 8; i++) if (fCh[i].held && fCh[i].age >= best) { best = fCh[i].age; c = i; } }
        if (c >= 0 && (hasRate || retrig)) {
            ChState& ch = fCh[c];
            ch.portaRate = rate; ch.portaOff = 0;
            if (retrig) ch.onTime = fNow; // LFO restarts with the tie
        }
        for (int i = 0; i < 8; i++) if (fCh[i].note >= 0) setPitch(i);
    }
    double lfoOffset(const ChState& ch) const
    {
        if (fLfoWave <= 0 || fLfoWave > 3 || fLfoPeriod <= 0 || !ch.held) return 0;
        double t = (double)(fNow - ch.onTime) / chipRate() - fLfoDelay;
        if (t < 0) return 0;
        double x = t / fLfoPeriod;
        switch (fLfoWave) {
        case 1: return fLfoDepth * (2.0 * (x - std::floor(x)) - 1.0);                 // sawtooth
        case 2: return ((long long)std::floor(x) & 1) ? -fLfoDepth : fLfoDepth;          // square
        default: { double y = std::fmod(x, 2.0); return fLfoDepth * (2.0 * (y < 1 ? y : 2 - y) - 1.0); } // triangle
        }
    }

    void write(int reg, int data) { fChip.write_address(reg); fChip.write_data(data & 0xff); }

    int allocate(int note)
    {
        if (fMono) return 0;
        // same note retrigger -> same channel
        for (int c = 0; c < 8; c++) if (fCh[c].note == note) return c;
        int best = -1; unsigned bestAge = ~0u;
        for (int c = 0; c < 8; c++) if (!fCh[c].held && fCh[c].age < bestAge) { best = c; bestAge = fCh[c].age; }
        if (best >= 0) return best;
        for (int c = 0; c < 8; c++) if (fCh[c].age < bestAge) { best = c; bestAge = fCh[c].age; }
        return best < 0 ? 0 : best;
    }

    // MXDRV-style attenuation from a 0..127 controller (inverse of the converter's mapping)
    static int attFromCC(int v) { if (v <= 0) return 127; return std::clamp((int)std::lround(-40.0 * std::log10(v / 127.0) / 0.75), 0, 127); }

    int panBits() const { return fPan < 43 ? 1 : fPan > 85 ? 2 : 3; } // bit0 = L, bit1 = R

    void loadVoice(int c, int prog)
    {
        ChState& ch = fCh[c];
        const OpmVoice& v = fBank.voice[prog];
        if (ch.loaded != prog) {
            static const int fileToReg[4] = { 0, 2, 1, 3 }; // M1,C1,M2,C2 -> register slots M1,M2,C1,C2
            for (int k = 0; k < 4; k++) {
                const OpmOp& o = v.op[k];
                int r = fileToReg[k] * 8 + c;
                write(0x40 + r, ((o.dt1 & 7) << 4) | (o.mul & 15));
                write(0x80 + r, ((o.ks & 3) << 6) | (o.ar & 31));
                write(0xa0 + r, (o.ame ? 0x80 : 0) | (o.d1r & 31));
                write(0xc0 + r, ((o.dt2 & 3) << 6) | (o.d2r & 31));
                write(0xe0 + r, ((o.d1l & 15) << 4) | (o.rr & 15));
            }
            write(0x38 + c, ((v.pms & 7) << 4) | (v.ams & 3));
            if (v.lfrq || v.amd || v.pmd || v.wf) {
                write(0x18, v.lfrq); write(0x19, v.amd & 127); write(0x19, 0x80 | (v.pmd & 127)); write(0x1b, v.wf & 3);
            }
            if (c == 7) write(0x0f, v.ne ? (0x80 | (v.nfrq & 31)) : 0);
            ch.loaded = prog;
            ch.levelKey = -1;
        }
        applyLevel(c);
    }

    void applyLevel(int c)
    {
        ChState& ch = fCh[c];
        if (ch.loaded < 0) return;
        const OpmVoice& v = fBank.voice[ch.loaded];
        int att = std::min(127, attFromCC(fVol) + attFromCC(fExpr));
        int key = att * 8 + panBits();
        if (key == ch.levelKey) return;
        ch.levelKey = key;
        static const int carriers[8] = { 8, 8, 8, 8, 10, 14, 14, 15 }; // bits over register slots M1,M2,C1,C2
        static const int fileToReg[4] = { 0, 2, 1, 3 };
        for (int k = 0; k < 4; k++) {
            int rs = fileToReg[k];
            int tl = v.op[k].tl + (((carriers[v.con & 7] >> rs) & 1) ? att : 0);
            write(0x60 + rs * 8 + c, std::min(127, tl));
        }
        int rl = (att >= 127) ? 0 : panBits();
        write(0x20 + c, (rl << 6) | ((v.fl & 7) << 3) | (v.con & 7));
    }

    void refreshLevels() { for (int c = 0; c < 8; c++) applyLevel(c); }

    void setPitch(int c)
    {
        static const int code[12] = { 0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14 };
        // MXDRV note n = MIDI - 15 at 4 MHz (KF +5 like MXDRV); at 3.58 MHz the OPM is ~2 semitones lower.
        double semis = (fCh[c].note - (f4MHz ? 15 : 13)) + (fBend / 8192.0) * fBendRange + fCh[c].portaOff + fDetune + lfoOffset(fCh[c]);
        int p = (int)std::lround(semis * 64.0) + (f4MHz ? 5 : 0);
        p = std::clamp(p, 0, 8 * 12 * 64 - 1);
        int n = p >> 6, kf = p & 63;
        write(0x28 + c, ((n / 12) << 4) | code[n % 12]);
        write(0x30 + c, kf << 2);
    }

    Chip fIntf;
    ymfm::ym2151 fChip;
    OpmBank fBank;
    ChState fCh[8];
    bool f4MHz = true, fMono = false, fVelProg = true;
    int fLastProg = -1;
    int fProgram = 0, fVol = 127, fExpr = 127, fPan = 64, fBend = 0, fBendRange = 12, fDefaultBend = 12;
    int fRpnMsb = 127, fRpnLsb = 127, fLfoVoice = -1;
    unsigned fAge = 0;
    uint64_t fNow = 0;
    int fCtl[kCtlKeys] = { -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1 };
    uint64_t fCtlAt[kCtlKeys] = {};
    bool fCtlAny = false;
    int fLastOn = -1, fLfoWave = 0;
    double fDetune = 0, fLfoPeriod = 0, fLfoDepth = 0, fLfoDelay = 0;
};
