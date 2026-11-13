/**
 * BK-084: atomic-apply v1, continuous-param read-modify-write patch.
 *
 * Pure function: takes a preset-dump byte buffer and a list of
 * display-value patches, returns a byte-exact patched dump plus a footer
 * hash recomputed via the XOR-fold (the `xor-fold-hash` primitive). NO MIDI
 * I/O; the wire orchestration (dump → this function → push → verify →
 * optional save) lives in `descriptor/imageApply.ts`.
 *
 * Scope EXACTLY per `docs/design/ii-atomic-apply-safety-review.md` §4
 * "v1: SHIP":
 *   - only paramIds that are REGISTERED CONTINUOUS knobs with a KNOWN
 *     CALIBRATION (`controlType === 'knob'` AND `resolveParamKind` has
 *     both `encodeDisplay`/`decodeWire`); the exact set `set_param`
 *     already drives audibly and safely today;
 *   - only on a block wire_id PRESENT in the parsed TLV chain of the
 *     dump in hand (never guesses a layout);
 *   - only X, or Y on an even-payload (two-channel) block; `paramWordIndex`
 *     throws (refused, not silently mis-addressed) on an odd-payload block.
 * Refused (stays on the incremental `set_param`/`apply_preset` path):
 *   - enum / type / effect_type / bypass paramIds (`controlType !== 'knob'`);
 *   - any paramId not present in `resolveParamKind`'s calibrated set;
 *   - any block absent from the dump's TLV chain.
 *
 * Safeguard #1 (round-trip-identity precondition): every patch call runs
 * `verifyRoundTripIdentity` FIRST and refuses the WHOLE operation (no
 * bytes touched) if it fails: the dump doesn't deframe/parse cleanly, or
 * its footer hash doesn't match our formula, so it isn't trustworthy to
 * address at all. (An earlier draft of that check also required byte-2's
 * "reserved" bits to be zero; a real-corpus sweep this session showed
 * 386/388 presets carry non-zero values there (routine, documented
 * firmware behavior per the `septet-21bit-byte2-mask-preservation` primitive,
 * NOT a corruption signal), so that requirement was removed. See
 * `presetImageRoundTrip.ts`'s docstring for the full correction.)
 *
 * Safeguard #3 (continuous-param-only scope) is enforced per-patch above;
 * a refused patch is reported in `refused[]`, never silently dropped.
 *
 * Safeguards #2 (post-push read-back verify) and #4 (NACK-abort +
 * STORE-gating) are wire-side and live in `descriptor/imageApply.ts`,
 * which also reuses the ALREADY-hardware-verified push path
 * (`descriptor/presetRestore.ts` `restorePresetBinaryAxeFxII`) rather than
 * re-implementing frame pacing / NACK detection a second time.
 *
 * Writeback invariant: only the specific target ushort's 3 wire bytes are
 * ever rewritten (`writeUshortAt`, preserving byte-2's high-5 device-private
 * bits per `(b2 & 0x7c) | (value >> 14 & 0x03)`, hardware-verified NACK-free
 * 2026-05-22, see `preset-binary-encoding.md` "Atomic apply procedure").
 * Every OTHER byte in the dump is copied from the source verbatim: there is
 * no whole-image re-serialization step that could silently clobber
 * untouched words' reserved bits.
 */

import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { resolveBlock, findParamFuzzy, type AxeFxIIBlock, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';

import {
  parsePresetDump,
  serializePresetDump,
  CHUNKS_PER_PRESET,
  type ParsedPresetDump,
} from './presetDump.js';
import {
  deframePresetImage,
  parsePresetImage,
  paramWordIndex,
  type AxeFxIIPresetImage,
  type PresetImageBlock,
} from './presetImageTlv.js';
import { verifyRoundTripIdentity } from './presetImageRoundTrip.js';

export interface ContinuousParamPatchInput {
  /** Block display name ("Amp 1") or effectId. Resolved via `resolveBlock`. */
  readonly block: string | number;
  readonly paramName: string;
  readonly channel: 'X' | 'Y';
  /** Display value (knob position, dB, ms, ...); display-first, never wire. */
  readonly displayValue: number | string;
}

export interface AppliedContinuousPatch {
  readonly block: string;
  readonly paramName: string;
  readonly channel: 'X' | 'Y';
  readonly wordIndex: number;
  readonly beforeWire: number;
  readonly afterWire: number;
  readonly displayValue: number | string;
}

export interface RefusedContinuousPatch {
  readonly input: ContinuousParamPatchInput;
  readonly reason: string;
}

export type PatchImageResult =
  | {
      readonly ok: true;
      readonly patchedBytes: Uint8Array;
      readonly applied: readonly AppliedContinuousPatch[];
      readonly refused: readonly RefusedContinuousPatch[];
      readonly newFooterHash: number;
      /** The pre-patch de-framed words, used by imageApply.ts's read-back verify. */
      readonly sourceWords: Uint16Array;
      /** The post-patch de-framed words, expected read-back result. */
      readonly patchedWords: Uint16Array;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly refused?: readonly RefusedContinuousPatch[];
    };

/**
 * Byte-level ushort patch, preserving byte-2's device-private high bits.
 * Ported verbatim from the hardware-verified 2026-05-22 procedure
 * (`preset-binary-encoding.md` "Atomic apply procedure", `research/atomicApply.ts`
 * `writeUshortAt`); NOT re-derived, so the byte-2 mask can't drift.
 */
function writeUshortAt(payload: Uint8Array, ushortIdx: number, value: number): void {
  const off = 2 + ushortIdx * 3;
  payload[off] = value & 0x7f;
  payload[off + 1] = (value >> 7) & 0x7f;
  payload[off + 2] = (payload[off + 2] & 0x7c) | ((value >> 14) & 0x03);
}

/**
 * BK-084 (wiring-judge graft 3): the STATIC image-patch eligibility
 * predicate, exported as the single source of truth for the retune
 * preflight classification and its refusal messages. A param is
 * image-patch-eligible iff (a) it is not enum-like (`controlType ===
 * 'select'` or a registered `enumValues` table) and (b) it has a known
 * calibration (both `encodeDisplay` and `decodeWire` registered) — the
 * exact set `set_param` already drives audibly today.
 *
 * BUG FIX (2026-07-17, hardware stress-test session): this predicate
 * used to hard-refuse anything whose RAW catalog `controlType` wasn't
 * exactly `'knob'`, including `controlType: 'unknown'` params that DO
 * carry a working calibration via the suffix-rule overlay (e.g.
 * `gateexpander.mix`: raw catalog controlType is `'unknown'`, but
 * `getCalibration` resolves it to a real 0..100% knob via the bare-
 * "mix" suffix rule, and `writer.setParam` happily drives it live
 * today). `writer.setParam`'s own enum gate is `controlType ===
 * 'select' || 'enumValues' in param` — it does NOT require
 * `controlType === 'knob'` — so the old image-patch gate was STRICTER
 * than the live write surface it claims to mirror, contradicting this
 * docstring's own "the exact set set_param already drives audibly
 * today" claim. Caught live on hardware: a 37-param retune batch on
 * "Boston Tone" spanning 9 block families refused ALL-OR-NOTHING
 * because `gateexpander.mix` alone tripped the old `controlType !==
 * 'knob'` check, even though the other 36 params (and gateexpander.mix
 * itself via set_param) were all individually fine.
 *
 * `controlType === 'switch'` (boolean toggles, e.g. `amp.bright_switch`)
 * is EXCLUDED EXPLICITLY rather than folded into the "not enum, so
 * accept" branch: `resolveParamKind` gives switches a working
 * `encodeDisplay`/`decodeWire` pair too (bool-coerced), so a purely
 * calibration-based gate would silently accept them, but this codebase
 * has no capture-cited evidence for how a boolean is PACKED inside the
 * preset image word (a dedicated ushort per switch, vs a bitfield
 * shared with neighboring flags) — unlike the continuous knobs, whose
 * one-ushort-per-param layout is captured and byte-verified. Refusing
 * switches defensively (not silently, not folded into the generic
 * "no calibration" message) keeps the "no guessed wire paths" line:
 * `set_param`'s live fn=0x2e/fn=0x02 path is untouched by this gate.
 */
export function isImagePatchEligibleParam(param: AxeFxIIParam): { ok: true } | { ok: false; reason: string } {
  const isEnumLike = param.controlType === 'select' || 'enumValues' in param;
  if (isEnumLike) {
    return {
      ok: false,
      reason:
        `${param.block}.${param.name} is an enum/type value (controlType="${param.controlType}"), ` +
        `not a continuous knob. Atomic image-patch v1 only writes registered continuous knobs; use set_param instead.`,
    };
  }
  if (param.controlType === 'switch') {
    return {
      ok: false,
      reason:
        `${param.block}.${param.name} is a boolean toggle (controlType="switch"). Its packing inside the preset ` +
        `image word is not confirmed against a hardware capture (unlike one-ushort-per-param continuous knobs), so ` +
        `atomic image-patch v1 refuses it defensively; use set_param instead (the live write path is unaffected).`,
    };
  }
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  if (kind.encodeDisplay === undefined || kind.decodeWire === undefined) {
    return {
      ok: false,
      reason:
        `${param.block}.${param.name} has no known calibration (source="${kind.source}"). ` +
        `Atomic image-patch v1 requires a registered, calibrated continuous knob (the same set set_param drives audibly today).`,
    };
  }
  return { ok: true };
}

function findTlvBlock(image: AxeFxIIPresetImage, wireId: number): PresetImageBlock | undefined {
  return image.blocks.find((b) => b.wireId === wireId) ?? image.systemTail.find((b) => b.wireId === wireId);
}

/**
 * Patch a preset dump's already-placed continuous param words in place.
 * Refuses the WHOLE operation (returns `{ ok: false }`, zero bytes
 * touched) if the round-trip-identity precondition fails or the dump
 * fails to parse. Individual patches that fail their own checks (not a
 * continuous knob, block not in the chain, channel/paramId out of
 * range) are reported per-entry in `refused[]`; the rest still apply.
 */
export function applyContinuousParamsToImage(
  dumpBytes: Uint8Array,
  patches: readonly ContinuousParamPatchInput[],
): PatchImageResult {
  if (patches.length === 0) {
    return { ok: false, reason: 'applyContinuousParamsToImage: no patches given.' };
  }

  let parsed: ParsedPresetDump;
  try {
    parsed = parsePresetDump(dumpBytes);
  } catch (err) {
    return { ok: false, reason: `dump parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const rt = verifyRoundTripIdentity(parsed);
  if (!rt.ok) {
    return {
      ok: false,
      reason: `round-trip-identity precondition failed, refusing to patch: ${rt.reason}`,
    };
  }

  let image: AxeFxIIPresetImage;
  try {
    image = parsePresetImage(rt.words);
  } catch (err) {
    return { ok: false, reason: `TLV parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const applied: AppliedContinuousPatch[] = [];
  const refused: RefusedContinuousPatch[] = [];
  // Copies of the source chunk payloads; every byte we don't explicitly
  // patch stays byte-for-byte identical to the source.
  const newChunks: Uint8Array[] = parsed.chunkPayloads.map((c) => Uint8Array.from(c));

  for (const input of patches) {
    const block: AxeFxIIBlock | undefined = resolveBlock(input.block);
    if (block === undefined) {
      refused.push({ input, reason: `unknown block "${input.block}".` });
      continue;
    }
    const param = findParamFuzzy(block, input.paramName);
    if (param === undefined) {
      refused.push({ input, reason: `block "${block.name}" has no param matching "${input.paramName}".` });
      continue;
    }
    const scopeCheck = isImagePatchEligibleParam(param);
    if (!scopeCheck.ok) {
      refused.push({ input, reason: scopeCheck.reason });
      continue;
    }
    const tlvBlock = findTlvBlock(image, block.id);
    if (tlvBlock === undefined) {
      refused.push({
        input,
        reason: `block "${block.name}" (wire_id ${block.id}) is not present in this preset's TLV chain: it is not placed.`,
      });
      continue;
    }
    let wordIndex: number;
    try {
      wordIndex = paramWordIndex(tlvBlock, param.paramId, input.channel);
    } catch (err) {
      refused.push({ input, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
    let wireValueRaw: number;
    try {
      // encodeDisplay presence already confirmed by isImagePatchEligibleParam.
      wireValueRaw = kind.encodeDisplay!(input.displayValue);
    } catch (err) {
      refused.push({ input, reason: `display value encode failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const wireValue = Math.round(wireValueRaw);
    if (!Number.isFinite(wireValue) || wireValue < 0 || wireValue > 0xffff) {
      refused.push({ input, reason: `encoded wire value ${wireValueRaw} is out of the 16-bit 0..65535 range.` });
      continue;
    }
    const before = rt.words[wordIndex];
    const chunkIdx = wordIndex >> 6; // 64 words per chunk
    const ushortIdx = wordIndex & 63;
    writeUshortAt(newChunks[chunkIdx], ushortIdx, wireValue);
    applied.push({
      block: block.name,
      paramName: param.name,
      channel: input.channel,
      wordIndex,
      beforeWire: before,
      afterWire: wireValue,
      displayValue: input.displayValue,
    });
  }

  if (applied.length === 0) {
    return { ok: false, reason: 'no patches applied (all refused).', refused };
  }

  const patchedParsed: ParsedPresetDump = { ...parsed, chunkPayloads: newChunks };
  const patchedWords = deframePresetImage(patchedParsed);
  let hash = 0;
  for (const w of patchedWords) hash ^= (w & 0xffff);
  hash &= 0xffff;
  const newFooter = new Uint8Array([
    hash & 0x7f,
    (hash >> 7) & 0x7f,
    (parsed.footerPayload[2] & 0x7c) | ((hash >> 14) & 0x03),
  ]);
  const patchedBytes = serializePresetDump({
    raw: parsed.raw,
    headerPayload: parsed.headerPayload,
    chunkPayloads: newChunks,
    footerPayload: newFooter,
  });

  return {
    ok: true,
    patchedBytes,
    applied,
    refused,
    newFooterHash: hash,
    sourceWords: rt.words,
    patchedWords,
  };
}

// Re-exported so goldens can assert chunk count without a second import.
export { CHUNKS_PER_PRESET };
