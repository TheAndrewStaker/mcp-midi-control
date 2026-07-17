---
name: ii-compressor-calibration-divergence
class: coercion
status: matched-singleton
discovered: 2026-05-27 (II STUDIO COMP hardware spotcheck)
verified_on:
  - axe-fx-ii-q8.02-ares2.00
firmware_sensitive: true
golden: scripts/primitives-verify.ts#case-ii-compressor-calibration-divergence
relates_to: [display-log10-scaling]
consumed_in:
  - packages/fractal-gen2/src/calibration.ts (II compressor overlay entries)
  - fractal-midi/src/gen2/axe-fx-ii/params.ts (base compressor param definitions)
---

# II compressor calibration range divergence from AM4

The Axe-Fx II STUDIO COMP (compressor block) uses different display
ranges than the AM4 compressor for four core knob params. AM4-shared
calibration entries cannot be blindly ported to II.

## Discovery

Hardware-verified 2026-05-27, Axe-Fx II XL+ Ares 2.00. The fn=0x02
GET response's ASCII tail (raw_response bytes after offset 18) is the
calibration ground truth: the device itself prints the display value.

## Formal definition

For **log10** params on II compressor, the wire-to-display formula is:

```
display = min * (max / min) ^ (wire / 65534)
```

For **linear** params, the formula is:

```
display = min + (max - min) * (wire / 65534)
```

## Divergence table

| Param | AM4 range | AM4 scaling | II range | II scaling | Evidence |
|---|---|---|---|---|---|
| threshold | -60..+20 dB | linear | -80..0 dB | linear | Wire 47512 -> device "-22.0 dB", wire 32767 -> device "-40.0 dB" |
| ratio | 1..20 | log10 | 1..20 | log10 | Wire 30326 -> device "4.000" (midpoint 10^0.4628 * 1 = 4.0) |
| attack | 0.1..100 ms | log10 | 1..100 ms | log10 | Wire 32767 -> device "10.00 ms" (midpoint sqrt(1*100) = 10) |
| release | 2..2000 ms | log10 | 10..1000 ms | log10 | Wire 32767 -> device "100.0 ms" (midpoint sqrt(10*1000) = 100) |

Ratio keeps the same range (1..20) and scaling (log10) on both
devices. Threshold shifts from -60..+20 to -80..0 and stays linear.
Attack and release change their min/max but keep log10 scaling.

## AM4-matching params (hardware-verified same range)

Three additional CPR knobs were probed 2026-05-27 (same session,
same firmware). These params match their AM4 siblings exactly and
use am4-shared calibration without correction:

| Param | AM4 range | AM4 scaling | II range | II scaling | Evidence |
|---|---|---|---|---|---|
| comp | 0..10 | linear | 0..10 | linear | Wire 0->"0.00", wire 32767->"5.00", wire 65534->"10.00"; 5/5 display values match |
| look_ahead | 0..2 ms | linear | 0..2 ms | linear | Wire 0->"0.000 ms", wire 32767->"1.000 ms", wire 65534->"2.000 ms" |
| filter | (no AM4 sibling) | n/a | 10..1000 Hz | log10 | Wire 0->"10.00 Hz", wire 32767->"100.0 Hz", wire 65534->"1000 Hz" |

`filter` (COMP_CONTOUR) has no AM4 equivalent; calibrated as
editor-observed. `comp` (COMP_SUSTAIN) and `look_ahead`
(COMP_DELAYTIME) match AM4's `compression` and `look_ahead_time`
respectively. All three verified with PEDAL COMP 1 type; values
persist across type switches (STUDIO COMP, OPTICAL 1, PEDAL COMP 2).

## Singleton justification

Only one axis (Axe-Fx II) is applicable. The AM4 has its own
compressor calibration (already shipped in `cacheParams.ts`); the III
compressor calibration is not yet probed. This entry captures the
cross-device divergence itself as the primitive, not the per-device
calibration. A second axis would require III compressor hardware data
or a different II firmware revision (Ares 2.x vs Quantum 8.x).

## Misapplication failure modes

- **DO NOT** copy AM4 compressor displayMin/displayMax into II params.ts
  entries verbatim. The ranges differ on threshold, attack, and release.
- **DO NOT** assume all compressor knobs are log10. Threshold is linear
  on both devices.
- **DO NOT** assume compressor calibration transfers to other blocks'
  similarly-named params (e.g. gate/expander threshold may differ again).

## Verification fixtures

The golden case in `scripts/primitives-verify.ts` verifies the log10
and linear formulas against the four hardware-captured wire/display
pairs from the table above.

## Refinement history

- 2026-05-27: Initial entry from hardware spotcheck on II XL+ Ares 2.00.
  Four params captured with fn=0x02 GET, ASCII display values read from
  device response. Ratio range identical to AM4; threshold, attack, and
  release diverge.
- 2026-05-27: Three additional CPR knobs probed (comp, filter, look_ahead).
  comp and look_ahead match AM4 exactly; filter (no AM4 sibling) is
  10..1000 Hz log10. All three calibrated in calibration.ts and
  hardware-verified via probe-cpr-calibration-verify.ts (15/15 pass).
  Consumed in: packages/fractal-gen2/src/calibration.ts.
