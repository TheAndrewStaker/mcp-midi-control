/**
 * Byte-diff two MicroFreak preset dumps, and name the nearest ASCII label before
 * each differing byte.
 *
 * Purpose: the preset payload is a self-describing TLV carrying its parameter
 * names inline (`#VCF`, `Cutoff`, `Reso`, ...). So if two dumps differ only in
 * one parameter, the label immediately preceding the differing bytes identifies
 * which field those bytes ARE. That turns "save two presets that differ in one
 * knob" into a field-locating primitive, without guessing offsets.
 *
 * First use (2026-07-25): settle whether an incoming MIDI CC actually reaches
 * the working buffer. The MicroFreak surfaces NOTHING on its display for
 * received CC, and its knob-catch position appears not to track CC either, so
 * save-then-dump is the only readback the device offers. Save with CC 83 = 0 to
 * one slot, CC 83 = 127 to another, and diff: bytes that move under a label of
 * "Reso" prove the CC landed.
 *
 * Run: npx tsx scripts/diff-microfreak-presets.ts <slotA> <slotB>
 */
import { readFileSync } from 'node:fs';

const a = Number(process.argv[2]);
const b = Number(process.argv[3]);
const load = (slot: number): Buffer =>
  readFileSync(`samples/arturia-microfreak/dumps/preset-${String(slot).padStart(3, '0')}.bin`);

const A = load(a);
const B = load(b);
console.log(`A = slot ${a} (${A.length} bytes)`);
console.log(`B = slot ${b} (${B.length} bytes)\n`);

if (A.length !== B.length) console.log(`NOTE: lengths differ (${A.length} vs ${B.length}).\n`);

const printable = (c: number): boolean => c >= 0x20 && c <= 0x7e;

/**
 * The nearest ASCII run of >= 3 printable chars at or before `pos`. That run is
 * the field label in this format, so it answers "which parameter is this byte".
 */
function labelBefore(buf: Buffer, pos: number): string {
  for (let end = pos; end >= 0 && pos - end < 64; end--) {
    if (!printable(buf[end])) continue;
    let start = end;
    while (start > 0 && printable(buf[start - 1])) start--;
    if (end - start + 1 >= 3) return buf.toString('latin1', start, end + 1);
    end = start;
  }
  return '(no label within 64 bytes)';
}

const diffs: number[] = [];
for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) diffs.push(i);

console.log(`differing bytes: ${diffs.length}`);
if (diffs.length === 0) {
  console.log('\nIDENTICAL. The change did NOT reach the saved preset.');
  process.exit(0);
}

// Group runs of adjacent differences so one changed field reads as one entry.
const runs: Array<{ start: number; end: number }> = [];
for (const d of diffs) {
  const last = runs[runs.length - 1];
  if (last !== undefined && d - last.end <= 2) last.end = d;
  else runs.push({ start: d, end: d });
}

console.log(`grouped into ${runs.length} region(s):\n`);
for (const r of runs) {
  const hexA = A.toString('hex', r.start, r.end + 1).replace(/(..)/g, '$1 ').trim();
  const hexB = B.toString('hex', r.start, r.end + 1).replace(/(..)/g, '$1 ').trim();
  console.log(`  offset ${r.start}${r.end > r.start ? `-${r.end}` : ''}   label: "${labelBefore(A, r.start)}"`);
  console.log(`    A: ${hexA}`);
  console.log(`    B: ${hexB}`);
}
process.exit(0);
