# Circuit Tracks → first-class support: plan

Living plan for promoting the Novation Circuit Tracks from "supported" to
**first-class** (the tier of AM4 / Axe-Fx II / Hydrasynth: hardware-verified
depth, reliable transfers, agent guidance, test coverage, and docs that position
it as a headline device). Update this doc as items land.

## Current capability surface (done)

- **Params:** `set_param` / `set_params` across synth / drum / project / macros /
  mod-matrix / FX sends / sidechain (live CC + NRPN, fire-and-forget).
- **Sequencing:** `apply_pattern`: drums + melodic note tracks, `live_stream`
  (audition) and `ncs_upload` (author into a template `.ncs` → stored project).
  Pattern sources: recipe / voices / notation / tab / midi_file. Hardware-confirmed.
- **Round-robin** (`round_robin`): spread a voice across drum tracks (anti-choke).
  Kept but **not to be expanded** (subtle benefit; isolated/tested).
- **Per-step sample flips** (`drum_flips`): `drum_choice` = absolute sample slot
  0..63, `0xFF` = no flip. Multiple drum pieces share one track. Hardware-confirmed
  on read AND write (authored flips read back byte-identical to the device's own
  Sample Flip). See CIRCUIT-TRACKS-CONTROL-MAP.md.
- **Reads:** `get_preset(location)` decodes a stored project (note + drum tracks,
  surfaces `sample_flips`). No live single-param readback (device limitation).
- **Sample / project upload:** `upload_sample` / `upload_kit` / `upload_project`
  over USB, byte-exact to Novation Components; WAV normalized to 48 kHz mono
  16-bit. The sample write reaches the slot (heard change on hardware) but its
  DURABLE persistence is unverified (2026-06-22: samples may not survive a
  pack/project reload, under investigation); project upload uses the
  hardware-confirmed file-transfer transport.
- **Navigation:** `switch_preset` (project select via PGM on ch16).
- **Overwrite gate** (`confirm_overwrite`): the destructive transfer tools honor
  the read-before-write contract. Project writes read the slot first (empty →
  write, occupied → refuse + name); sample writes refuse by default until the
  sample-directory decode lands. See SAFE-EDIT-WORKFLOW.md.

## #1: Connection auto-recovery (LANDED this session)

**Problem.** A cached MIDI handle can go stale between calls (Windows / @julusian:
`isPortOpen()` stays true after an unplug; the next send throws `Internal RtMidi
error` or sets `lastSendError`). Before this fix, a transfer that hit a stale
handle **refused and told the user to run `reconnect_midi`**, unacceptable for a
non-technical target user. We hit it twice in one session.

**Fix.** A handle-level fault now auto-reconnects and retries the whole transfer
once on a fresh handle:

- `DispatchCtx.reconnect?: () => MidiConnection`, set by `openCtx` to
  `() => ensureConnection(label, true)` (force-reopen, returns the fresh handle).
- `TransferOptions.reconnect?`, the transfer drivers accept it.
- `runUploadFramePlan` and `downloadProject` split into a `*Once` attempt that
  flags `staleFault` on a HANDLE-level failure (pre-flight refusal, a throwing
  send, `lastSendError` mid-send) vs a device-level `no ACK`. On `staleFault` +
  a `reconnect` callback, they settle ~200 ms, reopen, and retry once.
- A **device `no ACK` is NOT retried** (a busy device / wrong view would just
  fail again on a fresh handle).
- All Circuit transfer call sites (`uploadSample` / `uploadKit` / `uploadProject`
  / `realizePattern` / `getPreset`) pass `ctx.reconnect`.
- Golden: `verify-circuit-ncs-transfer.ts`: stale handle recovers + succeeds;
  **mid-send throw recovers + retries from the top, with the fresh handle leading
  with CLOSE_SESSION** (the device-reboot-risk branch); `reconnect()`-throws and
  reconnect-returns-still-dead surface honest errors; no reconnect callback →
  fails; no-ACK does NOT reconnect; the download side reconnects too.

**Relationship to the existing reboot guard.** The in-transfer guard (per-send
abort + always-close) already prevents the device-reboot incident; this adds
*recovery* on top of *safety*. They are complementary.

**Assumptions / open questions (for review):**
1. Is "retry once" enough, or should a mid-transfer death (not just pre-flight)
   also recover? Today a mid-send throw flags `staleFault` and the WHOLE transfer
   retries, re-sending from the top, correct for an idempotent overwrite.
   RESOLVED + golden-locked: the mid-send-throw → reconnect → retry case asserts
   the fresh handle's FIRST frame is CLOSE_SESSION, so the device session is reset
   before any data re-send (no half-written-slot hazard across the retry).
2. Is the 200 ms settle enough for a Windows driver to re-enumerate the port?
3. `set_param`-class (CC/NRPN) writes intentionally do NOT get this transfer-level
   recovery. CORRECTION (review): the existing `consecutiveTimeouts` auto-reconnect
   (`connections.ts`, threshold 2) only arms via `recordAckOutcome`, which is
   called solely from AM4's ACK-gated `sendAndAwaitAck`. Circuit param writes are
   fire-and-forget CC/NRPN and never feed that counter, so it does NOT auto-
   reconnect after a stale Circuit param write on the next call. This is acceptable
   to leave (one fire-and-forget CC failing is low-stakes and self-evident). If we
   ever want the param path to self-heal, the lightweight fix is a one-shot
   `ensureConnection(label, true)` when the Circuit send-path's `send()` throws /
   sets `lastSendError`, NOT extending the heavy transfer-retry machinery.
4. `reconnect` is optional on `DispatchCtx`; non-dispatcher callers (scripts,
   tests) omit it and get the old refuse-on-stale behavior. Intended.

## Remaining for first-class (prioritized)

**#0, RELEASE BLOCKER: safe-edit overwrite gate on the transfer tools (LANDED).**
The project's defining first-class contract (SAFE-EDIT-WORKFLOW.md, CLAUDE.md) is
*"never write to a preset location without reading it first"* / *"always confirm
before overwriting non-empty, non-factory locations."* `upload_sample` /
`upload_kit` / `upload_project` and `apply_pattern mode:ncs_upload` used to
overwrite a device slot with **no pre-flight gate**, only after-the-fact
advisory text.

**Decision (maintainer, 2026-06-22): gate it, occupancy-driven, NOT a blanket
refuse-by-default** (the explicit ask was to "read what's there, warn if
something exists or may exist and can't confirm, unless the user authoritatively
said save", with a stated worry about over-gating). Shipped:

- A `confirm_overwrite` boolean on all four destructive transfer tools, threaded
  as `SlotWriteOptions.confirmOverwrite` to the writer.
- **Project slots are readable**, so `upload_project` / `ncs_upload` READ the
  target first (`probeProjectSlot`): **empty → write through with zero friction**;
  **occupied → refuse (`overwrite_confirmation_required`) and name the stored
  project**; unreadable → refuse (can't confirm). `confirm_overwrite: true` skips
  the read and writes.
- **Sample slots are NOT readable yet** (dir-listing decode is RE-gated, #4), so
  `upload_sample` / `upload_kit` refuse by default and ask for
  `confirm_overwrite: true`. They graduate to empty-slot-no-friction once the
  dir decode lands.
- SAFE-EDIT-WORKFLOW.md gained a Circuit Tracks column + a "slot-transfer
  overwrite gate" subsection.
- Gate logic: `gateProjectOverwrite` / `gateSampleOverwrite` /
  `probeProjectSlot` in `packages/circuit-tracks/src/descriptor/writer.ts` +
  `.../ncs/uploadProject.ts`.

The full occupancy pre-check for samples folds in with #4's dir-listing decode;
the interim sample behavior (refuse-by-default) is the honest stopgap until then.

**Hardware-confirmed (2026-06-22, non-destructive):** against a connected Circuit,
`upload_project(slot 33, no confirm_overwrite)` read the slot and REFUSED, naming
the stored project ("User Session", device "Project 34"); the occupancy probe
read the real name off the device and the refusal wrote nothing. `launch-verification`
gained a `verifyCircuit` battery (describe_device guidance carries the gate,
list_params, get_param refusal, pattern-target realizers); all 6 checks passed on
the connected device.

**#2, Test coverage (broaden: the gap is the whole surface, not just new tools).**
Verified by the review: `launch-verification.ts`, `agent-regression/`, and
`live-regression.ts` have **zero** Circuit coverage (every other shipped device
has a `cases-<device>.ts`); only the codec/transfer goldens exist (and they DO run
in the gate via `test:circuit`). Add: (a) `launch-verification` cases for the
unified tools incl. `apply_pattern` modes; (b) a `cases-circuit-tracks.ts`
agent-regression file mirroring the other devices, including the overwrite-refusal
scenario, shipped in the SAME change as #0's gate (tests + gate together); (c) at
least one self-restoring `live-regression` case (download slot → re-upload identical
→ readback byte-identical, non-destructive). Wire into the release gate.

**#3: First-class positioning in docs.** Circuit Tracks is absent from
`ROADMAP.md` AND `CLAUDE.md`, and has no `docs/features/circuit-tracks.feature`.
Add it to the device tier in CLAUDE.md, the README first-class blurb, the roadmap,
and write the `.feature` spec (product capability record).

**#4: RE-gated polish (needs one capture each).**
- **Pattern LENGTH field:** every `ncs_upload` warns "set the length to N
  manually" (a short pattern plays with a silent tail). Decode + author it.
- **Drum-track default-sample field:** today a stored project plays the template's
  drum samples unless every step is flipped. Decoding the per-track default-sample
  selector lets a stored project carry its own kit (the gap behind the crash A/B
  needing manual sample assignment).

## Next FEATURE (separate from solidify): GM collision-graph packer

Make `midi_file` import actually work on busy grooves. Today GM voices beyond
kick/snare/hat/clap are unmapped → hard error. With sample flips proven, the
packer 4-colours the voices' collision graph (edge = two voices share a step)
onto the 4 drum tracks + per-step flips, losslessly whenever no single step has
>4 distinct hits. This is the "drop in any drummer's MIDI, keep the character"
payoff, net-new, so it follows #1–#3.

## Recommended order

#1 (done) → #2 (tests) → #3 (positioning + `.feature`) → cut a release with
Circuit Tracks as first-class → then the packer (#4 polish folds in as captures
arrive).
