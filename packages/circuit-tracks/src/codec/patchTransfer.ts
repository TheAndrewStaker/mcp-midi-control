/**
 * Circuit Tracks synth-patch transfer (dump request → reply), I/O driver.
 *
 * This is the read half that powers patch SAVE (`writer.savePreset`) and,
 * later, structured `get_param`. It is a single request → single reply
 * exchange — NOT the multi-block file-transfer session in `ncs/transfer.ts`
 * (that moves whole .ncs projects over command group 0x03). Patch messages
 * ride the SAME 5-byte Novation/Circuit prefix but put the command byte
 * (00 Replace-Current, 01 Replace-Patch, 40 Dump-Request) directly as the 6th
 * byte, with no group/subcommand split.
 *
 * The 340-byte patch body is raw 7-bit data (every byte ≤ 0x7F per the v3
 * Programmer's Reference Guide), NOT MSB-interleaved like the file-transfer
 * payload — so the reply is sliced verbatim, no de-interleave.
 *
 * IMPORTANT: a Dump Request reads a synth part's CURRENT (RAM) buffer, not an
 * arbitrary stored Flash slot. There is no random-access stored-patch read on
 * Circuit Tracks: to read a Flash patch the device must first Program-Change it
 * into a part (a destructive load), which this module deliberately does NOT do.
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { buildProgramChange } from '@mcp-midi-control/core/midi/messages.js';
import { buildDumpRequest, buildReplaceFlashPatch, buildReplaceCurrentPatch, CMD_REPLACE_CURRENT, PATCH_BODY_LEN, type SynthLocation } from './sysex.js';
import { decodePatchName } from './blob.js';
import { makeMessage, blockAddress, msbDeinterleave, crc32, TRANSFER_CONSTANTS } from '../ncs/transfer.js';

/**
 * Map the synth `instance` (1 = Synth 1, 2 = Synth 2) to a Dump-Request
 * Location. Shared by save_preset (writer) and get_param (reader) so the two
 * stay consistent. Mirrors the instance model used by set_param (instance 1 →
 * ch1/Synth 1, 2 → ch2/Synth 2).
 */
export function instanceToSynthLoc(instance?: number): SynthLocation {
  const inst = instance ?? 1;
  if (inst === 1) return 0;
  if (inst === 2) return 1;
  throw new DispatchError(
    'capability_not_supported',
    'Novation Circuit Tracks',
    `Circuit Tracks has two synth instances (1 = Synth 1, 2 = Synth 2); instance ${inst} is not addressable.`,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Strip the F0…F7 envelope to the core bytes (manufacturer prefix onward). */
function core(msg: readonly number[]): number[] {
  let b = msg as number[];
  if (b[0] === 0xf0) b = b.slice(1);
  if (b[b.length - 1] === 0xf7) b = b.slice(0, -1);
  return b;
}

// The 5 bytes before the command byte: 00 20 29 (Novation) 01 (synth) 64 (CT).
const PREFIX = [0x00, 0x20, 0x29, 0x01, 0x64] as const;
const isFamily = (c: number[]) => c.length > 5 && PREFIX.every((h, i) => c[i] === h);

// ── Stored-patch READ over the file-transfer protocol (fileType 0x04) ─────────
// Decoded 2026-07-03 from a real Components capture: reading a Flash patch slot is
// the SAME session transport as a project download (ncs/transfer.ts), only the
// fileId's type byte differs (project 0x03, PATCH 0x04, sample 0x05). Returns the
// device's ~1876-byte patch FILE (a different, larger layout than the 340-byte
// Replace-Patch body; it starts with the 16-char patch name). This is the
// read-back path for save verification + a future patch get_preset.
const XSUB = TRANSFER_CONSTANTS.SUBCMD;
const XHDR = TRANSFER_CONSTANTS.HEADER; // [00 20 29 01 64 03] — subcmd at core[XHDR.length]
const FILE_TYPE_PATCH = 0x04;
/**
 * `[fileType, pack, slot]` — the shared fileId shape (see `ncs/transfer.ts`
 * `fileId`, `ncs/sampleDirectory.ts` `fileIdFor`). `pack` is the 0-based microSD
 * pack index (device Pack 1 = 0).
 *
 * CORRECTED 2026-07-16: this read `(slot >> 7) & 0x7f`, the septet model that
 * `docs/design/circuit-pack-addressing.md` refutes by capture. It was invisible
 * because `slot >> 7` is 0 for every legal slot 0..63, so it emitted a correct
 * pack-0 byte while pinning every patch read to Pack 1.
 */
const patchFileId = (slot: number, pack = 0) => [FILE_TYPE_PATCH, pack & 0x7f, slot & 0x7f];
const nibblesToInt = (ns: number[]) => ns.reduce((a, n) => a * 16 + (n & 0xf), 0) >>> 0;

export interface StoredPatchResult {
  ok: boolean;
  /** The de-interleaved patch FILE (~1876 bytes); name is bytes 0-15. */
  bytes?: Uint8Array;
  crcOk?: boolean;
  name?: string;
  /** True when the slot held no patch (no READ_INIT reply). */
  empty?: boolean;
  error?: string;
}

/**
 * Read a STORED synth patch from a Flash slot (0..63) via the file-transfer READ
 * (fileType 0x04). Mirrors the hardware-confirmed project download handshake in
 * ncs/uploadProject.ts, with the patch fileId. Read-only; always closes the
 * session. Needs a bidirectional connection.
 */
export async function readStoredPatch(
  conn: MidiConnection, slot: number, opts: { responseTimeoutMs?: number } = {},
): Promise<StoredPatchResult> {
  const wait = opts.responseTimeoutMs ?? 5000;
  if (conn.isPortOpen && !conn.isPortOpen()) return { ok: false, error: 'MIDI port is not open' };
  const buf: number[][] = [];
  const unsub = conn.onMessage((m: number[]) => { const c = core(m); if (isFamily(c)) buf.push(c); });
  const take = async (pred: (c: number[]) => boolean, timeoutMs: number): Promise<number[] | undefined> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const i = buf.findIndex(pred);
      if (i >= 0) { const m = buf[i]; buf.splice(0, i + 1); return m; }
      await sleep(3);
    }
    return undefined;
  };
  const isSub = (c: number[], sub: number) => c[5] === 0x03 && c[XHDR.length] === sub;
  let started = false;
  try {
    // Reset any half-open session, then the EXACT patch-read handshake decoded
    // from components-patch-change.pcapng: OPEN, DIR(01), QUERY(01 00),
    // QUERY(01 01), DIR(02), then WRITE_INIT(read). (Differs from the project
    // download: two QUERY_INFO and NO dir-listing before WRITE_INIT.)
    conn.send(makeMessage(XSUB.CLOSE_SESSION)); await sleep(200); buf.length = 0;
    started = true;
    conn.send(makeMessage(XSUB.OPEN_SESSION)); await sleep(250); buf.length = 0;
    conn.send(makeMessage(XSUB.DIR_CONTROL, [0x01])); await sleep(60); buf.length = 0;
    conn.send(makeMessage(XSUB.QUERY_INFO, [0x01, 0x00])); await sleep(60); buf.length = 0;
    conn.send(makeMessage(XSUB.QUERY_INFO, [0x01, 0x01])); await sleep(60); buf.length = 0;
    conn.send(makeMessage(XSUB.DIR_CONTROL, [0x02])); await sleep(100); buf.length = 0;
    conn.send(makeMessage(XSUB.WRITE_INIT, [...blockAddress(0), ...patchFileId(slot), 0x02]));
    const init = await take((c) => isSub(c, XSUB.WRITE_INIT) && c.length >= XHDR.length + 1 + 8 + 3, wait);
    if (!init) return { ok: false, empty: true, error: `slot ${slot} returned no READ_INIT (empty slot?)` };
    const raw: number[] = [];
    let crcRx: number | undefined;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const m = await take((c) => isSub(c, XSUB.WRITE_DATA) || isSub(c, XSUB.WRITE_FINISH), wait);
      if (!m) break;
      if (isSub(m, XSUB.WRITE_DATA)) raw.push(...msbDeinterleave(m.slice(XHDR.length + 1 + 8 + 3)));
      else { crcRx = nibblesToInt(m.slice(XHDR.length + 1 + 8 + 3, XHDR.length + 1 + 8 + 3 + 8)); break; }
    }
    const bytes = Uint8Array.from(raw);
    let name = '';
    for (let i = 0; i < 16 && i < bytes.length; i++) name += String.fromCharCode(bytes[i] & 0x7f);
    return {
      ok: bytes.length > 0,
      bytes,
      crcOk: crcRx !== undefined && crcRx === crc32(bytes),
      name: name.replace(/[\s]+$/u, ''),
    };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  } finally {
    if (started) { try { conn.send(makeMessage(XSUB.CLOSE_SESSION)); } catch { /* port gone */ } }
    unsub();
  }
}

export interface SavePatchResult { ok: boolean; committed: boolean; error?: string }

/**
 * Save a 340-byte patch body to a Flash slot (Replace-Patch), WRAPPED IN A
 * FILE-TRANSFER SESSION exactly as Novation Components does (decoded from
 * components-patch-save.pcapng, 2026-07-03): OPEN → DIR/QUERY handshake → CLOSE
 * → WAIT for the device's post-CLOSE `0x08` session ack → then Replace-Patch.
 *
 * A bare Replace-Patch (no session) is silently DROPPED by the device — the
 * flash write is only accepted in the just-closed-session state. The device
 * emits the `0x08` ~within tens of ms of the CLOSE; the save follows it by ~3ms
 * in the capture.
 */
export async function savePatch(
  conn: MidiConnection, body: readonly number[], slot: number, opts: { responseTimeoutMs?: number } = {},
): Promise<SavePatchResult> {
  const wait = opts.responseTimeoutMs ?? 2000;
  if (conn.isPortOpen && !conn.isPortOpen()) return { ok: false, committed: false, error: 'MIDI port is not open' };
  const buf: number[][] = [];
  const unsub = conn.onMessage((m: number[]) => { const c = core(m); if (isFamily(c)) buf.push(c); });
  const take = async (pred: (c: number[]) => boolean, timeoutMs: number): Promise<number[] | undefined> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const i = buf.findIndex(pred);
      if (i >= 0) { const m = buf[i]; buf.splice(0, i + 1); return m; }
      await sleep(3);
    }
    return undefined;
  };
  const is08 = (c: number[]) => c[5] === 0x08; // device session/commit ack (group 0x08)
  try {
    // Establish the editor-connected session (same handshake as a read).
    conn.send(makeMessage(XSUB.CLOSE_SESSION)); await sleep(150); buf.length = 0;
    conn.send(makeMessage(XSUB.OPEN_SESSION)); await sleep(150); buf.length = 0;
    conn.send(makeMessage(XSUB.DIR_CONTROL, [0x01])); await sleep(60);
    conn.send(makeMessage(XSUB.QUERY_INFO, [0x01, 0x00])); await sleep(60);
    conn.send(makeMessage(XSUB.QUERY_INFO, [0x01, 0x01])); await sleep(60);
    conn.send(makeMessage(XSUB.DIR_CONTROL, [0x02])); await sleep(80); buf.length = 0;
    // Read the 16-slot PAGE containing the target (Components browses the bank
    // page before a save).
    const pageStart = Math.floor(slot / 16) * 16;
    for (let s = pageStart; s < pageStart + 16; s++) {
      conn.send(makeMessage(XSUB.WRITE_INIT, [...blockAddress(0), ...patchFileId(s), 0x02]));
      await sleep(45); buf.length = 0; // drain the reply (data for occupied, sub06 for empty)
    }
    // CLOSE, then wait for the device's post-CLOSE 0x08 ack.
    conn.send(makeMessage(XSUB.CLOSE_SESSION));
    const ack = await take(is08, wait);
    // CLEAN the body: byte 17 (patch-file offset 17 / frame offset 28) is the
    // device's "dirty edit-buffer" marker. Every PERSISTED Components save carries
    // body[17]=0x00; a dump of the LIVE buffer carries 0x01, and the device refuses
    // to commit a dirty body (7-agent capture review, 2026-07-03, byte-cited on 4/4).
    const clean = Array.from(body);
    clean[17] = 0x00;
    // FIRE-AND-FORGET: the Replace-Patch is the LAST thing on the wire. Components
    // sends nothing after it and the device commits SILENTLY (no ack on success);
    // opening any session afterward (e.g. a verify read) aborts the flash commit.
    conn.send(buildReplaceFlashPatch(clean, slot));
    const sendErr = conn.lastSendError ? conn.lastSendError.message : undefined;
    await sleep(300); // brief settle; do NOT open another session
    return { ok: sendErr === undefined, committed: ack !== undefined, error: sendErr };
  } catch (e) {
    return { ok: false, committed: false, error: errMsg(e) };
  } finally {
    unsub();
  }
}

export interface StoredPatchViaLoad { ok: boolean; body?: number[]; name?: string; error?: string }

/**
 * Read a STORED bank patch (slot 0..63) by LOADING it into the working buffer via
 * a Program Change on the synth channel, then dumping. Unlike readStoredPatch
 * (which reads the pack's sparse FILE store and cannot see a save_preset'd bank
 * patch), this reads the actual synth PATCH BANK — the same store save_preset
 * writes — and returns the full 340-byte body (name + all patch-dump params).
 * HARDWARE-CONFIRMED 2026-07-03: PC to an occupied slot loads it (freshly-saved
 * PROBE85 read back from slots 62/63); PC to an EMPTY slot loads nothing.
 *
 * DESTRUCTIVE to the working buffer. By default we dump the current buffer first
 * and Replace-Current it back afterward, so a live edit is preserved; pass
 * restore=false to skip (leaves the loaded patch in the buffer).
 */
export async function readStoredPatchViaLoad(
  conn: MidiConnection, slot: number, opts: { instance?: number; restore?: boolean } = {},
): Promise<StoredPatchViaLoad> {
  if (!Number.isInteger(slot) || slot < 0 || slot > 63) return { ok: false, error: `patch slot must be 0..63, got ${slot}` };
  if (conn.isPortOpen && !conn.isPortOpen()) return { ok: false, error: 'MIDI port is not open' };
  const loc = instanceToSynthLoc(opts.instance);
  // Back the live buffer up so the load is non-destructive to an unsaved edit.
  let backup: number[] | undefined;
  if (opts.restore !== false) {
    const cur = await readCurrentPatch(conn, loc, {});
    if (cur.ok && cur.body) backup = Array.from(cur.body);
  }
  // Load the target slot into the working buffer (PC on the synth channel), dump it.
  conn.send(buildProgramChange(loc, slot));
  await sleep(250);
  const read = await readCurrentPatch(conn, loc, {});
  // Restore the prior buffer (best-effort — a failed restore just leaves the loaded patch).
  if (backup) { try { conn.send(buildReplaceCurrentPatch(backup, loc)); await sleep(120); } catch { /* leave loaded */ } }
  if (!read.ok || !read.body) return { ok: false, error: read.error ?? 'no reply after loading the slot' };
  const body = Array.from(read.body);
  return { ok: true, body, name: decodePatchName(body) };
}

/** Reply core layout: [..PREFIX(5), cmd, loc, reserved, ...340 body]. */
const BODY_OFFSET = PREFIX.length + 3; // cmd + loc + reserved

export interface PatchReadResult {
  ok: boolean;
  loc: SynthLocation;
  /** The 340 raw patch-body bytes (name at 0-15), present only when ok. */
  body?: Uint8Array;
  error?: string;
}

export interface PatchReadOptions {
  /** Reply wait, ms. Default 2000 (the device answers in tens of ms when ready). */
  responseTimeoutMs?: number;
  /**
   * Force-reconnect + return a FRESH handle on a handle-level fault (stale/dead
   * handle), then retry once — same recovery contract as the .ncs transfer.
   * Omit (offline tests) to disable.
   */
  reconnect?: () => MidiConnection;
}

/**
 * Read a synth part's CURRENT (RAM) patch via a Dump Request. Sends
 * `F0…64 40 <loc> F7`; the device replies on USB with a Replace-Current-Patch
 * message (`F0…64 00 <loc> 00 <340> F7`), Location echoing the request. Returns
 * the 340 raw body bytes. Auto-reconnects + retries ONCE on a handle fault.
 */
export async function readCurrentPatch(
  conn: MidiConnection, loc: SynthLocation, opts: PatchReadOptions = {},
): Promise<PatchReadResult> {
  const first = await readOnce(conn, loc, opts);
  if (first.ok || !first.staleFault || !opts.reconnect) return strip(first);
  await sleep(200); // let the dying port settle before reopening
  let fresh: MidiConnection;
  try {
    fresh = opts.reconnect();
  } catch (e) {
    return { ok: false, loc, error: `${first.error}; auto-reconnect also failed (${errMsg(e)}); call reconnect_midi and retry.` };
  }
  return strip(await readOnce(fresh, loc, { ...opts, reconnect: undefined }));
}

const strip = (r: PatchReadResult & { staleFault?: boolean }): PatchReadResult =>
  ({ ok: r.ok, loc: r.loc, body: r.body, error: r.error });

async function readOnce(
  conn: MidiConnection, loc: SynthLocation, opts: PatchReadOptions,
): Promise<PatchReadResult & { staleFault?: boolean }> {
  const wait = opts.responseTimeoutMs ?? 2000;
  if (conn.isPortOpen && !conn.isPortOpen()) {
    return { ok: false, loc, error: 'MIDI port is not open (device unplugged or handle closed)', staleFault: true };
  }
  // Register the inbound handler BEFORE sending, then poll the buffer — avoids the
  // register-after-send race (the reply can arrive in tens of ms).
  const buf: number[][] = [];
  const unsub = conn.onMessage((m: number[]) => { const c = core(m); if (isFamily(c)) buf.push(c); });
  try {
    try {
      conn.send(buildDumpRequest(loc));
    } catch (e) {
      return { ok: false, loc, error: `send failed on dump request: ${errMsg(e)}`, staleFault: true };
    }
    if (conn.lastSendError) {
      return { ok: false, loc, error: `send error after dump request: ${conn.lastSendError.message}`, staleFault: true };
    }
    const end = Date.now() + wait;
    while (Date.now() < end) {
      const i = buf.findIndex(
        (c) => c[PREFIX.length] === CMD_REPLACE_CURRENT && c[PREFIX.length + 1] === loc && c.length >= BODY_OFFSET + PATCH_BODY_LEN,
      );
      if (i >= 0) {
        const body = Uint8Array.from(buf[i].slice(BODY_OFFSET, BODY_OFFSET + PATCH_BODY_LEN));
        return { ok: true, loc, body };
      }
      await sleep(3);
    }
    // Diagnostic timeout: this single request→reply is the exchange the patch
    // read/save community-beta status hinges on, so if frames DID arrive but none
    // matched (e.g. a different reply command or a divergent loc echo), surface
    // their shape — it saves a hardware tester a capture round-trip.
    const seen = buf
      .map((c) => `cmd=0x${(c[PREFIX.length] ?? -1).toString(16)} loc=${c[PREFIX.length + 1]} len=${c.length}`)
      .slice(0, 4);
    const seenNote = buf.length > 0
      ? ` Received ${buf.length} device frame(s) that did not match the expected reply ` +
        `(cmd=0x00 / loc=${loc} / len≥${BODY_OFFSET + PATCH_BODY_LEN}): ${seen.join('; ')}${buf.length > 4 ? '; …' : ''}.`
      : '';
    return {
      ok: false, loc,
      error: `no Current-Patch reply for Synth ${loc + 1} within ${wait}ms; the device may be busy, ` +
        `or its USB MIDI / PGM Rx is not active. The reply comes back on USB only.${seenNote}`,
    };
  } finally {
    unsub();
  }
}
