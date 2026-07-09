/**
 * Boss RC-505mk2 storage-transport discovery — find the mounted `ROLAND` root.
 *
 * In `STORAGE: CONNECT` mode the RC-505mk2 mounts as a removable drive whose
 * memories live under `ROLAND/DATA/MEMORY###A.RC0` / `###B.RC0` (a redundant
 * A/B pair per memory), alongside `SYSTEM1.RC0` / `SYSTEM2.RC0` / `RHYTHM.RC0`.
 * We locate the tree by scanning candidate mount points for a `DATA` folder that
 * holds at least one `MEMORY*.RC0`. An explicit `MCP_RC505_ROOT` override wins
 * (mirrors the SPD-SX `MCP_SPDSX_ROOT` and the FM3's `MCP_FM3_SERIAL_PATH`).
 *
 * The resolved root is the folder that DIRECTLY contains `DATA/` (i.e. the
 * `ROLAND` folder); the memory store joins `DATA/<file>` under it. This is the
 * storage analogue of MIDI port resolution — NOT a MIDI port; the dispatcher's
 * MIDI path is untouched, storage operations resolve a drive here.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RC505_ROOT_ENV = 'MCP_RC505_ROOT';

/** True if `root` holds a `DATA/` directory with at least one `MEMORY*.RC0`. */
export function isRc505Root(root: string): boolean {
  try {
    const data = join(root, 'DATA');
    if (!statSync(data).isDirectory()) return false;
    return readdirSync(data).some((f) => /^MEMORY.*\.RC0$/i.test(f));
  } catch {
    return false;
  }
}

/** Candidate `ROLAND` roots under a single mount point, in order. */
function candidatesUnder(mount: string): string[] {
  return [join(mount, 'ROLAND'), join(mount, 'Roland'), mount];
}

/** Windows drive letters D..Z (skip C:, the system disk). */
function windowsMounts(): string[] {
  const out: string[] = [];
  for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    out.push(`${String.fromCharCode(c)}:\\`);
  }
  return out;
}

/** macOS/Linux removable mount points. */
function unixMounts(): string[] {
  const out: string[] = [];
  for (const base of ['/Volumes', '/media', '/mnt', '/run/media']) {
    try {
      for (const name of readdirSync(base)) out.push(join(base, name));
    } catch {
      // base doesn't exist on this platform; skip.
    }
  }
  return out;
}

/**
 * Resolve the mounted RC-505mk2 `ROLAND` root, or undefined if none is found.
 * Order: `MCP_RC505_ROOT` override, then a scan of platform mount points.
 */
export function resolveRc505Root(): string | undefined {
  const override = process.env[RC505_ROOT_ENV];
  if (override && override.trim() !== '') {
    return isRc505Root(override) ? override : undefined;
  }
  const mounts = process.platform === 'win32' ? windowsMounts() : unixMounts();
  for (const mount of mounts) {
    if (!existsSync(mount)) continue;
    for (const cand of candidatesUnder(mount)) {
      if (isRc505Root(cand)) return cand;
    }
  }
  return undefined;
}
