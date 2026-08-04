/**
 * Backup index, where backups live, what they are called, and how a user
 * finds one later without knowing any of our directory conventions.
 *
 * Every path in this server that writes a backup file (`export_preset`,
 * backup-before-overwrite, `backup_device`) appends one line here. `list_backups`
 * reads it. That is the whole contract.
 *
 * Three decisions worth knowing:
 *
 * 1. **JSON Lines, not JSON.** Backups are appended one at a time, often while
 *    another tool call is in flight in the same process. An append-only line
 *    log cannot be corrupted by a concurrent writer the way a read-modify-write
 *    JSON array can, and a torn final line costs exactly one entry instead of
 *    the whole index. Parse errors skip the line and keep going.
 *
 * 2. **The index is a CONVENIENCE, never the artifact.** `recordBackup` NEVER
 *    throws: the backup is the file on disk, and a full disk or a read-only
 *    index must not turn a successful backup into a failed tool call. The
 *    inverse would be the worst possible failure mode for a safety feature.
 *
 * 3. **The directory is the source of truth, the index is a cache.**
 *    `listBackups` scans the folder AND reads the index, then merges. That is
 *    what makes backups taken before this module existed (and files the user
 *    dragged in by hand) still findable, and what stops a deleted file from
 *    being listed as if it were still there.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { BackupPolicy, DeviceDescriptor } from '../types.js';

/** Default backup root. One folder, every device, so "where are my backups" has one answer. */
export function defaultBackupDir(): string {
  return path.join(homedir(), 'mcp-midi-backups');
}

/** Index filename inside the backup directory. */
export const BACKUP_INDEX_FILE = 'index.jsonl';

/** Extensions we recognise as backup artifacts when scanning a directory. */
const BACKUP_EXTENSIONS = new Set(['.syx', '.ncs', '.rc0', '.spd', '.bin']);

export interface BackupIndexEntry {
  /** Filename inside the backup directory (not a full path, the directory can move). */
  file_name: string;
  /** Device display name, as the user says it ("Fractal AM4"). */
  device: string;
  /** Descriptor id, for machine matching. */
  device_id?: string;
  /** What this file IS: 'preset' / 'project' / 'kit' / 'active_buffer'. */
  unit: string;
  /** Stored location in DEVICE numbering, when the backup came from a stored slot. */
  location?: number | string;
  /** 1-based microSD pack, on pack-addressed devices. */
  pack?: number;
  /** Content name decoded from the bytes ("Sugar", "Plexi Lead"), when the device gave one. */
  name?: string;
  /** Wire-shape id from `PresetBinaryDump.format`, so a restore can validate before pushing. */
  format?: string;
  byte_length: number;
  /** ISO-8601 UTC. */
  created_at: string;
  /** Which tool wrote it, so a receipt can say how it got here. */
  tool: string;
  /** The tool that puts it back, by name. Absent ⇒ no restore path through this server. */
  restore_with?: string;
}

/** An entry as `list_backups` returns it: index data plus what the filesystem says. */
export interface ListedBackup extends BackupIndexEntry {
  file_path: string;
  /** True when the file was found by directory scan with no index line (pre-index or hand-added). */
  unindexed?: boolean;
  /** True when the index names a file that is no longer on disk. */
  missing?: boolean;
}

/** Collapse anything filesystem-unfriendly to underscores; bound the length. */
export function sanitizeForFilename(s: string, fallback = 'backup'): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Filesystem-safe local timestamp, e.g. `2026-07-27_12-53-18`. Sorts lexicographically. */
export function backupTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '-');
}

/**
 * Append one entry to the index. Never throws, see the header note: a backup
 * that landed on disk must not be reported as failed because the index could
 * not be updated. Returns whether the line was written, for tests.
 */
export function recordBackup(directory: string, entry: BackupIndexEntry): boolean {
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, BACKUP_INDEX_FILE), `${JSON.stringify(entry)}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Read + parse the index, skipping any line that does not parse (a torn tail costs one entry). */
export function readBackupIndex(directory: string): BackupIndexEntry[] {
  const file = path.join(directory, BACKUP_INDEX_FILE);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: BackupIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as BackupIndexEntry;
      if (typeof parsed.file_name === 'string' && parsed.file_name.length > 0) out.push(parsed);
    } catch {
      // Torn or hand-edited line. Skip it; the rest of the index is still good.
    }
  }
  return out;
}

/**
 * Ceiling on how many entries one `list_backups` call may SELECT.
 *
 * One definition, because it had been three: the zod schema's `.max(500)`, a
 * bare `Math.min(opts.limit, 500)` here, and the figure the truncation note
 * quotes back to the agent. A response-budget gate projects against it too
 * (`scripts/verify-response-budget.ts`), so a copy that drifts makes the gate
 * measure a limit the tool does not have.
 *
 * Note this bounds SELECTION, not response size. `executeListBackups` fits the
 * selected rows to a character budget and pages the rest; at 385 measured
 * chars per entry a full 500 would be ~192,000 chars, far past the host's
 * 50,000-char delivery cliff.
 */
export const LIST_BACKUPS_LIMIT_MAX = 500;

/** Entries returned when the caller names no `limit`. */
export const LIST_BACKUPS_LIMIT_DEFAULT = 50;

export interface ListBackupsOptions {
  directory?: string;
  /** Case-insensitive substring match against device display name or id. */
  device?: string;
  /** Exact unit match ('preset' / 'project' / 'kit' / 'active_buffer'). */
  unit?: string;
  /** Max entries returned, newest first. Default 50. */
  limit?: number;
  /** Include index rows whose file is gone from disk (default false). */
  include_missing?: boolean;
  /**
   * Index into the `limit`-selected, newest-first list to resume from, taken
   * from a prior response's `truncated.next_offset`. Applied by
   * `executeListBackups` after the size budget, not here: this function's job
   * is selection, and paging is a property of the response.
   */
  offset?: number;
}

/**
 * List backups, newest first, merging the index with a directory scan.
 *
 * A file present on disk with no index line is returned with `unindexed: true`
 * and whatever the filename and mtime can tell us. That is deliberately
 * generous: a user who has been taking `export_preset` backups since before
 * this index existed should still see them all in one place, even if we can
 * only report the file, its size and its date.
 */
export function listBackups(opts: ListBackupsOptions = {}): { directory: string; backups: ListedBackup[]; total: number } {
  const directory = opts.directory !== undefined && opts.directory.trim().length > 0
    ? opts.directory.trim()
    : defaultBackupDir();
  const limit = opts.limit !== undefined && opts.limit > 0 ? Math.min(opts.limit, LIST_BACKUPS_LIMIT_MAX) : LIST_BACKUPS_LIMIT_DEFAULT;

  const indexed = new Map<string, ListedBackup>();
  for (const e of readBackupIndex(directory)) {
    // Later lines win: a re-recorded filename is a correction, not a duplicate.
    indexed.set(e.file_name, { ...e, file_path: path.join(directory, e.file_name) });
  }

  let onDisk: string[] = [];
  try {
    onDisk = readdirSync(directory).filter((f) => BACKUP_EXTENSIONS.has(path.extname(f).toLowerCase()));
  } catch {
    onDisk = [];
  }
  const onDiskSet = new Set(onDisk);

  const merged: ListedBackup[] = [];
  for (const f of onDisk) {
    const known = indexed.get(f);
    if (known !== undefined) {
      merged.push(known);
      continue;
    }
    // Unindexed artifact: report what the filesystem knows and say so honestly.
    let size = 0;
    let mtime = new Date(0);
    try {
      const st = statSync(path.join(directory, f));
      size = st.size;
      mtime = st.mtime;
    } catch {
      // Raced with a delete; fall through with zeros.
    }
    merged.push({
      file_name: f,
      file_path: path.join(directory, f),
      device: '(unknown, taken before the backup index existed, or added by hand)',
      unit: 'unknown',
      byte_length: size,
      created_at: mtime.toISOString(),
      tool: '(unindexed)',
      unindexed: true,
    });
  }
  if (opts.include_missing) {
    for (const [name, entry] of indexed) {
      if (!onDiskSet.has(name)) merged.push({ ...entry, missing: true });
    }
  }

  const deviceNeedle = opts.device?.trim().toLowerCase();
  const filtered = merged.filter((b) => {
    if (opts.unit !== undefined && b.unit !== opts.unit) return false;
    if (deviceNeedle !== undefined && deviceNeedle.length > 0) {
      const hay = `${b.device} ${b.device_id ?? ''} ${b.file_name}`.toLowerCase();
      if (!hay.includes(deviceNeedle)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { directory, backups: filtered.slice(0, limit), total: filtered.length };
}

// ── Per-device backup policy ──────────────────────────────────────────
//
// Resolved from the descriptor's own declaration when it has one, else
// derived from signals the descriptor already carries. The derivation uses
// GENERIC capability signals (`has_packs`, `transport.kind`, reader/writer
// method presence), never a device id, so a new device inherits a correct,
// cautious policy on registration day without touching this file.

export interface ResolvedBackupPolicy extends BackupPolicy {
  unit_label: string;
  seconds_per_unit: number;
  /** True when the device can dump a STORED location (the sweepable unit). */
  can_dump_stored: boolean;
  /** True when the device can dump its ACTIVE working buffer (unsaved edits included). */
  can_dump_active: boolean;
  /** Set when the device's stored range is known, so a sweep needs no explicit from/to. */
  bounds?: { first: number; last: number };
}

export function resolveBackupPolicy(descriptor: DeviceDescriptor): ResolvedBackupPolicy {
  const declared = descriptor.capabilities.backup ?? {};
  const canDumpStored = descriptor.reader.dumpStoredPresetBinary !== undefined;
  const canDumpActive = descriptor.reader.dumpActivePresetBinary !== undefined;
  const kind = descriptor.transport?.kind ?? 'midi';

  // Unit label: the device's own word for the thing. Generic signals only.
  const unitLabel = declared.unit_label
    ?? (descriptor.capabilities.has_packs === true
      ? 'project'
      : kind === 'storage' || kind === 'hybrid'
        ? 'kit'
        : 'preset');

  // Cost per unit. A pack-addressed device moves whole project FILES over a
  // SysEx block-transfer session (seconds each); a storage device is a plain
  // file copy; a SysEx preset dump is a handful of frames.
  const secondsPerUnit = declared.seconds_per_unit
    ?? (descriptor.capabilities.has_packs === true
      ? 6
      : kind === 'storage' || kind === 'hybrid'
        ? 0.1
        : 1);

  // Restore tool: derived from which write path actually exists, so we never
  // promise a restore route the device does not have.
  const restoreTool = declared.restore_tool
    ?? (descriptor.writer.restorePresetBinary !== undefined
      ? 'import_preset'
      : descriptor.writer.uploadProject !== undefined
        ? 'upload_project'
        : undefined);

  const first = declared.first_location;
  const last = declared.last_location;
  const bounds = first !== undefined && last !== undefined ? { first, last } : undefined;

  return {
    ...declared,
    unit_label: unitLabel,
    seconds_per_unit: secondsPerUnit,
    restore_tool: restoreTool,
    can_dump_stored: canDumpStored,
    can_dump_active: canDumpActive,
    bounds,
  };
}
