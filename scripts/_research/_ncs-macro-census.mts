/**
 * OFFLINE .ncs census — hunt for the drum MACRO (pitch/decay/distortion/eq/pan) bytes.
 *
 * Read-only. Never writes into samples/ and never touches a device.
 *
 *   npx tsx scripts/_research/_ncs-macro-census.mts [--region 0x26e00-0x27100]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const NCS_SIZE = 160_780;
const ROOT = resolve(process.cwd(), 'samples');

const DRUM_LEVEL_BASE = 0x26fbd;
const DRUM_LEVEL_STRIDE = 11;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (e.toLowerCase().endsWith('.ncs') && st.size === NCS_SIZE) out.push(p);
  }
}

const files: string[] = [];
walk(ROOT, files);
files.sort();

// Dedupe by content hash: hundreds of the backups are byte-identical copies.
const byHash = new Map<string, { path: string; buf: Buffer; copies: number }>();
for (const f of files) {
  const buf = readFileSync(f);
  const h = createHash('sha1').update(buf).digest('hex');
  const hit = byHash.get(h);
  if (hit) {
    hit.copies++;
    continue;
  }
  byHash.set(h, { path: f, buf, copies: 1 });
}
const uniq = [...byHash.values()];
console.log(`scanned ${files.length} .ncs files of ${NCS_SIZE} bytes; ${uniq.length} byte-distinct`);

// ---- full-file presence bitset: 160780 offsets x 256 values -> 32 bytes/offset
const bits = new Uint8Array(NCS_SIZE * 32);
for (const { buf } of uniq) {
  for (let i = 0; i < NCS_SIZE; i++) {
    const v = buf[i];
    bits[i * 32 + (v >> 3)] |= 1 << (v & 7);
  }
}
function valuesAt(off: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < 256; v++) if (bits[off * 32 + (v >> 3)] & (1 << (v & 7))) out.push(v);
  return out;
}
function distinctAt(off: number): number {
  let n = 0;
  for (let b = 0; b < 32; b++) {
    let x = bits[off * 32 + b];
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

const arg = process.argv.find((a) => a.startsWith('--region='));
let lo = 0x26e00;
let hi = 0x27100;
if (arg) {
  const [a, b] = arg.slice('--region='.length).split('-');
  lo = Number(a);
  hi = Number(b);
}

const levelOffs = [0, 1, 2, 3].map((t) => DRUM_LEVEL_BASE + t * DRUM_LEVEL_STRIDE);
console.log(`\ndrum level offsets: ${levelOffs.map((o) => '0x' + o.toString(16)).join(' ')}`);

console.log(`\n=== per-offset census, 0x${lo.toString(16)}..0x${hi.toString(16)} ===`);
console.log('off       dec      n  values (value:filecount for n<=12)');
// per-offset value->count over unique files
for (let off = lo; off < hi; off++) {
  const n = distinctAt(off);
  const counts = new Map<number, number>();
  for (const { buf } of uniq) counts.set(buf[off], (counts.get(buf[off]) ?? 0) + 1);
  const isLevel = levelOffs.includes(off);
  const kMark = levelOffs.map((lv, t) => (off - lv === 0 ? `L${t + 1}` : '')).join('');
  const rel = (() => {
    const t = Math.floor((off - DRUM_LEVEL_BASE) / DRUM_LEVEL_STRIDE);
    const k = off - (DRUM_LEVEL_BASE + t * DRUM_LEVEL_STRIDE);
    return `t${t}+${k}`;
  })();
  let desc: string;
  if (n <= 12) {
    desc = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([v, c]) => `${v}:${c}`)
      .join(' ');
  } else {
    const vs = valuesAt(off);
    desc = `min=${vs[0]} max=${vs[vs.length - 1]} (${n} distinct)`;
  }
  console.log(
    `0x${off.toString(16)} ${String(off).padStart(7)} ${String(n).padStart(3)}  ${rel.padEnd(7)} ${isLevel ? kMark.padEnd(3) : '   '} ${desc}`,
  );
}
