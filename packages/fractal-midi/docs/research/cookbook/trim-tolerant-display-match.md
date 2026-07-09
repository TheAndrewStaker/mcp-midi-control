---
name: trim-tolerant-display-match
class: coercion
status: matched
discovered:  (probe-axefx2-enum-dump refinement)
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: scripts/extract-axe-fx-ii-params.ts display normalization + the probe diff loop)
relates_to: [fn28-enum-dump]
consumed_in:
  - scripts/_research/probe-axefx2-enum-dump.ts (diff loop)
  - scripts/extract-axe-fx-ii-params.ts (display normalization)
---

# Trim-tolerant display match

Axe-Fx II firmware pads enum-value labels with trailing whitespace for
fixed-width front-panel alignment. Catalog labels store the trimmed
form. Comparison must use `trimEnd()` on the device side before
equality.

## Formal definition

```
matches(deviceLabel, catalogLabel) = deviceLabel.trimEnd() === catalogLabel
```

Per  findings, 9 enum entries that initially appeared as
"mismatches" were trailing-whitespace padding only:
- `delay.tempo` idx 0: device emits `"NONE "`, catalog stores `"NONE"`
- `input.input_z` idx 0: device emits `"AUTO: "`, catalog stores `"AUTO"`
- `pitch.key` chromatic notes (7 entries): device emits `"A "`, `"B "`,
  ..., `"G "`; catalog stores `"A"`, `"B"`, ..., `"G"`.

After applying trimEnd-tolerant comparison, mismatch count went 9 → 0.

## Where it's used

- `probe-axefx2-enum-dump.ts` diff loop
- `extract-axe-fx-ii-params.ts` generator normalization
- Any wire-vs-catalog comparison for II enum labels

## Applicability

Use whenever comparing a device-emitted label to a stored catalog
label. The display-first convention (CLAUDE.md) requires the catalog
to carry the trimmed form for clean front-panel parity.

The two verification fixtures are the same device family (Axe-Fx II)
across two firmware majors, q8.02 and q9.04. Firmware revision is the
generalization axis claimed here: the trailing-whitespace padding
behavior was confirmed identical on both firmware majors, so a firmware
bump does not change the trim-tolerant comparison rule. No second device
family is claimed. Axe-Fx III and AM4 enum-label padding behavior is
unverified and is a transfer candidate.

## Misapplication failure modes

- **DO NOT** use bilateral `trim()` — leading whitespace is significant
  in some device labels (rare, but observed). Only trim trailing.
- **DO NOT** trim the catalog side — the device-side trim brings the
  device to catalog parity, not vice versa.

## Verification path

No inline fixture ships (golden is STUB). The de-facto surface is the
trim-tolerant comparison in `scripts/extract-axe-fx-ii-params.ts` and
the probe diff loop; a fixture would cover the 9 known padding cases
plus negative cases (where a leading-space label correctly mismatches).

## Refinement history

- : padding-vs-mismatch distinction surfaced during Session
  114 probe re-run. Comparison loop changed from byte-exact to
  trim-tolerant. Findings file headline renamed "Byte-exact matches" →
  "Display-equal matches (trim-tolerant)" so the semantics are visible.
