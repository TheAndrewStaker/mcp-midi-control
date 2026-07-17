---
name: am4-preset-dump-flat-byte-diff
class: decode-plan
status: non-matching
verified_on:
  - am4
firmware_sensitive: false
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when: never (re-adjudicated 2026-07-02: the container-decoder trigger already fired; am4-gen3-preset-container explains the churn as dynamic-Huffman table rebuild, flat-byte diffing of the compressed layer stays ruled out, and the decoded-layer diff lane shipped)
relates_to: [ii-preset-binary-flat-byte-diff, am4-fn1f-atomic-read, vendor-envelope-descriptor-table, am4-gen3-preset-container]
consumed_in: []
---

# Flat-byte-offset diff of the AM4 `0x77/0x78/0x79` preset binary: does NOT work

> **MECHANISM SUPERSEDED, VERDICT STANDS (2026-07-02).** The churn below
> is NOT encoder non-determinism: the dump body is the gen-3 preset
> container ([[am4-gen3-preset-container]]) and the per-export byte churn
> is the dynamic-Huffman CODE TABLE being rebuilt each export, plus ONE
> volatile decoded u16 @ body `0x140E`. Flat-byte diffing of the
> compressed layer stays ruled out exactly as written. The supported lane
> is now **decoded-layer diffing**: `decodeAm4RawPatch(...).decompressedBody`
> with `0x140E..0x140F` masked; a no-op redump pair diffs by exactly
> 2 bytes there, and the warm-pair amp-gain edits localize to a single
> LE u16 (chA gain @ `0x0958`). The "What works instead" list below
> gains that lane as the primary one for body field mapping.

A natural decode plan for the AM4 preset-dump body is: capture two
dumps with exactly one variable changed (a block-type swap, a per-channel
gain edit), diff the binaries byte-for-byte, and read the changed field's
offset from the diff positions. It does not work on AM4, for a reason
distinct from the II case ([[ii-preset-binary-flat-byte-diff]], whose
original "Huffman-compressed" premise was refuted 2026-07-02; the II
body is a stable fixed-layout word grid and word-layer diffing works
there): the AM4 dump encoder is **non-deterministic between identical
inputs**.

## Why it fails

**The encoder reshuffles the body on every export, even with no edit.**
A no-mutation redump pair (`am4-warm-pair-1-baseline-redump-before.syx`
vs `-after.syx`, captured back to back in one warm session) differs by
**2541 of 12352 bytes** (about 20 percent), spread across all four
`fn 0x78` chunks. A one-variable amp-type swap
(`am4-warm-pair-5-amp-type-swap-{before,after}.syx`) differs by 2909
bytes: the swap contributes only roughly 370 diffs on top of the 2541
no-op baseline noise, so the signal is swamped. With a ~20 percent noise
floor, no stable byte holding a changed field's value can be localized
from these pairs. The cleartext block-layout table (chunk-1 payload
`0x0E..0x40`) does NOT change on a confirmed amp-type swap and does not
hold block-type codes as record byte 0, so the dump does not expose
block-type identity in a flat-diffable position either. See
`am4-warm-pair-diff.json` (per-chunk `byte_diffs` / `septet_diffs`) and
`docs/devices/am4/preset-binary-format-research.md` Section 10.10.

Note the contrast with Axe-Fx II: the II `0x77/0x78/0x79` dump IS
deterministic between identical inputs (a channel-toggle redump of
`Drive_1` / `Compressor_1` shows zero byte diffs), and per the
2026-07-02 correction of [[ii-preset-binary-flat-byte-diff]], the II
body is a stable fixed-layout word grid, so one-variable word-layer
diffing WORKS on the II (the BK-070 width measurements are exactly
that). The AM4 and II dumps share an envelope shape but not a stability
property; do not assume one device's diffability from the other, in
either direction.

## What works instead

- **AM4 `fn 0x01 action=0x1F` name-table snapshot** for preset name, the
  four scene names, the active scene index (`0x08`), and the four
  per-slot block-type codes (`0xB0`, `BLOCK_TYPE_VALUES` pidLows). This
  is a structured, stable, deterministic reply. See
  `docs/devices/am4/SYSEX-MAP.md` "Read response for action = 0x1F".
- **[[am4-fn1f-atomic-read]]** (`fn 0x1F` per-block atomic read) for
  per-block parameter state, single round-trip per block.
- The **parser-side AM4-Edit Ghidra arc** recovers byte-positional
  knowledge of the dump body without any capture.

## What this does NOT rule out

- A **same-warm-window single-block capture**: a Z04 scratch preset
  holding exactly one block in slot 1, dumped, then one `set_block_type`
  swap, dumped again in the same session. With one block present the
  model-default-parameter churn is far smaller, so a stable block-type
  byte (if one exists in the dump) could be localized against the layout
  table. The existing corpus only has multi-block (`AM4 Gig Rig`) pairs,
  whose swapped-amp model-default churn swamps the layout-table signal.
- Diffing other AM4 envelopes whose bodies are stable by construction
  (`fn 0x01` single-param messages, the `action=0x1F` snapshot above).

## Symptoms / grep terms

Search these before re-attempting:

- "AM4 preset dump diff" / "0x77/0x78/0x79 byte diff AM4"
- "dump encoder non-deterministic" / "no-op redump differs"
- "2541 of 12352 bytes" (the measured noise floor)

## Refinement history

- 2026-07-02: mechanism corrected (not encoder non-determinism:
  dynamic-Huffman table churn in the gen-3 container,
  [[am4-gen3-preset-container]]). Verdict unchanged: flat-byte diffing
  of the compressed stream remains ruled out; decoded-layer diffing is
  the supported lane.
- 2026-05-29: negative finding registered. AM4 dump non-determinism
  reproduced directly (2541/12352 bytes differ on a no-op redump),
  confirming the block-type codes cannot be cross-corroborated from the
  dump primitive and the `0xB0` footer block-type map (in the
  `action=0x1F` snapshot) stays single-primitive. Cross-device note: the
  II dump is deterministic, so this non-determinism is AM4-specific.
