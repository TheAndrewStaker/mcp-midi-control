/**
 * Per-endpoint operation lock — connection-arbiter Phase B R1
 * (docs/design/connection-arbiter.md "The seam", "R3: contention").
 *
 * One operation per endpoint at a time. The "endpoint" is a device's door:
 * its MIDI port, the FM3's serial line, or the SPD-SX's mounted drive. Two
 * concurrent operations on ONE device would interleave their SysEx
 * request/response transactions into a stream the device (or our own
 * arrival-order response correlation — see the AM4 preset-name-read note in
 * RIG-CONSOLE-DESIGN.md "View-only is safe today was unproven") cannot tell
 * apart. Operations on DIFFERENT devices never wait on each other.
 *
 * This module owns only the lock. Context construction, transport
 * resolution, and the DispatchError mapping live in the dispatcher's
 * `withEndpoint` (protocol-generic/dispatcher/core.ts), which is the only
 * intended production caller; `reconnect_midi` uses the lock directly so a
 * forced reconnect cannot close a port out from under an in-flight holder.
 *
 * Key = `descriptor.connection_label ?? descriptor.id` — the SAME key the
 * connection registry uses, so the lock and the handle-health state
 * co-locate (design: "Lock key = connection_label ?? id").
 *
 * The mutex is `async-mutex`, not hand-rolled, per the design's resolved
 * decision: a bare promise-chain mutex with a bounded waiter timeout is
 * exactly the combination that leaks (a timed-out waiter handed the lock
 * later deadlocks the endpoint). Here a timed-out waiter's queued acquire
 * stays attached to an immediate-release continuation, so when the grant
 * eventually arrives it is returned to the queue instead of dangling
 * (covered by the leak-regression case in verify-endpoint-arbiter.ts).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Mutex } from 'async-mutex';

/** Who currently holds an endpoint, for `device_busy` messages. */
export interface EndpointHolder {
    /** Tool-level name of the in-flight operation (e.g. 'apply_pattern'). */
    opName: string;
    /** Date.now() at acquire, so a refusal can say "started 4 s ago". */
    acquiredAt: number;
}

interface LockCell {
    mutex: Mutex;
    holder?: EndpointHolder;
    waiterCount: number;
}

/**
 * How long a waiter queues behind a busy endpoint before failing fast.
 * Bounds the WAITER, not the op (design: holders hold for the whole op —
 * a live-stream or a 270 s kit upload is legitimate exclusive use). 5 s
 * outwaits every brief op by two orders of magnitude while keeping the
 * failure conversational: past it the caller gets a `device_busy` naming
 * the in-flight op rather than a silent multi-second stall.
 */
export const DEFAULT_ENDPOINT_WAIT_MS = 5000;

/** Thrown to a waiter that timed out queued behind a busy endpoint. */
export class EndpointBusyError extends Error {
    constructor(
        public readonly key: string,
        /** Snapshot of the holder at the moment the waiter gave up. */
        public readonly holder: EndpointHolder | undefined,
        public readonly waitedMs: number,
    ) {
        super(
            holder !== undefined
                ? `endpoint "${key}" is busy: ${holder.opName} has held it for ${Math.round((Date.now() - holder.acquiredAt) / 1000)} s (waited ${waitedMs} ms)`
                : `endpoint "${key}" is busy (waited ${waitedMs} ms)`,
        );
        this.name = 'EndpointBusyError';
    }
}

/**
 * Thrown when an operation already holding an endpoint's lock re-enters it
 * in the same call chain — the self-deadlock the design's reentrancy
 * invariant forbids ("an execute* holds at most one endpoint lock and never
 * calls another execute* while holding it"). A loud throw instead of a
 * silent deadlock, so a future violation fails in tests, not on stage.
 */
export class EndpointReentrancyError extends Error {
    constructor(key: string, opName: string, holderOpName: string | undefined) {
        super(
            `endpoint "${key}" is already held in this call chain` +
            (holderOpName !== undefined ? ` by ${holderOpName}` : '') +
            `; ${opName} must not re-acquire it (reentrancy invariant, docs/design/connection-arbiter.md). ` +
            'Composites call the unlocked inner function under their single lock; multi-endpoint ops release one endpoint before acquiring the next.',
        );
        this.name = 'EndpointReentrancyError';
    }
}

const cells = new Map<string, LockCell>();

/** Endpoint keys held by the current async call chain (reentrancy guard). */
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Kill-switch (design: "an MCP_DISABLE_ENDPOINT_ARBITER kill-switch env so
 * the whole layer can be turned off if it ever misbehaves"). Read per call,
 * so a test can flip it without re-importing the module.
 */
export function isEndpointArbiterDisabled(): boolean {
    const v = process.env.MCP_DISABLE_ENDPOINT_ARBITER;
    return v === '1' || v === 'true';
}

/** Waiter timeout; `MCP_ENDPOINT_WAIT_MS` overrides (tests use short values). */
export function endpointWaiterTimeoutMs(): number {
    const raw = process.env.MCP_ENDPOINT_WAIT_MS;
    if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return DEFAULT_ENDPOINT_WAIT_MS;
}

function getCell(key: string): LockCell {
    let cell = cells.get(key);
    if (cell === undefined) {
        cell = { mutex: new Mutex(), waiterCount: 0 };
        cells.set(key, cell);
    }
    return cell;
}

/** Current holder of `key`, or undefined when free. Advisory (TOCTOU): for
 * error messages and tests, never for gating a subsequent acquire. */
export function endpointHolder(key: string): EndpointHolder | undefined {
    return cells.get(key)?.holder;
}

/** Number of waiters currently queued on `key`. Advisory, for messages/tests. */
export function endpointWaiterCount(key: string): number {
    return cells.get(key)?.waiterCount ?? 0;
}

/**
 * Acquire `cell` or throw `EndpointBusyError` after `timeoutMs`. On the
 * timeout path the queued acquire is left with an immediate-release
 * continuation so a later grant returns to the queue instead of leaking
 * (the "timed-out-waiter-then-third-acquirer" regression).
 */
async function acquireWithTimeout(
    cell: LockCell,
    key: string,
    timeoutMs: number,
): Promise<() => void> {
    if (!cell.mutex.isLocked() || timeoutMs === Infinity) {
        // Free (checked BEFORE acquire — acquire() on a free mutex locks it
        // synchronously, so checking after would misread our own grab as
        // contention), or the caller asked to wait forever: no timer needed.
        return cell.mutex.acquire();
    }
    const acquireP = cell.mutex.acquire();
    cell.waiterCount++;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            acquireP,
            new Promise<never>((_, reject) => {
                // NOT unref'd: this timer is what guarantees the waiter
                // settles. An unref'd timer lets the event loop drain with
                // the waiter's promise forever pending (observed as an
                // "unsettled top-level await" process exit in the gate).
                timer = setTimeout(
                    () => reject(new EndpointBusyError(key, cell.holder, timeoutMs)),
                    timeoutMs,
                );
            }),
        ]);
    } catch (err) {
        // Timed out: the acquire is still queued. When it is eventually
        // granted, hand it straight back so the next waiter proceeds.
        void acquireP.then((release) => release()).catch(() => { /* mutex torn down */ });
        throw err;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        cell.waiterCount--;
    }
}

/**
 * Run `fn` holding the exclusive lock for endpoint `key`.
 *
 * - Same key: serialized (a second caller queues, then times out into
 *   `EndpointBusyError` after `timeoutMs` ?? `endpointWaiterTimeoutMs()`).
 * - Different keys: fully parallel.
 * - Re-entering a key already held by this call chain throws
 *   `EndpointReentrancyError` instead of deadlocking.
 * - `MCP_DISABLE_ENDPOINT_ARBITER` bypasses the lock entirely.
 */
export async function runExclusiveOnEndpoint<T>(
    key: string,
    opName: string,
    fn: () => Promise<T>,
    opts: { timeoutMs?: number } = {},
): Promise<T> {
    if (isEndpointArbiterDisabled()) return fn();
    const held = heldKeys.getStore();
    if (held?.has(key)) {
        throw new EndpointReentrancyError(key, opName, cells.get(key)?.holder?.opName);
    }
    const cell = getCell(key);
    const release = await acquireWithTimeout(cell, key, opts.timeoutMs ?? endpointWaiterTimeoutMs());
    cell.holder = { opName, acquiredAt: Date.now() };
    try {
        const next = new Set(held ?? []);
        next.add(key);
        return await heldKeys.run(next, fn);
    } finally {
        cell.holder = undefined;
        release();
    }
}
