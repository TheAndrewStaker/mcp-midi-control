---
name: am4-edit-dropdown-order-not-wire-order
class: enum-mapping
status: non-matching
verified_on:
  - am4-edit-2.00
golden: STUB (structural-only; negative finding: the resolved wire orders are guarded by scripts/verify-msg.ts enum-table registration cases; see Symptoms / grep terms)
retest_when: never (structural: editors re-sort dropdowns for display; the device front-panel knob order IS the wire order, and the hardware-sweep lane that resolved this shipped 2026-05-31)
relates_to: [param-descriptor-16byte]
consumed_in: []
---

# AM4-Edit dropdown DISPLAY order is NOT the wire-index order

A natural plan for recovering an enum's `wire-index → option-label` table
is to screenshot the AM4-Edit (or AxeEdit) dropdown and read the options
top-to-bottom, assigning index 0 to the first option, 1 to the second, etc.
This produces the correct label SET but a WRONG index map. It does NOT work.

## Why it fails

The editor sorts dropdown options for DISPLAY (alphabetical / by band-count /
some UI grouping), independent of the firmware's wire-index order.

**Proof (AM4-Edit FW 2.00, 2026-05-31):** `amp.geq_type` reads `wire=0` for
the value "8 Band Var Q", but AM4-Edit lists "8 Band Var Q" **last** in the
GEQ Type dropdown (display position 10 of 11). Same for `amp.compressor_type`:
the device holds `wire=0` for "Output", which the dropdown displays last
(position 2 of 3). The pre-existing `amp.geq_type` / `amp.compressor_type`
tables in `params.ts` register index 0 = "8 Band Var Q" / "Output" and agree
with the wire read: the wire-index order, not the display order, is correct.
(These are the 3-4 entry amp topology selectors, distinct from the separate
18-entry `geq.type` / `compressor.type` model dictionaries.)

## Why the obvious fallbacks also fail

- **Hardware `get_param` echo gives no label on AM4.** Unlike the Axe-Fx II
  (whose fn 0x02 GET response carries an ASCII label), the AM4 returns only a
  packed value; the descriptor decodes it. An enum `get_param` therefore
  returns the raw integer index (useful for confirming a single point if a
  human reads the editor's CURRENT-VALUE field at that index), but it never
  emits the option string itself.
- **Channel confound.** AM4-Edit's A/B/C/D channel buttons change which
  channel you are VIEWING, not necessarily the scene's ACTIVE channel that a
  no-channel `get_param` reads. Cross-checking "editor current value" against
  a device read silently compares two different channels unless you pin the
  channel on both sides.

## What does NOT work either: a raw Ghidra .rdata memory scan

A natural follow-up ("mine the wire-ordered enum table straight out of
AM4-Edit.exe with Ghidra") also fails, and it is worth recording why so the
next agent does not burn a run on it. The `am4-enum-options-ghidra-design`
workflow (2026-05-31, both reviewers `sound:false`) established:

- **The option labels are NOT a static, wire-ordered string table in the
  binary.** A full static-string sweep of AM4-Edit.exe found the
  discriminating labels (`Var Q`, `Const Q`, `8 Band`, `Feedback`, `Gain
  Enhancer`, `Soft`, `Hard`, `Peak`) absent as ASCII / UTF-16 / joined
  literals. They live in **compressed JUCE BinaryData** (ZIP/gzip in `.rsrc`);
  Ghidra loads the compressed bytes and never inflates them, so a `.rdata`
  pointer-array / `fromTokens` scan cannot see them.
- The 16-byte ParamDescriptor carries the SYMBOL pointer only (paramId@+0,
  namePtr@+8), no options pointer / count. The XML (`__block_layout*.xml`)
  marks the control `type="dropdownExpert"` but carries no option list. The
  paramId to option-set edge is established in editor code at combo-fill time,
  not as a static data edge.

## What actually works

- **JUCE BinaryData, decompressed.** The labels (if statically present at all)
  are in the compressed BinaryData blob, the lane that already recovered 1,299
  AM4-Edit labels. Inflate the `.rsrc` ZIP/gzip first, then search the
  decompressed resources. See `fractal-midi/docs/capture-guides/juce-binarydata-extraction.md`.
- **The editor metadata cache** (`effectDefinitions_15_2p0.cache`, parsed by
  `scripts/parse-cache.ts` into `cacheEnums.ts`). NOTE the cache's
  model-DICTIONARY array order is also not the wire order; the wire-ordered map
  is a SEPARATE per-param option-index sub-structure parse-cache.ts has not yet
  surfaced. Re-parse for that.
- **Hardware wire-sweep (the lane that actually resolved this, 2026-05-31).**
  Set each wire index and read the **DEVICE FRONT-PANEL** value at each step
  (NOT AM4-Edit, which owns the USB port and re-sorts its list). `scripts/_research/probe-am4-enum-sweep.ts`
  does this: it writes index 0,1,2,… via the codec `buildSetParam` (codec enum
  encode is identity, so it writes a raw index even when `enumValues` is empty),
  with a dwell so a human reads the label per step. The device readback CLAMP
  auto-detects table size for SOME params (knee/detector/preamp_tube/in_eq
  clamp) but NOT all (amp.eq_location stores out-of-range values and does not
  clamp via MIDI), so the human's knob-rotation read is the authoritative size.
  KEY RULE confirmed this way: the **device front-panel knob order (clockwise
  from start = index 0) IS the wire-index order.** It is the editor's *dropdown*
  that re-sorts, not the device. So read the device, not the editor.
- **Whichever source you use, verify index 0 against hardware ground truth**
  (`geq_type` wire 0 = "8 Band Var Q"; `compressor_type` wire 0 = "Output").

## Symptoms / grep terms

Search these before re-attempting:

- "dropdown order wire index" / "enum index from editor dropdown screenshot"
- "AM4-Edit dropdown re-sorts" / "dropdown top-to-bottom index 0"
- "front-panel knob order is wire order" (the positive rule that replaces this)

## RESOLVED (2026-05-31)

Six params were hardware-swept and registered in `params.ts` with the
device-confirmed wire order (each reorders the AM4-Edit dropdown):

- `compressor.knee_type` (5): `HARD, MED-HARD, MEDIUM, MED-SOFT, SOFT` (dropdown
  swapped indices 2/3, `Med-Soft`/`Medium`).
- `compressor.detector_type` (4): `RMS, PEAK, RMS + PEAK, HALF-WAVE` (dropdown
  led with `Half-Wave`, actually the LAST wire index).
- `amp.preamp_tube_type` (9): `12AX7A Syl, ECC83, 7025, 12AX7A JJ, ECC803S, EF86,
  12AX7A RCA, 12AX7A, 12AX7B` (editor groups the 12AX7A variants; wire scatters them).
- `amp.in_eq_type` (4): `LOWSHELF, PEAKING, HIGHSHELF, TILT EQ` (dropdown led
  with `Highshelf`, wire 2).
- `amp.eq_location` (3, the GRAPHIC-EQ location): `OUTPUT, PRE P.A., INPUT`.
- `amp.in_boost_type` (15): `NEUTRAL, T808, T808 MOD, SUPER OD, FULL OD, AC BOOST,
  SHIMMER, FAS BOOST, GRINDER, TREBLE BOOST, MID BOOST, CC BOOST, SHRED BOOST,
  RCB BOOST, JP IIC+ SHRED`.
- `amp.power_type` (2): `AC, DC` (rectifier). AMP-GATED: only editable on certain
  amps (found on FAS Modern, hidden on others), which is why it was hard to
  surface. Index 1 = DC confirmed by set-on-device + read-back of `0x005d`.

- `amp.power_tube_type` (26): `5881, 6L6GB, EL34 MULL, EL84/6BQ5, 6L6GC GE,
  6V6GT GE, KT66 GEN, KT88 GEN, 6550 SVET, 6973, 6AQ5, 300B, KT77 JJ, 6CA7 JJ,
  6L6GC JJ, EL34 JJ, EL84 JJ, KT66 JJ, KT88 JJ, 6CA7 AMP, EL34 SVET, 6L6GC SVET,
  6V6GT TUNG, EL84 MULL, 6550 TUNG, TRANSISTOR`. A NEW register at pidHigh `0x4b`
  (adjacent to preamp_tube_type `0x4c`), NOT `amp.tubes` `0x0095` (which stayed 0
  when Power Tube Type changed, ruled out). Found by scanning the amp register
  range for the distinctive parked value (TRANSISTOR = index 25):
  `probe-am4-find-power-tube-type.ts`. Amp-gated (Double Verb Vibrato).

Guarded by `scripts/verify-msg.ts` (8 enum-table registration cases). `amp.geq_type`
/ `amp.compressor_type` were already correct at index 0. Technique note: an
unmapped enum register can be located by parking it on a distinctive index on the
device, then scanning `sendReadAndParseRaw` over the block's pidHigh range for
that raw value.
