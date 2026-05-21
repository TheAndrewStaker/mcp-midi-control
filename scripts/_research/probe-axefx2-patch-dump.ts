/**
 * BK-070 — probe the Axe-Fx II `fn 0x03 SYSEX_PATCH_DUMP` request.
 *
 * Per the Ghidra-recovered opcode table (`fractal-midi/docs/devices/
 * axe-fx-ii/axeedit-opcode-table.md`), wire byte 0x03 maps to
 * `SYSEX_PATCH_DUMP` — the request that AxeEdit's "Read from
 * Axe-Fx" likely uses to pull the active preset binary. The expected
 * response is a 66-message stream (1× 0x77 header + 64× 0x78 chunks
 * + 1× 0x79 footer) totaling 12,951 bytes.
 *
 * This probe tries several payload variants and reports which one
 * gets the device to emit the 0x77/0x78/0x79 stream. Once we know
 * the request shape, we can wire `dump_preset` (read the working
 * buffer in one round-trip) and build the offset-extraction loop
 * for atomic apply_preset.
 *
 * Variants tested (in order):
 *   1. No payload — `F0 00 01 74 07 03 cs F7`
 *   2. Active-preset sentinel — `F0 00 01 74 07 03 7F 7F cs F7`
 *   3. Bank 0 preset 0 — `F0 00 01 74 07 03 00 00 cs F7`
 *   4. AxeEdit-observed shape (TBD if Ghidra finds more)
 *
 * For each variant we send the request, listen for ANY inbound SysEx
 * for 3 seconds, and report what arrives. Success = at least one
 * 0x77 PRESET_DUMP_HEADER frame in the response stream.
 *
 * Captured response (if any) is saved to
 * `samples/captured/probe-axefx2-patch-dump-<variant>.syx` for diff
 * use later. Existing files are NOT overwritten.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_PATCH_DUMP = 0x03;

function fractalChecksum(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

function buildPatchDumpRequest(payload: number[]): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, FUNC_PATCH_DUMP, ...payload];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

function hex(b: number): string {
  return b.toString(16).padStart(2, '0');
}

function classifyResponse(messages: number[][]): string {
  const funcs = messages.map((m) => m[5]);
  const headers = funcs.filter((f) => f === 0x77).length;
  const chunks = funcs.filter((f) => f === 0x78).length;
  const footers = funcs.filter((f) => f === 0x79).length;
  if (headers > 0 || chunks > 0 || footers > 0) {
    return `SUCCESS: ${headers}× 0x77 header, ${chunks}× 0x78 chunk, ${footers}× 0x79 footer (expected 1/64/1)`;
  }
  if (messages.length === 0) return 'NO RESPONSE';
  const summary = new Map<number, number>();
  for (const f of funcs) summary.set(f, (summary.get(f) ?? 0) + 1);
  const summaryStr = [...summary.entries()].map(([f, c]) => `${hex(f)}×${c}`).join(' ');
  return `unexpected ${messages.length} messages: ${summaryStr}`;
}

async function runProbe(label: string, payload: number[]): Promise<void> {
  console.log(`\n── ${label} ──`);
  const request = buildPatchDumpRequest(payload);
  console.log(`  request (${request.length}B): ${request.map(hex).join(' ')}`);

  const conn = connectAxeFxII();
  const messages: number[][] = [];

  // Subscribe to ALL inbound SysEx for 3 seconds.
  const unsubscribe = conn.onMessage((bytes) => {
    if (bytes[0] === SYSEX_START) messages.push([...bytes]);
  });

  conn.send(request);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  unsubscribe();

  const classification = classifyResponse(messages);
  console.log(`  result: ${classification}`);

  // If we got the PRESET_DUMP triple, save it for offline analysis.
  if (classification.startsWith('SUCCESS')) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const path = `samples/captured/probe-axefx2-patch-dump-${slug}.syx`;
    if (existsSync(path)) {
      console.log(`  saved earlier; not overwriting ${path}`);
    } else {
      const flat: number[] = [];
      for (const m of messages) flat.push(...m);
      writeFileSync(path, Buffer.from(flat));
      console.log(`  saved ${flat.length} bytes to ${path}`);
    }
  }
}

async function main(): Promise<void> {
  console.log('BK-070 — Axe-Fx II PATCH_DUMP (fn 0x03) probe');
  console.log('Sending several request variants and reporting which triggers a');
  console.log('66-message 0x77/0x78/0x79 PRESET_DUMP response.\n');

  // Variant 1: no payload.
  await runProbe('no payload', []);

  // Variant 2: active-preset sentinel (0x7F 0x7F per AM4 convention).
  await runProbe('active sentinel 7F 7F', [0x7f, 0x7f]);

  // Variant 3: bank 0 preset 0 (request a specific stored preset).
  await runProbe('bank 0 preset 0', [0x00, 0x00]);

  // Variant 4: bank 0 preset 0 with 4-byte payload matching the response
  // header format ([bank, preset, 0x00, 0x20]).
  await runProbe('header-shape 00 00 00 20', [0x00, 0x00, 0x00, 0x20]);

  console.log('\nDone. Inspect samples/captured/probe-axefx2-patch-dump-*.syx');
  console.log('to confirm the dumps; use scripts/_research/diff-axefx2-paired-dump.ts');
  console.log('for before/after diff once you have two captures.');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
