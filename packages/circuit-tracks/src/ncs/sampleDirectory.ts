/**
 * Circuit Tracks SAMPLE DIRECTORY read — the pack's 64-slot sample pool names.
 *
 * READ-ONLY. Decoded from a real Novation Components capture (docs/design/
 * circuit-sample-upload.md): Components enumerates the pool with a per-slot
 * occupancy query `…03 0d 05 00 <slot>`, then asks each slot for its info with
 * `…03 08 05 00 <slot>`; the device replies `…03 0c 05 00 <slot> <ASCII name> F7`.
 * We replay the same open + directory handshake, run the enumeration pass, then
 * read every slot's name. Sends NO write of any kind.
 *
 * This is the read half of the semantic-mapping workflow: knowing each pool
 * slot's NAME ("kick", "snare", "closed hat") lets the groove packer target the
 * right slot by meaning instead of a hardcoded layout. (It reads the shared
 * 64-slot pool; which pool sample a given drum TRACK points to inside a project
 * is a separate, still-undecoded binding.)
 *
 * Impure (drives the bidirectional MIDI connection) but self-contained: always
 * closes the file-transfer session, even on error, so the device is never left
 * on its transfer screen.
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

import { makeMessage, TRANSFER_CONSTANTS } from './transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FILE_TYPE_SAMPLE = 0x05;
const QUERY_CRC = 0x0d; // host → device: per-slot occupancy/CRC (enumeration pass)
const QUERY_NAME = 0x08; // host → device: per-slot info request
const REPLY_NAME = 0x0c; // device → host: fileId + ASCII name
const SLOT_COUNT = 64;
const REPLY_TIMEOUT_MS = 250;
const PRELUDE_TIMEOUT_MS = 400;

/** One sample-pool slot: 0-based wire slot, device-facing 1-based number, and name (undefined = empty). */
export interface SampleSlot {
  slot: number;        // 0..63 (wire)
  device_slot: number; // 1..64 (what the device/Components shows)
  name?: string;       // ASCII name, or undefined if the slot is empty
}

export interface SampleDirectoryResult {
  occupied: number;
  total: number;
  slots: SampleSlot[];
}

const ascii = (a: readonly number[]): string =>
  a.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('').trimEnd();

/**
 * Read the 64-slot sample-pool directory over the file-transfer transport.
 * Requires a bidirectional connection (the caller gates `conn.hasInput`).
 */
export async function readSampleDirectory(_conn: MidiConnection): Promise<SampleDirectoryResult> {
  // ⛔ DISABLED 2026-06-27 — DESTRUCTIVE. On hardware this "read" WIPED the entire
  // sample pool: it returned occupied:0 and every sample went silent. Root cause:
  // the prelude below replays the sample-WRITE session envelope (OPEN_SESSION 0x40
  // … 0x05 dir-listing … CLOSE_SESSION), which is a directory TRANSACTION — opening
  // it and closing it without writing any samples commits an EMPTY directory. A
  // read must NOT open the write transaction. The correct, non-destructive read is
  // whatever Components' "copy device to a pack" does (capture:
  // samples/captured/get_pack_from_circuit_tracks.pcapng); re-decode from that
  // before re-enabling. The body is kept (unreachable) as the decode-in-progress
  // reference. DO NOT remove this guard until the read is re-derived + hardware-safe.
  throw new Error(
    'read_sample_directory is DISABLED: the current implementation is destructive ' +
    '(it wiped the sample pool on hardware 2026-06-27 by committing an empty directory ' +
    'transaction). It must be re-decoded from a Components get-pack capture before use.',
  );
  // eslint-disable-next-line no-unreachable
  const conn = _conn;
  try {
    // Replay the captured open + directory handshake (drain each reply).
    const prelude: number[][] = [
      makeMessage(SUB.OPEN_SESSION),
      makeMessage(SUB.DIR_CONTROL, [0x01]),
      makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
      makeMessage(SUB.DIR_CONTROL, [0x02]),
      makeMessage(SUB.DIR_CONTROL, [FILE_TYPE_SAMPLE, 0x00]),
    ];
    for (const msg of prelude) {
      const replyP = conn.receiveSysEx(PRELUDE_TIMEOUT_MS).catch(() => [] as number[]);
      conn.send(msg);
      await replyP;
    }

    // Enumeration pass: 0x0d per slot. The device appears to need this before it
    // will answer 0x08 name queries (it is what Components does first).
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const replyP = conn
        .receiveSysExMatching((m) => m[7] === QUERY_CRC && m[8] === FILE_TYPE_SAMPLE && m[10] === slot, REPLY_TIMEOUT_MS)
        .catch(() => [] as number[]);
      conn.send(makeMessage(QUERY_CRC, [FILE_TYPE_SAMPLE, 0x00, slot]));
      await replyP;
    }

    // Name pass: 0x08 per slot → 0x0c reply with the ASCII name from byte 11.
    const slots: SampleSlot[] = [];
    let occupied = 0;
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      // Register the matcher BEFORE send (sync-throw-safe ordering).
      const replyP = conn
        .receiveSysExMatching((m) => m[7] === REPLY_NAME && m[8] === FILE_TYPE_SAMPLE && m[10] === slot, REPLY_TIMEOUT_MS)
        .catch(() => [] as number[]);
      conn.send(makeMessage(QUERY_NAME, [FILE_TYPE_SAMPLE, 0x00, slot]));
      const reply = await replyP;
      const name = reply.length ? ascii(reply.slice(11, reply.length - 1)) : '';
      if (name) occupied++;
      slots.push({ slot, device_slot: slot + 1, name: name || undefined });
    }

    return { occupied, total: SLOT_COUNT, slots };
  } finally {
    // ALWAYS end the session so the device leaves its transfer screen.
    try {
      conn.send(makeMessage(SUB.CLOSE_SESSION));
    } catch {
      /* handle already dead — nothing to clean up */
    }
  }
}
