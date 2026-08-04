/**
 * Bidirectional .ncs project transfer over SysEx (upload + download).
 *
 * This is the driver that puts the pure frame plan (`transfer.ts`) on the wire
 * and handles the device's ACK handshake. Hardware-confirmed end-to-end
 * (2026-06-18): a read round-trip is byte-identical to the device's export and
 * a write + readback is byte-exact.
 *
 * Uses a persistent inbound buffer (register the handler ONCE, then poll it) to
 * avoid the register-after-send race. Every wait is watchdog-bounded so a stalled
 * device can never wedge the caller. The device ACKs with subcmd 0x04 and does
 * NOT echo a matching addr/fid, so we wait for ANY ACK (matching the protocol).
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { isHandleHealthy, withReconnectRetry } from '@mcp-midi-control/core/server-shared/handleHealth.js';
import { recordAckOutcome } from '@mcp-midi-control/core/server-shared/connections.js';
import { NCS_FILE_SIZE, assertNcsStructure, checkNcsStructure } from './format.js';
import {
  blockAddress, buildUploadFrames, crc32, fileId, makeMessage, msbDeinterleave, TRANSFER_CONSTANTS,
  type UploadFrame,
} from './transfer.js';

/**
 * Matches `CIRCUIT_TRACKS_DESCRIPTOR.connection_label` in `../descriptor.ts`:
 * the registry key `ensureConnection` / `recordAckOutcome` key this device's
 * handle-health state under. Hardcoded here (rather than threaded through
 * every call site) because this module IS the Circuit's transfer driver;
 * there is only ever one label for it.
 */
const CIRCUIT_LABEL = 'circuit';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const HDR = TRANSFER_CONSTANTS.HEADER;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nibblesToInt = (ns: number[]) => ns.reduce((a, n) => (a * 16 + (n & 0xf)), 0) >>> 0;

function core(msg: number[]): number[] {
  let b = msg;
  if (b[0] === 0xf0) b = b.slice(1);
  if (b[b.length - 1] === 0xf7) b = b.slice(0, -1);
  return b;
}
// Device-family prefix (the 5 bytes BEFORE the command-group byte). The Circuit
// replies on three command groups: 0x03 (file request/reply), 0x04 (per-frame
// ACK), and 0x08 (the post-CLOSE flash-commit notification). HDR pins the group
// to 0x03, so a 0x08-group frame fails `isOurs` and is dropped before buffering;
// `isFamily` is the group-agnostic superset used for ingest so the commit
// notification is observable. (Decoded from two Components captures, 2026-06-23.)
const FAMILY = HDR.slice(0, 5);
const isFamily = (c: number[]) => c.length > 5 && FAMILY.every((h, i) => c[i] === h);
const isAck = (c: number[]) => c.length >= HDR.length + 1 + 8 + 3 && c[HDR.length] === SUB.ACK;
/** Post-CLOSE commit-complete: F0 00 20 29 01 64 08 00 F7 (group 0x08, subcmd 0x00). */
const isCommitDone = (c: number[]) => isFamily(c) && c[5] === 0x08 && c[6] === 0x00;

interface Inbox { take(pred: (c: number[]) => boolean, timeoutMs: number): Promise<number[] | undefined>; clear(): void; stop(): void; }
function attach(conn: MidiConnection): Inbox {
  const buf: number[][] = [];
  // Buffer every device-family frame, not only the 0x03 group — otherwise the
  // 0x08 commit notification never reaches the inbox. isAck still matches only
  // the 0x04 ACKs; the extra frames are cleared between non-ACK plan frames.
  const unsub = conn.onMessage((m: number[]) => { const c = core(m); if (isFamily(c)) buf.push(c); });
  return {
    async take(pred, timeoutMs) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const i = buf.findIndex(pred);
        if (i >= 0) { const m = buf[i]; buf.splice(0, i + 1); return m; }
        await sleep(3);
      }
      return undefined;
    },
    clear() { buf.length = 0; },
    stop() { unsub(); },
  };
}

export interface UploadResult { ok: boolean; slot: number; blocks: number; error?: string; }

/**
 * Transfer tunables. Defaults preserve the hardware-verified timing; callers
 * (and tests) can shorten them. `sleepScale` multiplies the fixed inter-frame
 * settle delays (1 = production timing; a tiny value makes an offline mock test
 * run in milliseconds).
 */
export interface TransferOptions {
  /**
   * 0-based microSD PACK index to read/write (device Pack 1 = 0). Default 0.
   *
   * Before the 2026-07-16 pack-addressing fix this was not a parameter at all:
   * the fileId's pack byte was hardcoded, so every transfer this server made
   * addressed Pack 1 regardless of which pack the front panel had selected.
   * Read the card's packs by name with `readPackDirectory` (packDirectory.ts).
   */
  pack?: number;
  /** READ_INIT / per-chunk data wait, ms (download). Default 5000. */
  responseTimeoutMs?: number;
  /** Per-ACK wait, ms (upload). Default 4000. */
  ackTimeoutMs?: number;
  /** Multiplier for the fixed inter-frame settle sleeps. Default 1. */
  sleepScale?: number;
  /**
   * Settle delay (ms) after each acked WRITE_DATA block before the next ~9 KB
   * frame is sent, so the device's flash write commits and its SysEx buffer
   * drains between blocks — prevents buffer overrun / watchdog reboot on the
   * 20-block burst (Circuit restart-research H6). Scaled by `sleepScale`.
   * Default 25.
   */
  interBlockMs?: number;
  /**
   * Force-reconnect the handle and return a FRESH one. When a transfer hits a
   * handle-level fault (stale/dead handle, RtMidi throw, port closed), the
   * driver calls this once and retries the whole transfer on the fresh handle,
   * so the user never has to run reconnect_midi by hand. A no-ACK (device-level)
   * does NOT trigger it. Omit (e.g. offline mock tests) to disable auto-recovery.
   */
  reconnect?: () => MidiConnection;
  /**
   * After the plan's final CLOSE, wait up to this many ms for the device's
   * post-CLOSE flash-commit notification (group 0x08, subcmd 0x00) before
   * returning ok, and keep the port open until it arrives. REQUIRED for SAMPLE
   * uploads: the Circuit takes ~6-8s to flush the pack sample manifest to flash
   * after CLOSE, and tearing down before it arrives leaves the slots empty
   * (decoded from two Components captures, 2026-06-23; CLOSE→commit measured at
   * 6.3s and 7.4s). When set, the success-path CLOSE is sent once and the
   * `finally` does NOT re-close. Omit (projects) for the legacy fire-and-return.
   */
  awaitCommitMs?: number;
  /**
   * Send CLOSE exactly ONCE, matching Novation Components (both "Send samples"
   * captures send OPEN×1 + CLOSE×1, opening cold). Skips the pre-OPEN reset CLOSE
   * and suppresses the `finally`'s second CLOSE on the success path. Our default
   * (projects) sends CLOSE up to 3× (pre-reset + plan + finally); for SAMPLE
   * uploads those extra closes around the device's multi-second flush appear to
   * strand the file-transfer session (device stuck in the upload/download display,
   * no commit). The `finally` still closes on a FAILED/aborted transfer.
   */
  singleClose?: boolean;
}

// Pre-flight + in-transfer liveness check. A multi-block transfer must NEVER be
// started on, or continued through, a dead/poisoned handle: a send that throws
// (or silently sets lastSendError) mid-transfer leaves the device half-written
// and can watchdog-reboot it (the 2026-06-20 incident). This is the headline
// guard; it sits where the device actually gets hurt, unlike the connection
// canary (ensureConnection, Layer A) which fires once before any byte of THIS
// call. Generalized 2026-07-09 (BK-097 Phase A): this used to be a private
// copy of the same check; now both this pre-flight AND the acquire-time
// canary share `isHandleHealthy` (server-shared/handleHealth.ts), so a fix to
// one signal (e.g. the slowSendSuspect stretch goal) reaches both call sites.
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Read how many PACKS the card holds, from the device's `0b 02` DIR_CONTROL
 * reply (`F0 …03 0b 02 <COUNT> F7`). Returns 0 if unread.
 *
 * SETTLED 2026-07-16 — this byte is the pack COUNT. The 2026-06-28 review had
 * FALSIFIED the original "active pack index" theory (the byte was invariant `01`
 * while working Components frames wrote pack byte `0`) but could not say what it
 * WAS, and left this probe waiting on "a clean 2+-pack capture". That capture
 * existed on disk the whole time:
 *
 *   - `send-pack-to-circuit-tracks-pack-2-*.pcapng`  → `0b 02 01`, card had 1 pack
 *   - `…-single-sample-…-pack-3-*.pcapng`            → `0b 02 02`, card had 2 packs
 *   - maintainer's device, 2026-07-16                → `0b 02 05`, front panel shows 5 packs
 *
 * Count, not index — which also explains the 2026-06-28 "invariant 01": that was
 * a one-pack card. The frame is the pack-directory listing HEADER
 * (`packDirectory.ts` `parsePackListHeader`); the device follows it with one
 * DIR_ENTRY per pack carrying the names.
 *
 * The pack a transfer targets is CHOSEN (the fileId's pack byte, `fileId(slot,
 * pack)`), never read back from here. There is NO known command reporting which
 * pack is ACTIVE.
 *
 * SAFE probe: sends only OPEN/0b01/0900/0b02/CLOSE — never the 0x05 dir session
 * that wipes. Prefer `readPackDirectory` (count + names + indices).
 */
export async function readPackCount(conn: MidiConnection, timeoutMs = 2000): Promise<number> {
  const inbox = attach(conn);
  try {
    conn.send(makeMessage(SUB.OPEN_SESSION));
    await sleep(120); inbox.clear();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01]));
    await sleep(40);
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00]));
    await sleep(40); inbox.clear();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02]));
    // core frame = [00 20 29 01 64 03 0b 02 <COUNT>]: subcmd at [6]=0x0b, fileType at [7]=0x02, count at [8].
    const reply = await inbox.take((c) => c.length >= 9 && c[6] === SUB.DIR_CONTROL && c[7] === 0x02, timeoutMs);
    return reply ? (reply[8] & 0x7f) : 0;
  } catch {
    return 0; // a wire fault here just reports "unknown"
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port already gone */ }
    inbox.stop();
  }
}

/**
 * @deprecated MISNAMED + SEMANTICALLY WRONG. This never read an "active pack
 * index": the byte is the pack COUNT (see `readPackCount` above and
 * `docs/design/circuit-pack-addressing.md` §3). Kept only as a compatibility
 * shim; call `readPackCount`, or `packDirectory.ts` `readPackDirectory` for the
 * count PLUS every pack's name and 0-based index.
 *
 * There is NO known command that reports which pack is ACTIVE. Do not
 * reintroduce one on this frame.
 */
export const readActivePackIndex = readPackCount;

/**
 * Drive an ordered {@link UploadFrame} plan onto the wire with the full
 * reboot-safety contract: pre-flight liveness, session reset, per-send abort,
 * ACK-or-settle per frame, and an always-close `finally`. Shared by every
 * file-transfer WRITE (projects and samples) so the hardened guard lives in ONE
 * place. Returns `{ ok }` or `{ ok:false, error }`; never throws on a wire fault.
 */
export async function runUploadFramePlan(
  conn: MidiConnection, frames: UploadFrame[], opts: TransferOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  // Recover ONLY from a handle-level fault (stale/dead handle), and only when a
  // reconnect is available. A no-ACK (device busy / wrong view) is NOT a handle
  // fault — retrying it on a fresh handle would just fail again, so we don't.
  // `withReconnectRetry` (server-shared/handleHealth.ts) is the shared R2
  // mechanism this used to hand-roll: reconnect + retry the WHOLE transfer
  // ONCE on the fresh handle, never more.
  const r = await withReconnectRetry(conn, (c) => runFramePlanOnce(c, frames, opts), {
    reconnect: opts.reconnect,
    settleMs: 200 * (opts.sleepScale ?? 1),
  });
  // Layer B (connection-canary.md correction): the write path's every outcome
  // is a real ack-or-not answer (never a "legitimate empty slot" exemption
  // like the read path below), so every result participates in the shared
  // staleness counter, matching how AM4's write path already feeds it.
  // Shared by both project AND sample uploads (both call this function), so
  // this one recordAckOutcome call generalizes staleness participation for
  // the whole Circuit file-transfer surface.
  recordAckOutcome(r.ok, CIRCUIT_LABEL);
  return { ok: r.ok, error: r.error };
}

/**
 * One attempt at the frame plan with the full reboot-safety contract: pre-flight
 * liveness, session reset, per-send abort, ACK-or-settle per frame, always-close
 * `finally`. `staleFault` flags a HANDLE-level failure (vs a device no-ACK) so
 * the caller knows a reconnect-and-retry is worth it. Never throws on a wire fault.
 */
async function runFramePlanOnce(
  conn: MidiConnection, frames: UploadFrame[], opts: TransferOptions = {},
): Promise<{ ok: boolean; error?: string; staleFault?: boolean }> {
  const ackTimeout = opts.ackTimeoutMs ?? 4000;
  const ss = opts.sleepScale ?? 1;
  const interBlockMs = opts.interBlockMs ?? 25;
  const inbox = attach(conn);
  let started = false; // true once we've sent into a session that finally must close
  let closedCleanly = false; // true once the success-path CLOSE + commit-wait ran (finally must NOT re-close)
  try {
    // Pre-flight: refuse to start a multi-block write on a handle we can't verify.
    // Return BEFORE setting `started`, so the finally never touches a handle we
    // just refused (don't send a close into a dead/closed port).
    const pf = isHandleHealthy(conn);
    if (!pf.ok) return { ok: false, error: `refused to start transfer: ${pf.reason}`, staleFault: true };
    started = true;
    // Reset any half-open session, then run the frame plan. Every send is
    // wrapped: a throw (or a silently-set lastSendError) ABORTS at that block
    // instead of firing the remaining frames into a dead port. `singleClose`
    // (sample uploads) opens COLD like Components — no pre-OPEN reset CLOSE.
    if (!opts.singleClose) {
      try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch (e) {
        return { ok: false, error: `send failed on session reset: ${errMsg(e)}`, staleFault: true };
      }
    }
    await sleep(200 * ss); inbox.clear();
    for (const f of frames) {
      // H8: drain any stale/duplicate reply before an ACK-gated send, so a late
      // ACK for the previous block can't be consumed as THIS frame's ACK.
      if (f.ack) inbox.clear();
      try { conn.send(f.bytes); } catch (e) {
        return { ok: false, error: `send failed at ${f.label}: ${errMsg(e)} (aborted; device left mid-transfer; power-cycle if it acts up)`, staleFault: true };
      }
      if (conn.lastSendError) {
        return { ok: false, error: `send error after ${f.label}: ${conn.lastSendError.message} (aborted before completing)`, staleFault: true };
      }
      const isClose = f.bytes[1 + HDR.length] === SUB.CLOSE_SESSION;
      if (opts.singleClose && isClose && !opts.awaitCommitMs) {
        // The plan's CLOSE is the ONLY close (Components-faithful). Mark it so the
        // `finally` does not fire a second one into the device's flush.
        closedCleanly = true;
        await sleep(120 * ss); inbox.clear();
      } else if (opts.awaitCommitMs && isClose) {
        // SAMPLE upload: this is the plan's final CLOSE. The device now flushes
        // the pack sample manifest to flash (~6-8s) and then sends the group-0x08
        // commit notification. Block on it with the port OPEN — returning early
        // (the legacy path) leaves every slot empty. The `finally` must not
        // re-close, so mark the session closed cleanly here.
        inbox.clear();
        const done = await inbox.take(isCommitDone, opts.awaitCommitMs);
        closedCleanly = true;
        if (!done) {
          return { ok: false, error: `no post-CLOSE commit signal within ${opts.awaitCommitMs}ms; the device's flash flush did not complete, so samples may not have persisted. Retry; if it persists, power-cycle the device.` };
        }
      } else if (f.ack) {
        const ok = await inbox.take(isAck, ackTimeout);
        if (!ok) {
          // A SET_FILENAME no-ACK is the device REJECTING the slot registration
          // (it replied with the empty-slot record 0x05 00…, not an 0x04 ACK):
          // the pack's sample directory is uninitialized. Make this loud instead
          // of the old "all acked" false success (decoded 2026-06-27).
          if (f.label.startsWith('set_filename')) {
            return { ok: false, error: `${f.label}: device rejected the slot registration; the pack's sample directory is UNINITIALIZED (empty pack). Sample data was sent but no directory entry was created, so it will not play. Initialize/load the pack in Novation Components first, then re-upload.` };
          }
          // H1: a no-ACK on a fresh handle is almost always the device being BUSY
          // (playing) or another app holding the exclusive MIDI port — not a wire
          // fault. The device documents that it silently ignores SysEx while busy.
          return { ok: false, error: `no ACK for ${f.label}; the Circuit did not accept the transfer. Stop playback on the device (a playing Circuit ignores transfer messages) and make sure no other app holds its MIDI port, then retry.` };
        }
        // H6: pace the burst — settle after each acked block so the device's flash
        // write commits and its SysEx buffer drains before the next ~9 KB frame,
        // preventing a buffer overrun / watchdog reboot mid-transfer.
        if (interBlockMs > 0) await sleep(interBlockMs * ss);
      } else {
        await sleep(120 * ss); inbox.clear();
      }
    }
    return { ok: true };
  } finally {
    // ALWAYS close the transfer session once we've started one, even on an
    // early-return (a missing ACK) or throw, so a failed/aborted transfer never
    // strands the device. Skip it when pre-flight refused (no session opened) OR
    // when the success path already sent the single CLOSE + commit-wait (a second
    // CLOSE fired into the device's multi-second flush is what the working
    // Components capture never does).
    if (started && !closedCleanly) { try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port already gone */ } }
    inbox.stop();
  }
}

/**
 * Upload a 160,780-byte project to `slot` (0..63) of `opts.pack` (0-based
 * microSD pack index; device Pack 1 = 0, the default and the only pack this
 * path could reach before the 2026-07-16 pack-addressing fix).
 * Requires a bidirectional conn (hasInput).
 */
export async function uploadProject(
  conn: MidiConnection, ncs: Uint8Array, slot: number, opts: TransferOptions = {},
): Promise<UploadResult> {
  // STRUCTURAL GATE, not just a length check. This is the last point before the
  // bytes reach a device slot, and it is the point EVERY caller passes through
  // (the MCP writer, the twenty one-off patch scripts, circuit-ncs-upload-file),
  // so the gate belongs here rather than only in the tool pre-flight. The device
  // has no erase: a slot written with a de-framed blob cannot be emptied, only
  // overwritten from a good copy, and `card-backup-2026-07-27T16-49Z` proves such
  // a blob can be sitting on disk wearing a `crc_verified: true` label.
  assertNcsStructure(ncs, `refusing to upload to project slot ${slot}`);
  const frames = buildUploadFrames(ncs, slot, undefined, opts.pack ?? 0);
  const dataCount = frames.filter((f) => f.label.startsWith('write_data')).length;
  const r = await runUploadFramePlan(conn, frames, opts);
  return { ok: r.ok, slot, blocks: dataCount, error: r.error };
}

export interface DownloadResult {
  ok: boolean; slot: number; bytes?: Uint8Array; crcOk: boolean; error?: string;
  /** True when the slot held no readable project (no READ_INIT) — empty, not an error. */
  empty?: boolean;
  /**
   * Does the decoded file look like a project? INDEPENDENT of `crcOk`, and the
   * two answer different questions: `crcOk` says the TRANSFER was faithful,
   * `structureOk` says the THING transferred is a `.ncs`. The device's CRC32
   * covers the encoded stream, so a de-framing failure comes back
   * `crcOk: true, structureOk: false`, which is how a structurally corrupt
   * project ended up in a backup manifest marked verified (2026-07-29).
   *
   * Reported, never enforced here: a read of a bad slot must still hand back the
   * bytes (they are what the device holds, and a backup of them is evidence),
   * and it is the CALLER that decides whether a non-project is fatal for what it
   * is about to do. Undefined when there are no bytes to judge.
   */
  structureOk?: boolean;
  /** One line per failed structural invariant. Empty when `structureOk`. */
  structureFaults?: string[];
}

/**
 * The occupancy verdict for one project slot — the read half of the overwrite
 * gate (cf. `docs/SAFE-EDIT-WORKFLOW.md`).
 *   - `empty`    : the slot has no stored project; safe to write without asking.
 *   - `occupied` : a project is stored here; `name` is its embedded name.
 *   - `unknown`  : the read itself failed, so occupancy could NOT be confirmed;
 *                  the gate treats this as "ask before clobbering", not a write.
 */
export type SlotProbe =
  | { status: 'empty' }
  | { status: 'occupied'; name: string }
  | { status: 'unknown'; error: string };

/** Project name lives at offset 0x10, 16 ASCII bytes, space-padded (matches reader.ts). */
function decodeProjectName(buf: Uint8Array): string {
  let s = '';
  for (let i = 0x10; i < 0x20; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s.replace(/[^\x20-\x7e]/g, '').trimEnd();
}

/**
 * Probe a project slot's occupancy for the overwrite gate. Reuses the hardened,
 * always-close {@link downloadProject} (so an empty-slot read can never strand
 * the device), then reports empty / occupied(+name) / unknown(read failed). A
 * CRC mismatch still answers "occupied" — a partial read is enough to know
 * something is there, and the gate only needs occupied-vs-empty, not the body.
 */
export async function probeProjectSlot(
  conn: MidiConnection, slot: number, opts: TransferOptions = {},
): Promise<SlotProbe> {
  const dl = await downloadProject(conn, slot, opts);
  if (dl.empty) return { status: 'empty' };
  if (dl.bytes && dl.bytes.length >= 0x20) return { status: 'occupied', name: decodeProjectName(dl.bytes) };
  return { status: 'unknown', error: dl.error ?? 'slot read returned no data' };
}

/**
 * Download a stored project from `slot`. Read-only; verifies the device CRC.
 * Auto-reconnects + retries ONCE on a handle-level fault (the stale-handle the
 * caller hit when a cached handle died between calls). An empty slot or a CRC
 * mismatch is NOT a handle fault and is returned as-is.
 */
export async function downloadProject(
  conn: MidiConnection, slot: number, opts: TransferOptions = {},
): Promise<DownloadResult> {
  const r = await withReconnectRetry(conn, (c) => downloadOnce(c, slot, opts), {
    reconnect: opts.reconnect,
    settleMs: 200 * (opts.sleepScale ?? 1),
  });
  // Layer B (connection-canary.md correction): a missing READ_INIT is a
  // LEGITIMATE empty-slot answer, not a dead handle: it must NOT feed the
  // shared staleness counter (recordAckOutcome), or an ordinary "check if
  // this slot is free" read would look identical to a stale handle after a
  // couple of calls. Every OTHER read outcome (success, CRC mismatch, a real
  // handle-level staleFault) DOES participate, same as the write path.
  if (!r.empty) recordAckOutcome(r.ok, CIRCUIT_LABEL);
  return r;
}

async function downloadOnce(
  conn: MidiConnection, slot: number, opts: TransferOptions = {},
): Promise<DownloadResult & { staleFault?: boolean }> {
  const wait = opts.responseTimeoutMs ?? 5000;
  const ss = opts.sleepScale ?? 1;
  const pack = opts.pack ?? 0;
  const fid = fileId(slot, pack);
  const inbox = attach(conn);
  let started = false; // true once we've sent into a session that finally must close
  try {
    // Pre-flight: never drive the session state machine on a handle we can't
    // verify (an aborted read strands the session and correlated with reboots).
    const pf = isHandleHealthy(conn);
    if (!pf.ok) return { ok: false, slot, crcOk: false, error: `refused to start read: ${pf.reason}`, staleFault: true };
    started = true;
    // Reset any half-open session left by a prior aborted transfer, else the
    // device ignores OPEN_SESSION and never sends READ_INIT. Wrap the handshake
    // sends: a throw mid-handshake aborts cleanly (finally still closes).
    try {
      conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(200 * ss); inbox.clear();
      conn.send(makeMessage(SUB.OPEN_SESSION)); await sleep(300 * ss); inbox.clear();
      conn.send(makeMessage(SUB.DIR_CONTROL, [0x01])); await sleep(100 * ss); inbox.clear();
      conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00])); await sleep(100 * ss); inbox.clear();
      conn.send(makeMessage(SUB.DIR_CONTROL, [0x02])); await sleep(100 * ss); inbox.clear();
      // Scope the session to THIS pack's project directory (2026-07-16: the
      // second byte is the 0-based pack, not a constant — see transfer.ts fileId).
      //
      // HARDENING TODO (occupancy pre-check): this dir-listing response is still
      // DRAINED. Decoding it would tell us which slots are occupied BEFORE we
      // issue the per-slot read below — so we'd never ask the firmware to dump a
      // non-existent project (the empty-slot read that stranded the device on
      // 2026-06-20). The "needs a capture" note here is now STALE: the reply IS
      // decoded — `sampleDirectory.ts` `parseDirListHeader` / `parseDirEntry`
      // read exactly this exchange byte-exact for fileType 0x03 (project, count
      // 52 confirmed). Wiring it in is plumbing, not RE. Until then the
      // always-close `finally` keeps an empty-slot read safe.
      conn.send(makeMessage(SUB.DIR_CONTROL, [0x03, pack & 0x7f])); await sleep(500 * ss); inbox.clear();
      conn.send(makeMessage(SUB.WRITE_INIT, [...blockAddress(0), ...fid, 0x02]));
    } catch (e) {
      return { ok: false, slot, crcOk: false, error: `send failed during read handshake: ${errMsg(e)} (aborted; finally closes the session)`, staleFault: true };
    }
    const init = await inbox.take((c) => c[HDR.length] === SUB.WRITE_INIT && c.length >= HDR.length + 1 + 8 + 3 + 4 + 5, wait);
    // No READ_INIT = the slot holds no readable project. Report it as EMPTY, not
    // an error — and let `finally` close the session (the device must not be left
    // mid-read on a slot it had nothing to send for).
    if (!init) {
      return { ok: false, slot, crcOk: false, empty: true, error: `slot ${slot} holds no readable project (empty slot, no READ_INIT response)` };
    }

    const raw: number[] = [];
    let crcRx: number | undefined;
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const m = await inbox.take((c) => c[HDR.length] === SUB.WRITE_DATA || c[HDR.length] === SUB.WRITE_FINISH, wait);
      if (!m) break;
      if (m[HDR.length] === SUB.WRITE_DATA) raw.push(...msbDeinterleave(m.slice(HDR.length + 1 + 8 + 3)));
      else { crcRx = nibblesToInt(m.slice(HDR.length + 1 + 8 + 3, HDR.length + 1 + 8 + 3 + 8)); break; }
    }
    const bytes = Uint8Array.from(raw.slice(0, NCS_FILE_SIZE));
    const structure = checkNcsStructure(bytes);
    return {
      ok: bytes.length === NCS_FILE_SIZE, slot, bytes, crcOk: crcRx === crc32(bytes),
      structureOk: structure.ok, structureFaults: structure.faults,
    };
    // Session close happens in `finally` — one close path for success and every
    // early-return/throw, so the device is never stranded mid-transfer.
  } finally {
    // ALWAYS close once a session was started, even when the read bailed early
    // (e.g. 'no READ_INIT' on an empty slot) or threw. Skip when pre-flight
    // refused — don't send a close into a handle we just declined to use.
    if (started) { try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port already gone */ } }
    inbox.stop();
  }
}
