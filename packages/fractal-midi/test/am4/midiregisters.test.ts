/**
 * AM4 raw-integer MIDI-config register regression vectors.
 *
 * The MIDI map (global CC assignments, MIDI channel) and the per-scene
 * MIDI transmit slots store a literal integer in the read u32 — unlike
 * the normalized Q16 continuous knobs. Before midiRegisters.ts the reader
 * ran them through the Q16 path, so a scene-select CC of 34 read back as
 * 34/65534 ≈ 0 (BUG-6). These goldens guard the classification, the
 * read decode, the 128 "None" sentinel, and the write encode (GAP-2).
 *
 * Anchored by the 2026-07-03/04 AM4 hardware session: global.scene_cc
 * read back raw u32 = 34 while the front panel showed CC#34, and the
 * unassigned register read raw 128 while the panel showed NONE.
 */
import {
  KNOWN_PARAMS,
  isRawIntRegister,
  rawIntRegisterHasNone,
  decodeRawIntRegister,
  encodeRawIntRegister,
  RAW_INT_NONE_SENTINEL,
} from '../../src/am4/index.js';

type Key = keyof typeof KNOWN_PARAMS;

function expectThrows(fn: () => unknown, label: string, failed: string[]): void {
  try {
    fn();
    failed.push(`${label}: expected throw, but it returned`);
  } catch {
    /* expected */
  }
}

export function runAm4MidiRegisterTests(): void {
  const failed: string[] = [];

  // ── Classification: raw-int vs normalized/enum ──────────────────────
  const isRawExpectations: Array<[Key, boolean]> = [
    ['global.scene_cc', true],
    ['global.out1_vol_cc', true],
    ['global.midi_chan', true],
    ['global.bypass_fx1_cc', true],
    ['global.default_scene', true],
    ['preset.scene_1_midi_1_channel', true],
    ['preset.scene_2_midi_1_value', true],
    // enum register — handled on the reader's enum branch, not raw-int
    ['preset.scene_1_midi_1_type', false],
    ['global.midi_prog_change', false],
    // normalized continuous 'count' knob (log curve) — must NOT be raw-int
    ['geq.master_q', false],
    // negative-range global 'count' (tuner cent offset -25..25) — Q16
    // calibration knob, NOT a raw-int MIDI register (review fix)
    ['global.offset1', false],
  ];
  for (const [key, want] of isRawExpectations) {
    const got = isRawIntRegister(KNOWN_PARAMS[key]);
    if (got !== want) failed.push(`isRawIntRegister(${key}): expected ${want}, got ${got}`);
  }

  // ── None-sentinel membership ────────────────────────────────────────
  const hasNoneExpectations: Array<[Key, boolean]> = [
    ['global.scene_cc', true],          // 0..127 CC assignment
    ['global.bypass_fx1_cc', true],
    ['global.midi_chan', false],        // 1..16, no None
    ['global.default_scene', false],    // 1..4, no None
    ['preset.scene_1_midi_1_value', false], // real 0..127 value, no None
    ['preset.scene_1_midi_1_channel', false],
    // 0..127 global VALUE register (external-controller start value), not a
    // CC assignment → no None sentinel (review fix: name must end `_cc`)
    ['global.ext_startval_begin', false],
  ];
  for (const [key, want] of hasNoneExpectations) {
    const got = rawIntRegisterHasNone(KNOWN_PARAMS[key]);
    if (got !== want) failed.push(`rawIntRegisterHasNone(${key}): expected ${want}, got ${got}`);
  }

  // ── Read decode (raw u32 → display), incl. None sentinel ────────────
  const decodeCases: Array<[Key, number, number | string]> = [
    ['global.scene_cc', 34, 34],                         // HW: CC#34
    ['global.scene_cc', RAW_INT_NONE_SENTINEL, 'None'],  // HW: unassigned
    ['global.scene_cc', 0, 0],                           // CC#0 is distinct from None
    ['global.midi_chan', 10, 10],
    ['global.midi_chan', RAW_INT_NONE_SENTINEL, 128],    // no None mapping → raw int
    ['preset.scene_1_midi_1_channel', 16, 16],           // HW: channel 16
    ['preset.scene_2_midi_1_value', 127, 127],           // HW: value 127
  ];
  for (const [key, u32, want] of decodeCases) {
    const got = decodeRawIntRegister(KNOWN_PARAMS[key], u32);
    if (got !== want) failed.push(`decodeRawIntRegister(${key}, ${u32}): expected ${want}, got ${got}`);
  }

  // ── Write encode (display → integer), incl. 'None' → 128 (GAP-2) ────
  const encodeCases: Array<[Key, number | string, number]> = [
    ['global.scene_cc', 34, 34],
    ['global.scene_cc', 'None', RAW_INT_NONE_SENTINEL],
    ['global.scene_cc', 'none', RAW_INT_NONE_SENTINEL],  // case-insensitive
    ['global.scene_cc', 34.4, 34],                       // rounds to integer
    ['preset.scene_1_midi_1_channel', 16, 16],
  ];
  for (const [key, value, want] of encodeCases) {
    const got = encodeRawIntRegister(KNOWN_PARAMS[key], value);
    if (got !== want) failed.push(`encodeRawIntRegister(${key}, ${JSON.stringify(value)}): expected ${want}, got ${got}`);
  }

  // ── Write encode rejections ─────────────────────────────────────────
  expectThrows(() => encodeRawIntRegister(KNOWN_PARAMS['global.scene_cc'], 200), 'scene_cc 200 out of range', failed);
  expectThrows(() => encodeRawIntRegister(KNOWN_PARAMS['global.midi_chan'], 'None'), "midi_chan 'None' (no sentinel)", failed);
  expectThrows(() => encodeRawIntRegister(KNOWN_PARAMS['global.midi_chan'], 0), 'midi_chan 0 below min', failed);
  expectThrows(() => encodeRawIntRegister(KNOWN_PARAMS['global.ext_startval_begin'], 'None'), "ext_startval_begin 'None' (value register, no sentinel)", failed);

  if (failed.length > 0) {
    throw new Error(`${failed.length} AM4 MIDI-register case(s) failed:\n` + failed.join('\n'));
  }
}

export const AM4_MIDI_REGISTER_CASE_COUNT =
  11 /* classification */ + 7 /* hasNone */ + 7 /* decode */ + 5 /* encode */ + 4 /* rejections */;
