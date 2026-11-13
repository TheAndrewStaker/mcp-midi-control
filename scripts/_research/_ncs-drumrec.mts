/**
 * OFFLINE: dump the 4 x 11-byte drum records from every byte-distinct .ncs in the corpus,
 * and list every file whose record deviates from the modal (factory) record.
 *
 *   npx tsx scripts/_research/_ncs-drumrec.mts
 *   npx tsx scripts/_research/_ncs-drumrec.mts --diff A.ncs B.ncs   (full-file byte diff)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';

const NCS_SIZE = 160_780;
const CWD = process.cwd();
const ROOT = resolve(CWD, 'samples');

const REC_BASE = 0x26fbc;
const REC_STRIDE = 11;
const FIELDS = ['patch', 'level', 'pitch', 'decay', 'dist', 'eq', 'pan', 'r7', 'r8', 'r9', 'r10'];

// ---- optional: full-file diff of two files
const di = process.argv.indexOf('--diff');
if (di >= 0) {
  const a = readFileSync(process.argv[di + 1]);
  const b = readFileSync(process.argv[di + 2]);
  console.log(`A=${process.argv[di + 1]} (${a.length})`);
  console.log(`B=${process.argv[di + 2]} (${b.length})`);
  let n = 0;
  const n2 = Math.min(a.length, b.length);
  for (let i = 0; i < n2; i++) {
    if (a[i] !== b[i]) {
      n++;
      if (n <= 400) console.log(`  0x${i.toString(16)} ${String(i).padStart(7)}  ${a[i]} -> ${b[i]}`);
    }
  }
  console.log(`total differing bytes: ${n}${a.length !== b.length ? ' (+ length differs)' : ''}`);
  process.exit(0);
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.toLowerCase().endsWith('.ncs') && st.size === NCS_SIZE) out.push(p);
  }
}
const files: string[] = [];
walk(ROOT, files);
files.sort();

type Entry = { path: string; buf: Buffer; copies: string[] };
const byHash = new Map<string, Entry>();
for (const f of files) {
  const buf = readFileSync(f);
  const h = createHash('sha1').update(buf).digest('hex');
  const hit = byHash.get(h);
  if (hit) { hit.copies.push(f); continue; }
  byHash.set(h, { path: f, buf, copies: [] });
}
const uniq = [...byHash.values()];

// modal value for each of the 44 record bytes
const modal: number[] = [];
for (let t = 0; t < 4; t++) {
  for (let k = 0; k < REC_STRIDE; k++) {
    const off = REC_BASE + t * REC_STRIDE + k;
    const c = new Map<number, number>();
    for (const u of uniq) c.set(u.buf[off], (c.get(u.buf[off]) ?? 0) + 1);
    modal.push([...c.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
}
console.log('modal (factory) record bytes, per track:');
for (let t = 0; t < 4; t++) {
  const row = modal.slice(t * REC_STRIDE, (t + 1) * REC_STRIDE);
  console.log(`  drum${t + 1} @0x${(REC_BASE + t * REC_STRIDE).toString(16)}: ` +
    row.map((v, k) => `${FIELDS[k]}=${v}`).join(' '));
}

// Only the MACRO columns (pitch/decay/dist/eq/pan = k 2..6); ignore patch + level (known-authored).
const MACRO_K = [2, 3, 4, 5, 6];
type Dev = { file: string; devs: string[]; copies: number };
const devFiles: Dev[] = [];
for (const u of uniq) {
  const devs: string[] = [];
  for (let t = 0; t < 4; t++) {
    for (const k of MACRO_K) {
      const off = REC_BASE + t * REC_STRIDE + k;
      const v = u.buf[off];
      const m = modal[t * REC_STRIDE + k];
      if (v !== m) devs.push(`d${t + 1}.${FIELDS[k]}@0x${off.toString(16)} ${m}->${v}`);
    }
  }
  if (devs.length) devFiles.push({ file: relative(CWD, u.path), devs, copies: u.copies.length });
}
console.log(`\n${devFiles.length} of ${uniq.length} byte-distinct files deviate on a MACRO column:\n`);
devFiles.sort((a, b) => b.devs.length - a.devs.length);
for (const d of devFiles) {
  console.log(`${d.file}  (+${d.copies} identical copies)`);
  for (const s of d.devs) console.log(`    ${s}`);
  const full: string[] = [];
  for (let t = 0; t < 4; t++) {
    const row: number[] = [];
    for (let k = 0; k < REC_STRIDE; k++) row.push(byHash.get(createHash('sha1').update(readFileSync(resolve(CWD, d.file))).digest('hex'))!.buf[REC_BASE + t * REC_STRIDE + k]);
    full.push(`d${t + 1}[${row.join(',')}]`);
  }
  console.log(`    record: ${full.join(' ')}`);
}

// ---- also: reserved-byte check (k 7..10 must be 0 everywhere)
let resBad = 0;
for (const u of uniq) {
  for (let t = 0; t < 4; t++) for (const k of [7, 8, 9, 10]) {
    if (u.buf[REC_BASE + t * REC_STRIDE + k] !== 0) resBad++;
  }
}
console.log(`\nreserved bytes (+7..+10) non-zero occurrences across ${uniq.length} files: ${resBad}`);
