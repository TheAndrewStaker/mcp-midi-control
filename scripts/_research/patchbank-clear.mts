/**
 * patchbank-clear.mts - BACK UP, PROVE, THEN CLEAR a pack's synth patch bank.
 *
 * The patch uploader refuses any group that is not empty and deliberately never sends DELETE_FILE,
 * which is the right default. This is the separate, explicit step for the case where the owner has
 * asked for a pack to be REPLACED - here: "pack 3 sounds good, just apply that to all of them".
 *
 * ORDER IS THE WHOLE SAFETY STORY, and it is strict:
 *
 *   1. probe   - which group slots are occupied
 *   2. READ    - download every occupied group via readStoredPatch (the device's own CRC gates it)
 *   3. PROVE   - every occupied group must be on disk, the right length, CRC-ok, and non-trivial.
 *                If ANY read failed or looks empty, STOP. Nothing is deleted.
 *   4. delete  - only then, and only the groups just proven backed up. `deleteSlots` guards each one
 *                with its own QUERY_EXISTS -> require OCCUPIED -> DELETE -> require ACK -> re-query
 *                -> require FREE.
 *   5. confirm - re-probe; every target must read FREE.
 *
 * DELETE_FILE is destructive and immediate: the device drops the file and ACKs. There is no undo on
 * the device, which is exactly why step 3 refuses to proceed on a partial backup.
 *
 * Usage: npx tsx scripts/_research/patchbank-clear.mts <wirePack> [--confirm]
 *   without --confirm this is a DRY RUN: it backs up and reports, and deletes nothing.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect } from '../../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript } from '../_lib/midi-lifecycle.js';
import { probeSlots, deleteSlots, FILE_TYPE } from '../../packages/circuit-tracks/src/ncs/fileDelete.js';
import { readStoredPatch } from '../../packages/circuit-tracks/src/codec/patchTransfer.js';

const PACK = Number(process.argv[2]);
const CONFIRM = process.argv.includes('--confirm');
if (!Number.isInteger(PACK) || PACK < 0 || PACK > 4) throw new Error('wire pack must be 0..4 (device Pack 1..5)');
const OUT = `samples/circuit-tracks/patchbank-preclear-wire${PACK}-2026-09-20`;
const GROUPS = Array.from({ length: 16 }, (_, g) => g);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' });
console.log(`wire pack ${PACK} = device Pack ${PACK + 1}${CONFIRM ? '' : '   (DRY RUN - nothing will be deleted)'}\n`);

// ---- 1. probe --------------------------------------------------------------------------------
const probe = await probeSlots(conn, FILE_TYPE.PATCH, GROUPS, { pack: PACK });
const occupied = probe.slots.filter((s) => s.exists).map((s) => s.slot);
console.log(`occupied group slots: ${occupied.length ? occupied.join(', ') : '(none)'}`);
if (occupied.length === 0) { console.log('nothing to clear; the uploader can write directly.'); exitMidiScript(0); }

// ---- 2 + 3. read every occupied group, and PROVE the backup before anything is deleted --------
mkdirSync(OUT, { recursive: true });
const backed: number[] = [];
const failed: string[] = [];
for (const g of occupied) {
  await sleep(150);
  const r = await readStoredPatch(conn, g, { responseTimeoutMs: 8000 });
  if (!r.ok || r.bytes === undefined || r.bytes.length === 0) {
    failed.push(`g${g}: ${r.error ?? 'no bytes returned'}`);
    console.log(`  g${String(g).padStart(2)}  READ FAILED  ${r.error ?? 'no bytes'}`);
    continue;
  }
  const path = `${OUT}/${String(g).padStart(2, '0')}_PATCHBANK.cpb`;
  writeFileSync(path, r.bytes);
  backed.push(g);
  const name = r.name ?? '(unnamed)';
  console.log(`  g${String(g).padStart(2)}  backed up ${String(r.bytes.length).padStart(5)} B  crcOk=${r.crcOk}  "${name}"  -> ${path}`);
}

console.log(`\nbacked up ${backed.length}/${occupied.length} occupied group(s) to ${OUT}`);
if (failed.length > 0) {
  console.log('\n==== REFUSING TO DELETE ====');
  for (const f of failed) console.log(`  ${f}`);
  console.log('A delete is irreversible on the device and the backup is incomplete. Nothing was deleted.');
  exitMidiScript(1);
}

if (!CONFIRM) {
  console.log('\nDRY RUN complete. Backup is proven. Re-run with --confirm to delete and clear the bank.');
  // `exitMidiScript`, NOT `endMidiScript`. The latter returns VOID and execution FALLS THROUGH into
  // the delete below; `exitMidiScript` returns `never` and terminates, which is precisely why
  // midi-lifecycle.ts distinguishes them ("anything that returns void would silently let the code
  // below it run on"). Caught on the first dry run of this script (2026-09-20) with the wrong one:
  // it printed "DRY RUN complete" and then entered deleteSlots. Nothing reached the device only
  // because the teardown had already closed the port, so the first send threw first. That is luck,
  // not a safeguard, and a dry run that can delete is worse than no dry run.
  exitMidiScript(0);
}

// ---- 4. delete, each slot guarded by its own query ------------------------------------------
console.log(`\ndeleting ${backed.length} group(s)...`);
const results = await deleteSlots(conn, FILE_TYPE.PATCH, backed, { pack: PACK });
for (const r of results) console.log(`  g${String(r.slot).padStart(2)}  ${r.deleted ? 'deleted' : `NOT DELETED: ${r.error ?? 'unknown'}`}`);

// ---- 5. confirm --------------------------------------------------------------------------------
await sleep(1200);
const after = await probeSlots(conn, FILE_TYPE.PATCH, GROUPS, { pack: PACK });
const still = after.slots.filter((s) => s.exists).map((s) => s.slot);
console.log(`\nafter: ${still.length ? `STILL OCCUPIED: ${still.join(', ')}` : 'all 16 group slots FREE'}`);
endMidiScript(still.length === 0 ? 0 : 1);
