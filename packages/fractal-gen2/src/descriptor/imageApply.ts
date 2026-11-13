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
 *   5. save: safeguard #4b, the INJECTED `savePresetFn` (the config
 *               writer's hardware-verified STORE_PRESET path), ONLY
 *               reached after a clean push AND a clean verify AND
 *               `save_authorized: true`.
 *
 * WIRED (2026-07-16, BK-084 wiring lane): `createAtomicImageApply` is the
 * config-parameterized factory `createWriter(config)` binds into
 * `writer.applyPresetRetune` (apply_preset mode:'retune'), per
 * `docs/_private/ATOMIC-APPLY-WIRING-DESIGN-2026-07-16.md`. The factory
 * threads `config.modelByte` into every dump/push call site and takes the
 * STORE path as an injected function instead of importing the XL+
 * `writer` singleton (kills the triple model-byte pin; the XL+ is the
 * only config that registers the capability today, AX8 excluded until an
 * AX8 dump corpus exists to oracle its image grammar).
 *
 * Push-NACK / verify-mismatch recovery (wiring-judge graft 1): on a push
 * NACK, ONE fast-fail probe re-dump classifies the buffer before anything
 * else: probe==patched → the push actually landed (continue as success);
 * probe==pre-patch → buffer intact (no recovery needed; the caller may
 * stream-fallback); neither → ONE recovery push of the pristine pre-patch
 * dump (the dump doubles as an automatic backup), verified; a failed
 * recovery is the honest `buffer_state:'unknown'` terminal.
 */

import type {
  DispatchCtx,
  LocationRef,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';

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
  /**
   * Two-phase timeout for the INITIAL dump (see `CollectPatchDumpOptions`).
   * The retune path passes 900 so an opportunistic image attempt against a
   * device/port that doesn't answer fn=0x03 fast-fails into the streamed
   * fallback instead of stalling 5 s (BK-081's performance-budget catch).
   * Omitted: the original single-window behavior.
   */
  readonly firstFrameTimeoutMs?: number;
  /**
   * All-or-nothing gate (retune contract): when true, ANY per-entry patch
   * refusal aborts the whole operation with ZERO push frames sent, instead
   * of pushing the entries that did apply. Default false preserves the
   * pre-wiring pipeline behavior (partial patches push).
   */
  readonly refusePartial?: boolean;
}

/**
 * What the working buffer provably holds when the pipeline returns.
 * 'untouched' = refused before any push (zero state-changing wire ops);
 * 'patched-verified' = the patched image, word-exact read-back;
 * 'original-intact' = the pre-patch image (push never landed);
 * 'original-restored' = the pre-patch image, re-pushed + verified;
 * 'unknown' = none of the above could be proven.
 */
export type AtomicBufferState =
  | 'untouched'
  | 'patched-verified'
  | 'original-intact'
  | 'original-restored'
  | 'unknown';

export interface AtomicApplyOutcome {
  readonly ok: boolean;
  /** Where the pipeline stopped. 'done' only on full success. */
  readonly stage: 'refused' | 'push' | 'verify' | 'store' | 'done';
  readonly applied: readonly AppliedContinuousPatch[];
  readonly refused: readonly RefusedContinuousPatch[];
  readonly reason?: string;
  readonly nacks?: readonly { frame_index: number; detail?: string }[];
  readonly saved_to_location?: string | number;
  /** Why stage==='refused', when it is. Lets the caller pick fallback vs validation-refusal. */
  readonly refusal_kind?: 'dump-read' | 'identity' | 'patch-entries' | 'no-patches';
  /** Image pushes attempted: 1 = single push; 2 = a recovery push of the pristine dump fired. 0 = none. */
  readonly push_attempts: number;
  readonly buffer_state: AtomicBufferState;
  /** Non-fatal observations (e.g. "push NACKed but the probe shows it landed"). */
  readonly notes?: readonly string[];
}

export interface AtomicImageApplyConfig {
  /** SysEx model byte threaded into every dump/push frame (XL+ 0x07). */
  readonly modelByte: number;
  readonly deviceLabel: string;
}

/** The injected STORE path: the config writer's hardware-verified savePreset. */
export type SavePresetFn = (ctx: DispatchCtx, location: LocationRef) => Promise<WriteResult>;

export type AtomicImageApply = (
  ctx: DispatchCtx,
  patches: readonly ContinuousParamPatchInput[],
  options?: AtomicApplyOptions,
) => Promise<AtomicApplyOutcome>;

/** Fast-fail probe dump: de-framed words, or undefined when the read fails. */
async function tryDumpWords(
  ctx: DispatchCtx,
  modelId: number,
  firstFrameTimeoutMs: number,
): Promise<Uint16Array | undefined> {
  try {
    const bytes = await dumpWorkingBufferBytes(ctx, { modelId, firstFrameTimeoutMs });
    return deframePresetImage(parsePresetDump(bytes));
  } catch {
    return undefined;
  }
}

function wordsEqual(a: Uint16Array, b: Uint16Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Build the BK-084 v1 pipeline bound to one Axe-Fx II family config.
 * The returned function never throws; every failure mode returns
 * `{ ok: false, stage, reason, buffer_state }` so the tool-layer caller
 * formats a structured refusal instead of an uncaught rejection.
 */
export function createAtomicImageApply(
  config: AtomicImageApplyConfig,
  savePresetFn: SavePresetFn,
): AtomicImageApply {
  const modelId = config.modelByte;
  const deviceLabel = config.deviceLabel;

  /** Graft-1 recovery: ONE push of the pristine pre-patch dump, verified. */
  async function recoverOriginal(
    ctx: DispatchCtx,
    dumpBytes: Uint8Array,
    sourceWords: Uint16Array,
  ): Promise<'original-restored' | 'unknown'> {
    try {
      const recovery = await restorePresetBinaryAxeFxII(ctx, dumpBytes, { modelId, deviceLabel });
      if (!recovery.ok) return 'unknown';
    } catch {
      return 'unknown';
    }
    const words = await tryDumpWords(ctx, modelId, 900);
    if (words !== undefined && wordsEqual(words, sourceWords)) return 'original-restored';
    return 'unknown';
  }

  return async function applyContinuousParamsAtomic(
    ctx: DispatchCtx,
    patches: readonly ContinuousParamPatchInput[],
    options?: AtomicApplyOptions,
  ): Promise<AtomicApplyOutcome> {
    let dumpBytes: Uint8Array;
    try {
      dumpBytes = await dumpWorkingBufferBytes(ctx, {
        modelId,
        firstFrameTimeoutMs: options?.firstFrameTimeoutMs,
      });
    } catch (err) {
      return {
        ok: false,
        stage: 'refused',
        refusal_kind: 'dump-read',
        push_attempts: 0,
        buffer_state: 'untouched',
        applied: [],
        refused: [],
        reason: `working-buffer dump failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const patch = applyContinuousParamsToImage(dumpBytes, patches);
    if (!patch.ok) {
      const refusalKind: AtomicApplyOutcome['refusal_kind'] = patch.reason.includes('no patches given')
        ? 'no-patches'
        : patch.reason.includes('all refused')
          ? 'patch-entries'
          : 'identity'; // round-trip-identity / dump-parse / TLV-parse: the image isn't trustworthy to address
      return {
        ok: false,
        stage: 'refused',
        refusal_kind: refusalKind,
        push_attempts: 0,
        buffer_state: 'untouched',
        applied: [],
        refused: patch.refused ?? [],
        reason: patch.reason,
      };
    }
    // Retune's all-or-nothing contract: a single refused entry means the
    // response would not describe what the push did; send ZERO frames.
    if (options?.refusePartial === true && patch.refused.length > 0) {
      return {
        ok: false,
        stage: 'refused',
        refusal_kind: 'patch-entries',
        push_attempts: 0,
        buffer_state: 'untouched',
        applied: patch.applied,
        refused: patch.refused,
        reason:
          `all-or-nothing refusal: ${patch.refused.length} patch entr${patch.refused.length === 1 ? 'y' : 'ies'} refused ` +
          `(see refused[]); zero push frames were sent.`,
      };
    }

    const notes: string[] = [];
    let pushAttempts = 1;
    let verifyWords: Uint16Array | undefined;

    // Safeguard #4a: push to the WORKING BUFFER ONLY. Never pass save
    // options to this call; STORE only happens after read-back verify below.
    const pushResult = await restorePresetBinaryAxeFxII(ctx, patch.patchedBytes, { modelId, deviceLabel });
    if (!pushResult.ok) {
      // Graft 1: probe-classify BEFORE any recovery. One fast-fail re-dump.
      const probe = await tryDumpWords(ctx, modelId, 900);
      if (probe !== undefined && wordsEqual(probe, patch.patchedWords)) {
        notes.push(
          `push NACKed (${pushResult.nacks.length} frame(s)) but the probe re-dump word-matches the patched ` +
          `image: the push actually landed; continuing as success.`,
        );
        verifyWords = probe; // the probe IS the read-back verify
      } else if (probe !== undefined && wordsEqual(probe, patch.sourceWords)) {
        return {
          ok: false,
          stage: 'push',
          push_attempts: pushAttempts,
          buffer_state: 'original-intact',
          applied: patch.applied,
          refused: patch.refused,
          nacks: pushResult.nacks,
          reason:
            `push NACKed (${pushResult.nacks.length} frame(s)) and the probe re-dump matches the pre-patch ` +
            `image: the working buffer is intact; no recovery push needed.`,
        };
      } else {
        pushAttempts = 2;
        const recovered = await recoverOriginal(ctx, dumpBytes, patch.sourceWords);
        return {
          ok: false,
          stage: 'push',
          push_attempts: pushAttempts,
          buffer_state: recovered,
          applied: patch.applied,
          refused: patch.refused,
          nacks: pushResult.nacks,
          reason: recovered === 'original-restored'
            ? `push NACKed (${pushResult.nacks.length} frame(s)); the pristine pre-patch image was re-pushed and ` +
              `verified clean. The working buffer holds the original preset.`
            : `push NACKed (${pushResult.nacks.length} frame(s)) and recovery could not be verified. The working ` +
              `buffer state is UNKNOWN; switching presets discards it safely; nothing was saved.`,
        };
      }
    }

    // Safeguard #2: post-push read-back verify. Re-dump and confirm the
    // ENTIRE image equals the expected patched words, not just the words we
    // intended to touch; catches a mis-push or an unexpected device-side
    // transform before it can become a saved corruption.
    if (verifyWords === undefined) {
      try {
        const verifyBytes = await dumpWorkingBufferBytes(ctx, { modelId });
        verifyWords = deframePresetImage(parsePresetDump(verifyBytes));
      } catch (err) {
        return {
          ok: false,
          stage: 'verify',
          push_attempts: pushAttempts,
          buffer_state: 'unknown',
          applied: patch.applied,
          refused: patch.refused,
          reason: `read-back verify failed to read/parse: ${err instanceof Error ? err.message : String(err)}. The working buffer's contents after the push are UNCONFIRMED; refusing to STORE.`,
        };
      }
    }
    if (!wordsEqual(verifyWords, patch.patchedWords)) {
      // Same recovery branch as the push NACK (graft 1): the verify dump
      // already in hand IS the probe.
      if (wordsEqual(verifyWords, patch.sourceWords)) {
        return {
          ok: false,
          stage: 'verify',
          push_attempts: pushAttempts,
          buffer_state: 'original-intact',
          applied: patch.applied,
          refused: patch.refused,
          reason:
            'read-back verify matches the PRE-PATCH image: the push did not land; the working buffer is intact.',
        };
      }
      pushAttempts += 1;
      const recovered = await recoverOriginal(ctx, dumpBytes, patch.sourceWords);
      return {
        ok: false,
        stage: 'verify',
        push_attempts: pushAttempts,
        buffer_state: recovered,
        applied: patch.applied,
        refused: patch.refused,
        reason: recovered === 'original-restored'
          ? 'read-back verify mismatched the patched image; the pristine pre-patch image was re-pushed and verified clean. Refusing to STORE.'
          : 'read-back verify mismatched the patched image and recovery could not be verified. The working buffer state is UNKNOWN; switching presets discards it safely; nothing was saved.',
      };
    }

    if (options?.save_authorized !== true) {
      return {
        ok: true,
        stage: 'done',
        push_attempts: pushAttempts,
        buffer_state: 'patched-verified',
        applied: patch.applied,
        refused: patch.refused,
        ...(notes.length > 0 ? { notes } : {}),
      };
    }

    // Safeguard #4b: STORE only after a clean push AND a clean verify.
    let targetLocation = options.target_location;
    if (targetLocation === undefined) {
      try {
        const activeWire = await getActivePresetNumber(ctx, modelId);
        targetLocation = activeWire + 1; // wire 0-indexed -> display 1-indexed
      } catch (err) {
        return {
          ok: false,
          stage: 'store',
          push_attempts: pushAttempts,
          buffer_state: 'patched-verified',
          applied: patch.applied,
          refused: patch.refused,
          reason:
            `save_authorized but no target_location was given and the active preset number could not ` +
            `be read (${err instanceof Error ? err.message : String(err)}). The patched preset IS in the ` +
            `working buffer, verified clean; pass target_location explicitly to retry the save.`,
        };
      }
    }
    const saveResult = await savePresetFn(ctx, targetLocation);
    if (!saveResult.acked) {
      return {
        ok: false,
        stage: 'store',
        push_attempts: pushAttempts,
        buffer_state: 'patched-verified',
        applied: patch.applied,
        refused: patch.refused,
        reason: saveResult.warning ?? 'save_preset did not ack; the working buffer holds the verified patch but it was not persisted.',
      };
    }
    return {
      ok: true,
      stage: 'done',
      push_attempts: pushAttempts,
      buffer_state: 'patched-verified',
      applied: patch.applied,
      refused: patch.refused,
      saved_to_location: targetLocation,
      ...(notes.length > 0 ? { notes } : {}),
    };
  };
}
