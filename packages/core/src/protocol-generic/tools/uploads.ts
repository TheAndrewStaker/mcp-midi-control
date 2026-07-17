/**
 * Sample-upload tools (Circuit Tracks family; dispatch by `port`).
 *
 *   - upload_sample, write one WAV to a drum-sample slot (1..64).
 *   - upload_kit   , write a folder of WAVs to consecutive slots in one batch.
 *
 * The 64 sample slots are the shared DRUM pool the 4 drum tracks pick from
 * (synths use patches, not samples). WAVs are normalized to the device's
 * 48 kHz / mono / 16-bit format on upload. The wire frames are decoded byte-
 * exact from a real Novation Components capture (community-beta: drive these
 * normally and confirm the result by ear). Replaces the manual Components
 * web-app workflow.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executeAuthorKit, executeUploadSample, executeUploadKit, executeUploadProject } from '../dispatcher/uploads.js';
import { PORT_DESC, asError, asText } from './shared.js';

export function registerUploadTools(server: McpServer): void {
  server.registerTool('upload_sample', {
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
      confirm_overwrite: z.boolean().optional().describe('Overwrite gate (slot-addressed pools only). Pass true ONLY when the user authorized overwriting the slot. Ignored on append-only pools.'),
    },
  }, async ({ port, file, slot, name, confirm_overwrite }) => {
    try {
      return asText(await executeUploadSample({ port, file, slot, name, confirm_overwrite }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('author_kit', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      'Author a sampler KIT (a pad-to-wave map) and write it to a stored kit location. The sampler-archetype whole-preset write (Roland SPD-SX). The kit IS the preset, addressed by location; there is no audition buffer, so this writes the device file directly.',
      '`location` is the kit number (SPD-SX: 1..100). `pads` is the per-pad assignment IN PAD ORDER: each entry is a wave index (number) or a wave name (string, resolved against the pool via list_samples), or -1 / "empty" for an empty pad. SPD-SX pads 1-9 are the main pads, 10-15 the external trigger inputs.',
      'PER-PAD PROPERTIES (object form): instead of a bare wave, pass `{ wave, note?, voice?, mute_group?, dynamics?, sub_wave? }` to set the pad MIDI trigger note (lines up with a Circuit MIDI 1/2 sequence; defaults ascend from 60 by pad order), voice ("poly" = overlapping trails for HAT ROLLS, "mono" = each hit chokes the last), mute_group 0..9 (0=off; same group cuts each other off, e.g. open vs closed hat), and dynamics (velocity to volume). Any object pad switches to the device full-kit format (decoded byte-exact, FX off; device acceptance of a server-authored full kit is community-beta, confirm by ear).',
      'Import the waves first with upload_sample (which returns the indices). OVERWRITE GATE: refuses to overwrite an occupied kit unless `confirm_overwrite: true` (which backs the prior kit up first). Pass `dry_run: true` to build + validate + preview without writing.',
      'PATCH MODE (non-destructive note edit): to change ONLY pad notes on an EXISTING kit, pass `set_notes` ({ "<pad 1-15>": note 0..127 }, e.g. {"7":60}) instead of name+pads. Only the notes change; waves/levels/FX are preserved, so it will not quiet the kit the way a full re-author does. Full kits only: a minimal (Wv-only) kit is refused (adding a note would force the level-changing full format); set those on the device PAD MIDI menu. get_preset shows if a kit is minimal.',
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
          level: z.number().int().min(0).max(127).optional().describe('Per-pad volume 0..127 (device WvLevel). Default 100. Lower it to balance a loud pad (e.g. a hi-hat/baked figure) below the shells without re-baking the wave.'),
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
      confirm_overwrite: z.boolean().optional().describe('Overwrite gate. Pass true ONLY when the user authorized overwriting the slot range (the sample slots can\'t be read to check occupancy). Omitted/false refuses.'),
    },
  }, async ({ port, folder, kit, start_slot, confirm_overwrite }) => {
    try {
      return asText(await executeUploadKit({ port, folder, kit, start_slot, confirm_overwrite }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('upload_project', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      'Upload a prepared whole-project Circuit Tracks .ncs to a project slot, sent VERBATIM over the file-transfer transport.',
      'Use this for a ready-made project (e.g. a swappable groove set) that already contains its patterns. To AUTHOR a pattern into a template instead, use apply_pattern mode:ncs_upload.',
      '`slot` is the project slot 0..63 (device shows "Project slot+1"). DESTRUCTIVE: this OVERWRITES that slot.',
      'OVERWRITE GATE: without `confirm_overwrite` the tool reads the slot first, writes through if EMPTY, else REFUSES and names the project it would replace (re-call to confirm). Pass `confirm_overwrite: true` ONLY on user save/replace language. Backup-before-overwrite is on by default (the clobbered project is first saved to ~/mcp-midi-backups, reversible via another upload_project; `backup_first: false` skips it).',
      'Drum tracks play whatever samples are assigned on the device, so load the matching kit first (upload_sample / upload_kit). ACK-gated, no readback, so confirm by ear.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      file: z.string().describe('Path to a prepared .ncs project file (160,780 bytes).'),
      slot: z.number().int().min(0).max(63).describe('Destination project slot, 0..63 (device shows "Project slot+1"). OVERWRITES that slot.'),
      pack: z.number().int().min(1).max(32).optional().describe('Circuit Tracks: which microSD PACK to write to, numbered as the device shows it, so pack:5 is the front panel\'s "Pack 5". NOTE the two bases in one call: `pack` is 1-based; `slot` is 0-based. Default pack 1. A card holds up to 32 packs, each a COMPLETE separate world of 64 projects, so the same slot number exists in every pack and the pack decides which project gets overwritten. Call list_packs first to see the card\'s packs by name. The overwrite gate, the pre-write backup, and the write all target this pack together. IMPORTANT: the server CANNOT detect which pack the device currently has selected (no wire command reports it), so if the user is working in a specific pack, pass it explicitly; otherwise this writes to Pack 1 no matter what the front panel shows.'),
      confirm_overwrite: z.boolean().optional().describe('Overwrite gate. Omitted/false reads the slot first and refuses only if it is occupied. Pass true to overwrite an occupied slot (skips the read), only when the user authorized it.'),
      backup_first: z.boolean().optional().describe('Backup-before-overwrite. Default true: when confirm_overwrite overwrites an occupied slot, save its current project to a .ncs backup (~/mcp-midi-backups) first so the change is reversible. Pass false to skip the pre-write backup read.'),
    },
  }, async ({ port, file, slot, pack, confirm_overwrite, backup_first }) => {
    try {
      return asText(await executeUploadProject({ port, file, slot, pack, confirm_overwrite, backup_first }));
    } catch (err) {
      return asError(err);
    }
  });
}
