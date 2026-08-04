/**
 * SURGICAL PASS 2026-07-30 — oracle-identity gate.
 *
 * Byte-compares each freshly-downloaded device project against its canonical
 * image in `samples/circuit-ncs/card-backup-2026-07-29/pack5/`. Any mismatch is
 * a STOP: it means the device holds something the canonical bytes do not
 * describe, and staging from the backup would silently revert it.
 *
 * Usage: npx tsx samples/_scratch/surgical-identity-2026-07-30.ts <deviceDir> [--canon <dir>]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const deviceDir = argv[0];
if (deviceDir === undefined) { console.error('usage: <deviceDir> [--canon <dir>]'); process.exit(2); }
const ci = argv.indexOf('--canon');
const canonDir = ci === -1 ? 'samples/circuit-ncs/card-backup-2026-07-29/pack5' : argv[ci + 1];

const SLOTS = [19, 20, 21, 22, 23, 24, 25, 35, 36, 37, 38, 39, 57, 58, 59, 60, 61, 62, 63];

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16);

const files = readdirSync(deviceDir);
let bad = 0;
for (const slot of SLOTS) {
  const hit = files.filter((f) => new RegExp(`-project${slot}-`).test(f)).sort();
  if (hit.length === 0) { console.log(`slot ${slot}: NO DEVICE FILE`); bad++; continue; }
  const dev = readFileSync(`${deviceDir}/${hit[hit.length - 1]}`);
  const canon = readFileSync(`${canonDir}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`);
  if (dev.length !== canon.length) { console.log(`slot ${slot}: LENGTH ${dev.length} vs ${canon.length}`); bad++; continue; }
  let diffs = 0; let first = -1;
  for (let i = 0; i < dev.length; i++) if (dev[i] !== canon[i]) { diffs++; if (first === -1) first = i; }
  if (diffs === 0) console.log(`slot ${String(slot).padStart(2)}: IDENTICAL  sha ${sha(dev)}`);
  else { console.log(`slot ${String(slot).padStart(2)}: ${diffs} DIFF BYTES, first at 0x${first.toString(16)}`); bad++; }
}
console.log(bad === 0 ? `\nORACLE-IDENTITY GATE PASSED: ${SLOTS.length}/${SLOTS.length} identical.` : `\nGATE FAILED: ${bad} slot(s) diverge. STOP.`);
process.exit(bad === 0 ? 0 : 1);
