/**
 * schism-levels-stage.ts — Stage the 16 Schism projects (Pack 2 slots 9-24)
 * with synth1/synth2 stored mixer levels set to 0, per the maintainer's
 * 2026-07-29 instruction (repertoire convention: external gear carries the
 * synth voices; the internal engines stay stored-silent).
 *
 * OFFLINE ONLY. Reads samples/circuit-ncs/schism-authored-2026-07-29/ (the
 * verified authored state), writes samples/circuit-ncs/schism-levels-fix-2026-07-29/.
 * Asserts per file: diffs vs source confined to exactly 0x2701c..0x2701d,
 * still structurally valid. Stops on any stray byte.
 * Model: scripts/_research/afterdark-stage-condense.ts.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  setSynthLevel,
  getSynthLevel,
  checkNcsStructure,
  NCS_FILE_SIZE,
  MIXER_SYNTH1_LEVEL,
  MIXER_SYNTH2_LEVEL,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const SRC = 'samples/circuit-ncs/schism-authored-2026-07-29';
const OUT = 'samples/circuit-ncs/schism-levels-fix-2026-07-29';

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

const files = readdirSync(SRC).filter(f => f.endsWith('.ncs')).sort();
check(`source dir has exactly 16 .ncs files (got ${files.length})`, files.length === 16, files.join(','));

mkdirSync(OUT, { recursive: true });

for (const f of files) {
  if (failed) break; // stop on any stray byte / fault
  const src = readFileSync(join(SRC, f));
  check(`${f}: size ${src.length} == ${NCS_FILE_SIZE}`, src.length === NCS_FILE_SIZE, `${src.length}`);
  const s0 = checkNcsStructure(new Uint8Array(src));
  check(`${f}: source structurally valid`, s0.ok, s0.ok ? '' : s0.faults.join('; '));
  if (failed) break;

  const u8 = new Uint8Array(Buffer.from(src));
  const prev1 = setSynthLevel(u8, 1, 0);
  const prev2 = setSynthLevel(u8, 2, 0);
  check(`${f}: displaced synth1=${prev1} synth2=${prev2} (template residue expected 100/100)`,
    prev1 === 100 && prev2 === 100, `prev1=${prev1} prev2=${prev2}`);
  check(`${f}: read-back synth1=0 synth2=0`,
    getSynthLevel(u8, 1) === 0 && getSynthLevel(u8, 2) === 0, 'read-back mismatch');

  const out = Buffer.from(u8);
  const diffs = diffOffsets(src, out);
  const confined = diffs.length === 2
    && diffs.every(o => o === MIXER_SYNTH1_LEVEL || o === MIXER_SYNTH2_LEVEL);
  check(`${f}: diffs confined to exactly 0x2701c..0x2701d`,
    confined,
    `diffs at ${diffs.slice(0, 12).map(o => '0x' + o.toString(16)).join(',')}`);

  const s1 = checkNcsStructure(new Uint8Array(out));
  check(`${f}: staged file structurally valid`, s1.ok, s1.ok ? '' : s1.faults.join('; '));

  if (failed) break;
  writeFileSync(join(OUT, f), out);
}

console.log(failed
  ? '\nSTAGING FAILED: do not proceed to device phases.'
  : `\nStaged ${files.length} files in ${OUT}. Device phases may proceed.`);
process.exit(failed ? 1 : 0);
