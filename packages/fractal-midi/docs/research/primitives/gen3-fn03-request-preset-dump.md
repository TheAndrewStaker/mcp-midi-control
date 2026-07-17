---
name: gen3-fn03-request-preset-dump
class: envelope
status: partial-N1
discovered: 2026-06-04 (FM9 "receive preset from device" capture, tester Harp)
verified_on:
  - fm9-fw-11.00
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-gen3-fn03-request-preset-dump
relates_to: [preset-name-ascii-triplets, msb-first-14bit-preset-payload, gen3-fn1f-poll-block-bulk-read]
consumed_in: []
---

# gen-3 fn=0x03 REQUEST_PRESET_DUMP (host → device, read/backup trigger)

Ask a gen-3 Fractal (Axe-Fx III 0x10 / FM3 0x11 / FM9 0x12) to send a
STORED preset back as the 0x77/0x78/0x79 dump chain. This is the
device→host backup trigger that pairs with the already-decoded preset-dump
envelope (`fractal-gen3/src/presetDump.ts`).

## Formal definition

```
request  F0 00 01 74 [model] 03 [preset_high7] [preset_low7] 00 [cs] F7   (11 B)
  preset_high7 = (presetNumber >> 7) & 0x7F      # BIG-ENDIAN: high septet first
  preset_low7  = presetNumber & 0x7F
  third payload byte = 0x00 (fixed in every captured request)
  cs = XOR(F0..last payload byte) & 0x7F

reply    F0 00 01 74 [model] 77 [preset#:14b BE] [wordCount:14b LE] [cs] F7   head (13 B)
         F0 00 01 74 [model] 78 [2B chunk-discrim][3072B septet body] [cs] F7  body ×N (3082 B)
         F0 00 01 74 [model] 79 [3B] [cs] F7                                   tail (11 B)
```

The reply chain parses with `parsePresetDump` and the name decodes with
`extractPresetName` ([[preset-name-ascii-triplets]]): `word[1] == 0xAA55`
magic, ASCII name from `word[4]` (2 chars / 16-bit word).

## The one gotcha: the preset number is BIG-ENDIAN

Unlike effect/param ids elsewhere in the gen-3 codec (little-endian
`encode14` = `[lo, hi]`), the preset number here is **big-endian** septet
(`[hi, lo]`), the same MSB-first convention as the II/gen-3 STORE and
GET_TEMPO ([[msb-first-14bit-preset-payload]]). Reading it little-endian
gives nonsense: captured FM9 request `03 03 3c 00` is preset
`(3<<7)|0x3c = 444` (a valid index), not `3|(0x3c<<7) = 7683`.

## Evidence (FM9 fw 11.00)

Seven captured requests decoded to valid indices 49, 129, 197, 273, 274,
355, 444; each paired to an IN `fn=0x77` head echoing the same number.
Reassembled dump for preset 49: `word[1]=0xAA55`, name "4x12 Plexi DARK
AltCab -'25f". Every dump/request frame's XOR-7F checksum validates.
Builder: `buildRequestPresetDump` in `fractal-midi/gen3/axe-fx-iii`. Full
writeup is in the maintainer's private session notes.

## Where this does NOT yet apply

- **Write-back (host → device 0x77/0x78/0x79)** is NOT captured. This entry
  is read/backup only; do not emit a device-bound preset write.
- **Edit-buffer dump** uses a different trigger (`fn=0x43`, no args) and
  envelope (`fn=0x51`/`0x52`); inner layout undecoded.
- N=1 axis (FM9 only). The III/FM3 share the codec but no III/FM3 receive
  capture exists yet; promote to `matched` when a second model confirms.

## Refinement history

- 2026-06-04: discovered + `partial-N1` (FM9 receive capture; builder +
  golden shipped; workflow-verified byte-exact).
