/**
 * verify-endpoint-arbiter — offline gate for connection-arbiter Phase B R1
 * (docs/design/connection-arbiter.md "Test plan", Phase B rows).
 *
 * Proves the per-endpoint lock's contract with NO hardware and NO real port:
 *
 *   1. Two concurrent ops on the SAME key serialize; a third on a different
 *      key runs in parallel.
 *   2. Interleave detection through the real `withEndpoint` seam: two ops'
 *      `send()` calls never overlap on one key (the direct proof of the
 *      core claim, using a registered mock connector).
 *   3. A waiter behind a hung holder throws `EndpointBusyError` (not a hang)
 *      carrying the holder's opName; the holder releasing lets a queued
 *      waiter proceed.
 *   4. Timed-out-waiter-then-third-acquirer: a holder releases AFTER a
 *      waiter already timed out, and a third caller still acquires (the
 *      leak regression `async-mutex` + the timeout race must not reintroduce).
 *   5. The reentrancy guard THROWS (does not deadlock) on same-key re-entry
 *      in one call chain; different-key nesting is allowed.
 *   6. `withEndpoint` maps the busy error to DispatchError('device_busy')
 *      naming the in-flight op, and says nothing was sent.
 *   7. `reconnect_midi`'s lock route: an acquire labelled reconnect_midi
 *      refuses (EndpointBusyError) while an op holds the endpoint.
 *   8. Kill-switch: MCP_DISABLE_ENDPOINT_ARBITER=1 bypasses serialization.
 *   9. A ctx-build failure inside the lock RELEASES the lock (the next
 *      caller gets the port error, never device_busy).
 *
 * Run: npm run verify-endpoint-arbiter   (registered in preflight)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ENDPOINT_WAIT_MS,
  EndpointBusyError,
  EndpointReentrancyError,
  endpointHolder,
  runExclusiveOnEndpoint,
} from '@mcp-midi-control/core/server-shared/endpointArbiter.js';
import { registerConnector } from '@mcp-midi-control/core/server-shared/connections.js';
import { withEndpoint } from '@mcp-midi-control/core/protocol-generic/dispatcher/core.js';
import { DispatchError, type DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

// Instance locks land in a scratch dir so this gate can never collide with a
// live server instance's lease files.
const lockDir = mkdtempSync(join(tmpdir(), 'arb-gate-'));
process.env.MCP_INSTANCE_LOCK_DIR = lockDir;

let failures = 0;
function assert(cond: boolean, name: string): void {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A promise released by hand, so holds are deterministic (no sleep races). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// ── 1. serialization + cross-key parallelism ────────────────────────────────
{
  console.log('\nsame-key serialization / cross-key parallelism:');
  const events: string[] = [];
  const hold = deferred();
  const p1 = runExclusiveOnEndpoint('k1', 'op1', async () => {
    events.push('op1:start');
    await hold.promise;
    events.push('op1:end');
  });
  const p2 = runExclusiveOnEndpoint('k1', 'op2', async () => {
    events.push('op2:start');
  });
  const p3 = runExclusiveOnEndpoint('k-other', 'op3', async () => {
    events.push('op3:start');
  });
  await p3;
  await sleep(10);
  assert(events.includes('op3:start'), 'different key ran in parallel while k1 held');
  assert(!events.includes('op2:start'), 'same-key op2 has not started while op1 holds');
  assert(endpointHolder('k1')?.opName === 'op1', 'holder metadata names op1');
  hold.resolve();
  await Promise.all([p1, p2]);
  assert(
    events.indexOf('op1:end') < events.indexOf('op2:start')
      && events.indexOf('op3:start') < events.indexOf('op1:end'),
    `op2 started only after op1 released; op3 never waited (got: ${events.join(',')})`,
  );
  assert(endpointHolder('k1') === undefined, 'holder cleared after release');
}

// ── 3. waiter timeout → EndpointBusyError; queued waiter proceeds ───────────
{
  console.log('\nwaiter timeout → EndpointBusyError:');
  const hold = deferred();
  const p1 = runExclusiveOnEndpoint('k2', 'long-holder', () => hold.promise);
  let busyErr: unknown;
  try {
    await runExclusiveOnEndpoint('k2', 'impatient', async () => undefined, { timeoutMs: 40 });
  } catch (e) {
    busyErr = e;
  }
  assert(busyErr instanceof EndpointBusyError, 'waiter threw EndpointBusyError, did not hang');
  assert(
    busyErr instanceof EndpointBusyError && busyErr.holder?.opName === 'long-holder',
    'busy error names the in-flight op',
  );
  // A waiter QUEUED with a generous timeout proceeds once the holder releases.
  const ran = { flag: false };
  const p4 = runExclusiveOnEndpoint('k2', 'patient', async () => { ran.flag = true; }, { timeoutMs: 5_000 });
  hold.resolve();
  await Promise.all([p1, p4]);
  assert(ran.flag, 'patient waiter proceeded after the holder released');
}

// ── 4. timed-out-waiter-then-third-acquirer (leak regression) ───────────────
{
  console.log('\nleak regression (timed-out waiter, then a third acquirer):');
  const hold = deferred();
  const p1 = runExclusiveOnEndpoint('k3', 'holder', () => hold.promise);
  const timedOut = await runExclusiveOnEndpoint('k3', 'gives-up', async () => undefined, { timeoutMs: 30 })
    .then(() => false, (e) => e instanceof EndpointBusyError);
  assert(timedOut, 'second caller timed out while the holder held');
  hold.resolve();
  await p1;
  // The abandoned waiter's grant must have been handed back: a third caller
  // acquires instead of deadlocking behind a ghost.
  const third = await runExclusiveOnEndpoint('k3', 'third', async () => 'ran', { timeoutMs: 1_000 })
    .catch(() => 'blocked');
  assert(third === 'ran', 'third acquirer got the lock after the timed-out waiter was cleaned up');
}

// ── 5. reentrancy guard ─────────────────────────────────────────────────────
{
  console.log('\nreentrancy guard:');
  let reentrant: unknown;
  await runExclusiveOnEndpoint('k4', 'outer', async () => {
    try {
      await runExclusiveOnEndpoint('k4', 'inner', async () => undefined, { timeoutMs: 50 });
    } catch (e) {
      reentrant = e;
    }
  });
  assert(reentrant instanceof EndpointReentrancyError, 'same-key re-entry threw (not a deadlock, not a timeout)');
  // Different keys may nest (the multi-endpoint sequential-acquire shape).
  const nested = await runExclusiveOnEndpoint('k5', 'outer', () =>
    runExclusiveOnEndpoint('k6', 'inner', async () => 'ok'));
  assert(nested === 'ok', 'different-key nesting is allowed');
}

// ── seam-level tests through withEndpoint + a registered mock connector ─────
const LABEL = 'arb-gate-device';
const sendLog: string[] = [];
function makeMockConn(): MidiConnection {
  return {
    send: () => { /* per-op logging rides opTag below, not raw sends */ },
    receiveSysEx: async () => [],
    receiveSysExMatching: async () => [],
    onMessage: () => () => undefined,
    hasInput: true,
    isPortOpen: () => true,
    close: () => undefined,
  };
}
registerConnector(LABEL, makeMockConn);
const fakeDescriptor = {
  id: LABEL,
  display_name: 'Arb Gate Device',
  connection_label: LABEL,
  capabilities: {},
} as unknown as DeviceDescriptor;

// ── 2. interleave detection through the REAL seam ───────────────────────────
{
  console.log('\ninterleave detection through withEndpoint (mock connector):');
  const op = (tag: string) => withEndpoint(fakeDescriptor, async (ctx) => {
    sendLog.push(`${tag}:a`);
    ctx.conn.send([0xf0, 0xf7]);
    await sleep(15);
    ctx.conn.send([0xf0, 0xf7]);
    sendLog.push(`${tag}:b`);
  }, { opName: tag });
  await Promise.all([op('A'), op('B'), op('C')]);
  const wellFormed = /^(A:a,A:b|B:a,B:b|C:a,C:b)(,(A:a,A:b|B:a,B:b|C:a,C:b)){2}$/.test(sendLog.join(','));
  assert(wellFormed, `three concurrent ops never interleaved on one key (got: ${sendLog.join(',')})`);
}

// ── 6. device_busy DispatchError mapping ────────────────────────────────────
{
  console.log('\ndevice_busy mapping at the withEndpoint seam:');
  const hold = deferred();
  const holder = withEndpoint(fakeDescriptor, () => hold.promise, { opName: 'apply_pattern' });
  process.env.MCP_ENDPOINT_WAIT_MS = '40';
  let err: unknown;
  try {
    await withEndpoint(fakeDescriptor, async () => undefined, { opName: 'set_param' });
  } catch (e) {
    err = e;
  } finally {
    delete process.env.MCP_ENDPOINT_WAIT_MS;
  }
  assert(err instanceof DispatchError && err.code === 'device_busy', 'waiter got DispatchError device_busy');
  const msg = err instanceof Error ? err.message : String(err);
  assert(/apply_pattern/.test(msg), 'device_busy names the in-flight op');
  assert(/Nothing was sent/.test(msg), 'device_busy says nothing was sent');
  assert(
    err instanceof DispatchError && /reconnect_midi/.test(err.details?.retry_action ?? ''),
    'retry_action warns against forcing reconnect_midi',
  );

  // ── 7. reconnect-during-hold refuses ──────────────────────────────────────
  console.log('\nreconnect_midi during a hold:');
  const reconnectRefused = await runExclusiveOnEndpoint(LABEL, 'reconnect_midi', async () => 'reconnected', { timeoutMs: 40 })
    .then(() => false, (e) => e instanceof EndpointBusyError);
  assert(reconnectRefused, 'reconnect acquire refused while an op holds the endpoint');

  hold.resolve();
  await holder;
}

// ── 8. kill-switch bypasses serialization ───────────────────────────────────
{
  console.log('\nMCP_DISABLE_ENDPOINT_ARBITER kill-switch:');
  process.env.MCP_DISABLE_ENDPOINT_ARBITER = '1';
  const events: string[] = [];
  try {
    const slow = withEndpoint(fakeDescriptor, async () => {
      events.push('slow:start');
      await sleep(25);
      events.push('slow:end');
    }, { opName: 'slow' });
    await sleep(5);
    await withEndpoint(fakeDescriptor, async () => { events.push('fast:ran'); }, { opName: 'fast' });
    await slow;
  } finally {
    delete process.env.MCP_DISABLE_ENDPOINT_ARBITER;
  }
  assert(
    events.indexOf('fast:ran') < events.indexOf('slow:end'),
    `disabled arbiter lets ops overlap (got: ${events.join(',')})`,
  );
}

// ── 9. ctx-build failure releases the lock ──────────────────────────────────
{
  console.log('\nctx-build failure releases the lock:');
  const ghost = {
    id: 'arb-gate-no-such-device',
    display_name: 'Arb Gate Ghost',
    connection_label: 'arb-gate-no-such-midi-port-zzz',
    capabilities: {},
  } as unknown as DeviceDescriptor;
  const first = await withEndpoint(ghost, async () => 'connected').then(() => 'connected', () => 'port-error');
  const second = await withEndpoint(ghost, async () => 'connected', { opName: 'retry' })
    .then(() => 'connected', (e) => (e instanceof DispatchError && e.code === 'device_busy') ? 'busy' : 'port-error');
  assert(first === 'port-error', 'absent port fails the ctx build (expected)');
  assert(second === 'port-error', 'second attempt gets the port error, NOT device_busy (lock was released)');
}

// sanity: the shipped default wait is conversational (see design: fail-fast).
assert(DEFAULT_ENDPOINT_WAIT_MS === 5000, 'default waiter timeout is 5000 ms');

rmSync(lockDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll endpoint-arbiter checks passed.' : `\n${failures} endpoint-arbiter check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
