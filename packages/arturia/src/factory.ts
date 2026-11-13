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
      // Kept terse on purpose: this string rides every describe_device payload
      // and the microfreak ceiling in verify-describe-device-budget.ts has
      // near-zero slack. Full provenance for the MicroFreak's import_preset
      // path lives in codec/sysex.ts and descriptor/presetWrite.ts, not here.
      save_note: hasSysex
        ? 'No save_preset verb; import_preset (target_location + save_authorized + confirm_overwrite + name) '
          + 'writes a stored slot, which IS the persist here. MiniFreak: no write path (device-code unknown).'
        : 'No save path on this Freak: the preset WRITE protocol needs the SysEx device-code byte, which is '
          + 'unknown for this model, so the whole surface is absent rather than approximate.',
      supports_lineage: false,
      preset_location_format: /^\d{1,3}$/,
      // BackupPolicy, only when the SysEx dump surface exists (its presence is
      // what makes `reader.dumpStoredPresetBinary` real). Declaring the bounds
      // lets backup_device size a stored sweep without from/to. No
      // restore_tool is DECLARED, and none is needed: `resolveBackupPolicy`
      // derives it from `writer.restorePresetBinary`, which this device gained
      // 2026-08-14, so the receipt already reads "Put any one of them back with
      // import_preset". (The note that used to sit here, warning that the
      // receipt still said "no restore path through this server", was written
      // before that writer landed and is no longer true.) No restore_note
      // either: the derivation covers it and the payload stays flat against the
      // frozen ceiling above.
      ...(hasSysex
        ? {
            backup: {
              unit_label: 'preset',
              first_location: 1,
              last_location: config.sysex!.preset_count,
              // MEASURED 2026-08-15, not estimated: a full `export_preset`
              // (1 dump start + 146 data pulls) round-trips in 201 ms, and a
              // whole write cycle in 250 ms, timed over the 512-slot library
              // send. The previous 10 s came from costing those 147 pulls at a
              // per-message 30-60 ms that the device does not charge — they
              // stream, they are not serial request/response — and it inflated
              // every quote this device gave by ~40x (a 64-preset sweep quoted
              // "about 11 minutes" against a real ~13 s). Kept ~2.5x
              // pessimistic per the BackupPolicy contract: a sweep that
              // finishes early is fine, one that runs long is not.
              seconds_per_unit: 0.5,
            },
          }
        : {}),
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
