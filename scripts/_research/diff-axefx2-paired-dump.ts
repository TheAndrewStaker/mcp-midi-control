/**
 * BK-070 — Axe-Fx II paired-dump diff helper.
 *
 * Companion to `diff-axefx2-preset-dump.ts`. Where that script does
 * variance analysis across the static factory bank, THIS script targets
 * the hardware-experiment loop: capture a preset BEFORE a change,
 * capture it AFTER, diff the two, and report which bytes encode the
 * change.
 *
 * Workflow for extracting per-scene byte offsets (the missing piece for
 * atomic apply_preset):
 *
 *   1. On hardware, dump the active preset (via Claude Desktop:
 *      "give me a SysEx dump of the current preset and save to file").
 *      Save as `samples/captured/preset-before-<experiment>.syx`.
 *   2. Make ONE change on hardware (e.g. via front panel or AxeEdit):
 *      "set scene 3 amp to channel Y, leave everything else alone".
 *   3. Dump again. Save as `samples/captured/preset-after-<experiment>.syx`.
 *   4. Run:
 *      npx tsx scripts/_research/diff-axefx2-paired-dump.ts \
 *        samples/captured/preset-before-<experiment>.syx \
 *        samples/captured/preset-after-<experiment>.syx
 *   5. The diff output identifies which bytes changed. Add the finding
 *      to `fractal-midi/docs/devices/axe-fx-ii/preset-binary-offsets.md`
 *      (TBD per BK-070 closure).
 *
 * Hardware discipline:
 *   - Change EXACTLY ONE thing between before and after. Two
 *     simultaneous edits produce ambiguous diff bytes and cost a day.
 *   - Disable AxeEdit auto-sync if it's running — auto-sync writes can
 *     race the dump and pollute the capture.
 *   - Capture during a quiet window (no incoming MIDI from a controller
 *     pedalboard, no automation).
 *
 * Output format: human-readable hex windows around each diff run.
 * Identical shape to the static-pair diff mode in
 * `diff-axefx2-preset-dump.ts` for consistency.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  CHUNKS_PER_PRESET,
  CHUNK_PAYLOAD_LEN,
  parsePresetDump,
  extractPresetName,
  type ParsedPresetDump,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

const [beforePath, afterPath, ...rest] = process.argv.slice(2);
if (beforePath === undefined || afterPath === undefined) {
  console.error('Usage:');
  console.error('  npx tsx scripts/_research/diff-axefx2-paired-dump.ts <before.syx> <after.syx>');
  console.error('');
  console.error('Both files must be single Axe-Fx II preset dumps (12,951 bytes each).');
  console.error('See file docstring for the recommended capture workflow.');
  process.exit(1);
}
if (rest.length > 0) {
  console.error(`Unexpected extra arguments: ${rest.join(' ')}`);
  process.exit(1);
}

function loadDump(path: string): ParsedPresetDump {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  const bytes = new Uint8Array(readFileSync(path));
  try {
    return parsePresetDump(bytes, 0);
  } catch (err) {
    console.error(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const before = loadDump(beforePath);
const after = loadDump(afterPath);

function flatten(p: ParsedPresetDump): Uint8Array {
  const total = p.headerPayload.length + p.chunkPayloads.length * CHUNK_PAYLOAD_LEN + p.footerPayload.length;
  const out = new Uint8Array(total);
  let cur = 0;
  out.set(p.headerPayload, cur); cur += p.headerPayload.length;
  for (const c of p.chunkPayloads) { out.set(c, cur); cur += c.length; }
  out.set(p.footerPayload, cur);
  return out;
}

const fa = flatten(before);
const fb = flatten(after);

function regionOf(offset: number): string {
  if (offset < 4) return `HEADER:${offset}`;
  const chunkOffset = offset - 4;
  if (chunkOffset < CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN) {
    const chunkIdx = Math.floor(chunkOffset / CHUNK_PAYLOAD_LEN);
    const inChunk = chunkOffset % CHUNK_PAYLOAD_LEN;
    return `CHUNK${chunkIdx.toString().padStart(2, '0')}:${inChunk.toString().padStart(3, '0')}`;
  }
  return `FOOTER:${chunkOffset - CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN}`;
}

function fmtHex(b: number): string {
  return b.toString(16).padStart(2, '0');
}

console.log(`Paired-dump diff (BK-070 hardware experiment):`);
console.log(`  before: ${beforePath} (preset name: "${extractPresetName(before)}")`);
console.log(`  after:  ${afterPath} (preset name: "${extractPresetName(after)}")`);
console.log(`  total payload bytes: ${fa.length}`);
console.log('');

if (fa.length !== fb.length) {
  console.error(`Payload lengths differ (${fa.length} vs ${fb.length}). Are both files single II preset dumps?`);
  process.exit(1);
}

// Quick sanity: header bytes 0..1 (bank + preset) often differ between
// captures even when content matches. Flag this so the user knows.
const headerDiffs: string[] = [];
for (let i = 0; i < 4; i++) {
  if (fa[i] !== fb[i]) headerDiffs.push(`offset ${i}: ${fmtHex(fa[i])} → ${fmtHex(fb[i])}`);
}
if (headerDiffs.length > 0) {
  console.log('Header differences (likely just bank/preset markers, not content):');
  for (const d of headerDiffs) console.log(`  ${d}`);
  console.log('');
}

// Body diffs — anything past the 4-byte header.
const diffs: number[] = [];
for (let i = 4; i < fa.length; i++) {
  if (fa[i] !== fb[i]) diffs.push(i);
}
console.log(`Body bytes differing: ${diffs.length} of ${fa.length - 4}`);

if (diffs.length === 0) {
  console.log('  → No content differences. Either the experiment didn\'t change anything');
  console.log('    (check hardware-side change actually committed), or the change');
  console.log('    affected ONLY the header bytes (bank/preset re-targeting).');
  process.exit(0);
}

// Coalesce adjacent diffs into runs (gap ≤ 8 bytes treated as adjacent).
const runs: { start: number; end: number }[] = [];
for (const d of diffs) {
  const last = runs[runs.length - 1];
  if (last !== undefined && d <= last.end + 8) {
    last.end = d;
  } else {
    runs.push({ start: d, end: d });
  }
}
console.log(`Coalesced runs (gap ≤ 8): ${runs.length}`);
console.log('');

console.log(`Diff runs:`);
for (const r of runs) {
  const len = r.end - r.start + 1;
  const region = regionOf(r.start);
  const aSlice = Array.from(fa.slice(r.start, r.end + 1)).map(fmtHex).join(' ');
  const bSlice = Array.from(fb.slice(r.start, r.end + 1)).map(fmtHex).join(' ');
  console.log(`  ${region} payload[${r.start}..${r.end}] (${len}B):`);
  console.log(`    before=[${aSlice}]`);
  console.log(`    after =[${bSlice}]`);
}
console.log('');

// ── NATIVE-STREAM diff (Session 115 — septet-decoded view) ──
// The wire-byte diffs above are informative but ambiguous because each
// 16-bit native ushort spans 3 wire bytes. Decoding the chunks into
// native ushorts (per BK-070 Ghidra finding) makes single-knob mutations
// pinpoint exactly one ushort or one bit within an ushort.
// Per descriptor 0xe04440: 14-bit count at payload[0..1], data at
// payload[2]. Fixed Session 115; previously read from payload[1] and
// used 7-bit count.
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

const nativeBefore: Uint16Array[] = before.chunkPayloads.map(decodeChunkNative);
const nativeAfter: Uint16Array[] = after.chunkPayloads.map(decodeChunkNative);

type NativeDiff = { chunk: number; offset: number; nativeIndex: number; before: number; after: number };
const nativeDiffs: NativeDiff[] = [];
for (let c = 0; c < nativeBefore.length; c++) {
  const a = nativeBefore[c];
  const b = nativeAfter[c];
  const lim = Math.min(a.length, b.length);
  for (let o = 0; o < lim; o++) {
    if (a[o] !== b[o]) {
      nativeDiffs.push({
        chunk: c,
        offset: o,
        nativeIndex: c * 64 + o,
        before: a[o],
        after: b[o],
      });
    }
  }
}

console.log(`Native-stream diffs (16-bit ushorts): ${nativeDiffs.length}`);
if (nativeDiffs.length === 0 && diffs.length > 0) {
  console.log('  (wire-byte diffs exist but all in chunk-header/count region — no payload ushorts changed)');
}
for (const d of nativeDiffs) {
  const xor = d.before ^ d.after;
  const popcount = ((): number => {
    let v = xor;
    let n = 0;
    while (v) { n += v & 1; v >>>= 1; }
    return n;
  })();
  const bitsList: number[] = [];
  for (let bit = 0; bit < 16; bit++) if (xor & (1 << bit)) bitsList.push(bit);
  console.log(
    `  chunk ${d.chunk.toString().padStart(2)} ushort[${d.offset.toString().padStart(2)}] ` +
      `(native idx ${d.nativeIndex.toString().padStart(4)}):  ` +
      `0x${d.before.toString(16).padStart(4, '0')} → 0x${d.after.toString(16).padStart(4, '0')}  ` +
      `xor=0x${xor.toString(16).padStart(4, '0')} ` +
      `(${popcount} bit${popcount === 1 ? '' : 's'} flipped${
        popcount > 0 && popcount <= 4 ? ' @ ' + bitsList.join(',') : ''
      })`,
  );
}
console.log('');

console.log(`Interpretation tips:`);
console.log(`  - 1-bit flip in native chunks 17-20 → strong per-scene channel/bypass`);
console.log(`    candidate. The bit position within the ushort indexes the scene`);
console.log(`    (scene 0 = bit 0, scene 1 = bit 1, etc. — to be verified).`);
console.log(`  - Multi-bit flip in one ushort → could be a packed multi-scene byte`);
console.log(`    or a 2-3 bit channel selector field.`);
console.log(`  - Native diffs in chunks 0..16 → block-id / param-value changes`);
console.log(`    (less interesting for the per-scene state hunt).`);
console.log(`  - Diffs in FOOTER → content hash; expected to change with content.`);
