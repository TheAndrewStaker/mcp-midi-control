/**
 * Axe-Fx Standard/Ultra (gen-1) DeviceDescriptor — top-level assembler for the
 * unified tool surface.
 *
 * gen-1 is the Fractal family's first generation (model byte 0x01). Its own
 * codec (nibble-split, fn 0x02, fixed trailer) lives in `fractal-midi/gen1`.
 * This descriptor exposes a SET + READ, community-beta surface:
 *   - set_param / set_params: supported.
 *   - get_param / get_params: supported (function 0x02 query -> MIDI_PARAM_VALUE,
 *     decoded from the gen-1 wiki spec; community-beta, hardware-unconfirmed).
 *   - get_preset: supported, SPEC-PINNED SUBSET (fn 0x03 -> fn 0x04 dump:
 *     name + 4x12 effect grid + edit-buffer/stored flag; the dump's parameter
 *     region is unpinned by the spec and NOT decoded — the snapshot says so).
 *     Stored reads cover presets 0..255 (banks A/B); bank C refuses.
 *   - describe_device / list_params: supported (introspection).
 *   - save / switch / scene / channel / block: refuse cleanly.
 *
 * Registration order in server-all is INTENTIONAL: register the gen-1
 * `/axe-?fx.*(ultra|standard)/i` pattern BEFORE the broad Axe-Fx II `/axe-?fx/i`
 * pattern so a "Axe-Fx Ultra" port name matches gen-1, not gen-2.
 */

import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

import { buildBlocks, buildBlockTypes } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';
import { AXEFXGEN1_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';

export const AXEFXGEN1_DESCRIPTOR: DeviceDescriptor = {
  id: 'axe-fx-gen1',
  display_name: 'Fractal Axe-Fx Standard/Ultra',
  preset_class: 'layout',
  connection_label: 'axe-fx-gen1',
  // More specific than the II pattern — must register BEFORE axe-fx-ii.
  port_match: [{ pattern: /axe-?fx.*(?:ultra|standard)/i }],
  capabilities: {
    // gen-1 has a fixed serial block layout (no grid) with no slot placement
    // at all. 'linear' matches canonical_terms.slot ("effect block"); 'grid'
    // was a stale default that implied row/col cells.
    slot_model: 'linear',
    support_tier: 'community-beta',
    verification:
      'Wire decoded byte-exactly from the published Axe-Fx gen-1 SysEx spec (model 0x01, fn 0x02, ' +
      'nibble-split, trailing query(0)/set(1) flag), validated against the full 0..255 conversion table. ' +
      'NOT hardware-verified; the project owns no gen-1 hardware. SET, parameter READ (get_param via ' +
      'fn 0x02 query -> MIDI_PARAM_VALUE), and the whole-patch dump SPEC-PINNED SUBSET (get_preset via ' +
      'fn 0x03 -> fn 0x04: name + effect grid + source flag; per-param values NOT decoded; the spec ' +
      'leaves that region undetermined) are wired; save and preset/scene/channel ops are not.',
    has_scenes: false,
    has_channels: false,
    supports_save: false,
    supports_lineage: false,
  },
  canonical_terms: {
    block: 'block',
    slot: 'effect block',
    preset: 'preset',
    scene: 'n/a (gen-1 has no scenes)',
    channel: 'n/a (gen-1 has no X/Y channels)',
    location: 'preset number 0..255 (spec labels A000..B255) for get_preset stored reads; no save/switch over this protocol',
  },
  blocks: buildBlocks(),
  block_types: buildBlockTypes(),
  reader,
  writer,
  agent_guidance: AXEFXGEN1_AGENT_GUIDANCE,
};
