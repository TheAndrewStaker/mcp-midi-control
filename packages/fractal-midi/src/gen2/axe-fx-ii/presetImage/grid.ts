/**
 * Axe-Fx II preset-image GRID + ROUTING cell matrix (words 34..129).
 *
 * Decoded 2026-07-16 (corpus 502/502: 384 Q8.02 factory + 118 live
 * hardware dumps; independently re-derived on a 503-dump superset with
 * zero violations). This region is the image encoding of exactly what
 * the live fn 0x20 GET_GRID / fn 0x06 SET_CELL_ROUTING surface
 * manipulates:
 *
 *   48 cells, COLUMN-MAJOR (col 1..12 outer, row 1..4 inner),
 *   2 words per cell:
 *     cellWord(col, row) = 34 + ((col-1)*4 + (row-1)) * 2
 *     cell word 0 = blockId: 0 = empty, 100..198 = block,
 *                   200..235 = shunt (observed maxima: block 170,
 *                   shunt 215; the bounds are domain allowances)
 *     cell word 1 = 4-bit INPUT-connection mask: bit N set = fed from
 *                   previous column row N+1. Column-1 occupied cells
 *                   carry 1 << (row-1) (input-node connect).
 *
 * This SUPERSEDES the old `block-record-stride-8` reading: the stride-8
 * "record" is a grid COLUMN (4 cells x 2 words); the old "flag 0x0002 =
 * active in standard scene" is actually routing bit 1 (fed from
 * prev-column row 2); "ids >= 200 unplaced placeholders" are SHUNTS
 * with real per-cell ids; "ushort[2..7] always zero" was an artifact of
 * row-2-only presets.
 *
 * Invariants (zero violations corpus-wide):
 *   - id domain {0} U [100..198] U [200..235]; mask <= 0x0F; empty
 *     cells carry mask 0
 *   - every col>1 mask bit points at an OCCUPIED previous-column cell
 *   - the grid's block-id multiset (ids < 200) EXACTLY equals the TLV
 *     chain's effect-block multiset (shunts are never serialized)
 *   - shunt ids are UNIQUE within a preset; allocation is otherwise
 *     NOT canonical (any unused id is corpus-legal; lowest-unused is
 *     the safe encoder choice and stays inside the attested envelope)
 *
 * There is NO explicit output-connection field anywhere in the image:
 * output tapping is implicit (Owner's Manual: cables to OUTPUT are
 * created automatically for last-column blocks). Factory convention
 * extends every signal path to column 12 with shunts (384/384).
 *
 * Scope note: this module ships grid PARSE + validation + the id-swap
 * mutations the splice engine needs (block <-> shunt at an existing
 * cell, flags preserved). Authoring NEW cable masks or fresh routing
 * stays out; the live fn 0x05/0x06 ops (hardware-verified) own that.
 */

export const II_GRID_START_WORD = 34;
export const II_GRID_COLS = 12;
export const II_GRID_ROWS = 4;
export const II_GRID_END_WORD = II_GRID_START_WORD + II_GRID_COLS * II_GRID_ROWS * 2; // 130

export const II_SHUNT_ID_MIN = 200;
export const II_SHUNT_ID_MAX = 235;
/** Highest block id the cell-id domain allows (observed max: 170). */
export const II_GRID_BLOCK_ID_MAX = 198;

/** One grid cell (col/row are 1-based, matching front-panel convention). */
export interface IIGridCell {
  readonly col: number;
  readonly row: number;
  /** 0 = empty, 100..198 = block wire id, 200..235 = shunt id. */
  readonly id: number;
  /** 4-bit input-connection mask (bit N = fed from prev-column row N+1). */
  readonly connectorMask: number;
  /** Word index of the cell's id word. */
  readonly idWord: number;
  /** Word index of the cell's mask word. */
  readonly maskWord: number;
}

/** Word index of a cell's id word. Throws on out-of-range col/row. */
export function gridCellWordIndex(col: number, row: number): number {
  if (!Number.isInteger(col) || col < 1 || col > II_GRID_COLS) {
    throw new Error(`gridCellWordIndex: col ${col} out of range 1..${II_GRID_COLS}`);
  }
  if (!Number.isInteger(row) || row < 1 || row > II_GRID_ROWS) {
    throw new Error(`gridCellWordIndex: row ${row} out of range 1..${II_GRID_ROWS}`);
  }
  return II_GRID_START_WORD + ((col - 1) * II_GRID_ROWS + (row - 1)) * 2;
}

/** Parse all 48 grid cells from an image's words. */
export function parseIIGrid(words: Uint16Array): IIGridCell[] {
  const cells: IIGridCell[] = [];
  for (let col = 1; col <= II_GRID_COLS; col++) {
    for (let row = 1; row <= II_GRID_ROWS; row++) {
      const idWord = gridCellWordIndex(col, row);
      cells.push({
        col,
        row,
        id: words[idWord],
        connectorMask: words[idWord + 1],
        idWord,
        maskWord: idWord + 1,
      });
    }
  }
  return cells;
}

export function isShuntId(id: number): boolean {
  return id >= II_SHUNT_ID_MIN && id <= II_SHUNT_ID_MAX;
}

export function isBlockCellId(id: number): boolean {
  return id >= 100 && id <= II_GRID_BLOCK_ID_MAX;
}

/**
 * Validate the corpus-pinned grid invariants. Returns a list of
 * violation strings (empty = clean). `chainBlockIds` (when given) also
 * checks the grid-vs-chain block multiset identity.
 *
 * Deliberately NOT checked: the column-1 mask == 1 << (row-1) rule and
 * fed-ness of occupied cells; live probe-authored presets legally carry
 * unconnected blocks (mask 0), matching the fn 0x05-without-fn 0x06
 * hardware finding.
 */
export function validateIIGridInvariants(
  cells: readonly IIGridCell[],
  chainBlockIds?: readonly number[],
): string[] {
  const violations: string[] = [];
  const shuntsSeen = new Set<number>();
  for (const cell of cells) {
    const at = `cell (${cell.col},${cell.row})`;
    if (!(cell.id === 0 || isBlockCellId(cell.id) || isShuntId(cell.id))) {
      violations.push(`${at}: id ${cell.id} outside {0} U [100..198] U [200..235]`);
    }
    if (cell.connectorMask > 0x0f) {
      violations.push(`${at}: connector mask 0x${cell.connectorMask.toString(16)} > 0x0F`);
    }
    if (cell.id === 0 && cell.connectorMask !== 0) {
      violations.push(`${at}: empty cell carries connector mask ${cell.connectorMask}`);
    }
    if (isShuntId(cell.id)) {
      if (shuntsSeen.has(cell.id)) violations.push(`${at}: duplicate shunt id ${cell.id}`);
      shuntsSeen.add(cell.id);
    }
    if (cell.col > 1 && cell.connectorMask !== 0) {
      for (let bit = 0; bit < II_GRID_ROWS; bit++) {
        if ((cell.connectorMask & (1 << bit)) === 0) continue;
        const prev = cells.find((x) => x.col === cell.col - 1 && x.row === bit + 1);
        if (prev === undefined || prev.id === 0) {
          violations.push(`${at}: mask bit ${bit} points at an empty previous-column cell`);
        }
      }
    }
  }
  if (chainBlockIds !== undefined) {
    const gridIds = cells
      .filter((c) => isBlockCellId(c.id))
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join(',');
    const chainIds = [...chainBlockIds].sort((a, b) => a - b).join(',');
    if (gridIds !== chainIds) {
      violations.push(`grid block-id multiset [${gridIds}] != chain effect-block multiset [${chainIds}]`);
    }
  }
  return violations;
}

/**
 * Lowest unused shunt id in 200..235. The corpus constraint is only
 * UNIQUENESS within a preset; lowest-unused keeps allocations inside
 * the corpus-attested envelope (observed ids 200..215). Throws when
 * all 36 ids are in use (cannot happen on a 48-cell grid with at least
 * one placed block, but fail loud).
 */
export function allocateShuntId(usedIds: Iterable<number>): number {
  const used = new Set(usedIds);
  for (let id = II_SHUNT_ID_MIN; id <= II_SHUNT_ID_MAX; id++) {
    if (!used.has(id)) return id;
  }
  throw new Error('allocateShuntId: all shunt ids 200..235 are in use');
}

/**
 * Swap a grid cell's id in place (words mutated), PRESERVING its
 * connector mask. The only grid mutation the corpus-validated splice
 * evidence covers: block -> fresh shunt (REMOVE) and shunt -> block
 * (PLACE at an existing routed cell). Throws when the cell does not
 * currently hold `expectCurrentId`.
 */
export function swapGridCellId(
  words: Uint16Array,
  col: number,
  row: number,
  expectCurrentId: number,
  newId: number,
): void {
  const idWord = gridCellWordIndex(col, row);
  if (words[idWord] !== expectCurrentId) {
    throw new Error(
      `swapGridCellId: cell (${col},${row}) holds id ${words[idWord]}, expected ${expectCurrentId}`,
    );
  }
  words[idWord] = newId;
}
