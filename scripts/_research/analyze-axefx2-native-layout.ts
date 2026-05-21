/**
 * BK-070 phase 2 — analyze the per-position structure of the Axe-Fx II
 * preset native stream.
 *
 * Builds on `decode-axefx2-preset-native.ts` (which proved the wire-to-
 * native decoder). This script:
 *
 *   1. Decodes every preset in Bank A into its native stream (4096 ushorts).
 *   2. For each (chunk_index, ushort_offset_within_chunk) position,
 *      computes the value space across 128 presets.
 *   3. Reports candidate semantic categories:
 *      - 1-valued constant (likely structural padding or version anchor)
 *      - 2-valued bool (likely per-block bypass bit)
 *      - 8-valued enum (likely scene_count_minus_one or scene index)
 *      - 64-valued range (likely a 6-bit packed value)
 *      - Wide range (likely param value or block id)
 *
 *   4. Cross-checks the chunk-0 ushort[2..33] decoded as preset-name ASCII
 *      (middle septet) — verifies our septet-decoder against the known
 *      factory names.
 *
 * Output: stdout summary + sparse coverage map per chunk.
 *
 * Usage: npx tsx scripts/_research/analyze-axefx2-native-layout.ts
 */

import { readFileSync } from 'node:fs';
import {
  PRESET_DUMP_LEN,
  parsePresetDump,
  extractPresetName,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

const FACTORY_BANK_A = 'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx';

const CHUNK_COUNT = 64;
const USHORTS_PER_CHUNK = 64;

// Per descriptor table 0xe04440: count = 14-bit septet at payload[0..1],
// data starts at payload[2] (= wire offset 8). Fixed Session 115 from
// (count = payload[0] & 0x7f, off = 1 + i*3) which read the wrong bytes
// but happened to work for factory presets where N=64 fits in 7 bits.
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

function decodePresetNative(presetBytes: Uint8Array): {
  name: string;
  chunks: Uint16Array[];
} {
  const parsed = parsePresetDump(presetBytes, 0);
  const name = extractPresetName(parsed);
  const chunks: Uint16Array[] = [];
  for (let i = 0; i < CHUNK_COUNT; i++) {
    chunks.push(decodeChunkNative(parsed.chunkPayloads[i]));
  }
  return { name, chunks };
}

function categorize(values: Set<number>): string {
  if (values.size === 1) return 'CONST';
  if (values.size === 2 && [...values].every(v => v <= 1)) return 'BOOL';
  if (values.size === 2) return `BIN(${[...values].sort((a, b) => a - b).join(',')})`;
  const maxVal = Math.max(...values);
  if (values.size <= 4 && maxVal < 32) return `ENUM4(${[...values].sort((a, b) => a - b).join(',')})`;
  if (values.size <= 8 && maxVal <= 7) return `SCENE8(0..${maxVal})`;
  if (values.size <= 16 && maxVal < 64) return `ENUM16(<${maxVal + 1})`;
  if (values.size <= 64 && maxVal < 128) return `6BIT(<${maxVal + 1})`;
  if (maxVal < 256) return `8BIT(${values.size}vals,max=${maxVal})`;
  if (maxVal < 16384) return `14BIT(${values.size}vals,max=${maxVal})`;
  return `16BIT(${values.size}vals,max=${maxVal})`;
}

function main() {
  const bank = readFileSync(FACTORY_BANK_A);
  const presetCount = bank.length / PRESET_DUMP_LEN;

  const all: { name: string; chunks: Uint16Array[] }[] = [];
  for (let p = 0; p < presetCount; p++) {
    const slice = new Uint8Array(
      bank.buffer,
      bank.byteOffset + p * PRESET_DUMP_LEN,
      PRESET_DUMP_LEN,
    );
    all.push(decodePresetNative(slice));
  }

  // ── 1. Sanity check: preset name from middle septet ──
  console.log('=== Sanity: preset name via middle septet of chunk-0 ushort[2..33] ===');
  for (let p = 0; p < Math.min(8, presetCount); p++) {
    const chars: string[] = [];
    for (let i = 2; i < 34; i++) {
      const v = all[p].chunks[0][i] ?? 0;
      const ch = (v >> 7) & 0x7f;
      if (ch === 0) break;
      if (ch >= 32 && ch <= 126) chars.push(String.fromCharCode(ch));
    }
    const decoded = chars.join('').trim();
    const known = all[p].name;
    const ok = decoded === known.trim();
    console.log(`  P${p.toString().padStart(3)} known="${known}"  decoded="${decoded}"  ${ok ? 'OK' : '!!'}`);
  }
  console.log('');

  // ── 2. Per-position value-space analysis ──
  console.log('=== Per-(chunk, offset) value-space scan ===');
  const interestingPerCategory: Map<string, Array<{ c: number; o: number; values: Set<number> }>> =
    new Map();

  for (let c = 0; c < CHUNK_COUNT; c++) {
    for (let o = 0; o < USHORTS_PER_CHUNK; o++) {
      const values = new Set<number>();
      for (const p of all) {
        values.add(p.chunks[c][o]);
      }
      const cat = categorize(values);
      // Bucket interesting categories.
      if (cat.startsWith('CONST')) continue;
      if (cat.startsWith('14BIT') || cat.startsWith('16BIT')) {
        // Too wide to care about scene state; bucket anyway for completeness.
      }
      if (!interestingPerCategory.has(cat)) interestingPerCategory.set(cat, []);
      interestingPerCategory.get(cat)!.push({ c, o, values });
    }
  }

  // Sort categories: smallest cardinality first.
  const sortedCats = [...interestingPerCategory.keys()].sort((a, b) => {
    // Prefer BOOL, SCENE8, ENUMs, etc.
    const aWeight = a.startsWith('BOOL') ? 0
      : a.startsWith('BIN') ? 1
      : a.startsWith('SCENE8') ? 2
      : a.startsWith('ENUM4') ? 3
      : a.startsWith('ENUM16') ? 4
      : a.startsWith('6BIT') ? 5
      : a.startsWith('8BIT') ? 6
      : 7;
    const bWeight = b.startsWith('BOOL') ? 0
      : b.startsWith('BIN') ? 1
      : b.startsWith('SCENE8') ? 2
      : b.startsWith('ENUM4') ? 3
      : b.startsWith('ENUM16') ? 4
      : b.startsWith('6BIT') ? 5
      : b.startsWith('8BIT') ? 6
      : 7;
    return aWeight - bWeight;
  });

  for (const cat of sortedCats) {
    const positions = interestingPerCategory.get(cat)!;
    console.log(`\n${cat}  (${positions.length} positions)`);
    // For interesting low-cardinality categories show full list.
    if (cat.startsWith('BOOL') || cat.startsWith('SCENE8') ||
        cat.startsWith('BIN') || cat.startsWith('ENUM4') || cat.startsWith('ENUM16')) {
      // Group by chunk for readability.
      const byChunk = new Map<number, number[]>();
      for (const p of positions) {
        if (!byChunk.has(p.c)) byChunk.set(p.c, []);
        byChunk.get(p.c)!.push(p.o);
      }
      const chunks = [...byChunk.keys()].sort((a, b) => a - b);
      const summary = chunks.slice(0, 6).map(c => {
        const offs = byChunk.get(c)!;
        return `ch${c}@[${offs.slice(0, 12).join(',')}${offs.length > 12 ? '...' : ''}]`;
      });
      console.log(`  ${summary.join('  ')}${chunks.length > 6 ? ` ...(+${chunks.length - 6} more chunks)` : ''}`);

      // For SCENE8 / BOOL show vertical-pattern (offsets that occur in
      // many chunks — likely per-scene fields repeated across chunks).
      const offCount = new Map<number, number>();
      for (const p of positions) offCount.set(p.o, (offCount.get(p.o) ?? 0) + 1);
      const popular = [...offCount.entries()].filter(([, n]) => n >= 4)
        .sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (popular.length > 0) {
        console.log(`  Repeating offsets (≥4 chunks): ${popular.map(([o, n]) => `o${o}×${n}`).join(', ')}`);
      }
    } else {
      console.log(`  (sample) first 5: ${positions.slice(0, 5).map(p => `(c${p.c},o${p.o})`).join(', ')}`);
    }
  }

  console.log('');
  console.log('=== KEY: SCENE8 candidates (full position list) ===');
  const scene8 = interestingPerCategory.get('SCENE8(0..7)') ?? [];
  for (const p of scene8) {
    const vals = [...p.values].sort((a, b) => a - b);
    console.log(`  (chunk ${p.c.toString().padStart(2)}, offset ${p.o.toString().padStart(2)})  values=${JSON.stringify(vals)}`);
  }

  console.log('');
  console.log('=== Other SCENE-family categories ===');
  for (const [cat, positions] of interestingPerCategory) {
    if (cat.startsWith('SCENE8') && cat !== 'SCENE8(0..7)') {
      console.log(`\n${cat}`);
      for (const p of positions) {
        const vals = [...p.values].sort((a, b) => a - b);
        console.log(`  (chunk ${p.c}, offset ${p.o}) values=${JSON.stringify(vals)}`);
      }
    }
  }
}

main();
