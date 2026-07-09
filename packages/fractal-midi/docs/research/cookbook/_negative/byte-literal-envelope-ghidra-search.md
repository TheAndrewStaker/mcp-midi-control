---
name: byte-literal-envelope-ghidra-search
class: ghidra-mining
status: non-matching
discovered:  (II dispatcher mining)
verified_on:
  - axe-edit-ii-32bit
firmware_sensitive: false
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when: never (structural, multi-device Fractal editors load the model byte at runtime by construction; the 4-byte-prefix scan + model-load inspection is the permanent replacement)
relates_to: [param-descriptor-16byte, ii-axeedit-opcode-table]
consumed_in: []
---

# Byte-literal full SysEx envelope search in Ghidra: does NOT work

A natural Ghidra mining plan for locating an editor's outbound SysEx
emitter is: search the binary for the 5-byte literal of the device's
SysEx envelope (e.g. `F0 00 01 74 10` for Axe-Fx II). It does NOT
work, because the model byte is loaded at runtime from a device-
handle struct, not embedded in the emitter's code.

## Why it fails

The editor's emitter writes the first 4 envelope bytes
(`F0 00 01 74`) as constants and then loads the model byte (`0x10`
for II, `0x07` for III, `0x15` for AM4) from a `*model` field on the
active device-handle struct. In disassembly the emitter looks like:

    F0 00 01 74           ; 4-byte literal
    MOV  AL, [ECX + 0x14] ; load model byte from device handle
    [emit AL]
    ...

The 5-byte search returns zero hits in any Fractal editor. The
4-byte search returns the emitter's literal write plus the model-
load instruction immediately following, which is what identifies
the function. See SESSIONS.md  for the disassembly walk.

## What works instead

- **Search the 4-byte prefix `F0 00 01 74`** and inspect the next
  instruction for the model load. The function is identified by
  the *pair* (literal prefix + model-load), not the full envelope.
- **[[ii-axeedit-opcode-table]]:** once the emitter function is
  identified, mine the static `OpcodeDescriptor` table in `.rdata`
  for the full fn-byte vocabulary (94 entries for II).

## What this does NOT rule out

- Byte-literal search for sub-envelope shapes that are emitted as
  constants (e.g. fn-byte + leading sub-action). Those land in
  `.text` as immediates.
- Searches against AMs / variants whose model byte is also
  hard-coded by an emitter that is not multi-device-capable.
  Editor-side emitters are multi-device; bespoke firmware-side
  emitters may be single-device.

## Symptoms / grep terms

Search these before re-attempting:

- "Ghidra search F0 00 01 74 10" / "5-byte SysEx envelope literal search"
- "model byte loaded at runtime" / "zero hits envelope search"
- "search 4-byte prefix F0 00 01 74" (the working alternative)

## Refinement history

- 2026-05-22 (cookbook backfill): negative finding registered after
   dispatcher-recovery walk. Pair with the positive
  refinement that Ghidra IS a viable lane for II (`SeekParamTablesII.java`,
  , 1,113 paramId/symbol entries at 99% indexed-symbol
  coverage); see CLAUDE.md "Ghidra-II reversal" note.
