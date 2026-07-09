/**
 * MINIMAL single-sample upload, for USBPcap capture of OUR wire bytes (to diff
 * against a Components "Send samples" capture). Upload ONLY — no directory
 * readback — so the capture is just our upload sequence. Uses the current code
 * (singleClose etc.). Run this WHILE USBPcap records the Circuit Tracks USB device.
 *
 *   npx tsx scripts/_research/circuit-upload-one-sample.ts [slot=1] [file.wav]
 */
import { readFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { uploadSample } from '@mcp-midi-control/circuit-tracks/samples/uploadSample.js';

const slot1 = Number(process.argv[2] ?? 1);                 // device 1..64
const file = process.argv[3] ?? 'C:/dev/mcp-midi-tools/samples/drum-sources/sleep-token-ii/page-leveled/stoken_1_01_kick.wav';

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered on? Components/other session closed?).' });
  if (!conn.hasInput) { console.error('no input port — sample upload needs a bidirectional connection'); conn.close(); process.exit(2); }
  try {
    const wav = new Uint8Array(readFileSync(file));
    console.log(`>>> START upload of "${file}" to slot ${slot1} (wire slot ${slot1 - 1}). Mark this point in the capture.`);
    const t = Date.now();
    const r = await uploadSample(conn, wav, slot1 - 1, `cap_${slot1}.wav`);
    console.log(`>>> END upload after ${((Date.now() - t) / 1000).toFixed(1)}s: ok=${r.ok}${r.error ? '  error=' + r.error : ''}`);
  } finally { conn.close(); }
}
main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); process.exit(1); });
