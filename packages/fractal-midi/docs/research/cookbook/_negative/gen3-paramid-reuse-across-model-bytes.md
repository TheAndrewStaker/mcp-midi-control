---
name: gen3-paramid-reuse-across-model-bytes
class: dispatch-context
status: non-matching
discovered: 2026-06-02 (FM9/FM3/VP4 editor-binary param-table scan)
verified_on:
  - axe-edit-iii-binary
  - fm9-edit-binary
  - fm3-edit-binary
  - vp4-edit-binary
firmware_sensitive: true
golden: STUB (structural-only; negative finding: device-true catalogs are drift-gated by the per-device catalog checks; see Symptoms / grep terms)
retest_when: never (measured firmware fact: paramIds are per-firmware per-effect ordinals, 6.9%/18.6%/99.5% divergence from the III; device-true catalogs mined from each editor binary are the permanent lane)
relates_to: [per-effect-paramtable-dispatcher, iii-multiproduct-editor-binary, iii-fn01-action-code-per-model-byte, param-descriptor-16byte]
consumed_in:
  - scripts/_research/scan-editor-param-tables.ts
  - scripts/_research/merge-modern-fractal-devicetrue.ts
---

# Gen-3 paramId reuse across model bytes: NO transfer

The modern-Fractal family (Axe-Fx III `0x10`, FM3 `0x11`, FM9 `0x12`,
VP4 `0x14`) shares ONE wire codec: identical SysEx envelope, checksum,
function family, and the `fn=0x01` PARAMETER_SETGET shape. It is
tempting to conclude that a parameter's `paramId` is therefore the same
across the family, so the III's mined catalog can be reused verbatim for
FM3/FM9/VP4. **It cannot.** The `paramId` is a firmware-specific,
per-effect-family ordinal, NOT a stable family-wide constant.

## The measurement

Pattern-scanning each editor's own param tables (the same
`{int32 paramId; int32 pad; char* name}` structs that
[[per-effect-paramtable-dispatcher]] describes; method below) and
comparing the device-OWN paramId to the III's paramId for every shared
symbol:

| Device | shared symbols w/ III | paramId DIFFERS from III |
|---|---:|---:|
| FM3 (0x11) | 1649 | **6.9%** |
| FM9 (0x12) | 1695 | **18.6%** |
| VP4 (0x14) | 963 | **99.5%** |

Byte-corroborated on FM9: `DELAY_BYPASS` = paramId 5 (III = 22);
`CONTROLLERS_MANUAL1` = 112 (III = 160); the whole `CONTROLLERS_*`
family is uniformly shifted by 48. VP4 does not even contain the symbol
`DELAY_BYPASS` (its namespace is reorganized). The shifts are
systematic, not noise: when a firmware adds or drops params in a family
(FM9 has ~230 fewer GLOBAL params than the III), every downstream
ordinal in that family moves.

## Why the shared codec does NOT imply shared paramIds

The envelope/checksum/function family are model-byte-parameterized
constants ([[iii-multiproduct-editor-binary]],
[[iii-fn01-action-code-per-model-byte]]). The `paramId` is different in
kind: it is assigned by each firmware's own per-effect ParamDescriptor
table, which tracks that firmware's exact param set. Same mechanism
(dispatcher + 16-byte rows), different contents. The
[[per-effect-paramtable-dispatcher]] entry already warned that per-block
paramId CONVENTIONS are not portable across devices (AM4 vs III); this
entry is the stronger, measured statement that the paramId VALUES are
not portable even within the SAME gen-3 codec family.

## What IS the correct source (offline, no hardware)

Each editor binary carries its OWN param tables. A direct PE pattern
scan recovers them: parse the PE (imageBase + sections), collect every
param-symbol string with its virtual address, then walk the file for u64
pointers into that VA set and read the `paramId` at `(pointer_offset -
8)`. `scripts/_research/scan-editor-param-tables.ts` does this. It is
validated by reproducing the III's Ghidra-mined paramIds at **100.00%
(2216/2216)** on the III control, so the FM/VP results from identical
code are trustworthy. This gives device-true paramIds at ~100% wire
coverage with no hardware and no Ghidra.

## Misapplication failure modes

- **"The codec is shared, so the catalog is shared."** Conflates the
  envelope (shared) with the paramId (per-device). Emitting an
  III-borrowed paramId on an FM/VP `fn=0x01` frame silently writes the
  WRONG parameter: no error, no ack divergence. This is the exact
  silent-mis-write class [[preference: no untested wire paths]] forbids.
- **"99.8% of symbols match by NAME, so the paramIds match."** The name
  overlap is high and irrelevant to the paramId question. Symbol
  equality does not force ordinal equality.
- **Circular self-confirmation.** If you build the FM catalog by joining
  symbols to III paramIds and then "check" that the FM paramIds equal
  the III paramIds, you get 100% agreement, because there is one source.
  The only non-circular check is the device's OWN binary.

## Where it does NOT apply

- The roster, display labels, control types, and effect-type ENUM
  vocabularies DO mine cleanly from each editor's `__block_layout.xml`
  ([[juce-binarydata-zip]]); only the paramId must come from the device
  binary, not the III.
- Cross-GENERATION reuse (gen-2 Axe-Fx II `fn=0x02` vs gen-3 `fn=0x01`)
  was never on the table; this entry is specifically about reuse WITHIN
  the gen-3 family, which looks safe and is not.

## Symptoms / grep terms

Search these before re-attempting:

- "reuse III paramIds for FM3/FM9/VP4" / "gen-3 shared codec shared catalog"
- "paramId same across model bytes" / "III catalog stopgap"
- "silent wrong-param write" (the failure mode an III-borrowed paramId produces)

## Refinement history

- 2026-06-02: discovered while replacing the FM3/FM9 III-catalog
  stopgap with device-true catalogs. The stopgap (FM3/FM9 reuse the III
  catalog incl. paramIds) was found to be wire-unsafe for 7-19% of
  shared params. Full writeup in the consumer repo's private findings
  note `MINING-FINDINGS-FM-VP4.md`.
