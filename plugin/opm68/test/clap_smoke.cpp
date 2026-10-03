#include "entry.h"
#include "plugin-factory.h"
#include "ext/params.h"
#include "ext/state.h"
#include "process.h"
#include "events.h"
#include <dlfcn.h>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
static const void* get_ext(const clap_host*, const char*) { return nullptr; }
static void noop(const clap_host*) {}
struct In { std::string s; size_t p = 0; };
static int64_t rd(const clap_istream* st, void* buf, uint64_t n) { In* in = (In*)st->ctx; size_t k = std::min<size_t>(n, in->s.size() - in->p); std::memcpy(buf, in->s.data() + in->p, k); in->p += k; return k; }
struct Ev { std::vector<clap_event_note> v; };
static uint32_t esize(const clap_input_events* l) { return ((Ev*)l->ctx)->v.size(); }
static const clap_event_header* eget(const clap_input_events* l, uint32_t i) { return &((Ev*)l->ctx)->v[i].header; }
static bool epush(const clap_output_events*, const clap_event_header*) { return true; }
int main(int argc, char** argv) {
    void* h = dlopen(argv[1], RTLD_NOW); if (!h) { std::printf("dlopen fail %s\n", dlerror()); return 1; }
    auto entry = (const clap_plugin_entry*)dlsym(h, "clap_entry"); entry->init(argv[1]);
    auto fac = (const clap_plugin_factory*)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
    auto desc = fac->get_plugin_descriptor(fac, 0); std::printf("plugin: %s (%s)\n", desc->name, desc->id);
    clap_host host{}; host.clap_version = CLAP_VERSION; host.name = "smoke"; host.vendor = "x"; host.url = ""; host.version = "1";
    host.get_extension = get_ext; host.request_restart = noop; host.request_process = noop; host.request_callback = noop;
    auto pl = fac->create_plugin(fac, &host, desc->id); pl->init(pl);
    auto params = (const clap_plugin_params*)pl->get_extension(pl, CLAP_EXT_PARAMS);
    for (uint32_t i = 0; params && i < params->count(pl); i++) { clap_param_info inf; params->get_info(pl, i, &inf); std::printf("  param %s = %g\n", inf.name, inf.default_value); }
    auto state = (const clap_plugin_state*)pl->get_extension(pl, CLAP_EXT_STATE);
    In in; in.s = std::string("__dpf_state_begin__") + '\0' + "bankfile" + '\0' + argv[2] + '\0' + "__dpf_state_end__" + '\0' + '\xfe';
    clap_istream is{ &in, rd }; std::printf("state load: %d\n", state->load(pl, &is));
    pl->activate(pl, 48000, 32, 512); pl->start_processing(pl);
    std::vector<float> L(512), R(512); float* chans[2] = { L.data(), R.data() };
    clap_audio_buffer ob{}; ob.data32 = chans; ob.channel_count = 2;
    FILE* f = std::fopen(argv[3], "wb");
    double energy = 0;
    for (int blk = 0; blk < 200; blk++) {
        Ev ev;
        if (blk % 10 == 0) { clap_event_note n{}; n.header = { sizeof(n), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_NOTE_ON, 0 }; n.port_index = 0; n.channel = 7; n.key = std::atoi(argv[4]); n.velocity = std::atoi(argv[5]) / 127.0; n.note_id = -1; ev.v.push_back(n); }
        if (blk % 10 == 5) { clap_event_note n{}; n.header = { sizeof(n), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_NOTE_OFF, 0 }; n.channel = 7; n.key = std::atoi(argv[4]); n.note_id = -1; ev.v.push_back(n); }
        clap_input_events iev{ &ev, esize, eget }; clap_output_events oev{ nullptr, epush };
        clap_process p{}; p.steady_time = blk * 512; p.frames_count = 512; p.audio_outputs = &ob; p.audio_outputs_count = 1; p.in_events = &iev; p.out_events = &oev;
        pl->process(pl, &p);
        for (int i = 0; i < 512; i++) { energy += L[i] * L[i]; float s[2] = { L[i], R[i] }; std::fwrite(s, 4, 2, f); }
    }
    std::fclose(f);
    std::printf("rms %.5f\n", std::sqrt(energy / (200 * 512)));
    pl->stop_processing(pl); pl->deactivate(pl); pl->destroy(pl); entry->deinit();
}
