/**
 * Adapter: turn `planIILiveComposeOps`'s surgical live-write plan (pure
 * codec logic, fractal-midi) into `ApplyPresetAtOp[]` so it can run
 * through the ALREADY-hardened `runApplyPresetAtOps` executor
 * (applyExecutor.ts) — safety mute, per-write ack/nack tracking, the
 * empty-cell skip optimization, all inherited for free rather than
 * reimplemented.
 *
 * This is the live-write successor to `composeImageChain`'s whole-image
 * splice-and-push (see that module's docstring in fractal-midi for the
 * 2026-07-17 AxeEdit-mining evidence this is built to match byte-for-
 * byte): a mid-chain REMOVE or a same-cell TYPE REPLACE is exactly one
 * fn 0x05 SET_GRID_CELL write, never paired with fn 0x06, because the
 * cell's connector mask never changes for either op. `planIILive
 * ComposeOps` refuses any target landing on a currently-empty cell
 * rather than guess whether fresh routing is needed; that refusal
 * surfaces here unchanged.
 *
 * Currently exercised directly by `scripts/_research/probe-ii-compose-
 * live-ops.ts` (the hardware-confirmed same-cell-replace probe) and by
 * `planIILiveComposeOps`'s own tests, NOT by `applyExecutor.ts`'s
 * production apply_preset path — the BK-084 mode-collapse (2026-07-18)
 * achieved "unchanged blocks stay untouched at the wire level" via a
 * narrower runtime extension of applyExecutor.ts's existing skip-empty-
 * cell-clears mechanism instead (see `readGridIntoSkipSet`'s docstring
 * there), so this adapter's `allowEmptyCellTargets` option is unused in
 * production for now. Kept because it's the correct, proven mechanism
 * for a future caller that wants a true grid-diff plan rather than a
 * runtime skip layered on a static full-clear-and-place build.
 */

import {
  planIILiveComposeOps,
  buildSetGridCell,
  type IIComposeGridCell,
  type IIComposeTarget,
} from 'fractal-midi/gen2/axe-fx-ii';
import type { ApplyPresetAtOp } from './applyExecutor.js';

export interface ComposeLiveOpsResult {
  readonly ok: true;
  readonly ops: readonly ApplyPresetAtOp[];
  readonly removed: readonly number[];
  readonly inserted: readonly number[];
  readonly unchanged: readonly number[];
}

export interface ComposeLiveOpsFailure {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Plan the live SET_GRID_CELL writes to rebuild `cells` to exactly
 * `targets`, expressed as `ApplyPresetAtOp[]` ready for
 * `runApplyPresetAtOps`. `cells` can come from a preset dump
 * (`parseIIGrid` on a fn 0x03/0x04 image) or a live fn 0x20
 * GET_GRID_LAYOUT read (map `{row, col, blockId}` to `{row, col, id:
 * blockId}`) — either satisfies `IIComposeGridCell`.
 *
 * `opts.allowEmptyCellTargets` opts into placing on a currently-empty
 * cell (default false, preserving the narrow same-cell-replace
 * behavior this adapter was first proven against). `applyExecutor.ts`
 * passes `true`: it owns its own routing authorship (OUTPUT-sentinel
 * auto-extension / legacy row-2 auto-chain fallback) for cells this
 * planner would otherwise refuse.
 */
export function buildComposeLiveApplyOps(
  cells: readonly IIComposeGridCell[],
  targets: readonly IIComposeTarget[],
  opts: { readonly modelId?: number; readonly allowEmptyCellTargets?: boolean } = {},
): ComposeLiveOpsResult | ComposeLiveOpsFailure {
  const plan = planIILiveComposeOps(cells, targets, { allowEmptyCellTargets: opts.allowEmptyCellTargets });
  if (!('ops' in plan)) return { ok: false, reason: plan.reason };

  const ops: ApplyPresetAtOp[] = plan.ops.map((op) => ({
    kind: op.blockId === 0 ? 'clear_cell' : 'place_block',
    bytes: buildSetGridCell({ row: op.row, col: op.col, blockId: op.blockId, modelId: opts.modelId }),
    summary: op.summary,
    awaitResponse: 'set_grid_cell',
    cellRef: { row: op.row, col: op.col },
  }));

  return { ok: true, ops, removed: plan.removed, inserted: plan.inserted, unchanged: plan.unchanged };
}
