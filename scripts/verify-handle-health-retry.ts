/**
 * Offline regression for R2 handle-health: Phase A of the connection
 * arbiter (docs/design/connection-arbiter.md) + the connection canary
 * (docs/design/connection-canary.md Layer A/B), PLUS Phase A.5 (in-call
 * reconnect-and-retry at the execute* dispatcher seam).
 *
 * Exercises the SHARED mechanism directly (packages/core/src/server-shared/
 * handleHealth.ts + connections.ts) and the actual dispatcher seam
 * (packages/core/src/protocol-generic/dispatcher/{core,params}.ts) against a
 * minimal fake device descriptor — not through a spawned MCP server: no
 * hardware, no MIDI ports opened, no mcp-midi-control tool calls. This is
 * the dedicated test script for BK-097 (does not touch
 * scripts/launch-verification.ts, owned by another agent this session).
 *
 * Things asserted:
 *   1. `isHandleHealthy`: the free liveness check (port-presence,
 *      lastSendError, the slowSendSuspect stretch-goal flag).
 *   2. `withReconnectRetry`: reconnect-and-retry-ONCE, never retry-forever,
 *      never a double-reconnect storm, honest failure when the retry (or
 *      the reconnect callback itself) also fails.
 *   3. `ensureConnection`'s proactive canary: a cached handle that died
 *      BETWEEN calls (no forceReconnect, no reconnect_midi) self-heals on
 *      the very NEXT `ensureConnection` call, and a healthy handle is
 *      reused with no redundant reconnect (no storm).
 *   4. Phase A.5 `withHandleFaultRetry` / `isHandleFaultError`: the
 *      THROW-style retry-once wrapper for the execute* seam (as opposed to
 *      #2's RetryableResult-style contract) — same retry-once / no-storm /
 *      honest-failure guarantees, classified by whether the connection's
 *      `lastSendError` got set (or the error text looks handle-shaped).
 *   5. The `execute*` dispatcher seam itself (`executeGetParam` /
 *      `executeSetParam` against a minimal fake registered device): a
 *      handle that THROWS "Internal RtMidi error" on its first send with
 *      `isPortOpen()` still `true` and `lastSendError` initially clean —
 *      the exact Windows clean-USB-replug case Phase A's acquire-time
 *      canary cannot catch (the PRIOR call succeeded, so every canary
 *      signal reads healthy at acquire time; only THIS call's own send
 *      fails) — self-heals in one dispatcher call. Without Phase A.5's fix
 *      this throws all the way to the MCP tool boundary.
 *
 * The Circuit-specific fold-in (`uploadProject.ts` now delegating to this
 * shared mechanism) stays covered by the existing
 * `scripts/verify-circuit-ncs-transfer.ts` stale-handle-auto-recovery block,
 * which this change was required to keep green byte-for-byte (same error
 * strings, same retry-once semantics); see that file for the Circuit-level
 * proof; this file is the device-agnostic, shared-mechanism proof.
 *
 * Run: `npm run build && npx tsx scripts/verify-handle-health-retry.ts`
 */

import {
  ensureConnection, registerConnector,
} from '@mcp-midi-control/core/server-shared/connections.js';
import {
  isHandleFaultError, isHandleHealthy, withHandleFaultRetry, withReconnectRetry,
  type RetryableResult,
} from '@mcp-midi-control/core/server-shared/handleHealth.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { executeGetParam, executeSetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import { registerDevice, unregisterDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import type {
  DeviceDescriptor, DeviceReader, DeviceWriter,
} from '@mcp-midi-control/core/protocol-generic/types.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}

function fakeConn(overrides: Partial<MidiConnection> = {}): MidiConnection {
  return {
    send: () => { /* noop */ },
    receiveSysEx: async () => { throw new Error('unused in this test'); },
    receiveSysExMatching: async () => { throw new Error('unused in this test'); },
    onMessage: () => () => { /* noop */ },
    hasInput: true,
    isPortOpen: () => true,
    close: () => { /* noop */ },
    ...overrides,
  };
}

// ── isHandleHealthy: the free, no-round-trip liveness check ─────────────────
{
  check('isHandleHealthy: healthy handle -> ok', isHandleHealthy(fakeConn()).ok === true);
  check('isHandleHealthy: closed port -> not ok',
    isHandleHealthy(fakeConn({ isPortOpen: () => false })).ok === false);
  check('isHandleHealthy: lastSendError set -> not ok (the ONLY reliable Windows signal)',
    isHandleHealthy(fakeConn({ lastSendError: new Error('Internal RtMidi error') })).ok === false);
  check('isHandleHealthy: slowSendSuspect flag -> not ok (stretch-goal wiring)',
    isHandleHealthy(fakeConn({ slowSendSuspect: true })).ok === false);
  const noIsPortOpen = fakeConn();
  delete (noIsPortOpen as { isPortOpen?: unknown }).isPortOpen;
  check('isHandleHealthy: mock omitting isPortOpen entirely -> ok (optional signal, not required)',
    isHandleHealthy(noIsPortOpen).ok === true);
}

// ── withReconnectRetry: reconnect-and-retry-ONCE, never retry-forever ───────
{
  interface R extends RetryableResult { tag?: string }

  // (a) A stale (handle-level) fault WITH a reconnect callback -> reconnects
  // once, retries once, succeeds.
  {
    let attempts = 0; let reconnects = 0;
    const attempt = async (): Promise<R> => {
      attempts++;
      if (attempts === 1) return { ok: false, error: 'dead handle', staleFault: true };
      return { ok: true };
    };
    const r = await withReconnectRetry(fakeConn(), attempt, {
      reconnect: () => { reconnects++; return fakeConn(); },
      settleMs: 1,
    });
    check('withReconnectRetry: staleFault + reconnect available -> succeeds on the retry',
      r.ok === true && attempts === 2 && reconnects === 1, JSON.stringify({ r, attempts, reconnects }));
  }

  // (b) staleFault with NO reconnect callback -> single attempt, honest failure.
  {
    let attempts = 0;
    const attempt = async (): Promise<R> => { attempts++; return { ok: false, error: 'dead', staleFault: true }; };
    const r = await withReconnectRetry(fakeConn(), attempt, {});
    check('withReconnectRetry: staleFault, no reconnect callback -> single attempt, no retry',
      r.ok === false && attempts === 1, JSON.stringify({ r, attempts }));
  }

  // (c) A device-level (non-stale) failure -> NEVER reconnects; retrying a
  // busy device on a fresh handle would just fail again identically.
  {
    let attempts = 0; let reconnects = 0;
    const attempt = async (): Promise<R> => { attempts++; return { ok: false, error: 'no ACK (device busy)' }; };
    const r = await withReconnectRetry(fakeConn(), attempt, { reconnect: () => { reconnects++; return fakeConn(); } });
    check('withReconnectRetry: device-level (non-stale) failure -> no reconnect attempted',
      r.ok === false && attempts === 1 && reconnects === 0, JSON.stringify({ r, attempts, reconnects }));
  }

  // (d) The retry ALSO fails -> honest final failure; reconnect called EXACTLY
  // once (never retry-forever, never a double-reconnect storm).
  {
    let attempts = 0; let reconnects = 0;
    const attempt = async (): Promise<R> => { attempts++; return { ok: false, error: 'still dead', staleFault: true }; };
    const r = await withReconnectRetry(fakeConn(), attempt, {
      reconnect: () => { reconnects++; return fakeConn(); }, settleMs: 1,
    });
    check('withReconnectRetry: retry ALSO fails -> ok:false, exactly ONE reconnect (no storm, no infinite retry)',
      r.ok === false && attempts === 2 && reconnects === 1 && /retried once/.test(r.error ?? ''),
      JSON.stringify({ r, attempts, reconnects }));
  }

  // (e) reconnect() itself throws -> a combined, honest error, never an
  // uncaught throw out of withReconnectRetry.
  {
    let threw = false; let res: R | undefined;
    const attempt = async (): Promise<R> => ({ ok: false, error: 'dead', staleFault: true });
    try {
      res = await withReconnectRetry(fakeConn(), attempt, {
        reconnect: () => { throw new Error('port busy'); }, settleMs: 1,
      });
    } catch { threw = true; }
    check('withReconnectRetry: reconnect() throws -> ok:false + "auto-reconnect also failed", not an uncaught throw',
      !threw && res?.ok === false && /auto-reconnect also failed/.test(res?.error ?? ''),
      JSON.stringify({ threw, res }));
  }

  // (f) Extra result fields survive the wrapper untouched (spread-through, not
  // a hand-rolled {ok,error} reconstruction that would drop caller-specific data).
  {
    const attempt = async (): Promise<R> => ({ ok: true, tag: 'payload-preserved' });
    const r = await withReconnectRetry(fakeConn(), attempt, {});
    check('withReconnectRetry: extra result fields pass through untouched',
      r.tag === 'payload-preserved', JSON.stringify(r));
  }
}

// ── Phase A.5: withHandleFaultRetry / isHandleFaultError (THROW-style ──────
// retry-once, the execute* dispatcher seam's underlying primitive) ─────────
{
  // A mock connection whose `send()` throws on demand and sets
  // `lastSendError` first (matching midi/transport.ts's real `send()`,
  // which ALWAYS sets `lastSendError` before rethrowing). Built as a RAW
  // object literal, not via `fakeConn({...})` spread — spreading an object
  // with a getter freezes its value at spread-time (`{...obj}` invokes the
  // getter ONCE and copies the result as a plain data property), which would
  // silently break the "live" `lastSendError` semantics this test depends on.
  function throwingConn(shouldThrow: () => boolean): MidiConnection {
    let lastErr: Error | undefined;
    return {
      send: () => {
        if (shouldThrow()) { lastErr = new Error('Internal RtMidi error'); throw lastErr; }
        lastErr = undefined;
      },
      get lastSendError() { return lastErr; },
      receiveSysEx: async () => { throw new Error('unused in this test'); },
      receiveSysExMatching: async () => { throw new Error('unused in this test'); },
      onMessage: () => () => { /* noop */ },
      hasInput: true,
      isPortOpen: () => true,
      close: () => { /* noop */ },
    };
  }

  // (a) isHandleFaultError: lastSendError set -> true; a plain unrelated
  // throw with no lastSendError -> false (device/logic-level, not a handle
  // fault).
  {
    const conn = throwingConn(() => true);
    try { conn.send([]); } catch { /* arm lastSendError */ }
    check('isHandleFaultError: lastSendError set -> true (handle fault)',
      isHandleFaultError(new Error('Internal RtMidi error'), conn) === true);
    const cleanConn = fakeConn();
    check('isHandleFaultError: unrelated error + clean lastSendError -> false (not a handle fault)',
      isHandleFaultError(new Error('unknown param "foo"'), cleanConn) === false);
  }

  // (b) Clean-replug throw + reconnect available -> reconnects once, retries
  // once, SUCCEEDS on the fresh handle. This is the exact case Phase A's
  // acquire-time canary cannot catch (the prior call succeeded, so
  // isPortOpen()/lastSendError both read healthy at acquire time; only
  // THIS call's own send fails) — without the Phase A.5 fix this throws.
  {
    let reconnects = 0;
    const connA = throwingConn(() => true); // every send throws (stale post-replug handle)
    const connB = throwingConn(() => false); // fresh handle: healthy
    const result = await withHandleFaultRetry(
      connA,
      async (c) => { c.send([0xf0, 0xf7]); return 'value-from-fresh-handle'; },
      { reconnect: () => { reconnects++; return connB; }, settleMs: 1 },
    );
    check('withHandleFaultRetry: clean-replug throw self-heals (reconnect once, retry succeeds)',
      result === 'value-from-fresh-handle' && reconnects === 1, JSON.stringify({ result, reconnects }));
  }

  // (c) Retry-once-never-forever: the FRESH handle ALSO throws -> the error
  // surfaces (thrown, not swallowed), reconnect called at MOST once (no
  // infinite retry, no double-reconnect storm).
  {
    let reconnects = 0;
    const connA = throwingConn(() => true);
    const connB = throwingConn(() => true); // fresh handle is ALSO dead
    let threw: string | undefined;
    try {
      await withHandleFaultRetry(
        connA,
        async (c) => { c.send([0xf0, 0xf7]); return 'unreachable'; },
        { reconnect: () => { reconnects++; return connB; }, settleMs: 1 },
      );
    } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check('withHandleFaultRetry: retry ALSO fails -> error surfaces (thrown), exactly ONE reconnect (no storm)',
      threw !== undefined && reconnects === 1 && /retried once/.test(threw), `threw=${threw}, reconnects=${reconnects}`);
  }

  // (d) A device-level (non-handle) failure -> NEVER reconnects; the
  // original error propagates on the FIRST try, unmodified (no retry-then-
  // identical-failure, no swallowed DispatchError-shaped detail).
  {
    let reconnects = 0; let attempts = 0;
    const conn = fakeConn(); // healthy connection; the throw is unrelated to it
    let threw: string | undefined;
    try {
      await withHandleFaultRetry(
        conn,
        async () => { attempts++; throw new Error('unknown param "foo" for block "amp"'); },
        { reconnect: () => { reconnects++; return fakeConn(); } },
      );
    } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check('withHandleFaultRetry: device/logic-level throw (no lastSendError) -> NOT retried, no reconnect',
      threw === 'unknown param "foo" for block "amp"' && attempts === 1 && reconnects === 0,
      `threw=${threw}, attempts=${attempts}, reconnects=${reconnects}`);
  }

  // (e) reconnect() itself throws -> a combined, honest error, never an
  // uncaught crash with a confusing native message.
  {
    const connA = throwingConn(() => true);
    let threw: string | undefined;
    try {
      await withHandleFaultRetry(
        connA,
        async (c) => { c.send([0xf0, 0xf7]); return 'unreachable'; },
        { reconnect: () => { throw new Error('port busy'); }, settleMs: 1 },
      );
    } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check('withHandleFaultRetry: reconnect() throws -> combined "auto-reconnect also failed" error',
      threw !== undefined && /auto-reconnect also failed/.test(threw), `threw=${threw}`);
  }

  // (f) No reconnect callback supplied -> the original throw propagates
  // as-is (auto-recovery disabled; matches offline tests / storage ctx with
  // no MIDI handle).
  {
    const connA = throwingConn(() => true);
    let threw: string | undefined;
    try {
      await withHandleFaultRetry(connA, async (c) => { c.send([0xf0, 0xf7]); return 'unreachable'; }, {});
    } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check('withHandleFaultRetry: no reconnect callback -> original throw propagates unmodified',
      threw === 'Internal RtMidi error', `threw=${threw}`);
  }
}

// ── Phase A.5: the execute* dispatcher seam itself, against a minimal fake ──
// registered device (proves the ACTUAL wiring in params.ts / dispatcher/    ──
// core.ts, not just the underlying primitive tested above) ─────────────────
{
  function makeFakeDescriptor(id: string, writer: DeviceWriter, reader: DeviceReader): DeviceDescriptor {
    return {
      id,
      display_name: `Test Device (${id})`,
      port_match: [{ pattern: id }],
      connection_label: id,
      capabilities: {
        slot_model: 'linear',
        has_scenes: false,
        has_channels: false,
        supports_save: false,
        supports_lineage: false,
      },
      canonical_terms: {
        block: 'block', slot: 'slot', preset: 'preset', scene: 'scene', channel: 'channel', location: 'location',
      },
      blocks: {
        amp: {
          display_name: 'Amp',
          params: {
            gain: { display_name: 'Gain', unit: 'knob', encode: (v) => Number(v), decode: (w) => w },
          },
        },
      },
      reader,
      writer,
    };
  }

  // Raw object literal (not `fakeConn({...})` spread — see the primitive-
  // level `throwingConn` above for why spreading a getter breaks it).
  function throwingConn(shouldThrow: () => boolean): MidiConnection {
    let lastErr: Error | undefined;
    return {
      send: () => {
        if (shouldThrow()) { lastErr = new Error('Internal RtMidi error'); throw lastErr; }
        lastErr = undefined;
      },
      get lastSendError() { return lastErr; },
      receiveSysEx: async () => { throw new Error('unused in this test'); },
      receiveSysExMatching: async () => { throw new Error('unused in this test'); },
      onMessage: () => () => { /* noop */ },
      hasInput: true,
      // The exact clean-replug case: isPortOpen() stays true throughout —
      // the PRIOR call succeeded, so this handle "looks" healthy at
      // ensureConnection's acquire-time canary. Only THIS call's own send
      // (fired below) reveals the fault.
      isPortOpen: () => true,
      close: () => { /* noop */ },
    };
  }

  const writer: DeviceWriter = {
    buildSetParam: () => [],
    async setParam(ctx, block, name, wireValue) {
      ctx.conn.send([0xf0, 0x00, 0xf7]);
      return { acked: true, op: 'set_param', block, name, wire_value: wireValue, display_value: wireValue };
    },
  };
  const reader: DeviceReader = {
    async getParam(ctx, block, name) {
      ctx.conn.send([0xf0, 0x00, 0xf7]);
      return { block, name, wire_value: 5, display_value: 5, unit: 'knob' };
    },
    async getParams() { return { reads: [], failed_indices: [] }; },
  };

  // (a) executeGetParam: clean-replug throw on the CACHED handle self-heals
  // within this single call (reconnect + retry succeeds). Without the
  // Phase A.5 fix, this throws "Internal RtMidi error" to the caller.
  {
    const LABEL = 'test-a5-getparam-selfheal';
    let factoryCalls = 0;
    const connA = throwingConn(() => true); // stale handle: every send throws
    const connB = throwingConn(() => false); // fresh handle after reconnect: healthy
    registerConnector(LABEL, () => { factoryCalls++; return factoryCalls === 1 ? connA : connB; });
    registerDevice(makeFakeDescriptor(LABEL, writer, reader));
    try {
      const result = await executeGetParam({ port: LABEL, block: 'amp', name: 'gain' });
      check('execute* seam: executeGetParam self-heals a clean-replug throw (reconnect + retry succeeds)',
        result.display_value === 5 && factoryCalls === 2, JSON.stringify({ result, factoryCalls }));
    } finally {
      unregisterDevice(LABEL);
    }
  }

  // (b) executeSetParam: same self-heal on the WRITE side.
  {
    const LABEL = 'test-a5-setparam-selfheal';
    let factoryCalls = 0;
    const connA = throwingConn(() => true);
    const connB = throwingConn(() => false);
    registerConnector(LABEL, () => { factoryCalls++; return factoryCalls === 1 ? connA : connB; });
    registerDevice(makeFakeDescriptor(LABEL, writer, reader));
    try {
      const result = await executeSetParam({ port: LABEL, block: 'amp', name: 'gain', value: 7 });
      check('execute* seam: executeSetParam self-heals a clean-replug throw (reconnect + retry succeeds)',
        result.acked === true && factoryCalls === 2, JSON.stringify({ result, factoryCalls }));
    } finally {
      unregisterDevice(LABEL);
    }
  }

  // (c) Retry-once-never-forever at the seam: the fresh handle ALSO throws
  // -> the error surfaces from the tool-level call (no infinite loop),
  // reconnect called at most once.
  {
    const LABEL = 'test-a5-getparam-retry-once';
    let factoryCalls = 0;
    const connA = throwingConn(() => true);
    const connB = throwingConn(() => true); // fresh handle is ALSO dead
    registerConnector(LABEL, () => { factoryCalls++; return factoryCalls === 1 ? connA : connB; });
    registerDevice(makeFakeDescriptor(LABEL, writer, reader));
    let threw: string | undefined;
    try {
      await executeGetParam({ port: LABEL, block: 'amp', name: 'gain' });
    } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    finally { unregisterDevice(LABEL); }
    check('execute* seam: retry ALSO fails -> error surfaces, factory called exactly twice (no storm)',
      threw !== undefined && factoryCalls === 2, `threw=${threw}, factoryCalls=${factoryCalls}`);
  }

  // (d) Device-level failure AT THE WIRE OP (post-acquire, e.g. a no-ACK /
  // busy rejection that never touches conn.send / never sets lastSendError)
  // is NOT retried — no reconnect, no second factory call. Distinct from an
  // unknown-param error (which fails during name resolution BEFORE a
  // connection is even acquired, so factoryCalls would stay 0 — not a
  // useful case for proving "acquired-but-rejected isn't retried").
  {
    const LABEL = 'test-a5-getparam-device-level-no-retry';
    let factoryCalls = 0;
    const connA = throwingConn(() => false); // healthy handle throughout
    registerConnector(LABEL, () => { factoryCalls++; return connA; });
    const deviceLevelReader: DeviceReader = {
      async getParam() { throw new Error('device busy: no ACK within timeout'); },
      async getParams() { return { reads: [], failed_indices: [] }; },
    };
    registerDevice(makeFakeDescriptor(LABEL, writer, deviceLevelReader));
    let threw: string | undefined;
    try {
      await executeGetParam({ port: LABEL, block: 'amp', name: 'gain' });
    } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    finally { unregisterDevice(LABEL); }
    check('execute* seam: device-level throw at the wire op (no lastSendError) -> not retried, factory called once',
      threw === 'device busy: no ACK within timeout' && factoryCalls === 1,
      `threw=${threw}, factoryCalls=${factoryCalls}`);
  }
}

// ── ensureConnection canary: self-heal on the NEXT call, no forceReconnect ──
{
  const LABEL = 'test-r2-canary-isportopen';
  let factoryCalls = 0;
  let connAHealthy = true;
  const connA: MidiConnection = fakeConn({ isPortOpen: () => connAHealthy });
  const connB: MidiConnection = fakeConn();
  registerConnector(LABEL, () => { factoryCalls++; return factoryCalls === 1 ? connA : connB; });

  const first = ensureConnection(LABEL);
  check('ensureConnection: first call opens via the factory', first === connA && factoryCalls === 1);

  // Simulate a replug death BETWEEN tool calls: no forceReconnect, no
  // reconnect_midi. This is the exact "first call fails, second succeeds"
  // scenario R2 exists to fix.
  connAHealthy = false;
  const second = ensureConnection(LABEL);
  check('ensureConnection: canary detects the dead handle -> self-heals on the NEXT call (fresh connB)',
    second === connB && factoryCalls === 2, JSON.stringify({ factoryCalls, healed: second === connB }));

  const third = ensureConnection(LABEL);
  check('ensureConnection: healthy handle is reused -> no reconnect storm (factory not called a 3rd time)',
    third === connB && factoryCalls === 2, `factoryCalls=${factoryCalls}`);
}

// ── ensureConnection canary: the lastSendError signal (the ONLY reliable ────
// Windows liveness signal; poison-probe-verified per connection-canary.md) ──
{
  const LABEL = 'test-r2-canary-lastsenderror';
  let factoryCalls = 0;
  let err: Error | undefined;
  const connA: MidiConnection = {
    send: () => { /* noop */ },
    receiveSysEx: async () => { throw new Error('unused'); },
    receiveSysExMatching: async () => { throw new Error('unused'); },
    onMessage: () => () => { /* noop */ },
    hasInput: true,
    isPortOpen: () => true,
    close: () => { /* noop */ },
    get lastSendError() { return err; },
  };
  const connB: MidiConnection = fakeConn();
  registerConnector(LABEL, () => { factoryCalls++; return factoryCalls === 1 ? connA : connB; });

  ensureConnection(LABEL);
  err = new Error('Internal RtMidi error'); // set by a PRIOR call's send(), as the real transport does
  const after = ensureConnection(LABEL);
  check('ensureConnection: lastSendError from a prior call also self-heals on the next acquire',
    after === connB && factoryCalls === 2, `factoryCalls=${factoryCalls}`);
}

// ── ensureConnection: a forced reconnect still bypasses the counter/canary ──
// path cleanly (unchanged pre-existing behavior; regression guard). ────────
{
  const LABEL = 'test-r2-forcereconnect-unchanged';
  let factoryCalls = 0;
  registerConnector(LABEL, () => { factoryCalls++; return fakeConn(); });
  const a = ensureConnection(LABEL);
  const b = ensureConnection(LABEL); // healthy, reused
  const callsBeforeForce = factoryCalls; // snapshot BEFORE the forced call below also bumps it
  check('ensureConnection: healthy handle reused without force (no redundant reconnect)',
    a === b && callsBeforeForce === 1, `factoryCalls=${callsBeforeForce}`);
  const c = ensureConnection(LABEL, true); // forced
  check('ensureConnection: forceReconnect still reopens regardless of health', c !== a && factoryCalls === 2);
}

console.log('');
if (failed > 0) { console.error(`x ${failed} handle-health check(s) FAILED.`); process.exit(1); }
console.log(
  'OK verify-handle-health-retry: isHandleHealthy + withReconnectRetry (retry-once, no storm, honest ' +
  'failure) + ensureConnection R2 canary self-heal (port-presence + lastSendError signals, no redundant ' +
  'reconnect on a healthy handle, forceReconnect unchanged) + Phase A.5 withHandleFaultRetry/' +
  'isHandleFaultError (throw-style retry-once) + the execute* dispatcher seam itself (executeGetParam/' +
  'executeSetParam self-heal a clean-replug throw against a fake registered device) verified (offline).',
);
