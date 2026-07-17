---
name: per-effect-paramtable-dispatcher
class: dispatch-context
status: matched
discovered:  (initial III mining); 2026-05-22 (AM4 + III dispatcher cross-confirmed, primitive entry proposed)
verified_on:
  - axe-edit-iii-binary
  - am4-edit-binary
  - fm9-edit-binary
  - fm3-edit-binary
  - vp4-edit-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-per-effect-paramtable-dispatcher
relates_to: [param-descriptor-16byte, iii-multiproduct-editor-binary, vendor-envelope-descriptor-table, gen3-paramid-reuse-across-model-bytes]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axeedit3-paramtables-v2.txt (49 cases, 2216 entries, dispatcher FUN_140397a40)
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt (47 tables / 2105 entries via SeekParamTables64.java; 50 dispatcher cases / 1732 catalog pairs after name filtering, dispatcher FUN_1402e3da0)
  - fractal-midi/scripts/ghidra/DumpAxeEditIIIParamTablesV2.java
  - scripts/_research/scan-editor-param-tables.ts (direct PE pattern scan; reproduces III Ghidra paramIds 100% then mines FM9/FM3/VP4 binaries)
  - fractal-midi/docs/devices/am4/SYSEX-MAP.md (L2069-2090: cross-device dispatcher cmp table; L2079 explicit dispatcher fn-byte pair)
  - fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md (49-case enumeration with family names)
---

# Per-effect parameter-table dispatcher

A Fractal editor binary stores its parameter catalog as N per-effect
`ParamDescriptor` tables, selected at runtime by a switch dispatcher
keyed on effect-type index. `(effectTypeCase, perEffectParamId)` is the
addressing pair; paramIds are effect-type-LOCAL, not global.

This is the dispatcher LAYER above the underlying ParamDescriptor row
shape that [[param-descriptor-16byte]] documents. The struct primitive
says "this is the row shape"; the dispatcher primitive says "this is
how the editor SELECTS WHICH TABLE to read given an effect-type code".

## Formal definition

For a given effect-type case index `c`:

```
ParamDescriptor* table = dispatcher_switch(c);   // returns base pointer
int N = walk_until_terminator(table);            // stride 16, paramId == -1
ParamDescriptor row_i = table[i];                // for i in 0..N
```

The dispatcher is a single function (one per device editor binary)
whose body is a large `switch (effectType)` mapping each case to a
distinct `ParamDescriptor*` base pointer in `.rdata`. The terminator
mechanism is inherited from [[param-descriptor-16byte]].

## Where it's used

| | AM4-Edit | Axe-Edit III |
|---|---|---|
| Dispatcher fn | `FUN_1402e3da0` | `FUN_140397a40` |
| Effect-family cases | 50 (1..0x3c) | 49 (1..0x3b) |
| Total `(paramId, nameStr)` pairs | 1,732 (after null-name filter) | 2,216 raw |
| Unique paramIds | varies (block-local 10..N) | 426 unique |
| Per-block paramId convention | starts at 10 (block-base reserved) | starts at 0 (no block-base reservation) |

The AM4 and III dispatchers are byte-mechanically the same shape: a
switch keyed on effect-type case, each arm returning a 16-byte-stride
ParamDescriptor table. Per-table param counts vary by effect family.

Concrete sites (this dump + cross-references):

- III: `ghidra-axeedit3-paramtables-v2.txt` L1-6 header names
  `FUN_140397a40` explicitly. Cases 0x01..0x3B enumerated in the V2
  script's `CASE_TO_DAT` table (49 entries, gaps at 0x04, 0x06, 0x1B).
- AM4: `ghidra-am4edit-paramtables.txt` is the analog dump. Cross-
  device contrast table at `docs/devices/am4/SYSEX-MAP.md` L2077-2083.

## Per-device divergences

The dispatcher MECHANISM is identical; the encoded paramId conventions
diverge per device:

- **AM4** reserves paramIds 0..9 for cross-block shared / global
  fields; per-block tables start at paramId=10. Out-of-band families
  (PATCH, GLOBAL, OUTPUT) follow other conventions.
- **III** uses 0-based per-effect paramIds with no reserved-low-range.
  Most effect tables run 0..N sequentially; some interleave high
  paramIds (e.g. 175, 176, 177) for type-variant fields.

These are LOCAL conventions on top of the same dispatcher shape; the
primitive itself is the dispatcher, not the numbering convention.

## Applicability

When investigating an unknown Fractal device's parameter catalog, this
is the SECOND primitive to apply after [[param-descriptor-16byte]]:
once stride-16 ParamDescriptor tables are found in `.rdata`, locate
the dispatcher function that selects them by effect-type case. The
dispatcher's switch arms enumerate the device's effect-family
namespace at compile time.

Cost: ~30 minutes of Ghidra mining per editor binary (dispatcher fn is
typically a large switch with N constant pointer-immediate arms,
easily caught by either xref-from-paramtable-base or by walking the
known fn-byte handlers backward).

Returns: the full effect-family enumeration of the device, with
per-family paramId ranges.

## Misapplication failure modes

- **Same numeric paramId means different things in different effect
  types.** A consumer that lifts paramId=15 out of one table and
  assumes it works for another effect will write to the wrong field.
  The `(effectType, paramId)` pair is mandatory.
- **Some case numbers SHARE a single table.** Per the III V2 script
  source comments: case 0x29 is shared with 0x2a, 0x2b, 0x2c, 0x2d
  (one table serves 5 cases); case 0x2e is shared with 0x2f, 0x30,
  0x31 (one table serves 4 cases). 49 III cases resolve to 42 unique
  table pointers. Inventory math that assumes "N cases = N tables"
  will overcount.
- **Some arms are empty.** III case `0x3a` resolves to `DAT_1412bd7d0`
  with 0 params. Do not treat an empty arm as a missing table.
- **Per-block paramId conventions are not portable across devices.**
  AM4's "paramIds 0..9 reserved" rule does NOT apply to III. Per-
  device discriminator logic must consult the device's own
  convention; see [[am4-pidlow-register-families]] for the AM4 case.
- **paramId VALUES are not portable even within the same gen-3 codec
  family.** III/FM3/FM9/VP4 share the wire codec, but their paramId
  ordinals differ (FM9 18.6% / VP4 99.5% mis-address vs III). Mine each
  device's OWN binary; never reuse the III's paramIds.
  See [[gen3-paramid-reuse-across-model-bytes]].

## Where it does NOT apply

- Hydrasynth has no equivalent dispatcher (NRPN-based, no editor-
  binary catalog of this shape).
- The dispatcher addresses PARAMETER reads/writes; it is not the
  envelope-shape descriptor (that is
  [[vendor-envelope-descriptor-table]]).

## Verification path

`scripts/primitives-verify.ts#case-per-effect-paramtable-dispatcher`
checks:

1. III dump header L1-6 names `FUN_140397a40` as the dispatcher.
2. III dump summary block names ≥40 distinct tables and ≥2000 entries
   (positive lower bound on the dispatcher's effective table count).
3. AM4 dump exists at the documented consumed_in path (the AM4
   dispatcher analog).
4. AM4 SYSEX-MAP contains the cross-device dispatcher table at the
   referenced line range.

A future axis (II via `SeekParamTablesII.java`) would lift `verified_on`
to a third device family; II is the natural next axis since II ships
the same Fractal editor codebase.

## Direct PE pattern-scan (no Ghidra)

The same `{int32 paramId; int32 pad; char* nameStr}` rows can be
recovered without a Ghidra project, by treating the binary as data:

1. Parse the PE (imageBase + section table) so file-offset <-> virtual-
   address maps both ways.
2. Collect every param-symbol string (`[A-Z][A-Z0-9_]+` with a `_`,
   NUL-terminated) and record its VA.
3. Walk the file reading a u64 at each 4-aligned offset; when it equals
   a known symbol VA, read the int32 at `(offset - 8)` as the paramId.

`scripts/_research/scan-editor-param-tables.ts` implements this. It is
self-validating: run against `Axe-Edit III.exe` and it reproduces the
Ghidra `FUN_140397a40` paramIds at **100.00% (2216/2216)**. That control
makes the identical scan trustworthy on FM9/FM3/VP4 binaries, where no
Ghidra project exists. Cost: seconds per binary, no Ghidra setup. This
is the gen-3 analog of the II `SeekParamTablesII.java` direct-pattern
scan. Use it as the cheap first pass; reach for Ghidra only when the
dispatcher's case->family mapping (not just the rows) is needed.

## Refinement history

- 2026-05-22 (mining pass): Promoted to `matched` based on AM4 + III
  cross-axis evidence. The cross-device contrast table in
  `docs/devices/am4/SYSEX-MAP.md` L2077-2083 was the founder-side
  documentation of the same mechanism; this entry promotes it to a
  primitive. Mining report:
  `synthesis-log/mine-ghidra-axeedit3-paramtables-v2-2026-05-22-1822.md`.
- 2026-06-02: lifted `verified_on` to five axes (added FM9/FM3/VP4
  editor binaries) via the direct PE pattern scan above. Surfaced the
  measured finding that paramId VALUES are NOT portable across the gen-3
  family even though the codec is shared, split out as the negative
  primitive [[gen3-paramid-reuse-across-model-bytes]].
