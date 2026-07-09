# Connection canary + transfer robustness — design plan

**Status:** post-review. The **in-transfer guard (Layer C) is BUILT + tested**;
the connection canary (Layer A) is reframed to recovery-hygiene and is pending.
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
   claim is withdrawn — F2 is the leading hypothesis pending experiments.

2. **The canary is NOT the fix.** `ensureConnection`'s canary fires once per
   tool call, BEFORE the first transfer byte — structurally incapable of
   preventing a mid-transfer death (the actual reboot timing). It is **recovery
   hygiene** (self-heals replugs / already-failed handles), not prevention.

3. **The headline fix is the in-transfer guard (Layer C), now BUILT:**
   pre-flight `handleHealth(conn)` (isPortOpen + lastSendError) at the top of
   `uploadProject`/`downloadProject`, plus each loop send wrapped in try/catch to
   **abort at the first failed block** instead of firing the rest into a dead
   port. See `packages/circuit-tracks/src/ncs/uploadProject.ts`. The plan's
   original "poll `lastSendError` after each send" was UNREACHABLE (send throws),
   now corrected to try/catch. `isPortOpen()` is exposed on `MidiConnection` but
   is a NEGATIVE catch only (a WinMM poisoned-but-present handle still reports
   open) — documented honestly, not oversold.

4. **A failure mode the original plan was BLIND to: a *blocked* send.**
   `@julusian`'s send runs synchronously on the JS thread; if the device queue
   stalls mid-block the native call NEVER RETURNS, throws nothing, sets no
   `lastSendError`, and freezes the event loop (the historical wedge). NONE of
   the current mitigations catch this. A slow-send timer (log + refuse if a
   single send exceeds ~250 ms) is the only defense and is NOT yet built.

5. **Layer B corrected:** do NOT feed empty-slot read timeouts into
   `recordAckOutcome` — "no READ_INIT" is a legitimate empty-slot answer, not a
   dead handle; distinguish by handshake-ack position.

### Experiments required BEFORE resuming device transfers

**@julusian poison probe — DONE 2026-06-20 (`scripts/circuit-poison-probe.ts`).**
Result on Windows WinMM:
- A stale-handle send **THROWS** `Internal RtMidi error` and **sets
  `lastSendError`** — it does NOT block forever or silently succeed. So the
  `lastSendError`-based guard is VALIDATED; the catastrophic silent-success case
  does not occur on this backend.
- The **first** stale send blocks **~1025 ms** (the WinMM driver timeout) then
  throws; subsequent sends fail fast (~1 ms). Bounded, not infinite — a transfer
  dying mid-stream costs ~1s on the failing block, then the guard aborts.
- **`isPortOpen()` stays `true` after an unplug** — confirmed useless on Windows
  for liveness; `lastSendError` is the ONLY working signal. Keep `isPortOpen` as
  a weak catch for the explicitly-closed/serial case only.
- A stale handle does **not** self-recover after replug — reconnect-by-name is
  mandatory (which `reconnect_midi` does).
- CAVEAT: this tested a CC (short message), not an 8 KB SysEx `midiOutLongMsg`
  block. The infinite-spin path (RtMidi.cpp:3183) requires a send ACCEPTED then
  stalled — a connected-but-queue-stalled device, NOT an unplug. The reboots
  were the throw path, so the transfer path is cleared for cautious resumption;
  a SysEx-specific probe would settle the longmsg path fully.
- **Practical protocol:** `reconnect_midi` immediately before each transfer
  (fresh handle), with the in-transfer guard as backstop.
- **EXP1 (safe, read-only):** on a fresh handle, instrument per-send wall-clock,
  download a known-OCCUPIED then a known-EMPTY slot — distinguishes a blocked
  send (>250 ms) from clean handling, and tells us if a pure read can reboot.
- **EXP2 (consented throwaway slot):** deliberately abort an upload at ~block 10
  (no WRITE_FINISH), then read it back + the front panel — tests whether a
  partial transfer corrupts flash (settles assumption A4).
- **Burn-in:** 10 consecutive fresh-handle uploads with readback + CRC compare,
  zero reboots, before declaring fresh-handle transfers safe.

### Done this session (the code fixes the review demanded)
Layer C guard (built+tested); micro-step contract restricted to `{1,6}` (the
`3→triplet` claim was a shipped guess — withdrawn); reader echoes the raw
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

Two distinct failure modes have hit the device this session:

- **F1 — stranded transfer session (FIXED).** An empty-slot read returned
  early without `CLOSE_SESSION`, leaving the device in transfer mode; a manual
  raw close into that state preceded a reboot. Fixed by the always-close
  `finally` in `uploadProject.ts` + the offline regression test.
- **F2 — mid-send death on a stale handle (NOT fixed; the reboot cause).** The
  handle went stale between calls; the next call was a 20-block upload; the
  `output.sendMessage` threw `Internal RtMidi error` **partway through** the
  transfer. The device was left mid-write → watchdog reboot. The always-close
  `finally` could not help: on a dead handle the close `send` also throws (it's
  swallowed by the `try/catch`), so no clean shutdown reached the device.

**The root problem is the connection, not the transfer protocol.** A multi-block
write on an unverified, possibly-dead handle is a coin-flip on a mid-send death,
and a mid-send death on a file transfer can reboot the device.

## 2. Goals / non-goals

**Goals**
- A USB replug or stale handle self-heals on the **next** tool call ("just
  works"), instead of "first call fails, second succeeds."
- A multi-block **transfer never starts on a handle it can't verify**, and
  **aborts immediately** if a send fails mid-transfer (don't keep firing blocks
  into a dead port — that's what strands/reboots the device).
- Read-path failures participate in staleness detection.

**Non-goals**
- The **Windows WinMM poisoned-handle wedge** (a handle that died mid-send is
  not released by the driver even after `closePort()`; STATE.md 2026-06-10).
  This is driver-level and cannot be fully fixed in-process — surface clear
  "restart the host app" guidance, don't pretend to recover.
- Decoding the directory listing for slot-occupancy (separate hardening; needs
  a capture). Tracked as a TODO in `uploadProject.ts`.

## 3. Design

### Layer A — Liveness canary in `ensureConnection` (headline)

Before returning a cached handle (`connections.ts:152-153`), run a **cheap
liveness check**; if it fails, force-reconnect proactively instead of handing
back a dead handle.

Two signals, both already available:
1. **Port-presence** — re-enumerate OS ports (`listMidiPorts()`,
   `transport.ts:224`, no open needed) and confirm a port still matches the
   device needle. A vanished name = unplugged → reconnect.
2. **Last-send health** — `cached.conn.lastSendError` (already on the
   `MidiConnection` interface, `transport.ts:62`). If the last send threw (the
   `Internal RtMidi error`), the handle is suspect → reconnect.

```
const existing = connections.get(label);
if (existing) {
  if (!isHandleHealthy(label, existing.conn)) {  // port present AND no lastSendError
    closeMidiSafely(existing.conn); connections.delete(label); /* fall through to reopen */
  } else {
    return existing.conn;
  }
}
```

This converts the common replug/stale case from "first call fails" → "next call
just works." Port scans are cheap (the code already says so, `:146-147`).

**Open question (for review):** `isPortOpen()` is the strongest liveness signal
but is NOT exposed on `MidiConnection` (only used inside `connect()`,
`transport.ts:485`). Options: (a) expose `isAlive()` on the interface (touches
both transports + mock); (b) rely on port-presence + `lastSendError` only.
Leaning (a) for a true probe; (b) is lower-touch but misses a dead-but-present
handle that hasn't sent yet.

### Layer B — Read-path staleness participation

Today only ack-decoded writes call `recordAckOutcome`. A read that times out
should also nudge staleness (or trigger the canary). Without this, a
`get_preset`/`get_param` after a replug keeps using the dead handle — the most
common "is it back?" action a user takes.

### Layer C — Transfer pre-flight + mid-send abort (device-safety critical)

In `uploadProject` / `downloadProject` (`uploadProject.ts`):
1. **Pre-flight**: before sending the first frame, assert the handle is healthy
   (Layer-A check). Refuse to start a 20-block transfer on a suspect handle —
   fail fast with a clear "reconnect first" error instead of dying mid-write.
2. **Mid-send abort**: after each `conn.send(...)` in the loop, check
   `conn.lastSendError`. If set, **stop immediately** — do not send the
   remaining blocks into a dead port. Then the `finally` attempts its close
   (best-effort). This is the direct fix for F2: a mid-transfer handle death
   stops after 1 failed block, not 19.

### Layer D — Honest failure surface

When the canary or pre-flight forces a reconnect that then fails (port truly
gone / WinMM wedge), surface the existing "powered? cable seated? restart the
host app?" guidance — do not retry-loop into the device.

## 4. Test plan (all offline, mock connection)

- Canary: cached handle whose `lastSendError` is set → `ensureConnection`
  rebuilds it (mock factory returns a fresh handle); healthy handle → returned
  as-is (no rebuild).
- Canary: needle no longer present in `listMidiPorts()` → rebuild.
- Read-path: a timed-out read increments staleness / trips the canary.
- Transfer pre-flight: `uploadProject` on a handle with `lastSendError` set →
  refuses to start (0 data frames sent).
- Transfer mid-send abort: a mock whose `send` sets `lastSendError` on block 3
  → the loop stops at block 3, not 20; `finally` still attempts close.
- Existing always-close regression stays green.

## 5. What this does and does NOT guarantee

- **Does**: dramatically cut mid-send deaths (pre-flight + abort), self-heal
  replugs (canary), stop reads stranding a dead handle (Layer B).
- **Does NOT**: guarantee the device never reboots. If a handle dies *exactly*
  between the pre-flight check and the first block, a partial send can still
  occur (smaller window, not zero). And the WinMM poisoned-handle wedge is
  driver-level. So: this makes device-driving **much** safer, not provably safe
  — the honest posture stays "resume device transfers cautiously."

## 6. Open questions for review

1. Is F2 (stale handle → mid-send death) the correct root cause of the reboot,
   or is the RE'd transfer protocol / overwriting an occupied slot / USB power
   also implicated? (Earlier successful uploads to slot 31 had content, so
   "overwrite" alone is probably not it — confirm.)
2. Is the CRC-gated-commit assumption (a partial upload is rejected, not
   committed, so flash isn't corrupted) actually true on this device?
3. Does `lastSendError` reliably get set on the `@julusian/midi` backend for the
   `Internal RtMidi error` we saw? (The swap is recent; the send-block path was
   not re-tested — project memory.)
4. Should transfers be gated behind an explicit health gate the way writes are
   behind read-before-write — i.e. never run `ncs_upload` without a fresh canary
   pass in the same call?
