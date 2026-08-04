/**
 * ASM Hydrasynth Explorer DeviceDescriptor — top-level assembler for the
 * BK-051 unified tool surface (Wave 2, BK-031).
 *
 * Wraps the existing Hydrasynth protocol code (params.ts, nrpn.ts,
 * encoding.ts, enums.ts) into the `DeviceDescriptor` contract from
 * `src/protocol/generic/types.ts`. The wire layer is byte-frozen —
 * no code under `src/asm/hydrasynth-explorer/` outside this descriptor
 * directory is modified. Mirrors the per-role split landed for Axe-Fx II
 * in Session 67 and AM4 in Session 65-cont.
 *
 * Registration order in `src/server/index.ts`: Hydrasynth's port_match
 * regex (`/hydrasynth|asm.*hydra/i`) is narrow enough that order doesn't
 * matter — it can't collide with Fractal device ports.
 *
 * Capabilities posture (v1 scaffold):
 *   - slot_model: 'linear' (1024 patches in 8 banks × 128)
 *   - has_scenes: false (synthesizer — no Fractal-style scenes)
 *   - has_channels: false (no per-block X/Y or A/B/C/D — modules are
 *     always-on synthesis stages, not bypassable effects)
 *   - has_macros: true (8 macro CCs; surface via blocks.macros.*)
 *   - supports_save: false BY DESIGN. The Hydrasynth is a voice-classed
 *     synthesizer: its preset is a single NRPN patch dump, not a
 *     guitar-signal-chain of blocks/slots/scenes. So patch authoring +
 *     save live in the dedicated `apply_patch` / `init_patch` tools (the
 *     patch-dump + Write Request envelope is hardware-confirmed there), NOT
 *     in the guitar-shaped unified apply_preset/save_preset. This is a
 *     deliberate two-surface split (synth vs guitar), not a pending wire.
 *   - supports_lineage: false (Fractal lineage corpus doesn't apply)
 *
 * Unified surface coverage (v1):
 *   ✓ set_param / set_params / list_params / describe_device
 *   ✓ switch_preset (Bank Select MSB/LSB + Program Change)
 *   ✗ apply_preset (legacy apply_patch covers — deferred)
 *   ✗ get_param / get_params (no decoded read primitive)
 *   ✗ scan_locations (Hydrasynth patches are full SysEx dumps, no name-only query)
 *   ✗ switch_scene / set_bypass / set_block — no-op for synth
 */

import type { DeviceDescriptor, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { listConceptKeysForDevice } from '@mcp-midi-control/core/protocol-generic/concept-keys.js';

import { HYDRASYNTH_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';
import { buildBlocks, buildBlockTypes } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';

/**
 * Per-device concept-key map. Built from the central registry in
 * `concept-keys.ts`. Surfaced via `describe_device.concept_keys` so the
 * agent can read the canonical concept-key -> local-name map in one call.
 * Hydrasynth-specific entries cover oscillator pitch, filter cutoff /
 * resonance, envelope ADSR, and LFO rate; cross-device Fractal concepts
 * (amp / drive / reverb etc.) are absent since the synth has no analog.
 */
const HYDRASYNTH_CONCEPT_KEYS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const entry of listConceptKeysForDevice('hydrasynth')) {
    out[entry.conceptKey] = entry.localName;
  }
  return Object.freeze(out);
})();

/**
 * Hydrasynth deliberately omits example_spec on the descriptor:
 * apply_preset's cross-device schema does NOT include Hydra's
 * synth-voice blocks (osc1/filter1/env1/etc), so an example_spec here
 * would parse at preflight but FAIL at the MCP schema layer, misleading
 * agents into authoring calls the protocol rejects.
 *
 * The canonical fresh-patch path for Hydra is apply_patch (see
 * agent_guidance.fresh_build_vs_tweak). Surfaced via the per-device
 * hydra_* tool surface. Agents are routed there by the agent_guidance,
 * not by an apply_preset example.
 */

/**
 * Curated top-N first-page knob list per Hydrasynth module.
 *
 * Source: front-panel module page ordering on the Explorer + the per-
 * module sections in `docs/devices/hydrasynth/SECTIONS.md`. Each list
 * is the daily-use knob set a synth player adjusts (oscillator pitch
 * + waveform, filter cutoff/res, envelope ADSR, LFO rate/wave, effects
 * mix/feedback). Excludes modulation-matrix wiring, per-step LFO
 * sequences, wavescan waveX entries, and warpN morphing knobs (those
 * live in `list_params`).
 *
 * The agent maps "block" -> Hydrasynth's "module" automatically via
 * `block_aliases.module`, but the param spellings here match each
 * module's own field names verbatim (no aliasing).
 */
const HYDRASYNTH_BLOCK_PARAMS_SUMMARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  osc1: ['mode', 'type', 'semi', 'cent', 'keytrack', 'wavescan'],
  osc2: ['mode', 'type', 'semi', 'cent', 'keytrack', 'wavescan'],
  osc3: ['mode', 'type', 'semi', 'cent', 'keytrack'],
  mixer: ['osc1_vol', 'osc2_vol', 'osc3_vol', 'noise_vol', 'ring_mod_vol', 'filterrouting'],
  filter1: ['type', 'cutoff', 'res', 'drive', 'keytrack', 'env1amt'],
  filter2: ['type', 'cutoff', 'res', 'keytrack', 'env1amt'],
  amp: ['level', 'velenv', 'lfo2amt'],
  prefx: ['type', 'preset', 'mix', 'param1', 'param2'],
  delay: ['type', 'time', 'feedback', 'dry_wet', 'feedtone', 'wet_tone'],
  reverb: ['type', 'time', 'predelay', 'dry_wet', 'tone', 'hidamp', 'lodamp'],
  postfx: ['type', 'preset', 'mix', 'param1', 'param2'],
  lfo1: ['wave', 'rate', 'gain', 'phase', 'smooth'],
  lfo2: ['wave', 'rate', 'gain', 'phase', 'smooth'],
  lfo3: ['wave', 'rate', 'gain', 'phase', 'smooth'],
  lfo4: ['wave', 'rate', 'gain', 'phase', 'smooth'],
  lfo5: ['wave', 'rate', 'gain', 'phase', 'smooth'],
  env1: ['attack', 'decay', 'sustain', 'release', 'atkcurve', 'deccurve', 'relcurve'],
  env2: ['attack', 'decay', 'sustain', 'release', 'atkcurve', 'deccurve', 'relcurve'],
  env3: ['attack', 'decay', 'sustain', 'release'],
  env4: ['attack', 'decay', 'sustain', 'release'],
  env5: ['attack', 'decay', 'sustain', 'release'],
  arp: ['enable', 'mode', 'division', 'octave', 'octmode', 'gate', 'swing'],
  voice: ['polyphony', 'glide', 'detune', 'stwidth', 'analogfeel', 'density'],
  macros: ['macro_1', 'macro_2', 'macro_3', 'macro_4', 'macro_5', 'macro_6', 'macro_7', 'macro_8'],
});

export const HYDRASYNTH_DESCRIPTOR: DeviceDescriptor = {
  id: 'hydrasynth',
  display_name: 'ASM Hydrasynth Explorer',
  preset_class: 'voice',
  connection_label: 'hydrasynth',
  port_match: [
    { pattern: /hydrasynth/i },
    { pattern: /asm.*hydra/i },
    // Short-form: agents often type "hydra" without the "synth" suffix
    // (`get_params(port:"hydra")` was the failure mode in the real-
    // world trace 2026-05-23). No other registered device has "hydra"
    // in its port name, so this short match is safe.
    { pattern: /hydra/i },
  ],
  capabilities: {
    slot_model: 'linear',
    slot_count: 1024, // 8 banks × 128 patches (Explorer)
    // Declared explicitly rather than inheriting the dispatcher's `?? 'verified'`
    // default: the default lands on the right answer here by luck, and a future
    // change to it would move this device's advertised status silently. The
    // contribution-guide gate requires an explicit declaration on every
    // registered descriptor.
    support_tier: 'verified',
    has_scenes: false,
    has_channels: false,
    has_macros: true,
    preset_location_format: /^([A-H]\d{1,3}|\d{1,4})$/,
    supports_save: false,
    supports_lineage: false,
    atomic_read: false,
    // Mod-matrix + macro-page routing authorable by name (set_mod_route /
    // set_macro_route). Source/target wire values resolve through the
    // name-backed tables in modRouting.ts; 32 matrix slots, 8 macros × 8
    // destinations. See descriptor/schema.ts modRoutingOverride.
    has_mod_matrix: true,
    mod_matrix_slots: 32,
    has_macro_routing: true,
    macro_count: 8,
    macro_dest_slots: 8,
    /**
     * Melodic voice names this synth answers to as an EXTERNAL note destination:
     * a host sequencer (Circuit Tracks) authors a pitched part onto one of its
     * outward MIDI tracks and the Hydrasynth plays it (`apply_pattern`
     * `external_targets: [{device:'hydrasynth', track:'midi1'}]`), alongside a
     * drum part on the other track.
     *
     * NOTE what this does and does not claim. `pattern_realizers` is deliberately
     * ABSENT: the Hydrasynth does not sequence itself, so it is not a pattern
     * target in its own right and `apply_pattern port:'hydrasynth'` still refuses.
     * This map exists because `buildExternalOverrides` gates on
     * `capabilities.voice_map` being present BEFORE it reaches the `voice_notes`
     * pin path, so a synth with no map cannot be routed to at all, even fully
     * pinned. (Verified 2026-07-16: dispatcher/externalRouting.ts throws
     * not_a_pattern_target on `extMap === undefined`.)
     *
     * The `channel` here is nominal and unused for external routing: the real
     * channel always comes from the HOST's `external_tracks[track]` (the Circuit's
     * MIDI 1 = ch3). The note is only a fallback for an un-pitched step; a melodic
     * voice carries its own pitch from its note tokens ("c2 ~ g2 ~"), so these
     * defaults rarely apply. Set the synth to receive on the host track's channel.
     *
     * Melodic names are an OPEN vocabulary (unlike the closed DRUM_ROLES enum), so
     * this is a starter set matching the Circuit's own melodic naming. Anything
     * outside it routes via `external_targets[].voice_notes` pinning.
     */
    voice_map: {
      bass: { channel: 1, note: 36 },   // C2
      chord: { channel: 1, note: 60 },  // C4
      lead: { channel: 1, note: 72 },   // C5
      arp: { channel: 1, note: 60 },    // C4
      pad: { channel: 1, note: 60 },    // C4 — ambience
    },
  },
  canonical_terms: {
    block: 'module',                 // OSC / Filter / Env / LFO / Mutator / etc.
    slot: 'macro slot',              // 8 macros are the closest signal-chain analog
    preset: 'patch',                 // Hydrasynth's word
    scene: 'n/a',                    // no scenes
    channel: 'n/a',                  // no per-block channels
    location: 'patch slot (A001..H128)',
  },
  // Map LLM's "block" word to Hydrasynth's "module" — both resolve to
  // the same BlockSchema entries. Keep this small and obvious.
  block_aliases: {
    module: 'block',
  },
  blocks: buildBlocks(),
  block_types: buildBlockTypes(),
  reader,
  writer,
  agent_guidance: HYDRASYNTH_AGENT_GUIDANCE,
  // example_spec intentionally omitted; see comment near the deleted
  // HYDRASYNTH_EXAMPLE_SPEC constant. Hydra uses apply_patch,
  // not apply_preset.
  block_params_summary: HYDRASYNTH_BLOCK_PARAMS_SUMMARY,
  concept_keys: HYDRASYNTH_CONCEPT_KEYS,
};
