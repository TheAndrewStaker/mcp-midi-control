/**
 * Axe-Fx III 0x77/0x78/0x79 PRESET_DUMP message parsing and serialization.
 *
 * A single Axe-Fx III preset is exported as an 18-message stream totaling
 * 49,336 bytes:
 *
 *   Msg 1     13B    func 0x77   PRESET_DUMP_HEADER   (5-byte payload)
 *   Msg 2..17 3082B  func 0x78   PRESET_DUMP_CHUNK    (3074-byte payload, x16)
 *   Msg 18    11B    func 0x79   PRESET_DUMP_FOOTER   (3-byte payload)
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
 *    `fractal-midi/docs/research/cookbook/vendor-envelope-descriptor-table.md`.
 *
 * 2. **Factory-bank structural validation** (no hardware needed). The
 *    three bank files at
 *    `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_{A,B,C}-*.syx`
 *    are each exactly 128 x 49,336 bytes. Every preset across the 384
 *    factory entries parses as 1 x 0x77 (13B) + 16 x 0x78 (3082B) + 1 x
 *    0x79 (11B), checksums validate via the same XOR-7F primitive used
 *    on II/AM4, and the header payload monotonically encodes
 *    `[bank, preset, 0x00, 0x00, 0x01]` (bank A=0, B=1, C=2; preset
 *    0x00..0x7F).
 *
 * Header payload bytes (5): `[bank, preset, 0x00, 0x00, 0x01]`. Bank
 * is the letter index (A=0, B=1, ...), preset is the 0..127 offset
 * within the bank. The trailing `0x00 0x00 0x01` bytes are constant
 * across all 384 factory presets; their semantic role hasn't been
 * verified against a hardware write-back, but treating them as
 * opaque-constant is safe for round-trip serialization.
 *
 * Chunk payload bytes (3074 each): the preset binary. The first two
 * bytes are constant `0x00 0x08` across every observed chunk (the
 * `mid=6, byte_count=2` field per the descriptor table; likely a
 * chunk-discriminator or length-prefix); the remaining 3072 bytes are
 * the packed payload (1024 ushorts x 3 bytes/ushort septet packing per
 * the cookbook primitive `septet-21bit-byte2-mask-preservation`).
 * Total preset body across 16 chunks: 49,152 bytes of packed-ushort
 * storage = 16,384 ushorts. Inner per-scene / per-block decode is
 * the subject of future work (the III analog of BK-070); this module
 * treats chunk payloads as opaque blobs.
 *
 * Footer payload bytes (3): believed to be a content hash (parallel to
 * AM4's and II's 0x79 footers per the same cookbook primitive). Treat
 * as opaque for round-trip purposes.
 *
 * BETA / HYPOTHESIS NOTE. This module's frame layout is derived from
 * the III editor binary's descriptor tables and matched against the
 * factory bank files. The Ghidra dispatcher map
 * (`fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-host-emitter-map.txt`)
 * lists 0x77/0x78/0x79 as host-emittable with no workflow registered,
 * implying these fns are emitted from generic "Export Preset Bundle"
 * (0x1C) / "File Snapshot / Get Preset Data" (0x19) paths rather than
 * a dedicated preset-push workflow. The factory bank shape parses
 * cleanly under the hypothesis above, so the layout is verified
 * **structurally on N=384 presets** but **NOT** byte-verified against
 * a live III device push capture (no such capture is committed to
 * either repo). Treat round-trip on a single factory preset as a
 * structural lower bound, not as hardware-verified ground truth.
 *
 * Per the cookbook + N=1 generalization rule, the III variant of the
 * preset-push primitive is `status: matched` only because the factory
 * banks supply N=384 distinct fixtures (3 banks x 128 presets) with
 * the same layout. A live hardware push capture would tighten the
 * status from "structural match" to "round-trip verified."
 */

import { fractalChecksum } from 'fractal-midi/shared';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AXE_FX_III_MODEL_ID = 0x10;

const FUNC_PRESET_HEADER = 0x77;
const FUNC_PRESET_CHUNK = 0x78;
const FUNC_PRESET_FOOTER = 0x79;

export const HEADER_LEN = 13;
export const CHUNK_LEN = 3082;
export const FOOTER_LEN = 11;
export const CHUNKS_PER_PRESET = 16;

/** Bytes wrapping a payload: F0 + 3 mfr + model + func + cs + F7 = 8. */
const ENVELOPE_OVERHEAD = 8;

export const HEADER_PAYLOAD_LEN = HEADER_LEN - ENVELOPE_OVERHEAD; // 5
export const CHUNK_PAYLOAD_LEN = CHUNK_LEN - ENVELOPE_OVERHEAD;   // 3074
export const FOOTER_PAYLOAD_LEN = FOOTER_LEN - ENVELOPE_OVERHEAD; // 3

/** Total bytes in one preset dump on disk / on the wire. */
export const PRESET_DUMP_LEN =
  HEADER_LEN + CHUNK_LEN * CHUNKS_PER_PRESET + FOOTER_LEN; // 49,336

/** A parsed Axe-Fx III preset dump. Payload buffers are slices of source. */
export interface ParsedPresetDump {
  /** The original 49,336 bytes this dump was parsed from. */
  readonly raw: Uint8Array;
  /** 5 bytes between 0x77 and its checksum: [bank, preset, 0x00, 0x00, 0x01]. */
  readonly headerPayload: Uint8Array;
  /** 16 x 3074-byte chunk payloads. Inner structure is opaque. */
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
  if (bytes[offset + 4] !== AXE_FX_III_MODEL_ID) {
    throw new Error(
      `${what}: expected Axe-Fx III model ID 0x10 at offset ${offset + 4}, got ${hex(bytes[offset + 4])}`,
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
 * Parse one Axe-Fx III preset dump (49,336 bytes) from a buffer.
 *
 * Validates every message envelope and checksum. Throws on any malformed
 * byte. The returned payload arrays are slices of the source buffer.
 */
export function parsePresetDump(bytes: Uint8Array, offset = 0): ParsedPresetDump {
  if (offset + PRESET_DUMP_LEN > bytes.length) {
    throw new Error(
      `parsePresetDump: insufficient bytes, need ${PRESET_DUMP_LEN} starting at offset ${offset}, ` +
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
 * Parse a buffer holding N back-to-back Axe-Fx III preset dumps. The
 * factory bank files
 * `Axe-Fx_III_BANK_{A,B,C}-*.syx` are the canonical example: 128
 * concatenated dumps per bank, no separator.
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
  out[4] = AXE_FX_III_MODEL_ID;
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
 * Serialize a parsed dump back to its 49,336-byte wire form. For any
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
 * Extract the preset name from a parsed dump.
 *
 * HYPOTHESIS / NOT YET VERIFIED. The II preset binary stores the name
 * at chunk 0 payload offset 8, encoded as 32 3-byte triplets where each
 * triplet's first byte is an ASCII character (the other two bytes are
 * zero or low-bit padding from the septet packing). The III chunk
 * payload uses the same septet-21bit-byte2-mask-preservation packing
 * primitive (per the cookbook), so the same scan SHOULD recover the
 * name, but the III's preset-binary inner layout is otherwise opaque
 * and the name offset is NOT verified. This function applies the II
 * convention as a first-cut hypothesis; the test harness logs the
 * decoded names so a human can eyeball them against known factory
 * preset names. If the decode does not produce printable ASCII, the
 * name offset or stride is wrong for the III and the function should
 * be re-derived from a known-name factory preset.
 *
 * Returns whatever the chunk-0 byte-8-stride-3 scan produces, trimmed.
 * Caller should not assume this is a valid preset name on the III
 * until a known-name fixture confirms.
 */
export const PRESET_NAME_PAYLOAD_OFFSET = 8;
export const PRESET_NAME_MAX_CHARS = 32;
export const PRESET_NAME_STRIDE = 3;

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
