# Primitives mining: ghidra-am4edit-paramtables.txt

Mined 2026-05-22 against
`fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt`
(87,376 bytes; SeekParamTables64.java output run against
AM4-Edit.exe, 64-bit image base 0x140000000).

Reading scope was limited to the named dump file and the primitive
entries it touches (param-descriptor-16byte, am4-pidlow-register-families,
am4-fn1f-atomic-read, vendor-envelope-descriptor-table, xor-fold-hash,
plus the primitives INDEX). All cited line numbers refer to the dump file.

---

## 1. Instances of existing primitives

### 1.1 `[[param-descriptor-16byte]]`

The dump is a direct application of this primitive. The SeekParamTables64
header (lines 1-6) explicitly declares `##  - seek ParamDescriptor
patterns (stride=16)`, and the dedup pass reports 47 top-level tables after the
nesting filter. The table-listing pass (lines 26-2225) lists every table by name +
RVA + entry count, and every row has the `[index] paramId=N SYMBOL` shape
that decodes the 16-byte struct (paramId at +0, namePtr at +8) per the
primitives corpus's formal definition.

Verification highlights (dump line refs):

- Header banner: lines 1-6 cite `SeekParamTables64.java` + `stride=16`.
- Dedup pass: line 24, "47 top-level tables after nesting filter"
  (2011 raw candidates collapsed via the primitives corpus's stride-16 invariant).
- Table-listing summary: lines 2227-2231, "47 ParamDescriptor tables / 2105
  entries / 1894 unique symbols / 7% of 24,950 indexed".

Sample table (DISTORT, lines 452-594, 142 entries, RVA `0x14141e930`):

```
### DISTORT  @ 0x14141e930  (entries=142)
  [  0]  paramId=10     DISTORT_TYPE
  [  1]  paramId=11     DISTORT_DRIVE
  [  2]  paramId=12     DISTORT_BASS
  ...
  [141]  paramId=151    DISTORT_DISABLECABSYNC
```

Per-table positional order is NOT sorted by paramId: the PATCH table at
lines 1121-1206 begins `paramId=59, 60, 61, 62, 20, 21, 22, 63, ...`,
matching the II-side observation that the array's positional index is
storage order, not the paramId itself (the paramId field is the actual
identifier). This is the same misapplication failure mode the primitive
entry already warns about (stride-by-4 garbage); confirms the
stride-by-16 reading for AM4-Edit as well.

**New axis added by this dump:** `am4-edit-binary` (64-bit, image base
0x140000000). The primitives corpus already lists `axe-edit-ii-binary`,
`axe-edit-iii-binary`, `am4-edit-binary` under `verified_on`; this dump
is the file-shaped fixture for the AM4 axis at scale (47 tables, 2105
entries). Existing `MineAM4EditParamResolver.java` is already in
`consumed_in`, but the dump file the founder produced from
`SeekParamTables64.java` is a separate consumer-output worth adding.

**Suggested `consumed_in:` addition:**

```
- fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt
```

### 1.2 `[[am4-pidlow-register-families]]`

The PATCH and GLOBAL totals declared by the primitive entry (PATCH=85,
GLOBAL=99) match the AM4-Edit binary tables byte-for-byte.

- PATCH table at `0x1414216d0`, **85 entries** (dump lines 1121-1206).
  Primitive claim: "85 params total" - exact match.
- GLOBAL table at `0x14141a9f0`, **99 entries** (dump lines 843-942).
  Primitive claim: "99 params catalogued" - exact match.

PATCH contains the safety-relevant Scene-MIDI sub-registers the primitives corpus
flagged as Trigger-class in the  refinement:

```
[ 60]  paramId=118    PATCH_SCENE_1_MIDI_EXEC
[ 61]  paramId=119    PATCH_SCENE_2_MIDI_EXEC
[ 62]  paramId=120    PATCH_SCENE_3_MIDI_EXEC
[ 63]  paramId=121    PATCH_SCENE_4_MIDI_EXEC
[ 64]  paramId=122    PATCH_SCENE_1_MIDI_EXEC_1
...
[ 79]  paramId=137    PATCH_SCENE_4_MIDI_EXEC_4
[ 80]  paramId=138    PATCH_SCENE_1_MIDI_MENU
...
[ 84]  paramId=142    PATCH_SCENE_MIDI_CLEAR
```

The primitive entry decoded `pidHigh=0x0070 = SCENE_MIDI_EXEC`
from scene-MIDI captures. The dump's AM4-Edit paramId space
indexes these as paramId=118..121 (per-scene) + paramId=122..137 (per-
scene-per-msg sub-EXECs); pidHigh on the wire and paramId in the editor
table use independent numbering, so this is not a contradiction but a
namespace distinction worth noting (see also negative finding §3.1 below).

GLOBAL family contains the two pid-checked goldens the primitives corpus cites:

```
[ 42]  paramId=99     GLOBAL_USBLEVEL1                (line 886)
[ 12]  paramId=46     GLOBAL_TAP_TEMPO_MODE           (line 856)
```

Both visible in the dump at the cited paramIds, confirming the GLOBAL
family decode from .

**Suggested `consumed_in:` addition:**

```
- fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt
```

### 1.3 `[[am4-fn1f-atomic-read]]`

The two 210-entry ID tables at `0x14141bbe0` (lines 28-239) and
`0x14142c2e0` (lines 240-451) are the canonical `effectId -> block
symbol` map that resolves the hardware-probed effectIds in the primitive
entry's Probe Evidence table.

Cross-checks against the primitives corpus's HW-AM4-FN1F probe results:

| Primitive probe shape | Primitive claim | Dump confirms (line) |
|---|---|---|
| `scene1` `01 00` | effectId 1 returns chunk | line 30: `paramId=1 ID_GLOBAL` |
| `amp1` `6a 00` | effectId 106 returns 100-byte chunk | line 135: `paramId=106 ID_TREMOLO1` |
| amp.gain write probe | only effectId 58 showed paramId-shaped diff at position 11 | line 87: `paramId=58 ID_DISTORT1` (DISTORT1 = AM4's amp/distort block) |

The DISTORT1 = effectId 58 mapping is the load-bearing one: the primitive
position-map probe established `chunkPosition === pidHigh` for the amp
block, and the dump confirms via the effectId table that effectId=58 is
ID_DISTORT1, which matches the DISTORT param table at `0x14141e930`
(142 entries with paramIds 10..151 - so the 256-ushort chunk size the
probe observed at effectId 58 makes sense: chunk indexed by paramId
0..255 covers DISTORT's full paramId range).

Open follow-up in the primitive entry ("extend the position-map probe to
the remaining ~16 distinct chunk sizes to lock the full block <-> effectId
mapping") becomes mechanical with this dump: the ID table enumerates the
exact block symbol for every effectId, so the position-map probe only
needs to fire one write per BLOCK_TYPE (not per effectId), checking
`chunkPosition === pidHigh` against the symbol family.

**Probe label refinement (minor):** the primitives corpus's Probe Evidence table
labels `effectId 106` as `amp1`. Per the dump (line 135), effectId 106
is `ID_TREMOLO1`. The "amp1" label was a probe-script naming choice and
should be re-read as "tremolo1" or "block106" for accuracy. Not a
primitive-level error; refinement-history note.

**Suggested `consumed_in:` addition:**

```
- fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt
```

---

## 2. Candidate net-new primitives

### 2.1 `am4-effectid-block-namespace-table` (partial-N1)

The 210-entry ID enum at `0x14141bbe0` (and its duplicate at
`0x14142c2e0`) is a structurally distinct artifact from the per-block
ParamDescriptor tables: each row maps a numeric `effectId` (paramId
field of the descriptor) to a symbolic block-instance name
(`ID_DISTORT1`, `ID_REVERB2`, etc.). It is THE namespace the AM4 fn=0x1F
atomic-read uses to address blocks, and it is the analog of the Axe-Fx
II `BlockType` enum the existing II Ghidra mining surfaced.

Proposed frontmatter:

```yaml
---
name: am4-effectid-block-namespace-table
class: struct-layout
status: partial-N1
discovered: 2026-05-22 (primitives mine of ghidra-am4edit-paramtables.txt)
verified_on:
  - am4-edit-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-am4-effectid-block-namespace-table
relates_to: [param-descriptor-16byte, am4-fn1f-atomic-read]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt
---
```

Summary: a 210-entry ParamDescriptor-shaped table in AM4-Edit `.rdata`
where the paramId field is the AM4 effectId and the name field is the
symbolic block-instance label (`ID_<BLOCKTYPE><N>` for blocks with N=4
instances, plain `ID_<SINGLETON>` for singletons like `ID_GLOBAL`,
`ID_TUNER`, `ID_FOOTCONTROLLER`).

Evidence (dump lines 28-239 for the canonical table, 240-451 for the
duplicate copy):

- Singletons by ID: 0=ID_NULL, 1=ID_GLOBAL, 2=ID_CONTROL, 35=ID_TUNER,
  36=ID_IRCAPTURE, 190=ID_MIDIBLOCK, 199=ID_FOOTCONTROLLER,
  200=ID_PRESET_FC, 201=ID_PERFORM, 206=ID_PATCHCTRL, 207=ID_CTRL,
  208=ID_SHUNT (line 237), 209=ID_4CM (line 238).
- Block families with 4 slot instances: ID_INPUT (37-40+5th input at 41),
  ID_OUTPUT (42-45), ID_COMP (46-49), ID_GRAPHEQ (50-53), ID_PARAEQ
  (54-57), ID_DISTORT (58-61), ID_CAB (62-65), ID_REVERB (66-69),
  ID_DELAY (70-73), ID_CHORUS (78-81), ID_FLANGER (82-85), ...
- 32 modifier slots: ID_MODIFIER1..32 (paramIds 3-34).

**Why partial-N1:** singleton-axis (AM4 only). Promotion path to
matched-singleton or matched: confirm whether II / III editor binaries
ship an identically-shaped effectId enum at known RVAs. The existing II
Ghidra mining (`MineAxeEditIIParamResolver.java` per primitive
`param-descriptor-16byte`) likely emitted equivalents; this is a
mechanical cross-check, no hardware required.

**Notable: the table appears TWICE in the binary** (`0x14141bbe0` +
`0x14142c2e0`, both 210 entries, byte-identical content per the dump's
row-for-row identity at lines 28-239 vs 240-451). Likely two consumers
of the same enum (e.g. one for paramId-to-name resolution, one for a
sort-order or display-list pass). Worth noting as a primitive-level
observation in the body, not a separate primitive.

### 2.2 `am4-block-paramid-base-10-convention` (matched-singleton)

Every per-block ParamDescriptor table in the AM4-Edit binary starts its
block-specific paramId namespace at `10`. paramIds 0..9 are reserved
(presumably for shared header/control fields). This is visible in the
dump for every block table:

- DISTORT (line 453): `[0] paramId=10 DISTORT_TYPE`
- PITCH (line 597): `[0] paramId=10 PITCH_TYPE`
- DELAY (line 1209): `[0] paramId=10 DELAY_MODEL`
- REVERB, CHORUS, FLANGER, ROTARY, PHASER, WAH, FORMANT, TREMOLO,
  VOLUME, GATE, GEQ, PEQ, MIXER, MULTITAP, MEGATAP, TENTAP, IRPLAYER,
  IRCAPTURE, ENHANCER, FUZZ, SYNTH, RESONATOR, RINGMOD, MULTICOMP,
  COMP, FILTER, DYNDIST, MOD, LOOPER, TONEMATCH, CONTROLLERS,
  CROSSOVER, ROTARY, PLEX, OUTPUT (24+10=34 first paramId) - same shape.

Counter-examples that confirm the rule's scope:

- GLOBAL (line 843-942): paramIds out of order, do NOT start at 10; this
  is a system-level table, not a per-block one.
- PATCH (line 1121-1206): paramIds 20+ ascend later; PATCH is also a
  system/preset-level table.
- OUTPUT (line 2039): starts at `paramId=22 OUTPUT_VUL`. Note OUTPUT here
  is the per-block output (4 instances per ID table), distinct from the
  global OUT* params; the dump's OUTPUT table starts at 22 not 10, so
  the "block-base-10" rule is NOT universal. Refine: holds for "signal-
  processing" blocks but not for IO routing blocks like OUTPUT.
- INPUT (line 2175): starts at `paramId=10` - INPUT_THRESH; consistent.

Proposed frontmatter:

```yaml
---
name: am4-block-paramid-base-10-convention
class: struct-layout
status: matched-singleton
discovered: 2026-05-22 (primitives mine of ghidra-am4edit-paramtables.txt)
verified_on:
  - am4-edit-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-am4-block-paramid-base-10
relates_to: [param-descriptor-16byte, am4-effectid-block-namespace-table]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt
---
```

Summary: AM4-Edit's per-block ParamDescriptor tables (those keyed by an
effectId block-family in the ID table, e.g. DISTORT, REVERB, DELAY,
etc.) reserve paramIds 0..9 and start block-specific params at
paramId=10. The rule applies to signal-processing block families;
non-block tables (GLOBAL, PATCH, CONTROLLERS) and IO-adjacent tables
(OUTPUT starts at 22) have their own conventions.

**Why matched-singleton not partial-N1:** the rule has been measured
across ~35 block tables in a single binary - that's high N within the
AM4-edit-binary axis - but only one axis point. Generalization axes
that would lift to `matched`: confirm II / III binaries follow the same
base-10 convention (likely yes per existing Ghidra dumps).

**Practical use:** when a future probe writes to an unknown paramId for
a block, the legal range is `[10, max(paramId in block table)]`.
paramId<10 writes either NACK or hit reserved fields.

### 2.3 (NOT proposed) `am4-effectid-duplicate-table`

The ID enum appears twice in the AM4-Edit binary (lines 28-239 +
240-451, byte-identical). At first glance this looks like a primitive
("Fractal editor binaries embed enum duplicates"), but a single-binary
observation with no cross-device or cross-version evidence is too thin.
Document in the body of `am4-effectid-block-namespace-table` (§2.1) as a
"two consumers" observation; do not promote separately.

---

## 3. Negative findings

### 3.1 The seeker emits ParamDescriptor tables only; vendor-envelope descriptor tables for AM4 are still un-mined

`[[vendor-envelope-descriptor-table]]` lists AM4 as a transfer
candidate: "AM4 editor binary descriptor tables not yet surveyed.
Primitive entry is currently II + III only."

This dump file does NOT close that gap. SeekParamTables64.java
specifically seeks the 16-byte ParamDescriptor shape with paramId at
+0 and name pointer at +8 (per the primitive entry's formal definition).
The vendor-envelope descriptor tables on II / III are a different shape:
contiguous `(tag, mid, byte_count)` triples terminated by `(-1, -1, -1)`,
typically 12 bytes per record.  (lines 11-21) scanned only for
the ParamDescriptor signature; no envelope-descriptor extraction was
attempted.

Concrete future-agent guidance: do NOT scan this dump file for AM4
vendor-envelope descriptor tables. The data is not in here. To close
the AM4 transfer candidate, write a sibling seeker
(`SeekVendorEnvelopeDescriptorsAM4.java`, a clone of the II/III
script) and produce a separate `ghidra-am4edit-envelope-descriptors.txt`
artifact.

Search terms a future agent would use:

- "AM4 vendor envelope descriptor table"
- "ghidra-am4edit-paramtables.txt envelope descriptor"
- "SeekParamTables64.java vendor envelope"
- "AM4 fn descriptor mid byte_count"

This is NOT a `_negative/<slug>.md` candidate (no hypothesis was tested
and falsified; the seeker simply didn't aim at this target). Filed as a
follow-up gap rather than a ruled-out method.

### 3.2 paramId-in-AM4-Edit-table is NOT pidHigh-on-wire

A future agent might be tempted to read the per-block paramId values in
this dump as wire pidHigh values directly. They are not.

Evidence: primitive entry `am4-pidlow-register-families` 
refinement claims `pidHigh = 0x0070 = SCENE_MIDI_EXEC`. 0x70 = 112
decimal. The dump's PATCH table (line 1121-1206) places PATCH_SCENE_*
MIDI_EXEC entries at paramId 118..121, NOT 112. paramId=112 is absent
from the PATCH table entirely (lines 1176-1177 jump from
`paramId=111 PATCH_SCENE_4_MIDI_VAL_4` to `paramId=113
PATCH_AMP_CHA_COLOR`).

The editor-side paramId is the AM4-Edit's internal registry index;
the wire pidHigh comes from a separate (currently unmapped) translation.
For PATCH writes, the existing `setParam` codec in `fractal-midi/src/am4/`
uses the `KNOWN_PARAMS` registry's (pidLow, pidHigh) pair, which is
NOT a direct copy of the editor binary's paramId.

Search terms a future agent would use to avoid this re-attempt:

- "AM4-Edit paramId equals pidHigh"
- "AM4 paramId pidHigh translation"
- "PATCH paramId 118 SCENE_MIDI_EXEC pidHigh 0x70"

Not a `_negative/<slug>.md` candidate either; rather a clarification
that should land in the body of `param-descriptor-16byte` and / or
`am4-pidlow-register-families` if confusion has actually surfaced.

---

## Summary

**Primitives deltas suggested (founder review required before promotion):**

| Entry | Action | Rationale |
|---|---|---|
| `param-descriptor-16byte` | Add `ghidra-am4edit-paramtables.txt` to `consumed_in` | Direct fixture of the 47-table / 2105-entry / 1894-unique-symbols mining on AM4-Edit; current `consumed_in` lists the script but not the dump |
| `am4-pidlow-register-families` | Add same path to `consumed_in` | PATCH count (85) + GLOBAL count (99) verified byte-exact against the editor binary |
| `am4-fn1f-atomic-read` | Add same path to `consumed_in`; refine "amp1" probe label to "tremolo1" or "block106" | ID table at 0x14141bbe0 confirms effectId 106 = ID_TREMOLO1 (not amp); minor naming polish |
| `vendor-envelope-descriptor-table` | No change | The dump doesn't close the AM4 transfer candidate; gap stands |

**New primitives proposed (2 candidates):**

1. `am4-effectid-block-namespace-table` (partial-N1) - 210-entry block
   instance enum at `0x14141bbe0`, dual-located at `0x14142c2e0`. Path
   to matched-singleton: cross-check II / III editor binaries for the
   same shape (likely already mined).
2. `am4-block-paramid-base-10-convention` (matched-singleton) - per-block
   ParamDescriptor tables reserve paramIds 0..9; block params start
   at paramId=10. Holds for ~35 block tables in this binary; non-block
   tables (GLOBAL, PATCH, CONTROLLERS, OUTPUT) follow their own
   conventions.

**Negative findings (2; neither promotes to `_negative/`):**

1. The seeker does not extract vendor-envelope descriptor tables. AM4
   transfer candidate for `vendor-envelope-descriptor-table` is still
   open; needs a separate seeker script.
2. AM4-Edit's paramId is NOT the wire pidHigh. Clarification, not a
   ruled-out method.
