---
name: xor-fold-hash
class: checksum
status: matched
discovered:  (Ghidra disasm of FUN_00544cc0)
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-xor-fold-hash
relates_to: [vendor-envelope-descriptor-table, septet-21bit-byte2-mask-preservation]
consumed_in:
  - packages/fractal-midi/src/gen2/axe-fx-ii/presetImage/frames.ts (computeImageHash21, the 21-bit refinement)
  - packages/fractal-gen2/src/presetDump.ts
  - scripts/_research/verify-footer-xor-hash.ts
---

# XOR-fold hash (II preset footer)

Axe-Fx II preset binary footer hash is a trivial 16-bit XOR-fold of the
DECODED native ushorts in the body.

## Formal definition

**REFINED 2026-07-16 (II): the fold is over the FULL 21-BIT words, and
the footer encodes all 21 bits.** Given the decoded 21-bit word array
`W = [w0, w1, ..., w4095]` (each `wi = lo7 | mid7<<7 | b2<<14`,
INCLUDING the byte-2 "reserved" bits, per
[[septet-21bit-byte2-mask-preservation]]):

```
hash21 = W.reduce((acc, w) => acc ^ w, 0) & 0x1FFFFF
footer payload = [hash21 & 0x7F, (hash21 >> 7) & 0x7F, (hash21 >> 14) & 0x7F]
```

Evidence: 500/503 on-disk II dumps carry exactly this footer (the only
3 misses are locally hand-modified push-test artifacts with
deliberately invalid footers), and the bk070 paired hardware dumps
show the footer's THIRD septet changing in lockstep when a scene
word's byte-2 mirror bits change (see [[scene-state-ushort]]), which a
16-bit fold cannot produce.

The earlier 16-bit formula
(`hash = U.reduce((a,u) => a ^ (u & 0xFFFF), 0) & 0xFFFF` with the
footer's `byte2 & 0x7c` preserved verbatim) is the correct PROJECTION
of this whenever a write changes no reserved bits, which is why it
never failed on the continuous RMW lane. Any encode that moves or
rewrites reserved bits (structural splice, scene-word mirror updates)
must use the 21-bit fold. Reconciliation note: the Ghidra disasm of
`FUN_00544cc0` was read as a ushort fold; the on-wire footer proves
the third septet is hash content, not preserved state, so either the
fold operates on wider ints upstream of that helper or the disasm
reading under-scoped it. The empirical formula above is the oracle.

The hash is computed over the DECODED words, NOT the raw wire bytes.
Encoding packs it via the footer descriptor table (see
[[vendor-envelope-descriptor-table]]) at `0xdff900` with
`(tag=0, mid=6, byte_count=3)`.

Scope: the 21-bit refinement is verified on the II. The gen-3 transfer
below was validated as a 16-bit fold of the body words and is NOT
claimed to carry the 21-bit extension.

Source: `FUN_00544cc0` in AxeEdit.exe (II 32-bit) + the 2026-07-16
corpus/paired-capture confirmation.

## Where it's used

II preset push (fn 0x77/0x78/0x79) footer field. Device validates the
hash on receive; mismatch causes fn 0x79 NACK 0x05.

## Misapplication failure modes

- **DO NOT** compute over raw wire bytes; must decode the 21-bit ushorts
  first.
- **DO NOT** confuse with [[xor-7f-envelope-checksum]] (universal
  Fractal envelope checksum across AM4 / II / III, per-envelope,
  7-bit mask).
## Where it does NOT apply

- AM4: uses [[xor-7f-envelope-checksum]].
- ~~Axe-Fx III, transfer candidate.~~ TRANSFERRED (2026-06-09): the
  gen-3 fn 0x79 footer carries the same 16-bit XOR-fold of the body
  words (validated by Axe-Edit III's own receive path, which XOR-folds
  the de-framed body and rejects on mismatch; and by
  `packages/fractal-gen3/src/presetHuffman.ts` `computeRawPatchXor`
  across III + FM9 factory presets). The III store flow computes NO
  additional editor-side hash; it forwards the `.syx` body verbatim and
  patches only the 0x77 header. Note the earlier pointer at emitter
  `FUN_140337060` / table `0x1407ab2f0` was a LOAD_PRESET request, not
  the store path. The gen-3 envelope XOR-fold is a separate layer from
  the inner raw-patch CRC that `presetHuffman.ts` also validates.

## Verification path

`scripts/primitives-verify.ts#case-xor-fold-hash` runs 2 fixtures:
1. Q8.02 capture from  (Bank A 128/128 match)
2. Q9.04 capture from `presetDump.ts` goldens

Verified 390/390 II presets across Bank A/B/C at ; cross-
verified against Q9.04 captures (firmware-revision axis).

## Refinement history

- 2026-05-22: Ghidra disasm of `FUN_00544cc0` revealed the
  17-line XOR-fold. Cracked the modified-push validation path.
  390/390 presets verified.
- Synthesis pass 2026-05-22: III transfer candidate filed in
  `STATE-AXEFX3.md`. Same script structure, parameterized binary.
- 2026-05-22 (Rosetta-stone primitives audit): misapplication
  parenthetical "(AM4-only)" against [[xor-7f-envelope-checksum]] was
  stale class-1 drift, identical to the model-byte error already
  corrected upstream. Fixed: the envelope checksum is universal across
  AM4 / II / III, not AM4-only.
- 2026-06-09: III transfer CONFIRMED. The III preset-binary descriptor
  tables are byte-identical to the II's record for record, the receiver
  validates the 0x79 footer as a 16-bit XOR-fold of the body words, and
  the store flow holds no second editor-computed hash. The "DO NOT
  assume this generalizes to III" caveat is retired; the gen-3 footer
  XOR was already shipping in `presetHuffman.ts`.
- 2026-07-16: II fold refined 16-bit -> 21-BIT (footer's third septet
  is hash content, not preserved state). Found by byte-diffing the
  bk070 scene paired dumps (footer high bits flip with a scene word's
  byte-2 mirror), confirmed 500/503 corpus-wide (3 misses = the known
  hand-modified-footer artifacts). Encoder: fractal-midi
  `computeImageHash21`; goldens: scripts/verify-ii-image-scene-words.ts
  (32 byte-exact pair replays) + verify-ii-image-structural-splice.ts
  (766 remove/re-add byte-identity ops). Gen-3 scope unchanged.
