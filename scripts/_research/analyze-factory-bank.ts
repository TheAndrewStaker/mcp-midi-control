/**
 * Walk an Axe-Fx III factory preset bank file and surface structural
 * statistics across all presets in the bank.
 *
 * A single bank file is N presets × 49,336 bytes each, where each
 * preset is the 18-frame envelope (1× 0x77 + 16× 0x78 + 1× 0x79)
 * documented in `docs/devices/axe-fx-iii/preset-format-research.md`. For the
 * v28.06 banks: each single-bank file holds exactly 128 presets
 * (128 × 49,336 = 6,315,008 bytes); the ALL-BANKS file holds 384.
 *
 * What this script answers:
 *   1. Does every preset in the bank match the 18-frame envelope?
 *   2. What does the 0x77 "preset header" payload look like across
 *      presets — uniform, or varying? (Community RE characterized it
 *      as a "preset revision number" that evolves only when needed.)
 *   3. What's in the 0x79 footer (11 bytes)? Constant or per-preset?
 *   4. How "full" is each preset (non-zero-byte count in body) — a
 *      proxy for preset complexity vs. empty/initial-state factory
 *      slots.
 *   5. What's in the first 64 bytes of each preset's body frame 0
 *      (where community RE pegged the preset name region)?
 *
 * Run:
 *   # Default: the v28.06 ALL-BANKS file
 *   npx tsx scripts/_research/analyze-factory-bank.ts
 *
 *   # Or a specific bank:
 *   npx tsx scripts/_research/analyze-factory-bank.ts \
 *     samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_A-250603-182903.syx
 */

import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { argv } from 'node:process';

const ROOT = resolve(import.meta.dirname ?? __dirname, '../..');
const DEFAULT_BANK = resolve(
  ROOT,
  'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06',
  'Axe-Fx_III_ALL-BANKS-250603-182903.syx',
);

// ── Frame walker (copied from analyze-splawnlane.ts; kept inline so
// each research script stays self-contained) ────────────────────────

interface Frame {
  index: number;
  start: number;
  length: number;
  model: number;
  fn: number;
}

function walkFrames(bytes: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xf0) {
      i += 1;
      continue;
    }
    const start = i;
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== 0xf7) j += 1;
    if (j >= bytes.length) break;
    const length = j - start + 1;
    if (length < 7
      || bytes[start + 1] !== 0x00
      || bytes[start + 2] !== 0x01
      || bytes[start + 3] !== 0x74) {
      i = j + 1;
      continue;
    }
    frames.push({
      index: frames.length,
      start,
      length,
      model: bytes[start + 4],
      fn: bytes[start + 5],
    });
    i = j + 1;
  }
  return frames;
}

function hex(bytes: Uint8Array | number[], max = 32): string {
  const arr = Array.from(bytes).slice(0, max);
  const more = bytes.length > max ? '…' : '';
  return arr.map((b) => b.toString(16).padStart(2, '0')).join(' ') + more;
}

// ── Preset grouping ────────────────────────────────────────────────

interface Preset {
  /** 0-based index within the bank file. */
  index: number;
  /** Frame indices [first, last] inclusive in the bank's frame list. */
  firstFrame: number;
  lastFrame: number;
  /** Byte offsets [start, end) in the source file. */
  byteStart: number;
  byteEnd: number;
  /** All frames belonging to this preset. */
  frames: Frame[];
  /** Quick reference to the 0x77 header frame. */
  header: Frame;
  /** Quick reference to the 0x79 footer frame. */
  footer: Frame | undefined;
  /** All 0x78 body frames in order. */
  bodies: Frame[];
}

function groupFramesIntoPresets(frames: Frame[]): Preset[] {
  const presets: Preset[] = [];
  let i = 0;
  while (i < frames.length) {
    if (frames[i].fn !== 0x77) {
      i += 1;
      continue;
    }
    const header = frames[i];
    const bodies: Frame[] = [];
    let j = i + 1;
    while (j < frames.length && frames[j].fn === 0x78) {
      bodies.push(frames[j]);
      j += 1;
    }
    let footer: Frame | undefined;
    if (j < frames.length && frames[j].fn === 0x79) {
      footer = frames[j];
      j += 1;
    }
    const lastFrame = (footer ?? bodies[bodies.length - 1] ?? header).index;
    const byteEnd =
      (footer ?? bodies[bodies.length - 1] ?? header).start
      + (footer ?? bodies[bodies.length - 1] ?? header).length;
    presets.push({
      index: presets.length,
      firstFrame: header.index,
      lastFrame,
      byteStart: header.start,
      byteEnd,
      frames: frames.slice(i, j),
      header,
      footer,
      bodies,
    });
    i = j;
  }
  return presets;
}

// ── Per-preset metrics ─────────────────────────────────────────────

interface PresetMetrics {
  /** Bytes that aren't 0x00 in the bodies' payloads (excluding envelope). */
  nonZeroBodyBytes: number;
  /** First body frame's payload, first 64 bytes (where the name lives). */
  bodyHead: Uint8Array;
  /** 0x77 header payload bytes (between fn and checksum). */
  headerPayload: Uint8Array;
  /** 0x79 footer payload bytes. */
  footerPayload: Uint8Array;
  /** Last 16 payload bytes of body frame 0 (looking for end-of-name padding). */
  bodyTail: Uint8Array;
}

function computeMetrics(bytes: Uint8Array, p: Preset): PresetMetrics {
  let nonZero = 0;
  for (const body of p.bodies) {
    // Payload is bytes [start+6 .. start+length-2): skip F0 00 01 74 10 78
    // prefix and checksum + F7 suffix.
    const from = body.start + 6;
    const to = body.start + body.length - 2;
    for (let k = from; k < to; k += 1) {
      if (bytes[k] !== 0x00) nonZero += 1;
    }
  }

  const headerPayload = bytes.slice(
    p.header.start + 6,
    p.header.start + p.header.length - 2,
  );
  const footerPayload = p.footer
    ? bytes.slice(p.footer.start + 6, p.footer.start + p.footer.length - 2)
    : new Uint8Array();
  const body0 = p.bodies[0];
  const bodyHead = body0
    ? bytes.slice(body0.start + 6, body0.start + 6 + 64)
    : new Uint8Array();
  const bodyTail = body0
    ? bytes.slice(body0.start + body0.length - 18, body0.start + body0.length - 2)
    : new Uint8Array();
  return { nonZeroBodyBytes: nonZero, bodyHead, headerPayload, footerPayload, bodyTail };
}

// ── Bank-level diffs: find byte positions that vary vs. constant ──

/**
 * For each byte offset in the "body 0 head" window, count how many
 * distinct values appear across all presets. Offsets with 1 distinct
 * value are structurally constant; offsets with many are data.
 */
function bodyHeadVariability(metrics: PresetMetrics[]): number[] {
  const windowSize = metrics[0]?.bodyHead.length ?? 0;
  const distinctPerOffset: number[] = [];
  for (let off = 0; off < windowSize; off += 1) {
    const values = new Set<number>();
    for (const m of metrics) {
      if (off < m.bodyHead.length) values.add(m.bodyHead[off]);
    }
    distinctPerOffset.push(values.size);
  }
  return distinctPerOffset;
}

// ── Reporting ──────────────────────────────────────────────────────

function describePayloadFamily(
  label: string,
  payloads: Uint8Array[],
): string {
  // How many distinct payloads exist?
  const distinct = new Map<string, number>();
  for (const p of payloads) {
    const key = Array.from(p).map((b) => b.toString(16).padStart(2, '0')).join('');
    distinct.set(key, (distinct.get(key) ?? 0) + 1);
  }
  const total = payloads.length;
  if (distinct.size === 1) {
    const [key] = distinct.keys();
    return `${label}: ALL ${total} presets share one value (${key.match(/.{2}/g)?.join(' ') ?? key})`;
  }
  const sorted = [...distinct.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [`${label}: ${distinct.size} distinct values across ${total} presets`];
  for (const [key, count] of sorted.slice(0, 5)) {
    const pct = ((count / total) * 100).toFixed(1);
    const formatted = key.match(/.{2}/g)?.join(' ') ?? key;
    lines.push(`    ${count.toString().padStart(4)} (${pct.padStart(5)}%)  ${formatted}`);
  }
  if (distinct.size > 5) {
    lines.push(`    … and ${distinct.size - 5} more`);
  }
  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────

const bankPath = argv[2] ? resolve(argv[2]) : DEFAULT_BANK;
const bankName = basename(bankPath);

console.log(`Analyzing factory bank: ${bankName}`);
console.log(`Source path: ${bankPath}\n`);

const bytes = readFileSync(bankPath);
const u8 = new Uint8Array(bytes);
console.log(`File size: ${bytes.byteLength.toLocaleString()} bytes`);

const frames = walkFrames(u8);
console.log(`Frames:    ${frames.length}`);

const presets = groupFramesIntoPresets(frames);
console.log(`Presets:   ${presets.length}\n`);

// ── Structural validation ─────────────────────────────────────────

console.log('Structural validation:');
let structureOk = true;
for (const p of presets) {
  if (p.bodies.length !== 16 || !p.footer || p.header.length !== 13) {
    console.log(
      `  ✗ preset ${p.index}: ${p.bodies.length} bodies, footer=${Boolean(p.footer)}, header_len=${p.header.length}`,
    );
    structureOk = false;
  }
}
if (structureOk) {
  console.log(`  ✓ all ${presets.length} presets match the 1× 0x77 + 16× 0x78 + 1× 0x79 envelope`);
}
const allFractalIII = frames.every((f) => f.model === 0x10);
console.log(`  ${allFractalIII ? '✓' : '✗'} every frame has model byte 0x10 (Axe-Fx III)`);

// Bank-size arithmetic.
const expectedSingleBank = 6_315_008;
const expectedAllBanks = expectedSingleBank * 3;
const presetSize = 13 + 16 * 3082 + 11;
console.log(
  `  preset envelope size: ${presetSize.toLocaleString()} bytes (expected 49,336) — ${presetSize === 49336 ? '✓' : '✗'}`,
);
console.log(
  `  bank file vs. presets × 49,336:`,
  `${bytes.byteLength.toLocaleString()} vs. ${(presets.length * presetSize).toLocaleString()}`,
  bytes.byteLength === presets.length * presetSize ? '✓ exact' : `(delta ${bytes.byteLength - presets.length * presetSize})`,
);

// ── Per-preset metrics ────────────────────────────────────────────

const metrics = presets.map((p) => computeMetrics(u8, p));

const nonZeroValues = metrics.map((m) => m.nonZeroBodyBytes);
const sortedNonZero = [...nonZeroValues].sort((a, b) => a - b);
const totalBodyBytes = 16 * (3082 - 8); // 16 bodies × 3074 payload bytes
console.log('\nBody fill (non-zero bytes per preset, out of total payload bytes):');
console.log(`  total body payload per preset: ${totalBodyBytes.toLocaleString()} bytes`);
console.log(`  min:    ${sortedNonZero[0]} (${((sortedNonZero[0] / totalBodyBytes) * 100).toFixed(1)}%)`);
console.log(`  median: ${sortedNonZero[Math.floor(sortedNonZero.length / 2)]} (${((sortedNonZero[Math.floor(sortedNonZero.length / 2)] / totalBodyBytes) * 100).toFixed(1)}%)`);
console.log(`  max:    ${sortedNonZero[sortedNonZero.length - 1]} (${((sortedNonZero[sortedNonZero.length - 1] / totalBodyBytes) * 100).toFixed(1)}%)`);

// ── Header revision distribution ──────────────────────────────────

const headerLen = metrics[0]?.headerPayload.length ?? 0;
console.log('\n' + describePayloadFamily(
  `0x77 header payload (${headerLen} bytes — destination preset slot per the all-banks pattern)`,
  metrics.map((m) => m.headerPayload),
));

// ── Footer distribution ───────────────────────────────────────────

const footerLen = metrics[0]?.footerPayload.length ?? 0;
console.log('\n' + describePayloadFamily(
  `0x79 footer payload (${footerLen} bytes — varies per preset, likely a checksum)`,
  metrics.map((m) => m.footerPayload),
));

// ── Body-head variability ─────────────────────────────────────────

const bodyVar = bodyHeadVariability(metrics);
console.log('\nFirst-64-bytes-of-body-0 variability (distinct values per offset):');
const totalPresets = presets.length;
let constantCount = 0;
let nearConstantCount = 0;
let highVarCount = 0;
for (const v of bodyVar) {
  if (v === 1) constantCount += 1;
  else if (v <= 3) nearConstantCount += 1;
  else highVarCount += 1;
}
console.log(`  constant (1 unique value):           ${constantCount.toString().padStart(3)} of 64 offsets`);
console.log(`  near-constant (2-3 unique values):   ${nearConstantCount.toString().padStart(3)} of 64 offsets`);
console.log(`  variable (4+ unique values):         ${highVarCount.toString().padStart(3)} of 64 offsets`);

console.log('\n  offset | distinct | first preset bytes (hex)');
console.log('  -------|----------|--------------------------------');
for (let off = 0; off < bodyVar.length; off += 1) {
  const sample = metrics[0].bodyHead[off];
  const distinct = bodyVar[off];
  const flag = distinct === 1 ? 'const' : distinct <= 3 ? 'near ' : '     ';
  console.log(`  ${off.toString().padStart(5)}  |    ${distinct.toString().padStart(3)}    ${flag} | ${sample.toString(16).padStart(2, '0')}`);
}

// ── Sample first 8 presets in detail ──────────────────────────────

console.log('\nFirst 8 presets (header / footer / body-head / body-tail):');
for (const p of presets.slice(0, 8)) {
  const m = metrics[p.index];
  console.log(`\n  Preset ${p.index} (bytes ${p.byteStart}-${p.byteEnd}):`);
  console.log(`    header payload: ${hex(m.headerPayload)}`);
  console.log(`    footer payload: ${hex(m.footerPayload)}`);
  console.log(`    body[0] head:   ${hex(m.bodyHead)}`);
  console.log(`    body[0] tail:   ${hex(m.bodyTail)}`);
  console.log(`    non-zero body bytes: ${m.nonZeroBodyBytes.toLocaleString()} (${((m.nonZeroBodyBytes / totalBodyBytes) * 100).toFixed(1)}%)`);
}

console.log('\nDone.');
console.log('\nNext-phase questions to chase:');
console.log('  - body[0] head includes the preset name (community RE places it');
console.log('    in the first 128 bytes of the body payload). Names for factory');
console.log('    presets are listed in the v28.06 release notes — we can pair-');
console.log('    match raw bytes ↔ known names to decode the encoding.');
console.log('  - Compare body fill (non-zero %) against AxeEdit\'s "amount of stuff');
console.log('    in this preset" — bands of presets with similar complexity should');
console.log('    cluster together.');
console.log('  - 0x77 header revision: if it varies across the bank, it\'s per-');
console.log('    preset metadata; if uniform, it\'s per-firmware metadata.');
