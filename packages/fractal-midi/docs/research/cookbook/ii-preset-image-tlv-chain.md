---
name: ii-preset-image-tlv-chain
class: struct-layout
status: matched
discovered: 2026-07-02
verified_on:
  - axe-fx-ii-q8.02 (384 factory presets, banks A/B/C file corpus)
  - axe-fx-ii-xl-plus-q8.02-live (bk070 + hw132 hardware dumps; BK-070 one-variable anchors land exactly)
firmware_sensitive: true
golden: scripts/verify-ii-preset-image-tlv.ts
relates_to: [septet-21bit-byte2-mask-preservation, xor-fold-hash, preset-name-ascii-triplets, block-record-stride-8, parambase-plus-paramid, alphabetical-name-cascade-block-ordering, scene-state-ushort, wire-id-pairs-per-placed-block]
consumed_in:
  - packages/fractal-gen2/src/presetImageTlv.ts
---

# II preset image = self-describing TLV chain

The de-framed Axe-Fx II 4096-word preset image (64 × `fn 0x78` chunks,
64 native ushorts each per [[septet-21bit-byte2-mask-preservation]])
is a self-describing TLV structure. No static width table and no
calibration probe is needed to locate any block's parameters in any
dump; the dump in hand describes its own layout.

## Formal definition

```
word 0        format tag 2049 (388/388)
words 2..33   preset name, 1 ASCII char per word, 0-terminated
              (word layer of [[preset-name-ascii-triplets]])
words 36..129 the record table ([[block-record-stride-8]]): GRID /
              signal-chain order metadata, NOT the serialization index
word 130..    TLV chain: repeated [wire_id, payload_len, payload...];
              wire_id == 0 terminates. paramBase of a TLV at word i is
              i + 2.
```

Chain contents, in order (388/388):

1. **Modifier records**: wire_id = modifier slot 1..20, payload_len
   always 15, always before the first block TLV. 15-word payload
   layout NOT decoded; read-only, preserve verbatim.
2. **Effect blocks**, ALPHABETICAL by the AxeEdit canonical DISPLAY
   name with spaces/punctuation ignored: "Tremolo/Panner" sorts under
   T (not under the internal PanTrem label), "Multiband Compressor"
   precedes "Multi Delay". Multi-instance blocks are adjacent.
3. **System tail**: an ordered subsequence of
   `[170 Tone Match, 139 Noisegate, 140 Output, 142 Feedback Send,
   143 Feedback Return, 141 Controllers]`: 139/140/141 always
   present; Feedback Send/Return serialize BETWEEN Output and
   Controllers; Tone Match before Noisegate.

Per-block param addressing (X/Y-capable blocks have an even
payload_len holding the X half then the Y half):

```
channel-X param p → word[paramBase + p]
channel-Y param p → word[paramBase + payload_len/2 + p]
```

Every hardware-measured BK-070 width equals `payload_len + 2` and
every measured X→Y offset equals `payload_len / 2` (Amp 236/2=118,
Cab 78/2=39, Compressor 40/2=20, Delay 140/2=70, Drive 42/2=21,
Reverb 90/2=45).

Tone-match presets (wire_id 170 in the chain; 4/388) additionally
carry a bulk region at fixed word 2048, after the chain terminator.
All other post-terminator words are zero (388/388).

## Evidence (two axes)

- **Factory file corpus**: 384 presets (Q8.02 XL+ banks A/B/C).
  Chain walks clean, ordering grammar, system tail, name equality vs
  the triplet decode, amp-type ordinal sanity: all 388/388 (incl.
  the 4 hardware dumps).
- **Live hardware (BK-070 anchors)**: on Test Crunch
  (`samples/captured/bk070-loop-amp-bass-2-baseline.syx`, Amp TLV
  `[106, 236]` at word 130 → paramBase 132), the two one-variable
  hardware diffs land at EXACTLY the predicted words: amp.bass
  (paramId 2) channel-Y at word 252 = 132+118+2; amp.master_volume
  (paramId 5) channel-Y at word 255 = 132+118+5. '59 Bassguy amp-type
  ordinal 0 sits at word 149 on factory A000 (one modifier record
  precedes the Amp TLV there).

## Misapplication failure modes

- **NEVER use the record table (words 36..129) to enumerate blocks.**
  It is grid-order metadata, capped at 12 entries, and carries
  ids >= 200 (unplaced/shunt placeholders) that are never serialized.
  The layout-order hypothesis is REFUTED: Test Crunch table order is
  Comp,Drive,Amp,Cab,Delay,Reverb; the measured serialization is
  alphabetical Amp@132..Reverb@678. Enumerate blocks by walking the
  TLV chain.
- **NEVER trust a static width table across firmware.** payload_len
  is per-dump self-described and DRIFTS: factory Q8.02 bank files
  carry Amp payload 234; live Q8.02 hardware dumps carry 236. The
  `blockBinaryLayout.ts` widths are firmware snapshots (provenance,
  not a lookup path).
- **Do NOT write flag-looking payload words.** Per-block scene/bypass/
  X-Y state words inside the payloads are UNMAPPED at the word level
  (only [[scene-state-ushort]]'s N=1 coordinates exist). Read-modify-
  write must only touch words addressed via paramBase + paramId.
- **On writeback, preserve** the tone-match bulk region (word 2048+)
  verbatim, and each triplet's `byte2 & 0x7c` reserved bits
  ([[septet-21bit-byte2-mask-preservation]], NACK 0x13 otherwise),
  and recompute the footer XOR-fold ([[xor-fold-hash]]).
- **Do not sort by the internal layout labels** (`AxeFxIIBlockName`:
  PanTrem, MultiDelay, EffectsLoop...). The device's sort key is the
  AxeEdit display name, squashed (lowercase, alphanumerics only).

## Where it does NOT apply

- AM4: its dump body is the gen-3 preset container
  ([[am4-gen3-preset-container]]), not this word grid.
- Axe-Fx III / gen-3: .syx body is Huffman-coded
  (`presetHuffman.ts`); different container entirely.
- The `fn=0x1F` live read ([[ii-fn1f-atomic-read]]): that reply is a
  different (broadcast-triple) shape, not this image.

## Verification path

`scripts/verify-ii-preset-image-tlv.ts` (wired into root
`test:codec`): synthetic-image goldens + strict-walker throw cases
always run; the corpus sweep (chain-walk, ordering grammar, tail
grammar, modifier prefix rule, name equality, amp ordinal <= 265,
post-terminator zeros, BK-070 diff-pair predictions) is capture-gated
on `samples/factory/` + `samples/captured/`.

## Refinement history

- 2026-07-02: decoded + confirmed 388/388 (384 factory + 4 hardware
  dumps); BK-070 one-variable anchors land exactly; shipped
  `packages/fractal-gen2/src/presetImageTlv.ts`
  (deframe/parse/paramWord) + the sweep golden. Refutes the
  record-table-as-layout hypothesis; supersedes static-width paramBase
  prediction ([[parambase-plus-paramid]] promoted accordingly).
  OPEN: modifier 15-word layout; per-block scene/bypass/X-Y state
  words; ids >= 200 semantics; MCP-facing atomic apply (gated on the
  II screech-class safety review).
