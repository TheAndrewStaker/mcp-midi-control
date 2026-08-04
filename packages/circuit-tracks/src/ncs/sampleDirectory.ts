/**
 * Circuit Tracks SAMPLE DIRECTORY read — the pack's 64-slot sample pool names.
 *
 * RE-DECODED 2026-07-09 from a genuine Novation Components READ capture
 * (`samples/captured/get_pack_from_circuit_tracks.pcapng`, USBPcap, device
 * 0x1235:0x0139, Components' own "Get Pack from Circuit Tracks" action,
 * decoded with `scripts/_research/decode-circuit-usbmidi.py`). This replaces
 * the 2026-06-27 DISABLED implementation below, which was never derived from
 * a real read capture and turned out to replay the wrong (write-flow)
 * enumeration primitive; see "What was actually wrong" below.
 *
 * ## The confirmed non-destructive LISTING protocol
 *
 * Sequence (cited against the capture's OUT/IN Circuit SysEx streams, byte
 * offsets from `F0` at index 0; envelope is `F0 00 20 29 01 64 03 <sub> … F7`,
 * so `msg[7]` is always the subcommand):
 *
 *   OPEN_SESSION (0x40) → DIR_CONTROL([0x01]) → QUERY_INFO([0x01,0x00]) →
 *   DIR_CONTROL([0x02]) → DIR_CONTROL([fileType, pack]) →
 *   [device replies: one 0x0b header, then N × 0x0c DIR_ENTRY] → CLOSE_SESSION.
 *
 * This exact 4-step prelude (OPEN, DIR(1), QUERY(1,0), DIR(2)) is ALSO the
 * hardware-confirmed prelude the project-upload path already sends
 * (`transfer.ts` `buildUploadFrames`, steps `dir_control_1`/`query_info`/
 * `dir_control_2`) before its own `dir_listing` = `DIR_CONTROL([0x03, 0x00])`
 * (the SAME opcode this decode confirms for PROJECT listings). So the
 * `DIR_CONTROL(fileType, pack)` call is not a listing added just for reads: it
 * is the identical scoping step a hardware-confirmed WRITE session already
 * uses safely, with only the `fileType` byte differing (0x03 project, 0x04
 * patch bank, 0x05 sample; see below).
 *
 * **DIR_CONTROL reply** (sub 0x0b): `msg[8]`=fileType, `msg[9]`=pack,
 * `msg[10..11]`=entry COUNT as a septet pair (`count = msg[11]*128 +
 * msg[10]`). Confirmed byte-exact for fileType=0x03 (project, count 0x34=52)
 * and fileType=0x04 (patch bank, count 0x10=16), e.g.:
 *   `f0 00 20 29 01 64 03 0b 03 00 34 00 f7`  (project dir: 52 entries)
 *   `f0 00 20 29 01 64 03 0b 04 00 10 00 f7`  (patch dir: 16 entries)
 *
 * **DIR_ENTRY reply** (sub 0x0c): `msg[8]`=fileType, `msg[9]`=pack,
 * `msg[10]`=slot, `msg[11..-2]`=ASCII name. One reply per OCCUPIED slot only
 * (no probing of empty slots), e.g.:
 *   `f0 00 20 29 01 64 03 0c 03 00 00 30 30 5f 48 65 6c 6c 6f ... f7`
 *   ("00_Hello Tracks.ncs", project slot 0)
 *
 * ## fileType=0x05 (SAMPLE) LISTING: HARDWARE-CONFIRMED 2026-07-10
 *
 * The per-file READ REQUEST (below) was already confirmed for fileType=0x05 in
 * the capture above: Components fetched ~40 sample files with the identical
 * envelope used for projects/patches, just `fileType=0x05`. The capture never
 * showed an explicit `DIR_CONTROL([0x05, pack])` / DIR_ENTRY exchange
 * (Components jumped straight from the last project read to per-file sample
 * reads, having learned the occupied slots elsewhere in that session), so this
 * module's `DIR_CONTROL([0x05, 0])` listing call originally shipped by direct
 * shape analogy only, flagged UNCONFIRMED for samples specifically.
 *
 * A 2026-07-10 live bench run on the maintainer's own device closed that gap:
 * `readSampleDirectory` returned the pack-0 sample directory with
 * `occupied=64` and correct, Components-matching names ("00_PCM.wav",
 * "01_stoken_4_02_kick2.wav", ...). The fileType=0x05 LISTING call is no
 * longer an analogy; it is device-confirmed. That same bench run also
 * diagnosed and fixed the prelude reply-desync bug below, which had been
 * masking the confirmation on the first attempt (`occupied=0`).
 *
 * ## The 2026-07-10 prelude reply-desync bug (occupied=0 on a real 64-sample pack)
 *
 * Before the fix, the bench run first hit `occupied=0` on a pack the device
 * genuinely holds 64 samples in. Root cause: the 4-step prelude (OPEN_SESSION,
 * DIR_CONTROL[0x01], QUERY_INFO[0x01,0x00], DIR_CONTROL[0x02]) can leave a
 * late/short DIR_CONTROL reply still arriving when the listing phase opens.
 * The observed straggler was `f0 00 20 29 01 64 03 0b 02 05 f7` (sub=0x0b, but
 * msg[8]=0x02 and only 11 bytes: NOT a directory-listing header for anything
 * we asked). The header matcher in use at the time, `(m) => m[7] ===
 * SUB.DIR_CONTROL`, accepted ANY sub=0x0b reply regardless of which fileType
 * or pack it actually answered, so it consumed the straggler instead of
 * waiting for the real one. `parseDirListHeader` correctly rejected that
 * malformed 11-byte frame (shorter than the fixed 13-byte header) and
 * returned `undefined`, so `count` fell back to 0 and the listing came back
 * empty — even though the REAL fileType=0x05 header
 * (`... 0b 05 00 40 00 ...`, count 0x40=64) and all 64 DIR_ENTRY replies were
 * still on their way.
 *
 * Fixed by making the header matcher STRICT: it now only accepts a reply that
 * is sub=DIR_CONTROL AND answers fileType=SAMPLE AND is the full fixed
 * 13-byte header shape (`m[7] === SUB.DIR_CONTROL && m[8] === FILE_TYPE_SAMPLE
 * && m.length === 13`), so a stray reply for a different fileType, or a
 * truncated frame, can never be mistaken for this call's header. A
 * best-effort drain (one short, match-anything receive between the prelude
 * and the listing request) was added as defense-in-depth, clearing a
 * straggler out of the queue before the strict header matcher starts
 * listening. Neither change touches the confirmed frame sequence; both are
 * receive-discipline only. Golden-locked in `scripts/verify-circuit-ncs.ts`
 * (a mocked round trip with the exact stale frame queued ahead of the real
 * header + entries).
 *
 * ## What was actually wrong with the disabled 2026-06-27 code
 *
 * The old prelude ended in the SAME `DIR_CONTROL([FILE_TYPE_SAMPLE, 0x00])`
 * call this file still uses; that part was fine. The destructive step was
 * what came AFTER: a 64× `0x0d` (QUERY_CRC) + 64× `0x08` (QUERY_NAME) probe
 * loop. Per the hardware-confirmed UPLOAD decode (`docs/design/
 * circuit-sample-upload.md`), `0x0d`/`0x08` are the enumeration primitives
 * Components sends WHILE PREPARING A WRITE (immediately before WRITE_INIT/
 * DATA/FINISH for the samples being uploaded), i.e. a write-flow priming
 * step, not a read-only directory query. Reusing it for a pure read, then
 * closing the session having sent zero real WRITE_INIT/DATA/FINISH frames,
 * is what committed an empty directory. This file no longer touches 0x0d/0x08
 * at all: the listing here is ONLY `DIR_CONTROL` (0x0b) request → `DIR_ENTRY`
 * (0x0c) replies, never a WRITE_INIT/DATA/FINISH/SET_FILENAME frame, so it
 * cannot "abandon a write" the way the old code did.
 *
 * This is the read half of the semantic-mapping workflow: knowing each pool
 * slot's NAME ("kick", "snare", "closed hat") lets the groove packer target
 * the right slot by meaning instead of a hardcoded layout. (It reads the
 * shared 64-slot pool; which pool sample a given drum TRACK points to inside
 * a project is the separate `drumBinding.ts` binding.)
 *
 * Impure (drives the bidirectional MIDI connection) but self-contained:
 * always closes the file-transfer session, even on error, so the device is
 * never left on its transfer screen. NEVER sends WRITE_INIT / WRITE_DATA /
 * WRITE_FINISH / SET_FILENAME; every frame this module sends is one of
 * OPEN_SESSION / DIR_CONTROL / QUERY_INFO / CLOSE_SESSION, so it cannot open
 * (let alone abandon) a write transaction.
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

import { makeMessage, blockAddress, TRANSFER_CONSTANTS } from './transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FILE_TYPE_PROJECT = 0x03;
const FILE_TYPE_PATCH = 0x04;
const FILE_TYPE_SAMPLE = 0x05;
const DIR_ENTRY = 0x0c; // device → host: one occupied (fileType, pack, slot) + ASCII name
const SLOT_COUNT = 64;
const REPLY_TIMEOUT_MS = 400;
const PRELUDE_TIMEOUT_MS = 400;
/**
 * Best-effort drain window (2026-07-10 fix): after the prelude and before the
 * listing header matcher registers, one short match-anything receive clears
 * any straggler reply still in flight from the prelude (see module docstring,
 * "prelude reply-desync bug"). Deliberately much shorter than the 400ms reply
 * timeouts above — this is a defensive sweep, not a real wait for a reply we
 * expect.
 */
const DRAIN_TIMEOUT_MS = 40;
/** Fixed on-wire length of a DIR_CONTROL listing-header reply (F0 + 6-byte header + sub + fileType + pack + count-lo + count-hi + F7). */
const DIR_LIST_HEADER_LENGTH = 13;

/** One sample-pool slot: 0-based wire slot, device-facing 1-based number, and name (undefined = empty). Alias of the generic {@link DirectorySlot}. */
export type SampleSlot = DirectorySlot;

export interface SampleDirectoryResult extends FileDirectoryResult {
  /** Honesty note about evidence tier (e.g. the sample-fileType listing caveat above). */
  capacity_note?: string;
}

const ascii = (a: readonly number[]): string =>
  a.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('').trimEnd();

/** 3-byte file id `[fileType, pack, slot]`, the shared fileId shape every file-transfer subcommand uses. */
export function fileIdFor(fileType: number, pack: number, slot: number): number[] {
  return [fileType & 0x7f, pack & 0x7f, slot & 0x7f];
}

/**
 * Parse a DIR_CONTROL (sub 0x0b) directory-listing HEADER reply: which
 * fileType/pack it answers, and how many DIR_ENTRY replies will follow.
 * Confirmed byte-exact for fileType 0x03 (project, count 52) and 0x04 (patch
 * bank, count 16) against `get_pack_from_circuit_tracks.pcapng`.
 */
export function parseDirListHeader(msg: readonly number[]): { fileType: number; pack: number; count: number } | undefined {
  // Fixed-length reply (no variable name field, unlike DIR_ENTRY): reject
  // anything that isn't EXACTLY the 13-byte shape rather than merely "long
  // enough", so a short/malformed sub=0x0b straggler (e.g. the 11-byte
  // `0b 02 05` frame from the 2026-07-10 desync bug) can never be misread by
  // reading past its end. Defensive: the caller's matcher is the primary
  // guard (see readSampleDirectory), this is the second line of defense.
  if (msg.length !== DIR_LIST_HEADER_LENGTH || msg[7] !== SUB.DIR_CONTROL) return undefined;
  return { fileType: msg[8], pack: msg[9], count: msg[11] * 128 + msg[10] };
}

/**
 * Parse a DIR_ENTRY (sub 0x0c) reply: one occupied slot's fileType/pack/slot
 * + its ASCII name. Confirmed byte-exact for fileType 0x03 (project) and 0x04
 * (patch bank) against the same capture. `msg.length < 12` rejects a
 * too-short frame rather than reading past its end (the name field is
 * variable-length, so unlike the header this can't tighten to an exact
 * length). Already immune to the 2026-07-10 desync straggler by construction:
 * that frame's sub byte is 0x0b (DIR_CONTROL), never 0x0c (DIR_ENTRY), so the
 * `msg[7] !== DIR_ENTRY` check alone rules it out; verified, no change needed.
 */
export function parseDirEntry(msg: readonly number[]): { fileType: number; pack: number; slot: number; name: string } | undefined {
  if (msg.length < 12 || msg[7] !== DIR_ENTRY) return undefined;
  return { fileType: msg[8], pack: msg[9], slot: msg[10], name: ascii(msg.slice(11, msg.length - 1)) };
}

/**
 * Build the per-file READ REQUEST envelope: "send me file (fileType, pack,
 * slot)". Same subcommand (0x01) as WRITE_INIT, but a short fixed tail (a
 * single `0x02` byte) instead of WRITE_INIT's size-nibble tail: the device
 * replies with a REAL WRITE_INIT (a longer payload carrying the actual file
 * size) followed by WRITE_DATA blocks and WRITE_FINISH, i.e. it becomes the
 * SENDER for this one exchange. Confirmed byte-exact for fileType 0x03
 * (project), 0x04 (patch bank), and 0x05 (sample) alike in the same capture,
 * e.g. `f0 00 20 29 01 64 03 01 00 00 00 00 00 00 00 00 05 00 00 02 f7`
 * (sample slot 0). NOT wired into a live orchestration here (this module only
 * needs slot NAMES for the directory listing); kept as pure, tested groundwork
 * for a future "download a sample's audio back" feature.
 */
export function buildReadFileRequest(fileType: number, pack: number, slot: number): number[] {
  return makeMessage(SUB.WRITE_INIT, [...blockAddress(0), ...fileIdFor(fileType, pack, slot), 0x02]);
}

export const SAMPLE_DIRECTORY_CONSTANTS = { FILE_TYPE_PROJECT, FILE_TYPE_PATCH, FILE_TYPE_SAMPLE, DIR_ENTRY } as const;

/** One occupied-directory slot: 0-based wire slot, 1-based device number, name. */
export interface DirectorySlot {
  slot: number;        // 0..63 (wire)
  device_slot: number; // 1..64 (what the device/Components shows)
  name?: string;       // ASCII name, or undefined if the slot is empty
}

export interface FileDirectoryResult {
  occupied: number;
  total: number;
  slots: DirectorySlot[];
  /** The 0-based microSD pack this directory was read from (device Pack 1 = 0). */
  pack: number;
}

/**
 * Read one 64-slot file directory (by `fileType`) over the file-transfer
 * transport, non-destructively. Shared core for the sample pool (0x05) and the
 * project directory (0x03) — both are the SAME listing protocol, differing only
 * in the fileType byte (module docstring). Requires a bidirectional connection
 * (the caller gates `conn.hasInput`).
 *
 * `pack` is the 0-based microSD pack (device Pack 1 = 0), the chosen byte every
 * file-transfer subcommand addresses (`docs/design/circuit-pack-addressing.md`).
 *
 * Sends ONLY OPEN_SESSION / DIR_CONTROL / QUERY_INFO / CLOSE_SESSION frames
 * (module docstring for the byte-exact sequence + capture citation). NEVER sends
 * WRITE_INIT/DATA/FINISH/SET_FILENAME, so it cannot open (or abandon) a write
 * transaction the way the disabled 2026-06-27 code did.
 */
export async function readFileDirectory(conn: MidiConnection, fileType: number, pack = 0): Promise<FileDirectoryResult> {
  if (!Number.isInteger(pack) || pack < 0 || pack > 31) {
    throw new RangeError(`pack must be 0..31 (0-based; device Pack 1 = 0), got ${pack}`);
  }
  const slots: DirectorySlot[] = Array.from({ length: SLOT_COUNT }, (_, slot) => ({ slot, device_slot: slot + 1 }));
  try {
    // Replay the captured, non-destructive open + directory handshake (drain
    // each reply). Byte-identical to the first 4 steps of the hardware-
    // confirmed project-upload prelude (transfer.ts buildUploadFrames).
    const prelude: number[][] = [
      makeMessage(SUB.OPEN_SESSION),
      makeMessage(SUB.DIR_CONTROL, [0x01]),
      makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
      makeMessage(SUB.DIR_CONTROL, [0x02]),
    ];
    for (const msg of prelude) {
      const replyP = conn.receiveSysEx(PRELUDE_TIMEOUT_MS).catch(() => [] as number[]);
      conn.send(msg);
      await replyP;
    }

    // Best-effort drain (2026-07-10 fix, see module docstring "prelude
    // reply-desync bug"): a straggler reply from the prelude above can still
    // be arriving when the listing phase opens. One short, match-anything
    // receive clears it before the strict header matcher below starts
    // listening. Best-effort only: an empty queue just times out here (the
    // common case) and is silently ignored; this never changes the frame
    // sequence, only what gets pulled off the wire first.
    await conn.receiveSysEx(DRAIN_TIMEOUT_MS).catch(() => undefined);

    // The directory LISTING request. STRICT header matcher: a reply is only
    // accepted as THIS call's header when it is sub=DIR_CONTROL AND answers the
    // requested fileType AND pack AND is the full fixed 13-byte header shape. A
    // stray sub=0x0b reply for a different fileType/pack, or a truncated frame
    // (the 2026-07-10 desync bug's root cause: a loose `m[7] === SUB.DIR_CONTROL`-
    // only predicate accepted such a straggler and returned occupied=0 on a real
    // 64-sample pack), fails this predicate and is left alone so the real header
    // can still be matched when it arrives.
    const headerReplyP = conn
      .receiveSysExMatching((m) => m[7] === SUB.DIR_CONTROL && m[8] === fileType && m[9] === (pack & 0x7f) && m.length === DIR_LIST_HEADER_LENGTH, PRELUDE_TIMEOUT_MS)
      .catch(() => [] as number[]);
    conn.send(makeMessage(SUB.DIR_CONTROL, [fileType, pack & 0x7f]));
    const headerReply = await headerReplyP;
    const header = parseDirListHeader(headerReply);
    const count = header?.count ?? 0;

    let occupied = 0;
    for (let i = 0; i < count; i++) {
      // Register the matcher BEFORE any further send (sync-throw-safe ordering).
      const entryReply = await conn
        .receiveSysExMatching((m) => m[7] === DIR_ENTRY && m[8] === fileType && m[9] === (pack & 0x7f), REPLY_TIMEOUT_MS)
        .catch(() => [] as number[]);
      if (entryReply.length === 0) break; // honest partial result on a stall, never a silent hang
      const entry = parseDirEntry(entryReply);
      if (!entry || entry.slot < 0 || entry.slot >= SLOT_COUNT) continue;
      slots[entry.slot] = { slot: entry.slot, device_slot: entry.slot + 1, name: entry.name || undefined };
      occupied++;
    }

    return { occupied, total: SLOT_COUNT, slots, pack };
  } finally {
    // ALWAYS end the session so the device leaves its transfer screen.
    try {
      conn.send(makeMessage(SUB.CLOSE_SESSION));
    } catch {
      /* handle already dead — nothing to clean up */
    }
  }
}

/**
 * Read the 64-slot SAMPLE pool directory (fileType 0x05) — each slot's stored
 * name. `pack` reads a specific pack's pool (the SAME byte projects address), so
 * `list_samples pack:5` reads the pool a Pack-5 project binds against instead of
 * always Pack 1's. Pack 0 is hardware-confirmed (2026-07-10) and a nonzero pack
 * reuses the identical listing call, owner-confirmed on a 5-pack card
 * (2026-07-17). Both are surfaced in `capacity_note`.
 *
 * READ-BACK TIMING (2026-07-27, the trap this call sets for its callers): the
 * device flushes a pack's sample manifest ~6-8 s AFTER a transfer session
 * CLOSES. A listing taken sooner reports slots "(empty)" that are simply still
 * in flight: a verification read 1.2 s after a 63-slot clone reported 8 slots
 * empty and a later read showed every one present. So this call is NOT a valid
 * write verifier until the commit window has passed. Poll (reconnect, ~9 s,
 * then 5 s retries) as `scripts/circuit-clone-pack-samples.ts` does. On a device
 * with no erase, a false "the write failed" leads to a re-send that is not free.
 */
export async function readSampleDirectory(conn: MidiConnection, pack = 0): Promise<SampleDirectoryResult> {
  const r = await readFileDirectory(conn, FILE_TYPE_SAMPLE, pack);
  return {
    ...r,
    capacity_note: pack === 0
      ? 'Pack 1 (wire pack 0). The sample-directory LISTING call (DIR_CONTROL fileType=0x05, pack 0) is ' +
        'HARDWARE-CONFIRMED (2026-07-10, live bench run): the device returned all 64 pack-0 sample slot names, ' +
        'byte-for-byte matching Novation Components (e.g. "00_PCM.wav", "01_stoken_4_02_kick2.wav"). ' +
        'If you are reading this to VERIFY a write you just made, wait: the device flushes a pack\'s sample manifest ' +
        '~6-8 s after the transfer session closes, so a listing taken sooner can report a just-written slot empty.'
      : `Pack ${pack + 1} (wire pack ${pack}). The nonzero-pack sample READ is owner-confirmed on a 5-pack card ` +
        '(2026-07-17): a higher pack returned a pool distinct from Pack 1\'s, so the chosen pack byte reaches the ' +
        'wire. The nonzero-pack sample WRITE is hardware-confirmed too (2026-07-27): 63 slots cloned onto Pack 2, ' +
        'read back off the device byte-identical, with an out-of-order write landing at its own index, so the slot ' +
        'byte is addressed rather than append-ordered. Names are read straight off the pack you selected. ' +
        'If you are reading this to VERIFY a write you just made, wait: the device flushes a pack\'s sample manifest ' +
        '~6-8 s after the transfer session closes, so a listing taken sooner can report a just-written slot empty.',
  };
}

/**
 * Read the 64-slot PROJECT directory (fileType 0x03) — each occupied project
 * slot's stored `.ncs` name, in ONE round trip. This is the fast pack-occupancy
 * read: seeing what a pack holds otherwise costs a get_preset per slot. The
 * fileType-0x03 header + entries are byte-confirmed against
 * `get_pack_from_circuit_tracks.pcapng` (52-project pack). `pack` is the 0-based
 * microSD pack.
 */
export async function readProjectDirectory(conn: MidiConnection, pack = 0): Promise<FileDirectoryResult> {
  return readFileDirectory(conn, FILE_TYPE_PROJECT, pack);
}
