/**
 * Verify the BK-070 breakthrough: Ghidra against AxeEdit II shows the
 * 12,951-byte PATCH_DUMP wire stream is septet-encoded native ushorts,
 * not opaque wire bytes. Each chunk's 194-byte payload = 1 septet
 * count + N × 3 septets per ushort.
 *
 * Acceptance test: decode chunk 0's first ushort field (the count N),
 * then decode the next N ushorts. The 32 ushorts starting at
 * payload offset 8 should be the preset name characters (ASCII bytes
 * 0..127 in the low 7 bits). This validates the septet decoder against
 * the known factory-bank preset names.
 *
 * Usage: npx tsx scripts/_research/verify-axefx2-septet-encoding.ts
 */

import { readFileSync } from 'node:fs';
import {
  CHUNKS_PER_PRESET,
  CHUNK_LEN,
  CHUNK_PAYLOAD_LEN,
  HEADER_LEN,
  PRESET_DUMP_LEN,
  parsePresetDump,
  extractPresetName,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

const FACTORY_BANK_A =
  'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx';

/**
 * Septet-decode `count` consecutive wire bytes into a single uint.
 * Each wire byte contributes 7 bits LSB-first.
 *   uint = (b0 & 0x7F) | ((b1 & 0x7F) << 7) | ((b2 & 0x7F) << 14) | ...
 */
function septetDecode(buf: Uint8Array, offset: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i++) v |= (buf[offset + i] & 0x7f) << (i * 7);
  return v >>> 0;
}

/**
 * Parse one 194-byte chunk payload as the Ghidra-discovered shape:
 *   [count_septet (1 byte)] [count × 3 septets per ushort]
 */
function parseChunkNative(payload: Uint8Array): Uint16Array {
  const count = payload[0] & 0x7f;
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = septetDecode(payload, 1 + i * 3, 3) & 0xffff;
  }
  return out;
}

function main() {
  const bank = readFileSync(FACTORY_BANK_A);
  console.log(`Bank file: ${FACTORY_BANK_A} (${bank.length} bytes)`);
  console.log(`Expected preset count: ${bank.length / PRESET_DUMP_LEN}`);
  console.log('');

  // Examine the first preset only (preset 0 "59 BASSGUY")
  const preset = new Uint8Array(bank.buffer, bank.byteOffset, PRESET_DUMP_LEN);
  const parsed = parsePresetDump(preset, 0);
  const knownName = extractPresetName(parsed);
  console.log(`Known name (per existing parser): "${knownName}"`);
  console.log('');

  // Decode chunk 0's native stream
  const chunk0 = parsed.chunkPayloads[0];
  // Try a different decode: just stride-3 ushorts starting from offset 0.
  // The Ghidra parser reads (offset=?, count=3) per ushort; descriptor table
  // controls offset. Native ushort i starts at wire offset i*3.
  const chunk0Native = new Uint16Array(Math.floor(chunk0.length / 3));
  for (let i = 0; i < chunk0Native.length; i++) {
    chunk0Native[i] = septetDecode(chunk0, i * 3, 3) & 0xffff;
  }
  console.log(`Chunk 0: payload length=${chunk0.length}`);
  console.log(`Chunk 0 native: ${chunk0Native.length} ushorts (stride 3)`);
  console.log('');
  const rawHex = Array.from(chunk0.slice(0, 36)).map(b => b.toString(16).padStart(2,'0')).join(' ');
  console.log('Chunk 0 first 36 raw bytes (from parsed.chunkPayloads[0]):');
  console.log('  ' + rawHex);
  console.log('');

  // Decode chunk 0's first 35 ushorts (3 header fields + 32 name characters)
  console.log('Chunk 0 first 40 ushorts:');
  for (let i = 0; i < Math.min(40, chunk0Native.length); i++) {
    const v = chunk0Native[i];
    const ascii = (v >= 32 && v <= 126) ? String.fromCharCode(v) : '·';
    console.log(`  [${i.toString().padStart(2)}]  0x${v.toString(16).padStart(4, '0')}  ${v.toString().padStart(5)}  '${ascii}'`);
  }
  console.log('');

  // Try the preset-name slot: starts at ushort index 0 per Ghidra (header fields
  // come from a different parser via 0x77, so chunk 0 begins with the name)
  // The existing parser says name lives at chunk 0 payload offset 8, 32 × 3-byte triplets.
  // That offset 8 is wire-byte offset, which corresponds to native ushort offset...
  // Let's check: offset 8 = septet header (1 byte) + 7 wire bytes already consumed.
  // 7 wire bytes after count = 7/3 = 2.33 ushorts. Doesn't align cleanly.
  // Reading more carefully: the existing parser uses `payload[8 + i * 3]` for ASCII.
  // That's wire offset 8 = native ushort index ((8 - 1) / 3) = 2.33 ... so name actually
  // starts at native ushort index 3 (after 1 count_septet + a few header ushorts).
  //
  // Try several starting offsets to find where the preset name begins.
  console.log('Searching for preset name as N=32 consecutive 7-bit-ASCII ushorts:');
  for (let start = 0; start < 20; start++) {
    const chars: string[] = [];
    let allAscii = true;
    for (let i = 0; i < 32; i++) {
      if (start + i >= chunk0Native.length) { allAscii = false; break; }
      const v = chunk0Native[start + i] & 0xff;
      if (v === 0) { chars.push('\0'); continue; }
      if (v >= 32 && v <= 126) chars.push(String.fromCharCode(v));
      else { allAscii = false; break; }
    }
    if (allAscii) {
      const text = chars.join('').replace(/\0/g, '·').trimEnd();
      console.log(`  start_idx=${start}: "${text}"`);
    }
  }
}

main();
