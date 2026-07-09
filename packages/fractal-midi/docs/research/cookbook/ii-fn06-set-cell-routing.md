---
name: ii-fn06-set-cell-routing
class: fn-byte-mapping
status: matched-singleton
discovered:  (2026-05-13; hardware-decoded)
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: scripts/verify-axe-fx-ii-encoding.ts (byte-exact fn=0x06 edge fixtures)
relates_to: [ii-axeedit-opcode-table]
consumed_in:
  - fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md
  - scripts/verify-axe-fx-ii-encoding.ts
---

# Axe-Fx II fn=0x06 SET_CELL_ROUTING

Axe-Fx II's routing grid (4 rows × 12 columns) uses fn=0x06
SET_CELL_ROUTING to add or remove a cable between adjacent-column
cells. The wire payload is a flat 3-byte tuple `[src_cell, dst_cell,
connect]`; the device validates that `dst_cell` is in the column
immediately to the right of `src_cell` and rejects the frame
otherwise.

Pre-Session-70 the wiki documented routing as fn=0x05 (SET_GRID_CELL,
which sets a block at a cell, not a connection between cells). fn=0x06
is a distinct opcode that operates on edges, not nodes. 
hardware-decoded the payload by toggling individual cables via AxeEdit
and capturing the emitted frames.

## Formal definition

Envelope (11 bytes):

```
F0 00 01 74 07 06 <src_cell:1> <dst_cell:1> <connect:1> <cksum> F7
```

Where:

- `07` is the Axe-Fx II XL+ model byte.
- `06` is the fn byte (SYSEX_CONNECT_EFFECT per
  [[ii-axeedit-opcode-table]]).
- `src_cell` is a single-byte cell ID (row × 16 + column, 0-indexed
  internally; column 0..11, row 0..3).
- `dst_cell` is the target cell; must be in the column immediately to
  the right of `src_cell`.
- `connect` is 0x01 to add the cable, 0x00 to remove it.
- `cksum` is the standard XOR-7F envelope checksum.

## Where it's used

Implementation: `fractal-midi/src/gen2/axe-fx-ii/setParam.ts`
`buildSetCellRouting(srcCell, dstCell, connect)`.

Golden: `scripts/verify-axe-fx-ii-encoding.ts` ships byte-exact
fixtures for the four canonical edges (Amp-row to Cab-row in adjacent
columns, etc.).

Used by the dispatcher's grid-routing tools (`apply_preset` with the
`routing[]` field, the `set_routing` MCP tool).

## Misapplication failure modes

- **DO NOT** use this to place a block at a cell. fn=0x05
  SET_GRID_CELL handles cell occupancy; fn=0x06 handles connectivity
  between cells. These are distinct operations.
- **DO NOT** connect non-adjacent columns. The device validates the
  column adjacency constraint and rejects non-adjacent edges silently
  (no NACK, no state change). The host must enforce the constraint
  pre-flight; the dispatcher does this in `apply_preset` validation.
- **DO NOT** assume the cell ID is just `row × 4 + column`. The
  internal encoding is `row × 16 + column` (the high nibble is the
  row, low nibble is the column); using the wrong base produces
  cell IDs that the device interprets as different rows.

## Where it does NOT apply

- AM4 uses a linear 4-slot signal chain, not a grid; no routing
  primitive exists at all (the slots are positional, the order is
  fixed).
- Axe-Fx III uses fn=0x33 BLOCK_CONNECT with a different payload
  shape (4-byte tuple naming source and destination block-types, not
  cell coordinates).
- Hydrasynth uses NRPN-addressed modulation routing, not SysEx grid
  edges.

## Verification path

`scripts/cookbook-verify.ts#case-ii-fn06-set-cell-routing` checks
that `buildSetCellRouting` is byte-exact against the four canonical
edge fixtures in `scripts/verify-axe-fx-ii-encoding.ts`.

Live wire verification:  ran the toggle-each-cable probe
on the device; emitted frames matched the proposed envelope shape
across all 4 rows × 11 adjacent column pairs.

## Refinement history

- 2026-05-13: payload decoded via AxeEdit toggle probe.
  Wiki entry was previously incorrect (cited fn=0x05 for routing);
  fn=0x06 is the actual routing opcode. fn=0x05 is SET_GRID_CELL
  (cell occupancy, a distinct operation).
- 2026-05-22 (Rosetta-stone cookbook audit): promoted to cookbook
  primitive. Byte-exact goldens at
  `scripts/verify-axe-fx-ii-encoding.ts` supply the verification
  fixture; the wiki-vs-binary disagreement (Wiki said fn=0x05) is a
  good case study for [[ii-axeedit-opcode-table]]'s "wiki may be
  wrong" misapplication note.
