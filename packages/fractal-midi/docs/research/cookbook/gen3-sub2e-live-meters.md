---
name: gen3-sub2e-live-meters
class: struct-layout
status: matched
discovered: 2026-06-30 (ForgeFX FM3 offsets + FM9 capture behavioral oracle)
verified_on:
  - fm9-receive-preset-from-device-harp-2026-06-04
  - fm3-community-2026-06-12 (job3, three same-preset block-targeted sub=0x2E reads)
golden: packages/fractal-midi/test/gen3/axe-fx-iii/livemeters.test.ts
relates_to: [gen3-sub2e-grid-region-tail-anchor, gen3-fn01-grid-routing, xor-7f-envelope-checksum]
consumed_in:
  - packages/fractal-midi/src/gen3/axe-fx-iii/liveMeters.ts (parseGen3LiveMeters)
  - packages/fractal-midi/test/gen3/axe-fx-iii/livemeters.test.ts
  - packages/fractal-gen3/src/reader.ts (get_preset live_meters)
  - scripts/verify-gen3-grid-layout.ts (capture cross-validation + complete-varying-set oracle)
---

# Gen-3 live meters in the sub=0x2E frame (CPU + stereo output)

The empty-target `fn=0x01 sub=0x2E` reply — the same ~755 B (FM9) / ~590 B (FM3)
frame that carries the live routing grid (its 7-bit-packed bitstream starts at
byte 361) — ALSO carries live telemetry in **fixed low byte offsets, before the
grid region**. A host that already polls the grid read gets these for free, no
extra round-trip.

## Wire offsets (into the FULL frame WITH leading 0xF0)

Index 0 is `0xF0`, index 5 is the fn byte, index 6 is the sub byte. The meter
bytes are raw 7-bit values (NOT septet-packed):

```
cpu_percent  = 32 + f[37] * 0.5     (7-bit field → 32.0 .. 95.5 %)
output_left  = f[35] / 127          (0..1, momentary peak)
output_right = f[36] / 127          (0..1, momentary peak)
```

## Evidence (two independent axes, kept separate)

The decode was sourced from the MIT-licensed ForgeFX project's FM3 (fw 12.0)
hardware testing, then cross-validated against our own FM9 capture
`fm9-receive-preset-from-device-harp-2026-06-04` (model 0x12) using a
**behavioral oracle**: all 10 empty-target sub=0x2E reads in that capture are of
the SAME static preset, so any byte that VARIES between reads must be live
telemetry, and any CONSTANT byte is grid/preset data.

- **output_left / output_right (f[35] / f[36]) — FM9-behaviorally-confirmed.**
  They swing widely across the 10 reads (32..122 / 7..119), exactly the signature
  of a stereo output meter bouncing with the audio.
- **cpu_percent (f[37]) — FM3(ForgeFX)-sourced, FM9-consistent.** It is CONSTANT
  at 66 (→ 65.0 %) across the 10 reads — consistent with a steady per-preset DSP
  load, but because it is constant the oracle cannot itself prove it is CPU (vs.
  any other static byte). Its identity rests on ForgeFX's FM3 hardware testing
  plus plausibility, not the FM9 capture.

`scripts/verify-gen3-grid-layout.ts` asserts: cpu constant === 65.0, output
meters vary, and the COMPLETE pre-checksum varying-byte set is exactly
`{34, 35, 36}` — documenting byte 34 as an undecoded 0..3 counter (a telemetry
field we see but do not surface) so it reads as "considered," not "missed."

## INPUT meter is NOT decoded (negative result, on purpose)

ForgeFX reads an input meter at `f[588]`, but that offset is **FM3-frame-length-
specific**: the FM3 frame is ~590 B so f[588] sits at its tail, whereas on FM9
the frame is 755 B and index 588 lands INSIDE the static grid bitstream region
(starts byte 361). In our FM9 capture `f[588]` is CONSTANT across all 10 reads —
grid data, not a live input level. Emitting `f[588]/127` as "input" would be a
wrong, frame-coincidental value on every non-FM3 device, so only the three
device-invariant low-offset fields ship. The verify script asserts f[588] stays
constant on FM9 to lock this rationale.

## Applicability (promoted to matched 2026-07-01: two capture axes)

The generalization axis is DEVICE. Two captures we hold now confirm the
low-offset fields on two devices:

- **FM9**: `fm9-receive-preset-from-device-harp-2026-06-04` (the original
  behavioral oracle above).
- **FM3**: `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json`
  job3 — three block-targeted sub=0x2E reads of one static preset. Same
  signature: f[35]/f[36] vary across reads (38/40 → 10/35 → 72/62), f[37]
  CONSTANT at 69 (→ 66.5 %). This also upgrades f[37]: previously
  ForgeFX-sourced only, now behaviorally consistent on a second device AND on
  a second frame shape.

Frame-LENGTH still differs by device (and even varies per-device: FM3 answers
590 AND 606 B — see [[gen3-sub2e-grid-region-tail-anchor]]), which is exactly
why the high-offset input meter does NOT generalize while the low-offset
CPU/output fields do. Block-targeted frames carry the same meters (the earlier
refusal's "bytes 35-37 are not meters there" premise was never established;
the FM3 frames falsify it).

## Refinement history

- 2026-07-01 — promoted `matched-singleton` → `matched`: FM3 capture axis
  (fm3-community-2026-06-12 job3) confirms the meters signature; block-target
  refusal removed from `parseGen3LiveMeters` (parity with the grid parser);
  block-targeted meters golden added to `livemeters.test.ts`.
- 2026-06-30 — registered `matched-singleton`. FM9 capture behavioral-oracle
  cross-validation of ForgeFX FM3 offsets; input meter ruled out as
  frame-length-specific. Tempo/scene current-state reads (fn=0x0C / fn=0x14)
  are a separate primitive (documented in the III SYSEX-MAP), not here.
