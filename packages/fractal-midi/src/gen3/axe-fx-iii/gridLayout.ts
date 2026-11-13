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
 * SCOPE: the strides are byte-validated on FM9 (0x12) and FM3 (0x11); the
 * III (0x10) shares the gen-3 codec (community-beta until a capture confirms).
 * FM3 geometry is 4 rows x 12 cols (vs 6 x 14 on III/FM9) and was pinned
 * offline against `samples/captured/fm3-community-2026-06-12/
 * fm3-probe-output.json` (job3, three checksum-valid sub=0x2E replies,
 * 590 + 606 bytes): the decoded grid — Input1(37)@r1c0 -> Amp1(58)@r1c1 ->
 * Output1(42)@r1c2 — exactly matches the device's own fn=0x13 status dump
 * from the same session (the placement oracle).
 *
 * The grid region is TAIL-ANCHORED, not at a fixed offset: it is the last
 * `ceil((46 + cols*rows*32) / 7)` bytes before the trailing checksum. That
 * rule reproduces the known FM9 offset (755-byte frame -> 361) AND both FM3
 * frame lengths (590 -> 361, 606 -> 377), so length variants decode without
 * per-length special cases.
 *
 * Block-targeted sub=0x2E replies (effectId/paramId populated in the target
 * region) carry the SAME layout — preset name, meters, and the grid tail.
 * The earlier "block-targeted = preset-name frame, NOT a grid" reading
 * (FM9, 2026-06-19) was vacuously true: that session's scratch preset had an
 * all-zero grid region. The FM3 frames above are block-targeted and carry
 * the full oracle-matched grid, so this parser accepts both request shapes.
 *
 * The bit reader is MSB-first within each 7-bit MIDI byte
 * (`bit -> (data[bit/7] >> (6 - bit%7)) & 1`) — the classic packing for
 * 8-bit fields carried over a 7-bit SysEx channel. Reading it with an
 * 8-bit reader yields garbage (the 0xE8/0xD8 "block-type" signature).
 *
 * CELL WORD (corrected 2026-10-23, FM3 hardware): each 32-bit cell is the
 * preset-body grid cell itself, starting ONE bit earlier than the original
 * community layout: `u16 id` (low byte, high byte) + `u16 input mask`
 * (low byte, high byte), from bit `45 + col*rows*32 + row*32`. The id is the
 * effect ID, or `1024 + n` for shunt n; the mask's bit k = input from row k of
 * the previous column. The earlier reading (8 bits at bit 46, `>> 1`, a
 * "type" byte 0x08, mask at bit 62) is the same bits shifted by one: it
 * agrees for ids < 128 but misreads every id > 127 (Send 182 -> 54,
 * Return 186 -> 58, Plex 178 -> 50, Multiplexer 191 -> 63, Synth 130 -> 2)
 * and reports the mask doubled (row 1 -> 0x04). Evidence: 7 generated FM3
 * grids (splits, merges, 4 rows, ids up to 1037) loaded to the edit buffer
 * read back identical in all 48 cells (`docs/research/evidence/fm3/fm3-grid-check-20261023.json`
 * + `-results.jsonl`, from an FM3 owner's fork, Apache-2.0); the mask
 * semantics match 384 FM3 factory preset grids (4801 cells) and an FM9 fw 12
 * field report's route_flag values. The III shares the frame layout.
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

/** Grid columns on III/FM9 (6-row devices). FM3 is 4 x 12 — see gridColsFor. */
export const GRID_COLS = 14;
const GRID_BASE_BIT = 46; // region sizing constant (unchanged; see header)
const GRID_CELL_BIT = 45; // first bit of cell (col 0, row 0): u16 id + u16 mask
const GRID_ROW_STRIDE = 32; // bits per cell row
// The region sits at the TAIL of the frame (see header): every known frame
// puts its first byte at mido offset >= 361, the shared header length. A
// tail-anchor below this floor means the frame cannot contain the region.
const GRID_MIN_REGION_OFFSET = 350;
const FIELD_ID = 0; // bits 0-15: effect ID or 1024 + shunt index (low byte first)
const FIELD_MASK = 16; // bits 16-31: input mask, bit k = row k of the previous column

/** Shunt ids are 1024 + sequential index, as in the preset body. */
const SHUNT_ID_BASE = 1024;

/** Grid rows for a model byte: 4 for FM3, 6 for III/FM9. */
function gridRowsFor(modelByte: number): number {
  return modelByte === MODEL_FM3 ? 4 : 6;
}

/** Grid columns for a model byte: 12 for FM3, 14 for III/FM9. */
function gridColsFor(modelByte: number): number {
  return modelByte === MODEL_FM3 ? 12 : 14;
}

/**
 * One occupied grid cell from a live sub=0x2E decode.
 * `cableInputMask` bit `n` set means a cable enters this cell from row `n`
 * of the previous column (FM3 hardware-confirmed 2026-10-23 against known
 * generated cablings, incl. splits and 4-input merges).
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
  /** Incoming-cable bitmask: bit k = a cable from row k of the prior column. */
  cableInputMask: number;
  /** Rows of the prior column feeding this cell (decoded from cableInputMask). */
  fromRows: number[];
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
  // mido strips the F0 status byte; offsets below are into that stream.
  const mido = frame.length >= 2 && frame[0] === SYSEX_START ? frame.slice(1) : frame;
  // Block-targeted replies carry the same layout as empty-target ones (see the
  // header: FM3 capture 2026-06-12, oracle-matched grid in block-targeted
  // frames), so no target-shape guard here — both decode identically.
  const rows = gridRowsFor(modelByte);
  const cols = gridColsFor(modelByte);
  const colStride = rows * GRID_ROW_STRIDE;
  // Tail anchor: the region is the last ceil((base + cols*colStride)/7) bytes
  // before the trailing [checksum, F7]. This absorbs length variants (FM3
  // frames arrive as both 590 and 606 bytes; FM9 as 755).
  const regionBytes = Math.ceil((GRID_BASE_BIT + cols * colStride) / 7);
  if (mido[mido.length - 1] !== SYSEX_END) {
    throw new Error(
      'parseGen3GridLayout: expected a full SysEx frame ending in F7 (the grid region is tail-anchored)',
    );
  }
  const regionOffset = mido.length - 2 - regionBytes;
  if (regionOffset < GRID_MIN_REGION_OFFSET) {
    throw new Error(
      `parseGen3GridLayout: frame too short for grid region (need ${regionBytes} region bytes after a >=${GRID_MIN_REGION_OFFSET}-byte header, have a ${mido.length}-byte frame)`,
    );
  }
  const region = mido.slice(regionOffset, mido.length - 2);
  const cells: Gen3GridLayoutCell[] = [];
  const byte = (bit: number) => readBitsMsb(region, bit, 8);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const base = GRID_CELL_BIT + col * colStride + row * GRID_ROW_STRIDE;
      const id = byte(base + FIELD_ID) | (byte(base + FIELD_ID + 8) << 8);
      const mask = byte(base + FIELD_MASK) | (byte(base + FIELD_MASK + 8) << 8);
      if (id === 0) continue; // empty cell
      const isShunt = id >= SHUNT_ID_BASE;
      cells.push({
        row,
        col,
        effectId: isShunt ? undefined : id,
        isShunt,
        shuntIndex: isShunt ? id - SHUNT_ID_BASE : undefined,
        cableInputMask: mask,
        fromRows: Array.from({ length: rows }, (_, k) => k).filter((k) => (mask >> k) & 1),
      });
    }
  }
  return cells;
}
