/**
 * Axe-Fx II preset-image TLV chain walk (strict) + bounded word
 * accessors.
 *
 * The de-framed 4096-word image is a self-describing TLV structure
 * (primitive `ii-preset-image-tlv-chain`, 388/388 corpus + BK-070
 * hardware anchors):
 *
 *   word 0        format tag 2049
 *   word 1        always 0 (502/502)
 *   words 2..33   preset name, 1 ASCII char per word, 0-terminated
 *   words 34..129 the GRID + ROUTING cell matrix (see ./grid.ts)
 *   word 130..    TLV chain: repeated [wire_id, payload_len, payload];
 *                 wire_id == 0 terminates. Modifier records (ids 1..20,
 *                 len 15) first, then effect blocks ALPHABETICAL by
 *                 squashed display name, then the system tail (an
 *                 ordered subsequence of [170, 139, 140, 142, 143, 141]).
 *   after the terminator: zeros, except the tone-match bulk region at
 *                 fixed word 2048 when block 170 is in the chain.
 *
 * CHANNEL-STORAGE REFINEMENT (2026-07-16, corpus 388/388): an even
 * payload does NOT imply X/Y halves. Eight block families store ONE
 * channel spanning the whole payload (their registered param ids span
 * [0..payloadLen-1], structurally incompatible with halving):
 * Filter, Formant, Multiband Compressor, Resonator, Ring Modulator,
 * Synth, Feedback Return, Output. For those, X-channel addressing is
 * bounded by the FULL payloadLen and there is no Y half. The halving
 * rule holds for every other even-payload family (BK-070 anchors).
 *
 * Scene-state words live INSIDE block payloads at the block family's
 * registered `<block>.bypass` housekeeping paramId (see
 * ./sceneWords.ts); `sceneStateWordIndex` is the DEDICATED accessor for
 * them, bounded by payloadLen, so the per-channel bound of
 * `imageParamWordIndex` stays a load-bearing safety gate and is never
 * relaxed.
 */

import { BLOCK_BY_ID, type AxeFxIIBlock } from '../blockTypes.js';
import { KNOWN_PARAMS } from '../params.js';
import { II_IMAGE_WORDS } from './frames.js';

/** word 0 of every II preset image. */
export const II_IMAGE_FORMAT_TAG = 2049;
/** Preset name region: words 2..33, one ASCII char per word. */
export const II_IMAGE_NAME_START = 2;
export const II_IMAGE_NAME_WORDS = 32;
/** First word of the TLV chain. */
export const II_TLV_CHAIN_START = 130;
/** Chain wire_ids below this are modifier-record slots (1..20 observed). */
export const II_BLOCK_WIRE_ID_MIN = 100;
/** Every modifier record in the corpus has this payload length. */
export const II_MODIFIER_PAYLOAD_LEN = 15;
/** Always-present system-tail blocks (139 Noisegate, 140 Output, 141 Controllers). */
export const II_SYSTEM_TAIL_WIRE_IDS = [139, 140, 141] as const;
/** Blocks that serialize in the tail region even though grid-placeable. */
export const II_TAIL_RESIDENT_WIRE_IDS = [170, 139, 140, 142, 143, 141] as const;
/** Tone-match block wire id. */
export const II_TONE_MATCH_WIRE_ID = 170;
/** Tone-match bulk region start (chain-independent, fixed; 4/4 corpus). */
export const II_TONE_MATCH_BULK_START = 2048;

/**
 * Block families that store ONE channel spanning the whole (even)
 * payload; no X/Y halving. Keyed by groupCode. Evidence: 448/448 corpus
 * instances in-range and mask-like at the full-payload bypass offset,
 * 0/448 under halving; each family's registered paramIds span
 * [0..payloadLen-1].
 */
export const II_SINGLE_CHANNEL_FULL_PAYLOAD_GROUPS: ReadonlySet<string> = new Set([
  'FIL', // Filter (len 14, bypass 8)
  'FRM', // Formant (12, 11)
  'MBC', // Multiband Compressor (28, 27)
  'RES', // Resonator (40, 38)
  'RNG', // Ring Modulator (10, 9)
  'SYN', // Synth (40, 28)
  'RTN', // Feedback Return (6, 5)
  'OUTPUT', // Output (20, 19)
]);

/** One modifier record from the chain head. Payload layout stays OPEN. */
export interface IIImageModifier {
  readonly slotId: number;
  readonly tlvWord: number;
  readonly payloadLen: number;
  /** Raw payload words. payload[8] is a block-id-shaped TARGET field. */
  readonly payload: readonly number[];
}

/** One block TLV (effect block, tone-match, or system-tail block). */
export interface IIImageBlock {
  readonly wireId: number;
  /** Registry entry when the wire id is known (display name, groupCode). */
  readonly block: AxeFxIIBlock | undefined;
  /** Word index of the TLV's wire_id word. */
  readonly tlvWord: number;
  /** Channel-X paramBase: tlvWord + 2. */
  readonly baseWord: number;
  /** Self-described payload length in words. Firmware-drifting. */
  readonly payloadLen: number;
  /**
   * Channel-Y offset: payloadLen / 2 for even-payload TWO-channel
   * blocks. undefined for odd payloads AND for the single-channel
   * full-payload families (see II_SINGLE_CHANNEL_FULL_PAYLOAD_GROUPS).
   */
  readonly xToYOffset: number | undefined;
  /** True when the family stores one channel across the full payload. */
  readonly singleChannelFullPayload: boolean;
}

/** A fully-walked II preset image (TLV layer). */
export interface IIImageTlv {
  readonly formatTag: number;
  readonly name: string;
  readonly modifiers: readonly IIImageModifier[];
  /** Effect-block TLVs in chain order, excluding 139/140/141. */
  readonly blocks: readonly IIImageBlock[];
  /** The always-present system blocks (139, 140, 141). */
  readonly systemTail: readonly IIImageBlock[];
  readonly toneMatchPresent: boolean;
  /** Word index of the wire_id == 0 terminator. */
  readonly terminatorWord: number;
}

const SYSTEM_TAIL_SET: ReadonlySet<number> = new Set(II_SYSTEM_TAIL_WIRE_IDS);

function extractName(words: Uint16Array): string {
  let s = '';
  for (let i = 0; i < II_IMAGE_NAME_WORDS; i++) {
    const w = words[II_IMAGE_NAME_START + i];
    if (w === 0) break;
    s += String.fromCharCode(w & 0x7f);
  }
  return s.trim();
}

/**
 * Walk a 4096-word II preset image. STRICT: throws on wrong size,
 * unknown format tag, a TLV running past the image, or a chain that
 * never terminates. No silent partial decode.
 */
export function parseIIImageTlv(words: Uint16Array): IIImageTlv {
  if (words.length !== II_IMAGE_WORDS) {
    throw new Error(`parseIIImageTlv: expected ${II_IMAGE_WORDS} words, got ${words.length}`);
  }
  if (words[0] !== II_IMAGE_FORMAT_TAG) {
    throw new Error(
      `parseIIImageTlv: word 0 format tag is ${words[0]}, expected ${II_IMAGE_FORMAT_TAG}`,
    );
  }
  const modifiers: IIImageModifier[] = [];
  const blocks: IIImageBlock[] = [];
  const systemTail: IIImageBlock[] = [];

  let i = II_TLV_CHAIN_START;
  let terminatorWord = -1;
  while (i < II_IMAGE_WORDS) {
    const wireId = words[i];
    if (wireId === 0) {
      terminatorWord = i;
      break;
    }
    if (i + 1 >= II_IMAGE_WORDS) {
      throw new Error(`parseIIImageTlv: TLV wire_id ${wireId} at word ${i} has no length word`);
    }
    const payloadLen = words[i + 1];
    if (i + 2 + payloadLen > II_IMAGE_WORDS) {
      throw new Error(
        `parseIIImageTlv: TLV [${wireId}, ${payloadLen}] at word ${i} runs past the image`,
      );
    }
    if (wireId < II_BLOCK_WIRE_ID_MIN) {
      modifiers.push({
        slotId: wireId,
        tlvWord: i,
        payloadLen,
        payload: Array.from(words.slice(i + 2, i + 2 + payloadLen)),
      });
    } else {
      const block = BLOCK_BY_ID[wireId];
      const singleChannel =
        block !== undefined && II_SINGLE_CHANNEL_FULL_PAYLOAD_GROUPS.has(block.groupCode);
      const entry: IIImageBlock = {
        wireId,
        block,
        tlvWord: i,
        baseWord: i + 2,
        payloadLen,
        xToYOffset: !singleChannel && payloadLen % 2 === 0 ? payloadLen / 2 : undefined,
        singleChannelFullPayload: singleChannel,
      };
      (SYSTEM_TAIL_SET.has(wireId) ? systemTail : blocks).push(entry);
    }
    i += 2 + payloadLen;
  }
  if (terminatorWord < 0) {
    throw new Error(`parseIIImageTlv: chain never reached a wire_id == 0 terminator`);
  }
  return {
    formatTag: words[0],
    name: extractName(words),
    modifiers,
    blocks,
    systemTail,
    toneMatchPresent: blocks.some((b) => b.wireId === II_TONE_MATCH_WIRE_ID),
    terminatorWord,
  };
}

/** Find a block TLV by wire id (effect blocks + system tail). */
export function findIIImageBlock(tlv: IIImageTlv, wireId: number): IIImageBlock | undefined {
  return tlv.blocks.find((b) => b.wireId === wireId) ?? tlv.systemTail.find((b) => b.wireId === wireId);
}

/**
 * Word index of a block param inside the image.
 *
 *   two-channel block, X: baseWord + paramId          (paramId < len/2)
 *   two-channel block, Y: baseWord + len/2 + paramId  (paramId < len/2)
 *   single-channel block, X: baseWord + paramId       (paramId < len)
 *   single-channel block, Y: refused
 *
 * The bound is load-bearing: an out-of-range paramId would silently
 * address a neighbouring TLV. Never relax it; scene-state words have
 * their own dedicated accessor (`sceneStateWordIndex`).
 */
export function imageParamWordIndex(
  block: IIImageBlock,
  paramId: number,
  channel: 'X' | 'Y' = 'X',
): number {
  if (!Number.isInteger(paramId) || paramId < 0) {
    throw new Error(`imageParamWordIndex: invalid paramId ${paramId}`);
  }
  const perChannel = block.xToYOffset ?? block.payloadLen;
  if (paramId >= perChannel) {
    throw new Error(
      `imageParamWordIndex: paramId ${paramId} out of range for wire_id ${block.wireId} ` +
        `(${perChannel} words per channel)`,
    );
  }
  if (channel === 'Y') {
    if (block.xToYOffset === undefined) {
      throw new Error(
        `imageParamWordIndex: wire_id ${block.wireId} is single-channel ` +
          `(payload ${block.payloadLen}${block.singleChannelFullPayload ? ', full-payload family' : ''}), no channel-Y half`,
      );
    }
    return block.baseWord + block.xToYOffset + paramId;
  }
  return block.baseWord + paramId;
}

/**
 * Registered `<block>.bypass` housekeeping paramId per groupCode, from
 * KNOWN_PARAMS. These pids address the per-block SCENE-STATE word
 * (low byte = bypass mask, high byte = channel-Y mask), NOT an ordinary
 * parameter. Families without an entry (QCH, FXL, SND, TMA, MIX,
 * INPUT) have no located scene word and are refused by the scene lane.
 */
export const II_BYPASS_PID_BY_GROUP: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const entry of Object.values(KNOWN_PARAMS)) {
    if (entry.name === 'bypass') map.set(entry.groupCode, entry.paramId);
  }
  return map;
})();

/**
 * DEDICATED scene-state word accessor (never routed through
 * `imageParamWordIndex`): the scene-state ushort lives at
 * `baseWord + bypassPid` in the FULL payload, layout-independent and
 * composition-independent (hardware-anchored: 32/32 informative BK-070
 * paired dumps diff at exactly this word). Bounded by payloadLen.
 * Returns undefined when the block's family has no registered bypass
 * pid or the pid falls outside this dump's self-described payload.
 */
export function sceneStateWordIndex(block: IIImageBlock): number | undefined {
  const group = block.block?.groupCode;
  if (group === undefined) return undefined;
  const pid = II_BYPASS_PID_BY_GROUP.get(group);
  if (pid === undefined) return undefined;
  if (pid >= block.payloadLen) return undefined;
  return block.baseWord + pid;
}
