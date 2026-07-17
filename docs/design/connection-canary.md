# Connection canary + transfer robustness: design plan

**Status:** post-review, Phase A (connection-arbiter.md R2) SHIPPED 2026-07-09.
**Layer C (in-transfer guard) is BUILT + tested** (unchanged, 2026-06-20).
**Layer A (the connection canary) is now ALSO BUILT**: `ensureConnection`
(`packages/core/src/server-shared/connections.ts`) runs the free liveness
check (`isHandleHealthy`, `packages/core/src/server-shared/handleHealth.ts`)
proactively before handing back a CACHED handle, so a replug or a handle that
died mid-send on a prior call self-heals on the NEXT call. **Layer B
(read-path staleness participation) is BUILT for the Circuit's .ncs transfer**:
`uploadProject`/`downloadProject` feed `recordAckOutcome` on every outcome
except a legitimate empty-slot answer. The item-4 slow-send timer is ALSO now
built (log + mark `slowSendSuspect`, not "refuse"; see below). See
"Phase A / 2026-07-09" note inline at each Layer's section for exactly what
shipped and where; the recovery-hygiene framing below (item 2) still holds:
this remains "recovery hygiene, not prevention," now shipped rather than
pending.
**Trigger:** the Circuit Tracks rebooted ~3 times during a 2026-06-20 session,
each time coinciding with a SysEx file-transfer (`ncs_upload` / `get_preset`)
that hit `Internal RtMidi error` on a stale handle or stranded a session.

---

## POST-REVIEW UPDATE (2026-06-20, 30-agent adversarial review)

The review **reframed the fix and corrected this plan.** Key conclusions:

1. **Root cause is UNRESOLVED, not F2.** `Internal RtMidi error` is proven
   host/driver-side (the Windows MM driver refusing the local submit); it does
   NOT prove the Circuit firmware faulted. Device-fault vs USB-pipe-wedge vs
   driver-fault is correlated, not isolated. The earlier §1 "F2 IS the cause"
   claim is withdrawn; F2 is the leading hypothesis pending experiments.

2. **The canary is NOT the fix.** `ensureConnection`'s canary fires once per
   tool call, BEFORE the first transfer byte, structurally incapable of
   preventing a mid-transfer death (the actual reboot timing). It is **recovery
   hygiene** (self-heals replugs / already-failed handles), not prevention.

3. **The headline fix is the in-transfer guard (Layer C), now BUILT:**
   pre-flight liveness check (isPortOpen + lastSendError) at the top of
   `uploadProject`/`downloadProject`, plus each loop send wrapped in try/catch to
   **abort at the first failed block** instead of firing the rest into a dead
   port. See `packages/circuit-tracks/src/ncs/uploadProject.ts`. The plan's
   original "poll `lastSendError` after each send" was UNREACHABLE (send throws),
   now corrected to try/catch. `isPortOpen()` is exposed on `MidiConnection` but
   is a NEGATIVE catch only (a WinMM poisoned-but-present handle still reports
   open), documented honestly, not oversold. **2026-07-09 update:** the
   pre-flight check used to be a private `handleHealth(conn)` copy in this
   file; it is now the shared `isHandleHealthy(conn)` in
   `packages/core/src/server-shared/handleHealth.ts` (same logic, same
   signals, no behavior change; verified byte-for-byte against
   `scripts/verify-circuit-ncs-transfer.ts`), so the acquire-time canary
   (Layer A, below) and this in-transfer pre-flight now share one
   implementation instead of two copies that could drift.

4. **A failure mode the original plan was BLIND to: a *blocked* send.**
   `@julusian`'s send runs synchronously on the JS thread; if the device queue
   stalls mid-block the native call NEVER RETURNS, throws nothing, sets no
   `lastSendError`, and freezes the event loop (the historical wedge). NONE of
   the mitigations built through 2026-06-20 caught this. **2026-07-09 update:
   the slow-send timer is now BUILT** (`connect()` in
   `packages/core/src/midi/transport.ts` wall-clocks each synchronous
   `sendMessage`; a send over `SLOW_SEND_THRESHOLD_MS` = 250ms logs a warning
   and sets `conn.slowSendSuspect`, which `isHandleHealthy` treats as
   unhealthy on the NEXT acquire). Note this is "log + mark suspect for the
   next health check," not "refuse" as originally floated: refusing
   mid-transfer would require interrupting a send already in flight, which is
   impossible for a synchronous native call (see the honest limit below,
   unchanged). The TRUE blocked-forever hang is still invisible to
   everything in-process: nothing here claims to catch it, only the
   slow-but-completed case.

5. **Layer B corrected:** do NOT feed empty-slot read timeouts into
   `recordAckOutcome`: "no READ_INIT" is a legitimate empty-slot answer, not a
   dead handle; distinguish by handshake-ack position. **2026-07-09: BUILT**
   for the Circuit's `.ncs` transfer: `downloadProject` calls
   `recordAckOutcome` on every outcome except `empty: true`;
   `runUploadFramePlan` (the write side) calls it on every outcome, matching
   how AM4's write path already fed the same counter.

### Experiments required BEFORE resuming device transfers

**@julusian poison probe: DONE 2026-06-20 (`scripts/circuit-poison-probe.ts`).**
Result on Windows WinMM:
- A stale-handle send **THROWS** `Internal RtMidi error` and **sets
  `lastSendError`**; it does NOT block forever or silently succeed. So the
  `lastSendError`-based guard is VALIDATED; the catastrophic silent-success case
  does not occur on this backend.
- The **first** stale send blocks **~1025 ms** (the WinMM driver timeout) then
  throws; subsequent sends fail fast (~1 ms). Bounded, not infinite: a transfer
  dying mid-stream costs ~1s on the failing block, then the guard aborts.
- **`isPortOpen()` stays `true` after an unplug**: confirmed useless on Windows
  for liveness; `lastSendError` is the ONLY working signal. Keep `isPortOpen` as
  a weak catch for the explicitly-closed/serial case only.
- A stale handle does **not** self-recover after replug; reconnect-by-name is
  mandatory (which `reconnect_midi` does).
- CAVEAT: this tested a CC (short message), not an 8 KB SysEx `midiOutLongMsg`
  block. The infinite-spin path (RtMidi.cpp:3183) requires a send ACCEPTED then
  stalled, a connected-but-queue-stalled device, NOT an unplug. The reboots
  were the throw path, so the transfer path is cleared for cautious resumption;
  a SysEx-specific probe would settle the longmsg path fully.
- **Practical protocol:** `reconnect_midi` immediately before each transfer
  (fresh handle), with the in-transfer guard as backstop.
- **EXP1 (safe, read-only):** on a fresh handle, instrument per-send wall-clock,
  download a known-OCCUPIED then a known-EMPTY slot: distinguishes a blocked
  send (>250 ms) from clean handling, and tells us if a pure read can reboot.
- **EXP2 (consented throwaway slot):** deliberately abort an upload at ~block 10
  (no WRITE_FINISH), then read it back + the front panel: tests whether a
  partial transfer corrupts flash (settles assumption A4).
- **Burn-in:** 10 consecutive fresh-handle uploads with readback + CRC compare,
  zero reboots, before declaring fresh-handle transfers safe.

### Done this session (the code fixes the review demanded)
Layer C guard (built+tested); micro-step contract restricted to `{1,6}` (the
`3→triplet` claim was a shipped guess, withdrawn); reader echoes the raw
micro-hit mask + hard-fails on CRC mismatch; upload INFO no longer over-claims
device-CRC confirmation; short-pattern silent-tail flagged; `sidechain2.depth`
unverified address surfaced loudly at write time.

---

## 1. Problem statement

The server caches **one MIDI handle per device for the whole process** and
reuses it on every tool call **with no liveness check** (`ensureConnection`,
`packages/core/src/server-shared/connections.ts:129-166`; it returns
`existing.conn` at line 153 unconditionally unless the stale *counter* already
tripped). Staleness is only detected **reactively**, after **two consecutive
ack-less writes** (`STALE_HANDLE_TIMEOUT_THRESHOLD = 2`,
`recordAckOutcome`, `:86-96`). Reads and fire-and-forget sends never increment
the counter, so a dead handle can persist indefinitely.

**2026-07-09 update: this section now describes the PRE-Phase-A state.**
`ensureConnection` now ALSO runs the free `isHandleHealthy` canary before
returning a cached handle (Layer A below is BUILT), so the "no liveness
check" line above no longer holds; kept verbatim as the historical record of
what Phase A fixed. The counter-based staleness detection described here is
UNCHANGED and still the mechanism `STALE_HANDLE_TIMEOUT_THRESHOLD` gates;
the canary is a second, independent, cheaper signal layered on top of it, not
a replacement.

Two distinct failure modes have hit the device this session:

- **F1: stranded transfer session (FIXED).** An empty-slot read returned
  early without `CLOSE_SESSION`, leaving the device in transfer mode; a manual
  raw close into that state preceded a reboot. Fixed by the always-close
  `finally` in `uploadProject.ts` + the offline regression test.
- **F2: mid-send death on a stale handle (NOT fixed; the reboot cause).** The
  handle went stale between calls; the next call was a 20-block upload; the
  `output.sendMessage` threw `Internal RtMidi error` **partway through** the
  transfer. The device was left mid-write → watchdog reboot. The always-close
  `finally` could not help: on a dead handle the close `send` also throws (it's
  swallowed by the `try/catch`), so no clean shutdown reached the device.

**The root problem is the connection, not the transfer protocol.** A multi-block
write on an unverified, possibly-dead handle is a coin-flip on a mid-send death,
and a mid-send death on a file transfer can reboot the device.

## 2. Goals / non-goals

**Goals** (all three DONE as of 2026-07-09, Phase A):
- A USB replug or stale handle self-heals on the **next** tool call ("just
  works"), instead of "first call fails, second succeeds." ✅ `ensureConnection`
  canary (Layer A, below).
- A multi-block **transfer never starts on a handle it can't verify**, and
  **aborts immediately** if a send fails mid-transfer (don't keep firing blocks
  into a dead port; that's what strands/reboots the device). ✅ Layer C
  (already built 2026-06-20), now backed by the shared `isHandleHealthy`
  instead of a private copy.
- Read-path failures participate in staleness detection. ✅ Layer B, below:
  built for the Circuit's `.ncs` transfer specifically; other devices' read
  paths were not touched in this pass (see connection-arbiter.md's
  "what Phase A explicitly did NOT touch").

**Non-goals**
- The **Windows WinMM poisoned-handle wedge** (a handle that died mid-send is
  not released by the driver even after `closePort()`; STATE.md 2026-06-10).
  This is driver-level and cannot be fully fixed in-process; surface clear
  "restart the host app" guidance, don't pretend to recover.
- Decoding the directory listing for slot-occupancy (separate hardening; needs
  a capture). Tracked as a TODO in `uploadProject.ts`.

## 3. Design

### Layer A: Liveness canary in `ensureConnection` (headline): BUILT 2026-07-09

Before returning a cached handle, `ensureConnection`
(`packages/core/src/server-shared/connections.ts`) now runs a **cheap
liveness check**; if it fails, it force-reconnects proactively instead of
handing back a dead handle (same code path the existing counter-stale /
`forceReconnect` branches already used), just a third trigger condition.

**As shipped**, the signals are `isHandleHealthy(conn)`
(`packages/core/src/server-shared/handleHealth.ts`):
1. **Port-presence**: `conn.isPortOpen()` (already exposed on
   `MidiConnection` by the time this shipped; the "open question" below
   about exposing it was resolved by an earlier session). This checks the
   HELD handle's own OS flag, not a fresh `listMidiPorts()` re-enumeration:
   cheaper (no full port-list scan) and equivalent for this purpose (the
   handle we're about to hand back is the only one in question). A vanished
   port makes this `false` → reconnect. Still a NEGATIVE catch only (a WinMM
   handle poisoned mid-send keeps reporting open, poison-probe-verified,
   see item 3 above).
2. **Last-send health**: `conn.lastSendError`. If the last send on this
   handle threw (the `Internal RtMidi error` case), the handle is suspect →
   reconnect. The ONLY reliable Windows liveness signal per the poison probe.
3. **`slowSendSuspect`** (the item-4 stretch goal, also shipped): a
   completed-but-slow (>250ms) send on this handle from a PRIOR call →
   reconnect as a precaution.

Actual shape (`connections.ts`, inline in `ensureConnection`):
```ts
const counterStale = (cached?.consecutiveTimeouts ?? 0) >= STALE_HANDLE_TIMEOUT_THRESHOLD;
const canaryStale = cached !== undefined && !forceReconnect && !counterStale
    && !isHandleHealthy(cached.conn).ok;
const stale = counterStale || canaryStale;
if (forceReconnect || stale) { /* same discard-and-reopen path as today */ }
```

This converts the common replug/stale case from "first call fails" → "next call
just works," for EVERY device that goes through this registry (not just
Circuit Tracks). No probe send is added: the check only reads state the
handle already tracks, so there is no extra round trip and no budget impact.
Tested offline in `scripts/verify-handle-health-retry.ts` (both signals, plus
"a healthy handle is reused with zero redundant reconnects").

**Open question (for review), RESOLVED:** went with reading the held handle's
own `isPortOpen()` rather than a fresh `listMidiPorts()` re-enumeration:
`isPortOpen()` was already exposed on `MidiConnection` by an earlier session
(so option (a) below was moot by the time this shipped), and it answers the
exact question ("is THIS handle's port still open") more cheaply than
scanning every port on the bus. Kept for historical context:
~~`isPortOpen()` is the strongest liveness signal but is NOT exposed on
`MidiConnection`... Options: (a) expose `isAlive()`... (b) rely on
port-presence + `lastSendError` only.~~

### Layer B: Read-path staleness participation: BUILT 2026-07-09 (Circuit only)

Today only ack-decoded writes call `recordAckOutcome`. A read that times out
should also nudge staleness (or trigger the canary). Without this, a
`get_preset`/`get_param` after a replug keeps using the dead handle, the most
common "is it back?" action a user takes.

**As shipped**: `packages/circuit-tracks/src/ncs/uploadProject.ts`'s
`downloadProject` (public read entry point for the `.ncs` transfer) now calls
`recordAckOutcome(r.ok, 'circuit')` on every outcome EXCEPT `r.empty === true`
(per the correction above, a missing READ_INIT is a legitimate "the slot is
free" answer, not evidence the handle is dead, and must not count toward the
stale-counter threshold). The write side (`runUploadFramePlan`, shared by
project AND sample uploads) records every outcome unconditionally, matching
how AM4's write path already feeds the same counter. **Scope note**: this
pass only wired the Circuit's own `.ncs` read/write leaf functions; the
generic `get_param`/`get_preset` read paths on OTHER devices (AM4, Axe-Fx,
Hydrasynth) were NOT touched and still do not feed `recordAckOutcome` from
their read side. That remains open follow-on work if the same "a replug keeps
using the dead handle on a read" gap is confirmed on those devices too.

### Layer C: Transfer pre-flight + mid-send abort (device-safety critical)

In `uploadProject` / `downloadProject` (`uploadProject.ts`):
1. **Pre-flight**: before sending the first frame, assert the handle is healthy
   (Layer-A check). Refuse to start a 20-block transfer on a suspect handle;
   fail fast with a clear "reconnect first" error instead of dying mid-write.
2. **Mid-send abort**: after each `conn.send(...)` in the loop, check
   `conn.lastSendError`. If set, **stop immediately**: do not send the
   remaining blocks into a dead port. Then the `finally` attempts its close
   (best-effort). This is the direct fix for F2: a mid-transfer handle death
   stops after 1 failed block, not 19.

### Layer D: Honest failure surface

When the canary or pre-flight forces a reconnect that then fails (port truly
gone / WinMM wedge), surface the existing "powered? cable seated? restart the
host app?" guidance; do not retry-loop into the device.

## 4. Test plan (all offline, mock connection): DONE 2026-07-09

- Canary: cached handle whose `lastSendError` is set → `ensureConnection`
  rebuilds it (mock factory returns a fresh handle); healthy handle → returned
  as-is (no rebuild). ✅ `scripts/verify-handle-health-retry.ts`.
- Canary: needle no longer present in `listMidiPorts()` → rebuild. **Shipped
  differently than planned**: rather than a fresh `listMidiPorts()` scan, the
  canary reads the held handle's own `isPortOpen()` (see Layer A's resolved
  open question); same intent (a vanished/closed port triggers rebuild),
  cheaper mechanism. Covered by the `isPortOpen: () => false` case in
  `verify-handle-health-retry.ts`.
- Read-path: a timed-out read increments staleness / trips the canary. ✅ for
  the Circuit's `.ncs` download (`verify-circuit-ncs-transfer.ts`'s
  stale-handle block); NOT yet extended to other devices' read paths (see
  Layer B's scope note).
- Transfer pre-flight: `uploadProject` on a handle with `lastSendError` set →
  refuses to start (0 data frames sent). ✅ unchanged, still green
  (`verify-circuit-ncs-transfer.ts`).
- Transfer mid-send abort: a mock whose `send` sets `lastSendError` on block 3
  → the loop stops at block 3, not 20; `finally` still attempts close. ✅
  unchanged, still green.
- Existing always-close regression stays green. ✅ confirmed byte-for-byte
  after the `isHandleHealthy`/`withReconnectRetry` fold-in (same error
  strings, same frame counts, same close-ordering).
- Additionally covered (not in the original plan): `withReconnectRetry` never
  retries more than once even when the retry ALSO fails (no infinite retry,
  no double-reconnect storm); `reconnect()` itself throwing surfaces a
  combined honest error instead of an uncaught throw.

## 5. What this does and does NOT guarantee

- **Does**: dramatically cut mid-send deaths (pre-flight + abort), self-heal
  replugs (canary: now for every registry-backed device, not just Circuit),
  stop the Circuit's `.ncs` reads from stranding a dead handle (Layer B).
- **Does NOT**: guarantee the device never reboots. If a handle dies *exactly*
  between the pre-flight check and the first block, a partial send can still
  occur (smaller window, not zero). And the WinMM poisoned-handle wedge is
  driver-level. So: this makes device-driving **much** safer, not provably safe;
  the honest posture stays "resume device transfers cautiously."

## 6. Open questions for review

1. Is F2 (stale handle → mid-send death) the correct root cause of the reboot,
   or is the RE'd transfer protocol / overwriting an occupied slot / USB power
   also implicated? (Earlier successful uploads to slot 31 had content, so
   "overwrite" alone is probably not it; confirm.)
2. Is the CRC-gated-commit assumption (a partial upload is rejected, not
   committed, so flash isn't corrupted) actually true on this device?
3. Does `lastSendError` reliably get set on the `@julusian/midi` backend for the
   `Internal RtMidi error` we saw? (The swap is recent; the send-block path was
   not re-tested, project memory.)
4. Should transfers be gated behind an explicit health gate the way writes are
   behind read-before-write, i.e. never run `ncs_upload` without a fresh canary
   pass in the same call? **RESOLVED, yes: built as Layer C's pre-flight
   (already shipped 2026-06-20, now backed by the shared `isHandleHealthy`)
   plus the NEW acquire-time canary in `ensureConnection` (2026-07-09): a
   transfer gets a health-checked handle from `ensureConnection` AND re-checks
   it itself before the first frame, so both seams gate on the same signals.**
