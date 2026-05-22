/**
 * Preset tools, full-preset apply, batch setlist apply, and factory
 * restore. These tools wrap the device's preset executor; the AM4
 * implementation lives in `src/fractal/am4/tools/applyExecutor.ts` and
 * is invoked by the descriptor's `writer.applyPreset` /
 * `writer.applySetlist` / `writer.restoreDefaults` methods.
 *
 * Tools registered here:
 *   - `apply_preset(port, spec, target_location?)`
 *   - `apply_setlist(port, entries, options?)`
 *   - `restore_defaults(port, from, to?, options?)`
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  executeApplyPreset,
  executeApplySetlist,
  executeGetPreset,
  executePortPreset,
  executeRestoreDefaults,
} from '../dispatcher.js';
import type { PresetSpec } from '../types.js';
import {
  ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA,
  SAVE_AUTHORIZED_SCHEMA,
  buildSaveAuthorizedDescription,
} from '../../server-shared/safeEdit.js';

import { PORT_DESC, asError, asText, presetShape } from './shared.js';

export function registerPresetTools(server: McpServer): void {
  server.registerTool('get_preset', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Snapshot the active working buffer in one tool call. Returns every placed block with its current params under a PresetSpec-shaped envelope. Use for state-anchoring before a tone edit: read, summarize, propose changes, then targeted set_param / set_params.',
      'Scope: active scene only; no scenes 2..N, no routing. Channel-bearing blocks default to flat params with channel_status:"unknown"; pass include_channel_state:true to nest under the active channel (+~50 ms per channel block).',
      'Performance: ~1-1.5 s on II for an 11-block preset (+~450 ms with include_channel_state). AM4 / III / Hydra: capability_not_supported (use get_param / get_params); describe_device.capabilities.atomic_read gates support.',
      'DO NOT feed the whole snapshot back into apply_preset (FRESH-BUILD-CLEARS unlisted slots + scenes). Use set_param / set_params for changed knobs. Re-call get_preset to verify; catches type-gated silent no-ops.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      include_channel_state: z.boolean().optional().describe(
        'When true, read each channel-bearing block\'s active channel via an extra SysEx round-trip per block (~50 ms each) so params nest under the active channel key. Default false (faster inspection).',
      ),
    },
  }, async ({ port, include_channel_state }) => {
    try {
      const result = await executeGetPreset({ port, include_channel_state });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('apply_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Build a fresh preset in one structured call. REPLACES the working-buffer layout; for targeted tweaks use set_param.',
      'Modes: no target_location = audition (reversible); target_location + save_authorized:false = audition at target; target_location + save_authorized:true = DESTRUCTIVE save (true ONLY for save/store/keep/put-on/persist vocab; scan_locations the target FIRST).',
      'Call describe_device(port) once for slot shape, example_spec (clone + swap), concept_keys, agent_guidance.',
      'FRESH-BUILD CLEARING: unlisted slots clear; unlisted scenes reset. Song-tone prompts: name scenes Verse/Chorus/Bridge/Solo for footswitch use.',
      'On response, scan validation_info[]: type-knob dropped_param (write suppressed pre-flight, pick a type via find_compatible_types), enum "Valid options:" lists (re-invoke verbatim), alias/case fixes, channel-Y inactive.',
      'For solo/lead loudness compensation, call lookup_lineage to read amp.master_sweet_spot + drive.boost_response_dB.',
      'When the user names SPECIFIC knobs (e.g. "slow chorus" implies rate/depth, "long reverb" implies time), call find_compatible_types({block, params:[knobs]}) BEFORE the first apply_preset to pick a type that exposes them. Known silent-no-op traps on AM4: Hall reverb has fixed decay (no `time`); Analog Stereo chorus has no rate/depth/tempo knobs.',
      'Do not re-call apply_preset to verify a previous apply. The result envelope\'s steps, duration_ms, and validation_info[] are sufficient. To check a specific landed value, call get_param.',
      'Performance: 1-3 s; +250 ms on save.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      spec: presetShape.describe('Preset specification (slots, optional scenes, optional name).'),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional navigation target. With save_authorized=false (default): navigate + apply (audition, no save). With save_authorized=true: navigate + apply + save (destructive). Omit to apply at the current working-buffer location.',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set true ONLY for explicit save vocab: "save", "store", "keep", "put on", "persist". AUDITION language (NOT save): "build a preset at X", "make me a tone on X", "design a preset at X", "make X look/sound like Y". State descriptions ("I want X to be Z") are audition unless save vocab is added. When ambiguous, audition (false) and ASK before saving; saves are destructive, auditions are reversible by switching presets.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
      verify_chain: z.boolean().optional().describe(
        'When true, run a read-after-write chain integrity check after the apply ops ack. On grid devices (Axe-Fx II / III) the check reads the working-buffer grid and surfaces any cell past col 1 with `routing_mask == 0` (broken cable, signal won\'t flow). On linear devices (AM4) and synths (Hydrasynth) the check returns a trivial pass since they have no chain-routing semantics. Use when you need certainty the preset will produce sound before the user plugs in. On a returned chain_break, surface the broken cells to the user (with their row/col) BEFORE claiming the preset is ready to play. Adds ~50-100 ms per call on grid devices.',
      ),
    },
  }, async ({ port, spec, target_location, save_authorized, on_active_preset_edited, verify_chain }) => {
    try {
      const result = await executeApplyPreset({
        port,
        spec: spec as PresetSpec,
        target_location,
        save_authorized,
        on_active_preset_edited,
        verify_chain,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('apply_setlist', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'DESTRUCTIVE: bulk switch + apply + save per entry across a list. Use when the user has a fully-specified setlist plan up front. For creative per-song builds, prefer apply_preset in sequence so you can narrate progress.',
      'PRE-FLIGHT: call scan_locations across the target range first and surface what would be overwritten. Silent overwrites are the worst failure mode here.',
      '- on_error: "stop" (default) halts on first failure; "continue" logs and proceeds.',
      '- dry_run=true: validate every entry, send no wire bytes.',
      '- verify (default true): name read-back per entry; mismatch flips entry to error.',
      '- Performance: ~3-5 s per entry. 15 entries = ~1 minute. Frame as "load before the show", not between songs.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      entries: z.array(z.object({
        location: z.union([z.string(), z.number()]),
        spec: presetShape,
      })).min(1).max(26).describe(
        '1..26 setlist entries. Each entry pairs a target location with a preset spec. Locations must be unique within the batch.',
      ),
      on_error: z.enum(['stop', 'continue']).optional(),
      dry_run: z.boolean().optional(),
      verify: z.boolean().optional(),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
    },
  }, async ({ port, entries, on_error, dry_run, verify, on_active_preset_edited }) => {
    try {
      const result = await executeApplySetlist({
        port,
        entries: entries.map((e: { location: string | number; spec: unknown }) => ({
          location: e.location,
          spec: e.spec as PresetSpec,
        })),
        options: { on_error, dry_run, verify },
        on_active_preset_edited,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('translate_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Translate a Fractal preset spec from one device to a sibling device (AM4 / Axe-Fx II / III). Caller passes `source_spec` explicitly; v1 does not read from the source device (renamed from port_preset 2026-05-22 because "port" implied source-read, "translate" matches what it actually does).',
      'Translation covers chain topology, block availability (II/III cab vs AM4 integrated), param-name aliases (drive.volume / drive.level), enum mappings (USA IIC+ / USA MK IIC+), and scene/channel cardinality (AM4 4x4 / II 8x2 / III 8x4). Modifier wiring is deferred.',
      'Three modes mirror apply_preset: dry_run=true OR no target_location = translator-only preview (no wire ops); target_location + save_authorized:false = translate + audition; target_location + save_authorized:true = translate + apply + SAVE (DESTRUCTIVE, explicit save vocab only).',
      'Returns {ok, port_summary, applied_spec, warnings, apply_result?}. Performance: ~5 ms translator + ~1-3 s apply when target_location is set.',
    ].join(' '),
    inputSchema: {
      source_port: z.string().describe(`Source device port (the preset's home device). ${PORT_DESC}`),
      source_spec: presetShape.describe('Source preset specification (slots, optional scenes, optional name) in the SOURCE device\'s vocabulary. Param names + enum strings should match what the source device accepts; the translator handles the cross-device rewrite.'),
      target_port: z.string().describe(`Target device port (where the translated preset lands). Must differ from source_port. ${PORT_DESC}`),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional navigation target on the target device. Omit (or pass dry_run=true) to get just the translated spec back without firing any wire op. Set to a location for mode-2 (audition) or mode-3 (save with save_authorized=true).',
      ),
      dry_run: z.boolean().optional().describe(
        'When true, returns the translated spec + summary without applying. Default false. Always-true effective when target_location is omitted.',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set to true ONLY when the user used explicit save-language. See apply_preset.save_authorized for the full rules; the same anti-patterns apply here.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
    },
  }, async ({ source_port, source_spec, target_port, target_location, dry_run, save_authorized, on_active_preset_edited }) => {
    try {
      const result = await executePortPreset({
        source_port,
        source_spec: source_spec as PresetSpec,
        target_port,
        target_location,
        dry_run,
        save_authorized,
        on_active_preset_edited,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('restore_defaults', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'DESTRUCTIVE: reset preset locations to factory state. Overwrites user content with no working-buffer recovery. Always run scan_locations first and get explicit user approval before clobbering non-empty slots.',
      'Two shapes: pass only `from` for one location; pass `from` + `to` for an inclusive range (max 26 per call).',
      '- Working buffer + active location pointer untouched; the user can keep playing while the restore runs.',
      '- Range options: on_error stop/continue, dry_run, verify (default true; empty post-restore name is a hard fail).',
      '- Performance: ~350 ms per location. 20 slots = ~5-7 s.',
      '- See describe_device.capabilities.supports_factory_restore.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      from: z.union([z.string(), z.number()]).describe(
        'Single target, or inclusive start of a range (e.g. "G01" or 24).',
      ),
      to: z.union([z.string(), z.number()]).optional().describe(
        'Inclusive end of a range. Omit for single-location restore.',
      ),
      on_error: z.enum(['stop', 'continue']).optional().describe(
        'Range only. "stop" (default) halts on first error; "continue" logs and proceeds.',
      ),
      dry_run: z.boolean().optional().describe(
        'Range only. Validate without sending any wire bytes.',
      ),
      verify: z.boolean().optional().describe(
        'Read name pre/post and compare. Default true.',
      ),
    },
  }, async ({ port, from, to, on_error, dry_run, verify }) => {
    try {
      const result = await executeRestoreDefaults({ port, from, to, on_error, dry_run, verify });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
