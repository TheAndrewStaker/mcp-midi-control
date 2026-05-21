/**
 * Axe-Fx II 0x77/0x78/0x79 PRESET_DUMP message parsing and serialization.
 *
 * A single Axe-Fx II preset is exported / uploaded as a 66-message stream
 * totaling 12,951 bytes:
 *
 *   Msg 1     12B   func 0x77   PRESET_DUMP_HEADER  (4-byte payload)
 *   Msg 2..65 202B  func 0x78   PRESET_DUMP_CHUNK   (194-byte payload, ×64)
 *   Msg 66    11B   func 0x79   PRESET_DUMP_FOOTER  (3-byte payload)
 *
 * The wire layout was confirmed Session 53 against the factory bank files
 * (`samples/factory/Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx`). Each bank file
 * is exactly 128 × 12,951 bytes = 1,657,728 bytes — a clean concatenation
 * of all 128 presets with no inter-preset separator.
 *
 * Header payload bytes (4): `[bank, preset, 0x00, 0x20]`. `bank` is the
 * letter index (A=0, B=1, ...), `preset` is the 0..127 offset within the
 * bank. The trailing `0x00 0x20` bytes are constant across all 384 factory
 * presets (per static analysis); their semantic role hasn't been verified
 * against a write-back, but treating them as opaque-constant is safe for
 * round-trip serialization.
 *
 * Chunk payload bytes (194 each): the preset binary. Sessions 113 cont 3
 * static analysis showed the binary is NOT Huffman-encrypted or
 * XOR-masked — it's a structured serialization where data bytes are
 * separated by zero-byte padding (roughly every 3rd byte holds data).
 * The preset name lives at chunk 0, payload offset 8, encoded as 32
 * 3-byte triplets where each triplet's first byte is an ASCII character
 * (the next two bytes are zero). Other fields use similar packed layouts.
 *
 * Footer payload bytes (3): believed to be a content hash (parallel to
 * AM4's 0x79 footer per `packages/am4/src/presetDump.ts`). Treat as
 * opaque for round-trip purposes.
 *
 * This module deliberately treats chunk payloads as opaque blobs. The
 * inner per-scene / per-block layout is the subject of the BK-070
 * decode (factory-bank diff harness). Once the offset map lands, this
 * module can grow `extractPresetState` / `applyPresetState` helpers
 * that read/write specific fields without disturbing the rest of the
 * binary.
 *
 * Target use cases:
 *   - Atomic read: dump the working buffer (or any stored preset) in
 *     ~1-2 s instead of an 8 s scene-walk. Unblocks `get_preset` v2
 *     with full per-scene + per-channel state in one round-trip.
 *   - Atomic write: serialize a constructed PresetSpec to the wire and
 *     push it as a single 66-message stream. Eliminates the
 *     SET_BLOCK_CHANNEL frames that corrupt non-active scene state
 *     (Session 102 test transcript). The structural fix BK-070
 *     "apply side" targets.
 *   - Backup / restore: byte-identical round-trip lets us archive
 *     working buffers to disk and replay them later.
 */

import { fractalChecksum } from 'fractal-midi/shared';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AXE_FX_II_MODEL_ID = 0x07;

const FUNC_PRESET_HEADER = 0x77;
const FUNC_PRESET_CHUNK = 0x78;
const FUNC_PRESET_FOOTER = 0x79;

export const HEADER_LEN = 12;
export const CHUNK_LEN = 202;
export const FOOTER_LEN = 11;
export const CHUNKS_PER_PRESET = 64;

/** Bytes wrapping a payload: F0 + 3 mfr + model + func + cs + F7 = 8. */
const ENVELOPE_OVERHEAD = 8;

export const HEADER_PAYLOAD_LEN = HEADER_LEN - ENVELOPE_OVERHEAD; // 4
export const CHUNK_PAYLOAD_LEN = CHUNK_LEN - ENVELOPE_OVERHEAD;   // 194
export const FOOTER_PAYLOAD_LEN = FOOTER_LEN - ENVELOPE_OVERHEAD; // 3

/** Total bytes in one preset dump on disk / on the wire. */
export const PRESET_DUMP_LEN =
  HEADER_LEN + CHUNK_LEN * CHUNKS_PER_PRESET + FOOTER_LEN; // 12,951

/** Where the preset name starts inside chunk 0's payload. */
export const PRESET_NAME_PAYLOAD_OFFSET = 8;
/** Max preset name length in characters. */
export const PRESET_NAME_MAX_CHARS = 32;
/** Stride between consecutive preset-name characters (1 char per 3 bytes). */
export const PRESET_NAME_STRIDE = 3;

/** A parsed Axe-Fx II preset dump. Payload buffers are slices of source. */
export interface ParsedPresetDump {
  /** The original 12,951 bytes this dump was parsed from. */
  readonly raw: Uint8Array;
  /** 4 bytes between 0x77 and its checksum: [bank, preset, 0x00, 0x20]. */
  readonly headerPayload: Uint8Array;
  /** 64 × 194-byte chunk payloads. Inner structure is opaque. */
  readonly chunkPayloads: readonly Uint8Array[];
  /** 3 bytes between 0x79 and its checksum. Believed to be a content hash. */
  readonly footerPayload: Uint8Array;
}

function hex(b: number): string {
  return '0x' + b.toString(16).padStart(2, '0');
}

function checkEnvelope(
  bytes: Uint8Array,
  offset: number,
  length: number,
  expectedFunc: number,
  what: string,
): void {
  if (bytes[offset] !== SYSEX_START) {
    throw new Error(`${what}: expected F0 at offset ${offset}, got ${hex(bytes[offset])}`);
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (bytes[offset + 1 + i] !== FRACTAL_MFR[i]) {
      throw new Error(
        `${what}: expected Fractal manufacturer ID 00 01 74 at offset ${offset + 1}, ` +
          `got ${hex(bytes[offset + 1])} ${hex(bytes[offset + 2])} ${hex(bytes[offset + 3])}`,
      );
    }
  }
  if (bytes[offset + 4] !== AXE_FX_II_MODEL_ID) {
    throw new Error(
      `${what}: expected Axe-Fx II model ID 0x07 at offset ${offset + 4}, got ${hex(bytes[offset + 4])}`,
    );
  }
  if (bytes[offset + 5] !== expectedFunc) {
    throw new Error(
      `${what}: expected function ${hex(expectedFunc)} at offset ${offset + 5}, ` +
        `got ${hex(bytes[offset + 5])}`,
    );
  }
  if (bytes[offset + length - 1] !== SYSEX_END) {
    throw new Error(
      `${what}: expected F7 at offset ${offset + length - 1}, got ${hex(bytes[offset + length - 1])}`,
    );
  }
  let acc = 0;
  const csInputEnd = offset + length - 2;
  for (let i = offset; i < csInputEnd; i++) acc ^= bytes[i];
  const expected = acc & 0x7f;
  const got = bytes[offset + length - 2];
  if (got !== expected) {
    throw new Error(
      `${what}: checksum mismatch at offset ${offset + length - 2}: ` +
        `expected ${hex(expected)}, got ${hex(got)}`,
    );
  }
}

/**
 * Parse one Axe-Fx II preset dump (12,951 bytes) from a buffer.
 *
 * Validates every message envelope and checksum. Throws on any malformed
 * byte. The returned payload arrays are slices of the source buffer.
 */
export function parsePresetDump(bytes: Uint8Array, offset = 0): ParsedPresetDump {
  if (offset + PRESET_DUMP_LEN > bytes.length) {
    throw new Error(
      `parsePresetDump: insufficient bytes — need ${PRESET_DUMP_LEN} starting at offset ${offset}, ` +
        `got ${bytes.length - offset} remaining`,
    );
  }

  const headerStart = offset;
  checkEnvelope(bytes, headerStart, HEADER_LEN, FUNC_PRESET_HEADER, 'PRESET_DUMP_HEADER (0x77)');
  const headerPayload = bytes.slice(
    headerStart + 6,
    headerStart + HEADER_LEN - 2,
  );

  const chunkPayloads: Uint8Array[] = [];
  let cursor = headerStart + HEADER_LEN;
  for (let i = 0; i < CHUNKS_PER_PRESET; i++) {
    checkEnvelope(
      bytes,
      cursor,
      CHUNK_LEN,
      FUNC_PRESET_CHUNK,
      `PRESET_DUMP_CHUNK ${i + 1}/${CHUNKS_PER_PRESET} (0x78)`,
    );
    chunkPayloads.push(bytes.slice(cursor + 6, cursor + CHUNK_LEN - 2));
    cursor += CHUNK_LEN;
  }

  checkEnvelope(bytes, cursor, FOOTER_LEN, FUNC_PRESET_FOOTER, 'PRESET_DUMP_FOOTER (0x79)');
  const footerPayload = bytes.slice(cursor + 6, cursor + FOOTER_LEN - 2);

  return {
    raw: bytes.slice(offset, offset + PRESET_DUMP_LEN),
    headerPayload,
    chunkPayloads,
    footerPayload,
  };
}

/**
 * Parse a buffer holding N back-to-back Axe-Fx II preset dumps. The
 * factory bank files `Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx` are the
 * canonical example: 128 concatenated dumps per bank, no separator.
 */
export function parsePresetBank(bytes: Uint8Array): ParsedPresetDump[] {
  if (bytes.length === 0 || bytes.length % PRESET_DUMP_LEN !== 0) {
    throw new Error(
      `parsePresetBank: expected length to be a non-zero multiple of ${PRESET_DUMP_LEN} ` +
        `(one preset dump), got ${bytes.length}`,
    );
  }
  const count = bytes.length / PRESET_DUMP_LEN;
  const out: ParsedPresetDump[] = [];
  for (let i = 0; i < count; i++) {
    out.push(parsePresetDump(bytes, i * PRESET_DUMP_LEN));
  }
  return out;
}

function buildMessage(
  func: number,
  payload: Uint8Array,
  totalLen: number,
): Uint8Array {
  const out = new Uint8Array(totalLen);
  out[0] = SYSEX_START;
  out[1] = FRACTAL_MFR[0];
  out[2] = FRACTAL_MFR[1];
  out[3] = FRACTAL_MFR[2];
  out[4] = AXE_FX_II_MODEL_ID;
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
 * Serialize a parsed dump back to its 12,951-byte wire form. For any
 * input that came from `parsePresetDump`, the output is byte-identical
 * to the input. Used by backup/restore and the round-trip golden.
 */
export function serializePresetDump(parsed: ParsedPresetDump): Uint8Array {
  if (parsed.headerPayload.length !== HEADER_PAYLOAD_LEN) {
    throw new Error(
      `serializePresetDump: header payload must be ${HEADER_PAYLOAD_LEN} bytes, ` +
        `got ${parsed.headerPayload.length}`,
    );
  }
  if (parsed.chunkPayloads.length !== CHUNKS_PER_PRESET) {
    throw new Error(
      `serializePresetDump: expected ${CHUNKS_PER_PRESET} chunk payloads, ` +
        `got ${parsed.chunkPayloads.length}`,
    );
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

  const out = new Uint8Array(PRESET_DUMP_LEN);
  let cursor = 0;
  out.set(buildMessage(FUNC_PRESET_HEADER, parsed.headerPayload, HEADER_LEN), cursor);
  cursor += HEADER_LEN;
  for (const chunk of parsed.chunkPayloads) {
    out.set(buildMessage(FUNC_PRESET_CHUNK, chunk, CHUNK_LEN), cursor);
    cursor += CHUNK_LEN;
  }
  out.set(buildMessage(FUNC_PRESET_FOOTER, parsed.footerPayload, FOOTER_LEN), cursor);
  return out;
}

/**
 * Extract the preset name from a parsed dump. The name is stored in
 * chunk 0 starting at payload offset 8, encoded as up to 32 3-byte
 * triplets where each triplet's first byte is an ASCII character and
 * the next two bytes are zero pad. A zero first-byte terminates the
 * name early.
 *
 * Returns the trimmed string. Static analysis of all 384 factory presets
 * (Session 113 cont 3) showed this decoding produces clean preset names
 * for every entry — "59 Bassguy", "Plexi 100W Treble", "5153 Red", etc.
 */
export function extractPresetName(parsed: ParsedPresetDump): string {
  const chunk0 = parsed.chunkPayloads[0];
  let name = '';
  for (let i = 0; i < PRESET_NAME_MAX_CHARS; i++) {
    const ch = chunk0[PRESET_NAME_PAYLOAD_OFFSET + i * PRESET_NAME_STRIDE];
    if (ch === 0 || ch === undefined) break;
    name += String.fromCharCode(ch);
  }
  return name.trim();
}

/**
 * Re-export for callers that want to compute checksums without
 * re-importing from `fractal-midi/shared`.
 */
export { fractalChecksum };
