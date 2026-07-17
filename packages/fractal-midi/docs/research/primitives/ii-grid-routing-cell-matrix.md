---
name: ii-grid-routing-cell-matrix
class: struct-layout
status: matched
discovered: 2026-07-16 (II image-encode mining session)
verified_on:
  - axe-fx-ii-q8.02 (384-preset factory file corpus; 502/502 with live dumps, zero invariant violations)
  - axe-fx-ii-xl-plus-q8.02-live (bk070 + hw132 hardware dumps; Test Crunch documented placement lands exactly; bk070 uncabled probe presets corroborate mask semantics)
firmware_sensitive: true
golden: scripts/primitives-verify.ts#case-ii-grid-routing-cell-matrix
relates_to: [ii-preset-image-tlv-chain, block-record-stride-8, ii-fn06-set-cell-routing, wire-id-pairs-per-placed-block, scene-state-ushort]
consumed_in:
  - packages/fractal-midi/src/gen2/axe-fx-ii/presetImage/grid.ts
  - packages/fractal-midi/src/gen2/axe-fx-ii/presetImage/structure.ts (grid id swap on PLACE/REMOVE)
---

# II preset-image grid + routing cell matrix (words 34..129)

Words 34..129 of the de-framed II preset image are the GRID + ROUTING
matrix: the image encoding of exactly what the live `fn 0x20 GET_GRID`
/ `fn 0x06 SET_CELL_ROUTING` surface manipulates
([[ii-fn06-set-cell-routing]]).

## Formal definition

48 cells, COLUMN-MAJOR (col 1..12 outer, row 1..4 inner), 2 words per
cell:

```
cellWord(col, row) = 34 + ((col-1)*4 + (row-1)) * 2
cell word 0 = blockId:  0 = empty
                        100..198 = placed block wire id (observed max 170)
                        200..235 = shunt id (observed max 215)
cell word 1 = 4-bit INPUT-connection mask:
                        bit N set = fed from previous column, row N+1
                        column-1 occupied cells carry 1 << (row-1)
                        (input-node connect)
```

Corpus invariants (zero violations, 502/502 dumps: 384 Q8.02 factory +
118 live; independently re-derived on a 503-dump superset):

- id domain `{0} U [100..198] U [200..235]`; mask <= 0x0F; empty cells
  carry mask 0
- every col>1 mask bit points at an OCCUPIED previous-column cell
  (4,860+ bits, zero dangling)
- the grid's block-id multiset (ids < 200) EXACTLY equals the TLV
  chain's effect-block multiset ([[ii-preset-image-tlv-chain]]);
  shunts are never serialized in the chain
- shunt ids are UNIQUE within a preset; allocation is otherwise NOT
  canonical (158/335 multi-shunt presets monotone, 177 not; any unused
  id is corpus-legal; lowest-unused is the safe encoder choice)
- there is NO explicit output-connection field anywhere in the image:
  output tapping is implicit (Owner's Manual: cables to OUTPUT are
  created automatically for last-column blocks); factory convention
  extends every path to column 12 with shunts (384/384)

Ground-truth anchor: bk070 Test Crunch (founder-documented placement,
visual row 2 cols 1..6) lands at image row 2 cols 1..6 with ids
100,133,106,108,112,110 in signal order. Grid start word 34 pinned by
factory-C098 (shunt 212 at cell (1,1), flag 1).

Adversarial alternates decisively fail: row-major transpose gives
5,046/5,360 dangling bits; [flags,id] swap gives 5,256 domain
violations. The mapping is pinned, not merely consistent.

## Supersedes the block-record-stride-8 reading

The old [[block-record-stride-8]] "record table" is this matrix seen
through a 1-cell-off, column-collapsed lens: the stride-8 "record" is
a grid COLUMN (4 cells x 2 words); "flag 0x0002 = active in standard
scene" is actually routing bit 1 (fed from prev-column row 2, the most
common single-row layout); "ids >= 200 unplaced placeholders" are
SHUNTS with real per-cell ids; "ushort[2..7] always zero, writeback
must preserve zeros" was an artifact of row-2-only presets (98 presets
are nonzero there; e.g. factory-A097 uses row 3 with coherent
parallel-path flags). The bk070 bypass before/after pairs show the
flag word does NOT change on bypass toggles, independently killing the
scene-flag reading.

## Applicability

Read the grid, validate images, and swap a cell's id in place (block
<-> shunt with flags preserved) for the structural splice lanes.
Authoring NEW cable masks / fresh routing is NOT covered by this
entry's encode evidence; the live fn 0x05/0x06 ops (hardware-verified)
own that.

## Misapplication failure modes

- **DO NOT** read the matrix as stride-8 records starting at word 36;
  cells start at word 34 and the unit is the 2-word cell.
- **DO NOT** enumerate placed blocks from the grid for serialization
  work; walk the TLV chain (the multiset identity makes them agree,
  but chain ORDER is alphabetical, not grid order).
- **DO NOT** treat the mask as an output/send field; it is the cell's
  INPUT-connection mask from the previous column.
- **DO NOT** require col-1 masks or fed-ness on live probe-authored
  presets: fn 0x05 placement without fn 0x06 cables legally leaves
  mask 0 (480 such cells in the bk070 dumps).

## Where it does NOT apply

- AM4 / VP4: serial 4-slot chain devices, no grid.
- Gen-3 (III/FM3/FM9): different grid encoding (sub=0x2E region,
  [[gen3-sub2e-grid-region-tail-anchor]]).

## Verification path

`scripts/primitives-verify.ts#case-ii-grid-routing-cell-matrix` runs a
byte-exact fixture: factory-A000's 96 grid words (row-2 signal chain,
11 blocks + 1 shunt) parsed via the cellWord formula, validated
against the invariants and the preset's known TLV chain multiset.
Corpus-scale: `scripts/verify-ii-image-structural-splice.ts` validates
all invariants + the multiset identity on every dump on disk and
exercises the id-swap mutations in 766 byte-identity splice ops.

## Refinement history

- 2026-07-16: discovered + pinned (this entry); supersedes the
  block-record-stride-8 reading (that entry retained with a
  supersession note).
