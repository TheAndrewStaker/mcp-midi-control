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
import * as path from 'node:path';

import {
  backupTimestamp,
  defaultBackupDir,
  recordBackup,
  resolveBackupPolicy,
  sanitizeForFilename,
} from './backupIndex.js';
import type { DeviceDescriptor, DispatchCtx } from '../types.js';

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
  /**
   * Mirrors `PresetBinaryDump.structurally_valid`: false means the read passed
   * its transfer check and still did not deliver a valid file, so this backup
   * exists but is NOT a usable restore source. `undefined` on devices that
   * declare no decode-side structural check.
   */
  structurally_valid?: boolean;
}

/**
 * Read project `slot` from the device and, if it holds a CRC-clean project,
 * write it to a `.ncs` backup before the caller overwrites it.
 *
 * `slot` is DEVICE numbering (Circuit Tracks: Project 1..64, as the front panel
 * shows it), matching `reader.dumpStoredPresetBinary`, which this forwards to
 * unchanged. Passing a wire index here reads the NEIGHBOURING project and hands
 * back a backup of the wrong thing, which is worse than no backup at all.
 */
/**
 * (original note)
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
  /**
   * `tool` labels the index entry with WHY the backup was taken. It matters for
   * finding one later: a user who erased a project searches for the delete, and
   * an entry labelled "backup-before-overwrite" for a slot nothing overwrote
   * would send them looking in the wrong place. Defaults to the overwrite label,
   * so every existing caller is unchanged.
   */
  opts: { directory?: string; tool?: string } = {},
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
  const dump = await dumpStored(slot, ctx);   // slot is DEVICE numbering
  if (dump.empty) {
    return {
      status: 'skipped_empty',
      note: `Project ${slot}${ctx.pack !== undefined && ctx.pack !== 0 ? ` on Pack ${ctx.pack + 1}` : ''} was empty, nothing to back up.`,
    };
  }
  const baseDir = opts.directory !== undefined && opts.directory.trim().length > 0
    ? opts.directory.trim()
    : defaultBackupDir();
  await mkdir(baseDir, { recursive: true });
  const ext = dump.file_extension ?? 'syx';
  // Pack-tag the artifact on pack-addressed devices (Circuit Tracks). The same
  // slot number exists in every pack, so without this two backups of DIFFERENT
  // projects differ only by timestamp — and the restore hint below could not
  // tell the user which pack to put it back in.
  const packTag = ctx.pack !== undefined && ctx.pack !== 0 ? `pack${ctx.pack + 1}-` : '';
  const slotTag = `${packTag}slot${String(slot).padStart(2, '0')}`;
  const fileName =
    `${sanitizeForFilename(descriptor.display_name, 'device')}-${slotTag}-${sanitizeForFilename(dump.name ?? 'project', 'project')}-${backupTimestamp()}.${ext}`;
  const filePath = path.join(baseDir, fileName);
  await writeFile(filePath, Buffer.from(dump.bytes));
  // Index it so the user can find this file later via list_backups without
  // knowing our naming convention. Never throws — the file IS the backup.
  const policy = resolveBackupPolicy(descriptor);
  recordBackup(baseDir, {
    file_name: fileName,
    device: descriptor.display_name,
    device_id: descriptor.id,
    unit: policy.unit_label,
    location: slot,
    pack: ctx.pack !== undefined ? ctx.pack + 1 : undefined,
    name: dump.name,
    format: dump.format,
    byte_length: dump.byte_length,
    created_at: new Date().toISOString(),
    tool: opts.tool ?? 'backup-before-overwrite',
    restore_with: policy.restore_tool,
  });
  const where = ctx.pack !== undefined && ctx.pack !== 0 ? ` on Pack ${ctx.pack + 1}` : '';
  const restoreHint = ctx.pack !== undefined && ctx.pack !== 0
    ? `restore it with upload_project (slot ${slot}, pack ${ctx.pack + 1}) if needed.`
    : 'restore it with upload_project if needed.';
  // A dump that passed its transfer check and FAILED its structural one is a
  // saved file that is not a usable undo. Saying "to undo, restore it" there
  // would be the worst sentence in the receipt, so the note says the opposite
  // and names why the slot could not be made reversible.
  if (dump.structurally_valid === false) {
    return {
      status: 'saved',
      file_path: filePath,
      byte_length: dump.byte_length,
      name: dump.name,
      structurally_valid: false,
      note:
        `Saved slot ${slot}${where} to ${filePath}, but THIS IS NOT A USABLE UNDO: the read passed the device's ` +
        `transfer check and the file it delivered is structurally invalid, so restoring it would write a broken ` +
        `project back. ${dump.warning ?? ''} The overwrite is therefore effectively irreversible; make sure that ` +
        `is what the user wants before proceeding.`.replace(/\s+/g, ' ').trim(),
    };
  }
  return {
    status: 'saved',
    file_path: filePath,
    byte_length: dump.byte_length,
    name: dump.name,
    structurally_valid: dump.structurally_valid,
    note:
      `Backed up the existing project in slot ${slot}${where} (${dump.name ?? 'unnamed'}, ${dump.byte_length} bytes) ` +
      `to ${filePath} before overwriting. To undo, ${restoreHint}`,
  };
}
