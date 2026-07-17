/**
 * Axe-Fx II preset-dump-level encode operations.
 *
 * Thin orchestration over the image-layer lanes: parse the 12,951-byte
 * dump, run the ROUND-TRIP-IDENTITY precondition (refuse the whole
 * operation, zero bytes touched, when the dump does not deframe/walk
 * cleanly or its footer hash does not match our formula, or when this
 * codec cannot re-encode it byte-exactly), apply the image op, re-frame
 * with a recomputed 21-bit footer XOR-fold, and serialize.
 *
 * Every lane is community-beta / hardware-unverified on the push side;
 * see the per-lane module docstrings for the evidence and the itemized
 * refusals. Q8.02 / XL+ scoped.
 */

import {
  parseIIPresetDumpFrames,
  serializeIIPresetDumpFrames,
  framesFromImage,
  verifyImageRoundTrip,
  type AxeFxIIImageBuffer,
  type AxeFxIIPresetDumpFrames,
} from './frames.js';
import {
  applyDiscreteSelectsToImage,
  type IIDiscretePatchInput,
  type IIAppliedDiscretePatch,
  type IIRefusedDiscretePatch,
} from './discretePatch.js';
import {
  applySceneStateToImage,
  type IISceneStateOp,
  type IIAppliedSceneOp,
  type IIRefusedSceneOp,
} from './sceneWords.js';
import {
  removeBlockFromImage,
  insertBlockIntoImage,
  type IIInsertBlockInput,
  type IIRemoveBlockResult,
  type IIInsertBlockResult,
} from './structure.js';

interface DumpContext {
  readonly frames: AxeFxIIPresetDumpFrames;
  readonly image: AxeFxIIImageBuffer;
}

function openDump(bytes: Uint8Array): DumpContext | { readonly reason: string } {
  let frames: AxeFxIIPresetDumpFrames;
  try {
    frames = parseIIPresetDumpFrames(bytes);
  } catch (err) {
    return { reason: `dump parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rt = verifyImageRoundTrip(frames);
  if (!rt.ok) {
    return { reason: `round-trip-identity precondition failed, refusing to patch: ${rt.reason}` };
  }
  try {
    // Strict TLV walk is part of the trust gate (parse errors refuse).
    // applyX lanes re-walk internally; this catches it up front.
    // (verifyImageRoundTrip validates framing + hash + re-encode.)
    return { frames, image: rt.image };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

function sealDump(frames: AxeFxIIPresetDumpFrames, image: AxeFxIIImageBuffer): Uint8Array {
  // The footer is the full 21-bit XOR-fold of the patched image; every
  // bit of it is computed, none preserved.
  const rebuilt = framesFromImage(image, frames.headerPayload);
  return serializeIIPresetDumpFrames(rebuilt);
}

export type IIDumpDiscreteResult =
  | {
      readonly ok: true;
      readonly patchedBytes: Uint8Array;
      readonly applied: readonly IIAppliedDiscretePatch[];
      readonly refused: readonly IIRefusedDiscretePatch[];
    }
  | { readonly ok: false; readonly reason: string; readonly refused?: readonly IIRefusedDiscretePatch[] };

/** Discrete rostered-select patch over a whole dump. */
export function applyDiscreteSelectsToDump(
  bytes: Uint8Array,
  patches: readonly IIDiscretePatchInput[],
): IIDumpDiscreteResult {
  const ctx = openDump(bytes);
  if ('reason' in ctx) return { ok: false, reason: ctx.reason };
  const result = applyDiscreteSelectsToImage(ctx.image, patches);
  if (!result.ok) return result;
  return {
    ok: true,
    patchedBytes: sealDump(ctx.frames, result.image),
    applied: result.applied,
    refused: result.refused,
  };
}

export type IIDumpSceneResult =
  | {
      readonly ok: true;
      readonly patchedBytes: Uint8Array;
      readonly applied: readonly IIAppliedSceneOp[];
      readonly refused: readonly IIRefusedSceneOp[];
    }
  | { readonly ok: false; readonly reason: string; readonly refused?: readonly IIRefusedSceneOp[] };

/** Scene-state (bypass / channel-Y per scene) ops over a whole dump. */
export function applySceneStateToDump(
  bytes: Uint8Array,
  ops: readonly IISceneStateOp[],
): IIDumpSceneResult {
  const ctx = openDump(bytes);
  if ('reason' in ctx) return { ok: false, reason: ctx.reason };
  const result = applySceneStateToImage(ctx.image, ops);
  if (!result.ok) return result;
  return {
    ok: true,
    patchedBytes: sealDump(ctx.frames, result.image),
    applied: result.applied,
    refused: result.refused,
  };
}

export type IIDumpRemoveResult =
  | ({ readonly patchedBytes: Uint8Array } & IIRemoveBlockResult)
  | { readonly ok: false; readonly reason: string };

/** Structural REMOVE over a whole dump. */
export function removeBlockFromDump(bytes: Uint8Array, wireId: number): IIDumpRemoveResult {
  const ctx = openDump(bytes);
  if ('reason' in ctx) return { ok: false, reason: ctx.reason };
  const result = removeBlockFromImage(ctx.image, wireId);
  if (!result.ok) return result;
  return { ...result, patchedBytes: sealDump(ctx.frames, result.image) };
}

export type IIDumpInsertResult =
  | ({ readonly patchedBytes: Uint8Array } & IIInsertBlockResult)
  | { readonly ok: false; readonly reason: string };

/** Structural PLACE over a whole dump. */
export function insertBlockIntoDump(bytes: Uint8Array, input: IIInsertBlockInput): IIDumpInsertResult {
  const ctx = openDump(bytes);
  if ('reason' in ctx) return { ok: false, reason: ctx.reason };
  const result = insertBlockIntoImage(ctx.image, input);
  if (!result.ok) return result;
  return { ...result, patchedBytes: sealDump(ctx.frames, result.image) };
}
