/**
 * Axe-Fx II de-framed preset-image TLV decoder.
 *
 * The 12,951-byte `0x77/0x78/0x79` preset dump de-frames to a fixed
 * 4096-word image (64 chunks × 64 native ushorts; each ushort is a
 * 3-byte septet triplet `lo7 | mid7<<7 | (b2 & 0x03)<<14`, see
 * `research/atomicApply.ts` decodeChunkNative). This module decodes the
 * image's own structure — CONFIRMED 2026-07-02 against 384 factory
 * presets (Q8.02 XL+ banks A/B/C) + 4 live hardware dumps
 * (`samples/captured/bk070-loop-amp-bass-2-baseline.syx`,
 * `samples/captured/hw132/{sentinel-eb-alpha,sentinel-eb-bravo,stored-slot-7}.syx`),
 * with every BK-070 hardware anchor landing exactly:
 *
 *   word 0        format tag 2049 (388/388)
 *   words 2..33   preset name, 1 ASCII char per word, 0-terminated
 *   words 36..129 the OLD record table: stride 8, max 12 entries.
 *                 This is GRID / signal-chain order, NOT serialization
 *                 order, and ids >= 200 are unplaced/shunt placeholders
 *                 that are never serialized. Do NOT use it to enumerate
 *                 placed blocks. (The layout-order hypothesis is
 *                 REFUTED: Test Crunch table order Comp,Drive,Amp,Cab,
 *                 Delay,Reverb vs measured serialization Amp@132..
 *                 Reverb@678.)
 *   word 130..    the TLV CHAIN: repeated [wire_id, payload_len,
 *                 payload[payload_len]]; wire_id == 0 terminates.
 *                 Contents in order (388/388):
 *                   1. optional modifier records (wire_id = slot 1..20,
 *                      always payload_len 15, always before the first
 *                      block TLV — zero small-ids after a block)
 *                   2. effect-block TLVs, ALPHABETICAL by the AxeEdit
 *                      canonical DISPLAY name with spaces/punctuation
 *                      ignored ("Tremolo/Panner" sorts under T, not
 *                      under the internal PanTrem label; "Multiband
 *                      Compressor" before "Multi Delay")
 *                   3. system tail: an ordered subsequence of
 *                      [170 Tone Match, 139 Noisegate, 140 Output,
 *                      142 Feedback Send, 143 Feedback Return,
 *                      141 Controllers] — 139/140/141 always present,
 *                      the others only when placed (Feedback Send/
 *                      Return sit BETWEEN Output and Controllers)
 *
 * Per-block param addressing (the BK-070 anchors, Test Crunch preset,
 * Amp TLV `[106, 236]` at word 130 → baseWord 132):
 *
 *   channel-X param p  →  word[baseWord + p]
 *   channel-Y param p  →  word[baseWord + payloadLen/2 + p]
 *
 *   amp.bass (paramId 2) channel-Y  → word 252   (132 + 118 + 2) ✓
 *   amp.master_volume (5) channel-Y → word 255   (132 + 118 + 5) ✓
 *   amp.effect_type (0) channel-X   → word[baseWord] = amp-type ordinal
 *   ('59 Bassguy ordinal 0 at word 149 on factory A000, whose chain
 *   carries one modifier record before the Amp TLV) ✓
 *
 * Every hardware-measured `widthUshorts` in `blockBinaryLayout.ts`
 * equals `payloadLen + 2` (the id + len words), and every measured
 * `xToYOffsetUshorts` equals `payloadLen / 2` (Amp 236/2=118,
 * Cab 78/2=39, Compressor 40/2=20, Delay 140/2=70, Drive 42/2=21,
 * Reverb 90/2=45).
 *
 * CRITICAL: payload lengths are per-dump self-described and DRIFT
 * across firmware (factory Q8.02 bank Amp payload_len 234 vs live
 * Q8.02 hardware 236). Never trust a static width table — always walk
 * the chain of the dump in hand.
 *
 * Tone-match presets (block wire_id 170 in the chain; 4 of 388) carry
 * an additional bulk data region at fixed word 2048, AFTER the chain
 * terminator. Preserve it verbatim on any future writeback.
 *
 * OPEN (decoded structure only — do NOT write these regions):
 *   - the modifier-record 15-word payload layout
 *   - per-block scene/bypass/X-Y state words inside block payloads
 *   - semantics of record-table ids >= 200
 * Writeback additionally requires the byte-2 high-bit mask preservation
 * documented in `research/atomicApply.ts` writeUshortAt (NACK 0x13).
 */

import type { ParsedPresetDump } from './presetDump.js';
import { CHUNKS_PER_PRESET } from './presetDump.js';
import {
  EFFECT_ID_TO_BLOCK_NAME,
  type AxeFxIIBlockName,
} from './blockBinaryLayout.js';

/** Words in one de-framed preset image (64 chunks × 64 ushorts). */
export const PRESET_IMAGE_WORDS = 4096;
/** word 0 of every II preset image (388/388 corpus). */
export const PRESET_IMAGE_FORMAT_TAG = 2049;
/** Preset name region: words 2..33, one ASCII char per word. */
export const PRESET_IMAGE_NAME_START = 2;
export const PRESET_IMAGE_NAME_WORDS = 32;
/** Record table: words 36..129, stride 8, max 12 entries. */
export const RECORD_TABLE_START = 36;
export const RECORD_TABLE_STRIDE = 8;
export const RECORD_TABLE_MAX_ENTRIES = 12;
/** First word of the TLV chain. */
export const TLV_CHAIN_START = 130;
/** Chain wire_ids below this are modifier-record slots (1..20 observed). */
export const BLOCK_WIRE_ID_MIN = 100;
/** Every modifier record in the corpus has this payload length. */
export const MODIFIER_PAYLOAD_LEN = 15;
/** The fixed system tail closing every chain (388/388). */
export const SYSTEM_TAIL_WIRE_IDS = [139, 140, 141] as const;
/** Tone-match block wire id. */
export const TONE_MATCH_WIRE_ID = 170;
/** Tone-match bulk region start (present only when id 170 is in the chain). */
export const TONE_MATCH_BULK_START = 2048;

/** One record-table entry (raw; grid-order metadata, NOT serialization). */
export interface PresetImageRecordEntry {
  /** 0..11 table position. */
  readonly index: number;
  /** Word index of this entry's wire_id word. */
  readonly word: number;
  /** wire_id; 0 = empty entry; >= 200 = unplaced/shunt placeholder. */
  readonly wireId: number;
  /** Flag word (bit semantics mostly undecoded; observed 0x0, 0x2, 0x3). */
  readonly flag: number;
  /**
   * Remaining raw words of the stride-8 entry. Entry 11 is clipped at
   * word 130 (the chain start), so its `rest` is shorter.
   */
  readonly rest: readonly number[];
}

/** One modifier record from the chain head. Payload layout is OPEN. */
export interface PresetImageModifier {
  /** Modifier slot (wire_id 1..20). */
  readonly slotId: number;
  /** Word index of the record's wire_id word. */
  readonly tlvWord: number;
  readonly payloadLen: number;
  /** Raw payload words (always 15 in the corpus). Do not write. */
  readonly payload: readonly number[];
}

/** One block TLV (effect block, tone-match, or system-tail block). */
export interface PresetImageBlock {
  readonly wireId: number;
  /**
   * Canonical AxeEdit block name resolved via EFFECT_ID_TO_BLOCK_NAME,
   * or undefined for ids outside the table (e.g. 170 ToneMatch).
   */
  readonly blockName: AxeFxIIBlockName | undefined;
  /** Word index of the TLV's wire_id word. */
  readonly tlvWord: number;
  /** Channel-X paramBase: tlvWord + 2. Param p (X) lives at baseWord + p. */
  readonly baseWord: number;
  /** Self-described payload length in words. Firmware-drifting. */
  readonly payloadLen: number;
  /**
   * Channel-Y offset: payloadLen / 2 for even payloads (X half then Y
   * half). undefined when payloadLen is odd (single-channel blocks like
   * VolPan / Enhancer / MegaTap / Crossover).
   */
  readonly xToYOffset: number | undefined;
}

/** A fully-walked II preset image. */
export interface AxeFxIIPresetImage {
  /** The 4096-word image this was parsed from (NOT copied). */
  readonly words: Uint16Array;
  /** words[0]; always PRESET_IMAGE_FORMAT_TAG. */
  readonly formatTag: number;
  /** Preset name from words 2..33, trimmed. */
  readonly name: string;
  /** The 12 raw record-table entries (grid order; do not enumerate blocks from this). */
  readonly recordTable: readonly PresetImageRecordEntry[];
  /** Modifier records from the chain head (raw). */
  readonly modifiers: readonly PresetImageModifier[];
  /**
   * Effect-block TLVs in chain order, EXCLUDING the always-present
   * system blocks 139/140/141. Includes Tone Match (170) and Feedback
   * Send/Return (142/143) when placed; note those serialize in the
   * tail region (see module docstring) — each block's true chain
   * position is its `tlvWord`.
   */
  readonly blocks: readonly PresetImageBlock[];
  /** The always-present system blocks (139 Noisegate, 140 Output, 141 Controllers). */
  readonly systemTail: readonly PresetImageBlock[];
  /** True when block 170 is in the chain → bulk region at word 2048. */
  readonly toneMatchPresent: boolean;
  /** Word index of the wire_id == 0 word that terminated the chain. */
  readonly terminatorWord: number;
}

const SYSTEM_TAIL_SET: ReadonlySet<number> = new Set(SYSTEM_TAIL_WIRE_IDS);

/**
 * De-frame a parsed `0x77/0x78/0x79` preset dump to its 4096-word
 * image. Each chunk payload is `[countLo, countHi, 64 × 3-byte word]`;
 * the count is validated (always 64). Words are masked to 16 bits —
 * byte 2's high 5 bits carry device-private state that a writeback
 * must preserve (see `research/atomicApply.ts` writeUshortAt).
 */
export function deframePresetImage(parsed: ParsedPresetDump): Uint16Array {
  const words = new Uint16Array(PRESET_IMAGE_WORDS);
  for (let c = 0; c < CHUNKS_PER_PRESET; c++) {
    const p = parsed.chunkPayloads[c];
    const count = (p[0] & 0x7f) | ((p[1] & 0x7f) << 7);
    if (count !== 64) {
      throw new Error(
        `deframePresetImage: chunk ${c + 1}/${CHUNKS_PER_PRESET} declares ` +
          `${count} words, expected 64`,
      );
    }
    for (let i = 0; i < 64; i++) {
      const o = 2 + i * 3;
      words[c * 64 + i] =
        (p[o] & 0x7f) | ((p[o + 1] & 0x7f) << 7) | ((p[o + 2] & 0x03) << 14);
    }
  }
  return words;
}

function extractName(words: Uint16Array): string {
  let s = '';
  for (let i = 0; i < PRESET_IMAGE_NAME_WORDS; i++) {
    const w = words[PRESET_IMAGE_NAME_START + i];
    if (w === 0) break;
    s += String.fromCharCode(w & 0x7f);
  }
  return s.trim();
}

function readRecordTable(words: Uint16Array): PresetImageRecordEntry[] {
  const entries: PresetImageRecordEntry[] = [];
  for (let r = 0; r < RECORD_TABLE_MAX_ENTRIES; r++) {
    const base = RECORD_TABLE_START + r * RECORD_TABLE_STRIDE;
    // Entry 11's stride-8 span would run into the chain start at word
    // 130 — the table region ends at word 129, so clip.
    const end = Math.min(base + RECORD_TABLE_STRIDE, TLV_CHAIN_START);
    entries.push({
      index: r,
      word: base,
      wireId: words[base],
      flag: words[base + 1],
      rest: Array.from(words.slice(base + 2, end)),
    });
  }
  return entries;
}

/**
 * Walk a 4096-word II preset image. STRICT: throws on a wrong image
 * size, an unknown format tag, a TLV running past the image, or a
 * chain that never reaches a wire_id == 0 terminator. No silent
 * partial decode.
 */
export function parsePresetImage(words: Uint16Array): AxeFxIIPresetImage {
  if (words.length !== PRESET_IMAGE_WORDS) {
    throw new Error(
      `parsePresetImage: expected ${PRESET_IMAGE_WORDS} words, got ${words.length}`,
    );
  }
  if (words[0] !== PRESET_IMAGE_FORMAT_TAG) {
    throw new Error(
      `parsePresetImage: word 0 format tag is ${words[0]}, expected ` +
        `${PRESET_IMAGE_FORMAT_TAG} — not a known II preset image`,
    );
  }

  const modifiers: PresetImageModifier[] = [];
  const blocks: PresetImageBlock[] = [];
  const systemTail: PresetImageBlock[] = [];

  let i = TLV_CHAIN_START;
  let terminatorWord = -1;
  while (i < PRESET_IMAGE_WORDS) {
    const wireId = words[i];
    if (wireId === 0) {
      terminatorWord = i;
      break;
    }
    if (i + 1 >= PRESET_IMAGE_WORDS) {
      throw new Error(
        `parsePresetImage: TLV wire_id ${wireId} at word ${i} has no length word`,
      );
    }
    const payloadLen = words[i + 1];
    if (i + 2 + payloadLen > PRESET_IMAGE_WORDS) {
      throw new Error(
        `parsePresetImage: TLV [${wireId}, ${payloadLen}] at word ${i} runs ` +
          `past the ${PRESET_IMAGE_WORDS}-word image`,
      );
    }
    if (wireId < BLOCK_WIRE_ID_MIN) {
      modifiers.push({
        slotId: wireId,
        tlvWord: i,
        payloadLen,
        payload: Array.from(words.slice(i + 2, i + 2 + payloadLen)),
      });
    } else {
      const block: PresetImageBlock = {
        wireId,
        blockName: EFFECT_ID_TO_BLOCK_NAME.get(wireId),
        tlvWord: i,
        baseWord: i + 2,
        payloadLen,
        xToYOffset: payloadLen % 2 === 0 ? payloadLen / 2 : undefined,
      };
      (SYSTEM_TAIL_SET.has(wireId) ? systemTail : blocks).push(block);
    }
    i += 2 + payloadLen;
  }
  if (terminatorWord < 0) {
    throw new Error(
      `parsePresetImage: TLV chain from word ${TLV_CHAIN_START} never reached ` +
        `a wire_id == 0 terminator`,
    );
  }

  return {
    words,
    formatTag: words[0],
    name: extractName(words),
    recordTable: readRecordTable(words),
    modifiers,
    blocks,
    systemTail,
    toneMatchPresent: blocks.some((b) => b.wireId === TONE_MATCH_WIRE_ID),
    terminatorWord,
  };
}

/**
 * Word index of a block param inside the image.
 *
 *   channel X: baseWord + paramId
 *   channel Y: baseWord + xToYOffset + paramId
 *
 * Throws when paramId falls outside the channel's half of the payload
 * (would silently read a neighbouring TLV) or when Y is requested on an
 * odd-payload single-channel block.
 */
export function paramWordIndex(
  block: PresetImageBlock,
  paramId: number,
  channel: 'X' | 'Y' = 'X',
): number {
  if (!Number.isInteger(paramId) || paramId < 0) {
    throw new Error(`paramWordIndex: invalid paramId ${paramId}`);
  }
  const perChannel = block.xToYOffset ?? block.payloadLen;
  if (paramId >= perChannel) {
    throw new Error(
      `paramWordIndex: paramId ${paramId} out of range for wire_id ` +
        `${block.wireId} (${perChannel} words per channel)`,
    );
  }
  if (channel === 'Y') {
    if (block.xToYOffset === undefined) {
      throw new Error(
        `paramWordIndex: wire_id ${block.wireId} has an odd payload ` +
          `(${block.payloadLen} words) — no channel-Y half`,
      );
    }
    return block.baseWord + block.xToYOffset + paramId;
  }
  return block.baseWord + paramId;
}

/**
 * Convenience: read a block param's raw 16-bit word from the image by
 * block wire_id. Throws when the wire_id is not in the chain.
 */
export function getParamWord(
  image: AxeFxIIPresetImage,
  blockWireId: number,
  paramId: number,
  channel: 'X' | 'Y' = 'X',
): { wordIndex: number; value: number } {
  const block =
    image.blocks.find((b) => b.wireId === blockWireId) ??
    image.systemTail.find((b) => b.wireId === blockWireId);
  if (!block) {
    const present = [...image.blocks, ...image.systemTail]
      .map((b) => b.wireId)
      .join(', ');
    throw new Error(
      `getParamWord: wire_id ${blockWireId} not in this preset's chain ` +
        `(present: ${present})`,
    );
  }
  const wordIndex = paramWordIndex(block, paramId, channel);
  return { wordIndex, value: image.words[wordIndex] };
}
