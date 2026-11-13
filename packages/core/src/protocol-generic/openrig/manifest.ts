/**
 * OpenRig Phase C: load a rig manifest (an OpenRig L1 `rig.json`) the reference
 * implementation validates and surfaces through `describe_rig`.
 *
 * Source: the `MCP_RIG_MANIFEST` env var, an absolute (or cwd-relative) path to a
 * rig.json. Env-var-driven ONLY, by design: there is no silent default-path load,
 * so `executeDescribeRig` stays a pure function of (registry, env) and every test
 * that touches it is hermetic (the golden simply clears the var). The maintainer
 * points the var at a private, gitignored `docs/_private/rig/rig.json` in the
 * server's launch config, exactly as `MCP_RIG_LINKS` / `MCP_FM3_SERIAL_PATH` are
 * set.
 *
 * Cached per PATH and per FILE STAMP: the cache remembers which `MCP_RIG_MANIFEST`
 * value produced it and the file's mtime + size, and reloads when either changes
 * (a repointed env var, or a hand edit to the file while the server runs). Call
 * `invalidateRigManifest()` (alias `clearRigManifestCache()`) to force a re-read.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { Rig } from 'openrig';

import { emitRigStoreWrite } from './events.js';
import { sameStamp, stampFile, type FileStamp } from './fileStamp.js';

export const RIG_MANIFEST_ENV = 'MCP_RIG_MANIFEST';

export type LoadedRigManifest =
  | { status: 'loaded'; rig: Rig; source: string }
  /** The path is configured but no file exists there yet (create it, do not "fix" it). */
  | { status: 'absent'; source: string }
  | { status: 'error'; error: string; source: string }
  | { status: 'unconfigured' };

let cache: LoadedRigManifest | undefined;
/** The `MCP_RIG_MANIFEST` value `cache` was loaded from (undefined = unconfigured). */
let cachedPath: string | undefined;
/** The file's stamp taken BEFORE `cache` was read (so a change mid-read reloads next time). */
let cachedStamp: FileStamp | undefined;

function load(): LoadedRigManifest {
  const path = process.env[RIG_MANIFEST_ENV];
  if (path === undefined || path.trim() === '') return { status: 'unconfigured' };
  const source = path.trim();
  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (e) {
    // A configured-but-not-yet-created manifest is a distinct state from a
    // corrupt/unreadable one: `absent` means "createRigManifest can make it",
    // while `error` means "a file is there and something is wrong with it".
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', source };
    return { status: 'error', source, error: `cannot read rig manifest at ${source}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: 'error', source, error: `rig manifest at ${source} is not valid JSON: ${(e as Error).message}` };
  }
  // Structural guard: valid JSON is not necessarily a Rig. Verify the shape the
  // consumers dereference (validateRig iterates nodes; deriveRigLinks maps them)
  // so a wrong/partial file degrades to a helpful status:'error' rather than
  // crashing describe_rig / apply_pattern with a bare TypeError.
  const obj = parsed as { nodes?: unknown; edges?: unknown };
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    return {
      status: 'error',
      source,
      error: `rig manifest at ${source} is not a valid OpenRig rig (expected a JSON object with "nodes" and "edges" arrays)`,
    };
  }
  return { status: 'loaded', rig: parsed as Rig, source };
}

/**
 * The configured rig manifest, or `unconfigured` when `MCP_RIG_MANIFEST` is unset.
 * Cached per path, and re-read whenever the file's mtime or size changed, so a
 * hand edit made while the server runs is what the next call sees.
 */
export function loadRigManifest(): LoadedRigManifest {
  const path = rigManifestSource();
  const stamp: FileStamp = path === undefined ? 'absent' : stampFile(path);
  if (cache === undefined || cachedPath !== path || !sameStamp(cachedStamp, stamp)) {
    cache = load();
    cachedPath = path;
    cachedStamp = stamp;
  }
  return cache;
}

/**
 * The stamp of the file the CURRENT cache was read from. An editor captures this
 * right after `loadRigManifest()` and hands it to `writeRigManifest` as
 * `ifUnchangedSince`, so a write never lands over a change it did not read.
 */
export function loadedRigManifestStamp(): FileStamp | undefined {
  return cachedStamp;
}

/** Drop the parsed-manifest cache so the next `loadRigManifest()` re-reads from disk. */
export function invalidateRigManifest(): void {
  cache = undefined;
  cachedPath = undefined;
  cachedStamp = undefined;
}

/** Thrown by `writeRigManifest` when the file changed after the edit read it. */
export class RigManifestChangedError extends Error {
  constructor(source: string) {
    super(`the rig manifest at ${source} changed on disk after this edit read it; nothing was written. Re-run the edit so it applies to the current file.`);
    this.name = 'RigManifestChangedError';
  }
}

/** Alias for `invalidateRigManifest()` (the historical name; verify scripts call it). */
export const clearRigManifestCache = invalidateRigManifest;

/** The configured manifest path, or undefined when `MCP_RIG_MANIFEST` is unset. */
export function rigManifestSource(): string | undefined {
  const path = process.env[RIG_MANIFEST_ENV];
  return path === undefined || path.trim() === '' ? undefined : path.trim();
}

/** How many `.bak` siblings `writeRigManifest` keeps regardless of age. */
const BACKUP_KEEP_COUNT = 20;
/** Backups younger than this survive pruning even past the keep count. */
const BACKUP_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Prune old `<basename>.<iso>.bak` siblings of `source`, keeping the newest
 * `BACKUP_KEEP_COUNT` plus anything with an mtime younger than `BACKUP_KEEP_MS`.
 * The ISO stem sorts lexically chronological, so a plain sort orders by age.
 * Best-effort: an unstattable/undeletable file is skipped, never fatal (pruning
 * must not fail a write that already succeeded). Returns the pruned filenames.
 */
function pruneBackups(source: string): string[] {
  const dir = nodePath.dirname(source);
  const prefix = `${nodePath.basename(source)}.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.bak'));
  } catch {
    return [];
  }
  entries.sort(); // ISO stem: lexical order == chronological order, oldest first
  const excess = entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP_COUNT));
  const cutoff = Date.now() - BACKUP_KEEP_MS;
  const pruned: string[] = [];
  for (const f of excess) {
    const full = nodePath.join(dir, f);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue; // young enough to keep
      fs.unlinkSync(full);
      pruned.push(f);
    } catch {
      // skip: a vanished or locked backup is not worth failing the write over
    }
  }
  return pruned;
}

/**
 * Persist an edited rig back to the configured manifest file, BACKING UP the
 * existing file first (safe-edit contract: no silent overwrite of a config the
 * server did not create), then pruning old backups (newest 20 + anything under
 * 7 days always survive). Writes pretty JSON, then invalidates the parse cache
 * so the next `loadRigManifest` / `describe_rig` reflects the change. The caller
 * is responsible for having VALIDATED `rig` before calling this (a malformed rig
 * must never reach disk).
 *
 * `ifUnchangedSince`: the stamp the caller's copy was read at. When the file on
 * disk no longer matches it, the write is REFUSED with `RigManifestChangedError`
 * (nothing backed up, nothing written) instead of silently discarding the change.
 */
export function writeRigManifest(
  rig: Rig, opts: { ifUnchangedSince?: FileStamp } = {},
): { source: string; backup?: string; pruned?: string[] } {
  const source = rigManifestSource();
  if (source === undefined) {
    throw new Error(`${RIG_MANIFEST_ENV} is not set; there is no rig manifest to write.`);
  }
  if (opts.ifUnchangedSince !== undefined && !sameStamp(opts.ifUnchangedSince, stampFile(source))) {
    throw new RigManifestChangedError(source);
  }
  let backup: string | undefined;
  let pruned: string[] | undefined;
  if (fs.existsSync(source)) {
    backup = `${source}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(source, backup);
    const removed = pruneBackups(source);
    if (removed.length > 0) pruned = removed;
  }
  fs.writeFileSync(source, `${JSON.stringify(rig, null, 2)}\n`, 'utf8');
  invalidateRigManifest();
  emitRigStoreWrite({ kind: 'manifest', source, created: false });
  return { source, backup, pruned };
}

/**
 * Create the configured manifest file for the first time (the `absent` state's
 * exit). REFUSES if a file already exists at the path: creation is never an
 * overwrite; edits of an existing manifest go through `writeRigManifest` and its
 * backup contract. The caller validates `rig` first, same as writeRigManifest.
 */
export function createRigManifest(rig: Rig): { source: string; created: true } {
  const source = rigManifestSource();
  if (source === undefined) {
    throw new Error(`${RIG_MANIFEST_ENV} is not set; there is nowhere to create a rig manifest.`);
  }
  if (fs.existsSync(source)) {
    throw new Error(`a rig manifest already exists at ${source}; refusing to overwrite it. Edit it via writeRigManifest (which backs up first).`);
  }
  fs.writeFileSync(source, `${JSON.stringify(rig, null, 2)}\n`, 'utf8');
  invalidateRigManifest();
  emitRigStoreWrite({ kind: 'manifest', source, created: true });
  return { source, created: true };
}
