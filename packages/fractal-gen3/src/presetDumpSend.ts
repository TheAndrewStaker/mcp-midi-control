/**
 * Gen-3 edit-buffer preset LOAD over a live connection: send a whole preset
 * dump into the unit's edit buffer, frame by frame.
 *
 * Transfer rules, each from the cited prior art (reimplemented, not ported):
 *  - The dump is retargeted to the edit buffer first (`7F 7F`), so a stored
 *    preset is never written by this path (presetDumpEditBuffer.ts).
 *  - Nothing precedes the dump: no fn=0x01 sub=0x27 preset switch (fractone:
 *    sending it first left the FM9 showing preset #0).
 *  - ACK POLICY, per model, because the per-frame ack is evidenced on ONE
 *    model only:
 *      'required' (FM9): every frame (0x77, each 0x78, 0x79) must draw
 *        `64 [fn] 00` before the next is sent (fractone Fm9EditBufferRestore
 *        Sender.RestoreAcknowledgedAsync, FM9 fw 12 hardware). A refusal
 *        retries the WHOLE transfer, up to 3 attempts 150 ms apart, after
 *        draining late answers (a late `64 78 00` carries no chunk index and
 *        could otherwise be credited to the next attempt). A header that
 *        draws no answer at all is NOT retried: the unit is not answering
 *        and a resend adds nothing.
 *      'probe' (FM3, Axe-Fx III): there is no evidence either way that these
 *        units ack each frame (ForgeFX sends FM3 loads un-acked and paced;
 *        fractal-remote lists it as not known). Send the header and wait a
 *        short probe window: an ack switches to the acked mode above; silence
 *        sends the remaining frames UN-ACKED, 150 ms apart (fractone's
 *        un-acked variant gap), and the result says `acked: false`. The
 *        caller judges an un-acked load only by the edit-buffer read-back
 *        (presetDumpLoad.ts).
 *  - After the last frame, wait 300 ms before anything else touches the unit
 *    (fractone AcknowledgedImportSettleDelay).
 *  - On the FM3's USB-CDC serial port each frame is written in 64-byte slices
 *    (forgefx ForgeFX server transport/serial.ts sendPaced, "the FM3 CDC drops
 *    a flooded write", 64 B / 3 ms). We keep 64-byte writes and ForgeFX's
 *    average rate but pause 12 ms after every 4 slices: a 3 ms timer lasts
 *    ~15.6 ms on Windows, so a pause per slice stretched an FM3 load to ~6 s.
 *    (fractone writes FM3 serial unpaced; that conflict is unresolved, the
 *    paced form is the conservative one.) Pacing is only possible on a raw
 *    byte stream: 'auto' paces only a serial connection and an explicit
 *    pacing on a MIDI port is refused.
 *  - One overall deadline per call (default 15 s): an attempt that would start
 *    past it, or a frame sent past it, fails with reason 'deadline'.
 *
 * Evidence label: community-beta, untested by us. Per-frame ack + load: FM9
 * fw 12 hardware (fractone). FM3: un-acked paced load validated by ForgeFX;
 * acks unknown. III: no hardware report for this path.
 */
import { buildEditBufferLoadFrames, classifyDumpFrameResponse } from './presetDumpEditBuffer.js';
import type { ParsedPresetDump } from './presetDump.js';

/** The connection surface this transfer needs (a subset of core's MidiConnection). */
export interface DumpTransferConnection {
  send: (bytes: number[]) => void;
  onMessage: (handler: (bytes: number[]) => void) => () => void;
  lastSendError?: Error;
  /** 'serial' for a raw byte-stream transport (the FM3's USB-CDC port). */
  transportKind?: 'midi' | 'serial';
}

export interface SerialPacing {
  chunkBytes: number;
  gapMs: number;
  /** Slices written back to back before each pause (default 1). */
  burstSlices?: number;
}

/** FM3 CDC pacing: 64-byte writes, 12 ms after every 4 (ForgeFX's 64 B / 3 ms average). */
export const FM3_SERIAL_PACING: SerialPacing = { chunkBytes: 64, gapMs: 12, burstSlices: 4 };
export const DUMP_FRAME_ACK_TIMEOUT_MS = 2000;
export const DUMP_HEADER_PROBE_MS = 400;
export const DUMP_UNACKED_FRAME_GAP_MS = 150;
export const DUMP_TRANSFER_MAX_ATTEMPTS = 3;
export const DUMP_TRANSFER_RETRY_GAP_MS = 150;
export const DUMP_LOAD_SETTLE_MS = 300;
export const DUMP_LOAD_DEADLINE_MS = 15_000;
/** Drain: wait until no answer arrived for this long (capped at 1 s) before a retry. */
export const DUMP_DRAIN_QUIET_MS = 200;

export type DumpAckPolicy = 'required' | 'probe';

/** Default ack policy per model: FM9 acks per frame (hardware); others are probed. */
export function defaultDumpAckPolicy(modelByte: number): DumpAckPolicy {
  return modelByte === 0x12 ? 'required' : 'probe';
}

export interface EditBufferLoadOptions {
  ackTimeoutMs?: number;
  maxAttempts?: number;
  retryGapMs?: number;
  settleMs?: number;
  /** Default per model (defaultDumpAckPolicy). */
  ackPolicy?: DumpAckPolicy;
  /** Header probe window for the 'probe' policy (default 400 ms). */
  probeMs?: number;
  /** Gap between frames when the unit does not ack (default 150 ms). */
  unackedGapMs?: number;
  /** Overall ceiling for this call (default 15 s). */
  deadlineMs?: number;
  /** 'auto' (default): FM3 pacing on a serial connection, none on MIDI. */
  pacing?: 'auto' | 'none' | SerialPacing;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests (default Date.now). */
  now?: () => number;
  /** Progress callback, one call per frame sent. */
  onProgress?: (p: { attempt: number; frame: number; frames: number }) => void;
}

export interface EditBufferLoadFailure {
  attempt: number;
  /** 0-based index of the frame that failed in the transfer. */
  frame_index: number;
  fn: number;
  reason: 'no_ack' | 'refused' | 'send_error' | 'deadline';
  result_code?: number;
  description?: string;
  detail?: string;
}

export interface EditBufferLoadResult {
  /** Every frame went out (and, in acked mode, was acknowledged). */
  ok: boolean;
  /** True only when every frame drew `64 [fn] 00`. An un-acked load is judged by read-back. */
  acked: boolean;
  /** How the frames were sent: per-frame acked, or un-acked after a silent header probe. */
  mode: 'acked' | 'unacked';
  /** Attempts made (1..maxAttempts). */
  attempts: number;
  frames: number;
  paced: boolean;
  /** Every failed attempt, in order (empty when the first attempt succeeded). */
  failures: EditBufferLoadFailure[];
  elapsed_ms: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resolvePacing(conn: DumpTransferConnection, pacing: EditBufferLoadOptions['pacing']): SerialPacing | undefined {
  if (pacing === undefined || pacing === 'auto') return conn.transportKind === 'serial' ? FM3_SERIAL_PACING : undefined;
  if (pacing === 'none') return undefined;
  if (conn.transportKind !== 'serial') {
    throw new Error('loadPresetDumpToEditBuffer: byte pacing needs a serial connection; a USB-MIDI SysEx cannot be split');
  }
  return pacing;
}

async function sendFrame(
  conn: DumpTransferConnection,
  frame: number[],
  pacing: SerialPacing | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (!pacing) {
    conn.send(frame);
    return;
  }
  const burst = Math.max(1, pacing.burstSlices ?? 1);
  let slice = 0;
  for (let i = 0; i < frame.length; i += pacing.chunkBytes) {
    conn.send(frame.slice(i, i + pacing.chunkBytes));
    slice++;
    if (i + pacing.chunkBytes < frame.length && slice % burst === 0) await sleep(pacing.gapMs);
  }
}

type FrameOutcome = Omit<EditBufferLoadFailure, 'attempt' | 'frame_index'> | undefined;

/**
 * Send one frame and wait up to `waitMs` for its 0x64 answer. Subscribes
 * before sending. Resolves `undefined` on an ack, a failure otherwise; with
 * `silentOk` a silent window resolves 'silent' instead of a no_ack failure.
 */
async function sendFrameAwaitAck(
  conn: DumpTransferConnection,
  frame: number[],
  modelByte: number,
  waitMs: number,
  pacing: SerialPacing | undefined,
  sleep: (ms: number) => Promise<void>,
  silentOk = false,
): Promise<FrameOutcome | 'silent'> {
  const fn = frame[5];
  let settle!: (r: FrameOutcome | 'silent') => void;
  const answered = new Promise<FrameOutcome | 'silent'>((res) => { settle = res; });
  let done = false;
  const finish = (r: FrameOutcome | 'silent'): void => {
    if (done) return;
    done = true;
    settle(r);
  };
  const unsubscribe = conn.onMessage((bytes) => {
    const ack = classifyDumpFrameResponse(bytes, modelByte, fn);
    if (!ack) return;
    if (ack.kind === 'ack') finish(undefined);
    else finish({ fn, reason: 'refused', result_code: ack.resultCode, description: ack.description });
  });
  // The timer starts once the whole frame is out (pacing a 3,082-byte chunk
  // takes a while on serial).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await sendFrame(conn, frame, pacing, sleep);
    } catch (err) {
      return { fn, reason: 'send_error', detail: err instanceof Error ? err.message : String(err) };
    }
    // A failed send wins over any answer: the frame may not have gone out whole.
    if (conn.lastSendError) return { fn, reason: 'send_error', detail: conn.lastSendError.message };
    if (!done) {
      timer = setTimeout(
        () => finish(silentOk ? 'silent' : { fn, reason: 'no_ack', detail: `no 0x64 answer within ${waitMs} ms` }),
        waitMs,
      );
    }
    return await answered;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  }
}

/** Wait until no 0x64 from this model arrived for `quietMs` (capped at 1 s). */
async function drainAnswers(conn: DumpTransferConnection, modelByte: number, quietMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const cap = setTimeout(done, 1000);
    function done(): void { clearTimeout(quiet); clearTimeout(cap); unsubscribe(); resolve(); }
    const unsubscribe = conn.onMessage((b) => {
      if (b[0] === 0xf0 && b[4] === modelByte && b[5] === 0x64) { clearTimeout(quiet); quiet = setTimeout(done, quietMs); }
    });
    quiet = setTimeout(done, quietMs);
  });
}

/**
 * Load `dump` into the edit buffer of the gen-3 unit on `conn` (model byte
 * `modelByte`). Retargets to the edit buffer, sends per the model's ack
 * policy, retries a refused transfer, and settles. Resolves (never rejects
 * for a device-side failure) with `ok`, `acked`, `mode` and every failed
 * attempt. A send error (dead port) is not retried.
 */
export async function loadPresetDumpToEditBuffer(
  conn: DumpTransferConnection,
  modelByte: number,
  dump: ParsedPresetDump,
  opts: EditBufferLoadOptions = {},
): Promise<EditBufferLoadResult> {
  if (dump.modelId !== modelByte) {
    throw new Error(
      `loadPresetDumpToEditBuffer: the dump is for model 0x${dump.modelId.toString(16)}, the unit is 0x${modelByte.toString(16)}`,
    );
  }
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const started = now();
  const ackTimeoutMs = opts.ackTimeoutMs ?? DUMP_FRAME_ACK_TIMEOUT_MS;
  const probeMs = opts.probeMs ?? Math.min(DUMP_HEADER_PROBE_MS, ackTimeoutMs);
  const unackedGapMs = opts.unackedGapMs ?? DUMP_UNACKED_FRAME_GAP_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DUMP_TRANSFER_MAX_ATTEMPTS);
  const retryGapMs = opts.retryGapMs ?? DUMP_TRANSFER_RETRY_GAP_MS;
  const settleMs = opts.settleMs ?? DUMP_LOAD_SETTLE_MS;
  const deadlineMs = opts.deadlineMs ?? DUMP_LOAD_DEADLINE_MS;
  const policy = opts.ackPolicy ?? defaultDumpAckPolicy(modelByte);
  const pacing = resolvePacing(conn, opts.pacing);
  const frames = buildEditBufferLoadFrames(dump);
  const failures: EditBufferLoadFailure[] = [];
  const result = (ok: boolean, mode: 'acked' | 'unacked', attempts: number): EditBufferLoadResult => ({
    ok, acked: ok && mode === 'acked', mode, attempts, frames: frames.length, paced: pacing !== undefined,
    failures, elapsed_ms: now() - started,
  });
  const pastDeadline = (): boolean => now() - started > deadlineMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let failed: EditBufferLoadFailure | undefined;
    let mode: 'acked' | 'unacked' = 'acked';
    for (let i = 0; i < frames.length; i++) {
      if (pastDeadline()) {
        failed = { attempt, frame_index: i, fn: frames[i][5], reason: 'deadline', detail: `${deadlineMs} ms deadline passed` };
        break;
      }
      opts.onProgress?.({ attempt, frame: i + 1, frames: frames.length });
      if (mode === 'unacked') {
        await sendFrame(conn, frames[i], pacing, sleep);
        if (conn.lastSendError) {
          failed = { attempt, frame_index: i, fn: frames[i][5], reason: 'send_error', detail: conn.lastSendError.message };
          break;
        }
        if (i < frames.length - 1) await sleep(unackedGapMs);
        continue;
      }
      const probing = i === 0 && policy === 'probe';
      const f = await sendFrameAwaitAck(conn, frames[i], modelByte, probing ? probeMs : ackTimeoutMs, pacing, sleep, probing);
      if (f === 'silent') {
        // No ack on the header of a model whose ack behaviour is unknown:
        // send the rest un-acked, the read-back decides.
        mode = 'unacked';
        await sleep(unackedGapMs);
        continue;
      }
      if (f) { failed = { ...f, attempt, frame_index: i }; break; }
    }
    if (!failed) {
      await sleep(settleMs);
      return result(true, mode, attempt);
    }
    failures.push(failed);
    // Dead port, deadline, or a header nobody answered: a retry adds nothing.
    if (failed.reason === 'send_error' || failed.reason === 'deadline') break;
    if (failed.reason === 'no_ack' && failed.frame_index === 0) break;
    if (attempt < maxAttempts) {
      await drainAnswers(conn, modelByte, DUMP_DRAIN_QUIET_MS);
      await sleep(retryGapMs);
    }
  }
  return result(false, 'acked', failures.length);
}
