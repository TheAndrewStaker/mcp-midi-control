/**
 * FM3 config for `createModernFractalDescriptor`.
 *
 * The FM3 (model byte 0x11) is a gen-3 sibling of the Axe-Fx III: same
 * SysEx envelope, 8 scenes, A–D channels, but a smaller **4×12 grid** and
 * a reduced block roster (it drops blocks the III has). Model byte 0x11
 * is byte-confirmed via tysonlt/AxeFxControl (AXEFX3=0x10, FM3=0x11). It
 * now ships a DEVICE-TRUE param catalog (`fractal-midi/gen3/fm3`) mined from
 * FM3-Edit's own binary: block effect IDs are the III's (shared), but
 * paramIds are FM3's own (reusing the III's mis-addresses 6.9% of shared
 * params; see `docs/_private/MINING-FINDINGS-FM-VP4.md`). community-beta.
 */
import { FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import type { FractalModernConfig, } from '../factory.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  MODERN_AGENT_GUIDANCE,
  MODERN_BLOCK_PARAMS_SUMMARY,
} from './shared.js';

// FM3's grid is 4×12 (wire-confirmed 4 rows; 12 cols per FM3-Edit). The
// example below keeps every slot within cols 1..4, which is valid.
const FM3_EXAMPLE_SPEC: PresetSpec = {
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
    { slot: { row: 2, col: 3 }, block_type: 'cab' },
    {
      slot: { row: 2, col: 4 },
      block_type: 'reverb',
      params_by_channel: {
        A: { type: 3, time: 5, mix: 25 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'A', reverb: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'B', reverb: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

export const FM3_CONFIG: FractalModernConfig = {
  id: 'fm3',
  display_name: 'Fractal FM3',
  model_byte: 0x11,
  connection_label: 'fm3',
  port_match: [
    { pattern: /fm ?3/i }, // "FM3", "FM 3", "FM-3"
  ],
  grid: { rows: 4, cols: 12 },
  scene_count: 8,
  channel_names: ['A', 'B', 'C', 'D'],
  // FM3 addresses 512 preset slots (beta assumption; over-permissive
  // validation just defers to the device for an out-of-range PC).
  preset_count: 512,
  preset_location_format: /^(?:\d{1,4})$/,
  // Preset switching: the fn=0x01 sub=0x27 SysEx switch is FM3-hardware-
  // confirmed (live 475→100, 2026-06-10; field-test restore, 2026-06-12). The
  // PC+Bank path is hardware-FALSIFIED on FM3 with 'standard' encoding: fw
  // 12.00 IGNORES CC32 (a PC switch to preset 438 landed on 54 = 438 mod 128,
  // field test 2026-06-12), i.e. the FM3 reads the bank from CC0 like the FM9.
  // 'msb' kept correct for any residual PC use (e.g. send_program_change docs).
  switch_preset_via: 'sysex',
  bank_select: 'msb',
  support_tier: 'community-beta',
  verification:
    'Model byte 0x11 byte-confirmed via tysonlt/AxeFxControl AND an FM3-Edit loopMIDI capture ' +
    '(the block-insert op fn=0x01 sub=0x32 decoded on model 0x11, byte-identical to III/FM9; ' +
    'grid wire-confirmed as 4 rows, 12 cols). Param catalog is FM3-true (mined from FM3-Edit\'s ' +
    'own parameter tables; paramIds are device-specific, not reused from the III); roster ' +
    'filtered to FM3\'s families. HARDWARE-CONFIRMED on FM3 fw 12.00 (macOS USB-CDC serial ' +
    'field test, 2026-06-12): serial discovery + framing, the documented queries (patch name / ' +
    'scene / tempo / status), the fn=0x1F whole-block read across 35 block types, the fn=0x01 ' +
    'sub=0x52 continuous SET (echo + read-back), set_bypass, switch_scene, and the sub=0x27 ' +
    'preset switch. Discrete set-by-name SET (float32(ordinal), sub 09 00) is FM3-hardware-' +
    'confirmed separately via a 2026-06-10 community session: frames byte-identical to this ' +
    'server\'s builder, sent from the tester\'s own rig, moved the FM3 front panel. Not yet ' +
    'confirmed: set_block placement, save_preset, and the Windows serial-driver path ' +
    '(untested, not falsified).',
  params_by_family: FM3_PARAMS_BY_FAMILY,
  device_true_roster: true,
  canonical_terms: {
    block: 'block',
    slot: 'grid location (row 1..4, col 1..12)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel A/B/C/D',
    location: 'preset slot 0..511 (integer)',
  },
  agent_guidance: {
    ...MODERN_AGENT_GUIDANCE,
    device_note: [
      'This is the Fractal FM3 (community beta). It shares the Axe-Fx III',
      'gen-3 SysEx protocol with 8 scenes and A–D channels, but uses a',
      'SMALLER 4×12 grid (48 cells, vs the III/FM9 6×14) and a reduced block roster.',
      'The param catalog is FM3-true (mined from FM3-Edit\'s own binary, so',
      'paramIds address the right knob); the roster is filtered to FM3\'s',
      'families. A 2026-06-12 hardware field test (fw 12.00, USB-CDC serial)',
      'confirmed the read path, continuous set_param, set_bypass, switch_scene,',
      'and the SysEx preset switch end-to-end through this server\'s own code;',
      'a 2026-06-10 community session confirmed set-by-name discrete set_param',
      'via frames byte-identical to this server\'s encoder. set_block and',
      'save_preset remain hardware-unverified; confirm those on the device.',
    ].join('\n'),
    cab_polish: [
      'CAB POLISH DEFAULTS (mix-ready cuts + room). Close-mic\'d IRs carry more',
      'lows and highs than any real rig in a room; the validated starting point',
      'is a low cut ~80 Hz / high cut ~6.5 kHz plus a little cab room, and the',
      'server auto-applies it on fresh cab-bearing builds on the AM4, Axe-Fx II,',
      'and FM9 (reported in `auto_applied`).',
      '',
      'NOT AUTO-APPLIED ON THE FM3 YET: the FM3\'s cab cut/room params',
      '(cab locut / hicut / roommix) are registered but carry NO calibrated',
      'display range in the FM3 catalog, so a Hz value like 80 cannot be',
      'expressed on the wire without guessing (set_param on them takes a raw',
      '0..65534 wire integer, NOT Hz). Do NOT write display-shaped values to',
      'them, and do not claim cuts were applied. Until FM3 range evidence lands,',
      'advise the user to set the cab low/high cut (80 Hz / 6.5-7.5 kHz,',
      '12 dB/oct) on the front panel or in FM3-Edit for direct/FRFR presets.',
    ].join('\n'),
  },
  example_spec: FM3_EXAMPLE_SPEC,
  block_params_summary: MODERN_BLOCK_PARAMS_SUMMARY,
};
