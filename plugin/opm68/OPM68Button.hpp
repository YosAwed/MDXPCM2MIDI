// Flat push button for the OPM68 UI: a filled box with a 1 px outline and a centred label.
// Click handling comes from DPF's ButtonEventHandler (the callback gets buttonClicked()).
#pragma once
#include "NanoVG.hpp"
#include "EventHandlers.hpp"
#include <string>

START_NAMESPACE_DGL

class OPM68Button : public NanoSubWidget, public ButtonEventHandler {
public:
    OPM68Button(Widget* parent, ButtonEventHandler::Callback* cb)
        : NanoSubWidget(parent), ButtonEventHandler(this)
    {
        loadSharedResources();
        setCallback(cb);
    }

    void setLabel(const std::string& s) { fLabel = s; repaint(); }
    void setBackgroundColor(Color c) { fBg = c; repaint(); }
    void setLabelColor(Color c) { fFg = c; repaint(); }

protected:
    void onNanoDisplay() override
    {
        const float w = getWidth(), h = getHeight();
        beginPath(); rect(0.5f, 0.5f, w - 1, h - 1);
        fillColor(getState() & kButtonStateActive ? Color(fBg, fFg, 0.15f) : fBg); fill();
        strokeColor(fFg); strokeWidth(1); stroke();
        fontSize(14); fillColor(fFg); textAlign(ALIGN_CENTER | ALIGN_MIDDLE);
        text(w / 2, h / 2, fLabel.c_str(), nullptr);
    }
    bool onMouse(const MouseEvent& ev) override { return mouseEvent(ev); }
    bool onMotion(const MotionEvent& ev) override { return motionEvent(ev); }

private:
    std::string fLabel;
    Color fBg{32, 32, 32}, fFg{255, 255, 255};
};

END_NAMESPACE_DGL
