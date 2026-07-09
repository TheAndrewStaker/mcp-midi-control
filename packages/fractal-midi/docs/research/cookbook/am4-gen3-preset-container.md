---
name: am4-gen3-preset-container
class: envelope
status: matched
discovered: 2026-07-02 (cross-device transfer reflex — gen-3 container hypothesis run against the AM4 dump corpus, full-bank oracle sweep)
verified_on:
  - am4 fw 1.01 (factory bank, 104 presets)
  - am4 fw 2.00 (hardware exports + warm-pair captures, 13 dumps)
firmware_sensitive: false
golden: packages/fractal-midi/test/am4/presetcontainer.test.ts (synthetic round-trip + CRC/XOR vectors); capture sweep scripts/verify-am4-preset-container.ts (890 checks / 117 dumps — adds the body block-record-chain amp walk)
relates_to: [gen3-fn03-request-preset-dump, am4-fn03-stored-dump-request, vendor-envelope-descriptor-table, xor-fold-hash, xor-7f-envelope-checksum, am4-preset-dump-flat-byte-diff]
consumed_in:
  - fractal-midi/src/shared/presetContainer.ts
  - fractal-midi/src/am4/presetContainer.ts
  - fractal-midi/src/am4/bodyChain.ts (body block-record chain walker + amp param-value decode)
  - mcp-midi-control/packages/am4/src/descriptor/reader.ts (stored get_preset surfaces whole_preset.amp)
  - mcp-midi-control/packages/fractal-gen3/src/presetHuffman.ts (re-export shim; gen-3 byte-identity preserved)
---

# AM4 `0x77/0x78/0x79` dump body = the gen-3 preset container, verbatim

The AM4 preset dump (13 B `0x77` header + **4** × 3,082 B `0x78` chunks +
11 B `0x79` footer = 12,352 B) carries the SAME inner container as the
gen-3 family (III = 16 chunks, FM3/FM9 = 8): **the chunk count is the only
device knob (N=4 on AM4)**.

- Chunk payload = 2-byte discriminator (constant `[00 08]` on every AM4
  chunk observed) + 3,072 packed bytes.
- Concatenate the packed bytes across chunks → 3-to-16 septet unpack
  (`b0 | b1<<7 | b2<<14` → LE u16) → 8,192 B `raw_patch`
  (4 × 1,024 LE words).
- `raw_patch` layout (identical offsets to gen-3): word[0] = fw/format
  word (`0x0107` fw 1.01 / `0x0109` fw 2.00); word[1] = `0xAA55` magic;
  `0x04` u16 = CRC-16/CCITT (poly `0x1021`, MSB-first, init `0xAA55`)
  computed with `[0x04:0x06]` zeroed; `0x08` = 32-char ASCII preset name;
  `0x48`/`0x4A` u16 = decompressed/compressed body sizes; `0x4C` = gen-3
  dynamic-Huffman bitstream decompressing to exactly decompSize;
  zero-filled tail.
- `0x79` footer payload = septet-packed u16 XOR of all raw_patch LE words
  (`computeRawPatchXor` — the same [[xor-fold-hash]]-family fold gen-3
  uses).

Oracles (all self-validating, no hardware key-press needed): CRC + footer
XOR + Huffman-terminates-at-decompSize + `0xAA55` magic + plaintext
name/scene-name decode hold on **all 104 fw 1.01 factory presets**
(`samples/factory/AM4-Factory-Presets-1p01.syx`) **and 13 fw 2.00
hardware dumps** (`samples/factory/A01-original.syx`,
`samples/captured/hw132/am4-{stored-a01,active-1}.syx`,
`samples/captured/am4-warm-pair-*-{before,after}.syx`).

## Decoded-body facts (field map PARTIAL)

Offsets into the DECOMPRESSED body; values are standard AM4 LE u16 on the
0..65534 wire scale:

- Scene records @ `0x0004 + n×0x50` (n=0..3): 32-char ASCII scene name
  (space-padded, NUL at 31), then unmapped per-scene state.
- amp.gain channel A @ `0x0958` (warm-pair oracle: display 5.1 →
  `0x828E` = round(5.1/10×65534)).
- ONE volatile u16 @ `0x140E`: churns between back-to-back no-op redumps.
- A no-op redump pair differs by exactly 2 bytes (that word) at the
  decoded layer; a one-variable amp-gain edit localizes to a single u16.

## Body = a walkable BLOCK-RECORD CHAIN (amp block byte-exact)

The body is NOT a fixed offset table: an amp TYPE-swap warm pair shrank one
body's `decompSize` 5344 → 4528 (a fixed table keeps length constant, so
downstream offsets shift when a block's type changes). It is a **walkable
variable-length block-record chain**. The AMP block is byte-exactly decoded:

- **Marker.** `u16 == the block's pidLow` (amp = `0x003A`), followed by a
  `0x0E`-byte record header (words 1..4 == 0 on a real block record; word
  5/6 carry block-level fields).
- **4 per-channel records** A/B/C/D at stride `0x130` bytes each.
- **Param word rule:** `off = marker + channel*0x130 + 0x0E + pidHigh*2`
  ("pidHigh + 7 words"; `0x0E` header bytes = 7 words). CONFIRMED anchors
  (warm-pair oracle): amp.type chA pidHigh `0x0A` off `0x22`; amp.gain chA
  pidHigh `0x0B` off `0x24` (`0x828E`=5.1); amp.gain chB pidHigh `0x0B` off
  `0x154` (pins the `0x130` stride); amp.master chA pidHigh `0x0F` off
  `0x2C`. The rest of the registered amp knobs ride the SAME geometry
  (formula-extrapolated from the four anchors), decoded through the shipped
  param scaling.
- **Config-dependent base — WALK IT, never hardcode.** The amp marker sits
  at body `0x0934` in 70/104 factory presets, `0x0A92` in 17 (an extra
  pre-amp record enlarges the modifier region by `0x15E`), and is ABSENT in
  17 (16 empty presets + one intentional `'Bass NoAmp DI'`).
  `locateAm4AmpBlock` scans + validates the record shape, so the marker is
  found in every config without a hardcoded offset.
- Decoder: `decodeAm4AmpBlock` (`src/am4/bodyChain.ts`) →
  `whole_preset.amp` (per-channel A/B/C/D knob maps, matching the gen-3
  `amp1` view). Golden buckets the located base per factory preset
  (70/17/17, zero false positives) and asserts the four anchors decode to
  5.1.

## Misapplication modes

- **Don't flat-diff the compressed layer.** The dynamic Huffman code
  table is rebuilt per export, so byte-identical decoded content still
  produces thousands of compressed-byte diffs (the old "encoder
  non-determinism" — see [[am4-preset-dump-flat-byte-diff]], mechanism
  now explained). Diff `decodeAm4RawPatch(...).decompressedBody`.
- **Mask the volatile word.** Decoded-layer comparisons must exclude
  body `0x140E..0x140F` or a no-op churn reads as a signal.
- **Chunk count is the device knob (N=4 on AM4).** Do not assert the
  III's 16 or the FM3/FM9's 8; parse by frame-walking to the `0x79`
  footer and validate the resulting raw_patch size instead.
- **The CRC field is self-referential.** Compute over the image with
  bytes `[0x04:0x06]` zeroed; folding the stored CRC in gives a false
  mismatch.
- **fw word ≠ content.** `A01-original.syx` vs the bank's A01 differ at
  the compressed layer partly because the fw word is `0x0109` vs
  `0x0107`; compare decoded bodies, not raw_patch bytes, across firmware.
- **Config-dependent block base MUST be walked.** The amp marker is at
  `0x0934` OR `0x0A92` OR absent; hardcoding `0x0934` misreads the 17
  larger-modifier-region presets and the 17 amp-less ones. Scan + validate.
- **A bare `u16 == effectId` scan false-positives.** Param values and
  modifier/routing records collide with small effectId markers (a naive
  scan reads two reverbs, `cab@0x0934` nonsense, etc.). Validate the record
  SHAPE: real block records have header words 1..4 == 0; the amp marker
  additionally needs all four channel TYPE ordinals in `[0, 247]`
  (a valid `AMP_TYPES` index). This is why only the amp block is decoded —
  it is the one block with an ordinal-bounded type enum to gate on.
- **stride / pidHigh+7 verified on AMP only.** Cab (`0x003E`) and FX blocks
  share the chain structure but their per-block stride + param formula are
  UNVERIFIED (no isolated one-variable capture yet). Don't extrapolate the
  amp formula to them — that's the pending capture (see captured-artifacts
  UNMINED `2026-07-02`), and shipping a guessed non-amp value would be a
  WEAK-evidence leak under the same "untested" banner as the amp anchors.

## Consumers / goldens

Decoder: `decodeAm4RawPatch` (`src/am4/presetContainer.ts`); shared
primitives hoisted to `src/shared/presetContainer.ts` (fractal-gen3's
`presetHuffman.ts` is now a re-export of them — gen-3 behavior
byte-identical, proven by verify-gen3-preset-huffman/-body/-authoring
staying green through the hoist). Pure-CPU golden:
`test/am4/presetcontainer.test.ts`. Capture sweep:
`scripts/verify-am4-preset-container.ts` (clean-skips when `samples/`
is absent).

## Refinement history

- 2026-07-02: registered at `matched` (two firmware axis points: the fw
  1.01 factory bank and fw 2.00 hardware exports; the container claim is
  additionally cross-device — the same primitives validate the III/FM9
  corpora). Explains and refines [[am4-preset-dump-flat-byte-diff]]
  (verdict stands; mechanism corrected from "encoder non-determinism"
  to dynamic-Huffman table churn + one volatile decoded word).
- 2026-07-02: BODY block-record chain decoded for the AMP block (marker +
  `0x130` channel stride + pidHigh+7 rule), diff-anchored on the AM4
  warm-pair captures and swept over the 104-preset factory bank (base
  distribution 70/17/17, zero false positives). Shipped `bodyChain.ts`
  (`locateAm4AmpBlock` / `decodeAm4AmpBlock`) → AM4 stored `get_preset`
  now surfaces `whole_preset.amp` (community-beta; four fields
  hardware-anchored, the rest formula-extrapolated on the same geometry).
  Non-amp blocks remain an honest omission pending per-block captures.
