/**
 * OFFLINE verification of the drum-track config record at 0x26fbc (4 x 11 bytes).
 *   - structural period-11 / 4-fold check
 *   - mirror search: any other offset in the file perfectly correlated with a record byte
 *   - scene-chain collision check (sceneChain.ts writes 0x26fbc and 0x26fd2)
 *
 *   npx tsx scripts/_research/_ncs-drumrec-verify.mts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';

const NCS_SIZE = 160_780;
const CWD = process.cwd();
const REC_BASE = 0x26fbc;
const STRIDE = 11;
// +7..+10 RETRACTED as revSend/dlySend 2026-09-20: zero in 4,700 of 4,700 track-slots, and the real
// drum reverb sends are hardware-confirmed at 0x26ffa..0x26ffd. The vendor's own Drum Control table
// ends at pan, so there is nothing these four are known to be.
const FIELDS = ['patch', 'level', 'pitch', 'decay', 'dist', 'eq', 'pan', 'pad7', 'pad8', 'pad9', 'pad10'];
const SCENE_CHAIN_END = 0x2c1;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.toLowerCase().endsWith('.ncs') && st.size === NCS_SIZE) out.push(p);
  }
}
const all: string[] = [];
walk(resolve(CWD, 'samples'), all);
all.sort();
const byHash = new Map<string, { path: string; buf: Buffer }>();
for (const f of all) {
  const buf = readFileSync(f);
  const h = createHash('sha1').update(buf).digest('hex');
  if (!byHash.has(h)) byHash.set(h, { path: f, buf });
}
const uniq = [...byHash.values()];
const N = uniq.length;
console.log(`${all.length} files, ${N} byte-distinct\n`);

// ---------- 1. structural check: is the modal value the same for all 4 tracks at each k?
console.log('=== 1. period-11 / 4-fold structural check ===');
for (let k = 0; k < STRIDE; k++) {
  const modals: number[] = [];
  const distinct: number[] = [];
  for (let t = 0; t < 4; t++) {
    const off = REC_BASE + t * STRIDE + k;
    const c = new Map<number, number>();
    for (const u of uniq) c.set(u.buf[off], (c.get(u.buf[off]) ?? 0) + 1);
    const sorted = [...c.entries()].sort((a, b) => b[1] - a[1]);
    modals.push(sorted[0][0]);
    distinct.push(c.size);
  }
  const same = modals.every((v) => v === modals[0]);
  console.log(
    `  +${String(k).padStart(2)} ${FIELDS[k].padEnd(8)} modal per track = [${modals.join(', ')}]` +
    `  distinct=[${distinct.join(',')}]  ${same ? 'SAME across 4 tracks' : '<-- DIFFERS'}`,
  );
}
// neighbours: does the period-11 pattern continue outside the 44 bytes?
console.log('\n  neighbour sanity (same k, tracks -1 and +4):');
for (const t of [-1, 4]) {
  const row: string[] = [];
  for (let k = 0; k < STRIDE; k++) {
    const off = REC_BASE + t * STRIDE + k;
    const c = new Map<number, number>();
    for (const u of uniq) c.set(u.buf[off], (c.get(u.buf[off]) ?? 0) + 1);
    row.push(String([...c.entries()].sort((a, b) => b[1] - a[1])[0][0]));
  }
  console.log(`    t=${t} @0x${(REC_BASE + t * STRIDE).toString(16)}: [${row.join(',')}]`);
}

// ---------- 2. mirror search: column fingerprint over all offsets
console.log('\n=== 2. mirror search (offsets whose value column is identical across all files) ===');
const fp = new Array<string>(NCS_SIZE);
{
  const col = Buffer.allocUnsafe(N);
  for (let off = 0; off < NCS_SIZE; off++) {
    for (let i = 0; i < N; i++) col[i] = uniq[i].buf[off];
    fp[off] = createHash('sha1').update(col).digest('base64').slice(0, 16);
  }
}
const groups = new Map<string, number[]>();
for (let off = 0; off < NCS_SIZE; off++) {
  const g = groups.get(fp[off]);
  if (g) g.push(off); else groups.set(fp[off], [off]);
}
for (let t = 0; t < 4; t++) {
  for (let k = 0; k < STRIDE; k++) {
    const off = REC_BASE + t * STRIDE + k;
    const g = groups.get(fp[off])!;
    const others = g.filter((o) => o !== off && (o < REC_BASE || o >= REC_BASE + 44));
    if (others.length && k <= 6) {
      console.log(`  d${t + 1}.${FIELDS[k]} @0x${off.toString(16)} correlates with ${others.length} other offsets: ` +
        others.slice(0, 8).map((o) => '0x' + o.toString(16)).join(' ') + (others.length > 8 ? ' ...' : ''));
    }
  }
}
const varying = [0, 1, 2, 3, 4, 5, 6].flatMap((k) => [0, 1, 2, 3].map((t) => REC_BASE + t * STRIDE + k))
  .filter((o) => groups.get(fp[o])!.length === 1 || groups.get(fp[o])!.every((x) => x >= REC_BASE && x < REC_BASE + 44));
console.log(`  ${varying.length} of 28 macro/level/patch bytes have NO mirror anywhere else in the file`);

// ---------- 3. scene-chain collision
console.log('\n=== 3. scene-chain collision (sceneChain.ts writes 0x26fbc=0 and 0x26fd2=7) ===');
let chained = 0, chainedD1zero = 0, chainedD3seven = 0;
let unchained = 0, unchD1zero = 0, unchD3seven = 0;
const chainedFiles: string[] = [];
for (const u of uniq) {
  const hasChain = u.buf[SCENE_CHAIN_END] !== 0;
  const d1 = u.buf[0x26fbc], d3 = u.buf[0x26fd2];
  if (hasChain) {
    chained++;
    if (d1 === 0) chainedD1zero++;
    if (d3 === 7) chainedD3seven++;
    if (chainedFiles.length < 12) chainedFiles.push(`${relative(CWD, u.path)}  end=${u.buf[SCENE_CHAIN_END]} d1patch=${d1} d3patch=${d3}`);
  } else {
    unchained++;
    if (d1 === 0) unchD1zero++;
    if (d3 === 7) unchD3seven++;
  }
}
console.log(`  with scene chain (0x2c1!=0): ${chained} files; d1patch==0 in ${chainedD1zero}, d3patch==7 in ${chainedD3seven}`);
console.log(`  no scene chain:              ${unchained} files; d1patch==0 in ${unchD1zero}, d3patch==7 in ${unchD3seven}`);
for (const s of chainedFiles) console.log(`    ${s}`);

// ---------- 4. distribution of patch_select (must be 0..63 if it is a sample index into a 64-sample pack)
console.log('\n=== 4. patch_select range check (pack holds 64 samples -> doc range 0..63) ===');
for (let t = 0; t < 4; t++) {
  const off = REC_BASE + t * STRIDE;
  let mn = 255, mx = 0, over = 0;
  for (const u of uniq) { const v = u.buf[off]; if (v < mn) mn = v; if (v > mx) mx = v; if (v > 63) over++; }
  console.log(`  d${t + 1} @0x${off.toString(16)}: min=${mn} max=${mx} values>63: ${over}`);
}
// level/pitch/decay/dist/eq/pan must all be 0..127
console.log('\n=== 5. 0..127 range check on level + 5 macro columns ===');
for (let k = 1; k <= 6; k++) {
  let over = 0, mn = 255, mx = 0;
  for (let t = 0; t < 4; t++) for (const u of uniq) {
    const v = u.buf[REC_BASE + t * STRIDE + k];
    if (v > 127) over++; if (v < mn) mn = v; if (v > mx) mx = v;
  }
  console.log(`  +${k} ${FIELDS[k].padEnd(6)} min=${mn} max=${mx} values>127: ${over}`);
}
