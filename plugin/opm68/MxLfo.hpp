// MXDRV 2.06 software LFOs (EC pitch / EB amplitude), stepped once per MDX clock.
// Same state machine as packages/core/src/sequencer.ts (ported from MXDRV's L0010be.. / L001120..).
#pragma once
#include <cstdint>

namespace mx {

inline int32_t w16(int32_t v) { return (int16_t)(uint16_t)(v & 0xffff); }

struct Random {
    uint32_t seed = 0x1234;
    uint32_t next() { uint32_t d0 = seed * 0xc549u + 0x0cu; seed = d0 & 0xffff; return d0 >> 8; }
};

struct PitchLfo {
    bool on = false; int wave = 0; uint16_t per = 0, perInit = 0, cnt = 0;
    int32_t delta0 = 0, init = 0, delta = 0, val = 0; // val: 1/65536 KF (offset = val >> 16)

    void reset() { cnt = perInit; delta = delta0; val = init; }
    // m: EC mode byte (0x80 off, 0x81 on, else wave + 4 for amplitude x256)
    void set(int m, int perRaw, int amp)
    {
        if (m & 0x80) { if (m & 1) { on = true; reset(); } else { on = false; val = 0; } return; }
        wave = m & 3; on = true; per = (uint16_t)perRaw;
        perInit = wave == 1 ? per : wave == 3 ? 1 : (uint16_t)(per >> 1);
        int32_t d = (int32_t)(uint32_t)((uint32_t)w16(amp) << 8);
        if (m >= 4) d = (int32_t)((uint32_t)d << 8);
        delta0 = d; init = wave == 2 ? d : 0;
        reset();
    }
    void step(Random& r)
    {
        auto dec = [&] { cnt = (uint16_t)(cnt - 1); return cnt == 0; };
        switch (wave) {
        case 0: val = (int32_t)((uint32_t)val + (uint32_t)delta); if (dec()) { cnt = per; val = (int32_t)(0u - (uint32_t)val); } break;
        case 1: val = delta; if (dec()) { cnt = per; delta = (int32_t)(0u - (uint32_t)delta); } break;
        case 2: val = (int32_t)((uint32_t)val + (uint32_t)delta); if (dec()) { cnt = per; delta = (int32_t)(0u - (uint32_t)delta); } break;
        default: if (dec()) { val = w16((int32_t)r.next()) * w16(delta); cnt = per; }
        }
    }
    int kf() const { return val >> 16; }
};

struct AmpLfo {
    bool on = false; int wave = 0; uint16_t per = 0, cnt = 0;
    int32_t delta0 = 0, init = 0, delta = 0, val = 0; // 16-bit word; attenuation = high byte

    void reset() { cnt = per; delta = delta0; val = init; }
    void set(int m, int perRaw, int amp)
    {
        if (m & 0x80) { if (m & 1) { on = true; reset(); } else { on = false; val = 0; } return; }
        wave = m & 3; on = true; per = (uint16_t)perRaw; delta0 = w16(amp);
        int32_t x = w16((wave & 1) ? -delta0 : -(delta0 * w16(perRaw)));
        init = x < 0 ? 0 : x;
        reset();
    }
    void step(Random& r)
    {
        auto dec = [&] { cnt = (uint16_t)(cnt - 1); return cnt == 0; };
        switch (wave) {
        case 0: val = w16(val + delta); if (dec()) { cnt = per; val = init; } break;
        case 1: if (dec()) { cnt = per; val = w16(val + delta); delta = w16(-delta); } break;
        case 2: val = w16(val + delta); if (dec()) { cnt = per; delta = w16(-delta); } break;
        default: if (dec()) { val = w16(delta * w16((int32_t)r.next())); cnt = per; }
        }
    }
    int att() const { return on ? (val >> 8) & 0xff : 0; }
};

} // namespace mx
