/**
 * afterdark-stage-condense.ts — Phase 0 of the After Dark 8→5 relocation.
 *
 * OFFLINE ONLY: reads the 2026-07-29 card backup, stages five .ncs files with
 * only the name (0x10..0x2f) and colour (0x0c..0x0f) fields changed, and
 * asserts (a) the plan's byte-identity premises against the backup and (b)
 * that each staged file differs from its source ONLY inside those two windows.
 * Touches no device. Plan: docs/_private/rig/songs/after-dark-rebuild-plan-2026-07-29.md
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyProjectColour, PROJECT_COLOURS, NCS_FILE_SIZE, checkNcsStructure } from '../../packages/circuit-tracks/src/ncs/format.js';

const SRC = 'samples/circuit-ncs/card-backup-2026-07-29/pack2';
const OUT = 'samples/circuit-ncs/afterdark-condense-2026-07-29';
const NAME_OFF = 0x10, NAME_LEN = 32;
const COLOUR_LO = 0x0c, COLOUR_HI = 0x0f;

const read = (f: string): Buffer => {
  const b = readFileSync(join(SRC, f));
  if (b.length !== NCS_FILE_SIZE) throw new Error(`${f}: ${b.length} bytes, want ${NCS_FILE_SIZE}`);
  const s = checkNcsStructure(new Uint8Array(b));
  if (!s.ok) throw new Error(`${f}: structurally invalid: ${s.faults.join('; ')}`);
  return b;
};

const diffOffsets = (a: Buffer, b: Buffer): number[] => {
  const d: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
  return d;
};

let failed = false;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${label}${ok ? '' : `  <-- ${detail}`}`);
  if (!ok) failed = true;
};

// ── Premise checks (section 0 of the plan) ─────────────────────────────
const p1 = read('proj01__00_SESSION.ncs'), p2 = read('proj02__01_SESSION.ncs');
const p3 = read('proj03__02_SESSION.ncs'), p4 = read('proj04__03_SESSION.ncs');
const p5 = read('proj05__04_SESSION.ncs'), p6 = read('proj06__05_SESSION.ncs');
const p7 = read('proj07__06_SESSION.ncs'), p8 = read('proj08__07_SESSION.ncs');

const d35 = diffOffsets(p3, p5), d38 = diffOffsets(p3, p8);
check('premise: P3 vs P5 differ at exactly [0x1b]', d35.length === 1 && d35[0] === 0x1b, `diffs at ${d35.slice(0, 12).map(o => '0x' + o.toString(16)).join(',')}`);
check('premise: P3 vs P8 differ at exactly [0x1b]', d38.length === 1 && d38[0] === 0x1b, `diffs at ${d38.slice(0, 12).map(o => '0x' + o.toString(16)).join(',')}`);

const P24_EXPECT = new Set([0x1b, 0x2cd, 0x1a5fc, 0x1b2a4, 0x1bf4c, 0x1cbf4, 0x1d89c, 0x1e544, 0x1f1ec, 0x1fe94]);
const d24 = diffOffsets(p2, p4);
check('premise: P2 vs P4 differ at exactly the 10 plan-listed bytes',
  d24.length === 10 && d24.every(o => P24_EXPECT.has(o)),
  `got ${d24.length} diffs: ${d24.slice(0, 14).map(o => '0x' + o.toString(16)).join(',')}`);

// ── Staging ────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const RED = PROJECT_COLOURS.findIndex(c => /red/i.test(c));
check(`palette: Red resolves to index 0 (got ${RED})`, RED === 0, 'palette table changed?');

const stage = (outName: string, src: Buffer, srcLabel: string, projName: string) => {
  const buf = Buffer.from(src);
  const name = Buffer.from(projName.padEnd(NAME_LEN, ' '), 'ascii');
  if (name.length !== NAME_LEN) throw new Error(`name too long: "${projName}"`);
  name.copy(buf, NAME_OFF);
  const u8 = new Uint8Array(buf);
  applyProjectColour(u8, 'Red');
  const out = Buffer.from(u8);
  // window assertion: diffs confined to 0x0c..0x0f and 0x10..0x2f
  const outside = diffOffsets(src, out).filter(o => !(o >= COLOUR_LO && o <= COLOUR_HI) && !(o >= NAME_OFF && o < NAME_OFF + NAME_LEN));
  check(`stage ${outName} <- ${srcLabel}: diffs confined to colour+name windows`, outside.length === 0,
    `stray diffs at ${outside.slice(0, 8).map(o => '0x' + o.toString(16)).join(',')}`);
  const s = checkNcsStructure(new Uint8Array(out));
  check(`stage ${outName}: still structurally valid`, s.ok, s.faults.join('; '));
  writeFileSync(join(OUT, outName), out);
};

stage('slot1_intro.ncs', p1, 'P1', 'AfterDark Intro');
stage('slot2_verse.ncs', p2, 'P2', 'AfterDark Verse');
stage('slot3_chorus.ncs', p3, 'P3', 'AfterDark Chorus');
stage('slot4_break.ncs', p6, 'P6', 'AfterDark Break');
stage('slot5_bridge.ncs', p7, 'P7', 'AfterDark Bridge');

console.log(failed ? '\nSTAGING FAILED: do not proceed to device phases.' : `\nStaged 5 files in ${OUT}. Phase 0 complete; device phases may proceed.`);
process.exit(failed ? 1 : 0);
