---
name: gen3-sub2e-grid-region-tail-anchor
class: struct-layout
status: matched
discovered: 2026-07-01 (offline mine of the 2026-06-12 FM3 field-test capture)
verified_on:
  - fm9-receive-preset-from-device-harp-2026-06-04
  - fm3-community-2026-06-12 (job3, three block-targeted sub=0x2E replies, 590/590/606 B)
golden: packages/fractal-midi/test/gen3/axe-fx-iii/gridlayout.test.ts
relates_to: [gen3-sub2e-live-meters, gen3-fn01-grid-routing, gen3-fn01-grid-set-position-insert, xor-7f-envelope-checksum]
consumed_in:
  - packages/fractal-midi/src/gen3/axe-fx-iii/gridLayout.ts (parseGen3GridLayout)
  - packages/fractal-gen3/src/reader.ts (get_preset live_grid)
  - scripts/verify-gen3-grid-layout.ts (FM9 + FM3 capture cross-validation)
---

# Gen-3 sub=0x2E grid region is TAIL-ANCHORED (and per-device sized)

The live routing grid inside a `fn=0x01 sub=0x2E` status reply is NOT at a
fixed byte offset. It is the **last `ceil((46 + cols·rows·32) / 7)` bytes
before the trailing `[checksum, F7]` pair**, where the geometry is per-device:

```
III / FM9 (0x10 / 0x12):  6 rows × 14 cols  → region = 391 B, col stride 192 bits
FM3        (0x11):        4 rows × 12 cols  → region = 226 B, col stride 128 bits
cell_start_bit = 46 + col·(rows·32) + row·32   (MSB-first within each 7-bit byte)
```

On the canonical 755-byte FM9 frame the anchor lands at mido byte 361 — which
is why the earlier fixed-361 decode worked there. The FM3 answers the same
query with BOTH 590-byte (→ 361) and 606-byte (→ 377) frames; only the tail
anchor decodes all of them with one rule. The 16 extra bytes in the 606-byte
variant sit inside an all-zero span before the region (position within the run
indistinguishable by construction).

## Evidence

- **FM9 axis**: `fm9-receive-preset-from-device-harp-2026-06-04` — 10
  empty-target replies, coherent grid, every effect ID resolves in
  `blockTypes.ts` (the original cross-oracle; see SYSEX-MAP sub=0x2E).
- **FM3 axis**: `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json`
  job3 — three checksum-valid block-targeted replies. Decoded grid on ALL
  three (including the 606 B length variant) is byte-exactly the same
  session's own `fn=0x13` status dump: Input1(37)@r1c0 → Amp1(58)@r1c1
  (cableIn 0x04) → Output1(42)@r1c2 (cableIn 0x04). Device-oracled, offline.
- Frame-length arithmetic is exact on both devices:
  `590 = 1 + 361 + 226 + 2`, `755 = 1 + 361 + 391 + 2`.

## Block-targeted frames carry the SAME layout

The FM3 frames above are block-targeted (effectId/paramId populated in the
target region) and carry the full grid + live meters + septet-packed preset
name. The earlier "block-targeted 2E = preset-name frame, NOT a grid" verdict
(FM9, 2026-06-19/20) was **vacuously true** — that session's scratch preset
had an all-zero grid region. Both `parseGen3GridLayout` and
`parseGen3LiveMeters` accept both target shapes.

## Misapplication failure modes

- **Do not hardcode offset 361.** It is an artifact of the shared ~361-byte
  header plus the canonical frame lengths; a length-variant frame (FM3 606 B)
  shifts the region. Anchor from the tail.
- **Do not reuse the 6×14 geometry on the FM3.** A 14-col/192-stride read of a
  590-byte FM3 frame does not fit (needs 391 region bytes, has 226) — the
  pre-2026-07-01 decoder threw "frame too short" on every real FM3 frame.
- **Do not refuse block-targeted frames as "not a grid".** That reading came
  from an empty preset. Conversely, an all-zero grid region on an EMPTY preset
  is correct data, not a parse failure.
- The FM3-only field at f[76..110] (zero on FM9) is undecoded — do not assign
  it meaning.

## Symptoms / grep terms

- "FM3 grid region offset unconfirmed" / "fm3 4-row region"
- "parseGen3GridLayout frame too short" on a real FM3 frame
- "block-targeted sub=0x2E" / "sub=0x2e overloaded"
- "grid offset 361" / "tail anchor"

## Refinement history

- 2026-07-01 — registered `matched` (FM9 + FM3 capture axes). Supersedes the
  fixed-offset-361 note in the 2026-06-17 grid-read shipping and the
  block-targeted refusal added 2026-06-20.
