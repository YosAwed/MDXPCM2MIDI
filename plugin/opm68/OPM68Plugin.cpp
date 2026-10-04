#include "DistrhoPlugin.hpp"
#include "OpmEngine.hpp"
#include <mutex>
#include <fstream>
#include <sstream>

START_NAMESPACE_DISTRHO

class OPM68Plugin : public Plugin {
public:
    OPM68Plugin() : Plugin(kParamCount, 0, kStateCount) { fEngine.setVelocityProgram(true); }

protected:
    const char* getLabel() const override { return "OPM68"; }
    const char* getDescription() const override { return "YM2151 (OPM) synth for MDX conversions. Loads .opm banks; note velocity selects the voice."; }
    const char* getMaker() const override { return "MDXPCM2MIDI"; }
    const char* getHomePage() const override { return "https://github.com/YosAwed/MDXPCM2MIDI"; }
    const char* getLicense() const override { return "BSD-3-Clause"; }
    uint32_t getVersion() const override { return d_version(0, 6, 2); }

    void initParameter(uint32_t index, Parameter& p) override
    {
        p.hints = kParameterIsAutomatable;
        switch (index) {
        case kParamVolume: p.name = "Volume"; p.symbol = "volume"; p.unit = "dB"; p.ranges = ParameterRanges(0.0f, -36.0f, 12.0f); break;
        case kParamVelProgram: p.name = "Velocity selects voice"; p.symbol = "velprog"; p.hints |= kParameterIsBoolean | kParameterIsInteger; p.ranges = ParameterRanges(1, 0, 1); break;
        case kParamProgram: p.name = "Voice"; p.symbol = "voice"; p.hints |= kParameterIsInteger; p.ranges = ParameterRanges(0, 0, 127); break;
        case kParamMono: p.name = "Mono"; p.symbol = "mono"; p.hints |= kParameterIsBoolean | kParameterIsInteger; p.ranges = ParameterRanges(0, 0, 1); break;
        case kParamClock4MHz: p.name = "Clock 4MHz (X68000)"; p.symbol = "clock4mhz"; p.hints |= kParameterIsBoolean | kParameterIsInteger; p.ranges = ParameterRanges(1, 0, 1); break;
        case kParamBendRange: p.name = "Pitch bend range"; p.symbol = "bendrange"; p.unit = "semi"; p.hints |= kParameterIsInteger; p.ranges = ParameterRanges(12, 0, 48); break;
        case kParamLastVoice: p.name = "Last voice"; p.symbol = "lastvoice"; p.hints = kParameterIsOutput | kParameterIsInteger; p.ranges = ParameterRanges(-1, -1, 127); break;
        }
    }

    float getParameterValue(uint32_t index) const override
    {
        switch (index) {
        case kParamVolume: return fVolumeDb;
        case kParamVelProgram: return fVelProg ? 1 : 0;
        case kParamProgram: return fProgram;
        case kParamMono: return fMono ? 1 : 0;
        case kParamClock4MHz: return f4MHz ? 1 : 0;
        case kParamBendRange: return fBendRange;
        case kParamLastVoice: return fLastVoice;
        }
        return 0;
    }

    void setParameterValue(uint32_t index, float v) override
    {
        switch (index) {
        case kParamVolume: fVolumeDb = v; fGain = std::pow(10.0f, v / 20.0f); break;
        case kParamVelProgram: fVelProg = v > 0.5f; fEngine.setVelocityProgram(fVelProg); break;
        case kParamProgram: fProgram = (int)v; fEngine.programChange(fProgram); break;
        case kParamMono: fMono = v > 0.5f; fEngine.setMono(fMono); break;
        case kParamClock4MHz: f4MHz = v > 0.5f; fEngine.setClock4MHz(f4MHz); updateRatio(); break;
        case kParamBendRange: fBendRange = (int)v; fEngine.setDefaultBend(fBendRange); fEngine.controlChange(101, 0); fEngine.controlChange(100, 0); fEngine.controlChange(6, fBendRange); fEngine.controlChange(101, 127); fEngine.controlChange(100, 127); break;
        }
    }

    void initState(uint32_t index, State& s) override
    {
        if (index == kStateBankFile) { s.key = "bankfile"; s.defaultValue = ""; s.label = "OPM bank file"; s.hints = kStateIsFilenamePath; }
        else { s.key = "bankdata"; s.defaultValue = ""; s.label = "OPM bank data"; s.hints = kStateIsOnlyForDSP; }
    }

    String getState(const char* key) const override
    {
        if (std::strcmp(key, "bankfile") == 0) return fBankFile;
        if (std::strcmp(key, "bankdata") == 0) return String(fBankText.c_str());
        return String();
    }

    void setState(const char* key, const char* value) override
    {
        if (std::strcmp(key, "bankfile") == 0) {
            fBankFile = value;
            std::ifstream f(value, std::ios::binary);
            if (!f) return;
            std::stringstream ss; ss << f.rdbuf();
            loadText(ss.str());
        } else if (std::strcmp(key, "bankdata") == 0) {
            if (value && *value) loadText(value);
        }
    }

    void activate() override { updateRatio(); std::lock_guard<std::mutex> g(fLock); fEngine.reset(); fPhase = 1.0; }

    void run(const float**, float** outputs, uint32_t frames, const MidiEvent* ev, uint32_t evCount) override
    {
        float* L = outputs[0]; float* R = outputs[1];
        std::unique_lock<std::mutex> g(fLock, std::try_to_lock);
        if (!g.owns_lock()) { std::memset(L, 0, frames * 4); std::memset(R, 0, frames * 4); return; }
        uint32_t e = 0;
        for (uint32_t i = 0; i < frames; i++) {
            while (e < evCount && ev[e].frame <= i) { handle(ev[e]); e++; }
            // linear-interpolating resampler from the chip rate to the host rate
            fPhase += fRatio;
            while (fPhase >= 1.0) { fPhase -= 1.0; fPrevL = fCurL; fPrevR = fCurR; fEngine.generate(fCurL, fCurR); }
            float t = (float)fPhase;
            L[i] = (fPrevL + (fCurL - fPrevL) * t) * fGain;
            R[i] = (fPrevR + (fCurR - fPrevR) * t) * fGain;
        }
        while (e < evCount) handle(ev[e++]);
        fLastVoice = fEngine.lastProgram();
    }

private:
    void handle(const MidiEvent& m)
    {
        const uint8_t* d = m.size > MidiEvent::kDataSize ? m.dataExt : m.data;
        uint8_t st = d[0] & 0xf0; // MIDI channel is ignored on purpose
        switch (st) {
        case 0x90: fEngine.noteOn(d[1], d[2]); break;
        case 0x80: fEngine.noteOff(d[1]); break;
        case 0xb0: fEngine.controlChange(d[1], d[2]); break;
        case 0xc0: fEngine.programChange(d[1]); break;
        case 0xe0: fEngine.pitchBend(d[1] | (d[2] << 7)); break;
        }
    }

    void loadText(const std::string& text)
    {
        OpmBank b;
        if (b.parse(text) == 0) { d_stderr("OPM68 bank parse failed"); return; }
        d_stderr("OPM68 bank loaded %d voices", b.count);
        std::lock_guard<std::mutex> g(fLock);
        fBankText = text;
        fEngine.setBank(b);
    }

    void updateRatio() { double sr = getSampleRate(); fRatio = fEngine.chipRate() / (sr > 0 ? sr : 48000.0); }

    OpmEngine fEngine;
    std::mutex fLock;
    std::string fBankText;
    String fBankFile;
    double fRatio = 62500.0 / 48000.0, fPhase = 1.0;
    float fPrevL = 0, fPrevR = 0, fCurL = 0, fCurR = 0;
    float fVolumeDb = 0, fGain = 1;
    bool fVelProg = true, fMono = false, f4MHz = true;
    int fProgram = 0, fBendRange = 12, fLastVoice = -1;

    DISTRHO_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OPM68Plugin)
};

Plugin* createPlugin() { return new OPM68Plugin(); }

END_NAMESPACE_DISTRHO
