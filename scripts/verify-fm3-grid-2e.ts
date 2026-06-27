/**
 * Gate: the FM3 (model 0x11) sub=0x2E live-grid decode must reproduce a known
 * device capture exactly. Frame below is an empty-target sub=0x2E response from a
 * real FM3 (fw 12.0) for the factory-style preset "Harmonic Voltage" — a multi-row
 * layout with parallel rows and cross-row cables. The expected cells are the
 * ground truth from the same preset's whole-preset dump decode.
 *
 * A regression in parseGen3GridLayout's FM3 branch (offset/stride/field/cable-mask)
 * fails here instead of silently shipping a wrong grid.
 */
import { parseGen3GridLayout } from '../packages/fractal-midi/src/gen3/axe-fx-iii/gridLayout.js';

const MODEL_FM3 = 0x11;

// Raw sub=0x2E response (F0..F7), FM3 fw 12.0, preset "Harmonic Voltage".
const FRAME = (
  'f0 00 01 74 11 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 70 03 53 00 20 00 00 00 00 00 00 00 00 00 00 03 6c 76 58 10 29 06 0b 49 5a 6f 37 1a 2c 32 02 59 5e 6c 3a 18 2c 76 29 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 00 49 37 1d 0e 26 79 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 00 04 6b 05 52 6e 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 00 29 5e 2d 67 23 20 40 32 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 00 02 4d 5e 6c 37 48 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 00 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 00 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 00 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 00 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 00 00 00 00 00 00 00 00 00 00 01 14 00 00 00 00 00 00 00 00 00 00 00 00 07 20 00 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 40 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 09 10 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 7c 00 02 00 10 20 00 10 00 00 00 00 00 00 00 00 00 00 39 40 01 40 00 00 00 00 00 13 40 00 20 00 00 00 00 00 00 00 00 00 00 32 00 01 00 00 00 00 00 00 00 00 00 00 02 18 00 09 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 42 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 0b 60 00 20 00 00 00 00 00 00 00 00 00 00 00 00 00 00 07 50 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 54 00 02 00 00 00 00 00 00 59 f7'
)
  .trim()
  .split(/\s+/)
  .map((x) => parseInt(x, 16));

// Ground truth (col, row, eid, isShunt, fromRows) from the whole-preset dump decode.
const EXPECTED = [
  [0, 2, 37, false, []],
  [1, 1, 58, false, [2]],
  [2, 2, 0, true, [1]],
  [3, 2, 146, false, [2]],
  [4, 2, 62, false, [2]],
  [4, 3, 130, false, [2]],
  [5, 2, 115, false, [2, 3]],
  [6, 0, 78, false, [2]],
  [6, 3, 50, false, [2]],
  [7, 2, 70, false, [0, 3]],
  [8, 2, 66, false, [2]],
  [9, 2, 47, false, [2]],
  [10, 2, 122, false, [2]],
  [11, 2, 42, false, [2]],
] as const;

const cells = parseGen3GridLayout(FRAME, MODEL_FM3);
const got = new Map(cells.map((c) => [`${c.col},${c.row}`, c]));
const fromRowsOf = (mask: number) => {
  const rs: number[] = [];
  for (let r = 0; r < 4; r++) if (mask & (1 << r)) rs.push(r);
  return rs;
};

let failed = 0;
function check(label: string, cond: boolean, detail: string) {
  if (cond) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label} (${detail})`);
    failed++;
  }
}

check(`cell count = ${EXPECTED.length}`, cells.length === EXPECTED.length, `got ${cells.length}`);
for (const [col, row, eid, isShunt, fromRows] of EXPECTED) {
  const c = got.get(`${col},${row}`);
  const id = c ? (c.isShunt ? c.shuntIndex : c.effectId) : undefined;
  const fr = c ? fromRowsOf(c.cableInputMask) : [];
  const ok = !!c && c.isShunt === isShunt && id === eid && JSON.stringify(fr) === JSON.stringify(fromRows);
  check(
    `c${col} r${row}: ${isShunt ? `shunt#${eid}` : `eid ${eid}`} fromRows=[${fromRows}]`,
    ok,
    c ? `got ${c.isShunt ? `shunt#${c.shuntIndex}` : `eid ${c.effectId}`} fromRows=[${fr}]` : 'missing',
  );
}

if (failed > 0) {
  console.error(`\nverify-fm3-grid-2e: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nverify-fm3-grid-2e: all checks passed (FM3 sub=0x2E decode byte-exact vs device capture)');
