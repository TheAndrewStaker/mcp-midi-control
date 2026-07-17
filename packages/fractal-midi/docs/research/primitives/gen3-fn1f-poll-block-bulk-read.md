---
name: gen3-fn1f-poll-block-bulk-read
class: fn-byte-mapping
status: matched-singleton
discovered: FM9 community capture (2026-06-03; hardware-confirmed shape, server-issued poll tester-pending)
verified_on:
  - fm9
  - fm3-fw-12.00
verified_scope: burst SHAPE byte-confirmed on FM9 (front-panel-driven and poll-answered); our SERVER issuing the poll is FM3-hardware-confirmed end-to-end (2026-06-12 community field test over USB-serial, 35/42 block types assembled, itemCount == valueCount on every one).
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-gen3-fn1f-poll-block-bulk-read
relates_to: [am4-fn1f-atomic-read, ii-fn1f-atomic-read, septet-14bit, xor-7f-envelope-checksum, gen3-paramid-reuse-across-model-bytes]
consumed_in:
  - fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md
---

# Gen-3 fn=0x1F block bulk-read POLL → 0x74/0x75/0x76 burst

The modern Fractal family (Axe-Fx III / FM3 / FM9, gen-3) exposes the SAME
fn=0x1F atomic block-read as the Axe-Fx II and AM4: a host POLL carrying a
14-bit effectId, answered ~1 ms later by a `0x74/0x75/0x76` state-broadcast
burst (NOT a separate fn=0x1F response body). The cross-device transfer from
[[am4-fn1f-atomic-read]] is exact in shape; the gen-3 differences are the model
byte and the 3-septet `packValue16` value encoding.

This is the gen-3 read path that works: the fn=0x01 sub=0x09 per-param GET was
never observed on the wire, and the sub=0x01 info-GET is a descriptor query (not
a value read). The poll→burst is the only byte-confirmed value-read mechanism.

## Formal definition

POLL (host→device, 10 bytes):

```
F0 00 01 74 <model> 1F <eid_lo> <eid_hi> <cksum> F7
   e.g. F0 00 01 74 12 1F 42 00 <cks> F7   → FM9 poll Reverb 1 (effectId 66)
```

- `<model>` = 0x10 III / 0x11 FM3 / 0x12 FM9.
- `<eid_lo> <eid_hi>` = 14-bit effectId, septet-LE per [[septet-14bit]].
- `<cksum>` = XOR-7F envelope checksum per [[xor-7f-envelope-checksum]].

REPLY (device→host, the burst):

```
HEAD  F0 00 01 74 <model> 74 <eid:14b> <itemCount:14b> <cksum> F7      (12 bytes)
BODY  F0 00 01 74 <model> 75 <sectionId> <flag> <N × packValue16(3B)> <cksum> F7
        (paged: one or more 0x75 sections)
END   F0 00 01 74 <model> 76 <cksum> F7                                (8 bytes)
```

- The HEAD has **no flag byte**: it is exactly 12 bytes, payload `<eid:14b>
  <itemCount:14b>` (4 bytes), so the byte immediately before `F7` IS the XOR-7
  checksum. FM9 capture `F0 00 01 74 12 74 42 00 24 02 07 F7` → eid 66,
  itemCount 292, checksum `0x07`. (An earlier draft of this entry and
  `parityMock.ts`'s reader-facing mock add a spurious flag byte → a 13-byte
  head; the reader tolerates it because it reads only bytes 6..9, but the real
  device emits 12 bytes. The wire-faithful builder is
  `fractal-gen3`'s `simResponders.buildBroadcastBurst`.)

- The `0x75` body is **CHANNEL-BLOCKED**, not a flat paramId vector. It packs
  one contiguous copy of every paramId slot per channel:
  `index = channel × stride + paramId`, where `stride = itemCount /
  channelCount = (max device-true paramId + 1)`. So paramId `p` on channel `c`
  is at `c × stride + p`; the channel-A copy (`c = 0`) is at index `p`, which
  is why a flat `values[paramId]` read *happens to* return channel A.
  FM9-hardware-confirmed (capture 2026-06-04): an amp Balance (paramId 2) drag
  on channel B changed only index 149 = 1×147 + 2, with the A/C/D copies
  constant. `itemCount = stride × 4` holds across 5 distinct blocks in
  existing FM9 captures (all 4-channel blocks): DISTORT 588=147×4,
  REVERB 292=73×4, Phaser 140=35×4, Filter 148=37×4, Drive/Fuzz 172=43×4.
  ⚠️ **`channelCount` is per-block, NOT uniformly 4** (FM3 field test,
  2026-06-12): FM3 itemCounts Send 2, Return 6, Ring Mod 26, Megatap 70 are
  not divisible by 4; Looper 24 vs catalog max paramId 23 → 24×1;
  Resonator 80 vs max paramId 39 → 40×2. Derive `channelCount` per block from
  the `fn=0x13` `dd` bits 6:4 or from `itemCount / (catalog max paramId + 1)`;
  never assume 4.
- paramIds are per-device (see [[gen3-paramid-reuse-across-model-bytes]]), so the
  per-channel `stride` differs per device/block and the channel-A index of a param
  decodes against each device's own catalog (Reverb TYPE is channel-A index 0 on
  III/FM3 but 10 on FM9).
- A whole-block dump **pages** across multiple `0x75` frames at the transport
  level (each frame carries up to ~256 values), independent of the channel
  blocking; Reverb's 292 values arrive as a 256 + 36 split. Concatenate frames in
  arrival order, THEN apply the channel-stride index.

## Misapplication failure modes

- ~~**DO NOT** poll an unplaced block. Like AM4, the device answers a poll for
  an empty effectId with an `fn=0x64` MULTIPURPOSE_RESPONSE NACK, not a
  burst.~~ **CORRECTED 2026-06-12 (FM3 field test, fw 12.00):** that claim was
  an AM4/II analogy never gen-3-observed, and is **falsified on FM3**: the
  field-test session answered `fn=0x1F` polls with full bursts for 35/42 block
  types while the same session's `fn=0x13` STATUS_DUMP reported only 3 placed
  blocks (Input/Output/Amp; capture
  `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json`). A poll
  answers REGARDLESS of placement, returning the block's working-buffer state.
  Use `fn=0x13` for placement truth; do not use "poll answered" as a placement
  detector, and beware reads silently returning unplaced-block state (the AM4
  phantom-param class). The 7 FM3 single-frame repliers (Tuner, IR Capture,
  Vocoder, Crossover, Tone Match, RTA, IR Player) are not-pollable block
  TYPES, not unplaced blocks.
- **DO NOT** reuse the III's paramId offsets to index an FM3/FM9 dump. The dump
  is positional by *device-true* paramId; using the III's offsets mis-reads the
  value (see [[gen3-paramid-reuse-across-model-bytes]]).
- **DO NOT** treat a 0x74 head for a different blockId as our reply. Front-panel
  edits emit the same burst unsolicited; gate on the head's `eid` matching the
  poll's effectId.
- **DO NOT** read `values[paramId]` as "the value"; that is the channel-A copy
  only. For a param that differs across channels it silently returns channel A's
  value regardless of the active channel. Read `values[channel × stride + paramId]`;
  if no channel is specified, return the value only when all four channel copies
  are equal, else require a channel. (The pre-2026-06-04 reader had this bug,
  hidden because the one param ever tested (Reverb Mix, paramId 0) sat at the
  channel-A index 0 either way.)

## Where it does NOT apply

- AM4: sibling primitive at [[am4-fn1f-atomic-read]] (model byte 0x15, same
  per-block shape, but `decode16Packed`-style values, not `packValue16`).
- Axe-Fx II: sibling at [[ii-fn1f-atomic-read]] (no-payload poll returns the
  WHOLE preset in one frame; gen-3 is per-block like AM4).

## Verification path

`scripts/primitives-verify.ts#case-gen3-fn1f-poll-block-bulk-read` checks the poll
shape + positional paging concatenation on a synthetic burst. Wire/decode goldens
live in `fractal-midi/test/gen3/modern-family/catalog.test.ts` (poll well-formedness +
`assembleGen3BlockBulkRead` across two paged sections); the end-to-end reader is
mock-tested in `scripts/verify-fractal-gen3-family.ts` §9 (poll → burst →
positional decode → enum label, across III/FM3/FM9).

## Refinement history

- 2026-06-03 (S2): poll builder `buildBlockBulkReadPoll` + assembler
  `assembleGen3BlockBulkRead` shipped on the `ModernFractalCodec` factory; the
  `fractal-gen3` (formerly `fractal-modern`) reader (`collectBlockBulkRead`)
  wires get_param / get_params
  through it, labeling enums via the S1 read-leg overlay. The burst shape is
  FM9-hardware-confirmed (capture 2026-06-03, both front-panel-driven and as the
  answer to a poll); the server *issuing* the poll is tester-pending end to end.
- 2026-06-04: the body is **channel-blocked**, not flat-positional (corrects the
  original "index i == paramId i" claim). `index = channel × stride + paramId`,
  `stride = itemCount/4`; confirmed N=5 blocks (DISTORT/REVERB/Phaser/Filter/Drive)
  from existing-capture itemCount arithmetic + the amp-balance per-channel diff
  (5-refuter validated). The `fractal-gen3` (formerly `fractal-modern`) reader
  now projects the requested
  channel (channel-invariant → return, else refuse listing per-channel values);
  get_preset reads channel A and warns. See SYSEX-MAP "channel-blocked".
- 2026-06-04 (device-simulator session): the 0x74 HEAD is **12 bytes with no
  flag byte** (byte 10 is the checksum). Confirmed by recomputing the XOR-7 of
  the captured FM9 head bytes 0..9 → matches byte 10 exactly across the Reverb
  (292), Amp (588), and Drive (172) bursts. The wire-faithful burst builder is
  `simResponders.buildBroadcastBurst`, which the codec-backed device simulator
  uses to make the editor render the grid over loopMIDI.
- 2026-06-12 (FM3 community field test, fw 12.00, USB-serial): our server
  issuing the poll is **FM3-hardware-confirmed end-to-end** (35/42 block types
  assembled, itemCount == valueCount throughout). Two corrections harvested
  from the same session: (a) the "unplaced block answers an fn=0x64 NACK"
  misapplication bullet is **falsified**: polls answer for unplaced blocks
  (fn=0x13 reported 3 placed blocks while 35 block types answered); placement
  truth comes from fn=0x13. (b) `channelCount` is per-block, not uniformly 4
  (Send 2 / Return 6 / Ring Mod 26 / Megatap 70 / Looper 24×1 /
  Resonator 40×2); `stride = itemCount / channelCount`. Capture:
  `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json`.

Promotion path: `matched-singleton` to `cross-device-pattern` is already
half-earned (AM4 + II ship the sibling); this entry stays a singleton until a
non-Fractal per-block atomic read lands. Within Fractal, AM4 / II / gen-3 share
the fn byte but differ in poll payload and value encoding: related, not
interchangeable.
