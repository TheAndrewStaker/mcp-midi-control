/**
 * Circuit Tracks SAMPLE upload — pure frame plan.
 *
 * Decoded from a real Novation Components capture (docs/design/circuit-sample-
 * upload.md). The per-sample WRITE frames (WRITE_INIT/DATA/FINISH/SET_FILENAME,
 * fileId type 0x05, 8192-byte blocks, msb-interleave, CRC32) are byte-identical
 * to the capture (verified — scripts/verify-circuit-ncs-transfer.ts).
 *
 * STATUS 2026-06-23: STILL BROKEN — root cause OPEN. The frames here are
 * byte-identical to the working Components "Send samples" captures, yet our upload
 * acks every frame but the slot reads back EMPTY (0/64), single sample and kit
 * alike, on a clean device. A timed both-direction capture decode found a post-
 * CLOSE group-0x08 notification ~6-8s after CLOSE and we built a commit-wait for
 * it — but HARDWARE-REFUTED: the wait engages and receives that frame, yet the
 * slot is still empty. The 0x08 frame is a generic "ready" status (sent pre-write
 * too), not a commit gate. The opt-in `awaitCommitMs` + ingest fix in
 * uploadProject.ts remain (correct + golden-tested) but are NOT engaged by
 * default. The session PRELUDE (dir-listing 0x05 + 64x 0x0d scan) is a pre-write
 * directory READ, not the commit gate. NEXT: a fresh Components capture of a
 * SINGLE sample to an EMPTY pack (our exact failing scenario) to diff the wire.
 * Full investigation: docs/design/circuit-sample-upload.md.
 */

import {
  blockAddress, crc32, intToNibbles, makeMessage, msbInterleave, TRANSFER_CONSTANTS,
  type UploadFrame,
} from '../ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const { BLOCK_SIZE } = TRANSFER_CONSTANTS;

/**
 * Two per-slot sub-commands Components issues before writing samples.
 *
 * `0x0d` is QUERY_EXISTS: read-only, returns the stored file's CRC32 when the
 * slot is occupied and an empty-slot record when it is free.
 *
 * `0x08` is NOT the "per-slot name/info" read it was recorded as here until
 * 2026-07-29. It is DELETE. Re-mined from the captures already on disk: across
 * seven of them the `0x08` set is a subset of the slots the `0x0d` scan calls
 * OCCUPIED, and in two of them most of those slots are cleared and never
 * rewritten (62 in `send-pack-…-sleep-token-and-roland-samples-06-27-2026`,
 * 11 in `send-to-circuit-tracks-sleep-token-samples`). A frame that removes a
 * file and is followed by no write is not an info read. Full decode, evidence
 * and the safety contract: `../ncs/fileDelete.ts`.
 *
 * That also explains the 2026-06-27 incident, which was written up for months
 * as "committed an empty directory": the disabled code looped `0x0d` + `0x08`
 * over all 64 sample slots, so it deleted the pool one frame at a time and the
 * device acknowledged every one.
 *
 * The single `0x08` this file still emits below is Components-faithful and
 * benign: it targets the slot the very next frames overwrite anyway, which is
 * delete-then-write, the order every capture shows. Do NOT generalise it to a
 * loop over the pool.
 */
const SUB_DIR_ENUM = 0x0d;
const SUB_DIR_INFO = 0x08;

/** The sample file-type byte (projects use 0x03). Confirmed from capture. */
export const FILE_TYPE_SAMPLE = 0x05;

/**
 * 3-byte sample file id: `[0x05, pack, slot]`, the same shape every file-transfer
 * subcommand uses (`ncs/transfer.ts` `fileId`). `pack` is the 0-based microSD pack
 * (device "Pack 1" = 0) and is a field the CALLER CHOOSES, not something the
 * device reports. Full decode + evidence: `docs/design/circuit-pack-addressing.md`.
 *
 * Every sample dir/file frame must carry the right pack, or SET_FILENAME is
 * REJECTED and the slot never registers (the long "0/64" bug). We previously built
 * `[0x05, slot>>7, slot]`, which is `[0x05, 0, slot]` for slots 0..63 — pack 0 by
 * accident, which is why uploads only worked on the first pack.
 *
 * CORRECTED 2026-07-16: the earlier note here claimed this byte was an "active pack
 * index" that "the device reports in its `0b 02` DIR_CONTROL reply". That model is
 * refuted — the `0b 02` byte is the pack COUNT, and no wire command reports which
 * pack the front panel has selected. The byte is chosen, not discovered.
 *
 * NOTE: no sample caller passes `packIndex` yet, so the sample path is still pinned
 * to Pack 1 while projects + patches are pack-aware. See the design doc §6.
 */
export function sampleFileId(slot: number, packIndex = 0): number[] {
  return [FILE_TYPE_SAMPLE, packIndex & 0x7f, slot & 0x7f];
}

/** Number of 8192-byte WRITE_DATA blocks a WAV of `byteLength` needs. */
export function sampleBlockCount(byteLength: number): number {
  return Math.ceil(byteLength / BLOCK_SIZE);
}

/** One sample to write: device-format WAV bytes + destination slot + name. */
export interface KitSampleItem {
  /** WAV bytes, device format (48 kHz mono 16-bit — normalize BEFORE calling). */
  wav: Uint8Array;
  /** Destination sample slot, 0..63. */
  slot: number;
  /** Name the device/Components shows (ASCII). */
  filename?: string;
}

/** WRITE_INIT/DATA/FINISH/SET_FILENAME for ONE sample (no session OPEN/CLOSE). */
function sampleWriteFrames(wav: Uint8Array, slot: number, filename?: string, packIndex = 0): UploadFrame[] {
  const fid = sampleFileId(slot, packIndex);
  const name = filename ?? `${String(slot).padStart(2, '0')}_sample.wav`;
  const numBlocks = sampleBlockCount(wav.length);
  const sizeNibbles = intToNibbles(wav.length, 5);
  const frames: UploadFrame[] = [];

  const initPayload = [...blockAddress(0), ...fid, 0x01, 0x00, 0x00, 0x00, ...sizeNibbles];
  frames.push({ label: `write_init s${slot}`, bytes: makeMessage(SUB.WRITE_INIT, initPayload), ack: { addr: blockAddress(0), fid } });
  for (let block = 1; block <= numBlocks; block++) {
    const chunk = wav.subarray((block - 1) * BLOCK_SIZE, (block - 1) * BLOCK_SIZE + BLOCK_SIZE);
    const addr = blockAddress(block);
    frames.push({
      label: `write_data s${slot} ${block}/${numBlocks}`,
      bytes: makeMessage(SUB.WRITE_DATA, [...addr, ...fid, ...msbInterleave(chunk)]),
      ack: { addr, fid },
    });
  }
  const finishAddr = blockAddress(numBlocks + 1);
  frames.push({
    label: `write_finish s${slot}`,
    bytes: makeMessage(SUB.WRITE_FINISH, [...finishAddr, ...fid, ...intToNibbles(crc32(wav), 8)]),
    ack: { addr: finishAddr, fid },
  });
  // SET_FILENAME registers the slot in the sample directory — and the device's
  // reply is the load-bearing success signal we ignored for months. On an
  // INITIALIZED directory it ACKs (0x04); on an UNINITIALIZED/empty directory it
  // REJECTS with the empty-slot record (0x05 00…), while the bulk data acks
  // regardless and the slot never plays ("acked-but-silent"). Expecting the ACK
  // here turns that silent failure loud: isAck matches 0x04 only, so the 0x05
  // rejection times out → ok:false. Hardware-decoded 2026-06-27 (pack-send capture
  // vs _our-single-timeline). See docs/design/circuit-sample-upload.md.
  frames.push({ label: `set_filename s${slot}`, bytes: makeMessage(SUB.SET_FILENAME, [...fid, ...[...name].map((c) => c.charCodeAt(0) & 0x7f)]), ack: { addr: blockAddress(0), fid } });
  return frames;
}

/**
 * Build ONE file-transfer session that writes every sample in the SAMPLE-
 * directory context (matches Novation Components). This is the persistence-
 * correct path: a single OPEN..CLOSE, dir-listing file-type 0x05 (not the
 * project's 0x03), so the device commits the writes to the pack sample manifest.
 *
 * @param items     samples to write (device-format WAV + slot + name)
 * @param opts.enumerate replay Components' 0x0d×64 directory read before writing
 *                       (browser refresh; not normally required — adds latency)
 */
export function buildKitUploadFrames(items: readonly KitSampleItem[], opts: { enumerate?: boolean; dirType?: number; packIndex?: number } = {}): UploadFrame[] {
  if (items.length === 0) throw new RangeError('no samples to upload');
  for (const it of items) {
    if (!Number.isInteger(it.slot) || it.slot < 0 || it.slot > 63) throw new RangeError(`sample slot must be 0..63, got ${it.slot}`);
    if (it.wav.length < 45) throw new RangeError(`WAV too small (${it.wav.length} bytes) to be a real sample`);
  }
  // The ACTIVE pack index (decoded from the device's 0b 02 reply). Every sample
  // dir/file frame carries it; a wrong index → SET_FILENAME rejected. Default 0
  // preserves the legacy (pack-0-only) behavior for callers that don't read it.
  const pack = opts.packIndex ?? 0;
  const frames: UploadFrame[] = [];
  frames.push({ label: 'open_session', bytes: makeMessage(SUB.OPEN_SESSION), ack: { addr: blockAddress(0), fid: sampleFileId(0, pack) } });
  frames.push({ label: 'dir_control_1', bytes: makeMessage(SUB.DIR_CONTROL, [0x01]) });
  frames.push({ label: 'query_info', bytes: makeMessage(SUB.QUERY_INFO, [0x01, 0x00]) });
  // QUERY_INFO subtype 0x01 — the load-bearing prelude difference (controlled
  // single-sample capture diff, 2026-06-24): the CURRENT Components single-sample
  // upload sends 09 01 00 AND 09 01 01 in its write session; our upload (and the
  // OLDER multi-sample captures) sent only 09 01 00 and the slot never committed.
  // The 09 01 01 reply (00 01 0f 03 0b 0f) differs from 09 01 00 (00 00 00 00 05 0b),
  // i.e. it queries a different field — likely a "prepare/lock pack for write" step.
  frames.push({ label: 'query_info_1', bytes: makeMessage(SUB.QUERY_INFO, [0x01, 0x01]) });
  frames.push({ label: 'dir_control_2', bytes: makeMessage(SUB.DIR_CONTROL, [0x02]) });
  // Directory listing + full sample-directory scan, byte-for-byte as Novation
  // Components does it (both working captures, _cap1/_cap2_control.txt idx 4-69):
  // the dir-listing is file-type 0x05 (SAMPLE dir) and is ALWAYS followed by a
  // 64x 0x0d per-slot occupancy read of THAT directory. The 0x05 listing and the
  // 0x0d scan are ONE indivisible "scan the sample directory" step — 0x05 WITHOUT
  // the 0x0d scan is what made the device ack-but-store-nothing on the 2026-06-22
  // attempt; this scan is what commits writes to the pack sample manifest (so the
  // sample survives a pack reload / device restart). cap2 then issues exactly ONE
  // targeted 0x08 for the slot it is about to write, which is a DELETE of that
  // slot (see SUB_DIR_INFO above, corrected 2026-07-29) and therefore
  // delete-then-write; we match that, for that one slot only. dirType/enumerate
  // stay overridable for RE A/B only (the persistence-correct values are the
  // defaults).
  const dirType = opts.dirType ?? FILE_TYPE_SAMPLE; // 0x05
  const enumerate = opts.enumerate ?? true;
  frames.push({ label: 'dir_listing', bytes: makeMessage(SUB.DIR_CONTROL, [dirType, pack]) });
  if (enumerate) {
    for (let slot = 0; slot < 64; slot++) {
      frames.push({ label: `enum0d ${slot}`, bytes: makeMessage(SUB_DIR_ENUM, [dirType, pack, slot]) });
    }
    // DELETE of the first item's slot, immediately before that slot is written.
    // Deliberately singular and target-scoped: this is the one frame in the
    // sample path that removes a file.
    frames.push({ label: 'delete08', bytes: makeMessage(SUB_DIR_INFO, [dirType, pack, items[0].slot]) });
  }
  for (const it of items) frames.push(...sampleWriteFrames(it.wav, it.slot, it.filename, pack));
  frames.push({ label: 'close_session', bytes: makeMessage(SUB.CLOSE_SESSION) });
  return frames;
}

/**
 * Build the frame plan to upload ONE device-format WAV to `slot` (0..63) — a
 * single-item kit session. Pure: returns frames + ACK expectations.
 */
export function buildSampleUploadFrames(wav: Uint8Array, slot: number, filename?: string, opts: { enumerate?: boolean; dirType?: number; packIndex?: number } = {}): UploadFrame[] {
  return buildKitUploadFrames([{ wav, slot, filename }], opts);
}
