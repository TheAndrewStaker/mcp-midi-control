/**
 * Axe-Fx II preset-dump frame codec + de-framed image buffer.
 *
 * Encode-lane substrate for the II preset image (BK-084 follow-on,
 * 2026-07-16 mining session). A single II preset travels as a 66-message
 * 12,951-byte `0x77/0x78/0x79` stream that de-frames to a fixed
 * 4096-word image (64 chunks x 64 native ushorts; each ushort is a
 * 3-byte septet triplet `lo7 | mid7<<7 | (b2 & 0x03)<<14`). Byte 2's
 * high 5 bits (`b2 & 0x7c`) carry device-private state that every
 * writeback must preserve per the `septet-21bit-byte2-mask-preservation`
 * primitive (NACK 0x13 class); this module carries them per-word in
 * `AxeFxIIImageBuffer.reserved` so splice/patch operations move a word's
 * reserved bits WITH the word.
 *
 * Firmware pinning: all corpus-wide invariants behind this codec are
 * Q8.02 / XL+ scoped (the 384-preset factory banks + local live dumps).
 *
 * The shipped MCP read path lives in `@mcp-midi-control/fractal-gen2`
 * (`presetDump.ts` / `presetImageTlv.ts` / `presetImageRoundTrip.ts`);
 * this codec-package port is the pure encode-lane substrate. The root
 * golden `scripts/verify-ii-image-structural-splice.ts` pins the two
 * implementations byte-identical across the corpus so they cannot
 * silently diverge.
 *
 * Support status: decode logic is corpus-oracled (footer hash is
 * self-validating); ENCODE paths built on it are community-beta /
 * hardware-unverified until a device key-press confirms them.
 */

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AXE_FX_II_MODEL_ID = 0x07;

const FUNC_PRESET_HEADER = 0x77;
const FUNC_PRESET_CHUNK = 0x78;
const FUNC_PRESET_FOOTER = 0x79;

export const II_DUMP_HEADER_LEN = 12;
export const II_DUMP_CHUNK_LEN = 202;
export const II_DUMP_FOOTER_LEN = 11;
export const II_DUMP_CHUNKS_PER_PRESET = 64;

/** F0 + 3 mfr + model + func + checksum + F7 around each payload. */
const ENVELOPE_OVERHEAD = 8;

export const II_DUMP_HEADER_PAYLOAD_LEN = II_DUMP_HEADER_LEN - ENVELOPE_OVERHEAD; // 4
export const II_DUMP_CHUNK_PAYLOAD_LEN = II_DUMP_CHUNK_LEN - ENVELOPE_OVERHEAD; // 194
export const II_DUMP_FOOTER_PAYLOAD_LEN = II_DUMP_FOOTER_LEN - ENVELOPE_OVERHEAD; // 3

/** Total bytes in one preset dump on disk / on the wire. */
export const II_PRESET_DUMP_LEN =
  II_DUMP_HEADER_LEN + II_DUMP_CHUNK_LEN * II_DUMP_CHUNKS_PER_PRESET + II_DUMP_FOOTER_LEN; // 12,951

/** Words in one de-framed preset image (64 chunks x 64 ushorts). */
export const II_IMAGE_WORDS = 4096;

/** One parsed 66-message preset dump (payload views, envelope stripped). */
export interface AxeFxIIPresetDumpFrames {
  /** 4 bytes between 0x77 and its checksum: [bank, preset, 0x00, 0x20]. */
  readonly headerPayload: Uint8Array;
  /** 64 x 194-byte chunk payloads: [countLo, countHi, 64 x 3-byte word]. */
  readonly chunkPayloads: readonly Uint8Array[];
  /** 3 bytes between 0x79 and its checksum: the XOR-fold content hash. */
  readonly footerPayload: Uint8Array;
}

/**
 * The de-framed image with its device-private reserved bits carried
 * per word. `words[i]` is the decoded 16-bit value; `reserved[i]` is
 * `byte2 & 0x7c` of the same triplet. A word's identity on the wire is
 * the (value, reserved) pair; every mutation in this package moves or
 * preserves them together.
 */
export interface AxeFxIIImageBuffer {
  readonly words: Uint16Array;
  readonly reserved: Uint8Array;
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
      throw new Error(`${what}: expected Fractal manufacturer ID 00 01 74 at offset ${offset + 1}`);
    }
  }
  if (bytes[offset + 4] !== AXE_FX_II_MODEL_ID) {
    throw new Error(
      `${what}: expected Axe-Fx II model ID 0x07 at offset ${offset + 4}, got ${hex(bytes[offset + 4])}`,
    );
  }
  if (bytes[offset + 5] !== expectedFunc) {
    throw new Error(
      `${what}: expected function ${hex(expectedFunc)} at offset ${offset + 5}, got ${hex(bytes[offset + 5])}`,
    );
  }
  if (bytes[offset + length - 1] !== SYSEX_END) {
    throw new Error(`${what}: expected F7 at offset ${offset + length - 1}`);
  }
  let acc = 0;
  const csInputEnd = offset + length - 2;
  for (let i = offset; i < csInputEnd; i++) acc ^= bytes[i];
  if (bytes[offset + length - 2] !== (acc & 0x7f)) {
    throw new Error(
      `${what}: checksum mismatch at offset ${offset + length - 2}: expected ${hex(acc & 0x7f)}`,
    );
  }
}

/**
 * Parse one 12,951-byte preset dump. Validates every envelope and
 * checksum; throws on any malformed byte. Payloads are copies (safe to
 * mutate downstream without touching the source buffer).
 */
export function parseIIPresetDumpFrames(bytes: Uint8Array, offset = 0): AxeFxIIPresetDumpFrames {
  if (offset + II_PRESET_DUMP_LEN > bytes.length) {
    throw new Error(
      `parseIIPresetDumpFrames: need ${II_PRESET_DUMP_LEN} bytes at offset ${offset}, ` +
        `got ${bytes.length - offset}`,
    );
  }
  checkEnvelope(bytes, offset, II_DUMP_HEADER_LEN, FUNC_PRESET_HEADER, 'PRESET_DUMP_HEADER (0x77)');
  const headerPayload = bytes.slice(offset + 6, offset + II_DUMP_HEADER_LEN - 2);

  const chunkPayloads: Uint8Array[] = [];
  let cursor = offset + II_DUMP_HEADER_LEN;
  for (let i = 0; i < II_DUMP_CHUNKS_PER_PRESET; i++) {
    checkEnvelope(bytes, cursor, II_DUMP_CHUNK_LEN, FUNC_PRESET_CHUNK, `PRESET_DUMP_CHUNK ${i + 1} (0x78)`);
    chunkPayloads.push(bytes.slice(cursor + 6, cursor + II_DUMP_CHUNK_LEN - 2));
    cursor += II_DUMP_CHUNK_LEN;
  }

  checkEnvelope(bytes, cursor, II_DUMP_FOOTER_LEN, FUNC_PRESET_FOOTER, 'PRESET_DUMP_FOOTER (0x79)');
  const footerPayload = bytes.slice(cursor + 6, cursor + II_DUMP_FOOTER_LEN - 2);

  return { headerPayload, chunkPayloads, footerPayload };
}

function buildMessage(func: number, payload: Uint8Array, totalLen: number): Uint8Array {
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
 * Serialize frames back to the 12,951-byte wire form. Byte-identical
 * to the source for anything that came from `parseIIPresetDumpFrames`.
 */
export function serializeIIPresetDumpFrames(frames: AxeFxIIPresetDumpFrames): Uint8Array {
  if (frames.headerPayload.length !== II_DUMP_HEADER_PAYLOAD_LEN) {
    throw new Error(`serializeIIPresetDumpFrames: header payload must be ${II_DUMP_HEADER_PAYLOAD_LEN} bytes`);
  }
  if (frames.chunkPayloads.length !== II_DUMP_CHUNKS_PER_PRESET) {
    throw new Error(`serializeIIPresetDumpFrames: expected ${II_DUMP_CHUNKS_PER_PRESET} chunk payloads`);
  }
  for (const c of frames.chunkPayloads) {
    if (c.length !== II_DUMP_CHUNK_PAYLOAD_LEN) {
      throw new Error(`serializeIIPresetDumpFrames: chunk payload must be ${II_DUMP_CHUNK_PAYLOAD_LEN} bytes`);
    }
  }
  if (frames.footerPayload.length !== II_DUMP_FOOTER_PAYLOAD_LEN) {
    throw new Error(`serializeIIPresetDumpFrames: footer payload must be ${II_DUMP_FOOTER_PAYLOAD_LEN} bytes`);
  }
  const out = new Uint8Array(II_PRESET_DUMP_LEN);
  let cursor = 0;
  out.set(buildMessage(FUNC_PRESET_HEADER, frames.headerPayload, II_DUMP_HEADER_LEN), cursor);
  cursor += II_DUMP_HEADER_LEN;
  for (const chunk of frames.chunkPayloads) {
    out.set(buildMessage(FUNC_PRESET_CHUNK, chunk, II_DUMP_CHUNK_LEN), cursor);
    cursor += II_DUMP_CHUNK_LEN;
  }
  out.set(buildMessage(FUNC_PRESET_FOOTER, frames.footerPayload, II_DUMP_FOOTER_LEN), cursor);
  return out;
}

/**
 * De-frame chunk payloads to the 4096-word image, carrying each word's
 * reserved byte-2 bits (`b2 & 0x7c`) alongside its 16-bit value.
 */
export function imageFromFrames(frames: AxeFxIIPresetDumpFrames): AxeFxIIImageBuffer {
  const words = new Uint16Array(II_IMAGE_WORDS);
  const reserved = new Uint8Array(II_IMAGE_WORDS);
  for (let c = 0; c < II_DUMP_CHUNKS_PER_PRESET; c++) {
    const p = frames.chunkPayloads[c];
    const count = (p[0] & 0x7f) | ((p[1] & 0x7f) << 7);
    if (count !== 64) {
      throw new Error(`imageFromFrames: chunk ${c + 1} declares ${count} words, expected 64`);
    }
    for (let i = 0; i < 64; i++) {
      const o = 2 + i * 3;
      words[c * 64 + i] = (p[o] & 0x7f) | ((p[o + 1] & 0x7f) << 7) | ((p[o + 2] & 0x03) << 14);
      reserved[c * 64 + i] = p[o + 2] & 0x7c;
    }
  }
  return { words, reserved };
}

/** Deep-copy an image buffer (mutating ops copy before writing). */
export function copyImage(image: AxeFxIIImageBuffer): AxeFxIIImageBuffer {
  return { words: Uint16Array.from(image.words), reserved: Uint8Array.from(image.reserved) };
}

/**
 * The footer content hash: the XOR-fold of the FULL 21-BIT words
 * (`lo7 | mid7<<7 | b2<<14`, i.e. value bits PLUS the byte-2 reserved
 * bits), encoded as 3 septets.
 *
 * DECODED 2026-07-16 (this session, from the bk070 paired hardware
 * dumps whose footers change in the byte-2 septet when a scene word's
 * reserved bits change, then confirmed corpus-wide): 500/503 on-disk
 * dumps carry exactly this 21-bit fold in their footer; the only 3
 * misses are the locally hand-modified push-test artifacts with
 * deliberately invalid footers. The earlier 16-bit-fold +
 * preserve-footer-byte-2 model was a correct SPECIAL CASE (16-bit-only
 * patches never change the fold's high septet); this is the general
 * formula (refines the `xor-fold-hash` primitive).
 */
export function computeImageHash21(image: AxeFxIIImageBuffer): number {
  let hash = 0;
  for (let i = 0; i < image.words.length; i++) {
    hash ^= image.words[i] | (image.reserved[i] << 14);
  }
  return hash & 0x1fffff;
}

/**
 * Legacy 16-bit fold over the value words alone (the low 16 bits of
 * the 21-bit fold whenever reserved bits are untouched). Kept for
 * parity checks against the shipped fractal-gen2 formula.
 */
export function computeImageHash(words: Uint16Array): number {
  let hash = 0;
  for (const w of words) hash ^= w & 0xffff;
  return hash & 0xffff;
}

/**
 * Re-frame an image buffer to chunk payloads + a recomputed footer.
 * Each word re-encodes as `[v & 0x7f, (v >> 7) & 0x7f, reserved | ((v >> 14) & 0x03)]`,
 * so reserved bits survive byte-exactly. The footer is the full 21-bit
 * XOR-fold of the image (see `computeImageHash21`); it needs no
 * preserved bits because every one of its 21 bits is computed.
 */
export function framesFromImage(
  image: AxeFxIIImageBuffer,
  headerPayload: Uint8Array,
): AxeFxIIPresetDumpFrames {
  if (image.words.length !== II_IMAGE_WORDS || image.reserved.length !== II_IMAGE_WORDS) {
    throw new Error(`framesFromImage: image must be ${II_IMAGE_WORDS} words`);
  }
  const chunkPayloads: Uint8Array[] = [];
  for (let c = 0; c < II_DUMP_CHUNKS_PER_PRESET; c++) {
    const p = new Uint8Array(II_DUMP_CHUNK_PAYLOAD_LEN);
    p[0] = 0x40; // count = 64
    p[1] = 0x00;
    for (let i = 0; i < 64; i++) {
      const v = image.words[c * 64 + i];
      const o = 2 + i * 3;
      p[o] = v & 0x7f;
      p[o + 1] = (v >> 7) & 0x7f;
      p[o + 2] = (image.reserved[c * 64 + i] & 0x7c) | ((v >> 14) & 0x03);
    }
    chunkPayloads.push(p);
  }
  const hash = computeImageHash21(image);
  const footerPayload = new Uint8Array([
    hash & 0x7f,
    (hash >> 7) & 0x7f,
    (hash >> 14) & 0x7f,
  ]);
  return { headerPayload: Uint8Array.from(headerPayload), chunkPayloads, footerPayload };
}

export type IIImageRoundTripCheck =
  | { readonly ok: true; readonly image: AxeFxIIImageBuffer }
  | { readonly ok: false; readonly reason: string };

/**
 * Round-trip-identity precondition (the fractal-midi equivalent of the
 * shipped `verifyRoundTripIdentity` contract, strengthened to the full
 * 21-bit footer): the dump must de-frame cleanly AND its own footer
 * must equal the 21-bit XOR-fold our formula predicts, or the dump is
 * not trustworthy to address at all. Byte-2 reserved bits inside the
 * image are NOT a corruption signal (they are routine firmware-defined
 * state, carried per word); only the footer formula is asserted.
 *
 * Additionally re-serializes through `framesFromImage` and requires
 * byte-identity with the source frames: the general re-encode gate
 * (any field this codec fails to carry would surface here before an
 * encode op could drop it).
 */
export function verifyImageRoundTrip(frames: AxeFxIIPresetDumpFrames): IIImageRoundTripCheck {
  let image: AxeFxIIImageBuffer;
  try {
    image = imageFromFrames(frames);
  } catch (err) {
    return { ok: false, reason: `deframe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const hash = computeImageHash21(image);
  const f = frames.footerPayload;
  if (f[0] !== (hash & 0x7f) || f[1] !== ((hash >> 7) & 0x7f) || f[2] !== ((hash >> 14) & 0x7f)) {
    return {
      ok: false,
      reason:
        `footer hash mismatch: recomputed 21-bit fold 0x${hash.toString(16).padStart(6, '0')} does not ` +
        `match source footer bytes [${f[0]},${f[1]},${f[2]}]`,
    };
  }
  const rebuilt = framesFromImage(image, frames.headerPayload);
  for (let c = 0; c < II_DUMP_CHUNKS_PER_PRESET; c++) {
    const a = frames.chunkPayloads[c];
    const b = rebuilt.chunkPayloads[c];
    for (let i = 0; i < II_DUMP_CHUNK_PAYLOAD_LEN; i++) {
      if (a[i] !== b[i]) {
        return {
          ok: false,
          reason: `re-encode identity failed: chunk ${c + 1} byte ${i} (${a[i]} vs ${b[i]}); ` +
            `the codec does not carry every field of this dump`,
        };
      }
    }
  }
  return { ok: true, image };
}
