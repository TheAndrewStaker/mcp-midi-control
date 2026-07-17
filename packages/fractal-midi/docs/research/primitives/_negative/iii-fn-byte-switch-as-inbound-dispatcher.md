---
name: iii-fn-byte-switch-as-inbound-dispatcher
class: dispatch-context
status: non-matching
discovered: 2026-05-22 (primitives-mine of ghidra-axe-edit-iii-inbound-dispatcher.txt)
verified_on:
  - axe-edit-iii-binary
  - am4-edit-binary
firmware_sensitive: false
golden: STUB (structural-only; negative finding: verification is grep-against the inbound-dispatcher dumps in consumed_in; see Search terms to avoid re-attempting)
retest_when:
  - a new AxeEdit III / AM4-Edit major release whose inbound dispatch shape changes (re-run the inbound-dispatcher dump + top-40 fn-byte-literal scan; the entry's own refinement history names this as the only re-opening evidence)
relates_to: [iii-async-workflow-fn-registry, iii-workflow-state-machine-executor, ii-axeedit-opcode-table]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
  - samples/captured/decoded/ghidra-am4-edit-preset-parser.txt
---

# Negative: Fractal async-workflow editors have no `switch(fnByte)` inbound dispatcher

(Slug retains the III-prefix for grep-stability; the finding now
applies cross-device to every Fractal editor using the
[[iii-async-workflow-fn-registry]] dispatch model; III + AM4 verified.)

## Hypothesis ruled out

That a Fractal async-workflow editor contains a function with a
top-level `switch(fnByte)` (where `fnByte = payload[5]` after the
`F0 00 01 74 <model>` envelope prefix) routing each inbound fn-byte
to a per-fn handler, the way II's [[ii-axeedit-opcode-table]]
suggests by analogy.

## Why the hypothesis fails

1. The dump
   `samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt`
   enumerates the top-40 functions ranked by "distinct fn-byte literals
   touched" (L7-L51). The leader is `FUN_1401f0f10` with 20 distinct
   fn-bytes, second is `FUN_1402a3300` with 18, third is `FUN_1402d6fa0`
   with 17. **None of these are a fn-byte switch:**
   - `FUN_1401f0f10` is the workflow REGISTRY
     ([[iii-async-workflow-fn-registry]]), not a dispatcher; it
     touches 20 fn-bytes because it passes them as the second argument
     to `FUN_1401bac70` to register them, not because it dispatches on
     them.
   - `FUN_1401f4390` (rank ~9) is the state-machine EXECUTOR
     ([[iii-workflow-state-machine-executor]]), switching on workflow
     state ID, not fn-byte.
   - The remaining top-40 candidates touch fn-bytes via builder calls
     or per-workflow logic, never via a switch keyed on fn-byte.

2. No function in the top-40 contains a `switch` whose case labels are
   the III fn-byte vocabulary (`0x77/0x78/0x79`, `0x46/0x47`,
   `0x19/0x1a/0x1b/0x1c`, etc.). Block-type / state-ID switches do
   exist (`FUN_14038f973` at L7048 switches on block type;
   `FUN_1401f4390` at L11215 switches on workflow state) but neither
   uses fn-bytes as case labels.

3. The actual dispatch shape is registry-lookup: device emits fn=X →
   lookup which workflow registered fn=X → call
   `FUN_1401f4390(workflow, nextStateId)`. The lookup table is built
   dynamically at startup by `FUN_1401f0f10`.

## Search terms to avoid re-attempting

- "Ghidra search for `switch` on `payload[5]`" against AxeEdit III's
  `.text`: there is no such function in the III editor binary.
- "find the III inbound fn-byte dispatcher" as a flat-switch
  construct: the dispatch is registry-lookup, not a switch.
- "expect III's inbound to mirror II's [[ii-axeedit-opcode-table]]
  switch shape". It does not. II uses a static `OpcodeDescriptor`
  table in `.rdata`; III uses a runtime-registered workflow table.

## What to look for instead

- Callers of `FUN_1401bac70(buf, <fn-byte>, 1)` enumerate which
  workflows listen for the device emitting a given fn-byte.
- `FUN_14040e6f0` (workflow attach; observed at
  inbound-dispatcher.txt L2273) reveals additional workflow
  attachments beyond the L60-L2285 registry block.
- `FUN_1402a3300` (L2288 onward) is a SECOND registry/builder for PC
  Mapping, EXTERNAL CONTROL, INITIAL VALUE, Tempo Tap, Tuner,
  Preset Increment, Scene Decrement, Input/Output Volume controls,
  etc. Different abstraction layer (UI-binding) but follows the
  same registry-lookup model.

## Refinement history

- 2026-05-22 (initial finding): primitives-mine of
  `ghidra-axe-edit-iii-inbound-dispatcher.txt` confirmed by
  exhaustive search of the top-40 fn-byte-touching functions that no
  flat `switch(fnByte)` exists. Filed as negative; future agents
  should not re-attempt this hypothesis without new evidence (e.g. a
  later AxeEdit III firmware that switches dispatch shape).
- 2026-05-28 (AM4 axis confirmation): independent verification
  against AM4-Edit.exe via `FindAM4EditPresetParser.java`. The script
  searched the entire `.text` for functions touching ALL THREE of
  fn-bytes 0x77 / 0x78 / 0x79 as immediates (the preset-dump
  triplet). **Zero matches.** Top-ranked candidates by 0x77 / 0x78
  count alone all decompiled to false positives:
  - `FUN_140462910` ([0x77=7]): JUCE LookAndFeel UI code; 0x77
    immediates are JUCE Identifier hashes
  - `FUN_1402d47f0` ([0x78=10]): UI dropdown builder iterating
    "Channel %C" labels; 0x78 immediates are stack-frame offsets
  - `FUN_140049c10` ([0x78=14]): unrelated UI code
  Same architectural model as III confirmed: AM4-Edit routes inbound
  via the workflow registry at `FUN_1402d83d0` (analog of III's
  `FUN_1401f0f10`); workflow state determines dispatch, not fn-byte.
  Body promoted to cross-device. Slug retains III prefix
  (grep-stability).
- 2026-05-28 cont (AM4 sharpening, small-vs-bulk hybrid): the
  HOP 2 classification of `AM4DeviceManager::vftable` slots 3-10
  surfaced `FUN_1402ddb80` (AMDM vtable slot 4) as AM4-Edit's
  **inbound message dispatcher**, and it DOES contain a literal
  `switch(fnByte)`, but only for short one-shot response opcodes:
  `0x00` (stream-start), `0x01` (stream-end / fn=0x01 ack), `0x03`
  (Query Device Version), `0x08` (Library Load), `0x19` (Refresh
  Cabinet Names), `0x47` (uncategorized). The dispatcher emits the
  log string `"DeviceManager: Message timed out for opCode: 0x%X.
  Recvd %d, expected %d."` confirming the role. **The rule-out
  remains correct for the bulk preset-binary frames `0x77/0x78/0x79`
  specifically**: those are absent from the switch and routed
  through the `iVar6 == 3` "other" status branch (multi-frame
  stream-accumulation path) or the `cVar5 == 0x01` stream-end
  handler `FUN_1402da830`. Refined claim: the rule-out is "no
  literal-switch dispatcher for **bulk multi-frame preset-binary
  streams** (the 0x77/0x78/0x79 triplet)", not "no fn-byte switch
  anywhere." AM4-Edit uses a hybrid: small synchronous responses
  via fn-switch in `FUN_1402ddb80`; bulk streams via
  workflow-state-driven accumulation reachable via the same
  dispatcher's stream-end branch.
