/**
 * BK-084 mode-collapse: `set_params`' internal atomic-vs-individual batch
 * heuristic (Axe-Fx II only). Adapted from `retuneApply.ts`'s
 * `classifyRetuneSpec` + its call into the atomic image pipeline
 * (`imageApply.ts`), but working off `set_params`' ACTUAL flat resolved-
 * ops shape (`{block, name, value, channel?, instance?}[]`) instead of a
 * whole `PresetSpec.slots[]`. The mechanism (dump -> patch -> push ->
 * verify) is unchanged and stays fully owned by `imageApply.ts` /
 * `presetImageContinuousPatch.ts`; this module only reshapes set_params'
 * input into that pipeline's input and reshapes the outcome back into
 * per-op `WriteResult`s.
 *
 * Dropped relative to retuneApply.ts (does not apply to set_params):
 *   - Step 1 (navigate-to-target): set_params has no target_location.
 *   - Step 11 (STORE): set_params never saves.
 *   - The grid-read placement gate: the image patch pipeline already
 *     refuses (per-entry, in `refused[]`) any block absent from the
 *     dump's TLV chain, so an explicit pre-check is redundant here.
 *   - The all-or-nothing `refusePartial` contract: set_params' own
 *     philosophy already tolerates per-op partial failure (each op is
 *     attempted independently; the existing individual-write loop never
 *     early-exits on one op's failure), so the atomic leg uses
 *     `refusePartial: false` — a per-entry image-patch refusal doesn't
 *     block the OTHER entries in the same batch from landing atomically.
 *     Retune's `refusePartial: true` existed because retune's response
 *     shape couldn't cleanly express partial outcomes; set_params'
 *     `writes[]` + counts already can.
 *
 * Kept, adapted: the enum-leg / continuous-image-patch split
 * (`isImagePatchEligibleParam`), and the channel resolution read for a
 * flat (no explicit channel) continuous op on a channel-bearing block —
 * the image patch addresses a STATIC byte in the dumped image, so
 * "whichever channel happens to be active" must be resolved to a
 * concrete X/Y BEFORE patching, unlike a live fn=0x2e write (which the
 * device resolves against its own active-channel pointer dynamically).
 */

import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import type { DispatchCtx, WriteResult } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  buildGetBlockChannel,
  isGetBlockChannelResponse,
  parseGetBlockChannelResponse,
  type AxeFxIIBlock,
  type AxeFxIIChannel,
  type AxeFxIIParam,
} from 'fractal-midi/gen2/axe-fx-ii';

import { isImagePatchEligibleParam, type ContinuousParamPatchInput } from '../presetImageContinuousPatch.js';
import type { AtomicImageApply } from './imageApply.js';

const PARAM_KIND_DEVICE = 'axe-fx-ii';
const READ_TIMEOUT_MS = 800;
/** BK-081 performance-budget catch (same constant retuneApply.ts used): bound the opportunistic dump attempt. */
const DUMP_FIRST_FRAME_TIMEOUT_MS = 900;

/**
 * HW-133 (2026-07-18, `scripts/_research/probe-set-params-atomic-
 * threshold.ts`, real Axe-Fx II XL+, 18/18 PASS): measured, not guessed.
 * Individual fn=0x2e writes are fire-and-forget and near-instant
 * regardless of count (N=1..3 measured ~3 ms total); the atomic image
 * path's fixed dump/patch/push/verify cost measured ~3.0 s consistently
 * at N=4,5,6 (close to, a bit faster than, retuneApply.ts's original
 * "~4 s" estimate). Raw wall-clock time therefore ALWAYS favors
 * individual writes — the atomic path's value was never speed, it's ONE
 * clean transition instead of N audible steps, a perceptual property
 * this timing data can't fully resolve on its own (only ears can confirm
 * exactly how many discrete steps stop sounding smooth). Kept at 4: nothing
 * in the measured data argues for moving it, and it matches the design
 * doc's own suggested single-digit range. Once the image-eligible subset
 * of a set_params batch reaches this size, those writes route through the
 * atomic path automatically; below it, every write streams individually
 * (unaffected, byte-identical to pre-BK-084 set_params).
 */
export const SET_PARAMS_ATOMIC_THRESHOLD = 4;

/** One already-resolved set_params op, ready for classification. */
export interface ResolvedSetParamsOp {
  /** Index into the caller's original ops[] array (for result ordering / error attribution). */
  readonly index: number;
  readonly block: AxeFxIIBlock;
  readonly param: AxeFxIIParam;
  /** Explicit channel from the caller; undefined = resolve to the block's active channel. */
  readonly channel?: AxeFxIIChannel;
  /** Wire-encoded value (the dispatcher's encodeValue has already run). */
  readonly wireValue: number;
}

export interface SetParamsAtomicClassification {
  /** Indices that must stream individually: enum/select, FN02-only-group, or not image-patch-eligible. */
  readonly streamIndices: readonly number[];
  /** Continuous, calibrated ops eligible for the atomic image path. */
  readonly imageEligible: readonly ResolvedSetParamsOp[];
}

/** Same enum detection `writer.setParam` and `retuneApply.ts` both use. */
function isEnumLike(param: AxeFxIIParam): boolean {
  return param.controlType === 'select' || 'enumValues' in param;
}

/**
 * Pure classification: which ops COULD ride the atomic image path if the
 * batch is large enough. Does not decide whether to actually use it —
 * see `SET_PARAMS_ATOMIC_THRESHOLD` / the caller in `writer.ts`.
 */
export function classifySetParamsForAtomic(
  ops: readonly ResolvedSetParamsOp[],
  fn02OnlyGroups: ReadonlySet<string>,
): SetParamsAtomicClassification {
  const streamIndices: number[] = [];
  const imageEligible: ResolvedSetParamsOp[] = [];
  for (const op of ops) {
    if (isEnumLike(op.param) || fn02OnlyGroups.has(op.block.groupCode)) {
      streamIndices.push(op.index);
      continue;
    }
    const eligible = isImagePatchEligibleParam(op.param);
    if (!eligible.ok) {
      streamIndices.push(op.index);
      continue;
    }
    imageEligible.push(op);
  }
  return { streamIndices, imageEligible };
}

export interface AtomicBatchDeps {
  readonly atomicImageApply: AtomicImageApply;
}

export interface AtomicBatchOutcome {
  /**
   * True when the atomic path was actually attempted and produced a
   * result (success or failure) for `results`. False means the caller
   * should fall back to streaming EVERY op in `fallbackIndices`
   * individually (nothing was sent for them — safe to retry via the
   * proven per-op path).
   */
  readonly attempted: boolean;
  /** Per-op results, keyed by the SAME `index` the input carried. Populated only when `attempted`. */
  readonly results: ReadonlyMap<number, WriteResult>;
  /** Indices to hand to the existing individual-write loop instead. */
  readonly fallbackIndices: readonly number[];
  readonly apply_path?: 'preset-image' | 'per-param-stream';
  readonly image_apply_fallback_reason?: string;
  readonly receipt?: 'word-exact' | 'none';
  readonly push_attempts?: number;
}

/** Awaited read of a block's active channel (mirrors retuneApply.ts's own helper). */
async function readBlockChannel(ctx: DispatchCtx, block: AxeFxIIBlock, modelId: number | undefined): Promise<AxeFxIIChannel> {
  const ackPromise = ctx.conn.receiveSysExMatching(
    (bytes) => isGetBlockChannelResponse(bytes, block.id, modelId),
    READ_TIMEOUT_MS,
  );
  ctx.conn.send(buildGetBlockChannel(block.id, { modelId }));
  return parseGetBlockChannelResponse(await ackPromise);
}

/**
 * Run the image-eligible subset of a set_params batch through the atomic
 * dump/patch/push/verify pipeline. Returns per-op results keyed by the
 * ops' original indices, OR (when the attempt refused/failed in a way
 * proven safe to retry) a list of indices the caller should stream
 * individually instead — never both for the same index.
 */
export async function runSetParamsAtomicBatch(
  ctx: DispatchCtx,
  ops: readonly ResolvedSetParamsOp[],
  modelId: number | undefined,
  deps: AtomicBatchDeps,
): Promise<AtomicBatchOutcome> {
  if (ops.length === 0) {
    return { attempted: false, results: new Map(), fallbackIndices: [] };
  }

  // Channel resolution: ops with an explicit channel pass through as-is
  // (the image patch can address either channel directly, no live-device
  // match required — unlike the enum leg's set_param-style refusal). Ops
  // without one, on a channel-bearing block, need one read of the block's
  // CURRENT active channel so the patch targets a concrete X/Y byte.
  // Dedup by block id: multiple ops on the same block share one read.
  const activeChannel = new Map<number, AxeFxIIChannel>();
  const needsRead = new Map<number, AxeFxIIBlock>();
  for (const op of ops) {
    if (op.channel === undefined && op.block.canBypass) needsRead.set(op.block.id, op.block);
  }
  for (const block of needsRead.values()) {
    try {
      activeChannel.set(block.id, await readBlockChannel(ctx, block, modelId));
    } catch {
      // Can't resolve which channel to patch for this block's ops — those
      // specific ops fall back to streaming (set_param's own channel
      // handling needs no such read: a flat live write lands on whichever
      // channel is already active, device-side, with no image to address).
      // NEVER also add these to `results` here: the caller's fallback
      // loop is what produces their real result via writer.setParam!,
      // and an index present in BOTH `results` and `fallbackIndices`
      // would double-count acked_count/unacked_count in writer.ts.
      const unreadableIndices = ops.filter((o) => o.block.id === block.id && o.channel === undefined).map((o) => o.index);
      const remaining = ops.filter((o) => !unreadableIndices.includes(o.index));
      const fallbackReason = `could not read ${block.name}'s active channel to address the atomic image patch; streamed individually instead.`;
      if (remaining.length < SET_PARAMS_ATOMIC_THRESHOLD) {
        // Not enough left to justify the atomic path at all; stream everything.
        return {
          attempted: false, results: new Map(), fallbackIndices: ops.map((o) => o.index),
          apply_path: 'per-param-stream', image_apply_fallback_reason: fallbackReason,
        };
      }
      // Recurse on the reduced set (rare path: a channel read failed for
      // one block among several targeted in the same batch).
      const rest = await runSetParamsAtomicBatch(ctx, remaining, modelId, deps);
      return {
        ...rest,
        fallbackIndices: [...unreadableIndices, ...rest.fallbackIndices],
        apply_path: rest.apply_path ?? 'per-param-stream',
        image_apply_fallback_reason: rest.image_apply_fallback_reason ?? fallbackReason,
      };
    }
  }

  // `index` (this batch's original op index) rides along on each patch
  // input so `refused[]` — which echoes back the EXACT SAME object
  // reference (see presetImageContinuousPatch.ts: `refused.push({input,
  // reason})` where `input` is the loop variable bound straight to this
  // array) — can be matched by identity, no lookup needed. `applied[]` is
  // a NEW object (`{block: block.name, ...}` — the resolved BLOCK NAME,
  // e.g. "Amp 1", NOT the numeric effectId `patches[].block` carries), so
  // it's matched via `nameKey` instead.
  // A key maps to MULTIPLE indices when the caller's batch names the same
  // (block, param, channel) more than once (a redundant/malformed request,
  // but not one set_params' existing per-op contract rejects — the
  // individual-write loop would just send both, last one winning on the
  // device). `outcome.applied` preserves the SAME relative order as
  // `patches` (imageApply iterates `patches` in order, pushing to
  // `applied`/`refused` conditionally), so duplicate-key entries are
  // resolved by consuming this queue FIFO below — matching each `applied`
  // entry to the correct duplicate's index, not fanning one result out to
  // all of them (which would mis-attribute a later duplicate's actual
  // displayValue/afterWire to an earlier index).
  type IndexedPatch = ContinuousParamPatchInput & { index: number };
  const nameKey = (blockName: string, paramName: string, channel: string): string => `${blockName}|${paramName}|${channel}`;
  const indexQueueByNameKey = new Map<string, number[]>();
  const patches: IndexedPatch[] = ops.map((op) => {
    const kind = resolveParamKind(PARAM_KIND_DEVICE, op.param.block, op.param.name);
    const displayValue = kind.decodeWire !== undefined ? kind.decodeWire(op.wireValue) : op.wireValue;
    const channel = op.channel ?? (op.block.canBypass ? activeChannel.get(op.block.id) ?? 'X' : 'X');
    const key = nameKey(op.block.name, op.param.name, channel);
    const queue = indexQueueByNameKey.get(key);
    if (queue !== undefined) queue.push(op.index);
    else indexQueueByNameKey.set(key, [op.index]);
    return { index: op.index, block: op.block.id, paramName: op.param.name, channel, displayValue };
  });

  const outcome = await deps.atomicImageApply(ctx, patches, {
    refusePartial: false,
    firstFrameTimeoutMs: DUMP_FIRST_FRAME_TIMEOUT_MS,
  });

  if (!outcome.ok && outcome.stage === 'refused') {
    // Nothing was sent (dump-read failure, round-trip-identity refusal,
    // or every entry refused internally) — safe to retry every op via
    // the proven individual path.
    return {
      attempted: false, results: new Map(), fallbackIndices: ops.map((o) => o.index),
      apply_path: 'per-param-stream', image_apply_fallback_reason: outcome.reason ?? outcome.refusal_kind,
    };
  }
  if (!outcome.ok && (outcome.buffer_state === 'original-intact' || outcome.buffer_state === 'original-restored')) {
    // The push/verify failed but the buffer is PROVEN back at (or still
    // at) the pre-patch image — safe to retry every op individually.
    return {
      attempted: false, results: new Map(), fallbackIndices: ops.map((o) => o.index),
      apply_path: 'per-param-stream', image_apply_fallback_reason: outcome.reason,
    };
  }

  // Either full success, or a failure with buffer_state 'unknown' — the
  // honest terminal (retuneApply.ts's own rule: never stream on top of an
  // unproven buffer). Report per-op results either way; no fallback.
  const results = new Map<number, WriteResult>();
  for (const applied of outcome.applied) {
    const idx = indexQueueByNameKey.get(nameKey(applied.block, applied.paramName, applied.channel))?.shift();
    if (idx === undefined) continue;
    results.set(idx, {
      op: 'set_param',
      block: applied.block,
      name: applied.paramName,
      channel: applied.channel,
      wire_value: applied.afterWire,
      display_value: applied.displayValue,
      acked: true,
    });
  }
  for (const refused of outcome.refused) {
    const idx = (refused.input as IndexedPatch).index;
    results.set(idx, {
      op: 'set_param',
      name: refused.input.paramName,
      channel: refused.input.channel,
      acked: false,
      warning: refused.reason,
    });
  }
  if (!outcome.ok) {
    // buffer_state 'unknown': every op that isn't already accounted for
    // (applied/refused) failed with the honest unknown-state warning.
    for (const p of patches) {
      if (results.has(p.index)) continue;
      results.set(p.index, {
        op: 'set_param',
        name: p.paramName,
        channel: p.channel,
        acked: false,
        warning: outcome.reason ?? 'atomic image apply failed; working buffer state UNKNOWN. Switching presets discards it safely; nothing was saved.',
      });
    }
  }

  return {
    attempted: true,
    results,
    fallbackIndices: [],
    apply_path: 'preset-image',
    receipt: outcome.ok ? 'word-exact' : 'none',
    push_attempts: outcome.push_attempts > 0 ? outcome.push_attempts : undefined,
  };
}
