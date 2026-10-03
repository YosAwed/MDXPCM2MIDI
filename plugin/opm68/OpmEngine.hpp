// YM2151 (ymfm) driven by MIDI, with MXDRV-compatible pitch and volume.
#pragma once
#include "OpmBank.hpp"
#include "ymfm/ymfm_opm.h"
#include <cmath>
#include <algorithm>

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
        fLfoVoice = -1;
    }

    // ---- MIDI ----
    int program() const { return fProgram; }
    void programChange(int p) { if (!fVelProg) fProgram = p & 127; }
    int lastProgram() const { return fLastProg; }

    void noteOn(int note, int vel)
    {
        if (vel == 0) { noteOff(note); return; }
        int prog = fVelProg ? std::clamp(vel - 1, 0, 126) : fProgram;
        const OpmVoice& v = fBank.voice[prog];
        if (!v.valid) return;
        fLastProg = prog;
        int c = allocate(note);
        ChState& ch = fCh[c];
        write(0x08, c);                 // key off now, key on after one chip sample
        ch.note = note; ch.held = true; ch.age = ++fAge;
        loadVoice(c, prog);
        setPitch(c);
        ch.pendingKeyOn = true;
    }

    void noteOff(int note)
    {
        for (int c = 0; c < 8; c++) {
            if (fCh[c].held && fCh[c].note == note) {
                fCh[c].held = false;
                if (fCh[c].pendingKeyOn) fCh[c].pendingKeyOn = false;
                write(0x08, c);
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
        for (int c = 0; c < 8; c++) {
            if (fCh[c].pendingKeyOn) {
                fCh[c].pendingKeyOn = false;
                const OpmVoice& v = fBank.voice[fCh[c].loaded >= 0 ? fCh[c].loaded : 0];
                write(0x08, ((v.slot >> 3) & 0x0f) << 3 | c);
            }
        }
    }

private:
    struct ChState { int note = -1; bool held = false; bool pendingKeyOn = false; unsigned age = 0; int loaded = -2; int levelKey = -1; };

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
        double semis = (fCh[c].note - (f4MHz ? 15 : 13)) + (fBend / 8192.0) * fBendRange;
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
};
