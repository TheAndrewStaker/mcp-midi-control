/**
 * BK-070 — fully-automated per-scene bypass byte extraction.
 *
 * Drives the experiment end-to-end via MCP dispatcher executors:
 *
 *   1. Switch to preset 2 (Diamonique Rain) — clean baseline.
 *   2. Dump preset 2 bytes via fn 0x03 → before.syx.
 *   3. Switch to scene 1.
 *   4. Toggle bypass on Delay 1 (the safe wire op — set_bypass, no
 *      SET_BLOCK_CHANNEL).
 *   5. Save working buffer to preset 666 (scratch — overwrites contents).
 *   6. Switch to preset 666 and dump → after.syx.
 *   7. Diff before vs after — bytes that changed = scene-1 Delay-1
 *      bypass byte + any "preset dirty" markers.
 *
 * Output: bytes saved to samples/captured/bk070-exp7-*.syx + diff
 * printed to stdout.
 */

import { writeFileSync } from 'node:fs';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_PATCH_DUMP = 0x03;
const FUNC_HEADER = 0x77;
const FUNC_CHUNK = 0x78;
const FUNC_FOOTER = 0x79;
const FUNC_GET_PRESET_NUM = 0x14;

function fractalChecksum(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

function buildMessage(func: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function septet14(value: number): [number, number] {
  return [value & 0x7f, (value >> 7) & 0x7f];
}

interface Conn {
  send(bytes: number[]): void;
  onMessage(fn: (bytes: number[]) => void): () => void;
}

async function captureFor(conn: Conn, ms: number, predicate?: (msgs: number[][]) => boolean): Promise<number[][]> {
  const msgs: number[][] = [];
  const unsubscribe = conn.onMessage((b) => {
    if (b[0] === SYSEX_START) msgs.push([...b]);
  });
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    if (predicate && predicate(msgs)) break;
  }
  unsubscribe();
  return msgs;
}

async function dumpStoredPreset(conn: Conn, location: number, outPath: string): Promise<void> {
  const [lo, hi] = septet14(location);
  const request = buildMessage(FUNC_PATCH_DUMP, [lo, hi]);
  console.log(`  request location ${location} (${lo.toString(16)} ${hi.toString(16)}): ${request.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  conn.send(request);
  const msgs = await captureFor(conn, 3000, (m) => m.some((x) => x[5] === FUNC_FOOTER));
  const dump = msgs.filter((m) => m[5] === FUNC_HEADER || m[5] === FUNC_CHUNK || m[5] === FUNC_FOOTER);
  const headers = dump.filter((m) => m[5] === FUNC_HEADER).length;
  const chunks = dump.filter((m) => m[5] === FUNC_CHUNK).length;
  const footers = dump.filter((m) => m[5] === FUNC_FOOTER).length;
  if (headers !== 1 || chunks !== 64 || footers !== 1) {
    throw new Error(`dump failed at location ${location}: ${headers}× 0x77, ${chunks}× 0x78, ${footers}× 0x79 (expected 1/64/1; got ${msgs.length} total)`);
  }
  const flat: number[] = [];
  for (const m of dump) flat.push(...m);
  writeFileSync(outPath, Buffer.from(flat));

  // Decode preset name from chunk 0.
  const chunk0 = dump.find((m) => m[5] === FUNC_CHUNK)!;
  let name = '';
  for (let i = 8; i < 8 + 32 * 3; i += 3) {
    const ch = chunk0[6 + i];
    if (ch === 0) break;
    name += String.fromCharCode(ch);
  }
  console.log(`  → "${name.trim()}" (${flat.length} bytes) saved to ${outPath}`);
}

async function getCurrentPresetNumber(conn: Conn): Promise<number> {
  conn.send(buildMessage(FUNC_GET_PRESET_NUM));
  const msgs = await captureFor(conn, 800);
  const reply = msgs.find((m) => m[5] === FUNC_GET_PRESET_NUM);
  if (reply === undefined) throw new Error('no response to GET_PRESET_NUMBER');
  return reply[6] | (reply[7] << 7);
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();

  console.log('Step 1: query current preset number (sanity)');
  const startPreset = await getCurrentPresetNumber(conn);
  console.log(`  device reports current preset = ${startPreset}\n`);

  console.log('Step 2: dump Diamonique Rain (load + read preset 2 via fn 0x03)');
  // Earlier probe: payload [0x00, 0x00] returned "59 Bassguy" (= preset 0).
  // So payload encoding is [preset_lo, preset_hi] septet-14-bit.
  // Diamonique Rain at user's "preset 2" → preset index 1? Let's try multiple.
  // We'll try [0x01, 0x00] first (preset 1).
  await dumpStoredPreset(conn, 1, 'samples/captured/bk070-exp7-preset1-baseline.syx');
  console.log('');

  console.log('Step 3: confirm preset number is now 1');
  const afterDump = await getCurrentPresetNumber(conn);
  console.log(`  device reports current preset = ${afterDump}`);
  if (afterDump !== 1) {
    console.log('  WARNING: device did not move to preset 1 — fn 0x03 may not have side-effect load');
  }
  console.log('');

  console.log('Step 4: dump preset 666 (load + read via fn 0x03) — captures pre-experiment state at scratch slot');
  await dumpStoredPreset(conn, 666, 'samples/captured/bk070-exp7-preset666-pristine.syx');
  console.log('');

  console.log('Done. Inspect:');
  console.log('  samples/captured/bk070-exp7-preset1-baseline.syx');
  console.log('  samples/captured/bk070-exp7-preset666-pristine.syx');
  console.log('');
  console.log('Next: pipe through the dispatcher to make ONE bypass change + save_preset(666),');
  console.log('then re-dump 666 and diff against baseline.');
  process.exit(0);
}

main().catch((e) => { console.error('experiment failed:', e); process.exit(1); });
