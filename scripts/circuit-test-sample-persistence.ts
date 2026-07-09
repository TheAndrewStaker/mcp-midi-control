/**
 * DELIBERATE persistence test: upload a kit using the FULL Components replica —
 * one session, sample-directory context (0x05), with the complete 0x0d + 0x08
 * directory read (the missing 0x08 name-reads were the only structural gap from
 * the capture). Separate from the known-working production path so we test this
 * grounded hypothesis ONCE, on purpose.
 *
 *   npx tsx scripts/circuit-test-sample-persistence.ts <folder> [startSlot=1]
 *
 * Then RESTART the device and check Drum > Preset: if the samples survive, the
 * 0x08 enumeration was the persistence key.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { runUploadFramePlan } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import { buildKitUploadFrames } from '@mcp-midi-control/circuit-tracks/samples/sampleTransfer.js';
import { normalizeToDevice } from '@mcp-midi-control/circuit-tracks/samples/wav.js';

const folder = process.argv[2];
const startSlot = Number(process.argv[3] ?? 1) - 1;
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const wavs = readdirSync(folder)
  .filter((f) => extname(f).toLowerCase() === '.wav' && statSync(join(folder, f)).isFile())
  .sort(natural);
if (!wavs.length) { console.error(`no .wav in ${folder}`); process.exit(1); }
const items = wavs.map((f, i) => {
  const n = normalizeToDevice(new Uint8Array(readFileSync(join(folder, f))));
  return { wav: n.wav, slot: startSlot + i, filename: f };
});

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered on? other session/Components closed?).' });
  if (!conn.hasInput) { console.error('no input port'); conn.close(); process.exit(2); }
  try {
    const frames = buildKitUploadFrames(items, { enumerate: true, dirType: 0x05 });
    console.log(`FULL Components replica: 1 session, 0x05 context, 0x0d+0x08 enumeration, ${items.length} samples (${frames.length} frames)…`);
    const r = await runUploadFramePlan(conn, frames, {});
    console.log(r.ok ? `\nSession completed (all frames acked).` : `\nFAIL: ${r.error}`);
    if (r.ok) {
      console.log('Samples → slots ' + (startSlot + 1) + '..' + (startSlot + items.length) + '.');
      console.log('NOW: 1) check Drum > Preset slots are populated, 2) RESTART the device, 3) check they survived.');
    }
  } finally {
    conn.close();
  }
}
main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
