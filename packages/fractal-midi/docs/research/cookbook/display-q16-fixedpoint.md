---
name: display-q16-fixedpoint
class: coercion
status: wip
discovered:
verified_on:
  - axe-fx-ii-q8.02 (partial — sanity probe queued)
firmware_sensitive: false
golden: scripts/verify-msg.ts (AM4 continuous-param byte goldens exercise the Q16 encode byte-exactly; decode sanity probe still queued)
relates_to: [display-log10-scaling]
consumed_in:
  - fractal-midi/src/am4/setParam.ts (the `u32 as Q16` continuous-float coercion)
---

# Q16 fixed-point display ↔ wire coercion

Many Fractal parameters use Q16 fixed-point encoding: `display = wire /
65536`. The wire value is a 32-bit unsigned integer; the display value
is the wire value divided by 2^16.

## Formal definition

```
display = wireU32 / 65536.0
wireU32 = round(displayFloat * 65536)
```

## Status: wip

A sanity probe is queued to verify the Q16 denominator across multiple
knob positions. Until that probe runs, the formula is robust for the
tested parameters (`get_block_layout`, `get_param`, `get_params` test
set) but not generalized.

## Where it's used

Wire-to-display conversion for Q16-encoded parameters. Many "0..10
knob" displays use this encoding under the hood; the conversion is at
the tool boundary via `resolveValue` / `resolveEnumValue`.

## Misapplication failure modes

- **DO NOT** use Q16 for parameters marked `scaling: 'log10'` — those
  use [[display-log10-scaling]].
- **DO NOT** assume integer wire values — Q16 wire is u32, not u16.

## Verification path

`scripts/verify-msg.ts` AM4 continuous-param byte goldens (built from
captured frames) exercise the Q16 encode path byte-exactly. The queued
sanity probe will add the multi-knob-position fixtures needed to
promote to `matched`.

## Refinement history

- Q16 denominator decoded for `get_param` / `get_params` response payloads.
- Sanity probe queued as confirmation pass; not yet run.
