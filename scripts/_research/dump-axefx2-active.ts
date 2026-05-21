/**
 * BK-070 — dump the Axe-Fx II active working buffer to a .syx file.
 *
 * Sends `fn 0x03 SYSEX_PATCH_DUMP` with empty payload, captures the
 * 66-message 0x77/0x78/0x79 response stream (12,951 bytes), saves to
 * the given path. Used to capture before/after pairs for per-scene
 * offset extraction (see `diff-axefx2-paired-dump.ts`).
 *
 * Usage:
 *   npx tsx scripts/_research/dump-axefx2-active.ts <out.syx>
 *
 * Overwrites the output file if it exists (no archive logic — keep it
 * simple for the experiment loop).
 */

import { writeFileSync } from 'node:fs';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';

const [outPath] = process.argv.slice(2);
if (outPath === undefined) {
  console.error('Usage: npx tsx scripts/_research/dump-axefx2-active.ts <out.syx>');
  process.exit(1);
}

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_PATCH_DUMP = 0x03;
const FUNC_HEADER = 0x77;
const FUNC_CHUNK = 0x78;
const FUNC_FOOTER = 0x79;

function fractalChecksum(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

async function main(): Promise<void> {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, FUNC_PATCH_DUMP];
  const request = [...head, fractalChecksum(head), SYSEX_END];

  const conn = connectAxeFxII();
  const messages: number[][] = [];
  const unsubscribe = conn.onMessage((bytes) => {
    if (bytes[0] === SYSEX_START) messages.push([...bytes]);
  });

  conn.send(request);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  unsubscribe();

  // Filter to ONLY the preset-dump messages (0x77/0x78/0x79). Any
  // state-broadcast triples (0x74/0x75/0x76) or other inbound traffic
  // that arrived during the capture window are not part of the dump and
  // would corrupt the byte-identical round-trip.
  const dumpMessages = messages.filter((m) =>
    m[5] === FUNC_HEADER || m[5] === FUNC_CHUNK || m[5] === FUNC_FOOTER,
  );

  const headers = dumpMessages.filter((m) => m[5] === FUNC_HEADER).length;
  const chunks = dumpMessages.filter((m) => m[5] === FUNC_CHUNK).length;
  const footers = dumpMessages.filter((m) => m[5] === FUNC_FOOTER).length;
  if (headers !== 1 || chunks !== 64 || footers !== 1) {
    console.error(`Unexpected response: ${headers}× 0x77, ${chunks}× 0x78, ${footers}× 0x79`);
    console.error(`(expected 1/64/1). Is the device connected and idle?`);
    process.exit(1);
  }

  const flat: number[] = [];
  for (const m of dumpMessages) flat.push(...m);
  writeFileSync(outPath, Buffer.from(flat));

  // Decode preset name for sanity confirmation.
  const headerMsg = messages.find((m) => m[5] === FUNC_HEADER)!;
  const chunk0 = messages.find((m) => m[5] === FUNC_CHUNK)!;
  const chunk0PayloadStart = 6;
  let name = '';
  for (let i = 8; i < 8 + 32 * 3; i += 3) {
    const ch = chunk0[chunk0PayloadStart + i];
    if (ch === 0) break;
    name += String.fromCharCode(ch);
  }
  const bankByte = headerMsg[6];
  const presetByte = headerMsg[7];

  console.log(`Captured working buffer: "${name.trim()}"`);
  console.log(`  header bytes: bank=0x${bankByte.toString(16).padStart(2,'0')} preset=0x${presetByte.toString(16).padStart(2,'0')}`);
  console.log(`  saved ${flat.length} bytes → ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('dump failed:', err);
  process.exit(1);
});
