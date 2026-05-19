/**
 * Axe-Fx II DeviceDescriptor — top-level assembler for the BK-051 unified
 * tool surface (Wave 2).
 *
 * Wraps the existing Axe-Fx II protocol code (params.ts, blockTypes.ts,
 * setParam.ts, lineageLookup.ts, tools/applyExecutor.ts) into the
 * `DeviceDescriptor` contract from `src/protocol/generic/types.ts`. The
 * wire layer is byte-frozen — no code under `src/fractal/axe-fx-ii/`
 * outside this descriptor directory (and the applyExecutor.ts widening
 * tweaks) is modified. This file is the translation layer between the
 * legacy direct-call shape and the dispatcher-routed shape.
 *
 * Split into a per-role directory (Session 67, mirroring the AM4
 * descriptor split in Session 65 cont):
 *
 *   - `descriptor/schema.ts`  — makeEncode / makeDecode (per-param
 *                                encode/decode closures), buildBlocks,
 *                                buildBlockTypes, parseAxeFxIILocation,
 *                                findBlockBySlug
 *   - `descriptor/writer.ts`  — DeviceWriter (14 methods)
 *   - `descriptor/reader.ts`  — DeviceReader (4 methods)
 *
 * Consumers continue to import `AXEFX2_DESCRIPTOR` from
 * `@/fractal/axe-fx-ii/descriptor.js`; the directory split is internal.
 *
 * Registration order in `src/server/index.ts` is INTENTIONAL: Axe-Fx II
 * registers BEFORE AM4 so the more-specific `/axe-?fx/i` regex fires
 * first on port names like "Fractal Axe-Fx II Port 1". AM4's
 * `/Fractal/i` regex stays as a catch-all (Q4 answered Session 66 wrap;
 * see `docs/_private/axefx2-descriptor-plan.md` § 9).
 */

import type { DeviceDescriptor, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

import { AXE_FX_II_BLOCKS } from 'fractal-midi/axe-fx-ii';

import { AXEFX2_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';
import { buildBlocks, buildBlockTypes } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';

// Channel-blocks list — every AxeFxIIBlock.canBypass=true entry exposes
// X/Y in principle. The wiki / firmware spec doesn't carry an explicit
// "has channels" flag, so this is the closest proxy. Looper / Vocoder
// / Megatap / Tone Match may not actually expose X/Y on Q8.02; Q7
// (Session 66 wrap) flags this for HW verification.
const CHANNEL_BLOCKS: readonly string[] = Object.freeze(
  AXE_FX_II_BLOCKS.filter((b) => b.canBypass).map((b) => b.name.toLowerCase().replace(/ \d+$/, '')),
);

/**
 * Working `apply_preset` payload literal for the unified surface. Axe-Fx II
 * uses {row, col} grid slot refs and X/Y channels on channel-bearing blocks.
 * Every value is in the device's display vocabulary (knob 0..10, canonical
 * upper-case enum spelling per AxeEdit). The spec passes
 * `collectApplyPresetPreflight` with zero errors (verified by
 * `scripts/verify-describe-device.ts`).
 */
const AXEFX2_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      params: {
        X: { effect_type: 'TUBE DRV 3-KNOB', gain: 3, tone: 6, volume: 5 },
      },
    },
    {
      slot: { row: 2, col: 2 },
      block_type: 'amp',
      params: {
        X: { effect_type: 'USA CLEAN', input_drive: 3, master_volume: 5 },
        Y: { effect_type: 'USA IIC+', input_drive: 6, master_volume: 4 },
      },
    },
    { slot: { row: 2, col: 3 }, block_type: 'cab' },
    {
      slot: { row: 2, col: 4 },
      block_type: 'reverb',
      params: {
        X: { effect_type: 'MEDIUM PLATE', mix: 25 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'X', reverb: 'X' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'Y', reverb: 'X' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

export const AXEFX2_DESCRIPTOR: DeviceDescriptor = {
  id: 'axe-fx-ii',
  display_name: 'Fractal Axe-Fx II XL+',
  connection_label: 'axe-fx-ii',
  port_match: [
    { pattern: /axe-?fx/i },
  ],
  capabilities: {
    slot_model: 'grid',
    grid: { rows: 4, cols: 12 },
    has_scenes: true,
    scene_count: 8,
    has_channels: true,
    channel_names: ['X', 'Y'],
    channel_blocks: CHANNEL_BLOCKS,
    preset_location_format: /^([1-9]\d{0,3}|0)$/,
    supports_save: true,
    supports_factory_restore: false,
    supports_lineage: true,
  },
  canonical_terms: {
    block: 'block',
    slot: 'grid cell (row 1..4, col 1..12)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel X/Y',
    location: 'preset slot 0..16383 (front panel = wire + 1)',
  },
  blocks: buildBlocks(),
  block_types: buildBlockTypes(),
  reader,
  writer,
  agent_guidance: AXEFX2_AGENT_GUIDANCE,
  example_spec: AXEFX2_EXAMPLE_SPEC,
};
