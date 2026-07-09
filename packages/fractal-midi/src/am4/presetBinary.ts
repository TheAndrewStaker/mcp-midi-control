/**
 * AM4 preset binary — field decoders + encoders.
 *
 * The 12,352-byte AM4 preset binary (see §10b in
 * `docs/devices/am4/SYSEX-MAP.md`) is the body of the 6-message stream
 * (`0x77` header + 4× `0x78` chunks + `0x79` footer) emitted by the
 * device in response to `buildRequestActiveBufferDump` (fn `0x03` with
 * `7F 7F 00` payload) or read sequentially from the factory bank file.
 *
 * Decoded fields so far:
 *
 *   - Preset name: 32-char ASCII, chunk-1 offset `0x0C` (= frame
 *     offset `0x21`), 48 wire bytes, 3-byte-per-2-char chunked
 *     encoding. Recovered 2026-05-21 from  calibration captures
 *     (`samples/exports/{ABCDEFG, Test 1234}.syx`).
 *
 * SUPERSEDED FOR STRUCTURE (2026-07-02): the dump body is now fully
 * container-decoded — it is the gen-3 preset container verbatim (see
 * `presetContainer.ts` / `decodeAm4RawPatch`: 3-to-16 unpack → 8,192-byte
 * CRC-validated raw_patch → Huffman-decompressed body with scene names and
 * LE-u16 param values). The "3-byte-per-2-char chunked encoding" below is
 * the container's 3-to-16 word packing applied to the ASCII name words at
 * raw_patch offset 0x08 (frame offset 0x21 = header 13 + frame overhead 6 +
 * discriminator 2 + 4 words × 3 bytes). This module's name codec remains
 * valid and byte-identical; the decoded-BODY field map (beyond name/scenes/
 * pinned params) is still partial — see presetContainer.ts.
 *
 * # Name wire format
 *
 * 48 wire bytes = 16 independent 3-byte groups, each carrying 2 ASCII
 * characters with 5 padding bits. Each group is independent — high
 * bits of char1 do NOT spill into the next group. This is NOT the
 * standard 8-to-7 sliding-window pack from §6b; it's a discrete
 * 2-char-per-3-byte chunked encoding.
 *
 *     byte0 = char0 & 0x7F                              (low 7 bits of char0)
 *     byte1 = (char0 >> 7) | ((char1 & 0x3F) << 1)      (high bit of char0 + low 6 bits of char1)
 *     byte2 = (char1 >> 6) & 0x03                       (high 2 bits of char1, in bits 0-1)
 *
 * The 32-char buffer is space-padded for the first 31 positions and
 * NUL-terminated at position 31 (the device always writes `\0` in the
 * 32nd byte, not a trailing space — confirmed against every active
 * export captured to date).
 */

/** Size of one preset frame in the AM4 stored binary (active export + factory bank). */
export const AM4_PRESET_FRAME_SIZE = 12_352;

/** Offset of the name field within a preset frame. */
export const AM4_PRESET_NAME_OFFSET = 0x21;

/** Width of the name field in wire bytes. */
export const AM4_PRESET_NAME_WIRE_LENGTH = 48;

/** Width of the name field in decoded characters. */
export const AM4_PRESET_NAME_CHAR_COUNT = 32;

/**
 * Decode an AM4 preset name from its 48-byte wire encoding.
 *
 * Returns a trimmed string with trailing NUL and space padding stripped.
 * Throws if `wire` is shorter than `(charCount / 2) * 3` bytes.
 */
export function decodeAm4PresetName(
  wire: Uint8Array,
  charCount: number = AM4_PRESET_NAME_CHAR_COUNT,
): string {
  const requiredBytes = (charCount / 2) * 3;
  if (wire.length < requiredBytes) {
    throw new Error(
      `decodeAm4PresetName: need ${requiredBytes} wire bytes, got ${wire.length}`,
    );
  }
  const chars: number[] = [];
  for (let g = 0; g < charCount / 2; g++) {
    const b0 = wire[g * 3]!;
    const b1 = wire[g * 3 + 1]!;
    const b2 = wire[g * 3 + 2]!;
    const char0 = (b0 & 0x7f) | ((b1 & 0x01) << 7);
    const char1 = ((b1 >> 1) & 0x3f) | ((b2 & 0x03) << 6);
    chars.push(char0, char1);
  }
  return Buffer.from(chars).toString('ascii').replace(/\0+$/, '').trimEnd();
}

/**
 * Encode an AM4 preset name to its 48-byte wire form.
 *
 * Pads the name with spaces up to position 30 and writes `\0` at position
 * 31 (matches the device's actual wire form — see Test 1234 / ABCDEFG
 * calibration captures). Input must be ASCII; non-ASCII bytes are masked
 * by the encoder.
 */
export function encodeAm4PresetName(
  name: string,
  charCount: number = AM4_PRESET_NAME_CHAR_COUNT,
): Uint8Array {
  const padded = (name + ' '.repeat(charCount)).slice(0, charCount - 1) + '\0';
  const buf = Buffer.from(padded, 'ascii');
  const out = new Uint8Array((charCount / 2) * 3);
  for (let g = 0; g < charCount / 2; g++) {
    const char0 = buf[g * 2]!;
    const char1 = buf[g * 2 + 1]!;
    out[g * 3] = char0 & 0x7f;
    out[g * 3 + 1] = ((char0 >> 7) & 0x01) | ((char1 & 0x3f) << 1);
    out[g * 3 + 2] = (char1 >> 6) & 0x03;
  }
  return out;
}

/**
 * Pull the name field out of a full preset frame and decode it.
 *
 * `frame` may be either a single 12,352-byte preset frame (active
 * export, or one preset's slice of the factory bank) or any byte
 * buffer whose first byte starts at the frame origin (offset 0 = frame
 * byte 0). Validates length only — does not verify §11 framing.
 */
export function decodeAm4PresetNameFromFrame(frame: Uint8Array): string {
  if (frame.length < AM4_PRESET_NAME_OFFSET + AM4_PRESET_NAME_WIRE_LENGTH) {
    throw new Error(
      `decodeAm4PresetNameFromFrame: frame too short (${frame.length} bytes; ` +
        `need ${AM4_PRESET_NAME_OFFSET + AM4_PRESET_NAME_WIRE_LENGTH})`,
    );
  }
  return decodeAm4PresetName(
    frame.subarray(AM4_PRESET_NAME_OFFSET, AM4_PRESET_NAME_OFFSET + AM4_PRESET_NAME_WIRE_LENGTH),
  );
}
