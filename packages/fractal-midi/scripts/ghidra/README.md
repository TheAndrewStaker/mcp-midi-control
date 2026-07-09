# Ghidra Script Registry (fractal-midi)

68 scripts. Read this BEFORE writing a new Ghidra script. The naming
convention is semantic (named by what they discover, not what they do
mechanically), but discovery via filename grep alone is unreliable
when there are this many files. This registry maps each script to:
its target binary, what it discovers, the output file it produces,
the last session that ran it, and current status.

**Run via the `.cmd` launcher** alongside each `.java` script. The
launchers expect your auto-analyzed Ghidra project (the `*.gpr`) to live
under your Windows user profile (`%USERPROFILE%`), and they derive the
repo root (`%PROJECT_ROOT%`) from the launcher's own location, so they
run in place from a fresh clone. To send output somewhere other than the
default below, edit the `OUT_DIR` line near the top of a launcher (or
export `PROJECT_ROOT` before running). The `.java` and `.py` scripts
themselves write to a relative `samples/captured/decoded/` path, resolved
against the directory Ghidra runs them in.

**Outputs land in** `fractal-midi/samples/captured/decoded/` (gitignored
in both repos; see `docs/research/captured-artifacts.md` for the
manifest).

## How to use this registry

1. Want to mine something new? Check the table; a script may already exist.
2. The "Status" column flags `✅ landed` (output is current and mined),
   `🟡 output exists, partially mined` (re-read with a TS parser to
   extract more), `🔜 run pending`, or `🚫 superseded`.
3. The "Cookbook primitive" column names which cookbook entry consumes
   this script's output. Many scripts feed multiple primitives.

---

## Mine*: parameter / catalog mining

Walk symbol tables, `.rdata` arrays, or direct-pattern scans to
recover paramId → name catalogs.

| Script | Target | Discovers | Output | Status | Cookbook primitive |
|---|---|---|---|---|---|
| `MineAM4EditParamResolver.java` | AM4-Edit | paramId → name pairs via resolver-table walk | `ghidra-am4-paramnames.json/.txt` | ✅ landed | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `MineAxeEditIIParamResolver.java` | AxeEdit (II 32-bit) | II paramId → name (early approach) | `ghidra-axeedit2-paramnames.json/.txt` | 🟡 superseded by SeekParamTablesII | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `MineAxeEditIII.java` | AxeEdit III | III paramId → name (v1) | `ghidra-axe-edit-iii-paramnames*.json` | 🟡 superseded by v2 | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `MineAxeEditIIIv2.java` | AxeEdit III | III paramId → name (v2, refined stride) | `ghidra-axe-edit-iii-paramnames-v2.json` | ✅ landed | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `MineAxeEditIIIParamResolver.java` | AxeEdit III | III resolver-table variant mining | `ghidra-axe-edit-iii-resolver.json` | ✅ landed | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `MineAxeEditIIIActionsAndShapes.java` | AxeEdit III | III fn=0x01 SET_PARAMETER action codes + 93 caller bodies | `ghidra-axe-edit-iii-actions-and-shapes.txt` (1.5 MB) | 🟡 output exists, ~70 sub-actions un-mined | (see synthesis-log 2026-05-22 §1d) |
| `MineAxeEditIIIEnvelopeEmitters.java` | AxeEdit III | III host-side emitter call sites for envelope-shape decode | `ghidra-axe-edit-iii-envelope-emitters.txt` | ✅ landed | [[../docs/research/cookbook/vendor-envelope-descriptor-table]] |

## Dump*: serialize discovered structures

Walk a known structure and emit text/JSON of its contents.

| Script | Target | Discovers | Output | Status | Cookbook primitive |
|---|---|---|---|---|---|
| `DumpAM4ParamNames.java` | AM4-Edit | AM4 param names | `ghidra-am4-edit-paramnames.json` | ✅ landed | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `DecompileAM4InboundDumpHandlers.java` | AM4-Edit | Focused decompile of 7 candidate AM4-Edit functions flagged by `FindAM4EditPresetParser` (high-0x77 / high-0x78 hits + the workflow registration helper) | `ghidra-am4-edit-inbound-dump-handlers.txt` (~4.7k lines) | ✅ landed 2026-05-28; classified high-0x77 candidates as JUCE UI false positives; documented `FUN_140196500` two-array storage layout |
| `DumpAM4DeviceManagerVtable.java` | AM4-Edit | (V1, symbol-table lookup) Aborted attempt to look up `AM4DeviceManager::vftable` by name: Ghidra synthesizes the label but doesn't expose it under that exact string for headless `SymbolTable` queries | (no usable output) | 🚫 superseded by V2; kept for the negative finding (symbol-lookup-for-rendered-vtable-names doesn't work in headless) |
| `DumpAM4DeviceManagerVtableV2.java` | AM4-Edit | Extracts `AM4DeviceManager::vftable` + `FasStateMachine::vftable` + sentinel addresses via head-scan of LEA refs in the ctor `FUN_1402df090` / `FUN_14031d230` | `ghidra-am4-edit-devicemanager-vtable-v2.txt` (~3.5k lines, includes 64-slot dump + decompiles of slots 0-15) | ✅ landed 2026-05-28; confirmed `AM4DeviceManager` root class @ 0x1412c2460, `FasStateMachine` workflow base @ 0x1412b2c48 |
| `DumpAM4DeviceMgrStateMachineVtable.java` | AM4-Edit | V3: full-body scan of `FUN_14031d230` to identify `DeviceMgrStateMachine::vftable` (skips the sentinel and FasStateMachine vtables found by V2). Dumps 64-slot vtable + decompiles longest-bodied methods | `ghidra-am4-edit-devicemgrstatemachine-vtable.txt` (~1.2k lines) | ✅ landed 2026-05-28; vtable @ 0x1412c4138; slots 30/12/22/45 are the remaining chunk-1-parser candidates (slot 23 ruled out as RNG) |
| `DecompileAndClassifyDMSMSlots.java` | AM4-Edit | Per-slot classification of 6 DMSM vtable candidates + 7 AM4DeviceManager candidates against the 22 chunk-1 anchor byte offsets, stride hints (0x3 / 0x12 / 0x27), buffer-read patterns, and negative-signal substrings (JUCE UI, `__components.xml` persistence, LCG RNG, single-instance dialog). Per slot: verdict + capped decompile | `ghidra-am4-edit-classify-dmsm-slots.txt` (~2k lines) | ✅ landed 2026-05-28; ALL 13 candidates ruled out as the chunk-1 parser. Pinned `FUN_1402ddb80` (AMDM slot 4) as the inbound message dispatcher as a side-finding; the follow-up chases the stream-end path `FUN_1402da830` |
| `DecompileAM4InboundStreamPath.java` | AM4-Edit | Classifies the dispatcher `FUN_1402ddb80`'s 8 first-level callees + 3 supporting size readers / allocators with the same scoring scheme as the prior slot-classification pass plus switch/case counting for state-machine-executor detection | `ghidra-am4-edit-inbound-stream-path.txt` (~1.8k lines) | ✅ landed 2026-05-28 (terminal pass). Predicted AM4 analog of III's `FUN_1401f4390` (`FUN_1402da830`) decompiled to a single-param SET_PARAMETER unpacker, not a state-machine executor. `FUN_1401da990` revealed the canonical inbound-parse: descriptor-table-driven via the 54 mined tables. **Definitive negative**: AM4-Edit contains NO chunk-1 inner per-param decoder. New cookbook entry `_negative/editor-side-chunk-1-inner-decode`. Decode arc closes at the editor-binary level |
| `DumpAEImageDepotVtable.java` | AxeEdit (II) | AEImageDepot vftable @ 0xeacff8: class architecture | `ghidra-aeimagedepot-vtable.txt` (1714 lines) | ✅ landed | [[../docs/research/cookbook/alphabetical-name-cascade-block-ordering]] |
| `DumpAxeEditIIChunkDescriptorTables.java` | AxeEdit (II) | II envelope-spec chunk descriptor tables | `ghidra-axe-edit-chunk-descriptors.txt` | ✅ landed | [[../docs/research/cookbook/vendor-envelope-descriptor-table]] |
| `DumpAxeEditIIFooterHash.java` | AxeEdit (II) | `FUN_00544cc0` (XOR-fold hash) disassembly | `ghidra-axeedit2-footer-hash.txt` | ✅ landed | [[../docs/research/cookbook/xor-fold-hash]] |
| `DumpAxeEditIIIDumpDescriptors.java` | AxeEdit III | III envelope-spec descriptor tables at 0x1407ab440 + 0x1407aba40 | `ghidra-axe-edit-iii-dump-descriptors.txt` | ✅ landed; parsed 2026-05-22 via `parse-ghidra-decompile.ts` | [[../docs/research/cookbook/vendor-envelope-descriptor-table]] |
| `DumpAxeEditIIIMiscDescriptors.java` | AxeEdit III | III caller-refs + 24 additional descriptor tables 0x1407aac70..0x1407abb60 | `ghidra-axe-edit-iii-misc-descriptors.txt` | ✅ landed; parsed 2026-05-22; **table 0x1407ab940 = 1024-ushort payload = III preset binary** | [[../docs/research/cookbook/vendor-envelope-descriptor-table]] |
| `DumpAxeEditIIIParamNames.java` | AxeEdit III | III param names | `ghidra-axe-edit-iii-paramnames.json` | ✅ landed | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `DumpAxeEditIIIParamTables.java` | AxeEdit III | III param tables (v1) | `ghidra-axe-edit-iii-paramtables.json` | 🟡 superseded by V2 |  |
| `DumpAxeEditIIIParamTablesV2.java` | AxeEdit III | III param tables (v2, refined) | `ghidra-axe-edit-iii-paramtables-v2.json` | ✅ landed | [[../docs/research/cookbook/param-descriptor-16byte]] |
| `DumpAxeEditIIIPatchParserDeep.java` | AxeEdit III | III patch-parser call graph (deep) | `ghidra-axe-edit-iii-patch-parsers.txt` (115 KB) | 🟡 output exists, un-mined | (transfer candidate: II alphabetical cascade) |
| `DumpAxeEditIIIPresetReceiver.java` | AxeEdit III | III preset-receiver flow (the III preset round-trip) | `ghidra-axe-edit-iii-preset-receiver.txt` (371 KB) | 🟡 output exists, contains III block-name cascade analog | [[../docs/research/cookbook/alphabetical-name-cascade-block-ordering]] (III transfer) |
| `DumpAxeEditIIIStorePresetFlow.java` | AxeEdit III | III store-preset flow (`FUN_140337060` + descriptor table 0x1407ab2f0) | `ghidra-axe-edit-iii-store-preset.txt` (81 KB) | 🟡 output exists, III hash function reachable here | [[../docs/research/cookbook/xor-fold-hash]] (III transfer) |
| `DumpAxeEditIIOpcodeTable.java` | AxeEdit (II) | II opcode table (94 fn-bytes) | `ghidra-axe-edit-iii-opcode-map.txt` | ✅ landed |  |
| `DumpAxeEditIIPresetDispatchHandlers.java` | AxeEdit (II) | II preset-dispatch handler table | `ghidra-axe-edit-preset-handlers.txt` | ✅ landed |  |
| `DumpAxeEditIISysExCore.java` | AxeEdit (II) | II SysEx core dispatch | `ghidra-axe-edit-sysex-core.txt` | ✅ landed |  |
| `DumpFooterHashCallContext.java` | AxeEdit (II) | Footer-hash call sites (cross-refs to `FUN_00544cc0`) | `ghidra-axeedit2-hash-call-ctx.txt` | ✅ landed | [[../docs/research/cookbook/xor-fold-hash]] |
| `DumpFractalEditorOpcodeTable.java` | Generic | Multi-binary opcode table dump (32-bit) |  | 🟡 misc |  |
| `DumpFractalEditorOpcodeTable64.java` | Generic | Multi-binary opcode table dump (64-bit) |  | 🟡 misc |  |
| `DumpMessageDirectory.java` | Generic | Message directory dump (older approach) |  | 🚫 superseded by Map*HostEmitters |  |
| `DumpMessageSchemas.java` | Generic | Message schema dump (older approach) |  | 🚫 superseded |  |
| `DumpResolverTables.java` | Generic | Resolver table dump |  | 🟡 misc |  |

## Find*: locate specific functions / data by pattern or xref

| Script | Target | Discovers | Output | Status |
|---|---|---|---|---|
| `FindAM4EditWorkflowCatalog.java` | AM4-Edit | AM4 workflow catalog (block copy/move/paste primitives) | `ghidra-am4-edit-workflow-catalog.txt` (586 KB) | 🟡 output exists; **fn=0x30 batch-param-set un-mined** |
| `FindAM4SysExBuilder.java` | AM4-Edit | AM4 SysEx builder functions | `ghidra-am4-edit-sysex-builders.txt` | ✅ landed |
| `FindAxeEditHeaderEmitters.java` | AxeEdit (II) | II envelope header emitters |  | ✅ landed |
| `FindAxeEditIIAllocCaller.java` / `FindAxeEditIIAllocPointer.java` / `FindAxeEditIIBlockAllocator.java` | AxeEdit (II) | II allocator-related discovery (chain) | `ghidra-axe-edit-alloc-*.txt`, `ghidra-axe-edit-block-allocator.txt` | ✅ landed |
| `FindAxeEditIIIBlockConnectEmitter.java` | AxeEdit III | III block-connect routing emitter | `ghidra-axe-edit-iii-block-connect.txt` | ⚠️ WRONG-PREMISE (2026-06-04): hunts `fn=0x33`, which is the INBOUND reply byte the Block-Connect workflow LISTENS for, not the emitted byte (routing is emitted as `fn=0x01 sub=0x35`). Returns 0 candidates. Superseded by `DecompileAxeEditIIIRoutingComposer.java`. |
| `DecompileAxeEditIIIRoutingComposer.java` | AxeEdit III | Decompiles the real routing path: executor `FUN_1401f4390` (state-machine, `case 0x35`) + fn=0x01 builder `FUN_14033ec70` + registrar `FUN_1401f0f10`; pinpoints the lone `0x35` immediate | `ghidra-axe-edit-iii-routing-composer.txt` (4,683 lines) | 🔴 landed 2026-06-04; NOT a quick win. `case 0x34/0x35/0x37` builds a message OBJECT (`param_1[0x475]`) via repeated `FUN_1402298a0(obj, typeCode, value)` field-appends, flushed by a later serializer; the shared tail `LAB_1401f4e9c` is only object teardown. `FUN_14033ec70` is a GENERIC septet serializer (packs caller-supplied fields). So the byte 21/22/23 arithmetic is NOT inline in any single function; it is distributed through the object-builder + its serializer, several fns deep with diminishing certainty. Conclusion: static recovery of the routing wire formula is NOT cheap (unlike flat param tables); the loopMIDI **capture route** (controlled-capture sweep) is the reliable closer. Don't re-attempt the static dive without a new lead. |
| `FindAxeEditIIIEnumPtrArray.java` | AxeEdit III | III enum pointer array | `ghidra-axe-edit-iii-enum-ptr-array.txt` | ✅ landed |
| `FindAxeEditIIIInboundDispatcher.java` | AxeEdit III | III inbound message dispatcher (response shapes) | `ghidra-axe-edit-iii-inbound-dispatcher.txt` (524 KB) | 🟡 output exists; **closes III GET 🟡 → 🟢; un-mined** |
| `FindAxeEditIIIRvaPointerArray.java` | AxeEdit III | III RVA pointer arrays | `ghidra-axe-edit-iii-rva-array.txt` | ✅ landed |
| `FindAxeEditIIISysexNamesIndirect.java` | AxeEdit III | III SysEx name resolution (indirect) |  | ✅ landed |
| `FindAxeEditIIOpcodeHandlers.java` | AxeEdit (II) | II per-fn-byte handler functions |  | ✅ landed |
| `FindAxeEditIIPresetParser.java` | AxeEdit (II) | II preset parser entry function |  | ✅ landed |
| `FindAM4EditPresetParser.java` | AM4-Edit | AM4 preset-binary parser entry via magic-immediate scoring (0x3040/0xC02/0x77/0x78/0x79) + 22 step-5 anchor offsets | `ghidra-am4-edit-preset-parser.txt` (~22k lines) | ✅ landed 2026-05-28; surfaced workflow registry FUN_1402d83d0 (not a direct parser; see [[iii-async-workflow-fn-registry]]) |
| `FindAM4EditFirmwareEmitter.java` | AM4-Edit | Searches AM4-Edit.exe for the firmware-emit wire path. Tests 4 anchors: 5-byte firmware header magic, 5-byte footer magic, 6-byte SysEx envelope `F0 00 01 74 15 7E` / `F0 00 01 74 15 7D`, and callers of the 4 mined SysEx envelope builders | `ghidra-am4-edit-firmware-emitter.txt` (~122 lines) | ✅ landed 2026-05-28; **NEGATIVE finding**: 0 hits on header magic, both envelope prefixes, and 3 of 4 SysEx builders have zero references. AM4-Edit.exe doesn't carry firmware-update wire bytes as compile-time constants |
| `ProbeAM4EditFractalBot.java` | AM4-Edit | Follow-up: is Fractal-Bot integrated into AM4-Edit.exe or shipped separately? Searches for 17 indicative strings ("Fractal-Bot", "FractalBot", "Firmware", etc.) + xrefs + whole-binary scan for functions carrying both 0xF0 + 0x7E immediates | `ghidra-am4-edit-fractal-bot-probe.txt` (~162 lines) | ✅ landed 2026-05-28; "Fractal-Bot" string xref'd from `FUN_14014c9d0` (a 6-product UI-skin dispatcher), proving Fractal-Bot is a UI MODE of the shared editor codebase rather than separate code |
| `DecompileAM4EditFirmwareEmitter.java` | AM4-Edit | Final pass: full decompile of the 7 candidates from FindAM4EditFirmwareEmitter + ProbeAM4EditFractalBot, searching for packing-loop signatures (`& 0x7f`, `<< 7`, 0x1E0 chunk-length constant) | `ghidra-am4-edit-firmware-emitter-decompile.txt` (94 KB / 2,877 lines) | ✅ landed 2026-05-28; **TERMINAL NEGATIVE**: zero packing-loop signatures across all 7 candidates. Both 0xF0+0x7E candidates decompile to JUCE UI rendering (FirmwareUpdateSkin paint code). Confirms no Fractal user-facing editor contains a firmware packer/unpacker: the packing is factory-only, the unpacker is in the device's boot loader. See [[_negative/editor-side-chunk-1-inner-decode]] refinement history 2026-05-28 |
| `FindAxeEditIISysExOpcodeTable.java` | AxeEdit (II) | II SysEx opcode table (94 fn-bytes) |  | ✅ landed |
| `FindAxeEditIIVtableUsers.java` | AxeEdit (II) | II vtable consumer functions | `ghidra-axe-edit-vtable-users.txt` | ✅ landed |
| `FindAxeEditRouting.java` | AxeEdit (II) | II routing emitter |  | ✅ landed |
| `FindEncoder.java` | Generic | Generic encoder-pattern discovery |  | 🟡 misc |
| `FindLabelSource.java` | Generic | JUCE BinaryData label source |  | ✅ superseded by [[../docs/research/cookbook/juce-binarydata-zip]] |
| `FindParamTable.java` | Generic | Param table discovery (early) |  | 🚫 superseded by SeekParamTables |
| `FindRoutingCaller.java` | Generic | Routing caller-site discovery |  | ✅ landed |

## Map* / Extract* / Associate* / Trace*: discover relationships

| Script | Target | Discovers | Output | Status |
|---|---|---|---|---|
| `MapAM4EditHostEmitters.java` | AM4-Edit | AM4 host-emit-able fn-byte → emitter function map | `ghidra-am4-edit-host-emitter-map.txt` | ✅ landed; reveals fn=0x30 batch-param-set (4 emitters) |
| `MapAM4EditWorkflowDispatch.java` | AM4-Edit | Three-anchor mining of the AM4-Edit workflow READ side: callers of FUN_1402d83d0, caller histogram of FUN_140196500, xrefs to "Get Preset Data" / "Save Preset" / etc. string literals | `ghidra-am4-edit-workflow-dispatch.txt` (~200 lines) | ✅ landed 2026-05-28; surfaced `AM4DeviceManager::vftable` reference in FUN_1402df090 ctor: root class name preserved by RTTI |
| `MapAxeEditIIIHostEmitters.java` | AxeEdit III | III fn-byte → emitter map (14-instruction window) | `ghidra-axe-edit-iii-host-emitter-map.txt` | 🟡 superseded by PreciseAxeEditIIIHostEmitters |
| `PreciseAxeEditIIIHostEmitters.java` | AxeEdit III | III fn-byte → emitter map (PcodeOp data-flow; 45 callers, 27 distinct fn-bytes with workflow labels) | `ghidra-axe-edit-iii-host-emitters-precise.txt` | ✅ landed |
| `AssociateAxeEditIIIFnByteWithName.java` | AxeEdit III | III fn-byte → name correlation | `ghidra-axe-edit-iii-fnbyte-name-map.txt` | ✅ landed |
| `ExtractVariantResolver.java` | AxeEdit (II) | II variant resolver tables |  | ✅ landed |
| `TraceAxeEditIIStateBuilders.java` | AxeEdit (II) | II state builder call graph (v1) |  | 🟡 superseded by V2 |
| `TraceAxeEditIIStateBuildersV2.java` | AxeEdit (II) | II state builder call graph (v2 refined) |  | ✅ landed |
| `TraceAxeEditIIIMessageBuilders.java` | AxeEdit III | III message builder call graph |  | ✅ landed |
| `TraceLoaderCallers.java` | Generic | Label loader caller-tracing (dead-end → superseded by JUCE BinaryData ZIP) |  | 🚫 superseded |

## Seek* / Probe* / Decode*: direct pattern scans + structure decoders

| Script | Target | Discovers | Output | Status |
|---|---|---|---|---|
| `SeekParamTables64.java` | Generic 64-bit | 64-bit ParamDescriptor table direct pattern scan |  | ✅ landed |
| `SeekParamTablesII.java` | AxeEdit (II 32-bit) | II ParamDescriptor table direct pattern scan: 1,113 (paramId, symbol) entries |  | ✅ landed (breakthrough) |
| `DecodeLabelLoader.java` | Generic | Label loader struct decode (early) |  | 🚫 superseded by JUCE BinaryData ZIP |
| `DecodeAxeEditIIOpcodeStruct.java` | AxeEdit (II) | II opcode struct (`name; wire_byte+1`) |  | ✅ landed |
| `DecodeAxeEditIIIDynamicActionCodes.java` | AxeEdit III | III dynamic action codes from caller-body local vars | `ghidra-axe-edit-iii-dynamic-action-codes-decode.txt` | 🟡 output exists, sub-actions partially mined |
| `DecodeAxeEditIIIDynamicEmits.java` | AxeEdit III | III dynamic-emit decode | `ghidra-axe-edit-iii-dynamic-emits-decode.txt` | 🟡 output exists, un-mined |
| `DecodeAxeEditIIINewFnBytes.java` | AxeEdit III | III previously-unseen fn-bytes | `ghidra-axe-edit-iii-new-fnbytes-decode.txt` (5679 lines) | 🟡 output exists, un-mined |
| `ProbeAxeEditIISysEx.java` | AxeEdit (II) | II SysEx-related symbol probe |  | ✅ landed |
| `ProbeBlockLayout.java` | AxeEdit (II) | II block-layout symbol probe |  | ✅ landed |
| `ProbeRdataStrings.java` | Generic | `.rdata` string-pool probe |  | ✅ landed |
| `ProbeSysexStringsGeneric.java` | Generic | SysEx-related string probe |  | ✅ landed |

---

## Naming conventions (when writing new scripts)

- `Mine<Target><Topic>.java`: walks symbol/.rdata/strings to recover a catalog
- `Dump<Target><Structure>.java`: serializes a known structure to text/JSON
- `Find<Target><Item>.java`: locates a specific function or data by pattern
- `Map<Target><Relationship>.java`: discovers a function→data or fn-byte→function relationship
- `Trace<Target><Topic>.java`: walks callers of a target function
- `Seek<Target><Item>.java`: direct-pattern byte scan
- `Decode<Target><Structure>.java`: parses a discovered binary structure into a higher-level type
- `Probe<Target><Topic>.java`: exploratory; for one-off discoveries before promoting to a Mine/Find script

Output files use lowercase-kebab-case under `samples/captured/decoded/`,
prefixed with `ghidra-<editor>-`. Example: `ghidra-axe-edit-iii-misc-descriptors.txt`.

## Output downstream: TS extractors

Once a Ghidra dump file lands in `samples/captured/decoded/`, a TS
extractor under `mcp-midi-control/scripts/_research/parse-*.ts` parses
it into structured JSON. The universal pattern (descriptor tables,
caller refs, function-to-data cross-refs) is implemented in
**`mcp-midi-control/scripts/_research/parse-ghidra-decompile.ts`**.
Specialized extractors (e.g. for the III actions-and-shapes file's
93 caller bodies with local-var assignments) can be written following
that pattern.

## Refinement history

- 2026-05-22 (initial registry): all 68 scripts enumerated, status
  flags added, cookbook cross-links populated. Synthesis-pass 2026-05-22
  identified ~10 of these scripts as having un-mined output sitting
  in `samples/captured/decoded/`; flagged `🟡 output exists` for those.
- v1.5 dump-extraction tier (plan §11): the headline TS extractor
  `parse-ghidra-decompile.ts` shipped 2026-05-22, validated against
  both III descriptor-table dump files. 26 III tables + 34 caller-refs
  extracted; III preset binary envelope shape confirmed at table
  `0x1407ab940` (1024 ushorts, byte-identical to II shape).
