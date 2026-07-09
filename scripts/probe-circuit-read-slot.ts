/**
 * Read-only diagnostic: read stored PATCH slots via the file-transfer READ
 * (fileType 0x04) and print each slot's name + file size. Non-destructive.
 *
 *   npx tsx scripts/probe-circuit-read-slot.ts [slot ...]   (default: 0 1 32 63)
 */
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { readStoredPatch } from '@mcp-midi-control/circuit-tracks/codec/patchTransfer.js';

const slots = process.argv.slice(2).map(Number);
const targets = slots.length ? slots : [0, 1, 32, 63];

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered? Components closed?).' });
  if (!conn.hasInput) { console.error('no MIDI input'); conn.close(); process.exit(1); }
  try {
    for (const s of targets) {
      const r = await readStoredPatch(conn, s);
      if (r.ok) console.log(`slot ${String(s).padStart(2)}: name="${r.name}"  file=${r.bytes!.length}B  crcOk=${r.crcOk}`);
      else console.log(`slot ${String(s).padStart(2)}: ${r.empty ? 'EMPTY' : 'READ FAIL'} — ${r.error}`);
    }
  } finally { conn.close(); }
}
main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exit(1); });
