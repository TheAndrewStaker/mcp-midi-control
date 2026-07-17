/**
 * FM9 config for `createModernFractalDescriptor`.
 *
 * The FM9 (model byte 0x12) is a gen-3 sibling of the Axe-Fx III: same
 * SysEx envelope, same 6×14 grid, 8 scenes, A–D channels. It now ships a
 * DEVICE-TRUE param catalog (`fractal-midi/gen3/fm9`) mined from FM9-Edit's own
 * binary — block roster + effect IDs are the III's (shared across the
 * family), but paramIds are FM9's own (reusing the III's mis-addresses
 * 18.6% of shared params; see `docs/_private/MINING-FINDINGS-FM-VP4.md`).
 * Model byte 0x12 is HARDWARE-CONFIRMED on a real FM9 (firmware 11.0,
 * community fm9-catalog foundation probe, 2026-06-06): a QUERY PATCH NAME
 * built with 0x12 echoes model 0x12 with a valid checksum, scene GET/SET
 * (fn 0x0C) round-trips with the front panel following, and STATUS_DUMP
 * (fn 0x13) framing matches the III family. The FM9 returns NO Universal
 * Identity Reply, so a Fractal-native query is the ID path. community-beta
 * (the explicit-effectId SET path is still owner-round-trip pending).
 */
import { FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES } from 'fractal-midi/gen3/fm9';
import type { FractalModernConfig } from '../factory.js';
import {
  MODERN_AGENT_GUIDANCE,
  MODERN_BLOCK_PARAMS_SUMMARY,
  WIDE_GRID_EXAMPLE_SPEC,
} from './shared.js';

export const FM9_CONFIG: FractalModernConfig = {
  id: 'fm9',
  display_name: 'Fractal FM9',
  model_byte: 0x12,
  connection_label: 'fm9',
  port_match: [
    { pattern: /fm ?9/i }, // "FM9", "FM 9", "FM-9" (transport strips the dash via needles)
  ],
  grid: { rows: 6, cols: 14 },
  scene_count: 8,
  channel_names: ['A', 'B', 'C', 'D'],
  // FM9 addresses 512 preset slots (beta assumption; over-permissive
  // validation just defers to the device, which ignores an out-of-range PC).
  preset_count: 512,
  preset_location_format: /^(?:\d{1,4})$/,
  // The FM9 reads MIDI Bank Select from CC0/MSB and ignores CC32 (hardware-
  // confirmed on a real FM9, 2026-06-06). Without this, switch_preset to any
  // preset above 127 lands in bank 0. The FM3 was field-confirmed to ignore
  // CC32 as well (fw 12.00, 2026-06-12 — see fm3.ts); only the III keeps the
  // spec-standard CC0<<7|CC32 default, sourced from the v1.4 spec (the same
  // spec sentence the FM3 falsified) and itself hardware-unverified for
  // presets above 127.
  bank_select: 'msb',
  support_tier: 'community-beta',
  verification:
    'Model byte 0x12 hardware-confirmed on a real FM9 (fw 11.0, community foundation probe ' +
    '2026-06-06: QUERY PATCH NAME echoes 0x12, scene fn 0x0C round-trips, STATUS_DUMP fn 0x13 ' +
    'framing matches the III family, no Universal Identity Reply). ' +
    'Param catalog is FM9-true (mined from FM9-Edit\'s own parameter tables; paramIds are ' +
    'device-specific, not reused from the III). A real FM9 fn=0x01 capture exists (FM9-Edit ' +
    'driving a reverb-mix change on hardware), confirming the model byte + fn=0x01 envelope ' +
    'on a live FM9. UPDATE 2026-06-17 (community FM9 owner test, fw 11.0 / macOS, driving THIS ' +
    'server): get_param + continuous set_param round-trip acked on the device with values ' +
    'confirmed on the FM9-Editor display; channel-specific reads and alias resolution (gain→drive) ' +
    'confirmed too. The READ path and the CONTINUOUS SET path are now FM9-hardware-confirmed ' +
    'end-to-end through this codec\'s own frames. UPDATE 2026-06-19 (community FM9 owner, ' +
    'Windows, gen3-verify probe): set_block PLACEMENT is hardware-confirmed (a placed Drive ' +
    'appeared in the device fn=0x13 status dump) and switch_scene round-trips (set scene 1, ' +
    'read back 1); the first Windows gen-3 write confirmation. The current-type-name READ ' +
    '(fn=0x01 sub=0x1F → device name string) is wire-confirmed: get_param on an enum returns ' +
    'the device\'s own model name (reverb "Small Room", amp "59 Bassguy Bright", drive ' +
    '"Rat Distortion"). Still community-beta pending confirmation: discrete enum set-by-name ' +
    '(FM3-hardware-confirmed via the shared codec), save_preset persistence, and the live grid ' +
    'read (fn=0x01 sub=0x2E).',
  params_by_family: FM9_PARAMS_BY_FAMILY,
  device_true_roster: true,
  // Device-true FM9 model rosters, mined from the FM9-Edit effectDefinitions
  // cache (fw 11.0) by anchored walk and validated against hardware ordinals:
  // amp 331 (@65/179/264), drive/FUZZ 86 (@15/36), reverb 79 (@16/45). The
  // ordinal IS the discrete-SET value, so these are read labels AND settable by
  // name across the whole roster. FM9-specific (the family-shared overlay leaves
  // these numeric for the III/FM3). See enumOverrides.ts / rosters.generated.ts.
  enum_overrides: FM9_ENUM_OVERRIDES,
  canonical_terms: {
    block: 'block',
    slot: 'grid location (row 1..6, col 1..14)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel A/B/C/D',
    location: 'preset slot 0..511 (integer)',
  },
  agent_guidance: {
    ...MODERN_AGENT_GUIDANCE,
    device_note: [
      'This is the Fractal FM9 (community beta). It shares the Axe-Fx III',
      'gen-3 SysEx protocol and a 6×14 grid with 8 scenes and A–D channels.',
      'The param catalog is FM9-true (mined from FM9-Edit\'s own binary, so',
      'paramIds address the right knob); block effect IDs are the III\'s,',
      'which are shared across the gen-3 family. Amp, drive, and reverb types',
      'are settable AND readable BY NAME using the FM9\'s own model names',
      '(e.g. amp "Texas Star Clean", drive "Blues OD", reverb "Music Hall"):',
      'the full device-true rosters are wired, not just a few captured points.',
      'get_param, continuous set_param, and channel-specific reads are',
      'FM9-hardware-confirmed (community owner test, fw 11.0). set_block',
      'placement and switch_scene are now FM9/Windows hardware-confirmed too',
      '(2026-06-19 verify probe: a placed Drive showed up in the device fn=0x13',
      'status dump; scene set+read-back matched). Reading a block\'s CURRENT',
      'type/model NAME is wire-confirmed (get_param on an enum returns the',
      'device\'s own name, e.g. reverb "Small Room", via fn=0x01 sub=0x1F).',
      'Still decoded-but-unconfirmed on FM9: discrete set-by-name and',
      'save_preset persistence; confirm those on the device.',
    ].join('\n'),
    cab_polish: [
      'CAB POLISH DEFAULTS (mix-ready cuts + room). Close-mic\'d IRs carry more',
      'lows and highs than any real rig in a room; un-cut modeler presets read',
      'as "shrill / digital / fizzy". Fractal\'s founder publishes the same',
      'starting point (low cut ~80 Hz, high cut ~7500 Hz).',
      '',
      'THE SERVER ENFORCES THIS DEFAULT on the FM9 (BK-103c, mirroring the',
      'AM4): every apply_preset that places a CAB block and sets NO cab',
      'cut/room/slope param auto-applies, per written cab channel window',
      '(after that window\'s own params):',
      '  cab locut    80 Hz',
      '  cab hicut    6500 Hz',
      '  cab roommix  8 %',
      'These ride the FM9\'s display-calibrated ranges (device-true, from its',
      'own editor cache) over the community-beta continuous set_param path, so',
      'confirm by ear / front panel like any other gen-3 write. NO filter-slope',
      'write is made: the gen-3 slope selector (cab order) has no verified',
      'value table yet. The response reports the injection in `auto_applied`.',
      'ALWAYS RELAY IT with the one-phrase undo: "applied mix-ready cab cuts',
      '(80 Hz / 6.5 kHz) and 8% room - say \'wide open\' to remove." A build',
      'with NO cab block placed injects nothing, and set_param(s) edits never',
      'inject.',
      '',
      'OPTING OUT (any explicit cab cut/room/slope param in the spec',
      'suppresses the whole injection): pass cab locut: 20, hicut: 20000,',
      'roommix: 0 explicitly for wide-open intent. When the rig runs 4CM / a',
      'real guitar cab, bypass the cab block (bypassed: true on the cab slot',
      'also suppresses). To undo after the fact ("wide open"): set_params cab',
      'locut 20, hicut 20000, roommix 0.',
    ].join('\n'),
  },
  example_spec: WIDE_GRID_EXAMPLE_SPEC,
  block_params_summary: MODERN_BLOCK_PARAMS_SUMMARY,
};
