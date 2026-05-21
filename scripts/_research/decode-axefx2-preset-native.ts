/**
 * BK-070 — Axe-Fx II preset native-stream decoder.
 *
 * Ghidra against AxeEdit II revealed that the 64 × 194-byte chunk
 * payloads in a 12,951-byte preset dump are NOT opaque blobs. Each
 * chunk encodes a variable-length array of 16-bit native values via:
 *
 *   chunk_payload[0]      = count_septet N (low 7 bits)
 *   chunk_payload[1..3N]  = N × 3 wire bytes per ushort (septet pack):
 *     ushort_i = (b0 & 0x7F) | ((b1 & 0x7F) << 7) | ((b2 & 0x7F) << 14)
 *     // truncated to 16 bits on the editor side (`*(undefined2 *)... = uVar2;`)
 *
 * The descriptor table at .rdata 0xe04440 (modern firmware) declares:
 *   field 0: 6-bit ×    2 values  — chunk header
 *   field 1: 8-bit × 3072 values  — main data, distributed across 64 chunks
 *
 * 3072 / 64 chunks = 48 values per chunk in theory; in practice the wire
 * stores per-chunk N=64 ushorts in early chunks and trails off.
 *
 * This script:
 *   1. Decodes every chunk of every factory preset (Bank A) into the
 *      native ushort stream.
 *   2. Reports per-index value spaces across all 128 presets:
 *      - indices where value ∈ {0, 1} are candidate channel bits
 *      - indices where value ∈ {0..7} are candidate scene indices
 *
 * Usage: npx tsx scripts/_research/decode-axefx2-preset-native.ts
 */

import { readFileSync } from 'node:fs';
import {
  PRESET_DUMP_LEN,
  parsePresetDump,
  extractPresetName,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

const FACTORY_BANK_A = 'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx';

/**
 * Decode one chunk payload as the Ghidra-discovered shape, per descriptor
 * table 0xe04440 `(key=0, val_b=6, val_c=2) + (key=1, val_b=8, val_c=3072)`:
 *   chunkPayload[0..1] = 14-bit septet count N
 *   chunkPayload[2..]  = N × 3 wire bytes per ushort
 * Returns an array of N 16-bit values (the 21-bit decoded value truncated
 * to ushort by the firmware's `*(uint16_t *) = uVar2;` cast).
 *
 * NOTE: prior version used `count = payload[0] & 0x7f` (7-bit) and
 * `off = 1 + i*3`. Both were wrong; the correct read offset for data is
 * 2 (= wire offset 8, since envelope is 6 bytes long). The 7-bit count
 * accidentally worked for factory presets where N=64 fits in 7 bits.
 */
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

/**
 * Decode all 64 chunks of one preset into a single concatenated native
 * stream. Each chunk contributes its own variable-length ushort array.
 */
function decodePresetNative(
  presetBytes: Uint8Array,
): { name: string; stream: Uint16Array; perChunkLen: Uint8Array } {
  const parsed = parsePresetDump(presetBytes, 0);
  const name = extractPresetName(parsed);
  const perChunkLen = new Uint8Array(64);
  let totalLen = 0;
  const chunkArrays: Uint16Array[] = [];
  for (let i = 0; i < 64; i++) {
    const ushorts = decodeChunkNative(parsed.chunkPayloads[i]);
    chunkArrays.push(ushorts);
    perChunkLen[i] = ushorts.length;
    totalLen += ushorts.length;
  }
  const stream = new Uint16Array(totalLen);
  let cursor = 0;
  for (const arr of chunkArrays) {
    stream.set(arr, cursor);
    cursor += arr.length;
  }
  return { name, stream, perChunkLen };
}

function main() {
  const bank = readFileSync(FACTORY_BANK_A);
  const presetCount = bank.length / PRESET_DUMP_LEN;
  console.log(`Bank A: ${presetCount} presets`);
  console.log('');

  // Decode every preset.
  const all: { name: string; stream: Uint16Array; perChunkLen: Uint8Array }[] = [];
  for (let p = 0; p < presetCount; p++) {
    const slice = new Uint8Array(
      bank.buffer,
      bank.byteOffset + p * PRESET_DUMP_LEN,
      PRESET_DUMP_LEN,
    );
    all.push(decodePresetNative(slice));
  }

  // Summary: per-chunk length histogram.
  console.log('Per-chunk length distribution across 128 presets:');
  console.log('  chunk | min | max | mean | unique-values');
  console.log('  ------+-----+-----+------+--------------');
  for (let c = 0; c < 64; c++) {
    let min = 255, max = 0, sum = 0;
    const distinct = new Set<number>();
    for (const p of all) {
      const n = p.perChunkLen[c];
      if (n < min) min = n;
      if (n > max) max = n;
      sum += n;
      distinct.add(n);
    }
    if (c < 5 || c === 16 || c === 32 || c === 47 || c === 48 || c >= 60) {
      console.log(
        `   ${c.toString().padStart(3)} | ${min.toString().padStart(3)} | ${max
          .toString()
          .padStart(3)} | ${(sum / presetCount).toFixed(1).padStart(5)} | ${distinct.size}`,
      );
    }
  }
  console.log('');

  // Verify the preset-name decoding works on the native stream.
  // Chunk 0 native stream: ushort[0] = header field 0, ushort[1] = header
  // field 1, then the name starts. From our raw-byte inspection the name
  // chars sit in low septet of triplets starting at wire offset 8 of chunk
  // 0 payload, which is...  Let me search for the first ASCII run.
  const firstPreset = all[0];
  console.log(`Preset 0 name (existing parser): "${firstPreset.name}"`);
  console.log(`Preset 0 native stream: ${firstPreset.stream.length} ushorts`);
  console.log('First 50 ushorts:');
  for (let i = 0; i < Math.min(50, firstPreset.stream.length); i++) {
    const v = firstPreset.stream[i];
    const lowByte = v & 0xff;
    const ch = lowByte >= 32 && lowByte <= 126 ? String.fromCharCode(lowByte) : ' ';
    console.log(
      `  [${i.toString().padStart(3)}]  0x${v.toString(16).padStart(4, '0')}  ` +
        `${v.toString().padStart(5)}  low8='${ch}'`,
    );
  }
  console.log('');

  // ── Per-index value-space analysis ──────────────────────────────
  // Length of the SHORTEST stream — only analyze positions present in all.
  let minLen = all[0].stream.length;
  for (const p of all) if (p.stream.length < minLen) minLen = p.stream.length;
  console.log(`Shortest preset stream: ${minLen} ushorts`);
  console.log('');

  // For each index, collect the value space across all 128 presets.
  type IdxStat = { idx: number; values: Set<number>; maxVal: number };
  const stats: IdxStat[] = [];
  for (let i = 0; i < minLen; i++) {
    const values = new Set<number>();
    let maxVal = 0;
    for (const p of all) {
      const v = p.stream[i];
      values.add(v);
      if (v > maxVal) maxVal = v;
    }
    stats.push({ idx: i, values, maxVal });
  }

  // Find indices where ALL values are in {0, 1}.
  const boolIndices: number[] = [];
  for (const s of stats) {
    if (s.maxVal <= 1) boolIndices.push(s.idx);
  }
  console.log(
    `Boolean indices (value space ⊆ {0, 1}): ${boolIndices.length} of ${minLen}`,
  );
  if (boolIndices.length > 0 && boolIndices.length < 200) {
    console.log(`  ${boolIndices.slice(0, 80).join(', ')}` +
      (boolIndices.length > 80 ? ` ... (+${boolIndices.length - 80} more)` : ''));
  }
  console.log('');

  // Find indices where ALL values are in {0..7} (potential scene indices).
  const sceneIndices: number[] = [];
  for (const s of stats) {
    if (s.maxVal <= 7 && s.maxVal > 1) sceneIndices.push(s.idx);
  }
  console.log(
    `Scene-byte indices (value space ⊆ {0..7}, max > 1): ${sceneIndices.length} of ${minLen}`,
  );
  if (sceneIndices.length > 0 && sceneIndices.length < 200) {
    console.log(`  ${sceneIndices.slice(0, 80).join(', ')}` +
      (sceneIndices.length > 80 ? ` ... (+${sceneIndices.length - 80} more)` : ''));
  }
  console.log('');

  // Find indices where value space has cardinality 2 but values aren't {0,1}.
  const binaryNonBool: number[] = [];
  for (const s of stats) {
    if (s.values.size === 2 && s.maxVal > 1) binaryNonBool.push(s.idx);
  }
  console.log(
    `2-valued indices (cardinality 2, not {0,1}): ${binaryNonBool.length}`,
  );
  if (binaryNonBool.length > 0 && binaryNonBool.length < 50) {
    for (const i of binaryNonBool.slice(0, 20)) {
      const vals = [...stats[i].values].sort((a, b) => a - b);
      console.log(`  [${i}] = {${vals.join(', ')}}`);
    }
  }
  console.log('');

  // Find indices where value space has cardinality 8 (likely 8-scene fields).
  const eightValued: number[] = [];
  for (const s of stats) {
    if (s.values.size === 8) eightValued.push(s.idx);
  }
  console.log(`8-valued indices (cardinality exactly 8): ${eightValued.length}`);

  // Find indices that look like block IDs (large value space, > 100 distinct).
  const blockIdLike: number[] = [];
  for (const s of stats) {
    if (s.values.size >= 50) blockIdLike.push(s.idx);
  }
  console.log(`Block-id-like indices (>=50 distinct values): ${blockIdLike.length}`);
}

main();
