# Axe-Fx III, fn byte research findings

Cross-reference of the III binary's fn-byte vocabulary against the 23
`SYSEX_*` string-pool symbols.  Captures the results of running:

- `scripts/ghidra/MineAxeEditIIIv2.java`
- `scripts/ghidra/TraceAxeEditIIIMessageBuilders.java`
- `scripts/ghidra/MineAxeEditIIIEnvelopeEmitters.java`
- `scripts/ghidra/AssociateAxeEditIIIFnByteWithName.java`
- `scripts/ghidra/FindAxeEditIIIRvaPointerArray.java`
- `scripts/ghidra/FindAxeEditIIIEnumPtrArray.java`

Against a local Axe-Edit III Ghidra project (Axe-Edit III.exe v1.14.31).

Parser side: `scripts/_research/parse-axeedit3-fnbyte-callers.ts` (in
the consumer repo) parses the message-builder trace into a
`(fn_byte, caller, call_site)` JSON + markdown table.

## TL;DR

- The III hardcodes its fn byte per-emitter and dispatches through two
  generic builders. The fn byte is passed as `param_2`:
  - `FUN_1403434b0`, 4-arg builder `(buf, fn_byte, payload, payload_ptr)`
  - `FUN_1403437d0`, 5-arg builder `(buf, fn_byte, payload_ptr, len, model)`
- We extracted **27 distinct fn-byte literals** from the 36 known
  emitter call sites.
- The `SYSEX_*` string pool at `.rdata` 0x1405abf80..0x1405ac298 is
  NOT referenced by any emitter (or any other) code. The strings are
  inert data, likely consumed by reflection / `__rtti` / a
  build-system metadata path that doesn't show up as a code xref.
  Tried (all empty): struct table `{ptr,opcode}`, flat 64-bit
  pointer array, 32-bit RVA array, instruction-walk LEA operands.
- **NEW finding.** Pair of emitter call sites encodes
  the fn byte as `(boolean) * 0x20 + 0x5A`. This produces either
  `0x5A` or `0x7A` per call (and analogously for `0x5B/0x7B`,
  `0x5C/0x7C`). The +0x20 offset between request/response or
  toggled-direction wire-bytes is a Fractal convention. See "Paired
  +0x20 fn bytes" below.

## fn byte vocabulary (27 distinct)

| fn  | v1.4 PDF | Caller functions | Hypothesis |
|----:|---|---|---|
| 0x00 |, | `FUN_1401c15d0` | 1-call. Likely reset/null. |
| 0x01 | ✓ PRESET_NUM | `FUN_14033ec70` | Byte-verified  as SET_PARAMETER. |
| 0x03 | ✓ TUNER | `FUN_14033bee0` | (II convention: 0x11 TUNER per v1.4 to 0x03 may be alt path.) |
| 0x04 | ✓ TEMPO | `FUN_14014d400` | (II convention 0x14 = TEMPO per v1.4.) |
| 0x08 | ✓ WHO_AM_I | `FUN_140150570`, `FUN_14015d6f0`, `FUN_1401c0690`, `FUN_1401c12f0` | 4 callers, every device-discovery code path. |
| 0x12 |, | `FUN_1401e3fb0`, `FUN_140253360` | 2 callers; both pass `model-from-struct` last arg. Strong candidate for `SYSEX_FS_PASSTHRU_MESSAGE` (FS = footswitch passthru). |
| 0x19 |, | `FUN_14033c6e0` | FOOTSWITCH-adjacent. |
| 0x1A |, | `FUN_14033ce70` | FOOTSWITCH-adjacent (3-byte payload). |
| 0x1B |, | `FUN_140211fe0` | FOOTSWITCH-adjacent (3-byte payload). |
| 0x1F |, | `FUN_140339ed0` | 14-bit-value packed-septet; sub-1f-shape. |
| 0x3F |, | `FUN_140336dd0` | 14-bit value pair with 0x40. |
| 0x40 |, | `FUN_140337060` | Per community RE: STORE_PRESET_BEGIN / ACK. **Hypothesis**: `SYSEX_GUI_CONTROL`. |
| 0x46 |, | `FUN_140333350` | Paired with 0x47 (INIT). Plausibly `SYSEX_DSP_MESSAGE` or `SYSEX_FS_MESSAGE`. |
| 0x47 |, | `FUN_140150400`, `FUN_14015d6f0` | INIT / session-start (II `0x47` matches). Empty payload. |
| 0x5A |, | `FUN_140328a10`, `FUN_1401a1a20` (toggled) | Paired with 0x7A via `+0x20` toggle. **Hypothesis**: `SYSEX_A3_SYSTEM_DATA_START`. |
| 0x5B |, | `FUN_1403359b0` | Paired with 0x7B. **Hypothesis**: `SYSEX_A3_SYSTEM_DATA`. |
| 0x5C |, | `FUN_140328a10` | Paired with 0x7C. **Hypothesis**: `SYSEX_A3_SYSTEM_DATA_END`. |
| 0x74 |, | `FUN_140338fb0` | Preset-adjacent; II uses 0x74 for `SYSEX_EFFECT_START`. **Hypothesis**: `SYSEX_EFFECT_DUMP` start. |
| 0x75 |, | `FUN_140339c40` | II `SYSEX_EFFECT_DATA`. **Hypothesis**: `SYSEX_EFFECT_DUMP` chunk. |
| 0x76 |, | `FUN_1401e7a70`, `FUN_14021ce90`, `FUN_14021e300` | II `SYSEX_EFFECT_END`. **Hypothesis**: `SYSEX_EFFECT_DUMP` footer. 3 callers + grid-block triggered code path candidate for  routing decode. |
| 0x77 |, community | `FUN_1401a1a20`, `FUN_1401d6f10`, `FUN_14033ba50`, `FUN_14014d2a0` | PRESET_DUMP HEADER (II shape). Verified hardcoded in `FUN_14014d2a0` (the v2 trace shows `local_43 = 0x77`). |
| 0x78 |, community | `FUN_14033ae30` | PRESET_DUMP CHUNK. |
| 0x79 |, community | `FUN_14033ac00` | PRESET_DUMP FOOTER. |
| 0x7A |, | `FUN_140336060`, `FUN_1401a1a20` (toggled) | Paired with 0x5A. **Hypothesis**: response/inverse-direction of `SYSEX_A3_SYSTEM_DATA_START` OR `SYSEX_FOOTSWITCH_START` (II convention puts START family at 0x7A range). |
| 0x7B |, | `FUN_140335000` | Paired with 0x5B. **Hypothesis**: `SYSEX_FOOTSWITCH_DATA`. |
| 0x7C |, | `FUN_140335370` | Paired with 0x5C. **Hypothesis**: `SYSEX_FOOTSWITCH_END`. |
| 0xFF |, | `FUN_14033db70` | Error sentinel (not a real fn byte on the wire). |

## Paired +0x20 fn bytes, new pattern

Two callers (`FUN_1401a1a20` and `FUN_14014ced0`) emit the fn byte
via arithmetic on a runtime boolean:

```c
// FUN_1401a1a20, line 544 of the message-builders trace
FUN_1403434b0(&local_1e0, (bVar25 ^ 1) * 0x20 + 0x5A, cVar14, &local_1d0);
// fn = 0x5A when bVar25 = 1
// fn = 0x7A when bVar25 = 0
```

```c
// FUN_14014ced0, line 116
FUN_1403434b0(param_2, (lVar13 << 5) + 0x5A, cVar6 ...);
// fn = 0x5A when lVar13 = 0
// fn = 0x7A when lVar13 = 1
```

This explains why we recovered both `0x5A` and `0x7A` (and similarly
`0x5B/0x7B`, `0x5C/0x7C`) as distinct emitters: they're the **same
logical operation** dispatched in two directions or modes. The +0x20
offset is the Fractal convention for the request↔response pair (or
toggled-mode pair).

**Implication for the SYSEX_* string-name mapping.** The 23-entry
`SYSEX_*` pool names ONE side of each pair. Possibilities:

| Pair | III strings | II analogue |
|---|---|---|
| 0x5A ↔ 0x7A | `SYSEX_A3_SYSTEM_DATA_START` vs `SYSEX_FOOTSWITCH_START` | II 0x7A = `SYSEX_CABIR_START` (different family, III likely reused the band for FOOTSWITCH/SYSTEM_DATA) |
| 0x5B ↔ 0x7B | `SYSEX_A3_SYSTEM_DATA` vs `SYSEX_FOOTSWITCH_DATA` | II 0x7B = `SYSEX_CABIR_DATA` |
| 0x5C ↔ 0x7C | `SYSEX_A3_SYSTEM_DATA_END` vs `SYSEX_FOOTSWITCH_END` | II 0x7C = `SYSEX_CABIR_END` |

The pair-with-+0x20 convention is the FIRST piece of evidence we have
for III pairing direction at the wire level. Hardware captures can
resolve the direction definitively:

1. Trigger AxeEdit III to read the **footswitch config**. Capture the
   outgoing SysEx. Whichever fn byte the host sends is the
   FOOTSWITCH side.
2. Trigger AxeEdit III to read **system data**. Capture the outgoing
   SysEx. Whichever fn byte the host sends is the A3_SYSTEM_DATA side.
3. The remaining fn byte in each pair is the device→host response.

## SYSEX_* string pool, inert data

The 23 `SYSEX_*` strings exist at `.rdata` 0x1405abf80..0x1405ac298
but have ZERO code xrefs by any technique we tried. They're likely
consumed by a reflection / metadata path the static analysis can't
trace.

**Workaround for the SYSEX_* → fn-byte mapping**: anchor the strings
against captures + the II wire-map. The fn-byte vocabulary we have is
the wire-byte side of the contract; the string names are the human
side, and the mapping is established via either:
(a) USBPcap of AxeEdit III firing the operation we want to name, or
(b) cross-reference of the +0x20 pairing pattern against the III's
known operations.

## Followups

- **Routing decode.** The III's grid routing is likely encoded in the
  `SYSEX_EFFECT_DUMP` family (0x74/0x75/0x76). Decompile `FUN_140338fb0`
  (0x74 emitter) for the payload shape; compare against II's fn 0x20
  GET_GRID envelope.
- **`SYSEX_*` mapping, next step.** Capture one operation per `SYSEX_*`
  name (footswitch, dsp, gui-control, system-dump) and bind each to a
  specific fn byte. ~6 captures, ~10 min hardware time per beta user with
  a III. Standardized community capture procedure lives in the community
  capture guides under `../../capture-guides/`.
