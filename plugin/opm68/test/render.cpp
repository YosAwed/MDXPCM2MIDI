// Offline test: render a MIDI event list (from midi2txt.py) through OpmEngine at 48 kHz.
#include "../OpmEngine.hpp"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <vector>
#include <cstdlib>
int main(int argc, char** argv) {
    if (argc < 4) { std::fprintf(stderr, "render bank.opm events.txt out.raw [velprog=1]\n"); return 1; }
    std::ifstream bf(argv[1], std::ios::binary); std::stringstream ss; ss << bf.rdbuf();
    OpmBank bank; std::printf("voices %d\n", bank.parse(ss.str()));
    if (getenv("OPMTRACE")) OpmEngine::traceFile() = std::fopen(getenv("OPMTRACE"), "w");
    OpmEngine eng; eng.setBank(bank); eng.setVelocityProgram(argc < 5 || argv[4][0] != '0');
    const double sr = 48000, ratio = eng.chipRate() / sr;
    std::ifstream ev(argv[2]); FILE* out = std::fopen(argv[3], "wb");
    long frame = 0, t; int a, b, c; double phase = 1; float pl = 0, pr = 0, cl = 0, cr = 0;
    auto advance = [&](long until) {
        for (; frame < until; frame++) {
            phase += ratio;
            while (phase >= 1) { phase -= 1; pl = cl; pr = cr; eng.generate(cl, cr); }
            float s[2] = { pl + (cl - pl) * (float)phase, pr + (cr - pr) * (float)phase };
            std::fwrite(s, 4, 2, out);
        }
    };
    while (ev >> t >> a >> b >> c) {
        advance(t);
        int st = a & 0xf0;
        if (st == 0x90) eng.noteOn(b, c); else if (st == 0x80) eng.noteOff(b);
        else if (st == 0xb0) eng.controlChange(b, c); else if (st == 0xc0) eng.programChange(b);
        else if (st == 0xe0) eng.pitchBend(b | (c << 7));
    }
    advance(frame + 48000);
    std::fclose(out);
}
