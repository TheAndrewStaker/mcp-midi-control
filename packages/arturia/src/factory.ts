/**
 * Build a DeviceDescriptor for any Arturia Freak from its config.
 *
 * Mirrors `createModernFractalDescriptor`: one codec, one factory, per-device
 * configs. A device is added by writing a config, never by writing a second
 * descriptor. What a config may legitimately withhold is the important part:
 * `sysex` is absent when the device-code byte is unknown, and the factory then
 * builds a descriptor whose globals block does not exist and whose reads refuse,
 * rather than one that advertises capabilities it cannot deliver.
 */
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

import { buildBlocks } from './descriptor/schema.js';
import { createReader } from './descriptor/reader.js';
import { createWriter } from './descriptor/writer.js';
import type { FreakConfig } from './devices/types.js';

export function createFreakDescriptor(config: FreakConfig): DeviceDescriptor {
  const hasSysex = config.sysex !== undefined;
  return {
    id: config.id,
    display_name: config.display_name,
    preset_class: 'voice',
    connection_label: config.id,
    port_match: config.port_match.map((pattern) => ({ pattern })),
    capabilities: {
      slot_model: 'linear',
      support_tier: config.support_tier,
      verification: config.verification,
      has_scenes: false,
      has_channels: false,
      supports_save: false,
      save_note:
        'No save path on any Freak: the preset WRITE/upload protocol is undecoded (the community '
        + 'reverse-engineering is read-only), so saving must be done on the device.',
      supports_lineage: false,
      preset_location_format: /^\d{1,3}$/,
    },
    canonical_terms: {
      block: 'section (oscillator / filter / envelope / LFO / ...)',
      slot: 'n/a (no slot chain)',
      preset: 'preset',
      scene: 'n/a (no scenes)',
      channel: 'n/a (no per-block channels)',
      location: `preset slot 1-${config.preset_count}`
        + (hasSysex ? '' : ' (preset names cannot be listed: no SysEx device code)'),
    },
    blocks: buildBlocks(config),
    reader: createReader(config),
    writer: createWriter(config),
    agent_guidance: config.agent_guidance,
  };
}
