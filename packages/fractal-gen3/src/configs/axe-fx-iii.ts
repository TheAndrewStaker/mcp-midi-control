/**
 * Axe-Fx III config for `createModernFractalDescriptor`.
 *
 * The III is the byte-verified anchor of the modern Fractal family: its
 * fn=0x01 SET path is confirmed against 10 public captures (Session 97),
 * and FM3/FM9 reuse the same codec with their own model byte. The III is
 * still `community-beta` because no maintainer owns the hardware to
 * confirm end-to-end — the GET-response shape and the II-ported
 * set_block / save / rename envelopes remain unconfirmed on real III
 * firmware.
 *
 * BEFORE EDITING, READ:
 *   - `docs/devices/axe-fx-iii/SYSEX-MAP.md`
 *   - `docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`
 */
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
import type { FractalModernConfig } from '../factory.js';
import { MODERN_AGENT_GUIDANCE } from './shared.js';

// ── Curated top-N first-page knob list per block ──────────────────
//
// Source: AxeEdit III page-1 controls per block, in the III's canonical
// spelling (`type` not `effect_type`, `master` not `master_volume`,
// `hicut`/`lowcut` one word, `harm1`/`harm2` for pitch voices).
const AXEFX3_BLOCK_PARAMS_SUMMARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  amp: ['type', 'gain', 'bass', 'mid', 'treble', 'master', 'presence', 'level'],
  reverb: ['type', 'mix', 'time', 'predelay', 'size', 'hicut', 'level'],
  delay: ['type', 'time', 'feed', 'mix', 'locut', 'hicut', 'level'],
  chorus: ['type', 'rate', 'depth', 'mix', 'level'],
  flanger: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  phaser: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  wah: ['type', 'fstart', 'fstop', 'q', 'control', 'level'],
  compressor: ['type', 'thresh', 'ratio', 'attack', 'release', 'level', 'mix'],
  pitch: ['type', 'pitchmode', 'harm1', 'harm2', 'key', 'scale', 'mix', 'level'],
  cab: ['level', 'pan'],
  pan_tremolo: ['type', 'rate', 'depth', 'duty', 'mix', 'level'],
  filter: ['type', 'freq', 'q', 'gain', 'level'],
  enhancer: ['type', 'width', 'depth', 'level'],
  gate_expander: ['type', 'thresh', 'attack', 'hold', 'release', 'ratio', 'level'],
  rotary: ['rate', 'lfdepth', 'hfdepth', 'drive', 'mix', 'level'],
  volume_pan: ['gain', 'panl', 'panr', 'level'],
  drive: ['type', 'drive', 'tone', 'level', 'mix'],
  formant: ['mix', 'level'],
  synth: ['mix', 'level'],
  ring_modulator: ['mix', 'level'],
  multitap_delay: ['basetype', 'time1', 'feedback1', 'level1', 'time2', 'feedback2', 'level2'],
});

// ── Agent guidance ─────────────────────────────────────────────────
//
// The III shares the family-wide MODERN_AGENT_GUIDANCE (one source of truth
// for the gen-3 family) plus an III-specific device_note. It previously kept a
// private copy that drifted stale — it claimed "no display calibration, raw
// wire 0..65534, midpoint 32767 NOT 5," which contradicts the device-true
// catalog (amp tone knobs are 0..10 display-calibrated) and the apply_preset
// coercion. Deduping onto the shared topics keeps the calibration/loudness/
// tempo guidance correct and consistent across III / FM3 / FM9 / VP4.
const AXEFX3_AGENT_GUIDANCE: Record<string, string> = {
  ...MODERN_AGENT_GUIDANCE,
  device_note: [
    'This is the Axe-Fx III (community beta): the gen-3 byte-identity anchor.',
    '6x14 grid, 8 scenes, A-D channels. get_param and continuous set_param are',
    'now III-hardware-confirmed (community owner test: amp gain on channel A',
    'acked with device echo, read-back matched the front panel). Discrete',
    'set-by-name, save_preset, set_block, and the live grid read stay community-',
    'beta on the III; confirm those writes on the device front panel.',
  ].join('\n'),
};

// ── Example spec ───────────────────────────────────────────────────

const AXEFX3_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      // The user-facing Drive / OD pedal (ID_FUZZ family): drive/tone/level.
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      params_by_channel: {
        A: { type: 3, drive: 5, tone: 5, level: 5 },
      },
    },
    {
      // The Amp block (ID_DISTORT family) carries the tone stack.
      slot: { row: 2, col: 2 },
      block_type: 'amp',
      params_by_channel: {
        A: { type: 3, bass: 5, mid: 5, treble: 5, master: 5 },
      },
    },
    { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2 },
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
    {
      slot: { row: 2, col: 5 },
      block_type: 'reverb',
      params_by_channel: {
        A: { type: 3, time: 5, mix: 25 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'A', amp_2: 'A', reverb: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'B', amp_2: 'A', reverb: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

export const AXE_FX_III_CONFIG: FractalModernConfig = {
  id: 'axe-fx-iii',
  display_name: 'Fractal Axe-Fx III',
  model_byte: 0x10,
  connection_label: 'axe-fx-iii',
  port_match: [
    // /axe-?fx ?iii/i — matches "Axe-Fx III", "AxeFx III", "axe fx iii", etc.
    { pattern: /axe-?fx ?iii/i },
    // /axe-?fx ?3/i — covers "Axe-Fx 3" / "AxeFx3" / "axefx 3" / "axe fx 3".
    { pattern: /axe-?fx ?3/i },
  ],
  grid: { rows: 6, cols: 14 },
  scene_count: 8,
  channel_names: ['A', 'B', 'C', 'D'],
  preset_count: 1024,
  preset_location_format: /^(?:\d{1,4})$/,
  support_tier: 'community-beta',
  verification:
    'fn=0x01 SET byte-verified against 10 public captures, and now III-hardware-confirmed ' +
    'end-to-end (community owner test 2026-06-17: continuous set_param amp gain on channel A ' +
    'acked with device echo, get_param read-back matched the front panel display). This is the ' +
    'first on-device confirmation of the III, the gen-3 byte-identity anchor. Still beta on real ' +
    'III hardware: discrete set-by-name, save_preset, set_block, and the live grid read (sub=0x2E).',
  // The III's own catalog — the byte-identity anchor for the family.
  params_by_family: PARAMS_BY_FAMILY,
  canonical_terms: {
    block: 'block',
    slot: 'grid location (row 1..6, col 1..14)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel A/B/C/D',
    location: 'preset slot 0..1023 (integer)',
  },
  agent_guidance: AXEFX3_AGENT_GUIDANCE,
  example_spec: AXEFX3_EXAMPLE_SPEC,
  block_params_summary: AXEFX3_BLOCK_PARAMS_SUMMARY,
};
