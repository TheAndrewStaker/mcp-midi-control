---
name: iii-workflow-state-machine-executor
class: dispatch-context
status: matched-singleton
discovered: 2026-05-22 (cookbook mine of ghidra-axe-edit-iii-inbound-dispatcher.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: STUB (structural-only; grep-against-dump verification, see Verification path)
relates_to: [iii-async-workflow-fn-registry, iii-fn01-action-code-per-model-byte, iii-fn01-set-parameter-envelope, iii-multiproduct-editor-binary]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
---

# AxeEdit III workflow state-machine executor (FUN_1401f4390)

`FUN_1401f4390` (Ghidra dump
`samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt`
L10986-L13097) is AxeEdit III's **workflow state-machine executor**.
Its body is a single large `switch(iVar27)` at L11215 where `iVar27` is
the next state ID drawn from the active workflow's state-list
(`param_2[3]` per L11187). Each case implements one workflow step.

The state-IDs are the entry/exit IDs registered in the workflow registry
([[iii-async-workflow-fn-registry]]). Roughly 60 workflows × 2 state IDs
each ≈ 120 IDs; observed switch labels in this dump are dense in
`0..0x47`. Cases that emit SysEx call `FUN_14033ec70` (the canonical
fn=0x01 builder per [[iii-fn01-set-parameter-envelope]]), and many of
them pick the action14 constant via a model-byte chained-equality block
(Pattern A / Pattern B per [[iii-fn01-action-code-per-model-byte]] and
[[iii-multiproduct-editor-binary]]).

## Formal definition

Executor signature (sketch from Ghidra):

```c
void FUN_1401f4390(WorkflowContext *param_1, ...) {
  // param_2[3] is a state-list pointer; iVar27 is the next state ID.
  int iVar27 = nextStateId(param_2[3]);
  switch (iVar27) {
    case 0x07: {
      // ... build a fn=0x01 payload (action14 chosen by model byte)
      // ... call FUN_14033ec70 to send
      break;
    }
    case 0x28: { /* ... */ break; }
    // ~70 case labels observed in the L11215 switch
  }
}
```

Observed case-label density (sampled from the dump):

L11216, L11222, L11228, L11233, L11386, L11456, L11471, L11478, L11519,
L11548, L11580, L11608, L11644, L11672, L11678, L11684, L11691, L11722,
L11764, L11771, L11778, L11785, L11814, L11843, L11864, L11882, L11912,
L11948, L11988, L12022, L12092, L12112, L12125, L12135, L12151, L12158,
L12165, L12176, L12195, L12227, L12243, L12272, L12301, L12334, L12362,
L12381, L12388, L12403, L12437, L12477, L12608, L12640, L12669, L12697,
L12726, L12769, L12801, L12830, L12867, L12897, L12926, L12955, L12983,
L13013, L13041, L13070, L13085: ~70 case labels, suggesting state IDs
in the lower half of the registered-ID space dispatch here.

## Model-byte selection inside states

State cases that select `action14` per model byte use the chained-
equality block per [[iii-fn01-action-code-per-model-byte]]. New rows
observed in this dump:

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

Verbatim snippet, L12419-L12425 (case 0x32, the HALF-SPLIT row where FM9
diverges from III + FM3):

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

The half-split shape is structurally identical to the existing
[[iii-fn01-action-code-per-model-byte]] `FUN_1401e41e0` entry
(`0x72/0x72/0x79`) but at different action values. Confirms that the
"FM9 splits alone" pattern is recurring in this binary, not a one-off.

## Why this is a primitive

Locating the inbound dispatch in III binaries does NOT start with a
fn-byte switch (that hypothesis is ruled out, see the corresponding
negative entry `_negative/iii-fn-byte-switch-as-inbound-dispatcher.md`).
It starts with the workflow registry
([[iii-async-workflow-fn-registry]]) and ends at this state-machine
executor. Without registering this primitive, the next agent will
re-search for the non-existent fn-byte switch.

## Where it's used

Decoding a captured III reply frame, given its fn-byte:

1. Find which workflow registered the fn-byte (registry primitive).
2. Read the workflow's state cases inside this executor's switch.
3. The cases show how the reply is consumed and what the next outbound
   frame (if any) will look like.

Cross-references to [[iii-fn01-set-parameter-envelope]] are dense
inside this executor: every state case that emits a fn=0x01 frame goes
through `FUN_14033ec70`.

## Misapplication failure modes

- **DO NOT** assume the switch label is a fn-byte. The labels are
  state IDs; the fn-byte vocabulary lives in the registry primitive,
  not here.
- **DO NOT** read this executor in isolation. Without the registry it
  is impossible to tell which workflow a given state belongs to. The
  registry-executor pair is the unit of analysis.

## Where it does NOT apply

- Axe-Fx II's editor uses the static [[ii-axeedit-opcode-table]] for
  outbound and (presumably) a different inbound dispatch shape. A
  future Ghidra pass against AxeEdit II's binary would confirm
  whether II has an analog state-machine executor. If yes, this
  entry promotes to `matched`.
- AM4-Edit DOES have async multi-step workflows
  ([[iii-async-workflow-fn-registry]]'s 2026-05-28 cross-device
  refinement landed AM4 as the second axis). The state-machine
  executor function itself is not yet pinned in AM4-Edit; the
  candidate is `FUN_1402da830` reached from the inbound dispatcher
  `FUN_1402ddb80` (AMDM vtable slot 4) via the fn=0x01 stream-end
  handler. If that decompiles to a switch on workflow state with
  cases that emit fn=0x01 or consume bulk preset-binary frames, this
  entry promotes to `matched` with AM4 as the second axis.

## Verification path

Structural observation; no `cookbook-verify` fixture. Verification is
grep-against-dump: every case label and Pattern-A row above cites a
specific dump line range.

## Refinement history

- 2026-05-22 (initial discovery): cookbook mine of
  `ghidra-axe-edit-iii-inbound-dispatcher.txt` identified
  `FUN_1401f4390` L10986-L13097 as the state-machine executor with
  ~70 case labels and 8 Pattern-A model-byte rows (1 of them a
  half-split). Filed `matched-singleton`; path to `matched` is
  confirming the analog executor in AxeEdit II's binary.
- 2026-05-28 (AM4-Edit cross-device refinement): the stale "AM4-Edit
  has no async multi-step workflows" claim in "Where it does NOT
  apply" struck. AM4-Edit class hierarchy decode landed
  `AM4DeviceManager` + `FasStateMachine` + `DeviceMgrStateMachine` +
  42 embedded workflow instances + the workflow registry at
  `FUN_1402d83d0` (see [[iii-async-workflow-fn-registry]]'s 2026-05-28
  refinement-history row). The AM4 analog of `FUN_1401f4390` is not
  yet pinned: HOP 2 (`DecompileAndClassifyDMSMSlots.java`) ruled out
  6 DMSM vtable slots + 7 AMDM vtable slots as the state-machine
  executor; the inbound dispatcher `FUN_1402ddb80` (AMDM slot 4)
  landed as a side-finding with the AM4 chunk-1 parser path now
  predicted at `FUN_1402da830` (reached from the dispatcher's fn=0x01
  stream-end branch). HOP 3 mines that path. Status stays
  `matched-singleton` until HOP 3 lands.
- 2026-05-28 (HOP 3 result: AM4 analog FALSIFIED, status locked):
  `DecompileAM4InboundStreamPath.java` decompiled `FUN_1402da830`
  (the predicted AM4 analog) plus all other dispatcher first-level
  callees. `FUN_1402da830` is a **single-param SET_PARAMETER
  response unpacker** (5-field 14-bit header + a canonical septet-7-
  bit unpack loop on bytes from +16 onwards), not a workflow
  state-machine executor. Zero switch/case statements; zero anchor-
  offset hits; the function processes single-param replies where
  the 3rd 14-bit field equals `0xd` (a specific param-class filter)
  and unpacks the packed-value payload into `AM4DeviceManager +
  0x594`. Same pattern as the other dispatcher callees, NONE of
  which are state-machine executors. The library-load handler
  `FUN_1401da990` revealed the canonical AM4-Edit inbound-parse
  mechanism: **descriptor-table-driven** ([[vendor-envelope-
  descriptor-table]]) field-by-field `(mid, byte_count)` walk over
  the 54 mined tables at `0x1405dc190..0x1405dd160`. NOT a state-
  machine executor switching on workflow state. **Conclusion**:
  AM4-Edit's architecture does not use the III `FUN_1401f4390`
  pattern at the function-shape level; the analog does NOT exist
  in AM4-Edit. Status stays `matched-singleton` permanently; the
  promotion-to-`matched` path now requires landing the pattern in
  a different binary (AxeEdit II is the remaining cross-device
  candidate). The bulk preset-binary parsing path that III's
  executor was hypothesized to handle is, on both AM4 and III,
  not a per-param decode but an opaque-blob accumulator (see new
  negative entry [[_negative/editor-side-chunk-1-inner-decode]]).
  Full evidence: `packages/fractal-midi/docs/devices/am4/preset-
  binary-format-research.md` §13.
