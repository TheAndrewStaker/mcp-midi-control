/**
 * SPD-SX storage-transport discovery — find the mounted `Roland/SPD-SX` root.
 *
 * In WAVE MGR mode the SPD-SX mounts as a removable drive containing a
 * `Roland\SPD-SX\` tree (Windows, once the Roland driver is installed) or
 * `/Volumes/<name>/Roland/SPD-SX` (macOS, class-compliant, no driver). We
 * locate it by scanning candidate mount points for that signature folder
 * (it must contain a `KIT` directory). An explicit `MCP_SPDSX_ROOT` override
 * wins (mirrors the FM3's `MCP_FM3_SERIAL_PATH`).
 *
 * This is the storage analogue of MIDI port resolution — NOT a MIDI port. The
 * dispatcher's MIDI path is untouched; storage operations resolve a drive here.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SPDSX_ROOT_ENV = 'MCP_SPDSX_ROOT';

/** True if `root` looks like a `Roland/SPD-SX` tree (has a KIT dir). */
export function isSpdsxRoot(root: string): boolean {
  try {
    return statSync(join(root, 'KIT')).isDirectory();
  } catch {
    return false;
  }
}

/** Candidate `Roland/SPD-SX` roots under a single mount point, in order. */
function candidatesUnder(mount: string): string[] {
  return [join(mount, 'Roland', 'SPD-SX'), join(mount, 'SPD-SX'), mount];
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
 * Resolve the mounted SPD-SX root, or undefined if none is found.
 * Order: `MCP_SPDSX_ROOT` override, then a scan of platform mount points.
 */
export function resolveSpdsxRoot(): string | undefined {
  const override = process.env[SPDSX_ROOT_ENV];
  if (override && override.trim() !== '') {
    return isSpdsxRoot(override) ? override : undefined;
  }
  const mounts = process.platform === 'win32' ? windowsMounts() : unixMounts();
  for (const mount of mounts) {
    if (!existsSync(mount)) continue;
    for (const cand of candidatesUnder(mount)) {
      if (isSpdsxRoot(cand)) return cand;
    }
  }
  return undefined;
}
