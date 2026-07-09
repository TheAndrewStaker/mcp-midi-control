---
name: juce-binarydata-zip
class: label-extraction
status: matched
discovered:  (replaced WinDbg dead-end with JUCE BinaryData ZIP path)
verified_on:
  - am4-edit-binary
  - axe-edit-iii-binary
  - fm9-edit-binary
  - fm3-edit-binary
  - vp4-edit-binary
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: scripts/_research/extract-xml-from-dump.ts extraction lane vs the local editor binaries)
relates_to: [param-descriptor-16byte, per-effect-paramtable-dispatcher, gen3-paramid-reuse-across-model-bytes]
consumed_in:
  - scripts/_research/extract-exe-strings.ts
  - scripts/_research/extract-xml-from-dump.ts
  - scripts/_research/mine-axeedit3-xml-labels.ts
  - scripts/_research/extract-editor-layout-xml.ts (ZIP-aware carver; FM9/FM3/VP4 + III re-extract)
  - scripts/_research/mine-modern-fractal-catalog.ts
---

# JUCE BinaryData ZIP extraction

JUCE-based editor binaries (AM4-Edit, AxeEdit, AxeEdit III) embed their
resource files as a ZIP archive inside the `BinaryData` static. Label
extraction takes 5 minutes via standard ZIP tooling, no debugger
attachment, no runtime instrumentation.

## Formal definition

The JUCE framework generates `BinaryData::namedResource` static arrays
at compile time. The named resources are typically a ZIP archive
containing XML, image, and string-table resources. The archive can be
located in the binary by:

1. Search for the ZIP central-directory signature `0x06054b50` in the
   binary.
2. Walk backward to the local-file-header signature `0x04034b50`.
3. Extract the ZIP from offset to offset+sizeof(zip) using any standard
   ZIP library.

The resulting archive contains files like `__block_layout.xml` (the
parameterName + displayLabel + controlType registry) and
`__amp_layout.xml`.

Practical note (gen-3 editors, 2026-06-02): the per-member streams use
ZIP **method 8 (raw DEFLATE)** with NO gzip/zlib header. A gzip-magic
(`1F 8B 08`) or zlib-magic (`78 xx`) byte scan finds NOTHING (verified:
0 hits on all four gen-3 editor exes). The robust carver walks each
`PK\x03\x04` local file header, reads the filename + compressed size,
and `inflateRaw`s the member. `scripts/_research/extract-editor-layout-xml.ts`
does this and is validated against the III (re-extracted `__block_layout.xml`
is byte-identical, 1,334,553 B / 8643 parameterName, to the prior mine).
VP4 additionally ships `__block_layout_expert.xml`; VP4 has NO
`__amp_layout.xml` (effects-only, no amp/cab).

## Where it's used

- AM4-Edit binary: 1,299 labels recovered.
- AxeEdit III binary: 10,250 labels recovered. The `__block_layout.xml`
  contains 2,017 III parameterName entries (90.1% catalog coverage)
  with displayLabel + controlType, zero hardware.
- AxeEdit II binary: **transfer candidate** per the cross-device
  protocol. The synthesis pass 2026-05-22 flagged this as untried.
  Expected yield: ~2,500 II parameterName entries with display metadata.

## Applicability

When mining labels for a new vendor binary that uses JUCE, this is the
FIRST method to try (5 minutes vs. ~3 days of WinDbg / Frida / Procmon
investigation that the  baseline took before pivoting).

## Misapplication failure modes

- **DO NOT** assume enum-value labels (amp model names, etc.) are in
  the XML. They aren't; XML carries parameter metadata, not enum
  string tables. Use [[fn28-enum-dump]] for II enum values; III + AM4
  enum value labels are transfer candidates.
- **DO NOT** assume the XML carries a `paramId` / wire id. It does not:
  the only id-like attribute is the rare `dynamicParamId`. The XML gives
  you symbol + label + control type + effect-type enums; the wire
  `paramId` comes from the binary param tables
  ([[per-effect-paramtable-dispatcher]]), NOT the XML, and is per-device
  ([[gen3-paramid-reuse-across-model-bytes]]).
- **DO NOT** locate the archive by inflating gzip/zlib magic offsets.
  The members are raw DEFLATE with no header; walk `PK\x03\x04` instead
  (see Practical note above).

## Where it does NOT apply

- Non-JUCE editors (Hydrasynth Editor, uses a different framework).

## Verification path

No inline fixture ships (golden is STUB: the editor binaries are
local-only). The extraction lane (`scripts/_research/extract-xml-from-dump.ts`
and siblings) de-facto asserts:
- ZIP signatures locatable at expected offsets
- `__block_layout.xml` parseable
- Known parameterName entries match expected canonical names

## Refinement history

- : WinDbg trap-after-launch, Frida hooks, Procmon traces all
  failed to locate the label loader (stack-frame too shallow, label
  written before trap arms).
- : JUCE BinaryData ZIP path discovered via static
  binary inspection. Immediate success on AM4-Edit. Cookbook entry's
  Refinement history documents the dead-end pivot so future agents
  don't repeat WinDbg.
- Synthesis pass 2026-05-22: AxeEdit II + Hydrasynth Editor flagged
  as untried; transfer candidates filed.
- 2026-06-02: extended to the gen-3 FM family. FM9-Edit / FM3-Edit /
  VP4-Edit all carve cleanly (block_layout 7629 / 8080 / 2752+ parameterName
  entries). Added the raw-DEFLATE / no-magic-scan refinement and the
  no-paramId-in-XML failure mode after a magic-byte scan returned 0 blobs.
