/**
 * Batch-upload ALL packed groove variations (full4bar + chop2bar per song) to a
 * contiguous block of project slots, reconnect+retry on a stale handle.
 *
 * Layout: starting at START_SLOT (default 42 = Project 43), each song takes two
 * consecutive slots: full4bar then chop2bar. 10 songs x 2 = 20 slots (42..61 =
 * Projects 43..62), keeping 33-42 (the originals) untouched.
 *
 * Requires the "Circuit Tracks" port FREE (close Novation Components).
 *
 *   npx tsx scripts/circuit-upload-packed-sets.ts [startSlot]
 */
import { readFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { uploadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const DIR = 'samples/circuit-tracks/grooves/packed';
const SONGS = [
  'the_summoning', 'granite', 'the_offering', 'take_me_back_to_eden', 'aqua_regia',
  'ascensionism', 'hypnosis', 'chokehold', 'vore', 'rain',
] as const;
const VARIANTS = ['full4bar', 'chop2bar'] as const;

const START_SLOT = Number(process.argv[2] ?? 42);
const SETTLE_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = () => connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (powered on? Components closed?).' });

async function main(): Promise<void> {
  // Build the (file, slot) plan.
  const plan: { file: string; slot: number; label: string }[] = [];
  let slot = START_SLOT;
  for (const song of SONGS) {
    for (const v of VARIANTS) {
      plan.push({ file: `${DIR}/${song}__${v}.ncs`, slot, label: `${song} ${v}` });
      slot++;
    }
  }
  if (plan[plan.length - 1].slot > 63) throw new Error(`plan overflows slot 63 (start ${START_SLOT}); pick a lower start`);

  let conn = open();
  const results: { project: number; label: string; ok: boolean; note: string }[] = [];
  try {
    for (const { file, slot, label } of plan) {
      const buf = new Uint8Array(readFileSync(file));
      if (buf.length !== NCS_FILE_SIZE) { results.push({ project: slot + 1, label, ok: false, note: `bad size ${buf.length}` }); continue; }
      process.stdout.write(`Project ${slot + 1} (slot ${slot})  ${label} … `);
      let res = await uploadProject(conn, buf, slot);
      if (!res.ok) { process.stdout.write(`retry (${res.error}) … `); conn.close(); conn = open(); res = await uploadProject(conn, buf, slot); }
      console.log(res.ok ? `OK (${res.blocks} blocks)` : `FAIL (${res.error})`);
      results.push({ project: slot + 1, label, ok: res.ok, note: res.ok ? '' : (res.error ?? 'unknown') });
      await sleep(SETTLE_MS);
    }
  } finally {
    conn.close();
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} uploaded to Projects ${START_SLOT + 1}..${START_SLOT + plan.length}.`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  Project ${f.project} ${f.label}: ${f.note}`); process.exit(1); }
  console.log('\nMap (Project = song variant):');
  for (const r of results) console.log(`  Project ${r.project}: ${r.label}`);
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
