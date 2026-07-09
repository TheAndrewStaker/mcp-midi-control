// Roland SysEx checksum (the "Roland checksum").
//
// Computed over the address bytes + data bytes of a DT1/RQ1 message. The
// device validates that (sum of those bytes + checksum) is a multiple of 128.
//
// Ported byte-for-byte from the Boss VE-500 Editor's own `chksum()`
// (midi_controller.js): `sum = Σbytes; cksum = (128 - (sum % 128)) & 0x7F`.
// This is the Roland family standard, NOT the Fractal XOR-and-mask checksum.

/** Roland checksum over the given bytes (address + data). Returns 0..127. */
export function rolandChecksum(bytes: readonly number[]): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return (128 - (sum % 128)) & 0x7f;
}
