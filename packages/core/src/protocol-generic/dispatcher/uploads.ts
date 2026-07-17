/**
 * Dispatcher — sample upload (`upload_sample`, `upload_kit`).
 *
 * Resolves the file/folder arguments at the dispatch boundary (read WAV bytes,
 * discover + curate a kit folder into the device's 64 sample slots), then
 * delegates the wire work to the descriptor's `writer.uploadSample` /
 * `writer.uploadKit`. Sample memory is a Circuit Tracks-family capability; a
 * device without it gets a clean capability_not_supported.
 *
 * Slot numbering: tools and these args use the device-facing 1..64; the wire is
 * 0..63. We convert ONCE here (slot - 1) so everything below the dispatcher is
 * wire-indexed and everything above is device-facing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { openCtx, requireDevice, toWirePack } from './core.js';
import { backupProjectSlot } from './backup.js';
import {
  DispatchError,
  type KitAuthorResult,
  type KitPadAssignment,
  type KitUploadItem,
  type KitUploadOutcome,
  type ProjectUploadOutcome,
  type SampleUploadOutcome,
} from '../types.js';

export interface UploadSampleArgs {
  port: string;
  /** Path to a WAV file. */
  file: string;
  /**
   * Device sample slot, 1..64 (Circuit Tracks — required, overwrites that slot).
   * Omit for append-only pools (SPD-SX wave pool — the wave lands at the next
   * free index, reported in the result).
   */
  slot?: number;
  /** Optional name shown on the device; defaults to the file's basename. */
  name?: string;
  /** Overwrite gate: true to write a slot that may hold a sample (see SAFE-EDIT-WORKFLOW.md). */
  confirm_overwrite?: boolean;
}

export interface UploadKitArgs {
  port: string;
  /** Folder containing WAV files. */
  folder: string;
  /** Optional kit token to filter on (e.g. "k1" matches `NN_k1_role.wav`). */
  kit?: string;
  /** First device slot to fill, 1..64 (default 1). */
  start_slot?: number;
  /** Overwrite gate: true to write slots that may hold samples (see SAFE-EDIT-WORKFLOW.md). */
  confirm_overwrite?: boolean;
}

export interface UploadProjectArgs {
  port: string;
  /** Path to a prepared whole-project file (e.g. a Circuit Tracks .ncs). */
  file: string;
  /** Destination project slot, 0..63 (device shows Project slot+1). */
  slot: number;
  /**
   * Destination microSD pack, 1-BASED as the device numbers it ("Pack 5" = 5).
   * Default 1. Converted to the wire index at `openCtx`; see `DispatchCtx.pack`.
   */
  pack?: number;
  /** Overwrite gate: true to overwrite an occupied project slot (see SAFE-EDIT-WORKFLOW.md). */
  confirm_overwrite?: boolean;
  /**
   * Backup-before-overwrite. Default true: when `confirm_overwrite` authorizes
   * clobbering an occupied slot, the slot's current project is read + saved to a
   * `.ncs` backup first, so the overwrite is reversible. Pass false to skip the
   * pre-write backup read (a few seconds faster; the overwrite becomes
   * irreversible).
   */
  backup_first?: boolean;
}

const isWav = (f: string) => extname(f).toLowerCase() === '.wav';
const isNcs = (f: string) => extname(f).toLowerCase() === '.ncs';

/** Numeric-aware sort so `2_x.wav` precedes `10_x.wav`. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function readWav(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (err) {
    throw new DispatchError('bad_location', '(sample upload)', `Could not read WAV '${path}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function executeUploadSample(args: UploadSampleArgs): Promise<SampleUploadOutcome> {
  const descriptor = requireDevice(args.port);
  if (!descriptor.writer.uploadSample) {
    throw new DispatchError('capability_not_supported', descriptor.display_name,
      `${descriptor.display_name} has no sample memory; upload_sample is a Circuit Tracks-family capability.`);
  }
  // slot is device-dependent: required + range-checked for slot-addressed pools
  // (Circuit 1..64), omitted for append-only pools (SPD-SX). Validate only when
  // given; the writer enforces its own required/append rule.
  if (args.slot !== undefined && (!Number.isInteger(args.slot) || args.slot < 1 || args.slot > 64)) {
    throw new DispatchError('bad_location', descriptor.display_name, `slot, when given, must be 1..64 (device numbering), got ${args.slot}.`);
  }
  if (!isWav(args.file)) {
    throw new DispatchError('bad_location', descriptor.display_name, `'${args.file}' is not a .wav file.`);
  }
  const wav = readWav(args.file);
  const filename = args.name ?? basename(args.file);
  const ctx = openCtx(descriptor);
  // Convert the device-facing 1-based slot to the wire 0-based index here (once),
  // or pass undefined through for append-only pools.
  const wireSlot = args.slot === undefined ? undefined : args.slot - 1;
  return descriptor.writer.uploadSample(ctx, wav, wireSlot, filename, { confirmOverwrite: args.confirm_overwrite });
}

export interface AuthorKitArgs {
  port: string;
  /** Kit location to write (device-facing numbering, e.g. 1..100 on SPD-SX). */
  location: number | string;
  /** Kit name. Required in BUILD mode (omitted/ignored in set_notes patch mode). */
  name?: string;
  /** Per-pad assignment in pad order: a wave index, a wave name, or -1 / 'empty'. Required in BUILD mode. */
  pads?: readonly KitPadAssignment[];
  /**
   * PATCH mode: set per-pad notes on the EXISTING kit non-destructively (only the
   * notes change; waves/levels/FX are preserved). Map of pad number (1-based,
   * as a string key) -> MIDI note 0..127. Mutually exclusive with name/pads.
   */
  set_notes?: Record<string, number>;
  /** Overwrite gate: true to overwrite an occupied kit (backs the prior one up first). */
  confirm_overwrite?: boolean;
  /** Build + validate the kit and report it, but do not write. */
  dry_run?: boolean;
}

export async function executeAuthorKit(args: AuthorKitArgs): Promise<KitAuthorResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  const patchMode = args.set_notes !== undefined && Object.keys(args.set_notes).length > 0;

  // PATCH mode: non-destructive per-pad note edit on an existing kit.
  if (patchMode) {
    if (args.pads !== undefined || args.name !== undefined) {
      throw new DispatchError('bad_request', descriptor.display_name,
        'author_kit: pass EITHER name+pads (build a kit) OR set_notes (patch notes on an existing kit), not both.');
    }
    if (!descriptor.writer.editPadNotes) {
      throw new DispatchError('capability_not_supported', descriptor.display_name,
        `${descriptor.display_name} cannot edit pad notes; set_notes is a sampler-family capability (e.g. Roland SPD-SX).`);
    }
    const notes: Record<number, number> = {};
    for (const [k, v] of Object.entries(args.set_notes!)) {
      const pad = Number(k);
      if (!Number.isInteger(pad)) {
        throw new DispatchError('bad_request', descriptor.display_name, `author_kit set_notes: pad key '${k}' is not an integer pad number.`);
      }
      notes[pad] = v;
    }
    const ctx = openCtx(descriptor);
    const result = await descriptor.writer.editPadNotes(ctx, args.location, notes, { dryRun: args.dry_run });
    return { ...result, device: descriptor.display_name };
  }

  // BUILD mode: author a kit from a pad list.
  if (!descriptor.writer.authorKit) {
    throw new DispatchError('capability_not_supported', descriptor.display_name,
      `${descriptor.display_name} has no kit format; author_kit is a sampler-family capability (e.g. Roland SPD-SX).`);
  }
  if (args.name === undefined || args.pads === undefined) {
    throw new DispatchError('bad_request', descriptor.display_name,
      'author_kit: building a kit needs both name and pads (or pass set_notes to patch notes on an existing kit instead).');
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.authorKit(ctx, args.location, args.name, args.pads, {
    confirmOverwrite: args.confirm_overwrite,
    dryRun: args.dry_run,
  });
  return { ...result, device: descriptor.display_name };
}

export async function executeUploadKit(args: UploadKitArgs): Promise<KitUploadOutcome> {
  const descriptor = requireDevice(args.port);
  if (!descriptor.writer.uploadKit) {
    throw new DispatchError('capability_not_supported', descriptor.display_name,
      `${descriptor.display_name} has no sample memory; upload_kit is a Circuit Tracks-family capability.`);
  }
  const startSlot = args.start_slot ?? 1;
  if (!Number.isInteger(startSlot) || startSlot < 1 || startSlot > 64) {
    throw new DispatchError('bad_location', descriptor.display_name, `start_slot must be 1..64, got ${startSlot}.`);
  }

  let entries: string[];
  try {
    entries = readdirSync(args.folder).filter((f) => isWav(f) && statSync(join(args.folder, f)).isFile());
  } catch (err) {
    throw new DispatchError('bad_location', descriptor.display_name, `Could not read folder '${args.folder}': ${err instanceof Error ? err.message : String(err)}`);
  }
  if (args.kit) {
    // Match the kit token as a delimited segment so "k1" doesn't catch "k10".
    const re = new RegExp(`(^|[_\\-])${args.kit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([_\\-]|\\.)`, 'i');
    entries = entries.filter((f) => re.test(f));
  }
  entries.sort(naturalCompare);
  if (entries.length === 0) {
    throw new DispatchError('bad_location', descriptor.display_name,
      `No WAV files${args.kit ? ` matching kit '${args.kit}'` : ''} in '${args.folder}'.`);
  }

  // Curate to the 64-slot ceiling; never silently truncate.
  const capacity = 64 - (startSlot - 1);
  const dropped = entries.length > capacity ? entries.slice(capacity) : [];
  const kept = entries.slice(0, capacity);

  const items: KitUploadItem[] = kept.map((f, i) => ({
    wav: readWav(join(args.folder, f)),
    slot: (startSlot - 1) + i, // wire-indexed
    filename: f,
  }));

  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.uploadKit(ctx, items, { confirmOverwrite: args.confirm_overwrite });
  if (dropped.length > 0) {
    const note = ` ${dropped.length} file(s) did not fit in the 64 slots and were SKIPPED: ${dropped.slice(0, 6).join(', ')}${dropped.length > 6 ? ', …' : ''}.`;
    result.warning = (result.warning ?? '') + note;
    result.info += note;
  }
  return result;
}

export async function executeUploadProject(args: UploadProjectArgs): Promise<ProjectUploadOutcome> {
  const descriptor = requireDevice(args.port);
  if (!descriptor.writer.uploadProject) {
    throw new DispatchError('capability_not_supported', descriptor.display_name,
      `${descriptor.display_name} has no project file-transfer; upload_project is a Circuit Tracks-family capability.`);
  }
  if (!Number.isInteger(args.slot) || args.slot < 0 || args.slot > 63) {
    throw new DispatchError('bad_location', descriptor.display_name,
      `slot must be 0..63 (project slot; device shows Project slot+1), got ${args.slot}.`);
  }
  if (!isNcs(args.file)) {
    throw new DispatchError('bad_location', descriptor.display_name,
      `'${args.file}' is not a .ncs file. upload_project sends a prepared Circuit Tracks project verbatim.`);
  }
  let project: Uint8Array;
  try {
    project = new Uint8Array(readFileSync(args.file));
  } catch (err) {
    throw new DispatchError('bad_location', descriptor.display_name,
      `Could not read project '${args.file}': ${err instanceof Error ? err.message : String(err)}`);
  }
  // One ctx carries the pack, so the backup below, the writer's gate, and the
  // write itself all address the SAME pack (see DispatchCtx.pack).
  const ctx = openCtx(descriptor, { pack: toWirePack(args.pack) });

  // Backup-before-overwrite (default on). The writer's overwrite gate SKIPS its
  // occupancy read when confirm_overwrite is set, so this is the only path where
  // an occupied slot is clobbered without first being read — back it up here so
  // the overwrite stays reversible. A read/CRC failure throws and aborts BEFORE
  // any destructive byte is sent (never overwrite a slot we couldn't back up).
  let backupNote = '';
  if (args.backup_first !== false && args.confirm_overwrite) {
    const backup = await backupProjectSlot(descriptor, ctx, args.slot);
    backupNote = ` ${backup.note}`;
  }

  const outcome = await descriptor.writer.uploadProject(ctx, project, args.slot, { confirmOverwrite: args.confirm_overwrite });
  if (backupNote) outcome.info = `${outcome.info}${backupNote}`;
  return outcome;
}
