/**
 * Preset tools: full-preset apply, get, and translate.
 *
 * Tools registered here:
 *   - `get_preset(port)`
 *   - `apply_preset(port, spec, target_location?)`
 *   - `translate_preset(source_port, source_spec, target_port)`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  executeApplyPreset,
  executeExportActivePreset,
  executeExportStoredPreset,
  executeGetPreset,
  executePortPreset,
  executeReadSampleDirectory,
  executeRestorePreset,
} from '../dispatcher.js';
import type { PresetSpec } from '../types.js';
import {
  ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA,
  SAVE_AUTHORIZED_SCHEMA,
  buildSaveAuthorizedDescription,
} from '../../server-shared/safeEdit.js';

import { PORT_DESC, asError, asText, buildPresetShape, buildPresetSlotShape } from './shared.js';

/** Collapse anything filesystem-unfriendly to underscores; bound the length. */
function sanitizeForFilename(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'preset';
}

/** Filesystem-safe local timestamp, e.g. `2026-06-03_12-53-18`. */
function backupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace('T', '_')
    .replace(/:/g, '-');
}

export function registerPresetTools(server: McpServer): void {
  const presetShape = buildPresetShape();

  // ── outputSchema reuse (2026-05-22 MCP migration) ────────────────
  //
  // Shared sub-schemas for tool output. We declare them once at
  // registration time so the wire envelope stays consistent across
  // apply_preset / get_preset.
  //
  // Per the 2025-11-25 spec these schemas are advisory: the model uses
  // them to plan invocations; clients SHOULD (not MUST) validate at
  // runtime. The runtime `asText` helper still emits the JSON in a
  // text content block as the spec's backwards-compat path, so
  // structuredContent + outputSchema is additive; older clients
  // continue to work against the text payload unchanged.

  const validationErrorShape = z.object({
    slot_index: z.number().int().optional(),
    scene_index: z.number().int().optional(),
    routing_index: z.number().int().optional(),
    path: z.string(),
    error: z.string(),
    suggestion: z.string().optional(),
    suggestions: z.array(z.string()).optional(),
    suggested_substitution: z.string().optional(),
    valid_options: z.array(z.string()).optional(),
  });

  const validationInfoShape = z.object({
    slot_index: z.number().int().optional(),
    scene_index: z.number().int().optional(),
    path: z.string(),
    info: z.string(),
    alias_used: z.string().optional(),
    original_value: z.string().optional(),
    canonical: z.string().optional(),
    level: z.enum(['info', 'warning']).optional(),
    dropped_param: z.string().optional(),
    reason: z.string().optional(),
    retry_action: z.string().optional(),
  });

  const failedStepShape = z.object({
    index: z.number().int(),
    description: z.string(),
    error: z.string(),
  });

  const chainIntegrityShape = z.object({
    ok: z.boolean(),
    breaks: z.array(z.object({
      slot_ref: z.unknown(),
      reason: z.string(),
    })),
    notes: z.array(z.object({
      slot_ref: z.unknown(),
      note: z.string(),
    })).optional(),
    summary: z.string(),
    extra_round_trips: z.number().int(),
  });

  const nackedStepShape = z.object({
    index: z.number().int(),
    description: z.string(),
    error: z.string(),
    kind: z.string(),
  });

  const applyPresetOutputShape = {
    ok: z.boolean(),
    steps: z.number().int(),
    duration_ms: z.number(),
    failed_step: failedStepShape.optional(),
    nacked_steps: z.array(nackedStepShape).optional(),
    warning: z.string().optional(),
    saved: z.boolean().optional(),
    validation_errors: z.array(validationErrorShape).optional(),
    validation_info: z.array(validationInfoShape).optional(),
    chain_integrity: chainIntegrityShape.optional(),
    applied_spec: z.unknown().optional(),
    recipe_id: z.string().optional(),
    device: z.string(),
  };
  server.registerTool('get_preset', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Snapshot the active working buffer: every placed block with current params in a PresetSpec-shaped envelope. Use for state-anchoring before a tone edit (read, summarize, propose, then targeted set_param / set_params). Default: active-channel params only. Pass include_channel_state: true for the per-channel nested shape (params_by_channel; II X/Y, AM4 A/B/C/D). Use instance on set_param/set_params to target a specific block (e.g. Amp 2). Scope: active scene only; no scenes 2..N, no routing. GEN-3 (Axe-Fx III / FM3 / FM9): pass `location` (integer preset number) to read a STORED preset and get the FULL decoded patch in `whole_preset` (routing grid, per-channel A/B/C/D block types, all 8 scene names plus per-scene bypass/channel, amp model plus knobs, modifiers, scene controllers; FM9-confirmed). Without location, gen-3 live read: `live_grid` = positioned routing (fn=0x01 sub=0x2E); `slots` = per-block param values; `live_meters.cpu_percent` = the preset\'s DSP/CPU load (answer "how much headroom?"); `active_scene` = current scene index. Performance: II ~2 s; AM4 ~0.3 s; gen-3 location read ~1-2 s. Hydra returns capability_not_supported. DO NOT feed the snapshot back into apply_preset (FRESH-BUILD clears unlisted slots plus scenes); use set_param / set_params for changed knobs. Re-call to verify.',
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      include_channel_state: z
        .boolean()
        .optional()
        .describe(
          'II: default false returns active-channel state only (fast, ~2 s). Pass true for the full per-channel X/Y nested shape (adds a per-param read per channel-bearing block; markedly slower). AM4: default false returns active-channel only (~0.3 s); pass true to read all channels (B/C/D), a per-param read per channel that can take several seconds.',
        ),
      location: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'gen-3 only (Axe-Fx III / FM3 / FM9): stored preset number to read instead of the active buffer. Dumps that stored slot (fn=0x03) and returns the full decoded patch in `whole_preset`. Ignored on II/AM4/Hydra (they read the active buffer).',
        ),
    },
  }, async ({ port, include_channel_state, location }) => {
    try {
      const locNum =
        location === undefined
          ? undefined
          : typeof location === 'number'
            ? location
            : Number.parseInt(String(location), 10);
      if (locNum !== undefined && (!Number.isInteger(locNum) || locNum < 0)) {
        return asError(new Error(`get_preset: location must be a non-negative integer, got ${JSON.stringify(location)}`));
      }
      const result = await executeGetPreset({ port, include_channel_state, location: locNum });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('export_preset', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Back up a preset to a byte-exact file on disk. Two modes: (1) omit `location` to dump the ACTIVE working-buffer preset, including unsaved edits (AM4, Axe-Fx II, gen-3 family; Hydrasynth and Axe-Fx Standard/Ultra return capability_not_supported); (2) pass `location` as an integer preset index to dump that STORED slot from device flash without touching the working buffer (AM4: 0..103 = A01..Z04; gen-3: 0-based preset number, FM9 wire-confirmed; Circuit Tracks: project slot 0..63, a byte-exact `.ncs` project, the read half of upload_project, where an empty slot reports `empty:true` and writes no file). Fractal dumps are `.syx` (sync via `directory` to OneDrive, reload in the manufacturer's editor; AM4 and Axe-Fx II also restore via import_preset, gen-3 does not); a Circuit dump is `.ncs` (restore via upload_project). Writes to `directory`, else a `mcp-midi-backups` folder under the user's home. Returns file_path, byte_length, frame_count, and a `source` field. Does NOT write to hardware.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      location: z.union([z.string(), z.number()]).optional().describe(
        'Optional stored preset location to export (integer index, 0-based). When given, exports that stored slot directly from device flash, leaving the working buffer untouched; when omitted, exports the active working-buffer preset. Stored-location export: AM4 (0..103 = A01..Z04, e.g. M03 = 12*4+2 = 50), gen-3 (Axe-Fx III / FM3 / FM9 / VP4), and Circuit Tracks (project slot 0..63). Active-buffer export also works on the Axe-Fx II. Circuit Tracks has no active buffer to export, so always pass a project slot.',
      ),
      directory: z.string().optional().describe(
        'Destination folder for the backup file (.syx, or .ncs for Circuit Tracks). Optional. Defaults to a `mcp-midi-backups` folder under the user\'s home directory. Point this at a cloud-synced folder (e.g. a OneDrive path) so backups reach the user\'s other devices. Created if it does not exist.',
      ),
    },
  }, async ({ port, location, directory }) => {
    try {
      let dump: Awaited<ReturnType<typeof executeExportActivePreset>>;
      if (location !== undefined) {
        const locNum = typeof location === 'number' ? location : parseInt(String(location), 10);
        if (!Number.isInteger(locNum) || locNum < 0) {
          return asError(new Error(`export_preset: location must be a non-negative integer, got ${JSON.stringify(location)}`));
        }
        dump = await executeExportStoredPreset({ port, location: locNum });
      } else {
        dump = await executeExportActivePreset({ port });
      }
      // An EMPTY stored slot (Circuit project slots can be empty) is a clean
      // read-before-write answer, not a backup; report it, write no file.
      if (dump.empty) {
        return asText({
          ok: true,
          empty: true,
          device: dump.device,
          source: dump.source,
          message: `Nothing was exported: ${dump.source ?? 'the requested location is empty'}. No backup file written.`,
        });
      }
      const baseDir = directory !== undefined && directory.trim().length > 0
        ? directory.trim()
        : path.join(homedir(), 'mcp-midi-backups');
      await mkdir(baseDir, { recursive: true });
      // Most devices dump a Fractal `.syx`; a device whose native container
      // differs (Circuit Tracks `.ncs`) declares its own extension.
      const ext = dump.file_extension ?? 'syx';
      const fileName = `${sanitizeForFilename(dump.device)}-${sanitizeForFilename(dump.name ?? 'preset')}-${backupTimestamp()}.${ext}`;
      const filePath = path.join(baseDir, fileName);
      await writeFile(filePath, Buffer.from(dump.bytes));
      return asText({
        ok: true,
        file_path: filePath,
        directory: baseDir,
        file_name: fileName,
        device: dump.device,
        name: dump.name,
        source: dump.source,
        ...(dump.warning !== undefined ? { warning: dump.warning } : {}),
        byte_length: dump.byte_length,
        frame_count: dump.frame_count,
        format: dump.format,
      });
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('list_samples', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: "Read a device's named sample pool and return each slot's stored name (the sampler-archetype \"what's in the pool\" read; the names author_kit / the groove packer reference). Circuit Tracks: the active Pack's shared 64-slot drum-sample pool (the 4 drum tracks pick from it), read over MIDI, so it needs a bidirectional connection (close Novation Components so the port is free) and takes a few seconds (probes all 64 slots). SPD-SX (WAVE MGR storage mode): the wave pool read from the mounted drive (can be hundreds of waves). So you can see what each slot holds by name (\"kick\", \"snare\", \"closed hat\") and map sounds semantically. Read-only; sends no write. Returns { occupied, total, slots:[{slot, device_slot, name}] }; name is omitted for empty slots. Devices without a named sample pool (Fractal, Hydrasynth) return capability_not_supported.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
    },
  }, async ({ port }) => {
    try {
      return asText(await executeReadSampleDirectory({ port }));
    } catch (err) {
      return asError(err);
    }
  });

  // Overrides shape is a partial PresetSpec: same per-slot shape (so the
  // block-type union + typed params.type enums apply), but `slots` is
  // optional and may be empty (recipe carries the base; overrides may
  // tweak knobs or append slots). Reuses the same factory so future
  // schema evolution stays in sync.
  const overridesSlotShape = buildPresetSlotShape();
  const overridesShape = z.object({
    slots: z.array(overridesSlotShape).optional(),
    scenes: presetShape.shape.scenes,
    name: presetShape.shape.name,
    landingScene: presetShape.shape.landingScene,
    routing: presetShape.shape.routing,
  });

  server.registerTool('apply_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Build or replace the entire working-buffer preset in one call. Single-knob tweak: use set_param. One block on a linear device: use set_block. Re-apply a byte-exact backup: use import_preset. RECIPES FIRST: scan describe_device(port).recipes[] for a block_stack match and apply via `recipe_id` (+ `overrides`); pasting recipe slots by hand is the dominant failure mode. Modes: `spec` (full author), `recipe_id` (verbatim), `recipe_id`+`overrides` (deep-merged). PITFALLS: FRESH-BUILD, unlisted slots clear and unlisted scenes reset. Slot is integer 1..4 (linear) or {row,col} (grid). Multi-instance blocks use canonical id (`amp`, `amp_2`), not display names. Grid routing[] must end with `{to:"OUTPUT"}`. Type-gated knobs silently drop; when the user names specific knobs, call find_compatible_types first. RESPONSE: ok:true succeeded, do NOT retry. validation_info[] level:"info" = auto-resolved (alias, case fix); level:"warning" needs action (channel-Y inactive, dropped params). ok:false with validation_errors[] = zero writes fired, fix and re-invoke. (1-3 s, +250 ms with save.)',
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      spec: presetShape.optional().describe(
        'Preset specification (slots, optional scenes, optional name). Required when `recipe_id` is NOT set; rejected when `recipe_id` IS set (use `overrides` to merge tweaks on top of a recipe instead).',
      ),
      recipe_id: z.string().optional().describe(
        'Apply a pre-authored block-stack recipe by id. The recipe\'s `slots_per_device[port]` becomes the base spec; merge knob tweaks via `overrides`. Discover available ids via `describe_device(port).recipes[].id`. Single-block recipes (auto_wah, pitch, wah, filter, scene_leveling) ship inline in describe_device and apply via set_block / set_param, not via this arg.',
      ),
      overrides: overridesShape.optional().describe(
        'Knob / slot / scene / name overrides merged on top of `recipe_id`. Per-slot deep merge keyed by `slot` ref (linear int OR {row,col}): overrides win on conflicting keys, recipe keys not in overrides survive. Override slot whose ref matches no recipe slot is appended. Scenes / name / landingScene / routing in overrides REPLACE the recipe\'s values entirely (recipes today don\'t author scenes). Ignored when `recipe_id` is not set.',
      ),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional navigation target. With save_authorized=false (default): navigate + apply (audition, no save). With save_authorized=true: navigate + apply + save (destructive). Omit to apply at the current working-buffer location.',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set true ONLY for explicit save vocab: "save", "store", "keep", "put on", "persist". AUDITION language (NOT save): "build a preset at X", "make me a tone on X", "design a preset at X", "make X look/sound like Y". State descriptions ("I want X to be Z") are audition unless save vocab is added. When ambiguous, audition (false) and ASK before saving; saves are destructive, auditions are reversible by switching presets.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
      verify_chain: z.boolean().optional().describe(
        'Run a read-after-write chain integrity check after the apply ops ack. DEFAULTS ON when the spec includes explicit routing[] edges (a non-linear path is where a broken cable is most likely); otherwise defaults off. Pass true/false to override either way. On the Axe-Fx II the check reads the working-buffer grid and surfaces any cell past col 1 with `routing_mask == 0` (broken cable, signal won\'t flow). Devices without an implemented chain read (AM4, Hydrasynth, and the gen-3 family for now) return a trivial pass. On a returned chain_break, surface the broken cells to the user (with their row/col) BEFORE claiming the preset is ready to play. Adds ~50-100 ms per call on grid devices.',
      ),
    },
    outputSchema: applyPresetOutputShape,
  }, async ({ port, spec, recipe_id, overrides, target_location, save_authorized, on_active_preset_edited, verify_chain }) => {
    try {
      const result = await executeApplyPreset({
        port,
        spec: spec as unknown as PresetSpec | undefined,
        recipe_id,
        overrides: overrides as unknown as Partial<PresetSpec> | undefined,
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

  server.registerTool('import_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Re-apply a byte-exact preset backup (a `.syx` written by export_preset) to the device. The inverse of export_preset. SAME-DEVICE-MODEL only: the bytes are that device's native dump, so an Axe-Fx II backup restores to an Axe-Fx II, an AM4 backup to an AM4 (to move a tone across devices, use apply_preset + translate_preset instead). Default pushes to the WORKING BUFFER (reversible by switching presets); with target_location + save_authorized it persists to that stored location. Validates every frame's checksum before sending. Available on Fractal AM4 + Axe-Fx II; other devices return capability_not_supported. Returns { ok, frames_sent, acks_received, nacks[], name?, saved_to_location? }.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      file_path: z.string().describe(
        'Absolute path to the `.syx` backup to re-apply (the `file_path` export_preset returned). Must be a dump from THIS device model.',
      ),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional stored location to persist the restored preset to (requires save_authorized). Omit to restore to the working buffer only (reversible). AM4: restore-to-location is not yet supported (working buffer only).',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set true ONLY with explicit save vocab ("save", "store", "keep", "put on"). With target_location, persists the restored bytes to that location (destructive overwrite). Default false = working-buffer restore (reversible).',
      ),
    },
  }, async ({ port, file_path, target_location, save_authorized }) => {
    try {
      const bytes = new Uint8Array(await readFile(file_path.trim()));
      const result = await executeRestorePreset({ port, bytes, target_location, save_authorized });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('translate_preset', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Translate a preset between layout-class devices (AM4 / Axe-Fx II / III / FM3 / FM9). Pure transform: returns the translated spec + warnings; does NOT apply, audition, or save. To write it, take the returned applied_spec and call apply_preset(target_port, spec). Source TWO ways: (1) source_spec, a preset you already have in the SOURCE device vocab; or (2) source_location (gen-3 only: Axe-Fx III / FM3 / FM9), a STORED preset number the server reads from the source device, decodes (grid, per-channel block types, scenes, amp model + knobs), and translates in one call. Pass exactly one. Bridges chain topology (linear slots to grid), block availability (II/III cab vs AM4 integrated), param aliases, enum mappings, channel collapse (A/B/C/D to X/Y), and scene count (4 vs 8). gen-3 caveat: non-amp knob values aren\'t decoded (non-amp blocks translate type-only); amp model + knobs carry. Read warnings[] first; gaps are lossy. Returns {ok, port_summary, applied_spec, warnings}.',
    inputSchema: {
      source_port: z.string().describe(`Source device port (the preset's home device). ${PORT_DESC}`),
      source_spec: presetShape.optional().describe(
        'Source preset specification (slots, optional scenes, optional name) in the SOURCE device\'s vocabulary.'
        + ' Param names + enum strings should match what the source device accepts; the translator handles the'
        + ' cross-device rewrite. Pass this OR source_location, not both.',
      ),
      source_location: z.union([z.string(), z.number()]).optional().describe(
        'gen-3 source only (Axe-Fx III / FM3 / FM9): a STORED preset number to read + decode from the source'
        + ' device and use as the source. The one-call alternative to building source_spec by hand. Pass this OR source_spec.',
      ),
      target_port: z.string().describe(
        `Target device port (where the translated preset will land if the caller later applies it).`
        + ` Must differ from source_port. ${PORT_DESC}`,
      ),
    },
  }, async ({ source_port, source_spec, source_location, target_port }) => {
    try {
      const result = await executePortPreset({
        source_port,
        source_spec: source_spec as unknown as PresetSpec | undefined,
        source_location,
        target_port,
        dry_run: true,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

}
