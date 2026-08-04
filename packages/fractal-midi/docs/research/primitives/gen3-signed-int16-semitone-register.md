---
name: gen3-signed-int16-semitone-register
class: value-encoding
status: matched
discovered: 2026-07-21 (community full-catalog SET→GET hardware roundtrip, 2026-06-18, GitHub issue #6)
verified_on:
  - fm9-fw11.0-hardware-roundtrip
  - axefx3-fw25.04-hardware-roundtrip
golden: scripts/verify-fractal-gen3-family.ts#C13
relates_to: [gen3-fn01-set-float32-ordinal]
consumed_in:
  - packages/fractal-gen3/src/catalog.ts (SIGNED_RAW_SEMITONE_PARAMS, makeSignedRawSemitoneDecode)
  - packages/fractal-midi/src/gen3/fm9/params.ts
  - packages/fractal-midi/src/gen3/fm3/params.ts
  - packages/fractal-midi/src/gen3/axe-fx-iii/params.ts
---

# Gen-3 signed-int16 semitone register (asymmetric READ, standard WRITE)

Some gen-3 continuous params are backed by a device register that stores a
raw **signed 16-bit two's-complement integer** in native units (a semitone
count), not the standard normalized 0..65534-across-`[displayMin,displayMax]`
field every other calibrated continuous param uses. The asymmetry is the
interesting part: the **write** side works exactly like any other continuous
param (normalized float32 SET, `[[gen3-fn01-set-float32-ordinal]]`'s sibling
form for continuous rather than discrete); only the **read** side (bulk poll
`fn=0x1F`, and presumably the `0x74/0x75` broadcast) returns the raw register
value, un-renormalized.

## Formal definition

For a param in the affected set, with `lo`/`hi` = its calibrated
`displayMin`/`displayMax` (always `-24`/`24`, one semitone granularity, for
every instance found so far):

```
encode(display) = round((display - lo) / (hi - lo) * 65534)   // UNCHANGED, standard normalized linear
decode(wire)     = clamp(wire > 32767 ? wire - 65536 : wire, lo, hi)   // raw signed int16, NOT normalized
```

`encode` is the same `displayToWire` every other linear-calibrated param
uses (`fractal-midi/shared/displayScale.ts`) — do not touch it. Only `decode`
differs, and only for the params in this set.

## Evidence

A real hardware SET→GET roundtrip (FM9 fw 11.0 + Axe-Fx III fw 25.04, macOS,
2026-06-18, GitHub issue #6) swept 5 wire values (0/25/50/75/100% of the
range, i.e. the standard normalized SET sweep) and read back:

| sentWire (normalized SET) | gotWire (raw read) | int16(gotWire) |
|---|---|---|
| 0 | 65512 | -24 |
| 16384 | 65525 | -11 |
| 32767 | 0 | 0 |
| 49151 | 12 | 12 |
| 65534 | 24 | 24 |

`int16(gotWire)` reproduces the SENT display value exactly (0 → -24, the
`displayMin` endpoint; 65534 → +24, `displayMax`) — proof this is a read-side
decode mismatch, not a write/wire bug: `gotWire=65512` is self-evidently NOT
"-24 renormalized to 0..65534" (that would decode to +24 under the standard
formula, the wrong sign), it IS -24 as a raw two's-complement int16. Every
intermediate sweep point round-trips the same way (16384→-11, 49151→12 — off
by one step from the "exact" -12/+12 due to rounding at the encode step, not
a decode error).

This pattern was IDENTICAL, byte-for-byte, across every one of 32 tested
params on FM9 and 32 on Axe-Fx III (two distinct device/firmware axis
points): `PITCH_SHIFT1-4`, `PITCH_STEP1-16`, `PLEX_SHIFT1-8`, `SYNTH_SHIFT1-3`,
`REVERB_SHIFT1-2` — every "pitch/step shift" style param across every block
family that has one. FM3 shares the same firmware symbols (one gen-3 effect
codec across the family) and the fix was applied there too, community-beta
(no FM3 hardware roundtrip exists yet for this specific shape).

## Where it does NOT apply

- Every OTHER gen-3 continuous param: standard normalized linear/log10
  decode (`fractal-midi/shared/displayScale.ts`), confirmed by the same
  2026-06-18 roundtrip (this was the ~89% pass rate baseline the 32/32
  outliers stood out against).
- Gen-3 DISCRETE (enum/type-selector) params: a completely different wire
  form (`float32(ordinal)`, sub `09 00`), see
  [[gen3-fn01-set-float32-ordinal]]. Not related to this primitive.
- Not (yet) observed outside the "shift"-family params above. Before
  applying this decode to a new param, confirm the same sign-flip pattern
  against a real capture — a param merely having a bipolar range (e.g.
  `MIXER_PAN1`, `-100..100`) is NOT sufficient evidence; those decode
  correctly under the standard normalized formula (confirmed: not in the
  roundtrip's failure list).

## Verification path

`scripts/verify-fractal-gen3-family.ts` section C13 asserts, for one param
per affected family on both FM9 and Axe-Fx III: `decode(65512) === -24`,
`decode(65525) === -11`, `decode(0) === 0`, `decode(12) === 12`,
`decode(24) === 24` (the exact captured wire bytes above), plus
`encode(-24) === 0` / `encode(24) === 65534` (confirming the write side is
untouched). `scripts/verify-fractal-gen3-display-units.ts` and
`scripts/verify-display-first-fractal.ts` both carve this param set out of
their generic "decode is the inverse of the normalized encode" invariant
(which is correct for every other calibrated param, but would wrongly flag
this set as broken) via the exported `SIGNED_RAW_SEMITONE_PARAMS` set and give
it its own dedicated endpoint check instead.

## Refinement history

- 2026-07-21: discovered by re-mining a community roundtrip capture
  (2026-06-18, GitHub issue #6) that had already driven the FM9/III
  enum-vs-continuous kind-classification fix but whose "bipolar semitone"
  failure category (32 FM9 + 32 III params) was never root-caused. Fixed in
  `packages/fractal-gen3/src/catalog.ts` (decode-only override, `encode`
  unchanged) plus a `displayMin`/`displayMax` backfill in FM9/FM3/III's
  `params.ts` for the params that had no calibrated range at all yet
  (`REVERB_SHIFT1/2` already had one and were already exhibiting the bug in
  production before this fix). Matched status: 2 distinct device axis points
  (FM9 fw 11.0, Axe-Fx III fw 25.04) from one capture session.
