# Docs

Project documentation for contributors and Claude Code agents working in
this repo. End-user install / usage docs live in the repo root
[`README.md`](../README.md).

## Start here

- [`PROJECT-VISION.md`](./PROJECT-VISION.md) — one-page strategic narrative
  (problem, solution, target user, what-it-is-not, phases).
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the codebase is organized
  (workspace packages, device descriptors, unified tool surface).
- [`GETTING-STARTED.md`](./GETTING-STARTED.md) — on-ramp for new
  contributors.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — how to contribute.

## Per-device protocol references

Per-device research, wire-protocol decodes, and capability notes live
under [`devices/`](./devices/):

- [`devices/am4/`](./devices/am4/) — Fractal AM4 (headline device).
- [`devices/axe-fx-ii/`](./devices/axe-fx-ii/) — Fractal Axe-Fx II XL+.
- [`devices/axe-fx-iii/`](./devices/axe-fx-iii/) — Fractal Axe-Fx III
  (community beta).
- [`devices/hydrasynth/`](./devices/hydrasynth/) — ASM Hydrasynth line.

Each device folder carries a `SYSEX-MAP.md` (authoritative wire spec)
plus per-device research and design notes.

## Wire protocol + RE methodology

Cross-device protocol decode methodology and capture guides:

- [`fractal-protocol-decode-status.md`](./fractal-protocol-decode-status.md)
  — cross-device status table; run `npm run coverage-audit` for the
  authoritative code-state numbers.
- [`fractal-broadcast-vs-poll-research.md`](./fractal-broadcast-vs-poll-research.md)
  — cross-device decode methodology (Axe-Fx II broadcasts, AM4 polls).
- [`fractal-midi-extraction-plan.md`](./fractal-midi-extraction-plan.md)
  — Phase 2 vendor protocol package extraction plan.
- [`ghidra-mining-workflow.md`](./ghidra-mining-workflow.md) — canonical
  RE method for Fractal editor binaries.
- [`loudness-data-methodology.md`](./loudness-data-methodology.md) —
  how the loudness reference data was produced.
- [`capture-guides/`](./capture-guides/) — step-by-step capture
  techniques (USBPcap + Wireshark, JUCE BinaryData extraction).

## Workflows

- [`SAFE-EDIT-WORKFLOW.md`](./SAFE-EDIT-WORKFLOW.md) — cross-device
  contract for buffer-dirty / save-authorization / multi-preset
  overwrite gates.
- [`TYPE-KNOB-WORKFLOW.md`](./TYPE-KNOB-WORKFLOW.md) — type-knob /
  block-type-change conventions.
- [`VOLUME-CONTROL.md`](./VOLUME-CONTROL.md) — volume-control surface
  and per-device differences.
- [`PARALLEL-WORK.md`](./PARALLEL-WORK.md) — guide for running
  multiple Claude sessions concurrently on this codebase.

## Reference

- [`DECISIONS.md`](./DECISIONS.md) — append-only architectural decisions
  with rationale and rejected alternatives.
- [`REFERENCES.md`](./REFERENCES.md) — catalogue of local manuals,
  protocol specs, and community sources.
- [`MULTI-DEVICE-ROADMAP.md`](./MULTI-DEVICE-ROADMAP.md) — multi-device
  expansion plan and target order.
- [`FRACTAL-PRESET-SCHEMA.md`](./FRACTAL-PRESET-SCHEMA.md) — cross-Fractal
  preset model used by `apply_preset`.
- [`BLOCK-PARAMS.md`](./BLOCK-PARAMS.md) — AM4 block parameter reference
  (cross-referenced from other devices).
- [`RELEASE-RUNBOOK.md`](./RELEASE-RUNBOOK.md) — end-to-end release
  checklist.
- [`SAFETY-FOR-MUSICIANS.md`](./SAFETY-FOR-MUSICIANS.md) — plain-language
  trust model for non-developer users.

## Vendor manuals

- [`manuals/README.md`](./manuals/README.md) — Fractal Audio and
  Hydrasynth manuals. PDFs are gitignored; `.txt` extractions are
  committed for grep-ability.

## Community

- [`community/`](./community/) — community-facing workflows
  (Axe-Fx III beta-tester guide, etc.).
