# Axe-Fx III, Grid routing decode research

This document captures the Ghidra-derived wire shape of the III's
grid/routing dump envelope (the III equivalent of II's fn 0x20
GET_GRID).

Source artifacts:
- `scripts/ghidra/DumpAxeEditIIIDumpDescriptors.java`
- Output: `samples/captured/decoded/ghidra-axe-edit-iii-dump-descriptors.txt`

## TL;DR

The III sends an **`SYSEX_EFFECT_DUMP` multi-frame envelope** via
fn `0x74` / `0x75` / `0x76` to push grid layout + routing to the
device. The frames are emitted by:

| fn | Caller | Role |
|---|---|---|
| 0x74 | `FUN_140338fb0` | START, fixed-size payload from a descriptor table; carries header + bulk data |
| 0x75 | `FUN_140339c40` | DATA, N × 3-byte cell records (the grid + routing) |
| 0x76 | `FUN_1401e7a70`, `FUN_14021ce90`, `FUN_14021e300` | END, empty payload |

This mirrors II's `0x74/0x75/0x76` family (`SYSEX_EFFECT_START` /
`SYSEX_EFFECT_DATA` / `SYSEX_EFFECT_END`) but with the III's larger
14×6 grid.

## 0x75 DATA frame, grid-routing wire layout

From the decompile of `FUN_140339c40`:

```c
undefined8 FUN_140339c40(longlong param_1, uint *param_2) {
  // param_2 is a struct: { count, header_val, cell_array, ..., array_len }
  //
  //   *param_2        = N (count of cell records)
  //   param_2[1]      = header value (single u32, septet-split into 2 bytes)
  //   param_2[2]      = pointer to ushort[N] (cell records)
  //   param_2[5]      = array length (guard)
  //
  // Descriptor table at DAT_1407ab440 (modern) / DAT_1407aba40 (legacy):
  //   tag=0, mid=6, byte_count=2   -- header field, 6-bit width, 2-byte slot
  //
  // Wire format:
  //   [2 bytes header: septet-split header value]
  //   [N × 3 bytes cell records: each cell is a u16 septet-split into 3 bytes]
  //     byte 0: cell_value & 0x7F
  //     byte 1: (cell_value >> 7) & 0x7F
  //     byte 2: (cell_value >> 14)            // upper 2 bits (16-bit total)

  FUN_1403437d0(param_1, 0x75, local_68, total_len, DAT_1412633f8);
}
```

### Cell-record bit layout (hypothesis from II analogue)

Each cell is a 16-bit native value. II's grid uses 4 bytes per cell
(block-id + position + routing-mask + reserved). III packs the same
information into 16 bits, dropping the reserved byte and possibly
combining position with routing-mask. Most plausible layout:

| Bits | Likely meaning |
|---|---|
| 0..10 (11 bits) | block-id (supports IDs 0..2047, covers the III's ~700 addressable + non-addressable IDs) |
| 11..15 (5 bits) | routing-mask (5 bits = one bit per source-row in the previous column; III has 6 rows but row 5 is rare) |

Validate with one USBPcap capture: AxeEdit III "Read from Axe-Fx" or
"Write to Axe-Fx" triggers an 0x75 DATA frame. The 14×6 = 84 cells
produce 84 × 3 = 252 wire bytes after septet-split. Cross-reference
against the III's `__block_layout.xml` (already mined) to verify the
block-id bits match the addressable IDs.

## 0x74 START frame, header payload

From the decompile of `FUN_140338fb0`:

```c
undefined8 FUN_140338fb0(longlong param_1, ushort *param_2) {
  // Modern firmware path (DAT_1412633f8 >= 0x10):
  //   reads descriptor table DAT_1407ab440 looking for tag=1
  //   gets uVar13 = byte_count = 768
  //   reads param_2[1] (single u32) and septet-splits across 768 bytes (??)
  //
  // Legacy path (DAT_1412633f8 < 0x10):
  //   reads descriptor table DAT_1407aaca0 looking for tag=0
  //   reads descriptor table DAT_1407aaca0 / DAT_1407aaf00 looking for tag=1
  //   gets byte_count = 192 (legacy chunk size)
  //
  FUN_1403437d0(param_1, 0x74, pbVar4, local_res20, DAT_1412633f8);
}
```

The 768-byte (modern) vs 192-byte (legacy) split corresponds to the
descriptor-table `byte_count` for tag=1. **Hypothesis**: the 768-byte
payload holds a snapshot of per-effect parameter state (the "dump"
half of EFFECT_DUMP). Routing data lives in the smaller 2 + N×3 byte
0x75 frame.

## 0x76 END frame, empty payload

Three callers, each invoking `FUN_1403437d0(buf, 0x76, 0, 0)` with no
payload. Marks the end of the multi-frame EFFECT_DUMP exchange.

## Where the routing-matrix actually lives, captures needed

The next decode step requires hardware captures:

1. **Triggering capture.** Open AxeEdit III, load a known preset
   (e.g. factory bank A preset 0 = "Plexi 100W Treble" or similar).
   Run a USBPcap session. Click "Write to Axe-Fx" (or "Sync", the
   action that pushes the editor state to the device). Save as
   `samples/captured/axefx3-effect-dump-write.pcapng`.

2. **What to look for** in the capture:
   - One `F0 00 01 74 10 74 [...] [cksum] F7`, START frame
   - One `F0 00 01 74 10 75 [...] [cksum] F7`, DATA frame containing
     the grid + routing
   - One `F0 00 01 74 10 76 [...] [cksum] F7`, END frame

3. **Reverse-engineering the cell bit layout.** Click ONE arrow on
   the grid (connect or disconnect a single cable). Re-capture. Diff
   the two 0x75 DATA payloads, only the cells whose routing changed
   should differ. The differing bits identify the routing-mask field
   position within each 16-bit cell value.

4. **Cross-validate against II's 0x20 envelope.** The II's
   `routing_mask` field at byte offset +2 per cell uses a 4-bit
   pattern (bits 0-3 = "fed from row 1/2/3/4 of previous column").
   III's larger grid likely uses 5 bits (one per source-row 0..4) or
   6 bits (one per source-row 0..5).

## Independent path: 0x40 / 0x47 / 0x76 sub-operation routing

The 0x76 END frame has 3 distinct callers, that's unusual. Possibly:
- One caller is for "EFFECT_DUMP write end"
- One caller is for "READ preset state end"
- One caller is for a "scene-switch" or similar transition

A capture-based decode of the three 0x76 sites would reveal which
high-level operation each one finalizes.

## Followups

- Capture and parse the 0x75 DATA frame as described above.
- Add `parseGridDump(buffer)` + `serializeGridDump(grid)` to
  `packages/fractal-gen3/src/grid.ts` once the cell layout is verified.
- Wire `axefx3_get_block_layout` to read via the EFFECT_DUMP
  multi-frame exchange instead of polling per-cell.
- Cross-check the descriptor-table byte_count values against captured
  frame sizes, if 768 doesn't match the actual frame, the value may
  encode bits or septets rather than wire bytes.
