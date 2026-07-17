---
name: editor-side-chunk-1-inner-decode
class: dispatch-context
status: non-matching
discovered: 2026-05-28 (HOP 3 of AM4-Edit parser-side decode arc)
verified_on:
  - am4-edit-binary
  - axe-edit-iii-binary
firmware_sensitive: false
golden: STUB (structural-only; negative finding: verification is the three-HOP Ghidra classification cited in consumed_in; see Search terms to avoid re-attempting)
retest_when: never (architectural: editors treat bulk preset chunks as opaque transport, proven by 3 Ghidra HOPs on AM4-Edit plus the committed III cross-cite; per-param byte positions are firmware-only knowledge, and the 2026-07-02 AM4 container decode came from the codec/oracle lane, not from any editor binary)
relates_to: [iii-async-workflow-fn-registry, iii-workflow-state-machine-executor, iii-fn-byte-switch-as-inbound-dispatcher, vendor-envelope-descriptor-table, iii-multiproduct-editor-binary]
consumed_in:
  - packages/fractal-midi/docs/devices/am4/preset-binary-format-research.md (§13)
  - packages/fractal-gen3/src/presetDump.ts (L47 - "treats chunk payloads as opaque blobs")
  - samples/captured/decoded/ghidra-am4-edit-inbound-stream-path.txt
  - samples/captured/decoded/ghidra-am4-edit-classify-dmsm-slots.txt
---

# Negative: Fractal editor binaries do NOT contain bulk preset-binary inner per-param decoders

The 0x77/0x78/0x79 PRESET_DUMP envelopes (AM4 12,352 bytes / III 49,336
bytes / II ~equivalent) carry per-(block, channel, param) values
packed at fixed byte positions inside the bulk chunk payloads. The
hypothesis ruled out here: **that those per-param byte positions are
known to the editor binary** and recoverable via Ghidra mining.
Verified false on AM4-Edit (3 HOPs of mining, 2026-05-28) and
cross-cited on AxeEdit III (`packages/fractal-gen3/src/presetDump.ts`
L47, committed comment "treats chunk payloads as opaque blobs").

## Hypothesis ruled out

That somewhere in a Fractal editor binary there exists a function
that:

1. Receives a 0x77/0x78/0x79 PRESET_DUMP frame.
2. Walks the chunk payload byte-by-byte (or ushort-by-ushort).
3. Maps each byte position to a `(block, channel, param)` tuple via
   either hardcoded immediates or a lookup table.
4. Writes the decoded value into the editor's per-param model struct.

This hypothesis was the basis for three Ghidra mining HOPs in
`packages/fractal-midi/docs/devices/am4/preset-binary-format-research.md`
§11-§13. All three terminated negatively.

## Why the hypothesis fails

Editor binaries treat bulk PRESET_DUMP chunks as opaque transport
blobs. The actual preset-load workflow is:

1. User clicks "Load Preset" in the editor UI.
2. Editor emits the relevant outbound request (e.g. AM4 fn=0x17
   "Get Preset Data" per `[[iii-async-workflow-fn-registry]]`'s AM4
   axis; III equivalent).
3. Device replies with the bulk preset binary (1× `0x77` header + N×
   `0x78` chunks + 1× `0x79` footer).
4. Inbound dispatcher routes each frame to a chunk-accumulator that
   stores the bytes in the active workflow's buffer.
5. Workflow completes with the bytes stored as an opaque blob.
6. **For export-to-file**, the bytes are written verbatim.
7. **For "load into editor UI"**, the editor issues PER-PARAM fn=0x01
   GET requests against its own model and rebuilds the UI from the
   per-param replies, NOT from the bulk binary.

The bulk binary's per-param byte positions are **firmware-only
knowledge**. The device writes those bytes when emitting the bulk
dump; the editor reads those bytes verbatim but does not know what
they mean at the per-param level.

## Evidence by binary

### AM4-Edit (verified 2026-05-28, HOP 1-3)

**HOP 1**: AM4-Edit class hierarchy decoded
(`AM4DeviceManager` + `FasStateMachine` + `DeviceMgrStateMachine` + 42
embedded workflow instances + workflow registry `FUN_1402d83d0`).
Workflow registry has NO entry for fn-bytes 0x77/0x78/0x79 (the
registry only lists OUTBOUND fn-bytes; the bulk frames are inbound
responses routed via workflow state, not fn-byte). Primitive
`[[iii-async-workflow-fn-registry]]` promoted matched-singleton →
matched. See `samples/captured/decoded/ghidra-am4-edit-preset-parser.txt`,
`ghidra-am4-edit-devicemanager-vtable-v2.txt`, etc.

**HOP 2** (`samples/captured/decoded/ghidra-am4-edit-classify-dmsm-slots.txt`):
classified all 6 `DeviceMgrStateMachine::vftable` candidate slots
(30 / 12 / 22 / 45 / 14 / 1) + 7 `AM4DeviceManager::vftable` candidate
slots (3 / 4 / 5 / 7 / 8 / 9 / 10) against the 22 chunk-1 anchor
byte offsets from `samples/captured/am4-warm-pair-diff.json` step-5
exclusive recs. ZERO anchor hits across all 13 candidates. Slots
resolved to: persistence load (`__components.xml`), JUCE UI builder,
single-instance dialog, RNG, destructor, struct initializer, XML
preset parser (`FUN_1402e23b0`), string-table lookup, and the
inbound message dispatcher (`FUN_1402ddb80`, AMDM slot 4: fn-byte
switch over short one-shot responses 0x00 / 0x01 / 0x03 / 0x08 /
0x19 / 0x47; no case for 0x77 / 0x78 / 0x79).

**HOP 3** (`samples/captured/decoded/ghidra-am4-edit-inbound-stream-path.txt`):
classified the dispatcher's 8 first-level callees + 3 supporting
functions. The predicted AM4 analog of III's `FUN_1401f4390`
workflow state-machine executor (`FUN_1402da830`, reached from
the dispatcher's `cVar5 == 0x01` stream-end branch) decompiled to a
single-param SET_PARAMETER response unpacker (5-field 14-bit header
+ septet-7-bit unpack loop), NOT a state-machine executor. Zero
anchor hits + zero switch/case statements + zero chunk-1 byte-buffer
reads across all 11 candidates. The library-load handler
(`FUN_1401da990`) revealed the canonical inbound-parse mechanism:
**descriptor-table-driven**, each fn-byte response uses one of the
54 mined `.rdata` descriptor tables at `0x1405dc190..0x1405dd160`
for field-by-field `(mid, byte_count)` lookup (primitive
`[[vendor-envelope-descriptor-table]]`). The chunk-1 outer
descriptor at `0x1405dcf40` declares `(tag=0, mid=6, byte_count=2)
+ (tag=1, mid=8, byte_count=3072)`, i.e. "header at +6 is 2 bytes;
body at +8 is 3072 bytes of opaque packed data." That table's role
ends at the outer envelope; the 3072 bytes are stored as one opaque
field.

### AxeEdit III (cross-cited, committed in production code)

`packages/fractal-gen3/src/presetDump.ts` L47 (committed):

```
* Total preset body across 16 chunks: 49,152 bytes of packed-ushort
* storage = 16,384 ushorts. Inner per-scene / per-block decode is
* the subject of future work (the III analog of BK-070); this module
* treats chunk payloads as opaque blobs.
```

III's outer envelope descriptor at `0x1407ab940` (primitive
`[[vendor-envelope-descriptor-table]]`) declares the same
`(tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=3072)`
shape per chunk. Same architecture as AM4: opaque transport at the
editor level.

## Search terms to avoid re-attempting

- "Ghidra search for chunk-1 byte-offset table in AM4-Edit": the
  table does not exist; only the outer envelope descriptor exists.
- "find the workflow state-machine executor that decodes chunk-1 on
  AM4-Edit": the predicted analog of III's `FUN_1401f4390` decoded
  to a single-param unpacker; no chunk-decode workflow case exists.
- "look at AM4-Edit's `__components.xml` for per-param byte positions":
  `__components.xml` is JUCE UI components persistence
  (MenuBarSkin, layout JSON), not per-param positions.
- "mine III's preset-receiver dump to bootstrap AM4 chunk-1 decode":
  III itself hasn't decoded its own inner layout (committed
  `presetDump.ts` L47).
- "lift the chunk-1 layout from JUCE BinaryData XML": the XML gives
  display labels and symbolic IDs; explicitly excludes wire IDs and
  preset-binary byte positions per
  `docs/capture-guides/juce-binarydata-extraction.md` L201-206.

## What to look for instead

For per-(block, channel, param) byte positions inside a Fractal
PRESET_DUMP chunk, the byte positions are **firmware-only knowledge**
and recovering them is out of scope:

- The bulk preset binary is opaque transport at the editor level
  (this entry's primary claim, verified §13 of `preset-binary-format-research.md`).
- The AM4 firmware `.syx` file uses a custom packing scheme applied
  by Fractal's internal factory tool; the packing decoder lives in
  the AM4's boot loader / firmware-update path on the device side.
  Not in AM4-Edit.exe (HOP 4 Phase 1.5, verified §15 of
  `preset-binary-format-research.md`), not in any other shipped
  Fractal editor (Axe-Edit, FX8-Edit, Cab-Lab, AX8-Edit all share
  the same UI-skin-dispatch codebase per §15.2). Recovering the
  unpacker requires physical flash dump or JTAG/SWD access to a
  running AM4 unit, out of project scope.
- **The right answer** for `get_preset` against non-active stored
  presets is to keep the slow per-channel fn 0x02 fallback (~7s).
  Active-buffer reads use the fn 0x1F atomic-read fast path
  (`[[am4-fn1f-atomic-read]]`, ~129 ms warm). Cross-device: same
  conclusion applies to III's stored-preset reads; no editor-side
  decoder exists.

For the OUTER envelope shape (chunk-header + chunk-body framing),
the editor's `[[vendor-envelope-descriptor-table]]` IS the answer,
mined for II (`0xe04440`), III (`0x1407ab940`), and AM4
(`0x1405dcf40`). That primitive remains the right tool for
fn-by-fn envelope-shape discovery; this entry rules out only the
inner-content decode.

For per-param read/write at runtime, use fn=0x01 (SET_PARAMETER /
SET_PARAMETER_RESPONSE); that path IS implemented in every editor
and is the only one that touches per-param positions. The bulk
preset binary is a transport layer; the param-edit layer is the
fn=0x01 path. AM4 production code at
`packages/am4/src/descriptor/reader.ts` uses fn=0x02 (the variant
of fn=0x01 for AM4's per-param GET) as the per-channel chunk-1
read primitive; the slow ~7 s per `get_preset` cost is the
unavoidable per-param-RPC tax for chunk-1 decode without firmware-
side knowledge.

## Refinement history

- 2026-05-28 (initial discovery): three HOPs of AM4-Edit Ghidra
  mining (HOP 1: class hierarchy + workflow registry; HOP 2: vtable
  candidate classification; HOP 3: inbound-stream callee
  classification) converged on the cross-device pattern. Filed as
  negative with AM4 + III axes (III via committed `presetDump.ts`
  L47 cross-cite). Future agents asking "where in the editor binary
  is preset binary X decoded inner per-param" should land on this
  entry and pivot to firmware mining without rerunning the hunt.
- 2026-05-28 cont (HOP 4 Phase 1, firmware extraction): the
  recommended "what to look for instead" path (firmware Ghidra)
  unblocked the outer SysEx envelope (fn=0x7D/0x7E/0x7F three-frame
  shape, parallel to the preset-binary 0x77/0x78/0x79 shape, same
  `[[vendor-envelope-descriptor-table]]` mechanism) but hits a
  second-order blocker: the packed firmware payload doesn't unpack
  to ARM Cortex-M code under any standard MIDI scheme (8-to-7
  msb-first / msb-last / reverse-bits / 3-to-2 ushort / no-unpack).
  String probe vs the AM4 block-name vocabulary returns 0-4
  coincidental hits across all variants. Recommendation: pivot to
  AM4-Edit firmware-update emitter mining as the next step before
  any further firmware analysis. Full writeup at
  `packages/fractal-midi/docs/devices/am4/preset-binary-format-research.md`
  §14. Scripts: `scripts/_research/extract-am4-firmware-syx.ts`,
  `analyze-am4-firmware-packing.ts`, `find-arm-code-region.ts`,
  `probe-am4-firmware-strings.ts`, `probe-am4-firmware-xor.ts`.
- 2026-05-28 cont (HOP 4 Phase 1.5, AM4-Edit firmware-emitter
  mining): the §14.6 "if pursued anyway" path was attempted and
  TERMINALLY rules out AM4-Edit as the source of the firmware
  packing format. Three headless Ghidra probes ran against
  `ghidra-am4-edit.gpr`. Headline finding: out of 16,940 functions
  in AM4-Edit.exe, only 2 contain BOTH 0xF0 (SysEx start) AND
  0x7E (firmware chunk fn) immediates, and both decompile to
  **JUCE UI rendering** (FirmwareUpdateSkin layout + font/color
  paint code). Zero packing-loop signatures (`& 0x7f`, `<< 7`,
  0x1E0 chunk-length constant, MIDI emit calls) across the entire
  94 KB / 2,877-line decompile of all 7 candidates. **Architectural
  finding**: `FUN_14014c9d0`'s 6-product UI-skin dispatcher
  (`Fractal-Bot`/`fractal-bot.xml`, `Axe-Edit`/`axe-edit.xml`,
  `Cab-Lab`, `FX8-Edit`, `Cab-Lab3`, `AX8-Edit`) confirms
  Fractal-Bot is a UI MODE of AM4-Edit's shared editor codebase
  that streams the pre-packed .syx file verbatim to MIDI out.
  **No Fractal user-facing editor contains a firmware
  packer/unpacker**; the packing was applied by Fractal's
  internal factory build tool, and the unpacker lives in the
  AM4's boot loader / firmware-update path on the device side.
  Cross-device implication: same conclusion applies to Axe-Edit,
  FX8-Edit, Cab-Lab, AX8-Edit. Recovering the unpacker requires
  physical flash dump or JTAG/SWD access to a running unit, both
  out of project scope. Full writeup §15 of the research doc.
  Scripts: `FindAM4EditFirmwareEmitter.java`,
  `ProbeAM4EditFractalBot.java`,
  `DecompileAM4EditFirmwareEmitter.java`.
