// Roland DT1 / RQ1 SysEx envelope.
//
// Frame shape (ported from the VE-500 Editor's midi_controller.js):
//   DT1 (write):  F0 41 <devId> <modelId...> 12 <addr:4> <data...>  <cksum> F7
//   RQ1 (read):   F0 41 <devId> <modelId...> 11 <addr:4> <size:4>   <cksum> F7
//
// The address (and, for RQ1, the size) are `sevenBitize`d 4-byte fields; the
// checksum covers the address + data (or address + size) bytes only.

import { addrToBytes, bytesToAddr } from './address.js';
import { rolandChecksum } from './checksum.js';

export const STX = 0xf0;
export const ROLAND_ID = 0x41;
export const DT1 = 0x12;
export const RQ1 = 0x11;
export const EOX = 0xf7;
export const BROADCAST_DEVICE_ID = 0x7f;

export interface RolandTarget {
  /** Model ID bytes, e.g. VE-500 = [0x00, 0x00, 0x00, 0x55]. */
  readonly modelId: readonly number[];
  /** Unit device ID (default 0x10). */
  readonly deviceId: number;
}

/** Build a DT1 (write) frame: write `data` to packed-internal `addr`. */
export function buildDT1(
  target: RolandTarget,
  addr: number,
  data: readonly number[],
): number[] {
  const body = [...addrToBytes(addr), ...data];
  return [
    STX,
    ROLAND_ID,
    target.deviceId,
    ...target.modelId,
    DT1,
    ...body,
    rolandChecksum(body),
    EOX,
  ];
}

/**
 * Build a DT1 with a LITERAL (already MIDI-safe) address — the address bytes are
 * sent verbatim, NOT 7-bit-spread. Roland editors use this for the command
 * address space (e.g. VE-500 `7F 00 01 xx` write/comm-mode commands), where the
 * address is hand-authored as wire bytes. Mirrors the editor's `dt1raw`.
 */
export function buildDT1Raw(
  target: RolandTarget,
  addrBytes: readonly number[],
  data: readonly number[],
): number[] {
  const body = [...addrBytes, ...data];
  return [
    STX,
    ROLAND_ID,
    target.deviceId,
    ...target.modelId,
    DT1,
    ...body,
    rolandChecksum(body),
    EOX,
  ];
}

/** Build an RQ1 (read request) frame: request `size` bytes at packed-internal `addr`. */
export function buildRQ1(
  target: RolandTarget,
  addr: number,
  size: number,
): number[] {
  const body = [...addrToBytes(addr), ...addrToBytes(size)];
  return [
    STX,
    ROLAND_ID,
    target.deviceId,
    ...target.modelId,
    RQ1,
    ...body,
    rolandChecksum(body),
    EOX,
  ];
}

export interface ParsedDT1 {
  /** Packed 28-bit internal address the device reported. */
  readonly addr: number;
  /** Data payload bytes. */
  readonly data: number[];
}

/**
 * Parse an inbound DT1 reply for this target. Accepts the unit's own device ID
 * or the broadcast 0x7F. Returns undefined if the message is not a matching DT1.
 */
export function parseDT1(
  target: RolandTarget,
  msg: readonly number[],
): ParsedDT1 | undefined {
  const headLen = 3 + target.modelId.length; // F0 41 dev model...
  if (msg.length < headLen + 1 + 4 + 1 + 1) return undefined;
  if (msg[0] !== STX || msg[1] !== ROLAND_ID) return undefined;
  if (msg[2] !== target.deviceId && msg[2] !== BROADCAST_DEVICE_ID)
    return undefined;
  for (let i = 0; i < target.modelId.length; i++) {
    if (msg[3 + i] !== target.modelId[i]) return undefined;
  }
  if (msg[headLen] !== DT1) return undefined;
  if (msg[msg.length - 1] !== EOX) return undefined;

  const addrStart = headLen + 1;
  const addrBytes = msg.slice(addrStart, addrStart + 4);
  const data = msg.slice(addrStart + 4, msg.length - 2); // drop checksum + F7
  return { addr: bytesToAddr(addrBytes), data };
}

/** Predicate: does `msg` carry a DT1 reply for `addr` (packed internal)? */
export function matchesDT1Addr(
  target: RolandTarget,
  addr: number,
  msg: readonly number[],
): boolean {
  const parsed = parseDT1(target, msg);
  return parsed !== undefined && parsed.addr === addr;
}
