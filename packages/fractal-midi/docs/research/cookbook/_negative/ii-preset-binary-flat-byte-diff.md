---
name: ii-preset-binary-flat-byte-diff
class: decode-plan
status: non-matching
discovered:  (21-capture plan rejection)
verified_on:
  - axe-fx-ii-xl-plus
firmware_sensitive: false
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when: never (re-adjudicated 2026-07-02 — the Huffman premise was refuted and the entry re-scoped; the remaining rule-outs, raw framed-byte-layer diffing and using the dump envelope for parameter sync, are structural to the frame format and to fn=0x1F being the sync primitive)
relates_to: [ii-preset-image-tlv-chain, ii-fn1f-atomic-read, vendor-envelope-descriptor-table, septet-21bit-byte2-mask-preservation, xor-fold-hash, preset-name-ascii-triplets, block-record-stride-8, am4-preset-dump-flat-byte-diff]
consumed_in: []
---

# Naive diff of the framed II `0x77/0x78/0x79` preset binary: wrong layer, wrong primitive

> **CORRECTED 2026-07-02.** This entry originally rejected the diff plan
> on the premise that the II body is "Huffman-compressed against a
> per-firmware codebook" with offsets "unstable across presets." That
> premise is **REFUTED** by on-disk evidence (adjudication below). The
> Huffman claim was a misattribution from the Axe-Fx III community RE
> (Fractal Forum #159885) — and even for the III it holds only for the
> gen-3 **.syx file body** (`packages/fractal-gen3/src/presetHuffman.ts`),
> not the II wire dump. The II body is a **fixed-layout word grid** with
> stable offsets at both the byte and word layers. Do NOT cite this entry
> as evidence that the II preset body is compressed.
>
> **SUPERSEDED-STRONGER 2026-07-02:** the word layer is not merely
> stable — it is a **self-describing TLV chain** from word 130
> ([[ii-preset-image-tlv-chain]], 388/388: 384 factory + 4 hardware
> dumps). Every block's paramBase is read directly from the dump in
> hand (`tlvWord + 2`), so cross-preset/cross-firmware offset
> "stability" no longer needs to be assumed at all; widths may drift
> across firmware (Amp payload 234 factory vs 236 live) and the chain
> still decodes exactly.

## What IS true (2026-07-02 adjudication, all local captures)

The II preset dump body is a deterministic fixed grid: 64 `fn 0x78`
chunks, each declaring exactly 64 native ushorts (2-byte septet count
`0x40 0x00` + 64 × 3-byte words per
[[septet-21bit-byte2-mask-preservation]]) — 4096 words per preset.
Evidence, one hypothesis per check
(`hw132/` + `bk070-*` + factory-bank captures):

- **Chunk word-count fixed:** every chunk across 128 Bank-A factory
  presets + 3 hw132 hardware dumps declares count=64. No variable-length
  regions anywhere — incompatible with entropy coding.
- **One-variable rename pair** (`hw132/sentinel-eb-alpha.syx` vs
  `sentinel-eb-bravo.syx`, "EB ALPHA"→"EB BRAVO"): differs at exactly
  **8 of 12,951 raw bytes** — the 5 changed name chars at byte offsets
  35/38/41/44/47 (stride 3, per [[preset-name-ascii-triplets]]), the
  chunk-0 frame checksum (212), and the footer hash + checksum
  (12,946/12,949). Zero downstream smear. At the de-framed word layer:
  exactly 5 words (chunk0 words 5..9, the ASCII codes).
- **One-variable param pairs** (`bk070-loop-amp-bass-2-*`,
  `bk070-loop-amp-master-vol-3-*`): exactly **1 differing word** each
  (chunk3 word 60 / word 63).
- **Self-validating de-frame:** the 0x79 footer equals the 16-bit
  XOR-fold of the de-framed words ([[xor-fold-hash]]) on every dump
  tested (and 390/390 historically).
- **Entropy signature absent:** over Bank A (524,288 words), 83.6% of
  words are zero, 87.2% ≤ 0x7F, and byte2's reserved bits
  (`byte2 & 0x7C`) are zero for 99.9% of words. A Huffman bitstream is
  near-uniform; this is a sparse fixed layout.
- **Cross-preset offset stability:** the name field decodes ASCII-clean
  at chunk-0 words 2..33 in **384/384** factory presets; the
  [[block-record-stride-8]] table sits at word 36 in every preset
  inspected (records span the chunk0→chunk1 boundary in the
  concatenated word image).

This matches `packages/fractal-gen2/src/presetDump.ts` (Session 113
static analysis: NOT Huffman, structured serialization) and the
cross-device note in [[am4-preset-dump-flat-byte-diff]] (II dump is
deterministic; a channel-toggle redump shows zero byte diffs). The
one-variable diff campaign this entry originally rejected was in fact
later executed successfully — the BK-070 width measurements
(`scripts/_research/bk070-measure-widths.ts`, batches A–E → 
`packages/fractal-gen2/src/blockBinaryLayout.ts`) are word-layer diffs
of exactly this dump.

## What remains ruled out

- **Diffing at the raw framed-byte layer without de-framing.** Byte
  offsets are stable, but a raw diff picks up non-signal bytes (each
  202-byte frame's XOR checksum, the footer hash) and misses that
  byte2's reserved high bits are firmware state requiring
  read-modify-write ([[septet-21bit-byte2-mask-preservation]] NACK 0x13).
  Always de-frame to the 4096-word image first; diff words.
- **Using the preset-binary envelope as the parameter-SYNC read.**
  [[ii-fn1f-atomic-read]] (`SYSEX_GET_ALL_PARAMS`) is the wire shape
  AxeEdit actually uses for its "Read from Axe-Fx" flow — one request,
  full per-block state. The `0x77/0x78/0x79` path is the store/load
  preset-file feature. For "what are the current parameter values," the
  original entry's reason 2 stands: fn=0x1F is the right primitive.
- **Assuming AM4 diffability from II** (or vice versa): the AM4 dump
  encoder is non-deterministic (~20% byte churn on a no-op redump, see
  [[am4-preset-dump-flat-byte-diff]]); the II dump is deterministic.
  Same envelope shape, different stability property.

## Symptoms / grep terms

Search these before re-attempting (or before re-believing the old claim):

- "II preset dump byte diff" / "diff 0x77/0x78/0x79 captures"
- "Huffman-compressed preset body" / "offsets unstable across presets"
  (REFUTED for the II — see adjudication above)
- "21-capture plan" / "one parameter changed per capture pair"
- "fixed 64-word chunk grid" / "4096-word image"

## Refinement history

- 2026-05-22 (cookbook backfill): negative finding registered.
  Citation correction: earlier CLAUDE.md text stated `fn 0x0E` for
  the atomic read primitive; the cookbook positive entry confirms
  it is `fn=0x1F`. This cookbook negative is the byte-correct
  reference.
- 2026-07-02 (record-contradiction adjudication): the "body is
  Huffman-compressed / offsets unstable" premise refuted against the
  hw132 rename pair, bk070 one-variable param pairs, and all 384
  factory presets (checks H1–H7 above). Entry re-scoped: the ruled-out
  items are raw-framed-byte diffing (vs the de-framed word layer) and
  using the dump envelope for parameter sync; the fixed-layout claims
  in `presetDump.ts` / [[preset-name-ascii-triplets]] /
  [[block-record-stride-8]] / [[xor-fold-hash]] are the correct record.
  Root CLAUDE.md's "Body is Huffman-compressed; offsets unstable"
  bullet mirrors the old text and needs the same correction.
- 2026-07-02 (preset-image TLV decode): stable-word-layer claim
  superseded-stronger — the image is a self-describing TLV chain
  ([[ii-preset-image-tlv-chain]]); per-dump paramBase is read, not
  predicted, making the offset-stability question moot for
  read-modify-write.
