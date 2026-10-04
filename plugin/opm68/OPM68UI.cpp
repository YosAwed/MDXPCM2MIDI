#include "DistrhoUI.hpp"
#include "DistrhoPluginInfo.h"
#include "NanoButton.hpp"
#include "OpmBank.hpp"
#include <fstream>
#include <sstream>

START_NAMESPACE_DISTRHO

using DGL_NAMESPACE::Button;
using DGL_NAMESPACE::ButtonEventHandler;
using DGL_NAMESPACE::SubWidget;

class OPM68UI : public UI, public ButtonEventHandler::Callback {
public:
    OPM68UI()
        : UI(DISTRHO_UI_DEFAULT_WIDTH, DISTRHO_UI_DEFAULT_HEIGHT),
          fLoad(this, this), fVel(this, this), fMono(this, this), fClock(this, this)
    {
        loadSharedResources();
        setup(fLoad, 12, 44, 120, "Load .OPM...");
        setup(fVel, 140, 44, 120, "");
        setup(fMono, 268, 44, 110, "");
        setup(fClock, 386, 44, 122, "");
        for (float& p : fParams) p = 0;
        fParams[kParamVelProgram] = 1; fParams[kParamClock4MHz] = 1; fParams[kParamLastVoice] = -1;
        updateLabels();
        setGeometryConstraints(DISTRHO_UI_DEFAULT_WIDTH, DISTRHO_UI_DEFAULT_HEIGHT, true);
    }

protected:
    void parameterChanged(uint32_t index, float value) override
    {
        if (index < kParamCount) fParams[index] = value;
        updateLabels();
        repaint();
    }

    void stateChanged(const char* key, const char* value) override
    {
        if (std::strcmp(key, "bankfile") == 0) {
            fFile = value;
            std::ifstream f(value, std::ios::binary);
            if (f) { std::stringstream ss; ss << f.rdbuf(); OpmBank b; if (b.parse(ss.str()) > 0) fBank = b; }
            repaint();
        } else if (std::strcmp(key, "bankdata") == 0 && value && *value) {
            // the bank the DSP actually plays (embedded by the converter in .flp projects; the file may not exist)
            OpmBank b; if (b.parse(value) > 0) fBank = b;
            repaint();
        }
    }

    void onNanoDisplay() override
    {
        const float W = getWidth(), H = getHeight();
        beginPath(); rect(0, 0, W, H); fillColor(Color(28, 30, 36)); fill();
        // header
        fontSize(20); fillColor(Color(251, 146, 60)); textAlign(ALIGN_LEFT | ALIGN_MIDDLE);
        text(12, 20, "OPM68", nullptr);
        fontSize(13); fillColor(Color(160, 164, 172));
        text(84, 21, "YM2151 for MDX  -  ymfm core  -  v0.6.3", nullptr);

        // bank info
        fontSize(13); fillColor(Color(236, 235, 231));
        std::string name = fFile.isEmpty() ? std::string("(no bank loaded)") : baseName(fFile.buffer());
        char buf[256];
        std::snprintf(buf, sizeof(buf), "Bank: %s   (%d voices)", name.c_str(), fBank.count);
        text(12, 96, buf, nullptr);

        const int last = (int)fParams[kParamLastVoice];
        if (last >= 0) {
            std::snprintf(buf, sizeof(buf), "Playing: %03d  %s", last, fBank.voice[last].valid ? fBank.voice[last].name.c_str() : "");
            fillColor(Color(134, 239, 172));
            text(12, 116, buf, nullptr);
        }

        // voice list (two columns)
        fontSize(11.5f);
        int row = 0;
        const float top = 140, lh = 15;
        const int rows = (int)((H - top - 8) / lh);
        for (int i = 0; i < 128 && rows > 0; i++) {
            if (!fBank.voice[i].valid) continue;
            const int col = row / rows;
            if (col > 1) break;
            const float x = 12 + col * (W / 2), y = top + (row % rows) * lh;
            fillColor(i == last ? Color(251, 146, 60) : Color(190, 192, 198));
            std::snprintf(buf, sizeof(buf), "vel %3d  @%03d  %s", i + 1, i, fBank.voice[i].name.c_str());
            text(x, y, buf, nullptr);
            row++;
        }
        if (fBank.count == 0) {
            fillColor(Color(160, 164, 172));
            text(12, top, "Load the .opm written by MDXPCM2MIDI (OPM68 mode).", nullptr);
            text(12, top + lh, "Note velocity 1-127 selects voice 0-126; MIDI channel is ignored.", nullptr);
        }
    }

    void buttonClicked(SubWidget* w, int) override
    {
        if (w == &fLoad) requestStateFile("bankfile");
        else if (w == &fVel) toggle(kParamVelProgram);
        else if (w == &fMono) toggle(kParamMono);
        else if (w == &fClock) toggle(kParamClock4MHz);
    }

private:
    static void setup(Button& b, int x, int y, int w, const char* label)
    {
        b.setAbsolutePos(x, y); b.setSize(w, 30); b.setLabel(label);
        b.setBackgroundColor(Color(48, 51, 59)); b.setLabelColor(Color(236, 235, 231));
    }
    void toggle(uint32_t p)
    {
        fParams[p] = fParams[p] > 0.5f ? 0 : 1;
        editParameter(p, true); setParameterValue(p, fParams[p]); editParameter(p, false);
        updateLabels(); repaint();
    }
    void updateLabels()
    {
        fVel.setLabel(fParams[kParamVelProgram] > 0.5f ? "Vel=Voice: ON" : "Vel=Voice: OFF");
        fMono.setLabel(fParams[kParamMono] > 0.5f ? "Mono: ON" : "Mono: OFF");
        fClock.setLabel(fParams[kParamClock4MHz] > 0.5f ? "Clock: 4MHz" : "Clock: 3.58MHz");
    }
    static std::string baseName(const char* p)
    {
        std::string s(p);
        size_t k = s.find_last_of("/\\");
        return k == std::string::npos ? s : s.substr(k + 1);
    }

    Button fLoad, fVel, fMono, fClock;
    float fParams[kParamCount];
    String fFile;
    OpmBank fBank;

    DISTRHO_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OPM68UI)
};

UI* createUI() { return new OPM68UI(); }

END_NAMESPACE_DISTRHO
