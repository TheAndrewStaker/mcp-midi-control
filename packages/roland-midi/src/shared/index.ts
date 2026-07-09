// Barrel for roland-midi/shared.
//
// Vendor-shared Roland protocol primitives that every Roland/Boss device builds
// on: the DT1/RQ1 SysEx envelope, the Roland checksum, the 7-bit address
// transform, and the INTEGER1xN / INTEGERnx4 value packing. Pure code — no MIDI
// transport dependency. Bring your own.

export { rolandChecksum } from './checksum.js';
export {
  sevenBitize,
  nibbleAddr,
  addrToBytes,
  bytesToAddr,
} from './address.js';
export {
  Size,
  PADDING,
  wireByteCount,
  encodeWire,
  decodeWire,
} from './packValue.js';
export {
  STX,
  ROLAND_ID,
  DT1,
  RQ1,
  EOX,
  BROADCAST_DEVICE_ID,
  buildDT1,
  buildDT1Raw,
  buildRQ1,
  parseDT1,
  matchesDT1Addr,
} from './sysex.js';
export type { RolandTarget, ParsedDT1 } from './sysex.js';
