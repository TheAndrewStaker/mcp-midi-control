/**
 * Axe-Fx III config for `createModernFractalDescriptor`.
 *
 * The III is the byte-verified anchor of the modern Fractal family: its
 * fn=0x01 SET path is confirmed against 10 public captures (Session 97),
 * and FM3/FM9 reuse the same codec with their own model byte. GET and
 * continuous SET are now III-HARDWARE-CONFIRMED (2026-06-17 owner test:
 * device echo + read-back matching the front panel; 2026-06-18
 * catalog-wide SET->GET roundtrip). set_block, save, and rename ride the
 * gen-3 EDITOR-DECODED envelopes (fn=0x01 sub=0x32 / sub=0x26 /
 * sub=0x28), not II ports; those writes, discrete set-by-name, and the
 * live grid read stay `community-beta` on real III firmware (decoded,
 * key-press pending).
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
  delay: ['model', 'type', 'time', 'feed', 'mix', 'locut', 'hicut', 'level'],
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
    'beta on the III; confirm those writes on the device front panel.',  ].join('\n'),
  cab_polish: [
    'CAB POLISH DEFAULTS (mix-ready cuts + room). Close-mic\'d IRs carry more',
    'lows and highs than any real rig in a room; un-cut modeler presets read',
    'as "shrill / digital / fizzy".',
    '',
    'THE SERVER ENFORCES THIS DEFAULT on the Axe-Fx III (BK-103c): every',
    'apply_preset that places a CAB block and sets NO cab cut/room/slope',
    'param auto-applies, per written cab channel window:',
    '  cab locut 80 Hz, cab hicut 6500 Hz, cab roommix 8 %.',
    'These ride the III\'s display-calibrated ranges (device-true, from its',
    'own editor cache) over the community-beta continuous set_param path, so',
    'confirm by ear / front panel like any other gen-3 write. NO filter-slope',
    'write is made (no verified value table). The response reports the',
    'injection in `auto_applied`; ALWAYS RELAY IT with the one-phrase undo:',
    '"applied mix-ready cab cuts (80 Hz / 6.5 kHz) and 8% room - say \'wide',
    'open\' to remove." A build with NO cab block injects nothing, and',
    'set_param(s) edits never inject.',
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
  // 1024 is the Mark II count; a Mark I holds 512. The model is not
  // distinguishable over the wire, so the ceiling stays permissive and
  // switch_preset's fn=0x0D read-back reports a location the unit refused.
  preset_count: 1024,
  preset_location_format: /^(?:\d{1,4})$/,
  // Preset switching: the III honours Bank MSB (CC0) and IGNORES Bank LSB
  // (CC32), so the spec's 'standard' encoding lands every preset >= 128 on
  // (location mod 128). Hardware-found on a Mk I, fw 32.06 (2026-10-28
  // community run: location 500 loaded 116; CC0=3 + PC 116 loads 500). The
  // fn=0x01 sub=0x27 SysEx switch was confirmed on the same unit (502 -> 499),
  // so it is the default path; 'msb' keeps any residual PC use correct.
  switch_preset_via: 'sysex',
  bank_select: 'msb',
  support_tier: 'community-beta',
  verification:
    'fn=0x01 SET byte-verified against 10 public captures, and now III-hardware-confirmed ' +
    'end-to-end (community owner test 2026-06-17: continuous set_param amp gain on channel A ' +
    'acked with device echo, get_param read-back matched the front panel display). A 2026-06-18 ' +
    'catalog-wide SET->GET roundtrip then confirmed the read + continuous-write paths across the ' +
    'whole III catalog on hardware, and became the device oracle for the 2026-06-20 reroute of ' +
    '~92 type/model/count selectors from continuous floats to discrete ordinals (wire builders ' +
    'unchanged; byte-identity intact). After a Mk I sweep (fw 32.06): switch_preset goes by SysEx ' +
    'and save_preset is checked by a name read-back; no CPU figure (sibling formula falsified). ' +
    'Still beta on real III hardware: discrete set-by-name, save_preset, set_block, and the live ' +
    'grid read (sub=0x2E).',
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
