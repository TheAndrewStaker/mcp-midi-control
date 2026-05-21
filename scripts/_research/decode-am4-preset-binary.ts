/**
 * AM4 preset binary — field-discovery harness (post-name decode).
 *
 * The 12,352-byte AM4 preset frame is largely undecoded. BK-036 cracked
 * the name field via paired calibration captures (`ABCDEFG.syx`,
 * `Test 1234.syx`). This script extends the same methodology to the
 * remaining structural fields without any new hardware capture:
 *
 *   1. Determinism mask. Three byte-identical-content re-exports of A01
 *      (`A01-original`, `A01-clean-a`, `A01-clean-b`) reveal which byte
 *      positions are per-export random (timestamp / padding / sequence
 *      noise — ~22% per BK-036). The mask is the COMPLEMENT: positions
 *      stable across all three re-exports. Every structural field lives
 *      inside this mask.
 *
 *   2. Param-value byte localization. A01-original vs A01-gain-plus-1
 *      changes a SINGLE param (amp.gain by 1 unit). Bytes that differ
 *      between these two captures AND fall inside the determinism mask
 *      are the wire bytes for amp.gain.
 *
 *   3. Block-layout discovery. The 104 factory presets in the bank file
 *      span every block-type combination AM4 supports. For each
 *      deterministic byte position, we count distinct values across the
 *      104 frames. Positions with cardinality matching a known
 *      block-type enum (e.g., 17 for full block-type set) become
 *      candidates for "slot N block type". Positions with cardinality
 *      matching the amp-type enum (~38 amp models on AM4) become
 *      candidates for amp.type. Etc.
 *
 *   4. Scene-state probing. Each preset stores 4 scenes; bypass + active
 *      channel per slot per scene = ~32 bytes of scene state. The
 *      pattern should appear as 4 repeating sub-structures within the
 *      preset frame. Walk the deterministic mask for 4× repeated
 *      structures separated by a constant stride.
 *
 * Output:
 *   - JSON summary at `samples/captured/am4-binary-decode-2026-05-21.json`
 *   - Markdown findings at `samples/captured/am4-binary-decode-2026-05-21.md`
 *
 * Run:
 *   npx tsx scripts/_research/decode-am4-preset-binary.ts
 *
 * This is RESEARCH SCRATCH — findings here motivate `presetBinary.ts`
 * fields in fractal-midi/src/am4/. Nothing here ships as code until
 * goldens are written.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

import {
  AM4_PRESET_FRAME_SIZE,
  AM4_PRESET_NAME_OFFSET,
  AM4_PRESET_NAME_WIRE_LENGTH,
  decodeAm4PresetNameFromFrame,
} from 'fractal-midi/am4';
import { unpackValueChunked } from 'fractal-midi/shared';
import {
  parsePresetDump,
  CHUNK_PAYLOAD_LEN,
  CHUNKS_PER_PRESET,
} from '@mcp-midi-control/am4/presetDump.js';
import {
  AMP_TYPES_VALUES,
  DRIVE_TYPES_VALUES,
  REVERB_TYPES_VALUES,
  DELAY_TYPES_VALUES,
  CHORUS_TYPES_VALUES,
  FLANGER_TYPES_VALUES,
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  COMPRESSOR_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
  BLOCK_TYPE_VALUES,
} from 'fractal-midi/am4';

const FACTORY_BANK = 'samples/factory/AM4-Factory-Presets-1p01.syx';
const A01_ORIG = 'samples/factory/A01-original.syx';
const A01_CLEAN_A = 'samples/factory/A01-clean-a.syx';
const A01_CLEAN_B = 'samples/factory/A01-clean-b.syx';
const A01_GAIN_PLUS_1 = 'samples/factory/A01-gain-plus-1.syx';

function readBinary(p: string): Uint8Array {
  if (!existsSync(p)) {
    throw new Error(`missing input: ${p}`);
  }
  const b = readFileSync(path.resolve(p));
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

interface FrameDiff {
  position: number;
  values: number[];      // value per source, in order
  delta: number | null;  // (b - a) if 2 sources, else null
}

function diffSources(sources: Uint8Array[], frameSize = AM4_PRESET_FRAME_SIZE): FrameDiff[] {
  const out: FrameDiff[] = [];
  for (let i = 0; i < frameSize; i++) {
    const values = sources.map((s) => s[i]!);
    const allEqual = values.every((v) => v === values[0]);
    if (!allEqual) {
      out.push({
        position: i,
        values,
        delta: values.length === 2 ? values[1] - values[0] : null,
      });
    }
  }
  return out;
}

function buildDeterminismMask(frames: Uint8Array[], frameSize = AM4_PRESET_FRAME_SIZE): boolean[] {
  // True at position i means "stable (same byte across all frames)".
  const mask = new Array<boolean>(frameSize);
  for (let i = 0; i < frameSize; i++) {
    const first = frames[0]![i]!;
    let stable = true;
    for (let j = 1; j < frames.length; j++) {
      if (frames[j]![i]! !== first) { stable = false; break; }
    }
    mask[i] = stable;
  }
  return mask;
}

interface FactoryStats {
  position: number;
  distinctCount: number;
  distinctValues: number[];   // up to 32 listed
  histogramTopN: Array<{ value: number; count: number }>;
}

function computeFactoryStats(
  factoryFrames: Uint8Array[],
  determinismMask: boolean[],
  frameSize = AM4_PRESET_FRAME_SIZE,
): FactoryStats[] {
  const out: FactoryStats[] = [];
  for (let i = 0; i < frameSize; i++) {
    if (!determinismMask[i]) continue;
    const counts = new Map<number, number>();
    for (const frame of factoryFrames) {
      const v = frame[i]!;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const distinctValues = [...counts.keys()].sort((a, b) => a - b);
    if (distinctValues.length <= 1) continue;  // constant across factory
    const histogram = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({ value, count }));
    out.push({
      position: i,
      distinctCount: distinctValues.length,
      distinctValues: distinctValues.slice(0, 32),
      histogramTopN: histogram,
    });
  }
  return out;
}

function parsePresetFrames(bank: Uint8Array, frameSize = AM4_PRESET_FRAME_SIZE): Uint8Array[] {
  if (bank.length % frameSize !== 0) {
    throw new Error(`factory bank size ${bank.length} not a multiple of ${frameSize}`);
  }
  const count = bank.length / frameSize;
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    out.push(bank.subarray(i * frameSize, (i + 1) * frameSize));
  }
  return out;
}

function locFromIndex(idx: number): string {
  const bank = String.fromCharCode('A'.charCodeAt(0) + Math.floor(idx / 4));
  const sub = (idx % 4) + 1;
  return `${bank}${sub.toString().padStart(2, '0')}`;
}

function hex(n: number, w = 2): string {
  return '0x' + n.toString(16).padStart(w, '0');
}

function toNumberSet(enumish: unknown): Set<number> {
  // Accepts either a number[] / readonly number[] OR a record-shaped enum
  // table (string-keyed or value-mapped). Returns the underlying integer IDs.
  if (Array.isArray(enumish)) {
    return new Set(enumish as number[]);
  }
  if (enumish && typeof enumish === 'object') {
    const out = new Set<number>();
    for (const [k, v] of Object.entries(enumish)) {
      // Two record shapes occur in fractal-midi:
      //  - { name: id }   (BLOCK_TYPE_VALUES)
      //  - { '0': 'Name', '1': 'Name', ... }  (AMP_TYPES_VALUES)
      if (typeof v === 'number') out.add(v);
      const asNum = Number(k);
      if (Number.isInteger(asNum) && asNum >= 0 && asNum < 1024) out.add(asNum);
    }
    return out;
  }
  return new Set<number>();
}

function looksLikeEnum(distinct: number[], enumValues: unknown): boolean {
  // Heuristic: every observed value is a known enum value, AND the
  // observed set covers >25% of the enum.
  const enumSet = toNumberSet(enumValues);
  if (enumSet.size === 0) return false;
  for (const v of distinct) {
    if (!enumSet.has(v)) return false;
  }
  return distinct.length >= Math.max(2, Math.floor(enumSet.size * 0.25));
}

function classifyPosition(
  s: FactoryStats,
): { tag: string; reason: string } | null {
  // Block-type byte (slot occupancy): values restricted to BLOCK_TYPE_VALUES.
  if (looksLikeEnum(s.distinctValues, BLOCK_TYPE_VALUES)) {
    const sz = toNumberSet(BLOCK_TYPE_VALUES).size;
    return { tag: 'block_type_id?', reason: `${s.distinctCount} distinct values, all match BLOCK_TYPE_VALUES (${sz} types)` };
  }
  // Amp type: AMP_TYPES_VALUES.
  if (looksLikeEnum(s.distinctValues, AMP_TYPES_VALUES)) {
    const sz = toNumberSet(AMP_TYPES_VALUES).size;
    return { tag: 'amp_type?', reason: `${s.distinctCount} distinct values, all match AMP_TYPES_VALUES (${sz} models)` };
  }
  // Reverb / Delay / Drive / etc.
  const enumChecks: Array<[string, unknown]> = [
    ['drive_type?', DRIVE_TYPES_VALUES],
    ['reverb_type?', REVERB_TYPES_VALUES],
    ['delay_type?', DELAY_TYPES_VALUES],
    ['chorus_type?', CHORUS_TYPES_VALUES],
    ['flanger_type?', FLANGER_TYPES_VALUES],
    ['phaser_type?', PHASER_TYPES_VALUES],
    ['wah_type?', WAH_TYPES_VALUES],
    ['compressor_type?', COMPRESSOR_TYPES_VALUES],
    ['filter_type?', FILTER_TYPES_VALUES],
    ['tremolo_type?', TREMOLO_TYPES_VALUES],
    ['enhancer_type?', ENHANCER_TYPES_VALUES],
    ['gate_type?', GATE_TYPES_VALUES],
  ];
  for (const [tag, values] of enumChecks) {
    if (looksLikeEnum(s.distinctValues, values)) {
      const sz = toNumberSet(values).size;
      return { tag, reason: `${s.distinctCount} distinct values, all match ${tag.replace('?', '').toUpperCase()}_VALUES (${sz} options)` };
    }
  }
  return null;
}

function summarizeRuns(positions: number[]): Array<{ start: number; end: number; len: number }> {
  const runs: Array<{ start: number; end: number; len: number }> = [];
  if (positions.length === 0) return runs;
  let start = positions[0]!;
  let prev = positions[0]!;
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i]!;
    if (p === prev + 1) {
      prev = p;
    } else {
      runs.push({ start, end: prev, len: prev - start + 1 });
      start = p;
      prev = p;
    }
  }
  runs.push({ start, end: prev, len: prev - start + 1 });
  return runs;
}

function main(): void {
  const log: string[] = [];
  const out = (s: string): void => { console.log(s); log.push(s); };

  out('AM4 preset binary — field-discovery harness');
  out('═'.repeat(76));

  // ── 1. Load corpus ────────────────────────────────────────────────
  out('\n## 1. Load corpus');
  const factoryBank = readBinary(FACTORY_BANK);
  const a01Orig = readBinary(A01_ORIG);
  const a01CleanA = readBinary(A01_CLEAN_A);
  const a01CleanB = readBinary(A01_CLEAN_B);
  const a01GainPlus1 = readBinary(A01_GAIN_PLUS_1);

  const factoryFrames = parsePresetFrames(factoryBank);
  out(`  factory bank:      ${factoryBank.length}B  →  ${factoryFrames.length} preset frames`);
  out(`  A01 original:      ${a01Orig.length}B`);
  out(`  A01 clean-a:       ${a01CleanA.length}B`);
  out(`  A01 clean-b:       ${a01CleanB.length}B`);
  out(`  A01 gain +1:       ${a01GainPlus1.length}B`);

  if (a01Orig.length !== AM4_PRESET_FRAME_SIZE) {
    out(`  WARN: A01 capture is ${a01Orig.length}B, expected ${AM4_PRESET_FRAME_SIZE} — first preset slice will be used`);
  }
  const a01OrigFrame = a01Orig.subarray(0, AM4_PRESET_FRAME_SIZE);
  const a01CleanAFrame = a01CleanA.subarray(0, AM4_PRESET_FRAME_SIZE);
  const a01CleanBFrame = a01CleanB.subarray(0, AM4_PRESET_FRAME_SIZE);
  const a01GainPlus1Frame = a01GainPlus1.subarray(0, AM4_PRESET_FRAME_SIZE);

  // Decode names so the analysis is grounded.
  const a01OrigName = decodeAm4PresetNameFromFrame(a01OrigFrame);
  const a01GainName = decodeAm4PresetNameFromFrame(a01GainPlus1Frame);
  out(`  A01 original name: "${a01OrigName}"`);
  out(`  A01 gain+1 name:   "${a01GainName}"`);

  // ── 2. Determinism mask ─────────────────────────────────────────────
  out('\n## 2. Determinism mask (orig / clean-a / clean-b stability)');
  const determinism = buildDeterminismMask([a01OrigFrame, a01CleanAFrame, a01CleanBFrame]);
  const stableCount = determinism.filter((b) => b).length;
  const unstableCount = determinism.length - stableCount;
  out(`  stable positions:   ${stableCount} / ${determinism.length}  (${(100 * stableCount / determinism.length).toFixed(2)}%)`);
  out(`  noise positions:    ${unstableCount}  (${(100 * unstableCount / determinism.length).toFixed(2)}%)`);

  // Summarize stable runs (≥ 16 contiguous stable bytes).
  const stablePositions: number[] = [];
  for (let i = 0; i < determinism.length; i++) {
    if (determinism[i]) stablePositions.push(i);
  }
  const stableRuns = summarizeRuns(stablePositions).filter((r) => r.len >= 16);
  out(`  large stable runs (≥16B):  ${stableRuns.length}`);
  for (const r of stableRuns.slice(0, 8)) {
    out(`    ${hex(r.start, 4)}..${hex(r.end, 4)}  len ${r.len}`);
  }
  if (stableRuns.length > 8) out(`    … and ${stableRuns.length - 8} more`);

  // ── 3. Param-value localization (A01 orig vs A01 gain+1) ────────────
  out('\n## 3. amp.gain byte localization (orig vs gain+1)');
  const gainDiff = diffSources([a01OrigFrame, a01GainPlus1Frame]);
  out(`  total differing bytes (any region): ${gainDiff.length}`);

  const gainDiffStable = gainDiff.filter((d) => determinism[d.position]);
  out(`  differing bytes inside determinism mask: ${gainDiffStable.length}`);

  // 3b. Unpack each chunk-1 payload via 8-to-7 sliding-window and diff
  //     in raw (unpacked) space. Chunk payload = 3074 wire bytes →
  //     2689 raw bytes (384 full 8→7 chunks + 2-byte trailer for 1
  //     raw byte). If the chunk content is packed-but-not-scrambled,
  //     a +1 amp.gain should localize to a contiguous handful of
  //     raw-space positions instead of the 343-byte raw-wire blow-up.
  out('\n## 3b. amp.gain diff in 8-to-7 UNPACKED chunk-payload space');
  try {
    const a01OrigParsed = parsePresetDump(a01OrigFrame);
    const a01GainParsed = parsePresetDump(a01GainPlus1Frame);
    const rawChunkLen = Math.floor(CHUNK_PAYLOAD_LEN * 7 / 8);
    out(`  chunk_payload_wire=${CHUNK_PAYLOAD_LEN}B  →  unpacked raw=${rawChunkLen}B per chunk`);
    let cumulativeRawDiff = 0;
    for (let ci = 0; ci < CHUNKS_PER_PRESET; ci++) {
      const aWire = a01OrigParsed.chunkPayloads[ci]!;
      const bWire = a01GainParsed.chunkPayloads[ci]!;
      // Determine wire-source identity first — if entire chunk
      // payloads are byte-identical, raw will also be identical;
      // skip the unpack cost.
      let wireDiff = 0;
      for (let i = 0; i < aWire.length; i++) if (aWire[i] !== bWire[i]) wireDiff++;
      const aRaw = unpackValueChunked(aWire, rawChunkLen);
      const bRaw = unpackValueChunked(bWire, rawChunkLen);
      const rawDiffPositions: number[] = [];
      for (let i = 0; i < rawChunkLen; i++) if (aRaw[i] !== bRaw[i]) rawDiffPositions.push(i);
      cumulativeRawDiff += rawDiffPositions.length;
      out(
        `  chunk ${ci + 1}/${CHUNKS_PER_PRESET}:  wire-diff=${wireDiff.toString().padStart(4)}B  ` +
          `raw-diff=${rawDiffPositions.length.toString().padStart(4)}B`,
      );
      if (rawDiffPositions.length > 0 && rawDiffPositions.length <= 24) {
        const runs = summarizeRuns(rawDiffPositions);
        for (const r of runs) {
          const slice = rawDiffPositions
            .filter((p) => p >= r.start && p <= r.end)
            .map((p) => `${hex(p, 4)}: ${hex(aRaw[p]!)}→${hex(bRaw[p]!)}`);
          out(`      raw-run ${hex(r.start, 4)}..${hex(r.end, 4)} (${r.len}B): ${slice.join(', ')}`);
        }
      }
    }
    out(`  TOTAL raw-space differing bytes: ${cumulativeRawDiff}`);
    if (cumulativeRawDiff < gainDiffStable.length) {
      out(
        `  ✓ unpack reduces diff from ${gainDiffStable.length} wire bytes → ${cumulativeRawDiff} raw bytes ` +
          `(${((1 - cumulativeRawDiff / gainDiffStable.length) * 100).toFixed(1)}% reduction)`,
      );
    } else {
      out(`  ✗ unpack did NOT reduce diff (raw ≥ wire) — chunks are not 8-to-7 packed in this form`);
    }
  } catch (err) {
    out(`  unpack failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (gainDiffStable.length === 0) {
    out('  No deterministic differences — gain change byte may sit in noise region');
    out('  (unexpected; would need a fresh paired capture). Skipping byte report.');
  } else {
    out(`\n  position  orig → gain+1   delta`);
    for (const d of gainDiffStable.slice(0, 24)) {
      out(`  ${hex(d.position, 4)}      ${hex(d.values[0]!)} → ${hex(d.values[1]!)}   ${d.delta! > 0 ? '+' : ''}${d.delta}`);
    }
    if (gainDiffStable.length > 24) out(`  … and ${gainDiffStable.length - 24} more`);

    // Cluster diff positions into contiguous runs — gain encoding is
    // likely a contiguous 3-4 byte field (matching the name encoding
    // pattern: 3 wire bytes per data unit).
    const runs = summarizeRuns(gainDiffStable.map((d) => d.position));
    out(`\n  contiguous diff runs in mask: ${runs.length}`);
    for (const r of runs) {
      const bytes = gainDiffStable
        .filter((d) => d.position >= r.start && d.position <= r.end)
        .map((d) => `${hex(d.values[0]!)}→${hex(d.values[1]!)}`)
        .join('  ');
      out(`    ${hex(r.start, 4)}..${hex(r.end, 4)}  len ${r.len}  ${bytes}`);
    }
  }

  // ── 4. Factory-bank cardinality across the determinism mask ─────────
  out('\n## 4. Block-layout candidates (factory bank, deterministic positions only)');
  const stats = computeFactoryStats(factoryFrames, determinism);
  out(`  positions varying across 104 factory presets (in mask): ${stats.length}`);

  // Low-cardinality positions: candidates for block-type / amp-type slots.
  const lowCardinality = stats.filter((s) => s.distinctCount >= 2 && s.distinctCount <= 40);
  out(`  candidates with cardinality 2..40 (slot occupancy / type enums): ${lowCardinality.length}`);

  // Classify by matching known enums.
  const classified: Array<FactoryStats & { tag: string; reason: string }> = [];
  for (const s of lowCardinality) {
    const c = classifyPosition(s);
    if (c) classified.push({ ...s, tag: c.tag, reason: c.reason });
  }
  out(`  positions matching a known enum: ${classified.length}`);
  out(`\n  position  card  tag                 reason`);
  for (const c of classified.slice(0, 32)) {
    out(`  ${hex(c.position, 4)}      ${c.distinctCount.toString().padStart(3)}   ${c.tag.padEnd(18)}  ${c.reason}`);
  }
  if (classified.length > 32) out(`  … and ${classified.length - 32} more`);

  // Run-detection on classified positions.
  out(`\n  contiguous runs of enum-matching positions (likely multi-byte fields):`);
  const classifiedByTag = new Map<string, number[]>();
  for (const c of classified) {
    const list = classifiedByTag.get(c.tag) ?? [];
    list.push(c.position);
    classifiedByTag.set(c.tag, list);
  }
  for (const [tag, positions] of classifiedByTag) {
    const runs = summarizeRuns(positions);
    out(`    ${tag}: ${runs.length} run(s) — ${runs.map((r) => `${hex(r.start, 4)}..${hex(r.end, 4)} (${r.len}B)`).join(', ')}`);
  }

  // ── 5. Cross-check: does the AM4 chunk-1 region (0x00..0x83) hold     ────
  //      the block-layout block? BK-036 identified `0x001e..0x0083` as a
  //      102B stable region within chunk 1; the name takes 0x21..0x50.
  //      Bytes 0x00..0x20 are envelope/header; 0x51..0x83 should hold
  //      structural fields.
  out('\n## 5. Structural-field candidates in chunk-1 stable region (0x51..0x83)');
  const structRegionStart = 0x51;
  const structRegionEnd = 0x83;
  const structPositions = classified.filter(
    (c) => c.position >= structRegionStart && c.position <= structRegionEnd,
  );
  out(`  enum-matching positions in 0x51..0x83: ${structPositions.length}`);
  for (const c of structPositions) {
    out(
      `    ${hex(c.position, 4)}  card=${c.distinctCount.toString().padStart(3)}  ${c.tag.padEnd(18)}  histogram top: ` +
        c.histogramTopN.slice(0, 3).map((h) => `${hex(h.value)}×${h.count}`).join(', '),
    );
  }

  // Also dump the raw structural region of A01 for cross-reference.
  out(`\n  A01-original structural region bytes:`);
  for (let row = structRegionStart; row <= structRegionEnd; row += 16) {
    const slice = Array.from(a01OrigFrame.subarray(row, Math.min(row + 16, structRegionEnd + 1)));
    out(`    +${hex(row, 4)}: ${slice.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }

  // ── 6. Scene-state candidate detection ──────────────────────────────
  //      AM4 has 4 scenes per preset. Per-scene state (bypass + active
  //      channel per slot) should appear as a 4× repeating sub-structure
  //      at a fixed stride. Look for low-cardinality positions whose
  //      neighbors at +stride, +2*stride, +3*stride have similar
  //      cardinality (indicating periodic structure).
  out('\n## 6. Periodic-structure candidates (scene-state)');
  const scenePositions = lowCardinality.map((s) => s.position);
  const sceneCandidates: Array<{ start: number; stride: number; positions: number[] }> = [];
  // Probe a range of plausible strides: 2..64 bytes per scene's slice.
  for (const stride of [4, 6, 8, 12, 16, 20, 24, 32]) {
    const set = new Set(scenePositions);
    for (const p of scenePositions) {
      if (set.has(p + stride) && set.has(p + 2 * stride) && set.has(p + 3 * stride)) {
        sceneCandidates.push({ start: p, stride, positions: [p, p + stride, p + 2 * stride, p + 3 * stride] });
      }
    }
  }
  // Dedupe and sort
  const seen = new Set<string>();
  const sceneFiltered = sceneCandidates.filter((c) => {
    const k = `${c.start}-${c.stride}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out(`  candidate 4×-periodic positions: ${sceneFiltered.length}`);
  for (const c of sceneFiltered.slice(0, 16)) {
    out(`    start=${hex(c.start, 4)}  stride=${c.stride}  positions: ${c.positions.map((p) => hex(p, 4)).join(', ')}`);
  }

  // ── 7. Save findings ────────────────────────────────────────────────
  const jsonSummary = {
    generated_at: new Date().toISOString(),
    corpus: {
      factory_bank: FACTORY_BANK,
      factory_preset_count: factoryFrames.length,
      paired_captures: [A01_ORIG, A01_CLEAN_A, A01_CLEAN_B, A01_GAIN_PLUS_1],
    },
    determinism_mask: {
      stable_positions: stableCount,
      noise_positions: unstableCount,
      large_stable_runs: stableRuns.slice(0, 16),
    },
    gain_diff: {
      total_differences: gainDiff.length,
      differences_in_mask: gainDiffStable.length,
      diff_positions: gainDiffStable.map((d) => ({
        position: d.position,
        position_hex: hex(d.position, 4),
        orig: d.values[0],
        gain_plus_1: d.values[1],
        delta: d.delta,
      })),
    },
    block_layout_candidates: classified.map((c) => ({
      position: c.position,
      position_hex: hex(c.position, 4),
      cardinality: c.distinctCount,
      tag: c.tag,
      reason: c.reason,
      histogram_top: c.histogramTopN,
    })),
    scene_periodic_candidates: sceneFiltered.slice(0, 64),
  };
  const jsonPath = path.resolve('samples/captured/am4-binary-decode-2026-05-21.json');
  writeFileSync(jsonPath, JSON.stringify(jsonSummary, null, 2));
  out(`\nWrote JSON  → ${jsonPath}`);

  const mdPath = path.resolve('samples/captured/am4-binary-decode-2026-05-21.md');
  const md = [
    '# AM4 preset binary — field-discovery findings',
    '',
    `Generated ${new Date().toISOString()} by \`scripts/_research/decode-am4-preset-binary.ts\`.`,
    'Builds on BK-036 (name-field decode) using the same paired-capture',
    'methodology to localize structural fields in the 12,352-byte AM4',
    'preset frame.',
    '',
    '```',
    log.join('\n'),
    '```',
    '',
  ].join('\n');
  writeFileSync(mdPath, md);
  out(`Wrote Markdown → ${mdPath}`);
}

main();
