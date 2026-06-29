/**
 * Gen-3 LIVE grid-layout read (fn=0x01 sub=0x2E).
 *
 * The modern-Fractal editors read a preset's routing grid live by sending
 * an empty-target `fn=0x01 sub=0x2E` query; the device replies with a
 * ~755-byte frame whose tail region carries a 7-bit-packed bitstream of
 * the 14-column grid. This is the LIVE counterpart to the whole-preset
 * body grid (which we decode only from a Huffman-decompressed dump) — it
 * lets a host read where every block and cable sits without pulling and
 * decompressing the entire preset.
 *
 * EVIDENCE (cross-validated, no hardware): the cell layout below was
 * contributed by the MIT-licensed `ai-tone-assistant` community project
 * (derived from its own FM9 Wireshark captures) and INDEPENDENTLY cross-validated
 * here against our own FM9 capture
 * (`samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json`,
 * model 0x12): the 10 empty-target sub=0x2E responses decode identically
 * to a coherent grid whose real-block effect IDs match `blockTypes.ts`
 * (Amp 58, Cab 62, Comp 46, Graphic EQ 50, Chorus 78, Drive 118) and
 * whose shunts (blockType 0x08) carry the documented sequential index.
 * Cross-validation against a reference oracle (our effect-ID table) clears
 * the project shipping bar; ships community-beta, awaiting a device
 * key-press to flip "untested" → "confirmed".
 *
 * SCOPE: the region offset + strides are byte-validated on FM9 (0x12).
 * The III (0x10) and FM3 (0x11) share the gen-3 codec but their grid
 * responses are not yet captured — FM3 has 4 grid rows (not 6), so its
 * region offset may differ. Pass the model byte; FM3/III runs are
 * community-beta until a capture confirms them.
 *
 * The bit reader is MSB-first within each 7-bit MIDI byte
 * (`bit -> (data[bit/7] >> (6 - bit%7)) & 1`) — the classic packing for
 * 8-bit fields carried over a 7-bit SysEx channel. Reading it with an
 * 8-bit reader yields garbage (the 0xE8/0xD8 "block-type" signature).
 */
import { fractalChecksum } from '../../shared/checksum.js';
import { AXE_FX_III_MODEL_ID, FN_PARAMETER_SETGET } from './setParam.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR_PREFIX = [0x00, 0x01, 0x74] as const;

/** FM3 model byte (4 grid rows, vs 6 for III/FM9). */
const MODEL_FM3 = 0x11;

/** fn=0x01 sub-action: read the live routing grid. */
export const SUB_ACTION_GRID_LAYOUT = 0x2e;

/** Grid geometry (FM9-validated; III shares it, FM3 has 4 rows). */
export const GRID_COLS = 14;
const GRID_REGION_OFFSET = 361; // byte offset into the mido data (after F0)
const GRID_BASE_BIT = 46; // bit offset of cell (col 0, row 0) within the region
const GRID_COL_STRIDE = 192; // bits per column (= 6 rows * 32)
const GRID_ROW_STRIDE = 32; // bits per cell row
const FIELD_BLOCK_ID = 0; // bits 0-7:  (effectId | shuntIndex) << 1
const FIELD_BLOCK_TYPE = 8; // bits 8-15: 0x08 = shunt, 0x00 = real block
const FIELD_CABLE_IN = 16; // bits 16-23: incoming-cable bitmask

const BLOCK_TYPE_SHUNT = 0x08;

// ── FM3 (model 0x11) sub=0x2E layout ──
// The FM3 grid response uses a DIFFERENT per-cell layout from the FM9/III (not just
// a region-offset shift). Decoded byte-exact from two FM3 device responses (a linear
// 12-col chain + a multi-row preset with cross-row cables): column-major 12x4, one
// 32-bit big-endian record per cell, empty cell = all zero.
//   bits 31-20 (12) = effectId (real block) | shuntIndex (shunt)
//   bits 19-16 (4)  = unused
//   bits 15-8  (8)  = type: 0x00 real block, 0x40 shunt
//   bits  7-0  (8)  = incoming-cable mask, source row r of the prior column -> bit (4+r)
// Region starts at mido bit 2568 (= wire byte 366, intra-byte bit 6).
const FM3_REGION_OFFSET = 366;
const FM3_BASE_BIT = 6;
const FM3_COL_STRIDE = 128; // 4 rows * 32
const FM3_ROW_STRIDE = 32;
const FM3_BLOCK_TYPE_SHUNT = 0x40;
const FM3_GRID_COLS = 12;
const FM3_GRID_ROWS = 4;

/** Grid rows for a model byte: 4 for FM3, 6 for III/FM9. */
function gridRowsFor(modelByte: number): number {
  return modelByte === MODEL_FM3 ? 4 : 6;
}

/**
 * One occupied grid cell from a live sub=0x2E decode.
 * `cableInputMask` bit `n` set means a cable enters this cell from row `n`
 * of the previous column (per wagahai850's decode; row indexing is the
 * raw mask — not yet field-validated against a known cabling, so it is
 * surfaced as the raw mask rather than a decoded edge list).
 */
export interface Gen3GridLayoutCell {
  row: number;
  col: number;
  /** Effect ID for a real block (undefined for a shunt). Resolve via blockTypes. */
  effectId?: number;
  /** True when the cell is a routing shunt (pass-through). */
  isShunt: boolean;
  /** Sequential shunt index (defined only for shunts). */
  shuntIndex?: number;
  /** Raw incoming-cable bitmask (bits = source rows of the prior column). */
  cableInputMask: number;
}

/**
 * Build the empty-target grid-layout query: `F0 00 01 74 <model> 01 2E 00
 * 00*13 <cks> F7` (23 bytes). Byte-exact to the FM9-Edit request captured
 * on hardware.
 */
export function buildRequestGridLayout(
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  // payload = [sub-action, 0x00, then 13 zero bytes] (empty target).
  const payload = [SUB_ACTION_GRID_LAYOUT, 0x00, ...new Array(13).fill(0x00)];
  const body = [
    SYSEX_START,
    ...FRACTAL_MFR_PREFIX,
    modelByte,
    FN_PARAMETER_SETGET,
    ...payload,
  ];
  return [...body, fractalChecksum(body), SYSEX_END];
}

/** Read `n` bits MSB-first from a 7-bit-packed byte stream. */
function readBitsMsb(data: readonly number[], bit: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const b = bit + i;
    v = (v << 1) | ((data[Math.floor(b / 7)] >> (6 - (b % 7))) & 1);
  }
  return v;
}

/**
 * Decode the live routing grid from an empty-target sub=0x2E response
 * frame (full SysEx, `F0`..`F7`). Returns only the OCCUPIED cells
 * (real blocks + shunts); empty cells are omitted.
 *
 * `modelByte` selects the row count (4 for FM3, 6 otherwise). Throws on a
 * frame too short to contain the grid region.
 */
export function parseGen3GridLayout(
  frame: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): Gen3GridLayoutCell[] {
  if (modelByte === MODEL_FM3) return parseFm3GridLayout(frame);
  // mido strips the F0 status byte; the offset 361 is into that stream.
  const mido = frame.length >= 2 && frame[0] === SYSEX_START ? frame.slice(1) : frame;
  const region = mido.slice(GRID_REGION_OFFSET);
  const rows = gridRowsFor(modelByte);
  const lastBit = GRID_BASE_BIT + (GRID_COLS - 1) * GRID_COL_STRIDE + (rows - 1) * GRID_ROW_STRIDE + FIELD_CABLE_IN + 8;
  if (region.length * 7 < lastBit) {
    throw new Error(
      `parseGen3GridLayout: frame too short for grid region (have ${region.length} region bytes, need ${Math.ceil(lastBit / 7)})`,
    );
  }
  const cells: Gen3GridLayoutCell[] = [];
  for (let col = 0; col < GRID_COLS; col++) {
    for (let row = 0; row < rows; row++) {
      const base = GRID_BASE_BIT + col * GRID_COL_STRIDE + row * GRID_ROW_STRIDE;
      const idField = readBitsMsb(region, base + FIELD_BLOCK_ID, 8) >> 1;
      const blockType = readBitsMsb(region, base + FIELD_BLOCK_TYPE, 8);
      const isShunt = blockType === BLOCK_TYPE_SHUNT;
      if (idField === 0 && !isShunt) continue; // empty cell
      cells.push({
        row,
        col,
        effectId: isShunt ? undefined : idField,
        isShunt,
        shuntIndex: isShunt ? idField : undefined,
        cableInputMask: readBitsMsb(region, base + FIELD_CABLE_IN, 8),
      });
    }
  }
  return cells;
}

/**
 * FM3 (model 0x11) sub=0x2E decode. The FM3 uses a 32-bit-per-cell, column-major
 * 12x4 layout that differs from the FM9/III bit-field grid (see the FM3_* constants
 * above). `cableInputMask` is normalized so bit `r` set = fed from row `r` of the
 * previous column. Byte-exact against two FM3 device responses.
 */
function parseFm3GridLayout(frame: readonly number[]): Gen3GridLayoutCell[] {
  const mido = frame.length >= 2 && frame[0] === SYSEX_START ? frame.slice(1) : frame;
  const region = mido.slice(FM3_REGION_OFFSET);
  const lastBit = FM3_BASE_BIT + (FM3_GRID_COLS - 1) * FM3_COL_STRIDE + (FM3_GRID_ROWS - 1) * FM3_ROW_STRIDE + 32;
  if (region.length * 7 < lastBit) {
    throw new Error(
      `parseGen3GridLayout(FM3): frame too short for grid region (have ${region.length} region bytes, need ${Math.ceil(lastBit / 7)})`,
    );
  }
  const cells: Gen3GridLayoutCell[] = [];
  for (let col = 0; col < FM3_GRID_COLS; col++) {
    for (let row = 0; row < FM3_GRID_ROWS; row++) {
      const base = FM3_BASE_BIT + col * FM3_COL_STRIDE + row * FM3_ROW_STRIDE;
      const idField = readBitsMsb(region, base, 12); // bits 31-20 of the 32-bit BE cell
      const blockType = readBitsMsb(region, base + 16, 8); // bits 15-8
      const cableByte = readBitsMsb(region, base + 24, 8); // bits 7-0
      const isShunt = blockType === FM3_BLOCK_TYPE_SHUNT;
      if (idField === 0 && !isShunt) continue; // empty cell
      cells.push({
        row,
        col,
        effectId: isShunt ? undefined : idField,
        isShunt,
        shuntIndex: isShunt ? idField : undefined,
        // FM3 packs source rows in bits 4-7; normalize so bit r = source row r.
        cableInputMask: (cableByte >> 4) & 0x0f,
      });
    }
  }
  return cells;
}
