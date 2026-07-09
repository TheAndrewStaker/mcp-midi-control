---
name: hydra-envelope-time-table
class: coercion
status: matched-singleton
discovered:  (27 envelope-time pairs hardware-verified )
verified_on:
  - hydrasynth-explorer-v2.2.0
firmware_sensitive: false
golden: scripts/hydrasynth/verify-env-time-display.ts (full 27-pair hardware round-trip)
relates_to: [hydra-nrpn-14bit-with-fxaware-resolution]
consumed_in:
  - packages/hydrasynth/src/nrpnDisplay.ts
  - scripts/hydrasynth/verify-env-time-display.ts
  - fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md
---

# Hydrasynth envelope-time lookup table

Hydrasynth's envelope-time parameters (attack / decay / release per
amp-env, filter-env, mod-env) use a non-linear wire-to-ms mapping that
is best represented as a lookup table, not a closed-form formula. 27
wire-to-ms pairs hardware-verified on Explorer firmware v2.2.0.

Distinct from Fractal's coercion primitives:
- Not Q16 fixed-point ([[display-q16-fixedpoint]]).
- Not log10 scaling ([[display-log10-scaling]]).

The ms response is non-linear AND non-logarithmic at the boundaries
(near 0 ms and near maximum-time), which is why a table beats either
formula.

## Formal definition

The table lives at `packages/hydrasynth/src/nrpnDisplay.ts` (or its
referenced data file). For each `(wire_value, display_ms)` pair the
table interpolates linearly between adjacent entries:

```ts
function wireToMs(wire: number): number {
  // Binary-search for the bracketing pair
  const idx = findBracketIndex(ENV_TIME_TABLE, wire);
  if (idx === 0) return ENV_TIME_TABLE[0].ms;
  if (idx === ENV_TIME_TABLE.length) {
    return ENV_TIME_TABLE[ENV_TIME_TABLE.length - 1].ms;
  }
  const lo = ENV_TIME_TABLE[idx - 1];
  const hi = ENV_TIME_TABLE[idx];
  const t = (wire - lo.wire) / (hi.wire - lo.wire);
  return lo.ms + t * (hi.ms - lo.ms);
}
```

Inverse `msToWire(ms)` performs the analogous bracket search on the ms
axis and interpolates.

The 27 verified pairs span the full envelope-time range (sub-1ms
attack at one end, multi-second release at the other). Pairs were
captured by setting the wire value via NRPN, then reading the device's
front-panel display.

## Where it's used

Every Hydra display-formatting path for envelope-time NRPNs:
- amp.env.{attack, decay, release}
- filter.env.{attack, decay, release}
- mod.env.{attack, decay, release}

Implementation: `packages/hydrasynth/src/nrpnDisplay.ts`. Goldens:
`scripts/hydrasynth/verify-env-time-display.ts` runs all 27 pairs
through `wireToMs` and `msToWire` for byte-exact round-trip.

## Misapplication failure modes

- **DO NOT** fit a closed-form formula (linear, log10, exponential).
  The 27 captured pairs do not fit any single curve at acceptable
  precision; the curve transitions between regimes at multiple wire
  values. A table is the right shape.
- **DO NOT** use this table for non-envelope-time params. LFO rates,
  filter cutoffs, oscillator pitches all have their own coercion
  paths; the table is envelope-time-specific.
- **DO NOT** extrapolate beyond the table's domain. Out-of-range wire
  values clamp to the nearest table entry's ms (per the implementation
  above), not extrapolated linearly.

## Where it does NOT apply

- Fractal Q16 fixed-point params use [[display-q16-fixedpoint]].
- Fractal log10-scaled params use [[display-log10-scaling]].
- Hydra LFO-rate / filter-cutoff / pitch params have their own per-param
  coercion specs in the NRPN catalog; see
  [[hydra-nrpn-14bit-with-fxaware-resolution]].

## Verification path

`scripts/cookbook-verify.ts#case-hydra-envelope-time-table` spot-checks
that `wireToMs` is the byte-exact inverse of `msToWire` on a handful
of representative pairs. Full 27-pair round-trip golden ships at
`scripts/hydrasynth/verify-env-time-display.ts`.

The 27 hardware pairs are the second-axis fixture set that supports
`matched-singleton` status: each pair is an independent measurement
on the device, supplying corroborating evidence for the table's
correctness at distinct wire values.

## Refinement history

- Initial decode: 27 wire-to-ms pairs captured on Hydrasynth
  Explorer v2.2.0. Initial implementation in `nrpnDisplay.ts`; 39
  goldens added to `verify-nrpn-display.ts` (subset cover env-time).
- 2026-05-22 (Rosetta-stone cookbook audit): promoted to cookbook
  primitive. The 27 pairs are the highest-density Hydra decode-work
  fixture set; the table beats a formula at every regime transition,
  which makes it a distinct primitive from
  [[display-q16-fixedpoint]] and [[display-log10-scaling]].
