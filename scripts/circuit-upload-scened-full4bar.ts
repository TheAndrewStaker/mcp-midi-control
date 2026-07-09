/**
 * Upload the scene-baked full4bar projects (from circuit-bake-scenes.ts) to their
 * device slots, reading each back to verify byte-exact. Slot map matches
 * circuit-upload-packed-sets.ts: SONGS order from START_SLOT, full4bar on the even
 * slot of each song's pair. the_summoning (slot 42 / Project 43) already holds the
 * hardware-confirmed scene reference, so it is SKIPPED by default.
 *
 * Requires the "Circuit Tracks" port FREE (close Novation Components).
 *
 *   npx tsx scripts/circuit-upload-scened-full4bar.ts [--include-summoning]
 */
import { readFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { downloadProject, uploadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const DIR = 'samples/circuit-tracks/grooves/packed/scened';
const SONGS = [
  'the_summoning', 'granite', 'the_offering', 'take_me_back_to_eden', 'aqua_regia',
  'ascensionism', 'hypnosis', 'chokehold', 'vore', 'rain',
] as const;
const START_SLOT = 42; // the_summoning full4bar; +2 per song
const SETTLE_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = () => connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (powered on? Components closed?).' });

const includeSummoning = process.argv.includes('--include-summoning');

async function main(): Promise<void> {
  const plan = SONGS
    .map((song, i) => ({ song, slot: START_SLOT + i * 2, file: `${DIR}/${song}__full4bar__scenes.ncs` }))
    .filter((p) => includeSummoning || p.song !== 'the_summoning');

  let conn = open();
  const results: { project: number; song: string; ok: boolean; note: string }[] = [];
  try {
    for (const { song, slot, file } of plan) {
      const buf = new Uint8Array(readFileSync(file));
      if (buf.length !== NCS_FILE_SIZE) { results.push({ project: slot + 1, song, ok: false, note: `bad size ${buf.length}` }); continue; }
      process.stdout.write(`Project ${slot + 1} (slot ${slot})  ${song} … `);
      let res = await uploadProject(conn, buf, slot);
      if (!res.ok) { process.stdout.write(`retry (${res.error}) … `); conn.close(); conn = open(); res = await uploadProject(conn, buf, slot); }
      if (!res.ok) { console.log(`FAIL (${res.error})`); results.push({ project: slot + 1, song, ok: false, note: res.error ?? 'upload failed' }); continue; }
      // Read back + verify byte-exact (the scenes really landed, not just acked).
      const dl = await downloadProject(conn, slot);
      const verified = !!dl.bytes && dl.crcOk && dl.bytes.length === buf.length && dl.bytes.every((b, i) => b === buf[i]);
      console.log(verified ? `OK (${res.blocks} blocks, read-back byte-exact)` : `UPLOADED but read-back MISMATCH (crcOk=${dl.crcOk})`);
      results.push({ project: slot + 1, song, ok: verified, note: verified ? '' : 'read-back mismatch' });
      await sleep(SETTLE_MS);
    }
  } finally {
    conn.close();
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} scene-baked full4bar projects uploaded + verified.`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  Project ${f.project} ${f.song}: ${f.note}`); process.exit(1); }
  console.log('\nOn the device: load each Project below, tap Scenes 1–4 — each recalls one of the 4 grooves (a looping 2-pattern chain):');
  for (const r of results) console.log(`  Project ${r.project}: ${r.song}`);
  console.log(`  Project 43: the_summoning (already had scenes; ${includeSummoning ? 're-uploaded' : 'skipped'})`);
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
