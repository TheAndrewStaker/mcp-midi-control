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
import { NCS_FILE_SIZE } from './format.js';
import {
  blockAddress, buildUploadFrames, crc32, fileId, makeMessage, msbDeinterleave, TRANSFER_CONSTANTS,
  type UploadFrame,
} from './transfer.js';

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

/**
 * Pre-flight + in-transfer liveness check. A multi-block transfer must NEVER be
 * started on, or continued through, a dead/poisoned handle: a send that throws
 * (or silently sets lastSendError) mid-transfer leaves the device half-written
 * and can watchdog-reboot it (the 2026-06-20 incident). This is the headline
 * guard — it sits where the device actually gets hurt, unlike the connection
 * canary which fires once before any byte. HONEST LIMIT: isPortOpen() is a
 * negative catch only and cannot see a synchronous-BLOCKED send (which never
 * returns and sets no error); that path stays unhandled here.
 */
function handleHealth(conn: MidiConnection): { ok: boolean; reason?: string } {
  if (conn.isPortOpen && !conn.isPortOpen()) {
    return { ok: false, reason: 'MIDI port is not open (device unplugged or handle closed)' };
  }
  if (conn.lastSendError) {
    return { ok: false, reason: `connection handle is in an error state (${conn.lastSendError.message})` };
  }
  return { ok: true };
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Read the byte the device returns in its `0b 02` DIR_CONTROL reply
 * (`F0 …03 0b 02 <IDX> F7`). It was HYPOTHESIZED to be the active pack index that
 * must ride in every sample frame, but the 2026-06-28 review FALSIFIED that: in the
 * repo's `_web`/`_our` capture pair this byte is invariant (`01`) while working
 * Components writes pack byte `0` in its frames — so the device does NOT copy it,
 * and this is more likely a count/status than an index. NOT wired into the upload
 * path (uploadSample/Kit write pack byte 0, Components-proven); kept as a SAFE probe
 * (sends only OPEN/0b01/0900/0b02/CLOSE — never the 0x05 dir session that wipes) for
 * when a clean 2+-pack capture settles what this byte means. Returns 0 if unread.
 */
export async function readActivePackIndex(conn: MidiConnection, timeoutMs = 2000): Promise<number> {
  const inbox = attach(conn);
  try {
    conn.send(makeMessage(SUB.OPEN_SESSION));
    await sleep(120); inbox.clear();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01]));
    await sleep(40);
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00]));
    await sleep(40); inbox.clear();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02]));
    // core frame = [00 20 29 01 64 03 0b 02 <IDX>]: subcmd at [6]=0x0b, arg at [7]=0x02, index at [8].
    const reply = await inbox.take((c) => c.length >= 9 && c[6] === SUB.DIR_CONTROL && c[7] === 0x02, timeoutMs);
    return reply ? (reply[8] & 0x7f) : 0;
  } catch {
    return 0; // a wire fault here just falls back to legacy pack-0 behavior
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port already gone */ }
    inbox.stop();
  }
}

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
  const first = await runFramePlanOnce(conn, frames, opts);
  // Recover ONLY from a handle-level fault (stale/dead handle), and only when a
  // reconnect is available. A no-ACK (device busy / wrong view) is NOT a handle
  // fault — retrying it on a fresh handle would just fail again, so we don't.
  if (first.ok || !first.staleFault || !opts.reconnect) {
    return { ok: first.ok, error: first.error };
  }
  await sleep(200 * (opts.sleepScale ?? 1)); // let the dying port settle before reopening
  let fresh: MidiConnection;
  try {
    fresh = opts.reconnect();
  } catch (e) {
    return { ok: false, error: `${first.error}; auto-reconnect also failed (${errMsg(e)}); call reconnect_midi and retry.` };
  }
  // Retry the WHOLE transfer once on the fresh handle. Disable a second retry.
  const second = await runFramePlanOnce(fresh, frames, { ...opts, reconnect: undefined });
  if (second.ok) return { ok: true };
  return { ok: false, error: `${second.error} (auto-reconnected and retried once; still failed; check the device is powered and the cable seated)` };
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
    const pf = handleHealth(conn);
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

/** Upload a 160,780-byte project to `slot` (0..63). Requires a bidirectional conn (hasInput). */
export async function uploadProject(
  conn: MidiConnection, ncs: Uint8Array, slot: number, opts: TransferOptions = {},
): Promise<UploadResult> {
  if (ncs.length !== NCS_FILE_SIZE) throw new RangeError(`.ncs must be ${NCS_FILE_SIZE} bytes, got ${ncs.length}`);
  const frames = buildUploadFrames(ncs, slot);
  const dataCount = frames.filter((f) => f.label.startsWith('write_data')).length;
  const r = await runUploadFramePlan(conn, frames, opts);
  return { ok: r.ok, slot, blocks: dataCount, error: r.error };
}

export interface DownloadResult {
  ok: boolean; slot: number; bytes?: Uint8Array; crcOk: boolean; error?: string;
  /** True when the slot held no readable project (no READ_INIT) — empty, not an error. */
  empty?: boolean;
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
  const first = await downloadOnce(conn, slot, opts);
  if (first.ok || first.empty || !first.staleFault || !opts.reconnect) return first;
  await sleep(200 * (opts.sleepScale ?? 1)); // let the dying port settle before reopening
  let fresh: MidiConnection;
  try {
    fresh = opts.reconnect();
  } catch (e) {
    return { ok: false, slot, crcOk: false, error: `${first.error}; auto-reconnect also failed (${errMsg(e)}); call reconnect_midi and retry.` };
  }
  return downloadOnce(fresh, slot, { ...opts, reconnect: undefined });
}

async function downloadOnce(
  conn: MidiConnection, slot: number, opts: TransferOptions = {},
): Promise<DownloadResult & { staleFault?: boolean }> {
  const wait = opts.responseTimeoutMs ?? 5000;
  const ss = opts.sleepScale ?? 1;
  const fid = fileId(slot);
  const inbox = attach(conn);
  let started = false; // true once we've sent into a session that finally must close
  try {
    // Pre-flight: never drive the session state machine on a handle we can't
    // verify (an aborted read strands the session and correlated with reboots).
    const pf = handleHealth(conn);
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
      // HARDENING TODO (occupancy pre-check): this dir-listing response is currently
      // DRAINED. Decoding it would tell us which slots are occupied BEFORE we issue
      // the per-slot read below — so we'd never ask the firmware to dump a
      // non-existent project (the empty-slot read that stranded the device on
      // 2026-06-20). The format is not yet reverse-engineered; needs a capture.
      // Until then the always-close `finally` keeps an empty-slot read safe.
      conn.send(makeMessage(SUB.DIR_CONTROL, [0x03, 0x00])); await sleep(500 * ss); inbox.clear();
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
    return { ok: bytes.length === NCS_FILE_SIZE, slot, bytes, crcOk: crcRx === crc32(bytes) };
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
