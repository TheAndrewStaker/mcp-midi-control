/**
 * Circuit Tracks parameter registry (handoff §5-§8, confirmed against the
 * v3 Programmer's Reference Guide).
 *
 * ONE descriptor per param, keyed internally by (channel/scope, kind,
 * number), NEVER by CC number alone, because CCs collide across scopes
 * (CC 12 is drum-1 level on ch10 AND synth-1 level on ch16; CC 74 is the
 * synth filter freq on ch1 AND the project master filter on ch16). The
 * channel disambiguates; this table carries the channel on every row.
 *
 * Both the live-control surface (CC/NRPN emit, `codec/live.ts`) and the
 * unified `blocks` schema (validation + display↔wire) are derived from
 * this single table so they can't drift (handoff §14.1).
 *
 * SCOPE NOTE: synth params address SYNTH 1 (ch1); Synth 2 is reached by
 * instance:2 (ch2) for every ch1 param. Registered surfaces: voice/osc/mixer/
 * filter/env/lfo/fx/eq, drums, project FX (reverb/delay incl. per-track sends,
 * master filter, bypass), mixer, mod matrix, macros (positions + A-D routing),
 * and sidechain. Still unregistered: the LFO toggle bus (NRPN 0:122/0:123 —
 * needs a shared-NRPN enum-bus addr kind, a small codec touch) and the
 * audio-input table (channel unconfirmed in v3, blocked on a hardware check).
 */

import type { ParamSchema } from '@mcp-midi-control/core/protocol-generic/types.js';
import { decodeSigned, encodeSigned, type SignedWindow } from './codec/signed.js';
import {
  CHORUS_TYPE, DELAY_LR_RATIO, DRIVE_TYPE, FILTER_ROUTING, FILTER_TYPE,
  FX_BYPASS, LFO_WAVEFORM, MOD_DEST, MOD_SOURCE, OSC_WAVEFORM, POLY_MODE, REVERB_TYPE,
  SIDECHAIN_SOURCE,
} from './enums.js';

export const CH_SYNTH1 = 1;
export const CH_SYNTH2 = 2;
// MIDI tracks 1/2 sequence EXTERNAL gear (no internal params); they exist here
// only so the pattern orchestrator can route a melodic voice onto the right
// note track. Default Tx channels per the handoff §3 (user-reassignable).
export const CH_MIDI1 = 3;
export const CH_MIDI2 = 4;
export const CH_DRUMS = 10;
export const CH_PROJECT = 16;

// Reused signed windows (handoff §4).
const BIPOLAR: SignedWindow = { center: 64, lo: 0, hi: 127 };   // -64..+63
const OCTAVE: SignedWindow = { center: 64, lo: 58, hi: 69 };    // -6..+5
const PITCH12: SignedWindow = { center: 64, lo: 52, hi: 76 };   // -12..+12
const FXLEVEL: SignedWindow = { center: 64, lo: 52, hi: 82 };   // -12..+18 dB

export type ParamAddr =
  | { kind: 'cc'; cc: number }
  | { kind: 'nrpn'; msb: number; lsb: number };

export interface CircuitParam {
  block: string;
  name: string;
  channel: number;
  addr: ParamAddr;
  display_name: string;
  unit: string;
  /** Wire default value. */
  default: number;
  /** Linear params: inclusive wire range. Omitted for signed/enum. */
  min?: number;
  max?: number;
  signed?: SignedWindow;
  enum?: Readonly<Record<number, string>>;
  notes?: string;
}

// ── Constructors (channel-scoped) ────────────────────────────────────

type Extra = Partial<Pick<CircuitParam, 'min' | 'max' | 'signed' | 'enum' | 'notes'>>;

function p(
  channel: number, block: string, name: string, addr: ParamAddr,
  display_name: string, unit: string, def: number, extra: Extra = {},
): CircuitParam {
  return { channel, block, name, addr, display_name, unit, default: def, ...extra };
}
const synCc = (b: string, n: string, cc: number, dn: string, u: string, d: number, e: Extra = {}) =>
  p(CH_SYNTH1, b, n, { kind: 'cc', cc }, dn, u, d, e);
const synNrpn = (b: string, n: string, msb: number, lsb: number, dn: string, u: string, d: number, e: Extra = {}) =>
  p(CH_SYNTH1, b, n, { kind: 'nrpn', msb, lsb }, dn, u, d, e);
const drumCc = (b: string, n: string, cc: number, dn: string, u: string, d: number, e: Extra = {}) =>
  p(CH_DRUMS, b, n, { kind: 'cc', cc }, dn, u, d, e);
const projCc = (b: string, n: string, cc: number, dn: string, u: string, d: number, e: Extra = {}) =>
  p(CH_PROJECT, b, n, { kind: 'cc', cc }, dn, u, d, e);
const projNrpn = (b: string, n: string, msb: number, lsb: number, dn: string, u: string, d: number, e: Extra = {}) =>
  p(CH_PROJECT, b, n, { kind: 'nrpn', msb, lsb }, dn, u, d, e);

// ── Registry ─────────────────────────────────────────────────────────

export const CIRCUIT_PARAMS: readonly CircuitParam[] = [
  // Voice
  synCc('voice', 'poly_mode', 3, 'Polyphony Mode', 'enum', 2, { enum: POLY_MODE }),
  synCc('voice', 'portamento', 5, 'Portamento Rate', 'count', 0, { min: 0, max: 127 }),
  synCc('voice', 'pre_glide', 9, 'Pre-Glide', 'semitones', 64, { signed: PITCH12 }),
  synCc('voice', 'octave', 13, 'Keyboard Octave', 'octaves', 64, { signed: OCTAVE }),

  // Oscillator 1
  synCc('osc1', 'wave', 19, 'Osc 1 Wave', 'enum', 2, { enum: OSC_WAVEFORM }),
  synCc('osc1', 'wave_interpolate', 20, 'Osc 1 Wave Interpolate', 'count', 0, { min: 0, max: 127 }),
  synCc('osc1', 'pw_index', 21, 'Osc 1 Pulse Width Index', 'bipolar', 64, { signed: BIPOLAR }),
  synCc('osc1', 'vsync_depth', 22, 'Osc 1 Virtual Sync Depth', 'count', 0, { min: 0, max: 127 }),
  synCc('osc1', 'density', 24, 'Osc 1 Density', 'count', 0, { min: 0, max: 127 }),
  synCc('osc1', 'density_detune', 25, 'Osc 1 Density Detune', 'count', 0, { min: 0, max: 127 }),
  synCc('osc1', 'semitones', 26, 'Osc 1 Semitones', 'semitones', 64, { signed: BIPOLAR }),
  synCc('osc1', 'cents', 27, 'Osc 1 Cents', 'cents', 64, { signed: BIPOLAR }),
  synCc('osc1', 'pitchbend', 28, 'Osc 1 Pitchbend', 'semitones', 76, { signed: PITCH12 }),

  // Oscillator 2
  synCc('osc2', 'wave', 29, 'Osc 2 Wave', 'enum', 2, { enum: OSC_WAVEFORM }),
  synCc('osc2', 'wave_interpolate', 30, 'Osc 2 Wave Interpolate', 'count', 0, { min: 0, max: 127 }),
  synCc('osc2', 'pw_index', 31, 'Osc 2 Pulse Width Index', 'bipolar', 64, { signed: BIPOLAR }),
  synCc('osc2', 'vsync_depth', 33, 'Osc 2 Virtual Sync Depth', 'count', 0, { min: 0, max: 127 }),
  synCc('osc2', 'density', 35, 'Osc 2 Density', 'count', 0, { min: 0, max: 127 }),
  synCc('osc2', 'density_detune', 36, 'Osc 2 Density Detune', 'count', 0, { min: 0, max: 127 }),
  synCc('osc2', 'semitones', 37, 'Osc 2 Semitones', 'semitones', 64, { signed: BIPOLAR }),
  synCc('osc2', 'cents', 39, 'Osc 2 Cents', 'cents', 64, { signed: BIPOLAR }),
  synCc('osc2', 'pitchbend', 40, 'Osc 2 Pitchbend', 'semitones', 76, { signed: PITCH12 }),

  // Mixer
  synCc('mixer', 'osc1_level', 51, 'Osc 1 Level', 'count', 127, { min: 0, max: 127 }),
  synCc('mixer', 'osc2_level', 52, 'Osc 2 Level', 'count', 0, { min: 0, max: 127 }),
  synCc('mixer', 'ringmod_level', 54, 'Ring Mod Level', 'count', 0, { min: 0, max: 127 }),
  synCc('mixer', 'noise_level', 56, 'Noise Level', 'count', 0, { min: 0, max: 127 }),
  synCc('mixer', 'pre_fx_level', 58, 'Pre FX Level', 'db', 64, { signed: FXLEVEL }),
  synCc('mixer', 'post_fx_level', 59, 'Post FX Level', 'db', 64, { signed: FXLEVEL }),

  // Filter
  synCc('filter', 'routing', 60, 'Filter Routing', 'enum', 0, { enum: FILTER_ROUTING }),
  synCc('filter', 'drive', 63, 'Filter Drive', 'count', 0, { min: 0, max: 127 }),
  synCc('filter', 'drive_type', 65, 'Filter Drive Type', 'enum', 0, { enum: DRIVE_TYPE }),
  synCc('filter', 'type', 68, 'Filter Type', 'enum', 1, { enum: FILTER_TYPE }),
  synCc('filter', 'frequency', 74, 'Filter Frequency', 'count', 127, { min: 0, max: 127 }),
  synCc('filter', 'tracking', 69, 'Filter Tracking', 'count', 127, { min: 0, max: 127 }),
  synCc('filter', 'resonance', 71, 'Filter Resonance', 'count', 0, { min: 0, max: 127 }),
  synCc('filter', 'q_normalize', 78, 'Filter Q Normalize', 'count', 64, { min: 0, max: 127 }),
  synCc('filter', 'env2_to_frequency', 79, 'Env 2 to Frequency', 'bipolar', 64, { signed: BIPOLAR }),

  // Envelope 1 (amp)
  synCc('env1', 'velocity', 108, 'Env 1 Velocity', 'bipolar', 64, { signed: BIPOLAR }),
  synCc('env1', 'attack', 73, 'Env 1 Attack', 'count', 2, { min: 0, max: 127 }),
  synCc('env1', 'decay', 75, 'Env 1 Decay', 'count', 90, { min: 0, max: 127 }),
  synCc('env1', 'sustain', 70, 'Env 1 Sustain', 'count', 127, { min: 0, max: 127 }),
  synCc('env1', 'release', 72, 'Env 1 Release', 'count', 40, { min: 0, max: 127 }),

  // Envelope 2 (filter)
  synNrpn('env2', 'velocity', 0, 0, 'Env 2 Velocity', 'bipolar', 64, { signed: BIPOLAR }),
  synNrpn('env2', 'attack', 0, 1, 'Env 2 Attack', 'count', 2, { min: 0, max: 127 }),
  synNrpn('env2', 'decay', 0, 2, 'Env 2 Decay', 'count', 75, { min: 0, max: 127 }),
  synNrpn('env2', 'sustain', 0, 3, 'Env 2 Sustain', 'count', 35, { min: 0, max: 127 }),
  synNrpn('env2', 'release', 0, 4, 'Env 2 Release', 'count', 45, { min: 0, max: 127 }),

  // Envelope 3 (mod)
  synNrpn('env3', 'delay', 0, 14, 'Env 3 Delay', 'count', 0, { min: 0, max: 127 }),
  synNrpn('env3', 'attack', 0, 15, 'Env 3 Attack', 'count', 10, { min: 0, max: 127 }),
  synNrpn('env3', 'decay', 0, 16, 'Env 3 Decay', 'count', 70, { min: 0, max: 127 }),
  synNrpn('env3', 'sustain', 0, 17, 'Env 3 Sustain', 'count', 64, { min: 0, max: 127 }),
  synNrpn('env3', 'release', 0, 18, 'Env 3 Release', 'count', 40, { min: 0, max: 127 }),

  // LFO 1
  synNrpn('lfo1', 'waveform', 0, 70, 'LFO 1 Waveform', 'enum', 0, { enum: LFO_WAVEFORM }),
  synNrpn('lfo1', 'phase', 0, 71, 'LFO 1 Phase Offset', 'degrees', 0, { min: 0, max: 119 }),
  synNrpn('lfo1', 'slew', 0, 72, 'LFO 1 Slew Rate', 'count', 0, { min: 0, max: 127 }),
  synNrpn('lfo1', 'delay', 0, 74, 'LFO 1 Delay', 'count', 0, { min: 0, max: 127 }),
  synNrpn('lfo1', 'delay_sync', 0, 75, 'LFO 1 Delay Sync', 'count', 0, { min: 0, max: 35 }),
  synNrpn('lfo1', 'rate', 0, 76, 'LFO 1 Rate', 'count', 68, { min: 0, max: 127 }),
  synNrpn('lfo1', 'rate_sync', 0, 77, 'LFO 1 Rate Sync', 'count', 0, { min: 0, max: 35 }),

  // LFO 2
  synNrpn('lfo2', 'waveform', 0, 79, 'LFO 2 Waveform', 'enum', 0, { enum: LFO_WAVEFORM }),
  synNrpn('lfo2', 'phase', 0, 80, 'LFO 2 Phase Offset', 'degrees', 0, { min: 0, max: 119 }),
  synNrpn('lfo2', 'slew', 0, 81, 'LFO 2 Slew Rate', 'count', 0, { min: 0, max: 127 }),
  synNrpn('lfo2', 'delay', 0, 83, 'LFO 2 Delay', 'count', 0, { min: 0, max: 127 }),
  synNrpn('lfo2', 'delay_sync', 0, 84, 'LFO 2 Delay Sync', 'count', 0, { min: 0, max: 35 }),
  synNrpn('lfo2', 'rate', 0, 85, 'LFO 2 Rate', 'count', 68, { min: 0, max: 127 }),
  synNrpn('lfo2', 'rate_sync', 0, 86, 'LFO 2 Rate Sync', 'count', 0, { min: 0, max: 35 }),

  // FX + EQ
  synCc('fx', 'distortion_level', 91, 'Distortion Level', 'count', 0, { min: 0, max: 127 }),
  synCc('fx', 'chorus_level', 93, 'Chorus Level', 'count', 0, { min: 0, max: 127 }),
  synNrpn('fx', 'distortion_type', 1, 0, 'Distortion Type', 'enum', 0, { enum: DRIVE_TYPE }),
  synNrpn('fx', 'distortion_compensation', 1, 1, 'Distortion Compensation', 'count', 100, { min: 0, max: 127 }),
  synNrpn('fx', 'chorus_type', 1, 24, 'Chorus Type', 'enum', 1, { enum: CHORUS_TYPE }),
  synNrpn('fx', 'chorus_rate', 1, 25, 'Chorus Rate', 'count', 84, { min: 0, max: 127 }),
  synNrpn('fx', 'chorus_rate_sync', 1, 26, 'Chorus Rate Sync', 'count', 0, { min: 0, max: 35 }),
  synNrpn('fx', 'chorus_feedback', 1, 27, 'Chorus Feedback', 'bipolar', 74, { signed: BIPOLAR }),
  synNrpn('fx', 'chorus_mod_depth', 1, 28, 'Chorus Mod Depth', 'count', 64, { min: 0, max: 127 }),
  synNrpn('fx', 'chorus_delay', 1, 29, 'Chorus Delay', 'count', 64, { min: 0, max: 127 }),
  synNrpn('eq', 'bass_frequency', 0, 104, 'EQ Bass Frequency', 'count', 64, { min: 0, max: 127 }),
  synNrpn('eq', 'bass_level', 0, 105, 'EQ Bass Level', 'bipolar', 64, { signed: BIPOLAR }),
  synNrpn('eq', 'mid_frequency', 0, 106, 'EQ Mid Frequency', 'count', 64, { min: 0, max: 127 }),
  synNrpn('eq', 'mid_level', 0, 107, 'EQ Mid Level', 'bipolar', 64, { signed: BIPOLAR }),
  synNrpn('eq', 'treble_frequency', 0, 108, 'EQ Treble Frequency', 'count', 125, { min: 0, max: 127 }),
  synNrpn('eq', 'treble_level', 0, 109, 'EQ Treble Level', 'bipolar', 64, { signed: BIPOLAR }),

  // Drums (ch10). patch select 0..63; pitch/EQ/pan bipolar; level/decay/distortion 0..127.
  ...drumBlock('drum1', { patch: 8, level: 12, pitch: 14, decay: 15, distortion: 16, eq: 17, pan: 77 }),
  ...drumBlock('drum2', { patch: 18, level: 23, pitch: 34, decay: 40, distortion: 42, eq: 43, pan: 78 }),
  ...drumBlock('drum3', { patch: 44, level: 45, pitch: 46, decay: 47, distortion: 48, eq: 49, pan: 79 }),
  ...drumBlock('drum4', { patch: 50, level: 53, pitch: 55, decay: 57, distortion: 61, eq: 76, pan: 80 }),

  // Project / global (ch16).
  // Reverb: character params (NRPN) + per-track SEND levels (CC, handoff §8).
  // The sends route each track's signal INTO the reverb; without them the
  // character params shape an effect nothing reaches. All on ch16.
  projNrpn('reverb', 'type', 1, 18, 'Reverb Type', 'enum', 2, { enum: REVERB_TYPE }),
  projNrpn('reverb', 'decay', 1, 19, 'Reverb Decay', 'count', 64, { min: 0, max: 127 }),
  projNrpn('reverb', 'damping', 1, 20, 'Reverb Damping', 'count', 64, { min: 0, max: 127 }),
  ...fxSends('reverb', 'Reverb', { synth1: 88, synth2: 89, drum1: 90, drum2: 106, drum3: 109, drum4: 110 }),
  // Delay: character params (NRPN) + per-track SEND levels (CC, handoff §8).
  projNrpn('delay', 'time', 1, 6, 'Delay Time', 'count', 64, { min: 0, max: 127 }),
  projNrpn('delay', 'time_sync', 1, 7, 'Delay Time Sync', 'count', 20, { min: 0, max: 35 }),
  projNrpn('delay', 'feedback', 1, 8, 'Delay Feedback', 'count', 64, { min: 0, max: 127 }),
  projNrpn('delay', 'width', 1, 9, 'Delay Width', 'count', 127, { min: 0, max: 127 }),
  projNrpn('delay', 'lr_ratio', 1, 10, 'Delay L-R Ratio', 'enum', 4, { enum: DELAY_LR_RATIO }),
  projNrpn('delay', 'slew', 1, 11, 'Delay Slew Rate', 'count', 5, { min: 0, max: 127 }),
  ...fxSends('delay', 'Delay', { synth1: 111, synth2: 112, drum1: 113, drum2: 114, drum3: 115, drum4: 116 }),
  projCc('master_filter', 'frequency', 74, 'Master Filter Frequency', 'bipolar', 64, { signed: BIPOLAR, notes: '0-63 LP, 64 OFF, 65-127 HP' }),
  projCc('master_filter', 'resonance', 71, 'Master Filter Resonance', 'count', 30, { min: 0, max: 127 }),
  projNrpn('fx', 'bypass', 1, 21, 'FX Bypass', 'enum', 0, { enum: FX_BYPASS }),

  // Sidechain (ch16): the synth amp ducked by a drum. Per-synth, but each engine
  // has its OWN NRPN address set (synth1 2:55.., synth2 2:65..) on the project
  // channel — so instance:2 does NOT reach synth2 here; they are distinct blocks.
  ...sidechainBlock('sidechain1', 'Synth 1', 55),
  // VERIFY: the v3 PDF prints synth2 depth as `1:69` (likely an OCR slip for
  // `2:69`, the address the rest of the synth2 block follows). Registered as 2:69.
  ...sidechainBlock('sidechain2', 'Synth 2', 65, 'PDF prints 1:69, registered as 2:69 (follows the rest of the synth2 block); VERIFY on hardware'),

  // Macro knob POSITIONS (Synth 1 default; instance 2 targets Synth 2 on ch2).
  ...macroPositions(),
  // Per-knob A-D destination routing (NRPN 3:x, ch1; instance 2 = Synth 2).
  // 8 knobs x 4 slots (A-D) x {destination,start,end,depth}. Rarely set live
  // (usually configured in Components) but fully addressable, so registered.
  ...macroRouting(),

  // Mod matrix: 12 slots, each Source1 / Source2 / Depth / Destination (handoff §5).
  // Per-synth (ch1 default; instance 2 = Synth 2). Source/Dest are enums (§6).
  ...modSlot(1, 1, 83, 84, 86, 87),
  ...modSlot(2, 1, 88, 89, 91, 92),
  ...modSlot(3, 1, 93, 94, 96, 97),
  ...modSlot(4, 1, 98, 99, 101, 102),
  ...modSlot(5, 1, 103, 104, 106, 107),
  ...modSlot(6, 1, 108, 109, 111, 112),
  ...modSlot(7, 1, 113, 114, 116, 117),
  ...modSlot(8, 1, 118, 119, 121, 122),
  ...modSlot(9, 1, 123, 124, 126, 127),
  ...modSlot(10, 2, 0, 1, 3, 4),
  ...modSlot(11, 2, 5, 6, 8, 9),
  ...modSlot(12, 2, 10, 11, 12, 13),

  // Project track mixer (ch16): synth levels + pans. Drum levels are the
  // per-drum 'level' CCs on ch10; reverb/delay sends are the *_send params in
  // the reverb/delay blocks above.
  projCc('track_mixer', 'synth1_level', 12, 'Synth 1 Level', 'count', 100, { min: 0, max: 127 }),
  projCc('track_mixer', 'synth2_level', 14, 'Synth 2 Level', 'count', 100, { min: 0, max: 127 }),
  projCc('track_mixer', 'synth1_pan', 117, 'Synth 1 Pan', 'bipolar', 64, { signed: BIPOLAR }),
  projCc('track_mixer', 'synth2_pan', 118, 'Synth 2 Pan', 'bipolar', 64, { signed: BIPOLAR }),
];

/**
 * Per-track effect SEND levels for a project FX block (reverb / delay).
 * Six sends per effect — Synth 1/2 and Drum 1-4 — each a 0..127 CC on the
 * project channel (ch16). The track is identified by the CC number, not the
 * channel (all sends share ch16); the handoff §8 CC map is the source. Default
 * 0 (dry): a freshly-routed send adds no effect until raised.
 */
function fxSends(
  block: string, label: string,
  cc: { synth1: number; synth2: number; drum1: number; drum2: number; drum3: number; drum4: number },
): CircuitParam[] {
  const send = (track: string, who: string, n: number) =>
    projCc(block, `${track}_send`, n, `${who} ${label} Send`, 'count', 0, { min: 0, max: 127 });
  return [
    send('synth1', 'Synth 1', cc.synth1),
    send('synth2', 'Synth 2', cc.synth2),
    send('drum1', 'Drum 1', cc.drum1),
    send('drum2', 'Drum 2', cc.drum2),
    send('drum3', 'Drum 3', cc.drum3),
    send('drum4', 'Drum 4', cc.drum4),
  ];
}

function macroPositions(): CircuitParam[] {
  return Array.from({ length: 8 }, (_unused, i) =>
    synCc('macros', `macro_${i + 1}`, 80 + i, `Macro ${i + 1} Position`, 'count', 0, { min: 0, max: 127 }));
}

/**
 * Per-macro A-D destination routing (handoff §5). NRPN MSB = 3; knob k (0-based)
 * occupies LSBs k*16..k*16+15, four consecutive LSBs per slot:
 * destination (0-70), start (0-127), end (0-127), depth (bipolar, center 64).
 * One block per knob (`macro1`..`macro8`) so a knob's 16 routing fields stay
 * together and the live POSITIONS keep their own `macros` block. Synth 1 default
 * (ch1); instance:2 reaches Synth 2 (ch2) like every other synth param.
 */
function macroRouting(): CircuitParam[] {
  const out: CircuitParam[] = [];
  const SLOTS = ['a', 'b', 'c', 'd'];
  for (let k = 0; k < 8; k++) {
    const block = `macro${k + 1}`;
    for (let s = 0; s < 4; s++) {
      const base = k * 16 + s * 4;
      const sl = SLOTS[s];
      const SL = sl.toUpperCase();
      out.push(
        synNrpn(block, `${sl}_destination`, 3, base, `Macro ${k + 1} Slot ${SL} Destination`, 'count', 0, { min: 0, max: 70 }),
        synNrpn(block, `${sl}_start`, 3, base + 1, `Macro ${k + 1} Slot ${SL} Start`, 'count', 0, { min: 0, max: 127 }),
        synNrpn(block, `${sl}_end`, 3, base + 2, `Macro ${k + 1} Slot ${SL} End`, 'count', 127, { min: 0, max: 127 }),
        synNrpn(block, `${sl}_depth`, 3, base + 3, `Macro ${k + 1} Slot ${SL} Depth`, 'bipolar', 64, { signed: BIPOLAR }),
      );
    }
  }
  return out;
}

/**
 * One synth's sidechain (handoff §8): source (which drum ducks the amp; 4=off),
 * attack, hold, decay, depth — five consecutive NRPN LSBs from `base` on the
 * project channel (ch16). `depthNote` flags the one address the PDF prints
 * ambiguously (synth2 depth).
 */
function sidechainBlock(block: string, who: string, base: number, depthNote?: string): CircuitParam[] {
  const depthExtra: Extra = depthNote ? { min: 0, max: 127, notes: depthNote } : { min: 0, max: 127 };
  return [
    projNrpn(block, 'source', 2, base, `${who} Sidechain Source`, 'enum', 4, { enum: SIDECHAIN_SOURCE }),
    projNrpn(block, 'attack', 2, base + 1, `${who} Sidechain Attack`, 'count', 0, { min: 0, max: 127 }),
    projNrpn(block, 'hold', 2, base + 2, `${who} Sidechain Hold`, 'count', 50, { min: 0, max: 127 }),
    projNrpn(block, 'decay', 2, base + 3, `${who} Sidechain Decay`, 'count', 70, { min: 0, max: 127 }),
    projNrpn(block, 'depth', 2, base + 4, `${who} Sidechain Depth`, 'count', 0, depthExtra),
  ];
}

function modSlot(n: number, msb: number, src1: number, src2: number, depth: number, dest: number): CircuitParam[] {
  const blk = `mod${n}`;
  return [
    synNrpn(blk, 'source1', msb, src1, `Mod ${n} Source 1`, 'enum', 0, { enum: MOD_SOURCE }),
    synNrpn(blk, 'source2', msb, src2, `Mod ${n} Source 2`, 'enum', 0, { enum: MOD_SOURCE }),
    synNrpn(blk, 'depth', msb, depth, `Mod ${n} Depth`, 'bipolar', 64, { signed: BIPOLAR }),
    synNrpn(blk, 'destination', msb, dest, `Mod ${n} Destination`, 'enum', 0, { enum: MOD_DEST }),
  ];
}

function drumBlock(
  block: string,
  cc: { patch: number; level: number; pitch: number; decay: number; distortion: number; eq: number; pan: number },
): CircuitParam[] {
  return [
    drumCc(block, 'patch', cc.patch, `${block} Patch Select`, 'count', 0, { min: 0, max: 63 }),
    drumCc(block, 'level', cc.level, `${block} Level`, 'count', 100, { min: 0, max: 127 }),
    drumCc(block, 'pitch', cc.pitch, `${block} Pitch`, 'bipolar', 64, { signed: BIPOLAR }),
    drumCc(block, 'decay', cc.decay, `${block} Decay`, 'count', 64, { min: 0, max: 127 }),
    drumCc(block, 'distortion', cc.distortion, `${block} Distortion`, 'count', 0, { min: 0, max: 127 }),
    drumCc(block, 'eq', cc.eq, `${block} EQ`, 'bipolar', 64, { signed: BIPOLAR }),
    drumCc(block, 'pan', cc.pan, `${block} Pan`, 'bipolar', 64, { signed: BIPOLAR }),
  ];
}

// ── Derived lookups ──────────────────────────────────────────────────

/** `${block}.${name}` → CircuitParam. The writer reads channel + addr here. */
export const PARAM_INDEX: ReadonlyMap<string, CircuitParam> = new Map(
  CIRCUIT_PARAMS.map((cp) => [`${cp.block}.${cp.name}`, cp]),
);

export function findParam(block: string, name: string): CircuitParam | undefined {
  return PARAM_INDEX.get(`${block}.${name}`);
}

/** Wire → display for a registered param (used by the writer to echo display_value). */
export function decodeParamWire(cp: CircuitParam, wire: number): number | string {
  if (cp.enum) return cp.enum[wire] ?? wire;
  if (cp.signed) return decodeSigned(wire, cp.signed);
  return wire;
}

/** Sorted "block.name" list for a block, for unknown-param error suggestions. */
export function listParamNames(block: string): string[] {
  return CIRCUIT_PARAMS.filter((cp) => cp.block === block).map((cp) => cp.name);
}

// ── ParamSchema construction (display ↔ wire) ────────────────────────

function makeSchema(cp: CircuitParam): ParamSchema {
  if (cp.enum) {
    const table = cp.enum;
    const byName = new Map<string, number>();
    for (const [k, v] of Object.entries(table)) byName.set(v.toLowerCase(), Number(k));
    return {
      display_name: cp.display_name,
      unit: 'enum',
      enum_values: table,
      encode: (display) => {
        if (typeof display === 'number') {
          if (table[display] !== undefined) return display;
          throw new RangeError(`${cp.block}.${cp.name}: unknown wire ordinal ${display}`);
        }
        const hit = byName.get(display.trim().toLowerCase());
        if (hit === undefined) {
          throw new RangeError(`${cp.block}.${cp.name}: unknown value '${display}'`);
        }
        return hit;
      },
      decode: (wire) => table[wire] ?? wire,
    };
  }
  if (cp.signed) {
    const w = cp.signed;
    return {
      display_name: cp.display_name,
      unit: cp.unit,
      display_min: w.lo - w.center,
      display_max: w.hi - w.center,
      encode: (display) => encodeSigned(toNum(cp, display), w),
      decode: (wire) => decodeSigned(wire, w),
    };
  }
  const min = cp.min ?? 0;
  const max = cp.max ?? 127;
  return {
    display_name: cp.display_name,
    unit: cp.unit,
    display_min: min,
    display_max: max,
    encode: (display) => {
      const n = Math.round(toNum(cp, display));
      if (n < min || n > max) {
        throw new RangeError(`${cp.block}.${cp.name} out of range [${min}..${max}]: ${display}`);
      }
      return n;
    },
    decode: (wire) => wire,
  };
}

function toNum(cp: CircuitParam, display: number | string): number {
  const n = typeof display === 'number' ? display : Number(display);
  if (!Number.isFinite(n)) {
    throw new RangeError(`${cp.block}.${cp.name}: expected a number, got '${display}'`);
  }
  return n;
}

const BLOCK_DISPLAY: Readonly<Record<string, string>> = {
  voice: 'Voice', osc1: 'Oscillator 1', osc2: 'Oscillator 2', mixer: 'Mixer',
  filter: 'Filter', env1: 'Envelope 1 (Amp)', env2: 'Envelope 2 (Filter)', env3: 'Envelope 3 (Mod)',
  lfo1: 'LFO 1', lfo2: 'LFO 2', fx: 'FX', eq: 'EQ',
  drum1: 'Drum 1', drum2: 'Drum 2', drum3: 'Drum 3', drum4: 'Drum 4',
  reverb: 'Reverb (Project)', delay: 'Delay (Project)', master_filter: 'Master Filter (Project)',
  macros: 'Macros', track_mixer: 'Track Mixer (Project)',
};

/** Display name for a block, including generated mod-matrix / macro / sidechain blocks. */
function displayForBlock(block: string): string {
  if (BLOCK_DISPLAY[block]) return BLOCK_DISPLAY[block];
  const mod = /^mod(\d+)$/.exec(block);
  if (mod) return `Mod Matrix Slot ${mod[1]}`;
  const macro = /^macro(\d+)$/.exec(block);
  if (macro) return `Macro ${macro[1]} Routing`;
  const sc = /^sidechain(\d+)$/.exec(block);
  if (sc) return `Sidechain (Synth ${sc[1]})`;
  return block;
}

/** Build the unified `blocks` schema from the registry. */
export function buildBlocks(): Record<string, { display_name: string; params: Record<string, ParamSchema> }> {
  const blocks: Record<string, { display_name: string; params: Record<string, ParamSchema> }> = {};
  for (const cp of CIRCUIT_PARAMS) {
    if (!blocks[cp.block]) {
      blocks[cp.block] = { display_name: displayForBlock(cp.block), params: {} };
    }
    blocks[cp.block].params[cp.name] = makeSchema(cp);
  }
  return blocks;
}
