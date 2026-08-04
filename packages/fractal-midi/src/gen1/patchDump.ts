// Axe-Fx Standard / Ultra (gen-1) whole-patch dump — the SPEC-PINNED SUBSET.
//
// Source: the gen-1 wiki "Axe-Fx System Exclusive Message Spec"
// (docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.wikitext.txt), sections
// ===MIDI_GET_PATCH=== (~lines 203–245) and ===MIDI_PATCH_DUMP===
// (~lines 443–467). Cross-checked byte-for-byte against that file 2026-07-02.
//
// WHAT IS PINNED (ships here, community-beta, hardware-unverified):
//   - The fn 0x03 request, edit-buffer form: F0 00 01 74 [model] 03 01 00 00 F7
//     (spec's own example frame).
//   - The fn 0x03 request, stored form for presets 0..255 (banks A/B):
//     F0 00 01 74 [model] 03 00 [ls] [ms] F7 with ls = preset & 0x0f,
//     ms = preset >> 4 — proven by the spec's worked examples
//     (A000 → 00 00, A127 → 0F 07, B128 → 00 08, B255 → 0F 0F).
//   - Dump (fn 0x04) header: byte 6 = 0x01 edit buffer / 0x00 stored.
//   - Dump name: 20 chars at offsets 13–52 as ls/ms nibble pairs, then a
//     nibble-pair null terminator at 53–54 (42 bytes total).
//   - Dump effect grid: offsets 77–268, 4×12 cells × 4 bytes each —
//     2 bytes effect id (ls/ms nibble pair, values match the fn 0x02
//     block-id table in blockTypes.ts) + 2 bytes undetermined state.
//
// WHAT IS NOT PINNED (deliberately OMITTED — no guessed wire paths):
//   - Bank-C stored requests (presets ≥ 256): the spec flags ls as "or'd with
//     unknown value when requesting presets from bank 2" (its C383 example
//     shows ls = 0x7F where 383 & 0x0f = 0x0f, and its C256 example shows
//     ls = 0x00, so the OR-value cannot be derived from the doc).
//     buildGetPatchDump REFUSES presets ≥ 256.
//   - Dump offsets 7–12 ("patch number?" — the spec's own question mark) and
//     55–76: undetermined; not decoded.
//   - The per-cell 2 state bytes: carried raw as `stateRaw`, not interpreted.
//   - The parameter region (offset 269 .. end-2): the spec says only
//     "Undetermined (assume parameter and modifier state)". parsePatchDump
//     returns its byte COUNT (`paramBlockBytes`), never a decode.
//   - The 2060-byte total: the spec hedges it ("appear to be 2060 bytes"), so
//     the parser tolerates any length that contains the pinned regions
//     (≥ 270 bytes) instead of hard-requiring 2060.
//   - The grid serialization ORDER: the spec states "4 x 12 grid" but not
//     whether cells stream row-major or column-major. Cell CONTENTS are exact
//     either way; the derived row/col fields assume column-major (the later
//     Fractal-family convention) and are marked provisional.
//
// One community capture closes the param block + the bank-C OR-value; see
// docs/contributing/devices/axe-fx-gen1.md (asks DONATE-1 and CAPTURE-1) in
// the mcp-midi-control repo.

import { nibbleJoin } from './nibble.js';
import { AXE_FX_GEN1_MODEL_ID } from './setParam.js';
import { AXE_FX_GEN1_BLOCKS } from './blockTypes.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_GET_PATCH = 0x03;
const FUNC_PATCH_DUMP = 0x04;

/** Dump grid geometry per the spec: "4 x 12 grid starting at offset 77". */
export const GEN1_GRID_ROWS = 4;
export const GEN1_GRID_COLS = 12;
const GRID_OFFSET = 77;
const GRID_CELL_BYTES = 4;
const GRID_BYTES = GEN1_GRID_ROWS * GEN1_GRID_COLS * GRID_CELL_BYTES; // 192, ends at offset 268
const NAME_OFFSET = 13;
const NAME_CHARS = 20;
const PARAM_REGION_OFFSET = GRID_OFFSET + GRID_BYTES; // 269

/**
 * Minimum parseable dump: everything through the grid (offset 268) plus the
 * trailing F7. The spec's hedged nominal total is 2060; we tolerate variance.
 */
export const GEN1_PATCH_DUMP_MIN_LENGTH = PARAM_REGION_OFFSET + 1; // 270
/** The spec's hedged total ("Patch dumps appear to be 2060 bytes"). */
export const GEN1_PATCH_DUMP_NOMINAL_LENGTH = 2060;

/** blockId → instance display name ("Amp 1"), from the fn 0x02 block-id table. */
const BLOCK_NAME_BY_ID: ReadonlyMap<number, string> = new Map(
  AXE_FX_GEN1_BLOCKS.flatMap((b) => b.instances.map((i) => [i.blockId, i.name] as const)),
);

/**
 * Build a gen-1 MIDI_GET_PATCH (fn 0x03) request.
 *
 * @param preset omit for the edit buffer (spec's fully-pinned form). Pass
 *               0..255 for a stored preset in bank A/B (ls/ms per the spec's
 *               worked examples). Presets ≥ 256 (bank C) are REFUSED: the spec
 *               itself flags the low-nibble byte as "or'd with unknown value"
 *               for bank-C requests, so those bytes cannot be derived from the
 *               doc — one community capture pins the OR-value.
 * @param model  model byte (defaults to Ultra 0x01)
 */
export function buildGetPatchDump(preset?: number, model: number = AXE_FX_GEN1_MODEL_ID): number[] {
  if (preset === undefined) {
    // Edit-buffer form, byte-exact to the spec's example.
    return [SYSEX_START, ...FRACTAL_MFR, model, FUNC_GET_PATCH, 0x01, 0x00, 0x00, SYSEX_END];
  }
  if (!Number.isInteger(preset) || preset < 0) {
    throw new Error(`gen-1 buildGetPatchDump: preset must be a non-negative integer, got ${preset}`);
  }
  if (preset > 255) {
    throw new Error(
      `gen-1 buildGetPatchDump: stored-preset requests are pinned only for presets 0..255 (banks A/B); ` +
        `got ${preset}. The spec flags the request's low-nibble byte as "or'd with unknown value" for ` +
        `bank-C presets (≥ 256) — e.g. its C383 example sends 0x7F where the plain low nibble is 0x0F — ` +
        `so bank-C requests need one community capture to pin the OR-value ` +
        `(docs/contributing/devices/axe-fx-gen1.md, ask CAPTURE-1).`,
    );
  }
  // Stored form: ls = preset & 0x0f, ms = preset >> 4 (NOT the fn 0x02
  // nibble-split — ms carries more than one nibble for presets ≥ 240... in
  // general it is the full high part, e.g. the spec's C256 shows ms = 0x10).
  return [
    SYSEX_START,
    ...FRACTAL_MFR,
    model,
    FUNC_GET_PATCH,
    0x00,
    preset & 0x0f,
    preset >> 4,
    SYSEX_END,
  ];
}

/** One cell of the dump's 4×12 effect grid. */
export interface Gen1PatchGridCell {
  /** Cell position in the dump's serialized order, 0..47. Exact. */
  index: number;
  /**
   * PROVISIONAL row/col (row 0..3, col 0..11), derived assuming COLUMN-MAJOR
   * serialization (col = floor(index/4), row = index%4 — the later Fractal-
   * family convention). The spec states the region is a "4 x 12 grid" but not
   * the streaming order; `index`, `effectId`, and `stateRaw` are exact
   * regardless. A capture confirms or flips the derivation.
   */
  row: number;
  col: number;
  /** Effect id, nibble-pair decoded. Matches the fn 0x02 block-id table where placed. */
  effectId: number;
  /** Resolved instance name ("Amp 1") when the effect id is in the gen-1 block table. */
  blockName?: string;
  /**
   * The cell's 2 trailing bytes, RAW. The spec marks them "undetermined state"
   * — their meaning is NOT pinned (bypass? routing? unknown). Carried verbatim
   * so nothing is lost; do not interpret.
   */
  stateRaw: [number, number];
}

/** The spec-pinned subset of a gen-1 MIDI_PATCH_DUMP (fn 0x04). */
export interface Gen1PatchDump {
  /** Model byte as sent by the device (captured, not gated — it is configurable). */
  model: number;
  /** Byte 6: 0x01 = edit buffer, otherwise a stored-preset dump. */
  source: 'edit-buffer' | 'stored';
  /** Patch name (20 chars max, nibble-pair decoded, trimmed). */
  name: string;
  /** All 48 grid cells in serialized order (including empty ones, effectId 0). */
  cells: readonly Gen1PatchGridCell[];
  /**
   * Byte COUNT of the unpinned parameter/modifier region (offset 269 up to
   * the trailing F7). NOT decoded — the spec leaves this region "Undetermined
   * (assume parameter and modifier state)". A count only, never values.
   */
  paramBlockBytes: number;
  /** Total frame length (the spec hedges 2060; real hardware may differ). */
  totalLength: number;
}

/**
 * Parse the spec-pinned subset of a gen-1 MIDI_PATCH_DUMP frame: source flag,
 * name, and effect grid. Throws (with a diagnostic message) on frames that do
 * not carry the pinned regions. Tolerates any total length ≥ 270 rather than
 * hard-requiring the spec's hedged 2060-byte total.
 */
export function parsePatchDump(bytes: readonly number[]): Gen1PatchDump {
  if (bytes.length < GEN1_PATCH_DUMP_MIN_LENGTH) {
    throw new Error(
      `gen-1 parsePatchDump: frame too short (${bytes.length} bytes; need ≥ ${GEN1_PATCH_DUMP_MIN_LENGTH} ` +
        `to contain the pinned header/name/grid regions through offset ${PARAM_REGION_OFFSET - 1} + F7).`,
    );
  }
  if (bytes[0] !== SYSEX_START || bytes[bytes.length - 1] !== SYSEX_END) {
    throw new Error('gen-1 parsePatchDump: not a SysEx frame (missing F0/F7).');
  }
  if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) {
    throw new Error('gen-1 parsePatchDump: manufacturer id is not Fractal (00 01 74).');
  }
  if (bytes[5] !== FUNC_PATCH_DUMP) {
    throw new Error(`gen-1 parsePatchDump: function byte 0x${bytes[5]?.toString(16)} is not MIDI_PATCH_DUMP (0x04).`);
  }

  // Name: 20 chars at 13..52 as nibble pairs, null pair at 53–54. Stop at the
  // first NUL; trim padding.
  let name = '';
  for (let i = 0; i < NAME_CHARS; i++) {
    const c = nibbleJoin(bytes[NAME_OFFSET + 2 * i], bytes[NAME_OFFSET + 2 * i + 1]);
    if (c === 0x00) break;
    name += String.fromCharCode(c);
  }

  const cells: Gen1PatchGridCell[] = [];
  for (let index = 0; index < GEN1_GRID_ROWS * GEN1_GRID_COLS; index++) {
    const at = GRID_OFFSET + index * GRID_CELL_BYTES;
    const effectId = nibbleJoin(bytes[at], bytes[at + 1]);
    cells.push({
      index,
      // Provisional column-major derivation — see Gen1PatchGridCell doc.
      row: index % GEN1_GRID_ROWS,
      col: Math.floor(index / GEN1_GRID_ROWS),
      effectId,
      ...(BLOCK_NAME_BY_ID.has(effectId) ? { blockName: BLOCK_NAME_BY_ID.get(effectId) } : {}),
      stateRaw: [bytes[at + 2], bytes[at + 3]],
    });
  }

  return {
    model: bytes[4],
    source: bytes[6] === 0x01 ? 'edit-buffer' : 'stored',
    name: name.trim(),
    cells,
    paramBlockBytes: bytes.length - 1 - PARAM_REGION_OFFSET,
    totalLength: bytes.length,
  };
}

/**
 * Predicate for `receiveSysExMatching`: accept the MIDI_PATCH_DUMP (fn 0x04)
 * reply to a request built by `buildGetPatchDump`. Matches the Fractal
 * envelope + fn 0x04, and requires the reply's edit-buffer flag (byte 6) to
 * match the request form (the spec shows `04 01` replies to edit-buffer
 * requests and `04 00` replies to stored requests). Length validation is left
 * to parsePatchDump so a truncated frame produces a diagnostic, not a timeout.
 */
export function isPatchDumpResponse(request: readonly number[], resp: readonly number[]): boolean {
  if (resp.length < 8) return false;
  if (resp[0] !== SYSEX_START || resp[resp.length - 1] !== SYSEX_END) return false;
  if (resp[1] !== FRACTAL_MFR[0] || resp[2] !== FRACTAL_MFR[1] || resp[3] !== FRACTAL_MFR[2]) return false;
  if (resp[5] !== FUNC_PATCH_DUMP) return false;
  // Request byte 6 is 0x01 for the edit-buffer form, 0x00 for stored.
  const expectFlag = request[6] === 0x01 ? 0x01 : 0x00;
  return resp[6] === expectFlag;
}
