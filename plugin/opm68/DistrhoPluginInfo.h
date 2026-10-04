#ifndef DISTRHO_PLUGIN_INFO_H_INCLUDED
#define DISTRHO_PLUGIN_INFO_H_INCLUDED

#define DISTRHO_PLUGIN_BRAND   "MDXPCM2MIDI"
#define DISTRHO_PLUGIN_NAME    "OPM68"
#define DISTRHO_PLUGIN_URI     "https://github.com/YosAwed/MDXPCM2MIDI/opm68"
#define DISTRHO_PLUGIN_CLAP_ID "jp.mdxpcm2midi.opm68"
#define DISTRHO_PLUGIN_BRAND_ID Mdxp
#define DISTRHO_PLUGIN_UNIQUE_ID Op68
#define DISTRHO_PLUGIN_CLAP_FEATURES "instrument", "synthesizer", "stereo"
#define DISTRHO_PLUGIN_VST3_CATEGORIES "Instrument|Synth"

#define DISTRHO_PLUGIN_HAS_UI          1
#define DISTRHO_PLUGIN_IS_SYNTH        1
#define DISTRHO_PLUGIN_IS_RT_SAFE      1
#define DISTRHO_PLUGIN_NUM_INPUTS      0
#define DISTRHO_PLUGIN_NUM_OUTPUTS     2
#define DISTRHO_PLUGIN_WANT_STATE      1
#define DISTRHO_PLUGIN_WANT_FULL_STATE 1
#define DISTRHO_PLUGIN_WANT_MIDI_INPUT 1
#define DISTRHO_UI_FILE_BROWSER        1
#define DISTRHO_UI_USE_NANOVG          1
#define DISTRHO_UI_DEFAULT_WIDTH       520
#define DISTRHO_UI_DEFAULT_HEIGHT      336

enum Parameters {
    kParamVolume = 0,   // dB
    kParamVelProgram,   // velocity selects voice
    kParamProgram,      // voice used when velocity mode is off (also follows program change)
    kParamMono,
    kParamClock4MHz,
    kParamBendRange,
    kParamLastVoice,    // output: voice of the last note
    kParamX68Lpf,       // X68000 output low-pass (on by default; matches MXDRV)
    kParamLowCut,       // low cut (coupling capacitors): 0 off, 1 = 70 Hz, 2 = 110 Hz
    kParamCount
};

enum States {
    kStateBankFile = 0, // path chosen in the UI
    kStateBankData,     // full .opm text, saved with the project
    kStateCount
};

#endif
