# AM4-Edit, Binary Anatomy

Class architecture, key functions, and RVA constants discovered in the
AM4-Edit binary.

Ghidra project: a local AM4-Edit Ghidra project (auto-analyzed,
persistent).

## Status

AM4-Edit is mature ([[../primitives/INDEX.md]] shows AM4 at 100% param
catalog coverage). Most of the binary's interesting structures are
already mined; this doc captures the open targets the synthesis pass
2026-05-22 flagged.

---

## Key functions

### Host-emitter map (`MapAM4EditHostEmitters.java` output)

`ghidra-am4-edit-host-emitter-map.txt` (19 KB) lists the AM4 fn-bytes
the host can emit + the emitter functions. The synthesis pass
identified these as net-new MCP capabilities not yet surfaced:

| fn-byte | Workflow label | Direction | Status |
|---|---|---|---|
| 0x15 | Paste Preset | host emit | un-wired in MCP |
| 0x28 | Block Copy | host emit | un-wired in MCP |
| 0x29 | Block Paste | device → host only | informational |
| 0x26 | Library Query / Block Move | device → host only | informational |
| 0x2A, 0x2E | Channel Copy/Paste/Swap family | device → host only | informational |
| **0x30** | **Batch set a block's parameter** (4 emitters) | host emit | **NATIVE multi-param atomic write**: un-mined wire shape, ~45 min hardware to confirm |

The 0x30 batch-param-set is the highest-leverage AM4 finding. If the
descriptor table for fn=0x30 is dumped (clone of
`DumpAxeEditIIIMiscDescriptors.java` for AM4 binary), the wire shape
is known without hardware.

### Workflow catalog (`FindAM4EditWorkflowCatalog.java` output)

`ghidra-am4-edit-workflow-catalog.txt` (586 KB): half a megabyte of
AM4-Edit workflow decompiles that haven't been touched since the dump
landed . Likely contains the fn=0x30 emitter detail +
other multi-emitter workflows.

### SysEx builders (`FindAM4SysExBuilder.java` output)

`ghidra-am4-edit-sysex-builders.txt` (62 KB): all AM4 message
builders, post-Ghidra. Same shape mining as the III actions-and-shapes
file.

---

## What's still un-mined

- **AM4 fn=0x30 batch-param-set descriptor table.** Clone
  `DumpAxeEditIIIMiscDescriptors.java` adapted for the AM4 binary; the
  descriptor table for fn=0x30 yields the wire shape. ~15 minutes
  Ghidra. Then ~30 minutes hardware probe to confirm. Closes a new
  MCP capability `am4_batch_set_params`.
- **AM4 envelope-spec descriptor tables** (analog of II `0xe04440` and
  III `0x1407ab440` etc.). The mechanism is universal (per
  [[../primitives/vendor-envelope-descriptor-table]]); a misc-descriptors
  variant for the AM4 binary would close any remaining "what does
  fn-byte X carry" questions.
- **AM4 preset binary layout**: `samples/captured/am4-binary-decode-findings-2026-05-21.md`
  reports a 22% noise floor in single-param-diff probing. Path forward
  (per the findings doc): cross-correlate across 104 factory presets
  to identify position-invariant block-layout fields. ~1 day TS work.
  Yield: AM4 `dump_preset` / `restore_preset` parity with II, feature,
  not P0.

---

## Refinement history

- Pre-Session-08: AM4 envelope shape + XOR-7F checksum codified
  ([[../primitives/xor-7f-envelope-checksum]]).
- : `param-descriptor-16byte` confirmed on AM4 binary.
- 2026-05-22 (synthesis pass): fn=0x30 batch-param-set surfaced as
  highest-leverage AM4 next move. AM4 envelope-spec descriptor table
  mining is the cheap precursor.
