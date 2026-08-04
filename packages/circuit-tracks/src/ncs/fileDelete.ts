/**
 * Circuit Tracks stored-file DELETE, and the occupancy oracle that gates it.
 *
 * The Circuit has no undo, no trash, and no erase on the front panel. This
 * module is the only code in the project that can make a stored project stop
 * existing, so read the safety contract before changing a byte of it.
 *
 * ## The two opcodes
 *
 *   QUERY_EXISTS  `F0 00 20 29 01 64 03 0d <fileType> <pack> <slot> F7`   (12 B)
 *   DELETE_FILE   `F0 00 20 29 01 64 03 08 <fileType> <pack> <slot> F7`   (12 B)
 *
 * Both carry the same 3-byte fileId every file-transfer subcommand uses
 * (`transfer.ts` `fileId`): fileType 0x03 project / 0x04 patch / 0x05 sample,
 * a 0-BASED pack, a 0-BASED slot.
 *
 * QUERY_EXISTS answers one of exactly two shapes:
 *
 *   OCCUPIED  `F0 …03 0d <fileType> <pack> <slot> <8 CRC nibbles> F7`      (20 B)
 *   FREE      `F0 …03 05 00 00 00 00 00 00 00 00 00 00 00 07 F7`          (21 B)
 *
 * The occupied answer echoes the fileId and appends the device's OWN CRC32 of
 * the stored file, MS-nibble first, the same nibble encoding WRITE_FINISH uses.
 * That makes it a genuine second opinion: it is computed from the file itself,
 * not read out of the directory table, so it can disagree with the directory
 * listing and catch a half-written slot.
 *
 * DELETE_FILE answers with the ordinary transfer ACK carrying block address 0
 * and the fileId back:
 *
 *   `F0 …03 04 00 00 00 00 00 00 00 00 <fileType> <pack> <slot> F7`        (20 B)
 *
 * ## Evidence (byte-exact, re-mined 2026-07-29 from captures already on disk)
 *
 * Seven Novation Components captures under `samples/captured/` were decoded in
 * CAPTURE ORDER (both directions interleaved) so each request could be paired
 * with its reply. Findings, all mechanical set comparisons rather than reading:
 *
 *  1. `send-pack-to-circuit-tracks-sleep-token-and-roland-samples-06-27-2026`
 *     is decisive. Components runs a per-slot `QUERY_EXISTS -> DELETE_FILE`
 *     loop and the 62 slots it deletes are a strict SUBSET of the 63 the
 *     QUERY_EXISTS scan reported occupied. It never deletes a slot the scan
 *     called free.
 *  2. In that same capture, 62 of the deleted slots are NEVER written
 *     afterwards: 46 project slots (fileType 0x03) and 16 patch slots (0x04)
 *     are cleared and left cleared. A delete with no following write cannot be
 *     a write prelude. That is what settles 0x08 as a DELETE rather than the
 *     "per-slot name/info read" it had been recorded as.
 *  3. `send-to-circuit-tracks-sleep-token-samples` shows the same shape from
 *     the other side: 62 sample slots deleted, 11 of them never rewritten. This
 *     is the wire trace of the 2026-06-27 incident in which a loop of these
 *     frames emptied a pack's sample pool and was written up for months as
 *     "committed an empty directory". It did not commit an empty directory. It
 *     deleted 64 files, one frame at a time, and the device ACKed every one.
 *  4. Every DELETE_FILE in every capture precedes its slot's WRITE_INIT when a
 *     write follows at all, so delete-then-write is the order Components uses.
 *  5. The paired reply shapes above hold across all seven captures without
 *     exception.
 *
 * ## Why the parser refuses rather than guesses
 *
 * `parseExistsReply` returns `undefined` for anything that is not EXACTLY one of
 * the two known shapes, echoing the fileId we asked about. It never treats
 * silence, a short frame, or a reply about another slot as "free". A free
 * verdict authorises nothing here (the caller refuses on free), but an
 * ambiguous frame read as OCCUPIED would authorise a delete, and the whole
 * point of this oracle is that it is the last thing standing between an agent
 * and an unrecoverable erase. Unknown is a refusal, always.
 *
 * ## Session discipline
 *
 * Both drivers below run inside ONE file-transfer session, opened with the same
 * 4-step prelude the hardware-confirmed upload path already sends
 * (`transfer.ts` `buildUploadFrames`), then scoped to the target pack's
 * directory with `DIR_CONTROL [fileType, pack]`, and ALWAYS closed in a
 * `finally` so a fault never strands the device on its transfer screen.
 *
 * `deleteProjectSlots` re-runs QUERY_EXISTS immediately before each DELETE_FILE,
 * in the same session, even when the caller has already pre-flighted the slot.
 * The pre-flight is what the user was shown; this is what the device is asked
 * one instruction before it destroys something. They are deliberately not the
 * same read.
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

import { blockAddress, makeMessage, TRANSFER_CONSTANTS } from './transfer.js';
import { parseDirEntry, parseDirListHeader } from './sampleDirectory.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;

/** fileType bytes the transfer layer addresses. Only PROJECT is wired to a tool. */
export const FILE_TYPE = { PROJECT: 0x03, PATCH: 0x04, SAMPLE: 0x05 } as const;

/** Slots per pack, for every fileType this transport addresses. */
export const SLOTS_PER_PACK = 64;

const REPLY_TIMEOUT_MS = 600;
const PRELUDE_TIMEOUT_MS = 400;
const DRAIN_TIMEOUT_MS = 40;
/** Fixed on-wire length of a DIR_CONTROL listing header (see sampleDirectory.ts). */
const DIR_LIST_HEADER_LENGTH = 13;
/** `F0` + 6-byte header + sub + fileId(3) + `F7`. */
const REQUEST_LENGTH = 12;
/** OCCUPIED reply: request shape + 8 CRC nibbles. */
const EXISTS_OCCUPIED_LENGTH = REQUEST_LENGTH + 8;
/** ACK reply: `F0` + 6-byte header + sub + addr(8) + fileId(3) + `F7`. */
const DELETE_ACK_LENGTH = 20;

// ── Pure builders + parsers ──────────────────────────────────────────

/**
 * `F0 00 20 29 01 64 03 0d <fileType> <pack> <slot> F7` asks whether a slot
 * holds a file. READ-ONLY: this frame changes nothing, which is what lets the
 * gate run it on the caller's behalf without authorization.
 */
export function buildQueryExists(fileType: number, pack: number, slot: number): number[] {
  return makeMessage(SUB.QUERY_EXISTS, [fileType & 0x7f, pack & 0x7f, slot & 0x7f]);
}

/**
 * `F0 00 20 29 01 64 03 08 <fileType> <pack> <slot> F7` DELETES the stored file.
 *
 * There is no confirmation step on the device and no undo. Nothing in this
 * module calls this builder without a fresh QUERY_EXISTS verdict of OCCUPIED in
 * the same session, and nothing above it calls it without a CRC-verified backup
 * already on disk. Keep it that way.
 */
export function buildDeleteFile(fileType: number, pack: number, slot: number): number[] {
  return makeMessage(SUB.DELETE_FILE, [fileType & 0x7f, pack & 0x7f, slot & 0x7f]);
}

/** What QUERY_EXISTS said about one slot. `undefined` = not a recognised answer. */
export type ExistsReply =
  | { status: 'occupied'; crc32: number }
  | { status: 'free' };

/**
 * Parse a QUERY_EXISTS reply for the slot we asked about.
 *
 * Returns `undefined` for silence, a wrong length, a reply about a DIFFERENT
 * (fileType, pack, slot), or any subcommand other than the two documented
 * answers. The caller must treat `undefined` as "occupancy unknown" and refuse,
 * never as "free" and never as "occupied".
 */
export function parseExistsReply(
  msg: readonly number[], fileType: number, pack: number, slot: number,
): ExistsReply | undefined {
  if (msg.length < 9) return undefined;
  const sub = msg[7];
  if (sub === SUB.EMPTY_RECORD) {
    // The negative answer. It carries no fileId to check against, so it is
    // accepted on shape alone; a stray EMPTY_RECORD can only ever cost a
    // refusal ("nothing to delete"), never authorise one.
    return { status: 'free' };
  }
  if (sub !== SUB.QUERY_EXISTS || msg.length !== EXISTS_OCCUPIED_LENGTH) return undefined;
  // The positive answer AUTHORISES a delete, so it must echo the exact fileId
  // we asked about. A reply for a neighbouring slot read as this slot's is the
  // one mistake that deletes the wrong project.
  if (msg[8] !== (fileType & 0x7f) || msg[9] !== (pack & 0x7f) || msg[10] !== (slot & 0x7f)) return undefined;
  let crc = 0;
  for (let i = 11; i < 19; i++) crc = ((crc << 4) | (msg[i] & 0x0f)) >>> 0;
  return { status: 'occupied', crc32: crc };
}

/** True when `msg` is the DELETE_FILE ACK for exactly this (fileType, pack, slot). */
export function isDeleteAckFor(
  msg: readonly number[], fileType: number, pack: number, slot: number,
): boolean {
  if (msg.length !== DELETE_ACK_LENGTH || msg[7] !== SUB.ACK) return false;
  const addr = blockAddress(0);
  for (let i = 0; i < 8; i++) if (msg[8 + i] !== addr[i]) return false;
  return msg[16] === (fileType & 0x7f) && msg[17] === (pack & 0x7f) && msg[18] === (slot & 0x7f);
}

// ── Session drivers ──────────────────────────────────────────────────

export interface FileDeleteOptions {
  /** 0-based microSD pack (device Pack 1 = 0). Default 0. */
  pack?: number;
  /** Multiplier for the fixed settle delays. 1 = production timing; tiny = fast offline tests. */
  sleepScale?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function assertSlots(slots: readonly number[]): void {
  for (const s of slots) {
    if (!Number.isInteger(s) || s < 0 || s >= SLOTS_PER_PACK) {
      throw new RangeError(`slot must be 0..${SLOTS_PER_PACK - 1} (wire), got ${s}`);
    }
  }
}

function assertPack(pack: number): void {
  if (!Number.isInteger(pack) || pack < 0 || pack > 31) {
    throw new RangeError(`pack must be 0..31 (0-based; device Pack 1 = 0), got ${pack}`);
  }
}

/**
 * Open a session and scope it to `fileType`'s directory on `pack`, replaying the
 * prelude byte-for-byte from the hardware-confirmed upload path. Returns the
 * names the directory listing reported, keyed by wire slot: that listing is the
 * SECOND, independent occupancy oracle, and it is also where the human-readable
 * project names come from (QUERY_EXISTS returns a CRC, not a name).
 */
async function openScopedSession(
  conn: MidiConnection, fileType: number, pack: number, sleepScale: number,
): Promise<Map<number, string>> {
  const prelude = [
    makeMessage(SUB.OPEN_SESSION),
    makeMessage(SUB.DIR_CONTROL, [0x01]),
    makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
    makeMessage(SUB.DIR_CONTROL, [0x02]),
  ];
  for (const msg of prelude) {
    const replyP = conn.receiveSysEx(PRELUDE_TIMEOUT_MS * sleepScale).catch(() => [] as number[]);
    conn.send(msg);
    await replyP;
  }
  // Clear a straggler still in flight before the strict header matcher registers
  // (the 2026-07-10 prelude reply-desync fix; see sampleDirectory.ts).
  await conn.receiveSysEx(DRAIN_TIMEOUT_MS * sleepScale).catch(() => undefined);

  const headerP = conn
    .receiveSysExMatching(
      (m) => m[7] === SUB.DIR_CONTROL && m[8] === fileType && m[9] === (pack & 0x7f) && m.length === DIR_LIST_HEADER_LENGTH,
      REPLY_TIMEOUT_MS * sleepScale,
    )
    .catch(() => [] as number[]);
  conn.send(makeMessage(SUB.DIR_CONTROL, [fileType, pack & 0x7f]));
  const header = parseDirListHeader(await headerP);
  const count = header?.count ?? 0;

  const names = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const reply = await conn
      .receiveSysExMatching((m) => m[7] === 0x0c && m[8] === fileType && m[9] === (pack & 0x7f), REPLY_TIMEOUT_MS * sleepScale)
      .catch(() => [] as number[]);
    if (reply.length === 0) break;   // honest partial listing, never a silent hang
    const entry = parseDirEntry(reply);
    if (!entry || entry.slot < 0 || entry.slot >= SLOTS_PER_PACK) continue;
    names.set(entry.slot, entry.name);
  }
  return names;
}

/** One slot, seen by BOTH oracles. Wire slot numbering (0..63). */
export interface SlotOccupancy {
  slot: number;
  /** QUERY_EXISTS said the device holds a file here. */
  exists: boolean;
  /** The pack's directory listing named this slot. */
  in_directory: boolean;
  /** Stored name, from the directory listing (QUERY_EXISTS carries no name). */
  name?: string;
  /** The device's own CRC32 of the stored file, when QUERY_EXISTS returned one. */
  crc32?: number;
  /**
   * The exact QUERY_EXISTS reply frame, kept so a caller can compare a slot's
   * refusal byte-for-byte against a KNOWN-FREE control slot's rather than against
   * a hardcoded expectation. See `SlotProbeReport.free_control`.
   */
  reply?: readonly number[];
  /** Set when occupancy could NOT be established. Callers must refuse, not assume. */
  unreadable?: string;
}

export interface SlotProbeReport {
  slots: SlotOccupancy[];
  /**
   * A slot the pack's directory does NOT list, read with the same query in the
   * same session, as a live sample of what "free" looks like on this device
   * right now.
   *
   * This exists because of a real mis-scoring on 2026-07-29: a verification
   * script whose matcher accepted only the OCCUPIED reply shape saw the device's
   * free-slot refusal as an unmatched reply and reported the file "still there",
   * on a slot that had in fact been erased. Only a read of a never-occupied
   * control slot settled it. So the refusal is a first-class expected answer
   * here, and a caller can prove a slot is free by showing its reply is
   * byte-identical to a slot that was never occupied, instead of trusting that
   * our idea of the refusal shape is complete.
   *
   * Absent when every slot on the pack is occupied, which is the one case where
   * no control exists. Callers fall back to the two ordinary oracles and say so.
   */
  free_control?: { slot: number; reply: readonly number[] };
}

/** Matches either documented QUERY_EXISTS answer: the occupied record OR the refusal. */
const existsReplyMatcher = (m: readonly number[]): boolean =>
  m[7] === SUB.EMPTY_RECORD || (m[7] === SUB.QUERY_EXISTS && m.length === EXISTS_OCCUPIED_LENGTH);

/**
 * Read `slots` with both oracles in one session: QUERY_EXISTS per slot, plus the
 * pack's directory listing, plus one known-free control slot.
 *
 * `slots` are NAMED slots, never a range, and this function walks exactly the
 * list it is given. That is deliberate at every layer of this feature: the
 * 2026-06-27 incident that emptied a pack's sample pool was a LOOP over a range,
 * and Novation Components itself never loops a delete either (it enumerates,
 * then sends one frame per named slot its own directory lists as occupied).
 *
 * Sends ONLY OPEN_SESSION / DIR_CONTROL / QUERY_INFO / QUERY_EXISTS /
 * CLOSE_SESSION, so it is read-only BY CONSTRUCTION: there is no DELETE_FILE, no
 * WRITE_INIT and no SET_FILENAME anywhere in this function, and it cannot
 * destroy or half-open anything.
 */
export async function probeSlots(
  conn: MidiConnection, fileType: number, slots: readonly number[], opts: FileDeleteOptions = {},
): Promise<SlotProbeReport> {
  const pack = opts.pack ?? 0;
  const ss = opts.sleepScale ?? 1;
  assertPack(pack);
  assertSlots(slots);

  const query = async (slot: number): Promise<{ verdict: ExistsReply | undefined; reply: number[] }> => {
    const replyP = conn.receiveSysExMatching(existsReplyMatcher, REPLY_TIMEOUT_MS * ss).catch(() => [] as number[]);
    conn.send(buildQueryExists(fileType, pack, slot));
    const reply = await replyP;
    return { verdict: parseExistsReply(reply, fileType, pack, slot), reply };
  };

  try {
    const names = await openScopedSession(conn, fileType, pack, ss);
    const out: SlotOccupancy[] = [];
    for (const slot of slots) {
      const { verdict, reply } = await query(slot);
      const name = names.get(slot);
      if (verdict === undefined) {
        out.push({
          slot, exists: false, in_directory: name !== undefined, name, reply,
          unreadable: 'the device did not answer the occupancy query with a recognised record',
        });
        continue;
      }
      out.push({
        slot,
        exists: verdict.status === 'occupied',
        in_directory: name !== undefined,
        name,
        reply,
        crc32: verdict.status === 'occupied' ? verdict.crc32 : undefined,
      });
    }

    // Read one slot the directory does not list, as the reference for "free".
    // Prefer one OUTSIDE the requested set so it stays a control across a delete
    // of those slots. Highest first: the tail of a pack is the likeliest to be
    // untouched, so it is also the least likely to be mid-transfer.
    let free_control: SlotProbeReport['free_control'];
    const requested = new Set(slots);
    for (let slot = SLOTS_PER_PACK - 1; slot >= 0; slot--) {
      if (requested.has(slot) || names.has(slot)) continue;
      const { verdict, reply } = await query(slot);
      if (verdict?.status === 'free') free_control = { slot, reply };
      break;   // one attempt only; a control is a nicety, not a gate
    }
    return { slots: out, free_control };
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port already gone */ }
  }
}

/** Outcome of trying to delete one slot. Wire slot numbering. */
export interface SlotDeleteResult {
  slot: number;
  /** The device ACKed the delete AND the in-session re-query came back free. */
  ok: boolean;
  /** Set when the slot was NOT deleted, saying which guard stopped it or what failed. */
  error?: string;
  /** The in-session QUERY_EXISTS re-check after the delete: true = the file is gone. */
  gone_by_query?: boolean;
}

/**
 * Delete `slots` on `pack`, in one session, each one guarded by its own
 * immediately-preceding QUERY_EXISTS.
 *
 * Per slot: QUERY_EXISTS -> require OCCUPIED -> DELETE_FILE -> require the ACK
 * for THAT fileId -> QUERY_EXISTS again -> require FREE. A slot that fails any
 * step is reported and the loop moves on; it never retries a delete and never
 * assumes an unanswered query means the slot was empty.
 *
 * This function does NOT take a backup and does NOT check authorization. Both
 * live in the dispatcher (`dispatcher/deleteProject.ts`), which is where
 * filesystem I/O belongs and where every gate can be tested offline. Do not call
 * this directly from a tool.
 */
export async function deleteSlots(
  conn: MidiConnection, fileType: number, slots: readonly number[], opts: FileDeleteOptions = {},
): Promise<SlotDeleteResult[]> {
  const pack = opts.pack ?? 0;
  const ss = opts.sleepScale ?? 1;
  assertPack(pack);
  assertSlots(slots);
  const results: SlotDeleteResult[] = [];
  try {
    await openScopedSession(conn, fileType, pack, ss);
    for (const slot of slots) {
      // Both reads below use `existsReplyMatcher`, which accepts the device's
      // REFUSAL shape as readily as its occupied record. A matcher that accepted
      // only the occupied shape mis-scored a real hardware delete on 2026-07-29:
      // the post-delete refusal fell through as an unmatched reply and the run
      // reported the project "still there" after it had genuinely been erased.
      // On a device with no undo, that reads as "the delete failed, send it
      // again". The refusal is an ANSWER, not a non-answer.
      // 1. Read, one instruction before the destructive frame.
      const beforeP = conn.receiveSysExMatching(existsReplyMatcher, REPLY_TIMEOUT_MS * ss).catch(() => [] as number[]);
      conn.send(buildQueryExists(fileType, pack, slot));
      const before = parseExistsReply(await beforeP, fileType, pack, slot);
      if (before === undefined) {
        results.push({ slot, ok: false, error: 'occupancy could not be read immediately before the delete, so the slot was left alone' });
        continue;
      }
      if (before.status === 'free') {
        results.push({ slot, ok: false, error: 'the slot read as already empty immediately before the delete, so nothing was sent' });
        continue;
      }

      // 2. Destroy it.
      const ackP = conn
        .receiveSysExMatching((m) => isDeleteAckFor(m, fileType, pack, slot), REPLY_TIMEOUT_MS * ss)
        .catch(() => [] as number[]);
      conn.send(buildDeleteFile(fileType, pack, slot));
      const ack = await ackP;
      if (ack.length === 0) {
        results.push({ slot, ok: false, error: 'the device did not acknowledge the delete; treat the slot as UNKNOWN and re-read it before acting' });
        continue;
      }
      await sleep(40 * ss);

      // 3. Ask the same oracle again. This is the in-session half of the
      //    verification; the directory half runs in a FRESH session afterwards,
      //    because the device's manifest flush lags the session close.
      const afterP = conn.receiveSysExMatching(existsReplyMatcher, REPLY_TIMEOUT_MS * ss).catch(() => [] as number[]);
      conn.send(buildQueryExists(fileType, pack, slot));
      const after = parseExistsReply(await afterP, fileType, pack, slot);
      const gone = after?.status === 'free';
      results.push({
        slot,
        ok: gone,
        gone_by_query: gone,
        error: gone ? undefined : 'the device acknowledged the delete but the slot did not read back as empty',
      });
    }
    return results;
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port already gone */ }
  }
}
