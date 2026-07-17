# Primitives crosscheck: ghidra-axe-edit-iii-actions-and-shapes.txt

Date: 2026-05-22
Dump path: `fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt` (988,973 bytes; produced by `MineAxeEditIIIActionsAndShapes.java`)
Primitives revision: 18 positive primitives + 8 negatives (per INDEX.md `## The table`).

The dump has three sections:

- **PART A** (lines 7-675): one-line caller summaries for the 93 callers of `FUN_14033ec70` (the fn=0x01 wrapper). Each caller has its ASSIGN statements that touch the action-descriptor struct.
- **PART A.2** (lines 677-22405): full Ghidra decompile of each of the 93 callers. The body of the fn=0x01 builder itself is reproduced under the (mislabeled) "fn=0x14" header at L22641.
- **PART B** (lines 22407-end): host-emit wire shapes for seven non-fn=0x01 workflows. Headers are auto-labeled by literal grep and are unreliable (see §3.A), but the listed functions are the right ones.

The mining yield falls into three buckets: instances of existing primitives now reachable from the III editor (§1), candidate net-new primitives the dump exposes (§2), and one negative finding about how to consume the dump (§3).

---

## 1. Instances of existing primitives

### 1.A, `[[iii-fn01-set-parameter-envelope]]`, full byte-pinned definition of the fn=0x01 builder

The dump exposes the complete decompile of `FUN_14033ec70`, the AxeEdit III function that composes every fn=0x01 SET_PARAMETER frame. This is the function the primitives corpus's `iii-fn01-set-parameter-envelope` 2026-05-22 refinement note named ("AxeEdit III editor's `FUN_14033ec70` builder ... packs the payload as a 6-field struct") but cited as an N=1 alternative reading. The dump now contains the function body itself, so the 6-field layout is byte-pinned, not hypothesized.

Location in dump: L22641-22850. The relevant excerpts (offset bytes are after the F0 00 01 74 <model> 01 prefix):

```c
// Field 0 (action14)   : 2-byte septet, output bytes [0,1]
pbVar4[0] = (byte)uVar1 & 0x7f;
pbVar4[1] = (byte)(uVar1 >> 7) & 0x7f;        // L22698-22699
// Field 1 (effectId14) : 2-byte septet, output bytes [2,3]
pbVar4[2] = (byte)uVar1 & 0x7f;
pbVar4[3] = (byte)(uVar1 >> 7) & 0x7f;        // L22726-22727
// Field 2 (paramId14)  : 2-byte septet, output bytes [4,5]
pbVar4[4] = (byte)uVar1 & 0x7f;
pbVar4[5] = (byte)(uVar1 >> 7) & 0x7f;        // L22754-22755
// Field 3 (value32)    : 5-byte septet, output bytes [6..10]
pbVar4[6]  = (byte)uVar1 & 0x7f;
pbVar4[7]  = (byte)(uVar1 >> 7) & 0x7f;
pbVar4[8]  = (byte)(uVar1 >> 0xe) & 0x7f;
pbVar4[9]  = (byte)(uVar1 >> 0x15) & 0x7f;
pbVar4[10] = (byte)(uVar1 >> 0x1c);           // L22782-22786
// Field 4 (modifier14) : 2-byte septet, output bytes [11,12]
pbVar4[0xb] = (byte)uVar1 & 0x7f;
pbVar4[0xc] = (byte)(uVar1 >> 7) & 0x7f;      // L22813-22814
// Field 5 (tailCount14) : 2-byte septet, output bytes [13,14]
pbVar4[0xd] = (byte)uVar1 & 0x7f;
pbVar4[0xe] = (byte)(uVar1 >> 7) & 0x7f;      // L22840-22841
// Tail (param_3[5] septets at byte 0xf+)
if (param_3[5] != 0)
  FUN_14033f2d0(param_3 + 6, param_3[5], pbVar3 + 0xf);   // L22844
// Send via central send routine with fn=1
FUN_1403437d0(param_2, 1, pbVar3, iVar2, *param_1);        // L22846
```

The buffer length is `iVar2 = (param_3[5] * 8 + 6) / 7 + 0xf` (L22659), so the fixed-size prefix is 15 bytes (0xf) and the tail is `ceil(tailCount * 8 / 7)` septet-packed bytes. The wire payload after the fn byte is exactly:

`[action14:2] [effectId14:2] [paramId14:2] [value32:5] [modifier14:2] [tailCount14:2] [tail:N]`

This matches the primitives corpus's existing 6-field interpretation precisely. The byte-pinned shapes per field also confirm the byte-verified shipped shape in `packages/fractal-gen3/src/setParam.ts` (since the captured corpus uses values in [0..16383], bytes 8-10 of field 3 are zero in every captured frame, and the on-wire bytes agree with the primitives corpus's `[drag-context:3] [value:3] [reserved:3]` retrospective decomposition).

**Suggested `consumed_in:` addition:**

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (FUN_14033ec70 full body; L22641-22850; 6-field struct + variable septet tail)
```

### 1.B, `[[iii-host-emitter-fn-table]]`, eight more host-emitted fn bytes localized to specific functions

The primitives corpus currently lists ~21 III host-emittable fn bytes inferred from caller-trace mining. This dump localizes eight of them to specific builder functions:

| fn byte | Caller / builder        | Dump line(s)                        | Payload signature        |
|---------|-------------------------|-------------------------------------|--------------------------|
| `0x01`  | `FUN_14033ec70`         | L22641-22850                        | 6-field struct, variable tail (see §1.A) |
| `0x08`  | `FUN_140150570`         | L25149                              | empty payload (signaling ping) |
| `0x12`  | `FUN_1401e3fb0`         | L25209                              | 1-byte payload (single index) |
| `0x19`  | `FUN_14033c6e0`         | L23090-23448 (call site L23404)     | descriptor-table-walked payload (see §1.D) |
| `0x1a`  | `FUN_1401f4??0` `case 7`| L20434                              | 0x536 literal field (per L20438) |
| `0x43`  | `FUN_14014bcd0 case 0xb`| L23733                              | empty payload + device dispatch (uVar18 = 0x42 vs 10 by model byte at L23433-23436) |
| `0x47`  | multiple                | L20444, L25084                      | empty payload (init/handshake) |
| `0x5a`  | `FUN_140328a10`         | L22941, L23039 (also `0x5c`)        | 6-byte fixed payload (see §1.C) |
| `0x5c`  | `FUN_140336a40`         | L23039, L23081                      | 5-byte packValue32 payload |

`0x08` and `0x47` were already in the primitives corpus's enumerated list of "11 PDF-omitted host-emittable opcodes". The dump now ties them to specific builder functions (not just "called from somewhere"), which is what the primitive entry's "Verification path" calls out as the next-tier verifiability gain (V4 → V5).

**Suggested `consumed_in:` addition:**

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (host-emit builders for fn 0x01/0x08/0x12/0x19/0x1a/0x43/0x47/0x5a/0x5c localized; L22641, L25149, L25209, L23404, L20434, L23733, L20444, L22941, L23081)
```

### 1.C, `[[septet-14bit]]` extended to 5-septet 32-bit packing

The dump shows two independent functions emitting the same 5-byte septet packing pattern with shift constants {0, 7, 14 (0xe), 21 (0x15), 28 (0x1c)}:

- `FUN_14033ec70` (fn=0x01 builder), L22782-22786, packing the value32 field of the 6-field struct.
- `FUN_140336a40` (fn=0x5c builder), L23076-23080, packing an unrelated 32-bit `param_2`:

```c
*pbVar1   = (byte)(param_2 & 0xffffffff) & 0x7f;
pbVar1[1] = (byte)((param_2 & 0xffffffff) >> 7) & 0x7f;
pbVar1[2] = (byte)(param_2 >> 0xe) & 0x7f;
pbVar1[3] = (byte)(param_2 >> 0x15) & 0x7f;
pbVar1[4] = (byte)(param_2 >> 0x18) >> 4;
FUN_1403437d0(param_1, 0x5c, pbVar1, 5, DAT_1412633f8);
```

Two independent call sites with the same shift table is N=2 inside one binary. The packing is the 32-bit extension of the primitives corpus's existing `septet-14bit` 2-septet form (same per-byte mask, more septets). Worth folding into the existing `septet-14bit` entry as a "wider variants" sub-section rather than spinning out a separate primitive: same mechanism, additional fixtures.

The dump's evidence pushes `septet-14bit` from "axis points: AM4/II/III" toward "axis points: AM4/II/III + width-variants {14, 21, 32}". The 21-bit form is already a sibling primitive ([[septet-21bit-byte2-mask-preservation]]); the 32-bit form has lived as an implicit extension and now has two N=2 fixtures within the III editor.

**Suggested `consumed_in:` addition to `septet-14bit.md`:**

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (5-septet 32-bit pack at L22782-22786 and L23076-23080)
```

### 1.D, `[[vendor-envelope-descriptor-table]]`, three new III tables walked at runtime

The primitive entry already lists 26 III descriptor tables extracted statically from `ghidra-axe-edit-iii-misc-descriptors.txt` and `ghidra-axe-edit-iii-dump-descriptors.txt`. This dump shows the runtime walker code, which is itself worth adding as a fixture (it confirms the stride and sentinel without relying on the static-extractor heuristic).

`FUN_14033c6e0` (fn=0x19 builder, L23096-23448) selects one of three descriptor tables by model byte and walks each with the same stride/sentinel pattern:

```c
piVar6 = &DAT_1407ab590;             // or 0x1407ab490, or 0x1407abb00
pbVar7 = pbVar5;  pbVar8 = pbVar5;  pbVar16 = pbVar5;
do {
  uVar14 = (int)pbVar16 + *(int *)(pbVar7 + 0x1407ab598);   // accumulate byte_count at record offset +8
  pbVar16 = (byte *)(ulonglong)uVar14;
  pbVar8 = pbVar8 + 1;
  pbVar7 = (byte *)((longlong)pbVar8 * 0xc);                // stride = 0xc = 12 bytes per record
} while (*(int *)(pbVar7 + 0x1407ab590) != -1);             // sentinel = -1 in the tag field at offset +0
```

(L23140-23149, plus parallel branches at L23260-23270 and L23329-23338.)

This confirms three properties of the primitive at runtime:

- Record stride is exactly 12 bytes (`pbVar8 * 0xc`).
- Termination is `tag == -1`, read from offset +0 of the record (`*(int *)(...table_base)`).
- The `byte_count` field is at record offset +8 (read via `+0x...598` = `+0x...590 + 8`).

The dispatch rule by model byte (L23138-23339):

| Model bytes              | Descriptor table address |
|--------------------------|--------------------------|
| 6, 7, 8 (II XL/XL+)      | `DAT_1407ab590`          |
| < 0x10 (other II)        | `DAT_1407ab490`          |
| `>= 0x10` (III, FM3, FM9)| `DAT_1407abb00`          |

L23433-23436 corroborates the III family bucket (`(DAT_1412633f8 == 0x10) || (DAT_1412633f8 == 0x11) || (DAT_1412633f8 == 0x12)`).

`DAT_1407abb00` is not in the current primitive entry's enumerated list (which names `0x1407ab940`, `0x1407ab440`, `0x1407aba40`, `0x1407ab0a0`, `0x1407ab910`, `0x1407ab8b0`, plus 19 smaller). Worth running the existing `parse-ghidra-decompile.ts` against this dump as a separate cross-extract pass to pull `0x1407abb00`, `0x1407ab590`, `0x1407ab490` byte-by-byte and merge into the JSON.

**Suggested `consumed_in:` addition:**

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (FUN_14033c6e0 walks descriptor tables 0x1407ab490 / 0x1407ab590 / 0x1407abb00 with stride-12 + sentinel -1; L23138-23339 dispatch by model byte)
```

### 1.E, `[[xor-7f-envelope-checksum]]`, Fractal vendor prefix validation observed

`FUN_14014ced0` (under the mislabeled "fn=0x10 Save Preset" header, L22418) parses an inbound SysEx file by checking the Fractal vendor prefix byte-by-byte:

```c
if ((((uVar12 < 6) || (*pcVar2 != -0x10)) || (pcVar2[1] != '\0')) ||
   ((pcVar2[2] != '\x01' || (pcVar2[3] != 't'))))  ...     // L22492-22493
cVar6 = pcVar2[4];   // model byte from the inbound message (L22505)
if (pcVar2[5] == 'Z')  ...                                  // fn=0x5A test (L22507)
```

`-0x10` as a signed char is `0xF0`, `'t'` is `0x74`. So the check is `[F0 00 01 74 <model> <fn> ...]`, with the function then routing on `<fn> == 'Z' (0x5A)` versus `'z' (0x7A)`. This is the standard `vendor-envelope-prefix` shape that `xor-7f-envelope-checksum` and `vendor-envelope-descriptor-table` both build on; the dump confirms the AxeEdit III binary recognizes it byte-for-byte at the consumer side too, not just at the emitter side.

The checksum itself is not visible here (it lives in the central send/recv functions `FUN_1403437d0` / `FUN_1403434b0`, which are not decompiled in this dump). The prefix-shape evidence is a small data point and probably does not warrant a `consumed_in:` addition on its own.

---

## 2. Candidate net-new primitives

### 2.A, `iii-multiproduct-editor-binary`, single editor binary, three model bytes

**Proposed slug:** `iii-multiproduct-editor-binary`

**Proposed frontmatter:**

```yaml
---
name: iii-multiproduct-editor-binary
class: dispatch-context
status: matched-singleton
discovered: 2026-05-22 (primitives-mine of actions-and-shapes dump)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-iii-multiproduct-editor-binary
relates_to: [vendor-envelope-descriptor-table, iii-host-emitter-fn-table, iii-fn01-set-parameter-envelope]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt
---
```

**Summary:** AxeEdit III's binary serves three Fractal model bytes simultaneously: `0x10` (Axe-Fx III), `0x11` (FM3), `0x12` (FM9). Action-code tables, descriptor tables, and per-fn envelopes can each diverge across these three within the same binary. When mining the III editor for any wire fact, the answer is potentially three answers, dispatched by `DAT_1412633f8` (the global current-device model byte).

**Evidence:**

- `cVar1 == '\x10' || cVar1 == '\x11' || cVar1 == '\x12'` appears as a model-byte gate at dozens of sites. Sample matches: L793-800 (`FUN_1401e38a0`), L1085-1086 (`FUN_1401e42a0`), L20433-20435 (case 7), L23433-23436 (`FUN_14033c6e0`).
- `DAT_1412633f8` is the global current-model-byte, written at L20420 (`DAT_1412633f8 = bVar2`) and L25720 (`DAT_1412633f8 = local_1d7[0]`), read at L23433 and L25084 and L25149 and L25209.
- Descriptor-table dispatch by model byte: L23138 / L23260 / L23329 select between three descriptor table addresses (see §1.D).

**Fixture count:** N=1 (single binary, single editor product line). `matched-singleton` is the right status: the second axis would be a different multi-product editor binary, which does not exist for Fractal currently. Body should explain "axis: multi-product editor binary, only one exists for the III family today; if Fractal ships a successor editor that drops one of the model bytes, that becomes the second axis."

**Why it matters:** every other III primitive in the primitives corpus implicitly assumes "this is THE binary for the III." That is true today, but the actual semantic is "this is the binary for three devices that share a wire dialect." Treating the model-byte axis as a first-class dispatch dimension matters when the FM3 or FM9 capabilities diverge from the III's. The primitives corpus should name this once, then each downstream primitive can cite it via `relates_to`.

### 2.B, `iii-fn01-action-code-per-model-byte`, action-code differs per device

**Proposed slug:** `iii-fn01-action-code-per-model-byte`

**Proposed frontmatter:**

```yaml
---
name: iii-fn01-action-code-per-model-byte
class: dispatch-context
status: matched-singleton
discovered: 2026-05-22 (primitives-mine of actions-and-shapes dump)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-iii-fn01-action-code-per-model-byte
relates_to: [iii-fn01-set-parameter-envelope, iii-multiproduct-editor-binary]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt
---
```

**Summary:** Inside the 93 callers of `FUN_14033ec70` (the fn=0x01 builder), the `action14` field (the first field of the 6-field struct) is selected by model byte. Most callers use a uniform action code for all three model bytes 0x10/0x11/0x12; six callers use a split action code per model byte. Code that ports III action codes to FM3 or FM9 must walk this table per caller, not assume uniformity.

**Evidence:** Sample call-site decompiles in the dump:

| Caller (fn=0x01 wrapper user) | III (0x10) | FM3 (0x11) | FM9 (0x12) | Dump line |
|-------------------------------|-----------|------------|------------|-----------|
| `FUN_1401e38a0`               | `0x84`    | `0x83`     | `0x7b`     | L793-800  |
| `FUN_1401e3a80`               | `0x84`    | `0x83`     | `0x7b`     | L859-867  |
| `FUN_1401e3b40`               | `0x4b`    | `0x4b`     | `0x4b`     | L902-906  |
| `FUN_1401e4030`               | `0x50`    | `0x50`     | `0x50`     | L957-958  |
| `FUN_1401e4130`               | `0x51`    | `0x51`     | `0x51`     | L1003-1004|
| `FUN_1401e41e0`               | `0x72`    | `0x72`     | `0x79`     | L1040-1048|
| `FUN_1401e42a0`               | `0x1c`    | `0x1c`     | `0x1c`     | L1085-1086|
| `FUN_1402263a0` (effect-add)  | `0x26`    | `0x26`     | `0x26`     | L1999-2001|
| `FUN_140228410`               | `0x27`    | `0x27`     | `0x27`     | L2231-2233|
| `FUN_140218f80`               | `0x17`    | `0x17`     | `0x17`     | L2470-2472|
| `FUN_1401e44b0` (footer)      | `0x3a`    | `0x3a`     | `0x3a`     | L1160-1162|
| `FUN_1401e4560`               | `0x39`    | `0x39`     | `0x39`     | L1197-1199|
| `FUN_1401e4610`               | `0x23`    | `0x23`     | `0x23`     | L1234-1236|
| `FUN_1401e46c0`               | `0x22`    | `0x22`     | `0x22`     | L1272-1274|
| `FUN_1401e4770`               | `0x19`    | `0x19`     | `0x19`     | L1310-1312|
| `FUN_1401e4820`               | `0x1a`    | `0x1a`     | `0x1a`     | L1347-1349|
| `FUN_1401e4a90`               | `0x1b`    | `0x1b`     | `0x1b`     | L1384-1386|

Split-per-model rows: `FUN_1401e38a0`, `FUN_1401e3a80`, `FUN_1401e41e0`. The remaining ~87 of 93 callers use a uniform action code (so far as the dump enumerates; only ~20 are shown in the head sample above, but the pattern continues identically through L22405).

**Fixture count:** N=1 (single dump, single editor binary): `matched-singleton`. Could be promoted to `matched` if a second axis appears (e.g. the FM3-only editor branch or a captured wire frame from each of III, FM3, FM9 demonstrating the action-code split at runtime).

**Why it matters:** when porting an III fn=0x01 capability to FM3 or FM9 by code-pattern-match against the III, the action code must be looked up by model byte, not copied as a constant. A "naive port from III to FM9" that copies `0x84` will silently emit the III-only action when the device is an FM9. The known split-per-model action codes (per the table above: 0x84/0x83/0x7b and 0x72/0x72/0x79) are the testable cases.

### 2.C, `iii-descriptor-table-model-byte-dispatch`, same fn, three tables by model

This is the descriptor-table analog of §2.B. The fn=0x19 envelope (file snapshot / export) uses one of three descriptor table addresses, dispatched by model byte (see §1.D). The dispatch mechanism is generic enough that other fn-byte builders likely use it too.

Worth tracking as a sub-claim within `[[vendor-envelope-descriptor-table]]`'s body rather than a stand-alone entry, because the underlying primitive (descriptor table stride-12, sentinel -1) does not change. The new fact is "the table-selection rule itself is model-byte-dispatched within the III editor." A one-paragraph addition under the existing entry's "Where it's used" section is sufficient.

**Status:** not a stand-alone candidate. Suggested action: amend [[vendor-envelope-descriptor-table]] in the same refinement pass that adds the §1.D `consumed_in` line.

---

## 3. Negative findings and notes for future agents

### 3.A, Auto-labeled `fn=0x...` headers in PART B are unreliable

**Negative claim:** the PART B section headers (`## fn=0x10: Save Preset`, `## fn=0x14: Set Preset Name`, `## fn=0x30: Reset Block`, etc.) are produced by literal-grep over the function body and do not correspond to the fn byte actually being emitted. Do not trust them.

**Evidence:**

- L22635 `## fn=0x14: Set Preset Name` → body is `FUN_14033ec70`, which calls `FUN_1403437d0(param_2, 1, pbVar3, iVar2, *param_1)` at L22846. The literal `1` is the fn byte. This is the fn=0x01 SET_PARAMETER builder, not Set Preset Name.
- L22412 `## fn=0x10: Save Preset` → body is `FUN_14014ced0`, which calls `FUN_1403434b0(param_2, <expr> + 0x5a, cVar6, &local_d8)` at L22516. The literal under the expression is `0x5a`, not `0x10`. This is a cab-bank file import routine, not a save-preset emitter.
- L22854 `## fn=0x15: Change Scene` → bodies are `FUN_140328a10` (emits fn=`0x5a` at L22941 and fn=`0x5c` at L23039) and `FUN_140336a40` (emits fn=`0x5c` at L23081). Neither emits fn=0x15.

**Search terms a future agent should grep:**
- Treat `FUN_1403437d0(...,<lit>,...)` as authoritative for the fn byte emitted by a caller.
- Treat `FUN_1403434b0(...,<lit>,...)` as the second authoritative form (different signature; used for inbound-side parsing or alternate dispatch).
- Ignore the `## fn=0x..` headers when in doubt; cross-check the literal at the `FUN_1403437d0` / `FUN_1403434b0` call site.

This is a dump-consumption note, not a wire-protocol negative. Probably belongs in the dump's own README rather than a `primitives/_negative/<slug>.md` entry, since it does not rule out a transferable hypothesis. But if the founder considers the multi-session value of "do not trust auto-labeled headers in `Mine*Actions*.java` dumps" worth a formal negative entry, the slug `_negative/ghidra-mineactions-fn-header-auto-label.md` would carry the warning.

### 3.B, Central send routines are not decompiled in this dump

Both `FUN_1403437d0` and `FUN_1403434b0` are called from dozens of sites in this dump but their bodies are not shown. The XOR-7F envelope checksum, the F0/F7 envelope wrap, and the model-byte placement at envelope offset 4 all happen inside one or both of these functions. To verify `[[xor-7f-envelope-checksum]]` directly against the III editor's send path, a separate Ghidra dump targeting `FUN_1403437d0` and `FUN_1403434b0` is needed.

This is not a negative finding (no hypothesis is rejected); it is a scope note that prevents future agents from concluding "the dump didn't show the checksum, therefore the checksum isn't there", the dump simply doesn't decompile the send routines.

---

## 4. Suggested actions for the founder (promotion-gated)

1. Amend `[[iii-fn01-set-parameter-envelope]]` with the §1.A `consumed_in` line and replace the refinement-history's hedged "this 6-field layout produces bytes identical" wording with a byte-pinned restatement from `FUN_14033ec70`'s body.
2. Amend `[[iii-host-emitter-fn-table]]` with the §1.B `consumed_in` line and the 8-row builder-localization table.
3. Amend `[[septet-14bit]]` with the §1.C `consumed_in` line; consider adding a "width variants" sub-section naming the 2-septet (14-bit), 3-septet-with-mask (21-bit, via the sibling primitive), and 5-septet (32-bit) forms.
4. Amend `[[vendor-envelope-descriptor-table]]` with the §1.D `consumed_in` line; rerun `parse-ghidra-decompile.ts` against this dump to mechanically pull `0x1407ab490` / `0x1407ab590` / `0x1407abb00` byte counts into the JSON; add the model-byte dispatch paragraph from §2.C under "Where it's used".
5. Promote §2.A (`iii-multiproduct-editor-binary`) as a new `matched-singleton` primitive in `class: dispatch-context`.
6. Promote §2.B (`iii-fn01-action-code-per-model-byte`) as a new `matched-singleton` primitive in `class: dispatch-context`.
7. Decide whether §3.A warrants a formal `_negative/` entry; default-no, unless this dump's `Mine*Actions*.java` header style proliferates to other devices.

---

End of report.
