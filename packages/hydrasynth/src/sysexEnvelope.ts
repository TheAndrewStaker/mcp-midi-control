/**
 * SysEx envelope codec for ASM Hydrasynth.
 *
 * Wire format per `docs/devices/hydrasynth-explorer/references/SysexEncoding.txt`
 * (edisyn, Sean Luke, 2023). Every Hydrasynth sysex message has shape:
 *
 *   F0 00 20 2B 00 6F  <ASCII base64 of payload>  F7
 *
 * where the binary `payload` is `[checksum(4)] [info...]` and the four
 * checksum bytes derive from a CRC-32 over the info bytes:
 *
 *   crc = CRC-32(info)                       // standard reversed 0xEDB88320
 *   payload[0..3] = (0xFF - crc[0]),         // little-endian byte order of crc
 *                   (0xFF - crc[1]),         //   then each byte XOR'd with 0xFF
 *                   (0xFF - crc[2]),
 *                   (0xFF - crc[3])
 *
 * `wrapSysex(info)` builds the full F0…F7 byte stream for a given logical
 * message (e.g. `[0x04, 0x00, 0x00, 0x7F]` = "request bank 0 patch 127");
 * `unwrapSysex(msg)` reverses it, validating the envelope and CRC.
 *
 * Goldens for this module live in `scripts/hydrasynth/verify-sysex-envelope.ts`
 * and exercise the worked example from the spec byte-exactly.
 */
import { Buffer } from 'node:buffer';

const HEADER: readonly number[] = [0xf0, 0x00, 0x20, 0x2b, 0x00, 0x6f];
const FOOTER = 0xf7;

const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3 / zlib) over the given bytes. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build the four-byte checksum prefix the Hydrasynth expects ahead of
 * `info` inside the base64 payload. See module-level docstring.
 */
function checksumBytes(info: Uint8Array): [number, number, number, number] {
  const crc = crc32(info);
  // CRC value is treated as AABBCCDD with AA the most significant byte.
  const aa = (crc >>> 24) & 0xff;
  const bb = (crc >>> 16) & 0xff;
  const cc = (crc >>> 8) & 0xff;
  const dd = crc & 0xff;
  // Reverse to DD CC BB AA, then subtract each from 0xFF.
  return [
    (0xff - dd) & 0xff,
    (0xff - cc) & 0xff,
    (0xff - bb) & 0xff,
    (0xff - aa) & 0xff,
  ];
}

/**
 * Wrap a logical Hydrasynth message (e.g. `[0x18, 0x00]` for "header")
 * into the full F0…F7 SysEx byte stream the device expects.
 *
 * @param info  the raw inner bytes of the message — checksum and base64
 *              are added by this function.
 * @returns     a fresh `number[]` ready to ship over MIDI.
 */
export function wrapSysex(info: Uint8Array | ArrayLike<number>): number[] {
  const infoBytes = info instanceof Uint8Array ? info : Uint8Array.from(info);
  const [c0, c1, c2, c3] = checksumBytes(infoBytes);
  const payload = new Uint8Array(infoBytes.length + 4);
  payload[0] = c0;
  payload[1] = c1;
  payload[2] = c2;
  payload[3] = c3;
  payload.set(infoBytes, 4);
  const base64 = Buffer.from(payload).toString('base64');
  const out: number[] = HEADER.slice();
  for (let i = 0; i < base64.length; i++) {
    out.push(base64.charCodeAt(i));
  }
  out.push(FOOTER);
  return out;
}

/**
 * Reverse of `wrapSysex`. Validates the F0…F7 envelope and the CRC-32
 * checksum, then returns the inner info bytes.
 *
 * Throws on any malformed message: wrong start/end byte, wrong header
 * namespace, truncated payload, base64 decode failure, or CRC mismatch.
 */
export function unwrapSysex(msg: ArrayLike<number>): Uint8Array {
  if (msg.length < HEADER.length + 1 + 1) {
    throw new Error(
      `SysEx message too short: ${msg.length} bytes (need >= ${HEADER.length + 2})`,
    );
  }
  if (msg[0] !== 0xf0) {
    throw new Error(
      `SysEx start mismatch: expected 0xF0, got 0x${toHex(msg[0])}`,
    );
  }
  if (msg[msg.length - 1] !== FOOTER) {
    throw new Error(
      `SysEx end mismatch: expected 0xF7, got 0x${toHex(msg[msg.length - 1])}`,
    );
  }
  for (let i = 1; i < HEADER.length; i++) {
    if (msg[i] !== HEADER[i]) {
      throw new Error(
        `SysEx header mismatch at byte ${i}: expected 0x${toHex(HEADER[i])}, got 0x${toHex(msg[i])}`,
      );
    }
  }

  let base64 = '';
  for (let i = HEADER.length; i < msg.length - 1; i++) {
    const b = msg[i];
    if (b < 0x20 || b > 0x7e) {
      throw new Error(
        `SysEx payload byte ${i} out of ASCII range: 0x${toHex(b)}`,
      );
    }
    base64 += String.fromCharCode(b);
  }
  const payload = Buffer.from(base64, 'base64');
  if (payload.length < 4) {
    throw new Error(
      `SysEx payload too short to contain checksum: ${payload.length} bytes`,
    );
  }
  const info = new Uint8Array(payload.subarray(4));
  const [e0, e1, e2, e3] = checksumBytes(info);
  if (
    payload[0] !== e0 ||
    payload[1] !== e1 ||
    payload[2] !== e2 ||
    payload[3] !== e3
  ) {
    const got = `${toHex(payload[0])} ${toHex(payload[1])} ${toHex(payload[2])} ${toHex(payload[3])}`;
    const want = `${toHex(e0)} ${toHex(e1)} ${toHex(e2)} ${toHex(e3)}`;
    throw new Error(
      `SysEx CRC-32 mismatch: payload checksum = ${got}, expected ${want}`,
    );
  }
  return info;
}

function toHex(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

/** Exposed for goldens; not part of the public API surface. */
export const __internal = { crc32, checksumBytes };
