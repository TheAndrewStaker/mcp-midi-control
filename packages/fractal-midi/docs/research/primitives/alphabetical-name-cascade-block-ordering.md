---
name: alphabetical-name-cascade-block-ordering
class: struct-layout
status: partial-N1
discovered:  cont (-DECODE-NOTES.md lines 4-80)
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: packages/fractal-gen2/src/sceneChannelMap.ts BLOCK_LAYOUT_MAP consumer; no byte-exact fixture)
relates_to: [parambase-plus-paramid, wire-id-pairs-per-placed-block, vendor-envelope-descriptor-table]
consumed_in:
  - packages/fractal-gen2/src/sceneChannelMap.ts (BLOCK_LAYOUT_MAP)
  - (III: pending, transfer candidate, see iii-preset-receiver.txt)
---

# Alphabetical-name-cascade block ordering

> **2026-07-02 note:** the serialization order is now corpus-pinned by
> the preset-image TLV decode ([[ii-preset-image-tlv-chain]], 388/388):
> alphabetical by the AxeEdit canonical DISPLAY name with spaces /
> punctuation ignored ("Tremolo/Panner" under T, which resolves this
> entry's Batch D "PanTrem" anomaly), then a fixed system tail
> [Tone Match?, Noisegate, Output, Feedback Send?, Feedback Return?,
> Controllers] (which matches the "Mixer sorts to the END"
> observation). More importantly, ordering PREDICTION is obsolete for
> read-modify-write; the chain self-describes each block's position.

The Axe-Fx II preset binary serializes block data in **alphabetical order
by block-type display name**, not by grid placement, not by block-id, not
by groupCode. The cascade is implemented as an if-else chain in
`AEImageDepot::FUN_00595260` (slot 1 of the vftable at `.rdata 0x00eacff8`).

## Formal definition

For a placed-blocks set `B = {b1, b2, ...}` with each block carrying a
canonical block-type display name (read from the block-descriptor struct
at offset 0), the serialization order is:

```
sort(B, key=blockTypeName, order=alphabetical)
```

The cascade order is the canonical alphabetical sequence (from
`FUN_00595260`'s if-else chain):

`Amp → Cab → Chorus → Compressor → Crossover → Delay → Drive →
Enhancer → FeedbackSend → FeedbackReturn → Filter → Flanger → Formant →
GateExpander → GraphicEQ → EffectsLoop → MegaTap → Mixer →
MultibandComp → MultiDelay → ParametricEQ → Phaser → Pitch → QuadChorus →
Resonator → Reverb → RingMod → Rotary → Synth → Vocoder → VolPan →
PanTrem → Tremolo → Looper → Noisegate → Output → Controllers`

Note: `EffectsLoop` lands between `GraphicEQ` and `MegaTap` in the
cascade, NOT in pure alphabetical position between `Drive` and `Enhancer`.
The cascade is *almost* alphabetical with a small reordering; agents
must use the cascade table, not a sort by string.

For each matched block-type, the serializer emits K consecutive wire-ids
(K ∈ {1, 2, 4}); see [[wire-id-pairs-per-placed-block]].

## Where it's used

- II preset binary block layout: defines paramBase ordering at the
  protocol level. The width-per-block-name table layered on top of this
  rule yields the formula for `paramBase` per (preset, block).
-  atomic_apply build path (+) uses this for the
  packing order; the missing piece is the per-block-name width table,
  which is queued in -DECODE-NOTES.md §"Per-block-type SIZE table".

Empirical verification (-DECODE-NOTES.md):
- Pure Test Crunch (Amp/Cab/Comp/Delay/Drive/Reverb): Compressor at c7:u2.
- After adding Chorus to the same preset: Compressor moves to c7:u52,
  Chorus claims c7:u2. ✓ matches cascade prediction.

## Applicability

This is the LAYOUT primitive. It tells you the ORDER of blocks in the
preset binary. To get the actual byte offsets you also need:
- [[wire-id-pairs-per-placed-block]]: how many wire-ids each block-name
  consumes
- The per-block-name WIDTH table (currently partial: Test Crunch has
  Amp=238, Cab=80, Comp=42, Delay=142, Drive=44 ushorts measured)

Together: `paramBase(block) = sum(width(b) for b in cascade order before block) + startOffset`.

Cost: zero (once the cascade table is in code). One TS sort + lookup.

## Misapplication failure modes

- **Cascade order is NOT the complete sort rule.** -DECODE-NOTES.md
  lines 164-181 documents observed anomalies that downgrade this entry
  to `partial-N1`:
  - **Batch D** breaks cascade: PanTrem (cascade pos 31) appeared
    BEFORE Vocoder (29) and VolPan (30) in the serialized binary.
    Hypothesis: alphabetical-within-cascade-cluster fallback when
    cascade positions cluster.
  - **Mixer (canBypass=false) always sorts to the END** regardless of
    cascade position (cascade pos 17, observed last in Batch B).
  - **canBypass-class hypothesis**: the sort is plausibly by
    canBypass-class first (true → false), then mostly cascade-position
    but sometimes alphabetical. Not yet conclusively RE'd.
- Does NOT apply to grid-placement order (the visual signal chain).
  Grid placement is independent of preset-binary layout.
- Does NOT apply to scene state; scene state ushorts are at fixed
  offsets per block-name, not in cascade order. See [[scene-state-ushort]].
- Cascade order alone is INSUFFICIENT for paramBase calculation; you
  also need the width table AND the full sort algorithm. Shipping a
  `BLOCK_LAYOUT_MAP` with cascade-ordered entries that don't account
  for the canBypass-class anomalies produces wrong paramBase values for
  any preset containing Mixer or a Batch-D-class block-set. This is the
  literal  N=1 trap the plan's capability application
  discipline § "Generalization-claim check" was designed to catch.

## Where it does NOT apply

- Axe-Fx III editor: the inline-string-cascade IMPLEMENTATION form is
  structurally absent. Exhaustive grep of all 7 III preset-related
  Ghidra dumps (preset-receiver 371 KB, store-preset 81 KB,
  actions-and-shapes 989 KB, inbound-dispatcher 524 KB, patch-parsers
  115 KB, dynamic-action-codes 291 KB, new-fnbytes 201 KB) found ZERO
  block-name string literals inside a `strcmp`-driven if-else chain.
  III preset serialization is [[vendor-envelope-descriptor-table]]-
  driven instead. The III block-ordering question on the wire remains
  open pending hardware capture, but agents should NOT re-spend a
  session trying to re-grep the dumps for `"Amp" / "Cab" / "Chorus"`
  needles. See `_negative/iii-block-name-string-cascade.md` for the
  full evidence + grep table.
- AM4: preset layout is different (AM4 has 4 slots × 1 block; cascade
  doesn't apply the same way).

## Verification path

No inline fixture ships (golden is STUB). A functional case, if added,
would run two fixtures:
1. Test Crunch composition (Amp/Cab/Comp/Delay/Drive/Reverb), expected
   cascade order: Amp, Cab, Compressor, Delay, Drive, Reverb. Verifies
   against captured paramBase values.
2. Test Crunch + Chorus, expected cascade-induced shift: Chorus claims
   the old Compressor position; Compressor shifts to the next slot.
   Verifies against the -DECODE-NOTES.md §1 empirical test.

## Refinement history

- 2026-05-22 ( cont): cascade order recovered from
  `AEImageDepot::FUN_00595260` Ghidra disassembly. Block-name → wire-id
  table extracted (36 rows). Wiki-vs-binary corrections surfaced
  (block IDs 164-169 mislabeled).
- 2026-05-22 (synthesis pass): primitive promoted from notes doc to the
  primitives corpus. Width table flagged as still-partial; that gap is now
  closed by the 28-block table in `blockBinaryLayout.ts`.
- 2026-05-22 (primitives audit): status downgraded from `matched-singleton`
  → `partial-N1` because cascade order is NOT the complete sort rule.
  See `blockBinaryLayout.ts` lines 164-181 for Batch D + Mixer anomalies. The
  canBypass-class hypothesis is the next RE target; full
  sort-algorithm crack is the blocker to `matched` (per
  [[parambase-plus-paramid]] § "Sort algorithm").
- 2026-05-22: III transfer-candidate audit
  closed as negative on the IMPLEMENTATION axis. Exhaustive grep of
  all III preset-related Ghidra dumps surfaces zero block-name string
  literals inside a strcmp cascade; III uses descriptor-table-driven
  serialization instead. Negative finding registered at
  `_negative/iii-block-name-string-cascade.md`. The block-ORDERING
  question (does III's wire binary serialize blocks alphabetically?)
  remains open and depends on a III preset-push hardware capture
  (HW follow-up #1 in STATE.md handoff).
