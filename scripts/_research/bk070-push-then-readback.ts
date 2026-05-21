/**
 * BK-070 — confirm whether fn 0x77/0x78/0x79 push actually mutates the
 * working buffer.
 *
 *   1. Switch to wire 665, read amp.input_drive (baseline value).
 *   2. Take a captured preset binary, modify the amp.input_drive triplet
 *      to encode a NEW unique value (e.g. wire_value 0x1234), serialize.
 *   3. Push the 66 messages.
 *   4. WITHOUT save, read amp.input_drive again. If the working buffer
 *      received the push, the value should be the new one.
 *   5. Skip save. Switch away + back to force a flash re-load,
 *      read again — should be the ORIGINAL flash value if save wasn't
 *      called.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeGetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump, serializePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;

type Conn = ReturnType<typeof connectAxeFxII>;

async function pushBytes(conn: Conn, bytes: Uint8Array): Promise<number[][]> {
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
  const responses: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === 0xf0) responses.push([...b]); });
  for (const m of messages) {
    conn.send(m);
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 800));
  unsub();
  return responses;
}

async function readDrive(label: string): Promise<number> {
  const r = await executeGetParam({ port: 'axe-fx-ii', block: 'amp', name: 'input_drive' });
  const dv = (r as { display_value?: number; wire_value?: number }).display_value ?? -1;
  const wv = (r as { wire_value?: number }).wire_value ?? -1;
  console.log(`  ${label}: display=${dv} wire=${wv}`);
  return wv;
}

async function main(): Promise<void> {
  console.log('Step 1: switch to scratch + baseline read');
  await executeSwitchPreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY, on_active_preset_edited: 'discard' });
  await new Promise((r) => setTimeout(r, 200));
  await readDrive('baseline');

  // Dump scratch fresh.
  console.log('\nStep 2: dump scratch to get a clean binary');
  const conn = connectAxeFxII();
  const SYSEX_START = 0xf0, FRACTAL_MFR = [0x00, 0x01, 0x74], II_MODEL = 0x07;
  function csum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
  function build(func: number, payload: number[]): number[] {
    const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
    return [...head, csum(head), 0xf7];
  }
  const [hi, lo] = [(SCRATCH_WIRE >> 7) & 0x7f, SCRATCH_WIRE & 0x7f];
  const msgs: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === 0xf0) msgs.push([...b]); });
  conn.send(build(0x03, [hi, lo]));
  await new Promise((r) => setTimeout(r, 2500));
  unsub();
  const dumpMsgs = msgs.filter((m) => m[5] === 0x77 || m[5] === 0x78 || m[5] === 0x79);
  if (dumpMsgs.length !== 66) {
    console.error(`dump failed: ${dumpMsgs.length} frames`);
    process.exit(1);
  }
  const dumpBytes = new Uint8Array(dumpMsgs.flat());
  writeFileSync('samples/captured/bk070-pt-baseline.syx', Buffer.from(dumpBytes));
  console.log(`  saved ${dumpBytes.length} bytes`);

  // Parse + modify amp.input_drive (CHUNK03:179 = 3-byte triplet).
  // Encode target wire value 4096 = 0x1000 = septet [0x00, 0x20, 0x00].
  const TARGET_WIRE = 4096;
  const NEW_TRIPLET = [TARGET_WIRE & 0x7f, (TARGET_WIRE >> 7) & 0x7f, (TARGET_WIRE >> 14) & 0x7f];
  console.log(`\nStep 3: modify CHUNK03 offsets 179-181 to encode wire ${TARGET_WIRE} (display ~0.625)`);
  console.log(`  new triplet: ${NEW_TRIPLET.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

  const parsed = parsePresetDump(dumpBytes);
  const chunk3 = new Uint8Array(parsed.chunkPayloads[3]);
  chunk3[179] = NEW_TRIPLET[0];
  chunk3[180] = NEW_TRIPLET[1];
  chunk3[181] = NEW_TRIPLET[2];
  const modifiedChunks = parsed.chunkPayloads.map((c, i) => (i === 3 ? chunk3 : new Uint8Array(c)));
  const modified = serializePresetDump({
    raw: parsed.raw,
    headerPayload: parsed.headerPayload,
    chunkPayloads: modifiedChunks,
    footerPayload: parsed.footerPayload,
  });
  writeFileSync('samples/captured/bk070-pt-modified.syx', Buffer.from(modified));
  console.log(`  modified bytes saved`);

  console.log('\nStep 4: push modified bytes (66 messages)');
  const responses = await pushBytes(conn, modified);
  console.log(`  ${responses.length} ack messages received`);
  const nacks = responses.filter((r) => r[5] === 0x64 && r[8] !== 0x00);
  if (nacks.length > 0) {
    console.log(`  ⚠ ${nacks.length} NACKs detected`);
    for (const n of nacks.slice(0, 3)) console.log(`    ${n.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }

  console.log('\nStep 5: read amp.input_drive WITHOUT save (working buffer check)');
  const postPush = await readDrive('after push, before save');

  if (postPush === TARGET_WIRE) {
    console.log('  ✅ working buffer accepted the push — value matches target');
  } else if (Math.abs(postPush - TARGET_WIRE) < 10) {
    console.log(`  ⚠ working buffer reports ~${postPush}, very close to target ${TARGET_WIRE} (rounding?)`);
  } else {
    console.log(`  ❌ working buffer reports ${postPush}, not target ${TARGET_WIRE}`);
    console.log('     push was REJECTED (likely hash validation or unsupported mode)');
  }

  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error(e); process.exit(1); });
