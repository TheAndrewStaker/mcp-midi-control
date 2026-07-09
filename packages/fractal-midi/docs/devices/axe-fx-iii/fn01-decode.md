# Axe-Fx III function 0x01, partial decode

**Status:** field skeletons for three sub-actions inferred from 11
unique 23-byte captures + 2 unique 87-byte captures (2026-05-15
community scrape). Sub-action codes confirmed; per-block param-ID
table still TBD.

## Headline: 0x01 carries multiple ops; III parameter-list query is unclear

Function 0x01 on the Axe-Fx III generation reuses the function-byte
the Axe-Fx II spec assigned to `GET_BLOCK_PARAMETERS_LIST`, BUT:

- Empirical attempts to call it on the FM3 (same family) return
  what looks like a stub/empty response, see "Failed
  GET_BLOCK_PARAMETERS_LIST attempt" below.
- The III's published v1.4 third-party MIDI PDF deliberately omits
  this function entirely.
- Community posts in this corpus describe 0x01 by its II name but
  also describe it as the workflow they expect to do `after the
  status dump response (0x13)`, i.e. a *hoped-for* workflow, not
  a confirmed working one.

So: **0x01 is the right opcode but the III may have changed the
call semantics from what the Axe-Fx II wiki describes.** The
function-name "GET_BLOCK_PARAMETERS_LIST" is more aspirational than
demonstrated.

What IS confirmed from captures: 0x01 carries multiple operations
distinguished by a 2-byte action / mode code at offsets 6-7.

| Action (pos 6-7) | Length | Direction | Empirically |
|---|---|---|---|
| `52 00` | 23 bytes | host → device | **SET_PARAMETER**: confirmed by the FC-12 boost on/off labeled captures. The value field at pos 15-16 is the only thing that changes between ON and OFF. |
| `04 01` | 23 bytes | device → host | **STATE_BROADCAST**: observed in passive sniffs of AxeEdit III ↔ III traffic. Effect IDs cover the v1.4 Appendix 1 range. Likely the device announcing parameter / modifier state during normal operation. |
| `01 00` | 87 bytes | device → host | **Long broadcast**: also observed in passive sniffs. Earlier writeup hypothesized this was a parameters-list dump; the empirical FM3 attempt (below) makes that claim weaker. Could be a block-state snapshot for a single block instead. |

## Failed GET_BLOCK_PARAMETERS_LIST attempt (FM3, 2024)

A community member calling 0x01 with `blockid == 106` (the Axe-Fx II
wiki's `Amp 1` effect ID) on an FM3 (model byte 0x11) got back a
single 23-byte response, not the documented `BATCH_LIST_REQUEST_START
... BATCH_LIST_REQUEST_COMPLETE` envelope:

```
Request:  (not captured; called GET_BLOCK_PARAMETERS_LIST blockid=106)
Response: F0 00 01 74 11 01 6A 00 7F 77 00 00 00 00 00 00 00 02 00 00 00 75 F7
```

- Effect ID `6A 00` = 106 echoed back
- Byte at pos 8 = `7F`, strong "not supported / no list" candidate
  (we have no other 23-byte 0x01 capture where pos 8 is `7F`)
- Rest of payload mostly zeros
- Checksum `75` validates

Interpretation: the III/FM3 generation may have **deliberately
disabled** parameter-list dumps in the third-party interface, the
v1.4 PDF's omission of 0x01 was an intentional removal, not an
oversight. Decoding `set_param` likely requires sniffing AxeEdit
III's traffic directly (as community RE has been advising all
along), not calling 0x01.

**Why this matters:** function 0x01 is the III's parameter-write
SysEx, **not in the v1.4 third-party MIDI PDF**. Decoding it unlocks
`axefx3_set_param` and `axefx3_get_param`. The v1.4 PDF deliberately
omits parameter writes, this is exactly the gap the community has
been trying to close.

## Sub-action `52 00`, SET_PARAMETER (host→device)

Four labeled captures (FC-12 footswitch sending boost on/off):

```
pos:  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22

A1on: F0 00 01 74 10 01 52 00 3A 00 28 00 00 00 00 7C 03 00 00 00 00 2B F7   "Amp 1 Boost ON"
A1of: F0 00 01 74 10 01 52 00 3A 00 28 00 00 00 00 00 00 00 00 00 00 54 F7   "Amp 1 Boost OFF"
A2on: F0 00 01 74 10 01 52 00 3B 00 28 00 00 00 00 7C 03 00 00 00 00 2A F7   "Amp 2 Boost ON"
A2of: F0 00 01 74 10 01 52 00 3B 00 28 00 00 00 00 00 00 00 00 00 00 55 F7   "Amp 2 Boost OFF"
```

Differences ON vs OFF (same block): only **value bytes at 15-16**
change. Differences A1 vs A2 (same value): only **effect ID lo
at offset 8** changes (`3A` ↔ `3B`).

### SET_PARAMETER field layout (verified)

| Offset | Bytes | Field | Evidence |
|---|---|---|---|
| 0-5 | `F0 00 01 74 10 01` | SysEx envelope + function 0x01 | Fixed |
| 6-7 | `52 00` | **Sub-action: SET_PARAMETER** | Constant across all SET captures |
| 8-9 | `3A 00`, `3B 00` | **Effect ID** (LS-first septet pair) | `3A 00` = 58 = `ID_DISTORT1` (Drive 1) per v1.4 Appendix; `3B 00` = Drive 2 |
| 10-11 | `28 00` | **Parameter ID** (LS-first septet pair) | Constant `40` across all 4 Drive captures, same param being set |
| 12-14 | `00 00 00` | Reserved (always zero in SET captures) | Constant |
| 15-16 | `7C 03` ↔ `00 00` | **Value** (LS-first septet pair) | The ONLY field that differs between same-block ON and OFF, confirms it's the value |
| 17-20 | `00 00 00 00` | Reserved | Constant zero |
| 21 | `2B` / `54` / `2A` / `55` | XOR checksum (Fractal family standard) | Re-derivable |
| 22 | `F7` | SysEx end | Fixed |

`0x1FC` (= 508 decimal) is the value Drive 1 / Drive 2 take when
"Boost ON". The forum thread doesn't label which Drive parameter
this is, could be Drive Mix, Output Level, or a boost-specific
flag. One more capture pairing this param with a known knob name
would close it.

## Sub-action `04 01`, STATE_BROADCAST (device→host)

**Behavioral finding (2026-05-18).** Originally captured
by user j20056 in Fractal Forum thread #203336 (April 2024); analyzed
in detail  via the local archive at
`founder-private notes` lines 73-81.

Key behavioral facts:

1. **Not a push-on-edit event.** The five frames below were captured
   "without doing anything" (no user knob action): they're idle
   passive traffic.
2. **AxeEdit-driven heartbeat poll, not device-initiated.** j20056:
   *"as soon as I quit Axe-Edit, then all MIDI traffic stops."*
   GlennO confirms: *"That parameter value response traffic is normal,
   for example when running Axe-Edit."* The III only emits `04 01`
   when an editor is actively polling.
3. **Byte-exact repeats.** Sequence 654 in the original capture is a
   byte-exact repeat of sequence 646 (same effect ID `3A 00`, same
   value `46 01`): heartbeat poll, not state delta.

**Implication for `axefx3_get_parameter`:** sending a SET to a bare
III (no AxeEdit running) will likely produce NO inbound `04 01`
broadcast. The `04 01` shape is real and field-decodable, but it
appears to be the editor-polling response channel, not a synchronous
SET acknowledgement or a state-change push. Our `get_param` tool's
🟡 banner correctly captures this, but the implementation should
treat a timeout as "expected on bare hardware" rather than a tool
error.

Five captures, all from one passive sniff:

```
pos:  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22

      F0 00 01 74 10 01 04 01 3A 00 00 00 46 01 00 00 00 00 00 00 00 6C F7
      F0 00 01 74 10 01 04 01 3B 00 00 00 13 00 00 00 00 00 00 00 00 39 F7
      F0 00 01 74 10 01 04 01 02 00 00 00 25 1A 00 00 00 00 00 00 00 2C F7
      F0 00 01 74 10 01 04 01 01 00 00 00 7F 1B 02 00 00 00 00 00 00 76 F7
      F0 00 01 74 10 01 04 01 3E 01 00 00 4F 27 02 00 00 00 00 00 00 44 F7
```

### STATE_BROADCAST field layout

| Offset | Bytes | Field | Evidence |
|---|---|---|---|
| 6-7 | `04 01` | **Sub-action: STATE_BROADCAST** | Constant across all 5 device-emitted captures |
| 8-9 | varies | **Effect ID** (LS-first septet pair) | Decoded values: 58/59 (Drive 1/2), 2 (`ID_CONTROL`), 1 (gen-1 holdover?), 190 (`ID_MIDIBLOCK`): all match v1.4 Appendix 1 |
| 10-11 | `00 00` | Reserved (no separate param-id field?) | Constant zero |
| 12-13 | varies | **Value** (LS-first septet pair) | Different values per broadcast |
| 14 | `00` / `02` | Unknown flag, appears with some broadcasts | Sometimes `02`, hypothesis: "value pending / latched" |
| 15-20 | `00 00 00 00 00 00` | Reserved | Constant zero |
| 21 | varies | XOR checksum | Re-derivable |

The broadcast covers effect IDs across the full v1.4 Appendix
range (1, 2, 58, 59, 190): consistent with a stream the device
emits when AxeEdit polls or auto-syncs state.

## Sub-action `2E 00`, LARGE DEVICE-EMITTED FRAME (device→host, 755 bytes)

**Status: structurally decoded, semantic ID still
needs a controlled capture to confirm.** Discovered as sequence 651 in
j20056's passive sniff (thread #203336): a 755-byte device-emitted
frame interleaved with `04 01` STATE_BROADCAST + `01 00` STATE_DUMP
traffic. The "~245 byte" framing in earlier handoffs underestimated by
~3×, the actual payload is 745 bytes (8-byte envelope + 745-byte
payload + cs + F7). Mechanical decode in
`scripts/_research/decode-axefx3-2e00-frame.ts` +
`scripts/_research/decode-axefx3-2e00-stride.ts`.

Full bytes archived in
`founder-private notes` (~line 78).

### Validated facts (byte-level)

- **Length:** 755 bytes total. 8-byte envelope (`F0 00 01 74 10 01 2E
  00`) + 745-byte payload + checksum (`5C`) + `F7`. Checksum verifies.
- **Three regions** identifiable from non-zero density + repeating-
  pattern boundaries:
  - **Header** (payload offset 0..38, ~39 bytes): sparse, fixed-field
    look. Contains the marker `3F 01` at offset 4-5 (same constant
    seen at pos 12-13 of the `01 00` STATE_DUMP captures, where it's
    hypothesized to mean "all parameters" or "this is a full block
    snapshot"). Other non-zero bytes: `05 4B`, `20`, `1D 2D 37 10 4A`
, likely (block_count, preset_number, scene_index) or similar
    routing metadata.
  - **Body** (offset 32..359, ~328 bytes): densely populated with the
    repeating 8-byte pattern `04 02 01 00 40 20 10 08` (and its
    cyclic rotations) interspersed with 24-110-byte "real data"
    chunks. Stride-40 alignment lays this out as **8 entries × 40
    bytes each**: matching the III's 8-scene count or 8-snapshot
    count exactly. The pattern bytes are NOT zero data, they decode
    LSF-septet to `[04 02 01 80 40 20 10]` (seven bytes, each with a
    single 1-bit, position cycling 2→1→0→7→6→5→4). Consistent with
    a "default / unmodified" sentinel for one structural element per
    scene.
  - **Tail** (offset 360..744, ~385 bytes): sparse, scattered non-
    zero markers in clear LSB-first pairs (e.g. `3E 00 01 00`,
    `4E 00 01 00`, `46 00 01 00`, `78 10 40`, `34 00 02 00`). Pattern
    is "`[paramId-or-flag] 00 [value-byte] 00`" repeated, looks like
    a flag/setting per parameter, NOT another scene block.
- **Pattern boundary runs** (where `bytes[i] == bytes[i+8]`,
  signaling "the 8-byte pattern continues"):
  - 39..59 (20B), 121..132 (11B), 250..278 (28B), 287..315 (28B),
    324..351 (27B): confirms 5+ pattern-only regions inside the
    body.

### Working hypothesis: full-preset state snapshot

Three regions × the III's known data shape gives the most likely fit:

1. **Header** = preset metadata (preset #, scene #, edit-buffer-dirty
   flag, block count active).
2. **Body** = 8 scenes × 40-byte per-scene state. Each 40-byte block
   contains "real data" (the scene's actual bypass/channel/CC values
   for blocks that differ from default) plus the walking-bit "default"
   sentinel for parameters at their default values. This is consistent
   with the III's per-scene override model, scenes don't copy the
   whole preset, they store deltas.
3. **Tail** = global preset settings (output level, FX-loop
   assignments, MIDI map overrides, tuner offset): the sparse
   `[id 00 val 00]` shape matches a 7-bit septet pair list of
   (paramId, value).

This makes the `2E 00` frame the III's **`GET_PRESET_DUMP`** response, the III's analogue of the II's `0x1D` preset envelope, but uncompressed
and single-frame (vs. the III's 18-frame `0x77/0x78/0x79` Huffman-
compressed save format which writes to flash, not the working buffer).

If correct, sending a request to the III with sub-action `2E 00` and an
empty payload should produce this dump for the active preset. Worth a
read-only probe once a III is on hand. Frame to test:

```
F0 00 01 74 10 01 2E 00 [cs] F7
```

cs computed = `0x35`. Wire: `F0 00 01 74 10 01 2E 00 35 F7`.

### What this unblocks (if hypothesis holds)

- **`get_active_preset_dump()` MCP tool**: single round-trip read of
  the III's full working-buffer state, no per-block STATUS_DUMP loop.
- **Faster dirty-state polling**: one 755-byte frame vs. N block-
  level reads. Trade-off: bigger frame, but fewer round-trips.
- **Scene comparison without writing**: read once, parse 8 scene
  blocks, compute deltas client-side.

### What still requires hardware to confirm

- Identity of the marker bytes in the header (`05 4B`, `20`,
  `1D 2D 37 10 4A`). A controlled capture against a preset with known
  name/number/scene-index would lock these fields.
- Whether the per-scene 40-byte block is the III's actual scene-data
  shape, or a different 8-element structure (e.g. snapshots, FX
  loop assignments × 8 channels).
- The septet-encoding choice, Fractal could be using LSF-collector,
  MSF-collector, or a custom variant. Confirming this needs a single
  scene with a known parameter value (e.g. amp gain = 5.0) and
  matching the wire bytes against the expected decoded float.

Decode is mechanical-complete; semantic confirmation needs 
(III owner runs `axefx3_send_sysex("F0 00 01 74 10 01 2E 00 35 F7")`
against a preset with known scene-0 amp-gain value and dumps the
response). Cheap probe, read-only.

## Sub-action `01 00`, STATE_DUMP (device→host, 87 bytes)

Two captures, much longer (87 bytes total → 79-byte payload):

```
pos: 00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 …

#1:  F0 00 01 74 10 01 01 00 25 00 00 00 3F 01 00 00 00 00 00 38 …
#2:  F0 00 01 74 10 01 01 00 28 00 00 00 3F 01 00 00 00 00 00 38 …
```

- Pos 6-7: `01 00` (action code)
- Pos 8-9: effect ID (`25 00` = 37 = `ID_INPUT1`; `28 00` = 40 = `ID_COMP1`)
- Pos 12-13: `3F 01` constant across both (191 = unknown, possibly "all parameters" flag)
- Pos 19: `38` constant, probably another marker
- Pos 21-37: per-block parameter values, packed as septet pairs

These look like **multi-parameter state dumps** for a single block.
Effectively the III's analog of Axe-Fx II's `GET_BLOCK_PARAMETERS_LIST`
response, the device transmitting all the block's parameters when
AxeEdit III opens its block editor for that block.

If this hypothesis is correct, sending `01 00` with a given effect
ID is the way to QUERY all parameters of a block. That would be
the III's `get_params(block)` function, a major decode unlock.

## Cross-decode facts

**Effect ID across all sub-actions decodes via the v1.4 Appendix 1
table.** Examples observed in 0x01 captures:

| Effect ID bytes | Decoded ID | v1.4 Appendix label |
|---|---|---|
| `01 00` | 1 | (reserved range, gen 1 holdover?) |
| `02 00` | 2 | `ID_CONTROL` |
| `25 00` | 37 | `ID_INPUT1` |
| `28 00` | 40 | `ID_COMP1` (Compressor 1) |
| `3A 00` | 58 | `ID_DISTORT1` (Drive 1) |
| `3B 00` | 59 | `ID_DISTORT2` (Drive 2) |
| `3E 01` | 190 | `ID_MIDIBLOCK` (Scene MIDI) |

This is independent verification that the v1.4 Appendix's effect-
ID space applies to the III's real-time parameter SysEx, not just
the documented `0x0A` / `0x0B` / `0x13` functions.

**"Amp 1 Boost" was actually a Drive block.** The forum-thread
title said "Amp 1 Boost," but `3A 00` = 58 = `ID_DISTORT1`. The
user labeled their footswitch action by intent, not by wire
representation. Wire bytes win.

**SET_PARAMETER (`52 00`) is fixed 23 bytes.** Single-parameter
operation. Simple encoder.

**STATE_BROADCAST (`04 01`) is also 23 bytes.** Same envelope
shape but device-emitted, different field layout.

**STATE_DUMP (`01 00`) is 87 bytes** with much richer payload.
Likely the "all parameters of this block" envelope.

## The 0x64 MULTIPURPOSE_RESPONSE error channel (confirmed)

When the III receives a malformed SysEx or an unsupported function,
it responds with v1.4's documented `0x64 MULTIPURPOSE_RESPONSE`.
Wire shape from a real capture:

```
F0 00 01 74 10 64 [echoed_fn] [result_code] [cs] F7
```

Example from a community capture: a host sent a `0x0E QUERY_SCENE_NAME`
with an incorrect checksum and got back:

```
F0 00 01 74 10 64 0E 00 7F F7
```

- `0E` = the function byte that errored (echo)
- `00` = result code = `MIDI_ERROR_BAD_CHKSUM`
- `7F` = checksum (validates: `F0^00^01^74^10^64^0E^00 = 0xFF & 0x7F = 0x7F`)

**Shipped :** the III tools wrap each fire-and-forget SET
with a 250ms 0x64 listener (`sendAndWatchForError` in
`src/gen3/axe-fx-iii/tools/shared.ts`); on reject the tool
response surfaces `(echoed_fn, result_code)` plus a human label.

### 0x64 result codes (full table,  decode)

The AxeEdit III 1.14.31 release binary contains a contiguous
8-byte-aligned `MIDI_ERROR_*` string table at .rdata offset
0x597108 onward. Each entry's index in offset order = the
`result_code` byte the III emits. Index 0 = `MIDI_ERROR_BAD_CHKSUM`
matches the empirically-verified capture above, so the indexing is
high-confidence.

| Code | Label | Meaning |
|---|---|---|
| 0x00 | MIDI_ERROR_BAD_CHKSUM | bad checksum |
| 0x01 | MIDI_ERROR_WRONG_SYSEX_ID | wrong SysEx manufacturer ID |
| 0x02 | MIDI_ERROR_WRONG_MODEL_NUM | wrong model number |
| 0x03 | MIDI_ERROR_BAD_ARGUMENT | bad argument |
| 0x04 | MIDI_ERROR_MSG_NOT_RECOGNIZED | message not recognized |
| 0x05 | MIDI_ERROR_INVALID_FXID | invalid effect ID |
| 0x06 | MIDI_ERROR_INVALID_PARAMID | invalid parameter ID |
| 0x07 | MIDI_ERROR_FX_NOT_IN_USE | effect not in use in this preset |
| 0x08 | MIDI_ERROR_NO_MODIFIERS_LEFT | no modifier slots left |
| 0x09 | MIDI_ERROR_WRONG_COUNT | wrong count |
| 0x0A | MIDI_ERROR_FX_NOT_ROUTABLE | effect not routable here |
| 0x0B | MIDI_ERROR_BAD_GRID_POS | bad grid position |
| 0x0C | MIDI_ERROR_DSP_OVERLOAD | DSP overload |
| 0x0D | MIDI_ERROR_FUNCTION_FAIL | function failed |
| 0x0E | MIDI_ERROR_INVALID_PATCHNUM | invalid patch number |
| 0x0F | MIDI_ERROR_ILLEGAL_MSG | illegal message |
| 0x10 | MIDI_ERROR_BAD_MSG_LENGTH | bad message length |
| 0x11 | MIDI_ERROR_IMAGE_SIZE_INCORRECT | image size incorrect (firmware) |
| 0x12 | MIDI_ERROR_BAD_IMAGE_CHKSUM | bad image checksum (firmware) |
| 0x13 | MIDI_ERROR_NOT_RDY_FOR_FW_UPD | not ready for firmware update |
| 0x14 | MIDI_ERROR_BUFFER_OVERRUN | buffer overrun |
| 0x15 | MIDI_ERROR_INVALID_CABNUM | invalid cab number |
| 0x16 | MIDI_ERROR_INVALID_MODIFIERID | invalid modifier ID |
| 0x17 | MIDI_ERROR_INVALID_BANKNUM | invalid bank number |
| 0x18 | MIDI_ERROR_FIRMWARE_ALREADY_CURRENT | firmware already current |
| 0x19 | MIDI_ERROR_CMD_NOT_SUPPORTED | command not supported |
| 0x1A | MIDI_ERROR_NULL_DATA | null data |
| 0x1B | MIDI_ERROR_FLASH_WRITE_FAILED | flash write failed |

Codes ≥ 0x1C: not enumerated in the AxeEdit III binary. If we
ever see a 0x64 result_code outside this range it's either firmware
newer than 1.14.31 added entries, or the device is in an unexpected
state.

Note: 0x05 = `MIDI_ERROR_INVALID_FXID` supersedes a previously
mis-labeled "NACK" entry that came from a loose community report.
The binary-extracted table is authoritative.

### Cross-extract: AxeEdit III binary as a research artifact

The AxeEdit III installer (`Axe-Edit-III-Win-v1p14p31.exe`, installed
to `C:\Program Files\Fractal Audio\Axe-Edit III\Axe-Edit III.exe`,
~20 MB) is rich with extractable string symbols. Extraction recipe:

```
npx tsx scripts/_research/extract-exe-strings.ts \
  --exe "C:\Program Files\Fractal Audio\Axe-Edit III\Axe-Edit III.exe" \
  --out samples/captured/decoded/axeedit3-strings.json \
  --min 4
```

The output is gitignored (samples/): re-run per session to refresh.

**Already mined:**
- `MIDI_ERROR_*` table at 0x597108 to 28 codes, full table above.

**Mined  (negative result on the offset-as-index hypothesis):**

The `SYSEX_*` symbol pool exists where an earlier leads suggested
, 23 contiguous-ish ASCII strings starting at 0x5aaf80 and running
to 0x5ab2b0. Filter recipe: `mine-axeedit3-sysex-table.ts`. Full
list in `SYSEX-MAP-AXE-FX-III.md` "Function names confirmed in
AxeEdit III binary."

But the `MIDI_ERROR_*` trick, string-pool index = enum value, **does NOT hold here.** Of the 8 documented v1.4 names that appear
in the pool, no single `delta = (fn_byte - string_pool_index)`
constant fits all anchors:

| String                  | Index | Documented fn | delta |
|---|---|---|---|
| SYSEX_SETGET_LOOPER     | 2     | 0x0F          | 13    |
| SYSEX_GET_SCENENAME     | 3     | 0x0E          | 11    |
| SYSEX_SETGET_TEMPO      | 5     | 0x14          | 15    |
| SYSEX_PATCH_STATUS      | 6     | 0x13          | 13    |
| SYSEX_GET_PATCHNAME     | 10    | 0x0D          | 3     |
| SYSEX_SETGET_SCENE      | 11    | 0x0C          | 1     |
| SYSEX_SETGET_CHANNEL    | 12    | 0x0B          | -1    |
| SYSEX_SETGET_BYPASS     | 13    | 0x0A          | -3    |

There's a sub-run pattern (within each contiguous run of known
anchors, fn_byte descends by 1 as offset ascends) consistent with
a `switch (fn) { case 0x14: ...; case 0x13: ...; }` written in
descending source order, but the runs are non-contiguous and the
unknown entries between them break any global index → fn formula.

A parallel function-byte array hypothesis was also tested:
`find-axeedit3-sysex-fnbyte-array.ts` scans the entire 20 MB binary
for a u8/u16/u32 array of length 23 (and 32 / 48 / 64 / 96 / 128)
satisfying all 8 anchor constraints. **Zero hits on every stride
and every guess.** No const u8 lookup table from enum-index to
function byte exists.

**Conclusion: the binary-string scrape cannot resolve undocumented
SYSEX_* function bytes.** What it CAN do: confirm the *existence*
of the 14 undocumented names. Function-byte assignment for those
names needs one of:

1. **Ghidra / decompiler against `Axe-Edit III.exe`.** No
   Ghidra-against-III work exists yet (the 14 `ghidra-*.txt`
   artifacts under `samples/captured/decoded/` are all AM4-Edit
   and Axe-Edit II generation, model byte 0x07). Decompiling the
   function that references this string pool would expose the
   `switch (fn)` cases directly. **This is the cleanest path.**
2. **USBPcap of AxeEdit III firing each undocumented function.**
   Direct wire-level evidence; expensive per-function.
3. **Forum / community scrape for any of these symbol names.**
   Most of these symbol names are unique enough to be googleable
   if any community RE has touched them.

**Other leads not yet mined (each is an independent next pickup):**

- `msg_*` format strings: `msg_getBlockString: effectId: %d, paramId
  %d / %d, string %d / %d` and `msg_getParamInfo: EffectId: ...`
  suggest the III has message-builder functions that return
  per-block param names by index. Useful if we can call them
  (hardware-dependent), but the format strings alone tell us the
  shape of the query.
- CSV export column headers in `.rdata` show AxeEdit III has an
  export-all-params function (`EffectType, Param Label, ParamId,
  Type, Units, Precision, Low Limit, High Limit, Multiplier,
  Resolution, Strings`). If we can locate the data table that feeds
  this export, we get the complete per-effect-type parameter
  dictionary without sniffing AxeEdit's MIDI traffic.

The string table at 0x597108 establishes the technique: when
.rdata contains a contiguous, 8-byte-aligned, NUL-terminated
string pool that lines up with one enum we've already verified,
the index → label mapping is reliable. **The SYSEX_* pool does
NOT satisfy that condition**: same shape, but the strings are
ordered by something other than function byte (likely source-
declaration order in a `getSysexFunctionName()` switch). The
MIDI_ERROR_* table was a lucky alignment, not a generalizable
trick.

## Some v1.4 effect IDs aren't actually controllable

A community thread (2019) clarifies that several effect IDs in the
v1.4 Appendix 1 table are listed but NOT addressable via the
third-party MIDI surface:

- `ID_CONTROL` (2): internal "control switch", FC-controlled only
- `ID_MIDIBLOCK` (190): internal-only
- `ID_FOOTCONTROLLER` (199): controlled via FC interface, not 3rd-party
- `ID_PRESET_FC` (200): internal

So the Appendix 1 table is the III's full block enumeration but the
*addressable subset* via 0x0A / 0x0B / 0x13 is narrower. Our
`blockTypes.ts` should mark these four as `addressable: false` to
keep the `set_bypass` / `set_channel` tools from offering them.

## What we still need

**Per-block, per-parameter ID dictionary**: still the biggest gap.
We've confirmed param ID `28 00` (= 40) for the Drive block boost
operation, but don't know what "param 40" is in human terms.

The clean path is **sniffing AxeEdit III directly**: capture USBPcap
of AxeEdit firing a single knob change on a known block, and
extract the `52 00` SET_PARAMETER frame. Each known (knob, value)
→ (effect_id, param_id, value) decode is one row of the table.

The 0x01 GET_BLOCK_PARAMETERS_LIST shortcut may not be viable on
the III as documented for II, the FM3 attempt above suggests
this path is blocked.

## Cross-references

- `scripts/_research/mine-axefx3-fn01.ts` (consumer repo): re-runnable
  extractor; drop more scrapes into the founder-private corpus and re-run.
- [`SYSEX-MAP.md`](SYSEX-MAP.md) "Undocumented function bytes seen
  in the wild" section, earlier note on 0x01.
- `docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`, the
  official v1.4 PDF that deliberately omits this function.
