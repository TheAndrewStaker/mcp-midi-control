/**
 * Hydrasynth stored-content READ transactions (BK-110).
 *
 * Implements the two device→host transfer flows documented in
 * `docs/_private/devices/hydrasynth-explorer/references/SysexEncoding.txt`
 * (Sean Luke / edisyn, verbatim vendor copy):
 *
 *   - REQUESTING BANK PATCH NAMES (~lines 497-620): `02 00 BANK` → 19
 *     chunk dumps carrying `03 00 BANK` + 128 × (16-byte name + 0x00
 *     [+ 0x3A separator]) = 2306 bytes.
 *   - REQUESTING A SINGLE PATCH (~lines 142-251): `04 00 BANK PATCH` →
 *     22 chunk dumps concatenating to the same 2790-byte patch buffer
 *     `encodePatch` / `decodePatch` already speak.
 *
 * Both flows are ACK-DRIVEN, unlike the write path's timer pacing: the
 * device sends chunk N+1 only after our `17 00 N TYPE` acknowledgment,
 * so each step registers its receive predicate BEFORE sending the
 * message that elicits it (standard register-before-write pattern).
 *
 * Spec discrepancy, resolved toward the worked example: the prose for
 * the names flow says "17 chunks then chunk 17", but its own worked
 * example shows 19 chunks (0x00..0x12: 18 × 128 + 1 × 2 = 2306 bytes)
 * and a `0x13` type byte where the prose says `0x16` on the final
 * chunk. We therefore terminate on the first SHORT chunk (data < 128
 * bytes) instead of a hardcoded count, and acknowledge with whatever
 * TYPE byte each chunk actually carried.
 *
 * The header/footer pair is a soft mutex on the device (spec: without
 * the footer the front panel is sluggish for ~20 s), so the footer is
 * sent in a `finally` even when the transfer fails mid-chunk.
 *
 * Goldens: `scripts/hydrasynth/verify-patch-read.ts` (scripted fake
 * connection; spec worked-example bytes for the name parser).
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { wrapSysex, unwrapSysex } from './sysexEnvelope.js';
import { PATCH_BUFFER_SIZE } from './patchEncoder.js';

/** Names-flow payload: `03 00 BANK` + 127×(16+2) + (16+1) bytes. */
export const BANK_NAMES_PAYLOAD_SIZE = 3 + 127 * 18 + 17; // 2306

/** Patches per bank on every Hydrasynth model. */
export const BANK_PATCH_COUNT = 128;

/** Per-step receive timeout. The device answers each leg in tens of ms. */
const STEP_TIMEOUT_MS = 2000;

/** Hard cap on chunks per transfer — the largest legal flow is 22. */
const MAX_CHUNKS = 32;

export interface HydraReadResult {
  /** Concatenated chunk data (names payload or the 2790-byte patch buffer). */
  payload: Uint8Array;
  /** The verbatim inbound F0..F7 chunk-dump frames, in arrival order. */
  frames: number[][];
}

/** Unwrap an inbound frame; undefined when it is not a valid Hydrasynth envelope. */
function tryUnwrap(bytes: number[]): Uint8Array | undefined {
  if (bytes[0] !== 0xf0) return undefined;
  try {
    return unwrapSysex(bytes);
  } catch {
    return undefined;
  }
}

function requireInput(conn: MidiConnection, what: string): void {
  if (!conn.hasInput) {
    throw new Error(
      `Cannot ${what}: the Hydrasynth MIDI INPUT port is not open, and this is a device→host ` +
      'transfer (nothing can arrive). Check that the OS exposes a Hydrasynth input and that no ' +
      'other app holds it, then call reconnect_midi.',
    );
  }
}

/**
 * Wait for the next inbound message whose UNWRAPPED info satisfies
 * `pred`. Must be registered before the send that elicits the reply.
 */
function waitForInfo(
  conn: MidiConnection,
  pred: (info: Uint8Array) => boolean,
  label: string,
): Promise<{ info: Uint8Array; frame: number[] }> {
  return conn
    .receiveSysExMatching((bytes) => {
      const info = tryUnwrap(bytes);
      return info !== undefined && pred(info);
    }, STEP_TIMEOUT_MS)
    .then((frame) => ({ info: tryUnwrap(frame)!, frame }))
    .catch((err) => {
      throw new Error(`Hydrasynth read: timed out waiting for ${label} (${err instanceof Error ? err.message : String(err)})`);
    });
}

const isHeaderResponse = (i: Uint8Array) => i.length === 2 && i[0] === 0x19 && i[1] === 0x00;
const isFooterResponse = (i: Uint8Array) => i.length === 2 && i[0] === 0x1b && i[1] === 0x00;
const isChunkDump = (i: Uint8Array) => i.length >= 4 && i[0] === 0x16 && i[1] === 0x00;

/**
 * Run one read transaction: header handshake, `request`, ack-driven
 * chunk loop terminated by the first short chunk, footer handshake.
 * Returns the concatenated payload plus the verbatim chunk frames.
 */
async function runReadTransaction(
  conn: MidiConnection,
  request: readonly number[],
  what: string,
): Promise<HydraReadResult> {
  requireInput(conn, what);

  // Header (soft mutex seize). Register the response wait first.
  const headerWait = waitForInfo(conn, isHeaderResponse, 'Header Response (19 00)');
  conn.send(wrapSysex([0x18, 0x00]));
  await headerWait;

  const parts: Uint8Array[] = [];
  const frames: number[][] = [];
  try {
    let expectedIndex = 0;
    let chunkWait = waitForInfo(conn, isChunkDump, 'first chunk dump (16 00 ...)');
    conn.send(wrapSysex([...request]));

    for (;;) {
      const { info, frame } = await chunkWait;
      const index = info[2]!;
      const typeByte = info[3]!;
      const data = info.subarray(4);
      if (index !== expectedIndex) {
        throw new Error(
          `Hydrasynth read: chunk sequence broke while trying to ${what} — expected chunk ${expectedIndex}, ` +
          `device sent chunk ${index}. Aborting rather than assembling a corrupt buffer.`,
        );
      }
      parts.push(Uint8Array.from(data));
      frames.push(frame);
      expectedIndex++;

      const isFinal = data.length < 128;
      if (!isFinal && expectedIndex >= MAX_CHUNKS) {
        throw new Error(
          `Hydrasynth read: more than ${MAX_CHUNKS} full chunks while trying to ${what} — no short ` +
          'terminator chunk arrived. Aborting.',
        );
      }
      if (!isFinal) {
        // Register the wait for the NEXT chunk before acking this one —
        // the ack is what makes the device send it.
        chunkWait = waitForInfo(conn, isChunkDump, `chunk dump ${expectedIndex}`);
      }
      // Ack echoes the chunk's own TYPE byte (0x16 patch flow, 0x13 names flow).
      conn.send(wrapSysex([0x17, 0x00, index, typeByte]));
      if (isFinal) break;
    }
  } finally {
    // Footer (soft mutex release) — ALWAYS, or the device front panel
    // stalls ~20 s. Best-effort on the error path.
    try {
      const footerWait = waitForInfo(conn, isFooterResponse, 'Footer Response (1B 00)');
      conn.send(wrapSysex([0x1a, 0x00]));
      await footerWait.catch(() => { /* footer response missing is survivable */ });
    } catch { /* send failed — the handle is the caller's problem */ }
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const payload = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    payload.set(p, off);
    off += p.length;
  }
  return { payload, frames };
}

/**
 * Parse the names-flow payload `03 00 BANK [NAME(16) 00 3A]×127 NAME(16) 00`
 * into 128 display names (trailing NUL/space padding trimmed).
 *
 * The layout is FIXED-STRIDE — 18 bytes per entry (16-byte name field +
 * 0x00 terminator + 0x3A separator), 17 for the final entry — which the
 * spec's own worked example confirms byte-for-byte (2306 = 3 + 127×18 +
 * 17). We parse by stride and throw on any structural surprise (wrong
 * opcode, wrong bank, missing terminator/separator) rather than
 * resynchronizing: a silently desynced parse would bind names to the
 * wrong slots, which is worse than no answer.
 */
export function parseBankNames(payload: Uint8Array, expectedBank: number): string[] {
  if (payload.length < BANK_NAMES_PAYLOAD_SIZE) {
    throw new Error(
      `bank-names payload too short: ${payload.length} bytes (expected ${BANK_NAMES_PAYLOAD_SIZE})`,
    );
  }
  if (payload[0] !== 0x03 || payload[1] !== 0x00) {
    throw new Error(
      `bank-names payload has wrong opcode: expected 03 00, got ` +
      `${payload[0]!.toString(16).padStart(2, '0')} ${payload[1]!.toString(16).padStart(2, '0')}`,
    );
  }
  if (payload[2] !== expectedBank) {
    throw new Error(`bank-names payload is for bank ${payload[2]}, expected bank ${expectedBank}`);
  }
  const names: string[] = [];
  for (let i = 0; i < BANK_PATCH_COUNT; i++) {
    const off = 3 + i * 18;
    let name = '';
    for (let j = 0; j < 16; j++) {
      const c = payload[off + j]!;
      name += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '\0';
    }
    // The 16-byte field pads short names with a NUL then spaces/NULs.
    names.push(name.replace(/[\0 ]+$/, '').replace(/\0/g, ' '));
    if (payload[off + 16] !== 0x00) {
      throw new Error(
        `bank-names payload desync at entry ${i + 1}/128: expected 0x00 terminator at offset ${off + 16}, ` +
        `got 0x${payload[off + 16]!.toString(16).padStart(2, '0')}`,
      );
    }
    if (i < BANK_PATCH_COUNT - 1 && payload[off + 17] !== 0x3a) {
      throw new Error(
        `bank-names payload desync at entry ${i + 1}/128: expected 0x3A separator at offset ${off + 17}, ` +
        `got 0x${payload[off + 17]!.toString(16).padStart(2, '0')}`,
      );
    }
  }
  return names;
}

/**
 * Read all 128 stored patch names of one bank (0-based: A=0..H=7).
 * ~19 ack-driven round trips, well under a second on a healthy handle.
 */
export async function readBankNames(conn: MidiConnection, bank: number): Promise<string[]> {
  if (!Number.isInteger(bank) || bank < 0 || bank > 7) {
    throw new Error(`bank must be 0..7 (A..H), got ${bank}`);
  }
  const { payload } = await runReadTransaction(
    conn,
    [0x02, 0x00, bank],
    `read bank ${String.fromCharCode(65 + bank)} patch names`,
  );
  return parseBankNames(payload, bank);
}

/**
 * Read one STORED patch (flash copy — the device has no working-buffer
 * read, per the spec's "WHAT CAN BE DONE"). Returns the 2790-byte patch
 * buffer (`decodePatch`-ready) plus the verbatim chunk frames for
 * byte-exact backup. 22 ack-driven round trips.
 */
export async function readStoredPatch(
  conn: MidiConnection,
  bank: number,
  patch: number,
): Promise<HydraReadResult> {
  if (!Number.isInteger(bank) || bank < 0 || bank > 7) {
    throw new Error(`bank must be 0..7 (A..H), got ${bank}`);
  }
  if (!Number.isInteger(patch) || patch < 0 || patch > 127) {
    throw new Error(`patch must be 0..127 (wire index), got ${patch}`);
  }
  const display = `${String.fromCharCode(65 + bank)}${(patch + 1).toString().padStart(3, '0')}`;
  const result = await runReadTransaction(
    conn,
    [0x04, 0x00, bank, patch],
    `read stored patch ${display}`,
  );
  if (result.payload.length !== PATCH_BUFFER_SIZE) {
    throw new Error(
      `Hydrasynth read: stored patch ${display} assembled to ${result.payload.length} bytes, ` +
      `expected ${PATCH_BUFFER_SIZE}. Not decoding a wrong-sized buffer.`,
    );
  }
  return result;
}
