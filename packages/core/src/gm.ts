// Default mappings from OPM voices / PDX samples to General MIDI.
// These are rough heuristics; users can override them in the UI.

import type { OpmVoice } from './mdx.js';

/** Guess a GM program from an OPM voice's algorithm and envelope. */
export function defaultProgramFor(v: OpmVoice | undefined): number {
  if (!v) return 80; // Lead 1 (square)
  // carriers per algorithm; ops are stored in OPM register order M1, M2, C1, C2
  const carriers: Record<number, number[]> = {
    0: [3], 1: [3], 2: [3], 3: [3], 4: [2, 3], 5: [1, 2, 3], 6: [1, 2, 3], 7: [0, 1, 2, 3],
  };
  const cs = carriers[v.con] ?? [3];
  const avg = (f: (o: OpmVoice['ops'][number]) => number) => cs.reduce((s, i) => s + f(v.ops[i]), 0) / cs.length;
  const ar = avg((o) => o.ar), d1r = avg((o) => o.d1r), d1l = avg((o) => o.d1l), rr = avg((o) => o.rr);
  const sustained = d1l <= 3 || d1r <= 2;
  const percussive = !sustained && d1r >= 8;

  if (v.con === 7) return sustained ? 16 : 11;      // organ / vibraphone
  if (percussive && rr >= 8) {
    if (v.con <= 3) return 33;                      // electric bass (finger)
    return 4;                                       // electric piano
  }
  if (percussive) return v.con >= 4 ? 25 : 27;      // guitars
  if (ar < 20) return v.con >= 4 ? 48 : 89;         // strings / warm pad
  if (v.con >= 4) return 61;                        // brass section
  return 81;                                        // Lead 2 (sawtooth)
}

const DRUM_CYCLE = [36, 38, 42, 46, 49, 45, 48, 50, 39, 51, 41, 57, 37, 44, 47, 43, 52, 55, 56, 54];

export function defaultDrumFor(sampleIndex: number): number {
  return DRUM_CYCLE[sampleIndex % DRUM_CYCLE.length];
}

export const GM_PROGRAM_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];
