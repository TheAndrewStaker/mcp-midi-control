/**
 * BK-084: atomic-apply v1 orchestration, dump → patch → push → verify →
 * (optional) save, over live `ctx.conn`.
 *
 * This is the wire-side composition the safety review's GO verdict names
 * (`docs/design/ii-atomic-apply-safety-review.md` §7, all four
 * safeguards). It is DELIBERATELY built by composing already-hardware-
 * verified primitives rather than re-implementing them:
 *
 *   1. dump: `patchDumpIo.dumpWorkingBufferBytes` (the SAME edit-buffer
 *               sentinel path `export_preset` uses, HW-132 no-reload-
 *               side-effect confirmed).
 *   2. patch: `presetImageContinuousPatch.applyContinuousParamsToImage`
 *               (pure; safeguards #1 round-trip-identity + #3 continuous-
 *               only scope).
 *   3. push: `presetRestore.restorePresetBinaryAxeFxII` called WITHOUT
 *               `save_authorized`/`target_location`, so it ONLY pushes to
 *               the working buffer (the same 66-frame NACK-detecting push
 *               `import_preset` uses). Safeguard #4a: any NACK aborts here,
 *               before any STORE is attempted.
 *   4. verify: safeguard #2, re-dump the working buffer (same sentinel
 *               path) and confirm the ENTIRE image now equals the expected
 *               patched words, not just the touched ones. A mismatch
 *               anywhere refuses to STORE.
 *   5. save: safeguard #4b, `writer.savePreset` (the existing
 *               hardware-verified STORE_PRESET path), ONLY reached after
 *               a clean push AND a clean verify AND `save_authorized: true`.
 *
 * NOT WIRED to any MCP tool or dispatcher route in this session; doing so
 * requires extending `DeviceWriter` (`packages/core/src/protocol-generic/
 * types.ts`) and the `apply_preset`/dispatcher tool layer, both outside
 * this task's touch scope. This module is a complete, tested,
 * community-beta-grade capability ready for that follow-up wiring.
 */

import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

import { parsePresetDump } from '../presetDump.js';
import { deframePresetImage } from '../presetImageTlv.js';
import {
  applyContinuousParamsToImage,
  type AppliedContinuousPatch,
  type ContinuousParamPatchInput,
  type RefusedContinuousPatch,
} from '../presetImageContinuousPatch.js';

import { dumpWorkingBufferBytes, getActivePresetNumber } from './patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from './presetRestore.js';
import { writer } from './writer.js';

export interface AtomicApplyOptions {
  /** Persist to a stored location after a clean push + verify. Default false (working-buffer-only, reversible). */
  readonly save_authorized?: boolean;
  /**
   * Stored location to STORE to when `save_authorized`. Defaults to the
   * device's currently-active preset (read via GET_PRESET_NUMBER), the
   * natural "save the buffer back to where it came from" target, since
   * this pipeline always dumps and pushes to the ACTIVE working buffer.
   */
  readonly target_location?: string | number;
}

export interface AtomicApplyOutcome {
  readonly ok: boolean;
  /** Where the pipeline stopped. 'done' only on full success. */
  readonly stage: 'refused' | 'push' | 'verify' | 'store' | 'done';
  readonly applied: readonly AppliedContinuousPatch[];
  readonly refused: readonly RefusedContinuousPatch[];
  readonly reason?: string;
  readonly nacks?: readonly { frame_index: number; detail?: string }[];
  readonly saved_to_location?: string | number;
}

/**
 * Run the full BK-084 v1 pipeline against the live connection. Never
 * throws; every failure mode returns `{ ok: false, stage, reason }` so a
 * future tool-layer caller can format a structured refusal instead of an
 * uncaught rejection.
 */
export async function applyContinuousParamsAtomicII(
  ctx: DispatchCtx,
  patches: readonly ContinuousParamPatchInput[],
  options?: AtomicApplyOptions,
): Promise<AtomicApplyOutcome> {
  let dumpBytes: Uint8Array;
  try {
    dumpBytes = await dumpWorkingBufferBytes(ctx);
  } catch (err) {
    return {
      ok: false,
      stage: 'refused',
      applied: [],
      refused: [],
      reason: `working-buffer dump failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const patch = applyContinuousParamsToImage(dumpBytes, patches);
  if (!patch.ok) {
    return { ok: false, stage: 'refused', applied: [], refused: patch.refused ?? [], reason: patch.reason };
  }

  // Safeguard #4a: push to the WORKING BUFFER ONLY. Never pass save
  // options to this call; STORE only happens after read-back verify below.
  const pushResult = await restorePresetBinaryAxeFxII(ctx, patch.patchedBytes);
  if (!pushResult.ok) {
    return {
      ok: false,
      stage: 'push',
      applied: patch.applied,
      refused: patch.refused,
      nacks: pushResult.nacks,
      reason: `push NACKed (${pushResult.nacks.length} frame(s)); aborting before read-back verify and STORE.`,
    };
  }

  // Safeguard #2: post-push read-back verify. Re-dump and confirm the
  // ENTIRE image equals the expected patched words, not just the words we
  // intended to touch; catches a mis-push or an unexpected device-side
  // transform before it can become a saved corruption.
  let verifyWords: Uint16Array;
  try {
    const verifyBytes = await dumpWorkingBufferBytes(ctx);
    const verifyParsed = parsePresetDump(verifyBytes);
    verifyWords = deframePresetImage(verifyParsed);
  } catch (err) {
    return {
      ok: false,
      stage: 'verify',
      applied: patch.applied,
      refused: patch.refused,
      reason: `read-back verify failed to read/parse: ${err instanceof Error ? err.message : String(err)}. The working buffer's contents after the push are UNCONFIRMED; refusing to STORE.`,
    };
  }
  if (verifyWords.length !== patch.patchedWords.length) {
    return {
      ok: false,
      stage: 'verify',
      applied: patch.applied,
      refused: patch.refused,
      reason: `read-back word count ${verifyWords.length} != expected ${patch.patchedWords.length}; refusing to STORE.`,
    };
  }
  const mismatches: number[] = [];
  for (let i = 0; i < verifyWords.length; i++) {
    if (verifyWords[i] !== patch.patchedWords[i]) mismatches.push(i);
  }
  if (mismatches.length > 0) {
    const first = mismatches[0];
    return {
      ok: false,
      stage: 'verify',
      applied: patch.applied,
      refused: patch.refused,
      reason:
        `read-back mismatch at ${mismatches.length} word(s) (first: word ${first}, expected ` +
        `${patch.patchedWords[first]}, device holds ${verifyWords[first]}); refusing to STORE. ` +
        `The working buffer may not match what was pushed; do not trust it as saved-safe.`,
    };
  }

  if (options?.save_authorized !== true) {
    return { ok: true, stage: 'done', applied: patch.applied, refused: patch.refused };
  }

  // Safeguard #4b: STORE only after a clean push AND a clean verify.
  let targetLocation = options.target_location;
  if (targetLocation === undefined) {
    try {
      const activeWire = await getActivePresetNumber(ctx);
      targetLocation = activeWire + 1; // wire 0-indexed -> display 1-indexed
    } catch (err) {
      return {
        ok: false,
        stage: 'store',
        applied: patch.applied,
        refused: patch.refused,
        reason:
          `save_authorized but no target_location was given and the active preset number could not ` +
          `be read (${err instanceof Error ? err.message : String(err)}). The patched preset IS in the ` +
          `working buffer, verified clean; pass target_location explicitly to retry the save.`,
      };
    }
  }
  if (writer.savePreset === undefined) {
    // Unreachable in practice: this module is Axe-Fx-II-specific and
    // writer.savePreset is always implemented here, but DeviceWriter
    // declares it optional, so guard rather than assert.
    return {
      ok: false,
      stage: 'store',
      applied: patch.applied,
      refused: patch.refused,
      reason: 'writer.savePreset is not implemented; the working buffer holds the verified patch but it was not persisted.',
    };
  }
  const saveResult = await writer.savePreset(ctx, targetLocation);
  if (!saveResult.acked) {
    return {
      ok: false,
      stage: 'store',
      applied: patch.applied,
      refused: patch.refused,
      reason: saveResult.warning ?? 'save_preset did not ack; the working buffer holds the verified patch but it was not persisted.',
    };
  }
  return {
    ok: true,
    stage: 'done',
    applied: patch.applied,
    refused: patch.refused,
    saved_to_location: targetLocation,
  };
}
