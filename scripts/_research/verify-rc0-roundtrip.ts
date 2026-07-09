/**
 * Prototype validation for the RC-family `.RC0` codec (scripts/_research/rc0-codec.ts).
 *
 * Proves three things:
 *  1. BYTE-EXACT round-trip: parseRc0 -> serializeRc0 reproduces every real
 *     sibling-corpus file exactly (RC-600 / RC-505 mk1 / RC-500 dialects).
 *  2. SURGICAL edit: setLeaf changes exactly ONE line and no other byte.
 *  3. SELF-CONTAINED golden: a synthetic single-letter `.RC0` (the RC-600/mk2
 *     dialect) round-trips + edits with no external files, so this runs on any
 *     clone even though the corpus lives in gitignored samples/.
 *
 * Run: npx tsx scripts/_research/verify-rc0-roundtrip.ts
 * The corpus (samples/rc505mk2-oracle/*.RC0) is gitignored, so this is a
 * manually-run research check, NOT part of preflight. Exits non-zero on failure.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseRc0,
  serializeRc0,
  getLeaf,
  setLeaf,
  decodeCharCodes,
  leavesUnder,
} from './rc0-codec.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const corpusDir = join(repoRoot, 'samples', 'rc505mk2-oracle');

let failures = 0;
const ok = (msg: string): void => console.log(`  OK   ${msg}`);
const fail = (msg: string): void => { console.log(`  FAIL ${msg}`); failures++; };

// ── 1 + 2: real sibling corpus ──────────────────────────────────────
console.log('RC0 codec round-trip vs real sibling corpus');
if (!existsSync(corpusDir)) {
  console.log(`  (corpus dir ${corpusDir} absent - skipping; run the fetch in RC-505mk2-RC0-SCHEMA.md section 1)`);
} else {
  const files = readdirSync(corpusDir).filter((f) => f.toUpperCase().endsWith('.RC0')).sort();
  if (files.length === 0) console.log('  (no .RC0 files in corpus dir - skipping)');
  for (const f of files) {
    const text = readFileSync(join(corpusDir, f), 'latin1'); // byte-preserving 1:1
    const doc = parseRc0(text);
    const out = serializeRc0(doc);
    if (out === text) {
      ok(`${f}: byte-exact round-trip (${text.length}B, ${doc.leaves.length} leaves)`);
    } else {
      // Locate first divergence for diagnostics.
      let i = 0;
      while (i < out.length && i < text.length && out[i] === text[i]) i++;
      fail(`${f}: round-trip DIVERGED at byte ${i} (len ${text.length}->${out.length})`);
    }
  }

  // Surgical-edit proof on the RC-600 file (single-letter dialect = mk2 twin).
  const memFile = files.find((f) => /MEMORY001A/i.test(f)) ?? files.find((f) => /MEMORY/i.test(f));
  if (memFile) {
    const text = readFileSync(join(corpusDir, memFile), 'latin1');
    const before = parseRc0(text);
    // Find a concrete editable leaf: TRACK1's 4th field (RC-600 D = PlayLevel 0..200).
    const target = before.byPath.has('database/mem#0/TRACK1/D')
      ? 'database/mem#0/TRACK1/D'
      : before.leaves.find((l) => /\/TRACK1\//.test(l.path))?.path;
    if (target) {
      const original = getLeaf(before, target)!;
      const bumped = String((Number.parseInt(original, 10) || 0) + 7);
      setLeaf(before, target, bumped);
      const edited = serializeRc0(before);
      const origLines = text.split('\n');
      const editLines = edited.split('\n');
      const changed = origLines.reduce((n, l, i) => n + (l === editLines[i] ? 0 : 1), 0);
      if (changed === 1 && getLeaf(parseRc0(edited), target) === bumped) {
        ok(`${memFile}: setLeaf('${target}' ${original}->${bumped}) changed exactly 1 line, all other bytes intact`);
      } else {
        fail(`${memFile}: surgical edit changed ${changed} lines (expected 1)`);
      }
    }

    // Name decode demo (RC-600 NAME = <A..L> ASCII codes).
    const namePath = before.leaves.some((l) => l.path.startsWith('database/mem#0/NAME/'))
      ? 'database/mem#0/NAME'
      : undefined;
    if (namePath) {
      const name = decodeCharCodes(parseRc0(text), namePath);
      ok(`${memFile}: decoded memory name = ${JSON.stringify(name)}`);
    }
  }
}

// ── 3: self-contained synthetic golden (RC-600/mk2 single-letter dialect) ──
console.log('RC0 codec self-contained golden (no external files)');
// Mirrors the real RC-600 shape: xml decl, database envelope, single-letter
// leaves, nested container, trailing <count> with NO final newline.
const SYNTH = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<database name="RC-600" revision="0">',
  '<mem id="0">',
  '<NAME>',
  '\t<A>84</A>',   // 'T'
  '\t<B>101</B>',  // 'e'
  '\t<C>115</C>',  // 's'
  '\t<D>116</D>',  // 't'
  '\t<E>32</E>',
  '</NAME>',
  '<TRACK1>',
  '\t<A>0</A>',
  '\t<D>100</D>',
  '</TRACK1>',
  '<ASSIGN1>',
  '\t<A>0</A>',
  '\t<B>0</B>',
  '\t<G>0</G>',
  '</ASSIGN1>',
  '</mem>',
  '</database>',
  '<count>0001</count>',
].join('\n'); // deliberately NO trailing newline, like real RC-600

{
  const doc = parseRc0(SYNTH);
  if (serializeRc0(doc) === SYNTH) ok('synthetic: byte-exact round-trip (incl. no-final-newline + trailing <count>)');
  else fail('synthetic: round-trip diverged');

  if (decodeCharCodes(doc, 'database/mem#0/NAME') === 'Test') ok("synthetic: NAME decodes to 'Test'");
  else fail(`synthetic: NAME decoded wrong -> ${JSON.stringify(decodeCharCodes(doc, 'database/mem#0/NAME'))}`);

  // ASSIGN1 and TRACK1 both have an <A>; paths must disambiguate them.
  const a1 = getLeaf(doc, 'database/mem#0/TRACK1/A');
  const a2 = getLeaf(doc, 'database/mem#0/ASSIGN1/A');
  if (a1 === '0' && a2 === '0' && doc.byPath.size === doc.leaves.length) ok('synthetic: path addressing disambiguates repeated <A> across sections');
  else fail('synthetic: path addressing collision');

  // Surgical edit preserves the trailing <count> and every other line.
  const d2 = parseRc0(SYNTH);
  setLeaf(d2, 'database/mem#0/TRACK1/D', 200);
  const edited = serializeRc0(d2);
  const changed = SYNTH.split('\n').reduce((n, l, i) => n + (l === edited.split('\n')[i] ? 0 : 1), 0);
  if (changed === 1 && edited.includes('<count>0001</count>') && edited.includes('\t<D>200</D>')) ok('synthetic: setLeaf preserved trailing <count> + all other lines');
  else fail(`synthetic: setLeaf side effects (changed ${changed} lines)`);

  // Editing a non-integer/unknown path must throw.
  try { setLeaf(d2, 'database/mem#0/NOPE/X', 1); fail('synthetic: setLeaf on missing path did not throw'); }
  catch { ok('synthetic: setLeaf on missing path throws'); }

  // Count total leaves for visibility.
  ok(`synthetic: ${leavesUnder(doc, 'database/mem#0').length} leaves under mem#0`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: rc0 codec (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
