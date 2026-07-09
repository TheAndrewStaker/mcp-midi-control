---
name: vp4-fn01-swapped-septet-float32
class: value-encoding
status: matched
discovered: samples/captured/decoded/vp4-403-v2/FINDINGS.md
verified_on:
  - vp4-fw4.03-capture-2026-06-08
  - vp4-fw4.03-capture-2026-06-09
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-vp4-fn01-swapped-septet-float32
relates_to: [septet-14bit, xor-7f-envelope-checksum, gen3-fn01-set-float32-ordinal]
consumed_in:
  - packages/fractal-midi/src/gen3/vp4/setParam.ts (encodeVp4Float / decodeVp4Float)
---

# VP4 fn=0x01 value field: swapped-septet float32

The VP4 (model 0x14) carries its fn=0x01 SET value as an IEEE-754 **float32**,
5-septet little-endian, but with the **top two septets (s3, s4) SWAPPED on the
wire**: the value bytes are emitted as `[s0, s1, s2, s4, s3]`.

## Formal definition

```
u32   = float32_bits(value)
s0..4 = [ u&0x7f, (u>>7)&0x7f, (u>>14)&0x7f, (u>>21)&0x7f, (u>>28)&0x7f ]
wire  = [ s0, s1, s2, s4, s3 ]      // d18 = s4 (high), d19 = s3
```

Decode reverses it: read wire `[w0,w1,w2,w3,w4]`, reassemble with the swap undone
(`u = w0 | w1<<7 | w2<<14 | w4<<21 | w3<<28`), reinterpret as float32.

The non-swapped order decodes to ~1e-36 garbage, which is how the swap was found.

## Evidence

From the 2026-06-09 edit-session capture (Kevin Iudicello, fw 4.03), the Reverb
block-bypass SET value `00 00 10 03 78` un-swaps to `00 00 10 78 03` =
`0x3F040000` = float32 **0.515625**. Continuous params carry a normalized [0,1]
float (the Delay-feedback drag decodes to a [0,1] sweep). Commands (SAVE) carry a
small raw int in the low septet, not a float.

Full SET frame: `F0 00 01 74 14 01 [eid:14b LE] [pid:14b LE] [tc] 00 00 00 04 00 [val:5] cks F7`.

## Caveats

- Editor *drag* frames carry noise in the top septet (bits beyond 32) the device
  masks; clean `float32` values round-trip exactly, drag frames do not.
- Per-param **display calibration** (normalized↔%/ms/Hz) is NOT decoded, only the
  raw normalized [0,1] value field. See `docs/devices/vp4/SYSEX-MAP.md`.
