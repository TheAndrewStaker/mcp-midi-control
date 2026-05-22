/**
 * Navigation tools, preset / scene / location moves and bulk scanning.
 *
 * Tools registered here:
 *   - `switch_preset(port, location)`, load a stored preset into working buffer
 *   - `save_preset(port, location, name?)`, persist working buffer to a location
 *   - `switch_scene(port, scene)`, change active scene
 *   - `rename(port, target, name)`, rename the working-buffer preset or a scene
 *   - `scan_locations(port, from, to)`, bulk-scan stored preset names
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  executeRename,
  executeSavePreset,
  executeScanLocations,
  executeSwitchPreset,
  executeSwitchScene,
} from '../dispatcher.js';
import {
  ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA,
} from '../../server-shared/safeEdit.js';

import { PORT_DESC, asError, asText } from './shared.js';

export function registerNavigationTools(server: McpServer): void {
  server.registerTool('switch_preset', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Load a stored preset into the working buffer. Same effect as turning the device\'s preset knob.',
      'WARNING: discards unsaved working-buffer edits. The on_active_preset_edited gate refuses by default if the buffer is dirty; pass "discard" or "save_active_first" to override.',
      '- Location format is per-device. See describe_device.capabilities.preset_location_format (AM4: A1..Z4; II: 1..16384; Hydra: A1..H8).',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      location: z.union([z.string(), z.number()]).describe(
        'Preset location. See describe_device.capabilities.preset_location_format for the device\'s expected shape.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
    },
  }, async ({ port, location, on_active_preset_edited }) => {
    try {
      const result = await executeSwitchPreset({ port, location, on_active_preset_edited });
      if (result.refused) {
        return {
          content: [{ type: 'text', text: result.warningText ?? 'navigation refused' }],
          isError: true,
        };
      }
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('save_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'DESTRUCTIVE: persist the working buffer to a stored location, optionally renaming first. Call ONLY when the user explicitly said save/store/keep/persist.',
      '- "make me a preset for X" is audition language, not save. When unsure, apply_preset first and ask before persisting.',
      '- Confirm before overwriting a non-empty location. Z04 is the conventional AM4 scratch slot.',
      '- Optional `name` (<=32 chars) renames the preset before saving.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      location: z.union([z.string(), z.number()]).describe(
        'Storage location. See describe_device for the device\'s shape.',
      ),
      name: z.string().max(32).optional().describe(
        'Optional new name (up to 32 chars). If supplied, the preset is renamed before saving.',
      ),
    },
  }, async ({ port, location, name }) => {
    try {
      const result = await executeSavePreset({ port, location, name });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('switch_scene', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Change the active scene within the current preset. Toggles per-scene bypass + channel state; the block layout stays the same.',
      '- Working-buffer scope only; the next preset load starts at its default scene.',
      '- Devices without scenes (Hydrasynth) refuse with a capability error.',
      '- Scene range is per-device (AM4: 1..4; Axe-Fx II/III: 1..8).',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      scene: z.number().int().describe(
        'Scene number (1-indexed). Range depends on the device, AM4: 1..4; Axe-Fx II: 1..8.',
      ),
    },
  }, async ({ port, scene }) => {
    try {
      const result = await executeSwitchScene({ port, scene });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

    server.registerTool('rename', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Rename the working-buffer preset or one of its scenes. Target is "preset" or "scene:N" (1-indexed).',
      '- Writes the working buffer only; persists only if save_preset follows.',
      '- AM4: rename(target="preset") needs save_preset(location, name) to land. The shortcut is to call save_preset with both args directly.',
      '- Devices without scenes refuse scene targets.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      target: z.string().describe(
        'Rename target, "preset" or "scene:N" (1-indexed).',
      ),
      name: z.string().min(1).max(32).describe(
        'New name (1..32 chars). Shorter names are space-padded on the wire by the device.',
      ),
    },
  }, async ({ port, target, name }) => {
    try {
      const result = await executeRename({ port, target, name });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('scan_locations', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Bulk-read stored preset names across a location range. Non-destructive; working buffer and active location preserved.',
      'Canonical use: before bulk-applying or restoring a range, scan first to surface which locations hold customised presets vs are empty.',
      '- Empty locations come back with is_empty=true.',
      '- On mid-loop failure the scan aborts and returns partial results + the failure location.',
      '- Performance: ~50-100 ms per location on AM4 (4-location bank ~200-400 ms); ~80 ms per slot on Axe-Fx II (64-slot scan ~5 s). For II ranges larger than ~12 slots, announce the wait to the user up front.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      from: z.union([z.string(), z.number()]).describe(
        'Inclusive start of the scan range. AM4: "A1".."Z4"; Axe-Fx II: 0..383; etc.',
      ),
      to: z.union([z.string(), z.number()]).describe(
        'Inclusive end of the scan range. Pass from <= to.',
      ),
    },
  }, async ({ port, from, to }) => {
    try {
      const result = await executeScanLocations({ port, from, to });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
