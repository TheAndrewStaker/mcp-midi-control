# AxeEdit II, Binary Anatomy

Class architecture, key functions, and RVA constants discovered in the
AxeEdit (II 32-bit) binary. This doc hosts findings that **support**
primitives but aren't primitives themselves, anatomy of the
binary, not encoding rules.

When a primitive cites a function or RVA from this binary, it
links here for the structural context. When new RE work finds new
class architecture, it lands here (not in primitive entries, keep
those focused on the WHAT of the encoding, not the WHERE in the
binary).

Ghidra project: a local Axe-Edit (II generation) Ghidra project (auto-analyzed,
persistent, DO NOT delete; orphans all II scripts in
`scripts/ghidra/`).

---

## Class architecture

### `AEImageDepot`, preset binary builder/parser

The class responsible for serializing + deserializing the II preset
binary (the body of fn 0x77/0x78/0x79 envelope).

| Symbol | Address | Role |
|---|---|---|
| `AEImageDepot::vftable` | `0xeacff8` (`.rdata`) | Virtual function table (~14 methods) |
| `DAT_00f8bb58` |, | Singleton instance |
| `FUN_004116d0` |, | Constructor |
| `FUN_00595260` | vftable slot 1 | **The alphabetical-cascade block ordering function** ([[../primitives/alphabetical-name-cascade-block-ordering]]). Iterates placed-blocks array, emits per-block wire-ids via `FUN_00406350`. |
| `FUN_00406350` |, | Append-ushort-to-list helper (called by `FUN_00595260` to emit wire-ids) |

Block-name cross-references (per `FUN_00595260` disassembly):

| Symbol | Block-name → wire-ids |
|---|---|
| `DAT_007153e4` | Amp → 106, 107 |
| `DAT_007153e8` | Cab → 108, 109 |
| ... | (full table in [[../primitives/wire-id-pairs-per-placed-block]]) |
| `DAT_00715428` | (uncertain, see "Refinement history" below) |

---

## Key functions

### `FUN_00544cc0`, XOR-fold hash (preset binary footer)

Trivial 16-bit XOR-fold of decoded native ushorts. Returns the hash
that lands in the footer field of fn 0x79. 17 lines of disassembly;
no surprises. See [[../primitives/xor-fold-hash]] for the formal
definition.

### `FUN_0054d1d0`, fn 0x79 footer parser (calls `FUN_00544cc0`)

The footer-parse entry. Reads the descriptor table at `0xdff900`,
walks the footer payload field-by-field, calls `FUN_00544cc0` to
compute the expected hash, compares against the received hash. NACK
on mismatch.

### `FUN_00513184`, preset binary buffer walk

Walks the descriptor table at `0xe04440` and accumulates byte counts
across the chunk fields. Analog of the III store-preset emitter
`FUN_140337060` (which walks descriptor table `0x1407ab2f0`).

---

## RVA constants ( `.rdata` ): descriptor tables

II envelope-spec descriptor tables. Each declares the wire-field
layout of one envelope family. Shape: `(tag, mid, byte_count)` triples
terminated by `(-1, -1, -1)` sentinel, see
[[../primitives/vendor-envelope-descriptor-table]].

| Address | Purpose | Shape |
|---|---|---|
| `0xe04440` | Preset push chunk envelope | `(0, 6, 2) + (1, 8, 3072)` → 1024 ushorts × 3 bytes/ushort septet |
| `0xdff900` | Preset push footer envelope | `(0, 6, 3)` → 3-byte payload (the XOR-fold hash output) |

(More descriptor tables likely exist for other fn-bytes, `DumpAxeEditIIChunkDescriptorTables.java` discovered the calling
patterns; a misc-descriptors variant for II would surface the full
set the way the III misc-descriptors did.)

---

## Param descriptor table

II uses the 16-byte ParamDescriptor struct per
[[../primitives/param-descriptor-16byte]]. The II 32-bit binary table
was recovered via `SeekParamTablesII.java` ( direct-pattern
scan technique): 1,113 (paramId, symbol) entries at 99%
indexed-symbol coverage.

---

## What's still un-mined (open RE targets)

- **Full preset-binary descriptor-table inventory.** Only chunk + footer
  descriptors mined; other II fn-bytes (fn 0x05 SET_GRID_CELL, fn 0x14
  GET_PRESET_NUMBER, etc.) presumably have descriptor tables too. A
  `DumpAxeEditIIMiscDescriptors.java` (analog of the III version) would
  close this in one Ghidra run.
- **The "compute preset binary size from placed blocks" function.**
  Hypothesized to contain the per-block-name WIDTH table that would
  generalize [[../primitives/parambase-plus-paramid]] from `partial-N1`
  → `matched`. ** ruled this out**: the encoder lives
  in firmware, not in AxeEdit.exe. The AxeEdit binary only CONSUMES
  the device-encoded output; full sort-algorithm crack requires
  firmware analysis (separate, deeper effort).
- **Inbound dispatcher table.** Analog of the III inbound dispatcher;
  closes II response-shape decode for any fn-byte we don't already
  understand.

---

## Refinement history

- : `param-descriptor-16byte` stride bug discovered + fixed
  (stride-by-4 → stride-by-16). Direct-pattern scan technique
  established (`SeekParamTables*.java`).
- : `SeekParamTablesII.java` direct-pattern scan recovers
  1,113 entries at 99% indexed-symbol coverage. 470 new params
  unlocked (entire VOCODER/RESONATOR/MOD blocks become mineable).
- : II opcode table recovered via
  `DumpAxeEditIIOpcodeTable.java`, 94 wire opcodes.
- : `FUN_00544cc0` decoded as XOR-fold hash. Bug fix on
  byte-2-mask preservation ([[../primitives/septet-21bit-byte2-mask-preservation]]).
-  cont: `AEImageDepot` vtable +
  `FUN_00595260` cascade decoded. Block-name → wire-id table extracted
  (36 rows). Wiki-vs-binary corrections surfaced (block IDs 164-169
  mislabeled: should be Filter 3/4, VolPan 2-4, Looper). Ghidra Path B
  for the "compute binary size" function explicitly ruled out,   encoder is in firmware.
