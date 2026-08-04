/**
 * Stored-content tools: putting content INTO a device's stored slots, and (for
 * the one device that can) taking it back out. Dispatch by `port`.
 *
 *   - upload_sample , write one WAV to a drum-sample slot (1..64).
 *   - upload_kit    , write a folder of WAVs to consecutive slots in one batch.
 *   - author_kit    , build a sampler kit and write it to a kit location.
 *   - upload_project, send a whole prepared project to a project slot.
 *   - delete_project, ERASE stored projects. The inverse verb, and the only
 *     tool here that leaves a slot with nothing in it.
 *
 * `delete_project` lives beside `upload_project` on purpose: they are inverse
 * verbs on the same unit, and an agent reading one should see the other. Its
 * gates are stricter than every upload's, because an upload replaces content
 * while a delete removes it, on hardware with no undo. See
 * `dispatcher/deleteProject.ts` and `docs/SAFE-EDIT-WORKFLOW.md`.
 *
 * The 64 sample slots are the shared DRUM pool the 4 drum tracks pick from
 * (synths use patches, not samples). WAVs are normalized to the device's
 * 48 kHz / mono / 16-bit format on upload. The wire frames are decoded byte-
 * exact from real Novation Components captures. Replaces the manual Components
 * web-app workflow.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executeAuthorKit, executeUploadSample, executeUploadKit, executeUploadProject } from '../dispatcher/uploads.js';
import { executeDeleteProject, MAX_DELETES_PER_CALL } from '../dispatcher/deleteProject.js';
import { PACK_DESC, PORT_DESC, asError, asText } from './shared.js';

// ── delete_project's declared output shape ──────────────────────────
//
// Hoisted to module scope (it was inline on the registration until
// 2026-08-02) so `scripts/verify-apply-output-schema.ts` can gate it the same
// way it gates apply_preset's: the shape must stay in lockstep with
// `ProjectDeleteOutcome` (types.ts), and the JSON Schema the SDK renders from
// it must stay permissive.
//
// EVERY LEVEL IS z.looseObject, NOT z.object. Full reasoning lives in one
// place, the block comment in `tools/preset.ts` above `validationErrorShape`.
// The short version: the SDK renders a plain `z.object` as
// `"additionalProperties": false` at every nesting level, and the MCP client
// compiles that into an Ajv validator and THROWS on any key the schema does
// not name. On this tool that error would arrive after projects had already
// been erased from the card, with the backups already written, and the agent
// would have no way to tell a failed erase from a successful one it was not
// allowed to read. Adding a field to ProjectDeleteOutcome must never be able
// to produce that.
const deleteProjectResultShape = z.looseObject({
  slot: z.number(),
  ok: z.boolean(),
  name: z.string().optional().describe('What was in the slot, read before it was erased.'),
  backup_path: z.string().optional().describe('The pre-delete backup. Feed this to upload_project to put it back.'),
  gone_by_query: z.boolean().optional().describe('The device\'s own per-file query says the file is gone.'),
  gone_by_directory: z.boolean().optional().describe('A fresh read of the pack directory no longer lists the slot.'),
  matches_free_control: z.boolean().optional().describe('The slot now answers byte-for-byte like a slot the device reports as empty. Absent when the pack had no empty slot to compare against.'),
  error: z.string().optional().describe('Why this project was not erased, or why the erase could not be confirmed. A slot with an error is UNKNOWN, not empty and not intact: re-read it, do not re-send.'),
});

const deleteProjectOutputShape = {
  ok: z.boolean().describe('True only when every named project was confirmed erased by all available checks.'),
  pack: z.number().describe('The pack this call addressed, as the device numbers it.'),
  deleted: z.array(deleteProjectResultShape).describe('One entry per named project, in the order requested.'),
  info: z.string().describe('What was destroyed, where the backups are, and how to undo it.'),
  warning: z.string().optional().describe('Present when any project was not confirmed erased. Surface it to the user before claiming success.'),
};

/**
 * Exported for verify-apply-output-schema's lockstep gate: a maximal
 * `Required<ProjectDeleteOutcome>`-typed literal must strict-parse
 * against this shape.
 */
export const DELETE_PROJECT_OUTPUT_SHAPE = deleteProjectOutputShape;

/** The schema delete_project actually declares. Loose, never strict. */
export const DELETE_PROJECT_OUTPUT_SCHEMA = z.looseObject(deleteProjectOutputShape);

export function registerUploadTools(server: McpServer): void {
  server.registerTool('upload_sample', {
    title: 'Upload Sample',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      'Add a WAV to a device sample pool. Two pool styles, by device.',
      'CIRCUIT TRACKS (slot-addressed): `slot` is REQUIRED (1..64, the shared drum pool the 4 drum tracks pick from); this OVERWRITES that slot. The WAV is normalized to 48 kHz mono 16-bit on upload.',
      'SPD-SX (append-only, WAVE MGR storage mode): OMIT `slot`; the wave is appended at the next free index (reported in the result), referenced later from author_kit by that index or name. Any uncompressed PCM/float WAV is accepted and normalized to 44.1 kHz / 16-bit on import (resampled + requantized, mono/stereo preserved); pre-convert tonal material with `bouncer spdsx` for higher quality.',
      'OVERWRITE GATE (slot-addressed pools): the slot cannot be read to check occupancy, so the tool REFUSES by default. Pass `confirm_overwrite: true` ONLY on user save/overwrite/replace language. Append-only pools never overwrite, so the gate does not apply.',
      'Takes several seconds. No readback: confirm by ear; power-cycle SPD-SX to pick up new files.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      file: z.string().describe('Path to a .wav file on the machine running this server (a local disk path, not a chat-sandbox file). Any rate/channels; normalized on upload (Circuit -> 48k mono 16-bit; SPD-SX -> 44.1k 16-bit, channels preserved).'),
      slot: z.number().int().min(1).max(64).optional().describe('Destination sample slot, 1..64 (Circuit Tracks: REQUIRED, overwrites that slot). OMIT on SPD-SX (append-only: lands at the next free index).'),
      name: z.string().optional().describe('Name shown on the device. Default: the file\'s basename. (SPD-SX names are <=12 chars; longer ones truncate with a warning.)'),
      pack: z.number().int().min(1).max(32).optional().describe(`Which pack to write to. Write the SAME pack the project that binds this slot targets, or the project resolves its drum bindings against a different pool. ${PACK_DESC}`),
      confirm_overwrite: z.boolean().optional().describe('Overwrite gate (slot-addressed pools only). Pass true ONLY when the user authorized overwriting the slot. Ignored on append-only pools.'),
    },
  }, async ({ port, file, slot, name, pack, confirm_overwrite }) => {
    try {
      return asText(await executeUploadSample({ port, file, slot, name, pack, confirm_overwrite }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('author_kit', {
    title: 'Author Kit',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      'Author a sampler KIT (a pad-to-wave map) and write it to a stored kit location. The sampler-archetype whole-preset write (Roland SPD-SX). The kit IS the preset, addressed by location; no audition buffer, so this writes the device file directly.',
      '`location` is the kit number (SPD-SX: 1..100). `pads` is the per-pad assignment IN PAD ORDER: each entry is a wave index (number) or a wave name (string, resolved against the pool via list_samples), or -1 / "empty" for an empty pad. SPD-SX pads 1-9 are the main pads, 10-15 external trigger inputs.',
      'PER-PAD PROPERTIES (object form): instead of a bare wave, pass `{ wave, note?, voice?, mute_group?, dynamics?, sub_wave? }` to set the pad MIDI trigger note (lines up with a Circuit MIDI 1/2 sequence; defaults ascend from 60 by pad order), voice ("poly" = overlapping trails for HAT ROLLS, "mono" = each hit chokes the last), mute_group 0..9 (0=off; same group cuts each other off, e.g. open vs closed hat), and dynamics (velocity to volume). Any object pad switches to the device full-kit format (decoded byte-exact, FX off; device acceptance of a server-authored full kit is community-beta, confirm by ear).',
      'Import the waves first with upload_sample (returns the indices). OVERWRITE GATE: refuses an occupied kit unless `confirm_overwrite: true` (backs the prior kit up first). `dry_run: true` builds + validates + previews without writing.',
      'RE-AUTHORING MERGES over the existing kit: any per-pad field you do NOT name (level, note, mute group, dynamics, voice) and the FX header keep their current values, so swapping one wave cannot flatten a balanced kit. The result reports what it kept and flags any pad whose wave changed under an inherited level (measured for the old sample).',
      'PATCH MODE (surgical note edit): pass `set_notes` ({ "<pad 1-15>": note 0..127 }, e.g. {"7":60}) instead of name+pads to change ONLY notes, touching nothing else. Full kits only: a minimal (Wv-only) kit is refused (a note would force the level-changing format; set those on the device PAD MIDI menu). get_preset shows if a kit is minimal.',
      'SPD-SX is in WAVE MGR storage mode for this (not AUDIO/MIDI). Power-cycle the unit afterwards to load the new kit. Confirm by ear.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      location: z.union([z.number().int(), z.string()]).describe('Kit location to write (device numbering; SPD-SX 1..100).'),
      name: z.string().optional().describe('Kit name (SPD-SX: <=8 printable-ASCII chars). Required to BUILD a kit; omit in set_notes patch mode.'),
      set_notes: z.record(z.string(), z.number().int().min(0).max(127)).optional().describe('PATCH mode: set per-pad notes on the EXISTING kit non-destructively. Map of pad number "1".."15" → MIDI note 0..127, e.g. {"7":60}. Mutually exclusive with name/pads; preserves waves/levels/FX.'),
      pads: z.array(z.union([
        z.number().int(),
        z.string(),
        z.object({
          wave: z.union([z.number().int(), z.string()]).describe('Wave index, wave name, or -1 / "empty".'),
          note: z.number().int().min(0).max(127).optional().describe('MIDI note that triggers this pad. Default: ascending from 60 by pad order.'),
          voice: z.enum(['poly', 'mono']).optional().describe('poly = overlapping trails (hat rolls ring out); mono = each hit chokes the previous. Default poly for a one-shot, mono for a loop.'),
          loop: z.boolean().optional().describe('LOOP the wave (a groove/bed you play/drum along to) instead of a one-shot hit; plays at its native recorded tempo. Default false. Use for the loop pads in a sample kit (e.g. Roland pack "TEMPLATE=LOOP" pads).'),
          mute_group: z.number().int().min(0).max(9).optional().describe('Mute group 0..9 (0 = off; same-group pads cut each other off, e.g. open vs closed hat).'),
          level: z.number().int().min(0).max(127).optional().describe('Per-pad volume 0..127 (device WvLevel). Default: the pad\'s current level when re-authoring an existing kit, else 100. Lower it to balance a loud pad (e.g. a hi-hat/baked figure) below the shells without re-baking the wave.'),
          dynamics: z.boolean().optional().describe('Velocity scales volume. Default true.'),
          sub_wave: z.union([z.number().int(), z.string()]).optional().describe('Optional second wave layered on the pad.'),
        }),
      ])).optional().describe('Per-pad assignment in pad order: a wave index (number), a wave name (string), -1 / "empty", or an object { wave, note?, voice?, loop?, mute_group?, level?, dynamics?, sub_wave? } for per-pad MIDI/voice/level properties. Required to BUILD a kit; omit in set_notes patch mode.'),
      confirm_overwrite: z.boolean().optional().describe('Overwrite gate. Pass true ONLY when the user authorized replacing the kit (save/overwrite/replace language); the prior kit is backed up first. Omitted/false refuses to clobber an occupied kit.'),
      dry_run: z.boolean().optional().describe('Build + validate the kit (or patch) and report it, but do not write.'),
    },
  }, async ({ port, location, name, pads, set_notes, confirm_overwrite, dry_run }) => {
    try {
      return asText(await executeAuthorKit({ port, location, name, pads, set_notes, confirm_overwrite, dry_run }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('upload_kit', {
    title: 'Upload Kit',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      'Upload a folder of WAVs to consecutive Circuit Tracks drum-sample slots in one batch.',
      'Pass `folder`; optionally `kit` to filter to files named like NN_k1_role.wav (the kit token matches as a delimited segment, so "k1" does not catch "k10"), and `start_slot` (1..64, default 1).',
      'Files are natural-sorted (so 2_x precedes 10_x) and mapped to slots from start_slot upward. Only 64 slots exist, so files past the ceiling are SKIPPED and reported (never silently dropped).',
      'Each WAV is normalized to 48 kHz mono 16-bit; each OVERWRITES its target slot. Stops on the first failure (earlier samples persist).',
      'OVERWRITE GATE, DESTRUCTIVE: a kit fills a RANGE of slots that cannot be read to check occupancy, so the tool REFUSES by default. Pass `confirm_overwrite: true` ONLY when the user authorized replacing those slots (loading a kit is usually overwrite-intent; confirm the range first).',
      'About 1 s per sample, so a 16-sample kit is about 15 s: tell the user the cost before a big batch. Confirm by ear.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      folder: z.string().describe('Path to a folder containing .wav files.'),
      kit: z.string().optional().describe('Optional kit token to filter on (e.g. "k1" → files like 03_k1_snr.wav). Omit to take every WAV in the folder.'),
      start_slot: z.number().int().min(1).max(64).optional().describe('First device slot to fill, 1..64. Default 1.'),
      pack: z.number().int().min(1).max(32).optional().describe('Circuit Tracks: which microSD PACK to write to, numbered as the device shows it (pack:5 = "Pack 5"). Default 1. Write the SAME pack the project that binds these slots targets, or the project resolves its drum bindings against a different pool. The device does not report the selected pack, so choose it. Writing to a nonzero pack is hardware-confirmed. Verifying with list_samples IMMEDIATELY afterwards is not: the device flushes the pack manifest ~6-8 s after the session closes, so re-read after ~10 s before concluding a slot is empty.'),
      confirm_overwrite: z.boolean().optional().describe('Overwrite gate. Pass true ONLY when the user authorized overwriting the slot range (the sample slots can\'t be read to check occupancy). Omitted/false refuses.'),
    },
  }, async ({ port, folder, kit, start_slot, pack, confirm_overwrite }) => {
    try {
      return asText(await executeUploadKit({ port, folder, kit, start_slot, pack, confirm_overwrite }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('upload_project', {
    title: 'Upload Project',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      'Upload a prepared whole-project Circuit Tracks .ncs to a project slot, sent VERBATIM over the file-transfer transport.',
      'Use this for a ready-made project (e.g. a swappable groove set) that already contains its patterns. To AUTHOR a pattern into a template instead, use apply_pattern mode:ncs_upload.',
      '`slot` is the project number 1..64, exactly as the device shows it. DESTRUCTIVE: this OVERWRITES that project.',
      'OVERWRITE GATE: without `confirm_overwrite` the tool reads the slot first, writes through if EMPTY, else REFUSES and names the project it would replace (re-call to confirm). Pass `confirm_overwrite: true` ONLY on user save/replace language. Backup-before-overwrite is on by default (the clobbered project is first saved to ~/mcp-midi-backups, reversible via another upload_project; `backup_first: false` skips it).',
      'Drum tracks play whatever samples are assigned on the device, so load the matching kit first (upload_sample / upload_kit). ACK-gated, no readback, so confirm by ear.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      file: z.string().describe('Path to a prepared .ncs project file (160,780 bytes).'),
      slot: z.number().int().min(1).max(64).describe('Destination PROJECT, 1..64, numbered exactly as the device shows it (Project 35 = 35). OVERWRITES that project.'),
      pack: z.number().int().min(1).max(32).optional().describe('Circuit Tracks: which microSD PACK to write to, numbered as the device shows it, so pack:5 is the front panel\'s "Pack 5". Both `pack` and `slot` are 1-based, exactly as the device shows them (Pack 5, Project 35). Default pack 1. A card holds up to 32 packs, each a COMPLETE separate world of 64 projects, so the same slot number exists in every pack and the pack decides which project gets overwritten. Call list_packs first to see the card\'s packs by name. The overwrite gate, the pre-write backup, and the write all target this pack together. IMPORTANT: the server CANNOT detect which pack the device currently has selected (no wire command reports it), so if the user is working in a specific pack, pass it explicitly; otherwise this writes to Pack 1 no matter what the front panel shows.'),
      confirm_overwrite: z.boolean().optional().describe('Overwrite gate. Omitted/false reads the slot first and refuses only if it is occupied. Pass true to overwrite an occupied slot (skips the read), only when the user authorized it.'),
      backup_first: z.boolean().optional().describe('Backup-before-overwrite. Default true: when confirm_overwrite overwrites an occupied slot, save its current project to a .ncs backup (~/mcp-midi-backups, findable later via list_backups) first so the change is reversible. Pass false to skip the pre-write backup read. It applies to the OVERWRITE path only, because that is the only path that can destroy anything: without confirm_overwrite this tool refuses rather than overwrites. To take a backup on its own, use backup_device.'),
    },
  }, async ({ port, file, slot, pack, confirm_overwrite, backup_first }) => {
    try {
      return asText(await executeUploadProject({ port, file, slot, pack, confirm_overwrite, backup_first }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('delete_project', {
    title: 'Delete Project',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      // Deliberately NOT idempotent, even though a second call leaves the device
      // in the same state (it refuses: the slot is already empty). The hint an
      // agent acts on is "is a blind retry safe here", and on this tool it is
      // not: a delete whose confirmation was ambiguous must be re-READ, never
      // re-sent. A 2026-07-29 verification mis-scored a successful erase as
      // "still there" and the obvious next move was to send it again.
      idempotentHint: false,
      openWorldHint: true,
    },
    description: [
      'Permanently ERASE stored projects from a Circuit Tracks pack. Not a replace: the slots end up empty, and the device has no undo and no trash.',
      'Name each project in `slots` (1..64 as the device shows them) plus the `pack` (default 1). No range form: run scan_locations first and name what you saw.',
      `Max ${MAX_DELETES_PER_CALL} per call, refused above that, never trimmed.`,
      'REFUSES BY DEFAULT and returns what would be lost, naming every project. Relay that list, get an explicit yes for those specific projects, then re-call with confirm_delete: true. "Tidy up the pack" is not a yes.',
      'Also refuses if any named slot reads empty or unreadable, rather than erasing its neighbours on a wrong picture of the card.',
      'Every project is backed up CRC-verified to disk first, always, with no flag to skip it: that backup is the only undo (restore with upload_project). Each erase is then confirmed gone by the device\'s own file query AND a fresh directory read.',
      'About 8 s per project; tell the user the wait first.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      slots: z.array(z.number().int().min(1).max(64)).min(1).max(MAX_DELETES_PER_CALL).describe(
        'The projects to erase, named one by one, 1..64 exactly as the device shows them (Project 35 = 35). There is deliberately no from/to range: the one incident that emptied a pack on this device was a loop over a range, and Novation Components itself enumerates the pack and then names individual slots rather than looping. If the user asked for "61 to 64", call scan_locations over that range first, tell them what is in it, and pass the numbers you saw.',
      ),
      pack: z.number().int().min(1).max(32).optional().describe(
        'Which microSD PACK to erase from, numbered as the device shows it (pack:5 = "Pack 5"). Default 1. Each pack is a COMPLETE separate world of 64 projects, so the same project number exists in every pack and the pack decides which one is destroyed. The server CANNOT detect which pack the front panel has selected, so if the user is working in a specific pack, pass it. Call list_packs first.',
      ),
      confirm_delete: z.boolean().optional().describe(
        'Erase authorization. Omit it on the first call: the tool then reads the pack, refuses, and returns exactly which projects would be destroyed, by name. Pass true ONLY after you have told the user those specific project names and they agreed to lose them. General clean-up language ("tidy this up", "sort out the pack") is NOT authorization to erase named work; a save/overwrite-style yes is not one either, because this leaves nothing behind.',
      ),
      directory: z.string().optional().describe(
        'Where the mandatory pre-delete backups go. Defaults to a `mcp-midi-backups` folder under the user\'s home, findable later with list_backups. Point it at a synced folder (e.g. OneDrive) if the only copy of these projects should leave this machine. There is no way to skip the backup.',
      ),
    },
    outputSchema: DELETE_PROJECT_OUTPUT_SCHEMA,
  }, async ({ port, slots, pack, confirm_delete, directory }) => {
    try {
      return asText(await executeDeleteProject({ port, slots, pack, confirm_delete, directory }));
    } catch (err) {
      return asError(err);
    }
  });
}
