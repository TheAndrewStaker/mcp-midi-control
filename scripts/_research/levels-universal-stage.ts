/**
 * levels-universal-stage.ts — Stage the 8 Redbone (Pack 2 slots 25-32) and
 * 9 What I Got (Pack 2 slots 41-49) projects with the synth2 stored mixer
 * level set to 0, per the maintainer's 2026-07-30 universal stored-silent
 * directive: ALL synth levels store 0, no internal-voice exception; voices
 * are raised live from the mixer. synth1 is already 0 in both builds, so
 * exactly ONE byte (0x2701d, MIXER_SYNTH2_LEVEL) may change per file.
 *
 * OFFLINE ONLY. Reads the canonical authored sweeps, writes
 * samples/circuit-ncs/levels-universal-fix-2026-07-30/.
 * Asserts per file: diff vs canonical is EXACTLY the one byte at 0x2701d,
 * still structurally valid. Stops on any stray byte.
 * Model: scripts/_research/schism-levels-stage.ts (the Schism levels fix).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  setSynthLevel,
  getSynthLevel,
  checkNcsStructure,
  NCS_FILE_SIZE,
  MIXER_SYNTH2_LEVEL,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const SOURCES: { dir: string; count: number }[] = [
  { dir: 'samples/circuit-ncs/redbone-authored-2026-07-29', count: 8 },
  { dir: 'samples/circuit-ncs/whatigot-authored-2026-07-29', count: 9 },
];
const OUT = 'samples/circuit-ncs/levels-universal-fix-2026-07-30';

let failed = false;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${label}${ok ? '' : `  <-- ${detail}`}`);
  if (!ok) failed = true;
};

const diffOffsets = (a: Buffer, b: Buffer): number[] => {
  const d: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
  return d;
};

mkdirSync(OUT, { recursive: true });
let staged = 0;

for (const { dir, count } of SOURCES) {
  if (failed) break;
  const files = readdirSync(dir).filter(f => f.endsWith('.ncs')).sort();
  check(`${dir}: exactly ${count} .ncs files (got ${files.length})`, files.length === count, files.join(','));

  for (const f of files) {
    if (failed) break; // stop on any stray byte / fault
    const src = readFileSync(join(dir, f));
    check(`${f}: size ${src.length} == ${NCS_FILE_SIZE}`, src.length === NCS_FILE_SIZE, `${src.length}`);
    const s0 = checkNcsStructure(new Uint8Array(src));
    check(`${f}: source structurally valid`, s0.ok, s0.ok ? '' : s0.faults.join('; '));
    if (failed) break;

    const u8 = new Uint8Array(Buffer.from(src));
    check(`${f}: synth1 already stored-silent (0)`, getSynthLevel(u8, 1) === 0, `synth1=${getSynthLevel(u8, 1)}`);
    const prev2 = setSynthLevel(u8, 2, 0);
    check(`${f}: displaced synth2=${prev2} (expected 100)`, prev2 === 100, `prev2=${prev2}`);
    check(`${f}: read-back synth1=0 synth2=0`,
      getSynthLevel(u8, 1) === 0 && getSynthLevel(u8, 2) === 0, 'read-back mismatch');

    const out = Buffer.from(u8);
    const diffs = diffOffsets(src, out);
    const confined = diffs.length === 1 && diffs[0] === MIXER_SYNTH2_LEVEL;
    check(`${f}: diff is EXACTLY the one byte at 0x2701d`,
      confined,
      `diffs at ${diffs.slice(0, 12).map(o => '0x' + o.toString(16)).join(',')}`);

    const s1 = checkNcsStructure(new Uint8Array(out));
    check(`${f}: staged file structurally valid`, s1.ok, s1.ok ? '' : s1.faults.join('; '));

    if (failed) break;
    writeFileSync(join(OUT, f), out);
    staged++;
  }
}

console.log(failed
  ? '\nSTAGING FAILED: do not proceed to device phases.'
  : `\nStaged ${staged} files in ${OUT}. Device phases may proceed.`);
process.exit(failed ? 1 : 0);
