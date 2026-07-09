/**
 * Upload a folder of WAVs to consecutive sample slots in ONE sample-directory
 * session (the persistence-fixed path — see uploadSampleKit). No MCP 30s timeout,
 * so a full 13+ sample kit goes in one go.
 *
 *   npx tsx scripts/circuit-upload-kit-folder.ts <folder> [startSlot=1]
 *
 * Requires the "Circuit Tracks" port FREE (close Components / other sessions).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { uploadSampleKit } from '@mcp-midi-control/circuit-tracks/samples/uploadSample.js';

const folder = process.argv[2];
const startSlot = Number(process.argv[3] ?? 1) - 1; // device 1..64 → wire 0..63
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const wavs = readdirSync(folder)
  .filter((f) => extname(f).toLowerCase() === '.wav' && statSync(join(folder, f)).isFile())
  .sort(natural);
if (!wavs.length) { console.error(`no .wav files in ${folder}`); process.exit(1); }
const items = wavs.map((f, i) => ({ wav: new Uint8Array(readFileSync(join(folder, f))), slot: startSlot + i, filename: f }));

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered on? Components/other session closed?).' });
  if (!conn.hasInput) { console.error('no input port — kit upload needs a bidirectional connection'); conn.close(); process.exit(2); }
  try {
    console.log(`Uploading ${items.length} samples to slots ${startSlot + 1}..${startSlot + items.length} in ONE sample-directory session…`);
    const r = await uploadSampleKit(conn, items);
    if (!r.ok) { console.error(`FAIL: ${r.error}`); process.exit(1); }
    console.log(`OK — ${r.uploaded.length} samples committed:`);
    for (const u of r.uploaded) console.log(`  slot ${String(u.slot + 1).padStart(2)}: ${u.filename}${u.converted ? '  (converted)' : ''}`);
    console.log('\nNow RESTART the device (or reload the pack) and check the samples survive + read back by name.');
  } finally {
    conn.close();
  }
}
main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
