# Circuit Tracks → first-class: release-readiness assessment (2026-06-23)

A top-level "are we ready, what's the gap" view for shipping Novation Circuit
Tracks as a **first-class** device (the AM4 / Axe-Fx II / Hydrasynth tier). The
deep-dives live in the design docs cited below; the per-item roadmap lives in
[`CIRCUIT-TRACKS-FIRST-CLASS-PLAN.md`](./CIRCUIT-TRACKS-FIRST-CLASS-PLAN.md).
This doc is the synthesis: findings, a readiness scorecard, and prioritized next
steps to raise release quality.

## Findings (what is true today)

- **Capability depth is there.** Live params (`set_param`/`set_params`),
  sequencing (`apply_pattern` live_stream + ncs_upload, recipes/voices/notation/
  tab/midi), per-step sample flips, project upload (`upload_project`), and now
  **durable sample upload** all ship and are hardware-confirmed.
- **The sample-persistence defect is FIXED and hardware-confirmed.** Samples now
  survive a power-cycle. Root cause was the session PRELUDE (sample-directory
  file-type `0x05` + the 64× `0x0d` manifest scan as one indivisible step), not
  the write bytes. Decoded by capture-diff. See
  [`design/circuit-sample-upload.md`](./design/circuit-sample-upload.md).
- **The `.ncs` config regions are decoded** (length / chain / scenes), hardware-
  confirmed by on-device save→download→diff. See
  [`design/circuit-ncs-format-decode.md`](./design/circuit-ncs-format-decode.md).
- **The overwrite gate (read-before-write) shipped and is hardware-validated**
  non-destructively: occupied project slot refused, named the stored project,
  wrote nothing. Empty slots write friction-free; samples refuse-by-default
  (occupancy not yet readable). See SAFE-EDIT-WORKFLOW.md.
- **Transfers are reliable**: connection auto-recovery + retry-once, in-transfer
  reboot guard, always-close session.
- **Test coverage is real**: deterministic gate/transfer goldens in the preflight
  gate, a `verifyCircuit` launch-verification battery, a self-restoring
  live-regression block, and agent-regression cases. `npm run preflight` is green.
- **Backup/restore is designed, not built.** See
  [`design/circuit-pack-backup.md`](./design/circuit-pack-backup.md).
- **Synth PATCH save + read: ✅ HARDWARE-CONFIRMED (2026-07-03), `supports_save = true`.**
  `save_preset` persists a synth part's live sound to a Flash PATCH slot 0-63
  (instance 1/2 = Synth 1/2; refuse-by-default overwrite gate). Two patches saved
  this way survived a power-cycle (confirmed by ear). The write protocol
  (`codec/patchTransfer.ts savePatch`), decoded from Components captures + a 7-agent
  capture review, cleans the body's dirty-edit marker (`body[17]=0x00`), wraps a
  byte-clean Replace-Patch in a file-transfer session, and sends it FIRE-AND-FORGET
  as the last message (the device commits to flash silently; any session opened
  afterward aborts it; it never acks a save). `get_param`/`get_params` read synth
  patch params (osc/filter/env/lfo/mixer/fx/eq) from a live Patch Dump at each
  param's §13 offset; the offset map (32-123) is **oracle-confirmed against 128 real
  factory patch dumps**. `get_preset("patch:N")` reads a STORED bank patch (name +
  all decoded params) by PC-loading the slot into the working buffer and dumping it
  (a Program Change loads an OCCUPIED bank slot, HW-confirmed reading back a
  freshly-saved patch), restoring the prior buffer. Mod-matrix/macro record arrays
  (offsets 124-339) deferred. See `CIRCUIT-TRACKS-CONTROL-MAP.md` "Patch save + read"
  and `HARDWARE-TASKS-CIRCUIT.md`.

## Readiness scorecard (against the first-class bar)

| Dimension | State | Note |
|---|---|---|
| Capability depth | ✅ strong | params, sequencing, samples (durable), projects, flips, scenes/length/chain |
| Reliable transfers | ✅ | auto-recovery + reboot guard + always-close |
| Safe-edit contract | 🟡 mostly | overwrite gate shipped; **backup-before-overwrite not built** (overwrite is warned, not yet reversible) |
| Agent guidance | ✅ | `describe_device` guidance carries the gate + workflows |
| Test coverage | 🟡 mostly | preflight goldens green; some Circuit checks are hardware-sweep-only; gate auto-drive + byte-identical round-trip not in the battery |
| First-class positioning | ❌ gap | absent from ROADMAP.md, CLAUDE.md device tier, README first-class blurb; **no `.feature` spec** |

**Verdict:** functionally first-class; the blocker to *claiming* it is positioning
(#3) plus the safety contract being only half-complete (gate without backup).

## Next steps to improve release quality (prioritized)

### P1: gate the first-class claim
1. **#3 positioning.** Add Circuit Tracks to `CLAUDE.md`'s device tier, the
   `README.md` first-class blurb, and `ROADMAP.md`; write
   `docs/features/circuit-tracks.feature` (the durable product-capability record).
   This is the actual gate to shipping the first-class claim.
2. **Backup-before-overwrite (Tier 1 of the pack-backup design).** Ship
   `export_project[s]` + a `backup_first` (default on) on the destructive transfer
   tools, so an overwrite is one-command-reversible. This **completes the
   safe-edit contract**: the gate warns; backup makes "yes, overwrite" safe for
   a non-technical user. Everything needed (`downloadProject`) is hardware-
   confirmed. Bonus: raw `.ncs` download via `export_project` also unblocks the
   byte-identical download→re-upload→readback round-trip test that the current
   tool surface can't express.

### P2: close quality gaps in shipped features
3. **Wire scene/length/chain into authoring.** Authored `ncs_upload` projects
   should ship full-length (length `0x1f`) and, where a packed set has multiple
   grooves, carry the captured Scene 1–4 + chain bytes, so a stored project
   plays full-length and is tap-to-switch without the manual length-set step the
   `ncs_upload` receipt currently warns about. Decode is done (scripts apply it);
   fold it into the authoring path.
4. **Auto-drive the overwrite refusal in `verifyCircuit`.** Currently hardware-
   validated by hand + by goldens; add it to the launch-verification battery with
   a committed WAV fixture (sample refusal) and a known-occupied project slot
   (project refusal) so the gate is covered in the standard battery.

### P3: depth that lifts the ceiling (RE-gated)
5. **Decode the sample READ (file-type `0x05`).** Unblocks three things at once:
   sample backup, a "what samples do I have" directory read, and upgrading the
   sample overwrite gate from refuse-by-default to occupancy-driven (matching
   projects). The WRITE is decoded; READ is its inverse + the `0x08` name read.
6. **Drum-track → sample-slot binding.** Still unsolved (lives outside the `.ncs`,
   pack-level). Solving it delivers true one-tap groove sets (auto-bind D1–D4)
   instead of the current manual per-project Drum > Preset assignment.
7. **Song-import hardening (drum-tab / MIDI).** Groundwork landed; MIDI files are
   the reliable source (web-tab fetch is dead per prior findings). Harden the GM
   voice mapping onto the 4 drum tracks + flips (the collision-graph packer) so
   "drop in any drummer's MIDI" lands losslessly when no step exceeds 4 hits.

## Risks / honest caveats to carry into the release notes
- Sample tools **refuse by default** (occupancy unreadable until P3 #5), minor
  friction; the agent must pass `confirm_overwrite` once the user authorizes.
- The transfer's **final device CRC verdict is not read back**: writes are
  frame-acked; confirm a sample/project by ear / on-device.
- Several Circuit tests are **hardware-sweep-only** (no Circuit mock transport),
  so CI/preflight covers the codec + gate logic deterministically but not the
  live wire path; a hardware sweep is the standing pre-release step.
