/**
 * Per-port MIDI connection registry shared by every tool family.
 *
 * The connection layer is keyed by `label` so the server can hold open
 * handles to multiple MIDI ports concurrently. Each device contributes
 * its own connector factory via `registerConnector(label, factory)` at
 * module-load time — typically a side-effect of the device's `midi.ts`
 * being imported. Labels with no registered factory fall back to a
 * generic substring connect against the label string itself.
 *
 * Extracted from `src/server/index.ts` during the server.ts split — the
 * shared module the rest of the tools depend on.
 */

import { connect, type MidiConnection } from '../midi/transport.js';
import { isHandleHealthy } from './handleHealth.js';
import {
    acquireInstanceLock,
    awaitInstanceLeaseRelease,
    describeHolder,
    heldInstanceLocks,
    releaseAllInstanceLocks,
    releaseInstanceLock,
    touchInstanceLock,
    PORT_HELD_ELSEWHERE,
} from './instanceLock.js';
import { endpointHolder } from './endpointArbiter.js';

/**
 * Max time we wait for the device to echo a WRITE after we send it. The
 * AM4 typically responds in well under 50 ms when the target block is
 * placed; if 300 ms passes we treat it as silent-absorb (block not in
 * the active preset) and surface a clear error instead of pretending
 * the write succeeded.
 */
export const WRITE_ECHO_TIMEOUT_MS = 300;

export const AM4_LABEL = 'am4';
export const AXEFX2_LABEL = 'axe-fx-ii';
export const AXEFX3_LABEL = 'axe-fx-iii';
// Modern Fractal family siblings of the III (same gen-3 codec, different
// model byte). community-beta.
export const FM3_LABEL = 'fm3';
export const FM9_LABEL = 'fm9';
// VP4 (gen-3 effects codec, AM4-shape serial chain). community-beta; reads +
// mode switch only, device-state writes gated (placement wire shape undecoded).
export const VP4_LABEL = 'vp4';

/**
 * How many ack-less writes we tolerate before assuming the MIDI handle is
 * stale and forcing a reconnect on the next use. Two is chosen so a single
 * "block not placed" silent-absorb doesn't trigger a reconnect (that's a
 * legitimate no-ack and should keep the handle), but two in a row across
 * any tool calls looks like the handle is actually dead.
 */
export const STALE_HANDLE_TIMEOUT_THRESHOLD = 2;

interface RegistryEntry {
    conn: MidiConnection;
    consecutiveTimeouts: number;
    /**
     * True until the first write/ack outcome is recorded on this handle.
     * A freshly-opened USB-MIDI handle frequently drops the very first
     * outbound transaction during driver warm-up, so the first write's ack
     * can go missing even though the handle is healthy. `sendAndAwaitAck`
     * reads this to decide whether a no-ack warrants a one-shot same-handle
     * resend (see `isColdHandle`). Cleared by `recordAckOutcome` on the
     * first outcome of either kind, so the cold-start resend fires at most
     * once per handle lifetime.
     */
    cold: boolean;
}

const connections = new Map<string, RegistryEntry>();
const connectionErrors = new Map<string, Error>();
const connectorFactories = new Map<string, () => MidiConnection>();
/** Labels whose handle must stay open between operations (see {@link ConnectorOptions}). */
const holdWhileIdle = new Set<string>();
/** Per-label idle-release timers (unref'd: they never keep the process alive). */
const idleTimers = new Map<string, NodeJS.Timeout>();
/** Per-label pin counts: a pinned handle is in use by a caller outside the endpoint arbiter. */
const pins = new Map<string, number>();

export interface ConnectorOptions {
    /**
     * Keep this device's handle (and its instance lease) open for the whole
     * session instead of releasing it after the idle grace. Only for devices
     * whose safety state arrives UNSOLICITED on the open port: the Axe-Fx II
     * pushes its edit-buffer-dirty signal as state broadcasts, and a closed
     * port would miss a knob turn and blind the buffer-dirty gate. Every
     * other device re-reads what it needs on the next operation.
     */
    holdWhileIdle?: boolean;
}

/**
 * Register a device-specific connector factory. The factory is invoked
 * the first time a tool calls `ensureConnection(label)` for the given
 * label. Subsequent calls return the cached connection until a
 * forced/stale reconnect, or until the handle is released for going idle
 * (see {@link portIdleReleaseMs}).
 *
 * Devices register at module-load time (typically in their `midi.ts`)
 * so the side effect happens whenever any code imports the device
 * package — including the server boot path and isolated test scripts.
 */
export function registerConnector(label: string, factory: () => MidiConnection, opts: ConnectorOptions = {}): void {
    connectorFactories.set(label, factory);
    if (opts.holdWhileIdle) holdWhileIdle.add(label);
    else holdWhileIdle.delete(label);
}

/** Does this device keep its port for the whole session (never idle-released)? */
export function holdsPortWhileIdle(label: string): boolean {
    return holdWhileIdle.has(label);
}

/**
 * How long a device handle (and its instance lease) stays open after the
 * last operation before this instance lets go of it, so ANOTHER instance
 * (a second Claude session, the standalone console) can take the port
 * without anyone quitting. 15 s keeps a burst of tool calls on one warm
 * handle (a port open costs tens of ms plus the cold-start ack retry) while
 * a session that has moved on frees the device within the time it takes a
 * person to switch windows. `MCP_PORT_IDLE_RELEASE_MS` overrides; `0`
 * disables idle release (the pre-2026-09-03 hold-until-exit behaviour).
 */
export const DEFAULT_PORT_IDLE_RELEASE_MS = 15_000;
export function portIdleReleaseMs(): number {
    const raw = process.env.MCP_PORT_IDLE_RELEASE_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_PORT_IDLE_RELEASE_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PORT_IDLE_RELEASE_MS;
}

/**
 * How long a device operation waits for ANOTHER instance's lease to clear
 * before failing with `port_held_elsewhere`. Sized to outlast the other
 * instance's idle-release grace with margin, so "I just used it over there
 * and now I want it here" stalls for a few seconds instead of failing.
 * `MCP_PORT_WAIT_MS` overrides; `0` fails fast.
 */
export const DEFAULT_PORT_WAIT_MS = 20_000;
export function portWaitMs(): number {
    const raw = process.env.MCP_PORT_WAIT_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_PORT_WAIT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PORT_WAIT_MS;
}

/**
 * Close `label`'s handle (if open) and release its instance lease, so another
 * instance can open the port. The next `ensureConnection(label)` re-opens and
 * re-leases on demand. Returns true when a handle was actually closed.
 */
export function releaseConnection(label: string): boolean {
    const timer = idleTimers.get(label);
    if (timer !== undefined) {
        clearTimeout(timer);
        idleTimers.delete(label);
    }
    const entry = connections.get(label);
    if (entry !== undefined) {
        closeMidiSafely(entry.conn);
        connections.delete(label);
    }
    releaseInstanceLock(label);
    return entry !== undefined;
}

/**
 * Keep `label`'s handle open until the returned function is called, for a
 * caller that holds a connection across real time OUTSIDE the endpoint
 * arbiter (the generic `send_note` / `send_chord` / `send_sequence`
 * primitives, which may play for up to 300 s). Arbiter-routed operations
 * need no pin: the idle timer already defers while `endpointHolder(label)`
 * reports one in flight.
 */
export function pinConnection(label: string): () => void {
    pins.set(label, (pins.get(label) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const n = (pins.get(label) ?? 1) - 1;
        if (n <= 0) pins.delete(label);
        else pins.set(label, n);
        if (connections.has(label)) armIdleRelease(label);
    };
}

/** (Re)start `label`'s idle-release countdown after a use. */
function armIdleRelease(label: string): void {
    if (holdWhileIdle.has(label)) return;
    if (process.env.MCP_MOCK_TRANSPORT === '1') return; // no port, no lease: nothing to give back
    const ms = portIdleReleaseMs();
    if (ms === 0) return;
    const existing = idleTimers.get(label);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
        idleTimers.delete(label);
        // Still in use: an arbiter-held operation (a 270 s kit upload, a live
        // stream) or a pinned primitive. Defer another grace period rather
        // than cut it off; the release is a courtesy, never an interruption.
        if (endpointHolder(label) !== undefined || (pins.get(label) ?? 0) > 0) {
            armIdleRelease(label);
            return;
        }
        releaseConnection(label);
    }, ms);
    timer.unref?.();
    idleTimers.set(label, timer);
}

/**
 * Wait (briefly) for another instance's lease on `label` to clear before an
 * operation opens the device. Free when we already hold the handle or the
 * lease, or under the mock transport. Does not acquire; `ensureConnection`
 * does, and reports the holder in words if the wait ran out.
 */
export async function awaitDeviceLease(label: string): Promise<void> {
    if (process.env.MCP_MOCK_TRANSPORT === '1') return;
    if (connections.has(label) || heldInstanceLocks().includes(label)) return;
    await awaitInstanceLeaseRelease(label, portWaitMs());
}

/**
 * Call after a write/ack pair completes. Resets the stale-handle counter on
 * success; increments it on timeout. Counter is per-port — patterns like
 * "apply_preset 3 AM4 writes all time out" count as 3 consecutive against
 * the AM4 entry only, and don't drag down a separate Hydrasynth handle.
 */
export function recordAckOutcome(acked: boolean, label: string = AM4_LABEL): void {
    const entry = connections.get(label);
    if (!entry) return;
    if (acked) entry.consecutiveTimeouts = 0;
    else entry.consecutiveTimeouts++;
    // The handle has now completed at least one write/ack round-trip
    // attempt, so it is no longer "cold". This clears the cold-start
    // resend eligibility regardless of outcome — a failed first write
    // gets exactly one resend, not a resend on every subsequent write.
    entry.cold = false;
}

/**
 * True when `label`'s handle has not yet recorded any write/ack outcome —
 * i.e. the next write would be the first on a freshly-opened handle, where
 * a dropped ack is most likely a USB warm-up artifact rather than a real
 * silent-absorb. `sendAndAwaitAck` uses this to gate its one-shot
 * cold-start resend. Returns false when there is no entry (no handle yet,
 * so nothing is "cold" to retry).
 */
export function isColdHandle(label: string = AM4_LABEL): boolean {
    return connections.get(label)?.cold ?? false;
}

function closeMidiSafely(conn: MidiConnection | undefined): void {
    if (!conn) return;
    try {
        conn.close();
    } catch {
        // Closing a stale handle can throw; ignore — we're discarding it anyway.
    }
}

/**
 * Open or return a cached connection for `label`. The default label is
 * the AM4; future device packages will pass their own label.
 *
 * When the label has a registered connector factory, that factory is
 * invoked. Otherwise the label itself is used as a port-name substring
 * via the generic `connect()`. Devices needing a non-substring port
 * discovery path (e.g. Axe-Fx II's "Axe-Fx II Port 1" with a space the
 * label uses a dash for) must register a factory.
 */
export function ensureConnection(
    label: string = AM4_LABEL,
    forceReconnect = false,
): MidiConnection {
    const cached = connections.get(label);
    const counterStale = (cached?.consecutiveTimeouts ?? 0) >= STALE_HANDLE_TIMEOUT_THRESHOLD;
    // R2 handle-health canary (docs/design/connection-canary.md Layer A;
    // docs/design/connection-arbiter.md R2: "ships first, no lock required").
    // Before handing back a CACHED handle, run the FREE in-band liveness check
    // (no probe send: isHandleHealthy only reads state the handle already
    // tracks). This is what converts "USB replug -> first call fails, second
    // call succeeds" into "the NEXT call just works," for every device that
    // goes through this registry, not just the ones with their own bespoke
    // pre-flight check (uploadProject.ts). Skipped when we're already
    // reconnecting for another reason (forceReconnect / counter-stale); no
    // point running a redundant check right before we discard the entry anyway.
    const canaryStale = cached !== undefined && !forceReconnect && !counterStale
        && !isHandleHealthy(cached.conn).ok;
    const stale = counterStale || canaryStale;
    if (forceReconnect || stale) {
        if (cached) closeMidiSafely(cached.conn);
        connections.delete(label);
        connectionErrors.delete(label);
        // 2026-05-23: ALSO clear ANY error keyed by a label that doesn't
        // match this one. Pre-fix: reconnect_midi("hydra") cleared
        // connectionErrors["hydra"] but the real stale entry was under
        // "hydrasynth" (the canonical connection_label). A clear cache
        // wipe on any reconnect is cheap (~5 device labels max) and
        // closes the entire class of "wrong cache key" bugs. The flip
        // side: a forced reconnect for one device retriggers a fresh
        // port scan for ALL devices on next use, which is fine — port
        // scans are cheap.
        if (forceReconnect) {
            connectionErrors.clear();
        }
    }
    const existing = connections.get(label);
    if (existing) {
        touchInstanceLock(label);
        armIdleRelease(label);
        return existing.conn;
    }
    const cachedErr = connectionErrors.get(label);
    if (cachedErr) throw cachedErr;
    // Single-instance lease at THE handle-open seam: every device open in the
    // process funnels through here, so this one check is what makes a second
    // server instance lose access to this device (reads too) instead of racing
    // the first for its exclusive port. Deliberately NOT cached in
    // connectionErrors: held-elsewhere is transient (the other instance may
    // exit any moment), and re-acquire-on-demand is the designed behaviour.
    // Re-entrant for our own process, so forced reconnects sail through.
    //
    // MOCK TRANSPORT EXEMPTION: the lease protects a PHYSICAL exclusive port.
    // Under MCP_MOCK_TRANSPORT=1 the factory returns an in-memory mock — no
    // port exists to protect, and taking the real lease makes offline test
    // gates fail whenever a live server instance happens to hold the device
    // (found 2026-08-09: verify-agent-retry-paths' Hydrasynth cases turned
    // port_held_elsewhere the moment ensureMidi routed through this registry
    // while a Desktop session held the 'hydrasynth' lease).
    const lease = process.env.MCP_MOCK_TRANSPORT === '1'
        ? { acquired: true as const, holderPid: undefined }
        : acquireInstanceLock(label);
    if (!lease.acquired) {
        const who = lease.holder !== undefined
            ? describeHolder(lease.holder)
            : lease.holderPid !== undefined ? `pid ${lease.holderPid}` : 'holder unknown';
        const graceS = Math.round(portIdleReleaseMs() / 1000);
        const policy = holdWhileIdle.has(label)
            ? 'This device keeps its port for the whole session in every instance (it reports edits unsolicited), '
              + 'so the port frees only when that instance exits: quit that session, or run /mcp reconnect there.'
            : graceS > 0
                ? `Ports are released automatically ${graceS} s after an instance's last operation on the device, so this `
                  + 'usually clears itself; if it stays held, that instance is mid-operation. Let it finish, or quit that '
                  + 'session / run /mcp reconnect there.'
                : 'Idle release is disabled (MCP_PORT_IDLE_RELEASE_MS=0), so the port frees only when that instance exits.';
        const err = new Error(
            `The "${label}" device is held by another mcp-midi-control instance (${who}); `
            + `this instance cannot reach it meanwhile (reads are refused as well as writes). ${policy} `
            + `list_midi_ports shows every device lease. [${PORT_HELD_ELSEWHERE}]`,
        );
        (err as Error & { reason?: string }).reason = PORT_HELD_ELSEWHERE;
        throw err;
    }
    try {
        const factory = connectorFactories.get(label);
        const conn = factory ? factory() : connect({ needles: [label], allowOutputOnly: true });
        connections.set(label, { conn, consecutiveTimeouts: 0, cold: true });
        touchInstanceLock(label);
        armIdleRelease(label);
        return conn;
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        // The open failed, so there is no handle and nothing will ever arm the
        // idle release: give the lease back now. Left held, it locked every other
        // instance out of the device for as long as this process lived (found
        // 2026-11-12: one failed open of an unplugged MPC held its lease 10 h).
        if (process.env.MCP_MOCK_TRANSPORT !== '1') releaseInstanceLock(label);
        // "Not plugged in" is not cached: the device may be connected a moment
        // later, and a cached copy kept answering with the old port list until
        // someone thought to run reconnect_midi. A port scan is cheap.
        if (!/No MIDI port matching/.test(e.message)) connectionErrors.set(label, e);
        throw e;
    }
}

/**
 * Back-compat shim — every AM4-only call site continues to call this.
 * Forwards to `ensureConnection()` with the default AM4 label.
 */
export function ensureMidi(forceReconnect = false): MidiConnection {
    return ensureConnection(AM4_LABEL, forceReconnect);
}

process.on('exit', () => {
    for (const entry of connections.values()) closeMidiSafely(entry.conn);
    connections.clear();
    // Synchronous by contract: 'exit' handlers never await, and a lease left
    // behind would make the next instance read 'port_held_elsewhere' until
    // the dead-pid steal kicks in.
    releaseAllInstanceLocks();
});
