/**
 * Safe replace of one file on a device's mounted storage (a card, a USB drive).
 *
 * Owns the steps every storage write needs, so a device writer only says WHAT
 * the new bytes are:
 *
 *   1. Conflict check. The caller passes the SHA-256 of the file as it read it
 *      when it planned the edit. If the file on disk no longer matches, nothing
 *      is written: someone (the unit, another program, another session) changed
 *      it in between, and writing would silently drop their change. The same
 *      check proves the file is the one that was read, on the same volume.
 *   2. Backup. The current bytes are copied into the server's backup folder
 *      (`mcp-midi-backups`) and indexed, so `list_backups` finds it.
 *   3. Write to a temporary file beside the target, flushed to disk, then read
 *      back and compared byte for byte with what was meant.
 *   4. An optional `verify` callback checks the re-read bytes the way the
 *      device will read them (the MPC writer parses the project again).
 *   5. Rename over the target, read it once more, and hand back a receipt with
 *      both hashes and the backup path.
 *
 * A failure at any step before the rename leaves the target untouched and
 * removes the temporary file.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { backupTimestamp, defaultBackupDir, recordBackup, sanitizeForFilename } from '../protocol-generic/dispatcher/backupIndex.js';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface SafeReplaceBackupLabel {
  /** Device display name. */
  device: string;
  device_id: string;
  /** What the file is ('project', 'kit', ...). */
  unit: string;
  /** Where it lives on the device, as the user names it. */
  location: string;
  name?: string;
  /** The tool doing the write. */
  tool: string;
  /** Backup folder; defaults to `mcp-midi-backups` in the home folder. */
  directory?: string;
}

export interface SafeReplaceReceipt {
  /** The file that was replaced. */
  path: string;
  bytes: number;
  sha256_before: string;
  sha256_after: string;
  /** Where the previous bytes were saved. */
  backup_path: string;
}

/** Thrown when the file changed after the edit was planned. Nothing was written. */
export class StorageConflictError extends Error {
  constructor(readonly path: string, readonly expected: string, readonly found: string) {
    super(
      `${basename(path)} changed on disk after it was read (sha256 ${found.slice(0, 12)}, expected ${expected.slice(0, 12)}). `
      + 'Nothing was written. Read it again and redo the edit on the current copy.',
    );
    this.name = 'StorageConflictError';
  }
}

export function safeReplaceFile(args: {
  path: string;
  bytes: Uint8Array;
  /** SHA-256 of the file as read when the edit was planned. */
  expectSha256: string;
  backup: SafeReplaceBackupLabel;
  /** Check the re-read bytes the way the device will read them; throw to abort. */
  verify?: (written: Uint8Array) => void;
}): SafeReplaceReceipt {
  const { path, bytes } = args;
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${path} is not there to replace. Nothing was written.`);
  }
  const current = readFileSync(path);
  const before = sha256(current);
  if (before !== args.expectSha256) throw new StorageConflictError(path, args.expectSha256, before);

  const dir = args.backup.directory !== undefined && args.backup.directory.trim() !== '' ? args.backup.directory.trim() : defaultBackupDir();
  mkdirSync(dir, { recursive: true });
  const ext = extname(path) || '.bin';
  const backupName = `${sanitizeForFilename(args.backup.device, 'device')}-${sanitizeForFilename(args.backup.name ?? basename(path, ext), 'file')}-${backupTimestamp()}${ext}`;
  const backupPath = join(dir, backupName);
  copyFileSync(path, backupPath);
  if (sha256(readFileSync(backupPath)) !== before) {
    throw new Error(`The backup at ${backupPath} does not match ${basename(path)}. Nothing was written.`);
  }
  recordBackup(dir, {
    file_name: backupName,
    device: args.backup.device,
    device_id: args.backup.device_id,
    unit: args.backup.unit,
    location: args.backup.location,
    ...(args.backup.name !== undefined ? { name: args.backup.name } : {}),
    byte_length: current.length,
    created_at: new Date().toISOString(),
    tool: args.backup.tool,
  });

  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const reread = readFileSync(tmp);
    if (!Buffer.from(bytes).equals(reread)) {
      throw new Error(`The temporary copy of ${basename(path)} read back different from what was written. Nothing was replaced.`);
    }
    args.verify?.(reread);
    // A last look before the rename: the window since the first check is the
    // backup and one write, but another writer on the same card is possible.
    const now = sha256(readFileSync(path));
    if (now !== before) throw new StorageConflictError(path, before, now);
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
  const after = sha256(readFileSync(path));
  if (after !== sha256(bytes)) {
    throw new Error(`${basename(path)} reads back different from what was written. The previous copy is at ${backupPath}.`);
  }
  return { path, bytes: bytes.length, sha256_before: before, sha256_after: after, backup_path: backupPath };
}
