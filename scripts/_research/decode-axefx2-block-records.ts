/**
 * BK-070 — decode the block-record list at CHUNK00:110+.
 *
 * Per Session 113 cont 4 notes, the block-record list is "12 × 24-byte
 * records, stride 24" starting at CHUNK00:110. Each record encodes
 * which block_type is at which slot.
 *
 * Strategy: decode the chunk 0 native ushort stream, find a region
 * with constant-stride structure, and dump it across multiple
 * factory presets to see what varies and what stays constant.
 *
 * Note: CHUNK00:110 is a WIRE BYTE offset, not a native-ushort offset.
 * In the native view, that's ushort index (110 - 2) / 3 ≈ 36 within
 * chunk 0 (after the 2-byte count and 36 chars × 3 bytes of preset
 * name, which occupies ushorts 0..35).
 */

import { readFileSync, existsSync } from 'node:fs';
import {
  parsePresetBank,
  parsePresetDump,
  PRESET_DUMP_LEN,
  extractPresetName,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';
import type { ParsedPresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

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

function hexBytes(bytes: Uint8Array, start: number, len: number): string {
  return Array.from(bytes.slice(start, start + len))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function hexUshorts(arr: Uint16Array, start: number, len: number): string {
  return Array.from(arr.slice(start, start + len))
    .map((v) => '0x' + v.toString(16).padStart(4, '0'))
    .join(' ');
}

function loadBank(path: string): ParsedPresetDump[] | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = new Uint8Array(readFileSync(path));
  return parsePresetBank(bytes);
}

function analyzePreset(parsed: ParsedPresetDump, label: string): void {
  const name = extractPresetName(parsed);
  const chunk0Payload = parsed.chunkPayloads[0];
  const chunk0Native = decodeChunkNative(chunk0Payload);
  console.log(`\n--- ${label}: "${name}" ---`);
  console.log(`Chunk 0: ${chunk0Native.length} native ushorts`);

  // The preset name occupies ushorts 0..??? — let's see where the
  // count "header" ends and what's after. Per notes, name is at wire
  // offset 8..103 = 32 chars × 3 bytes. In native view starting at
  // ushort 0:
  //  - ushort[0..1] likely header constants
  //  - ushort[2..33] preset name (32 chars in middle septet)
  //  - ushort[34..end] block-record list?

  // Show ushorts 0..63 as 4-byte hex rows.
  console.log('Chunk 0 native ushorts (decoded):');
  for (let row = 0; row < 16; row++) {
    const start = row * 4;
    const ushorts = Array.from(chunk0Native.slice(start, start + 4));
    const hex = ushorts.map((v) => '0x' + v.toString(16).padStart(4, '0')).join(' ');
    // ASCII decode (middle septet) for name region.
    const ascii = ushorts
      .map((v) => {
        const ch = (v >> 7) & 0x7f;
        return ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '.';
      })
      .join('');
    console.log(`  [${start.toString().padStart(2)}..${(start + 3).toString().padStart(2)}]  ${hex}  | ${ascii}`);
  }
}

function diffPresets(a: ParsedPresetDump, b: ParsedPresetDump, label: string): void {
  const aN = decodeChunkNative(a.chunkPayloads[0]);
  const bN = decodeChunkNative(b.chunkPayloads[0]);
  console.log(`\n--- DIFF: ${label} ---`);
  const len = Math.min(aN.length, bN.length);
  for (let i = 0; i < len; i++) {
    if (aN[i] !== bN[i]) {
      console.log(`  ushort[${i.toString().padStart(2)}]: 0x${aN[i].toString(16).padStart(4, '0')} -> 0x${bN[i].toString(16).padStart(4, '0')}`);
    }
  }
  if (aN.length !== bN.length) {
    console.log(`  (lengths differ: ${aN.length} vs ${bN.length})`);
  }
}

function main(): void {
  console.log('BK-070 — decode block-record list at CHUNK00:110+\n');

  // Examine factory presets to see the chunk 0 structure.
  const bankA = loadBank('samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx');
  if (bankA !== undefined && bankA.length > 0) {
    console.log('=== Factory Bank A ===');
    // Look at 4 distinct presets so we can see structural patterns.
    for (const idx of [0, 1, 64, 127]) {
      if (idx < bankA.length) analyzePreset(bankA[idx], `Bank A preset ${idx}`);
    }
    // Diff two adjacent presets to see what fields differ.
    if (bankA.length > 1) {
      diffPresets(bankA[0], bankA[1], 'Bank A preset 0 vs 1');
    }
  }

  // Examine the BK-070 hardware captures (those have known mutations).
  for (const captureName of [
    'bk070-loop-amp-master-vol-3-baseline.syx',
    'bk070-loop-amp-master-vol-3-after.syx',
    'bk070-loop-amp-scene1-Y-baseline.syx',
    'bk070-loop-amp-scene1-Y-after.syx',
    'bk070-pwh-baseline.syx',
    'bk070-pwh-redump.syx',
  ]) {
    const path = `samples/captured/${captureName}`;
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.length !== PRESET_DUMP_LEN) continue;
    const parsed = parsePresetDump(bytes);
    analyzePreset(parsed, captureName);
  }
}

main();
