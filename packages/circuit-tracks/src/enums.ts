/**
 * Circuit Tracks enum tables (handoff §6, confirmed against the v3
 * Programmer's Reference Guide). Wire index → display name.
 */

export const POLY_MODE: Readonly<Record<number, string>> = {
  0: 'Mono', 1: 'Mono AG', 2: 'Poly',
};

export const FILTER_ROUTING: Readonly<Record<number, string>> = {
  0: 'Normal', 1: 'Osc1 Bypass', 2: 'Osc1+2 Bypass',
};

/** Filter drive type (CC 65) and distortion type (NRPN 1:0) share these. */
export const DRIVE_TYPE: Readonly<Record<number, string>> = {
  0: 'Diode', 1: 'Valve', 2: 'Clipper', 3: 'Cross-over',
  4: 'Rectifier', 5: 'Bit Reducer', 6: 'Rate Reducer',
};

export const FILTER_TYPE: Readonly<Record<number, string>> = {
  0: 'LP12', 1: 'LP24', 2: 'BP6/6', 3: 'BP12/12', 4: 'HP12', 5: 'HP24',
};

export const CHORUS_TYPE: Readonly<Record<number, string>> = {
  0: 'Phaser', 1: 'Chorus',
};

export const REVERB_TYPE: Readonly<Record<number, string>> = {
  0: 'Chamber', 1: 'Small Room', 2: 'Large Room',
  3: 'Small Hall', 4: 'Large Hall', 5: 'Great Hall',
};

export const DELAY_LR_RATIO: Readonly<Record<number, string>> = {
  0: '1:1', 1: '4:3', 2: '3:4', 3: '3:2', 4: '2:3', 5: '2:1',
  6: '1:2', 7: '3:1', 8: '1:3', 9: '4:1', 10: '1:4', 11: '1:OFF', 12: 'OFF:1',
};

/** FX bypass (NRPN 1:21): 0 = FX enabled, 1 = FX disabled. */
export const FX_BYPASS: Readonly<Record<number, string>> = {
  0: 'Enabled', 1: 'Disabled',
};

/** Sidechain source (NRPN 2:55 / 2:65): which drum ducks the synth; 4 = off. */
export const SIDECHAIN_SOURCE: Readonly<Record<number, string>> = {
  0: 'Drum 1', 1: 'Drum 2', 2: 'Drum 3', 3: 'Drum 4', 4: 'OFF',
};

export const OSC_WAVEFORM: Readonly<Record<number, string>> = {
  0: 'Sine', 1: 'Triangle', 2: 'Sawtooth',
  // Descending saw:pulse blends, verified against the v3 PDF Osc Waveform Table
  // (3='saw 9:1 PW' … 11='saw 1:9 PW'); Title-cased to match this table's casing.
  3: 'Saw 9:1 PW', 4: 'Saw 8:2 PW', 5: 'Saw 7:3 PW', 6: 'Saw 6:4 PW',
  7: 'Saw 5:5 PW', 8: 'Saw 4:6 PW', 9: 'Saw 3:7 PW', 10: 'Saw 2:8 PW', 11: 'Saw 1:9 PW',
  12: 'Pulse Width', 13: 'Square', 14: 'Sine Table', 15: 'Analogue Pulse',
  16: 'Analogue Sync', 17: 'Triangle-Saw Blend', 18: 'Digital Nasty 1', 19: 'Digital Nasty 2',
  20: 'Digital Saw-Square', 21: 'Digital Vocal 1', 22: 'Digital Vocal 2', 23: 'Digital Vocal 3',
  24: 'Digital Vocal 4', 25: 'Digital Vocal 5', 26: 'Digital Vocal 6',
  27: 'Random Collection 1', 28: 'Random Collection 2', 29: 'Random Collection 3',
};

/** Mod-matrix source (0-12; 1-3 are unused on the device). */
export const MOD_SOURCE: Readonly<Record<number, string>> = {
  0: 'Direct', 4: 'Velocity', 5: 'Keyboard', 6: 'LFO1+', 7: 'LFO1+/-',
  8: 'LFO2+', 9: 'LFO2+/-', 10: 'Env Amp', 11: 'Env Filter', 12: 'Env 3',
};

/** Mod-matrix destination (0-17). */
export const MOD_DEST: Readonly<Record<number, string>> = {
  0: 'Osc1&2 Pitch', 1: 'Osc1 Pitch', 2: 'Osc2 Pitch', 3: 'Osc1 V-Sync', 4: 'Osc2 V-Sync',
  5: 'Osc1 PW/Index', 6: 'Osc2 PW/Index', 7: 'Osc1 Level', 8: 'Osc2 Level', 9: 'Noise Level',
  10: 'Ring Mod Level', 11: 'Filter Drive', 12: 'Filter Frequency', 13: 'Filter Resonance',
  14: 'LFO1 Rate', 15: 'LFO2 Rate', 16: 'Amp Env Decay', 17: 'Filter Env Decay',
};

export const LFO_WAVEFORM: Readonly<Record<number, string>> = {
  0: 'Sine', 1: 'Triangle', 2: 'Sawtooth', 3: 'Square', 4: 'Random S/H', 5: 'Time S/H',
  6: 'Piano Env', 7: 'Sequence 1', 8: 'Sequence 2', 9: 'Sequence 3', 10: 'Sequence 4',
  11: 'Sequence 5', 12: 'Sequence 6', 13: 'Sequence 7',
  14: 'Alternative 1', 15: 'Alternative 2', 16: 'Alternative 3', 17: 'Alternative 4',
  18: 'Alternative 5', 19: 'Alternative 6', 20: 'Alternative 7', 21: 'Alternative 8',
  22: 'Chromatic', 23: 'Chromatic 16', 24: 'Major', 25: 'Major 7', 26: 'Minor 7',
  27: 'Min Arp 1', 28: 'Min Arp 2', 29: 'Diminished', 30: 'Dec Minor', 31: 'Minor 3rd',
  32: 'Pedal', 33: '4ths', 34: '4ths x12', 35: '1625 Maj', 36: '1625 Min', 37: '2511',
};
