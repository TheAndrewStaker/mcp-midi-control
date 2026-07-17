/**
 * Dispatcher — backup-before-overwrite for whole-project slots.
 *
 * The safety half of the Circuit Tracks (and any future project-memory device)
 * overwrite contract (cf. `docs/SAFE-EDIT-WORKFLOW.md`): before a destructive
 * project write actually clobbers an occupied slot, read the current contents
 * byte-exact and write them to a `.ncs` backup on disk, so the overwrite is
 * REVERSIBLE. With a backup, "yes, overwrite it" stops being a one-way door.
 *
 * Layering: filesystem I/O is a host concern, so the backup file is written
 * HERE (the dispatcher) rather than inside the device writer — same stance as
 * `export_preset` keeping its `writeFile` in the tool/dispatch layer. The read
 * itself reuses the device's `reader.dumpStoredPresetBinary` (the same path
 * `export_preset(location)` uses), so this stays device-agnostic.
 *
 * A read that fails its device CRC (or fails outright) PROPAGATES as a thrown
 * DispatchError — the caller MUST treat that as a hard stop and NOT proceed to
 * overwrite, because a corrupt/absent backup means the destruction would be
 * irreversible. Never save a half-read blob as a "backup".
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { DeviceDescriptor, DispatchCtx } from '../types.js';

/** Collapse anything filesystem-unfriendly to underscores; bound the length. */
function sanitizeForFilename(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'project';
}

/** Filesystem-safe local timestamp, e.g. `2026-06-23_12-53-18`. */
function backupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace('T', '_')
    .replace(/:/g, '-');
}

export interface ProjectBackupResult {
  /**
   * - `saved`              : the occupied slot was read CRC-clean and written to disk.
   * - `skipped_empty`      : the slot held nothing; there was nothing to back up.
   * - `skipped_unsupported`: the device exposes no stored-project read, so no
   *                          backup could be taken (the caller decides whether to
   *                          still proceed — a non-Circuit project device).
   */
  status: 'saved' | 'skipped_empty' | 'skipped_unsupported';
  file_path?: string;
  byte_length?: number;
  /** Project name decoded from the backed-up bytes, when available. */
  name?: string;
  /** One-line note for the success receipt (always set). */
  note: string;
}

/**
 * Read project `slot` from the device and, if it holds a CRC-clean project,
 * write it to a `.ncs` backup before the caller overwrites it. Returns the
 * outcome (saved / skipped_empty / skipped_unsupported) with a receipt note.
 *
 * Throws (propagating the reader's DispatchError) when the occupancy read fails
 * or fails CRC: the caller must NOT proceed with the destructive write in that
 * case, since the overwrite would be unrecoverable.
 *
 * `directory` overrides the default `~/mcp-midi-backups` destination.
 */
export async function backupProjectSlot(
  descriptor: DeviceDescriptor,
  ctx: DispatchCtx,
  slot: number,
  opts: { directory?: string } = {},
): Promise<ProjectBackupResult> {
  const dumpStored = descriptor.reader.dumpStoredPresetBinary;
  if (dumpStored === undefined) {
    return {
      status: 'skipped_unsupported',
      note:
        `Backup-before-overwrite skipped: ${descriptor.display_name} exposes no stored-project read, ` +
        `so the slot's current contents could not be saved first.`,
    };
  }
  // May throw (read failure / CRC mismatch) — let it propagate so the caller
  // aborts the overwrite rather than destroy a slot we could not back up.
  const dump = await dumpStored(slot, ctx);
  if (dump.empty) {
    return {
      status: 'skipped_empty',
      note: `Project slot ${slot}${ctx.pack !== undefined && ctx.pack !== 0 ? ` on Pack ${ctx.pack + 1}` : ''} was empty, nothing to back up.`,
    };
  }
  const baseDir = opts.directory !== undefined && opts.directory.trim().length > 0
    ? opts.directory.trim()
    : path.join(homedir(), 'mcp-midi-backups');
  await mkdir(baseDir, { recursive: true });
  const ext = dump.file_extension ?? 'syx';
  // Pack-tag the artifact on pack-addressed devices (Circuit Tracks). The same
  // slot number exists in every pack, so without this two backups of DIFFERENT
  // projects differ only by timestamp — and the restore hint below could not
  // tell the user which pack to put it back in.
  const packTag = ctx.pack !== undefined && ctx.pack !== 0 ? `pack${ctx.pack + 1}-` : '';
  const slotTag = `${packTag}slot${String(slot).padStart(2, '0')}`;
  const fileName =
    `${sanitizeForFilename(descriptor.display_name)}-${slotTag}-${sanitizeForFilename(dump.name ?? 'project')}-${backupTimestamp()}.${ext}`;
  const filePath = path.join(baseDir, fileName);
  await writeFile(filePath, Buffer.from(dump.bytes));
  const where = ctx.pack !== undefined && ctx.pack !== 0 ? ` on Pack ${ctx.pack + 1}` : '';
  const restoreHint = ctx.pack !== undefined && ctx.pack !== 0
    ? `restore it with upload_project (slot ${slot}, pack ${ctx.pack + 1}) if needed.`
    : 'restore it with upload_project if needed.';
  return {
    status: 'saved',
    file_path: filePath,
    byte_length: dump.byte_length,
    name: dump.name,
    note:
      `Backed up the existing project in slot ${slot}${where} (${dump.name ?? 'unnamed'}, ${dump.byte_length} bytes) ` +
      `to ${filePath} before overwriting. To undo, ${restoreHint}`,
  };
}
