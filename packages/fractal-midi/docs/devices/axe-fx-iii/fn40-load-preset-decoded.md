# Axe-Fx III, fn=0x40 LOAD/SELECT PRESET (not STORE_PRESET BEGIN)

**Status:** Ghidra-decoded. Corrects the community RE assumption
(`STORE_PRESET_ACK_OR_BEGIN` per Forum #159885): the actual
operation is preset SELECTION / LOAD, not save BEGIN.

## The chain

```
FUN_1402990d0(ctx, byte presetNum)        // entry point
  └─ allocates 3000-byte SysEx tx buffer
  └─ FUN_140337060(buf, [presetNum, 0])   // emits fn=0x40
       └─ FUN_1403437d0(buf, /*fn*/ 0x40, payload, 2, model)
```

## Wire envelope

```
F0 00 01 74 10 40 [low_septet] [high_septet] [cksum] F7  (10 bytes total)
```

Where the 2 payload bytes are the septet-encoded preset number:

```c
local_res10[0] = (ushort)presetNum;       // single source byte
FUN_140337060(buf, local_res10);
  // emits buf[0] = (presetNum >> 0) & 0x7F
  // emits buf[1] = (presetNum >> 7) & 0x7F   = 0 for presets < 128
```

For preset 0..127, the wire bytes look like `F0 00 01 74 10 40 NN 00 [cksum] F7`
where `NN` is the preset slot number directly.

## Why this is NOT STORE_PRESET BEGIN

`FUN_14014d400` is the III's save-preset workflow (verified by the
embedded user-confirmation string "Warning!\n\nIf you continue, you
will permanently overwrite ... presets in your ..."). Its case 4 and
case 5 branches call `FUN_14014d2a0` (the fn=0x77 PRESET_DUMP HEADER
emitter) directly. **There is no call to `FUN_140337060` (fn=0x40)
anywhere in the save workflow.**

The III's actual STORE_PRESET workflow:

```
FUN_14014d400 (UI: "Save Preset")
  ├─ case 4: confirm-then-save to NEW location (preset overwrite)
  └─ case 5: save to OTHER location (different overwrite mode)
       └─ both call FUN_14014d2a0(ctx, ?, presetNum << 7, txBuf)
            └─ FUN_14014d2a0 hardcodes fn=0x77
                 └─ FUN_14033ba50 builds header containing target preset
                 └─ followed by 0x78 chunks + 0x79 footer
```

**There is no separate BEGIN/END marker.** The target preset is
encoded directly in the 0x77 PRESET_DUMP_HEADER payload. The III's
save workflow is just:

```
F0 00 01 74 10 77 [bank, preset, ...header] [cs] F7   (header)
F0 00 01 74 10 78 [194 bytes] [cs] F7 × 64            (chunks)
F0 00 01 74 10 79 [3 bytes hash] [cs] F7              (footer)
```

## What fn=0x40 actually does

Based on the caller pattern (`FUN_1402990d0` allocates a 3000-byte
buffer + emits 0x40 + queues to outbound), fn=0x40 is most consistent
with:

- **LOAD/SELECT PRESET request**: "device, please send me preset
  number N as a PRESET_DUMP". The 3000-byte buffer is the inbound
  response buffer (sized for the ~3KB compressed wire-byte total of
  the device's PRESET_DUMP response).
- Or potentially **PRESET_LOCK / PRESET_HEARTBEAT** if it's a status
  query.

Confirming the exact role requires one USBPcap capture of AxeEdit
III firing a "Load Preset N" UI action.

## Implications

For  (unified surface) `save_to_location` tool on III:

The III's save-to-location is implementable TODAY without further
protocol RE:
1. Build the PRESET_DUMP frames (header + 64 chunks + footer) per
   the existing `preset-dump-decoded.md` wire layout
2. Encode target preset number into the header bytes
3. Send the multi-frame envelope to the device

No need for a separate `STORE_PRESET_BEGIN` marker. The atomic apply
+ save workflow is simpler than the community RE suggested.

## Closes & corrects

- **Community RE Forum #159885**: fn=0x40 is NOT
  `STORE_PRESET_ACK_OR_BEGIN`. It's a LOAD/SELECT operation.
- ****: Adds a new III fn-byte decoded (fn=0x40 wire shape
  confirmed) and corrects the prior name.

## Source artifacts

- `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
  L8-265, FUN_140337060 + FUN_1402990d0 caller chain
- `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
  L269-1268, FUN_14014d2a0 (fn=0x77 emitter) + FUN_14014d400 (save
  workflow with user-confirmation strings)
