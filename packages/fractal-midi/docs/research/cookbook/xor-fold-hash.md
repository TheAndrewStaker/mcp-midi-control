---
name: xor-fold-hash
class: checksum
status: matched
discovered:  (Ghidra disasm of FUN_00544cc0)
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-xor-fold-hash
relates_to: [vendor-envelope-descriptor-table, septet-21bit-byte2-mask-preservation]
consumed_in:
  - packages/fractal-gen2/src/presetDump.ts
  - scripts/_research/verify-footer-xor-hash.ts
---

# XOR-fold hash (II preset footer)

Axe-Fx II preset binary footer hash is a trivial 16-bit XOR-fold of the
DECODED native ushorts in the body.

## Formal definition

Given the decoded ushort array `U = [u0, u1, ..., u1023]` (each `ui` is
a 21-bit value extracted via [[septet-21bit-byte2-mask-preservation]]):

```
hash = U.reduce((acc, u) => acc ^ (u & 0xFFFF), 0) & 0xFFFF
```

The hash is computed over the DECODED ushorts, NOT the raw wire bytes.
Encoding then packs the 16-bit hash via the footer descriptor table
(see [[vendor-envelope-descriptor-table]]) at `0xdff900` with
`(tag=0, mid=6, byte_count=3)`.

Source: `FUN_00544cc0` in AxeEdit.exe (II 32-bit).

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

`scripts/cookbook-verify.ts#case-xor-fold-hash` runs 2 fixtures:
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
- 2026-05-22 (Rosetta-stone cookbook audit): misapplication
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
