/**
 * R2 handle-health: the shared liveness check + reconnect-and-retry-once
 * mechanism behind Phase A of the connection arbiter
 * (docs/design/connection-arbiter.md) and the connection canary
 * (docs/design/connection-canary.md).
 *
 * Two responsibilities, both explicitly IN this phase:
 *
 *  1. {@link isHandleHealthy}: the FREE, in-band liveness check (no probe
 *     send, no extra round trip): port-presence (`isPortOpen`, a NEGATIVE
 *     catch only (a WinMM handle poisoned mid-send still reports open),
 *     poison-probe-verified 2026-06-20) + `lastSendError` (the ONLY reliable
 *     Windows liveness signal) + `slowSendSuspect` (the wall-clock
 *     instrumentation below). Generalizes the bespoke `handleHealth()` that
 *     used to live only in `circuit-tracks/ncs/uploadProject.ts`, so every
 *     handle-based device (MIDI or serial) can use the identical check.
 *
 *  2. {@link withReconnectRetry}: reconnect-and-retry-once. Runs an attempt;
 *     if it reports a HANDLE-level fault (`staleFault: true`, e.g. a dead or
 *     poisoned handle) and a `reconnect` callback is supplied, force-
 *     reconnects exactly ONCE and retries the attempt exactly ONCE on the
 *     fresh handle. A DEVICE-level failure (no-ACK / busy / a legitimate
 *     empty-slot answer) is NOT a `staleFault` and is never retried;
 *     retrying a busy device on a fresh handle would just fail again
 *     identically. This is what `uploadProject.ts`'s bespoke
 *     `runUploadFramePlan` / `downloadProject` retry logic now delegates to,
 *     so the mechanism lives in ONE place instead of being re-derived per
 *     caller.
 *
 * R1 (per-endpoint serialization) and R3 (contention/cancellation) are
 * explicitly OUT of this phase; this module never acquires a lock. Per the
 * design: "This is the present-value reliability win and needs no
 * serialization, so it ships in Phase A on its own."
 *
 * `ensureConnection` (connections.ts) uses `isHandleHealthy` as a proactive
 * canary before handing back a CACHED handle (the "next call just works"
 * self-heal for a replug or a handle that died on a PRIOR call. This module
 * intentionally does not import from connections.ts (no coupling either way
 * beyond the one-directional canary use).
 */
import type { MidiConnection } from '../midi/transport.js';

export interface HandleHealth {
  ok: boolean;
  reason?: string;
}

/**
 * The free, in-band liveness check. Reads state the connection already
 * tracks (no send, no extra round trip), so it is safe to run on every
 * `ensureConnection` acquire (Layer A) as well as immediately before a
 * multi-block transfer starts (the pre-flight guard uploadProject.ts already
 * shipped, now backed by this shared function instead of a private copy).
 *
 * HONEST LIMIT (connection-canary.md): `isPortOpen()` is a NEGATIVE catch
 * only. A synchronous send that BLOCKS forever (the queue-stalled case, not
 * an unplug) never returns, throws nothing, and sets no `lastSendError`;
 * nothing in-process can observe that case at all. `slowSendSuspect` catches
 * only the "blocked for a while, then returned" case (see
 * `midi/transport.ts`'s `connect()`), not a true hang.
 */
export function isHandleHealthy(conn: MidiConnection): HandleHealth {
  if (conn.isPortOpen && !conn.isPortOpen()) {
    return { ok: false, reason: 'MIDI port is not open (device unplugged or handle closed)' };
  }
  if (conn.lastSendError) {
    return { ok: false, reason: `connection handle is in an error state (${conn.lastSendError.message})` };
  }
  if (conn.slowSendSuspect) {
    return {
      ok: false,
      reason: 'a prior send on this handle took unusually long (>250ms), suggesting a stalled queue; '
        + 'reconnecting as a precaution before the next operation',
    };
  }
  return { ok: true };
}

/**
 * Result shape any `withReconnectRetry` attempt must return. Matches the
 * shape `uploadProject.ts`'s `runFramePlanOnce` / `downloadOnce` already
 * produced; this interface just names the contract so other handle-based
 * operations (a future device's file-transfer, a read primitive) can adopt
 * the same wrapper instead of re-deriving the retry-once logic by hand.
 */
export interface RetryableResult {
  ok: boolean;
  error?: string;
  /**
   * True ONLY for a HANDLE-level fault (dead/poisoned handle: pre-flight
   * refused, a send threw, `lastSendError` got set mid-operation). False or
   * omitted for a DEVICE-level failure (no-ACK / busy / a legitimate
   * empty-slot answer): those are NOT worth a reconnect, since a fresh
   * handle would hit the identical device-level condition again.
   */
  staleFault?: boolean;
}

export interface ReconnectRetryOptions {
  /**
   * Force-reconnect this endpoint and return a FRESH handle. Omit to
   * disable auto-recovery (the attempt's own failure is returned as-is,
   * e.g. offline tests with no registry-backed connection).
   */
  reconnect?: () => MidiConnection;
  /** Settle delay (ms) before retrying on the fresh handle. Default 200. */
  settleMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Run `attempt` once against `conn`. On a `staleFault`, force-reconnect via
 * `opts.reconnect` (when supplied) and retry `attempt` EXACTLY ONCE against
 * the fresh handle, never more. A second failure (either the retry itself,
 * or `reconnect()` throwing) surfaces honestly instead of looping, so a
 * truly dead device fails fast rather than retrying forever or hammering
 * the port with repeated reconnects (no "double-reconnect storm": this
 * function calls `opts.reconnect` at most once per invocation, full stop).
 *
 * This is R2's "verify-or-reconnect-and-retry-once", generalized from
 * `uploadProject.ts`'s bespoke `runUploadFramePlan` / `downloadProject`
 * logic so any handle-based operation (MIDI or serial) can adopt it without
 * re-deriving the sleep/reconnect/retry choreography.
 */
export async function withReconnectRetry<R extends RetryableResult>(
  conn: MidiConnection,
  attempt: (conn: MidiConnection) => Promise<R>,
  opts: ReconnectRetryOptions = {},
): Promise<R> {
  const first = await attempt(conn);
  if (first.ok || !first.staleFault || !opts.reconnect) return first;

  await sleep(opts.settleMs ?? 200); // let the dying port settle before reopening
  let fresh: MidiConnection;
  try {
    fresh = opts.reconnect();
  } catch (e) {
    return {
      ...first,
      error: `${first.error}; auto-reconnect also failed (${errMsg(e)}); call reconnect_midi and retry.`,
    };
  }
  const second = await attempt(fresh);
  if (second.ok) return second;
  return {
    ...second,
    error: `${second.error} (auto-reconnected and retried once; still failed; check the device is powered and the cable seated)`,
  };
}

/**
 * Classify whether a THROWN error from a leaf wire operation represents a
 * HANDLE-level fault worth a reconnect-and-retry, as opposed to a device- or
 * logic-level throw (validation, `capability_not_supported`, a legitimate
 * `DispatchError`) that must propagate untouched. Used by
 * {@link withHandleFaultRetry} below.
 *
 * `conn.lastSendError` is the primary, reliable signal: `midi/transport.ts`'s
 * `send()` ALWAYS sets it (then rethrows) on a failed `output.sendMessage`,
 * so checking it right after a catch answers "did THIS call's own send just
 * fail" with no string-matching on driver-specific error text. The message
 * regex is a fallback for the rare connection that reports the fault a
 * different way, or omits `lastSendError` (optional on `MidiConnection`).
 */
export function isHandleFaultError(err: unknown, conn: MidiConnection): boolean {
  if (conn.lastSendError) return true;
  return err instanceof Error && /rtmidi|sendmessage/i.test(err.message);
}

export interface HandleFaultRetryOptions {
  /**
   * Force-reconnect this endpoint and return a FRESH handle. Omit to
   * disable auto-recovery (the original throw propagates as-is) — used for
   * offline tests and any ctx with no reconnect callback.
   */
  reconnect?: () => MidiConnection;
  /** Settle delay (ms) before retrying on the fresh handle. Default 200. */
  settleMs?: number;
}

/**
 * Reconnect-and-retry-once for THROW-style leaf operations — Phase A.5 of
 * the connection arbiter (docs/design/connection-arbiter.md), wired at the
 * `execute*` dispatcher seam (`protocol-generic/dispatcher/{params,layout,
 * navigation,preset}.ts` via `dispatcher/core.ts`'s `withHandleRetry`).
 *
 * Complements {@link withReconnectRetry} above, which is for leaf operations
 * that already convert a wire fault into a `RetryableResult` instead of
 * throwing (`uploadProject.ts`'s multi-block transfer driver). The
 * dispatcher's per-device writer/reader methods call `ctx.conn.send`
 * directly (via `sendAndAwaitAck` and its per-device equivalents) and let a
 * dead-handle throw propagate uncaught — exactly the "Internal RtMidi error"
 * surfaced on a 2026-07-10 hardware bench, where Phase A's acquire-time
 * canary could NOT catch it: on a clean Windows USB replug, the PRIOR call
 * had succeeded, so `isPortOpen()` still reads `true` and `lastSendError` is
 * still clean at acquire time — the fault only appears when THIS call's own
 * send fires into the now-dead handle.
 *
 * `attempt` is free to throw for ANY reason. Only a throw classified by
 * {@link isHandleFaultError} triggers the reconnect + single retry; every
 * other throw (a `DispatchError`, a validation error, any device-level
 * rejection such as a no-ACK) propagates on the FIRST try, unmodified —
 * retrying those would just repeat the identical failure, and reshaping them
 * would swallow structured error detail (`DispatchError.details`) callers
 * rely on.
 *
 * A second failure (the retry itself throws, OR `reconnect()` itself throws)
 * surfaces as ONE combined `Error` — never an infinite loop, never a silent
 * swallow, `reconnect` called at MOST once per invocation.
 */
export async function withHandleFaultRetry<T>(
  conn: MidiConnection,
  attempt: (conn: MidiConnection) => Promise<T>,
  opts: HandleFaultRetryOptions = {},
): Promise<T> {
  try {
    return await attempt(conn);
  } catch (err) {
    if (!isHandleFaultError(err, conn) || !opts.reconnect) throw err;
    await sleep(opts.settleMs ?? 200); // let the dying port settle before reopening
    let fresh: MidiConnection;
    try {
      fresh = opts.reconnect();
    } catch (reErr) {
      throw new Error(
        `${errMsg(err)}; auto-reconnect also failed (${errMsg(reErr)}); call reconnect_midi and retry.`,
      );
    }
    try {
      return await attempt(fresh);
    } catch (err2) {
      throw new Error(
        `${errMsg(err2)} (auto-reconnected and retried once; still failed; check the device is powered and the cable seated)`,
      );
    }
  }
}
