# Connection arbiter: design

Status: **Phase A (R2 handle-health) SHIPPED 2026-07-09.** Phase B (R1
per-endpoint serialization + R3 contention/cancellation) is the remaining
forward-looking orchestration foundation, not started. See "Phase A: shipped
2026-07-09" under Phasing below for what landed, where, and what Phase B
still needs to build on top of it.

Status (pre-Phase-A, kept for context): **sound, ready to build (revised after a 5-lens design review).** The
mechanical-but-dangerous half of the multi-device song-orchestration vision
(Decision 2 in [device-archetypes-and-transport.md](device-archetypes-and-transport.md)):
the agent reasons about *what* each device should do; the arbiter owns *that the
handle is healthy* and *when a device may be touched*. Pairs with `describe_rig`
(the agent's "see the stage" read) as the "drive the stage safely" write-side.

The review reframed two things from the first draft, both folded in here: the
load-bearing present-value win is **handle health (R2)**, which ships first;
**per-endpoint serialization (R1) + contention/cancellation (R3)** are the
forward-looking orchestration foundation. And the lock lives at **one seam
(`openCtx`)**, not scattered across every call site.

## Mental model & how it's used

The single most important thing: **nobody ever calls the arbiter.** Not the
musician, not the AI agent, not most of our own code. It is invisible plumbing
under every tool. "How it's used" means "what it quietly does on your behalf."

**The bouncer at each device's door.** Every connected device (FM9, AM4, Circuit,
SPD-SX) is a room with one door. Today there is no bouncer: any operation can
walk in anytime, two can collide (two SysEx streams interleave into a garble the
device can't parse), and nobody checks the room is still there (a handle can die
mid-use while we keep "sending" into the void). The arbiter is a bouncer on each
door enforcing two rules:

1. **Check the room is alive before letting anyone in** (R2, ships first). Verify
   the handle; if it faults, reconnect and retry once, transparently.
2. **One operation in the room at a time** (R1, orchestration phase). A second op
   to the *same* device waits; ops to *different* devices use *different* doors
   and never wait on each other.

The "door" is the *endpoint*, usually a MIDI port, but also the FM3's serial
line or the SPD-SX's mounted drive. Same bouncer, every transport.

**What each party experiences:**

- **The musician:** nothing new in the normal case (no contention = waved straight
  through). You only notice it when it *saves* you: a clean result because the
  second op waited, a transparent reconnect-and-retry instead of a dead-port
  silent failure, or a clear "the FM9 is busy finishing a pattern"; never a
  corrupted patch, never a fake "done."
- **The AI agent:** keeps calling tools exactly as today. It learns no new tool and
  manages no connections. New things it can encounter: a `device_busy` error
  (handled like any other: wait/retry or tell the user) and an advisory
  `busy_hint` in `describe_rig`.
- **A device author:** writes the descriptor's reader/writer as today and gets
  health recovery + serialization for free.

**Worked scenario**: "set me up for a song: heavy tone on the FM9, half-time
groove on the Circuit, fat-snare kit on the SPD-SX":

- `apply_preset(fm9)` → FM9 door free, runs, holds the door ~1 s.
- `apply_pattern(circuit)` → *different* door, parallel; a live-stream holds the
  Circuit for several bars.
- `author_kit(spd-sx)` → *different* door (mounted drive); "back up old kit then
  write new" runs as one atomic visit, so nothing slips in and corrupts it.
- `set_param(circuit, tempo)` *while the pattern streams* → *same* Circuit door,
  occupied → it waits, then runs cleanly when the stream ends, or fails fast with
  "Circuit is busy streaming" (and the user can cancel the stream).

Without per-endpoint serialization, that last step is a real corruption risk:
two MIDI streams interleaved into one port. **Note (attribution):** the *logged*
Circuit-reboot and "169 writes into a dead port reported success" incidents were
a *different* cause (a second process holding the exclusive port, and a WinMM
handle poisoned mid-send) which serialization does **not** fix. Those are the
health/liveness (R2) and cross-process (out-of-scope) problems, below. Don't
conflate them: R1 prevents an interleave we have not yet logged; R2 fixes the
ones we have.

**2026-07-27 attribution update.** The "poisoned mid-send" half was narrower
than this framing assumed. `close()` closed the INPUT port first; a throwing
input close (WinMM `midiInUnprepareHeader` on a handle poisoned mid-SysEx, not
wrapped by `NodeMidiInput::ClosePort`) aborted the whole close and leaked the
OUTPUT port for the process lifetime, so the next `connect()` tripped its own
`isPortOpen()` assertion against our own handle. Fixed in
`releaseNativeHandles` (`packages/core/src/midi/transport.ts`): output closes
first, each step isolated, no retry on a throwing input close. R2's
"reconnect and retry once" therefore now actually recovers where it previously
could not. `isPortOpen()` still lies for a poisoned input handle, so the
in-band liveness reasoning below is unchanged.

## What it solves, and what it cannot

In scope:

1. **Handle health (R2).** Every operation runs against a verified-or-reconnected
   handle; a fault reconnects-and-retries once in-band. Folds the scattered
   recovery (Circuit in-transfer guard, stale-handle counter, `uploadProject`'s
   reconnect, cold-start resend) into one place every device gets.
2. **Per-endpoint serialization (R1).** At most one operation per endpoint at a
   time, so overlapping calls can't interleave into a corrupt stream. Latent-safe
   today only because one chat serializes calls, which the MCP spec does **not**
   guarantee (concurrent requests are legal; a long stream or upload holds a
   device for seconds).
3. **Graceful contention (R3).** A busy endpoint makes a waiter block briefly then
   fail fast with a clear `device_busy`; long holders are escapable by
   **cancellation**, not by waiting.

**What it CANNOT do (hard boundary, state this up front):**

- **No cross-process coordination.** The lock is a single in-process structure. It
  cannot stop a *second* MCP server instance, an orphaned prior process, or
  AxeEdit/Components from holding the same exclusive port. That class (the actual
  cause of the logged incidents) is mitigated separately (the server already
  self-terminates on client disconnect to release ports, and `connect()` reports a
  held port with the likely holder) and a hard guard (single-instance lockfile /
  OS named mutex / boot-time port-claim) is **deferred**, noted as future work
  below. The arbiter must not be sold as fixing it.
- **No musical timing.** It guarantees *who may touch a device and when it's safe*,
  not tempo-aligning sends across devices. That stays the agent's / a future
  setlist tool's job, keeping reasoning in the model.

## Current state (`packages/core/src/server-shared/connections.ts`)

- `ensureConnection(label, forceReconnect)`: per-`label` registry
  (`Map<label, { conn, consecutiveTimeouts, cold }>`), opened via a connector
  factory or generic `connect()`, then cached.
- Stale detection: `recordAckOutcome` bumps `consecutiveTimeouts`; at threshold 2
  the next `ensureConnection` force-reconnects.
- `openCtx(descriptor)` (dispatcher/core.ts) → `ensureConnection(label)` →
  `DispatchCtx`. **Synchronous.** It is the single membrane that resolves
  `transport.kind`, builds `{ conn, storage:{root}, descriptor, reconnect }`, and
  substitutes `createNullMidiConnection` for storage devices.
- `reconnect_midi` calls `ensureConnection(label, true)` → `closeMidiSafely()`
  **directly, with no coordination**: it can close a port out from under an
  in-flight op.
- Windows MIDI ports are **exclusive**; `isPortOpen()` is a negative catch only (a
  mid-send-poisoned WinMM handle still reports open). No mutex exists.

## Requirements

| # | Requirement | Phase |
|---|---|---|
| R1 | One op at a time per endpoint (serialize) | B |
| R2 | Acquire returns a healthy handle; prove liveness **in-band**, reconnect-and-retry-once on fault | **A (ships first)** |
| R3 | Bounded waiter wait → fast `device_busy`; **cancellation** (AbortSignal) for long holders | B |
| R4 | Transport-aware: MIDI, serial, storage/hybrid | A + B |

**Capacity / rotation is explicitly out of scope** (cut from the design, not
default-off): no rig has exhausted handles, and LRU eviction adds evict-vs-acquire
races *and* re-triggers the USB warm-up first-ACK-drop on every reopen, silently
degrading reliability. If a real rig ever caps out, an explicit idle/disconnect
tool is simpler than transparent rotation.

## Design

### The seam: `withEndpoint(descriptor, fn)` that absorbs `openCtx`

The lock lives at **one membrane**, not ~25 call sites. `openCtx` already owns
transport resolution + ctx construction; the arbiter owns the same resolution
plus the lock:

```ts
// connections.ts (or a thin arbiter.ts beside it)
withEndpoint<T>(descriptor: DeviceDescriptor, fn: (ctx: DispatchCtx, signal: AbortSignal) => Promise<T>): Promise<T>
```

It (1) derives the lock key, (2) acquires the per-endpoint lock, (3) builds the
`DispatchCtx` (the current `openCtx` body: transport branch, storage root,
null-conn, reconnect), (4) runs `fn` with health recovery (R2) and an
`AbortSignal` (R3), (5) releases in `finally`.

Each I/O `execute*` changes by one line: `const ctx = openCtx(d); return writer.foo(ctx, …)`
becomes `return withEndpoint(d, (ctx) => writer.foo(ctx, …))`. Crucially, a
**missed wrap is a `tsc` error**, not a silent serialization hole: bare `openCtx`
stops being exported for I/O paths, so there is no way to get a usable ctx without
going through the lock. Storage/hybrid/`reconnect` logic stays in one place
instead of being hand-rebuilt per call. (The even-cleaner end state, an
auto-wrapping reader/writer decorator applied at descriptor registration, is
noted as a later refinement; the explicit `withEndpoint` is the P-B target.)

### Lock key = `connection_label ?? id`

Same key as the existing connection registry, so the lock and the handle-health
state co-locate under one key. The earlier "resolved endpoint" idea is dropped:
`MidiConnection` exposes no port name, and the SPD-SX hybrid's endpoint *changes
by USB mode* (drive root vs MIDI port): two ops across a mode flip would get two
keys and fail to serialize. Instead, the handle/root is **re-resolved fresh inside
the lock on each acquire**, so a mode flip is simply seen on the next acquire. (A
real two-descriptors-one-physical-port device would revisit this; none exists.)

### Reentrancy invariant (prevents self-deadlock)

A non-reentrant per-endpoint mutex self-deadlocks if a locked op calls another
locked op on the same endpoint. Two such paths exist today:

- `executeSetModRoute` / `executeSetMacroRoute` call `executeSetParam` 2–3× on the
  same port.
- `executeTranslatePreset` reads the **source** (via raw `openCtx`) while calling
  `executeApplyPreset` on the **target**: two endpoints, nested.

The invariant: **an `execute*` holds at most one endpoint lock and never calls
another `execute*` while holding it.** Enforced by:

- **Composites call unlocked inner functions.** `set_mod_route` acquires once, then
  calls the *unwrapped* param-write core (not `executeSetParam`) under that single
  lock.
- **Multi-endpoint ops acquire in a canonical order** (sorted by key) and release
  each before the next where possible. `executeTranslatePreset` reads + releases
  the source, *then* acquires the target; never both held nested.
- **A reentrancy guard throws** a clear error (`endpoint already held in this call
  chain`) rather than deadlocking, so a future violation fails loud in tests.

### The mutex: `async-mutex`, not hand-rolled

Use `async-mutex` (`runExclusive` + `withTimeout`, ~3 KB, mature). A bare
promise-chain mutex with a bounded timeout is exactly the combination that leaks:
a waiter that extended the tail then timed out leaves a dangling link, and on
release the lock is handed to an abandoned, already-rejected waiter → the endpoint
deadlocks forever. ("Zero-dep" was never an invariant; the project already ships
`@julusian/midi`, `serialport`, `zod`, the MCP SDK.)

`withEndpoint` does **not** call `recordAckOutcome`; leaf I/O keeps ownership of
the ack counter, so wrapping doesn't double-count.

### R2: health & liveness (ships first, no lock required)

`isPortOpen()` lies for a poisoned handle, and a real first-ACK probe on every
acquire adds 30–60 ms (a `get_param` becomes two round-trips, blowing the <200 ms
budget). So liveness is proven **in-band**, not pre-flight:

- Keep the *free* stale-counter force-reconnect at acquire.
- Run `fn`; on a handle fault (throw / `lastSendError` set / stale-fault),
  **reconnect once and retry `fn`**, generalizing `uploadProject`'s existing
  recovery. This in-op reconnect is **lock-free**: it operates on the held slot
  and never re-enters the mutex.

This is the present-value reliability win and needs no serialization, so it ships
in Phase A on its own.

### R3: contention & cancellation

- **Waiter timeout bounds the WAITER, not the op.** Deliberately short (fail-fast),
  because real op durations are long: `awaitCommitMs` ≈ 6–8 s, `upload_kit` ≈
  270 s, live-streams many bars. A second op queued behind a *healthy* long
  transfer must not false-trip, so it doesn't wait it out, it gets a `device_busy`
  that distinguishes **"briefly busy, retry"** from **"busy for the whole stream,
  don't wait"** (using the holder metadata below).
- **Cancellation is the escape for long holders, not the timeout.** Thread an
  `AbortSignal` into `fn`; wire it to the MCP SDK's `notifications/cancelled` so
  "stop the pattern" actually unwinds a streaming holder (which `send_panic`
  cannot). The live-stream holder gets a real stop checkpoint (it already loops per
  cycle; check the signal there). Add **graceful SIGINT/SIGTERM shutdown** that
  aborts in-flight ops and lets them release **before** the existing synchronous
  `process.on('exit')` / `shutdown()` close yanks a port mid-transfer.
- **`reconnect_midi` routes through the lock.** It either acquires the endpoint
  (waiting its turn) or refuses with "busy, can't reconnect mid-op," so an agent
  that sees `device_busy` and "helpfully" reconnects can't close the port out from
  under a streaming holder. The Health section distinguishes a *holder's own*
  in-op reconnect (allowed, it owns the slot) from a *concurrent external*
  reconnect (must take the lock).
- **`device_busy` is added to the `ErrorCode` union** (it currently won't
  typecheck) with `details.retry_action`, plus an `MCP_DISABLE_ENDPOINT_ARBITER`
  kill-switch env so the whole layer can be turned off if it ever misbehaves.

### Transport-awareness (R4)

MIDI / serial / storage all key by `connection_label ?? id`. Storage endpoints use
the same lock (atomic `author_kit` = back-up-then-write) at no MIDI-handle cost.
Hybrid (SPD-SX) re-resolves root/handle fresh inside the lock each acquire, so a
USB-mode flip is handled on the next acquire rather than serving a stale key.

### `describe_rig` visibility (advisory only)

Add `busy_hint` (not `busy`) to each device in `describe_rig`: **advisory, never
gated on** (a busy flag the agent acts on is a TOCTOU race: it can flip between
the read and the call). The P-B lock cell carries holder metadata
`{ holderOpName, acquiredAt, waiterCount }` so a `device_busy` error can name the
in-flight op ("busy: apply_pattern started 4 s ago").

## Phasing

- **Phase A: health/liveness (R2), SHIPPED 2026-07-09.** In-band
  reconnect-and-retry-once, generalized into
  `packages/core/src/server-shared/handleHealth.ts`:
  - `isHandleHealthy(conn)`: the free, no-round-trip liveness check
    (port-presence + `lastSendError` + the new `slowSendSuspect` flag).
    Generalizes the bespoke copy that used to live only in
    `circuit-tracks/ncs/uploadProject.ts`; that file now imports the shared
    function instead of holding its own copy.
  - `withReconnectRetry(conn, attempt, opts)`: the reconnect-and-retry-once
    wrapper. `uploadProject.ts`'s `runUploadFramePlan` / `downloadProject`
    (both project AND sample transfers, since `uploadSample.ts` calls the
    same `runUploadFramePlan`) now delegate to it instead of hand-rolling the
    sleep/reconnect/retry choreography per call site.
  - **`ensureConnection` (`connections.ts`) runs the canary proactively**
    before handing back a CACHED handle (connection-canary.md Layer A): a
    replug or a handle that died mid-send on a PRIOR call self-heals on the
    very NEXT acquire, with no probe send added. This is the seam-level
    change: every device that goes through the registry gets it, not just
    Circuit Tracks.
  - **Read-path staleness participation** (connection-canary.md Layer B):
    `uploadProject`/`downloadProject` now call the existing
    `recordAckOutcome` counter on every outcome EXCEPT a legitimate
    empty-slot answer (no READ_INIT); a missing READ_INIT is a real "the
    slot is free" result, not a proof the handle is dead, and must not
    count toward the stale-counter threshold.
  - **Stretch goal shipped**: `connect()` (`midi/transport.ts`) wall-clocks
    each synchronous `sendMessage` call; a send over `SLOW_SEND_THRESHOLD_MS`
    (250ms) is logged and sets `conn.slowSendSuspect`, which
    `isHandleHealthy` now treats as unhealthy on the next acquire. Honest
    limit unchanged from the canary doc: a send that never returns at all
    (the true queue-stalled hang) still cannot be observed, only "slow but
    eventually returned."
  - **What Phase A explicitly did NOT touch**: the `openCtx` seam itself
    (`protocol-generic/dispatcher/core.ts`) is untouched; `withReconnectRetry`
    is available for any `execute*` to adopt, but no dispatcher call site was
    rewired to call it directly (Circuit's own transfer functions are the
    only current callers). Wiring `withReconnectRetry` through `openCtx`/
    `execute*` uniformly, so a bare `set_param`/`get_param` on a stale AM4 or
    Axe-Fx handle also self-heals in-band (today those devices lean on the
    proactive `ensureConnection` canary alone, which covers the "cached
    handle already known-bad" case but not "this call's own send just
    failed"), is unclaimed work: natural Phase A.5 or folded into Phase B's
    `withEndpoint` seam.
- **Phase B: serialization + contention + cancellation (R1 + R3).** The
  `withEndpoint(descriptor, fn)` seam, `async-mutex`, lock key = label, the
  reentrancy invariant + composite refactor, `AbortSignal`/MCP cancellation +
  live-stream stop checkpoint + graceful shutdown, `reconnect_midi` through the
  lock, `device_busy` + kill-switch. The orchestration foundation. Cancellation is
  built **with** the lock here, not deferred.
- **Phase C: observability.** `busy_hint` in `describe_rig` + a lock-wait metric,
  so a jammed rig is diagnosable.

## Resolved decisions

- **Long-running holders hold for the whole op** (was OQ1; resolved to "hold"). A
  live-stream *is* exclusive use of that device; a concurrent write to the same box
  mid-pattern is almost always a mistake. This is exactly why granularity is
  **per-endpoint, not global** (holding one device for a stream never blocks any
  other device) and it is paired with the cancellation checkpoint so a long hold
  is always escapable.
- **`async-mutex` dependency** over hand-rolling (the leak bug is what's hard to get
  right by hand).
- **Cancellation lands in Phase B**, not a later add-on.
- **Capacity/rotation removed** from the design.

## Deferred / future work

- **Cross-process port guard.** A single-instance lockfile / OS named mutex /
  boot-time port-claim to coordinate across MCP server processes. This is the
  actual fix for the logged "two processes on one port" incidents; deferred
  because the existing self-terminate-on-disconnect + held-port diagnostic
  mitigate it and a hard guard is its own effort. Tracked here so it isn't
  mistaken for something the arbiter already does.
- **Auto-wrapping reader/writer decorator** at registration (so `withEndpoint` is
  applied structurally, not per-call), the cleaner end state after Phase B proves
  the seam.

## Test plan

Phase A: DONE, `scripts/verify-handle-health-retry.ts` (new, device-agnostic,
offline) + the pre-existing `scripts/verify-circuit-ncs-transfer.ts`
stale-handle block (kept green byte-for-byte through the fold-in):
- A handle fault inside an op triggers exactly one reconnect-and-retry; a second
  fault surfaces honestly (no infinite retry). ✅
- The in-op reconnect is lock-free (does not re-enter / block). ✅ (no lock
  exists yet in Phase A, so this is true by construction)
- Additionally covered: `ensureConnection`'s proactive canary self-heals a
  cached handle that died between calls (no `forceReconnect` needed) on
  BOTH signals (`isPortOpen() === false` and `lastSendError` set); a healthy
  handle is reused with zero redundant reconnects (no "storm"); `reconnect()`
  itself throwing is surfaced as a combined, honest error instead of an
  uncaught throw; extra result fields pass through the wrapper untouched.

Phase B:
- Two concurrent `withEndpoint(d, …)` on the same key **serialize** (the second
  starts only after the first resolves); a third on a *different* key runs in
  parallel.
- **Interleave-detection mock**: assert no two ops' `send()` calls ever overlap on
  one key; this is the direct proof of the core claim.
- A hung holder past the waiter timeout makes the waiter throw `device_busy` (not
  hang); the holder releasing lets a queued waiter proceed.
- **Timed-out-waiter-then-third-acquirer**: a holder releases *after* a waiter
  already timed out, and a third caller still acquires (the leak regression).
- **Reentrancy guard** throws (does not deadlock) when an op re-enters the same
  endpoint; composites (mod/macro route) complete under a single lock.
- A long, healthy holder does **not** false-trip the busy timeout for a same-device
  waiter that is willing to wait for a brief op.
- **`reconnect_midi` during a hold** waits or refuses, never closes the port under
  the holder.
- **Cancellation**: an aborted op releases the lock promptly and a queued op then
  proceeds; SIGINT aborts an in-flight transfer before the port is closed.
- **Hybrid mode-flip**: an SPD-SX op after a USB-mode change re-resolves the
  endpoint correctly under the same key.
- Regression: existing single-device goldens unchanged (serialization is
  transparent with no contention; `recordAckOutcome` not double-counted).
