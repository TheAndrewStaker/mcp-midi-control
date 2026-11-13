/**
 * Axe-Fx II preset-image COMPOSE: rebuild a chain to a target (wireId,
 * gridCell) set, from whatever is currently loaded, touching only the
 * delta.
 *
 * This is NOT a from-scratch / blank-canvas builder and does not need
 * to be one. `apply_preset` always operates against a preset that is
 * ALREADY loaded (the working buffer is never truly blank — even a
 * freshly-navigated or factory-init preset has a full 48-cell grid
 * with real connector masks). Compose treats the currently loaded grid
 * as a routing DONOR: every cell's connector mask is preserved across
 * every block<->shunt/block<->block conversion it makes, because a
 * cell-id overwrite (`swapGridCellId` in grid.ts; the live wire
 * equivalent is a single fn 0x05 SET_GRID_CELL) only ever touches the
 * cell's id word, never the mask word next to it. So a full rebuild
 * needs zero new routing authorship for any cell that was ALREADY
 * occupied (block or shunt): remove every currently-placed block that
 * isn't wanted at its current cell, then insert every wanted block
 * that isn't already there into the resulting gap. Blocks already
 * correctly placed (same wireId, same cell) are left completely
 * untouched — their stored param state survives; only their explicitly
 * listed knobs need a separate continuous/discrete patch pass on top
 * (this module does structure only, not params).
 *
 * **Live-write ground truth (2026-07-17 AxeEdit mining, hand-decoded,
 * see SYSEX-MAP.md "fn 0x05" section for the byte-exact citations).**
 * AxeEdit itself performs both a mid-chain block REMOVE and a same-cell
 * TYPE REPLACE as exactly ONE live fn 0x05 SET_GRID_CELL write — REMOVE
 * writes blockId 0 (truly empty, NOT a shunt instance id); REPLACE
 * writes the new wireId at the block's existing cell. Neither op is
 * ever paired with an fn 0x06 SET_CELL_ROUTING write, because the
 * cell's mask never needs to change (it was already correct before the
 * edit). `planIILiveComposeOps` is the live-write planner built to this
 * exact evidence: it emits ONLY single-cell fn 0x05-shaped writes for
 * cells that were already occupied (block or shunt) before compose,
 * and REFUSES any target landing on a currently-empty (id 0) cell
 * rather than guess whether fresh fn 0x06 authorship is needed there —
 * AxeEdit's own captures never exercise growing the chain into
 * never-before-wired territory, so that case stays out (use
 * `mode:'build'`'s `applyExecutor`, which owns proven chain-extension
 * routing, for that scenario instead).
 *
 * `composeImageChain` (below) is the earlier whole-image-splice
 * approach: still offline-tested and useful for preview/consistency
 * checking, but superseded as the *live* execution mechanism now that
 * AxeEdit's own wire behavior is confirmed to never push a whole image
 * for a structural edit — it always writes single cells live. Both
 * functions share the same target-diff semantics (`unchanged` /
 * `toRemove` / `toInsert`), computed by the private `diffComposeTargets`
 * helper.
 *
 * Composed entirely from primitives already hardware-confirmed or
 * codec-tested: `removeBlockFromImage` (hardware-confirmed, 5/5
 * novel-composition pushes accepted 2026-07-16), `insertBlockIntoImage`
 * (codec-tested; a PUSH containing a FRESH_DEFAULT_RECORDS-synthesized
 * insert specifically is the one hardware-confirmation gap this module
 * inherits — see the module docstring on `insertBlockIntoImage`'s
 * per-call warning). Un-parked 2026-07-17: the "open-ended grid-mask
 * RE problem" that previously blocked this was never real for the
 * always-a-preset-already-loaded case; see STATE-AXEFX2.md.
 */

import { II_TAIL_RESIDENT_WIRE_IDS, parseIIImageTlv, type IIImageTlv } from './tlv.js';
import { parseIIGrid, isBlockCellId, type IIGridCell } from './grid.js';
import { BLOCK_BY_ID } from '../blockTypes.js';
import type { AxeFxIIImageBuffer } from './frames.js';
import {
  removeBlockFromImage,
  insertBlockIntoImage,
  type IITlvSpan,
  type IIStructureResult,
} from './structure.js';

const TAIL_RESIDENT: ReadonlySet<number> = new Set(II_TAIL_RESIDENT_WIRE_IDS);

export interface IIComposeTarget {
  /** Wire id this cell should hold after compose. */
  readonly wireId: number;
  readonly gridCell: { readonly col: number; readonly row: number };
  /**
   * Donor span for a block that needs a fresh insert (not already at
   * this exact wireId+cell). Omit to use the registered default record
   * (FRESH_DEFAULT_RECORDS preferred, DEFAULT_RECORDS fallback) via
   * `insertBlockIntoImage`'s own donor resolution.
   */
  readonly span?: IITlvSpan;
}

export interface IIComposeResult {
  readonly ok: true;
  readonly image: AxeFxIIImageBuffer;
  /** Wire ids removed from their prior cell (wrong cell, or not in targets). */
  readonly removed: readonly number[];
  /** Wire ids freshly inserted. */
  readonly inserted: readonly number[];
  /** Wire ids already correctly placed (same wireId, same cell); left untouched. */
  readonly unchanged: readonly number[];
  readonly warnings: readonly string[];
}

function cellKey(cell: { readonly col: number; readonly row: number }): string {
  return `${cell.col},${cell.row}`;
}

/**
 * Minimal grid-cell shape the diff/live-planner side of this module
 * needs: just id + position. `IIGridCell` (image-parsed, carries mask +
 * word indices too) satisfies this structurally, but so does a plain
 * live fn 0x20 GET_GRID_LAYOUT read (`{row, col, blockId}` renamed to
 * `id` by the caller) — callers are not forced to fabricate an image
 * just to plan live ops.
 */
export interface IIComposeGridCell {
  readonly col: number;
  readonly row: number;
  readonly id: number;
}

interface ComposeDiff {
  readonly unchanged: readonly number[];
  readonly toRemove: readonly number[];
  readonly toInsert: readonly IIComposeTarget[];
}

/**
 * Shared target-diff core for both `composeImageChain` (image splice)
 * and `planIILiveComposeOps` (live single-cell writes). Validates the
 * target set up front (all-or-nothing, zero side effects on failure),
 * then classifies every currently-placed non-tail-resident block as
 * `unchanged` (its cell is a target naming the same wireId) or
 * `toRemove` (anything else), and every target not already satisfied
 * by an `unchanged` block as `toInsert`.
 */
function diffComposeTargets(
  cells: readonly IIComposeGridCell[],
  targets: readonly IIComposeTarget[],
  opName: string,
): { readonly ok: false; readonly reason: string } | { readonly ok: true; readonly diff: ComposeDiff } {
  const seenCells = new Set<string>();
  const seenWireIds = new Set<number>();
  for (const t of targets) {
    if (TAIL_RESIDENT.has(t.wireId)) {
      return {
        ok: false,
        reason:
          `${opName}: target wire_id ${t.wireId} is a system-tail / tail-resident block; ` +
          `compose never touches tail-resident blocks, omit it from targets.`,
      };
    }
    if (BLOCK_BY_ID[t.wireId] === undefined) {
      return { ok: false, reason: `${opName}: target wire_id ${t.wireId} is not a registered block.` };
    }
    const ck = cellKey(t.gridCell);
    if (seenCells.has(ck)) {
      return { ok: false, reason: `${opName}: two targets both name grid cell (${t.gridCell.col},${t.gridCell.row}).` };
    }
    seenCells.add(ck);
    if (seenWireIds.has(t.wireId)) {
      return { ok: false, reason: `${opName}: wire_id ${t.wireId} appears in targets more than once.` };
    }
    seenWireIds.add(t.wireId);
  }

  const targetByCell = new Map<string, IIComposeTarget>(targets.map((t) => [cellKey(t.gridCell), t]));

  // A currently-placed (non-tail-resident) block is "unchanged" iff its
  // cell is a target AND that target names the same wireId; otherwise
  // it's "unwanted" (removed). Compute this BEFORE any mutation.
  const unchanged: number[] = [];
  const toRemove: number[] = [];
  for (const cell of cells) {
    if (!isBlockCellId(cell.id) || TAIL_RESIDENT.has(cell.id)) continue;
    const target = targetByCell.get(cellKey(cell));
    if (target !== undefined && target.wireId === cell.id) {
      unchanged.push(cell.id);
    } else {
      toRemove.push(cell.id);
    }
  }
  const unchangedIds = new Set(unchanged);
  const toInsert = targets.filter((t) => !unchangedIds.has(t.wireId));

  return { ok: true, diff: { unchanged, toRemove, toInsert } };
}

/**
 * Rebuild the chain to exactly the given (wireId, gridCell) targets,
 * in a COPY of the image, as a single logical operation (internally a
 * sequence of remove/insert calls, each building on the last). Blocks
 * not mentioned in `targets` and not tail-resident are removed (become
 * shunts). Tail-resident blocks (139/140/141/142/143/170) are NEVER
 * touched by compose — omit them from `targets`; they pass through
 * unchanged regardless of what else changes.
 *
 * All-or-nothing: validates the full target set before mutating
 * anything, so a single invalid target refuses with zero image writes
 * (same BK-059 contract every other structural op here follows).
 *
 * Superseded as the LIVE execution mechanism by `planIILiveComposeOps`
 * (see module docstring); kept for offline preview/consistency checks.
 */
export function composeImageChain(
  source: AxeFxIIImageBuffer,
  targets: readonly IIComposeTarget[],
): IIStructureResult<IIComposeResult> {
  const tlv = parseIIImageTlv(source.words);
  if (tlv.toneMatchPresent) {
    return {
      ok: false,
      reason:
        `composeImageChain: this preset carries a Tone Match block (wire_id 170); structural ` +
        `splices on tone-match presets are refused in v1 (a naive splice would shift the ` +
        `chain-independent bulk region).`,
    };
  }

  const cells = parseIIGrid(source.words);
  const diffResult = diffComposeTargets(cells, targets, 'composeImageChain');
  if (!diffResult.ok) return { ok: false, reason: diffResult.reason };
  const { unchanged, toRemove, toInsert } = diffResult.diff;

  let image: AxeFxIIImageBuffer = { words: source.words.slice(), reserved: source.reserved.slice() };
  const warnings: string[] = [];

  for (const wireId of toRemove) {
    const r = removeBlockFromImage(image, wireId);
    if (!('image' in r)) {
      return { ok: false, reason: `composeImageChain: removing wire_id ${wireId} to make room: ${r.reason}` };
    }
    image = r.image;
    warnings.push(...r.warnings);
  }

  for (const t of toInsert) {
    const r = insertBlockIntoImage(image, { wireId: t.wireId, span: t.span, gridCell: t.gridCell });
    if (!('image' in r)) {
      return { ok: false, reason: `composeImageChain: inserting wire_id ${t.wireId} at (${t.gridCell.col},${t.gridCell.row}): ${r.reason}` };
    }
    image = r.image;
    warnings.push(...r.warnings);
  }

  // Strict re-parse + grid/chain multiset check as a final sanity gate
  // (each remove/insert already self-checks; this catches any
  // cross-step inconsistency the sequential application could produce).
  let finalTlv: IIImageTlv;
  try {
    finalTlv = parseIIImageTlv(image.words);
  } catch (err) {
    return {
      ok: false,
      reason: `composeImageChain: post-compose image failed the strict walk: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const finalCells: readonly IIGridCell[] = parseIIGrid(image.words);
  const gridBlockIds = finalCells.filter((c) => isBlockCellId(c.id)).map((c) => c.id).sort((a, b) => a - b);
  const chainBlockIds = finalTlv.blocks.map((b) => b.wireId).sort((a, b) => a - b);
  if (JSON.stringify(gridBlockIds) !== JSON.stringify(chainBlockIds)) {
    return {
      ok: false,
      reason:
        `composeImageChain: post-compose grid/chain multiset mismatch (grid [${gridBlockIds.join(',')}], ` +
        `chain [${chainBlockIds.join(',')}]); refusing to return an inconsistent image.`,
    };
  }

  return {
    ok: true,
    image,
    removed: toRemove,
    inserted: toInsert.map((t) => t.wireId),
    unchanged,
    warnings,
  };
}

/** One live SET_GRID_CELL write. `blockId: 0` is AxeEdit's own removal convention (a bare clear, not a shunt instance). */
export interface IILiveGridOp {
  readonly col: number;
  readonly row: number;
  readonly blockId: number;
  readonly summary: string;
}

export interface IILiveComposeResult {
  readonly ok: true;
  /** Live fn 0x05-shaped writes, in the order they should be sent (removes first, then inserts, matching `composeImageChain`'s ordering). */
  readonly ops: readonly IILiveGridOp[];
  readonly removed: readonly number[];
  readonly inserted: readonly number[];
  readonly unchanged: readonly number[];
}

/**
 * Live-write analog of `composeImageChain`: plans a MINIMAL sequence of
 * single-cell SET_GRID_CELL writes (fn 0x05 shape: col/row + new
 * blockId, 0 = clear) that rebuilds the chain to exactly the given
 * targets, matching AxeEdit's own confirmed wire behavior byte-for-byte
 * (see module docstring). Every op touches a cell that was ALREADY
 * occupied (block or shunt) before compose, so no fn 0x06 routing
 * write is ever needed — the mask is inherited unchanged, exactly as
 * AxeEdit's own remove/replace captures show.
 *
 * Takes the CURRENT grid (`parseIIGrid` output, e.g. from a preset
 * dump or a live fn 0x20 GET_GRID read) rather than a full image
 * buffer: unlike `composeImageChain`, this never touches the TLV bulk
 * region, so it does not need (and does not apply) the tone-match
 * refusal.
 *
 * Refuses (all-or-nothing, zero ops returned) if any target names a
 * cell that is currently EMPTY (id 0): an empty cell carries no
 * established connector mask, and neither of AxeEdit's own captured
 * structural edits exercises writing into never-before-wired
 * territory, so this planner does not guess whether fresh fn 0x06
 * authorship would be needed there, UNLESS the caller opts in via
 * `opts.allowEmptyCellTargets` — for a caller that owns its own proven
 * chain-extension routing authorship (the OUTPUT-sentinel auto-
 * extension / legacy row-2 auto-chain fallback) and just needs this
 * planner's cell-level SET, not a mask decision. No production caller
 * opts in yet (BK-084 mode-collapse, 2026-07-18, achieved apply_preset's
 * "unchanged blocks stay untouched" via a narrower runtime extension of
 * applyExecutor.ts's existing skip-empty-cell-clears mechanism instead —
 * see that file's `readGridIntoSkipSet` docstring); the option is
 * exercised today only by `buildComposeLiveApplyOps`'s own tests and the
 * hardware-confirmed same-cell-replace probe. When opted in, an empty-
 * cell target still emits exactly one plain `SET wire_id` op (same shape
 * as any other insert) — this planner never emits fn 0x06 routing writes
 * either way; that stays the caller's job.
 */
export function planIILiveComposeOps(
  cells: readonly IIComposeGridCell[],
  targets: readonly IIComposeTarget[],
  opts?: { readonly allowEmptyCellTargets?: boolean },
): IIStructureResult<IILiveComposeResult> {
  const diffResult = diffComposeTargets(cells, targets, 'planIILiveComposeOps');
  if (!diffResult.ok) return { ok: false, reason: diffResult.reason };
  const { unchanged, toRemove, toInsert } = diffResult.diff;

  // toRemove wireIds always resolve to a real (non-empty) cell — they
  // came from scanning placed blocks in `cells` above.
  const removeCellByWireId = new Map<number, IIComposeGridCell>();
  for (const cell of cells) {
    if (isBlockCellId(cell.id) && toRemove.includes(cell.id)) removeCellByWireId.set(cell.id, cell);
  }

  const allowEmptyCellTargets = opts?.allowEmptyCellTargets === true;
  for (const t of toInsert) {
    const targetCell = cells.find((c) => c.col === t.gridCell.col && c.row === t.gridCell.row);
    if (targetCell === undefined) {
      return {
        ok: false,
        reason: `planIILiveComposeOps: target cell (${t.gridCell.col},${t.gridCell.row}) is out of grid range.`,
      };
    }
    if (targetCell.id === 0 && !allowEmptyCellTargets) {
      return {
        ok: false,
        reason:
          `planIILiveComposeOps: target wire_id ${t.wireId} at (${t.gridCell.col},${t.gridCell.row}) lands on a ` +
          `currently-EMPTY cell (never wired). This planner only writes cells already occupied by a block or ` +
          `shunt, matching AxeEdit's own remove/replace wire evidence; growing the chain into new territory ` +
          `needs fresh fn 0x06 routing this planner refuses to guess. Use mode:'build' for that case.`,
      };
    }
  }

  const ops: IILiveGridOp[] = [];
  const insertCells = new Set(toInsert.map((t) => cellKey(t.gridCell)));

  for (const wireId of toRemove) {
    const cell = removeCellByWireId.get(wireId);
    if (cell === undefined) {
      return { ok: false, reason: `planIILiveComposeOps: internal error, no cell found for wire_id ${wireId} to remove.` };
    }
    // A cell simultaneously named by a toInsert target is a same-cell
    // replace: skip the separate clear, the insert write below covers it
    // (matching AxeEdit's own single-write replace, not clear-then-place).
    if (insertCells.has(cellKey(cell))) continue;
    ops.push({
      col: cell.col,
      row: cell.row,
      blockId: 0,
      summary: `CLEAR wire_id ${wireId} at (${cell.col},${cell.row})`,
    });
  }

  for (const t of toInsert) {
    ops.push({
      col: t.gridCell.col,
      row: t.gridCell.row,
      blockId: t.wireId,
      summary: `SET wire_id ${t.wireId} at (${t.gridCell.col},${t.gridCell.row})`,
    });
  }

  return {
    ok: true,
    ops,
    removed: toRemove,
    inserted: toInsert.map((t) => t.wireId),
    unchanged,
  };
}
