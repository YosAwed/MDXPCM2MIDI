// YM2151 (ymfm) driven by MIDI, with MXDRV-compatible pitch and volume.
#pragma once
#include "OpmBank.hpp"
#include "MxLfo.hpp"
#include "ymfm/ymfm_opm.h"
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <cstdio>

class OpmEngine {
public:
    /** Test hook: when set, pitch codes and carrier attenuations are logged as "sec kind value". */
    static FILE*& traceFile() { static FILE* f = nullptr; return f; }
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
        fLfoVoice = -1; fLastOn = -1; fCtlAny = false; fLegatoNext = false; fCurProg = -1; fLevelDirty = false; for (int& o : fOver) o = -1; for (int& x : fCtl) x = -1;
        fPorta = 0; fPortaAcc = 0; fDetuneKf = 0; fVolAtt = 0; fFadeAtt = 0; fPLfo = mx::PitchLfo(); fALfo = mx::AmpLfo(); fDelay = fDelayCnt = 0;
        fRnd = mx::Random(); fNextTick = 0; fLastOnTime = 0;
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
        catchUpTicks();                 // MXDRV runs this clock's LFO step before the note command
        fPorta = 0; fPortaAcc = 0;      // cleared by every note command; a portamento item sent with it sets it again
        resolveControl();               // a complete control packet sent with this note applies first
        if (fLegatoNext) {
            fLegatoNext = false;
            if (fLastOn >= 0 && fCh[fLastOn].held) {
                // tie into another pitch (&): retune the sounding note, no key-on, LFOs keep running
                ChState& ch = fCh[fLastOn];
                ch.note = note;
                anchorTicks();
                ch.offKf = fDetuneKf + fPLfo.kf();
                if (prog != ch.loaded) { loadVoice(fLastOn, prog); ch.levelKey = -1; }
                setPitch(fLastOn);
                return;
            }
        }
        if (prog != fCurProg) { clearOverrides(); fCurProg = prog; } // a different voice means an @ command in MXDRV
        // after a v or @, MXDRV rewrites the carrier TLs at the next key-on (over any y write since)
        if (fLevelDirty) { clearTlOverrides(); fLevelDirty = false; }
        int c = allocate(note);
        ChState& ch = fCh[c];
        write(0x08, c);                 // key off now, key on after one chip sample
        ch.note = note; ch.held = true; ch.age = ++fAge;
        fLastOn = c; fLastOnTime = fNow;
        lfoKeyOn();
        anchorTicks();
        ch.offKf = fDetuneKf + fPLfo.kf(); ch.amAtt = fALfo.att(); ch.volAtt = fVolAtt; ch.levelKey = -1;
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
            }
        }
    }

    void allNotesOff() { for (int c = 0; c < 8; c++) { fCh[c].held = false; fCh[c].pendingKeyOn = false; write(0x08, c); } }

    void controlChange(int cc, int val)
    {
        switch (cc) {
        case 7: fVol = val; refreshLevels(); break;
        case 11: fExpr = val; refreshLevels(); break;
        case 10: fPan = val; refreshPan(); break; // MXDRV's p writes only RL/FB/CON
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
        while ((double)fNow >= fNextTick) { mdxTick(); fNextTick += clockSamples(); }
        for (int c = 0; c < 8; c++) {
            if (fCh[c].pendingKeyOn) {
                fCh[c].pendingKeyOn = false;
                const OpmVoice& v = fBank.voice[fCh[c].loaded >= 0 ? fCh[c].loaded : 0];
                write(0x08, ((v.slot >> 3) & 0x0f) << 3 | c);
            }
        }
    }

private:
    struct ChState { int note = -1; bool held = false; bool pendingKeyOn = false; unsigned age = 0; int loaded = -2; int levelKey = -1; int tlProg = -1; int att = 0;
                     int offKf = 0, amAtt = 0, volAtt = 0; };

    // ---- MXDRV control notes ----
    // DAWs (FL Studio) deliver pitch-bend automation only at block rate and scale it by their own pitch
    // range, which distorts MXDRV's fast portamento and vibrato. In OPM68 mode the converter therefore
    // sends MXDRV's per-channel driver state (portamento, detune, EC/EB software LFOs, E9 delay, volume,
    // clock length) as short silent notes on keys 0-14 (below MDX's lowest note, MIDI 15), and this
    // engine runs MXDRV's per-clock state machines itself (MxLfo.hpp). Notes arrive sample-accurately.
    // Packet format: see packages/core/src/opm68ctl.ts (byte i on key i, value = velocity - 1).
    static constexpr int kCtlKeys = 15;
    void controlNote(int key, int vel) { fCtl[key] = std::clamp(vel - 1, 0, 126); fCtlAt[key] = fNow; fCtlAny = true; }
    void resolveControl()
    {
        if (!fCtlAny) return;
        if (fCtl[0] < 0) { // header missing: drop stale bytes
            for (int k = 1; k < kCtlKeys; k++) if (fCtl[k] >= 0 && fNow - fCtlAt[k] > 256) fCtl[k] = -1;
            return;
        }
        const int n = (fCtl[0] & 15) + 1;
        for (int k = 1; k < n; k++)
            if (fCtl[k] < 0) { // wait briefly for the rest of the packet, then drop it
                if (fNow - fCtlAt[0] > 256) { for (int& x : fCtl) x = -1; fCtlAny = false; }
                return;
            }
        uint8_t pk[kCtlKeys];
        for (int k = 0; k < n; k++) pk[k] = (uint8_t)fCtl[k];
        for (int& x : fCtl) x = -1;
        fCtlAny = false;
        catchUpTicks();
        applyPacket(pk, n);
        anchorTicks();
        updateCurrent();
    }
    void applyPacket(const uint8_t* b, int n)
    {
        int p = 1;
        auto rd = [&]() -> int { int v = 0, mul = 1, x, i = 0; do { if (p >= n) return v; x = b[p++]; v += (x & 63) * mul; mul *= 63; } while ((x & 64) && ++i < 5); return v; };
        auto sg = [](int u) { return (u & 1) ? -((u + 1) >> 1) : (u >> 1); };
        bool lfoSet = false, delaySet = false;
        const int late = (b[0] >> 4) & 7; // the packet belongs to `late` clocks ago (it did not fit then)
        while (p < n) {
            int tag = b[p++], type = tag >> 4, param = tag & 15;
            switch (type) {
            case 0: { int v = sg(rd()); if (param & 1) fPorta = 0; else { fPorta = v; fPortaAcc = 0; } break; }
            case 1: fDetuneKf = sg(rd()); break;
            case 2: case 3: {
                int per = 0, amp = 0;
                if (param >= 2) { per = rd(); amp = sg(rd()); }
                int m = param == 0 ? 0x80 : param == 1 ? 0x81 : ((param - 2) & 3) + (param >= 10 ? 4 : 0);
                if (type == 2) fPLfo.set(m, per, amp); else fALfo.set(m, per, amp);
                lfoSet = true;
                break;
            }
            case 4:
                if (param == 1) fLegatoNext = true;
                else if (param == 2) { // @ during a note: MXDRV reloads the voice of the sounding note at once
                    int slot = rd();
                    // MXDRV's @: on a keyed-on note the whole voice is written at once; otherwise only the voice
                    // pointer changes (a following v recomputes the carrier TLs from it, the rest waits for the key-on)
                    if (slot >= 0 && slot < 128 && fBank.voice[slot].valid) {
                        clearOverrides(); fCurProg = slot;
                        if (fLastOn >= 0) {
                            ChState& ch = fCh[fLastOn];
                            if (ch.held) { ch.loaded = -2; loadVoice(fLastOn, slot); }
                            else ch.tlProg = slot;
                        }
                    }
                }
                else if (param == 3) { int reg = rd() & 0xff, data = rd() & 0xff; regWrite(reg, data); }
                else { fDelay = rd() & 0xff; delaySet = true; }
                break;
            case 5: { int v = rd(); if (v > 0) fClockSec = v * 256e-6; break; }
            case 6: fVolAtt = std::min(127, rd()); clearTlOverrides(); fLevelDirty = true; if (fLastOn >= 0) fCh[fLastOn].levelKey = -1; break;
            case 7: { int v = std::min(127, rd()); if (v != fFadeAtt) { fFadeAtt = v; refreshLevels(); } break; } // fade-out
            default: p = n; break;
            }
        }
        // an LFO command in the same clock as a key-on comes first in MXDRV: redo the key-on delay
        if (late == 0) { if (lfoSet && fLastOn >= 0 && fNow - fLastOnTime <= 64) lfoKeyOn(); }
        else if ((lfoSet || delaySet) && fLastOn >= 0
                 && std::fabs((double)(fNow - fLastOnTime) - late * clockSamples()) <= clockSamples() * 0.5 + 64) {
            // the key-on was `late` clocks ago: redo it with the new LFO / delay and run the clocks since then
            lfoKeyOn();
            for (int i = 0; i < late; i++) lfoTick();
        }
    }
    /** Key-on (not a tie): with an LFO delay, MXDRV zeroes both LFOs and restarts them after the delay. */
    void lfoKeyOn()
    {
        fDelayCnt = fDelay;
        if (fDelay == 0) return;
        fPLfo.val = 0; fALfo.val = 0;
        delayTick();
    }
    void delayTick()
    {
        fDelayCnt = (fDelayCnt - 1) & 0xff;
        if (fDelayCnt == 0) { if (fPLfo.on) fPLfo.reset(); if (fALfo.on) fALfo.reset(); }
    }
    /** One MDX clock of modulation (MXDRV L001050). */
    void mdxTick()
    {
        if (fPorta) fPortaAcc = (int32_t)((uint32_t)fPortaAcc + (uint32_t)(fPorta * 256));
        lfoTick();
        updateCurrent();
    }
    void lfoTick()
    {
        if (fDelay != 0 && fDelayCnt != 0) delayTick();
        else { if (fPLfo.on) fPLfo.step(fRnd); if (fALfo.on) fALfo.step(fRnd); }
    }
    double clockSamples() const { return std::max(1.0, fClockSec * chipRate()); }
    /** Run the clock that falls on this moment before applying events of the same clock. */
    void catchUpTicks() { while ((double)fNow + clockSamples() * 0.5 >= fNextTick) { mdxTick(); fNextTick += clockSamples(); } }
    void anchorTicks() { fNextTick = (double)fNow + clockSamples(); }
    /** The current note follows the channel's modulation; older (released) voices keep their last state. */
    void updateCurrent()
    {
        if (fLastOn < 0) return;
        ChState& ch = fCh[fLastOn];
        int off = fDetuneKf + (fPortaAcc >> 16) + fPLfo.kf();
        int am = fALfo.att();
        if (off != ch.offKf) { ch.offKf = off; setPitch(fLastOn); }
        if (am != ch.amAtt || fVolAtt != ch.volAtt) {
            if (am != ch.amAtt) clearTlOverrides(); // MXDRV recomputes the carrier TLs from the voice
            ch.amAtt = am; ch.volAtt = fVolAtt; applyLevel(fLastOn);
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
        if (ch.tlProg >= 0) { ch.tlProg = -1; ch.levelKey = -1; }
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
        // y-command overrides (MXDRV has one fixed chip channel per MDX channel; we may use another one)
        for (int row = 0x38; row < 0x100; row += 8) {
            if (row >= 0x60 && row < 0x80) continue; // TL: applyLevel
            int o = fOver[(row - 0x20) >> 3];
            if (o >= 0) write(row + c, o);
        }
        applyLevel(c);
    }

    /** y command (FE): a direct register write as MXDRV does it on this channel. */
    void regWrite(int reg, int data)
    {
        if (reg < 0x20) { write(reg, data); return; } // chip-wide (LFO, noise)
        const int row = reg & 0xf8;
        if (row == 0x28 || row == 0x30) { if (fLastOn >= 0) write(row + fLastOn, data); return; } // pitch: rewritten by the driver anyway
        fOver[(row - 0x20) >> 3] = data;
        if (fLastOn < 0) return;
        if (row == 0x20 || (row >= 0x60 && row < 0x80)) { fCh[fLastOn].levelKey = -1; applyLevel(fLastOn); }
        else write(row + fLastOn, data);
    }
    void clearTlOverrides() { for (int r = 0x60; r < 0x80; r += 8) fOver[(r - 0x20) >> 3] = -1; }
    void clearOverrides()
    {
        bool any = false;
        for (int& o : fOver) { any |= o >= 0; o = -1; }
        if (any) for (auto& ch : fCh) ch.loaded = -2; // chip channels still hold overridden values: reload on next use
    }

    void applyLevel(int c)
    {
        ChState& ch = fCh[c];
        if (ch.loaded < 0) return;
        const OpmVoice& v = fBank.voice[ch.tlProg >= 0 ? ch.tlProg : ch.loaded]; // carrier TLs (see VOICE)
        const OpmVoice& lv = fBank.voice[ch.loaded];
        // amplitude LFO: MXDRV adds the high byte to the volume; an overflow (>= 0x80) mutes
        // MXDRV: volume + amplitude-LFO high byte, any overflow (>= 0x80) becomes 0x7f
        int mxAtt = ch.volAtt + ch.amAtt; if (mxAtt >= 0x80) mxAtt = 0x7f;
        int att = std::min(127, attFromCC(fVol) + attFromCC(fExpr) + mxAtt + fFadeAtt);
        int key = att * 8 + panBits();
        if (key == ch.levelKey) return;
        ch.levelKey = key;
        if (traceFile() && c == fLastOn) std::fprintf(traceFile(), "%.6f a %d\n", fNow / chipRate(), att);
        static const int carriers[8] = { 8, 8, 8, 8, 10, 14, 14, 15 }; // carrier bits in file order M1,C1,M2,C2 (OP1..OP4)
        static const int fileToReg[4] = { 0, 2, 1, 3 };
        for (int k = 0; k < 4; k++) {
            int rs = fileToReg[k];
            const bool car = (carriers[v.con & 7] >> k) & 1;
            int tl = car ? v.op[k].tl + att : lv.op[k].tl;
            if (fOver[(0x60 + rs * 8 - 0x20) >> 3] >= 0) tl = fOver[(0x60 + rs * 8 - 0x20) >> 3] & 127; // y command
            if (traceFile() && c == fLastOn) std::fprintf(traceFile(), "%.6f t%d %d\n", fNow / chipRate(), rs, std::min(127, tl)); // TL per register slot (M1,M2,C1,C2)
            write(0x60 + rs * 8 + c, std::min(127, tl));
        }
        ch.att = att;
        writeRlFlCon(c);
    }
    void writeRlFlCon(int c)
    {
        const ChState& ch = fCh[c];
        if (ch.loaded < 0) return;
        const OpmVoice& lv = fBank.voice[ch.loaded];
        int rl = (ch.att >= 127) ? 0 : panBits();
        const int flcon = fOver[0] >= 0 ? (fOver[0] & 0x3f) : (((lv.fl & 7) << 3) | (lv.con & 7));
        write(0x20 + c, (rl << 6) | flcon);
    }
    void refreshPan() { for (int c = 0; c < 8; c++) writeRlFlCon(c); }

    void refreshLevels() { for (int c = 0; c < 8; c++) applyLevel(c); }

    void setPitch(int c)
    {
        static const int code[12] = { 0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14 };
        // MXDRV note n = MIDI - 15 at 4 MHz (KF +5 like MXDRV); at 3.58 MHz the OPM is ~2 semitones lower.
        double semis = (fCh[c].note - (f4MHz ? 15 : 13)) + (fBend / 8192.0) * fBendRange;
        int p = (int)std::lround(semis * 64.0) + fCh[c].offKf + (f4MHz ? 5 : 0);
        p = std::clamp(p, 0, 8 * 12 * 64 - 1);
        int n = p >> 6, kf = p & 63;
        if (traceFile() && c == fLastOn) std::fprintf(traceFile(), "%.6f p %d\n", fNow / chipRate(), p);
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
    int fCtl[kCtlKeys] = { -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1 };
    uint64_t fCtlAt[kCtlKeys] = {};
    bool fCtlAny = false;
    int fOver[28] = { -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1 }; // y-command register overrides, rows 0x20..0xf8
    int fCurProg = -1;
    bool fLevelDirty = false;
    bool fLegatoNext = false; // LEGATO control item: the next note is a tie into another pitch
    int fLastOn = -1;
    uint64_t fLastOnTime = 0;
    // MDX channel state (one MDX channel per plugin instance)
    int fPorta = 0, fDetuneKf = 0, fDelay = 0, fDelayCnt = 0, fVolAtt = 0, fFadeAtt = 0;
    int32_t fPortaAcc = 0;
    mx::PitchLfo fPLfo;
    mx::AmpLfo fALfo;
    mx::Random fRnd;
    double fNextTick = 0, fClockSec = 12288.0 * 56 / 48 / 1e6;
};
