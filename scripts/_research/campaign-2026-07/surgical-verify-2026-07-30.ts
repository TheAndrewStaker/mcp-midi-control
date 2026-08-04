/**
 * SURGICAL PASS 2026-07-30 — final verification.
 *
 *  A. Each of the 19 target slots, downloaded from the device, must be
 *     BYTE-IDENTICAL to its staged image (full file, all 160,780 bytes).
 *  B. Each target must still differ from its ORIGINAL canonical image only
 *     inside {0x0c..0x0f} u {0x10..0x2f} u {0x2701c..0x2701d}, and must still
 *     pass checkNcsStructure. This is the "no content moved" proof, restated
 *     against the device rather than against the staging buffer.
 *  C. The three neighbour samples (Stranglehold 1, Clint 27, Sugar 46) must be
 *     byte-identical to their own authored canonicals — nothing splashed.
 *
 * Usage: npx tsx samples/_scratch/surgical-verify-2026-07-30.ts <scanDir> <neighbourDir>
 */
import { readFileSync, readdirSync } from 'node:fs';
import {
  PROJECT_COLOUR_OFFSET, PROJECT_NAME_OFFSET, PROJECT_NAME_LEN,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, getProjectName, projectColourName, checkNcsStructure,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const [scanDir, neighbourDir] = process.argv.slice(2);
if (scanDir === undefined || neighbourDir === undefined) { console.error('usage: <scanDir> <neighbourDir>'); process.exit(2); }

const STAGED = 'samples/circuit-ncs/surgical-pass-verify-2026-07-30/staged';
const CANON = 'samples/circuit-ncs/card-backup-2026-07-29/pack5';
const SLOTS = [19, 20, 21, 22, 23, 24, 25, 35, 36, 37, 38, 39, 57, 58, 59, 60, 61, 62, 63];

const ALLOWED: Array<[number, number]> = [
  [0x0c, 0x0f],
  [PROJECT_NAME_OFFSET, PROJECT_NAME_OFFSET + PROJECT_NAME_LEN - 1],
  [MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL],
];
const allowed = (i: number): boolean => ALLOWED.some(([a, b]) => i >= a && i <= b);

const pick = (dir: string, slot: number): Buffer => {
  const hit = readdirSync(dir).filter((f) => new RegExp(`-project0?${slot}-`).test(f)).sort();
  if (hit.length === 0) throw new Error(`no file for slot ${slot} in ${dir}`);
  return readFileSync(`${dir}/${hit[hit.length - 1]}`);
};
const diffCount = (a: Uint8Array, b: Uint8Array): number => {
  let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n;
};

let fail = 0;

console.log('=== A/B: 19 targets, device vs staged, and device vs original canonical ===');
console.log('slot | name             | colour  | lvls | vs staged | vs canonical (stray outside windows) | struct');
for (const slot of SLOTS) {
  const dev = pick(scanDir, slot);
  const staged = readFileSync(`${STAGED}/pack5-proj${String(slot).padStart(2, '0')}.ncs`);
  const canon = readFileSync(`${CANON}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`);

  const vsStaged = diffCount(dev, staged);
  let inWindow = 0; let stray = 0; let strayAt = -1;
  for (let i = 0; i < dev.length; i++) {
    if (dev[i] === canon[i]) continue;
    if (allowed(i)) inWindow++; else { stray++; if (strayAt === -1) strayAt = i; }
  }
  const st = checkNcsStructure(dev);
  const ok = vsStaged === 0 && stray === 0 && st.ok;
  if (!ok) fail++;
  console.log(
    `${String(slot).padStart(4)} | ${getProjectName(dev).padEnd(16)} | ${projectColourName(dev[PROJECT_COLOUR_OFFSET]).padEnd(7)} | ` +
    `${dev[MIXER_SYNTH1_LEVEL]}/${dev[MIXER_SYNTH2_LEVEL]}  | ` +
    `${(vsStaged === 0 ? 'IDENTICAL' : `${vsStaged} DIFF`).padEnd(9)} | ` +
    `${String(inWindow).padStart(3)} in-window, ${stray} stray${stray ? ` @0x${strayAt.toString(16)}` : ''}`.padEnd(36) +
    ` | ${st.ok ? 'ok' : st.faults.join(';')}${ok ? '' : '   <-- FAIL'}`,
  );
}

console.log('\n=== C: neighbour samples vs their authored canonicals ===');
const NEIGHBOURS: Array<{ slot: number; dir: string; label: string }> = [
  { slot: 1, dir: 'samples/circuit-ncs/stranglehold-authored-2026-07-30', label: 'Stranglehold 1' },
  { slot: 27, dir: 'samples/circuit-ncs/clint-authored-2026-07-30', label: 'Clint 27' },
  { slot: 46, dir: 'samples/circuit-ncs/sugar-authored-2026-07-30', label: 'Sugar 46' },
];
for (const n of NEIGHBOURS) {
  const dev = pick(neighbourDir, n.slot);
  const canon = pick(n.dir, n.slot);
  const d = diffCount(dev, canon);
  if (d !== 0) fail++;
  console.log(`${n.label.padEnd(16)} slot ${String(n.slot).padStart(2)}: ${d === 0 ? 'BYTE-IDENTICAL' : `${d} DIFF BYTES  <-- FAIL`}  (name "${getProjectName(dev)}", ${projectColourName(dev[PROJECT_COLOUR_OFFSET])})`);
}

console.log(fail === 0 ? '\nVERIFY PASSED: 19/19 targets identical to staged, zero content bytes moved, 3/3 neighbours untouched.' : `\n${fail} FAILURE(S).`);
process.exit(fail === 0 ? 0 : 1);
