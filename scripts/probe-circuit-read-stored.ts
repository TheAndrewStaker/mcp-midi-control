/**
 * Confirms readStoredPatchViaLoad (the get_preset("patch:N") read path): reads a
 * STORED bank patch by PC-loading it + dumping, and RESTORES the prior working
 * buffer. Read-only w.r.t. Flash (only loads + reads). Non-destructive to the buffer.
 *
 *   npx tsx scripts/probe-circuit-read-stored.ts [slot ...]   (default: 62 63)
 */
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { readCurrentPatch, readStoredPatchViaLoad } from '@mcp-midi-control/circuit-tracks/codec/patchTransfer.js';
import { OFFSET_BY_PARAM } from '@mcp-midi-control/circuit-tracks/codec/patchLayout.js';
import { decodePatchName } from '@mcp-midi-control/circuit-tracks/codec/blob.js';

const FREQ = OFFSET_BY_PARAM.get('filter.frequency')!;
const targets = process.argv.slice(2).map(Number);
const slots = targets.length ? targets : [62, 63];

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found.' });
  if (!conn.hasInput) { console.error('no input'); conn.close(); process.exit(1); }
  try {
    const before = await readCurrentPatch(conn, 0, {});
    const beforeName = before.ok && before.body ? decodePatchName(Array.from(before.body)) : '(?)';
    console.log(`working buffer BEFORE: "${beforeName}"`);
    for (const s of slots) {
      const r = await readStoredPatchViaLoad(conn, s, {});
      const freq = r.ok && r.body ? r.body[FREQ] & 0x7f : -1;
      console.log(`get_preset patch:${s} (Patch ${s + 1}) → ok=${r.ok} name="${r.name ?? ''}" filter.frequency=${freq}${r.error ? ` err=${r.error}` : ''}`);
    }
    const after = await readCurrentPatch(conn, 0, {});
    const afterName = after.ok && after.body ? decodePatchName(Array.from(after.body)) : '(?)';
    console.log(`working buffer AFTER (restore check): "${afterName}" ${afterName === beforeName ? '✅ restored' : '⚠️ NOT restored'}`);
  } finally { conn.close(); }
}
main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exit(1); });
