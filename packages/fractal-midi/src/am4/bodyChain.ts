/**
 * AM4 decoded-BODY block-record chain walker + AMP param-value decode.
 *
 * The AM4 preset body (`decodeAm4RawPatch(...).decompressedBody`) is a
 * WALKABLE variable-length BLOCK-RECORD CHAIN, not a fixed offset table
 * (proof: an amp type-swap shrank a body's decompSize 5344 -> 4528 —
 * downstream offsets shift when a block's type changes, so a fixed table
 * cannot describe it). Diff-anchored against the AM4 factory bank +
 * hardware warm-pair captures (2026-07-02); see primitive
 * `am4-body-block-record-chain` and the AM4 SYSEX-MAP body section.
 *
 * ── Structure (AMP block, byte-exact) ────────────────────────────────
 *
 *   marker  u16 == the block's pidLow (amp = BLOCK_TYPE_VALUES.amp = 0x003a)
 *           followed by a 0x0E-byte record header (words 1..4 are zero on a
 *           real block record; word 5/6 carry block-level fields), then
 *           4 per-channel records A/B/C/D at `AM4_BODY_CHANNEL_STRIDE`
 *           (0x130 bytes) each.
 *
 *   Within a channel record, a param's word lives at
 *     off = ampMarker + channel*0x130 + 0x0E + pidHigh*2
 *   (the "pidHigh + 7 words" rule; 0x0E header bytes = 7 words).
 *
 * CONFIRMED anchors (byte-exact, warm-pair oracle):
 *   - amp.type   chA pidHigh 0x0A  off 0x22  (ordinal -> AMP_TYPES roster)
 *   - amp.gain   chA pidHigh 0x0B  off 0x24  (0x828E = round(5.1/10*65534) = 5.1)
 *   - amp.gain   chB pidHigh 0x0B  off 0x154 (pins the 0x130 channel stride)
 *   - amp.master chA pidHigh 0x0F  off 0x2C  (0x828E = 5.1)
 * The remaining registered amp knobs ride the SAME confirmed record geometry
 * (marker + stride + pidHigh-rule), decoded through the shipped param scaling;
 * they are formula-extrapolated from the four anchors, not individually pinned.
 *
 * ── Config-dependent base (MUST be walked, never hardcoded) ──────────
 * The amp marker sits at body offset 0x0934 in 69/104 factory presets and
 * 0x0A92 in 17 (an extra pre-amp record enlarges the modifier region by
 * 0x15E), and is ABSENT in 17 (16 empty presets + one intentional
 * 'Bass NoAmp DI'). `locateAm4AmpBlock` scans + validates the record shape,
 * so it finds the marker in every config without a hardcoded offset.
 *
 * ── The WHOLE chain (decoded 2026-11-12) ─────────────────────────────
 * The amp record above is one instance of a uniform, self-describing record:
 *
 *   word 0      effect id (== the block's pidLow; a second instance is id+1)
 *   words 1..4  zero
 *   word 5      cols  (param words per channel row)
 *   word 6      rows  (4 = channels A/B/C/D, 1 = a single shared row)
 *   then        cols * rows param words; a param sits at row*cols + pidHigh
 *
 * The chain starts right after the four scene records (body 0x0144), runs
 * record to record with no gaps, and ends 2 bytes before decompSize in all
 * 104 factory presets and every fw 2.00 hardware dump on hand. It holds the
 * always-present system records (0x02, 0x03..0x12, Input 0x25, Output 0x2A,
 * Cab 0x3E, PATCH 0xCE) plus one record per PLACED block, in ascending id
 * order. The record layout equals the fn 0x1F chunk (`channel*cols + pidHigh`),
 * so `walkAm4BodyChain` + `decodeAm4PresetBody` decode every registered param
 * of every placed block through the shipped param scaling.
 *
 * Slot order, scene state and volatile words are documented on the constants
 * below; evidence and offsets are in the AM4 SYSEX-MAP body section and the
 * `am4-body-block-record-chain` primitive.
 */

import {
  KNOWN_PARAMS,
  decode as am4Decode,
  roundDisplayValue,
  type Param,
} from './params.js';
import { AMP_TYPES } from './cacheEnums.js';
import { BLOCK_NAMES_BY_VALUE, BLOCK_TYPE_VALUES, type BlockTypeName } from './blockTypes.js';

/** amp effectId marker (== amp pidLow) in the decoded body. */
const AMP_MARKER = BLOCK_TYPE_VALUES.amp; // 0x003a
/** Amp TYPE ordinal bound — a valid marker's 4 channel types are all < this. */
const AMP_TYPE_ORDINAL_COUNT = AMP_TYPES.length; // 248

/** Per-channel record stride (A -> B -> C -> D), in BYTES. */
export const AM4_BODY_CHANNEL_STRIDE = 0x130;
/** Record-header size between the effectId marker and the pidHigh-0 param word, in BYTES. */
export const AM4_BODY_BLOCK_HEADER_BYTES = 0x0e;
/** Number of per-channel records in an amp block (A/B/C/D). */
export const AM4_BODY_AMP_CHANNEL_COUNT = 4;

const CHANNEL_LETTERS = ['A', 'B', 'C', 'D'] as const;

/** amp.type pidHigh — used to read the raw ordinal for `type_id`. */
const AMP_TYPE_PID_HIGH = 0x0a;

/** Body-scan lower bound: the amp block always follows the scene + modifier
 *  region, which starts well past 0x0200 in every observed preset. Scanning
 *  from here skips the preset/scene header where 0x003a could collide. */
const AMP_SCAN_START = 0x0200;
/** Body-scan upper bound: the amp block base has never exceeded ~0x0B00; cap
 *  the scan generously below any FX region to avoid deep value collisions. */
const AMP_SCAN_END = 0x1400;

function u16le(body: Uint8Array, off: number): number {
  return ((body[off] ?? 0) | ((body[off + 1] ?? 0) << 8)) & 0xffff;
}

/**
 * Locate the AMP block's marker offset in a decoded preset body, or return
 * `undefined` when the preset has no amp (empties + 'Bass NoAmp DI').
 *
 * Validation (rejects value-collision false positives — a bare `u16 == 0x003a`
 * scan hits param values and modifier/routing records that reference the amp
 * effectId):
 *   1. `u16 == AMP_MARKER` (0x003a).
 *   2. Record-header words 1..4 (offsets +2,+4,+6,+8) are all zero — the
 *      signature of a real block record; modifier/routing records carry a
 *      nonzero effectId in word 1.
 *   3. All four channel TYPE ordinals (base + ch*stride + 0x22) are in
 *      [0, 247] (a valid AMP_TYPES index).
 *   4. The full 4-channel span fits inside the decompressed body.
 * Validated against the 104-preset factory bank (70 @0x0934, 17 @0x0A92,
 * 17 absent) with zero false positives, and the amp warm-pair captures.
 */
export function locateAm4AmpBlock(body: Uint8Array, decompSize?: number): number | undefined {
  const limit = Math.min(decompSize ?? body.length, body.length);
  const lastChannelBase = (AM4_BODY_AMP_CHANNEL_COUNT - 1) * AM4_BODY_CHANNEL_STRIDE;
  const typeOff = AM4_BODY_BLOCK_HEADER_BYTES + AMP_TYPE_PID_HIGH * 2; // 0x22
  const scanEnd = Math.min(AMP_SCAN_END, limit);
  for (let o = AMP_SCAN_START; o + lastChannelBase + typeOff + 1 < limit && o < scanEnd; o += 2) {
    if (u16le(body, o) !== AMP_MARKER) continue;
    if (u16le(body, o + 2) !== 0 || u16le(body, o + 4) !== 0 ||
        u16le(body, o + 6) !== 0 || u16le(body, o + 8) !== 0) continue;
    let ok = true;
    for (let ch = 0; ch < AM4_BODY_AMP_CHANNEL_COUNT; ch++) {
      if (u16le(body, o + ch * AM4_BODY_CHANNEL_STRIDE + typeOff) >= AMP_TYPE_ORDINAL_COUNT) {
        ok = false;
        break;
      }
    }
    if (ok) return o;
  }
  return undefined;
}

/**
 * Decode one stored amp-record chunk word to its display value. Mirrors the
 * shipped per-paramId decode (reader `decodeChunkValue`):
 *   - enum: `enumValues[wire]`, falling back to the raw ordinal.
 *   - non-enum: internal = wire / 65534 (Q16 -> [0..1]), then the shipped
 *     `am4Decode` applies the per-unit scale. Scaling is NOT reimplemented.
 */
function decodeAmpChunkValue(param: Param, wire: number): number | string {
  if (param.unit === 'enum') {
    const enumValues = param.enumValues as Record<number, string> | undefined;
    return enumValues?.[wire] ?? wire;
  }
  const internal = wire / 65534;
  return roundDisplayValue(param, am4Decode(param, internal));
}

/** Per-channel amp knob maps: `{ A: { type, gain, ... }, B: {...}, ... }`. */
export interface Am4AmpBlockValues {
  /** Body offset of the amp effectId marker (config-dependent; walked). */
  readonly base: number;
  /** Channel letter -> (param name -> display value). Shaped for `whole_preset.amp`. */
  readonly channels: Record<string, Record<string, number | string>>;
}

/**
 * Locate + decode the AMP block from a decoded preset body. Returns
 * `undefined` when the preset has no amp block (the marker doesn't validate).
 *
 * Surfaces every REGISTERED amp param (params.ts `block === 'amp'`,
 * `pidLow === 0x003a`) whose word fits inside the channel record, for all
 * four channels A/B/C/D, decoded to display units through the shipped param
 * scaling. Each channel also carries `type_id` (the raw amp-model ordinal)
 * alongside `type` (its roster name) for gen-3 parity. Params that overflow
 * the channel stride (synthetic-high pidHigh like the amp channel selector)
 * are skipped rather than misattributed.
 */
export function decodeAm4AmpBlock(body: Uint8Array, decompSize?: number): Am4AmpBlockValues | undefined {
  const base = locateAm4AmpBlock(body, decompSize);
  if (base === undefined) return undefined;
  const limit = Math.min(decompSize ?? body.length, body.length);

  const ampParams = Object.values(KNOWN_PARAMS)
    .map((p) => p as Param)
    .filter((p) => p.block === 'amp' && p.pidLow === AMP_MARKER);

  const channels: Record<string, Record<string, number | string>> = {};
  for (let ch = 0; ch < AM4_BODY_AMP_CHANNEL_COUNT; ch++) {
    const chBase = base + ch * AM4_BODY_CHANNEL_STRIDE;
    const chOut: Record<string, number | string> = {};

    // type_id: the raw amp-model ordinal, for gen-3 parity with amp1 views.
    const typeOff = chBase + AM4_BODY_BLOCK_HEADER_BYTES + AMP_TYPE_PID_HIGH * 2;
    if (typeOff + 1 < limit) chOut.type_id = u16le(body, typeOff);

    for (const p of ampParams) {
      const rel = AM4_BODY_BLOCK_HEADER_BYTES + p.pidHigh * 2;
      if (rel >= AM4_BODY_CHANNEL_STRIDE) continue; // would overflow into the next channel
      const off = chBase + rel;
      if (off + 1 >= limit) continue;
      chOut[p.name] = decodeAmpChunkValue(p, u16le(body, off));
    }
    channels[CHANNEL_LETTERS[ch]] = chOut;
  }
  return { base, channels };
}

// ── Whole-chain walk + per-block decode ──────────────────────────────

/** Body offset of the first chain record: right after the 4 scene records (0x04 + 4 * 0x50). */
export const AM4_BODY_CHAIN_START = 0x0144;
/** Bytes left after the last chain record in every dump on hand. */
export const AM4_BODY_CHAIN_TAIL_BYTES = 2;
/** Record header word index of `cols` / `rows`. */
const RECORD_COLS_WORD = 5;
const RECORD_ROWS_WORD = 6;

/** PATCH record (effect id == pidLow 0x00CE): preset-level registers, one row. */
export const AM4_BODY_PATCH_RECORD_ID = 0x00ce;
/** PATCH word of slot 1's block id; slots 2..4 follow (== BLOCK_SLOT_PID_HIGH_BASE). */
export const AM4_BODY_PATCH_SLOT_WORD = 0x0f;
/** PATCH word holding the location index the buffer was loaded from. Not preset content. */
export const AM4_BODY_PATCH_LOCATION_WORD = 0x0a;
/** PATCH word that churns between back-to-back dumps of an untouched preset. Not preset content. */
export const AM4_BODY_PATCH_VOLATILE_WORD = 0x0e;
/** Body offset of the active scene (0-based u16): the scene the preset was saved on. */
export const AM4_BODY_ACTIVE_SCENE_OFFSET = 0x0000;

/** Scene record: offset (from the record start) of slot 1's channel word; one per slot at 4-byte stride. */
export const AM4_BODY_SCENE_CHANNEL_OFFSET = 0x20;
/** Scene record: offset of slot 1's bypass word (nonzero = bypassed); one per slot at 4-byte stride. */
export const AM4_BODY_SCENE_BYPASS_OFFSET = 0x30;
const SCENE_RECORD_BASE = 0x0004;
const SCENE_RECORD_STRIDE = 0x50;
const SCENE_COUNT = 4;
const SLOT_COUNT = 4;
const SCENE_SLOT_STRIDE = 4;

/** One record of the body chain. */
export interface Am4BodyRecord {
  /** Effect id (== block pidLow; a second instance of a block is id + 1). */
  readonly id: number;
  /** Body offset of the record header. */
  readonly offset: number;
  /** Body offset of the first param word (offset + 0x0E). */
  readonly paramsOffset: number;
  readonly cols: number;
  readonly rows: number;
}

export interface Am4BodyChain {
  readonly records: readonly Am4BodyRecord[];
  /**
   * True when the walk consumed the body exactly (last record ends
   * `AM4_BODY_CHAIN_TAIL_BYTES` before decompSize). When false the layout is
   * not the one this decoder knows and nothing from it should be trusted.
   */
  readonly complete: boolean;
}

/**
 * Walk the block-record chain of a decoded preset body. Self-describing: each
 * record names its own id and table size, so no per-block size table and no
 * marker scan is involved.
 */
export function walkAm4BodyChain(body: Uint8Array, decompSize?: number): Am4BodyChain {
  const limit = Math.min(decompSize ?? body.length, body.length);
  const records: Am4BodyRecord[] = [];
  let o = AM4_BODY_CHAIN_START;
  while (o + AM4_BODY_BLOCK_HEADER_BYTES <= limit) {
    const cols = u16le(body, o + RECORD_COLS_WORD * 2);
    const rows = u16le(body, o + RECORD_ROWS_WORD * 2);
    if (u16le(body, o + 2) !== 0 || u16le(body, o + 4) !== 0 ||
        u16le(body, o + 6) !== 0 || u16le(body, o + 8) !== 0) break;
    if (cols === 0 || (rows !== 1 && rows !== AM4_BODY_AMP_CHANNEL_COUNT)) break;
    const paramsOffset = o + AM4_BODY_BLOCK_HEADER_BYTES;
    const next = paramsOffset + cols * rows * 2;
    if (next > limit) break;
    records.push({ id: u16le(body, o), offset: o, paramsOffset, cols, rows });
    o = next;
  }
  return { records, complete: records.length > 0 && o + AM4_BODY_CHAIN_TAIL_BYTES === limit };
}

/** One placed block of a preset body, with every registered param per channel row. */
export interface Am4StoredBlock {
  /** 1-based slot in the signal chain. */
  readonly slot: number;
  /** Block name, or undefined when the effect id is not in the block dictionary. */
  readonly block: BlockTypeName | undefined;
  /** Effect id as stored in the slot register. */
  readonly effectId: number;
  /** 1-based instance (2 = the block's second instance, effect id base + 1). */
  readonly instance: number;
  /** Rows of the block's own record (4 = A/B/C/D). 0 when the record is missing. */
  readonly rows: number;
  /** Channel letter -> (param name -> display value). One entry per row. */
  readonly channels: Record<string, Record<string, number | string>>;
  /** Per scene (4): the channel this block's slot selects. */
  readonly sceneChannels: readonly string[];
  /** Per scene (4): whether this block's slot is bypassed. */
  readonly sceneBypass: readonly boolean[];
}

export interface Am4PresetBody {
  /** Effect id per slot 1..4 (0 = empty). */
  readonly slotEffectIds: readonly number[];
  /** Placed blocks in slot order (empty slots omitted). */
  readonly blocks: readonly Am4StoredBlock[];
  /** 0-based active scene (in a stored dump: the scene the preset was saved on). */
  readonly activeScene: number;
}

/**
 * Records that back a block name besides its own: for the amp, the cab section
 * (0x3E, four rows) and the amp-page registers kept in the one-row PATCH record
 * (channel LED colours), which land on channel A's entry like the live read.
 */
const EXTRA_RECORD_IDS: Partial<Record<BlockTypeName, readonly number[]>> = {
  amp: [0x003e, AM4_BODY_PATCH_RECORD_ID],
};

const PARAMS_BY_BLOCK_AND_PIDLOW: ReadonlyMap<string, readonly Param[]> = (() => {
  const acc = new Map<string, Param[]>();
  for (const param of Object.values(KNOWN_PARAMS)) {
    const p = param as Param;
    const key = `${p.block}:${p.pidLow}`;
    const list = acc.get(key);
    if (list === undefined) acc.set(key, [p]); else list.push(p);
  }
  return acc;
})();

/**
 * Decode the whole decoded body: slot order, every placed block's registered
 * params for each channel row, and the per-scene channel + bypass state.
 * Returns `undefined` when the chain walk does not consume the body exactly,
 * or the PATCH record is missing, so a layout this decoder does not know
 * yields nothing instead of misplaced values.
 */
export function decodeAm4PresetBody(body: Uint8Array, decompSize?: number): Am4PresetBody | undefined {
  const chain = walkAm4BodyChain(body, decompSize);
  if (!chain.complete) return undefined;
  const byId = new Map<number, Am4BodyRecord>();
  for (const r of chain.records) byId.set(r.id, r);
  const patch = byId.get(AM4_BODY_PATCH_RECORD_ID);
  if (patch === undefined || patch.cols < AM4_BODY_PATCH_SLOT_WORD + SLOT_COUNT) return undefined;

  const slotEffectIds: number[] = [];
  for (let s = 0; s < SLOT_COUNT; s++) {
    slotEffectIds.push(u16le(body, patch.paramsOffset + (AM4_BODY_PATCH_SLOT_WORD + s) * 2));
  }

  const blocks: Am4StoredBlock[] = [];
  for (let s = 0; s < SLOT_COUNT; s++) {
    const effectId = slotEffectIds[s];
    if (effectId === 0) continue;
    // A second instance of a block is stored as effect id base + 1.
    let block: BlockTypeName | undefined = BLOCK_NAMES_BY_VALUE[effectId];
    let instance = 1;
    if (block === undefined && BLOCK_NAMES_BY_VALUE[effectId - 1] !== undefined) {
      block = BLOCK_NAMES_BY_VALUE[effectId - 1];
      instance = 2;
    }
    const own = byId.get(effectId);
    const channels: Record<string, Record<string, number | string>> = {};
    if (block !== undefined && own !== undefined) {
      const basePidLow = effectId - (instance - 1);
      const sources: Array<{ rec: Am4BodyRecord; pidLow: number }> = [{ rec: own, pidLow: basePidLow }];
      for (const extra of EXTRA_RECORD_IDS[block] ?? []) {
        const rec = byId.get(extra);
        if (rec !== undefined) sources.push({ rec, pidLow: extra });
      }
      for (let row = 0; row < own.rows; row++) {
        const out: Record<string, number | string> = {};
        for (const { rec, pidLow } of sources) {
          if (row >= rec.rows) continue;
          for (const p of PARAMS_BY_BLOCK_AND_PIDLOW.get(`${block}:${pidLow}`) ?? []) {
            if (p.pidHigh >= rec.cols) continue; // synthetic registers outside the table
            out[p.name] = decodeAmpChunkValue(p, u16le(body, rec.paramsOffset + (row * rec.cols + p.pidHigh) * 2));
          }
        }
        channels[CHANNEL_LETTERS[row]] = out;
      }
    }
    const sceneChannels: string[] = [];
    const sceneBypass: boolean[] = [];
    for (let n = 0; n < SCENE_COUNT; n++) {
      const rec = SCENE_RECORD_BASE + n * SCENE_RECORD_STRIDE;
      const ch = u16le(body, rec + AM4_BODY_SCENE_CHANNEL_OFFSET + s * SCENE_SLOT_STRIDE);
      sceneChannels.push(CHANNEL_LETTERS[ch] ?? `ch_${ch}`);
      sceneBypass.push(u16le(body, rec + AM4_BODY_SCENE_BYPASS_OFFSET + s * SCENE_SLOT_STRIDE) !== 0);
    }
    blocks.push({
      slot: s + 1, block, effectId, instance, rows: own?.rows ?? 0, channels, sceneChannels, sceneBypass,
    });
  }
  return { slotEffectIds, blocks, activeScene: u16le(body, AM4_BODY_ACTIVE_SCENE_OFFSET) };
}

/**
 * A copy of the decoded body with the words that are NOT preset content
 * zeroed (the PATCH record's source-location pointer and its volatile word),
 * so two bodies compare equal exactly when the presets hold the same content.
 * Returns `undefined` when the chain does not walk cleanly.
 */
export function am4ComparableBody(body: Uint8Array, decompSize?: number): Uint8Array | undefined {
  const chain = walkAm4BodyChain(body, decompSize);
  if (!chain.complete) return undefined;
  const patch = chain.records.find((r) => r.id === AM4_BODY_PATCH_RECORD_ID);
  if (patch === undefined) return undefined;
  const out = body.slice(0, Math.min(decompSize ?? body.length, body.length));
  for (const word of [AM4_BODY_PATCH_LOCATION_WORD, AM4_BODY_PATCH_VOLATILE_WORD]) {
    if (word >= patch.cols) continue;
    out[patch.paramsOffset + word * 2] = 0;
    out[patch.paramsOffset + word * 2 + 1] = 0;
  }
  return out;
}
