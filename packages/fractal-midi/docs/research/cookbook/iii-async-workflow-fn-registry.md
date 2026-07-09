---
name: iii-async-workflow-fn-registry
class: dispatch-context
status: matched
discovered: 2026-05-22 (cookbook mine of ghidra-axe-edit-iii-inbound-dispatcher.txt)
verified_on:
  - axe-edit-iii-binary
  - am4-edit-binary
firmware_sensitive: false
golden: STUB (structural grep-against-dump; no pure-CPU fixture applies, see Verification path)
relates_to: [iii-host-emitter-fn-table, iii-fn01-set-parameter-envelope, iii-multiproduct-editor-binary, iii-workflow-state-machine-executor]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
  - samples/captured/decoded/ghidra-am4-edit-preset-parser.txt
---

# Async-workflow fn-byte registry (AxeEdit III + AM4-Edit)

AxeEdit III and AM4-Edit both route inbound SysEx by a runtime-registered
**named-workflow registry**, not by a `switch(fnByte)` dispatcher of the
kind the II's [[ii-axeedit-opcode-table]] suggests by analogy. Each
workflow registers a tuple `(workflowName, [fn-bytes], stateIdEntry,
stateIdExit)` via repeated calls to a registration helper, followed by a
name-binding call.

Binary-specific sites:

| Editor | Registry constructor | Registration helper | Name binder |
|---|---|---|---|
| AxeEdit III | `FUN_1401f0f10` | `FUN_1401bac70(buf, fnByte, 1)` | `FUN_14005faa0(&handle, name)` |
| AM4-Edit | `FUN_1402d83d0` | `FUN_140196500(buf, fnByte, 1)` | `FUN_140060fb0(&handle, name)` |

The III registry enumerates ~60 workflows over L60-L2285 of
`ghidra-axe-edit-iii-inbound-dispatcher.txt`. AM4-Edit's registry holds
fewer workflows (single-shot device; ~35 distinct names observed) but
the structural pattern (the same per-fn-byte registration helper, the
same paired (request_id, response_id) workflow ints written at the
workflow-object offset, the same name-binder call) is byte-for-byte
the same architectural shape across both editors.

When the device emits a SysEx with fn=X, the dispatcher (not present in
this dump) looks up which workflow registered fn=X and hands control to
`FUN_1401f4390` (see [[iii-workflow-state-machine-executor]]) with the
workflow's next state ID.

## Formal definition

The registration pattern, observed at every workflow site in
`FUN_1401f0f10`:

```c
FUN_1401bac70(workflowBuf, fnByteA, 1);   // register fn-byte A
FUN_1401bac70(workflowBuf, fnByteB, 1);   // register fn-byte B
// ... additional fn-byte registrations
FUN_14005faa0(&workflowHandle, "Workflow Name");
```

Verbatim snippet, L132-140 (the "Query device version" workflow):

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

This workflow listens for device replies with fn-bytes
`{0x00, 0x04, 0x05, 0x06, 0x07, 0x08, 0x46, 0x01}` while running the
"Query device version" state sequence.

## Sample registry rows

Selected workflow → registered-fn-bytes pairs from the L60-L2285
enumeration:

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

The fn-byte vocabulary across the full registry ranges over `0x00..0x47`
with a gap at `0x27`. `0x00` and `0x01` appear in nearly every workflow
(generic start-of-stream / fn=0x01 PARAMETER ack channels).

## Why this is a primitive

Tells future RE work that fn-byte semantics on III are **workflow-
scoped**: `fn=0x33` ONLY means "Block Connect reply" because Block
Connect registered it; nothing else registers it. The same fn-byte
under a different workflow could in principle carry different
semantics, though in practice the registry rows above show no
cross-workflow fn collisions outside the generic `0x00 / 0x01` pair.

The registry is the ground truth for "what fn-bytes can the III emit"
and "which UI action a given inbound fn-byte belongs to."

## Where it's used

Mechanical decode of a captured III reply frame proceeds:

1. Grep this registry for the captured fn-byte.
2. The matching workflow row identifies the UI action that triggered
   the device-side reply.
3. The workflow's state-machine cases in `FUN_1401f4390` (see
   [[iii-workflow-state-machine-executor]]) show how that reply is
   consumed.

The registry also complements [[iii-host-emitter-fn-table]]: the
host-emitter table is the host's outbound vocabulary; the registry is
the device's inbound vocabulary (which a workflow may listen for).
Many fn-bytes are bidirectional, so the two tables overlap.

## Misapplication failure modes

- **DO NOT** assume a fn-byte's semantics are global. If a future
  workflow re-registers fn=0x33 with a different parent workflow, the
  semantics change. Grep the registry before claiming "fn=X means Y."
- **DO NOT** search for a flat `switch(fnByte)` in III binaries; see
  the corresponding negative entry
  `_negative/iii-fn-byte-switch-as-inbound-dispatcher.md`.

## Where it does NOT apply

- Axe-Fx II's editor uses the static [[ii-axeedit-opcode-table]] (a
  flat `OpcodeDescriptor` table in `.rdata`). The runtime-registered
  workflow model is III + AM4 in the current cookbook corpus.
  AxeEdit II likely has a thinner workflow registry for its own
  multi-step actions; confirming the same primitive applies to II
  would add a third axis point.
- Hydrasynth is NRPN-based; not in the family.

## Verification path

This is a structural observation against a static dump rather than a
pure-CPU algorithm, so no `cookbook-verify` fixture applies. The
verification is grep-against-dump: every workflow row above cites a
specific dump line range; opening the dump at that range shows the
verbatim `FUN_1401bac70` + `FUN_14005faa0` pair.

## Refinement history

- 2026-05-22 (initial discovery): cookbook mine of
  `ghidra-axe-edit-iii-inbound-dispatcher.txt` enumerated ~60 named
  workflows in `FUN_1401f0f10` L60-L2285. Status filed as
  `matched-singleton` because the corpus is fully generalized within
  the III editor binary axis but has only one device-family axis
  point. Path to `matched`: confirm the same registry pattern in
  another Fractal editor binary (a second axis).
- 2026-05-28 (AM4 axis confirmation): mining for the AM4-Edit preset-
  dump parser via magic-immediate scoring (`FindAM4EditPresetParser.java`)
  surfaced `FUN_1402d83d0` as the AM4-Edit equivalent of III's
  `FUN_1401f0f10`. Same pattern: per-fn-byte registration helper
  (`FUN_140196500`, 139 callers across the binary), name-binder call
  (`FUN_140060fb0`), workflow-object request/response int pair written
  at the head of each workflow's offset block. ~35 named workflows
  observed including "Query device version", "Initialization",
  "Save Preset", "Get Preset Data", "Refresh Preset Names",
  "Block Copy", "Block Paste", "Channel Copy/Paste/Swap", "Change
  Scene", "Paste Preset". Status promoted matched-singleton → matched
  (II remains an open axis; AxeEdit II's `OpcodeDescriptor` table is
  a static-`.rdata` cousin, possibly with a parallel workflow registry
  not yet investigated).
