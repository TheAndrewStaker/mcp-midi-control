/**
 * Modern Fractal (gen-3) 0x77/0x78/0x79 PRESET_DUMP message parsing and
 * serialization. One codec for the whole gen-3 family (Axe-Fx III 0x10,
 * FM3 0x11, FM9 0x12, VP4 0x14): the envelope shape is identical across
 * the family; only the model byte and the number of chunk frames differ.
 *
 * A preset is exported as a 0x77 header frame, a run of 0x78 chunk frames,
 * and a 0x79 footer frame. Frame lengths are family-constant:
 *
 *   header   13B    func 0x77   PRESET_DUMP_HEADER   (5-byte payload)
 *   chunk    3082B  func 0x78   PRESET_DUMP_CHUNK    (3074-byte payload)
 *   footer   11B    func 0x79   PRESET_DUMP_FOOTER   (3-byte payload)
 *
 * The CHUNK COUNT is what varies by device/preset, so parsing counts the
 * 0x78 frames between the 0x77 head and the 0x79 tail rather than asserting
 * a fixed count. The Axe-Fx III emits 16 chunks (49,336 B total); the FM9
 * emits 8 chunks (24,680 B total) for the same envelope.
 *
 * The wire layout was synthesized from two evidence sources:
 *
 * 1. **Descriptor table mining** (no hardware needed). The III's editor
 *    binary contains the same kind of `(tag, mid, byte_count)` descriptor
 *    tables Session 113-115 decoded for the II. Table at `0x1407ab940`
 *    declares `(tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=3072)`,
 *    encoding a chunk envelope with a 2-byte field at offset 6 (chunk
 *    index / discriminator) followed by 3072 bytes of packed body (1024
 *    ushorts x 3-byte septet packing). Mining work captured in
 *    `fractal-midi/docs/research/primitives/vendor-envelope-descriptor-table.md`.
 *
 * 2. **Factory-bank + on-disk export structural validation** (no hardware
 *    needed). The three III bank files at
 *    `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_{A,B,C}-*.syx`
 *    are each exactly 128 x 49,336 bytes; every preset across the 384
 *    factory entries parses as 1 x 0x77 (13B) + 16 x 0x78 (3082B) + 1 x
 *    0x79 (11B). An on-disk FM9 export
 *    (`samples/captured/fm9-152-super-duos2-exported-*.syx`, model 0x12,
 *    24,680 B) parses as 1 x 0x77 (13B) + 8 x 0x78 (3082B) + 1 x 0x79 (11B)
 *    under this same frame-counted parser, with every checksum valid via
 *    the same XOR-7F primitive used on II/AM4.
 *
 * Header payload bytes (5): device-specific. The III encodes
 * `[bank, preset, 0x00, 0x00, 0x01]`; the FM9 (no banks) encodes a
 * septet-split preset number `[presetHigh, presetLow, 0x00, 0x40, 0x00]`.
 * This module treats the header payload as opaque for round-trip purposes
 * and does not interpret it.
 *
 * Chunk payload bytes (3074 each): the preset binary. The first two bytes
 * are a chunk discriminator (the `mid=6, byte_count=2` field per the
 * descriptor table); the remaining 3072 bytes are 1024 ushorts packed
 * 3 bytes/ushort (low septet, mid septet, high septet -> little-endian
 * 16-bit value). This module is the FRAMING layer only: it reassembles the
 * chunk ushort image and decodes the preset name (below), but treats the
 * rest of the chunk body as an opaque blob. The inner per-scene /
 * per-block decode is NOT future work: it ships in `presetBody.ts`
 * (`decodeGen3Body` / `decodeGen3PresetDump`), which Huffman-decompresses
 * the reassembled image into the flat `raw_patch` and decodes the grid,
 * placed blocks, per-channel effect types, amp model + knobs, modifiers,
 * and scene state (cross-validated against the reference decoder over all
 * 384 III factory presets). presetDump's own scope stays framing + name.
 *
 * Footer payload bytes (3): the uint16 XOR of every little-endian word of
 * the raw_patch image, septet-packed (`[xor&0x7f, (xor>>7)&0x7f,
 * (xor>>14)&0x7f]`). Proven byte-exact across the III factory banks (N=384)
 * and an FM9 export by `computeRawPatchXor` + `scripts/verify-gen3-authoring.ts`.
 * Authoring recomputes it on any edit (`encodeFooterXor` in presetAuthor.ts);
 * a plain parse→serialize round-trip preserves it verbatim.
 *
 * READ DIRECTION WIRE-VERIFIED (FM9 fw 11.00, 2026-06-04). The
 * device→host dump was previously only structurally verified (III factory
 * banks N=384 + an on-disk FM9 export N=1). A "receive preset from device"
 * USBPcap capture now confirms the dump on the wire: the host requests a
 * stored preset with `fn=0x03 [preset#:14b big-endian]`
 * (`buildRequestPresetDump` in `fractal-midi/gen3/axe-fx-iii`) and the device
 * replies with this exact 0x77/0x78/0x79 chain. The reassembled body's
 * `word[1] == 0xAA55` magic and the word-4 name decode reproduce here
 * (e.g. "4x12 Plexi DARK AltCab"), and `parsePresetDump` + `extractPresetName`
 * parse the captured bytes directly. Evidence:
 * `docs/_private/FM9-CAPTURE-RECEIVE+SWEEP-2026-06-04.md`.
 *
 * WRITE-BACK (host→device 0x77/0x78/0x79) is still NOT captured; treat
 * `serializePresetDump` output as file-backup bytes, not a verified
 * device-bound restore stream, until that direction is captured.
 */

import { fractalChecksum } from 'fractal-midi/shared';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;

const FUNC_PRESET_HEADER = 0x77;
const FUNC_PRESET_CHUNK = 0x78;
const FUNC_PRESET_FOOTER = 0x79;

/** Frame lengths are family-constant across all gen-3 models. */
export const HEADER_LEN = 13;
export const CHUNK_LEN = 3082;
export const FOOTER_LEN = 11;

/** Bytes wrapping a payload: F0 + 3 mfr + model + func + cs + F7 = 8. */
const ENVELOPE_OVERHEAD = 8;

export const HEADER_PAYLOAD_LEN = HEADER_LEN - ENVELOPE_OVERHEAD; // 5
export const CHUNK_PAYLOAD_LEN = CHUNK_LEN - ENVELOPE_OVERHEAD;   // 3074
export const FOOTER_PAYLOAD_LEN = FOOTER_LEN - ENVELOPE_OVERHEAD; // 3

/**
 * The Axe-Fx III emits 16 chunks per preset; one III preset dump is
 * 49,336 bytes. These describe the III's canonical shape (used by the III
 * factory-bank golden); the parser itself counts frames and does not
 * depend on them. FM9 dumps are a different chunk count (8) and total.
 */
export const CHUNKS_PER_PRESET = 16;
export const PRESET_DUMP_LEN =
  HEADER_LEN + CHUNK_LEN * CHUNKS_PER_PRESET + FOOTER_LEN; // 49,336

/** A parsed gen-3 preset dump. Payload buffers are slices of source. */
export interface ParsedPresetDump {
  /** The model byte shared by every frame in this dump (0x10/0x11/0x12/...). */
  readonly modelId: number;
  /** The original bytes this dump was parsed from. */
  readonly raw: Uint8Array;
  /** Total byte length of this dump (header + chunks + footer). */
  readonly byteLength: number;
  /** 5 bytes between 0x77 and its checksum. Device-specific; opaque here. */
  readonly headerPayload: Uint8Array;
  /** N x 3074-byte chunk payloads. Inner structure is opaque. */
  readonly chunkPayloads: readonly Uint8Array[];
  /** 3 bytes between 0x79 and its checksum: septet-packed uint16 XOR of the
   *  raw_patch words (see `computeRawPatchXor` / `encodeFooterXor`). */
  readonly footerPayload: Uint8Array;
}

function hex(b: number): string {
  return '0x' + b.toString(16).padStart(2, '0');
}

/**
 * Locate one SysEx frame starting at `offset` by scanning to the next
 * F7 terminator (no payload byte can be 0xF7 since payload is 7-bit, so
 * the scan is unambiguous). Validates the envelope and checksum, asserts
 * the model byte matches `modelId`, and returns the frame's func, length,
 * and payload (the bytes between the func byte and the checksum).
 */
function readFrame(
  bytes: Uint8Array,
  offset: number,
  modelId: number,
  what: string,
): { func: number; length: number; payload: Uint8Array } {
  if (bytes[offset] !== SYSEX_START) {
    throw new Error(`${what}: expected F0 at offset ${offset}, got ${hex(bytes[offset] ?? -1)}`);
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (bytes[offset + 1 + i] !== FRACTAL_MFR[i]) {
      throw new Error(
        `${what}: expected Fractal manufacturer ID 00 01 74 at offset ${offset + 1}, ` +
          `got ${hex(bytes[offset + 1])} ${hex(bytes[offset + 2])} ${hex(bytes[offset + 3])}`,
      );
    }
  }
  if (bytes[offset + 4] !== modelId) {
    throw new Error(
      `${what}: expected model ID ${hex(modelId)} at offset ${offset + 4}, got ${hex(bytes[offset + 4] ?? -1)}`,
    );
  }
  // Scan to the frame terminator.
  let end = offset + 6;
  while (end < bytes.length && bytes[end] !== SYSEX_END) end++;
  if (end >= bytes.length) {
    throw new Error(`${what}: no F7 terminator found after offset ${offset}`);
  }
  const length = end - offset + 1;
  // Checksum is the byte immediately before F7.
  const csIndex = end - 1;
  let acc = 0;
  for (let i = offset; i < csIndex; i++) acc ^= bytes[i];
  const expected = acc & 0x7f;
  if (bytes[csIndex] !== expected) {
    throw new Error(
      `${what}: checksum mismatch at offset ${csIndex}: expected ${hex(expected)}, got ${hex(bytes[csIndex])}`,
    );
  }
  return {
    func: bytes[offset + 5],
    length,
    payload: bytes.slice(offset + 6, csIndex),
  };
}

function expectFrameLength(actual: number, expected: number, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected frame length ${expected}, got ${actual}`);
  }
}

/**
 * Parse one gen-3 preset dump starting at `offset` by walking frames:
 * one 0x77 header, then every consecutive 0x78 chunk up to the 0x79 footer.
 *
 * The model byte is taken from the header frame and asserted to be
 * identical across every frame in the dump. Pass `expectedModelId` to
 * additionally require a specific model (e.g. when the caller knows it is
 * reading an FM9 dump); omit it to accept whatever gen-3 model the bytes
 * declare. Returned payload arrays are slices of the source buffer.
 */
export function parsePresetDump(
  bytes: Uint8Array,
  offset = 0,
  expectedModelId?: number,
): ParsedPresetDump {
  if (offset + HEADER_LEN > bytes.length) {
    throw new Error(
      `parsePresetDump: insufficient bytes for a header at offset ${offset} ` +
        `(need ${HEADER_LEN}, have ${bytes.length - offset})`,
    );
  }
  const modelId = expectedModelId ?? bytes[offset + 4];

  const header = readFrame(bytes, offset, modelId, 'PRESET_DUMP_HEADER (0x77)');
  if (header.func !== FUNC_PRESET_HEADER) {
    throw new Error(
      `PRESET_DUMP_HEADER: expected func 0x77 at offset ${offset}, got ${hex(header.func)}`,
    );
  }
  expectFrameLength(header.length, HEADER_LEN, 'PRESET_DUMP_HEADER (0x77)');

  const chunkPayloads: Uint8Array[] = [];
  let cursor = offset + header.length;
  for (;;) {
    if (cursor + 6 > bytes.length) {
      throw new Error(
        `parsePresetDump: ran out of bytes scanning for chunk/footer at offset ${cursor}`,
      );
    }
    const func = bytes[cursor + 5];
    if (func === FUNC_PRESET_FOOTER) break;
    const what = `PRESET_DUMP_CHUNK ${chunkPayloads.length + 1} (0x78)`;
    const chunk = readFrame(bytes, cursor, modelId, what);
    if (chunk.func !== FUNC_PRESET_CHUNK) {
      throw new Error(`${what}: expected func 0x78, got ${hex(chunk.func)}`);
    }
    expectFrameLength(chunk.length, CHUNK_LEN, what);
    chunkPayloads.push(chunk.payload);
    cursor += chunk.length;
  }

  if (chunkPayloads.length === 0) {
    throw new Error('parsePresetDump: no 0x78 chunk frames between header and footer');
  }

  const footer = readFrame(bytes, cursor, modelId, 'PRESET_DUMP_FOOTER (0x79)');
  expectFrameLength(footer.length, FOOTER_LEN, 'PRESET_DUMP_FOOTER (0x79)');
  cursor += footer.length;

  const byteLength = cursor - offset;
  return {
    modelId,
    raw: bytes.slice(offset, cursor),
    byteLength,
    headerPayload: header.payload,
    chunkPayloads,
    footerPayload: footer.payload,
  };
}

/**
 * Parse a buffer holding N back-to-back preset dumps. The III factory bank
 * files are the canonical example: 128 concatenated dumps per bank, no
 * separator. Frame-walks each dump and advances by its byte length, so it
 * handles dumps of differing chunk counts in one buffer.
 */
export function parsePresetBank(bytes: Uint8Array, expectedModelId?: number): ParsedPresetDump[] {
  if (bytes.length === 0) {
    throw new Error('parsePresetBank: empty buffer');
  }
  const out: ParsedPresetDump[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const parsed = parsePresetDump(bytes, cursor, expectedModelId);
    out.push(parsed);
    cursor += parsed.byteLength;
  }
  return out;
}

function buildMessage(
  modelId: number,
  func: number,
  payload: Uint8Array,
  totalLen: number,
): Uint8Array {
  const out = new Uint8Array(totalLen);
  out[0] = SYSEX_START;
  out[1] = FRACTAL_MFR[0];
  out[2] = FRACTAL_MFR[1];
  out[3] = FRACTAL_MFR[2];
  out[4] = modelId;
  out[5] = func;
  out.set(payload, 6);
  const csIndex = 6 + payload.length;
  let acc = 0;
  for (let i = 0; i < csIndex; i++) acc ^= out[i];
  out[csIndex] = acc & 0x7f;
  out[csIndex + 1] = SYSEX_END;
  return out;
}

/**
 * Serialize a parsed dump back to its wire form. For any input that came
 * from `parsePresetDump`, the output is byte-identical to the input. Used
 * by backup/restore and the round-trip golden.
 */
export function serializePresetDump(parsed: ParsedPresetDump): Uint8Array {
  if (parsed.headerPayload.length !== HEADER_PAYLOAD_LEN) {
    throw new Error(
      `serializePresetDump: header payload must be ${HEADER_PAYLOAD_LEN} bytes, ` +
        `got ${parsed.headerPayload.length}`,
    );
  }
  if (parsed.chunkPayloads.length === 0) {
    throw new Error('serializePresetDump: at least one chunk payload is required');
  }
  for (let i = 0; i < parsed.chunkPayloads.length; i++) {
    if (parsed.chunkPayloads[i].length !== CHUNK_PAYLOAD_LEN) {
      throw new Error(
        `serializePresetDump: chunk ${i + 1} payload must be ${CHUNK_PAYLOAD_LEN} bytes, ` +
          `got ${parsed.chunkPayloads[i].length}`,
      );
    }
  }
  if (parsed.footerPayload.length !== FOOTER_PAYLOAD_LEN) {
    throw new Error(
      `serializePresetDump: footer payload must be ${FOOTER_PAYLOAD_LEN} bytes, ` +
        `got ${parsed.footerPayload.length}`,
    );
  }

  const totalLen =
    HEADER_LEN + CHUNK_LEN * parsed.chunkPayloads.length + FOOTER_LEN;
  const out = new Uint8Array(totalLen);
  let cursor = 0;
  out.set(buildMessage(parsed.modelId, FUNC_PRESET_HEADER, parsed.headerPayload, HEADER_LEN), cursor);
  cursor += HEADER_LEN;
  for (const chunk of parsed.chunkPayloads) {
    out.set(buildMessage(parsed.modelId, FUNC_PRESET_CHUNK, chunk, CHUNK_LEN), cursor);
    cursor += CHUNK_LEN;
  }
  out.set(buildMessage(parsed.modelId, FUNC_PRESET_FOOTER, parsed.footerPayload, FOOTER_LEN), cursor);
  return out;
}

/**
 * Preset-name word decode (verified offline, no hardware).
 *
 * The preset name lives in chunk 0's ushort body. After the 2-byte chunk
 * discriminator, the body is 1024 ushorts packed 3 bytes/ushort
 * (`value = b0 | b1<<7 | b2<<14`, masked to 16 bits). Word index 1 holds a
 * constant `0xAA55` magic; the name is ASCII starting at word index 4, two
 * characters per 16-bit word (low byte then high byte), space-padded and
 * NUL-terminated, up to 16 words (32 chars).
 *
 * Verified against the FM9 export ("Super Duos2") and the III factory banks
 * ("59 Bassguy", "Vibrato Lux", "Deluxe Verb", ...). If the magic word is
 * absent the layout is unknown for that fixture and an empty string is
 * returned rather than garbage.
 */
export const PRESET_NAME_MAGIC = 0xaa55;
export const PRESET_NAME_MAGIC_WORD_INDEX = 1;
export const PRESET_NAME_FIRST_WORD = 4;
export const PRESET_NAME_MAX_WORDS = 16;

/** Chunk discriminator occupies the first 2 payload bytes; words follow. */
const CHUNK_BODY_OFFSET = 2;

/** Unpack one 16-bit word from a chunk payload's septet-packed ushort body. */
function unpackChunkWord(chunkPayload: Uint8Array, wordIndex: number): number {
  const off = CHUNK_BODY_OFFSET + wordIndex * 3;
  const b0 = chunkPayload[off] ?? 0;
  const b1 = chunkPayload[off + 1] ?? 0;
  const b2 = chunkPayload[off + 2] ?? 0;
  return (b0 | (b1 << 7) | (b2 << 14)) & 0xffff;
}

export function extractPresetName(parsed: ParsedPresetDump): string {
  const chunk0 = parsed.chunkPayloads[0];
  if (chunk0 === undefined) return '';
  if (unpackChunkWord(chunk0, PRESET_NAME_MAGIC_WORD_INDEX) !== PRESET_NAME_MAGIC) {
    return '';
  }
  let name = '';
  for (let i = 0; i < PRESET_NAME_MAX_WORDS; i++) {
    const w = unpackChunkWord(chunk0, PRESET_NAME_FIRST_WORD + i);
    const lo = w & 0xff;
    if (lo === 0) break;
    name += String.fromCharCode(lo);
    const hi = (w >> 8) & 0xff;
    if (hi === 0) break;
    name += String.fromCharCode(hi);
  }
  return name.replace(/\s+$/, '');
}

/**
 * Re-export for callers that want to compute checksums without
 * re-importing from `fractal-midi/shared`.
 */
export { fractalChecksum };
