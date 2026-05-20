/**
 * Read the raw Ghidra opcode dump produced by
 * scripts/ghidra/DumpAxeEditIIOpcodeTable.java and emit the
 * wire-byte → opcode-name table (with the `wire = enum - 1` offset
 * applied uniformly).
 *
 * Source:  samples/captured/decoded/ghidra-axeedit2-opcode-map.txt
 * Stdout:  Markdown table sorted by wire byte.
 *
 * Run:
 *   npx tsx scripts/_research/axeedit2-opcode-map.ts
 *
 * Why this exists: an earlier manual transcription of the Ghidra dump
 * into axeedit-opcode-table.md got the offset wrong on several rows.
 * Generating the table programmatically catches that class of error.
 */

import { readFileSync } from 'node:fs';

const SOURCE =
  'samples/captured/decoded/ghidra-axeedit2-opcode-map.txt';

interface Entry {
  readonly enumByte: number;
  readonly wireByte: number;
  readonly name: string;
}

function parseDump(text: string): Entry[] {
  const entries: Entry[] = [];
  // Lines look like `  0x01  SYSEX_WHO_AM_I` — two-space indent, then
  // hex byte, then opcode name.
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(0x[0-9A-Fa-f]+)\s+(SYSEX_[A-Z_0-9]+)\s*$/.exec(line);
    if (!m) continue;
    const enumByte = parseInt(m[1], 16);
    const name = m[2];
    entries.push({ enumByte, wireByte: enumByte - 1, name });
  }
  return entries.sort((a, b) => a.wireByte - b.wireByte);
}

const text = readFileSync(SOURCE, 'utf8');
const entries = parseDump(text);

console.log('## Wire-byte → opcode-name map (offset applied)');
console.log('');
console.log('| Wire | AxeEdit enum | Opcode name |');
console.log('|------|--------------|-------------|');
for (const e of entries) {
  const wireHex = '0x' + e.wireByte.toString(16).padStart(2, '0').toUpperCase();
  const enumHex = '0x' + e.enumByte.toString(16).padStart(2, '0').toUpperCase();
  console.log(`| \`${wireHex}\` | ${enumHex} | \`${e.name}\` |`);
}

// Also emit a quick TypeScript-enum-style block for codec import.
console.log('');
console.log('## TypeScript enum (for fractal-midi/src/axe-fx-ii/opcodes.ts)');
console.log('');
console.log('```typescript');
console.log('// Generated from samples/captured/decoded/ghidra-axeedit2-opcode-map.txt');
console.log('// via scripts/_research/axeedit2-opcode-map.ts (Session 103).');
console.log('// DO NOT edit by hand — regenerate from the Ghidra dump.');
console.log('export const AXE_FX_II_OPCODES = {');
for (const e of entries) {
  const wireHex = '0x' + e.wireByte.toString(16).padStart(2, '0');
  // Strip the SYSEX_ prefix for cleaner names.
  const enumName = e.name.replace(/^SYSEX_/, '');
  console.log(`  ${enumName}: ${wireHex},`);
}
console.log('} as const;');
console.log('');
console.log('export type AxeFxIIOpcode = keyof typeof AXE_FX_II_OPCODES;');
console.log('```');
console.log('');
console.log(`Total: ${entries.length} opcodes.`);
