/**
 * Hydrasynth byte-exact stored-patch WRITE transactions (BK-113).
 *
 * The write-side counterpart of `patchRead.ts`: push EXACT 2790-byte
 * patch buffers (from device reads or `.syx` backups) to stored slots,
 * per `SysexEncoding.txt` "WRITING A SERIES OF PATCHES":
 *
 *   header 18 00 → [ per patch: 22 chunk dumps, each ACKED by the
 *   device (17 00 N 16); after the final chunk the device ALSO emits
 *   the Patch Saved counter (07 00 BANK PATCH); then ~100 ms pause ]
 *   → ONE Write Request 14 00 for the whole batch → 15 00 receipt
 *   (the flash commit; the device is busy for seconds) → footer 1A 00.
 *
 * Differences from apply_patch's write path (deliberate):
 *   - ACK-DRIVEN pacing, not timers: each chunk waits for the device's
 *     ack before the next is sent, so a 128-patch bank cannot outrun
 *     the device and a dead handle fails on chunk 1, loudly.
 *   - Byte-exact: the buffer is the payload; only the chunk-0 header
 *     bytes that ADDRESS the write are rewritten (byte 0 save-marker
 *     0x06, bytes 2/3 bank/patch — matching both the spec's write
 *     example `06 00 04 7F ...` and the hardware-confirmed apply_patch
 *     behavior, which touches nothing else).
 *   - ONE flash commit per batch: per NOTE 0 the device keeps a whole
 *     bank's working copy in RAM, so a batch MUST NOT span banks —
 *     `writeStoredPatches` refuses mixed-bank batches rather than
 *     letting a later bank's commit silently persist an earlier bank's
 *     leftovers.
 *
 * Community-beta status: the flow is decoded byte-exactly from the
 * spec (whose single-patch variant is hardware-confirmed via
 * apply_patch, including the 15 00 receipt); the multi-patch series
 * shape awaits its first on-device run. Goldens:
 * `scripts/hydrasynth/verify-patch-write.ts`.
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { wrapSysex, unwrapSysex } from './sysexEnvelope.js';
import { splitIntoChunks, PATCH_BUFFER_SIZE, PATCH_CHUNK_COUNT } from './patchEncoder.js';

/** Per-step receive timeout for chunk acks. */
const ACK_TIMEOUT_MS = 2000;

/**
 * Flash-commit receipt timeout. The spec warns the device spends "3
 * seconds or more" writing; a whole-bank commit is the worst case, so
 * wait generously before declaring the receipt missing.
 */
const WRITE_RECEIPT_TIMEOUT_MS = 20000;

/** Spec: pause between patches in a series write. */
const INTER_PATCH_PAUSE_MS = 100;

export interface StoredPatchWrite {
  /** 0-based bank (A=0..H=7). */
  bank: number;
  /** 0-based patch within the bank (0..127). */
  patch: number;
  /** The full 2790-byte patch buffer (header bytes are rewritten). */
  buffer: Uint8Array;
}

export interface SeriesWriteOptions {
  /**
   * Settle pause AFTER the flash commit (receipt or its timeout) before
   * the footer / any further traffic. The spec mandates >= 3500 ms after
   * a write operation "before sending the Hydrasynth anything else"
   * (SysexEncoding.txt series-write NOTE); the hardware-confirmed
   * apply_patch path honors the same figure. Override below 3500 only
   * in offline goldens against a fake device.
   */
  flashSettleMs?: number;
}

export interface SeriesWriteResult {
  /** Patches whose full 22-chunk dump was acked by the device. */
  patches_acked: number;
  /** Patch Saved (07 00) counters observed (fires per patch, RAM-level). */
  patch_saved_seen: number;
  /** True when the 15 00 Write Request Response (flash receipt) arrived. */
  flash_receipt: boolean;
  /** Wall-clock of the whole transaction. */
  elapsed_ms: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tryUnwrap(bytes: number[]): Uint8Array | undefined {
  if (bytes[0] !== 0xf0) return undefined;
  try {
    return unwrapSysex(bytes);
  } catch {
    return undefined;
  }
}

function waitForInfo(
  conn: MidiConnection,
  pred: (info: Uint8Array) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Uint8Array> {
  return conn
    .receiveSysExMatching((bytes) => {
      const info = tryUnwrap(bytes);
      return info !== undefined && pred(info);
    }, timeoutMs)
    .then((frame) => tryUnwrap(frame)!)
    .catch((err) => {
      throw new Error(
        `Hydrasynth write: timed out waiting for ${label} (${err instanceof Error ? err.message : String(err)})`,
      );
    });
}

const isHeaderResponse = (i: Uint8Array) => i.length === 2 && i[0] === 0x19 && i[1] === 0x00;
const isFooterResponse = (i: Uint8Array) => i.length === 2 && i[0] === 0x1b && i[1] === 0x00;
const isWriteReceipt = (i: Uint8Array) => i.length === 2 && i[0] === 0x15 && i[1] === 0x00;
const isChunkAck = (n: number) => (i: Uint8Array) =>
  i.length === 4 && i[0] === 0x17 && i[1] === 0x00 && i[2] === n && i[3] === 0x16;
const isPatchSaved = (bank: number, patch: number) => (i: Uint8Array) =>
  i.length === 4 && i[0] === 0x07 && i[1] === 0x00 && i[2] === bank && i[3] === patch;

/**
 * Clone `buffer` with the chunk-0 addressing header rewritten for a
 * stored write to (bank, patch): byte 0 = 0x06 (write marker), bytes
 * 2/3 = bank/patch. Nothing else is touched — a read buffer (byte 0 =
 * 0x05, its source slot in bytes 2/3) becomes a byte-exact write to
 * the NEW slot.
 */
export function addressPatchBuffer(buffer: Uint8Array, bank: number, patch: number): Uint8Array {
  if (buffer.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buffer.length}`);
  }
  if (!Number.isInteger(bank) || bank < 0 || bank > 7) throw new Error(`bank must be 0..7, got ${bank}`);
  if (!Number.isInteger(patch) || patch < 0 || patch > 127) throw new Error(`patch must be 0..127, got ${patch}`);
  const out = new Uint8Array(buffer);
  out[0] = 0x06;
  out[2] = bank;
  out[3] = patch;
  return out;
}

/**
 * Parse a Hydrasynth `.syx` backup (the verbatim chunk-dump frames
 * `dumpStoredPresetBinary` wrote, concatenated F0..F7 messages) back
 * into the 2790-byte patch buffer. Inverse of the export path.
 */
export function framesToPatchBuffer(fileBytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i < fileBytes.length; i++) {
    if (fileBytes[i] === 0xf0) start = i;
    else if (fileBytes[i] === 0xf7 && start >= 0) {
      const frame = Array.from(fileBytes.subarray(start, i + 1));
      start = -1;
      const info = tryUnwrap(frame);
      if (info === undefined) {
        throw new Error(`backup frame ${chunks.length} failed envelope/CRC validation`);
      }
      if (!(info.length >= 4 && info[0] === 0x16 && info[1] === 0x00)) {
        throw new Error(`backup frame ${chunks.length} is not a chunk dump (info starts 0x${info[0]?.toString(16)})`);
      }
      if (info[2] !== chunks.length) {
        throw new Error(`backup frame out of order: expected chunk ${chunks.length}, got ${info[2]}`);
      }
      chunks.push(Uint8Array.from(info.subarray(4)));
    }
  }
  if (chunks.length !== PATCH_CHUNK_COUNT) {
    throw new Error(`backup holds ${chunks.length} chunk frames, expected ${PATCH_CHUNK_COUNT}`);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total !== PATCH_BUFFER_SIZE) {
    throw new Error(`backup chunks total ${total} bytes, expected ${PATCH_BUFFER_SIZE}`);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Write a batch of byte-exact patches to stored slots in ONE header/
 * commit/footer transaction (the spec's series flow). All entries MUST
 * target the same bank (NOTE-0 whole-bank-RAM: one commit per bank is
 * the only shape whose blast radius equals its intent). Ack-driven
 * throughout; throws on the first missing ack. The footer is sent even
 * on the error path (soft-mutex release).
 *
 * `flash_receipt: false` in the result means the 15 00 receipt never
 * arrived — Protect ON is the usual suspect; the caller MUST verify by
 * re-reading before treating the write as persisted.
 */
export async function writeStoredPatches(
  conn: MidiConnection,
  entries: readonly StoredPatchWrite[],
  options: SeriesWriteOptions = {},
): Promise<SeriesWriteResult> {
  if (entries.length === 0) throw new Error('writeStoredPatches: empty batch');
  if (!conn.hasInput) {
    throw new Error(
      'Cannot write stored patches: the Hydrasynth MIDI INPUT port is not open, and this flow is ' +
      'ack-driven (every chunk waits for the device\'s acknowledgment). Check the input port, then retry.',
    );
  }
  const bank = entries[0]!.bank;
  for (const e of entries) {
    if (e.bank !== bank) {
      throw new Error(
        `writeStoredPatches: mixed-bank batch (bank ${bank} and ${e.bank}). One commit per bank — ` +
        'split the batch so each bank\'s flash commit covers exactly that bank\'s writes (NOTE-0 blast radius).',
      );
    }
  }

  const startMs = Date.now();
  let patchesAcked = 0;
  let patchSavedSeen = 0;
  let flashReceipt = false;

  const headerWait = waitForInfo(conn, isHeaderResponse, ACK_TIMEOUT_MS, 'Header Response (19 00)');
  conn.send(wrapSysex([0x18, 0x00]));
  await headerWait;

  try {
    for (let p = 0; p < entries.length; p++) {
      const entry = entries[p]!;
      const buf = addressPatchBuffer(entry.buffer, entry.bank, entry.patch);
      const chunks = splitIntoChunks(buf);
      for (let i = 0; i < chunks.length; i++) {
        const isFinal = i === chunks.length - 1;
        const ackWait = waitForInfo(conn, isChunkAck(i), ACK_TIMEOUT_MS, `chunk ${i} ack (patch ${p + 1}/${entries.length})`);
        // The Patch Saved counter arrives BEFORE the final chunk's ack
        // per the spec — register its wait alongside, tolerate absence
        // (it is a RAM-level counter, not the flash receipt).
        const savedWait = isFinal
          ? waitForInfo(conn, isPatchSaved(entry.bank, entry.patch), ACK_TIMEOUT_MS, 'Patch Saved (07 00)')
              .then(() => { patchSavedSeen++; })
              .catch(() => { /* tolerated: counter, not receipt */ })
          : undefined;
        conn.send(wrapSysex(chunks[i]!.info));
        await ackWait;
        if (savedWait) await savedWait;
      }
      patchesAcked++;
      // Spec step 3c sits INSIDE the per-patch repeat, so the pause also
      // separates the LAST patch from the Write Request (review A4).
      await sleep(INTER_PATCH_PAUSE_MS);
    }

    // ONE flash commit for the whole batch.
    const receiptWait = waitForInfo(conn, isWriteReceipt, WRITE_RECEIPT_TIMEOUT_MS, 'Write Request Response (15 00)');
    conn.send(wrapSysex([0x14, 0x00]));
    try {
      await receiptWait;
      flashReceipt = true;
    } catch {
      flashReceipt = false; // caller verifies by re-read; Protect ON suspected
    }
    // Spec-mandated settle after the write operation, receipt or not
    // (on a receipt timeout the flash may STILL be completing) — before
    // the footer or any caller traffic (review F2).
    await sleep(options.flashSettleMs ?? 3500);
  } finally {
    try {
      const footerWait = waitForInfo(conn, isFooterResponse, ACK_TIMEOUT_MS, 'Footer Response (1B 00)');
      conn.send(wrapSysex([0x1a, 0x00]));
      await footerWait.catch(() => { /* survivable */ });
    } catch { /* send failed; handle is the caller's problem */ }
  }

  return {
    patches_acked: patchesAcked,
    patch_saved_seen: patchSavedSeen,
    flash_receipt: flashReceipt,
    elapsed_ms: Date.now() - startMs,
  };
}
