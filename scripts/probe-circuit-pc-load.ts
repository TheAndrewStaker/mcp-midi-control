/**
 * Does a Program Change on a synth channel LOAD an OCCUPIED bank patch into the
 * working buffer? (Earlier PC tests used empty slots.) Reads filter.frequency via
 * the dump after each PC. Read-only (PC + dump). Non-destructive.
 *
 *   npx tsx scripts/probe-circuit-pc-load.ts [slot ...]   (default: our saved 62 63)
 */
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { buildProgramChange } from '@mcp-midi-control/core/midi/messages.js';
import { readCurrentPatch } from '@mcp-midi-control/circuit-tracks/codec/patchTransfer.js';
import { OFFSET_BY_PARAM } from '@mcp-midi-control/circuit-tracks/codec/patchLayout.js';
import { decodePatchName } from '@mcp-midi-control/circuit-tracks/codec/blob.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FREQ = OFFSET_BY_PARAM.get('filter.frequency')!;
const slots = process.argv.slice(2).map(Number);
const targets = slots.length ? slots : [62, 63];

async function dump(conn: MidiConnection): Promise<{ freq: number; name: string }> {
  const r = await readCurrentPatch(conn, 0, {});
  if (!r.ok || !r.body) throw new Error(r.error ?? 'no reply');
  return { freq: r.body[FREQ] & 0x7f, name: decodePatchName(r.body) };
}

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found.' });
  if (!conn.hasInput) { console.error('no input'); conn.close(); process.exit(1); }
  try {
    const base = await dump(conn);
    console.log(`baseline working buffer: freq=${base.freq}, name="${base.name}"`);
    for (const s of targets) {
      conn.send(buildProgramChange(0, s)); // ch1 (Synth 1), program = slot
      await sleep(300);
      const d = await dump(conn);
      console.log(`PC ch1 program ${s} (Patch ${s + 1}) → freq=${d.freq}, name="${d.name}" ${d.freq === 85 ? '  ← our saved bright patch!' : ''}`);
    }
  } finally { conn.close(); }
}
main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exit(1); });
