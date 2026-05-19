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
 *   - supports_save: false in v1 (save-to-slot envelope not yet wired
 *     into the descriptor — legacy hydra_apply_patch covers it until
 *     v1 follow-up extends writer.applyPreset)
 *   - supports_factory_restore: false (Hydrasynth has "init patch"
 *     instead — exposed via legacy hydra_apply_init, not the unified
 *     restore_defaults primitive yet)
 *   - supports_lineage: false (Fractal lineage corpus doesn't apply)
 *
 * Unified surface coverage (v1):
 *   ✓ set_param / set_params / list_params / describe_device
 *   ✓ switch_preset (Bank Select MSB/LSB + Program Change)
 *   ✗ apply_preset (legacy hydra_apply_patch covers — deferred)
 *   ✗ get_param / get_params (no decoded read primitive)
 *   ✗ scan_locations (Hydrasynth patches are full SysEx dumps, no name-only query)
 *   ✗ switch_scene / set_bypass / set_block / restore_defaults — no-op for synth
 */

import type { DeviceDescriptor, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

import { HYDRASYNTH_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';
import { buildBlocks, buildBlockTypes } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';

/**
 * Working `apply_preset` payload literal for the unified surface. Hydrasynth
 * is a synth: modules (osc/filter/amp/fx) are always-on, there are no
 * scenes, and no per-block channels. The "slot" is a per-module addressing
 * placeholder (always 1); every module instance is named directly by its
 * canonical block slug. The spec passes `collectApplyPresetPreflight` with
 * zero errors (verified by `scripts/verify-describe-device.ts`).
 */
const HYDRASYNTH_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    { slot: 1, block_type: 'osc1', params: { semi: 0 } },
    { slot: 1, block_type: 'filter1', params: { cutoff: 60 } },
    { slot: 1, block_type: 'amp', params: { level: 90 } },
    { slot: 1, block_type: 'reverb', params: { dry_wet: 25, predelay: 10 } },
    { slot: 1, block_type: 'delay', params: { dry_wet: 15 } },
  ],
};

export const HYDRASYNTH_DESCRIPTOR: DeviceDescriptor = {
  id: 'hydrasynth',
  display_name: 'ASM Hydrasynth Explorer',
  connection_label: 'hydrasynth',
  port_match: [
    { pattern: /hydrasynth/i },
    { pattern: /asm.*hydra/i },
  ],
  capabilities: {
    slot_model: 'linear',
    slot_count: 1024, // 8 banks × 128 patches (Explorer)
    has_scenes: false,
    has_channels: false,
    has_macros: true,
    preset_location_format: /^([A-H]\d{1,3}|\d{1,4})$/,
    supports_save: false,
    supports_factory_restore: false,
    supports_lineage: false,
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
  example_spec: HYDRASYNTH_EXAMPLE_SPEC,
};
