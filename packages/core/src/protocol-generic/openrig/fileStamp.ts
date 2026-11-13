/**
 * File STAMP: a cheap "has this file changed on disk since I read it" check for
 * the manifest + inventory caches.
 *
 * Why it exists (2026-09-16): both loaders parsed once and cached forever,
 * invalidating only on the server's OWN writes. A hand edit to `rig.json` was
 * invisible to `describe_rig` (it reported 20 cables against 23 on disk), and the
 * next `edit_rig` rebuilt from the stale copy and wrote it back over the hand
 * edits. One `statSync` per load closes both halves.
 */
import * as fs from 'node:fs';

/** mtime + size of a file, or `absent` when there is no file at the path. */
export type FileStamp = { mtimeMs: number; size: number } | 'absent';

export function stampFile(path: string): FileStamp {
  try {
    const s = fs.statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return 'absent';
  }
}

export function sameStamp(a: FileStamp | undefined, b: FileStamp): boolean {
  if (a === undefined) return false;
  if (a === 'absent' || b === 'absent') return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
