# AM4-Edit action-code table, recovered via Ghidra mining 🟢

> 2026-05-20. Mined from `AM4-Edit.exe` (64-bit MSVC binary,
> v2.00 build Mar 2026) via `scripts/ghidra/DumpFractalEditorOpcodeTable64.java`.
>
> The `OpcodeDescriptor` struct (stride 16 bytes on 64-bit:
> `{const char* name; uint32_t enum_value; uint32_t pad;}`) lives in
> `.rdata` at `0x1413c7bc8`. 47 entries indexed by an internal enum.
>
> **Wire byte = enum value − 1.** Same +1 offset convention as AxeEdit II
>. Validated against 6+ wire bytes captured live on AM4
> firmware v2.00, see "Offset validation" below.

## What these are

These are NOT top-level SYSEX function bytes. AM4 uses `0x01` as a
combined R/W dispatcher (see SYSEX-MAP.md §6a) whose body carries a
14-bit `action` field. The 47 enums below are the **action subcodes**
inside the `0x01` envelope.

Wire frame shape:
```
F0 00 01 74 15 01 [pidLo_lo pidLo_hi] [pidHi_lo pidHi_hi] [action_lo action_hi] [hdr3_lo hdr3_hi] [hdr4_lo hdr4_hi] [payload...] [cs] F7
                  ^------ hdr0 ------^^------ hdr1 ------^^------ hdr2 ------^^------ hdr3 ------^^------ hdr4 ------^
```

`hdr2` (action_lo, action_hi) carries the wire action byte. The wire
action byte is what this table maps.

## Offset validation (wire bytes captured live on AM4 firmware v2.00)

| Wire action | Ghidra enum | Opcode name | Reference |
|------|------|-------------|-----------|
| `0x01` | `0x02` | `MESSAGE_SET` | SYSEX-MAP.md §6a: "WRITE (float)", the standard SET_PARAM wire byte |
| `0x02` | `0x03` | `MESSAGE_SET_NORM` | SYSEX-MAP.md : continuous-slider drags from older AM4-Edit |
| `0x08` | `0x09` | `MESSAGE_DEFAULT` | SYSEX-MAP.md companion zero-payload frame (reset-to-default semantics) |
| `0x0C` | `0x0D` | `MESSAGE_SET_MEMBER` | SYSEX-MAP.md preset-rename ack (`action=0x000C`); writes a "member" of the preset |
| `0x0D` | `0x0E` | `MESSAGE_GET` | SYSEX-MAP.md §6a: "long-form read (64-byte response)", full descriptor + state |
| `0x0E` | `0x0F` | `MESSAGE_GET_PARAM` | SYSEX-MAP.md §6a: "short-form read (23-byte response)", just the value |
| `0x12` | `0x13` | `MESSAGE_GET_STRING` | SYSEX-MAP.md : READ_PRESET_NAME (`action=0x0012`) |
| `0x17` | `0x18` | `MESSAGE_UPDATE_UI` | SYSEX-MAP.md "anomaly at pidHigh=0x3E81 action=0x0017", UI refresh notification |
| `0x1B` | `0x1C` | `MESSAGE_STORE_PATCH` | SYSEX-MAP.md save ack (`action=0x001B`): preset save complete |

9 wire bytes match. The −1 offset rule is locked.

##  hardware-verified action bytes

After mining the table,  ran `scripts/_research/probe-am4-action-reads.ts` and `scripts/_research/probe-am4-action-writes.ts --writes --writes-tier3` live against the AM4 (firmware v2.00). Results:

### Writes confirmed via baseline+verify reads

| Wire | Opcode | Verified effect |
|------|--------|-----------------|
| `0x02` | `MESSAGE_SET_NORM` | Normalized 0..1 write (Δ -0.45 confirmed on AMP.GAIN) |
| `0x03` | `MESSAGE_INCR` | +66 u32 ticks ≈ +0.01 display step on Q15 |
| `0x04` | `MESSAGE_INCR_COARSE` | +655 u32 ticks ≈ +0.1 display step (10× larger) |
| `0x05` | `MESSAGE_DECR` | -66 u32 ticks (symmetric) |
| `0x06` | `MESSAGE_DECR_COARSE` | -655 u32 ticks (symmetric) |
| `0x0A` | `MESSAGE_SET_PARAM` | Alternate SET; observed AMP.GAIN 32767 → 0 |

Wire shape for all six: same as MESSAGE_SET (0x01): `F0 00 01 74 15 01 [pidLo] [pidHi] [action] [00 00] [hdr4] [packed payload] [cs] F7`. INCR/DECR-family use no payload (hdr4=0x0000). SET_NORM and SET_PARAM carry a 4-byte float32 LE payload like MESSAGE_SET.

### Writes ack'd but effect needs front-panel verify (cmd-ack 18B)

| Wire | Opcode | Verify path |
|------|--------|-------------|
| `0x18` | `MESSAGE_EXECUTE` | Check inbound for state changes |
| `0x1C` | `MESSAGE_RECALL_PATCH` | Front-panel preset display |
| `0x22` | `MESSAGE_PLACE_EFFECT` | fn 0x20 grid-layout read after |
| `0x2D` | `MESSAGE_COPY_CHANNEL` | Channel-B param read |
| `0x2E` | `MESSAGE_COPY_SCENE` | Per-scene param reads |
| `0x32` | `MESSAGE_SWAP_SCENES` | Per-scene param reads |

### Re-classified after variant probe (originally cmd-ack-only)

| Wire | Opcode | Re-verdict |
|------|--------|------------|
| `0x07` | `MESSAGE_TOGGLE` | 🟢 **Hardware-verified to flip bypass on 6 blocks** (reverb, delay, drive, chorus, flanger, phaser). Wire shape: `F0 00 01 74 15 01 [block_pidLow] [03 00] [07 00] [00 00] [00 00] [cs] F7` (16 bytes). Each TOGGLE flipped state BYPASSED→ACTIVE→BYPASSED across 2 successive calls, confirmed via long-form bypass read. ~~NOTE: on the AMP slot, `pidHigh=0x03` is the BOOST register (AM4's AMP slot has no bypass), so TOGGLE @ AMP toggles boost, not bypass.~~ **Superseded 2026-11-25 (hardware):** `pidHigh=0x03` on the AMP is its real per-scene bypass, the same register every block uses (SYSEX-MAP §6h). Sending the §6h amp-bypass golden flipped the decoded working-buffer amp scene-bypass word `0000 → 1000` (scene 1 bypassed) and the OFF golden flipped it back, while `amp.in_boost_sw` and `amp.out_boost` read OFF before and after. Captures: `samples/hw-test-0.10.0/ampbyp-on/*.syx`, `ampbyp-off/*.syx` (local, gitignored). Builder: `buildToggleBlockBypass(blockPidLow)` (fractal-midi/am4). |
| `0x08` | `MESSAGE_DEFAULT` | 🟢 **Responds with 64-byte structured response, not a write**. Global (`pidLow=0, pidHigh=0`) returns mostly-zero descriptor. AMP-scope (`pidLow=AMP, pidHigh=0`) returns packed data (`09 6b 40 00 02 70 28 2e ...`). Re-classified as a READ that returns the default-value descriptor for a target, NOT "reset to default" as the name suggested. The companion "zero-payload frame" observed in older captures is THIS opcode being used as a status query. |

### Writes that did not respond

| Wire | Opcode | Status |
|------|--------|--------|
| `0x09` | `MESSAGE_DEFAULT_PARAM` | 🟡 no change observed, possibly param was already at default |
| `0x23` | `MESSAGE_RESET_EFFECT` | 🔴 0 inbound frames, wire shape wrong, retry with payload variant |

### Reads that returned structured data

| Wire | Opcode | Response | Unlock |
|------|--------|----------|--------|
| `0x0F` | `GET_PARAM_INFO` | 23B short-resp | Redundant variant of `0x0E` |
| `0x10` | `GET_KNOBVALUE` | 23B short-resp | Front-panel knob position |
| `0x11` | `GET_STR` | **55B with 32-byte string payload** | Display-string read |
| `0x19` | `GET_VAL` | 23B short-resp | Alternate value read |
| `0x1F` | `GET_PATCH` | **238B response with hdr4=0x0140 (320-byte payload)** | Preset binary read, needs decode |
| `0x26` | `GET_MODIFIER` | 23B short-resp | Modifier read (limited AM4 support) |
| `0x30` | `GET_EFFECT_INUSE` | 23B short-resp | Slot occupancy summary |

### Reads that returned cmd-ack only (no data, need different shape)

| Wire | Opcode | Note |
|------|--------|------|
| `0x1A` | `GET_VAL_AND_STR` | Probably needs payload byte count > 0 |
| `0x1D` | `GET_PATCH_NAME_BY_NUM` | Existing `0x12 MESSAGE_GET_STRING` is the working variant |
| `0x1E` | `GET_ALL_SCENE_NAMES` | Different addressing needed |
| `0x20` | `GET_GRID_INFO` | Use top-level fn 0x20 instead |
| `0x25` | `GET_EFFECT_AVAIL` | Different addressing needed |
| `0x2B` | `GET_METER` | 🔴 **dead-end confirmed**: 100-sample polling probe (5 s @ 20 Hz) during active guitar playing returned identical 18-byte cmd-acks. Zero per-byte variance. Wire path does NOT expose live audio metering. Filed as non-blocking; would need a different wire path (likely subscribe-style, not in this opcode table). |
| `0x2C` | `GET_SPI_ADC` | Diagnostic, low priority |
| `0x31` | `GET_SCENE_NAME_BY_NUM` | Different addressing needed |

### Step-size lookup (from INCR/DECR-family results)

For AMP.GAIN (and likely all Q15-encoded display 0..10 params):
- Fine step (INCR / DECR): 66 u32 ticks ≈ 0.01 display units
- Coarse step (INCR_COARSE / DECR_COARSE): 655 u32 ticks ≈ 0.1 display units

These are exact-divisor steps of the `READ_VALUE_DENOMINATOR = 65534` Q-format. The coarse step is 9.92× the fine step, close to 10× but not exact (likely Q15 rounding).

### Probe capture references

- `samples/captured/probe-am4-action-reads.syx` (gitignored, local-only)
- `samples/captured/probe-am4-action-reads-findings.md`
- `samples/captured/probe-am4-action-writes.syx`
- `samples/captured/probe-am4-action-writes-findings.md`
- `samples/captured/probe-am4-cmd-ack-variants.syx` (variant probe)
- `samples/captured/probe-am4-cmd-ack-variants-findings.md`
- `samples/captured/am4-get_patch-resp-1.bin` (unpacked GET_PATCH response)
- `samples/captured/am4-get_patch-resp-2.bin` (second call, 2 bytes differ from #1)

Scripts at `scripts/_research/probe-am4-{action-reads,action-writes,meter,cmd-ack-variants}.ts` (in the mcp-midi-control repo, codec-domain artifacts; could be lifted into the fractal-midi side if useful).

### GET_PATCH (0x1F) decode, 192-byte patch info descriptor

Two GET_PATCH calls (no-target vs preset-level addressing) returned identical 192-byte payloads except for 2 bytes:

| Offset | Bytes | Notes |
|--------|-------|-------|
| 0..3 | `33 00 00 00` | constant, could be "patch info" type code (51 decimal) |
| 4..10 | `00 00 00 00 00 00 00` | zero |
| 11..14 | `10 [counter_lo] [counter_hi] 67` | **VARIES per call**: bytes 12-13 are a 16-bit counter (saw `e4 18` then `f4 ae`) |
| 15..30 | `c8 81 a8 aa 81 a8 ac 27 50 10 00 00 41 10 04 41` | structured slot/state data |
| 31..46 | `10 00 00 41 10 04 41 10 00 00 41 10 04 41 10 00` | repeating `41 10 04 41 10 00 00` 7-byte pattern (slot bitmap?) |
| 47..191 | all zeros | reserved / unused buffer space |

This is **NOT the full preset binary** (which is 12,352 bytes via the 0x77/0x78/0x79 stream). It's a smaller metadata descriptor, possibly the working-buffer hash + slot occupancy summary. The 16-bit counter at bytes 12-13 suggests it could be used as a fingerprint for cache invalidation. Doesn't unlock stored-preset reads on its own. Needs follow-up probe with extended listen window (5-10 s) to see whether GET_PATCH triggers a 0x77/0x78/0x79 stream after the metadata frame.

### MESSAGE_GET_METER (0x2B): confirmed dead-end

100-sample polling probe (5 s @ 20 Hz) during active guitar playing (strums, palm-mutes, individual notes) returned identical 18-byte cmd-acks. Zero per-byte variance across all 100 samples. **The dispatcher accepts the action but does not expose live audio metering via this wire shape.** Would need a different opcode or subscribe-style envelope. Filed as non-blocking research; AM4 doesn't have a useful live-meter wire path through this surface.

### Remaining cmd-ack-only after variant probe

| Wire | Opcode | Status |
|------|--------|--------|
| `0x1A` | GET_VAL_AND_STR | Tried 4 variants; all cmd-ack. Need very different shape. |
| `0x1D` | GET_PATCH_NAME_BY_NUM | 4 variants; all cmd-ack. Existing `0x12 MESSAGE_GET_STRING` is the working preset-name-read; this opcode may have different semantics still TBD. |
| `0x1E` | GET_ALL_SCENE_NAMES | 4 variants; all cmd-ack. Possibly needs SUBSCRIBE-style envelope. |
| `0x20` | GET_GRID_INFO | 3 variants; all cmd-ack. Use top-level fn 0x20 instead. |
| `0x25` | GET_EFFECT_AVAIL | 4 variants; all cmd-ack. |
| `0x2C` | GET_SPI_ADC | 4 variants; all cmd-ack. Diagnostic, low priority. |
| `0x31` | GET_SCENE_NAME_BY_NUM | 4 variants; all cmd-ack. |
| `0x18` | MESSAGE_EXECUTE | 2 variants; all cmd-ack. |
| `0x1C` | MESSAGE_RECALL_PATCH | 2 variants; cmd-ack. Front-panel verification still pending. |
| `0x22` | MESSAGE_PLACE_EFFECT | 3 variants; all cmd-ack. Grid-layout read verification needed. |
| `0x2D` | MESSAGE_COPY_CHANNEL | 2 variants; cmd-ack; baseline didn't change. Channel-B read verification needed. |
| `0x2E` | MESSAGE_COPY_SCENE | 3 variants; cmd-ack. Per-scene read verification needed. |
| `0x32` | MESSAGE_SWAP_SCENES | 2 variants; cmd-ack. Per-scene read verification needed. |
| `0x23` | MESSAGE_RESET_EFFECT | 3 variants; either silent (empty payload) or cmd-ack (u32-zero payload). Multi-variant probe didn't trigger reset. |

## Full action-byte → opcode-name map (47-entry table)

| Wire | Enum | Action name | Notes |
|------|------|-------------|-------|
| `0x01` | `0x02` | `MESSAGE_SET` | Exact-value write (the canonical SET_PARAM). Default for our `buildSetParam`. |
| `0x02` | `0x03` | `MESSAGE_SET_NORM` | Normalized 0..1.0 write, used for continuous slider drags. |
| `0x03` | `0x04` | `MESSAGE_INCR` | Increment by step. |
| `0x04` | `0x05` | `MESSAGE_INCR_COARSE` | Coarse increment (multi-step). May be what AM4-Edit's "Send All" fires. |
| `0x05` | `0x06` | `MESSAGE_DECR` | Decrement by step. |
| `0x06` | `0x07` | `MESSAGE_DECR_COARSE` | Coarse decrement. |
| `0x07` | `0x08` | `MESSAGE_TOGGLE` | Boolean toggle (used for bypass / on-off params). |
| `0x08` | `0x09` | `MESSAGE_DEFAULT` | Reset to default. Companion zero-payload frame observed in captures. |
| `0x09` | `0x0A` | `MESSAGE_DEFAULT_PARAM` | Reset a specific param to default. |
| `0x0A` | `0x0B` | `MESSAGE_SET_PARAM` | Alternate SET variant (vs `MESSAGE_SET`). Distinct semantics TBD. |
| `0x0C` | `0x0D` | `MESSAGE_SET_MEMBER` | Write a "member" of a composite, used for preset-rename and likely per-scene bypass. |
| `0x0D` | `0x0E` | `MESSAGE_GET` | Long-form read, returns 64-byte response (full descriptor + state). |
| `0x0E` | `0x0F` | `MESSAGE_GET_PARAM` | Short-form read, returns 23-byte response (value only). |
| `0x0F` | `0x10` | `MESSAGE_GET_PARAM_INFO` | Param-descriptor read (capabilities + range, NOT value). |
| `0x10` | `0x11` | `MESSAGE_GET_KNOBVALUE` | Knob-position read (UI-side state). |
| `0x11` | `0x12` | `MESSAGE_GET_STR` | Short string read. |
| `0x12` | `0x13` | `MESSAGE_GET_STRING` | Long string read, READ_PRESET_NAME uses this. |
| `0x13` | `0x14` | `MESSAGE_UPDATE` | Generic update notification. |
| `0x14` | `0x15` | `MESSAGE_UPDATE_MEMBER` | Member-of-composite update notification. |
| `0x15` | `0x16` | `MESSAGE_UPDATE_KNOB_AND_STR` | Update both knob value + display string in one notification. |
| `0x16` | `0x17` | `MESSAGE_UPDATE_VAR` | Variable update notification. |
| `0x17` | `0x18` | `MESSAGE_UPDATE_UI` | "Refresh your UI" notification, anomaly explained. |
| `0x18` | `0x19` | `MESSAGE_EXECUTE` | Execute a command (no value). |
| `0x19` | `0x1A` | `MESSAGE_GET_VAL` | Get value only. |
| `0x1A` | `0x1B` | `MESSAGE_GET_VAL_AND_STR` | Get value + display string in one round-trip. |
| `0x1B` | `0x1C` | `MESSAGE_STORE_PATCH` | Save preset to a location (save ack uses this). |
| `0x1C` | `0x1D` | `MESSAGE_RECALL_PATCH` | Recall preset from a location. |
| `0x1D` | `0x1E` | `MESSAGE_GET_PATCH_NAME_BY_NUM` | Read preset name by location number (no need to switch active preset). |
| `0x1E` | `0x1F` | `MESSAGE_GET_ALL_SCENE_NAMES` | Bulk-read all scene names of the active preset. |
| `0x1F` | `0x20` | `MESSAGE_GET_PATCH` | Read a full preset binary. |
| `0x20` | `0x21` | `MESSAGE_GET_GRID_INFO` | Read the block-grid layout. |
| `0x21` | `0x22` | `MESSAGE_SET_GRID_POS` | Move a block to a different grid position. |
| `0x22` | `0x23` | `MESSAGE_PLACE_EFFECT` | Place an effect into a grid slot. |
| `0x23` | `0x24` | `MESSAGE_RESET_EFFECT` | Reset an effect to its default state. |
| `0x24` | `0x25` | `MESSAGE_CONNECT_EFFECTS` | Wire two effects together in the grid. |
| `0x25` | `0x26` | `MESSAGE_GET_EFFECT_AVAIL` | Query which effect types are available. |
| `0x26` | `0x27` | `MESSAGE_GET_MODIFIER` | Read modifier (LFO / envelope / etc.) state. |
| `0x27` | `0x28` | `MESSAGE_CONNECT_MODIFIER` | Wire a modifier source to a param target. |
| `0x2A` | `0x2B` | `MESSAGE_DISCONNECT_MODIFIER` | Remove a modifier connection. |
| `0x2B` | `0x2C` | `MESSAGE_GET_METER` | Read DSP meter (input/output level). |
| `0x2C` | `0x2D` | `MESSAGE_GET_SPI_ADC` | Read raw SPI ADC value (hardware diagnostic). |
| `0x2D` | `0x2E` | `MESSAGE_COPY_CHANNEL` | Copy block channel state (A→B, etc.). |
| `0x2E` | `0x2F` | `MESSAGE_COPY_SCENE` | Copy scene state. |
| `0x2F` | `0x30` | `MESSAGE_CLEAR_PATCHES` | Bulk-clear preset locations. |
| `0x30` | `0x31` | `MESSAGE_GET_EFFECT_INUSE` | Query which effect slots are occupied. |
| `0x31` | `0x32` | `MESSAGE_GET_SCENE_NAME_BY_NUM` | Read scene name by index. |
| `0x32` | `0x33` | `MESSAGE_SWAP_SCENES` | Swap two scenes. |

Gap at enum `0x0C` and `0x29..0x2A`, slots in AM4-Edit's internal enum
without a named string (likely reserved / deprecated). Not a parser bug;
the stride-16 run is contiguous in `.rdata`.

## What this unlocks

Decode work that was previously blocked on "what does action=0xNN mean":

1. **action=0x07 MESSAGE_TOGGLE**: likely the canonical bypass-toggle
   wire byte. Existing `am4_set_bypass` uses `MESSAGE_SET` (0x01) with
   value 0/1; switching to `MESSAGE_TOGGLE` would reduce wire shape and
   may match AM4-Edit's exact behavior.

2. **action=0x12 MESSAGE_GET_STRING + action=0x1D MESSAGE_GET_PATCH_NAME_BY_NUM**
, wire path for reading preset names from non-active locations without
   switching. Closes the AM4 side of "read stored preset name without
   leaving the active preset" (the safe-edit contract assumes this is
   impossible; this opcode says otherwise, needs hardware verification).

3. **action=0x1B MESSAGE_STORE_PATCH + action=0x1C MESSAGE_RECALL_PATCH**
, the official save / load wire bytes. Existing AM4 save path uses
   the front-panel save command + capture confirms `action=0x001B` ack;
   sending `MESSAGE_STORE_PATCH` directly may eliminate the manual save.

4. **action=0x1E MESSAGE_GET_ALL_SCENE_NAMES**: bulk scene-name read
   in ONE round-trip instead of 4 individual queries. ~75% wire reduction
   for scene-name discovery.

5. **action=0x20 MESSAGE_GET_GRID_INFO + 0x21 MESSAGE_SET_GRID_POS +
   0x22 MESSAGE_PLACE_EFFECT + 0x23 MESSAGE_RESET_EFFECT +
   0x24 MESSAGE_CONNECT_EFFECTS**: full grid-manipulation surface.
   Currently we only read grid via fn 0x20; these opcodes would let us
   place/connect/reset blocks programmatically.

6. **action=0x26 MESSAGE_GET_MODIFIER + 0x27 MESSAGE_CONNECT_MODIFIER +
   0x2A MESSAGE_DISCONNECT_MODIFIER**: modifier (LFO / envelope / external
   controller) graph manipulation. AM4 has limited modifier support but
   this is the wire path.

7. **action=0x32 MESSAGE_SWAP_SCENES**: atomic scene swap. Useful for
   "make this scene the new scene 1" UX.

Each of these would need (a) capture of AM4-Edit doing the corresponding
operation to confirm wire shape, and (b) a probe-and-check pass before
shipping. The queued capture asks are tracked in the project's hardware-task list.

## How to regenerate

```cmd
scripts\ghidra\run-am4edit-opcode-table-v2.cmd
```

Output lands at `samples/captured/decoded/ghidra-am4-edit-opcode-map-v2.txt`
(gitignored, local-only). After verifying the run, hand-port new
entries into this table.

## Related

- AxeEdit II opcode table: `../axe-fx-ii/axeedit-opcode-table.md` (94 opcodes,
  same Ghidra-mining methodology, different naming convention `SYSEX_*`).
- AxeEdit III opcode mining attempted : only **2 MESSAGE_***
  and 23 `SYSEX_*` strings survive in the release binary. Opcode names
  stripped, III decode needs the disassembly approach
  (`TraceAxeEditIIIMessageBuilders.java`).
- Ghidra mining workflow: `../../research/ghidra-mining-workflow.md`.
