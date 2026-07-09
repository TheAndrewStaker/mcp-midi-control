---
name: flat-int-stride4-param-table
class: struct-layout
status: non-matching
discovered:  (II param-table layout)
verified_on:
  - axe-edit-ii-32bit
  - axe-edit-iii-1.40
  - am4-edit-1.x
firmware_sensitive: false
golden: STUB (structural-only; negative finding, the positive stride-16 layout is exercised by scripts/cookbook-verify.ts#case-per-effect-paramtable-dispatcher; see Symptoms / grep terms)
retest_when: never (structural: the real layout is the 16-byte ParamDescriptor, param-descriptor-16byte, verified across 3 editor binaries; stride-4 reads pointer fragments by construction)
relates_to: [param-descriptor-16byte]
consumed_in:
  - fractal-midi/scripts/ghidra/DumpAxeEditIIIParamTablesV2.java (script header L7-18 documents one more in-the-wild instance of the stride-4 mistake: V1 used stride-4 and got garbage, V2 fixed by switching to stride-16; "The DAT_xxx tables aren't `-1`-terminated int arrays - they're arrays of 16-byte structs")
---

# Param table as flat `-1`-terminated `int` array: does NOT work

A natural mining plan for recovering the editor's param table is:
locate the `.rdata` section holding paramIds, treat it as a flat
`int[]` terminated by `-1`, stride by 4 bytes, read paramId at each
offset. It does NOT work and produces garbage.

## Why it fails

The structure is a 16-byte `ParamDescriptor` per entry, not a 4-byte
`int`. See [[param-descriptor-16byte]] for the positive primitive.
Layout:

    offset  size  field
    +0      4     paramId        (uint32)
    +4      4     reserved / flags
    +8      8     name pointer   (char* into .rdata string heap)

Stride-by-4 reads `paramId` correctly at offset 0 but then steps to
the middle of the same descriptor's flags / pointer-low-bytes,
treating those as the next paramId. The result is a 4×-oversized
list of meaningless 32-bit words including pointer fragments and
zero-padding. The `-1` sentinel only appears at the end of the real
16-byte stride.

## Why this matters

Two RE sessions burned time on the flat-int interpretation before
 disassembled the consumer function and recovered the
16-byte stride from the descriptor's load pattern (`MOV EAX, [ESI]`
for paramId, `MOV ECX, [ESI+8]` for name pointer, `ADD ESI, 0x10`
for the iteration).  re-confirmed the same layout against
the 32-bit AxeEdit II binary via `SeekParamTablesII.java`, recovering
1,113 `(paramId, symbol)` entries at 99% indexed-symbol coverage.

## What works instead

[[param-descriptor-16byte]] is the canonical positive primitive,
verified across AM4-Edit / AxeEdit II / AxeEdit III.

## What this does NOT rule out

- Stride-by-4 over genuinely flat `int[]` tables (e.g. enum-value
  tables, fn-byte permission masks). The negative is specific to
  the `ParamDescriptor` array.
- Other editor binaries from other vendors. The 16-byte stride is
  Fractal-specific and may differ on non-Fractal devices.

## Symptoms / grep terms

Search these before re-attempting:

- "param table flat int array" / "-1-terminated paramId array"
- "stride-by-4 garbage paramIds" / "pointer fragments as paramIds"
- "16-byte ParamDescriptor" (the positive primitive that replaces this)

## Refinement history

- 2026-05-22 (cookbook backfill): negative finding registered after
   dispatcher walk and  II re-confirmation.
