---
name: param-descriptor-16byte
class: struct-layout
status: matched
discovered: 
verified_on:
  - axe-edit-ii-binary
  - axe-edit-iii-binary
  - am4-edit-binary
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-per-effect-paramtable-dispatcher (validates the same stride-16 descriptor tables against the mined dumps)
relates_to: []
consumed_in:
  - fractal-midi/scripts/ghidra/MineAxeEditIIParamResolver.java
  - fractal-midi/scripts/ghidra/MineAxeEditIII.java
  - fractal-midi/scripts/ghidra/MineAM4EditParamResolver.java
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt (SeekParamTables64.java mining of AM4-Edit.exe; 47 tables / 2105 entries / 1894 unique symbols / stride-16 validated)
  - fractal-midi/samples/captured/decoded/ghidra-axeedit3-paramtables-v2.txt (DumpAxeEditIIIParamTablesV2 against Axe-Edit III.exe; 49 tables / 2216 entries / 426 unique paramIds / stride-16 validated against FUN_140397a40 dispatcher)
  - fractal-midi/scripts/ghidra/DumpAxeEditIIIParamTablesV2.java (V2 script that switched from 4-byte stride to 16-byte; explicit negative-then-positive transition documented in script header L7-18; in-the-wild instance of the stride-4 mistake corrected by stride-16 rewrite)
---

# ParamDescriptor 16-byte struct layout

Fractal editor binaries store their parameter catalog as an array of
16-byte ParamDescriptor structs in `.rdata`.

## Formal definition

```
struct ParamDescriptor {
  uint32  paramId;     // +0  (4 bytes)
  uint32  reserved_4;  // +4  (typically flags or unused)
  void*   namePtr;     // +8  (8 bytes on 64-bit, 4+pad on 32-bit)
  uint32  reserved_C;  // +C
};
```

Total stride: 16 bytes (32-bit builds use the same stride with padding).
Termination: `paramId = 0xFFFFFFFF` (-1 as signed) sentinel.

## Where it's used

ParamId → name resolution in all three editor binaries (AM4-Edit,
AxeEdit, AxeEdit III). Mined via headless Ghidra scripts in
`fractal-midi/scripts/ghidra/`.

## Misapplication failure modes

- **DO NOT** stride by 4; that's the  bug. Stride-by-4
  produces garbage (interprets the name pointer field as a paramId).
  Use stride 16.
- **DO NOT** assume `namePtr` points to a null-terminated C string in
  all cases; some entries are JUCE BinaryData ZIP references (see
  [[juce-binarydata-zip]]) which require a different resolver.

## Verification path

`scripts/cookbook-verify.ts#case-per-effect-paramtable-dispatcher`
validates the stride-16 descriptor tables (entry counts + dispatcher
cite) against the mined dumps from the editor binaries.
Cross-referenced with `verify-msg.ts` goldens.

## Refinement history

- : stride-by-4 ruled out (negative finding). Stride-by-16
  confirmed across AM4 + II + III binaries.
- : II 32-bit binary used `SeekParamTablesII.java` direct
  pattern scan to recover 1,113 (paramId, symbol) entries at 99%
  indexed-symbol coverage.
- 2026-05-22 (Rosetta-stone cookbook audit): `verified_on` axis tags
  corrected from firmware revs (`axe-fx-ii-q8.02`, `am4-fw18`, etc.)
  to editor-binary revs (`axe-edit-ii-binary`, `am4-edit-binary`,
  `axe-edit-iii-binary`). The primitive is verified against editor
  binaries (which carry the static table in `.rdata`), not against
  device firmware images. Mirrors the axis-tag convention already
  in [[juce-binarydata-zip]].
