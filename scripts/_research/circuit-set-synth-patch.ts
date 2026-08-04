/**
 * Set a project's stored SYNTH 1 / SYNTH 2 patch number, surgically.
 *
 * THE DECODE (hardware-proven 2026-08-01, this repo's own card):
 *   0xCD64 = Synth 1 patch, 0xCD6C = Synth 2 patch, both stored 0-BASED.
 *   Proof: the maintainer saved Pack 5 project 41 with Synth 1 patch 20 and
 *   project 42 with patch 40; the bytes read 19 and 39. Offsets originally from
 *   the `Ondrysak/ncstool` map (Ghidra decompilation of Novation's own .ncs
 *   validator), whose drum-binding offset 0x1A278 independently matches this
 *   repo's hardware-confirmed decode.
 *
 * WHY 0-BASED MATTERS: the stored byte IS the Program Change value the Circuit
 * transmits when that patch is selected. Store 14 -> the device shows patch 15
 * -> it sends PC 14 -> a Hydrasynth in bank A loads A015. Same number end to
 * end, once you accept the display is 1-based and the wire is not.
 *
 * SAFETY: download-patch-upload-verify, in that order, every run.
 *   - refuses if the slot holds no readable project
 *   - writes a timestamped backup of the ORIGINAL bytes before uploading
 *   - asserts the staged buffer differs from the original in EXACTLY the one
 *     byte, before anything is sent
 *   - re-downloads after the write and byte-compares the whole file against the
 *     staged buffer, so the proof is against the DEVICE, not the local buffer
 *
 *   npx tsx scripts/_research/circuit-set-synth-patch.ts <project 1..64> <pack 1..8> <displayPatch 1..128> [--synth2] [--dry]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { downloadProject, uploadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';

export const SYNTH1_PATCH_OFFSET = 0xcd64;
export const SYNTH2_PATCH_OFFSET = 0xcd6c;

const project = Number(process.argv[2]);
const packDisplay = Number(process.argv[3]);
const displayPatch = Number(process.argv[4]);
const useSynth2 = process.argv.includes('--synth2');
const dryRun = process.argv.includes('--dry');
const BACKUP_DIR = process.env.CIRCUIT_PATCH_BACKUP_DIR ?? 'samples/circuit-ncs/synth-patch-backups';

if (!Number.isInteger(project) || project < 1 || project > 64) throw new Error('project must be 1..64');
if (!Number.isInteger(packDisplay) || packDisplay < 1 || packDisplay > 8) throw new Error('pack must be 1..8');
if (!Number.isInteger(displayPatch) || displayPatch < 1 || displayPatch > 128) throw new Error('patch must be 1..128 (as the device displays it)');

const slot = project - 1;
const pack = packDisplay - 1;
const offset = useSynth2 ? SYNTH2_PATCH_OFFSET : SYNTH1_PATCH_OFFSET;
const label = useSynth2 ? 'Synth 2' : 'Synth 1';
const stored = displayPatch - 1;

async function main(): Promise<void> {
  const c = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered on? Components closed?).' });
  try {
    const before = await downloadProject(c, slot, { pack });
    if (!before.bytes) throw new Error(`Pack ${packDisplay} project ${project} holds no readable project (${before.error ?? 'empty'}) — refusing to write.`);
    const orig = Buffer.from(before.bytes);
    const name = orig.slice(0x10, 0x20).toString('latin1').replace(/\0/g, '').trim();
    const wasStored = orig[offset];
    console.log(`Pack ${packDisplay} project ${project} = ${JSON.stringify(name)} (crcOk=${before.crcOk})`);
    console.log(`  ${label} patch: stored ${wasStored} (displays ${wasStored + 1})  ->  stored ${stored} (displays ${displayPatch})`);

    if (wasStored === stored) { console.log('  already set; nothing to do.'); return; }

    const staged = Buffer.from(orig);
    staged[offset] = stored;

    // Gate: exactly one byte may differ, and it must be the one we intend.
    const diffs: number[] = [];
    for (let i = 0; i < orig.length; i++) if (orig[i] !== staged[i]) diffs.push(i);
    if (diffs.length !== 1 || diffs[0] !== offset) {
      throw new Error(`staging gate failed: expected exactly 1 diff at 0x${offset.toString(16)}, got ${diffs.length} at [${diffs.map((d) => '0x' + d.toString(16)).join(', ')}]`);
    }
    console.log(`  staged: 1 byte changed at 0x${offset.toString(16)}`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(BACKUP_DIR, `pack${packDisplay}-proj${project}-before-${stamp}.ncs`);
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, orig);
    console.log(`  backup: ${backup}`);

    if (dryRun) { console.log('  --dry: not uploading.'); return; }

    const up = await uploadProject(c, staged, slot, { pack });
    if (!up.ok) throw new Error(`upload failed: ${up.error ?? 'unknown'}`);
    console.log('  uploaded.');

    // SETTLE + RETRY. Observed 2026-08-01: the read immediately after an upload
    // returns no READ_INIT, and a second read a moment later returns the slot
    // perfectly. Without this the script cries corruption over a clean write,
    // which is the worst possible false alarm — it invites a needless restore.
    let after = await (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, 600));
        const r = await downloadProject(c, slot, { pack });
        if (r.bytes) return r;
        console.log(`  read-back attempt ${attempt + 1} returned nothing; settling...`);
      }
      return await downloadProject(c, slot, { pack });
    })();
    if (!after.bytes) throw new Error('read-back returned nothing after 5 attempts — VERIFY BY HAND before trusting this slot.');
    const back = Buffer.from(after.bytes);
    if (!back.equals(staged)) {
      const bad: number[] = [];
      for (let i = 0; i < staged.length && bad.length < 12; i++) if (staged[i] !== back[i]) bad.push(i);
      throw new Error(`READ-BACK MISMATCH vs staged at [${bad.map((d) => '0x' + d.toString(16)).join(', ')}] — restore from ${backup}`);
    }
    console.log(`  VERIFIED against the device: ${label} patch now displays ${displayPatch}, every other byte identical.`);
  } finally {
    c.close();
  }
}
main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
