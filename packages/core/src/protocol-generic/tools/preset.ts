/**
 * Preset tools: full-preset apply, get, and translate.
 *
 * Tools registered here:
 *   - `get_preset(port)`
 *   - `apply_preset(port, spec, target_location?)`
 *   - `translate_preset(source_port, source_spec, target_port)`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  backupTimestamp,
  defaultBackupDir,
  recordBackup,
  sanitizeForFilename,
} from '../dispatcher/backupIndex.js';

import {
  executeApplyPreset,
  executeExportActivePreset,
  executeExportStoredPreset,
  executeGetPreset,
  executePortPreset,
  executeReadPackDirectory,
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

import { PACK_DESC, PORT_DESC, asError, asText, buildPresetShape, buildPresetSlotShape } from './shared.js';

// ── outputSchema reuse (2026-05-22 MCP migration) ────────────────
//
// Shared sub-schemas for tool output, declared once at module scope so
// the wire envelope stays consistent across apply_preset / get_preset
// AND so verify-apply-output-schema can strict-parse a maximal
// ApplyResult against the exported shape (the recurrence gate for the
// 2026-07-16 auto_applied incident, see the field comment below).
//
// Per the 2025-11-25 spec these schemas are advisory: the model uses
// them to plan invocations; clients SHOULD (not MUST) validate at
// runtime. The runtime `asText` helper still emits the JSON in a
// text content block as the spec's backwards-compat path, so
// structuredContent + outputSchema is additive; older clients
// continue to work against the text payload unchanged.
//
// ── WHY EVERY OBJECT BELOW IS z.looseObject AND NOT z.object ─────
// (2026-08-02, closing the latent hazard the 2026-07-16 incident left)
//
// The SDK renders a declared outputSchema to JSON Schema with zod's own
// converter (`server/mcp.js` -> `toJsonSchemaCompat(obj, { pipeStrategy:
// 'output' })`), and a plain `z.object` renders as `"additionalProperties":
// false` at EVERY nesting level. The MCP *client* then compiles that JSON
// Schema into an Ajv validator and THROWS `McpError(InvalidParams)` when a
// response fails it (`client/index.js`, `callTool` -> `getToolOutputValidator`).
// Measured against SDK 1.30.0 on 2026-08-02: `z.object` emits
// `"additionalProperties": false` and the validator rejects an unknown key;
// `z.looseObject` emits `"additionalProperties": {}` and the same key passes.
//
// That combination turns an advisory schema into a hard runtime gate that
// fires AFTER the writes have already landed on the hardware. It is what cost
// a full bench day on 2026-07-16: BK-103b added `auto_applied` to ApplyResult,
// the shape below did not learn it, and every apply_preset came back to Claude
// Desktop as a generic "Tool execution failed" with the wire ops already
// committed to the device. apply_preset is destructiveHint AND idempotentHint,
// so the agent's natural reading of that error is that nothing happened and
// the whole build should be sent again.
//
// Only ONE direction of that strictness has a compiler behind it:
//   - A MISSING required key cannot drift silently. `executeApplyPreset` is
//     typed `Promise<ApplyResult & { device: string }>`, so every return path
//     has to carry `ok` / `steps` / `duration_ms` / `device` or the build
//     fails. `required` therefore STAYS: it costs nothing and it documents a
//     guarantee the type system already enforces.
//   - An EXTRA key is precisely the drift nothing catches: adding a field to
//     ApplyResult compiles clean, ships, and fails first at the user's rig.
//     `additionalProperties: false` is that half of the strictness, and it is
//     the half dropped here.
//
// Considered and rejected:
//   (a) Declare outputSchema on all 55 tools so the coverage stops being an
//       accident of history. `tools/list` already measures 172,056 chars and
//       the known live problem on this surface is SIZE; 51 more schemas make
//       a measured problem worse to buy a benefit the spec itself calls
//       advisory.
//   (b) Drop outputSchema from the four tools that declare one. The shapes
//       are load-bearing documentation the tool descriptions lean on
//       (apply_preset's own description sends the agent to `ok`,
//       `validation_errors[]` and `validation_info[].level`), and 51 of 55
//       tools already return structuredContent with no declared shape at all,
//       so keeping four described costs nothing new.
//
// The lockstep discipline does NOT go away with the strictness, it MOVES to
// the build, where a red gate costs a developer a minute instead of costing a
// player a re-sent preset. `scripts/verify-apply-output-schema.ts` now asserts
// both halves: that the emitted JSON Schema is permissive at every level (so
// drift can never reject a real response) and that the shape still tracks the
// result type (so it stays honest documentation).
//
// IF YOU ADD A NESTED OBJECT TO ANY OUTPUT SHAPE, MAKE IT z.looseObject. A
// `z.object` nested inside a loose parent is still rendered
// `additionalProperties: false` and re-opens the hazard one level down.

const validationErrorShape = z.looseObject({
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

  const validationInfoShape = z.looseObject({
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

  const failedStepShape = z.looseObject({
    index: z.number().int(),
    description: z.string(),
    error: z.string(),
  });

  const chainIntegrityShape = z.looseObject({
    ok: z.boolean(),
    breaks: z.array(z.looseObject({
      slot_ref: z.unknown(),
      reason: z.string(),
    })),
    notes: z.array(z.looseObject({
      slot_ref: z.unknown(),
      note: z.string(),
    })).optional(),
    summary: z.string(),
    extra_round_trips: z.number().int(),
  });

  const nackedStepShape = z.looseObject({
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
    // BK-103b: server-injected defaults report. Kept in lockstep with
    // ApplyResult (types.ts) so the declared shape stays honest
    // documentation of what the tool returns. This field is the one that
    // drifted on 2026-07-16 and, back when the schema was strict, made
    // Claude Desktop REJECT the whole response client-side with a generic
    // "Tool execution failed" AFTER the wire writes had landed. The
    // strictness is gone (see the block comment above); the lockstep is
    // not. verify-apply-output-schema strict-parses a maximal ApplyResult
    // against this shape.
    auto_applied: z.looseObject({
      params: z.record(z.string(), z.string()),
      channels: z.array(z.string()).optional(),
      note: z.string(),
    }).optional(),
  };

/**
 * Exported for verify-apply-output-schema's lockstep gate: a maximal
 * `Required<ApplyResult>`-typed literal must strict-parse against this
 * shape, so a new ApplyResult field without a matching schema entry
 * fails the gate instead of shipping a schema that under-describes what
 * the tool actually returns.
 */
export const APPLY_PRESET_OUTPUT_SHAPE = applyPresetOutputShape;

/**
 * The schema apply_preset actually declares, and therefore the exact
 * object `verify-apply-output-schema` renders to JSON Schema when it
 * checks that a client-side validator cannot reject a real response.
 *
 * `z.looseObject`, never `z.object`: see the block comment above.
 */
export const APPLY_PRESET_OUTPUT_SCHEMA = z.looseObject(applyPresetOutputShape);

export function registerPresetTools(server: McpServer): void {
  const presetShape = buildPresetShape();

  server.registerTool('get_preset', {
    title: 'Read Preset',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Snapshot the active working buffer: every placed block with current params in a PresetSpec-shaped envelope. Use for state-anchoring before a tone edit. Default: active-channel params only. Pass include_channel_state: true for the per-channel nested shape (params_by_channel; II X/Y, AM4 A/B/C/D). Use instance on set_param/set_params to target a specific block (e.g. Amp 2). Scope: active scene only; no scenes 2..N, no routing. GEN-3 (Axe-Fx III / FM3 / FM9): pass `location` (integer preset number) to read a STORED preset and get the FULL decoded patch in `whole_preset` (routing grid, per-channel A/B/C/D block types, all 8 scene names plus per-scene bypass/channel, amp model plus knobs, modifiers, scene controllers; FM9-confirmed). Without location, gen-3 live read: `live_grid` = positioned routing (fn=0x01 sub=0x2E); `slots` = per-block param values; `live_meters.cpu_percent` = the preset\'s DSP/CPU load (answer "how much headroom?"); `active_scene` = current scene index. CIRCUIT: `location` (Project 1..64, + `pack`) reads a stored project; `slots` are pattern 1, `pattern_occupancy` lists which of the 8 patterns hold content (a silent pattern 1 is not an empty project). Performance: II ~2 s; AM4 ~0.3 s; gen-3 location read ~1-2 s. Hydra returns capability_not_supported. DO NOT feed the snapshot back into apply_preset (FRESH-BUILD clears unlisted slots plus scenes); use set_param / set_params for changed knobs. Re-call to verify.',
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
      pack: z.number().int().min(1).max(32).optional().describe(`Which pack the numeric \`location\` lives in. A "patch:N" location instead reads the working buffer, which always follows the front-panel pack. ${PACK_DESC}`),
    },
  }, async ({ port, include_channel_state, location, pack }) => {
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
      const result = await executeGetPreset({ port, include_channel_state, location: locNum, pack });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('export_preset', {
    title: 'Export Preset',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Back up a preset to a byte-exact file on disk. Two modes: (1) omit `location` to dump the ACTIVE working-buffer preset, including unsaved edits (AM4, Axe-Fx II, gen-3 family; Hydrasynth and Axe-Fx Standard/Ultra return capability_not_supported); (2) pass `location` as an integer preset index to dump that STORED slot from device flash without touching the working buffer (AM4: 0..103 = A01..Z04; gen-3: 0-based preset number, FM9 wire-confirmed; Circuit Tracks: Project 1..64, a byte-exact `.ncs`, the read half of upload_project, where an empty slot reports `empty:true` and writes no file). Fractal dumps are `.syx` (sync via `directory` to OneDrive, reload in the manufacturer's editor; AM4 and Axe-Fx II also restore via import_preset, gen-3 does not); a Circuit dump is `.ncs` (restore via upload_project). Writes to `directory`, else a `mcp-midi-backups` folder under the user's home. Returns file_path, byte_length, frame_count, and a `source` field. Does NOT write to hardware.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      location: z.union([z.string(), z.number()]).optional().describe(
        'Optional stored preset location to export (integer index). When given, exports that stored slot directly from device flash, leaving the working buffer untouched; when omitted, exports the active working-buffer preset. Stored-location export: AM4 (0..103 = A01..Z04, e.g. M03 = 12*4+2 = 50), gen-3 (Axe-Fx III / FM3 / FM9 / VP4), and Circuit Tracks (Project 1..64). Active-buffer export also works on the Axe-Fx II. Circuit Tracks has no active buffer to export, so always pass a project slot.',
      ),
      pack: z.number().int().min(1).max(32).optional().describe(`Which pack the numeric \`location\` lives in. A "patch:N" location instead reads the working buffer, which always follows the front-panel pack. ${PACK_DESC}`),
      directory: z.string().optional().describe(
        'Destination folder for the backup file (.syx, or .ncs for Circuit Tracks). Optional. Defaults to a `mcp-midi-backups` folder under the user\'s home directory. Point this at a cloud-synced folder (e.g. a OneDrive path) so backups reach the user\'s other devices. Created if it does not exist.',
      ),
    },
  }, async ({ port, location, pack, directory }) => {
    try {
      let dump: Awaited<ReturnType<typeof executeExportActivePreset>>;
      if (location !== undefined) {
        const locNum = typeof location === 'number' ? location : parseInt(String(location), 10);
        if (!Number.isInteger(locNum) || locNum < 0) {
          return asError(new Error(`export_preset: location must be a non-negative integer, got ${JSON.stringify(location)}`));
        }
        dump = await executeExportStoredPreset({ port, location: locNum, pack });
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
        : defaultBackupDir();
      await mkdir(baseDir, { recursive: true });
      // Most devices dump a Fractal `.syx`; a device whose native container
      // differs (Circuit Tracks `.ncs`) declares its own extension.
      const ext = dump.file_extension ?? 'syx';
      const fileName = `${sanitizeForFilename(dump.device, 'device')}-${sanitizeForFilename(dump.name ?? 'preset', 'preset')}-${backupTimestamp()}.${ext}`;
      const filePath = path.join(baseDir, fileName);
      await writeFile(filePath, Buffer.from(dump.bytes));
      // Index it so list_backups can find this file later. A backup the user
      // cannot locate is not much of a backup. Never throws.
      recordBackup(baseDir, {
        file_name: fileName,
        device: dump.device,
        unit: location === undefined ? 'active_buffer' : 'preset',
        location: location === undefined ? undefined : (typeof location === 'number' ? location : String(location)),
        pack,
        name: dump.name,
        format: dump.format,
        byte_length: dump.byte_length,
        created_at: new Date().toISOString(),
        tool: 'export_preset',
      });
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

  server.registerTool('list_packs', {
    title: 'List Packs',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: "List the storage PACKS a device holds, by name. Circuit Tracks: the microSD card's packs (up to 32), each a COMPLETE separate world of 64 projects, 128 patches, and 64 samples. Read-only, one round trip over MIDI, so it needs a bidirectional connection (close Novation Components so the port is free). CALL THIS BEFORE any pack-addressed write (apply_pattern / upload_project with `pack`): the server CANNOT detect which pack the device currently has selected, and the same slot number exists in every pack, so this is the only way to see which packs exist, what they are called, and which one to aim at. Returns { count, packs:[{pack, name, wire_index}] }, where `pack` is the 1-based number the front panel shows AND exactly the value the `pack` arg takes (pass it straight through; ignore wire_index, which is diagnostic). An empty pack is the safe target for new work. Devices that do not store content in packs (Fractal, Hydrasynth, SPD-SX) return capability_not_supported.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
    },
  }, async ({ port }) => {
    try {
      return asText(await executeReadPackDirectory({ port }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('list_samples', {
    title: 'List Samples',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: "Read a device's named sample pool and return each slot's stored name (the sampler-archetype \"what's in the pool\" read; the names author_kit / the packer reference). Circuit Tracks: a pack's shared 64-slot drum-sample pool (the 4 drum tracks pick from it), read over MIDI, needs a bidirectional connection (close Novation Components so the port is free). Pass `pack` (1-based; default Pack 1) to read a SPECIFIC pack: read the SAME pack you will write the project to, or its drum bindings resolve against a different pool and the wrong samples play. Pack 1 and every nonzero pack are hardware-confirmed for reads. SPD-SX (WAVE MGR storage mode): the wave pool read from the mounted drive (hundreds of waves; not pack-addressed). Names each slot (\"kick\", \"snare\", \"closed hat\") so sounds map semantically. Read-only. Returns { occupied, total, pack?, slots:[{slot, device_slot, name}] }; name omitted for empty slots. Devices without a named pool (Fractal, Hydrasynth) return capability_not_supported.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      pack: z.number().int().min(1).max(32).optional().describe(`Which pack's sample pool to read. Read the SAME pack you will write the project to, or its drum bindings resolve against a different pool. ${PACK_DESC}`),
    },
  }, async ({ port, pack }) => {
    try {
      return asText(await executeReadSampleDirectory({ port, pack }));
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
  // ── WHY THIS ONE IS z.looseObject WHILE THE OUTPUT SHAPES ARE TOO ─────
  //
  // Same keyword, OPPOSITE reason, and conflating the two is how this gets
  // reverted. The `looseObject` rule in TOOL-AUTHORING-GUIDE is about
  // **outputSchema**: a closed OUTPUT schema makes the client's Ajv validator
  // throw AFTER the hardware write already landed. It says nothing about
  // inputs.
  //
  // On an INPUT, `z.object` does not reject an unknown key — it SILENTLY
  // STRIPS it, before the handler ever sees it. Measured in the trace corpus:
  // 3 of the 23 apply_preset calls that passed `overrides` used a flat
  // `{"amp.type": "...", "reverb.type": "..."}` shape instead of `slots[]`.
  // Every key was dropped, the call returned ok:true, and in all three the
  // agent then told the user the value HAD been applied and asked them to
  // confirm it on the front panel. Nothing was ever sent.
  //
  // So: loose here so unknown keys REACH the handler, and
  // `executeApplyPreset` rejects them with a message that teaches the shape
  // (see `rejectUnknownSpecKeys` in dispatcher/preset.ts). Making this
  // `z.object`/`.strict()` again re-opens a defect where the agent
  // confidently reports a device change that never happened.
  const overridesShape = z.looseObject({
    slots: z.array(overridesSlotShape).optional(),
    scenes: presetShape.shape.scenes,
    name: presetShape.shape.name,
    landingScene: presetShape.shape.landingScene,
    routing: presetShape.shape.routing,
  });

  server.registerTool('apply_preset', {
    title: 'Build Preset',
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
        'Knob / slot / scene / name overrides merged on top of `recipe_id`. SAME SHAPE AS `spec` (slots[]/scenes/name/landingScene/routing), never flat `"amp.type"` keys: an unrecognised key is REFUSED, not applied. Per-slot deep merge keyed by `slot` ref (linear int OR {row,col}): overrides win on conflicting keys, recipe keys not in overrides survive. A slot ref matching NO recipe slot is APPENDED, not merged, so a guessed ref silently adds a block instead of changing one; read the recipe\'s real refs first from describe_device({port, recipe:id}).slots. Scenes / name / landingScene / routing in overrides REPLACE the recipe\'s values entirely (recipes today don\'t author scenes). Ignored when `recipe_id` is not set.',
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
    outputSchema: APPLY_PRESET_OUTPUT_SCHEMA,
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
    title: 'Restore Preset',
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
    title: 'Translate Preset',
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
