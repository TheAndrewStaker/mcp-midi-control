---
name: ii-axeedit-opcode-table
class: fn-byte-mapping
status: matched-singleton
discovered:  (2026-05-20; Ghidra mining of Axe-Edit.exe)
verified_on:
  - axe-edit-ii-binary
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: docs/devices/axe-fx-ii/axeedit-opcode-table.md + the FUNC_* constants in src/gen2/axe-fx-ii)
relates_to: [param-descriptor-16byte, vendor-envelope-descriptor-table]
consumed_in:
  - fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md
  - fractal-midi/scripts/ghidra/DumpAxeEditIIOpcodeTable.java
---

# Axe-Fx II AxeEdit opcode table (static `.rdata` struct)

`Axe-Edit.exe` (the 32-bit JUCE editor binary for Axe-Fx II) carries a
static `OpcodeDescriptor` struct array in its `.rdata` section that
enumerates the full SysEx wire vocabulary, indexed by an internal enum
value. Mining the table yields 94 named opcodes plus the algebraic
`wire byte = enum value - 1` relationship that maps the enum back to
on-the-wire bytes.

This is the AxeEdit II analog of vendor-envelope-descriptor-table:
descriptor-table mining recovers wire shape; this primitive recovers
wire opcode identity.

## Formal definition

Each row of the `.rdata` table is an 8-byte struct:

```c
struct OpcodeDescriptor {
  const char* name;        // 4-byte pointer into .rdata strings
  uint32_t    enum_value;  // 1-indexed; wire_byte = enum_value - 1
};
```

The array is terminated by a sentinel record with `name == NULL`. 94
records were recovered via `DumpAxeEditIIOpcodeTable.java`.

## Where it's used

Every II SysEx wire byte the host emits or the device emits corresponds
to one of these 94 entries. Pre-Session-103 work guessed opcodes from
wiki tables; this primitive supplies them from the editor binary itself,
which is the source of truth for what AxeEdit sends and parses.

15+ wire bytes have been live-captured on Q8.02 (see the table at
`fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md` lines
18-40). Every captured wire byte equals `enum_value - 1` for its named
opcode, confirming the -1 offset is universal across the table.

## Misapplication failure modes

- **DO NOT** read the `enum_value` field as the wire byte directly. The
  enum is 1-indexed from a different origin than the wire-byte counter;
  AxeEdit's enum starts at 1 with `SYSEX_NULL` while the wire-byte
  counter starts at 0. Wire byte is always `enum_value - 1`.
- **DO NOT** trust the wiki opcode table when it disagrees with the
  binary. Several wiki entries had wrong opcodes (or missing entries)
  before  disambiguated them.
- **DO NOT** assume the table generalizes to AxeEdit III without
  cross-mining. III's analog is [[iii-host-emitter-fn-table]] (V4,
  smaller corpus); the III binary uses a different struct layout for
  its host-emitter map and has different name strings.

## Where it does NOT apply

- AM4 (use `fractal-midi/src/am4/setParam.ts` FN_* constants; AM4 editor
  binary mining is a separate primitive).
- Axe-Fx III (use [[iii-host-emitter-fn-table]]).
- Hydrasynth (different vendor protocol entirely; see
  [[hydra-sysex-envelope-base64-crc32]]).

## Verification path

No inline fixture ships (golden is STUB). The de-facto invariant is that
the documented 94-entry table is consistent with the live-captured
opcode set in `fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md`
and that every shipped `FUNC_*` constant in
`fractal-midi/src/gen2/axe-fx-ii/setParam.ts` matches an enum entry minus 1.

When the AxeEdit binary refreshes, re-run
`DumpAxeEditIIOpcodeTable.java` and diff the output against the
committed table. The header docstring in the table file explicitly
forbids hand-editing for this reason.

## Refinement history

- 2026-05-20: table mined from `Axe-Edit.exe` via
  `DumpAxeEditIIOpcodeTable.java`. 94 entries indexed; `wire = enum - 1`
  offset confirmed against 15+ live-captured opcodes on Q8.02.
- 2026-05-22 (Rosetta-stone primitives audit): promoted to
  primitive. The opcode-table doc existed pre-Session-117 but the
  mechanism ("static OpcodeDescriptor struct in editor `.rdata`") was
  not promoted to a primitive until the audit; the III analog
  [[iii-host-emitter-fn-table]] uses the same mining strategy.
