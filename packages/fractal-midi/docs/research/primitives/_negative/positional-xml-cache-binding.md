---
name: positional-xml-cache-binding
class: label-extraction
status: non-matching
discovered:  (XML-to-wire-id binding)
verified_on:
  - axe-edit-ii-1.x
  - axe-edit-iii-1.40
firmware_sensitive: false
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when: never (measured, 20-40% inversion rate; the XML records the editor's UI layout by construction, not the device param table, so the positional binding cannot become correct)
relates_to: [juce-binarydata-zip, param-descriptor-16byte, parambase-plus-paramid]
consumed_in: []
---

# Positional XML parameterName → cache-record binding: does NOT work

JUCE BinaryData extraction yields per-block XML layout files with
`parameterName=` attributes ordered by display position. The
hypothesis is that the N-th `parameterName=` in `__block_layout.xml`
binds to the N-th wire-id reserved by that block-type. It does NOT.

## Why it fails

`parameterName` in the layout XML is a **per-variant UI symbol**, not
a unique wire key. Across variants of the same block-type the same
display name maps to different wire ids and the same wire id maps to
different display names. Measured inversion rate: 20-40% across the
variants surveyed . Examples:

- `DISTORT_TONE` resolves to `drive.id=12` in some variants and
  `drive.id=23` in others.
- `parameterName="LEVEL"` appears at distinct positions across drive
  variants; the positional index does not match wire order in any
  variant beyond the first.

The XML records the editor's UI layout, not the device's parameter
table. The two are independent data structures and the positional
order of one is not load-bearing on the other.

## What works instead

Combine the XML (for the *names* and *displayLabel* / *controlType*
metadata) with one of:

- **Ghidra param-descriptor mining** ([[param-descriptor-16byte]])
  recovers `(paramId, name)` pairs from the editor's `.rdata`
  ParamDescriptor table at 99% wire-accuracy.
- **Wire capture matched to a known UI action.** The device echoes
  paramId in its response. One capture per param resolves the
  binding without trusting the XML's positional order.
- **[[parambase-plus-paramid]]** address-calculation primitive on II,
  for block-types whose `paramBase` has been measured.

## What this does NOT rule out

- The XML as a source of display labels, ranges, and control types.
  These attributes are intrinsic to the name and transfer across
  variants. Only the *positional binding* to wire ids fails.
- Using XML to discover unregistered parameter *names*. The names
  are useful inputs to a paramId-recovery probe even when the
  position is not.

## Symptoms / grep terms

Search these before re-attempting:

- "positional XML wire-id binding" / "N-th parameterName binds N-th wire id"
- "__block_layout.xml positional order" / "XML order is UI layout"
- "20-40% inversion rate" (the measured failure)

## Refinement history

- 2026-05-22 (primitives backfill): negative finding registered after
   measurement. The positional-binding shortcut had
  appeared in three subsequent investigations as a "maybe this works
  on the III" hypothesis; that line of inquiry should now stop.
