---
name: block-record-stride-8
class: struct-layout
status: matched-singleton
discovered: 
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: packages/fractal-gen2/src/sceneChannelMap.ts consumer; no byte-exact fixture)
relates_to: [ii-preset-image-tlv-chain, scene-state-ushort, alphabetical-name-cascade-block-ordering, vendor-envelope-descriptor-table, wire-id-pairs-per-placed-block]
consumed_in:
  - packages/fractal-gen2/src/sceneChannelMap.ts
---

# Block-record table stride-8 (II)

> **CORRECTED 2026-07-02 (preset-image TLV decode).** This table is
> GRID / signal-chain-order metadata, NOT a placed-block enumerator
> and NOT the serialization layout. It is capped at 12 entries and
> carries ids >= 200 (unplaced/shunt placeholders) that are never
> serialized. To enumerate a preset's blocks or locate their data,
> walk the self-describing TLV chain from word 130 instead —
> [[ii-preset-image-tlv-chain]].

Axe-Fx II preset binary carries a block-record table in the de-framed
word image starting at word 36 (chunk 0, ushort offset 36), with
stride 8 ushorts per record.

## Formal definition

The table occupies words 36..129 of the de-framed 4096-word image
(the TLV chain begins at word 130, so the 12th entry's stride-8 span
is clipped):

```
record[i] = words[36 + 8*i : min(36 + 8*(i+1), 130)]   i = 0..11
```

Per the Ghidra cross-reference, **only the first 2
ushorts of each record are populated**:

- `ushort[0]` — block_id. Ids < 200 match the wire-ids from
  [[wire-id-pairs-per-placed-block]]; ids >= 200 (200, 201, 206,
  207... observed) are unplaced/shunt placeholders with no TLV in the
  serialized chain.
- `ushort[1]` — flag ushort. Bit 1 (`0x0002`) = "active in standard
  scene" (-DECODE-NOTES.md lines 399-410). Other bits' semantics
  not yet decoded but observed values cluster around 0x0002, 0x0003.
- `ushort[2..7]` — zero, reserved by firmware (writeback must preserve
  zeros)

Termination: block_id = 0 marks an empty entry; 383/388 corpus
presets fill all 12 entries.

## Where it's used

The table records the preset's GRID / signal-chain order (2026-07-02:
Test Crunch table order is Comp,Drive,Amp,Cab,Delay,Reverb — the
signal chain — while the serialized TLV chain is alphabetical
Amp..Reverb). The earlier framing ("enumerate which blocks are
PLACED") is WRONG in both directions: placeholders >= 200 appear in
the table without being serialized, and the multiset of table ids
otherwise mirrors the chain's effect blocks but tells you nothing
about where their data lives. Scene-state ushort offsets per block
([[scene-state-ushort]]) were historically looked up via this table;
new code should resolve blocks via the TLV walk.

## Misapplication failure modes

- **DO NOT use this table to enumerate blocks or predict layout**
  (2026-07-02): it is grid-order metadata with placeholder ids. The
  serialized layout is the TLV chain, [[ii-preset-image-tlv-chain]].
- **DO NOT** assume the unused ushorts (positions 2..7) carry paramBase
  or any layout information. They DO NOT. paramBase is the TLV
  position: `tlvWord + 2` per [[ii-preset-image-tlv-chain]] (the
  historical width-sum prediction lives in [[parambase-plus-paramid]] /
  [[alphabetical-name-cascade-block-ordering]]).
- **DO NOT** treat the table as fixed-position (always at chunk 0
  ushort 36). The OFFSET is stable in the II envelope family, but a
  new firmware revision could shift it; verify against the envelope
  descriptor table ([[vendor-envelope-descriptor-table]]) for the
  current firmware.

## Where it does NOT apply

- AM4 (no analog; 4 fixed slots, no record table needed)
- Axe-Fx III — transfer candidate (would need probe of III preset
  binary structure)

## Verification path

No inline fixture ships (golden is STUB). A functional case, if added,
would parse a known preset capture and assert:
- Records start at chunk 0 ushort 36
- Each record is 8 ushorts (stride verified)
- Only positions 0-1 are non-zero
- Block-id sequence matches expected placed blocks

## Refinement history

- : table structure decoded. 21 blocks total mappable per
  the table.
-  cont: Ghidra cross-reference confirmed ushort[2..7] are
  always zero (firmware doesn't write them); paramBase dynamic-
  computation hypothesis confirmed.
- 2026-07-02 (preset-image TLV decode): role corrected — the table is
  grid/signal-chain-order metadata with a 12-entry cap and >= 200
  placeholder ids, NOT a placed-block enumerator and NOT layout order
  (layout-order hypothesis refuted on Test Crunch). Region pinned to
  words 36..129 (entry 12 clipped at the word-130 chain start).
  Block enumeration + addressing moved to [[ii-preset-image-tlv-chain]];
  golden coverage via scripts/verify-ii-preset-image-tlv.ts.
