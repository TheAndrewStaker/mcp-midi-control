---
name: ii-fn0e-query-states
class: struct-layout
status: matched-singleton
verified_on:
  - axe-fx-ii-q8.02
golden: scripts/primitives-verify.ts#case-ii-fn0e-query-states
relates_to: [ii-fn1f-atomic-read, scene-state-ushort, septet-14bit]
---

# Axe-Fx II fn 0x0E QUERY_STATES whole-preset block-state read

fn 0x0E SYSEX_QUERY_STATES is AxeEdit's single-round-trip whole-preset
block-state read. A "Read from Axe-Fx" / direct-sync gesture fires fn
0x20 GET_GRID and fn 0x0E together, and the pair reconstructs the whole
working buffer. It is distinct from [[ii-fn1f-atomic-read]] (fn 0x1F),
which is a per-block, multi-KB parameter dump.

The response payload is the bytes between the 6-byte header
`F0 00 01 74 07 0E` and the trailing `F7`. It tiles into fixed 5-byte
records:

```
record = [tag] [b1] [b2] [b3] [b4]
  tag = per-block LIVE state in the ACTIVE scene:
          bit 0x01 = engaged (1) vs bypassed (0)
          bit 0x02 = active channel (X vs Y)
          (other tag bits not yet exercised)
  b1..b4 = a per-block address/offset, INVARIANT across bypass, channel,
           and scene changes. The low-14 field (b1 | b2<<7) increments by
           a ~1028 stride per record (see below). This is NOT the
           bypass/channel/scene bitmap (the earlier framing of b1..b4 as
           the state word was wrong; the live state is in the tag byte).
```

## What is matched

- **5-byte record stride.** The payload length is always a multiple of
  5.
- **Record count == placed NON-SHUNT block count.** Cross-checked
  against the fn 0x20 GET_GRID read captured in the same session. A
  12-cell grid with one shunt cell yields a 55-byte payload (11
  records); a sibling buffer with that shunt replaced by a real block
  (Volume/Pan 1, blockId 127) yields a 60-byte payload (12 records).
  Shunts (blockId 200..235) do not get a record. This also explains the
  11-vs-12 record-count difference between
  `session-58-direct-sync.syx` (11 records) and
  `session-60-channel-toggle.syx` (12 records): different working
  buffers, one with a shunt cell where the other has a placed block, not
  a count instability.
- **Checksum-less framing.** The response carries no trailing checksum.
  XOR over `F0`..second-last byte = `0x1a` for the 62-byte sample,
  which is not the byte present in that slot, so that byte is data.
- **Payload-insensitivity.** An empty request and a block-selector
  request return the same frame shape.
- **Byte-exact tiling round-trip on two captures** that are TWO DISTINCT
  working-buffer states. They differ at records 4 and 7, which
  strengthens the structure-generalization axis (the tiling holds
  across changing block state, not just one frozen frame).

## Tag byte = live per-block state in the active scene (bound by controlled differential)

The leading tag byte of each record carries the block's live state for
the currently active scene. Three controlled differentials bind it:

- **Channel = bit `0x02`** (offline, `session-60-channel-toggle.syx`).
  Toggling Amp 1 (effectId 106) X to Y flips exactly one byte in the
  whole frame: Amp 1 record byte 0 `0x03` to `0x01` and back. Bit `0x01`
  stays set; the toggled bit is `0x02`.
- **Bypass = bit `0x01`** (live, Q8.02). Bypassing Amp 1 flips only its
  record byte 0 `0x03` to `0x02`; re-engaging restores `0x03`. So bit
  `0x01` = engaged (1) vs bypassed (0). State restored after.
- **The frame is active-scene-derived** (live, Q8.02). Switching scene 0
  to scene 1 flipped the engaged bit (`0x01`) on nine records (blocks
  whose bypass differs between the two scenes) and changed nothing else;
  bytes b1..b4 never moved. So the record reflects the ACTIVE scene's
  state, not a whole-preset multi-scene bitmap; switching scene re-reads
  the per-scene engaged/channel state into the tag byte.

So tag bits `0x01` (engaged) and `0x02` (channel) are bound, and the
scene model is settled (active-scene-derived). N is small (one block per
flip; channel direction inferred) but each is a clean single-bit
differential. Corroboration: Amp 1 record 0 is byte-identical
(`03 4a 10 53 06`) across `session-58-direct-sync.syx`,
`session-60-channel-toggle.syx`, and the live Q8.02 baseline.

## Bytes b1..b4 are a per-block address, monotonic in blockId

The 28-bit value `b1 | (b2<<7) | (b3<<14) | (b4<<21)` is a per-block
address that is INVARIANT across bypass / channel / scene (an address
does not change with state) and is **monotonic in blockId**. This was
confirmed by a controlled record-to-block map (Q8.02): each placed
block's bypass was toggled in turn, identifying which record's engaged
bit flips, for an 11-block preset. Sorting the 11 records by their
28-bit address reproduces blockId-ascending order **exactly (11/11)**:

```
records sorted by b1..b4 -> 100,106,108,110,112,114,116,118,120,124,133
blockId ascending        -> 100,106,108,110,112,114,116,118,120,124,133
```

The delivery order (the order records arrive in the frame) is NOT this:
it is preset-specific (this preset arrived 106,108,116,100,112,133,...),
and it is also NOT grid-cell order. The low-14 field alone is not
monotonic (b3/b4 carries the high address bits); only the full 28-bit
value sorts cleanly. The address steps by a ~1024 base stride between
adjacent blockIds, with per-block variation (one block reads `0x78` in
b4, a large jump consistent with a separate address region for a
high-blockId block). Corroborated across two captured presets (the
~1028-stride low-14 run 2122/3150/4178/5214/6242/7280 recurs).

## Record identification rule (solved)

To map fn 0x0E records to blocks without relying on delivery order:

1. Read fn 0x20 GET_GRID for the placed blockIds.
2. Read fn 0x0E and decode the records.
3. **Sort records by their 28-bit b1..b4 address; zip to the placed
   blockIds sorted ascending.** That binds each record to its block.
4. Read engaged (tag `0x01`) and channel (tag `0x02`) per block.

Remaining footnote (not blocking use): the exact internal structure of
the b3/b4 high field and why the per-blockId address stride is not
perfectly linear are uncharacterized; neither affects the sort-based
identification.

## Where it does NOT apply

- AM4 does not expose fn 0x0E in its editor's wire vocabulary; the
  capability does not transfer at the editor level (see
  `_negative/am4-query-states-fn0e-transfer.md`). On Axe-Fx III, byte
  0x0E is QUERY SCENE NAME, not QUERY_STATES (see
  `_negative/iii-fn0e-fn16-from-ii-transfer.md`). So fn 0x0E
  QUERY_STATES is an Axe-Fx-II-only opcode: no second device axis
  exists, which is why this entry is matched-singleton rather than
  matched.
- The codec parser (`parseQueryStatesResponse` in
  `src/gen2/axe-fx-ii/setParam.ts`) currently returns opaque records. It can
  now expose the per-block engaged (tag `0x01`) and channel (tag `0x02`)
  state, and identify each record's block by sorting records on the
  28-bit b1..b4 address and zipping to the grid's placed blockIds
  ascending (see "Record identification rule" above).

## Refinement history

- 2026-05-28: structural decode committed. Record stride, record-count
  invariant, checksum-less framing, payload-insensitivity, and
  byte-exact tiling round-trip across two distinct working-buffer states
  all verified. Opaque codec parser added (tag + four state septets +
  packed 28-bit word). Bit semantics and ordering basis remain
  hardware-gated.
- 2026-05-28: channel flag bound offline to tag byte bit `0x02` from a
  controlled X to Y to X differential in `session-60-channel-toggle.syx`
  (one byte flips, Amp 1 record byte 0, `0x03` to `0x01` to `0x03`).
  Record-count invariant refined to placed NON-SHUNT blocks (shunts
  blockId 200..235 get no record), which also reconciles the 11-vs-12
  record difference between the two captures. Two record-ordering
  hypotheses (grid-cell order, second-byte-sort) falsified. Bypass bits,
  scene bits, and the ordering basis remain hardware-gated.
- 2026-05-29: tag-byte state bound on hardware (Q8.02). A live bypass
  toggle on Amp 1 flips only its record byte 0 `0x03` to `0x02`, so bit
  `0x01` = engaged. A live scene switch (0 to 1) flips the engaged bit on
  nine records and moves nothing else, so the frame is active-scene
  derived (not a whole-preset multi-scene bitmap), and bytes b1..b4 are
  invariant across bypass / channel / scene (they are NOT the state
  word; the earlier b1..b4-as-state framing was wrong). Remaining open:
  the meaning of b1..b4 and the record-ordering basis. State restored
  after each differential.
- 2026-05-29: bytes b1..b4 decoded offline as a per-block address/offset
  (low-14 field b1|b2<<7 increments by a ~1028 stride), corroborating the
  earlier address-delta observation. So b1..b4 is an address, not state.
- 2026-05-29: record-ordering SOLVED and entry promoted to
  matched-singleton. A controlled record-to-block map on Q8.02
  (`scripts/_research/probe-axefx2-fn0e-record-map.ts`, bypass-toggle per
  block, 11-block preset, state restored) showed the 28-bit b1..b4
  address is monotonic in blockId: sorting records by that address
  reproduces blockId-ascending order exactly (11/11). The record
  identification rule (sort records by address, zip to placed blockIds
  ascending) closes the get_preset record-to-block mapping. Delivery
  order is preset-specific (not grid, not blockId, not address) and is
  ignorable. Remaining footnote: b3/b4 internal structure + the
  non-linear per-blockId stride, neither blocking use. matched-singleton
  because fn 0x0E QUERY_STATES is II-only (AM4 and III 0x0E are different
  ops), so no second device axis exists.
