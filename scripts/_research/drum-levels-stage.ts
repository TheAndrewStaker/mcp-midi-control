/**
 * drum-levels-stage.ts — Stage every live campaign project whose stored DRUM
 * mixer levels are nonzero with all four set to 0, per the maintainer's
 * 2026-07-30 correction: the universal stored-silent rule covers DRUM levels
 * too, not just synths. The condensed internal drum layer is a silent blend he
 * raises by hand; it must never double the SPD-SX unasked.
 *
 * The urgent case is Breakdown (Pack 5, 35-39): its binding is [0,1,2,3] and
 * today's Clint re-author SEEDED Pack 5's sample pool (wire 1 kick2 / 2 snr /
 * 5 hatC / 11 ride), so Drum2/Drum3 — which had nothing to play when the pool
 * held one sample — now play kick2 and snr at level 100.
 *
 * OFFLINE ONLY. Reads the fresh device scan, writes staged/.
 * Asserts per file: every diff vs the scan lies in the FOUR drum-level offsets
 * (0x26fbd + n*11), the changed set equals exactly the offsets that were
 * nonzero, all four read back 0, and checkNcsStructure still passes.
 * Stops on the first stray byte. Model: levels-universal-stage.ts.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getDrumLevel,
  setDrumLevels,
  drumLevelOffset,
  checkNcsStructure,
  getProjectName,
  NCS_FILE_SIZE,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const SCAN = 'samples/circuit-ncs/drumlevels-2026-07-30/scan';
const OUT = 'samples/circuit-ncs/drumlevels-2026-07-30/staged';

/** The 30 live, campaign-owned projects the audit found nonzero. */
const TARGETS: ReadonlySet<string> = new Set([
  '2/1', '2/4', '2/5',                                // After Dark
  '2/17', '2/18', '2/19',                             // Schism interludes
  '2/33',                                             // Brain Stew 1 Solo (partial: drum1 already 0)
  '5/9', '5/10', '5/11', '5/12',                      // Amber
  '5/19', '5/20', '5/21', '5/22', '5/23', '5/24', '5/25', // I Believe
  '5/35', '5/36', '5/37', '5/38', '5/39',             // Breakdown  <-- the audible defect
  '5/57', '5/58', '5/59', '5/60', '5/61', '5/62', '5/63', // The Offering
]);

const LEVEL_OFFSETS = [0, 1, 2, 3].map(drumLevelOffset);

let failed = false;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${label}${ok ? '' : `  <-- ${detail}`}`);
  if (!ok) failed = true;
};

const diffOffsets = (a: Buffer, b: Buffer): number[] => {
  const d: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
  return d;
};

mkdirSync(OUT, { recursive: true });

const FN_RE = /-pack(\d+)-project(\d+)-/;
const files = readdirSync(SCAN).filter(f => f.endsWith('.ncs')).sort();
const seen = new Set<string>();
let staged = 0;

for (const f of files) {
  if (failed) break;
  const m = FN_RE.exec(f);
  if (!m) { check(`${f}: filename carries pack+project`, false, 'unparsed'); break; }
  const pack = Number(m[1]);
  const slot = Number(m[2]);
  const key = `${pack}/${slot}`;
  if (!TARGETS.has(key)) continue;
  if (seen.has(key)) { check(`${key}: exactly one scan file`, false, `duplicate ${f}`); break; }
  seen.add(key);

  const src = readFileSync(join(SCAN, f));
  check(`${key}: size ${src.length} == ${NCS_FILE_SIZE}`, src.length === NCS_FILE_SIZE, `${src.length}`);
  if (failed) break;
  const s0 = checkNcsStructure(new Uint8Array(src));
  check(`${key}: source structurally valid`, s0.ok, s0.faults.join('; '));
  if (failed) break;

  const u8 = new Uint8Array(Buffer.from(src));
  const name = getProjectName(u8);
  const before = [0, 1, 2, 3].map(t => getDrumLevel(u8, t));
  const expected = LEVEL_OFFSETS.filter((_, t) => before[t] !== 0);
  check(`${key} "${name}": at least one drum level nonzero (${before.join('/')})`,
    expected.length > 0, 'nothing to do — audit and file disagree');
  if (failed) break;

  setDrumLevels(u8, [0, 0, 0, 0]);
  const after = [0, 1, 2, 3].map(t => getDrumLevel(u8, t));
  check(`${key}: read-back 0/0/0/0`, after.every(v => v === 0), after.join('/'));

  const out = Buffer.from(u8);
  const diffs = diffOffsets(src, out);
  const confined = diffs.length === expected.length && diffs.every((o, i) => o === expected[i]);
  check(`${key}: diff confined to the ${expected.length} drum-level byte(s) ${expected.map(o => '0x' + o.toString(16)).join(',')}`,
    confined, `diffs at ${diffs.slice(0, 12).map(o => '0x' + o.toString(16)).join(',')}`);

  const s1 = checkNcsStructure(new Uint8Array(out));
  check(`${key}: staged file structurally valid`, s1.ok, s1.faults.join('; '));
  if (failed) break;

  writeFileSync(join(OUT, `pack${pack}-proj${String(slot).padStart(2, '0')}.ncs`), out);
  console.log(`     staged pack${pack}/${slot} "${name}"  ${before.join('/')} -> 0/0/0/0`);
  staged++;
}

const missing = [...TARGETS].filter(k => !seen.has(k));
check(`all ${TARGETS.size} targets found in the scan`, missing.length === 0, `missing ${missing.join(', ')}`);

console.log(failed
  ? '\nSTAGING FAILED: do not proceed to device phases.'
  : `\nStaged ${staged} files in ${OUT}. Device phases may proceed.`);
process.exit(failed ? 1 : 0);
