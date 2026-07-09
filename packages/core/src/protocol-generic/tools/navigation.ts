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
  executeSavePreset,
  executeScanLocations,
  executeSwitchPreset,
  executeSwitchScene,
  dispatchSetModRoute,
  dispatchSetMacroRoute,
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
      '- Location format is per-device. See describe_device.capabilities.preset_location_format (AM4: A1..Z4; II: 1..16384; III/FM3/FM9: integer preset #; Hydra: A1..H8).',
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
      '- OVERWRITE GATE (AM4): if the target location is occupied AND is not the location you are editing, the save refuses and returns the occupying preset name. Confirm with the user, then retry with confirm_overwrite: true. Saving over the active location, or to an empty location, proceeds without the gate.',
      '- RECEIPT (AM4): on success the response carries saved_snapshot { block_chain, amp_model, drive_model, preset_name }, read back from the device so you can confirm to the user exactly what landed, not just that it acked.',
      '- Optional `name` (<=32 chars) renames the preset before saving.',
      '- `instance` selects Synth 1/2 on Circuit Tracks for save (default 1); whole-preset devices (Fractal) ignore it.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      location: z.union([z.string(), z.number()]).describe(
        'Storage location. See describe_device for the device\'s shape.',
      ),
      name: z.string().max(32).optional().describe(
        'Optional new name (up to 32 chars). If supplied, the preset is renamed before saving.',
      ),
      confirm_overwrite: z.boolean().optional().describe(
        'Set true to confirm overwriting an occupied, non-active target location. Omit (or false) to be refused (with the occupying preset name surfaced) when the target already holds a preset. Saving to the active location or an empty location does not require this.',
      ),
      instance: z.number().int().min(1).optional().describe(
        'Block instance (1-indexed) to save on multi-instance devices. Circuit Tracks: 2 = Synth 2 (default 1 = Synth 1). Ignored/rejected on single-instance devices.',
      ),
    },
  }, async ({ port, location, name, confirm_overwrite, instance }) => {
    try {
      const result = await executeSavePreset({ port, location, name, confirm_overwrite, instance });
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
      '- Scene range is per-device (AM4: 1..4; Axe-Fx II/III/FM3/FM9: 1..8).',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      scene: z.number().int().describe(
        'Scene number (1-indexed). Range depends on the device: AM4: 1..4; Axe-Fx II/III/FM3/FM9: 1..8.',
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

  // `rename` tool removed 2026-05-23. The standalone rename was leftover
  // from v0.2 and its own description admitted "needs save_preset to
  // land" — agents reach for save_preset.name (persistence-time rename)
  // or apply_preset.spec.name + spec.scenes[].name (build-time rename)
  // depending on intent. Both already cover the use case. The dispatcher
  // executor `executeRename` is kept for any future caller; if a v0.2
  // workflow needs incremental scene renames without rebuild, surface
  // it via a new focused tool then.

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

  // set_mod_route ----------------------------------------------------------
  server.registerTool('set_mod_route', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Wire one modulation-matrix route by NAME on a synth with a mod matrix (e.g. Hydrasynth): picks a free slot and writes source + target + depth in one call (env-to-filter, velocity-to-brightness, LFO-to-pitch on an agent-built patch). source/target use the device\'s own labels (source e.g. "Env 2", "LFO 1", "Velocity"; target e.g. "Filt 1 Cutoff", "Osc 1 Pitch"); full lists: list_params({port, block:"modmatrix"}). depth is bipolar -128..+128 (0 = no modulation). Slot auto-allocation assumes a fresh/INIT patch; on a factory patch pass an explicit slot. The MOD MATRIX front-panel page DOES redraw to show NRPN-set routes (live-verified), so confirm by screen or by ear. Returns capability_not_supported on devices without a mod matrix.',
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      source: z.union([z.string(), z.number()]).describe('Mod source name (e.g. "Env 2", "LFO 1", "Velocity") or its wire value.'),
      target: z.union([z.string(), z.number()]).describe('Mod destination name (e.g. "Filt 1 Cutoff", "Mut 1 Depth") or its wire value.'),
      depth: z.number().min(-128).max(128).optional().describe('Bipolar modulation depth -128..+128. Default 0 (no modulation).'),
      slot: z.number().int().min(1).optional().describe('Explicit matrix slot (1-based). Omit to auto-allocate the next free slot (reuses the slot already routing this source to target).'),
    },
  }, async ({ port, source, target, depth, slot }) => {
    try {
      return asText(await dispatchSetModRoute({ port, source, target, depth, slot }));
    } catch (err) {
      return asError(err);
    }
  });

  // set_macro_route --------------------------------------------------------
  server.registerTool('set_macro_route', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Assign one of a performance Macro\'s (1-8) destinations by NAME on the Hydrasynth macro page (up to 8 each); allocates a free slot and writes target + depth + button value. A destination has exactly THREE fields: Destination, Button Value, Depth. There is NO sweep start/min; the knob sweeps the destination from the patch\'s programmed value by depth (bipolar -128..+128). button_value is what the macro\'s physical Control button applies when pressed; new destinations initialize it to 0 (the device otherwise leaves -128, which would slam the destination full-negative on a button press). After this, set_macro(macro, value) moves the destination; an unwired macro is silent. Target labels match set_mod_route; discover via list_params({port, block:"macros"}). Auto-allocation assumes a fresh/INIT patch; pass an explicit slot on a factory patch. CONFIRM BY EAR: the macro edit page may not redraw over MIDI (the MOD MATRIX page does). capability_not_supported on devices without authorable macros.',
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      macro: z.number().int().min(1).max(8).describe('Macro number 1-8.'),
      target: z.union([z.string(), z.number()]).describe('Destination name (e.g. "Filt 1 Cutoff") or wire value.'),
      depth: z.number().min(-128).max(128).optional().describe('Bipolar depth -128..+128. Default 0.'),
      slot: z.number().int().min(1).max(8).optional().describe('Explicit destination slot 1-8 for this macro. Omit to auto-allocate.'),
      button_value: z.number().min(-128).max(128).optional().describe(
        "Value the macro's physical Control button applies when pressed (bipolar -128..+128; button behavior Toggle/Trigger/Hold/Reset is a device System Setup setting). NOT a sweep bound. Defaults to 0 on newly-created destinations; existing destinations keep their authored value unless this is passed.",
      ),
    },
  }, async ({ port, macro, target, depth, slot, button_value }) => {
    try {
      return asText(await dispatchSetMacroRoute({ port, macro, target, depth, slot, button_value }));
    } catch (err) {
      return asError(err);
    }
  });
}
