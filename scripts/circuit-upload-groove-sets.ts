/**
 * Batch-upload the Sleep Token groove-set projects to consecutive Circuit
 * Tracks project slots. Each *.ncs is a complete project (8 swappable grooves
 * on the 4 drum tracks); this writes one song per project slot.
 *
 * Uses the hardware-confirmed project-upload transport, with a reconnect +
 * single retry on a stale-handle failure (the documented 2026-06-20 pattern:
 * @julusian throws on a dead handle; reconnect and re-send). A short settle
 * delay between songs lets the device's flash write quiesce.
 *
 * Requires the "Circuit Tracks" port to be FREE (close Novation Components).
 *
 *   npx tsx scripts/circuit-upload-groove-sets.ts [startSlot]
 *
 * startSlot defaults to 32 (device "Project 33"); the device shows "Project
 * slot+1". The song order below is the handoff order.
 */
import { readFileSync } from 'node:fs';

import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { uploadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const GROOVE_DIR = 'samples/circuit-tracks/grooves';
const ORDER = [
  'the_summoning', 'granite', 'the_offering', 'take_me_back_to_eden', 'aqua_regia',
  'ascensionism', 'hypnosis', 'chokehold', 'vore', 'rain',
] as const;

const START_SLOT = Number(process.argv[2] ?? 32);
const SETTLE_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openConn() {
  return connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (is Components still holding the port?).' });
}

async function main(): Promise<void> {
  let conn = openConn();
  const results: { project: number; song: string; ok: boolean; note: string }[] = [];
  try {
    for (let i = 0; i < ORDER.length; i++) {
      const song = ORDER[i];
      const slot = START_SLOT + i;
      const project = slot + 1; // device numbering
      const buf = new Uint8Array(readFileSync(`${GROOVE_DIR}/${song}.ncs`));
      if (buf.length !== NCS_FILE_SIZE) {
        results.push({ project, song, ok: false, note: `bad size ${buf.length} (expected ${NCS_FILE_SIZE})` });
        continue;
      }
      process.stdout.write(`Project ${project} (slot ${slot})  ${song} … `);
      let res = await uploadProject(conn, buf, slot);
      if (!res.ok) {
        // Stale handle: reconnect once and retry this song.
        process.stdout.write(`retry (${res.error}) … `);
        conn.close();
        conn = openConn();
        res = await uploadProject(conn, buf, slot);
      }
      console.log(res.ok ? `OK (${res.blocks} blocks acked)` : `FAIL (${res.error})`);
      results.push({ project, song, ok: res.ok, note: res.ok ? `${res.blocks} blocks` : (res.error ?? 'unknown') });
      await sleep(SETTLE_MS);
    }
  } finally {
    conn.close();
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} uploaded.`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  Project ${f.project} ${f.song}: ${f.note}`);
    process.exit(1);
  }
  console.log('All groove sets uploaded. On the device load each project (Projects view) and, per project, assign Drum 1..4 → Preset positions 1..4 (kick/snare/hat/ride).');
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
