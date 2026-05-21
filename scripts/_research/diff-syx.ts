/**
 * mcp-midi-control — SysEx Diff Tool
 *
 * Compares two .syx files byte by byte and highlights differences.
 * Use this to reverse-engineer what changed when you modified one parameter.
 *
 * Usage:
 *   npx ts-node scripts/diff-syx.ts samples/factory/A01.syx samples/factory/A02.syx
 */

import fs from 'fs';

const [,, file1, file2] = process.argv;

if (!file1 || !file2) {
  console.error('Usage: ts-node diff-syx.ts <file1.syx> <file2.syx>');
  process.exit(1);
}

const a = Array.from(fs.readFileSync(file1));
const b = Array.from(fs.readFileSync(file2));

console.log(`File A: ${file1} (${a.length} bytes)`);
console.log(`File B: ${file2} (${b.length} bytes)\n`);

const len = Math.max(a.length, b.length);
const COLS = 16;

let diffCount = 0;
const diffs: Array<{ offset: number; a: number | undefined; b: number | undefined }> = [];

for (let i = 0; i < len; i++) {
  if (a[i] !== b[i]) {
    diffs.push({ offset: i, a: a[i], b: b[i] });
    diffCount++;
  }
}

console.log(`Differences: ${diffCount} bytes\n`);

if (diffCount === 0) {
  console.log('✅ Files are identical.');
  process.exit(0);
}

// Print diff table
console.log('Offset    A         B         Change');
console.log('─'.repeat(50));

for (const d of diffs) {
  const offset = `0x${d.offset.toString(16).padStart(4, '0').toUpperCase()}`;
  const aHex = d.a !== undefined ? `0x${d.a.toString(16).padStart(2, '0').toUpperCase()}` : '--';
  const bHex = d.b !== undefined ? `0x${d.b.toString(16).padStart(2, '0').toUpperCase()}` : '--';
  const aVal = d.a !== undefined ? d.a : 0;
  const bVal = d.b !== undefined ? d.b : 0;
  const delta = bVal - aVal;
  console.log(`${offset}    ${aHex.padEnd(8)}  ${bHex.padEnd(8)}  ${delta > 0 ? '+' : ''}${delta}`);
}

// Print hex dump of regions around diffs
console.log('\n\n=== HEX DUMP CONTEXT ===');

const printed = new Set<number>();

for (const d of diffs) {
  const start = Math.max(0, d.offset - 8);
  const end = Math.min(len, d.offset + 16);

  // Print row header once
  const rowStart = Math.floor(start / COLS) * COLS;

  for (let row = rowStart; row < end; row += COLS) {
    if (printed.has(row)) continue;
    printed.add(row);

    const addr = row.toString(16).padStart(4, '0').toUpperCase();
    const aRow = Array.from({ length: COLS }, (_, i) =>
      row + i < a.length ? a[row + i].toString(16).padStart(2, '0').toUpperCase() : '  '
    );
    const bRow = Array.from({ length: COLS }, (_, i) =>
      row + i < b.length ? b[row + i].toString(16).padStart(2, '0').toUpperCase() : '  '
    );

    // Mark changed bytes
    const markers = Array.from({ length: COLS }, (_, i) =>
      a[row + i] !== b[row + i] ? '^^' : '  '
    );

    console.log(`\n${addr}  A: ${aRow.join(' ')}`);
    console.log(`${addr}  B: ${bRow.join(' ')}`);
    console.log(`       ${markers.join(' ')}`);
  }
}
