/**
 * parse-ghidra-decompile.ts
 *
 * Universal extractor for the Ghidra decompile-dump format used by
 * `fractal-midi/scripts/ghidra/Dump*.java` outputs. Reads a .txt
 * dump file and emits structured JSON of every (tag, mid, byte_count)
 * descriptor table found inside it.
 *
 * Synthesis-pass 2026-05-22 finding: the III preset binary envelope
 * spec is byte-identical in shape to the II envelope spec; both are
 * declared as `(tag, mid, byte_count)` triples in `.rdata` and dumped
 * by the existing `Dump*Descriptors.java` Ghidra scripts. The III
 * tables at 0x1407ab440 + 0x1407aba40 + ~24 more in misc-descriptors
 * close BK-070's III equivalent without hardware.
 *
 * Cookbook primitive: vendor-envelope-descriptor-table
 * (see fractal-midi/docs/research/cookbook/vendor-envelope-descriptor-table.md)
 *
 * Format the parser recognizes (both supported):
 *
 *   FORMAT A — ## Descriptor table @ 0xADDR header followed by a
 *   pipe-separated table:
 *
 *     ## Descriptor table @ 0x1407ab440
 *     idx | tag (i32) | mid (i32) | byte_count (i32)
 *     ----+-----------+-----------+----------------
 *       0 | 0         | 6         | 2
 *       1 | 1         | 8         | 768
 *       2 | -1        | -1        | -1          <-- SENTINEL
 *
 *   FORMAT B — Table @ 0xADDR header followed by a pipe-separated
 *   table with (key, val_b, val_c) column labels (semantically the
 *   same as tag/mid/byte_count):
 *
 *     Table @ 0x1407aac70
 *       idx | key (i32) | val_b (i32) | val_c (i32)
 *       ----+-----------+-------------+------------
 *         0 | 0         | 6           | 1
 *         ...
 *
 * Optional bonus: if the file contains a "CALLER → POTENTIAL TABLE
 * REFERENCES" section (the misc-descriptors format), the parser maps
 * each function address to the descriptor tables it references. This
 * lets a downstream consumer answer "which fn-byte uses which table?"
 *
 * Usage:
 *   tsx scripts/_research/parse-ghidra-decompile.ts <input.txt>
 *   tsx scripts/_research/parse-ghidra-decompile.ts <input.txt> --json
 *   tsx scripts/_research/parse-ghidra-decompile.ts <input.txt> --out <output.json>
 *
 * Default output (no --out flag): prints a summary to stdout +
 * writes JSON to <input>.descriptors.json alongside the input.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface DescriptorEntry {
  idx: number;
  tag: number;        // also called "key" in some dumps
  mid: number;        // also called "val_b" — wire offset from F0
  byte_count: number; // also called "val_c" — bytes OR units-per-element
}

interface DescriptorTable {
  address: string;             // hex string e.g. "0x1407ab440"
  source_function?: string;    // if discoverable via caller-refs section
  entries: DescriptorEntry[];  // excludes the SENTINEL row
  source_format: 'dump-descriptors' | 'misc-descriptors';
}

interface CallerRef {
  caller_address: string;     // hex e.g. "0x140338fb0"
  table_refs: string[];       // hex addresses
}

interface ParseResult {
  source_file: string;
  table_count: number;
  caller_ref_count: number;
  tables: DescriptorTable[];
  caller_refs: CallerRef[];
}

/**
 * Parse a single pipe-separated descriptor table block. Accepts both
 * (tag, mid, byte_count) and (key, val_b, val_c) column names; the
 * row order is the same and the semantics are identical (Session
 * 116 cont, verified against the II envelope spec).
 *
 * Returns the entries up to but NOT including the SENTINEL row
 * (tag=-1, mid=-1, byte_count=-1).
 */
function parseTableBody(lines: string[], startIdx: number): { entries: DescriptorEntry[]; consumed: number } {
  const entries: DescriptorEntry[] = [];
  let i = startIdx;

  // Skip the header line(s): "idx | tag | mid | byte_count" + separator "----+-----..."
  while (i < lines.length && !lines[i].match(/^\s*\d+\s*\|/)) {
    i++;
  }

  while (i < lines.length) {
    const row = lines[i].trim();
    if (row === '' || row.startsWith('#') || row.startsWith('---')) {
      // table block ended
      break;
    }
    // Match a row like "  0 | 0 | 6 | 2" or "  2 | -1 | -1 | -1  <-- SENTINEL"
    const m = row.match(/^(\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)/);
    if (!m) break;

    const idx = parseInt(m[1], 10);
    const tag = parseInt(m[2], 10);
    const mid = parseInt(m[3], 10);
    const byte_count = parseInt(m[4], 10);

    if (tag === -1 && mid === -1 && byte_count === -1) {
      // SENTINEL row — stop, don't include
      i++;
      break;
    }

    entries.push({ idx, tag, mid, byte_count });
    i++;
  }

  return { entries, consumed: i - startIdx };
}

/**
 * Parse the "CALLER → POTENTIAL TABLE REFERENCES" section from the
 * misc-descriptors format. Each row looks like:
 *
 *   0x140338fb0  refs: [0x1407aaca0, 0x1407aaf00]
 *   0x14014d400  refs: (none)
 *
 * The section header is followed by decorator lines (`####...`) we
 * skip past. We stop when we encounter the next "##" labeled section
 * (e.g. "## DESCRIPTOR TABLE DUMPS") or a non-conforming line after
 * we've started consuming caller-ref rows.
 */
function parseCallerRefs(lines: string[], startIdx: number): { refs: CallerRef[]; consumed: number } {
  const refs: CallerRef[] = [];
  let i = startIdx;
  let sawAnyRef = false;

  while (i < lines.length) {
    const raw = lines[i];
    const row = raw.trim();

    // Skip blank lines + decorator lines (`####...`) regardless of position
    if (row === '' || /^#+$/.test(row)) {
      i++;
      continue;
    }

    // Match an actual section header line ("## SOMETHING") — this
    // marks the END of the caller-refs section.
    if (/^##\s+[A-Z]/.test(row)) {
      break;
    }

    // Match "0xADDR  refs: [...]" or "0xADDR  refs: (none)"
    const m = row.match(/^(0x[0-9a-fA-F]+)\s+refs:\s+(.+)$/);
    if (!m) {
      // If we've already started consuming refs and hit something
      // unexpected, stop. If we haven't seen any refs yet, advance —
      // we may still be in pre-data filler.
      if (sawAnyRef) break;
      i++;
      continue;
    }

    sawAnyRef = true;
    const callerAddress = m[1];
    const refList = m[2];
    let tableRefs: string[] = [];

    if (refList.startsWith('[')) {
      const inner = refList.slice(1, refList.lastIndexOf(']'));
      tableRefs = inner
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    // refs: (none) → empty array, still record the caller

    refs.push({ caller_address: callerAddress, table_refs: tableRefs });
    i++;
  }

  return { refs, consumed: i - startIdx };
}

function parseDecompile(inputPath: string): ParseResult {
  const content = fs.readFileSync(inputPath, 'utf-8');
  const lines = content.split(/\r?\n/);

  const tables: DescriptorTable[] = [];
  const caller_refs: CallerRef[] = [];
  let inCallerRefSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section transitions
    if (line.includes('CALLER → POTENTIAL TABLE REFERENCES')) {
      inCallerRefSection = true;
      continue;
    }
    if (line.includes('DESCRIPTOR TABLE DUMPS') || line.includes('## Descriptor table @')) {
      inCallerRefSection = false;
    }

    if (inCallerRefSection) {
      const { refs, consumed } = parseCallerRefs(lines, i);
      caller_refs.push(...refs);
      i += Math.max(0, consumed - 1);
      inCallerRefSection = false;
      continue;
    }

    // FORMAT A: "## Descriptor table @ 0xADDR"
    const formatA = line.match(/^##\s*Descriptor table @ (0x[0-9a-fA-F]+)/);
    if (formatA) {
      const address = formatA[1];
      const { entries, consumed } = parseTableBody(lines, i + 1);
      if (entries.length > 0) {
        tables.push({ address, entries, source_format: 'dump-descriptors' });
      }
      i += consumed;
      continue;
    }

    // FORMAT B: "Table @ 0xADDR" (misc-descriptors)
    const formatB = line.match(/^Table @ (0x[0-9a-fA-F]+)/);
    if (formatB) {
      const address = formatB[1];
      const { entries, consumed } = parseTableBody(lines, i + 1);
      if (entries.length > 0) {
        tables.push({ address, entries, source_format: 'misc-descriptors' });
      }
      i += consumed;
      continue;
    }
  }

  // Cross-link source_function on tables when caller_refs are present
  for (const table of tables) {
    const referencingCaller = caller_refs.find((r) => r.table_refs.includes(table.address));
    if (referencingCaller) {
      table.source_function = referencingCaller.caller_address;
    }
  }

  return {
    source_file: path.basename(inputPath),
    table_count: tables.length,
    caller_ref_count: caller_refs.length,
    tables,
    caller_refs,
  };
}

function printSummary(result: ParseResult): void {
  console.log(`\n=== ${result.source_file} ===`);
  console.log(`  Descriptor tables found: ${result.table_count}`);
  console.log(`  Caller refs mapped:      ${result.caller_ref_count}`);
  console.log();

  for (const table of result.tables) {
    const fnHint = table.source_function ? ` (used by FUN_${table.source_function.replace('0x', '')})` : '';
    console.log(`  Table @ ${table.address}${fnHint}`);
    console.log(`    ${table.entries.length} fields:`);
    for (const e of table.entries) {
      const unitsHint =
        e.byte_count > 100
          ? `   ← packed payload (likely ${Math.round(e.byte_count / 3)} ushorts × 3 bytes/ushort septet)`
          : '';
      console.log(`      tag=${e.tag}  wire-offset-from-F0=${e.mid}  byte_count=${e.byte_count}${unitsHint}`);
    }
    console.log();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: tsx parse-ghidra-decompile.ts <input.txt> [--json] [--out <output.json>]');
    process.exit(1);
  }

  const inputPath = args[0];
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const jsonOnly = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const outPath =
    outIdx >= 0 && args[outIdx + 1]
      ? args[outIdx + 1]
      : inputPath.replace(/\.txt$/, '.descriptors.json');

  const result = parseDecompile(inputPath);

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`JSON written to: ${outPath}`);
  }
}

main();
