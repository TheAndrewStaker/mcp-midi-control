# Ghidra mining workflow — Fractal editor binaries

**Read this before opening a new Ghidra project against any Fractal
editor binary** (AM4-Edit, Axe-Edit III, future FM3/FM9/VP4 editors).
The workflow is reusable across the family because every Fractal
editor shares the same per-effect parameter-dictionary architecture.

This document captures what worked, what didn't, and why — distilled
from Session 82's mining of AM4-Edit.exe + Axe-Edit III.exe.

---

## What the editors actually contain

Every Fractal editor binary embeds:

1. **A per-effect parameter-table dispatcher** — a switch statement
   keyed on an internal effect-type index (1..0x3c-ish range). Each
   case returns a pointer to a `-1`-terminated array of 16-byte
   `ParamDescriptor` structs.

2. **The ParamDescriptor struct (16 bytes, identical across editors):**

   ```c
   struct ParamDescriptor {
       int32   paramId;       // wire paramId (-1 terminates the array)
       int32   padding;       // always 0
       const char* nameStr;   // 64-bit pointer to NUL-terminated
                              // symbolic name like "REVERB_TIME"
   };
   ```

3. **Symbolic parameter-name strings** in `.rdata`, prefixed by effect
   family — `REVERB_*`, `DELAY_*`, `DISTORT_*`, `GLOBAL_*`, etc.
   Same naming convention across AM4-Edit and Axe-Edit III, confirms
   shared codebase ancestry.

4. **A `__block_layout.xml`** (and `__block_layout_expert.xml` on
   AM4-Edit) embedded as JUCE BinaryData, listing which paramIds get
   UI widgets per effect page. Useful for filtering the dispatcher
   catalog down to user-facing knobs (vs modifier slots / internal
   calc state).

5. **A generic SysEx message-builder** that takes the function byte
   as a runtime parameter. On Axe-Edit III this is `FUN_1403437d0`
   (v1.14.31). Tracing its callers reveals every function byte the
   editor emits.

The wire mapping is **direct** — no separate lookup function:

| Wire byte | Source |
|---|---|
| AM4 pidLow | block-type identifier (see `packages/am4/src/blockTypes.ts`) |
| AM4 pidHigh ≥ 10 | dispatcher paramId for that block-specific param |
| AM4 pidHigh 0..9 | generic shared param (0=level, 1=mix, 2=balance, 4=bypass_mode) |
| AM4 pidHigh = 2002 | channel-select register (different code path) |
| III effectId | Appendix 1 enum (ID_REVERB1=66, etc.) |
| III paramId | same as AM4 pidHigh — dispatcher paramId |

Verified at 99% match rate against existing hand-decoded
`packages/am4/src/params.ts` (Session 82).

---

## Headless runner pattern

All scripts ship with a `.cmd` runner under `scripts/ghidra/`. The
common invocation:

```bat
%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat ^
    "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "<binary.exe>" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript <Script>.java
```

- `-noanalysis -readOnly` — never modifies the project. Auto-analysis
  is assumed done once via Ghidra GUI before headless runs.
- **The GUI must be fully closed** before headless can open the
  project (lock contention). If the GUI is open and you need
  headless, File → Exit (not just close the project view).
- Default Ghidra install: `C:\tools\ghidra_12.0.4_PUBLIC`. Override
  via `GHIDRA_INSTALL_DIR` env var.

Project locations (Session 82):
- `C:\Users\Steph\ghidra-am4-edit.gpr` → AM4-Edit.exe
- `C:\Users\Steph\ghidra-axe-edit-3.gpr` → Axe-Edit III.exe
- `C:\Users\Steph\ghidra-axe-edit.gpr` → Axe-Edit (II generation)

---

## Three-tier mining technique (proven)

Built from `scripts/ghidra/FindEncoder.java`'s pattern (the script
that successfully mined AM4-Edit's SET_PARAM encoder in earlier
sessions). All three tiers run in one script for max coverage:

### Tier 1 — Symbol-table walk

```java
SymbolIterator it = symTbl.getAllSymbols(true);
while (it.hasNext()) {
    Symbol s = it.next();
    String name = s.getName(true).toLowerCase(); // includes namespace
    for (String pattern : SYMBOL_PATTERNS) {
        if (name.contains(pattern)) { /* matched */ }
    }
}
```

Catches:
- Ghidra's auto-generated `s_<prefix>_<addr>` symbols (created by
  the String Analyzer at .rdata literals; xrefs to these are
  populated automatically and survive even when the data-ref
  analyzer didn't fully run)
- C++ mangled method names like `?SetParam@DebugSetParamDlg@@...`
- Class vftable symbols like `CableComponent::vftable`

### Tier 2 — Byte-pattern search

```java
AddressSetView init = memory.getAllInitializedAddressSet();
Address cur = init.getMinAddress();
while (cur != null) {
    Address hit = memory.findBytes(cur, pattern, null, true, monitor);
    if (hit == null) break;
    // process hit, advance cur
}
```

**Important**: use `getAllInitializedAddressSet()`, not
`program.getMinAddress() .. getMaxAddress()`. The latter spans into
external/uninitialized space (the III binary's max address ends in
the external space at 0xff0000xxxx; scanning there is wasted).

Useful patterns:
- `F0 00 01 74` — Fractal SysEx prefix (model byte loaded dynamically
  on III, so `F0 00 01 74 10` returns 0 hits — model byte 0x10 isn't
  a literal in the code. AM4 hardcodes its model byte 0x15 sometimes
  but more commonly also loads from a struct field.)
- Known parameter-table addresses if you've already found them

### Tier 3 — Instruction-walk fallback

```java
InstructionIterator it = listing.getInstructions(true);
while (it.hasNext()) {
    Instruction ins = it.next();
    for (int op = 0; op < ins.getNumOperands(); op++) {
        for (Object o : ins.getOpObjects(op)) {
            long addr = (o instanceof Address) ? ((Address)o).getOffset()
                     : (o instanceof Scalar) ? ((Scalar)o).getUnsignedValue()
                     : -1;
            if (targetSet.contains(addr)) { /* found xref to target */ }
        }
    }
    // Also try ins.getReferencesFrom() for Ghidra-resolved refs
    for (Reference r : ins.getReferencesFrom()) { /* ... */ }
}
```

Use this when Tier 1's symbol-table walk returns 0 matches for
strings that you KNOW are in the binary. Means Ghidra's data-ref
analyzer didn't link the LEA/MOV instructions to their data targets;
this walks instruction operands manually to find them.

**On a 20MB binary, instruction-walk scans ~1.4M instructions in
~30-60 seconds. Plan accordingly.**

---

## Direct-pattern-scan technique (Session 94, 2026-05-17)

**A dispatcher-independent alternative to the three-tier walk above.**
Use this when the dispatcher-via-xref technique fails (typically:
32-bit binaries with indirect dispatch — Axe-Edit II) OR as
independent cross-validation of a dispatcher-mined catalog.

Scripts:
- `scripts/ghidra/SeekParamTablesII.java` — 32-bit (Axe-Edit II)
- `scripts/ghidra/SeekParamTables64.java` — 64-bit (AM4-Edit, AxeEdit III)

### Insight

The three-tier walk above finds tables by following the dispatcher's
switch statement. That requires:
1. Finding the dispatcher (rank functions by # of param-symbol refs).
2. The dispatcher's case targets resolve to data pointers via xref.

Step 2 breaks on 32-bit Axe-Edit (Session 87 cont negative finding —
hash-keyed indirect dispatch produces 9/1125 refs / 3 UI-prompt
functions only). The instruction-walk fallback (Tier 3) helps but
still depends on reaching the dispatcher from a known entry point.

The direct-pattern-scan technique bypasses the dispatcher entirely.
Instead of "find the dispatcher, follow its cases", it asks: where
in this binary do consecutive `ParamDescriptor` struct entries live?
Then it reads those tables directly, regardless of how they're
dispatched.

### Algorithm

1. **Index every Fractal-prefixed string** in .rdata (same as Tier 2
   byte-pattern scan — store address → symbol name).
2. **Walk every initialized non-executable memory block** on
   4-byte alignment.
3. **At each offset, treat the bytes as a candidate
   `ParamDescriptor` entry.** Try to extend forward at the struct's
   natural stride until:
   - `paramId == -1` (terminator), OR
   - `paramId` outside plausible range (0..1000), OR
   - pointer outside image range, OR
   - pointer doesn't resolve to a known indexed Fractal symbol.
4. **Tables with at least `MIN_TABLE_ENTRIES` (default 3) survive.**
5. **Drop nested subtables** — a "table" starting +stride into a
   larger valid table is a false-match seed.

### ParamDescriptor stride per architecture

| Arch | Struct shape | Stride |
|---|---|---|
| 64-bit | `int32 paramId + int32 padding + int64 ptr` | 16 |
| 32-bit | `int32 paramId + int32 ptr` (or `+ int32 pad + int32 ptr`) | 8 (try 12 too) |

### Pointer-range bounds

64-bit AM4/III: derive from `currentProgram.getMin/MaxAddress()` at
runtime — handles ASLR-shifted modules without hardcoding
`0x140000000`.

32-bit Axe-Edit II: `0x00400000 - 0x02000000` (Windows PE default image
base + plausible image size). Hardcoded constants; revisit if a future
32-bit Fractal editor uses a different base.

### Cross-validation against dispatcher catalogs

Use `scripts/_research/compare-ghidra-techniques.ts` to join the
direct-scan output against the dispatcher catalog. Reports:
- `matched` — same name, same paramId (the bulk should land here)
- `dispatcher-only` — direct-scan missed (cosmetic UI buttons at
  high paramIds, tables below `MIN_TABLE_ENTRIES`)
- `direct-scan-only` — dispatcher missed (tables loaded indirectly,
  `ID_*` block-identifier constants stored in separate tables)
- `paramId disagreements` — **MUST be 0**. If non-zero, one of the
  techniques has a wire-correctness bug and the catalog is unsafe to
  ship.

### Empirical results (Session 94, 2026-05-17)

| Binary | Symbols indexed | Tables found | Total entries | Unique syms in tables | % indexed |
|---|---|---|---|---|---|
| AM4-Edit.exe (64-bit) | 24,950 | 47 | 2,105 | 1,894 | 7% |
| AxeEdit III.exe (64-bit) | 32,647 | 53 | 2,562 | 2,150 | 6% |
| Axe-Edit.exe (32-bit II) | 1,257 | 43 | 1,353 | 1,245 | 99% |

The "% indexed" gap on the 64-bit binaries is huge because their
.rdata is dominated by layout-XML strings (BinaryData payload),
SYSEX_* function names, ID_* enums, etc. — only ~6-7% of indexed
strings are actual paramId-bound names. The 32-bit II binary has a
smaller .rdata so the ratio inverts.

Cross-validation vs dispatcher (all 0 paramId disagreements):
- **AM4**: dispatcher 1,732 / direct-scan 1,895; 1,684 matched.
  Dispatcher-only 47 (UI buttons at paramId 65520+ — `CABINET_PICKER1`,
  `CONTROLLERS_SCENE1_SET_ALL`). Direct-scan-only 210 (ALL `ID_*`
  block-identifier constants — belong in `blockTypes.ts`).
- **III**: dispatcher 2,216 / direct-scan 2,097; 1,891 matched.
  Dispatcher-only 325 (mostly `GLOBAL_FC_*` non-addressable foot-
  controller config + cosmetic CABINET high-paramIds). Direct-scan-
  only 206 (ALL `ID_*` constants).
- **II**: 639 of 640 shipping (parameterName, paramId) pairs validate
  exactly. 470 NEW entries the wiki never indexed (entire VOCODER /
  RESONATOR / MOD blocks plus selective CONTROLLERS / DISTORT gaps).

### When to use which technique

- **64-bit Fractal editor (AM4-Edit, AxeEdit III, FM3/FM9/VP4
  presumably)**: dispatcher walk is the canonical first pass — it
  finds tables in the order the device addresses them and emits a
  clean per-effect mapping. Run direct-scan after as cross-
  validation (wire-correctness gate at 0 disagreements).
- **32-bit Fractal editor (Axe-Edit II, possibly other legacy
  editors)**: skip the dispatcher walk entirely — direct-scan is
  the primary path. Confirmed Session 94 with II at 99% indexed-
  symbol coverage.
- **Any binary with auto-analysis incomplete**: direct-scan is
  independent of data-ref analyzer state. The three-tier walk
  depends on Tier 1's symbol-table population.

### Limits

The direct-scan technique misses:
- Tables under `MIN_TABLE_ENTRIES` (default 3). Tune downward at
  the cost of more false positives.
- Tables whose first entry's pointer resolves to a symbol NOT in
  the `PREFIXES` list. Add new prefixes as you discover new effect
  families.
- `ID_*` block-identifier tables, by design — those are catalog of
  block enums, not paramId tables. They belong in `blockTypes.ts`
  in the cross-published package. The compare script will flag them
  as `direct-scan-only` in the cross-val report; that's normal.
- UI-only widget paramIds at very high numbers (typically 65520+ on
  AM4) where the dispatcher allocates them but they live in a
  separate "UI helper" table direct-scan doesn't pattern-match. The
  compare script flags these as `dispatcher-only`. Filter them
  before shipping to params.ts.

---

## What DIDN'T work (Session 82 failure modes)

These cost a wall-time iteration each; documenting so we don't redo
them.

### 1. `mem.findBytes(needle)` + `refMgr.getReferencesTo(addr)`

The first III mining script (`MineAxeEditIII.java`, v1) used
`findBytes` to locate SYSEX_* strings, then `getReferencesTo` on
each string's address. Result: 0 refs across all 23 SYSEX_*
strings.

Why it failed: `getReferencesTo` returns refs the data-ref analyzer
has already populated. For 64-bit PE binaries (image base
0x140000000+), the data-ref analyzer needs to fully analyze every
LEA/MOV-with-immediate to populate refs to .rdata literals. If
auto-analysis didn't run all analyzers, or if it timed out, the
data refs are missing — even though the strings ARE in memory and
findable.

Fix: use the symbol-table walk (Tier 1) instead, or add the
instruction-walk fallback (Tier 3). Both are independent of the
data-ref analyzer's completeness.

### 2. Null-terminator inclusion in `findBytes` needles

The v1 script built needles as `"SYSEX_DSP_MESSAGE\0".getBytes(...)`.
This works for strings stored as exact literals BUT fails for cases
where the symbol appears as a prefix of a longer string. Example:
`"msg_getBlockString:..."` — searching for `"msg_getBlockString\0"`
returns 0 hits because the colon follows the symbol.

Fix: drop the NUL terminator from needles; verify matches by reading
the string at the hit address and checking it starts with the prefix.

### 3. Assuming the SysEx envelope is a byte literal

The III binary writes the SysEx envelope via runtime byte
construction:

```c
local_48 = 0x740100f0;    // F0 00 01 74 (little-endian)
local_44 = device_handle[0x30];  // model byte from struct field
local_43 = fn_byte;       // function byte
```

The model byte (`0x10` for III, `0x15` for AM4, `0x11` for FM3,
etc.) is loaded from a device-handle struct field at runtime. Byte-
pattern searches for `F0 00 01 74 10` return 0 hits on the III
binary; `F0 00 01 74` returns 7 hits (the actual emitters).

Fix: search for the shorter `F0 00 01 74` envelope. Each hit is a
SysEx-emitter function; the model byte and function byte are loaded
into adjacent local-variable bytes immediately afterward.

### 4. Assuming the param-table is a flat int array

The dispatcher's per-effect param tables are NOT `-1`-terminated
int arrays of paramIds — they're arrays of 16-byte structs (see
ParamDescriptor above). The first iteration of
`DumpAxeEditIIIParamTables.java` read every 4 bytes and broke on
-1, producing garbage (4 values per real entry, of which only the
first is paramId).

Fix: stride by 16 bytes per entry, read paramId at offset 0, name
pointer at offset 8 (64-bit LE).

---

## Dispatcher discovery recipe

To find the per-effect dispatcher on a new Fractal editor:

1. **Run `Mine<Editor>ParamResolver.java`** — byte-pattern scan for
   the parameter-symbol prefixes (REVERB_, DELAY_, EFFECT_, GLOBAL_,
   ID_, etc.); collect xrefs per symbol; rank functions by # of
   distinct symbols referenced.

2. **The top function with 20+ symbol references is the dispatcher.**
   On AM4-Edit it's `FUN_1402e3da0` (32 symbols). On Axe-Edit III
   it's `FUN_140397a40` (30 symbols). Single-digit reference counts
   mean Ghidra's data-ref analysis didn't fully run — fall back to
   the instruction-walk technique.

3. **Decompile the dispatcher.** The body is a switch statement
   with each case returning a pointer to a `DAT_xxxxxxxx` per-effect
   table. Effect-type internal enum values are 1..0x3b-ish; some
   cases share tables (`case 0x29-0x2d: piVar3 = &DAT_xxx;` — INPUT
   1-5 share params; `case 0x2e-0x31:` OUTPUT 1-4 share params).

4. **Extract the `DAT_xxxxxxxx` addresses.** Hardcode them as a
   `CASE_TO_DAT` table in a new `Dump<Editor>ParamNames.java` script.

5. **Read 16-byte ParamDescriptor structs at each DAT_xxx.**
   Dereference each `nameStr` pointer to get the parameter's
   symbolic name. Output: `(paramId, name)` pairs per effect family,
   per case index.

6. **Identify effect families by the prefix of the first param's
   name.** `REVERB_TYPE` → REVERB family, `DELAY_MODEL` → DELAY,
   etc. Effect-type internal-enum case index doesn't map directly
   to v1.4 Appendix 1 effect IDs — it's a separate internal
   ordering Fractal uses in editor code.

---

## Files produced by Session 82

Committed in commit `3262ea1` ("research: Ghidra-mine AM4-Edit +
Axe-Edit III parameter dictionaries").

### Per-Fractal-editor

| File | Purpose |
|---|---|
| `Mine<Editor>.java` / `Mine<Editor>v2.java` | Broad protocol-string xref walk; envelope byte-pattern hits; param-symbol rank |
| `Mine<Editor>ParamResolver.java` | Focused: rank functions by # of param-symbols referenced; decompile top resolver(s) |
| `Dump<Editor>ParamNames.java` | Extract per-effect `(paramId, name)` pairs from the dispatcher |
| `Dump<Editor>ParamTables[V2].java` | Earlier iterations; superseded by ParamNames |
| `Trace<Editor>MessageBuilders.java` | Walk callers of generic SysEx builder; enumerate fn bytes |
| `run-*.cmd` | Headless invocation wrappers |

### Analysis tooling (TS, runs locally)

| File | Purpose |
|---|---|
| `survey-axeedit3-anchors.ts` | Bucket strings JSON by prefix family (SYSEX_, msg_, CSV headers, etc.) — picks anchors for the Ghidra script |
| `analyze-param-symbol-tables.ts` | Find contiguous runs in the offset-sorted string list — detects const char* arrays |
| `mine-axeedit3-sysex-table.ts` | Extract+sort SYSEX_* strings; cross-anchor against v1.4 docs |
| `find-axeedit3-sysex-fnbyte-array.ts` | Scan binary for parallel u8/u16/u32 fn-byte arrays — negative result on III |
| `parse-ghidra-axeedit3-mine.ts` | Post-Ghidra structured extraction (switch-case bodies, decompile blocks) |
| `compare-am4-params-coverage.ts` / `v2.ts` | Audit `packages/am4/src/params.ts` against the Ghidra catalog |
| `generate-am4-params-from-catalog.ts` | Emit proposed `params.ts` entries from the catalog (uses verified pidLow/pidHigh mapping) |

---

## Cross-block addressing — when one family covers multiple blocks

Some Fractal devices route a single param family's catalog through
multiple wire-level block IDs. Verified Session 83 on AM4:

- **AMP + DRIVE both use the DISTORT family** (catalog case 0xa, 143
  params). Addressed via different pidLow values:
  - `amp` block: `pidLow = 0x003a`
  - `drive` block: `pidLow = 0x0076`

The anchor for finding these patterns is AM4-Edit's
`__block_layout.xml` `<EditorControls name="X" parameters="FAMILY_*">`
attribute. The "Amp" EditorControls entry explicitly references
`DISTORT_*` symbols, confirming the cross-pidLow mapping.

When validating against the catalog (see
`scripts/_research/validate-params-against-catalog.ts`), use the
reverse `pidLow → block` map to look up the actual family the wire
bytes target, rather than just the user-facing block tag in
`params.ts`.

## Non-placeable but wire-addressable blocks

`packages/am4/src/blockTypes.ts` lists only the slot-placeable
blocks (17 on AM4). The wire format addresses additional system
"blocks" via dedicated pidLows that aren't in that map. Confirmed
to date:

- `pidLow = 0x0025` — Input Noise Gate (params.ts `ingate.*`).
  Catalog family = INPUT (case 0x29). Validated: `ingate.threshold`
  pidHigh=10 matches `INPUT_THRESH` paramId 10.
- `pidLow = 0x003e` — Cabinet block (§6k). Catalog family = CABINET
  (case 0xb). 16 `amp.cab_*` entries in params.ts use this pidLow
  (the AM4 amp's integrated cab Expert page).
- PATCH family (case 0x3c, 85 params) — pidLow TBD. AM4-specific
  scene/routing/4CM/scene-MIDI params not in any current device file.
- GLOBAL family (case 0x1, 99 params) — pidLow TBD. System-wide
  settings (tuner mode, USB level, output config, etc.).

Future devices likely have analogous "system" pidLows. When mining
a new editor binary, look for catalog families that have no
corresponding entry in the device's blockTypes — those are
candidates for non-placeable system-block discovery via capture.

## Tips for the next session

- **Always close Ghidra GUI fully (File → Exit) before any headless
  run.** Closing just the project view leaves `javaw.exe` running
  and holds the project lock.
- **The strings JSON (`samples/captured/decoded/*-strings.json`)
  is gitignored but cheap to regenerate** via `extract-exe-strings.ts`.
  Re-run when the editor binary updates (e.g. new Axe-Edit III release).
- **JSON outputs are gitignored**; the Java scripts that produce
  them ARE committed. Re-running the `.cmd` files reproduces every
  artifact in ~1-5 minutes per script.
- **When adding a new Fractal device:** copy the existing
  `Mine<Editor>ParamResolver.java` + `Dump<Editor>ParamNames.java`,
  point them at the new project, change the `OUTPUT_PATH`. Most of
  the work is just running the scripts and copying the resulting
  CASE_TO_DAT table into the param-names dumper.
