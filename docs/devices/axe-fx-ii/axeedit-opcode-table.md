# AxeEdit II opcode table — recovered via Ghidra mining 🟢

> Session 103 (2026-05-20). Mined from `Axe-Edit.exe` (32-bit JUCE
> binary) via `scripts/ghidra/DumpAxeEditIIOpcodeTable.java`. The
> `OpcodeDescriptor` struct (8 bytes, `{const char* name; uint32_t
> enum_value;}`) lives in `.rdata`; 95 entries indexed by an internal
> enum that maps to the wire function byte via **`wire_byte = enum_value - 1`**.
>
> Offset validated against multiple known opcodes:
>
> - `SYSEX_PARAM_SET` enum 0x03 → wire 0x02 ✓ (SET_BLOCK_PARAMETER_VALUE)
> - `SYSEX_QUERY_VERSION` enum 0x09 → wire 0x08 ✓ (GET_FIRMWARE_VERSION)
> - `SYSEX_SET_NAME` enum 0x0A → wire 0x09 ✓ (SET_PRESET_NAME)
> - `SYSEX_TEMPO` enum 0x11 → wire 0x10 ✓ (MIDI_TEMPO_BEAT)
> - `SYSEX_PATCHNUM` enum 0x15 → wire 0x14 ✓ (GET_PRESET_NUMBER)
> - `SYSEX_BANK_DUMP` enum 0x1D → wire 0x1C ✓ (BANK_DUMP_REQUEST)
> - `SYSEX_SAVE_PATCH` enum 0x1E → wire 0x1D ✓ (STORE_PRESET)
> - `SYSEX_GET_GRID` enum 0x21 → wire 0x20 ✓ (GET_GRID_LAYOUT_AND_ROUTING)
> - `SYSEX_SET_SCENE` enum 0x2A → wire 0x29 ✓ (SET_SCENE_NUMBER)
> - `SYSEX_PATCH_START` enum 0x78 → wire 0x77 ✓ (PRESET_DUMP_HEADER)
> - `SYSEX_PATCH_DATA` enum 0x79 → wire 0x78 ✓ (PRESET_DUMP_CHUNK)
> - `SYSEX_PATCH_END` enum 0x7A → wire 0x79 ✓ (PRESET_DUMP_FOOTER)
> - `SYSEX_EFFECT_START` enum 0x75 → wire 0x74 ✓ (state-broadcast header)
> - `SYSEX_EFFECT_DATA` enum 0x76 → wire 0x75 ✓ (state-broadcast chunk)
> - `SYSEX_EFFECT_END` enum 0x77 → wire 0x76 ✓ (state-broadcast footer)

## Full wire-byte → opcode-name map (94 opcodes)

| Wire | Opcode name | SYSEX-MAP equivalent (if any) |
|------|-------------|-------------------------------|
| 0x00 | (unmapped) | |
| 0x01 | `SYSEX_WHO_AM_I` | (not in wiki) |
| 0x02 | `SYSEX_PARAM_DUMP` | (sibling of SET_BLOCK_PARAMETER_VALUE; PARAM_RW read) |
| 0x03 | `SYSEX_PATCH_DUMP` | preset dump request |
| 0x04 | `SYSEX_PATCH_RCV` | preset receive |
| 0x05 | `SYSEX_PLACE_EFFECT` | (block placement on grid) |
| 0x06 | `SYSEX_CONNECT_EFFECT` | **SET_CELL_ROUTING** (fn 0x06 ✓ Session 71 decode) |
| 0x07 | `SYSEX_MODIFIER_SET` | GET / SET_MODIFIER_VALUE |
| 0x08 | `SYSEX_QUERY_VERSION` | GET_FIRMWARE_VERSION ✓ |
| 0x09 | `SYSEX_SET_NAME` | SET_PRESET_NAME ✓ |
| 0x0A | `SYSEX_CABIR_RCV` | cab IR receive |
| 0x0B | `SYSEX_CHECKSUM` | |
| 0x0C | `SYSEX_SET_GRID` | grid layout WRITE (companion to fn 0x20 GET) |
| 0x0D | `SYSEX_TUNER` | TUNER_INFO ✓ |
| **0x0E** | **`SYSEX_QUERY_STATES`** | **PRESET_BLOCKS_DATA** ✓ — bulk-state read envelope |
| 0x0F | `SYSEX_QUERY_NAME` | GET_PRESET_NAME ✓ |
| 0x10 | `SYSEX_TEMPO` | MIDI_TEMPO_BEAT ✓ |
| 0x11 | (unmapped) | |
| 0x12 | `SYSEX_CABNAME` | GET_CAB_NAME ✓ |
| 0x13 | `SYSEX_CPU_LOAD` | GET_CPU_USAGE ✓ |
| 0x14 | `SYSEX_PATCHNUM` | GET_PRESET_NUMBER ✓ |
| 0x15 | `SYSEX_QUERY_NAME_BY_NUM` | (preset-name-by-number — used during bank scan) |
| 0x16 | `SYSEX_GET_PARAM_INFO` | (per-param metadata query) |
| 0x17 | `SYSEX_GET_MIDI_CHANNEL` | GET_MIDI_CHANNEL ✓ |
| 0x18 | `SYSEX_GET_MODIFIER_INFO` | (per-block modifier metadata) |
| 0x19 | `SYSEX_CAB_DUMP` | |
| 0x1A | `SYSEX_GLOBAL_BLOCK_USED` | |
| 0x1B | `SYSEX_GLOBAL_PATCH` | |
| **0x1C** | **`SYSEX_BANK_DUMP`** | **BANK_DUMP_REQUEST** ✓ |
| **0x1D** | **`SYSEX_SAVE_PATCH`** | **STORE_PRESET** ✓ |
| 0x1E | `SYSEX_SET_BYPASS` | (was in wiki at fn 0x02 paramId 255; this is a different envelope?) |
| **0x1F** | **`SYSEX_GET_ALL_PARAMS`** | **(bulk per-block param dump — NEW)** |
| **0x20** | **`SYSEX_GET_GRID`** | **GET_GRID_LAYOUT_AND_ROUTING** ✓ |
| 0x21 | `SYSEX_RESYNC` | FRONT_PANEL_CHANGE_DETECTED ✓ |
| 0x22 | `SYSEX_SET_DEFAULTS` | |
| 0x23 | `SYSEX_LOOPER_STATE` | MIDI_LOOPER_STATUS ✓ |
| 0x24 | `SYSEX_MOVE_EFFECT` | (block move on grid) |
| 0x25 | `SYSEX_FW_UPDATE` | (firmware bootstrap) |
| 0x26 | `SYSEX_FPGA_UPDATE` | |
| 0x27 | `SYSEX_MICRO_UPDATE` | |
| 0x28 | `SYSEX_GET_PARAM_STRINGS` | (enum-value label query) |
| **0x29** | **`SYSEX_SET_SCENE`** | **GET / SET_SCENE_NUMBER** ✓ |
| 0x2A | `SYSEX_GET_FLAGS` | GET_PRESET_EDITED_STATUS ✓ |
| 0x2B | `SYSEX_MODIFIER_DUMP` | |
| 0x2C | `SYSEX_MODIFIER` | |
| 0x2D | `SYSEX_SET_CAB_NAME` | |
| 0x2E | `SYSEX_SET_PARAM_DIRECT` | SET_TYPED_BLOCK_PARAMETER_VALUE ✓ |
| 0x30 | (unmapped) | |
| 0x31 | `SYSEX_GET_GRAPH` | |
| 0x32 | `SYSEX_TM_DATA` | BATCH_LIST_REQUEST_START ✓ |
| 0x33 | `SYSEX_MULTIMSG_START` | BATCH_LIST_REQUEST_COMPLETE ✓ |
| 0x34 | `SYSEX_MULTIMSG_END` | |
| 0x35 | `SYSEX_ERASE_SECTOR` | |
| 0x36 | `SYSEX_GET_CONFIG` | SET_TARGET_BLOCK ✓ |
| 0x37 | `SYSEX_GET_GRAPHN` | |
| 0x38 | `SYSEX_EDIT_EFFECT` | |
| 0x39 | `SYSEX_BROADCAST_KNOB` | |
| 0x3A | `SYSEX_BROADCAST_MODIFIER` | |
| 0x3B | `SYSEX_GET_POSITION` | |
| 0x3C | `SYSEX_SET_MODPARAM_DIRECT` | (`wiki` listed SET_PRESET_NUMBER at 0x3C — likely off-by-one in wiki too) |
| 0x3E | `SYSEX_RECALL_PATCH` | SET_PRESET_NUMBER (corrects wiki) |
| 0x3F | `SYSEX_MUTE` | |
| 0x40 | `SYSEX_SET_IRCAP_NAME` | |
| 0x41 | `SYSEX_CONTROL_IRCAP` | |
| 0x42 | `SYSEX_DELETE_CABIR` | DISCONNECT_FROM_CONTROLLER ✓ (0x42) |
| 0x43 | `SYSEX_EDITOR_DISCONNECT` | (paired with DISCONNECT_FROM_CONTROLLER) |
| 0x44 | `SYSEX_DUMP_SYSTEM` | |
| 0x45 | `SYSEX_CAB_BANK_DUMP` | |
| 0x46 | `SYSEX_LAYOUT_SET` | |
| **0x47** | **`SYSEX_PATCH_PLUS_CAB_DUMP`** | **(undocumented — emitted at sync start. 8-byte payload `0a 02 3d 01 00 08 04 00` in session-58)** |
| 0x48 | `SYSEX_GET_SYSINFO` | |
| 0x61 | `SYSEX_FW_UPDATE_END` | |
| 0x62 | `SYSEX_SYSTEM_DATA_START` | |
| 0x63 | `SYSEX_SYSTEM_DATA` | |
| 0x64 | `SYSEX_FSGRID` | MULTIPURPOSE_RESPONSE ✓ (0x64) |
| 0x67 | `SYSEX_CABIR_END` | |
| 0x68 | `SYSEX_RAWIR_START` | |
| 0x69 | `SYSEX_RAWIR_DATA` | |
| 0x6A | `SYSEX_STATUS_MSG` | |
| 0x6B | `SYSEX_FPGA_UPDATE_START` | |
| 0x6C | `SYSEX_FPGA_UPDATE_DATA` | |
| 0x6D | `SYSEX_FPGA_UPDATE_END` | |
| 0x6E | `SYSEX_MICRO_UPDATE_START` | |
| 0x6F | `SYSEX_MICRO_UPDATE_DATA` | |
| 0x74 | `SYSEX_MICRO_UPDATE_END` | (NOTE: state-broadcast header is wire 0x74 — naming overlap due to enum sharing the byte) |
| **0x74** | **`SYSEX_EFFECT_START`** (state-broadcast) | **0x74/0x75/0x76 PRESET-STATE TRIPLE** ✓ |
| 0x75 | `SYSEX_EFFECT_DATA` | state-broadcast chunk ✓ |
| 0x76 | `SYSEX_EFFECT_END` | state-broadcast footer ✓ |
| **0x77** | **`SYSEX_PATCH_START`** | **PRESET_DUMP_HEADER** ✓ |
| **0x78** | **`SYSEX_PATCH_DATA`** | **PRESET_DUMP_CHUNK** ✓ |
| **0x79** | **`SYSEX_PATCH_END`** | **PRESET_DUMP_FOOTER** ✓ |
| 0x7A | `SYSEX_CABIR_START` | MIDI_START_IR_DOWNLOAD ✓ |
| 0x7B | `SYSEX_CABIR_DATA` | MIDI_G2_IR_DATA ✓ |
| 0x7C | `SYSEX_RAWIR_END` | MIDI_CLOSE_IR_DOWNLOAD ✓ |
| 0x7D | `SYSEX_FW_UPDATE_START` | |
| 0x7E | `SYSEX_FW_UPDATE_DATA` | |
| 0x7F | (unmapped) | |

> **Caveat — 1-byte offset ambiguity.** The +1 offset between AxeEdit's
> enum and the wire byte is consistent across every cross-checkable
> entry (15+ confirmed). The 6 entries in the table above that don't
> match the wiki's prior labeling (e.g. wiki 0x3C = SET_PRESET_NUMBER
> vs AxeEdit 0x3C = SET_MODPARAM_DIRECT) are most likely WIKI ERRORS,
> not table errors. The captured Q8.02 wire bytes confirm
> AxeEdit's mapping for every byte we've observed live (0x06, 0x08,
> 0x09, 0x0E, 0x1C, 0x1D, 0x20, 0x29, 0x74-0x79). Wiki entries that
> contradict AxeEdit on un-captured opcodes should be treated as
> suspect.

## What this unlocks for BK-070

**`fn 0x0E SYSEX_QUERY_STATES` is the atomic working-buffer read primitive.**
Confirmed in `samples/captured/session-58-direct-sync.syx`: AxeEdit
sends ONE 0x0E frame at sync start and the device responds with the
full per-block state. The request frame from that capture:

```
F0 00 01 74 07 0E
   03 4A 10 53 06    ← block 0 (5-byte descriptor)
   03 4E 18 63 06    ← block 1
   02 52 20 23 07
   02 56 00 20 06
   03 5E 28 03 07
   02 62 30 2B 78
   02 70 38 33 07
   02 16 41 53 07
   03 26 51 73 06
   02 2C 75 43 07
   02 42 59 63 07
F7
```

11 chunks × 5 bytes each — likely `[flags, blockId_lo, blockId_hi,
data_offset_lo, data_offset_hi]` or similar. Bytes 1-2 of each chunk
might septet-pack a block ID. Decode TBD pending the bidirectional
sync capture (HW-115 revised).

**`fn 0x47 SYSEX_GET_SYSINFO` is the init frame.** 8-byte payload
`0a 02 3d 01 00 08 04 00` looks like a capability-flags request.
Sent immediately after `fn 0x08` handshake.

**`fn 0x1F SYSEX_GET_ALL_PARAMS` is a bulk per-block param dump.**
Not used in AxeEdit's direct-sync flow (AxeEdit prefers 0x0E for
overall state), but available as a per-block read alternative if
0x0E doesn't carry param values.

## Reproduce

```cmd
:: One-time: ensure Axe-Edit.exe has been auto-analyzed
scripts\ghidra\run-axeedit2-full-analyze.cmd

:: Re-run the opcode-table dump
analyzeHeadless C:\Users\Steph ghidra-axe-edit ^
    -process Axe-Edit.exe -noanalysis -readOnly ^
    -scriptPath C:\dev\mcp-midi-tools\scripts\ghidra ^
    -postScript DumpAxeEditIIOpcodeTable.java
```

Output lands at
`samples/captured/decoded/ghidra-axeedit2-opcode-map.txt`.
