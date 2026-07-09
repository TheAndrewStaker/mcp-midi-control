# Circuit Tracks — session handoff (2026-06-22)

Pick-up pointer for the next session. Full roadmap + design lives in
[`CIRCUIT-TRACKS-FIRST-CLASS-PLAN.md`](./CIRCUIT-TRACKS-FIRST-CLASS-PLAN.md); the
capability/protocol reference is [`CIRCUIT-TRACKS-CONTROL-MAP.md`](./CIRCUIT-TRACKS-CONTROL-MAP.md).
For the top-level "are we ready, what's the gap" view with prioritized next
steps, read [`CIRCUIT-TRACKS-RELEASE-READINESS.md`](./CIRCUIT-TRACKS-RELEASE-READINESS.md)
(2026-06-23): durable sample upload + `.ncs` length/chain/scene decode landed;
the P1 release-quality levers are **#3 positioning** and **backup-before-overwrite**.

## What shipped this session (all green, preflight exit 0)

- **Sample/project upload** — `upload_sample` / `upload_kit` / `upload_project`
  (byte-exact to Novation Components; WAV auto-normalized to 48 kHz mono 16-bit).
  Sample write reaches the slot (a live overwrite was heard change) but durable
  persistence is unverified (2026-06-22: samples may not survive a reload).
- **Round-robin** (`apply_pattern round_robin`) — anti-choke voice spreading.
  Decision: **keep, do not expand** (subtle benefit; isolated/tested).
- **Per-step sample flips** — `drum_choice` decoded = absolute sample slot 0..63
  (`0xFF` = no flip), hardware-confirmed both directions. `apply_pattern
  drum_flips` authors them; `get_preset` surfaces them. Multiple drum pieces share
  one track (write byte-identical to the device's own Sample Flip, on Project 32).
- **Connection auto-recovery (#1)** — transfers now reconnect + retry once on a
  stale handle instead of erroring; no-ACK is not retried. Golden covers the
  mid-send-throw recovery (fresh handle leads with CLOSE_SESSION), reconnect
  failures, and the download path.
- **Docs** — control-map (sample upload / round-robin / sample flips), agent
  guidance keys, the first-class plan, this handoff.

## What landed after this handoff (2026-06-22, later session)

**#0 — the safe-edit overwrite gate — DONE.** Decision was **gate it,
occupancy-driven** (read the slot, warn/refuse only when something exists or
can't be confirmed, write empty slots with zero friction, skip on explicit
`confirm_overwrite`). All four destructive transfer tools now take
`confirm_overwrite`; `upload_project` / `ncs_upload` read the slot first
(`probeProjectSlot`), samples refuse-by-default until the dir decode lands.
SAFE-EDIT-WORKFLOW.md gained Circuit rows + a gate subsection. See plan #0.

**#2 — test coverage — substantially DONE.** Landed:
- `verifyCircuit` in `scripts/launch-verification.ts` (describe_device guidance
  carries the gate, list_params, get_param refusal, pattern realizers) — 6/6
  green on the connected device.
- A self-restoring Circuit block in `scripts/live-regression.ts`: get_param
  refusal, get_preset reads a stored project, and the overwrite gate REFUSES an
  occupied slot without `confirm_overwrite` (refusal writes nothing) + a re-read
  asserting the slot is unchanged — 4/4 green on hardware. Also fixed a
  pre-existing `checkDevice` liveness false-positive (disconnected devices now
  SKIP instead of FAIL).
- `cases-circuit-tracks.ts` agent-regression: overwrite-refusal + authorize +
  get_preset read + apply_pattern audition.
- Deterministic gate goldens in `verify-circuit-ncs-transfer.ts` (preflight).
- Non-destructive HARDWARE validation of the project gate (occupied slot 33
  refused, naming "User Session" / Project 34, wrote nothing).

Thin remainder: extend the launch-verification `verifyCircuit` battery to drive
the `confirm_overwrite` refusal automatically (needs a WAV fixture for samples /
a known-occupied slot for projects); a true byte-identical download→re-upload
round-trip is blocked on there being no raw-`.ncs` download MCP tool (get_preset
decodes to a snapshot).

## THE next action

**#3 — first-class positioning.** Circuit Tracks is still absent from
`ROADMAP.md` and `CLAUDE.md`'s device tier, the README first-class blurb, and has
no `docs/features/circuit-tracks.feature`. Add those, then cut a release with
Circuit Tracks as first-class. Then the GM collision-graph packer (the "play any
song" payoff) and #4 RE-gated polish (pattern-LENGTH, drum default-sample, the
sample dir-listing decode that upgrades the sample overwrite gate).

Then: **#3** positioning (Circuit is absent from `ROADMAP.md` and `CLAUDE.md`;
no `.feature` file), **#4** RE-gated polish (pattern-LENGTH field + drum-track
default-sample field + the sample dir-listing decode that upgrades the sample
overwrite gate — one capture each), then the **GM collision-graph packer**
(the "play any song" payoff).

## Open hardware / RE items

- Pattern-LENGTH offset (kills the "set length to N manually" warning on every
  `ncs_upload`) — needs a capture.
- Drum-track default-sample field (so a stored project carries its own kit without
  per-step flips on every step) — needs a capture.
- Dir-listing format (occupancy pre-check for the overwrite gate; the
  `downloadOnce` "HARDENING TODO" note) — needs a capture.

## Workflow review (2026-06-22) — confirmed findings, status

1. (HIGH) Overwrite gate missing → **planned as #0**, not yet implemented.
2. (MED) Test-coverage gap is the whole surface → **plan #2 broadened**.
3. (MED) Assumption #3 (`consecutiveTimeouts`) inaccurate for Circuit →
   **corrected in the plan** (fire-and-forget never feeds the counter; acceptable).
4. (MED) Mid-send-recovery + reconnect-failure branches untested → **goldens
   added this session** (done).

## Recent commits

- `89e73c5` — sample upload, round-robin, per-step sample flips.
- `9b7a1ec` — sample-flip docs.
- (this session) — connection auto-recovery (#1) + plan + handoff.
