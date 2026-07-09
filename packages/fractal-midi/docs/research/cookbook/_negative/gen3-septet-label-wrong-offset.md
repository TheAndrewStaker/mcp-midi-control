---
name: gen3-septet-label-wrong-offset
class: bit-level
status: non-matching
discovered: 2026-06-04 (fm9-decode-verify workflow caught the false negative)
verified_on:
  - fm9-fw-11.00
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-gen3-septet-label-wrong-offset
retest_when: never (trap-record, the byte-5 alignment is capture-proven and golden-gated; this entry exists as the offset-sweep tripwire, not as a re-testable hypothesis)
relates_to: [gen3-enum-label-septet-stream, iii-byte-stream-septet-pack-8to7]
consumed_in: []
---

# Septet unpack at the wrong byte offset hides gen-3 enum labels: DO NOT conclude "no labels on the wire"

This is the trap that produced a WRONG multi-session conclusion ("gen-3
enum value names are device-resident / never cross the wire"). They DO
cross the wire ([[gen3-enum-label-septet-stream]]); two independent decodes
missed them because the streaming 8→7 septet unpack is **bit-alignment
sensitive to its start byte**, and both started one byte too late.

## What failed

- A full-capture ASCII scan unpacking each frame's payload from **byte 6**
  (after the `sub` byte) yielded only the fixed identity blob `SPFGAD…` and
  one `"Output 3"`, no enum labels. Conclusion drawn: "labels off-wire."
- The correct stream starts at **byte 5** (the `fn` byte). At byte 5 the
  same frames decode to "Clean", "Warm", "Medium Spring", "BASSGUY", … One
  byte of misalignment shifts every 7-bit boundary and turns ASCII to noise.

This is the same wrong-septet bug class as the firmware-mining dead-end
([[iii-byte-stream-septet-pack-8to7]] used the right algorithm; the failures
used a wrong start/grouping). Both the original capture3 17-agent decode and
the first pass on the 2026-06-04 captures made this error.

## The rule

When a Fractal frame "has no readable strings," before concluding the data
isn't there: sweep the septet-unpack **start offset** (4,5,6,7,8) and look
for fixed-width ASCII fields. For gen-3 fn=0x01 IN frames the answer is
offset 5.

## Also retired here: "open the block panel to dump type lists"

A companion false lead: opening a block's PANEL was believed to make the
editor fetch that block's full enum/type lists. It does not; panel-open
yields only the param CURRENT-values (`sub=0x1a`) and the active cab's IR
list (`sub=0x2e`). The full per-type list dumps only when the **Type
dropdown itself is opened**. Ask testers to open the dropdown, not just the
block.

## Symptoms / grep terms

Search these before re-attempting (or before re-concluding "no labels"):

- "gen-3 enum labels not on wire" / "labels device-resident"
- "septet unpack no readable strings" / "SPFGAD identity blob only"
- "8-to-7 unpack start offset" / "byte 5 vs byte 6 alignment"

## Refinement history

- 2026-06-04: registered as the negative companion to
  [[gen3-enum-label-septet-stream]] after the verify workflow refuted the
  off-wire claim and a hand re-derivation pinned the offset to 5.
