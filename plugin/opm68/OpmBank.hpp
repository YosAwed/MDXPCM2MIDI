// .OPM (VOPM / MiOPMdrv) sound bank parser.
#pragma once
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

struct OpmOp { int ar = 31, d1r = 0, d2r = 0, rr = 15, d1l = 0, tl = 127, ks = 0, mul = 1, dt1 = 0, dt2 = 0, ame = 0; };

struct OpmVoice {
    bool valid = false;
    std::string name;
    int lfrq = 0, amd = 0, pmd = 0, wf = 0, nfrq = 0;
    int pan = 64, fl = 0, con = 0, ams = 0, pms = 0, slot = 120, ne = 0;
    OpmOp op[4]; // file order: M1, C1, M2, C2
};

struct OpmBank {
    OpmVoice voice[128];
    int count = 0;

    // Parse text; returns number of voices found.
    int parse(const std::string& text)
    {
        for (auto& v : voice) v = OpmVoice();
        count = 0;
        int cur = -1;
        size_t pos = 0;
        while (pos < text.size()) {
            size_t e = text.find('\n', pos);
            if (e == std::string::npos) e = text.size();
            std::string line = text.substr(pos, e - pos);
            pos = e + 1;
            while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
            if (line.rfind("//", 0) == 0 || line.empty()) continue;
            if (line.rfind("@:", 0) == 0) {
                char* end = nullptr;
                long n = std::strtol(line.c_str() + 2, &end, 10);
                cur = (n >= 0 && n < 128) ? (int)n : -1;
                if (cur >= 0) {
                    voice[cur] = OpmVoice();
                    voice[cur].valid = true;
                    while (end && *end == ' ') end++;
                    voice[cur].name = end ? end : "";
                    if (voice[cur].name == "no Name") voice[cur].valid = false;
                    count++;
                }
                continue;
            }
            if (cur < 0) continue;
            int vals[11] = {};
            const char* p = line.c_str();
            const char* colon = std::strchr(p, ':');
            if (!colon) continue;
            std::string tag(p, colon - p);
            int n = readInts(colon + 1, vals, 11);
            OpmVoice& v = voice[cur];
            if (tag == "LFO" && n >= 5) { v.lfrq = vals[0]; v.amd = vals[1]; v.pmd = vals[2]; v.wf = vals[3]; v.nfrq = vals[4]; }
            else if (tag == "CH" && n >= 7) { v.pan = vals[0]; v.fl = vals[1]; v.con = vals[2]; v.ams = vals[3]; v.pms = vals[4]; v.slot = vals[5]; v.ne = vals[6]; }
            else {
                int k = tag == "M1" ? 0 : tag == "C1" ? 1 : tag == "M2" ? 2 : tag == "C2" ? 3 : -1;
                if (k < 0 || n < 11) continue;
                OpmOp& o = v.op[k];
                o.ar = vals[0]; o.d1r = vals[1]; o.d2r = vals[2]; o.rr = vals[3]; o.d1l = vals[4]; o.tl = vals[5];
                o.ks = vals[6]; o.mul = vals[7]; o.dt1 = vals[8]; o.dt2 = vals[9]; o.ame = vals[10];
            }
        }
        // a slot named "no Name" with real data still counts as usable
        count = 0;
        for (auto& v : voice) if (v.valid) count++;
        return count;
    }

private:
    static int readInts(const char* s, int* out, int max)
    {
        int n = 0;
        while (*s && n < max) {
            while (*s == ' ' || *s == '\t') s++;
            if (!*s) break;
            char* end = nullptr;
            long v = std::strtol(s, &end, 10);
            if (end == s) break;
            out[n++] = (int)v;
            s = end;
        }
        return n;
    }
};
