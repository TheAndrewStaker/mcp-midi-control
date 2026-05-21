/**
 * BK-070 — Axe-Fx II preset-dump diff harness.
 *
 * Static analysis of the factory bank to isolate per-scene + per-block
 * byte offsets inside the 12,951-byte preset-dump envelope. Used to
 * build the offset map needed for atomic apply_preset (the structural
 * fix that kills the SET_BLOCK_CHANNEL corruption class).
 *
 * Three modes:
 *
 *   - `pair <bankA-N> <bankA-M>` — byte-by-byte diff between two
 *     specific presets in Bank A. Reports differing offsets + a 16-byte
 *     hex window around each one.
 *   - `variance <bank>` — for each byte offset in the preset binary,
 *     count how many distinct values appear across all 128 presets in
 *     the bank. Surfaces structural constants (1 value), low-variance
 *     fields (2-4 values, likely enums), high-variance fields (128
 *     values, content). Output is a histogram + the top-N most-variant
 *     offsets.
 *   - `name-region` — confirms the preset-name decoding by printing
 *     all 128 names from Bank A through `extractPresetName`. Used to
 *     re-verify the name encoding when chunk-0 layout investigations
 *     might have invalidated assumptions.
 *
 * Usage:
 *   npx tsx scripts/_research/diff-axefx2-preset-dump.ts pair A 1 2
 *   npx tsx scripts/_research/diff-axefx2-preset-dump.ts variance A
 *   npx tsx scripts/_research/diff-axefx2-preset-dump.ts name-region
 *   npx tsx scripts/_research/diff-axefx2-preset-dump.ts list A
 *
 * Output is human-readable for now; the goal is feedback loop, not
 * automated reporting. Once the offset map is stable we'll codify
 * findings in `fractal-midi/docs/devices/axe-fx-ii/preset-binary.md`
 * and ship reader/writer helpers in `presetDump.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  CHUNKS_PER_PRESET,
  CHUNK_PAYLOAD_LEN,
  PRESET_DUMP_LEN,
  extractPresetName,
  parsePresetBank,
  type ParsedPresetDump,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

const BANK_PATHS: Record<string, string> = {
  A: 'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx',
  B: 'samples/factory/Axe-Fx-II_XL+_Bank-B_Q8p02.syx',
  C: 'samples/factory/Axe-Fx-II_XL+_Bank-C_Q8p02.syx',
};

function loadBank(bank: string): ParsedPresetDump[] {
  const path = BANK_PATHS[bank.toUpperCase()];
  if (path === undefined) throw new Error(`Unknown bank '${bank}'. Use A, B, or C.`);
  if (!existsSync(path)) throw new Error(`Bank file not found: ${path}`);
  const bytes = new Uint8Array(readFileSync(path));
  return parsePresetBank(bytes);
}

function fmtHex(b: number | undefined): string {
  if (b === undefined) return '..';
  return b.toString(16).padStart(2, '0');
}

function hexWindow(bytes: Uint8Array, offset: number, width = 16): string {
  const start = Math.max(0, offset - width / 2);
  const end = Math.min(bytes.length, start + width);
  const chunks: string[] = [];
  for (let i = start; i < end; i++) {
    const marker = i === offset ? `[${fmtHex(bytes[i])}]` : ` ${fmtHex(bytes[i])} `;
    chunks.push(marker);
  }
  return `@${start}..${end}: ${chunks.join('')}`;
}

/** Flatten the parsed dump's payload (header + chunks + footer) into a
 *  single 12,929-byte buffer addressed as "preset byte 0 = header byte 0,
 *  preset byte 4 = chunk 0 byte 0, etc." Lets diffs report offsets in
 *  preset-relative terms instead of per-chunk. */
function flattenPayload(p: ParsedPresetDump): Uint8Array {
  const total = p.headerPayload.length + p.chunkPayloads.length * CHUNK_PAYLOAD_LEN + p.footerPayload.length;
  const out = new Uint8Array(total);
  let cur = 0;
  out.set(p.headerPayload, cur); cur += p.headerPayload.length;
  for (const c of p.chunkPayloads) { out.set(c, cur); cur += c.length; }
  out.set(p.footerPayload, cur);
  return out;
}

function regionOf(offset: number): string {
  if (offset < 4) return 'HEADER';
  const chunkOffset = offset - 4;
  if (chunkOffset < CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN) {
    const chunkIdx = Math.floor(chunkOffset / CHUNK_PAYLOAD_LEN);
    const inChunk = chunkOffset % CHUNK_PAYLOAD_LEN;
    return `CHUNK${chunkIdx.toString().padStart(2, '0')}:${inChunk.toString().padStart(3, '0')}`;
  }
  return `FOOTER:${chunkOffset - CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN}`;
}

function cmdPair(args: string[]): void {
  const [bank, aStr, bStr] = args;
  if (bank === undefined || aStr === undefined || bStr === undefined) {
    console.error('usage: pair <bank> <preset-A 1-128> <preset-B 1-128>');
    process.exit(1);
  }
  const bankData = loadBank(bank);
  const a = Number(aStr) - 1;
  const b = Number(bStr) - 1;
  if (a < 0 || a >= bankData.length || b < 0 || b >= bankData.length) {
    console.error(`preset indices must be 1..${bankData.length}`);
    process.exit(1);
  }
  const pa = bankData[a];
  const pb = bankData[b];
  const fa = flattenPayload(pa);
  const fb = flattenPayload(pb);
  if (fa.length !== fb.length) {
    console.error(`payload sizes differ: ${fa.length} vs ${fb.length}`);
    process.exit(1);
  }

  console.log(`Pair diff: Bank ${bank.toUpperCase()} preset ${a + 1} ("${extractPresetName(pa)}") vs preset ${b + 1} ("${extractPresetName(pb)}")`);
  console.log(`Total payload bytes: ${fa.length}`);
  console.log(`Region map: HEADER (offsets 0..3) | CHUNK00..CHUNK63 (each 194 bytes) | FOOTER (offsets ${4 + CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN}..end)`);
  console.log('');

  const diffs: number[] = [];
  for (let i = 0; i < fa.length; i++) {
    if (fa[i] !== fb[i]) diffs.push(i);
  }
  console.log(`Bytes differing: ${diffs.length} of ${fa.length} (${((diffs.length / fa.length) * 100).toFixed(1)}%)`);

  // Group adjacent diffs into runs for easier reading.
  const runs: { start: number; end: number }[] = [];
  for (const d of diffs) {
    const last = runs[runs.length - 1];
    if (last !== undefined && d <= last.end + 8) {
      last.end = d;
    } else {
      runs.push({ start: d, end: d });
    }
  }
  console.log(`Coalesced runs (gap ≤ 8 bytes treated as adjacent): ${runs.length}`);
  console.log('');

  // Print first N runs with surrounding hex.
  const MAX_RUNS = 40;
  console.log(`First ${Math.min(MAX_RUNS, runs.length)} runs:`);
  for (let i = 0; i < Math.min(MAX_RUNS, runs.length); i++) {
    const r = runs[i];
    const len = r.end - r.start + 1;
    const region = regionOf(r.start);
    const aSlice = Array.from(fa.slice(r.start, r.end + 1)).map(fmtHex).join(' ');
    const bSlice = Array.from(fb.slice(r.start, r.end + 1)).map(fmtHex).join(' ');
    console.log(`  ${region}  payload[${r.start}..${r.end}] (${len}B):`);
    console.log(`    A=[${aSlice}]`);
    console.log(`    B=[${bSlice}]`);
  }
  if (runs.length > MAX_RUNS) {
    console.log(`  ... ${runs.length - MAX_RUNS} more runs`);
  }
}

function cmdVariance(args: string[]): void {
  const [bank] = args;
  if (bank === undefined) {
    console.error('usage: variance <bank>');
    process.exit(1);
  }
  const bankData = loadBank(bank);
  const flattened = bankData.map(flattenPayload);
  const len = flattened[0].length;

  // For each offset, count distinct values across all 128 presets.
  const distinct: number[] = new Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    const seen = new Set<number>();
    for (const f of flattened) seen.add(f[i]);
    distinct[i] = seen.size;
  }

  // Histogram of distinct counts.
  const histogram: Map<number, number> = new Map();
  for (const d of distinct) histogram.set(d, (histogram.get(d) ?? 0) + 1);
  console.log(`Variance histogram across Bank ${bank.toUpperCase()} (${flattened.length} presets, ${len} bytes each):`);
  const sortedBuckets = Array.from(histogram.entries()).sort((a, b) => b[0] - a[0]);
  for (const [distinctCount, byteCount] of sortedBuckets) {
    const pct = ((byteCount / len) * 100).toFixed(1);
    console.log(`  ${distinctCount.toString().padStart(4)} distinct values: ${byteCount.toString().padStart(5)} bytes (${pct}%)`);
  }
  console.log('');

  // Count of constants (1 distinct value).
  const constOffsets: number[] = [];
  for (let i = 0; i < len; i++) if (distinct[i] === 1) constOffsets.push(i);
  console.log(`Constant offsets (1 distinct value across all 128 presets): ${constOffsets.length}`);

  // Bucket constants by region.
  const regionCounts: Map<string, number> = new Map();
  for (const o of constOffsets) {
    const region = regionOf(o).split(':')[0];
    regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
  }
  console.log('  Constants per region:');
  for (const [region, count] of [...regionCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${region}: ${count}`);
  }
  console.log('');

  // Most-varying offsets (likely content / scene state).
  const variantOrder = distinct
    .map((d, i) => ({ offset: i, distinct: d }))
    .sort((a, b) => b.distinct - a.distinct)
    .slice(0, 30);
  console.log('Top 30 most-variant byte offsets (likely content / per-preset state):');
  for (const v of variantOrder) {
    console.log(`  offset ${v.offset.toString().padStart(5)} (${regionOf(v.offset)}): ${v.distinct} distinct values`);
  }
}

function cmdNameRegion(): void {
  const bank = loadBank('A');
  console.log('Bank A preset names via extractPresetName:');
  for (let i = 0; i < bank.length; i++) {
    const name = extractPresetName(bank[i]);
    console.log(`  ${(i + 1).toString().padStart(3)}: "${name}"`);
  }
}

function cmdList(args: string[]): void {
  const [bank] = args;
  if (bank === undefined) {
    console.error('usage: list <bank>');
    process.exit(1);
  }
  const bankData = loadBank(bank);
  console.log(`Bank ${bank.toUpperCase()} (${bankData.length} presets):`);
  for (let i = 0; i < bankData.length; i++) {
    console.log(`  ${(i + 1).toString().padStart(3)}: "${extractPresetName(bankData[i])}"`);
  }
}

const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case 'pair':       cmdPair(rest); break;
  case 'variance':   cmdVariance(rest); break;
  case 'name-region': cmdNameRegion(); break;
  case 'list':       cmdList(rest); break;
  default:
    console.error('Usage:');
    console.error('  npx tsx scripts/_research/diff-axefx2-preset-dump.ts pair <bank> <preset-A> <preset-B>');
    console.error('  npx tsx scripts/_research/diff-axefx2-preset-dump.ts variance <bank>');
    console.error('  npx tsx scripts/_research/diff-axefx2-preset-dump.ts name-region');
    console.error('  npx tsx scripts/_research/diff-axefx2-preset-dump.ts list <bank>');
    process.exit(1);
}
