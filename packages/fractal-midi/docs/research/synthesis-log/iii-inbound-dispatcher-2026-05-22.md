# Primitives mining: ghidra-axe-edit-iii-inbound-dispatcher.txt

Date: 2026-05-22
Dump file: `fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt` (524,207 bytes)
Source binary: `Axe-Edit III.exe`
Mining agent: Senior RE engineer (primitives-mine sub-agent)

## Headline

The dump exposes two top-level structures of primitives interest:

1. **`FUN_1401f0f10` (L60-L2285)** is the III editor's **async-workflow registry**. It registers ~60 named workflows. Each workflow declares (a) two sequential workflow-state IDs (e.g. `3,4` / `5,6` / ... up to `0x73,0x74`), (b) a set of fn-bytes the workflow consumes from the device's inbound stream (via `FUN_1401bac70(workflowBuf, fnByte, 1)`), and (c) a UTF-8 workflow name (via `FUN_14005faa0`). This is the per-workflow inbound fn-byte routing table.
2. **`FUN_1401f4390` (L10986-L13097)** is the **workflow state-machine executor**. The big `switch(iVar27)` at L11215 dispatches on the next workflow state (the IDs registered in step 1). Each state composes a payload, calls `FUN_14033ec70` (the fn=0x01 builder per [[iii-fn01-set-parameter-envelope]]), and many cases pick the action14 via a model-byte chained-equality block. This is the structural counterpart of [[iii-fn01-action-code-per-model-byte]].

There is NO `switch(fnByte)` style inbound dispatcher of the form II ships. III dispatches inbound by registry lookup, not by switch. A future agent searching for a fn-byte switch will not find one in this binary.

## 1. Instances of existing primitives

### 1.1 [[iii-host-emitter-fn-table]]

The `FUN_1401bac70` registration calls (~190 sites across `FUN_1401f0f10`) enumerate the fn-bytes each named workflow listens for. The set of distinct fn-bytes registered ranges over `0x00..0x47` with gaps at `0x27`. This corpus crosschecks the existing host-emitter list and adds the inverse perspective (device-emitted reply fn-bytes that the host registers callbacks for, including the host-emitter set since many fn-bytes are bidirectional).

Sample matches (workflow name → inbound fn-bytes from `FUN_1401bac70(buf, fn, 1)` calls):

| Workflow (dump line) | fn-bytes registered |
|---|---|
| "Query device version" (L132-140) | `0x00, 0x04, 0x05, 0x06, 0x08, 0x07, 0x46, 0x01` |
| "Initialization" (L172-176) | `0x00, 0x0e, 0x0f, 0x01` |
| "Query All Param Definitions" (L279-285) | `0x00, 0x0a, 0x0d, 0x0c, 0x47, 0x01` |
| "Change Preset" (L426-429) | `0x00, 0x11, 0x01` |
| "Save Preset" (L566-569) | `0x00, 0x10, 0x01` |
| "File Snapshot" / "File Export to Sysex" / "Get Preset Data" / "File Export to Templates" (L601-708) | `0x00, 0x19, 0x01` |
| "Paste Preset" (L811-815) | `0x00, 0x1f, 0x22, 0x01` |
| "Set Tempo" (L987-990) | `0x00, 0x23, 0x01` |
| "Delete Block" (L1023-1030) | `0x00, 0x02, 0x24, 0x25, 0x26, 0x03, 0x01` |
| "Insert Block" (L1063-1070) | `0x00, 0x02, 0x24, 0x28, 0x29, 0x03, 0x01` |
| "Block Connect" (L1351-1354) | `0x00, 0x33, 0x01` |
| "Move Block" (L1387-1393) | `0x00, 0x24, 0x02, 0x31, 0x03, 0x01` |
| "Import User Cab" (L1601-1605) | `0x00, 0x20, 0x22, 0x01` |
| "Batch set a block's parameter" (L2200-2203) | `0x00, 0x1d, 0x01` |
| "Listing preset and scene names" (L2235-2238) | `0x00, 0x1e, 0x01` |
| "Listing preset and scene names" (2nd, L2269-2272) | `0x00, 0x45, 0x01` |

Snippet (verbatim L132-140 "Query device version"):

```c
FUN_1401bac70(lVar2,0,1);
FUN_1401bac70(lVar2,4,1);
FUN_1401bac70(lVar2,5);
FUN_1401bac70(lVar2,6,1);
FUN_1401bac70(lVar2,8,1);
FUN_1401bac70(lVar2,7,1);
FUN_1401bac70(lVar2,0x46,1);
FUN_1401bac70(lVar2,1,1);
FUN_14005faa0(&local_res8,"Query device version");
```

`consumed_in:` path to add to `iii-host-emitter-fn-table.md`:

```
fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt (FUN_1401f0f10 L60-L2285 enumerates ~60 named async workflows and the inbound fn-bytes each one consumes; this is the bidirectional corpus, complementing the earlier host-emitter-only mining)
```

### 1.2 [[iii-fn01-action-code-per-model-byte]]

`FUN_1401f4390`'s big `switch(iVar27)` at L11215 is a state-machine executor where many states compose an fn=0x01 payload by calling `FUN_14033ec70` (the canonical fn=0x01 builder per [[iii-fn01-set-parameter-envelope]]). Multiple cases include the chained-equality model-byte block this primitive registers. NEW verified split + uniform sites:

| State case | Pattern | Action14 picked | Dump line |
|---|---|---|---|
| 0x07 | Pattern A (family bucket) | 0x10/0x11/0x12 → `0x1a`; else `0` | L11462 |
| 0x28 | Pattern A (family bucket) | 0x10/0x11/0x12 → `0x32`; else `0` | L12181 |
| 0x2a | Pattern A (family bucket) | 0x10/0x11/0x12 → `0x14`; else `0` | L12233 |
| 0x2f | Pattern A (family bucket) | 0x10/0x11/0x12 → `0x4e`; else `0` | L12369 |
| 0x31 | Pattern A (family bucket) | 0x10/0x11/0x12 → `0x36`; else `0` | L12393 |
| **0x32** | **Pattern A HALF-SPLIT** | **0x10/0x11 → `0x7a`; 0x12 → `0x81`** | **L12420-L12424** |
| 0x46 | Pattern A (family bucket) | 0x10/0x11/0x12 → `0x1a`; else `0` | L13076 |
| 0x47 | Uniform constant (no branch) | always `9` | L13089 |

Case 0x32 is a NEW half-split entry (FM9 diverges from III+FM3 sharing `0x7a`). It is the same shape as the existing table's `FUN_1401e41e0` entry (`0x72/0x72/0x79`) but at different action values, supporting that "FM9 splits alone" is a recurring half-split pattern, not a one-off.

Snippet (verbatim L12419-L12425 case 0x32):

```c
cVar10 = (char)param_1[0x33];
if ((cVar10 == '\x10') || (cVar10 == '\x11')) {
  uVar30 = 0x7a;
}
else if (cVar10 == '\x12') {
  uVar30 = 0x81;
}
*(undefined4 *)param_1[0x34] = uVar30;
```

The other Pattern-A "family bucket" cases (L11462, L12181, L12233, L12369, L12393, L13076) are instances of the existing `iii-multiproduct-editor-binary` Pattern B (treat III/FM3/FM9 as one family vs everything else). They confirm that this binary's state executor uses Pattern B as the dominant model-byte gate, with Pattern A (per-model split) reserved for the minority of cases where FM9 needs a different opcode.

`consumed_in:` path to add to both `iii-fn01-action-code-per-model-byte.md` AND `iii-multiproduct-editor-binary.md`:

```
fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt (FUN_1401f4390 workflow state-machine executor; 7 Pattern-A family-bucket sites + 1 Pattern-A half-split (case 0x32, L12420-L12424) inside the switch at L11215)
```

### 1.3 [[iii-multiproduct-editor-binary]]

Same evidence as 1.2. Every `if cVar10 == '\x10' || '\x11' || '\x12'` site in this dump is a Pattern A or Pattern B confirmation. The dump line refs above belong on this entry too. No new pattern shape; corpus expansion only.

### 1.4 [[iii-paramid-pseudo-sentinel-ranges]]

The dump contains an unrelated UI-update dispatcher (block-type switch around `FUN_14038f973`, L7048-L8470) that uses the `0xFFFx` pseudo-paramIds as lookup keys, supporting the claim that these IDs map to real UI widgets (not just placeholder markers):

| Site (dump line) | Pseudo-paramId used | Widget class |
|---|---|---|
| L7278 | `0xff04` | `CabNameLabel::RTTI_Type_Descriptor` |
| L7290 | `0xff05` | `CabNameLabel::RTTI_Type_Descriptor` |
| L7302 | `0xff06` | `CabNameLabel::RTTI_Type_Descriptor` |
| L8398, L8442 | `0xfff4` | `CabNameLabel::RTTI_Type_Descriptor` |

Snippet (verbatim L7278-L7287):

```c
case 0:
  lVar9 = FUN_1402574e0(param_1,*param_3,0xff04);
  if (lVar9 != 0) {
    local_168 = (undefined4 *)((ulonglong)local_168 & 0xffffffff00000000);
    lVar9 = FUN_140115ba4(lVar9,0,&FASEffectParam::RTTI_Type_Descriptor,
                          &CabNameLabel::RTTI_Type_Descriptor);
    if (lVar9 != 0) {
      *(undefined4 *)(lVar9 + 0x1009d4) = *(undefined4 *)(param_3 + 0x1e);
      FUN_14030e010(lVar9);
    }
  }
```

This is the "hypothesis on semantics" in the existing entry's body becoming evidence: the `0xFF00..0xFF13` cluster (CABINET case 0x0b) and the `0xFFFx` cluster both resolve to `CabNameLabel` lookups via `FUN_1402574e0` when the inbound UI dispatcher runs. The corpus stays on a single axis (still III only), so status remains `matched-singleton`.

`consumed_in:` path to add to `iii-paramid-pseudo-sentinel-ranges.md`:

```
fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt (FUN_14038f973 inbound-block UI dispatcher uses 0xff04/0xff05/0xff06/0xfff4 as CabNameLabel lookup keys at L7278-L7302, L8398, L8442; runtime evidence the pseudo-paramIds map to real widgets, not just UI separators)
```

## 2. Candidate net-new primitives

### 2.1 `iii-async-workflow-fn-registry`

Proposed frontmatter:

```yaml
---
name: iii-async-workflow-fn-registry
class: dispatch-context
status: matched-singleton
discovered: 2026-05-22 (primitives mine of ghidra-axe-edit-iii-inbound-dispatcher.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-iii-async-workflow-fn-registry
relates_to: [iii-host-emitter-fn-table, iii-fn01-set-parameter-envelope, iii-multiproduct-editor-binary]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
---
```

**Summary**: AxeEdit III routes inbound SysEx by a named-workflow registry, not a fn-byte switch. Each of ~60 workflows (`FUN_1401f0f10` L60-L2285) registers a tuple `(workflowName, [fn-bytes], stateIdEntry, stateIdExit)` via `FUN_1401bac70(buf, fn, 1)` + `FUN_14005faa0(&handle, name)`. When the device emits a SysEx with fn=X, the dispatcher (not in this dump) looks up which workflow registered fn=X and calls `FUN_1401f4390` with the workflow's next state ID.

**Why this is a primitive**: tells future RE work that fn-byte semantics on III are workflow-scoped (`fn=0x33` ONLY means "Block Connect reply" because Block Connect registered it; nothing else registers it). The same fn-byte under a different workflow could carry different meaning. The registry is the ground truth.

**Evidence**: ~60 distinct `FUN_14005faa0(&local_*, "<Workflow Name>")` strings (L140-L2272) paired with the preceding `FUN_1401bac70` calls. Fully enumerated above in §1.1's headline table; the dump's L60-L2285 IS the complete enumeration.

**Cross-device transfer outlook**: a similar registry pattern likely exists in AxeEdit II (different fn-byte vocabulary; different builder function). Confirming the same primitive applies to II would promote this to `matched`. AM4-Edit likely has a thinner equivalent given fewer named workflows. Hydra is not in the family.

**Why matched-singleton, not partial-N1**: this primitive is "the registry mechanism exists at this address in this binary." It is fully generalized within the III binary axis (one binary, complete enumeration, no missing rows). Path to `matched` is "find the same mechanism in AxeEdit II's binary", a second axis (different device family). Filed as a follow-up Ghidra mining task.

**N=1 vs N>=2**: ~60 named-workflow fixtures within the same axis (III editor binary). The fixture count is N=60 per workflow but only N=1 on the device axis. Hence `matched-singleton`.

### 2.2 `iii-workflow-state-machine-executor`

Proposed frontmatter:

```yaml
---
name: iii-workflow-state-machine-executor
class: dispatch-context
status: matched-singleton
discovered: 2026-05-22 (primitives mine of ghidra-axe-edit-iii-inbound-dispatcher.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-iii-workflow-state-machine-executor
relates_to: [iii-async-workflow-fn-registry, iii-fn01-action-code-per-model-byte, iii-fn01-set-parameter-envelope, iii-multiproduct-editor-binary]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
---
```

**Summary**: `FUN_1401f4390` (L10986-L13097) is the AxeEdit III workflow state-machine executor. Its body is a single large `switch(iVar27)` at L11215 where `iVar27` is the next state ID drawn from the workflow's state-list (`param_2[3]` per L11187). Each case implements one workflow step. The cases that emit SysEx call `FUN_14033ec70` (the fn=0x01 builder) and many of them choose the `action14` constant via a model-byte chained-equality block (Pattern A) per [[iii-fn01-action-code-per-model-byte]].

**Why this is a primitive**: locating the inbound dispatch in III binaries does NOT start with a fn-byte switch. It starts with the workflow registry (§2.1) and ends at this state-machine executor. Without registering this primitive, the next agent will re-search for the non-existent fn-byte switch.

**Evidence**: ~70 case labels observed in the switch (sample at L11216, L11222, L11228, L11233, L11386, L11456, L11471, L11478, L11519, L11548, L11580, L11608, L11644, L11672, L11678, L11684, L11691, L11722, L11764, L11771, L11778, L11785, L11814, L11843, L11864, L11882, L11912, L11948, L11988, L12022, L12092, L12112, L12125, L12135, L12151, L12158, L12165, L12176, L12195, L12227, L12243, L12272, L12301, L12334, L12362, L12381, L12388, L12403, L12437, L12477, L12608, L12640, L12669, L12697, L12726, L12769, L12801, L12830, L12867, L12897, L12926, L12955, L12983, L13013, L13041, L13070, L13085). The state-ID space matches the entry/exit IDs registered in `FUN_1401f0f10`'s registry (~60 workflows × 2 state IDs each ≈ 120 IDs; observed switch labels are dense in `0..0x47`, suggesting the upper-half IDs may dispatch elsewhere or share handlers).

**Cross-device transfer outlook**: II's editor likely uses a similar executor (its workflow vocabulary is smaller; the fn-byte set is different). Confirming the pattern in AxeEdit II's binary would promote to `matched`.

**N=1 vs N>=2**: 1 executor function with ~70 state cases. Fixture count is the case count; axis count is 1 (III editor binary). `matched-singleton`.

## 3. Negative findings

### 3.1 `iii-fn-byte-switch-as-inbound-dispatcher` (proposed `_negative/`)

Proposed frontmatter:

```yaml
---
name: iii-fn-byte-switch-as-inbound-dispatcher
class: dispatch-context
status: non-matching
discovered: 2026-05-22 (primitives mine of ghidra-axe-edit-iii-inbound-dispatcher.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
relates_to: [iii-async-workflow-fn-registry, iii-workflow-state-machine-executor, ii-axeedit-opcode-table]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
---
```

**Hypothesis ruled out**: that AxeEdit III contains a function with a top-level `switch(fnByte)` (where `fnByte = payload[5]` after the `F0 00 01 74 10` envelope prefix) routing each inbound fn-byte to a per-fn handler, the way II's [[ii-axeedit-opcode-table]] suggests by analogy.

**Evidence the hypothesis fails**:

1. The dump enumerates the TOP-40 functions ranked by "distinct fn-byte literals touched" (L7-L51). The leader is `FUN_1401f0f10` with 20 distinct fn-bytes, second is `FUN_1402a3300` with 18, third is `FUN_1402d6fa0` with 17. None of these are a fn-byte switch:
   - `FUN_1401f0f10` is the workflow REGISTRY (§2.1), not a dispatcher; it touches 20 fn-bytes because it passes them as the second argument to `FUN_1401bac70` to register them, not because it dispatches on them.
   - `FUN_1401f4390` (rank ~9) is the state-machine EXECUTOR (§2.2), switching on workflow state ID, not fn-byte.
   - The remaining candidates similarly touch fn-bytes via builder calls or per-workflow logic, not via switch-on-fn-byte.
2. No function in the top-40 contains a `switch` whose case labels are the III fn-byte vocabulary (`0x77/0x78/0x79`, `0x46/0x47`, `0x19/0x1a/0x1b/0x1c`, etc.). The block-type / state-ID switches do exist (FUN_14038f973 at L7048 switches on block type; FUN_1401f4390 at L11215 switches on workflow state) but neither uses fn-bytes as case labels.
3. The actual dispatch shape is registry-lookup: device emits fn=X → lookup which workflow registered fn=X → call `FUN_1401f4390(workflow, nextStateId)`. The lookup table is built dynamically at startup by `FUN_1401f0f10`.

**Search terms to avoid re-attempting**:
- "Ghidra search for switch on payload[5]" against AxeEdit III's `.text`
- "find the III inbound fn-byte dispatcher" as a flat-switch construct
- "expect III's inbound to mirror II's `ii-axeedit-opcode-table` switch shape", it does not, II uses a static OpcodeDescriptor table; III uses a runtime-registered workflow table.

**What to look for instead**: search for callers of `FUN_1401bac70(buf, <fn-byte>, 1)` (registration) and `FUN_14040e6f0` (workflow attach, observed at L2273) to find more workflow definitions. The non-FUN_1401f0f10 workflows (PC Mapping, EXTERNAL CONTROL, INITIAL VALUE, etc.) shown in `FUN_1402a3300` L2768-L3012 use a slightly different shape but follow the same registry model.

## Notes on consumed_in: path updates

Each existing-primitive entry's `consumed_in:` block should add one line citing this dump (paths above in §1.1-§1.4). I have NOT modified any primitives files; the founder reviews and promotes.

## Out-of-scope but flagged

`FUN_1402a3300` (L2288-end of dump section) is a second registry/builder that handles PC Mapping, EXTERNAL CONTROL, INITIAL VALUE, Tempo Tap, Tuner, Preset Increment, Scene Decrement, Input/Output Volume controls, etc. (L2768-L3604). It is a SEPARATE workflow family from the one in `FUN_1401f0f10`. If a future agent decodes inbound footswitch / PC-mapping events, this is the function to read. Not registered as a primitive in this pass because it appears to be a different abstraction layer (UI-binding) rather than a wire-protocol primitive.

The top-40 "distinct fn-byte" ranking at L7-L51 is itself a useful artifact: it confirms that no single function in this binary is the inbound dispatcher in II's sense, and it pins the top candidates (workflow registry, state-machine executor, UI binding registry, PC-mapping registry).
