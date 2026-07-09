/**
 * Circuit Tracks project (.ncs) SysEx transfer, payload + framing layer.
 *
 * This is the over-USB transport Components uses to move a whole project to
 * the device (the alternative to copying the file onto a microSD card). It is
 * clean-room reverse-engineered (algorithm + message shapes only; independent
 * TypeScript implementation). The transport is CRC32-gated: a malformed upload
 * is rejected by the device, so it is safe to iterate.
 *
 * THIS MODULE IS PURE (no MIDI I/O): it builds the exact ordered SysEx frames
 * for an upload (and the per-frame ACK matchers), so the whole payload is
 * unit-testable offline. The bidirectional send loop (send frame, await ACK,
 * watchdog) that drives these onto hardware lives separately and is the
 * hardware-verified step.
 *
 * Envelope: F0 00 20 29 01 64 03 <subcmd> <payload...> F7
 *   00 20 29 = Novation, 01 = product type, 64 = Circuit Tracks, 03 = file cmd group.
 */

import { NCS_FILE_SIZE } from './format.js';

const HEADER = [0x00, 0x20, 0x29, 0x01, 0x64, 0x03] as const;

const SUBCMD = {
  WRITE_INIT: 0x01,
  WRITE_DATA: 0x02,
  WRITE_FINISH: 0x03,
  ACK: 0x04,
  SET_FILENAME: 0x07,
  QUERY_INFO: 0x09,
  DIR_CONTROL: 0x0b,
  OPEN_SESSION: 0x40,
  CLOSE_SESSION: 0x41,
} as const;

const FILE_TYPE_PROJECT = 0x03;
const BLOCK_SIZE = 8192;

// ── Pure encode primitives ───────────────────────────────────────────

/**
 * MSB-interleave 8-bit data into 7-bit MIDI-safe bytes: per 7 input bytes,
 * emit 1 header byte (bit j = MSB of input byte j) then the 7 low-7-bit bytes.
 */
export function msbInterleave(data: Uint8Array | readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 7) {
    let header = 0;
    const group: number[] = [];
    for (let j = 0; j < 7 && i + j < data.length; j++) {
      const b = data[i + j] & 0xff;
      if (b & 0x80) header |= 1 << j;
      group.push(b & 0x7f);
    }
    out.push(header, ...group);
  }
  return out;
}

/** Inverse of {@link msbInterleave}. */
export function msbDeinterleave(encoded: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < encoded.length;) {
    const header = encoded[i++];
    for (let j = 0; j < 7 && i < encoded.length; j++) {
      out.push((encoded[i++] & 0x7f) | (((header >> j) & 1) << 7));
    }
  }
  return out;
}

/** Sequential block number → 8-byte address: 16 offsets per page. */
export function blockAddress(block: number): number[] {
  return [0, 0, 0, 0, 0, 0, (block >> 4) & 0x7f, block & 0x0f];
}

/** 3-byte project file id for a slot 0..63. */
export function fileId(slot: number): number[] {
  return [FILE_TYPE_PROJECT, (slot >> 7) & 0x7f, slot & 0x7f];
}

/** Integer → `count` hex nibbles, most-significant first. */
export function intToNibbles(value: number, count: number): number[] {
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push((value >>> (4 * i)) & 0x0f);
  return out;
}

/** CRC-32 (zlib/IEEE, poly 0xEDB88320), the device's upload validity gate. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Wrap a subcommand + payload in the full F0..F7 SysEx envelope. */
export function makeMessage(subcmd: number, payload: readonly number[] = []): number[] {
  return [0xf0, ...HEADER, subcmd, ...payload, 0xf7];
}

// ── Upload frame plan (pure) ─────────────────────────────────────────

export interface UploadFrame {
  bytes: number[];
  /** When set, the sender must wait for an ACK (subcmd 0x04) carrying this addr+fid before proceeding. */
  ack?: { addr: number[]; fid: number[] };
  /** Human label for logging / the hardware harness. */
  label: string;
}

/** True if `msg` is an ACK frame matching `addr` + `fid`. For the send loop / harness. */
export function isAckFor(msg: readonly number[], addr: readonly number[], fid: readonly number[]): boolean {
  // F0 + HEADER(6) + ACK + addr(8) + fid(3) + F7
  if (msg.length < 1 + HEADER.length + 1 + 8 + 3) return false;
  for (let i = 0; i < HEADER.length; i++) if (msg[1 + i] !== HEADER[i]) return false;
  if (msg[1 + HEADER.length] !== SUBCMD.ACK) return false;
  const a = 1 + HEADER.length + 1;
  for (let i = 0; i < 8; i++) if (msg[a + i] !== addr[i]) return false;
  for (let i = 0; i < 3; i++) if (msg[a + 8 + i] !== fid[i]) return false;
  return true;
}

/**
 * Build the complete ordered frame plan to upload a 160,780-byte project to
 * `slot` (0..63). Pure: returns frames + ACK expectations; sends nothing.
 */
export function buildUploadFrames(ncs: Uint8Array, slot: number, filename?: string): UploadFrame[] {
  if (ncs.length !== NCS_FILE_SIZE) {
    throw new RangeError(`.ncs must be ${NCS_FILE_SIZE} bytes, got ${ncs.length}`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
    throw new RangeError(`slot must be 0..63, got ${slot}`);
  }
  const fid = fileId(slot);
  const name = filename ?? `${String(slot).padStart(2, '0')}_SESSION.ncs`;
  const numBlocks = Math.ceil(ncs.length / BLOCK_SIZE);
  const sizeNibbles = intToNibbles(ncs.length, 5);
  const frames: UploadFrame[] = [];

  frames.push({ label: 'open_session', bytes: makeMessage(SUBCMD.OPEN_SESSION), ack: { addr: blockAddress(0), fid } });
  // Directory handshake (replicates what Components sends; responses drained).
  frames.push({ label: 'dir_control_1', bytes: makeMessage(SUBCMD.DIR_CONTROL, [0x01]) });
  frames.push({ label: 'query_info', bytes: makeMessage(SUBCMD.QUERY_INFO, [0x01, 0x00]) });
  frames.push({ label: 'dir_control_2', bytes: makeMessage(SUBCMD.DIR_CONTROL, [0x02]) });
  frames.push({ label: 'dir_listing', bytes: makeMessage(SUBCMD.DIR_CONTROL, [0x03, 0x00]) });

  const initPayload = [...blockAddress(0), ...fid, 0x01, 0x00, 0x00, 0x00, ...sizeNibbles];
  frames.push({ label: 'write_init', bytes: makeMessage(SUBCMD.WRITE_INIT, initPayload), ack: { addr: blockAddress(0), fid } });

  for (let block = 1; block <= numBlocks; block++) {
    const chunk = ncs.subarray((block - 1) * BLOCK_SIZE, (block - 1) * BLOCK_SIZE + BLOCK_SIZE);
    const addr = blockAddress(block);
    frames.push({
      label: `write_data ${block}/${numBlocks}`,
      bytes: makeMessage(SUBCMD.WRITE_DATA, [...addr, ...fid, ...msbInterleave(chunk)]),
      ack: { addr, fid },
    });
  }

  const finishAddr = blockAddress(numBlocks + 1);
  const crc = crc32(ncs);
  frames.push({
    label: 'write_finish',
    bytes: makeMessage(SUBCMD.WRITE_FINISH, [...finishAddr, ...fid, ...intToNibbles(crc, 8)]),
    ack: { addr: finishAddr, fid },
  });
  frames.push({ label: 'set_filename', bytes: makeMessage(SUBCMD.SET_FILENAME, [...fid, ...[...name].map((c) => c.charCodeAt(0) & 0x7f)]) });
  frames.push({ label: 'close_session', bytes: makeMessage(SUBCMD.CLOSE_SESSION) });
  return frames;
}

export const TRANSFER_CONSTANTS = { BLOCK_SIZE, SUBCMD, HEADER, FILE_TYPE_PROJECT } as const;
