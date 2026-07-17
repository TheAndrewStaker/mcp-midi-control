# Axe-Fx II 0x74/0x75/0x76 state-broadcast triple, decode + bidirectional confirmation

**Status: 🟢 BIDIRECTIONAL, hardware-verified 2026-05-25 (XL+ Q8.02).**

The triple is accepted by the device as a HOST-TO-DEVICE write, not just a
device-emitted broadcast. All 21 block types tested. Constraints: NOT
channel-aware (writes to monolithic block state); encoding is per-position
(mixed wire16 / display-int); full value array required. See
the project's hardware-test log and primitive entry
`ii-state-broadcast-triple-write` for the full decode.

**Source captures (gitignored):**
- `samples/captured/session-58-axefx2-grid-move.syx`
- `samples/captured/session-58-axefx2-block-add.syx`
- `samples/captured/session-58-axefx2-knob-turn.syx`

Decoded 2026-05-11 from passive captures. Triple appears ONLY in
write-action captures (zero in `session-58-axefx2-direct-sync.syx`
which was read-only).

## Envelope structure (confirmed against grid-move capture)

### HEADER, function 0x74 (13 bytes)

```
F0 00 01 74 07 74 [70 00] [0c 01 01] [0a] F7
└─F0─┘ └─mfr─┘ └m─┘ fn  └─addr?─┘ └metadata─┘ cs F7
```

- **`70 00`**: 2 bytes, likely 14-bit septet-packed address (bank?
  slot? state region ID?). Decodes as `0x70 | (0x00 << 7) = 0x70 = 112`.
- **`0c 01 01`**: 3 bytes of metadata. Plausibly: chunk-count (12?
  but we observed 3 chunks, not 12), version marker, or size hint.
  Needs cross-capture comparison to nail down.
- **`0a`**: 1 byte checksum.

### CHUNK, function 0x75 (variable, 46-202 bytes observed)

```
F0 00 01 74 07 75 [count_lo count_hi] [N × 3 payload bytes] [cs] F7
└─F0─┘ └─mfr─┘ └m─┘ fn  └─14-bit item count─┘ └─items─┘     cs F7
```

- **`count_lo count_hi`**: 14-bit septet-packed item count. `40 00`
  decodes to 64 items; `0c 00` decodes to 12 items.
- **Items**: each item is **3 bytes = one 16-bit value in the wiki's
  3-septet packing** (the same encoding used by function 0x02
  SET_BLOCK_PARAMETER_VALUE for `value` bytes).
  - byte 0: value bits 0-6
  - byte 1: value bits 7-13
  - byte 2: value bits 14-15 (top 2 bits in low 2 bits of this byte)
  - Decoded examples from `grid-move`:
    - `7f 7f 01` → 32767 (0x7FFF)
    - `7e 7f 03` → 65534 (0xFFFE, max wire value)
    - `00 00 00` → 0
    - `12 12 00` → 2322
    - `77 32 01` → 19575
- **`cs`**: XOR checksum, AND 0x7F (same algorithm as every Fractal
  function).

### FOOTER, function 0x76 (8 bytes)

```
F0 00 01 74 07 76 [cs] F7
```

Single-byte payload that's probably just the checksum. No semantic
content, pure terminator. Matches AM4's `0x79 PRESET_DUMP_FOOTER`
structurally.

## Grid-move capture sequence (in capture order)

One complete triple per write action. From `session-58-axefx2-
grid-move.syx`:

1. **`fn=0x74 len=13`**: header at offset 0x152fc
2. **`fn=0x75 len=202`**: 64 items (192 payload bytes)
3. **`fn=0x75 len=202`**: 64 items (192 payload bytes)
4. **`fn=0x75 len=46`**: 12 items (36 payload bytes)
5. **`fn=0x76 len=8`**: footer

**Total decoded:** 140 16-bit values per dump.

## Cross-capture analysis (2026-05-11)

Comparing all 3 write captures locked down the header structure:

| Capture | Header bytes 6-7 (target_id) | Header bytes 8-9 (item_count) | Op flag (byte 10) | Items |
|---|---|---|---|---|
| grid-move | `70 00` = **112** | `0c 01` = **140** | `01` | 140 ✓ |
| block-add | `7f 00` = **127** (sentinel) | `09 00` = **9** | `00` | 9 ✓ |
| knob-turn | `6a 00` = **106 = AMP 1** | `6c 01` = **236** | `01` | 236 ✓ |

**Confirmed header structure:**

```
F0 00 01 74 07 74 [target_id:14b septet] [item_count:14b septet] [op_flag:1] [cs:1] F7
                  └── bytes 6+7 ──┘       └── bytes 8+9 ──┘       byte 10     byte 11
```

- **`target_id`** matches our `blockTypes.ts` effect IDs. `0x6A`
  decoded to 106 = AMP 1 verbatim (cross-references our
  `verify-axe-fx-ii-encoding.ts` golden for AMP 1).
- **`0x7F`** appears to be a preset-wide / non-targeted sentinel
  (block-add affects preset structure, not a single block).
- **`item_count`** matches the actual total items across all chunks
  that follow, the header pre-announces payload size.
- **`op_flag`** is `01` for direct-block edits, `00` for preset-
  level changes. Could be a "modified" vs "added" discriminator.

**Striking observation:** the knob-turn capture (one knob nudged on
AMP 1) produced 236 16-bit values. AMP 1 has ~225 params in our
`params.ts`. **The device broadcasts the FULL AMP 1 parameter state
every time ONE knob changes**, not just the delta.

## Decoded value distributions (2026-05-11 analysis)

After decoding the 16-bit septet-packed values from each capture:

### `block-add` (target=127 preset-wide, 9 values)

All 9 decoded values: **`[65534, 32767, 2, 0, 0, 65534, 52427, 0, 0]`**

Very structured. Two appearances of 65534 (max-value "ON" / "max"
sentinel), one 32767 (mid-point sentinel), one small integer (2),
one packed value (52427 = 0xCCCB), and four zeros. **Looks like a
fixed-shape preset metadata header**: 9 fields, fixed positions.
Worth diffing against an "empty preset" baseline to identify which
positions correspond to which preset attributes.

### `grid-move` (target=112, 140 values)

- Min: 0, Max: 65534
- 60 zeros (43% of values are zero, sparse / unused slots)
- 20 values at exactly 32767 (mid-range sentinel)
- 11 values at exactly 65534 (max sentinel)
- Lots of variety in the remaining 49 non-sentinel values

Distribution matches **a block-state dump** with many bypass/flag
fields (zeros + sentinels) plus a few rich numeric fields (param
values). 140 values is consistent with target=112 being a specific
block whose state is being broadcast.

**Open question:** what block is target=112 (0x70)? Not AMP 1 (106).
Need to cross-reference against `blockTypes.ts` IDS_BY_GROUP to
identify. Could be Cab 1, Drive 1, Reverb 1, whichever block the
founder dragged in this capture.

### `knob-turn` (target=106 AMP 1, 236 values)

- Min: 0, Max: 65534
- 63 zeros (27%, denser than grid-move; AMP has more active params)
- Multiple 32767 and 65534 sentinels scattered throughout
- Wide distribution of values, consistent with a full AMP param dump

**Confirms hypothesis:** the device dumps the FULL block state on
every per-block edit. The 236 count vs AMP's ~225 documented params
suggests either (a) some extra header bytes, (b) some params we
haven't catalogued, or (c) per-channel state included (AMP 1 has 4
channels × N params).

## Semantic mapping, first results (2026-05-11)

Ran `scripts/decode-axefx2-chunk.ts` against the three write captures and
overlaid `KNOWN_PARAMS` from `src/fractal/axe-fx-ii/params.ts` two ways:

1. **Position-as-paramId**: value at position `i` maps to `paramId = i`
   for the target block's group.
2. **Ordinal-of-registry**: value at position `i` maps to the i-th
   paramId in sorted order (skipping registry gaps).

**Result: position-as-paramId is the right model.** Ordinal was
falsified at position 32 of the AMP 1 knob-turn capture: value 8693
(a mid-range knob value), but the ordinal model claimed position 32 =
`pid40 boost(switch)`, a switch can only carry wire 0 or 65534, not
8693. The position-as-paramId model resolves position 32 to an
undocumented paramId 32 (a knob, by its value), which is consistent.

Concrete AMP 1 alignment from `session-58-knob-turn.syx` (target=106,
236 values, first 117 positions):

| pos | value | pid | param            | reading                                          |
|----:|------:|----:|------------------|--------------------------------------------------|
|   0 |     4 |   0 | `effect_type`    | enum 4 = "DOUBLE VERB VIB", confirms model      |
|   1 | 20053 |   1 | `input_drive`    | knob ~30% of 65534                               |
|   2 | 27328 |   2 | `bass`           | knob                                             |
|   3 | 38075 |   3 | `middle`         | knob                                             |
|   4 | 36830 |   4 | `treble`         | knob                                             |
|   5 | 65534 |   5 | `master_volume`  | MAX, master is maxed                            |
|  23 |     0 |  23 | `bypass_mode`    | enum 0 = first option (sensible default)         |
| 116 | 32767 | 116 | `motor_time_const` | MID, last documented paramId, value plausible  |

The 236-value AMP 1 dump is therefore at minimum a full
`paramId 0..116` linear dump (117 values), with 119 additional values
in positions 117..235 that look like a second concatenated state, possibly the per-channel state for another channel, or modifier
assignments. Diff-capture work is required to nail down positions
117..235.

### Block-add capture target was wrong in the original write-up

Original analysis claimed `target_id=127` was "preset-wide sentinel".
**Wrong**: `BLOCK_BY_ID[127]` = "Volume/Pan 1". The 9-value capture
is actually a state dump for the Volume/Pan 1 block that the founder
added during the capture session. The 9-value count is consistent
with VOL's small param surface (~6-10 params).

### Grid-move capture target

`target_id=112` = "Delay 1" (group=DLY). The 140-value dump is
Delay 1's full state. Position-as-paramId overlay shows position 0
= `effect_type`, position 2 = `time`, position 3 = `ratio`,
position 4 = `feedback`, all consistent with the DLY paramId order
in `params.ts`.

### Reproducing

```bash
npx tsx scripts/decode-axefx2-chunk.ts samples/captured/session-58-knob-turn.syx
npx tsx scripts/decode-axefx2-chunk.ts samples/captured/session-58-grid-move.syx
npx tsx scripts/decode-axefx2-chunk.ts samples/captured/session-58-block-add.syx
# Saved outputs in samples/captured/decoded/session-58-*-decode.txt
```

## Semantic mapping next steps

To map 16-bit positions to known param names, the cleanest approach:

1. **Capture the same block twice with one known param changed.**
   E.g.: capture AMP 1 with default bass=5.30, then capture AMP 1
   with bass=6.30. Diff the 236-value lists, the differing index
   is the byte-position of `bass`.
2. **Repeat for several known params** (treble, gain, master, etc.)
   to anchor the value-list positions.
3. **Generalize**: once 5-10 params are positioned, the rest can
   often be inferred from param-table order.

This is straightforward future work, each iteration is one ~10
second passive capture per param change. Can be done in a single
focused 15-minute hardware session.

This is great for RE, a single captured knob turn reveals the
complete current state of that block. Pair multiple captures (e.g.
"AMP 1 with default values" + "AMP 1 with bass=6.30") and the diff
in the 236-value list is the byte-position of `bass`.

## Hypothesis on semantic mapping

The 140-value count is suggestive but not yet pinned down. Plausible
interpretations to test:

1. **Grid-cell state dump**: 4 rows × 12 cols = 48 cells. If each cell
   carries ~3 attributes (block-id, channel?, bypass?), that's 144,    close to 140 with some cells being empty / collapsed.
2. **Placed-block state dump**: in this capture's preset, the active
   preset is whatever was loaded when the founder dragged a block. If
   ~12 blocks placed (matches "Shiver Clean" preset from earlier HW
   tests with 12 blocks) and ~12 attributes per block = 144 values.
3. **Full preset chunk**: the device might be dumping the entire
   working-buffer state every time AxeEdit makes a small edit. 140
   values is too small to be a full preset (Axe-Fx II presets are
   ~13KB in the bank-file format), so it's probably a state subset.

**Cross-reference needed against:**
- `session-58-axefx2-block-add.syx`, same triple should appear; if
  the 140 count is consistent across edits, it's a grid-snapshot
  format. If it varies with how many blocks are placed, it's a
  placed-blocks dump.
- `session-58-axefx2-knob-turn.syx`, turning a knob shouldn't change
  block placement, so if the 140 values include knob state, only one
  value will differ between this and a baseline capture.

## What this unlocks

If this is the Axe-Fx II store-to-location format:

- **`axefx2_save_preset`** can ship with byte-exact encoding via
  this triple.
- **`axefx2_apply_preset`** (kitchen-sink preset builder, AM4-
  equivalent) becomes viable, we issue a synthesized 0x74/0x75/0x76
  triple to push a full preset state to the device's working buffer.
- ** pilot decode target ✅**: first capture-derived editor-
  write surface decode on Axe-Fx II.

If this is just a state-broadcast format (device announcing changes
back to AxeEdit, not the way AxeEdit writes TO the device), then:

- We still get the chunk-decode template for the bidirectional case.
- For actual `apply_preset` we'd need to capture AxeEdit's OUTGOING
  bytes (host → device): which requires the bridge approach (ipMIDI
  + MIDI-OX) we deferred.

**Test to distinguish:** check if the triple appears in the
`block-add` capture (where AxeEdit ADDS a block, definitely a write
that would trigger a state-update broadcast OR an apply-preset write
from AxeEdit's side). If it does, this is most likely a device-side
broadcast (since `session-58` captures are passive-input only, we
see only what the device sends back).

## Next session pickup points

1. **Cross-reference triple appearances** across all 4 write captures
   (grid-move, block-add, knob-turn) to confirm format consistency
   and value-count variance.
2. **Decode the header's address bytes** (`70 00 0c 01 01`). Capture
   the same action at different preset locations to see which bytes
   change.
3. **Map 140 values to grid/block state.** Approach: load a known
   preset (e.g. "Shiver Clean" from HW tests), trigger a passive
   capture, decode the 140 values, compare against `axefx2_get_
   grid_layout` output. Repeat after a known edit (move block from
   cell A to cell B) and diff the value list.
4. **Test write-side encoding.** Synthesize a 0x74/0x75/0x76 triple
   from our own code and send via `send_sysex`. Observe AxeEdit's UI
   for state-change confirmation. This is the moment we prove the
   triple is bidirectional (works for write too, not just device
   broadcast).

## Cross-reference to AM4

AM4 uses `0x77/0x78/0x79` for `PRESET_DUMP_HEADER/CHUNK/FOOTER`. The
chunk format is similar (header + N × payload-items + footer) but
the items are different (AM4 chunks are 3082 bytes each, much
larger). Different encoding, same architecture.

Both follow the Fractal-family pattern: function-byte triple,
checksum per message, septet-packed values throughout, F0/F7
framing. This consistency is what makes contributions across the
Fractal product line feasible from a single decode framework.

## Sources

- Capture file: `samples/captured/session-58-axefx2-grid-move.syx`
  (gitignored).
- Capture methodology: `scripts/capture-midi-passive.ts`.
- Triple identification:  outcome (local hardware-tasks queue
  for Axe-Fx II).
- AM4 dump format precedent: [`../am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md) §10b (PRESET DUMP).
- Wiki documentation: NONE, this triple is not documented in the
  Fractal wiki for Axe-Fx II. **First public decode.**
