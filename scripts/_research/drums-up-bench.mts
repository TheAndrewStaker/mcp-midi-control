/**
 * drums-up-bench.mts - OFFLINE. Build the Pack 5 audition bench from `rig/circuit-bench.json`.
 *
 * Supersedes the hard-coded layout in drums-up-audition.mts: which samples sit on the bench is now a
 * config edit, because the bench is re-cut every time the owner narrows his picks. The layout rule is
 * fixed and is the whole point: FOUR BLOCKS OF SIXTEEN, one per role, because the Circuit's Sample
 * view pages in sixteens, so a role block is exactly one page you tap across.
 *
 * Usage: npx tsx scripts/_research/drums-up-bench.mts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alignSampleFilename } from '../../packages/circuit-tracks/src/samples/uploadSample.js';
import { naturalCompare } from '../../packages/core/src/protocol-generic/dispatcher/uploads.js';

const RUN = 'samples/circuit-ncs/drums-up-2026-09-16';
const OUT = `${RUN}/audition-pack5`;
const PACK_SECONDS = 196.6;
const SPEC = JSON.parse(readFileSync('docs/_private/rig/circuit-bench.json', 'utf8')) as {
  roots: Record<string, string>;
  rows: { role: string; items: [string, string][] }[];
};
const resolve = (ref: string) => {
  const [root, ...rest] = ref.split('/');
  const base = SPEC.roots[root];
  if (!base) throw new Error(`bench references root "${root}", which is not defined`);
  const p = join(base, rest.join('/'));
  if (!existsSync(p)) throw new Error(`bench references ${ref}, which is not on disk (${p})`);
  return p;
};
function dur(path: string): number {
  const b = readFileSync(path);
  let off = 12, rate = 0, ch = 0, bits = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4); const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') return sz / (rate * ch * (bits / 8));
    off += 8 + sz + (sz & 1);
  }
  return 0;
}
rmSync(OUT, { recursive: true, force: true });
let total = 0;
const manifest: { slot: number; device_slot: number; row: string; name: string; file: string; seconds: number }[] = [];
const calls: { folder: string; start_slot: number; pack: number; confirm_overwrite: true }[] = [];
SPEC.rows.forEach((row, ri) => {
  if (row.items.length > 16) throw new Error(`row "${row.role}" has ${row.items.length} items; a role block is 16`);
  const base = ri * 16;
  const folder = `${OUT}/${row.role}`;
  mkdirSync(folder, { recursive: true });
  row.items.forEach(([label, ref], i) => {
    const slot = base + i;
    const src = resolve(ref);
    const name = alignSampleFilename(`${String(slot).padStart(2, '0')}_${row.role.slice(0, 3)}_${label}.wav`, slot).filename;
    copyFileSync(src, join(folder, name));
    const s = dur(src); total += s;
    manifest.push({ slot, device_slot: slot + 1, row: row.role, name, file: src, seconds: Number(s.toFixed(3)) });
  });
  // upload_kit maps a natural-sorted folder onto consecutive slots: assert that order IS slot order.
  readdirSync(folder).filter((f) => f.endsWith('.wav')).sort(naturalCompare).forEach((f, i) => {
    const want = manifest.find((m) => m.slot === base + i)!.name;
    if (f !== want) throw new Error(`${row.role}: upload_kit would put "${f}" on slot ${base + i + 1}, plan says "${want}"`);
  });
  calls.push({ folder, start_slot: base + 1, pack: 5, confirm_overwrite: true });
});
if (total > PACK_SECONDS) throw new Error(`bench is ${total.toFixed(1)}s, over the ${PACK_SECONDS}s pack budget`);
writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), seconds: Number(total.toFixed(1)), slots: manifest, calls }, null, 2));
for (const c of calls) console.log(`upload_kit  folder=${c.folder}  start_slot=${c.start_slot}  pack=5`);
console.log(`\n${manifest.length} samples, ${total.toFixed(1)}s of ${PACK_SECONDS}s`);
for (const row of SPEC.rows) {
  const r = manifest.filter((m) => m.row === row.role);
  console.log(`\n${row.role.toUpperCase()} (page ${SPEC.rows.indexOf(row) + 1})`);
  console.log('  ' + r.map((m) => `${((m.slot % 16) + 1)}:${m.name.replace(/^\d+_\w{3}_|\.wav$/g, '')}`).join('  '));
}
