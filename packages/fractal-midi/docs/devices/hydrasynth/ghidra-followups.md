# Hydrasynth, Ghidra Follow-ups

Per-device research roadmap for Hydrasynth Ghidra mining. Format mirrors
`../axe-fx-ii/ghidra-followups.md` (the canonical pattern). Status
legend: ✅ landed / 🔜 next / ⸀ blocked / 🟡 in flight.

## Status

Hydrasynth Ghidra work is **not yet started**. The Hydrasynth Editor
binary is the next mining target when an active Hydra workstream
opens. Until then this doc is a placeholder + queue.

The Hydrasynth uses a different vendor protocol from Fractal (Manny /
ASM, not the `F0 00 01 74` envelope), so primitives like
[[../../research/primitives/xor-7f-envelope-checksum]] and
[[../../research/primitives/vendor-envelope-descriptor-table]] **do NOT
apply directly**: Hydra primitive entries are a separate effort.

## Phase A, Foundation (🔜 when Hydra workstream opens)

- **A1** 🔜 Confirm Hydrasynth Editor binary uses JUCE BinaryData
  ([[../../research/primitives/juce-binarydata-zip]] transfer candidate).
  If yes: 5-minute label extraction yields the param catalog without
  hardware. Recommended FIRST move, same approach as AM4-Edit
  (1,299 labels) + AxeEdit III (10,250 labels).
- **A2** 🔜 If JUCE: extract `__block_layout.xml` equivalent + recover
  param metadata (parameterName + displayLabel + controlType).
- **A3** 🔜 If NOT JUCE: identify the framework + adapt the label-
  extraction approach.

## Phase B, Wire protocol (⸀ blocked on A1)

- **B1** ⸀ Identify Hydrasynth SysEx envelope shape (manufacturer ID,
  fn-byte, payload, checksum). The Hydra uses ASM's vendor ID, not
  Fractal's `00 01 74`. A new primitive `asm-vendor-envelope-shape`
  is the deliverable.
- **B2** ⸀ Identify Hydrasynth descriptor-table mechanism (analog of
  Fractal's `(tag, mid, byte_count)` per-fn payload spec). May not
  exist in the same shape, ASM's protocol design is unknown.
- **B3** ⸀ Identify Hydrasynth preset format. Community RE may already
  exist (`.hydra` / `.patch` file format research at
  [`devices/hydrasynth/preset-format-research.md`](preset-format-research.md))
, cross-reference before Ghidra mining.

## Phase C, Capability decode (⸀ blocked on B1-B3)

- **C1** ⸀ Iconic-tone test portfolio per
  `founder-private notes`, once SET_PARAMETER wire
  shape is locked, exercise the iconic-tones list to validate decode.

## Notes

- The Hydrasynth has no MIDI-exposed dirty signal (per project memory).
  Hydra tools in mcp-midi-control omit `on_active_preset_edited`
  entirely; the `save_authorized` gate still applies. Capability decode
  needs to confirm this remains true on newer firmware.
- Hydra MCP work is currently at the discovery / capability-decode
  stage; full preset-format decode is not on the critical path until
  basic SET / GET primitives ship.

## Refinement history

- 2026-05-22: placeholder created following the II/III pattern. AM4
  ghidra-followups deferred per senior review (AM4 at 100% catalog;
  near-empty follow-up invites cargo padding). Hydra follows the
  same logic, this doc stays minimal until an active workstream
  opens.
