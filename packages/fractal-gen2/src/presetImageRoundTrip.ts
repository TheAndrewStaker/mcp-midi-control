/**
 * Axe-Fx II preset-image round-trip-identity precondition.
 *
 * The linchpin safeguard named in `docs/design/ii-atomic-apply-safety-review.md`
 * §5: before trusting the TLV walker's decode of a SPECIFIC preset (for a
 * read OR a patch), confirm the dump is structurally well-formed under our
 * decode model AND that our footer XOR-fold formula reproduces what this
 * dump's own footer already encodes.
 *
 * CORRECTED 2026-07-09 (same session, caught by a real-corpus sweep before
 * shipping): an earlier draft of this check additionally re-encoded every
 * word from its DECODED value alone (byte-2 = only the value's top 2 bits,
 * as if byte-2's other 5 bits were always zero) and compared against the
 * source bytes, on the theory that a non-zero "reserved" bit would signal
 * an untrustworthy dump. Running that check against the 388-dump corpus
 * (`samples/factory/*.syx` + `samples/captured/hw132/*.syx`) refuted the
 * premise: 386/388 REAL presets carry non-zero byte-2 top bits somewhere
 * in the image (e.g. word 544 = chunk 8 offset 32 on nearly every factory
 * preset). This is NOT a corruption signal; it is exactly the documented,
 * ALREADY-KNOWN behavior in the `septet-21bit-byte2-mask-preservation` primitive:
 * "DO NOT assume byte 2 reserved bits are always 0. They are not; they
 * carry firmware-defined state. Read-modify-write is required; blind-write
 * is wrong." The naive re-encode check was testing the WRONG invariant (can
 * we reconstruct the whole image from 16-bit words alone) instead of the
 * one that actually matters (does our WRITE preserve those bits, which
 * `presetImageContinuousPatch.ts`'s `writeUshortAt` already does via
 * `(origByte2 & 0x7c) | (value >> 14 & 0x03)` (read-modify-write, never a
 * wholesale reconstruction). Shipping the naive check would have refused
 * to patch or atomically read almost every real preset, defeating BK-081/
 * BK-084 entirely. Removed; see the corrected scope below.
 *
 * What this DOES verify, and why each check is meaningful (not tautological):
 *   1. `deframePresetImage` succeeds: every one of the 64 chunks declares
 *      exactly 64 words (a structural invariant; a mismatch means this
 *      dump isn't the fixed 4096-word shape our model assumes).
 *   2. `parsePresetImage` succeeds: the TLV chain reaches a wire_id==0
 *      terminator without running past the image (a real preset-corruption
 *      or unknown-format detector; the 388-dump corpus in
 *      `verify-ii-preset-image-tlv.ts` already confirms this holds broadly,
 *      but a specific dump in hand could still be an edge case).
 *   3. The footer's XOR-fold hash matches what OUR formula computes over
 *      the decoded words: confirms our hash model (the `xor-fold-hash` primitive)
 *      actually applies to THIS dump (wrong device/model byte, a corrupted
 *      upload, or a firmware whose hash differs would fail here).
 *
 * Consumed by:
 *   - `descriptor/presetImageRead.ts` (BK-081 atomic get_preset read)
 *   - `presetImageContinuousPatch.ts` (BK-084 atomic-apply v1 RMW patch)
 */

import type { ParsedPresetDump } from './presetDump.js';
import { deframePresetImage, parsePresetImage } from './presetImageTlv.js';

export type RoundTripCheck =
  | { readonly ok: true; readonly words: Uint16Array }
  | { readonly ok: false; readonly reason: string };

/**
 * Deframe + strictly parse the TLV chain, then confirm the source footer
 * already encodes the XOR-fold hash our own formula predicts for the
 * decoded words. Pure: no MIDI I/O, no mutation of `parsed`.
 */
export function verifyRoundTripIdentity(parsed: ParsedPresetDump): RoundTripCheck {
  let words: Uint16Array;
  try {
    words = deframePresetImage(parsed);
  } catch (err) {
    return { ok: false, reason: `deframe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    parsePresetImage(words);
  } catch (err) {
    return { ok: false, reason: `TLV walk failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let hash = 0;
  for (const w of words) hash ^= (w & 0xffff);
  hash &= 0xffff;
  const f = parsed.footerPayload;
  const expectedLo = hash & 0x7f;
  const expectedMid = (hash >> 7) & 0x7f;
  const expectedHiBits = (hash >> 14) & 0x03;
  if (f[0] !== expectedLo || f[1] !== expectedMid || (f[2] & 0x03) !== expectedHiBits) {
    return {
      ok: false,
      reason:
        `footer hash mismatch: recomputed 0x${hash.toString(16).padStart(4, '0')} does not match ` +
        `source footer bytes [${f[0]},${f[1]},${f[2]}]`,
    };
  }
  return { ok: true, words };
}
