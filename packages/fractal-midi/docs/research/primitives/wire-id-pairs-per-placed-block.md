---
name: wire-id-pairs-per-placed-block
class: struct-layout
status: matched-singleton
discovered:  cont (-DECODE-NOTES.md lines 25-67)
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: the block-name → wire-ids table in packages/fractal-gen2/src/blockBinaryLayout.ts + fractal-midi/src/gen2/axe-fx-ii/blockTypes.ts)
relates_to: [alphabetical-name-cascade-block-ordering]
consumed_in:
  - packages/fractal-gen2/src/blockBinaryLayout.ts (block-name → wire-ids table from FUN_00595260)
  - fractal-midi/src/gen2/axe-fx-ii/blockTypes.ts
---

# Wire-id pairs per placed block

Each Axe-Fx II block-type name reserves K consecutive wire-ids in the
preset binary, where K ∈ {1, 2, 4}. K is the number of in-grid instances
the block-type supports. Confirmed by direct Ghidra cross-reference of
the `DAT_007153e4..DAT_007154xx` data tables.

## Formal definition

For each block-type name `N`, the editor binary's `.rdata` carries K
wire-ids referenced consecutively via `DAT_*` cross-references from
`AEImageDepot::FUN_00595260` (the alphabetical cascade,
[[alphabetical-name-cascade-block-ordering]]):

| K | Meaning | Example block-types |
|---|---|---|
| 1 | Single-instance block (no replicates) | Enhancer, EffectsLoop, Looper, Output |
| 2 | Two-instance block (e.g. Amp 1 + Amp 2) | Amp, Cab, Chorus, Compressor, Delay, Drive, Reverb |
| 4 | Four-instance block | Filter (1-4), GraphicEQ (1-4), ParametricEQ (1-4), VolPan (1-4) |

Full table extracted from `FUN_00595260` lives in
[[alphabetical-name-cascade-block-ordering]] §"Block-name → wire-id table"
(via -DECODE-NOTES.md lines 25-67).

## Where it's used

- Block-id allocation in `AXE_FX_II_BLOCKS` registry, currently has 4
  documented wiki errors that this primitive surfaces:
  - id 164 wiki says "Graphic EQ 3" → binary says **Filter 3**
  - id 165 wiki missing → binary says **Filter 4**
  - ids 166-168 wiki missing → binary says **VolPan 2, 3, 4**
  - id 169 wiki missing → binary says **Looper**

The K=4 pattern for Filter, GraphicEQ, ParametricEQ, VolPan explains
why their second-instance wire-ids land at 160-169 rather than near
their first-instance ids: the four wire-ids per block-name are
allocated in two pairs (1-2, then 3-4 elsewhere).

## Applicability

Use when:
- Resolving a wire-id to its canonical block-type name
- Determining whether a block has multiple instances in the same preset
- Validating an `AXE_FX_II_BLOCKS` registry entry against the binary

Cost: zero. The mapping is a lookup table; no probe needed once
extracted.

## Misapplication failure modes

- Does NOT predict block-id ordering within the K-id range, for example,
  Pitch claims wire-ids `130, 153` (NOT 130, 131). Consecutive
  allocation is the common case, but several block-types have
  non-consecutive pairs. Use the explicit cascade table, not arithmetic.
- Does NOT directly encode block layout in the preset binary; that's
  [[alphabetical-name-cascade-block-ordering]]. This primitive answers
  "given a block-type name, which wire-ids does it own?". The cascade
  answers "given a placed-blocks set, in what order is data
  serialized?".

## Where it does NOT apply

- Axe-Fx III: transfer candidate. III likely uses the same K=1/2/4
  allocation scheme; the III equivalent table is in
  `ghidra-axe-edit-iii-preset-receiver.txt` (371KB, un-mined).
- AM4: only 4 slots, no replication scheme. Doesn't apply.

## Verification path

No inline fixture ships (golden is STUB). A functional case, if added,
would assert:
1. K=1 case: `Enhancer → [135]`
2. K=2 case: `Amp → [106, 107]`
3. K=4 case: `Filter → [131, 132, 164, 165]` (non-consecutive pair pattern)
4. Wiki-vs-binary mismatch case: block-id `164` must resolve to
   `Filter 3`, NOT `Graphic EQ 3`.

## Refinement history

- 2026-05-22 ( cont): full 36-row block-name → wire-id table
  extracted from Ghidra `FUN_00595260` disassembly. 4 wiki errors
  surfaced (block-ids 164-169).
- 2026-05-22 (synthesis pass): primitive split out from
  alphabetical-cascade because it's a distinct lookup (block-name →
  wire-id set) used in code paths unrelated to cascade ordering. Wiki
  corrections queued as `AXE_FX_II_BLOCKS` registry update (separate
  PR, tracked in `STATE-AXEFX2.md`).
