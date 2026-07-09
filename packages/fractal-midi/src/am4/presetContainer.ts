/**
 * AM4 preset-dump CONTAINER decode (fn `0x77/0x78/0x79` stream → decoded
 * preset body). DECODED 2026-07-02: the AM4 dump body is the gen-3 preset
 * container, verbatim, at the AM4's chunk count:
 *
 *   0x77 header (13 B) + 4 × 0x78 chunks (3,082 B each) + 0x79 footer (11 B)
 *   = 12,352 B total (`AM4_PRESET_FRAME_SIZE`).
 *
 * Each chunk payload = 2-byte discriminator (`[0x00, 0x08]`, constant across
 * every AM4 chunk observed) + 3,072 packed bytes. Concatenating the packed
 * bytes and 3-to-16 unpacking yields the 8,192-byte `raw_patch`
 * (4 × 1,024 LE u16 words) with the shared layout
 * (`fractal-midi/shared` presetContainer.ts):
 *
 *   0x00 u16  firmware/format word: 0x0107 = fw 1.01, 0x0109 = fw 2.00
 *   0x02 u16  0xAA55 magic
 *   0x04 u16  CRC-16/CCITT poly 0x1021 init 0xAA55, computed with
 *             bytes [0x04:0x06] zeroed — valid on all 104 fw 1.01 factory
 *             presets + 14 fw 2.00 hardware exports
 *   0x08      32-byte ASCII preset name (plaintext after the unpack; its
 *             packed image is the "3-byte-per-2-char" encoding presetBinary.ts
 *             documented at frame offset 0x21 — same bytes, now explained)
 *   0x48 u16  decompressed body size
 *   0x4A u16  compressed body size
 *   0x4C ...  gen-3 dynamic-Huffman bitstream, decompressing to exactly
 *             decompSize bytes; the raw_patch tail after the bitstream is
 *             zero-filled
 *
 * The 3-byte 0x79 footer payload is the septet-packed u16 XOR of all
 * raw_patch LE words (`computeRawPatchXor`) — matches on the full corpus.
 *
 * Decoded-BODY field map is PARTIAL. Pinned so far (all offsets are into the
 * decompressed body; values are standard AM4 LE u16 on the 0..65534 wire
 * scale):
 *
 *   - Scene records @ 0x0004 + n×0x50 (n = 0..3): 32-byte ASCII scene name
 *     (space-padded, NUL at index 31, same convention as the preset name),
 *     followed by per-scene state (channel bytes visible at strided
 *     positions; not yet mapped).
 *   - amp.gain channel A @ 0x0958 (oracle: warm-pair capture, 5.1 →
 *     0x828E = round(5.1/10×65534)).
 *   - ONE VOLATILE u16 @ 0x140E: changes between back-to-back no-op redumps
 *     of an unchanged buffer. Diffing at the decoded layer must ignore it.
 *     (This word — re-Huffman-coded with a churned dynamic code table — is
 *     what made the compressed layer look "non-deterministic"; see cookbook
 *     `_negative/am4-preset-dump-flat-byte-diff.md`.)
 *
 * The rest of the body (block records, routing, remaining params) is the
 * follow-on decode; do not treat the constants below as a complete map.
 */

import {
  decode3to16,
  computeRawPatchCrc,
  computeRawPatchXor,
  huffmanUncompress,
  RAW_PATCH_CRC_OFFSET,
  RAW_PATCH_DECOMP_SIZE_OFFSET,
  RAW_PATCH_COMP_SIZE_OFFSET,
  RAW_PATCH_BODY_OFFSET,
} from '../shared/presetContainer.js';
import { AM4_MODEL_ID } from './setParam.js';

// ── Container shape (AM4 instantiation of the shared container) ──────

/** AM4 dumps carry 4 chunk frames (the III emits 16, FM3/FM9 emit 8). */
export const AM4_CONTAINER_CHUNK_COUNT = 4;
/** 4 chunks × 1,024 words × 2 bytes. */
export const AM4_RAW_PATCH_SIZE = 8192;
/** 32-byte ASCII preset name inside the raw_patch. */
export const AM4_RAW_PATCH_NAME_OFFSET = 0x08;
export const AM4_RAW_PATCH_NAME_LENGTH = 32;
/** Constant 2-byte chunk discriminator observed on every AM4 chunk. */
export const AM4_CHUNK_DISCRIMINATOR: readonly [number, number] = [0x00, 0x08];

/** raw_patch word 0 — firmware/format version word. */
export const AM4_FW_WORD_1P01 = 0x0107;
export const AM4_FW_WORD_2P00 = 0x0109;
/** raw_patch word 1 — container magic. */
export const AM4_RAW_PATCH_MAGIC = 0xaa55;

// ── Decoded-body field map (PARTIAL — see module doc) ────────────────

export const AM4_SCENE_COUNT = 4;
/** First scene record's name field, in the DECOMPRESSED body. */
export const AM4_BODY_SCENE_NAME_OFFSET = 0x0004;
/** Stride between consecutive scene records. */
export const AM4_BODY_SCENE_RECORD_STRIDE = 0x50;
/** 32-byte ASCII, space-padded, NUL at index 31. */
export const AM4_BODY_SCENE_NAME_LENGTH = 32;
/** amp.gain channel A as LE u16 (0..65534) — pinned by warm-pair oracle. */
export const AM4_BODY_AMP_GAIN_CHA_OFFSET = 0x0958;
/** The one u16 that churns between no-op redumps; exclude from diffs. */
export const AM4_BODY_VOLATILE_WORD_OFFSET = 0x140e;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PRESET_HEADER = 0x77;
const FUNC_PRESET_CHUNK = 0x78;
const FUNC_PRESET_FOOTER = 0x79;

const HEADER_LEN = 13;
const CHUNK_LEN = 3082;
const FOOTER_LEN = 11;

function hex(b: number): string {
  return '0x' + (b ?? -1).toString(16).padStart(2, '0');
}

function u16le(buf: Uint8Array, off: number): number {
  return ((buf[off] ?? 0) | ((buf[off + 1] ?? 0) << 8)) & 0xffff;
}

/** Read one AM4 SysEx frame at `offset`: validate envelope, model byte, and
 *  the XOR-7F checksum; return func, total length, and payload. */
function readFrame(
  bytes: Uint8Array,
  offset: number,
  what: string,
): { func: number; length: number; payload: Uint8Array } {
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
  if (bytes[offset + 4] !== AM4_MODEL_ID) {
    throw new Error(
      `${what}: expected AM4 model ID ${hex(AM4_MODEL_ID)} at offset ${offset + 4}, ` +
        `got ${hex(bytes[offset + 4])}`,
    );
  }
  let end = offset + 6;
  while (end < bytes.length && bytes[end] !== SYSEX_END) end++;
  if (end >= bytes.length) {
    throw new Error(`${what}: no F7 terminator found after offset ${offset}`);
  }
  const csIndex = end - 1;
  let acc = 0;
  for (let i = offset; i < csIndex; i++) acc ^= bytes[i];
  if (bytes[csIndex] !== (acc & 0x7f)) {
    throw new Error(
      `${what}: checksum mismatch at offset ${csIndex}: expected ${hex(acc & 0x7f)}, ` +
        `got ${hex(bytes[csIndex])}`,
    );
  }
  return { func: bytes[offset + 5], length: end - offset + 1, payload: bytes.slice(offset + 6, csIndex) };
}

/** A parsed (framing-layer) AM4 preset dump. */
export interface ParsedAm4PresetDump {
  /** 5 bytes between 0x77 and its checksum (location addressing; opaque here). */
  readonly headerPayload: Uint8Array;
  /** 4 × 3,074-byte chunk payloads (2-byte discriminator + 3,072 packed). */
  readonly chunkPayloads: readonly Uint8Array[];
  /** 3 bytes: septet-packed u16 XOR of the raw_patch words. */
  readonly footerPayload: Uint8Array;
  /** Total bytes consumed (12,352 for every AM4 dump observed). */
  readonly byteLength: number;
}

/**
 * Frame-walk one AM4 preset dump starting at `offset`: one 0x77 header,
 * consecutive 0x78 chunks, one 0x79 footer. Validates envelope, model byte,
 * per-frame checksums, and frame lengths. Chunk COUNT is not asserted here
 * (it is the per-device container knob); `decodeAm4RawPatch` checks the
 * resulting raw_patch size instead.
 */
export function parseAm4PresetDump(bytes: Uint8Array, offset = 0): ParsedAm4PresetDump {
  const header = readFrame(bytes, offset, 'AM4 PRESET_DUMP_HEADER (0x77)');
  if (header.func !== FUNC_PRESET_HEADER) {
    throw new Error(`AM4 PRESET_DUMP_HEADER: expected func 0x77, got ${hex(header.func)}`);
  }
  if (header.length !== HEADER_LEN) {
    throw new Error(`AM4 PRESET_DUMP_HEADER: expected frame length ${HEADER_LEN}, got ${header.length}`);
  }
  const chunkPayloads: Uint8Array[] = [];
  let cursor = offset + header.length;
  for (;;) {
    if (cursor + 6 > bytes.length) {
      throw new Error(`parseAm4PresetDump: ran out of bytes scanning for chunk/footer at offset ${cursor}`);
    }
    if (bytes[cursor + 5] === FUNC_PRESET_FOOTER) break;
    const what = `AM4 PRESET_DUMP_CHUNK ${chunkPayloads.length + 1} (0x78)`;
    const chunk = readFrame(bytes, cursor, what);
    if (chunk.func !== FUNC_PRESET_CHUNK) {
      throw new Error(`${what}: expected func 0x78, got ${hex(chunk.func)}`);
    }
    if (chunk.length !== CHUNK_LEN) {
      throw new Error(`${what}: expected frame length ${CHUNK_LEN}, got ${chunk.length}`);
    }
    chunkPayloads.push(chunk.payload);
    cursor += chunk.length;
  }
  if (chunkPayloads.length === 0) {
    throw new Error('parseAm4PresetDump: no 0x78 chunk frames between header and footer');
  }
  const footer = readFrame(bytes, cursor, 'AM4 PRESET_DUMP_FOOTER (0x79)');
  if (footer.length !== FOOTER_LEN) {
    throw new Error(`AM4 PRESET_DUMP_FOOTER: expected frame length ${FOOTER_LEN}, got ${footer.length}`);
  }
  cursor += footer.length;
  return {
    headerPayload: header.payload,
    chunkPayloads,
    footerPayload: footer.payload,
    byteLength: cursor - offset,
  };
}

/** Read a 32-byte ASCII name field: stop at NUL, strip trailing spaces. */
function readNameField(buf: Uint8Array, offset: number, length: number): string {
  let name = '';
  for (let i = offset; i < offset + length && i < buf.length; i++) {
    const c = buf[i];
    if (c === 0) break;
    name += String.fromCharCode(c);
  }
  return name.replace(/\s+$/, '');
}

/** A fully container-decoded AM4 preset. */
export interface Am4DecodedPreset {
  /** 32-char ASCII preset name from raw_patch offset 0x08. */
  readonly name: string;
  /** raw_patch word 0: 0x0107 = fw 1.01, 0x0109 = fw 2.00. */
  readonly fwWord: number;
  /** word 1 === 0xAA55. */
  readonly magicValid: boolean;
  /** The 8,192-byte unpacked LE image. */
  readonly rawPatch: Uint8Array;
  readonly storedCrc: number;
  readonly computedCrc: number;
  readonly crcValid: boolean;
  /** u16 from the 0x79 footer (septet-unpacked). */
  readonly storedFooterXor: number;
  readonly computedFooterXor: number;
  readonly footerXorValid: boolean;
  readonly decompSize: number;
  readonly compSize: number;
  /** True when the Huffman stream produced exactly decompSize bytes. */
  readonly huffmanComplete: boolean;
  /**
   * The decompressed preset body (decompSize bytes). Field map is PARTIAL
   * (see module doc). CAVEAT for diffing: the u16 at
   * `AM4_BODY_VOLATILE_WORD_OFFSET` (0x140E) churns between back-to-back
   * no-op redumps — exclude it when comparing two decoded bodies.
   */
  readonly decompressedBody: Uint8Array;
  /** The four 32-char scene names from the decoded body (may be empty strings). */
  readonly sceneNames: readonly [string, string, string, string];
  /** Bytes consumed from the input (one dump). */
  readonly byteLength: number;
}

/**
 * Decode one AM4 0x77/0x78/0x79 preset dump (active-buffer export, stored
 * dump, or one preset's slice of the factory bank) into its container-decoded
 * form. Accepts the raw frame bytes; pass `offset` to walk a concatenated
 * bank file (advance by `byteLength`).
 *
 * Throws on framing/checksum errors and on a raw_patch size other than
 * 8,192 B; CRC / footer-XOR / Huffman-termination results are REPORTED via
 * flags rather than thrown so a caller can surface a corrupt dump usefully.
 */
export function decodeAm4RawPatch(bytes: Uint8Array, offset = 0): Am4DecodedPreset {
  const parsed = parseAm4PresetDump(bytes, offset);

  let total = 0;
  for (const c of parsed.chunkPayloads) total += c.length - 2; // strip 2-byte discriminator
  const packed = new Uint8Array(total);
  let off = 0;
  for (const c of parsed.chunkPayloads) { packed.set(c.subarray(2), off); off += c.length - 2; }
  const rawPatch = decode3to16(packed);
  if (rawPatch.length !== AM4_RAW_PATCH_SIZE) {
    throw new Error(
      `decodeAm4RawPatch: expected an ${AM4_RAW_PATCH_SIZE}-byte raw_patch ` +
        `(${AM4_CONTAINER_CHUNK_COUNT} chunks), got ${rawPatch.length} bytes ` +
        `from ${parsed.chunkPayloads.length} chunks`,
    );
  }

  const storedCrc = u16le(rawPatch, RAW_PATCH_CRC_OFFSET);
  const computedCrc = computeRawPatchCrc(rawPatch);
  const decompSize = u16le(rawPatch, RAW_PATCH_DECOMP_SIZE_OFFSET);
  const compSize = u16le(rawPatch, RAW_PATCH_COMP_SIZE_OFFSET);
  const decompressedBody = huffmanUncompress(
    rawPatch.subarray(RAW_PATCH_BODY_OFFSET, RAW_PATCH_BODY_OFFSET + compSize),
    decompSize,
  );

  const fp = parsed.footerPayload;
  const storedFooterXor = ((fp[0] ?? 0) | ((fp[1] ?? 0) << 7) | ((fp[2] ?? 0) << 14)) & 0xffff;
  const computedFooterXor = computeRawPatchXor(rawPatch);

  const sceneNames = [0, 1, 2, 3].map((n) =>
    readNameField(
      decompressedBody,
      AM4_BODY_SCENE_NAME_OFFSET + n * AM4_BODY_SCENE_RECORD_STRIDE,
      AM4_BODY_SCENE_NAME_LENGTH,
    ),
  ) as [string, string, string, string];

  return {
    name: readNameField(rawPatch, AM4_RAW_PATCH_NAME_OFFSET, AM4_RAW_PATCH_NAME_LENGTH),
    fwWord: u16le(rawPatch, 0x00),
    magicValid: u16le(rawPatch, 0x02) === AM4_RAW_PATCH_MAGIC,
    rawPatch,
    storedCrc,
    computedCrc,
    crcValid: storedCrc === computedCrc,
    storedFooterXor,
    computedFooterXor,
    footerXorValid: storedFooterXor === computedFooterXor,
    decompSize,
    compSize,
    huffmanComplete: decompressedBody.length === decompSize,
    decompressedBody,
    sceneNames,
    byteLength: parsed.byteLength,
  };
}
