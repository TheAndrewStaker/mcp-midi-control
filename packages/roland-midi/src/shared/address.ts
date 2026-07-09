// Roland address encoding.
//
// Roland devices address their parameter memory with a 4-byte address where
// every byte carries only 7 bits (MIDI-safe, 0x00..0x7F). The editor stores
// addresses internally as a *packed 28-bit* integer (four 7-bit groups packed
// contiguously) and spreads them across the four wire bytes on send.
//
// Ported byte-for-byte from the VE-500 Editor's `_7bitize()` / `nibble()`
// (converter.js). `sevenBitize` = internal→wire; `nibbleAddr` = wire→internal
// (used when parsing a DT1 reply's address).

/** Packed 28-bit internal address -> 31-bit value whose 4 bytes are each 7-bit. */
export function sevenBitize(addr: number): number {
  return (
    ((addr & 0x0fe00000) << 3) |
    ((addr & 0x001fc000) << 2) |
    ((addr & 0x00003f80) << 1) |
    (addr & 0x0000007f)
  ) >>> 0;
}

/** Inverse of {@link sevenBitize}: a 32-bit wire value -> packed 28-bit internal. */
export function nibbleAddr(x: number): number {
  return (
    ((x & 0x7f000000) >>> 3) |
    ((x & 0x007f0000) >>> 2) |
    ((x & 0x00007f00) >>> 1) |
    (x & 0x0000007f)
  ) >>> 0;
}

/** Packed 28-bit internal address -> 4 wire bytes (big-endian, each 0x00..0x7F). */
export function addrToBytes(addr: number): number[] {
  const w = sevenBitize(addr);
  return [(w >>> 24) & 0x7f, (w >>> 16) & 0x7f, (w >>> 8) & 0x7f, w & 0x7f];
}

/** 4 wire address bytes (big-endian) -> packed 28-bit internal address. */
export function bytesToAddr(bytes: readonly number[]): number {
  const w =
    (((bytes[0] & 0x7f) << 24) |
      ((bytes[1] & 0x7f) << 16) |
      ((bytes[2] & 0x7f) << 8) |
      (bytes[3] & 0x7f)) >>>
    0;
  return nibbleAddr(w);
}
