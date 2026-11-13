/**
 * Gen-3 routing codec goldens (buildSetGridRouting, fn=0x01 sub=0x35).
 *
 * Grid sizes:
 *   Axe-Fx III: 6 rows × 14 cols (model 0x10)
 *   FM9:        6 rows × 14 cols (model 0x12)
 *   FM3:        4 rows × 12 cols (model 0x11)
 *   VP4:        serial 4-slot     (model 0x14) — no routing primitive
 *
 * One law for every grid, from the source and destination gridPos:
 *
 *   from = (srcCol - 1) * rows + (srcRow - 1)
 *   to   = srcCol * rows + (destRow - 1)
 *   b21  = from >> 1;  b22 = ((from & 1) << 6) | (to >> 2);  b23 = (to & 3) << 5
 *
 * Frame layout (26 bytes):
 *   F0 00 01 74 <model> 01 35 00 00 00 00 00 <OP> 00 00 00 00 00 00 02 00 <b21> <b22> <b23> <cs> F7
 *
 * The 6-row goldens below are every distinct sub=0x35 frame FM9-Edit sent in
 * our loopMIDI captures (`samples/captured/<file>.annotated.jsonl`), not values
 * derived from the law. Decoding each with the law above puts its destination
 * exactly one column right of its source (42/42), which a wrong law would not.
 * The 4-row goldens are the FM3-Edit captures (2026-06-05).
 */
import { createModernFractalCodec, ROUTING_OP_CONNECT, ROUTING_OP_DISCONNECT } from '../../../src/gen3/axe-fx-iii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hexStr(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function parseHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}

const FM9 = 0x12;
const III = 0x10;

const cases: Array<() => void> = [];

// ─── FM9 6-row goldens: captured FM9-Edit frames ──────────────────────────────
// [srcRow, srcCol, destRow, op, wire bytes 21..24 (b21 b22 b23 cs), capture]
const FM9_CAPTURED: ReadonlyArray<readonly [number, number, number, number, string, string]> = [
  [2, 3, 3, 1, '06 45 00 63', 'fm9-cc-routing-live'],
  [3, 3, 1, 1, '07 04 40 63', 'fm9-cc-routing-sweep'],
  [3, 3, 2, 1, '07 04 60 43', 'fm9-cc-routing-sweep'],
  [3, 3, 3, 1, '07 05 00 22', 'fm9-cc-routing-sweep'],
  [3, 3, 4, 1, '07 05 20 02', 'fm9-cc-routing-sweep'],
  [3, 3, 5, 1, '07 05 40 62', 'fm9-cc-routing-sweep'],
  [3, 3, 6, 1, '07 05 60 42', 'fm9-cc-routing-sweep'],
  [1, 2, 1, 1, '03 03 00 20', 'fm9-cc-routing-sweep'],
  [1, 2, 3, 1, '03 03 40 60', 'fm9-cc-routing-sweep'],
  [3, 1, 3, 1, '01 02 00 23', 'fm9-cc-routing-sweep'],
  [3, 2, 3, 1, '04 03 40 67', 'fm9-cc-routing-sweep'],
  [3, 4, 3, 1, '0a 06 40 6c', 'fm9-cc-routing-sweep'],
  [3, 5, 3, 1, '0d 08 00 25', 'fm9-cc-routing-sweep'],
  [1, 3, 2, 1, '06 04 60 42', 'fm9-cc-routing-sweep'],
  [1, 4, 1, 1, '09 06 00 2f', 'fm9-cc-routing-sweep'],
  [1, 4, 5, 1, '09 07 00 2e', 'fm9-cc-routing-sweep'],
  [4, 3, 1, 1, '07 44 40 23', 'fm9-cc-routing-sweep'],
  [4, 3, 3, 1, '07 45 00 62', 'fm9-cc-routing-sweep'],
  [4, 3, 6, 1, '07 45 60 02', 'fm9-cc-routing-sweep'],
  [5, 3, 1, 1, '08 04 40 6c', 'fm9-cc-routing-sweep'],
  [5, 3, 3, 1, '08 05 00 2d', 'fm9-cc-routing-sweep'],
  [5, 3, 6, 1, '08 05 60 4d', 'fm9-cc-routing-sweep'],
  [6, 3, 1, 1, '08 44 40 2c', 'fm9-cc-routing-sweep'],
  [6, 3, 3, 1, '08 45 00 6d', 'fm9-cc-routing-sweep'],
  [6, 3, 6, 1, '08 45 60 0d', 'fm9-cc-routing-sweep'],
  [1, 3, 1, 1, '06 04 40 62', 'fm9-cc-routing-sweep'],
  [1, 3, 3, 1, '06 05 00 23', 'fm9-cc-routing-sweep'],
  [1, 3, 4, 1, '06 05 20 03', 'fm9-cc-routing-sweep'],
  [1, 3, 5, 1, '06 05 40 63', 'fm9-cc-routing-sweep'],
  [1, 3, 6, 1, '06 05 60 43', 'fm9-cc-routing-sweep'],
  [2, 3, 4, 1, '06 45 20 43', 'fm9-cc-routing2-live'],
  [2, 5, 3, 1, '0c 48 00 64', 'fm9-cc-routing3-live'],
  [1, 6, 1, 1, '0f 09 00 26', 'fm9-sim-m1-2026-06-04'],
  [1, 7, 1, 1, '12 0a 40 78', 'fm9-sim-m1-2026-06-04'],
  [2, 2, 2, 2, '03 43 20 43', 'fm9-sim-m1-2026-06-04'],
  [1, 1, 1, 1, '00 01 40 61', 'fm9-sim-m1-2026-06-04'],
  [1, 1, 2, 1, '00 01 60 41', 'fm9-sim-m1-2026-06-04'],
  [2, 3, 2, 1, '06 44 60 02', 'fm9-sim-m1-2026-06-04'],
  [2, 4, 2, 1, '09 46 20 4f', 'fm9-sim-m1-2026-06-04'],
  [2, 1, 2, 2, '00 41 60 02', 'fm9-sim-m1-2026-06-04'],
  [2, 2, 2, 1, '03 43 20 40', 'fm9-sim-m1-2026-06-04'],
  [2, 3, 2, 2, '06 44 60 01', 'fm9-sim-m1-2026-06-04'],
];
for (const [srcRow, srcCol, destRow, op, tail, src] of FM9_CAPTURED) {
  cases.push(() => {
    const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow, srcCol, destRow, op });
    const want = parseHex(
      `f0 00 01 74 12 01 35 00 00 00 00 00 0${op} 00 00 00 00 00 00 02 00 ${tail} f7`,
    );
    assert(got.length === want.length && got.every((b, i) => b === want[i]),
      `FM9 r${srcRow}c${srcCol}→r${destRow}c${srcCol + 1} op ${op} (${src}): [${hexStr(got)}]`);
  });
}

// The III shares the payload; only the model byte and checksum differ.
cases.push(() => {
  const fm9 = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2 });
  const iii = createModernFractalCodec(III).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2 });
  assert(iii[4] === III, 'III model byte');
  for (let i = 0; i < fm9.length; i++) {
    if (i === 4 || i === 24) continue;
    assert(fm9[i] === iii[i], `FM9 vs III byte[${i}] should match outside model+checksum`);
  }
});

// Max column boundary on a 14-col grid: r2c13 → r2c14.
// from = 73, to = 79: b21 = 0x24, b22 = 0x40 | 0x13 = 0x53, b23 = 0x60.
cases.push(() => {
  const got = createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 13, destRow: 2 });
  assert(hexStr(got.slice(21, 24)) === '24 53 60', `FM9 r2c13→r2c14: [${hexStr(got)}]`);
});

// ─── FM3 4-row goldens (byte-confirmed FM3-Edit loopMIDI, 2026-06-05) ─────────
//
// Formula: srcGp=(srcCol-1)*4+(srcRow-1); b21=floor(srcGp/2);
//          b22=((srcGp&1)<<6)|srcCol; b23=(destRow-1)<<5
// FM3 model byte 0x11; fixed prefix XOR = 0xA0 (CONNECT).
// cs = (0xA0 ^ b21 ^ b22 ^ b23) & 0x7F  [CONNECT path]

// FM3 r2c1→r2c2 (baseline, srcGp=1): confirms 4-row formula matches Rig-A capture.
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 20 42 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c1→r2c2: [${hexStr(got)}]`);
});

// FM3 r4c1→r4c2 (srcGp=3, destRow=4 → b23=0x60): bottom row, cross-col.
// Key: b22 uses colTerm=srcCol=1 (no destSign), b23=(4-1)*32=0x60.
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 4, srcCol: 1, destRow: 4, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 41 60 03 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r4c1→r4c2: [${hexStr(got)}]`);
});

// FM3 r2c1→r4c2 (fan-out to bottom row, srcGp=1, destRow=4).
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 4, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 60 02 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c1→r4c2: [${hexStr(got)}]`);
});

// FM3 r1c1→r1c2 (row-1 odd-col, srcGp=0).
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 1, srcCol: 1, destRow: 1, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 01 00 22 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r1c1→r1c2: [${hexStr(got)}]`);
});

// FM3 r2c2→r2c3 (even srcCol, srcGp=5): key discriminator that proved 4-row formula.
// b21=2 (not 3 as 6-row predicts), b22=((1<<6)|2)=0x42, b23=0x20.
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 2, destRow: 2, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 42 20 43 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c2→r2c3: [${hexStr(got)}]`);
});

// FM3 r2c3→r2c4 (srcGp=9): b21=4 (not 6 as 6-row predicts), b22=0x43 (colTerm=srcCol=3).
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 3, destRow: 2, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 04 43 20 44 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r2c3→r2c4: [${hexStr(got)}]`);
});

// FM3 r1c2→r1c3 (row-1 even col, srcGp=4).
cases.push(() => {
  const got = createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 1, srcCol: 2, destRow: 1, rows: 4 });
  const want = parseHex('f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 02 00 23 f7');
  assert(got.length === want.length && got.every((b, i) => b === want[i]),
    `FM3 r1c2→r1c3: [${hexStr(got)}]`);
});

// ─── Model byte smoke: all gen-3 devices produce well-formed frames ───────────

// Case 16: VP4 (0x14) routing frames are not hardware-validated but must
// have correct header, model byte, and checksum. FM3 (0x11) is excluded
// here because its 4-row formula is gated by the rows≠6 guard.
function isWellFormed(bytes: number[], model: number): boolean {
  if (bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return false;
  if (bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74 || bytes[4] !== model) return false;
  let x = 0;
  for (let i = 0; i < bytes.length - 2; i++) x ^= bytes[i];
  return (x & 0x7f) === bytes[bytes.length - 2];
}
for (const [name, mb, rows] of [['III', 0x10, 6], ['FM3', 0x11, 4], ['FM9', 0x12, 6], ['VP4', 0x14, 6]] as const) {
  const nameCopy = name;
  const mbCopy = mb;
  const rowsCopy = rows;
  cases.push(() => {
    const frame = createModernFractalCodec(mbCopy).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, rows: rowsCopy });
    assert(isWellFormed(frame, mbCopy),
      `${nameCopy} routing frame well-formed: [${hexStr(frame)}]`);
    assert(frame.length === 26, `${nameCopy} routing frame length should be 26, got ${frame.length}`);
    assert(frame[5] === 0x01, `${nameCopy} fn byte should be 0x01`);
    assert(frame[6] === 0x35, `${nameCopy} sub-action should be 0x35`);
  });
}

// ─── Refusal tests ────────────────────────────────────────────────────────────

// rows=3 (invalid) throws; rows=4 and rows=6 are both valid.
cases.push(() => {
  let threw = false;
  try {
    createModernFractalCodec(0x11).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, rows: 3 });
  } catch { threw = true; }
  assert(threw, 'rows=3 (invalid) should throw');
});

// srcRow out of range.
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 0, srcCol: 1, destRow: 2 }); } catch { threw = true; }
  assert(threw, 'srcRow=0 should throw');
});
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 7, srcCol: 1, destRow: 2 }); } catch { threw = true; }
  assert(threw, 'srcRow=7 on 6-row grid should throw');
});

// destRow out of range.
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 0 }); } catch { threw = true; }
  assert(threw, 'destRow=0 should throw');
});
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 7 }); } catch { threw = true; }
  assert(threw, 'destRow=7 on 6-row grid should throw');
});

// srcCol out of range: max srcCol is 13 (destCol 14 is the boundary).
cases.push(() => {
  let threw = false;
  try { createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 14, destRow: 2 }); } catch { threw = true; }
  assert(threw, 'srcCol=14 should throw (max is 13 on a 14-col grid)');
});

// Invalid op.
cases.push(() => {
  let threw = false;
  try {
    createModernFractalCodec(FM9).buildSetGridRouting({ srcRow: 2, srcCol: 1, destRow: 2, op: 0x99 });
  } catch { threw = true; }
  assert(threw, 'op=0x99 should throw (only CONNECT=0x01 or DISCONNECT=0x02 allowed)');
});

export function runGen3RoutingTests(): void {
  for (const c of cases) c();
}
export const GEN3_ROUTING_CASE_COUNT = cases.length;
