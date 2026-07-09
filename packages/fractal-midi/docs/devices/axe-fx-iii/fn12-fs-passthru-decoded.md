# Axe-Fx III, fn=0x12 Revert Preset (CORRECTED, was incorrectly named FS_PASSTHRU)

**Status:** Wire shape decoded via `FUN_1401e3fb0` + `FUN_140253360`
builders. 1-byte payload status messages.

> **CORRECTION.** Subsequent decode of
> `FUN_1401f0f10` (the III's state-machine initializer; see
> `workflow-catalog-ghidra.md`) reveals fn=0x12 belongs to the
> **"Revert Preset"** workflow, the device acknowledges a
> request to undo the working buffer and reload the stored preset
> state. It is NOT `SYSEX_FS_PASSTHRU_MESSAGE` (that string in the
> .rdata pool has no code refs and remains unmapped).
>
> The footswitch-event-shaped caller pattern in `FUN_1401e3fb0` is
> the HOST sending fn=0x12 as a one-byte revert REQUEST, with the
> byte denoting scope (active scene, all scenes, etc.). The device
> responds with another fn=0x12 frame (and the 0x64 ACK) to close
> the workflow.

## Wire envelope

```
F0 00 01 74 10 12 [status_byte] [cksum] F7   (9 bytes total)
```

Single-byte payload carrying a status enum or flag.

## Builder A, `FUN_1401e3fb0`

```c
void FUN_1401e3fb0(longlong ctx, byte statusByte) {
    undefined2 local_28 = 0xf7f0;
    undefined1 local_res10[24];

    local_res10[0] = statusByte;
    FUN_1403437d0(&local_28, /*fn*/ 0x12, local_res10, /*len*/ 1,
                  /*model*/ *(byte *)(ctx + 0x38));

    FUN_1401e34b0(ctx, &local_28);  // queue or send wrapper
    // ...
}
```

**3 caller contexts:**

1. `FUN_1402fa560`, emits when `*(byte *)(param_1 + 0x1c) & 2 != 0`
   (some "enable" flag), passing `*(byte *)((longlong)param_1 + 0x3f1)`
   as the status byte. Context suggests preset/scene-change handler.

2. `FUN_1401d3420`, sets `*(undefined2 *)(plVar1 + 0x7e) = 0x81e;`
   then emits fn=0x12 with `(char)plVar1[0x7e]` (low byte of 0x81e
   = `0x1E`). Calls a vtable method at offset +0x58 afterward,    looks like a UI-event broadcast path.

3. `FUN_1402fed80`, same pattern as #2, with `param_2` as the
   status byte. Variant of the broadcast path.

## Builder B, `FUN_140253360`

Heavier signature (`longlong param_1, longlong param_2`) than
Builder A. Same fn=0x12 + 1-byte payload pattern but with an
expanded path (vector arithmetic for SIMD-batched broadcasts). Used
for periodic / streaming FS-event reporting.

## What the status byte carries

Without hardware captures I can only narrow the candidate space:

- **Footswitch press state**: most consistent with the
  `SYSEX_FS_PASSTHRU_MESSAGE` name. The byte enumerates which FS
  is pressed (1..16 for a 16-button FC controller, 0 = no press).
- **Looper state**: `SYSEX_SETGET_LOOPER` is a separate fn-byte
  (0x0F per v1.4 PDF), so unlikely.
- **Scene-change pulse**: possible but the III has dedicated fn=0x0C
  for `SETGET_SCENE`.
- **A3 tempo down-beat tick**: `SYSEX_A3_TEMPO` is one of the
  inert SYSEX_* strings; fn-byte unknown. Possible match.

The most likely interpretation, given the FS_PASSTHRU name and the
"toggle a flag then broadcast" caller pattern, is that fn=0x12 is the
**footswitch event pass-through** the III sends to AxeEdit so the
editor's UI footswitch-button widgets light up in sync with the
hardware. AxeEdit III may also emit fn=0x12 host→device when the
user clicks a UI footswitch.

## Implications

For  (bidirectional MIDI surface, listen + sequence) and
forum-asked "footswitch automation" workflows:

- The III emits fn=0x12 on every footswitch event. A future
  `listen` MCP tool can subscribe to this fn-byte and surface
  footswitch states to the agent in real time.
- Cost: 9 wire bytes per event, infrequent (only on FS press), so
  effectively zero overhead.

For the SYSEX_*-name catalog: this likely closes the
`SYSEX_FS_PASSTHRU_MESSAGE` ↔ fn=0x12 mapping. Confirmable in one
USBPcap capture of AxeEdit III + FC controller paired traffic
(observe fn=0x12 emissions when buttons are pressed).

## Source

- `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
  L1535-1717, FUN_1401e3fb0 + 3 callers
- `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
  L1721+, FUN_140253360 (Builder B)
