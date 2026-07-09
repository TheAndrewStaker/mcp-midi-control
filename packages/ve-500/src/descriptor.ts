/**
 * Boss VE-500 Vocal Performer DeviceDescriptor — top-level assembler for the
 * unified tool surface.
 *
 * The VE-500 is a `layout` / preset-signal-processor archetype: it reuses the
 * unified verbs (set_param / get_param / set_params / get_params / set_bypass /
 * switch_preset / describe_device / list_params) with NO device-specific tools.
 *
 * It is the first Roland address-based SysEx codec in the tree. The entire wire
 * surface (model id 00 00 00 55, DT1/RQ1 envelope, Roland checksum, the full
 * parameter address map, value packing) was decoded from the BOSS VE-500
 * Editor's own JavaScript (the manufacturer's authoritative encoder) and is
 * hardware-confirmed end-to-end on the maintainer's unit (support_tier verified;
 * factory preset P01-P50 recall and whole-patch reads deferred).
 *
 * Codec lives in `roland-midi` (shared Roland primitives + the VE-500 catalog).
 */

import type {
  DeviceDescriptor,
  PresetSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';

import { buildBlocks } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';
import { VE500_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';

/**
 * Working apply_preset payload an agent can clone. Each slot is a fixed VE-500
 * section (block_type = section name; the `slot` ordinal just enumerates them).
 * `bypassed` toggles a section's on/off switch; `params` are display values.
 * Working-buffer only — press WRITE on the device to keep the result.
 */
const VE500_EXAMPLE_SPEC: PresetSpec = {
  name: 'Lead Vocal',
  slots: [
    { slot: 1, block_type: 'enhancer', bypassed: false, params: { enhance: 40, compressor: 30, de_esser: 20 } },
    { slot: 2, block_type: 'pitch_correct', bypassed: false, params: { type: 'Soft', formant: 50, speed: 5 } },
    { slot: 3, block_type: 'harmony1', params: { voice_manual: '+3RD', pan: 50, level: 70 } },
    { slot: 4, block_type: 'reverb1', bypassed: false, params: { type: 'Hall', reverb_time: 50, reverb_level: 40 } },
  ],
};

export const VE500_DESCRIPTOR: DeviceDescriptor = {
  id: 've-500',
  display_name: 'Boss VE-500 Vocal Performer',
  preset_class: 'layout',
  connection_label: 've-500',
  // USB-MIDI class compliant; transport defaults to 'midi'.
  port_match: [{ pattern: /VE-?500/i }],
  capabilities: {
    // Fixed effect sections (not a placeable grid).
    slot_model: 'linear',
    support_tier: 'verified',
    verification:
      'Wire decoded from the BOSS VE-500 Editor\'s own code (model id 00 00 00 55, DT1/RQ1 envelope, ' +
      'Roland checksum, full parameter address map, value packing). HARDWARE-CONFIRMED end-to-end on ' +
      'the maintainer\'s unit (2026-06-28): set_param, get_param (RQ1→DT1 round-trip), set_bypass, and ' +
      'switch_preset for user memories U01–U99 (BARE Program Change; a prepended Bank Select makes the ' +
      'unit ignore the recall, so none is sent; requires PC IN = ON, RX CH = OMNI/Ch.1). save_preset ' +
      '(store the edit buffer to a USER memory) HARDWARE-CONFIRMED 2026-07-08: a bare store command ' +
      '(DT1 0x7F000104) did NOT persist a MIDI-set value, but the editor\'s connect handshake always sends ' +
      'Editor Communication Mode ON first, so save_preset now sends that before the store and waits for the ' +
      'device\'s store-ack echo; a set + save + recall round-trip persisted correctly on the maintainer\'s ' +
      'unit. NOT yet wired: factory preset (P01–P50) recall (Bank Select mapping undecoded, gated) and ' +
      'whole-patch get_preset.',
    has_scenes: false,
    has_channels: false,
    supports_save: true,
    save_note:
      'save_preset stores the active edit buffer to a USER memory U01–U99: it sends Editor Communication ' +
      'Mode ON, then the store command, then waits for the device\'s store-ack echo (pass ' +
      'save_authorized=true on explicit save intent). Presets P01–P50 are factory/read-only and rejected. ' +
      'HARDWARE-CONFIRMED 2026-07-08 (a set + save + flash-reload round-trip persisted; the device echoes ' +
      'the store, so acked reflects a real device ack).',
    supports_lineage: false,
    // User memories U01–U99 (1–99) and preset P01–P50.
    preset_location_format: /^(U0?[1-9][0-9]?|P0?[1-9][0-9]?|[1-9][0-9]?)$/i,
  },
  canonical_terms: {
    block: 'effect section',
    slot: 'effect section',
    preset: 'memory',
    scene: 'n/a (VE-500 has no scenes)',
    channel: 'n/a (VE-500 has no per-block channels)',
    location: 'memory U01–U99 (user) / P01–P50 (preset)',
  },
  blocks: buildBlocks(),
  reader,
  writer,
  agent_guidance: VE500_AGENT_GUIDANCE,
  example_spec: VE500_EXAMPLE_SPEC,
};
