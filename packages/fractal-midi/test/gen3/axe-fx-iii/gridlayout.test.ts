/**
 * Gen-3 live grid-layout codec goldens (fn=0x01 sub=0x2E).
 *
 * 1. buildRequestGridLayout is byte-exact to the FM9-Edit request captured
 *    on hardware (`fm9-receive-preset-from-device-harp-2026-06-04`):
 *      f0 00 01 74 12 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 38 f7
 * 2. parseGen3GridLayout round-trips a hand-packed synthetic grid (the
 *    MSB-first 7-bit packing must invert exactly).
 * 3. FM3 goldens: two real checksum-valid frames from
 *    `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json`
 *    (job3; block-targeted sub=0x2E replies, 590 + 606 bytes) decode to the
 *    grid the device's own fn=0x13 status dump names for that preset:
 *    Input1(37)@r1c0 -> Amp1(58)@r1c1 -> Output1(42)@r1c2. These lock the
 *    FM3 4x12 geometry AND the tail-anchored region rule (the 606-byte
 *    length variant shifts the region 361 -> 377 and must decode the same).
 *
 * The real-capture cross-validation (10 responses → coherent grid whose
 * effect IDs match blockTypes.ts) runs in `scripts/verify-gen3-grid-layout.ts`
 * against the gitignored sample when present.
 */
import {
  buildRequestGridLayout,
  parseGen3GridLayout,
  AXE_FX_III_MODEL_ID,
} from '../../../src/gen3/axe-fx-iii/index.js';

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
const GRID_REGION_OFFSET = 361;
const GRID_BASE_BIT = 46;
const GRID_COL_STRIDE = 192;
const GRID_ROW_STRIDE = 32;

/** MSB-first bit writer into a 7-bit-packed byte stream (inverse of the reader). */
function writeBitsMsb(region: number[], bit: number, value: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = bit + i;
    const idx = Math.floor(b / 7);
    const pos = 6 - (b % 7);
    const v = (value >> (n - 1 - i)) & 1;
    region[idx] = (region[idx] ?? 0) | (v << pos);
  }
}

/** Pack a list of {col,row,id,type,cable} cells into a full grid frame. */
function buildSyntheticFrame(
  cells: { col: number; row: number; id: number; type: number; cable: number }[],
): number[] {
  const region = new Array(391).fill(0);
  for (const c of cells) {
    const base = GRID_BASE_BIT + c.col * GRID_COL_STRIDE + c.row * GRID_ROW_STRIDE;
    writeBitsMsb(region, base + 0, c.id << 1, 8); // bits 0-7: id<<1
    writeBitsMsb(region, base + 8, c.type, 8); // bits 8-15: block type
    writeBitsMsb(region, base + 16, c.cable, 8); // bits 16-23: cable mask
  }
  const filler = new Array(GRID_REGION_OFFSET).fill(0);
  // Trailing 0x00 stands in for the checksum byte: the parser tail-anchors
  // the region against the final [checksum, F7] pair (it does not verify
  // the checksum value).
  return [0xf0, ...filler, ...region, 0x00, 0xf7];
}

const cases: Array<() => void> = [];

// 1. Request byte-exact (FM9), captured on hardware.
cases.push(() => {
  const expected = 'f0 00 01 74 12 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 38 f7';
  const got = buildRequestGridLayout(FM9);
  assert(got.length === 23, `grid request must be 23 bytes, got ${got.length}`);
  assert(
    hexStr(got) === hexStr(parseHex(expected)),
    `grid request mismatch:\n  exp ${expected}\n  got ${hexStr(got)}`,
  );
});

// 2. Request for III (different model byte → different checksum, still 23 bytes).
cases.push(() => {
  const got = buildRequestGridLayout(AXE_FX_III_MODEL_ID);
  assert(got.length === 23, 'III grid request must be 23 bytes');
  assert(got[4] === AXE_FX_III_MODEL_ID, 'III grid request model byte');
  assert(got[5] === 0x01 && got[6] === 0x2e, 'III grid request fn/sub');
});

// 3. Parse round-trips a hand-packed grid (real block, shunt, cable mask).
cases.push(() => {
  const frame = buildSyntheticFrame([
    { col: 0, row: 0, id: 58, type: 0x00, cable: 0 }, // Amp
    { col: 1, row: 0, id: 3, type: 0x08, cable: 0b00000010 }, // shunt #3
    { col: 2, row: 1, id: 46, type: 0x00, cable: 0b00000100 }, // Comp
  ]);
  const cells = parseGen3GridLayout(frame, FM9);
  assert(cells.length === 3, `expected 3 placed cells, got ${cells.length}`);

  const amp = cells.find((c) => c.col === 0 && c.row === 0)!;
  assert(amp.effectId === 58 && !amp.isShunt, 'col0row0 should be Amp (id 58), not a shunt');

  const shunt = cells.find((c) => c.col === 1 && c.row === 0)!;
  assert(shunt.isShunt && shunt.shuntIndex === 3 && shunt.effectId === undefined, 'col1row0 should be shunt #3');
  assert(shunt.cableInputMask === 0b00000010, 'shunt cable mask round-trip');

  const comp = cells.find((c) => c.col === 2 && c.row === 1)!;
  assert(comp.effectId === 46 && comp.cableInputMask === 0b00000100, 'col2row1 should be Comp with cable mask 4');
});

// 4. Empty cells are omitted.
cases.push(() => {
  const cells = parseGen3GridLayout(buildSyntheticFrame([]), FM9);
  assert(cells.length === 0, 'an empty grid yields zero cells');
});

// 5. Too-short frame throws (no silent partial decode).
cases.push(() => {
  let threw = false;
  try {
    parseGen3GridLayout([0xf0, 0x00, 0x01, 0xf7], FM9);
  } catch {
    threw = true;
  }
  assert(threw, 'a frame too short for the grid region must throw');
});

// 6. FM3 real-capture goldens (fm3-community-2026-06-12, job3): both frames —
//    including the 606-byte length variant — decode to the fn=0x13 oracle grid.
const FM3 = 0x11;
const FM3_FRAME_DRIVE_590 =
  'F0 00 01 74 11 01 2E 00 76 00 00 00 3A 00 00 00 00 00 00 70 03 5B 00 20 00 00 04 00 00 00 ' +
  '00 00 00 00 00 48 3E 45 10 28 36 63 05 6A 64 32 50 2E 57 23 3D 5A 61 3A 19 2C 45 13 55 5C ' +
  '20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 00 53 31 59 2D 66 29 44 40 20 10 08 04 02 01 ' +
  '00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 12 40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 07 20 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 28 00 02 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 4C F7';
const FM3_FRAME_AMP_606 =
  'F0 00 01 74 11 01 2E 00 3A 00 0A 00 3A 00 00 00 00 00 00 70 03 5B 00 20 00 00 04 00 00 00 ' +
  '00 00 00 00 02 26 28 45 10 28 36 63 05 6A 64 32 50 2E 57 23 3D 5A 61 3A 19 2C 45 13 55 5C ' +
  '20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 00 53 31 59 2D 66 29 44 40 20 10 08 04 02 01 ' +
  '00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 12 ' +
  '40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 07 20 00 08 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 01 28 00 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 70 F7';

function assertFm3OracleGrid(cells: ReturnType<typeof parseGen3GridLayout>, label: string): void {
  assert(cells.length === 3, `${label}: expected the 3-cell oracle grid, got ${cells.length}`);
  const at = (row: number, col: number) => cells.find((c) => c.row === row && c.col === col);
  const input = at(1, 0)!;
  const amp = at(1, 1)!;
  const output = at(1, 2)!;
  assert(input?.effectId === 37 && !input.isShunt && input.cableInputMask === 0, `${label}: r1c0 must be Input1 (37)`);
  assert(amp?.effectId === 58 && amp.cableInputMask === 0x04, `${label}: r1c1 must be Amp1 (58) cable 0x04`);
  assert(output?.effectId === 42 && output.cableInputMask === 0x04, `${label}: r1c2 must be Output1 (42) cable 0x04`);
}

cases.push(() => {
  assertFm3OracleGrid(parseGen3GridLayout(parseHex(FM3_FRAME_DRIVE_590), FM3), 'FM3 590B');
});

cases.push(() => {
  // The 16-byte-longer variant tail-anchors to region offset 377 (not 361)
  // and MUST decode identically — this is the length-variant rule golden.
  assertFm3OracleGrid(parseGen3GridLayout(parseHex(FM3_FRAME_AMP_606), FM3), 'FM3 606B');
});

export function runGen3GridLayoutTests(): void {
  for (const c of cases) c();
}
export const GEN3_GRIDLAYOUT_CASE_COUNT = cases.length;
