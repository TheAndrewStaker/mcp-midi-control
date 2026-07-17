# Mine: ghidra-am4edit-envelope-descriptors.txt (2026-05-22 18:20)

**Target:** `samples/captured/decoded/ghidra-am4edit-envelope-descriptors.txt`
**Producer:** `SeekVendorEnvelopeDescriptorsAM4.java` (per header L1-8)
**Source binary:** `AM4-Edit.exe`, image base `0x140000000` (64-bit build)
**Output:** 54 candidate descriptor tables, post-nested-filter, all in `.rdata` at `0x1405dc190..0x1405dd160` (4048-byte cluster)
**Stride / sentinel:** 12-byte records, `(-1, -1, -1)` sentinel
**Heuristics:** first tag==0, tag step 0..1, mid in [4, 4096], byte_count in [1, 65536]

---

## 1. Instances of existing primitives

### [[vendor-envelope-descriptor-table]], headline match (AM4 axis point)

The entire dump is one large fixture for this primitive. AM4-Edit.exe carries
the **byte-identical** mechanism that the primitive entry already documents for
II and III:

- Stride-12 records `(int32 tag, int32 mid, int32 byte_count)` (header L4)
- `(-1, -1, -1)` sentinel termination (header L5; every table L41/L52/L62/.../L443)
- First record consistently `(tag=0, mid=6, ...)`, meaning the wire-offset
  count starts at 6, immediately after the 6-byte envelope prefix
  `F0 00 01 74 0x15 [fn]` (AM4 model byte `0x15` per CLAUDE.md AM4 quick facts).
  Same offset convention as II/III which use a 5-byte prefix + fn at offset 5.

**Where in the dump:** 54 tables, lines 33-443. Address range `0x1405dc190`
through `0x1405dd160` in the `.rdata` block `[140545000-1413acfff]`.

**Cross-device byte-count correspondences with III** (proves the same envelope
shapes recur across products, not just the table mechanism):

| `byte_count` | AM4 table(s)                            | III table (per existing entry / misc-descriptors JSON) |
|---|---|---|
| 3072 | `0x1405dcf40` (L389-394)                  | `0x1407ab940`, 1024 ushorts × 3 (byte-identical to II preset push body) |
| 1280 | `0x1405dc610` (L270-275), `0x1405dc640` (L277-282) | `0x1407ab0a0` |
| 768  | `0x1405dc9c0` (L305-310)                  | `0x1407ab440` |
| 192  | `0x1405dc190` (L214-219), `0x1405dc260` (L228-233), `0x1405dcfb0` (L396-401) | `0x1407aba40` |
| 160  | `0x1405dcea0` (L368-373), `0x1405dcf10` (L382-387) | `0x1407ab910` (function `0x140335000`) |
| 31   | `0x1405dcde8` (L361-366)                  | `0x1407ab8b0` (function `0x140336dd0`) |

All six AM4 tables in the column above carry the same 2-record shape
`(tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=N)` that the
III entries do (verified vs `ghidra-axe-edit-iii-misc-descriptors.descriptors.json`
L300-396). The "header ushort at offset 6, sized payload at offset 8"
shape is now confirmed on three devices.

**Snippet, AM4 0x1405dcf40, the 3072 fixture (L389-394):**

```
### Table @ 0x1405dcf40  (entries=2)
  idx | tag | mid (envelope offset) | byte_count (or units x bytes-per-unit)
    0 |   0 | 6                     | 2
    1 |   1 | 8                     | 3072
   -- | -1  | -1                    | -1   <-- SENTINEL
```

This 3072 is what makes a 64-bit AM4-Edit binary suspect of being a
multi-product editor: AM4's own working space (4 slots × ~30 params) is
far smaller than 1024 ushorts. See §2 candidate finding below for the
hypothesis to investigate.

**Snippet, AM4 0x1405dccf0, the longest table (entries=6, L33-42):**

```
### Table @ 0x1405dccf0  (entries=6)
    0 |   0 | 6                     | 1
    1 |   1 | 7                     | 1
    2 |   2 | 8                     | 1
    3 |   3 | 9                     | 1
    4 |   4 | 10                    | 1
    5 |   5 | 11                    | 1
   -- | -1  | -1                    | -1   <-- SENTINEL
```

A 6-byte payload broken into 6 single-byte fields. The `mid` column is
strictly monotonic and matches running `byte_count` accumulation,
confirming the "wire-offset from F0" interpretation in the primitive
entry's Formal definition.

**Consumed-in path to add to the existing entry:**

```
- fractal-midi/samples/captured/decoded/ghidra-am4edit-envelope-descriptors.txt
  (54 AM4 envelope descriptor tables; SeekVendorEnvelopeDescriptorsAM4.java
  output; address range 0x1405dc190..0x1405dd160; cross-device shape
  correspondence with III at 3072/1280/768/192/160/31 byte_count values)
```

**Status implication for the existing entry:**

The current `verified_on` lists `axe-fx-ii-q8.02`, `axe-fx-ii-q9.04`,
`axe-fx-iii-public-captures-v1.4`. Adding `am4-edit-binary` (the editor-binary
axis convention from [[param-descriptor-16byte]] post-2026-05-22) brings AM4
in as the third device-family axis. The entry's Refinement-history line
"AM4 transfer candidate filed in `STATE-AM4.md`" can be closed.

The entry's "Where it does NOT apply" section currently disclaims AM4 with
"AM4 editor binary descriptor tables not yet surveyed." That paragraph is
now stale and should be removed (primitives discipline: same-session refinement).

### [[xor-7f-envelope-checksum]], implicit instance, no new evidence

The descriptor entries describe the bytes BETWEEN the envelope prefix and
the checksum/F7 trailer. They do not themselves carry checksum information,
but every envelope they describe is wrapped by the universal `0x7F` XOR
checksum primitive (per `CLAUDE.md` AM4 quick facts). No new evidence in
this dump; mentioning only to acknowledge the relationship already encoded
in the existing entry's `relates_to`.

### Implicit relationship: [[septet-14bit]]

Every `byte_count = 2` field in the dump is a septet-encoded 14-bit value
(pidLow / pidHigh / action code / effect ID / preset number / tempo BPM /
location, per the project-wide rule in CLAUDE.md "Septet-encode every
14-bit field"). The dump contains dozens of `(_, _, 2)` records, all
implicit instances of [[septet-14bit]]. No new fixture needed; the
primitive is already `matched` and well-evidenced.

---

## 2. Candidate net-new primitives

### Candidate 2.1, none promoted

This dump is dense (54 tables) but every byte_count value, every record
shape, and every sentinel matches a structure the primitives corpus already names.
The dump is best treated as a third-axis-point refinement of
[[vendor-envelope-descriptor-table]], not as the discovery of a new
primitive.

The remainder of this section flags observations that **could** become
new primitives if follow-up work supplies the missing evidence. None
meet the bar to propose a frontmatter today.

### Observation 2.2, AM4-Edit may be a multi-product editor (HYPOTHESIS)

**Claim:** AM4-Edit.exe carries descriptor tables for devices other than
AM4 itself (Axe-Fx III / FM3 / FM9 / II family). This would make AM4-Edit
the second known multi-product Fractal editor binary alongside AxeEdit III
(see [[iii-multiproduct-editor-binary]]).

**Evidence (circumstantial):**

- 54 descriptor tables is far more than AM4's own functional surface
  needs. AM4 has 4 slots, 4 channels per block, 4 scenes, ~30 params per
  block, its envelope command set is small (`SYSEX-MAP.md` for AM4
  lists on the order of 10-15 fn-bytes total).
- The 3072-byte payload at `0x1405dcf40` matches the II preset-push body
  size **exactly** (1024 ushorts × 3 bytes/ushort septet) and the III
  `0x1407ab940` shape exactly. AM4's own preset cannot plausibly be
  1024 ushorts.
- Six distinct byte_count values (3072, 1280, 768, 192, 160, 31) recur
  byte-identically in the III misc-descriptors JSON. Independent
  collision on six numeric magnitudes simultaneously is unlikely.

**Counter-hypothesis:**

- The byte counts could coincide because AM4 and III share lower-level
  envelope conventions (e.g. a 64-ushort small-config field is 192
  bytes on any septet-packed device). In that case AM4-Edit only
  carries AM4 envelopes, and the shape collisions are emergent from
  shared encoding primitives rather than shared device support.
- The seeker's heuristics ("tag step 0..1, mid in [4, 4096], byte_count
  in [1, 65536]") are permissive. Some of the 54 candidates may be
  aligned-data false positives that happen to honor the (-1,-1,-1)
  sentinel by accident.

**Why not promote to a new primitive yet:** the claim is specifically
"AM4-Edit is multi-product." Proving it requires either (a) finding
the model-byte dispatch site in AM4-Edit (analog of III's
`DAT_1412633f8` from [[iii-multiproduct-editor-binary]]) or (b) wire
captures showing AM4-Edit emitting envelopes with non-AM4 model bytes.
Neither is in this dump.

**Search terms for follow-up:** `model byte` / `model_byte` /
`device_id` / `productId` in AM4-Edit.exe; chained-equality blocks of
the form `if (mb == 0x15) else if (mb == 0x10)` in any disasm of
AM4-Edit; presence of a JUCE BinaryData ZIP with names like
`AM4_blocks.xml` AND `III_blocks.xml` side-by-side.

**Proposed slug if confirmed:** `am4edit-multiproduct-editor-binary`
(analog of [[iii-multiproduct-editor-binary]]). Would relate to
[[vendor-envelope-descriptor-table]] and [[iii-multiproduct-editor-binary]].

### Observation 2.3, three-record `(1,1,N)` shape is a recurring AM4 command envelope

**Pattern:** records `(tag=0, mid=6, bc=1) + (tag=1, mid=7, bc=1) + (tag=2, mid=8, bc=N)`
appear in many AM4 tables. Examples (selected, L142-181):

- `0x1405dc8b0`: bc-final = 1 (3-byte payload, generic command)
- `0x1405dc990`: bc-final = 2 (4-byte payload)
- `0x1405dcb48`: bc-final = 32 (34-byte payload, plausibly preset name)
- `0x1405dcc30`: bc-final = 3 (5-byte payload)

The "two single-byte header fields then a variable-length payload"
shape is canonical command-envelope geometry. This is a sub-pattern of
[[vendor-envelope-descriptor-table]], not a separate primitive.

**Why not promote:** without caller-function cross-linking (this dump
has none, the file ends at line 443 with the summary, no
caller-refs section like the III misc-descriptors), there's no way to
bind these tables to specific fn-bytes. A primitive that names a
shape but cannot say which command uses it is too thin to register
as `matched-singleton`.

**Proposed follow-up:** re-run `SeekVendorEnvelopeDescriptorsAM4.java`
with caller-ref extraction enabled (analog of the III
misc-descriptors caller-refs section that was used to bind tables to
fn-byte families in [[vendor-envelope-descriptor-table]] L60-63).

### Observation 2.4, table at `0x1405dcb48` is a candidate preset-rename envelope

**Shape (L166-172):**

```
### Table @ 0x1405dcb48  (entries=3)
    0 |   0 | 6                     | 1
    1 |   1 | 7                     | 1
    2 |   2 | 8                     | 32
   -- | -1  | -1                    | -1   <-- SENTINEL
```

A 32-byte payload at envelope offset 8, prefixed by two single-byte
header fields. AM4 preset names are exactly 32 bytes (per CLAUDE.md
"Fractal terminology", Preset names are stored as fixed-width strings).
The shape strongly suggests "rename preset" or "name-this-thing"
envelope: 2-byte command/target header, then 32 ASCII bytes.

**Why not promote:** N=1 fixture, no caller-ref binding, no wire
capture. This is a hypothesis worth a probe, not a primitive. The
existing [[preset-name-ascii-triplets]] primitive (II, 32 × 3-byte
triplets) is the natural sibling but cannot generalize: AM4's 32-byte
field is 32 raw ASCII bytes, not 96 bytes of triplets, since AM4
envelopes are not septet-packed at the payload level the way II
preset binaries are.

---

## 3. Negative findings

### No new negatives.

This dump confirms the application of an existing primitive to a third
device. It does not rule any hypothesis out. The existing `_negative/`
entries that touch AM4 or descriptor-table mining (in particular
`byte-literal-envelope-ghidra-search.md` and `flat-int-stride4-param-table.md`)
remain valid and are not contradicted.

The dump also does not contradict the documented exclusions in the
existing [[vendor-envelope-descriptor-table]] entry's "Where it does
NOT apply" section other than the AM4 line itself (covered in §1
above, that exclusion is now stale and should be removed).

---

## Cross-cutting note on dump structure

`SeekVendorEnvelopeDescriptorsAM4.java` (header L1-8) is the AM4 sibling
of the II / III mining scripts already referenced by
[[vendor-envelope-descriptor-table]]'s `consumed_in` list. Promoting the
AM4 finding to the primitive entry should also add the AM4 mining
script's eventual path under `consumed_in:` once it lands in the
fractal-midi ghidra scripts directory.

The dump is descriptor-tables-only: no caller-function cross-linking
section. The III misc-descriptors file has both (descriptors AND
caller-refs), which is how the primitive entry could bind tables to fn-bytes
for III. Adding caller-ref extraction to the AM4 seeker is the highest-leverage
follow-up for binding these 54 tables to specific AM4 fn-bytes.

---

## Summary

- 1 strong refinement of existing primitive: [[vendor-envelope-descriptor-table]]
  picks up AM4 as a third axis (verified across editor binaries for II + III + AM4).
  The Refinement-history can record "AM4 transfer candidate closed" and the
  "Where it does NOT apply" AM4 paragraph can be removed.
- 0 net-new primitives proposed. 3 observations flagged that could
  become primitives with one more piece of evidence each (multi-product
  hypothesis, command-envelope sub-shapes, preset-rename envelope).
- 0 negative findings.
- Headline follow-up: run AM4 descriptor mining with caller-ref
  extraction to bind the 54 tables to fn-bytes, mirroring the III
  misc-descriptors caller-refs section.
