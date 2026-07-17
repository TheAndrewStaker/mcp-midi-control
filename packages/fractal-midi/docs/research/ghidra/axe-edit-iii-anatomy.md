# AxeEdit III, Binary Anatomy

Class architecture, key functions, and RVA constants discovered in the
AxeEdit III (64-bit) binary. Sister file to `axe-edit-ii-anatomy.md`.

Ghidra project: a local Axe-Edit III Ghidra project (auto-analyzed,
persistent, DO NOT delete; orphans all III scripts in
`scripts/ghidra/`).

## Headline (2026-05-22)

The III preset binary envelope is **byte-identical in shape** to the
II preset binary envelope. Both use the same
[[../primitives/vendor-envelope-descriptor-table]] mechanism. Descriptor
tables at `0x1407ab440` + `0x1407aba40` + 24 more in `.rdata`
declare the per-fn envelope shapes. **Table `0x1407ab940` carries
the 1024-ushort × 3-byte preset-binary payload, the III equivalent
of II's `0xe04440` chunk table.**

All 26 III descriptor tables extracted 2026-05-22 via
`scripts/_research/parse-ghidra-decompile.ts` in the consumer repo; JSON
output at `samples/captured/decoded/ghidra-axe-edit-iii-{dump,misc}-descriptors.descriptors.json`.

---

## Key functions

### `FUN_140337060`, store-preset emitter

Walks descriptor table at `0x1407ab2f0`. The III analog of the II
preset binary buffer walk (`FUN_00513184`). Hash computation reachable
from this function, likely calls the III XOR-fold hash (analog of
II `FUN_00544cc0`, not yet decompile-dumped; cloneable via
`DumpAxeEditIIIFooterHash.java` once written).

### `FUN_14014d2a0`, PRESET_DUMP HEADER (hardcoded fn=0x77)

Per `ghidra-axe-edit-iii-host-emitters-precise.txt`: fn=0x77 PRESET_DUMP
HEADER is emitted by this function. 5 distinct emit sites.

### `FUN_140338fb0`, preset-binary descriptor walker

Walks descriptor tables at `0x1407aaca0` and `0x1407aaf00` (per
caller-refs cross-link). Likely the entry function for one of the
preset-binary fn-byte families.

### `FUN_14033ae30`, preset-payload walker

Walks descriptor tables at `0x1407ab940` (the 1024-ushort table!) +
`0x1407aacd0` (192-byte table = 64 ushorts). This function is the
**likely entry point for the III preset binary parser**.

### `FUN_1403434b0` / `FUN_1403437d0`, fn-byte wrappers

Generic SysEx-emit wrappers. `PreciseAxeEditIIIHostEmitters.java`
walks the call sites of these via PcodeOp data-flow analysis to
recover the fn-byte arg constant per call site (45 distinct callers,
27 distinct fn-bytes with workflow labels).

### `FUN_14033ec70`, fn=0x01 SET_PARAMETER wrapper

`param_3[0]` is the action code. 93 callers enumerated in
`ghidra-axe-edit-iii-actions-and-shapes.txt`. Each caller's local-var
assignments show the action-code constant being loaded, ~70
sub-actions un-mined via TS extractor pending.

---

## RVA constants ( `.rdata` ): descriptor tables

Full extraction in `ghidra-axe-edit-iii-{dump,misc}-descriptors.descriptors.json`.
26 tables total. Highlights:

| Address | Shape | Likely role |
|---|---|---|
| `0x1407ab440` | `(0, 6, 2) + (1, 8, 768)` → 256 ushorts | Preset push (256-ushort variant) |
| `0x1407aba40` | `(0, 6, 2) + (1, 8, 192)` → 64 ushorts | Preset push (64-ushort variant) |
| `0x1407ab940` | `(0, 6, 2) + (1, 8, 3072)` → **1024 ushorts** | **III preset binary body (analog of II 0xe04440)** |
| `0x1407ab0a0` | `(0, 6, 2) + (1, 8, 1280)` → 427 ushorts | Large packed payload (purpose un-mapped) |
| `0x1407ab910` | `(0, 6, 2) + (1, 8, 160)` → 53 ushorts | Medium payload |
| `0x1407ab8b0` | `(0, 6, 2) + (1, 8, 31)` | 31-byte payload (likely metadata/header block) |
| `0x1407ab2f0` | `(0, 6, 1) + (1, 7, 1)` | Used by `FUN_140337060` store-preset |
| `0x1407aac70` | `(0, 6, 1) + (1, 7, 1) + (2, 8, 2)` | Used by `FUN_14033ba50` |
| (19 more) | Smaller payloads (1-3 bytes) | Per-fn-byte command shapes |

---

## fn-byte map (precise data-flow analysis)

From `ghidra-axe-edit-iii-host-emitters-precise.txt`: III emits 27
distinct fn-bytes (host → device). Highlights:

| fn-byte | Emits | Workflow label |
|---|---|---|
| 0x01 | 1 | SET_PARAMETER |
| 0x12 | 2 | Revert Preset |
| 0x19 | 1 | File Snapshot / Export / Get Preset Data |
| 0x1A | 1 | Export User Cab |
| 0x1B | 2 | Import Preset Bundle |
| 0x1F | 1 | Paste Preset (sub) |
| 0x40 | 1 | Load/Select Preset |
| 0x46 | 1 | Query device version |
| 0x47 | 4 | Initialization / Param Definitions (sub) |
| 0x77 | 5 | **PRESET_DUMP HEADER** (hardcoded via `FUN_14014d2a0`) |
| 0x78 | 1 | (no workflow label, preset_dump body?) |
| 0x79 | 1 | (no workflow label, preset_dump footer?) |
| 0x76 | 4 | (no workflow label) |
| ... | ... | ... (full table in the dump file) |

Dynamic fn-byte emits (runtime-determined, not constant): 3 sites.

---

## What's still un-mined (open RE targets)

- **III XOR-fold hash function**: clone `DumpAxeEditIIFooterHash.java`
  → III variant; the hash function is callable from `FUN_140337060`'s
  call graph. ~1 hour Ghidra batch. Closes III preset round-trip
  modified-push validation (transfer of [[../primitives/xor-fold-hash]]
  to III).
- **III block-name cascade analog**: `ghidra-axe-edit-iii-preset-receiver.txt`
  (371 KB) almost certainly contains the III analog of II's
  `AEImageDepot::FUN_00595260`. ~2 hours TS work (grep for alphabetical
  block-name cascade). Transfer of
  [[../primitives/alphabetical-name-cascade-block-ordering]] to III.
- **III inbound dispatcher response shapes**:   `ghidra-axe-edit-iii-inbound-dispatcher.txt` (524 KB) decodes
  fn 0x14 GET reply, fn 0x28 enum dump, state-broadcast envelopes.
  1-day TS parse yields III SET → GET parity.
- **fn=0x01 SET_PARAMETER sub-action codes**: ~70 sub-actions un-mined
  in `ghidra-axe-edit-iii-actions-and-shapes.txt`. 200-line TS
  extractor over caller-body local-var assignments closes it.

---

## Refinement history

- : III fn=0x01 SET_PARAMETER wire shape pivoted from fn=0x02
  hypothesis. Byte-verified against 10 public captures.
-  era: III opcode table recovered (94 fn-bytes via
  binary-side wire vocabulary mining).
- 2026-05-22 (synthesis pass): all 26 III descriptor tables extracted
  via `parse-ghidra-decompile.ts`. III preset binary envelope shape
  confirmed byte-identical to II. III preset binary parser/serializer
  now decodable without hardware, only the hash function clone
  blocks ship.
