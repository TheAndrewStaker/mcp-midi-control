/**
 * Axe-Fx II 0x77/0x78/0x79 PATCH_DUMP wire I/O, shared by every caller
 * that needs the raw 66-frame preset-dump byte stream (export_preset's
 * `dumpActivePresetBinary`, the BK-081 atomic `get_preset` image read,
 * and the BK-081/BK-084 atomic-apply RMW orchestration).
 *
 * Extracted from `descriptor/reader.ts` (2026-07-09) so the wire-collection
 * logic lives in exactly one place; before this split, `reader.ts` held its
 * own private copy that a second caller would have had to duplicate.
 *
 * SOURCE SEMANTICS (hardware-confirmed Q8.02, 2026-06-10, HW-132):
 *   - fn 0x03 + the `0x7F 0x7F` sentinel = the EDIT BUFFER: tracks live
 *     buffer edits, has NO reload side effect, and round-trips back to the
 *     device cleanly (`buildEditBufferDumpRequest`). This is the ONLY safe
 *     way to read the *active* working buffer.
 *   - fn 0x03 + a preset number = the STORED flash copy, and the request
 *     RELOADS that copy into the working buffer (destroys unsaved edits;
 *     `buildPatchDumpRequest`). Never use this form for an "active" read.
 */

import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  AXE_FX_II_XL_PLUS_MODEL_ID,
  buildEditBufferDumpRequest,
  buildGetPresetNumber,
  isGetPresetNumberResponse,
  parseGetPresetNumberResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

const FN_PATCH_HEADER = 0x77;
const FN_PATCH_CHUNK = 0x78;
const FN_PATCH_FOOTER = 0x79;

/** Frames in one PATCH_DUMP stream: 1 header + 64 chunks + 1 footer. */
export const PATCH_DUMP_FRAME_COUNT = 66;
export const PATCH_DUMP_TIMEOUT_MS = 5000;
const GET_RESPONSE_TIMEOUT_MS = 800;

function isPatchFrame(b: number[], expectedModelId: number): boolean {
  return (
    b.length >= 6
    && b[0] === 0xf0
    && b[1] === 0x00
    && b[2] === 0x01
    && b[3] === 0x74
    && b[4] === expectedModelId
    && (b[5] === FN_PATCH_HEADER || b[5] === FN_PATCH_CHUNK || b[5] === FN_PATCH_FOOTER)
  );
}

export interface CollectPatchDumpOptions {
  /**
   * When set, enables a two-phase timeout: if NO patch frame arrives
   * within `firstFrameTimeoutMs` of the caller's send, reject fast (the
   * device/port isn't answering this request at all: a stale handle, an
   * older firmware, or a mock/test transport that doesn't implement it).
   * Once the FIRST frame arrives, the fast-fail timer is cancelled and the
   * full `PATCH_DUMP_TIMEOUT_MS` ceiling applies to the remaining 65
   * frames (a real 66-frame transfer legitimately takes ~1-2s once it has
   * started). Omitted (default): the original single-timer behavior, one
   * `PATCH_DUMP_TIMEOUT_MS` window for the WHOLE collection, unchanged
   * since before this option existed. `export_preset` (`dumpActivePresetBinary`)
   * deliberately keeps the default: it is an explicit, no-fallback user
   * request, so waiting the full window is correct there. The BK-081
   * opportunistic `get_preset` image-read attempt (`presetImageRead.ts`)
   * is the one caller that passes this; it needs a bounded worst-case add-on
   * cost when the device doesn't support the request, not a 5s stall before
   * falling back to the per-block path (CLAUDE.md performance budget).
   */
  firstFrameTimeoutMs?: number;
  /**
   * SysEx model byte to match inbound frames against. Defaults to the XL+
   * (0x07) for back-compat; a non-XL+ config (e.g. AX8, 0x08) must pass its
   * own model byte or every inbound frame will be silently dropped as
   * "not ours" and the read will time out.
   */
  modelId?: number;
}

/**
 * Collect the 66-frame PATCH_DUMP reply. The caller MUST invoke this
 * BEFORE sending the request so the burst can't outrace the listener.
 */
export function collectPatchDump(ctx: DispatchCtx, options?: CollectPatchDumpOptions): Promise<number[][]> {
  const firstFrameTimeoutMs = options?.firstFrameTimeoutMs;
  const modelId = options?.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
  return new Promise<number[][]>((resolve, reject) => {
    const collected: number[][] = [];
    let fastFailTimer: ReturnType<typeof setTimeout> | undefined;
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (fastFailTimer !== undefined) clearTimeout(fastFailTimer);
      if (ceilingTimer !== undefined) clearTimeout(ceilingTimer);
      unsub();
    };

    const unsub = ctx.conn.onMessage((bytes) => {
      if (!isPatchFrame(bytes, modelId)) return;
      if (collected.length === 0 && fastFailTimer !== undefined) {
        // First frame arrived: the device IS answering this request.
        // Cancel the fast-fail timer and give the transfer the full
        // ceiling to finish the remaining frames.
        clearTimeout(fastFailTimer);
        fastFailTimer = undefined;
        ceilingTimer = setTimeout(() => {
          cleanup();
          reject(new Error(
            `Timed out waiting for Axe-Fx II PATCH_DUMP after ${collected.length} frames `
            + `(expected ${PATCH_DUMP_FRAME_COUNT}).`,
          ));
        }, PATCH_DUMP_TIMEOUT_MS);
      }
      collected.push([...bytes]);
      if (bytes[5] === FN_PATCH_FOOTER) {
        cleanup();
        resolve(collected);
      }
    });

    if (firstFrameTimeoutMs !== undefined) {
      fastFailTimer = setTimeout(() => {
        cleanup();
        reject(new Error(
          `No response to Axe-Fx II PATCH_DUMP request within ${firstFrameTimeoutMs}ms `
          + `(0 of ${PATCH_DUMP_FRAME_COUNT} frames); the device/port may not answer this request.`,
        ));
      }, firstFrameTimeoutMs);
    } else {
      // Original single-timer behavior: one PATCH_DUMP_TIMEOUT_MS window
      // for the whole collection, unchanged for existing callers.
      ceilingTimer = setTimeout(() => {
        cleanup();
        reject(new Error(
          `Timed out waiting for Axe-Fx II PATCH_DUMP after ${collected.length} frames `
          + `(expected ${PATCH_DUMP_FRAME_COUNT}).`,
        ));
      }, PATCH_DUMP_TIMEOUT_MS);
    }
  });
}

/**
 * Dump the ACTIVE working buffer via the edit-buffer sentinel (no reload
 * side effect, HW-132) and flatten the 66 frames into the verbatim
 * `.syx` byte stream. Throws a plain `Error` on any wire failure or a
 * frame-count mismatch; callers wrap it in whatever `DispatchError` shape
 * fits their tool's contract.
 */
export async function dumpWorkingBufferBytes(ctx: DispatchCtx, options?: CollectPatchDumpOptions): Promise<Uint8Array> {
  const framesPromise = collectPatchDump(ctx, options);
  ctx.conn.send(buildEditBufferDumpRequest({ modelId: options?.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID }));
  const frames = await framesPromise;
  if (frames.length !== PATCH_DUMP_FRAME_COUNT) {
    throw new Error(
      `edit-buffer dump returned ${frames.length} frames; expected ${PATCH_DUMP_FRAME_COUNT}.`,
    );
  }
  const flat: number[] = [];
  for (const f of frames) for (const b of f) flat.push(b);
  return Uint8Array.from(flat);
}

/** Read the device's currently-active preset number (0-indexed wire form). */
export async function getActivePresetNumber(ctx: DispatchCtx, modelId: number = AXE_FX_II_XL_PLUS_MODEL_ID): Promise<number> {
  const respP = ctx.conn.receiveSysExMatching(isGetPresetNumberResponse, GET_RESPONSE_TIMEOUT_MS);
  ctx.conn.send(buildGetPresetNumber({ modelId }));
  const bytes = await respP;
  return parseGetPresetNumberResponse(bytes).presetNumber;
}
