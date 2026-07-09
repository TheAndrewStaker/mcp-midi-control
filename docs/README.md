# Docs

This is an open-source MCP server with strict, opinionated rules for
controlling music gear, and those rules apply to every device the same
way: display-first units (front-panel readings, never wire bytes), no
silent saves, no silent edit loss, no silent overwrites, every write
acknowledged, tempo-first, read-before-write. Consistency is the point.
The same instruction and the same guarantees behave the same on a guitar
amp modeler or on a synthesizer, and adding a device is a descriptor, not
a new set of tools.

Any USB MIDI device works today via generic-MIDI primitives (CC, NRPN,
SysEx, program change, notes, clock). Hardware-verified depth (whole-preset
and whole-patch authoring, lineage, cross-device translation) currently
covers the Fractal AM4, Axe-Fx II XL+, and ASM Hydrasynth Explorer. In
community beta: the modern Fractal family (Axe-Fx III / FM3 / FM9 / VP4),
the original Axe-Fx Standard/Ultra, and three non-guitar devices: the
Novation Circuit Tracks (sequencer), the Roland SPD-SX (sample pad), and
the Boss VE-500 (vocal processor).

This folder holds the documentation for contributors and Claude Code
agents working in this repo. End-user install and usage docs live in the
repo root [`README.md`](../README.md).

## Start here

- [`PROJECT-VISION.md`](./PROJECT-VISION.md): one-page strategic narrative
  (problem, solution, target user, what-it-is-not, phases).
- [`ARCHITECTURE.md`](./ARCHITECTURE.md): how the codebase is organized
  (workspace packages, device descriptors, unified tool surface).
- [`GETTING-STARTED.md`](./GETTING-STARTED.md): on-ramp for new
  contributors.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): how to contribute.

## Per-device protocol references

Per-device research, wire-protocol decodes, and capability notes for the
hardware-verified devices live in the `fractal-midi` codec package under
[`packages/fractal-midi/docs/devices/`](../packages/fractal-midi/docs/devices/):

- [`devices/am4/`](../packages/fractal-midi/docs/devices/am4/): Fractal AM4 (deepest decode today).
- [`devices/axe-fx-ii/`](../packages/fractal-midi/docs/devices/axe-fx-ii/): Fractal Axe-Fx II XL+.
- [`devices/axe-fx-iii/`](../packages/fractal-midi/docs/devices/axe-fx-iii/): Fractal Axe-Fx III
  (community beta).
- [`devices/hydrasynth/`](../packages/fractal-midi/docs/devices/hydrasynth/): ASM Hydrasynth Explorer.

Each device folder carries a `SYSEX-MAP.md` (authoritative wire spec)
plus per-device research and design notes.

## Wire protocol + RE methodology

Cross-device protocol decode methodology, exploratory research notes,
and capture guides:

- [`research/`](./research/): cross-device research notes.
  - [`research/fractal-protocol-decode-status.md`](../packages/fractal-midi/docs/research/fractal-protocol-decode-status.md)
    cross-device status table. Run `npm run coverage-audit` for the
    authoritative code-state numbers.
  - [`research/fractal-broadcast-vs-poll-research.md`](../packages/fractal-midi/docs/research/fractal-broadcast-vs-poll-research.md)
    cross-device decode methodology (Axe-Fx II broadcasts, AM4 polls).
  - [`research/fractal-midi-extraction-plan.md`](./research/fractal-midi-extraction-plan.md)
    vendor protocol package extraction plan.
  - [`research/ghidra-mining-workflow.md`](../packages/fractal-midi/docs/research/ghidra-mining-workflow.md)
    canonical RE method for Fractal editor binaries.
  - [`research/loudness-data-methodology.md`](./research/loudness-data-methodology.md)
    how the per-amp loudness corpus was produced.
- [`capture-guides/`](../packages/fractal-midi/docs/capture-guides/): step-by-step capture
  techniques (USBPcap + Wireshark, JUCE BinaryData extraction).

## Workflows

- [`SAFE-EDIT-WORKFLOW.md`](./SAFE-EDIT-WORKFLOW.md): cross-device
  contract for buffer-dirty / save-authorization / multi-preset
  overwrite gates.
- [`TYPE-KNOB-WORKFLOW.md`](./TYPE-KNOB-WORKFLOW.md): type-knob /
  block-type-change conventions.
- [`VOLUME-CONTROL.md`](./VOLUME-CONTROL.md): volume-control surface
  and per-device differences.

## Reference

- [`REFERENCES.md`](./REFERENCES.md): catalogue of local manuals,
  protocol specs, and community sources.
- [`MULTI-DEVICE-ROADMAP.md`](./MULTI-DEVICE-ROADMAP.md): multi-device
  expansion plan and target order.
- [`FRACTAL-PRESET-SCHEMA.md`](./FRACTAL-PRESET-SCHEMA.md): cross-Fractal
  preset model used by `apply_preset`.
- [`BLOCK-PARAMS.md`](./BLOCK-PARAMS.md): AM4 block parameter reference
  (cross-referenced from other devices).
- [`RELEASE-RUNBOOK.md`](./RELEASE-RUNBOOK.md): end-to-end release
  checklist.
- [`SAFETY-FOR-MUSICIANS.md`](./SAFETY-FOR-MUSICIANS.md): plain-language
  trust model for non-developer users.
- [`captures/`](./captures/README.md): community capture & probe guides for
  gen-3 Fractal devices (FM9 / Axe-Fx III / FM3): per-device pages with a
  one-command probe, a report-from-a-chat menu, and the captures still needed,
  plus a shared [`SETUP.md`](./captures/SETUP.md) for Wireshark/USBPcap and Mac.

## Vendor manuals

- [`manuals/README.md`](../packages/fractal-midi/docs/manuals/README.md): Fractal Audio and
  Hydrasynth manuals. PDFs are gitignored; `.txt` extractions are
  committed for grep-ability.
