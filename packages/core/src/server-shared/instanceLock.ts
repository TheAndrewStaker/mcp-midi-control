/**
 * Single-instance PORT lease: at most one mcp-midi-control process drives a
 * given device label at a time, and every instance can SEE who holds what.
 *
 * WHY. A MIDI/serial port is held by exactly one process, and a second server
 * instance (Claude Desktop + the standalone console, two Claude Code sessions,
 * or two Desktops after a crashy relaunch) opening the same device is this
 * project's most common "nothing happens" failure: writes report success into
 * a dead or duplicate handle. The lease turns that silent failure into a NAMED
 * one, and (since 2026-09-03) into a SHORT one: the connection registry
 * releases an idle handle and its lease after a grace period
 * (`connections.ts`, `MCP_PORT_IDLE_RELEASE_MS`), so the session that is
 * actually driving the device gets it without anyone quitting anything.
 *
 * SHAPE. One lock file per label under a shared directory
 * (`MCP_INSTANCE_LOCK_DIR`, default `<tmpdir>/mcp-midi-control-locks`),
 * created atomically with `fs.openSync(path, 'wx')` and holding
 * `{pid, startedAt, client, heldSince, lastActiveAt}`. Liveness is
 * `process.kill(pid, 0)`; a dead holder's lock is stolen. `startedAt` is the
 * PID-REUSE guard: a lock naming OUR pid but a different process start time
 * was left by a dead predecessor whose pid the OS handed to us, so it is
 * stale, not "held by ourselves". `client` is the MCP client's declared name
 * ("claude-code", "Claude Desktop") so a human reading a refusal or
 * `list_midi_ports` knows WHICH of their sessions has the device;
 * `lastActiveAt` is refreshed on every device operation (throttled, written
 * via temp-file + rename so a concurrent reader never sees a torn payload).
 *
 * POLICY (RIG-CONSOLE-WORKPLAN.md chunk 4, revised 2026-09-03): the loser
 * NEVER refuses to start. It degrades to read-only: file-backed surfaces
 * (describe_rig, the rig console, edit_rig) keep working, and only the
 * device-handle open fails, with the machine-readable reason
 * `port_held_elsewhere` so a UI can say WHY (vs "not plugged in", which is
 * not actionable). Before failing, the dispatcher seam waits briefly for the
 * holder to go idle (`awaitInstanceLeaseRelease`). Acquisition is re-entrant
 * (a forced reconnect re-acquires the lease it already holds) and the lease
 * is RELEASED SYNCHRONOUSLY at process exit from both exit closers, because
 * `process.on('exit')` handlers must not await.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const INSTANCE_LOCK_DIR_ENV = 'MCP_INSTANCE_LOCK_DIR';

/** The machine-readable reason a UI keys on. */
export const PORT_HELD_ELSEWHERE = 'port_held_elsewhere';

/** What a lock file holds. `pid` + `startedAt` are load-bearing; the rest is for humans. */
export interface LockPayload {
  pid: number;
  startedAt: number;
  /** The MCP client driving the holding instance ("claude-code", "Claude Desktop"), when known. */
  client?: string;
  /** Date.now() when the lease was taken. */
  heldSince?: number;
  /** Date.now() of the holder's most recent device operation on this label. */
  lastActiveAt?: number;
}

export interface LockAcquisition {
  acquired: boolean;
  /** Why not (only when `acquired` is false). */
  reason?: typeof PORT_HELD_ELSEWHERE;
  /** The live pid holding the lease (only when `acquired` is false). */
  holderPid?: number;
  /** The live holder's payload, identity + activity, for messages (only when `acquired` is false). */
  holder?: LockPayload;
  /** The lock file path (diagnostics). */
  file: string;
}

/** One row of {@link describeInstanceLocks}: a lease as seen from THIS process. */
export interface InstanceLease {
  label: string;
  file: string;
  pid: number;
  /** The holder process is alive (always true for our own leases). */
  alive: boolean;
  /** This process holds it. */
  ours: boolean;
  client?: string;
  heldSince?: number;
  lastActiveAt?: number;
}

/**
 * This process's start time, computed once: `startedAt` must be byte-stable
 * across every acquire in this process or the re-entrant check would fail
 * against our own lease (uptime jitter would move a per-call value).
 */
const OUR_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

/** Labels this process currently leases (for exit-time release). */
const held = new Set<string>();

/** Last time we rewrote each lease's `lastActiveAt` (touch throttle). */
const lastTouch = new Map<string, number>();
/** A touch rewrites the lock file at most this often; activity is advisory, not a clock. */
const TOUCH_THROTTLE_MS = 2000;

/**
 * Where the MCP client's name comes from. Set once by the server bootstrap
 * (`setInstanceClientNameProvider`), read lazily at every lock write because
 * the client's `initialize` may not have completed when the provider is
 * installed. Defaults to "unknown".
 */
let clientNameProvider: () => string | undefined = () => undefined;

/** Install the source of the MCP client's declared name (from `initialize`). */
export function setInstanceClientNameProvider(provider: () => string | undefined): void {
  clientNameProvider = provider;
}

function clientName(): string | undefined {
  try {
    const name = clientNameProvider();
    if (typeof name !== 'string') return undefined;
    const trimmed = name.trim();
    return trimmed === '' ? undefined : trimmed.slice(0, 80);
  } catch {
    return undefined;
  }
}

function lockDir(): string {
  const env = process.env[INSTANCE_LOCK_DIR_ENV];
  return env !== undefined && env.trim() !== '' ? env.trim() : path.join(os.tmpdir(), 'mcp-midi-control-locks');
}

function safeLabel(label: string): string {
  // Labels are short identifiers ('am4', 'axe-fx-ii'); sanitise defensively so
  // a hostile/buggy label cannot traverse out of the lock directory.
  return label.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function lockFile(label: string): string {
  return path.join(lockDir(), `${safeLabel(label)}.lock`);
}

function ourPayload(heldSince: number): LockPayload {
  const payload: LockPayload = { pid: process.pid, startedAt: OUR_STARTED_AT, heldSince, lastActiveAt: Date.now() };
  const client = clientName();
  if (client !== undefined) payload.client = client;
  return payload;
}

function tryCreate(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(ourPayload(Date.now())));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function readPayload(file: string): LockPayload | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockPayload>;
    if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'number') return undefined;
    const payload: LockPayload = { pid: raw.pid, startedAt: raw.startedAt };
    if (typeof raw.client === 'string' && raw.client !== '') payload.client = raw.client;
    if (typeof raw.heldSince === 'number') payload.heldSince = raw.heldSince;
    if (typeof raw.lastActiveAt === 'number') payload.lastActiveAt = raw.lastActiveAt;
    return payload;
  } catch {
    return undefined;
  }
}

function isOurs(payload: LockPayload): boolean {
  return payload.pid === process.pid && payload.startedAt === OUR_STARTED_AT;
}

/** Is a process with this pid alive (as far as signal 0 can tell)? */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours to signal; anything else (ESRCH) = gone.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire (or re-acquire) the lease for `label`. Never throws on contention:
 * the caller gets `{acquired:false, reason:'port_held_elsewhere', holderPid, holder}`
 * and decides how to degrade. Steals a lock whose holder is dead, whose
 * payload is unreadable, or whose pid is OURS with a different start time
 * (the OS reused our predecessor's pid for us).
 */
export function acquireInstanceLock(label: string): LockAcquisition {
  const file = lockFile(label);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(file)) {
      held.add(label);
      lastTouch.set(label, Date.now());
      return { acquired: true, file };
    }
    const payload = readPayload(file);
    if (payload !== undefined) {
      if (isOurs(payload)) {
        // Re-entrant: a forced reconnect re-acquires the lease it holds.
        held.add(label);
        return { acquired: true, file };
      }
      const pidReusedFromPredecessor = payload.pid === process.pid && payload.startedAt !== OUR_STARTED_AT;
      if (!pidReusedFromPredecessor && pidAlive(payload.pid)) {
        return { acquired: false, reason: PORT_HELD_ELSEWHERE, holderPid: payload.pid, holder: payload, file };
      }
    }
    // Dead holder, our reused pid, or an unreadable payload: steal and retry
    // the atomic create ONCE (if a rival steals first, the retry loses cleanly).
    try {
      fs.unlinkSync(file);
    } catch {
      // Vanished under us: the retry decides.
    }
  }
  // Lost the post-steal race: someone else created it between our unlink and
  // retry. Report them as the holder.
  const rival = readPayload(file);
  return { acquired: false, reason: PORT_HELD_ELSEWHERE, holderPid: rival?.pid, holder: rival, file };
}

/**
 * Record device activity on a lease THIS process holds: refreshes
 * `lastActiveAt` (and fills in `client` if it was unknown at acquire time).
 * Throttled to one rewrite per {@link TOUCH_THROTTLE_MS}; written to a temp
 * file and renamed over the lock so a concurrent reader in another instance
 * sees either the old payload or the new one, never a torn one (a torn
 * payload would be read as "unreadable" and STOLEN). Advisory: never throws.
 */
export function touchInstanceLock(label: string): void {
  if (!held.has(label)) return;
  const now = Date.now();
  const last = lastTouch.get(label) ?? 0;
  if (now - last < TOUCH_THROTTLE_MS) return;
  const file = lockFile(label);
  const payload = readPayload(file);
  if (payload === undefined || !isOurs(payload)) return; // not ours any more: leave it alone
  const next: LockPayload = { ...payload, lastActiveAt: now };
  if (next.client === undefined) {
    const client = clientName();
    if (client !== undefined) next.client = client;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
    lastTouch.set(label, now);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/**
 * Every lease in the lock directory, as seen from this process: ours, live
 * foreign holders, and stale files left by exited processes (reclaimed on
 * the next acquire). Read-only; opens no port. This is what lets BOTH
 * sessions see who has a device (`list_midi_ports`).
 */
export function describeInstanceLocks(): InstanceLease[] {
  let names: string[];
  try {
    names = fs.readdirSync(lockDir());
  } catch {
    return [];
  }
  const out: InstanceLease[] = [];
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(lockDir(), name);
    const payload = readPayload(file);
    if (payload === undefined) continue;
    const ours = isOurs(payload);
    const lease: InstanceLease = {
      label: name.slice(0, -'.lock'.length),
      file,
      pid: payload.pid,
      alive: ours || pidAlive(payload.pid),
      ours,
    };
    if (payload.client !== undefined) lease.client = payload.client;
    if (payload.heldSince !== undefined) lease.heldSince = payload.heldSince;
    if (payload.lastActiveAt !== undefined) lease.lastActiveAt = payload.lastActiveAt;
    out.push(lease);
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** "41 min ago", "3 s ago", "just now". */
export function describeAgo(at: number | undefined, now = Date.now()): string | undefined {
  if (at === undefined) return undefined;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 2) return 'just now';
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * A holder in words, for refusals and listings: which client, which pid, how
 * long it has held the device and when it last used it. Never names a user.
 */
export function describeHolder(
  holder: Pick<LockPayload, 'pid' | 'client' | 'heldSince' | 'lastActiveAt'>,
  now = Date.now(),
): string {
  const parts = [`${holder.client ?? 'client unknown'}, pid ${holder.pid}`];
  const since = describeAgo(holder.heldSince, now);
  if (since !== undefined) parts.push(`holding it since ${since === 'just now' ? 'just now' : since.replace(/ ago$/, ' ago')}`);
  const active = describeAgo(holder.lastActiveAt, now);
  if (active !== undefined) parts.push(`last device operation ${active}`);
  return parts.join(', ');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait up to `waitMs` for `label` to be free of a LIVE FOREIGN holder,
 * polling the lock file every `pollMs`. Resolves true as soon as the label is
 * unheld, held by this process, or held by a dead process (all of which the
 * next `acquireInstanceLock` turns into ours); false when the wait runs out.
 * Does NOT acquire: the caller's `ensureConnection` does, closing the
 * (tiny) race with the atomic create. Used by the dispatcher seam so a
 * session that starts driving a device just after another one used it
 * rides out the other's idle-release grace instead of failing fast.
 */
export async function awaitInstanceLeaseRelease(label: string, waitMs: number, pollMs = 250): Promise<boolean> {
  const file = lockFile(label);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const payload = readPayload(file);
    if (payload === undefined || isOurs(payload) || !pidAlive(payload.pid)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Release the lease for `label` if THIS process holds it. Synchronous by
 * contract: both exit closers call it inside `process.on('exit')`, where
 * async work never runs.
 */
export function releaseInstanceLock(label: string): void {
  held.delete(label);
  lastTouch.delete(label);
  const file = lockFile(label);
  const payload = readPayload(file);
  if (payload === undefined) return;
  if (!isOurs(payload)) return; // not ours
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone / locked by AV scan: exit paths never throw over cleanup.
  }
}

/** Release every lease this process holds. Called from the exit closers. */
export function releaseAllInstanceLocks(): void {
  for (const label of [...held]) releaseInstanceLock(label);
}

/** Test-only: the labels this process currently leases. */
export function heldInstanceLocks(): readonly string[] {
  return [...held];
}
