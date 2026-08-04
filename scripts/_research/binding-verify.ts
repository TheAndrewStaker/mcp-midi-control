/**
 * binding-verify.ts — OFFLINE. Full-file byte-compare of the post-write device
 * re-download against what we intended, for EVERY live project on packs 2/4/5.
 *
 * Two assertions, covering the whole card surface we touched and the surface we
 * did not:
 *
 *   TARGETS (the 57 rebound projects): verify/ must be byte-identical to staged/
 *   across all 160,780 bytes — not just the 4 binding bytes. This catches any
 *   transfer corruption or device-side re-serialisation.
 *
 *   NEIGHBOURS (every other live project): verify/ must be byte-identical to the
 *   pre-write scan/. This is the proof that a 57-project write campaign moved
 *   nothing it was not aimed at.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { getProjectName, NCS_FILE_SIZE, checkNcsStructure } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';

const BASE = 'samples/circuit-ncs/bindings-2026-07-30';
const SCAN = join(BASE, 'scan');
const STAGED = join(BASE, 'staged');
const VERIFY = join(BASE, 'verify');
const CANONICAL = [1, 2, 5, 11];

const FN_RE = /-pack(\d+)-project(\d+)-/;

/** newest capture per (pack,slot) in a backup_device output directory */
function indexDir(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter(n => n.endsWith('.ncs'))) {
    const g = FN_RE.exec(f);
    if (!g) continue;
    const key = `${Number(g[1])}/${String(Number(g[2])).padStart(2, '0')}`;
    const prev = m.get(key);
    if (!prev || f > prev) m.set(key, f);
  }
  return m;
}

const scan = indexDir(SCAN);
const verify = indexDir(VERIFY);
const manifest: { key: string; pack: number; slot: number; name: string; staged: string; before: number[] }[] =
  JSON.parse(readFileSync(join(BASE, 'manifest.json'), 'utf8'));
const targetKeys = new Set(manifest.map(e => e.key));

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : Math.min(a.length, b.length);
}

let targetOk = 0, targetFail = 0, neighbourOk = 0, neighbourFail = 0, missing = 0;
const problems: string[] = [];

console.log('=== TARGETS: verify vs staged (full file) ===');
for (const e of manifest) {
  const vf = verify.get(e.key);
  if (!vf) { problems.push(`${e.key} "${e.name}": MISSING from verify scan`); missing++; continue; }
  const got = new Uint8Array(readFileSync(join(VERIFY, vf)));
  const want = new Uint8Array(readFileSync(join(STAGED, e.staged)));
  const d = firstDiff(got, want);
  const bind = getDrumSampleBinding(got);
  const struct = checkNcsStructure(got);
  if (d === -1 && bind.join(',') === CANONICAL.join(',') && struct.ok) {
    targetOk++;
  } else {
    targetFail++;
    problems.push(
      `${e.key} "${e.name}": ${d === -1 ? '' : `first diff at 0x${d.toString(16)} (device ${got[d]} vs staged ${want[d]}); `}` +
      `binding=[${bind.join(',')}]${struct.ok ? '' : `; structure faults: ${struct.faults.join('; ')}`}`,
    );
  }
}
console.log(`  ${targetOk}/${manifest.length} byte-identical to staged, binding [${CANONICAL.join(',')}], structure ok.`);
if (targetFail) console.log(`  ${targetFail} FAILED.`);
if (missing) console.log(`  ${missing} missing from the verify scan.`);

console.log('\n=== NEIGHBOURS: verify vs pre-write scan (full file, must be untouched) ===');
for (const [key, vf] of [...verify.entries()].sort()) {
  if (targetKeys.has(key)) continue;
  const sf = scan.get(key);
  if (!sf) { problems.push(`${key}: present in verify but absent from scan (new project?)`); continue; }
  const got = new Uint8Array(readFileSync(join(VERIFY, vf)));
  const before = new Uint8Array(readFileSync(join(SCAN, sf)));
  const d = firstDiff(got, before);
  if (d === -1) neighbourOk++;
  else {
    neighbourFail++;
    problems.push(`${key} "${getProjectName(got)}": NEIGHBOUR CHANGED, first diff at 0x${d.toString(16)} (${before[d]} -> ${got[d]})`);
  }
}
console.log(`  ${neighbourOk} untouched projects byte-identical to their pre-write state.`);
if (neighbourFail) console.log(`  ${neighbourFail} NEIGHBOURS CHANGED — investigate.`);

// Any live project still not on the canonical binding (excluding the deliberate exclusions)?
console.log('\n=== FINAL BINDING CENSUS (all live projects post-write) ===');
const census = new Map<string, string[]>();
for (const [key, vf] of [...verify.entries()].sort()) {
  const buf = new Uint8Array(readFileSync(join(VERIFY, vf)));
  const b = '[' + getDrumSampleBinding(buf).join(',') + ']';
  if (!census.has(b)) census.set(b, []);
  census.get(b)!.push(`${key} ${getProjectName(buf)}`);
}
for (const [b, list] of [...census.entries()].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`  ${b}: ${list.length} projects`);
  if (b !== '[' + CANONICAL.join(',') + ']') for (const l of list) console.log(`      ${l}`);
}

if (problems.length) {
  console.log('\n=== PROBLEMS ===');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`\nALL CLEAN: ${targetOk} rebound + ${neighbourOk} untouched, every byte accounted for.`);
