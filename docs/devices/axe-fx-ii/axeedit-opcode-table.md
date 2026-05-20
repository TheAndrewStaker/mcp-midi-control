# AxeEdit II opcode table — recovered via Ghidra mining 🟢

> Session 103 (2026-05-20). Mined from `Axe-Edit.exe` (32-bit JUCE
> binary) via `scripts/ghidra/DumpAxeEditIIOpcodeTable.java`. The
> `OpcodeDescriptor` struct (8 bytes, `{const char* name; uint32_t
> enum_value;}`) lives in `.rdata`; 94 entries indexed by an internal
> enum.
>
> **Wire byte = enum value − 1.** AxeEdit's enum is 1-indexed from a
> different origin than the wire-byte counter. Validation against
> every wire byte we've live-captured on Q8.02 (15+ opcodes) confirms
> the −1 offset is universal across the table.
>
> The table below is generated programmatically from the Ghidra dump
> via `scripts/_research/axeedit2-opcode-map.ts` — DO NOT hand-edit;
> re-run the script after any AxeEdit binary refresh.

## Offset validation (every wire byte captured live on Q8.02)

| Wire | AxeEdit enum | Opcode name | Capture reference |
|------|--------------|-------------|-------------------|
| `0x02` | 0x03 | SYSEX_PARAM_SET | session-58-knob-turn fn 0x02 = SET_BLOCK_PARAMETER_VALUE |
| `0x06` | 0x07 | SYSEX_CONNECT_EFFECT | session-71 fn 0x06 = SET_CELL_ROUTING |
| `0x08` | 0x09 | SYSEX_QUERY_VERSION | session-58 fn 0x08 = GET_FIRMWARE_VERSION |
| `0x09` | 0x0A | SYSEX_SET_NAME | SET_PRESET_NAME |
| `0x0D` | 0x0E | SYSEX_TUNER | TUNER_INFO |
| `0x0E` | 0x0F | SYSEX_QUERY_STATES | session-58-direct-sync fn 0x0E = PRESET_BLOCKS_DATA |
| `0x0F` | 0x10 | SYSEX_QUERY_NAME | GET_PRESET_NAME |
| `0x14` | 0x15 | SYSEX_PATCHNUM | HW-100 fn 0x14 = GET_PRESET_NUMBER |
| `0x1C` | 0x1D | SYSEX_BANK_DUMP | BANK_DUMP_REQUEST |
| `0x1D` | 0x1E | SYSEX_SAVE_PATCH | session-61 fn 0x1D = STORE_PRESET |
| `0x20` | 0x21 | SYSEX_GET_GRID | session-69 fn 0x20 = GET_GRID_LAYOUT_AND_ROUTING |
| `0x21` | 0x22 | SYSEX_RESYNC | wiki FRONT_PANEL_CHANGE_DETECTED |
| `0x29` | 0x2A | SYSEX_SET_SCENE | session-68 fn 0x29 = SET_SCENE_NUMBER |
| `0x47` | 0x48 | SYSEX_GET_SYSINFO | session-58 fn 0x47 init frame |
| `0x74` | 0x75 | SYSEX_EFFECT_START | session-58-knob-turn state-broadcast HEADER |
| `0x75` | 0x76 | SYSEX_EFFECT_DATA | state-broadcast CHUNK |
| `0x76` | 0x77 | SYSEX_EFFECT_END | state-broadcast FOOTER |
| `0x77` | 0x78 | SYSEX_PATCH_START | session-53 fn 0x77 = PRESET_DUMP_HEADER |
| `0x78` | 0x79 | SYSEX_PATCH_DATA | PRESET_DUMP_CHUNK |
| `0x79` | 0x7A | SYSEX_PATCH_END | PRESET_DUMP_FOOTER |

## Wire-byte → opcode-name map (full 94-opcode table)

| Wire | AxeEdit enum | Opcode name |
|------|--------------|-------------|
| `0x00` | 0x01 | `SYSEX_WHO_AM_I` |
| `0x01` | 0x02 | `SYSEX_PARAM_DUMP` |
| `0x02` | 0x03 | `SYSEX_PARAM_SET` |
| `0x03` | 0x04 | `SYSEX_PATCH_DUMP` |
| `0x04` | 0x05 | `SYSEX_PATCH_RCV` |
| `0x05` | 0x06 | `SYSEX_PLACE_EFFECT` |
| `0x06` | 0x07 | `SYSEX_CONNECT_EFFECT` |
| `0x07` | 0x08 | `SYSEX_MODIFIER_SET` |
| `0x08` | 0x09 | `SYSEX_QUERY_VERSION` |
| `0x09` | 0x0A | `SYSEX_SET_NAME` |
| `0x0A` | 0x0B | `SYSEX_CABIR_RCV` |
| `0x0B` | 0x0C | `SYSEX_CHECKSUM` |
| `0x0C` | 0x0D | `SYSEX_SET_GRID` |
| `0x0D` | 0x0E | `SYSEX_TUNER` |
| `0x0E` | 0x0F | `SYSEX_QUERY_STATES` |
| `0x0F` | 0x10 | `SYSEX_QUERY_NAME` |
| `0x10` | 0x11 | `SYSEX_TEMPO` |
| `0x12` | 0x13 | `SYSEX_CABNAME` |
| `0x13` | 0x14 | `SYSEX_CPU_LOAD` |
| `0x14` | 0x15 | `SYSEX_PATCHNUM` |
| `0x15` | 0x16 | `SYSEX_QUERY_NAME_BY_NUM` |
| `0x16` | 0x17 | `SYSEX_GET_PARAM_INFO` |
| `0x17` | 0x18 | `SYSEX_GET_MIDI_CHANNEL` |
| `0x18` | 0x19 | `SYSEX_GET_MODIFIER_INFO` |
| `0x19` | 0x1A | `SYSEX_CAB_DUMP` |
| `0x1A` | 0x1B | `SYSEX_GLOBAL_BLOCK_USED` |
| `0x1B` | 0x1C | `SYSEX_GLOBAL_PATCH` |
| `0x1C` | 0x1D | `SYSEX_BANK_DUMP` |
| `0x1D` | 0x1E | `SYSEX_SAVE_PATCH` |
| `0x1E` | 0x1F | `SYSEX_SET_BYPASS` |
| `0x1F` | 0x20 | `SYSEX_GET_ALL_PARAMS` |
| `0x20` | 0x21 | `SYSEX_GET_GRID` |
| `0x21` | 0x22 | `SYSEX_RESYNC` |
| `0x22` | 0x23 | `SYSEX_SET_DEFAULTS` |
| `0x23` | 0x24 | `SYSEX_LOOPER_STATE` |
| `0x24` | 0x25 | `SYSEX_MOVE_EFFECT` |
| `0x25` | 0x26 | `SYSEX_FW_UPDATE` |
| `0x26` | 0x27 | `SYSEX_FPGA_UPDATE` |
| `0x27` | 0x28 | `SYSEX_MICRO_UPDATE` |
| `0x28` | 0x29 | `SYSEX_GET_PARAM_STRINGS` |
| `0x29` | 0x2A | `SYSEX_SET_SCENE` |
| `0x2A` | 0x2B | `SYSEX_GET_FLAGS` |
| `0x2B` | 0x2C | `SYSEX_MODIFIER_DUMP` |
| `0x2C` | 0x2D | `SYSEX_MODIFIER` |
| `0x2D` | 0x2E | `SYSEX_SET_CAB_NAME` |
| `0x2E` | 0x2F | `SYSEX_SET_PARAM_DIRECT` |
| `0x30` | 0x31 | `SYSEX_GET_GRAPH` |
| `0x31` | 0x32 | `SYSEX_TM_DATA` |
| `0x32` | 0x33 | `SYSEX_MULTIMSG_START` |
| `0x33` | 0x34 | `SYSEX_MULTIMSG_END` |
| `0x34` | 0x35 | `SYSEX_ERASE_SECTOR` |
| `0x35` | 0x36 | `SYSEX_GET_CONFIG` |
| `0x36` | 0x37 | `SYSEX_GET_GRAPHN` |
| `0x37` | 0x38 | `SYSEX_EDIT_EFFECT` |
| `0x38` | 0x39 | `SYSEX_BROADCAST_KNOB` |
| `0x39` | 0x3A | `SYSEX_BROADCAST_MODIFIER` |
| `0x3A` | 0x3B | `SYSEX_GET_POSITION` |
| `0x3B` | 0x3C | `SYSEX_SET_MODPARAM_DIRECT` |
| `0x3D` | 0x3E | `SYSEX_RECALL_PATCH` |
| `0x3E` | 0x3F | `SYSEX_MUTE` |
| `0x3F` | 0x40 | `SYSEX_SET_IRCAP_NAME` |
| `0x40` | 0x41 | `SYSEX_CONTROL_IRCAP` |
| `0x41` | 0x42 | `SYSEX_DELETE_CABIR` |
| `0x42` | 0x43 | `SYSEX_EDITOR_DISCONNECT` |
| `0x43` | 0x44 | `SYSEX_DUMP_SYSTEM` |
| `0x44` | 0x45 | `SYSEX_CAB_BANK_DUMP` |
| `0x45` | 0x46 | `SYSEX_LAYOUT_SET` |
| `0x46` | 0x47 | `SYSEX_PATCH_PLUS_CAB_DUMP` |
| `0x47` | 0x48 | `SYSEX_GET_SYSINFO` |
| `0x60` | 0x61 | `SYSEX_FW_UPDATE_END` |
| `0x61` | 0x62 | `SYSEX_SYSTEM_DATA_START` |
| `0x62` | 0x63 | `SYSEX_SYSTEM_DATA` |
| `0x63` | 0x64 | `SYSEX_FSGRID` |
| `0x66` | 0x67 | `SYSEX_CABIR_END` |
| `0x67` | 0x68 | `SYSEX_RAWIR_START` |
| `0x68` | 0x69 | `SYSEX_RAWIR_DATA` |
| `0x69` | 0x6A | `SYSEX_STATUS_MSG` |
| `0x6A` | 0x6B | `SYSEX_FPGA_UPDATE_START` |
| `0x6B` | 0x6C | `SYSEX_FPGA_UPDATE_DATA` |
| `0x6C` | 0x6D | `SYSEX_FPGA_UPDATE_END` |
| `0x6D` | 0x6E | `SYSEX_MICRO_UPDATE_START` |
| `0x6E` | 0x6F | `SYSEX_MICRO_UPDATE_DATA` |
| `0x73` | 0x74 | `SYSEX_MICRO_UPDATE_END` |
| `0x74` | 0x75 | `SYSEX_EFFECT_START` |
| `0x75` | 0x76 | `SYSEX_EFFECT_DATA` |
| `0x76` | 0x77 | `SYSEX_EFFECT_END` |
| `0x77` | 0x78 | `SYSEX_PATCH_START` |
| `0x78` | 0x79 | `SYSEX_PATCH_DATA` |
| `0x79` | 0x7A | `SYSEX_PATCH_END` |
| `0x7A` | 0x7B | `SYSEX_CABIR_START` |
| `0x7B` | 0x7C | `SYSEX_CABIR_DATA` |
| `0x7C` | 0x7D | `SYSEX_RAWIR_END` |
| `0x7D` | 0x7E | `SYSEX_FW_UPDATE_START` |
| `0x7E` | 0x7F | `SYSEX_FW_UPDATE_DATA` |

> AxeEdit's table does NOT cover every wire byte the device speaks.
> Notably absent: `0x3C` (our codec uses this for SET_PRESET_NUMBER /
> switch preset, confirmed via HW-100). That's a legacy MIDI opcode
> AxeEdit handles via a different code path. When the table has a
> gap, fall back to the wiki + live captures.

## High-value opcodes for BK-070

| Wire | AxeEdit name | What it gives us |
|------|--------------|------------------|
| `0x0E` | `SYSEX_QUERY_STATES` | ONE-frame atomic read of working-buffer state. AxeEdit fires this once per "Read from Axe-Fx" sync. Request payload format: 11 chunks × 5 bytes each (per `samples/captured/session-58-direct-sync.syx`). Response binary structure TBD pending the bidirectional HW-115 capture. |
| `0x1E` | `SYSEX_SET_BYPASS` | Dedicated bypass-write opcode (separate from fn 0x02 paramId 255). New finding. |
| `0x1F` | `SYSEX_GET_ALL_PARAMS` | Bulk per-block param dump. Alternative single-block read path. |
| `0x21` | `SYSEX_RESYNC` | Request the device push current state. Matches wiki `FRONT_PANEL_CHANGE_DETECTED` semantically — sending this triggers `0x74/0x75/0x76` state-broadcast triples per placed block, which we ALREADY decode. **Likely usable as an atomic-read primitive RIGHT NOW** without HW-115. |
| `0x28` | `SYSEX_GET_PARAM_STRINGS` | Runtime enum-value label query — could replace hardcoded amp-type strings with device-emitted labels for firmware-version-independent tolerance. |
| `0x47` | `SYSEX_GET_SYSINFO` | Richer device-info than fn 0x08 (firmware version only). 8-byte request payload `0a 02 3d 01 00 08 04 00` per session-58. |

## Reproduce

```cmd
:: One-time: ensure Axe-Edit.exe has been auto-analyzed
scripts\ghidra\run-axeedit2-full-analyze.cmd

:: Re-run the opcode-table dump (raw enum values)
analyzeHeadless C:\Users\Steph ghidra-axe-edit ^
    -process Axe-Edit.exe -noanalysis -readOnly ^
    -scriptPath C:\dev\mcp-midi-tools\scripts\ghidra ^
    -postScript DumpAxeEditIIOpcodeTable.java

:: Regenerate this doc's table with the wire = enum - 1 offset applied
npx tsx scripts/_research/axeedit2-opcode-map.ts > \
    samples/captured/decoded/ghidra-axeedit2-opcode-wire-map.md
```

The raw Ghidra dump lives at `samples/captured/decoded/ghidra-axeedit2-opcode-map.txt`
(values are raw AxeEdit enum, no offset). The wire-byte-correct
companion is `samples/captured/decoded/ghidra-axeedit2-opcode-wire-map.md`.
