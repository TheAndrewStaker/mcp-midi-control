/**
 * drum-levels-verify.ts — Verify the 2026-07-30 drum-levels pass landed exactly.
 *
 * Three assertions, all byte-level:
 *  1. Each of the 30 re-downloaded projects is FULL-FILE byte-identical to the
 *     staged file that was uploaded. Not "the four bytes are 0" — the whole
 *     160,780 bytes, so nothing else moved on the round trip.
 *  2. Each still passes checkNcsStructure and reads back drum levels 0/0/0/0.
 *  3. The four neighbour witnesses from two untouched songs (Clint 27-28,
 *     Sugar 46-47) are byte-identical pre vs post.
 *
 * OFFLINE ONLY.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  getDrumLevel,
  checkNcsStructure,
  getProjectName,
  NCS_FILE_SIZE,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const BASE = 'samples/circuit-ncs/drumlevels-2026-07-30';
const STAGED = join(BASE, 'staged');
const VERIFY = join(BASE, 'verify');
const NPRE = join(BASE, 'neighbours-pre');
const NPOST = join(BASE, 'neighbours-post');

let failed = false;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${label}${ok ? '' : `  <-- ${detail}`}`);
  if (!ok) failed = true;
};

const firstDiff = (a: Buffer, b: Buffer): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
};

const FN_RE = /-pack(\d+)-project(\d+)-/;
/** Map pack/slot -> downloaded file, newest wins. */
function byKey(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of readdirSync(dir).filter(x => x.endsWith('.ncs')).sort()) {
    const g = FN_RE.exec(f);
    if (g) m.set(`${Number(g[1])}/${Number(g[2])}`, join(dir, f));
  }
  return m;
}

// --- 1 + 2: the 30 fixed projects ------------------------------------------
const dl = byKey(VERIFY);
const staged = readdirSync(STAGED).filter(f => f.endsWith('.ncs')).sort();
check(`staged set has 30 files (got ${staged.length})`, staged.length === 30);

let matched = 0;
for (const f of staged) {
  const g = /^pack(\d+)-proj(\d+)\.ncs$/.exec(f);
  if (!g) { check(`${f}: staged filename parses`, false); continue; }
  const key = `${Number(g[1])}/${Number(g[2])}`;
  const dlPath = dl.get(key);
  if (!dlPath) { check(`${key}: re-downloaded after upload`, false, 'no verify capture'); continue; }

  const want = readFileSync(join(STAGED, f));
  const got = readFileSync(dlPath);
  const d = firstDiff(want, got);
  const name = getProjectName(new Uint8Array(got));
  check(`${key} "${name}": FULL-FILE byte-identical to staged (${NCS_FILE_SIZE} bytes)`,
    d === -1 && got.length === want.length,
    d === -1 ? `length ${got.length} vs ${want.length}` : `first diff at 0x${d.toString(16)} (${want[d]} -> ${got[d]})`);

  const u8 = new Uint8Array(got);
  const levels = [0, 1, 2, 3].map(t => getDrumLevel(u8, t));
  check(`${key}: on-device drum levels 0/0/0/0`, levels.every(v => v === 0), levels.join('/'));
  const s = checkNcsStructure(u8);
  check(`${key}: structurally valid on device`, s.ok, s.faults.join('; '));
  if (d === -1) matched++;
}

// --- 3: neighbour witnesses -------------------------------------------------
console.log('\n--- neighbour witnesses (two untouched songs) ---');
const pre = byKey(NPRE);
const post = byKey(NPOST);
check(`4 neighbour witnesses captured pre and post`, pre.size === 4 && post.size === 4, `pre=${pre.size} post=${post.size}`);
for (const [key, pPath] of [...pre.entries()].sort()) {
  const qPath = post.get(key);
  if (!qPath) { check(`${key}: post capture exists`, false); continue; }
  const a = readFileSync(pPath);
  const b = readFileSync(qPath);
  const d = firstDiff(a, b);
  check(`${key} "${getProjectName(new Uint8Array(a))}": byte-identical pre vs post`,
    d === -1, `first diff at 0x${d.toString(16)}`);
}

console.log(failed
  ? '\nVERIFICATION FAILED.'
  : `\nVERIFIED: ${matched}/30 projects byte-identical to staged; all neighbours unchanged.`);
process.exit(failed ? 1 : 0);
