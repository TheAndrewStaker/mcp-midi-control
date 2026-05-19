/**
 * AM4 DeviceDescriptor — top-level assembler for the BK-051 unified tool
 * surface.
 *
 * Wraps the existing AM4 protocol code (params.ts, blockTypes.ts,
 * setParam.ts, locations.ts) into the `DeviceDescriptor` contract from
 * `src/protocol/generic/types.ts`. The wire layer is byte-frozen — no
 * code under `src/fractal/am4/` outside this descriptor directory is
 * modified. This file is the translation layer between the legacy
 * direct-call shape and the dispatcher-routed shape.
 *
 * Coexists with `src/fractal/am4/device.ts` (the Fractal-protocol-layer
 * `FractalDevice` instance used by the cross-Fractal device registry).
 * Both registries hold an AM4 entry; they serve different layers.
 *
 * Split into a per-role directory (Session 65) so the writer object
 * (~720 LOC of execute methods + pure builders) doesn't sit alongside
 * the reader, schema helpers, and the top-level descriptor literal:
 *
 *   - `descriptor/schema.ts`  — makeEncode / makeDecode / buildBlocks /
 *                                buildBlockTypes / parseAm4Location
 *   - `descriptor/writer.ts`  — DeviceWriter (14 methods)
 *   - `descriptor/reader.ts`  — DeviceReader (4 methods)
 *
 * Consumers continue to import `AM4_DESCRIPTOR` from
 * `@/fractal/am4/descriptor.js`; the directory split is internal.
 */

import type {
  CompatibleTypesQuery,
  CompatibleTypesResult,
  DeviceDescriptor,
  PresetSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';

import { findCompatibleTypes as am4FindCompatibleTypes } from 'fractal-midi/am4';
import { TOTAL_LOCATIONS } from 'fractal-midi/am4';

import { AM4_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';
import { buildBlocks, buildBlockTypes } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';

function findCompatibleTypes(query: CompatibleTypesQuery): CompatibleTypesResult {
  const r = am4FindCompatibleTypes(query.block, query.params);
  return {
    block: query.block,
    params_queried: query.params,
    compatible_types: r.compatible_types,
    total_types: r.total_types,
    applicability_known: r.applicability_known,
    note: r.note,
  };
}

/**
 * Working `apply_preset` payload literal the agent can clone. AM4 uses
 * linear bare-int slots 1..4 and A/B/C/D channels on amp/drive/reverb/delay.
 * Every value here is in the device's display vocabulary (knob 0..10,
 * canonical enum spelling); the spec passes `collectApplyPresetPreflight`
 * with zero errors (verified by `scripts/verify-describe-device.ts`).
 */
const AM4_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      slot: 1,
      block_type: 'drive',
      params: {
        A: { type: 'Tube Drive 3-Knob', drive: 3, tone: 6, level: 5 },
      },
    },
    {
      slot: 2,
      block_type: 'amp',
      params: {
        A: { type: 'USA Pre Clean', gain: 3, master: 5 },
        B: { type: 'USA MK IIC+', gain: 6, master: 4 },
      },
    },
    {
      slot: 3,
      block_type: 'reverb',
      params: {
        A: { type: 'Hall, Medium', mix: 25 },
      },
    },
    {
      slot: 4,
      block_type: 'delay',
      params: {
        A: { type: 'Digital Stereo', mix: 15 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'A', reverb: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'B', reverb: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

export const AM4_DESCRIPTOR: DeviceDescriptor = {
  id: 'am4',
  display_name: 'Fractal AM4',
  connection_label: 'am4',                      // matches AM4_LABEL in connections.ts
  port_match: [
    { pattern: /AM4/i },
    { pattern: /Fractal/i },
  ],
  capabilities: {
    slot_model: 'linear',
    slot_count: 4,
    has_scenes: true,
    scene_count: 4,
    has_channels: true,
    channel_names: ['A', 'B', 'C', 'D'],
    channel_blocks: ['amp', 'drive', 'reverb', 'delay'],
    preset_location_format: /^[A-Z]0?[1-4]$/,
    supports_save: true,
    supports_factory_restore: true,
    supports_lineage: true,
  },
  canonical_terms: {
    block: 'block',
    slot: 'slot 1–4',
    preset: 'preset',
    scene: 'scene 1–4',
    channel: 'channel A/B/C/D',
    location: `location A1..Z4 (${TOTAL_LOCATIONS} total — banks A..Z × 4 per bank; device front-panel shows the unpadded form, e.g. "A1", "M3", "Z4")`,
  },
  blocks: buildBlocks(),
  block_types: buildBlockTypes(),
  reader,
  writer,
  agent_guidance: AM4_AGENT_GUIDANCE,
  findCompatibleTypes,
  example_spec: AM4_EXAMPLE_SPEC,
};
