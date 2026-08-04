/**
 * circuit-verify-backup.ts — verify a card backup's OWN integrity, on disk only.
 *
 * Touches NO hardware and opens NO port. Re-hashes every file the manifest
 * claims and reports mismatches, missing files, and orphans (files on disk the
 * manifest does not list). A backup nobody has re-hashed is not a backup.
 *
 * ## Two questions, kept apart
 *
 * A hash match says the file on disk is the file that was captured. It says
 * NOTHING about whether that file is a usable project, and neither does the
 * manifest's `crc_verified`, because the device's WRITE_FINISH CRC32 covers the
 * ENCODED STREAM rather than the decoded `.ncs`. So each project is also
 * structure-checked here, and the two verdicts are reported in separate
 * sections with separate counts:
 *
 *   - **BACKUP DAMAGED** (missing / size / hash): the backup itself is broken.
 *     Recapture. This is what sets the exit code.
 *   - **NOT RESTORABLE** (structure): the backup is intact and faithfully holds
 *     a file that is not a project. Recapturing changes nothing; the damage is
 *     on the card. Reported loudly, and deliberately NOT an exit-1, because
 *     failing the standard command on a known, permanent, already-recorded
 *     condition trains people to ignore the command.
 *
 *   npx tsx scripts/circuit-verify-backup.ts [--dir <backup root>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { checkNcsStructure } from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const DIR = flag('--dir') ?? 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Rec { file?: string; bytes?: number; sha256?: string; crc_verified?: boolean; structurally_valid?: boolean; wire_slot?: number; embedded_name?: string; device_project?: number }
interface PackRecord { device_pack: number; pack_name: string; projects: Rec[]; samples: Rec[]; patch_files: Rec[] }
interface Manifest { captured_at: string; packs: PackRecord[] }

const walk = (root: string): string[] => {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  rec(root);
  return out;
};

function main(): void {
  const mp = join(DIR, 'manifest.json');
  if (!existsSync(mp)) { console.error(`no manifest at ${mp}`); process.exit(2); }
  const m = JSON.parse(readFileSync(mp, 'utf8')) as Manifest;

  console.log(`Verifying backup at ${DIR}`);
  console.log(`Captured ${m.captured_at}\n`);

  const listed = new Set<string>(['manifest.json', 'INDEX.md']);
  let ok = 0, badHash = 0, badSize = 0, missing = 0, noHash = 0;
  /** Structurally invalid projects, and whether the manifest called them CRC-verified. */
  const notRestorable: { where: string; file: string; faults: string[]; crcVerified: boolean; recorded: boolean }[] = [];

  const check = (kind: string, pack: number, r: Rec): void => {
    if (r.file === undefined) return;              // name-only sample record
    listed.add(r.file);
    const p = join(DIR, r.file);
    if (!existsSync(p)) { missing++; console.log(`  MISSING   pack${pack} ${kind} ${r.file}`); return; }
    const b = new Uint8Array(readFileSync(p));
    if (r.bytes !== undefined && b.length !== r.bytes) {
      badSize++; console.log(`  SIZE      pack${pack} ${kind} ${r.file}: manifest ${r.bytes}B, disk ${b.length}B`); return;
    }
    if (r.sha256 === undefined) { noHash++; console.log(`  NO HASH   pack${pack} ${kind} ${r.file} (manifest carries none)`); return; }
    const h = sha256(b);
    if (h !== r.sha256) { badHash++; console.log(`  SHA256    pack${pack} ${kind} ${r.file}: manifest ${r.sha256.slice(0, 16)}…, disk ${h.slice(0, 16)}…`); return; }
    ok++;
    // Structure is checked on the bytes, not taken from the manifest, so this
    // works on a manifest written before the field existed AND catches a
    // manifest that claims a validity it does not have.
    if (kind === 'project') {
      const st = checkNcsStructure(b);
      if (!st.ok) {
        notRestorable.push({
          where: `pack${pack} project ${r.device_project ?? '?'} "${r.embedded_name ?? ''}"`,
          file: r.file, faults: st.faults, crcVerified: r.crc_verified === true, recorded: r.structurally_valid === false,
        });
      } else if (r.structurally_valid === false) {
        console.log(`  MANIFEST  pack${pack} ${kind} ${r.file}: recorded structurally_valid:false but the file passes. Stale record.`);
      }
    }
  };

  for (const p of m.packs) {
    for (const r of p.projects) check('project', p.device_pack, r);
    for (const r of p.samples) check('sample', p.device_pack, r);
    for (const r of p.patch_files) check('patchbank', p.device_pack, r);
  }

  const onDisk = walk(DIR);
  const orphans = onDisk.filter((f) => !listed.has(f));

  console.log(`\nManifest-listed files re-hashed: ${ok} OK, ${badHash} hash mismatch, ${badSize} size mismatch, ${missing} missing, ${noHash} without a manifest hash.`);
  console.log(`Files on disk: ${onDisk.length}; listed by manifest: ${listed.size}; orphans: ${orphans.length}`);
  for (const o of orphans) console.log(`  ORPHAN    ${o}  (${statSync(join(DIR, o)).size}B)`);

  const bad = badHash + badSize + missing;
  console.log(bad === 0 ? '\nBACKUP INTACT — every listed file re-hashed to its manifest sha256.' : `\n** BACKUP DAMAGED — ${bad} problem file(s) **`);

  // A separate verdict, on purpose. "The backup is intact" and "every file in it
  // is restorable" are different claims, and the whole point of this pass is
  // that the first was being read as the second.
  if (notRestorable.length === 0) {
    console.log('STRUCTURE OK: every project in this backup is a valid .ncs and can be restored.');
  } else {
    console.log(`\n** NOT RESTORABLE: ${notRestorable.length} project(s) are intact copies of a file that is not a project **`);
    for (const n of notRestorable) {
      console.log(`  ${n.where}  ${n.file}`);
      for (const f of n.faults) console.log(`      ${f}`);
      if (n.crcVerified) {
        console.log('      The manifest records crc_verified:true, and that is CORRECT: the transfer was faithful.');
        console.log('      The device CRC32 covers the ENCODED STREAM, not the decoded file, so it cannot see this.');
      }
      if (!n.recorded) console.log('      Manifest carries no structurally_valid:false for it. Re-run circuit-backup-card.ts against this directory to record it.');
    }
    console.log('  These are NOT transfer failures. Recapturing fetches the same bytes; the damage is on the card.');
    console.log('  upload_project refuses them, so the exit code below reports BACKUP integrity only.');
  }
  process.exit(bad === 0 ? 0 : 1);
}

main();
