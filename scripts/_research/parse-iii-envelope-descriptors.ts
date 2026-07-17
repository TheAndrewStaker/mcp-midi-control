/**
 * parse-iii-envelope-descriptors.ts
 *
 * Ports the Axe-Fx III preset-binary envelope-spec descriptor tables out of
 * the Ghidra decompile dump produced by DumpAxeEditIIIDumpDescriptors.java.
 *
 * Input:  packages/fractal-midi/samples/captured/decoded/
 *           ghidra-axe-edit-iii-dump-descriptors.txt
 * Output: samples/captured/decoded/iii-envelope-descriptors.json
 *
 * Extracts, with dump line numbers as evidence:
 *  1. Every descriptor table section ("## Descriptor table @ 0x...") as an
 *     ordered list of (tag, mid, byte_count) records up to the (-1,-1,-1)
 *     sentinel. Same record shape as the II envelope spec at 0xe04440 /
 *     0xdff900 (BK-070).
 *  2. Every emitter section ("## EMITTER FUN_... @ 0x...") with:
 *     - the fn byte(s) it emits, from FUN_1403437d0(param_1, 0xNN, ...) calls
 *     - every &DAT_1407a... descriptor-table reference
 *     - the model-byte dispatch when it matches the canonical reassignment
 *       pattern:  pV = &DAT_AAAA;  if (DAT_1412633f8 < 0x10) pV = &DAT_BBBB;
 *       (DAT_1412633f8 is the connected device's model byte; >= 0x10 = gen-3)
 *
 * Run: npx tsx scripts/_research/parse-iii-envelope-descriptors.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const DUMP = path.join(
  repoRoot,
  'packages', 'fractal-midi', 'samples', 'captured', 'decoded',
  'ghidra-axe-edit-iii-dump-descriptors.txt',
);
const OUT_DIR = path.join(repoRoot, 'samples', 'captured', 'decoded');
const OUT = path.join(OUT_DIR, 'iii-envelope-descriptors.json');
// Prior extraction by parse-ghidra-decompile.ts; used as a cross-check oracle.
const PRIOR_JSON = path.join(
  repoRoot,
  'packages', 'fractal-midi', 'samples', 'captured', 'decoded',
  'ghidra-axe-edit-iii-dump-descriptors.descriptors.json',
);

interface DescriptorEntry {
  idx: number;
  tag: number;
  mid: number;
  byte_count: number;
  dump_line: number; // 1-based line in the dump file
}

interface DescriptorTable {
  address: string;
  header_dump_line: number;
  entries: DescriptorEntry[];
  sentinel_dump_line?: number;
}

interface TableRef {
  address: string;
  dump_line: number;
}

interface EmitterInfo {
  function: string;
  address: string;
  header_dump_line: number;
  /** fn bytes passed to the shared frame-emit helper FUN_1403437d0 */
  emits: { fn_byte: string; dump_line: number }[];
  table_refs: TableRef[];
  /** present when the canonical model-byte reassignment pattern matched */
  model_dispatch?: {
    gen3_table: string;       // default assignment (model byte >= 0x10)
    gen2_table: string;       // reassigned when DAT_1412633f8 < 0x10
    dump_lines: [number, number, number];
  };
}

const lines = readFileSync(DUMP, 'utf8').split(/\r?\n/);

const tables: DescriptorTable[] = [];
const emitters: EmitterInfo[] = [];

const TABLE_HDR = /^## Descriptor table @ (0x[0-9a-f]+)/;
const EMITTER_HDR = /^## EMITTER (FUN_[0-9a-f]+) @ (0x[0-9a-f]+)/;
const ROW = /^\s*(\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*(<-- SENTINEL)?\s*$/;
const EMIT_CALL = /FUN_1403437d0\(param_1,(0x[0-9a-f]+)/;
const DAT_REF = /&(DAT_1407a[0-9a-f]+)/g;
const MODEL_GUARD = /if \(DAT_1412633f8 < 0x10\)/;

let current: DescriptorTable | undefined;
let currentEmitter: EmitterInfo | undefined;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNo = i + 1;

  const th = TABLE_HDR.exec(line);
  if (th) {
    current = { address: th[1], header_dump_line: lineNo, entries: [] };
    tables.push(current);
    currentEmitter = undefined;
    continue;
  }

  const eh = EMITTER_HDR.exec(line);
  if (eh) {
    currentEmitter = {
      function: eh[1],
      address: eh[2],
      header_dump_line: lineNo,
      emits: [],
      table_refs: [],
    };
    emitters.push(currentEmitter);
    current = undefined;
    continue;
  }

  if (current) {
    const r = ROW.exec(line);
    if (r) {
      const [, idx, tag, mid, byteCount, sentinel] = r;
      if (sentinel || (tag === '-1' && mid === '-1' && byteCount === '-1')) {
        current.sentinel_dump_line = lineNo;
        current = undefined; // table complete
      } else {
        current.entries.push({
          idx: Number(idx),
          tag: Number(tag),
          mid: Number(mid),
          byte_count: Number(byteCount),
          dump_line: lineNo,
        });
      }
    }
    continue;
  }

  if (currentEmitter) {
    const em = EMIT_CALL.exec(line);
    if (em) currentEmitter.emits.push({ fn_byte: em[1], dump_line: lineNo });
    for (const m of line.matchAll(DAT_REF)) {
      const address = '0x' + m[1].slice(4); // DAT_1407abXXX -> 0x1407abXXX
      currentEmitter.table_refs.push({ address, dump_line: lineNo });
    }
    // Canonical model-byte dispatch pattern across exactly 3 lines:
    //   pV = &DAT_AAAA;
    //   if (DAT_1412633f8 < 0x10) {
    //     pV = &DAT_BBBB;
    if (MODEL_GUARD.test(line) && i > 0 && i + 1 < lines.length) {
      const before = /&DAT_(1407a[0-9a-f]+)/.exec(lines[i - 1]);
      const after = /&DAT_(1407a[0-9a-f]+)/.exec(lines[i + 1]);
      if (before && after && !currentEmitter.model_dispatch) {
        currentEmitter.model_dispatch = {
          gen3_table: '0x' + before[1],
          gen2_table: '0x' + after[1],
          dump_lines: [lineNo - 1, lineNo, lineNo + 1],
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------
const fail = (msg: string): never => {
  console.error(`SANITY FAIL: ${msg}`);
  process.exit(1);
};

if (tables.length !== 2) fail(`expected 2 descriptor tables, got ${tables.length}`);

const byAddr = new Map(tables.map((t) => [t.address, t]));
const t440 = byAddr.get('0x1407ab440') ?? fail('table 0x1407ab440 missing');
const ta40 = byAddr.get('0x1407aba40') ?? fail('table 0x1407aba40 missing');

const expectEntries = (
  t: DescriptorTable,
  expected: [number, number, number][],
) => {
  if (t.entries.length !== expected.length) {
    fail(`${t.address}: expected ${expected.length} entries, got ${t.entries.length}`);
  }
  expected.forEach(([tag, mid, bc], i) => {
    const e = t.entries[i];
    if (e.tag !== tag || e.mid !== mid || e.byte_count !== bc) {
      fail(`${t.address}[${i}]: expected (${tag},${mid},${bc}), got (${e.tag},${e.mid},${e.byte_count})`);
    }
  });
  if (t.sentinel_dump_line === undefined) fail(`${t.address}: no sentinel found`);
};

expectEntries(t440, [[0, 6, 2], [1, 8, 768]]);
expectEntries(ta40, [[0, 6, 2], [1, 8, 192]]);

// Cross-check against the prior parse-ghidra-decompile.ts extraction, if present.
let priorAgrees: boolean | 'absent' = 'absent';
if (existsSync(PRIOR_JSON)) {
  const prior = JSON.parse(readFileSync(PRIOR_JSON, 'utf8'));
  priorAgrees = tables.every((t) => {
    const pt = prior.tables?.find((p: { address: string }) => p.address === t.address);
    return (
      pt &&
      pt.entries.length === t.entries.length &&
      pt.entries.every(
        (pe: { tag: number; mid: number; byte_count: number }, i: number) =>
          pe.tag === t.entries[i].tag &&
          pe.mid === t.entries[i].mid &&
          pe.byte_count === t.entries[i].byte_count,
      )
    );
  });
  if (!priorAgrees) fail('disagreement with prior ghidra-axe-edit-iii-dump-descriptors.descriptors.json');
}

// ---------------------------------------------------------------------------
// Emit JSON
// ---------------------------------------------------------------------------
const output = {
  source_file: path.relative(repoRoot, DUMP).replaceAll('\\', '/'),
  generated_by: 'scripts/_research/parse-iii-envelope-descriptors.ts',
  notes: [
    'tag/mid/byte_count semantics per primitive vendor-envelope-descriptor-table:',
    'tag = field order key; mid = wire-byte offset from F0; byte_count = field size',
    '(raw bytes, or units x bytes-per-unit for packed septet payloads).',
    'DAT_1412633f8 is the connected model byte; >= 0x10 selects the gen-3 table.',
  ],
  table_count: tables.length,
  tables,
  emitter_count: emitters.length,
  emitters,
  cross_check_vs_prior_extraction: priorAgrees,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------
console.log(`Parsed ${path.basename(DUMP)} (${lines.length} lines)`);
console.log(`\nDescriptor tables (${tables.length}):`);
for (const t of tables) {
  const shape = t.entries.map((e) => `(${e.tag},${e.mid},${e.byte_count})`).join(' + ');
  console.log(`  ${t.address}  ${shape}   [dump L${t.header_dump_line}..L${t.sentinel_dump_line}]`);
}
console.log(`\nEmitters (${emitters.length}):`);
for (const e of emitters) {
  const fns = e.emits.map((x) => `${x.fn_byte}@L${x.dump_line}`).join(', ') || '(no direct emit)';
  console.log(`  ${e.function} @ ${e.address}  emits: ${fns}`);
  if (e.model_dispatch) {
    console.log(
      `    model dispatch: gen-3(>=0x10) -> ${e.model_dispatch.gen3_table}, ` +
      `gen-2(<0x10) -> ${e.model_dispatch.gen2_table}  ` +
      `[L${e.model_dispatch.dump_lines.join('/L')}]`,
    );
  } else if (e.table_refs.length > 0) {
    const refs = [...new Set(e.table_refs.map((r) => `${r.address}@L${r.dump_line}`))].join(', ');
    console.log(`    table refs: ${refs}`);
  }
}
console.log(`\nCross-check vs prior extraction: ${priorAgrees}`);
console.log(`Wrote ${path.relative(repoRoot, OUT)}`);
