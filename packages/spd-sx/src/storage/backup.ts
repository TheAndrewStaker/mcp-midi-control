/**
 * SPD-SX backup — copy the config that surgical writes can change (KIT/,
 * WAVE/PRM/, SYSTEM/) to a timestamped folder, plus a manifest of WAVE/DATA
 * so a missing/clobbered wave is detectable. This is the real undo before any
 * device write (the device has no CRC recovery; "Save All onto the device" is
 * NOT a backup).
 *
 * Port of `scripts/spdsx/spdsx_backup.py`. `full` also copies WAVE/DATA audio
 * (hundreds of MB) for disaster recovery; surgical writes are append-only, so
 * a config backup is enough to recover an authoring mistake.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BackupResult {
  dest: string;
  kits: number;
  wavePrms: number;
  full: boolean;
}

function countFiles(dir: string, match: RegExp, recurse = false): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && recurse) n += countFiles(join(dir, e.name), match, recurse);
    else if (e.isFile() && match.test(e.name)) n += 1;
  }
  return n;
}

/** `now` is injected (scripts can't call Date.now in some contexts); pass a Date. */
export function backup(root: string, outDir: string, opts: { full?: boolean; now: Date }): BackupResult {
  if (!existsSync(join(root, 'KIT'))) {
    throw new Error(`not an SPD-SX root (no KIT/): ${root}`);
  }
  const d = opts.now;
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
    `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const dest = join(outDir, `spdsx-${stamp}`);
  mkdirSync(dest, { recursive: true });

  for (const sub of ['KIT', 'SYSTEM', join('WAVE', 'PRM')]) {
    const src = join(root, sub);
    if (existsSync(src) && statSync(src).isDirectory()) {
      cpSync(src, join(dest, sub), { recursive: true });
    }
  }

  // WAVE/DATA: manifest always; full copy only on request.
  const data = join(root, 'WAVE', 'DATA');
  if (existsSync(data)) {
    const lines: string[] = [];
    for (const bucket of readdirSync(data).sort()) {
      const bdir = join(data, bucket);
      if (!statSync(bdir).isDirectory()) continue;
      for (const f of readdirSync(bdir).sort()) {
        if (!f.toLowerCase().endsWith('.wav')) continue;
        lines.push(`${bucket}/${f}\t${statSync(join(bdir, f)).size}`);
      }
    }
    writeFileSync(join(dest, 'DATA-MANIFEST.txt'), lines.join('\n') + '\n', 'utf-8');
    if (opts.full) cpSync(data, join(dest, 'WAVE', 'DATA'), { recursive: true });
  }

  return {
    dest,
    kits: countFiles(join(dest, 'KIT'), /^kit\d+\.spd$/),
    wavePrms: countFiles(join(dest, 'WAVE', 'PRM'), /^\d+\.spd$/, true),
    full: !!opts.full,
  };
}
