/**
 * BK-070 — proof-of-life for atomic apply.
 *
 * The footer hash is XOR-fold of decoded native ushorts across all chunks
 * (verified 390/390 presets — see scripts/_research/verify-footer-xor-hash.ts).
 *
 * Procedure:
 *   1. Switch to scratch preset (display 666 / wire 665).
 *   2. Dump baseline via fn 0x03 [hi, lo].
 *   3. Read amp.input_drive — record baseline value.
 *   4. Modify chunkPayload[3] bytes 179-181 to encode a new wire value.
 *   5. Recompute footer hash via the verified XOR-fold formula.
 *   6. Replace footer bytes; re-serialize.
 *   7. Push 66 messages; collect ACKs/NACKs.
 *   8. save_preset; re-dump.
 *   9. Read amp.input_drive — confirm new value is on the device.
 *
 * Expected outcome:
 *   - Zero NACKs on push (vs. the existing NACK 0x13 on footer when hash
 *     isn't recomputed).
 *   - amp.input_drive after save+re-read == new wire value.
 *   - Re-dumped binary's footer == our computed footer.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  executeSwitchPreset,
  executeSavePreset,
} from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeGetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import {
  parsePresetDump,
  serializePresetDump,
  CHUNKS_PER_PRESET,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;

function csum(b: number[]): number {
  let a = 0;
  for (const x of b) a ^= x;
  return a & 0x7f;
}

function build(func: number, payload: number[]): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
  return [...head, csum(head), SYSEX_END];
}

// Per Ghidra FUN_0054d0c0 + descriptor table 0xe04440 (key=0 → offset=6
// count=2 [14-bit count], key=1 → offset=8 [data start, each ushort = 3
// septet wire bytes]). Wire offset 6 maps to chunkPayload[0] since the
// envelope F0 00 01 74 07 78 is 6 bytes.
function decodeChunkNative(payload: Uint8Array): Uint16Array {
  const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    const v =
      ((payload[off] & 0x7f) |
        ((payload[off + 1] & 0x7f) << 7) |
        ((payload[off + 2] & 0x7f) << 14)) &
      0xffff;
    out[i] = v;
  }
  return out;
}

// XOR-fold of all decoded ushorts across all chunks. Per Ghidra
// FUN_00544cc0 (16-bit XOR-fold over a ushort buffer at param_1+0x1c,
// length param_1+0x20/2). Verified 390/390 presets.
function computeFooterHash(chunks: readonly Uint8Array[]): number {
  let xor = 0;
  for (const c of chunks) {
    const ushorts = decodeChunkNative(c);
    for (const v of ushorts) xor ^= v;
  }
  return xor & 0xffff;
}

function encodeFooter(hash16: number, preservedHighSeptet: number): Uint8Array {
  // Footer parser reads 3 septet bytes via FUN_0055d750(msg, 6, 3) →
  // 21-bit value, low 16 = hash.
  // We DON'T know yet what byte 2 high-5 bits encode (Session 113 cont 4
  // claimed scene-bypass mirror but the XOR-fold finding may make that
  // coincidence). Preserve the original high septet so we don't lose
  // whatever extra metadata lives there.
  const b0 = hash16 & 0x7f;
  const b1 = (hash16 >> 7) & 0x7f;
  // Low 2 bits of footer byte 2 carry hash bits 14-15; high 5 bits keep
  // whatever the original footer had.
  const hashHigh = (hash16 >> 14) & 0x03;
  const b2 = (preservedHighSeptet & 0x7c) | hashHigh;
  return new Uint8Array([b0, b1, b2]);
}

type Conn = ReturnType<typeof connectAxeFxII>;

async function captureFor(conn: Conn, ms: number, until?: (m: number[][]) => boolean): Promise<number[][]> {
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

async function dumpPresetByWire(conn: Conn, wire: number): Promise<Uint8Array> {
  const [hi, lo] = [(wire >> 7) & 0x7f, wire & 0x7f];
  conn.send(build(0x03, [hi, lo]));
  const msgs = await captureFor(conn, 3000, (m) => m.some((x) => x[5] === 0x79));
  const dump = msgs.filter((m) => m[5] === 0x77 || m[5] === 0x78 || m[5] === 0x79);
  if (dump.length !== 66) throw new Error(`dump wire ${wire} failed: ${dump.length} frames`);
  const flat: number[] = [];
  for (const m of dump) flat.push(...m);
  return new Uint8Array(flat);
}

async function pushBytes(conn: Conn, bytes: Uint8Array): Promise<number[][]> {
  // Split into individual SysEx messages.
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
  if (messages.length !== 66) {
    throw new Error(`expected 66 messages to push, got ${messages.length}`);
  }
  const responses: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === SYSEX_START) responses.push([...b]); });
  for (const m of messages) {
    conn.send(m);
    await new Promise((r) => setTimeout(r, 8));
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
  console.log('================================================================');
  console.log('BK-070 — modified push with RECOMPUTED footer hash');
  console.log('================================================================\n');

  console.log('Step 1: switch_preset display=666 (discard)');
  await executeSwitchPreset({
    port: 'axe-fx-ii',
    location: SCRATCH_DISPLAY,
    on_active_preset_edited: 'discard',
  });
  await new Promise((r) => setTimeout(r, 250));

  const conn = connectAxeFxII();

  console.log('\nStep 2: dump baseline (wire 665)');
  const baselineBytes = await dumpPresetByWire(conn, SCRATCH_WIRE);
  writeFileSync('samples/captured/bk070-pwh-baseline.syx', Buffer.from(baselineBytes));
  console.log(`  baseline: ${baselineBytes.length} bytes`);

  console.log('\nStep 3: read amp.input_drive baseline');
  const baselineDrive = await readDrive('baseline');

  // Choose target wire value DIFFERENT from baseline. amp.input_drive
  // wire is roughly 6553 per display unit (0..10 display → 0..65535 wire).
  // Pick something distinctive that we won't accidentally hit.
  const TARGET_WIRE = baselineDrive === 0x1234 ? 0x5678 : 0x1234;
  console.log(`\nStep 4: modify chunkPayload[3][179..181] to encode wire 0x${TARGET_WIRE.toString(16)}`);
  const NEW_TRIPLET = [
    TARGET_WIRE & 0x7f,
    (TARGET_WIRE >> 7) & 0x7f,
    (TARGET_WIRE >> 14) & 0x7f,
  ];
  console.log(`  triplet bytes: [${NEW_TRIPLET.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);

  const parsed = parsePresetDump(baselineBytes);
  const baselineFooterBytes = Array.from(parsed.footerPayload);
  const baselineHashFromBytes = (baselineFooterBytes[0] & 0x7f) | ((baselineFooterBytes[1] & 0x7f) << 7) | ((baselineFooterBytes[2] & 0x7f & 0x03) << 14);
  console.log(`  baseline footer bytes: [${baselineFooterBytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
  console.log(`  baseline hash (low 16): 0x${(baselineHashFromBytes & 0xffff).toString(16).padStart(4, '0')}`);
  console.log(`  baseline footer byte2 high-5: 0x${((baselineFooterBytes[2] & 0x7c) >> 2).toString(16)}`);

  // Sanity: recompute baseline hash from chunks; should match low 16 of footer.
  const baselineHashComputed = computeFooterHash(parsed.chunkPayloads);
  console.log(`  baseline hash (computed from chunks): 0x${baselineHashComputed.toString(16).padStart(4, '0')}`);
  if ((baselineHashFromBytes & 0xffff) !== baselineHashComputed) {
    throw new Error('baseline hash mismatch — decoder broken before we even mutate');
  }

  // Modify chunk 3.
  const modifiedChunks: Uint8Array[] = parsed.chunkPayloads.map((c, i) => {
    const out = new Uint8Array(c);
    if (i === 3) {
      out[179] = NEW_TRIPLET[0];
      out[180] = NEW_TRIPLET[1];
      out[181] = NEW_TRIPLET[2];
    }
    return out;
  });

  // Recompute hash.
  const newHash = computeFooterHash(modifiedChunks);
  console.log(`\nStep 5: new hash from modified chunks: 0x${newHash.toString(16).padStart(4, '0')}`);
  const newFooter = encodeFooter(newHash, baselineFooterBytes[2]);
  console.log(`  new footer bytes: [${Array.from(newFooter).map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);

  // Serialize.
  const modifiedBytes = serializePresetDump({
    raw: parsed.raw,
    headerPayload: parsed.headerPayload,
    chunkPayloads: modifiedChunks,
    footerPayload: newFooter,
  });
  writeFileSync('samples/captured/bk070-pwh-modified.syx', Buffer.from(modifiedBytes));
  console.log(`  modified: ${modifiedBytes.length} bytes saved`);

  console.log('\nStep 6: push 66 messages to device');
  const responses = await pushBytes(conn, modifiedBytes);
  console.log(`  ${responses.length} response messages received`);

  // Count ACK / NACK responses. The device responds with fn 0x64 for ack/nack
  // (per existing notes), but actual response shape varies. Just look for
  // any response with a non-zero "error code" pattern.
  let nackCount = 0;
  for (const r of responses) {
    // Heuristic: an ACK has a 0x00 status byte somewhere; NACK has non-zero.
    if (r.length > 7 && r[5] === 0x64 && r[7] !== 0x00) {
      nackCount++;
      console.log(`  NACK: ${r.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  }
  console.log(`  NACKs detected: ${nackCount}`);

  console.log('\nStep 7: save_preset display=666');
  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise((r) => setTimeout(r, 300));

  console.log('\nStep 8: re-read amp.input_drive (post-save)');
  const postSaveDrive = await readDrive('post-save');

  console.log('\nStep 9: re-dump preset, compare to our modified bytes');
  const reDumpBytes = await dumpPresetByWire(conn, SCRATCH_WIRE);
  writeFileSync('samples/captured/bk070-pwh-redump.syx', Buffer.from(reDumpBytes));
  const reDumpParsed = parsePresetDump(reDumpBytes);
  const reDumpHash = computeFooterHash(reDumpParsed.chunkPayloads);
  const reDumpFooterBytes = Array.from(reDumpParsed.footerPayload);
  console.log(`  re-dump footer bytes: [${reDumpFooterBytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
  console.log(`  re-dump hash (computed): 0x${reDumpHash.toString(16).padStart(4, '0')}`);

  // Did the chunk-3 mod survive?
  const reDumpChunk3 = reDumpParsed.chunkPayloads[3];
  console.log(`  re-dump chunk3[179..181]: [${[reDumpChunk3[179], reDumpChunk3[180], reDumpChunk3[181]].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);

  console.log('\n================================================================');
  console.log('VERDICT');
  console.log('================================================================');
  if (nackCount === 0) {
    console.log('✅ Push had zero NACKs — modified binary accepted by device');
  } else {
    console.log(`❌ Push had ${nackCount} NACKs — modified binary rejected`);
  }
  if (postSaveDrive === TARGET_WIRE) {
    console.log(`✅ amp.input_drive post-save = 0x${postSaveDrive.toString(16)} (matches target)`);
  } else {
    console.log(`❌ amp.input_drive post-save = 0x${postSaveDrive.toString(16)}, expected 0x${TARGET_WIRE.toString(16)}`);
  }
  if (reDumpChunk3[179] === NEW_TRIPLET[0] &&
      reDumpChunk3[180] === NEW_TRIPLET[1] &&
      reDumpChunk3[181] === NEW_TRIPLET[2]) {
    console.log('✅ Re-dumped chunk3 byte triplet matches our written values');
  } else {
    console.log('❌ Re-dumped chunk3 byte triplet does NOT match');
  }

  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
