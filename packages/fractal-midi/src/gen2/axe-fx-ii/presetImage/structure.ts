/**
 * Axe-Fx II preset-image STRUCTURAL splice: PLACE / REMOVE a block.
 *
 * Chain-splice mechanics pinned 2026-07-16 (502/502 corpus + synthesis
 * experiments, adversarially reproduced):
 *
 *   REMOVE = splice out the block's 2+len words (each 3-byte triplet
 *   moves WHOLE, so byte-2 reserved bits travel with their word),
 *   zero-fill the vacated tail of the fixed 4096-word image, swap the
 *   block's grid cell id to an unused shunt id (flags preserved),
 *   recompute the footer XOR-fold.
 *
 *   PLACE = the inverse: insert [wireId, payloadLen, payload...] at the
 *   alphabetical (squashed display-name) position among effect blocks,
 *   after all modifier records, before the system tail; swap the target
 *   grid SHUNT cell's id to the block id (flags preserved).
 *
 *   NOTHING ELSE MOVES: word 1 == 0 (502/502); the 0x77 header's
 *   trailing `00 20` is the septet encoding of 4096 (the image word
 *   count, not a chain-dependent field); terminator == 130 +
 *   sum(2+len) (502/502); post-terminator words are zero except the
 *   tone-match bulk at fixed word 2048.
 *
 * Oracles that pinned this: triplet-level rebuild byte-exact vs the
 * bank files; remove(Flanger)+re-add on factory-A000 reproduces the
 * ORIGINAL 12,951 bank bytes byte-for-byte (footer included, with 5
 * nonzero reserved-byte-2 words moved by the splice); synthesized
 * PLACE of the modal Phaser record onto A000 yields a chain whose
 * [wireId,payloadLen] sequence equals factory-A001 (the real preset
 * with exactly that composition) verbatim.
 *
 * v1 refusals (evidence boundaries, enforced):
 *   - TONE-MATCH presets: a naive splice shifts the chain-independent
 *     bulk region pinned at word 2048. Structural ops refuse when
 *     block 170 is in the chain (4/388 corpus presets).
 *   - System-tail / tail-resident blocks (139, 140, 141, 142, 143,
 *     170) and modifier records: their ordering grammar is pinned but
 *     placement/removal of them has no synthesis oracle.
 *   - Headroom: an insert that would push the terminator to word 2048
 *     or beyond refuses (max factory chain end is word 1531).
 *   - Fresh grid ROUTING: inserts only replace an existing routed
 *     SHUNT cell (flags preserved); authoring new cable masks stays on
 *     the hardware-verified live fn 0x06 ops.
 *
 * Hardware residuals (community-beta, labeled): device acceptance of a
 * PUSHED spliced image is untested (remove+reinsert identity proves
 * decoder inversion, not novel-composition device-acceptability, so
 * this lane's hardware-unverified label reads LOUDER than the RMW
 * lanes'); nonzero reserved byte-2 bits MOVED to new word positions
 * have no offline oracle (NACK 0x13 evidence was per-position RMW);
 * inserted words carry zero reserved bits (no donor exists for them).
 * Q8.02 / XL+ scoped.
 */

import { BLOCK_BY_ID } from '../blockTypes.js';
import { II_IMAGE_WORDS, type AxeFxIIImageBuffer } from './frames.js';
import {
  parseIIImageTlv,
  findIIImageBlock,
  II_TAIL_RESIDENT_WIRE_IDS,
  II_TONE_MATCH_BULK_START,
  type IIImageTlv,
} from './tlv.js';
import {
  parseIIGrid,
  allocateShuntId,
  swapGridCellId,
  isShuntId,
  isBlockCellId,
  type IIGridCell,
} from './grid.js';
import { DEFAULT_RECORDS, PAYLOAD_LEN_CENSUS } from './defaultRecords.js';

const TAIL_RESIDENT: ReadonlySet<number> = new Set(II_TAIL_RESIDENT_WIRE_IDS);

/** Squash a display name for the corpus-pinned alphabetical chain order. */
export function squashDisplayName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A removed (or to-be-inserted) TLV span: header + payload words. */
export interface IITlvSpan {
  /** 2 + payloadLen words: [wireId, payloadLen, ...payload]. */
  readonly words: readonly number[];
  /** byte-2 reserved bits per span word (same length as words). */
  readonly reserved: readonly number[];
}

export interface IIRemoveBlockResult {
  readonly ok: true;
  readonly image: AxeFxIIImageBuffer;
  /** The removed span, sufficient for a byte-exact re-insert. */
  readonly removed: IITlvSpan;
  readonly removedTlvWord: number;
  /** The fresh shunt id now occupying the block's grid cell. */
  readonly shuntId: number;
  readonly gridCell: { readonly col: number; readonly row: number };
  readonly warnings: readonly string[];
}

export interface IIInsertBlockResult {
  readonly ok: true;
  readonly image: AxeFxIIImageBuffer;
  /** Word index the span was inserted at. */
  readonly insertedTlvWord: number;
  /** The shunt id displaced from the target grid cell. */
  readonly replacedShuntId: number;
  readonly warnings: readonly string[];
}

export type IIStructureResult<T> = T | { readonly ok: false; readonly reason: string };

function structuralPreflight(tlv: IIImageTlv, opName: string): string | undefined {
  if (tlv.toneMatchPresent) {
    return (
      `${opName}: this preset carries a Tone Match block (wire_id 170) with its chain-independent ` +
      `bulk region at word ${II_TONE_MATCH_BULK_START}; structural splices on tone-match presets are ` +
      `refused in v1 (a naive splice would shift the bulk).`
    );
  }
  return undefined;
}

function gridCellsForId(cells: readonly IIGridCell[], id: number): IIGridCell[] {
  return cells.filter((c) => c.id === id);
}

/**
 * Remove a placed effect block from a COPY of the image: TLV splice +
 * grid id swap to a fresh shunt. Returns the removed span so the exact
 * inverse insert is possible (remove + re-add is byte-identity,
 * corpus-proven).
 */
export function removeBlockFromImage(
  source: AxeFxIIImageBuffer,
  wireId: number,
): IIStructureResult<IIRemoveBlockResult> {
  const tlv = parseIIImageTlv(source.words);
  const preflight = structuralPreflight(tlv, 'removeBlockFromImage');
  if (preflight !== undefined) return { ok: false, reason: preflight };
  if (TAIL_RESIDENT.has(wireId)) {
    return {
      ok: false,
      reason:
        `removeBlockFromImage: wire_id ${wireId} is a system-tail / tail-resident block; ` +
        `tail splices have no synthesis oracle and are refused.`,
    };
  }
  const block = findIIImageBlock(tlv, wireId);
  if (block === undefined || tlv.blocks.every((b) => b.wireId !== wireId)) {
    return { ok: false, reason: `removeBlockFromImage: wire_id ${wireId} is not placed in this preset's chain.` };
  }
  const cells = parseIIGrid(source.words);
  const targetCells = gridCellsForId(cells, wireId);
  if (targetCells.length !== 1) {
    return {
      ok: false,
      reason:
        `removeBlockFromImage: expected exactly 1 grid cell holding id ${wireId}, found ` +
        `${targetCells.length}; grid/chain multiset identity is violated, refusing to touch this image.`,
    };
  }
  const warnings: string[] = [];
  for (const m of tlv.modifiers) {
    if (m.payload[8] === wireId) {
      warnings.push(
        `modifier slot ${m.slotId} targets the removed block (payload[8] == ${wireId}); firmware ` +
          `tolerates dangling modifier targets (16/265 factory modifiers dangle), the record is preserved verbatim.`,
      );
    }
  }

  const spanStart = block.tlvWord;
  const spanLen = 2 + block.payloadLen;
  const removed: IITlvSpan = {
    words: Array.from(source.words.slice(spanStart, spanStart + spanLen)),
    reserved: Array.from(source.reserved.slice(spanStart, spanStart + spanLen)),
  };

  const words = new Uint16Array(II_IMAGE_WORDS);
  const reserved = new Uint8Array(II_IMAGE_WORDS);
  words.set(source.words.slice(0, spanStart), 0);
  reserved.set(source.reserved.slice(0, spanStart), 0);
  words.set(source.words.slice(spanStart + spanLen), spanStart);
  reserved.set(source.reserved.slice(spanStart + spanLen), spanStart);
  // Vacated tail is already zero (fresh arrays).

  const cell = targetCells[0];
  const usedShunts = cells.filter((c) => isShuntId(c.id)).map((c) => c.id);
  const shuntId = allocateShuntId(usedShunts);
  swapGridCellId(words, cell.col, cell.row, wireId, shuntId);

  // Strict re-parse: the spliced image must still walk cleanly.
  try {
    parseIIImageTlv(words);
  } catch (err) {
    return {
      ok: false,
      reason: `removeBlockFromImage: post-splice image failed the strict walk: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    image: { words, reserved },
    removed,
    removedTlvWord: spanStart,
    shuntId,
    gridCell: { col: cell.col, row: cell.row },
    warnings,
  };
}

export interface IIInsertBlockInput {
  /** Wire id of the block to place (must be absent from chain + grid). */
  readonly wireId: number;
  /**
   * The full TLV span to insert ([wireId, payloadLen, ...payload] with
   * optional reserved bits), e.g. from a prior remove or a donor dump.
   * Omit to use the corpus-modal DEFAULT_RECORDS entry (available only
   * for the five small rarely-tweaked families; every always-tweaked
   * family refuses without a donor).
   */
  readonly span?: IITlvSpan;
  /** Grid cell currently holding a SHUNT, whose routing the block inherits. */
  readonly gridCell: { readonly col: number; readonly row: number };
}

/**
 * Insert an effect block into a COPY of the image at its corpus-pinned
 * alphabetical chain position + swap the target shunt cell to the
 * block id (routing preserved).
 */
export function insertBlockIntoImage(
  source: AxeFxIIImageBuffer,
  input: IIInsertBlockInput,
): IIStructureResult<IIInsertBlockResult> {
  const tlv = parseIIImageTlv(source.words);
  const preflight = structuralPreflight(tlv, 'insertBlockIntoImage');
  if (preflight !== undefined) return { ok: false, reason: preflight };

  const { wireId } = input;
  const registered = BLOCK_BY_ID[wireId];
  if (registered === undefined) {
    return { ok: false, reason: `insertBlockIntoImage: wire_id ${wireId} is not a registered block.` };
  }
  if (TAIL_RESIDENT.has(wireId)) {
    return {
      ok: false,
      reason:
        `insertBlockIntoImage: wire_id ${wireId} is a system-tail / tail-resident block; ` +
        `tail splices have no synthesis oracle and are refused.`,
    };
  }
  if (findIIImageBlock(tlv, wireId) !== undefined) {
    return { ok: false, reason: `insertBlockIntoImage: wire_id ${wireId} is already placed in this preset.` };
  }

  const warnings: string[] = [];
  let span = input.span;
  if (span === undefined) {
    const def = DEFAULT_RECORDS[wireId];
    if (def === undefined) {
      return {
        ok: false,
        reason:
          `insertBlockIntoImage: no donor span given and wire_id ${wireId} has no corpus-derivable ` +
          `default record (always-tweaked family; synthesizing one would be a guess with no oracle). ` +
          `Provide a donor span from a same-firmware dump.`,
      };
    }
    span = {
      words: [def.wireId, def.payloadLen, ...def.payload],
      reserved: new Array<number>(2 + def.payloadLen).fill(0),
    };
    warnings.push(
      `default record for ${def.blockName}: factory-modal (exact in ${def.fullModalMatches}/${def.occurrences} ` +
        `factory instances, byte-identical on live hw dumps); fresh-placement device behavior is community-beta.`,
    );
  }
  if (span.words.length < 2 || span.words[0] !== wireId || span.words[1] !== span.words.length - 2) {
    return {
      ok: false,
      reason:
        `insertBlockIntoImage: span must be [wireId, payloadLen, ...payload] with wireId ${wireId}; ` +
        `got header [${span.words[0]}, ${span.words[1]}] over ${span.words.length} words.`,
    };
  }
  if (span.reserved.length !== span.words.length) {
    return { ok: false, reason: `insertBlockIntoImage: span.reserved length must match span.words.` };
  }
  for (const w of span.words) {
    if (!Number.isInteger(w) || w < 0 || w > 0xffff) {
      return { ok: false, reason: `insertBlockIntoImage: span word ${w} outside 0..65535.` };
    }
  }
  const payloadLen = span.words[1];
  const census = PAYLOAD_LEN_CENSUS[wireId];
  if (census !== undefined && census.factory !== payloadLen && census.live !== payloadLen) {
    warnings.push(
      `span payloadLen ${payloadLen} matches neither the factory (${census.factory ?? 'n/a'}) nor the ` +
        `live (${census.live ?? 'n/a'}) census length for wire_id ${wireId}; the dump self-describes, but check the donor.`,
    );
  }

  // Grid target: must currently hold a shunt.
  const cells = parseIIGrid(source.words);
  if (gridCellsForId(cells, wireId).length !== 0) {
    return { ok: false, reason: `insertBlockIntoImage: wire_id ${wireId} already occupies a grid cell.` };
  }
  const cell = cells.find((c) => c.col === input.gridCell.col && c.row === input.gridCell.row);
  if (cell === undefined) {
    return { ok: false, reason: `insertBlockIntoImage: grid cell (${input.gridCell.col},${input.gridCell.row}) out of range.` };
  }
  if (!isShuntId(cell.id)) {
    return {
      ok: false,
      reason:
        `insertBlockIntoImage: grid cell (${cell.col},${cell.row}) holds id ${cell.id}, not a shunt; ` +
        `v1 placement only replaces an existing routed shunt cell (fresh routing stays on live fn 0x06 ops).`,
    };
  }

  // Insertion word: alphabetical squashed-display-name position among
  // non-tail-resident effect blocks; else before the first tail entry.
  const newKey = squashDisplayName(registered.name);
  let insertAt: number | undefined;
  for (const b of tlv.blocks) {
    if (TAIL_RESIDENT.has(b.wireId) || b.block === undefined) continue;
    if (squashDisplayName(b.block.name) > newKey) {
      insertAt = b.tlvWord;
      break;
    }
  }
  if (insertAt === undefined) {
    const tailWords = [...tlv.blocks, ...tlv.systemTail]
      .filter((b) => TAIL_RESIDENT.has(b.wireId))
      .map((b) => b.tlvWord);
    insertAt = Math.min(...tailWords);
  }

  // Headroom: the shifted terminator must stay clear of word 2048.
  const spanLen = span.words.length;
  const newTerminator = tlv.terminatorWord + spanLen;
  if (newTerminator >= II_TONE_MATCH_BULK_START) {
    return {
      ok: false,
      reason:
        `insertBlockIntoImage: insert would push the chain terminator to word ${newTerminator}, ` +
        `at/past the pinned bulk region start ${II_TONE_MATCH_BULK_START}; refused (max factory chain end is 1531).`,
    };
  }
  // The spanLen words falling off the image end must be zero.
  for (let i = II_IMAGE_WORDS - spanLen; i < II_IMAGE_WORDS; i++) {
    if (source.words[i] !== 0 || source.reserved[i] !== 0) {
      return {
        ok: false,
        reason:
          `insertBlockIntoImage: image tail word ${i} is nonzero (value ${source.words[i]}, ` +
          `reserved 0x${source.reserved[i].toString(16)}); shifting would clobber it. Refused.`,
      };
    }
  }

  const words = new Uint16Array(II_IMAGE_WORDS);
  const reserved = new Uint8Array(II_IMAGE_WORDS);
  words.set(source.words.slice(0, insertAt), 0);
  reserved.set(source.reserved.slice(0, insertAt), 0);
  words.set(span.words, insertAt);
  reserved.set(span.reserved, insertAt);
  words.set(source.words.slice(insertAt, II_IMAGE_WORDS - spanLen), insertAt + spanLen);
  reserved.set(source.reserved.slice(insertAt, II_IMAGE_WORDS - spanLen), insertAt + spanLen);

  swapGridCellId(words, cell.col, cell.row, cell.id, wireId);

  try {
    parseIIImageTlv(words);
  } catch (err) {
    return {
      ok: false,
      reason: `insertBlockIntoImage: post-splice image failed the strict walk: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    image: { words, reserved },
    insertedTlvWord: insertAt,
    replacedShuntId: cell.id,
    warnings,
  };
}
