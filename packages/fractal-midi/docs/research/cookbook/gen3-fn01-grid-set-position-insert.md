---
name: gen3-fn01-grid-set-position-insert
class: envelope-shape
status: matched
discovered: 2026-06-04 (no-hardware loopMIDI editor-emulation capture)
verified_on:
  - fm9-edit-loopmidi-write-capture
  - axe-edit-iii-loopmidi-write-capture
golden: scripts/cookbook-verify.ts#case-gen3-fn01-grid-set-position-insert
relates_to: [septet-14bit, xor-7f-envelope-checksum, iii-fn01-set-parameter-envelope, gen3-fn1f-poll-block-bulk-read]
consumed_in:
  - packages/fractal-midi/src/gen3/axe-fx-iii/setParam.ts (buildSetGridCell)
  - packages/fractal-midi/test/gen3/modern-family/catalog.test.ts (byte-exact insert golden, models 0x10/0x11/0x12)
---

# Gen-3 block insert / grid_set_position (fn=0x01 sub=0x32)

The gen-3 editor places a block into a grid cell with a `fn=0x01`
two-message transaction. The editor names this operation
`grid_set_position` (surfaced verbatim in an FM9-Edit timeout dialog:
"Insert Block : grid_set_position"). It is the first decode of the gen-3
editor **write** surface (block placement), which no prior capture in the
public corpus had shown.

This was captured with no hardware, by driving FM9-Edit against a loopMIDI
virtual port and passively reading the editor's outbound SysEx (see the
[loopMIDI editor-emulation capture guide](../../capture-guides/loopmidi-editor-emulation.md)).

## Formal definition

A block insert emits two 23-byte messages, a cell-select companion then
the insert proper:

```
SELECT  F0 00 01 74 <model> 01 30 00 00 00 00 00 <gridPos:2> 00 00 00 00 00 00 00 <cks> F7
INSERT  F0 00 01 74 <model> 01 32 00 <effectId:2> 00 00 <gridPos:2> 00 00 00 00 00 00 00 <cks> F7
```

Where:

- `00 01 74` is the Fractal manufacturer ID; `<model>` is the gen-3 model
  byte (FM9 `0x12`, FM3 `0x11`, Axe-Fx III `0x10`); `01` is the fn byte.
- The sub-action is at envelope position 6: `0x30` SELECT (carries only
  the grid position), `0x32` INSERT (carries effect id + grid position).
- `effectId` is a 2-byte septet-encoded 14-bit field at positions 8-9 per
  [[septet-14bit]] (LSB-first). Real effect blocks have the high septet
  zero. **A high septet of `0x08` (i.e. `effectId >> 7 == 0x08`) marks a
  shunt / routing element rather than a real effect**, see "Shunt
  discriminator" below.
- `gridPos` is a 2-byte septet-encoded 14-bit field at positions 12-13.
- `cks` is the standard XOR-7F envelope checksum per
  [[xor-7f-envelope-checksum]].
- Positions 10-11 and 14-20 are zero across every captured insert.

### Grid position encoding

`gridPos = column * ROWS + row` (both 0-indexed), column-major. On the FM9
`ROWS = 6` (the grid is 6 rows tall). Confirmed against ten placements at
known cells:

| Cell (1-indexed) | col0,row0 | gridPos | captured byte 12 |
|---|---|---|---|
| r1c1 | 0,0 | 0 | `00` |
| r2c1 | 0,1 | 1 | `01` |
| r1c2 | 1,0 | 6 | `06` |
| r1c4 | 3,0 | 18 | `12` |
| r4c1 | 0,3 | 3 | `03` |
| r4c3 | 2,3 | 15 | `0f` |
| r4c6 | 5,3 | 33 | `21` |

**Confirmed `ROWS = 6` on BOTH FM9 (model 0x12) and Axe-Fx III (model
0x10)**: III placements gave r1c1=0, r2c1=1, r1c2=6, identical formula.
The op is byte-identical across the model bytes (only byte 4 differs),
which is the cross-family axis. **FM3 (model 0x11) confirmed at `ROWS = 4`**
via an FM3-Edit loopMIDI capture (r1c1=0, r2c1=1, r1c2=4): the same op with
a 4-row stride. Its 12th column is wire-confirmed too: Cab at r4c12 gave
gridPos=47 = (12-1)*4 + (4-1). So the grids are: III / FM9 = 6 rows x 14
cols, FM3 = 4 rows x 12 cols (all three cross-checked against official
Fractal specs; the III product page states "six rows and 14 columns"
verbatim, the wiki lists FM9 "14x6" and FM3 "12x4").

Note: the shipped `fractal-gen3` config now sets `grid: { rows: 6 }` for
III and FM9, matching the wire (two editors). The gen-3 codec's
`buildSetGridCell` takes the row count via `opts.rows` (default 6) so the
cell-index stride is `(col-1)*rows + (row-1)`; the `fractal-gen3` writer
passes `shape.grid.rows`. FM3 stays at its smaller (uncaptured) row count.

### Effect IDs read off the wire

The `effectId` field is the standard gen-3 block effect id (shared across
III / FM3 / FM9). Harvested and cross-checked against the block table and
independent capture decodes:

| Block | effectId | hex | cross-check |
|---|---|---|---|
| Amp | 58 | `0x3a` | `ID_DISTORT1` |
| Cab | 62 | `0x3e` | `ID_CABINET1` |
| Compressor | 46 | `0x2e` | |
| Graphic EQ | 50 | `0x32` | `ID_GRAPHEQ1` |
| Reverb | 66 | `0x42` | matches gen-3 reverb-type capture |
| Delay | 70 | `0x46` | |
| Chorus | 78 | `0x4e` | |
| Drive | 118 | `0x76` | matches gen-3 drive-type capture |

### Shunt discriminator (byte 9)

Drawing a cable between two empty cells makes the editor auto-insert
shunts, which use the SAME `sub=0x32` insert op but with byte 9 (the
effect-id high septet) = `0x08` instead of `0x00`. So byte 9 is a
block-type discriminator: `0x00` = real effect, `0x08` = shunt / routing
element, with byte 8 then indexing the shunt instance (0, 1, 2, ...).

### Routing write (sub=0x35), partial

The connection itself is a separate `fn=0x01 sub=0x35` message (26 bytes) whose
tail bytes (21..23) vary with the cable, consistent with setting a block's
input-routing mask. Advanced via live FM9-Edit draws against a rendered grid
([[gen3-editor-sync-read-surface]]), still not fully field-decoded:

- A cable emits **two** `sub=0x35` frames (likely source-output + dest-input
  masks, or two edge segments). bytes 12 and 19 are constant small counts
  (1 and 2) across draws.
- **Drawing between EMPTY cells auto-inserts shunts at both endpoints (and in
  any gap) BEFORE the routing op**, so those frames reference the shunts, not the
  cells clicked, the confound that kept this op "partial". Confirmed: r1c1->r1c2
  inserted shunts at both; r1c1->r1c3 inserted shunts at c1/c2(gap)/c3.
- **Drawing between already-PLACED blocks inserts NO shunts** (clean endpoints):
  Amp(58,r2c3)->Cab(62,r2c5) gave tails `06 44 60` + `09 46 20` with no shunts.
- byte 23 tracks the destination ROW (r1c1->r1c2 = `..40`, r1c1->r2c2 = `..60`,
  +0x20 per row), but bytes 21..22 do not map to gridPos/effectId by inspection.
- Re-drawing an EXISTING edge is a DISCONNECT in the editor UI ("Click to
  disconnect"), so a clean connect sample needs an unconnected placed pair.

A full decode is an OFFLINE task: correlate every captured `sub=0x35` frame with
its exact draw (raw frames saved in the gitignored `samples/captured/fm9-sim-*`
logs). Live capture adds noise once the grid accumulates shunts.

## Where it does NOT apply

- Axe-Fx II places/connects via different opcodes (`fn=0x06` cell routing,
  the `0x74/0x75/0x76` triple for state); see [[ii-fn06-set-cell-routing]]
  and [[ii-state-broadcast-triple-write]].
- AM4 has no grid (4-slot serial chain).
- `sub=0x32` here is the INSERT op; do not confuse it with the `fn=0x01`
  SET_PARAMETER sub-actions (typed-input `09 00`, drag `52 00`) in
  [[iii-fn01-set-parameter-envelope]]. Different sub-action, different
  payload layout.

## Verification path

`scripts/cookbook-verify.ts#case-gen3-fn01-grid-set-position-insert` builds
the INSERT envelope for three captured placements (Amp r1c1, Amp r1c2,
Cab r1c4) from `(effectId, gridPos)` and asserts byte-for-byte equality
with the captured frames, exercising both the `column*6+row` grid formula
and the septet effect-id field.

## Refinement history

- 2026-06-04: discovered via no-hardware loopMIDI editor-emulation
  capture. Block insert decoded (`sub=0x32` = effectId + gridPos,
  `sub=0x30` cell-select companion), grid formula `col*6+row` confirmed at
  ten cells, eight effect ids harvested and cross-checked, shunt
  discriminator (byte 9 = `0x08`) identified, routing op (`sub=0x35`)
  located but only partially decoded. FM9 only so far; III/FM3 share the
  codec and are the expected second axis once captured.
- 2026-06-04: III (model 0x10) and FM3 (model 0x11, 4-row grid) placements
  captured, confirming the op is byte-identical across all three model bytes
  (only byte 4 differs) and the row-stride formula holds at ROWS=4 and ROWS=6.
- 2026-06-04: codec migrated. `buildSetGridCell` now emits `fn=0x01 sub=0x32`
  (was the fn=0x05 II-port); the gen-3 `set_block` warning copy updated to name
  the confirmed op. A byte-exact golden ties the production builder to the
  captured frames for models 0x10/0x11/0x12 in
  `test/gen3/modern-family/catalog.test.ts`. The codec-backed device simulator's
  insert mutator parses the same shape (effectId @8-9, gridPos @12-13).
- 2026-06-27: the `sub=0x30` cell-select is NOT optional on the FM3. An FM3
  owner (sKuhLight/ForgeFX) live-confirmed on hardware that the FM3 ignores the
  insert's target cell unless a `sub=0x30` cursor-move to that cell is sent
  FIRST (its codec sends select → ~15 ms → insert). The Axe-Fx III and FM9
  (6-row) place correctly from the insert alone (FM9 fn=0x13 read-back,
  2026-06-19), so the select is now paired with the insert ONLY on the 4-row FM3
  placement path (`buildSelectCell` + the gen-3 `setBlock` writer, gated on
  `grid.rows === 4`); the confirmed 6-row single-frame path is unchanged.
  Community-beta on FM3.
