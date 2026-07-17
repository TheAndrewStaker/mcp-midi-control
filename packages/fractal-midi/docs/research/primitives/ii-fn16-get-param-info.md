---
name: ii-fn16-get-param-info
class: struct-layout
status: partial-N1
verified_on:
  - axe-fx-ii-q8.02
golden: scripts/primitives-verify.ts#case-ii-fn16-get-param-info
relates_to: [septet-14bit, display-q16-fixedpoint, ii-axeedit-opcode-table]
---

# Axe-Fx II fn 0x16 GET_PARAM_INFO per-parameter descriptor

fn 0x16 SYSEX_GET_PARAM_INFO returns a per-parameter metadata descriptor
(companion to fn 0x02, which returns the current value). The response is
a 33-byte SysEx frame: a 6-byte header `F0 00 01 74 07 16`, a 25-byte
payload, then `[checksum] F7`.

The 25-byte payload is **5 fixed groups of 5 wire bytes**. Each group
packs one 32-bit native value as plain little-endian septets:

```
v   = b0 | (b1<<7) | (b2<<14) | (b3<<21) | (b4<<28)   (low 32 bits used)
b_i = (v >> 7*i) & 0x7F
```

This is the 5-septet extension of [[septet-14bit]] (shift table 0, 7,
14, 21, 28). It is NOT the AM4 sliding-window float packer: 265.0
encodes plain-LE as `00 00 12 1c 04` (`0x43848000`), whereas the AM4
packer would emit `00 20 10 44 18`.

## Group roles

| Group | Offset | Type | Role |
|---|---|---|---|
| G0 | 0..4 | int32 | **default** value (NOT the current value; the live value comes from fn 0x02) |
| G1 | 5..9 | float32 | min |
| G2 | 10..14 | float32 | for enums: value count; for continuous params: one range/scale extent |
| G3 | 15..19 | float32 | the other range/scale extent (frequently a `1.0` sentinel) |
| G4 | 20..24 | float32 | step / resolution (0 for enums) |

The earlier reading (G0 current, G2/G3 max-or-default, G4 reserved) was
corrected by the hardware sweep below. G0 is the default, G4 is a step,
and there is no "default" field inside G2/G3.

## What is matched

The packing model (5 groups of 5 plain-LE septets, 32-bit each) and the
int/float typing of each group. Byte-exact round-trip on both captured
25-byte payloads, and both response-frame checksums verified:

- Enum paramId=0 (amp.effect_type), checksum `0x71`:
  G0=16 (default amp-type index), G1 min=0.0, G2 count=265.0, G3=1.0,
  G4 step=0.
- Knob paramId=10 (amp.bright_cap, an internal DSP capacitor scalar,
  NOT a 0..10 display knob), checksum `0x59`:
  G0=2113 (default), G1=1e-5, G2=0.01, G3=1e6, G4 step=0.

Both captures are AMP 1 (effectId 106). The float fields are
firmware-internal DSP units for non-display-mapped params; for display
calibration the wire 0..65534 endpoints are still obtained separately.

### Hardware sweep (Q8.02, AMP effectId 106, paramIds 0..24)

A live sweep plus a fn 0x02 current-value cross-check pinned the group
roles:

- **G0 = default, not current.** All eight 0..10 display knobs
  (paramIds 1, 2, 3, 4, 5, 16, 19, 20) return G0 = 50 (the 5.0 default
  in tenths), while fn 0x02 returns their differing live values (bass
  current `4.55`, amp.effect_type current `BRIT 800`). If G0 were the
  current value the eight identical-default knobs would not all read 50.
- **G1 = min.** 0.0 for 0..10 knobs, `-80` for a dB level param, `400`
  for a Hz param, `200`/`10` for ms-style ranges.
- **G4 = step / resolution.** `0.001` (float) for the 0..10 knobs,
  `0` for enums. The prior "reserved=0" reading held only because both
  earlier samples happened to read 0.
- **Enums carry the value count in G2**, with G3 = `1.0`:
  amp.effect_type = 265, tone_stack (paramId 34) = 109, paramId 14 = 3,
  paramId 15 = 2, paramId 18 = 12.
- **Display max is the larger meaningful extent** of G2/G3: a 0..10
  knob reads max 10.0 in G3 (G2 = `1.0` sentinel); a `-80..+20` dB param
  reads max +20 in G2 (G3 = `1.0` sentinel).

## What is partial-N1 (path to matched)

- ~~**G2/G3 internal-vs-display split for continuous params.**~~ RESOLVED
  2026-06-10 by a full knob audit across the user-facing blocks
  (`probe-ii-fn16-catalog-audit`): **G1/G2 are the param's INTERNAL/SI
  extent, not the display range.** Knobs read 0..1 (display = internal x
  scale, e.g. amp.bass 0..1 -> 0..10), bipolar pan/balance read -1..1
  (-> -100..100), time reads SECONDS (delay.time 0.001..8 -> 1..8000 ms),
  and dB levels read display-equal because dB IS the internal unit
  (amp.level -80..20 = display, the anchor that proved the decode). So
  fn 0x16 gives a device-true range AFTER applying the param's unit scale;
  it confirmed the II compressor-level divergence (internal/display dB
  -20..20, not the convention's -80..20) and showed most catalog DISPLAY
  ranges are right (the apparent "divergences" are just internal x scale).
  A few non-clean-scaling reads (amp.low_res device 0..24 vs catalog 0..10,
  amp.cathode_resist 0..4, cab.room_size 0.1..1) are genuine candidates for
  the catalog-range review. The enum case is settled (count in G2, G3 = 1.0).
- ~~**fn 0x28 full enumeration is tooling-blocked.**~~ RESOLVED
  2026-06-09: the receive path now reassembles node-midi's 2048-byte
  WinMM fragments (`createSysExAssembler`), and the post-fix fn 0x28
  re-run captured the full amp table in one untruncated frame: 266
  labels (ordinals 0..265), 266/266 display-equal vs the shipped
  catalog. The G2 "265" reading was the max ordinal, not the count.
  See [[fn28-enum-dump]] and [[editor-cache-section-record-grammar]]
  (the cache roster independently confirmed the 7 once-missing names).

## Where it does NOT apply

- AM4 uses fn 0x01 with a sliding-window float packer, not this
  5-group plain-LE-septet layout; the encoding model does not transfer.
- G0 is the DEFAULT, not the live value. The current value comes from
  fn 0x02 GET (which also returns the display string, e.g. `4.55` or
  `BRIT 800`); fn 0x16 is for the surrounding min/default/range/step
  metadata, not for reading the live value.

## Refinement history

- 2026-05-28: 25-byte payload decoded as 5 groups of 5 plain-LE septets
  (G0 int current, G1 min f32, G2/G3 max/default f32 role-TBD, G4
  reserved int). Byte-exact round-trip on 2 captured payloads + both
  frame checksums verified. Open: G2/G3 role label, G4 semantics, and
  the 265-vs-259 enum-count reconciliation.
- 2026-05-28: added the exact disambiguation probe frames (amp.bass
  `F0 00 01 74 07 16 6A 00 02 00 7C F7` for G2/G3; an AMP paramId sweep
  for G4) and settled the 265-vs-259 question offline as structure (most
  consistent with an allocated-slot count, max catalog index 258), not
  as a count: the only on-disk fn 0x28 dump is truncated at 154 of 259
  labels, so the live count needs an untruncated re-read of
  `F0 00 01 74 07 28 6A 00 00 00 40 F7`. Status stays partial-N1; the
  G2/G3 and G4 labels are hardware-gated.
- 2026-05-29: hardware sweep on Q8.02 (AMP effectId 106, paramIds 0..24)
  plus fn 0x02 current-value cross-check corrected the group model. G0
  is the DEFAULT, not the current value (eight 0..10 knobs all read
  G0=50 while their live values differ; current comes from fn 0x02). G4
  is step/resolution (0.001 for 0..10 knobs), not reserved. Enums carry
  the value count in G2 (amp 265, tone_stack 109) with G3=1.0. Remaining
  open: the internal-vs-display split of G2/G3 for continuous params
  (needs a per-param display-range cross-ref), and the fn 0x28 full
  enumeration (still capped at 155 labels by the 2048-byte receive
  buffer).
- 2026-06-09: the fn 0x28 enumeration gap closed. The 2048-byte "cap"
  was node-midi WinMM fragmentation, now reassembled in the transport;
  the re-run returned all 266 amp labels untruncated and the G2 reading
  is settled as the max ordinal (265) of a 266-entry table. Remaining
  open for this entry: only the continuous-param G2/G3
  internal-vs-display split.
