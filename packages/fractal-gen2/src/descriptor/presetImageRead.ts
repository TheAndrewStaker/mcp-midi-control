/**
 * BK-081: atomic whole-preset param read via the `0x77/0x78/0x79`
 * preset-image dump, decoded through the TLV chain
 * (`fractal-gen2/presetImageTlv.ts`).
 *
 * `get_preset`'s prior read path (`readAllParams` in `reader.ts`) issues
 * one fn=0x1F SYSEX_GET_ALL_PARAMS round-trip PER PLACED BLOCK, serially.
 * Each round-trip is itself atomic (the device's state-broadcast triple
 * carries a channel-blocked X+Y snapshot for that one block), but the
 * SNAPSHOT AS A WHOLE is not: between block K's request and block K+1's
 * request (~50-150ms apart on Q8.02, ~1-2s total across a 12-block
 * preset), a front-panel edit, a foot-switch scene change, or a
 * concurrent editor write could mutate device state, producing a
 * composite snapshot that never existed on the device at any single
 * instant: the "streamed per-param path that can tear" the BK-081 ask
 * names.
 *
 * This module reads the WHOLE preset in one request (the edit-buffer
 * dump, hardware-confirmed no-reload-side-effect, HW-132) and decodes
 * every placed block's X/Y param values from that ONE captured instant,
 * closing the cross-block tear window entirely. Trust gate: the
 * round-trip-identity precondition (`presetImageRoundTrip.ts`): a
 * mismatch means this preset's composition isn't lossless under our TLV
 * walker for this specific dump, so the caller must fall back to the
 * per-block path rather than serve possibly-misattributed values.
 *
 * Scope: X/Y CONTINUOUS + enum param VALUES for every block present in
 * the chain. Does NOT cover per-scene bypass/channel-select for scenes
 * OTHER than the active one; the per-block scene/bypass/X-Y state words
 * inside payloads remain UNMAPPED (STATE-AXEFX2.md 2026-07-02 entry).
 * The active scene's bypass/channel still comes from fn=0x0E
 * QUERY_STATES (read separately by `reader.ts`, unaffected by this
 * module). Grid topology (slot row/col) also stays a separate fn=0x01
 * read; the TLV chain's "record table" is explicitly NOT reliable for
 * enumerating placed blocks (see `presetImageTlv.ts` module docstring).
 */

import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { BLOCK_BY_ID } from 'fractal-midi/gen2/axe-fx-ii';

import { parsePresetDump } from '../presetDump.js';
import { parsePresetImage, type AxeFxIIPresetImage } from '../presetImageTlv.js';
import { verifyRoundTripIdentity } from '../presetImageRoundTrip.js';
import { dumpWorkingBufferBytes } from './patchDumpIo.js';
import { decodeGroupValues } from './paramGroupIndex.js';

/** One block's decoded param state from the whole-preset image. */
export interface ImageBlockParams {
  readonly x: Record<string, number | string>;
  /** undefined when the block's payload is odd-length (no Y half: VolPan, Enhancer, MegaTap, Crossover). */
  readonly y: Record<string, number | string> | undefined;
  readonly bypass: boolean | undefined;
  readonly bypassMode: string | undefined;
}

export interface PresetImageReadResult {
  readonly ok: true;
  readonly name: string;
  /** Keyed by wire_id (== AxeFxIIBlock.id / effectId). */
  readonly blockParams: ReadonlyMap<number, ImageBlockParams>;
  readonly toneMatchPresent: boolean;
}

export interface PresetImageReadFailure {
  readonly ok: false;
  readonly reason: string;
}

export type PresetImageReadOutcome = PresetImageReadResult | PresetImageReadFailure;

/**
 * Dump the working buffer, walk the TLV chain, and decode every placed
 * block's X/Y param values from the single captured image. Never throws:
 * every failure mode (wire timeout, malformed dump, TLV walk failure,
 * round-trip-identity mismatch) returns `{ ok: false, reason }` so the
 * caller can fall back to the per-block fn=0x1F path transparently.
 */
/**
 * Fast-fail window for the OPPORTUNISTIC image-read attempt: if the device
 * hasn't sent even the first PATCH_DUMP frame within this window, it isn't
 * answering fn=0x03 at all (stale handle, older firmware, or a test/mock
 * transport); bail out and let the caller fall back to the per-block
 * fn=0x1F path immediately, rather than stalling `get_preset` for the full
 * `PATCH_DUMP_TIMEOUT_MS` (5s) before even starting the fallback. Once the
 * first frame arrives, `collectPatchDump` extends to the full ceiling for
 * the remaining ~65 frames of a real (~1-2s) transfer. See CLAUDE.md
 * "Performance budget": an opportunistic pre-check must not itself blow
 * the read-tool latency budget when it doesn't pan out.
 */
const IMAGE_READ_FIRST_FRAME_TIMEOUT_MS = 900;

export async function readPresetImageSnapshot(ctx: DispatchCtx, modelId?: number): Promise<PresetImageReadOutcome> {
  let bytes: Uint8Array;
  try {
    bytes = await dumpWorkingBufferBytes(ctx, { firstFrameTimeoutMs: IMAGE_READ_FIRST_FRAME_TIMEOUT_MS, modelId });
  } catch (err) {
    return { ok: false, reason: `dump failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed;
  try {
    parsed = parsePresetDump(bytes);
  } catch (err) {
    return { ok: false, reason: `dump parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const rt = verifyRoundTripIdentity(parsed);
  if (!rt.ok) {
    return { ok: false, reason: rt.reason };
  }

  let image: AxeFxIIPresetImage;
  try {
    image = parsePresetImage(rt.words);
  } catch (err) {
    // Shouldn't happen: verifyRoundTripIdentity already ran parsePresetImage
    // successfully, but defensive in case a future refactor decouples them.
    return { ok: false, reason: `TLV parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const blockParams = new Map<number, ImageBlockParams>();
  for (const block of [...image.blocks, ...image.systemTail]) {
    const codecBlock = BLOCK_BY_ID[block.wireId];
    if (codecBlock === undefined) continue; // unregistered wire_id (e.g. Tone Match 170): no param catalog
    const groupCode = codecBlock.groupCode;
    const perChannel = block.xToYOffset ?? block.payloadLen;
    const xValues = Array.from(image.words.slice(block.baseWord, block.baseWord + perChannel));
    const xDecoded = decodeGroupValues(groupCode, xValues);
    let yOut: Record<string, number | string> | undefined;
    if (block.xToYOffset !== undefined) {
      const yStart = block.baseWord + block.xToYOffset;
      const yValues = Array.from(image.words.slice(yStart, yStart + perChannel));
      yOut = decodeGroupValues(groupCode, yValues).out;
    }
    blockParams.set(block.wireId, {
      x: xDecoded.out,
      y: yOut,
      bypass: xDecoded.bypass,
      bypassMode: xDecoded.bypassMode,
    });
  }

  return {
    ok: true,
    name: image.name,
    blockParams,
    toneMatchPresent: image.toneMatchPresent,
  };
}
