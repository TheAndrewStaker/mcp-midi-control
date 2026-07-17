# Primitives mine: `ghidra-axeedit3-paramtables-v2.txt`

Mining pass against `samples/captured/decoded/ghidra-axeedit3-paramtables-v2.txt`
(28,317 bytes, 468 lines) produced by `scripts/ghidra/dump-axeedit3-paramtables/DumpAxeEditIIIParamTablesV2.java`.

Header L1-6:

```
Axe-Edit III RE -- DumpAxeEditIIIParamTablesV2.java
  Per-effect parameter ID tables from FUN_140397a40 dispatcher,
  read with proper 16-byte struct stride and -1 terminator detection.
```

Summary block (L411-417):

```
Total distinct tables read: 49
Total parameter-ID entries (sum across all tables): 2216
Param-ID range observed: 0 .. 65530 (426 unique)
```

Primitives crosschecks performed against INDEX.md (35 entries) plus the
five most relevant per-entry reads ([[param-descriptor-16byte]],
[[vendor-envelope-descriptor-table]], [[iii-multiproduct-editor-binary]],
[[iii-host-emitter-fn-table]], [[block-record-stride-8]],
[[wire-id-pairs-per-placed-block]], [[xor-fold-hash]],
`_negative/flat-int-stride4-param-table.md`).

---

## 1. Instances of existing primitives

### 1.1 [[param-descriptor-16byte]], direct confirmation on AxeEdit III

The entire dump is a stride-16 walk of `ParamDescriptor` arrays in
AxeEdit III's `.rdata`. The mining script's own commentary L7-18 names
the struct as `{int32 paramId; int32 padding; void* metadata;}` (16
bytes total, 64-bit pointer), terminator `paramId == -1`, identical to
the canonical primitive definition.

Direct evidence inside the dump:
- L9 case 0x1 → `DAT_1412bc840`: 248 paramIds read at stride 16 before
  `-1` terminator.
- L25 metadata pointer for paramId=100 at `0x1407e4da8` (lives in the
  `0x1407......` `.rdata` string-heap window typical of editor-binary
  ParamDescriptor metadata regions).
- 49 distinct tables, 2,216 entries, all `-1`-terminated, all stride 16.

Notable: the III dump validates `param-descriptor-16byte` against a
THIRD `verified_on` axis (`axe-edit-iii-binary`) explicitly per the
script's V2 design note L7-18 (V1 had assumed 4-byte stride and got
garbage; V2 uses 16 and works). The existing `param-descriptor-16byte`
entry already lists `axe-edit-iii-binary` in `verified_on` so no axis
promotion is needed, but the dump path should be added to
`consumed_in:`.

**Proposed `consumed_in:` addition (founder action):**

```
- fractal-midi/samples/captured/decoded/ghidra-axeedit3-paramtables-v2.txt (49 tables / 2216 entries / 426 unique paramIds / stride-16 validated; FUN_140397a40 effect-type dispatcher)
- fractal-midi/scripts/ghidra/dump-axeedit3-paramtables/DumpAxeEditIIIParamTablesV2.java (V2 script that switched from 4-byte stride to 16-byte and fixed V1's garbage output; explicit negative-then-positive transition documented in the script header L7-18)
```

The V1 → V2 narrative also rein-validates the
`_negative/flat-int-stride4-param-table.md` entry: the script's own
header is an in-the-wild instance of an RE attempt that re-hit the
stride-4 mistake before correcting. Worth adding to that negative
entry's `consumed_in:` as a "stride-4 mistake encountered again
in-the-wild, recovered via stride-16 V2 rewrite" cite.

**Proposed `_negative/flat-int-stride4-param-table.md` consumed_in addition:**

```
- fractal-midi/scripts/ghidra/dump-axeedit3-paramtables/DumpAxeEditIIIParamTablesV2.java (V1 → V2 narrative L7-18 documents one more in-the-wild instance of the stride-4 mistake)
```

### 1.2 [[iii-multiproduct-editor-binary]], silently relevant context

The dump file does NOT exhibit per-model-byte dispatch within itself
(no chained-equality blocks visible; the script reads from a static
case-to-DAT table baked into the Ghidra script source L50-100). But
the dispatcher function `FUN_140397a40` lives in the III editor binary
which IS the multi-product editor per
[[iii-multiproduct-editor-binary]]. Any caller of `FUN_140397a40` that
varies the case index by model byte would inherit that primitive's
dispatch-context warning. No direct match-add to that entry, just a
"keep in mind" note for downstream consumers.

---

## 2. Candidate net-new primitives

### 2.1 Proposed: `iii-per-effect-paramtable-dispatcher`

This is the headline finding. The III editor's `FUN_140397a40` is a
switch statement mapping effect-type indices to per-effect
ParamDescriptor tables. The same dispatcher mechanism exists in
AM4-Edit's `FUN_1402e3da0` (cross-referenced in
`docs/devices/am4/SYSEX-MAP.md` L2069-2090) producing 50 cases / 1,732
paramId/name pairs. III dump in hand shows 49 cases / 2,216 paramId
entries.

This is the dispatcher LAYER, distinct from the underlying
ParamDescriptor struct that [[param-descriptor-16byte]] already
documents. The struct primitive says "this is the row shape"; the
dispatcher primitive says "this is how the editor SELECTS WHICH
TABLE to read given an effect-type code".

Proposed frontmatter (founder copies, edits, promotes):

```yaml
---
name: per-effect-paramtable-dispatcher
class: dispatch-context
status: matched
discovered: initial III mining; 2026-05-22 (AM4 + III dispatcher cross-confirmed, primitive entry proposed)
verified_on:
  - axe-edit-iii-binary
  - am4-edit-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-per-effect-paramtable-dispatcher
relates_to: [param-descriptor-16byte, iii-multiproduct-editor-binary, vendor-envelope-descriptor-table]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axeedit3-paramtables-v2.txt (49 cases, 2216 entries, dispatcher FUN_140397a40)
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt (50 cases, 1732 entries, dispatcher FUN_1402e3da0; per param-descriptor-16byte.md L17)
  - fractal-midi/scripts/ghidra/dump-axeedit3-paramtables/DumpAxeEditIIIParamTablesV2.java
  - fractal-midi/docs/devices/am4/SYSEX-MAP.md L2069-2090 (cross-device table contrast)
  - fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md L787-803 (49-case enumeration with family names)
---
```

**One-line summary:** A Fractal editor binary stores its parameter
catalog as N per-effect `ParamDescriptor` tables, selected at runtime
by a switch dispatcher keyed on effect-type index. `(effectTypeCase,
perEffectParamId)` is the addressing pair; paramIds are effect-type-
LOCAL, not global.

**Evidence (this dump):**

- L138 `FUN_140397a40` named explicitly in script header.
- L50-100 of `DumpAxeEditIIIParamTablesV2.java` lists 49 explicit
  `(caseIdx, virtualAddress)` pairs covering cases 0x01..0x3b minus
  the four explicit gaps (0x04, 0x06, 0x1b, and any > 0x3b).
- 49 distinct tables enumerated in the dump's "Per-table param counts"
  block L418-468.
- Per-effect-local paramId proof: case 0x2 starts at paramId=0 going
  sequential (L30-43); case 0x1 starts at paramId=100 (L9, L25); case
  0x39 starts at paramId=1285 (L395-399). The same numeric paramId
  resolves to a different metadata pointer per case.
- Metadata pointer for case 0x1 paramId=100 is `0x1407e4da8` (L25);
  metadata pointer for case 0x2 paramId=0 is `0x1407dc0e0` (L42).
  Different metadata for different (case, paramId) pairs, confirming
  the dispatcher is the disambiguator.

**N-fixture count: matched (N=2).**

Two distinct editor binaries (axe-edit-iii-binary + am4-edit-binary)
confirm the same dispatcher mechanism. Path-to-matched satisfied as
filed because [[param-descriptor-16byte]]'s `consumed_in:` already
includes the AM4 path
(`fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt`,
47 tables / 2105 entries, note: the AM4 SYSEX-MAP says 50 cases
producing 1,732 paramId/name pairs after `nameStr` filtering, vs
SeekParamTables64 raw count of 47 tables / 2,105 entries; the
discrepancy is null-name filtering, not a dispatcher disagreement).

Note: there is a third potential axis (`axe-edit-ii-binary`) that is
NOT yet listed. II's catalog mining via `SeekParamTablesII.java`
recovered 1,113 `(paramId, symbol)` entries per the existing
[[param-descriptor-16byte]] entry's L65-66, but the primitives corpus does not
yet name whether II uses a per-effect dispatcher of the same shape or
a single coherent catalog array. Resolving that adds a third axis and
hardens the primitive further. Filed as a follow-up Ghidra mining
target.

**Misapplication failure modes to call out in the body:**

- The same numeric paramId means different things in different effect
  types. A consumer that lifts paramId=15 out of one table and assumes
  it works for another effect will write to the wrong field. The
  (effectType, paramId) pair is mandatory.
- Some case numbers SHARE a single table (script L88-89: case 0x29 is
  shared with 0x2a, 0x2b, 0x2c, 0x2d; case 0x2e is shared with 0x2f,
  0x30, 0x31). The dispatcher arms are not strictly bijective; do not
  assume "N cases = N tables". 49 cases in this dump resolve to 42
  unique table pointers per the explicit script-source comments. This
  matters for inventory math (decode-progress claims) and for any
  code that walks the case set assuming unique tables.

**Path to additional verification:** Run an II Ghidra script with the
same case-walking shape against AxeEdit.exe; promote `verified_on`
when the III pattern is confirmed on the II binary.

### 2.2 Proposed: `iii-paramid-pseudo-sentinel-ranges`

Non-terminator high-value paramId values appear in the III per-effect
tables and function as in-list pseudo-entries, NOT as terminators.
Distinct from `0xFFFFFFFF` (-1) which IS the table terminator.

Observed ranges:

- `0xFFF0..0xFFFA` (65520..65530): block-end or inline markers,
  variable count
- `0xFF00..0xFF13` (65280..65299): a 20-element bank, only seen as a
  tail group on case 0x0b

Concrete sites in the dump:

- L41: case 0x2 ends with `65520 65521 65522 65523 65524 65525 65526
  65527 65528 65529 65530` (11 consecutive 0xFFF0+ entries appended to
  175 real paramIds)
- L103-104: case 0x0b ends with `65280 65281 65282 ... 65299` (20
  consecutive 0xFF00+ entries appended)
- L23: case 0x1 has `65520 65521 65522` inline among real paramIds
  (mid-table)
- L315-316: case 0x26 has `... 46 65520 47`, a single 0xFFF0 inserted
  between two real paramIds 46 and 47 (mid-table pseudo-entry)
- L357: case 0x33 ends with `... 21 65520 65521 65522 65523 65524`
- L389-390: case 0x38 ends with `... 1944 65520 65521 ... 65527 5648
  5649 5650 5651` (pseudo-entries embedded between real ID groups)
- L398: case 0x39 ends with `... 1331 1332 65520 65521 65522`

**Why this matters:** A future agent reading these tables WILL trip
on the `0xFFFx` values. They are negative shorts (`int16_t` cast) but
positive ints (`uint32_t`). If a mining script (or a consumer parser)
treats `paramId & 0xFFFF == 0xFFFx` as "end of meaningful data" it
will TRUNCATE legitimate entries that come after. Worse, if a
consumer maps `paramId & 0xFFFF` into a global table the pseudo-
entries collide.

The terminator is strictly `paramId == 0xFFFFFFFF` (full 32-bit). The
script's `readIntLE` returns `paramId == -1` only at the true
terminator (L167); the pseudo-entries read as positive 32-bit
integers `0x0000FFF0..0x0000FFFA` and the loop continues correctly.

**Hypothesis on semantics (not yet confirmed):**

- The `0xFFF0..0xFFFA` cluster likely represents UI / browser
  separators or category-group markers per the editor's parameter
  browser. The fact that they appear at table-end (with the real
  paramIds first) and occasionally mid-table is consistent with
  "after this comes a group of pseudo-knobs" or "this position
  reserves a UI label not bound to a knob".
- The 20-entry `0xFF00..0xFF13` block in case 0x0b (CABINET, 126
  params) suggests cab-bank UI placeholders (cabinet selection
  options or factory-IR slots). Verifying that needs a peek at
  the metadata pointers for those entries (the script dumps the
  FIRST metadata ptr only).

This is candidate `matched-singleton` because the III dump is the only
fixture; the AM4 catalog dump shows no analogous `0xFFFx` cluster per
SYSEX-MAP L2080 ("Total paramId/name pairs: AM4 1,732"). If AM4 also
has these pseudo-entries they were filtered out before counting; an
AM4 re-mine that preserves the raw stride-16 walk (analog of this V2
script) could resolve the axis.

Proposed frontmatter:

```yaml
---
name: iii-paramid-pseudo-sentinel-ranges
class: struct-layout
status: matched-singleton
discovered: 2026-05-22 (primitives mine of ghidra-axeedit3-paramtables-v2.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-iii-paramid-pseudo-sentinel-ranges
relates_to: [param-descriptor-16byte, per-effect-paramtable-dispatcher]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axeedit3-paramtables-v2.txt
---
```

**One-line summary:** Inside III per-effect ParamDescriptor tables,
paramIds in `0xFF00..0xFFFE` are non-terminator pseudo-entries (UI
separators / placeholders); only `0xFFFFFFFF` is the true terminator.

**N=1 path-to-matched:** Re-mine AM4 with the same script shape
preserving 0xFFFx entries (current AM4 mine reports 1,732 pairs which
suggests filtering); cross-confirm whether AM4 dispatcher tables carry
the same pseudo-entries.

### 2.3 Proposed: `iii-effect-type-case-vocabulary`

The III dispatcher's case-index space is a sparse subset of
`0x01..0x3B` with explicit gaps at `0x04`, `0x06`, `0x1B`. Some cases
share tables (per the script source comments):

| Case index group | Shared table at | Notes |
|---|---|---|
| `0x29, 0x2a, 0x2b, 0x2c, 0x2d` | `DAT_1412c16e0` | One table serves 5 cases |
| `0x2e, 0x2f, 0x30, 0x31` | `DAT_1412c4b00` | One table serves 4 cases |

Plus a notable empty arm: case `0x3a` resolves to `DAT_1412bd7d0`
with 0 params (L402-403 of the dump).

**Why this might or might not deserve a primitive entry:**

This is descriptor-table-shaped data (a 49-row enumeration), so it
could be a primitive, but more naturally it's the body of the
`per-effect-paramtable-dispatcher` primitive (§2.1) as its concrete
fixture. I'd lean against a separate primitive entry; instead the
49-case enumeration should be documented inside §2.1's body or
referenced via `docs/devices/axe-fx-iii/SYSEX-MAP.md` L787-803 which
already names the family-string-per-case.

**Recommendation:** Do NOT promote this as a separate primitive. Fold
the shared-arms observation and the empty-arm observation into §2.1's
"Misapplication failure modes" section.

---

## 3. Negative findings

### 3.1 No new negatives from this dump

The dump exercises the positive [[param-descriptor-16byte]] primitive
on III; it does not falsify any hypothesis. The script's V1 → V2
narrative (header L7-18) is itself a re-confirmation of the existing
[[_negative/flat-int-stride4-param-table]] entry (V1 used stride-4 and
got garbage; V2 fixed by switching to stride-16). That's worth folding
into the existing negative entry's `consumed_in:` as a third in-the-
wild instance of the stride-4 mistake, but no NEW negative is needed.

### 3.2 Search terms a future agent should grep first

To avoid re-attempting work already covered by this dump:

- "III param table" / "AxeEdit III paramtable" → `param-descriptor-16byte.md`
  → this dump
- "FUN_140397a40" → III dispatcher; this dump + `docs/devices/axe-fx-iii/SYSEX-MAP.md`
  L787-803
- "FUN_1402e3da0" → AM4 dispatcher; `docs/devices/am4/SYSEX-MAP.md` L2079
- "per-effect paramId" → §2.1 here; primary doc target after founder
  promotion
- "0xFFF0 paramId" / "65520 paramId sentinel" → §2.2 here
- "case 0x3a empty" → §2.3 here (and §2.1 misapplication notes if
  promoted)

---

## 4. Action checklist for the founder

If this report converts to primitives changes, three independent
actions (each is reversible; none is automated by the agent):

1. **Promote §2.1** to a new primitive entry
   `primitives/per-effect-paramtable-dispatcher.md` with the frontmatter
   above. Add a golden case in `scripts/primitives-verify.ts` that
   asserts (a) `FUN_140397a40` named in the III dump's L138, (b) 49
   cases reflected in the script's `CASE_TO_DAT` L50-100, (c) the
   parallel AM4 dispatcher claim in `docs/devices/am4/SYSEX-MAP.md`
   L2079. Probably a STUB-shaped golden (consumed_in path existence
   + line-ref check), like `iii-multiproduct-editor-binary`.

2. **Promote §2.2** as `matched-singleton` to
   `primitives/iii-paramid-pseudo-sentinel-ranges.md`. Golden: parse the
   dump, assert ≥3 distinct `0xFFFx` entries appear in non-terminator
   position. Document the AM4 re-mine plan as the
   `path-to-matched` body.

3. **Append `consumed_in:` lines** to:
   - `primitives/param-descriptor-16byte.md` (dump + V2 script paths
     per §1.1).
   - `primitives/_negative/flat-int-stride4-param-table.md` (V2 script
     as third in-the-wild instance per §1.1).

Action 3 is the lowest-cost; do first.

---

## 5. Sizing for context

Findings tier: 1 large new primitive (§2.1, axes = III + AM4, ready
for `matched`), 1 medium singleton (§2.2, novel and useful, candidate
`matched-singleton`), 1 instance match-add (§1.1, two lines into
existing entry). Total primitives deltas if all promoted: +2 new
primitives, +3 `consumed_in:` lines distributed across 2 existing
entries. No negative-primitives deltas.

Highest payoff if only one is taken: §2.1 promotion. It encodes the
canonical "given an effect type, give me its param table" mechanism
that applies to AM4, III, and very likely II, and that all three
existing per-device decode pipelines already rely on without
referencing as a primitive. Future mining sessions and
extraction scripts (per the fractal-midi extraction plan) gain a
shared vocabulary.
