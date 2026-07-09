// Roland parameter value packing.
//
// Each parameter declares a `size` that says how its value is laid out across
// wire data bytes. Ported byte-for-byte from the VE-500 Editor's `constant.js`
// (the size constants) and `parameter.js` (`toHexArray` / `toValue`).
//
// Two families:
//   - INTEGER1xN  (N=1..7): one data byte holding an N-bit value, `v & 0x7F`.
//   - INTEGERnx4  (n=2,3,4,6): the value split into n big-endian 4-bit nibbles,
//     one nibble per data byte (`(v >> 4k) & 0x0F`). This is Roland's encoding
//     for values wider than 7 bits — the same family as the Fractal gen-1
//     nibble-split codec, just n nibbles big-endian instead of 2 little-endian.
//   - PADDING | n: one byte (`v & 0x7F`) repeated n times (reserved fields).
//   - raw count (< INTEGER1x1): an ASCII string of that many chars (patch name).
//
// `ofs` is a signed-value bias: display = wire - ofs (encode adds it back).

export const Size = {
  INTEGER1x1: 0x10000, // 1 byte, 1 significant bit
  INTEGER1x2: 0x10001, // 1 byte, 2 bits
  INTEGER1x3: 0x10002,
  INTEGER1x4: 0x10003,
  INTEGER1x5: 0x10004,
  INTEGER1x6: 0x10005,
  INTEGER1x7: 0x10006, // 1 byte, 7 bits
  INTEGER2x4: 0x10007, // 2 bytes, 4 bits each
  INTEGER3x4: 0x10008, // 3 bytes
  INTEGER4x4: 0x10009, // 4 bytes
  INTEGER6x4: 0x1000a, // 6 bytes
} as const;

export const PADDING = 0x20000;
const INTEGER_BASE = Size.INTEGER1x1;

/** Number of wire data bytes a parameter of this `size` occupies. */
export function wireByteCount(size: number): number {
  if (size & PADDING) return size & ~PADDING;
  if (size < INTEGER_BASE) return size; // raw byte count (e.g. ASCII name length)
  switch (size) {
    case Size.INTEGER2x4:
      return 2;
    case Size.INTEGER3x4:
      return 3;
    case Size.INTEGER4x4:
      return 4;
    case Size.INTEGER6x4:
      return 6;
    default:
      return 1; // any INTEGER1xN
  }
}

/** True for the single-byte INTEGER1x1..INTEGER1x7 sizes. */
function isInteger1x(size: number): boolean {
  return size >= Size.INTEGER1x1 && size <= Size.INTEGER1x7;
}

/**
 * Encode a display/numeric (or string, for ASCII) value to wire data bytes.
 * `ofs` is added for numeric integer sizes (signed-param bias).
 */
export function encodeWire(
  size: number,
  value: number | string,
  ofs = 0,
): number[] {
  if (isInteger1x(size)) {
    return [((value as number) + ofs) & 0x7f];
  }
  switch (size) {
    case Size.INTEGER2x4: {
      const v = (value as number) + ofs;
      return [(v & 0x00f0) >> 4, v & 0x000f];
    }
    case Size.INTEGER3x4: {
      const v = (value as number) + ofs;
      return [(v & 0x0f00) >> 8, (v & 0x00f0) >> 4, v & 0x000f];
    }
    case Size.INTEGER4x4: {
      const v = (value as number) + ofs;
      return [
        (v & 0xf000) >> 12,
        (v & 0x0f00) >> 8,
        (v & 0x00f0) >> 4,
        v & 0x000f,
      ];
    }
    case Size.INTEGER6x4: {
      const v = (value as number) + ofs;
      return [
        (v & 0xf00000) >> 20,
        (v & 0x0f0000) >> 16,
        (v & 0x00f000) >> 12,
        (v & 0x000f00) >> 8,
        (v & 0x0000f0) >> 4,
        v & 0x00000f,
      ];
    }
    default: {
      if (size & PADDING) {
        const n = size & ~PADDING;
        const b = ((value as number) + ofs) & 0x7f;
        return new Array(n).fill(b);
      }
      // ASCII: `size` chars, space-padded (0x20), each char 7-bit.
      const str = String(value);
      const out: number[] = [];
      for (let i = 0; i < size; i++) {
        out[i] = i < str.length ? str.charCodeAt(i) & 0x7f : 0x20;
      }
      return out;
    }
  }
}

/** Decode wire data bytes back to a display/numeric (or string) value. */
export function decodeWire(
  size: number,
  bytes: readonly number[],
  ofs = 0,
): number | string {
  if (isInteger1x(size)) {
    return (bytes[0] & 0x7f) - ofs;
  }
  switch (size) {
    case Size.INTEGER2x4:
      return (((bytes[0] & 0xf) << 4) | (bytes[1] & 0xf)) - ofs;
    case Size.INTEGER3x4:
      return (
        (((bytes[0] & 0xf) << 8) | ((bytes[1] & 0xf) << 4) | (bytes[2] & 0xf)) -
        ofs
      );
    case Size.INTEGER4x4:
      return (
        (((bytes[0] & 0xf) << 12) |
          ((bytes[1] & 0xf) << 8) |
          ((bytes[2] & 0xf) << 4) |
          (bytes[3] & 0xf)) -
        ofs
      );
    case Size.INTEGER6x4:
      return (
        (((bytes[0] & 0xf) << 20) |
          ((bytes[1] & 0xf) << 16) |
          ((bytes[2] & 0xf) << 12) |
          ((bytes[3] & 0xf) << 8) |
          ((bytes[4] & 0xf) << 4) |
          (bytes[5] & 0xf)) -
        ofs
      );
    default: {
      if (size & PADDING) return 0; // reserved/unused
      // ASCII
      let s = '';
      for (let i = 0; i < size; i++) s += String.fromCharCode(bytes[i] & 0x7f);
      return s;
    }
  }
}
