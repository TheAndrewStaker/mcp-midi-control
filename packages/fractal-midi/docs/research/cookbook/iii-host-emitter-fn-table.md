---
name: iii-host-emitter-fn-table
class: fn-byte-mapping
status: matched-singleton
discovered: Sessions 82-83 (Ghidra mining of AxeEdit III)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: the consumed_in fn-byte-name-map dump citations)
relates_to: [ii-axeedit-opcode-table, vendor-envelope-descriptor-table, iii-fn40-as-store-preset-begin, iii-fn01-set-parameter-envelope]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-fnbyte-name-map.txt
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-host-emitters-precise.txt
  - fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (confirms fn=0x40 at L182, fn=0x01 at L1527, fn=0x12 at L1552 + L1885)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (localizes fn=0x01 to FUN_14033ec70 L22641, fn=0x08 to FUN_140150570 L25149, fn=0x12 to FUN_1401e3fb0 L25209, fn=0x19 to FUN_14033c6e0 L23404, fn=0x1a at L20434, fn=0x43 at L23733, fn=0x47 at L20444+L25084, fn=0x5a to FUN_140328a10 L22941, fn=0x5c to FUN_140336a40 L23081)
---

# Axe-Fx III host-emitter fn-byte table

AxeEdit III (the JUCE editor binary for Axe-Fx III) emits SysEx for ~21
distinct fn bytes. The fn byte to name mapping was recovered Sessions
82-83 by walking caller traces of the central send routines
`FUN_1403437d0` and `FUN_1403434b0` and matching each call site against
the static fn-byte literal it passes. The full list includes 10 fn
bytes documented in the Fractal v1.4 PDF plus 11 fn bytes the PDF omits
(0x0B-0x0F, 0x10-0x13, 0x19, 0x1A, 0x1B, 0x1F, 0x3F, 0x40, 0x46, 0x47,
0x5A, 0x5B, 0x5C, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x7B, 0x7C).

This is the III analog of [[ii-axeedit-opcode-table]], with weaker
verifiability (V4 vs V5) because III's binary is larger, the caller
trace produces some indirect dispatch, and the corpus of live captures
covering each fn byte is smaller.

## Formal definition

The III fn-byte vocabulary is reconstructed by:

1. Static analysis of `Axe-Edit III.exe`. The central send routines
   take a fn-byte literal as their second argument; cross-referencing
   call sites yields the fn-byte to caller mapping.
2. Naming: each caller function's symbol or surrounding string constants
   provides the human-readable opcode name (e.g. `FUN_140337060` calls
   send with fn `0x40`, decoded as LOAD/SELECT PRESET via its caller's
   large inbound-buffer allocation; see
   [[iii-fn40-as-store-preset-begin]] for why this is a read/select
   request and not a store handshake).

Output corpus:

- `ghidra-axe-edit-iii-fnbyte-name-map.txt` (1 line per fn byte; ~21 entries)
- `ghidra-axe-edit-iii-host-emitters-precise.txt` (per-emitter source line
  precision, used when name disambiguation matters)

## Where it's used

The III's `setParam.ts` `FN_*` constants are derived from this mapping.
Wire-byte ground truth comes from the editor binary, not the v1.4 PDF
(which omits 11 of the 21 host-emittable opcodes entirely).

The 11 PDF-omitted fn bytes include the `0x77/0x78/0x79` preset-push
family, the `0x40` block-list bulk op, the `0x46` query-device-version,
the `0x47` initialization family, and `0x5A/0x5B/0x5C` (unnamed, host
emitted but no workflow registered). These ship as decoded primitives
because the editor binary uses them in the wild.

## Misapplication failure modes

- **DO NOT** assume the III fn byte equals the II opcode for the same
  conceptual operation. III's wire vocabulary diverges from II's by
  more than just model byte: see [[iii-fn01-set-parameter-envelope]]
  (III SET_PARAMETER is fn=0x01 + sub-action, NOT II's fn=0x02).
- **DO NOT** read the v1.4 PDF as authoritative for which fn bytes
  exist. The editor binary is the source of truth; PDF omits 11
  host-emittable opcodes.
- **DO NOT** apply II's `wire = enum - 1` offset from
  [[ii-axeedit-opcode-table]] without verification. III's binary uses
  a different struct shape; the offset relationship has not been
  established because III doesn't have a single coherent enum array
  the way II's AxeEdit does.

## Where it does NOT apply

- Axe-Fx II (use [[ii-axeedit-opcode-table]]).
- AM4.
- Hydrasynth.

## Verification path

No inline fixture ships (golden is STUB). The intended invariant: every
`FN_*` constant in `fractal-midi/src/gen3/axe-fx-iii/setParam.ts`
appears in the mined fn-byte-name map text dump.

Live wire-byte validation is partial: a subset of fn bytes have
captured frames (fn 0x01 via [[iii-fn01-set-parameter-envelope]],
fn 0x77/0x78/0x79 via the III factory bank corpus, fn 0x14 via Session
105). Most III fn bytes lack live captures because no III-owning
contributor has run the corresponding probe.

## Refinement history

- Sessions 82-83 (Ghidra mining): caller-trace mining produced the
  initial ~21-entry map.
- 2026-05-18: fn=0x01 SET_PARAMETER pivot disambiguated
  the III set-param fn byte; see [[iii-fn01-set-parameter-envelope]].
- 2026-05-22 (Rosetta-stone cookbook audit): promoted to cookbook
  primitive. Pre-existing decode work that predated the cookbook
  discipline.
- 2026-05-28: corrected the worked example in the Formal definition.
  `FUN_140337060` emits fn `0x40` (LOAD/SELECT PRESET), not fn `0x1D`
  "STORE_PRESET". Every other source, including this entry's own
  `consumed_in` store-preset dump and [[iii-fn40-as-store-preset-begin]],
  establishes the fn=0x40 / select-preset reading.
