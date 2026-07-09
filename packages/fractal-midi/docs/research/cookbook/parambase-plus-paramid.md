---
name: parambase-plus-paramid
class: address-calculation
status: matched
discovered:  (formula);  (28-block width table); 2026-07-02 (TLV promotion)
verified_on:
  - axe-fx-ii-q8.02 (384 factory presets, banks A/B/C file corpus, via the TLV walk)
  - axe-fx-ii-xl-plus-q8.02-live (BK-070 one-variable hardware diffs land at the predicted words)
firmware_sensitive: true
golden: scripts/verify-ii-preset-image-tlv.ts
relates_to: [ii-preset-image-tlv-chain, alphabetical-name-cascade-block-ordering, block-record-stride-8, wire-id-pairs-per-placed-block, septet-21bit-byte2-mask-preservation]
consumed_in:
  - packages/fractal-gen2/src/blockBinaryLayout.ts (width + X→Y offset tables)
  - packages/fractal-gen2/src/sceneChannelMap.ts (BLOCK_LAYOUT_MAP)
# Note: axefx2_atomic_apply was deprecated ; the active
# consumer is the apply_preset slots[].params.X/.Y nesting path.
---

# paramBase + paramId = ushort offset (II)

For each placed block in the II preset binary, the per-param ushort
offset is `paramBase + paramId`. `paramBase` is READ from the dump in
hand — it is the block's TLV position, `tlvWord + 2`, per
[[ii-preset-image-tlv-chain]]; `paramId` is fixed per (block-type,
param) pair.

## Formal definition

For a placed block `b` whose TLV `[wire_id, payload_len, payload...]`
sits at word `i` of the de-framed 4096-word image, with a parameter
`paramId` `p`:

```
paramBase(b)          = i + 2
ushortOffset(b, p, X) = paramBase(b) + p
ushortOffset(b, p, Y) = paramBase(b) + payload_len/2 + p     # X/Y blocks (even payload_len)
value                 = decode21bit(presetBinary, ushortOffset)   # see [[septet-21bit-byte2-mask-preservation]]
```

`paramBase` is no longer PREDICTED from composition + widths + a sort
rule; it is read from the self-describing chain. Per-block widths are
stable across preset compositions WITHIN one firmware build (5 batches
of co-resident probes, Session 116 cont 2) but are firmware snapshots:
the chain's `payload_len` drifts across firmware (Amp 234 in the
Q8.02 factory bank files vs 236 on live Q8.02 hardware), and
`widthUshorts = payload_len + 2` always.

## Status: matched (2026-07-02)

Promoted via the preset-image TLV decode: the formula is confirmed on
384 factory presets + 4 live hardware dumps, and the two BK-070
one-variable hardware diffs (amp.bass ch-Y, amp.master_volume ch-Y on
Test Crunch) land at EXACTLY the words the walker predicts (252, 255).
The former blocker — "the sort algorithm is only partially cracked" —
is **irrelevant for read-modify-write**: no ordering prediction is
needed when the chain is walked. (The order itself is also now
corpus-pinned: alphabetical by squashed AxeEdit display name, then the
[Tone Match?, Noisegate, Output, Feedback Send?, Feedback Return?,
Controllers] tail — the Batch D "PanTrem" anomaly was the
Tremolo/Panner display name, and "Mixer last" matches the
canBypass-false tail group. See [[ii-preset-image-tlv-chain]].)

## Measured widths (-DECODE-NOTES.md )

Per-block-name widths in ushorts, cross-verified across batches A-E
(stable per block-name regardless of co-resident placement):

| Block-name | Width | Verified |
|---|---|---|
| Amp | 238 | Test Crunch + all batches |
| Cab | 80 | Test Crunch + all batches |
| Chorus | 50 | A, E |
| Compressor | 42 | A, E + Test Crunch |
| Crossover | 17 | A |
| Delay | 142 | A + Test Crunch |
| Drive | 44 | A + Test Crunch |
| EffectsLoop (FX Loop) | 22 | D |
| Enhancer | 13 | A |
| Filter | 16 | A |
| Flanger | 50 | B, E |
| Formant | 14 | B |
| GateExpander | 28 | B |
| GraphicEQ | 40 | B, E |
| MegaTap | 19 | B |
| MultibandComp | 30 | B |
| MultiDelay | 120 | B |
| ParametricEQ | 50 | C, E |
| Phaser | 48 | C |
| Pitch | 172 | C, E |
| Resonator | 42 | C |
| Reverb | 92 | C, E |
| RingMod | 12 | C, D |
| Rotary | 40 | C, D |
| Synth | 42 | D |
| Vocoder | 52 | D |
| VolPan | 11 | D |
| PanTrem | 34 | D |

Per-block-name X→Y channel offsets (ushorts,  cont 2 Tier 1a):

| Block-name | X→Y offset |
|---|---|
| Amp | 118 |
| Cab | 39 |
| Compressor | 20 |
| Delay | 70 |
| Drive | 21 |
| Reverb | 45 |

Remaining block-names' X→Y offsets need measurement (probe per-block-name
with channel-X + channel-Y SET_PARAM, observe diff in both positions).

## Sort algorithm — RESOLVED / irrelevant (historical)

Historical anomaly notes, kept for provenance. The 2026-07-02 corpus
sweep pinned the order (alphabetical by squashed AxeEdit display name
+ fixed tail grammar, 388/388), and — more importantly — the TLV walk
removes any need to predict it:

- **Cascade order from `FUN_00595260` works for batches A, B, C, E.**
- **Batch D "broke" cascade**: PanTrem appeared BEFORE Vocoder +
  VolPan — resolved: the sort key is the display name
  "Tremolo/Panner" (T), which alphabetically precedes "Vocoder" /
  "Volume/Pan" (V). The internal PanTrem label was never the key.
- **Mixer (canBypass=false) always sorts to the END** — consistent
  with the canBypass-false system-tail group (Mixer never appears in
  the 388-dump corpus, so its exact tail position stays unpinned).

## Applicability

Any II preset dump: de-frame to the 4096-word image, walk the TLV
chain, read `paramBase = tlvWord + 2` for the target block. No
calibration probe, no composition constraint. The persisted
`blockBinaryLayout.ts` widths + X→Y offsets remain valid hardware
provenance for the firmware that produced them.

## Misapplication failure modes

- **DO NOT** predict paramBase from static widths + an ordering rule —
  that path is obsolete AND firmware-fragile (Amp 234 vs 236). Read it
  from the chain ([[ii-preset-image-tlv-chain]]).
- **DO NOT** write words outside `paramBase + paramId` targets:
  per-block scene/bypass/X-Y state words inside payloads are unmapped
  ([[scene-state-ushort]] is N=1 coordinates only).
- **DO NOT** ship an MCP-facing atomic apply on this primitive without
  the II screech-class safety review (self-oscillation incident class).

## Where it does NOT apply

- AM4 (different binary layout; 4 slots, no cascade).
- Axe-Fx III — transfer candidate. III binary likely uses a similar
  per-block-name width + sort scheme; un-verified.

## Verification path

`scripts/verify-ii-preset-image-tlv.ts` (root `test:codec`): the
BK-070 anchor arithmetic vectors run always (Test Crunch Amp TLV
[106,236]@130 → bass ch-Y 252, master ch-Y 255), and the
capture-gated corpus sweep re-derives every paramBase across 384
factory + 4 hardware dumps, asserting the two one-variable hardware
diff pairs land at the predicted words.

## Refinement history

- : formula `paramBase + paramId = ushort offset` decoded
  for Test Crunch.
- : BLOCK_LAYOUT_MAP shipped with Test Crunch widths,
  caveat in tool description.
-  cont: co-resident probe (Chorus added to Test Crunch)
  proved paramBase is layout-dependent. Cascade-order rule recovered
  from `AEImageDepot::FUN_00595260`. Status downgraded → `partial-N1`.
- : 28 block-name widths measured across 5 batches,
  persisted in `blockBinaryLayout.ts`. Cross-block stability confirmed.
  X→Y offsets measured for 6 Tier-1 blocks.
- : Ghidra Path B (mine "compute binary size" in
  AxeEdit.exe) explicitly ruled out — encoder lives in firmware.
  Path A (calibration-based atomic apply) confirmed as interim
  approach.
- : deprecated `axefx2_atomic_apply` tool;
  scene-state writes route through `apply_preset slots[].params.X/.Y`
  channel-nesting path.
- 2026-05-22 (cookbook audit): refreshed the entry to reflect Session
  116 cont 2-4 actual state — width table is 28 rows (not the original
  5), Ghidra path is closed (not "queued"), and the sort-algorithm
  anomalies (Batch D, Mixer) are the actual blocker to `matched` status.
- 2026-07-02 (preset-image TLV decode): PROMOTED partial-N1 → matched.
  paramBase is read from the self-describing TLV chain (`tlvWord + 2`,
  [[ii-preset-image-tlv-chain]]), confirmed 388/388 (384 factory + 4
  hardware dumps) with the BK-070 one-variable diffs landing exactly;
  the sort algorithm became irrelevant for read-modify-write (and the
  order is corpus-pinned anyway). Golden repointed from STUB to
  scripts/verify-ii-preset-image-tlv.ts. Widths reframed as firmware
  snapshots (`payload_len + 2`; Amp 234 factory vs 236 live). The
  former "Path A calibration probe" recommendation is retired.
