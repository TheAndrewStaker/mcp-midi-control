---
name: ii-fn03-dump-addressing
class: fn-byte-mapping
status: matched-singleton
discovered: 2026-06-10 (live probe, hardware-verified same session)
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: scripts/verify-axe-fx-ii-encoding.ts (buildPatchDumpRequest + buildEditBufferDumpRequest byte goldens)
relates_to: [ii-fn1f-atomic-read, am4-fn03-stored-dump-request, ii-axeedit-opcode-table]
consumed_in:
  - fractal-midi/src/gen2/axe-fx-ii/setParam.ts
  - fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md
---

# Axe-Fx II fn=0x03 SYSEX_PATCH_DUMP: two addressing forms, one destructive

fn=0x03 takes a 2-byte address and answers with the 66-frame
0x77/0x78/0x79 dump chain (12,951 bytes). The address selects the
SOURCE, and the two forms behave very differently:

## Slot-addressed: `[preset_hi, preset_lo]` (MSB-first)

```
F0 00 01 74 07 03 <hi> <lo> <cs> F7
```

Returns the STORED flash contents of that slot (never the working
buffer) **and RELOADS the stored preset into the working buffer as a
side effect**, silently destroying unsaved edits. Proven live: a buffer
rename (fn 0x09, buffer-scope verified) was present immediately before
the request and gone immediately after (fn 0x0F re-read), replaced by
the stored preset's name. This is why the consumer's export_preset
never uses the slot-addressed form on the II.

## Sentinel-addressed: `7F 7F` = EDIT BUFFER (AM4 convention transfers)

```
F0 00 01 74 07 03 7F 7F <cs> F7
```

Returns the WORKING BUFFER. Hardware-confirmed three ways in one probe
session (`samples/captured/hw132/` in the consumer repo):

1. **Tracking**: two sentinel dumps taken across a live buffer rename
   ("EB ALPHA" → "EB BRAVO") differ; each differs from the stored dump.
2. **No side effect**: the buffer rename SURVIVES the sentinel request
   (unlike the slot-addressed form).
3. **Round-trip**: pushing the 66-frame response back to the device
   restored the dumped buffer state (name re-read "EB ALPHA").

All three response chains carry an identical 0x77 header payload
`[7F 00 00 20]` regardless of which form was requested; the response
header does NOT echo the requested address (unlike the AM4, whose 0x77
header echoes `[bank, sub]`).

## Cross-device transfer note

The `0x7F 0x7F` sentinel is the AM4's documented active-buffer
convention (`am4-fn03-stored-dump-request` is the mirror entry). It was
worth one read-only probe on the II before accepting "no edit-buffer
dump exists": the 94-opcode AxeEdit table has no dedicated edit-buffer
opcode, but the sentinel rides the existing fn 0x03; opcode-table
absence does not rule out sentinel addressing on an existing opcode.
