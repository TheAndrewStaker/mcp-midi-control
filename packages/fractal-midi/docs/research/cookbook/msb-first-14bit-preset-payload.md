---
name: msb-first-14bit-preset-payload
class: bit-level
status: matched
discovered:  (preset number encoding decode)
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
  - axe-fx-iii-public-captures
firmware_sensitive: false
golden: scripts/verify-axe-fx-ii-encoding.ts (buildSwitchPreset 0/128/699 MSB-first byte goldens)
relates_to: [septet-14bit]
consumed_in:
  - fractal-midi/src/gen2/axe-fx-ii/setParam.ts (buildSwitchPreset)
  - fractal-midi/src/gen3/axe-fx-iii/setParam.ts (buildSwitchPreset)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_14014d2a0 stream-patches MSB-first 14-bit preset index into each 0x77 PRESET_DUMP_HEADER; L322-339)
---

# MSB-first 14-bit preset payload

Preset numbers ≥ 128 in Axe-Fx II / III control envelopes (fn 0x03
SWITCH_PRESET, fn 0x3c, fn 0x1d STORE_PRESET reply, fn 0x14
GET_PRESET_NUMBER reply) encode as 2 bytes, **MSB-first** — distinct
from septet 14-bit pair encoding.

## Formal definition

A preset number `p` in the range 0 ≤ p < 16384 encodes as:

```
[ (p >> 7) & 0x7F, p & 0x7F ]
```

Decode:

```
p = (byte0 << 7) | byte1
```

Both bytes are SysEx-safe (high bit 0). The MSB precedes the LSB in the
wire stream — unlike [[septet-14bit]] which is LSB-first
(pidLow precedes pidHigh).

Example: preset 699 encodes as `[0x05, 0x3B]` → `(0x05 << 7) | 0x3B = 699`.

## Where it's used

- fn 0x03 SWITCH_PRESET — outbound preset selection
- fn 0x3c — outbound variant
- fn 0x1d STORE_PRESET — outbound preset save, target slot
- fn 0x14 GET_PRESET_NUMBER reply — inbound active preset (decoded from
  `05 3B → preset 699`  cite)

## Applicability

Apply ONLY to preset-number fields (and related "global preset slot"
fields like target STORE slot). Do NOT use for parameter IDs or values —
those use [[septet-14bit]].

Cost: trivial. One shift + OR.

## Misapplication failure modes

- **DO NOT confuse with [[septet-14bit]]**. Septet is LSB-first; this
  primitive is MSB-first. Using septet decode on an MSB-first payload
  produces a different (wrong) preset number that may still parse as a
  valid SysEx-safe value, making the bug silent.
- **DO NOT** use for param values. Param values that need >7 bits use
  septet 14-bit encoding, not this. fn 0x02 SET_PARAMETER (II) and
  fn 0x01 SET_PARAMETER (III) tails use septet.
- **DO NOT** apply to AM4 preset numbers — AM4 envelope is different;
  preset locations use the A01-Z04 textual scheme. See
  `protocol/locations.ts`.

## Where it does NOT apply

- AM4 (uses location codes A01-Z04, not numeric preset payload)
- Any param-value field (use [[septet-14bit]] or
  [[septet-21bit-byte2-mask-preservation]])
- fn 0x14 request (the request has no preset-number payload; only the
  reply uses MSB-first)

## Verification path

`scripts/verify-axe-fx-ii-encoding.ts` carries buildSwitchPreset byte
goldens over real envelopes (presets 0 / 128 / 699). Reference fixtures:
1. Encode preset 699 → expected `[0x05, 0x3B]`
2. Decode `[0x05, 0x3B]` → expected preset 699
3. Encode preset 127 (boundary case under MSB byte 0) → expected
   `[0x00, 0x7F]`
4. Encode preset 128 (first preset with non-zero MSB) → expected
   `[0x01, 0x00]`
5. Mismatch fixture: assert septet decode of `[0x05, 0x3B]` yields a
   DIFFERENT value (`0x05 | (0x3B << 7) = 7557`), proving the two
   primitives are distinct.

## Refinement history

- : decoded via passive capture (founder triggered AxeEdit
  "Read from Axe-Fx" → device replied `05 3B` for active preset 700,
  i.e. wire preset 699 = display slot 700). Cross-referenced with
  a community axe-fx-midi library.
- : extended to STORE_PRESET target-slot encoding.
- 2026-05-22 (synthesis pass): promoted to its own cookbook entry
  because the LSB/MSB confusion failure mode is silent (produces a
  parseable wrong number) and easy to introduce when implementing a
  new fn-byte that carries a preset-slot field.
