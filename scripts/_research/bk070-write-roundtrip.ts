/**
 * BK-070 — test that we can write a preset binary back to the device.
 *
 * Strategy:
 *   1. Read the current scratch (wire 665) baseline.
 *   2. Send the SAME 66 messages back via fn 0x77/0x78/0x79.
 *   3. Re-dump scratch.
 *   4. Diff baseline vs re-dump. Should be 0 bytes if device accepted
 *      and round-trip is faithful.
 *
 * Then SECOND PASS:
 *   5. Take baseline, flip byte CHUNK02:099 bit 1 (toggle scene 1
 *      amp channel X→Y), recompute checksums in affected message.
 *   6. Push modified bytes back.
 *   7. Re-dump. Diff should show only that 1 byte changed (plus
 *      possibly footer hash).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset, executeSavePreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { CHUNK_PAYLOAD_LEN, parsePresetDump, serializePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;

function checksum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
function build(func: number, payload: number[]): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
  return [...head, checksum(head), SYSEX_END];
}
function msbPreset(w: number): [number, number] { return [(w >> 7) & 0x7f, w & 0x7f]; }

type Conn = ReturnType<typeof connectAxeFxII>;

async function capture(conn: Conn, ms: number, until?: (m: number[][]) => boolean): Promise<number[][]> {
  const msgs: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === SYSEX_START) msgs.push([...b]); });
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    if (until && until(msgs)) break;
  }
  unsub();
  return msgs;
}

async function dumpWire(conn: Conn, wire: number, outPath: string): Promise<void> {
  const [hi, lo] = msbPreset(wire);
  conn.send(build(0x03, [hi, lo]));
  const msgs = await capture(conn, 3000, (m) => m.some((x) => x[5] === 0x79));
  const dump = msgs.filter((m) => m[5] === 0x77 || m[5] === 0x78 || m[5] === 0x79);
  if (dump.length !== 66) throw new Error(`dump failed: ${dump.length} frames`);
  const flat: number[] = [];
  for (const m of dump) flat.push(...m);
  writeFileSync(outPath, Buffer.from(flat));
}

async function pushBytes(conn: Conn, bytes: Uint8Array): Promise<number[][]> {
  // The bytes are already the concatenated 66 SysEx messages (header +
  // 64 chunks + footer). Send each one separately by walking F0..F7
  // boundaries — easier than chunking on byte count.
  const messages: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xf0) { i++; continue; }
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== 0xf7) j++;
    if (j >= bytes.length) break;
    messages.push(Array.from(bytes.slice(i, j + 1)));
    i = j + 1;
  }
  console.log(`  ${messages.length} messages to send`);

  // Listen for any responses during the push.
  const responses: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === SYSEX_START) responses.push([...b]); });

  for (let k = 0; k < messages.length; k++) {
    conn.send(messages[k]);
    // Brief inter-message delay to avoid overwhelming the device's
    // input parser. ~5ms between messages keeps total send time at
    // ~330ms for 66 messages.
    await new Promise((r) => setTimeout(r, 5));
  }
  // Allow trailing acks/nacks to arrive.
  await new Promise((r) => setTimeout(r, 800));
  unsub();
  return responses;
}

async function main(): Promise<void> {
  console.log(`Round-trip write test on wire ${SCRATCH_WIRE} (display ${SCRATCH_DISPLAY})\n`);

  // Switch to scratch and capture baseline.
  console.log('Step 1: switch + dump baseline');
  await executeSwitchPreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY, on_active_preset_edited: 'discard' });
  await new Promise((r) => setTimeout(r, 200));

  const conn = connectAxeFxII();
  const baselinePath = 'samples/captured/bk070-rt-baseline.syx';
  await dumpWire(conn, SCRATCH_WIRE, baselinePath);
  console.log(`  baseline saved → ${baselinePath}`);

  // VERBATIM round-trip.
  console.log('\nStep 2: push baseline bytes BACK to device verbatim');
  const baselineBytes = new Uint8Array(readFileSync(baselinePath));
  const responses1 = await pushBytes(conn, baselineBytes);
  console.log(`  device replied with ${responses1.length} messages:`);
  for (const r of responses1.slice(0, 8)) {
    console.log(`    ${r.slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join(' ')}${r.length > 12 ? '...' : ''}  (${r.length}B fn=0x${r[5]?.toString(16).padStart(2, '0')})`);
  }

  console.log('\nStep 3: save_preset + re-dump');
  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise((r) => setTimeout(r, 200));
  const rtPath = 'samples/captured/bk070-rt-after-verbatim.syx';
  await dumpWire(conn, SCRATCH_WIRE, rtPath);

  // Diff
  console.log('\nStep 4: diff verbatim round-trip');
  const a = new Uint8Array(readFileSync(baselinePath));
  const b = new Uint8Array(readFileSync(rtPath));
  let diffs = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diffs++;
  console.log(`  bytes differing: ${diffs}/${a.length}`);
  if (diffs === 0) {
    console.log('  ✅ verbatim round-trip succeeded — device accepted the bytes and they re-dump identical');
  } else {
    console.log('  ❌ verbatim round-trip changed bytes — device may have rejected the push, or modified state on save');
  }

  // ── Edit + push ──────────────────────────────────────
  console.log('\nStep 5: modify CHUNK02:099 bit 1 (toggle scene 1 amp channel), re-serialize, push, dump, diff');
  const parsed = parsePresetDump(new Uint8Array(readFileSync(baselinePath)));
  // CHUNK02:099 = chunk 2 payload byte 99.
  const chunk2 = new Uint8Array(parsed.chunkPayloads[2]);
  const beforeByte = chunk2[99];
  chunk2[99] = chunk2[99] ^ 0x02;  // flip bit 1
  console.log(`  CHUNK02:099 ${beforeByte.toString(16)} → ${chunk2[99].toString(16)}`);
  const modifiedChunks = parsed.chunkPayloads.map((c, i) => (i === 2 ? chunk2 : new Uint8Array(c)));
  const modified = serializePresetDump({
    raw: parsed.raw,  // ignored by serializer
    headerPayload: parsed.headerPayload,
    chunkPayloads: modifiedChunks,
    footerPayload: parsed.footerPayload,
  });
  writeFileSync('samples/captured/bk070-rt-modified.syx', Buffer.from(modified));

  console.log('  pushing modified bytes...');
  const responses2 = await pushBytes(conn, modified);
  console.log(`  ${responses2.length} response messages`);

  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise((r) => setTimeout(r, 200));
  const editedDumpPath = 'samples/captured/bk070-rt-after-edit.syx';
  await dumpWire(conn, SCRATCH_WIRE, editedDumpPath);

  const ba = new Uint8Array(readFileSync(baselinePath));
  const ed = new Uint8Array(readFileSync(editedDumpPath));
  const editDiffs: number[] = [];
  for (let i = 0; i < ba.length; i++) if (ba[i] !== ed[i]) editDiffs.push(i);
  console.log(`  bytes differing from baseline: ${editDiffs.length}`);
  if (editDiffs.length > 0) {
    console.log('  first 12 diff offsets:', editDiffs.slice(0, 12).join(','));
  }

  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
