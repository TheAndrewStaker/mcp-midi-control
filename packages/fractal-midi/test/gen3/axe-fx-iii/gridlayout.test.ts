/**
 * Gen-3 live grid-layout codec goldens (fn=0x01 sub=0x2E).
 *
 * 1. buildRequestGridLayout is byte-exact to the FM9-Edit request captured
 *    on hardware (`fm9-receive-preset-from-device-harp-2026-06-04`):
 *      f0 00 01 74 12 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 38 f7
 * 2. parseGen3GridLayout round-trips a hand-packed synthetic grid (the
 *    MSB-first 7-bit packing must invert exactly). Cell = u16 id + u16 mask
 *    from bit 45 (the preset-body cell word; corrected 2026-10-23).
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
const GRID_CELL_BIT = 45;
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

/** Pack a list of {col,row,id,mask} cells (preset-body cell words) into a full grid frame. */
function buildSyntheticFrame(cells: { col: number; row: number; id: number; mask: number }[]): number[] {
  const region = new Array(391).fill(0);
  for (const c of cells) {
    const base = GRID_CELL_BIT + c.col * GRID_COL_STRIDE + c.row * GRID_ROW_STRIDE;
    writeBitsMsb(region, base + 0, c.id & 0xff, 8); // id low byte
    writeBitsMsb(region, base + 8, c.id >> 8, 8); // id high byte
    writeBitsMsb(region, base + 16, c.mask & 0xff, 8); // mask low byte
    writeBitsMsb(region, base + 24, c.mask >> 8, 8); // mask high byte
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
    { col: 0, row: 0, id: 58, mask: 0 }, // Amp
    { col: 1, row: 0, id: 1024 + 3, mask: 0b00000001 }, // shunt #3, fed from row 0
    { col: 2, row: 1, id: 186, mask: 0b00000001 }, // Return (id > 127), fed from row 0
  ]);
  const cells = parseGen3GridLayout(frame, FM9);
  assert(cells.length === 3, `expected 3 placed cells, got ${cells.length}`);

  const amp = cells.find((c) => c.col === 0 && c.row === 0)!;
  assert(amp.effectId === 58 && !amp.isShunt, 'col0row0 should be Amp (id 58), not a shunt');

  const shunt = cells.find((c) => c.col === 1 && c.row === 0)!;
  assert(shunt.isShunt && shunt.shuntIndex === 3 && shunt.effectId === undefined, 'col1row0 should be shunt #3');
  assert(shunt.cableInputMask === 0b00000001 && shunt.fromRows.join() === '0', 'shunt cable mask round-trip');

  const ret = cells.find((c) => c.col === 2 && c.row === 1)!;
  assert(ret.effectId === 186 && ret.fromRows.join() === '0', 'col2row1 should be Return (186) fed from row 0');
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
  assert(amp?.effectId === 58 && amp.cableInputMask === 0x02 && amp.fromRows.join() === '1', `${label}: r1c1 must be Amp1 (58) fed from row 1`);
  assert(output?.effectId === 42 && output.cableInputMask === 0x02 && output.fromRows.join() === '1', `${label}: r1c2 must be Output1 (42) fed from row 1`);
}

cases.push(() => {
  assertFm3OracleGrid(parseGen3GridLayout(parseHex(FM3_FRAME_DRIVE_590), FM3), 'FM3 590B');
});

cases.push(() => {
  // The 16-byte-longer variant tail-anchors to region offset 377 (not 361)
  // and MUST decode identically — this is the length-variant rule golden.
  assertFm3OracleGrid(parseGen3GridLayout(parseHex(FM3_FRAME_AMP_606), FM3), 'FM3 606B');
});

// 7. FM3 hardware goldens (2026-10-23, mcp-midi-control grid check): replies to
//    the empty-target request after loading generated presets G04/G05 into the
//    edit buffer. Every cell must equal the cell words the generator wrote,
//    including ids > 127 (Multiplexer 191, Send 182, Return 186, Synth 130),
//    shunts 1024+n, and multi-row inputs (masks 6 and 10).
const FM3_G04_MULTIPLEXER =
  'F0 00 01 74 11 01 2E 00 00 00 00 00 00 00 00 00 00 00 00 70 03 59 40 20 00 00 04 00 00 00 ' +
  '00 00 00 00 01 15 28 38 10 48 75 12 25 08 20 23 4C 06 42 02 35 2A 4C 2A 12 2A 04 62 15 30 ' +
  '45 29 00 00 00 00 00 00 00 00 00 00 00 00 00 00 43 36 19 2C 16 71 00 40 20 10 08 04 02 01 ' +
  '00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 00 05 13 21 72 74 34 1B 24 ' +
  '04 33 05 68 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 00 26 ' +
  '19 2C 16 21 01 04 72 34 59 6D 07 21 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 ' +
  '20 10 08 04 00 02 35 52 64 10 11 6C 16 4B 38 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 ' +
  '00 40 20 10 08 04 02 01 00 40 20 00 10 6D 46 2B 05 5C 20 21 5B 6D 57 01 01 06 68 37 5C 4E ' +
  '57 19 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 00 01 14 42 10 14 69 74 62 3C 40 20 10 ' +
  '08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 00 08 47 13 25 6C ' +
  '65 10 13 0C 56 0B 10 40 42 39 1D 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 ' +
  '00 00 4C 32 58 2C 42 02 35 52 64 10 11 4B 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 ' +
  '02 01 00 40 20 10 08 00 00 00 00 00 00 12 40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 05 60 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 08 02 00 00 60 40 10 00 00 ' +
  '00 00 00 00 00 00 00 00 76 00 00 40 07 38 00 08 00 00 00 00 00 00 00 00 00 00 00 20 40 10 ' +
  '00 08 04 02 00 00 00 00 00 00 00 00 00 00 0B 78 00 0C 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 74 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1F 00 00 20 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 08 60 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02 08 00 ' +
  '02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02 02 00 40 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 0A 40 00 10 00 00 00 00 00 00 00 00 00 00 40 F7';
const FM3_G05_SYNTH_SOURCE =
  'F0 00 01 74 11 01 2E 00 00 00 00 00 46 00 00 00 00 00 00 70 03 59 40 20 00 00 04 00 00 00 ' +
  '00 00 00 00 02 70 3B 3C 10 48 75 12 25 08 20 23 4C 06 52 02 4D 32 4E 2A 12 04 05 1A 3D 2A ' +
  '52 21 51 20 00 00 00 00 00 00 00 00 00 00 00 00 43 36 19 2C 16 71 00 40 20 10 08 04 02 01 ' +
  '00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 00 05 13 21 72 74 34 1B 24 ' +
  '04 33 05 68 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 00 26 ' +
  '19 2C 16 21 01 04 72 34 59 6D 07 21 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 ' +
  '20 10 08 04 00 02 35 52 64 10 11 6C 16 4B 38 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 ' +
  '00 40 20 10 08 04 02 01 00 40 20 00 10 6D 46 2B 05 5C 20 21 5B 6D 57 01 01 06 68 37 5C 4E ' +
  '57 19 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 00 01 14 42 10 14 69 74 62 3C 40 20 10 ' +
  '08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 00 08 47 13 25 6C ' +
  '65 10 13 0C 56 0B 10 40 42 39 1D 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 ' +
  '00 00 4C 32 58 2C 42 02 35 52 64 10 11 4B 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 ' +
  '02 01 00 40 20 10 08 00 00 00 00 00 00 12 40 00 00 05 68 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 05 60 00 08 00 05 02 01 00 00 00 00 00 00 00 00 00 00 03 58 00 02 00 01 40 40 20 00 00 ' +
  '00 00 00 00 00 00 00 00 3A 00 00 40 00 38 10 08 00 00 00 00 00 00 00 00 00 00 0F 40 00 10 ' +
  '00 10 04 02 00 00 00 00 00 00 00 00 00 00 00 00 10 04 00 04 41 00 40 04 08 00 00 00 00 00 ' +
  '00 00 00 02 04 01 00 01 20 20 10 00 0D 02 02 00 00 00 00 00 00 3F 00 01 20 00 2C 08 04 00 ' +
  '00 00 00 00 00 00 00 00 00 00 20 20 08 00 46 00 01 00 00 00 00 00 00 00 00 00 00 00 0C 08 ' +
  '02 00 10 40 00 20 00 00 00 00 00 00 00 00 00 00 04 02 00 40 00 60 10 08 00 00 00 00 00 00 ' +
  '00 00 00 00 2D 40 00 10 00 54 00 02 00 00 00 00 00 00 18 F7';
const FM3_G04_EXPECTED: number[][] = [[1, 0, 37, 0], [1, 1, 46, 2], [1, 2, 1024, 2], [1, 3, 118, 2], [1, 4, 1025, 2], [1, 5, 191, 6], [1, 6, 58, 2], [1, 7, 62, 2], [1, 8, 70, 2], [1, 9, 66, 2], [1, 10, 1026, 2], [1, 11, 42, 2], [2, 2, 1027, 2], [2, 3, 119, 4], [2, 4, 1028, 4]];
const FM3_G05_EXPECTED: number[][] = [[1, 0, 37, 0], [1, 1, 46, 2], [1, 2, 118, 2], [1, 3, 58, 2], [1, 4, 62, 2], [1, 5, 1024, 2], [1, 6, 1025, 2], [1, 7, 126, 10], [1, 8, 1026, 2], [1, 9, 1027, 2], [1, 10, 1028, 2], [1, 11, 182, 2], [2, 0, 186, 0], [2, 1, 1029, 4], [2, 2, 1030, 4], [2, 3, 1031, 4], [2, 4, 1032, 4], [2, 5, 1033, 4], [2, 6, 1034, 4], [2, 7, 1035, 4], [2, 8, 70, 4], [2, 9, 66, 4], [2, 10, 1036, 4], [2, 11, 42, 4], [3, 5, 130, 0], [3, 6, 1037, 8]];

function assertGrid(frameHex: string, expected: number[][], label: string): void {
  const got = parseGen3GridLayout(parseHex(frameHex), FM3).map((c) => [c.row, c.col, c.isShunt ? 1024 + (c.shuntIndex ?? 0) : (c.effectId ?? 0), c.cableInputMask]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert(JSON.stringify(got) === JSON.stringify(expected), `${label}: grid mismatch\n  exp ${JSON.stringify(expected)}\n  got ${JSON.stringify(got)}`);
}

cases.push(() => assertGrid(FM3_G04_MULTIPLEXER, FM3_G04_EXPECTED, 'FM3 G04'));
cases.push(() => {
  assertGrid(FM3_G05_SYNTH_SOURCE, FM3_G05_EXPECTED, 'FM3 G05');
  const cells = parseGen3GridLayout(parseHex(FM3_G05_SYNTH_SOURCE), FM3);
  const mixer = cells.find((c) => c.row === 1 && c.col === 7)!;
  assert(mixer.effectId === 126 && mixer.fromRows.join() === '1,3', 'G05 Mixer merges rows 1 and 3');
  const synth = cells.find((c) => c.row === 3 && c.col === 5)!;
  assert(synth.effectId === 130 && synth.fromRows.length === 0, 'G05 Synth (130) has no input');
});

export function runGen3GridLayoutTests(): void {
  for (const c of cases) c();
}
export const GEN3_GRIDLAYOUT_CASE_COUNT = cases.length;
