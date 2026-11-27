---
name: gen3-editor-typecode-taper
class: coercion
status: matched-singleton
discovered: community PR #24 (FM3 fw 12 hardware), absorbed in 0.10.0
verified_on:
  - fm3-fw12.00
firmware_sensitive: false
golden: scripts/verify-fractal-gen3-family.ts (the "Editor-typecode tapers" block)
relates_to: [display-log10-scaling, editor-cache-section-record-grammar]
consumed_in:
  - packages/fractal-gen3/src/catalog.ts
---

# Gen-3 editor-cache typecode selects the display taper

Each float row in a gen-3 editor definition cache (III / FM3 / FM9) carries a
typecode next to its display window. Two of its classes decide how the panel
maps the wire value, independent of the window the row states:

| typecode | panel | encode/decode |
|---|---|---|
| low byte `0x52` | a 0..10 knob, whatever the stated window | linear over 0..10 |
| class `0x4X` (`tc & 0xF0 == 0x40`) | the stated window on a log taper | log10 over the window |
| anything else | the stated window | linear, unless the param is already listed as log10 |

`0x52` rows state windows that span an exact decade (20..200 for `WAH_Q`, for
example), which is what a 0..10 knob scaled into the editor's internal range
looks like. The `0x4X` rule is applied only when the window is positive and
increasing, since a log taper over zero or a reversed window is undefined.

## Evidence

Decoded on a real FM3 (firmware 12) in community PR #24: wide-range params such
as PEQ frequency (20..2000) read off the panel on a log taper, and `0x52` rows
read 0..10. Measured offline on all three device caches: every param this
codebase already treated as log10 falls inside `0x4X` or `0x52`, so the rule is
a superset of the earlier hand list. It moves about 184 to 221 params per device
from linear to log10. The AM4's screenshot-verified wah resonance (a ×10
`knob_0_10`) matches the `0x52` reading of the III's `WAH_Q`.

Singleton: one device was observed on hardware. The III and FM9 share the cache
grammar and the typecode values, so the rule is applied family-wide. A panel
reading on either of them would make this `matched`.

## Misapplication failure modes

- **DO NOT** read the stated window of a `0x52` row as the panel range. It
  gives a 20..200 "Q" that the panel shows as 0..10.
- **DO NOT** apply log10 to a `0x4X` row whose window includes 0.
- **DO NOT** carry this to the AM4 or II catalogs. They have their own
  per-param scaling metadata ([[display-log10-scaling]]).

## Verification path

`scripts/verify-fractal-gen3-family.ts` checks, for III / FM3 / FM9: PEQ freq1
spans 20..2000 and 200 Hz lands at mid-wire (log), chorus drive is a 0..10
`knob_0_10` with 5 at mid-wire, and reverb low cut stays log10.
