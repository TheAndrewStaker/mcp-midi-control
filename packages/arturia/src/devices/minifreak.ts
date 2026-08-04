/**
 * MiniFreak device config: **CC + Program Change only, NO SysEx.**
 *
 * Deliberately partial, and the gaps are the point. This project has no
 * MiniFreak, so nothing here is hardware-confirmed. What it does have:
 *
 *   - A CC table. Arturia publish a MiniFreak MIDI Implementation Chart; their
 *     page rejects automated fetches (HTTP 403), so this table is transcribed
 *     from a third-party mirror. That mirror was independently validated for the
 *     MicroFreak: its table matched Arturia's own Appendix D **exactly**, entry
 *     for entry, which is real (if indirect) evidence for its accuracy here.
 *     Still second-hand. Treat as community-beta, not documented-by-vendor.
 *   - No SysEx at all. The Arturia envelope is shared brand-wide but keyed by a
 *     **device code byte**, and the MiniFreak's is UNKNOWN. Guessing it would
 *     address some other Arturia product. So `sysex` is absent, which
 *     structurally disables the globals read/write and preset-name paths rather
 *     than shipping them broken.
 *
 * **Why this cannot inherit the MicroFreak's CC table**: the numbers collide
 * with different meanings. Cutoff is CC 23 on the MicroFreak and CC 74 here;
 * resonance CC 83 vs CC 71; CC 24 is Cycling-Env Amount there and VCF Env
 * Amount here; CC 26 is Filter Amount there and FX2 Time here. Sharing a table
 * would silently move the wrong parameter.
 *
 * To promote this to a full descriptor someone needs to capture the MiniFreak's
 * SysEx device code (one MIDI Control Center session with a sniffer) and
 * confirm a few CCs by ear.
 */
import type { FreakConfig, FreakCc } from './types.js';

/**
 * MiniFreak CC map. Note the shape differences from the MicroFreak that make
 * this a genuinely different instrument, not a variant: TWO oscillators, a
 * second LFO, an ENV Release stage, three onboard FX slots (the MicroFreak has
 * no effects at all), and assignable macros.
 *
 * The evidence label is applied to the whole table below rather than typed on
 * each row, so a CC added later CANNOT silently inherit the MicroFreak's
 * stronger `vendor-documented` default. Every entry here is second-hand and
 * every entry must say so.
 */
const MINIFREAK_CCS_RAW: readonly Omit<FreakCc, 'evidence'>[] = [
  { block: 'oscillator1', param: 'tune', cc: 70, label: 'Tune 1' },
  { block: 'oscillator1', param: 'wave', cc: 14, label: 'Wave 1' },
  { block: 'oscillator1', param: 'timbre', cc: 15, label: 'Timbre 1' },
  { block: 'oscillator1', param: 'shape', cc: 16, label: 'Shape 1' },
  { block: 'oscillator1', param: 'volume', cc: 17, label: 'Volume 1' },

  { block: 'oscillator2', param: 'tune', cc: 73, label: 'Tune 2' },
  { block: 'oscillator2', param: 'wave', cc: 18, label: 'Wave 2' },
  { block: 'oscillator2', param: 'timbre', cc: 19, label: 'Timbre 2' },
  { block: 'oscillator2', param: 'shape', cc: 20, label: 'Shape 2' },
  { block: 'oscillator2', param: 'volume', cc: 21, label: 'Volume 2' },

  { block: 'filter', param: 'cutoff', cc: 74, label: 'Filter Cutoff' },
  { block: 'filter', param: 'resonance', cc: 71, label: 'Resonance' },
  { block: 'filter', param: 'env_amount', cc: 24, label: 'VCF ENV Amount' },

  { block: 'envelope', param: 'attack', cc: 80, label: 'ENV Attack' },
  { block: 'envelope', param: 'decay', cc: 81, label: 'ENV Decay' },
  { block: 'envelope', param: 'sustain', cc: 82, label: 'ENV Sustain' },
  { block: 'envelope', param: 'release', cc: 83, label: 'ENV Release' },
  { block: 'envelope', param: 'velocity_mod', cc: 94, label: 'Velocity Envelope MOD' },

  { block: 'cycling_env', param: 'rise', cc: 76, label: 'CYC ENV Rise' },
  { block: 'cycling_env', param: 'fall', cc: 77, label: 'CYC ENV Fall' },
  { block: 'cycling_env', param: 'hold', cc: 78, label: 'CYC ENV Hold' },
  { block: 'cycling_env', param: 'rise_shape', cc: 68, label: 'CYC ENV Rise Shape' },
  { block: 'cycling_env', param: 'fall_shape', cc: 69, label: 'CYC ENV Fall Shape' },

  { block: 'lfo1', param: 'rate', cc: 85, label: 'LFO1 Rate' },
  { block: 'lfo2', param: 'rate', cc: 87, label: 'LFO2 Rate' },

  { block: 'fx1', param: 'time', cc: 22, label: 'FX1 Time' },
  { block: 'fx1', param: 'intensity', cc: 23, label: 'FX1 Intensity' },
  { block: 'fx1', param: 'amount', cc: 25, label: 'FX1 Amount' },
  { block: 'fx2', param: 'time', cc: 26, label: 'FX2 Time' },
  { block: 'fx2', param: 'intensity', cc: 27, label: 'FX2 Intensity' },
  { block: 'fx2', param: 'amount', cc: 28, label: 'FX2 Amount' },
  { block: 'fx3', param: 'time', cc: 29, label: 'FX3 Time' },
  { block: 'fx3', param: 'intensity', cc: 30, label: 'FX3 Intensity' },
  { block: 'fx3', param: 'amount', cc: 31, label: 'FX3 Amount' },

  { block: 'seq', param: 'gate', cc: 115, label: 'SEQ Gate' },
  { block: 'seq', param: 'spice', cc: 116, label: 'SEQ Spice' },

  { block: 'keyboard', param: 'glide', cc: 5, label: 'Glide' },
  { block: 'keyboard', param: 'macro1', cc: 117, label: 'Macro 1' },
  { block: 'keyboard', param: 'macro2', cc: 118, label: 'Macro 2' },
];

export const MINIFREAK_CCS: readonly FreakCc[] = MINIFREAK_CCS_RAW.map((cc) => ({
  ...cc,
  evidence: 'transcribed-unvalidated' as const,
}));

export const MINIFREAK_AGENT_GUIDANCE: Readonly<Record<string, string>> = {
  overview:
    'Arturia MiniFreak: a 6-voice synth with TWO digital engines, an analog filter, three onboard '
    + 'FX slots and assignable macros. A different instrument from the MicroFreak, not a variant.',
  evidence_warning:
    'NOTHING here is hardware-confirmed: this project has no MiniFreak. The CC table is '
    + 'transcribed from a third-party mirror of Arturia\'s implementation chart (their own page '
    + 'blocks automated fetches). That mirror was validated against Arturia\'s documentation for '
    + 'the MicroFreak and matched exactly, which is indirect support, not proof. Confirm by ear '
    + 'before relying on any specific CC.',
  no_sysex:
    'NO SysEx support. The Arturia envelope is brand-wide but keyed by a device-code byte, and the '
    + "MiniFreak's is unknown. Rather than guess a byte that would address some other Arturia "
    + 'product, the whole SysEx surface is disabled: no Utility-globals read/write, no preset-name '
    + 'reads, no preset dump. get_param therefore refuses for EVERY parameter on this device.',
  write_only:
    'Every parameter is WRITE-ONLY here. With SysEx unavailable there is no readback path at all, '
    + 'so never report a write as verified. Ask the user to listen.',
  presets:
    'switch_preset sends a plain Program Change. The MicroFreak was hardware-confirmed 0-based; '
    + 'the same is ASSUMED here and unverified. Only presets 1-128 are addressable, since Bank '
    + 'Select is not decoded for any Freak.',
};

export const MINIFREAK: FreakConfig = {
  id: 'minifreak',
  display_name: 'Arturia MiniFreak',
  port_match: [/mini\s*freak/i],
  ccs: MINIFREAK_CCS,
  // sysex deliberately ABSENT: device code unknown. See the header.
  pc_max_preset: 128,
  preset_count: 256,
  support_tier: 'generic-only',
  channel_env: 'MCP_MINIFREAK_CHANNEL',
  verification:
    'GENERIC-ONLY, and deliberately a weaker tier than the MicroFreak rather than sharing it. '
    + 'Nothing device-specific works here at all. No hardware access: nothing has been tested on a device. The CC table is second-hand (a third-party mirror of Arturia\'s implementation '
    + "chart; Arturia's own page returns 403 to automated fetches), though the same mirror matched "
    + "Arturia's documentation exactly for the MicroFreak. SysEx is entirely absent because the "
    + 'device-code byte is unknown, so Utility globals, preset-name reads and preset dumps are all '
    + 'unavailable and get_param refuses for every parameter. switch_preset assumes the 0-based '
    + 'Program Change confirmed on the MicroFreak; unverified here. To promote this: capture the '
    + 'device code from one MIDI Control Center session, and confirm a few CCs by ear.',
  agent_guidance: MINIFREAK_AGENT_GUIDANCE,
};
