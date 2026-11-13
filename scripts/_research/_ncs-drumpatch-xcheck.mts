/**
 * OFFLINE cross-check: does the drum-config record's +0 column (patch_select)
 * agree with the HARDWARE-CONFIRMED drum-binding block at 0x1a278?
 *
 *   npx tsx scripts/_research/_ncs-drumpatch-xcheck.mts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, sep } from 'node:path';

const N = 160_780, CWD = process.cwd(), B = 0x26fbc, S = 11, BIND = 0x1a278;

function walk(d: string, o: string[]): void {
  let e: string[]; try { e = readdirSync(d); } catch { return; }
  for (const x of e) {
    const p = join(d, x); let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, o);
    else if (x.toLowerCase().endsWith('.ncs') && s.size === N) o.push(p);
  }
}
const a: string[] = []; walk(resolve(CWD, 'samples'), a); a.sort();
const m = new Map<string, { p: string; b: Buffer }>();
for (const f of a) {
  const b = readFileSync(f); const h = createHash('sha1').update(b).digest('hex');
  if (!m.has(h)) m.set(h, { p: f, b });
}
const u = [...m.values()];

function grp(p: string): string {
  const r = relative(CWD, p).split(sep).join('/');
  if (r.includes('/pack0/')) return 'FACTORY pack0';
  if (/card-backup|backup-sugar|pre-delete|predelete|preauthor|templates/.test(r)) return 'DEVICE backup / pre-author';
  return 'authored by our tooling';
}
const agg = new Map<string, { n: number; ok: number; per: number[] }>();
for (const x of u) {
  const k = grp(x.p);
  const e = agg.get(k) ?? { n: 0, ok: 0, per: [0, 0, 0, 0] };
  e.n++; let all = true;
  for (let t = 0; t < 4; t++) { if (x.b[B + t * S] === x.b[BIND + t]) e.per[t]++; else all = false; }
  if (all) e.ok++; agg.set(k, e);
}
console.log('record[+0] vs drum binding 0x1a278 (hardware-confirmed sample pointers)\n');
console.log('group'.padEnd(28) + 'files  all4       d1       d2       d3       d4');
for (const [k, v] of agg) {
  console.log(k.padEnd(28) + String(v.n).padStart(5) + '  ' + String(v.ok).padStart(4) + '  ' +
    v.per.map((x) => `${x}/${v.n}`.padStart(8)).join(' '));
}
console.log('\nmismatches inside DEVICE-ORIGIN groups (should be ~none):');
let c = 0;
for (const x of u) {
  if (grp(x.p) === 'authored by our tooling') continue;
  for (let t = 0; t < 4; t++) {
    if (x.b[B + t * S] !== x.b[BIND + t]) {
      c++;
      if (c <= 25) console.log(`  ${relative(CWD, x.p)} d${t + 1} rec=${x.b[B + t * S]} bind=${x.b[BIND + t]}`);
    }
  }
}
console.log(`  total device-origin mismatches: ${c}`);
