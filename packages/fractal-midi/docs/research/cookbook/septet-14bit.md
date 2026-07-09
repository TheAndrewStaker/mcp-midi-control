---
name: septet-14bit
class: bit-level
status: matched
discovered: 
verified_on:
  - am4-fw18
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
  - axe-fx-iii-public-captures
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-septet-14bit
relates_to: [septet-21bit-byte2-mask-preservation, msb-first-14bit-preset-payload]
consumed_in:
  - fractal-midi/src/shared/packValue.ts
  - fractal-midi/src/am4/setParam.ts
  - fractal-midi/src/gen2/axe-fx-ii/setParam.ts
  - fractal-midi/src/gen3/axe-fx-iii/setParam.ts
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (LSB-first septet pairs in FUN_140337060 L122-127, L175-179 and FUN_14033ec70 L1379-1380, L1407-1408, L1435-1436, L1493-1495, L1521-1522)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (5-septet 32-bit width-variant at FUN_14033ec70 L22782-22786 and FUN_140336a40 L23076-23080; N=2 inside the III binary confirms the same shift-table {0, 7, 14, 21, 28} the cookbook documents for the 2-septet form generalizes to 5 septets)
---

# Septet 14-bit encoding (LSB-first)

A 14-bit unsigned value `v` (0 ≤ v < 16384) encodes as 2 SysEx-safe bytes,
**LSB-first**:

```
encode(v): [ v & 0x7F, (v >> 7) & 0x7F ]
decode(b0, b1): b0 | (b1 << 7)
```

## Where it's used

Everywhere a 14-bit field appears in a Fractal envelope tail:
- paramId low/high pair (`pidLow, pidHigh`): `set_param` / `get_param`
- action codes in fn 0x01 SET_PARAMETER (III) tails
- effect ids in fn 0x05 SET_GRID_CELL (II)
- preset numbers in command frames (when LSB-first variants are used,
  but NOTE the reply payloads are MSB-first; see
  [[msb-first-14bit-preset-payload]])
- tempo BPM in fn 0x14 family
- location bytes in AM4 envelope

Implementation: `fractal-midi/src/shared/packValue.ts` (canonical).

## Misapplication failure modes

- **DO NOT** use this for preset-number REPLY payloads: those are
  MSB-first ([[msb-first-14bit-preset-payload]]). The bug is silent
  (produces a parseable wrong number).
- **DO NOT** use this for 21-bit values; use
  [[septet-21bit-byte2-mask-preservation]].
- Forgetting to septet-encode a field that EXTERNALLY looks like 1 byte
  but might exceed 127 (action codes, effect IDs) was the 
  bug class. Always septet-encode 14-bit fields; never assume they
  fit in 1 byte just because current observed values are ≤ 127.

## Verification path

`scripts/cookbook-verify.ts#case-septet-14bit` runs round-trip fixtures
covering boundary cases (0, 127, 128, 16383). Plus 18+ existing
`verify-msg.ts` goldens that use septet decode against captured wire
bytes (see SYSEX-MAP files).

## Refinement history

- : bug found, pidHigh was being decoded as the high byte of
  a little-endian 16-bit int instead of the high 7 bits of a 14-bit
  septet. Fix shipped. Rule established: every new pidHigh requires a
  `verify-msg.ts` golden built from captured bytes.
