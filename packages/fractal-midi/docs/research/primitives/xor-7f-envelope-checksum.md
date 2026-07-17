---
name: xor-7f-envelope-checksum
class: checksum
status: matched
discovered: AM4 SYSEX-MAP §6 (codified pre-Session-08); II  (8448/8448 verification); III SYSEX-MAP line 29
verified_on:
  - am4-fw18
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
  - axe-fx-iii-public-captures-v1.4
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-xor-7f-envelope-checksum
relates_to: [vendor-envelope-descriptor-table]
consumed_in:
  - fractal-midi/src/shared/checksum.ts
  - fractal-midi/src/am4/setParam.ts
  - fractal-midi/src/gen2/axe-fx-ii/setParam.ts
  - fractal-midi/src/gen3/axe-fx-iii/setParam.ts
---

# XOR-7F envelope checksum (universal Fractal)

Universal Fractal SysEx envelope checksum across AM4, Axe-Fx II, and
Axe-Fx III: XOR-fold of all bytes from `F0` through the last payload
byte, masked to 7 bits.

## Formal definition

```
checksum = bytes.reduce((a, b) => a ^ b, 0) & 0x7F
```

The fold covers `F0` through the last payload byte (everything except
the checksum byte itself and the terminating `F7`).

Envelope shape (all three devices):
`F0 00 01 74 [model] [fn] [payload...] [checksum] F7`

Model bytes (Fractal device family, per codec source `src/axe-fx-*/setParam.ts`):
- `0x07` → Axe-Fx II
- `0x10` → Axe-Fx III
- `0x11` → FM3
- `0x12` → FM9
- `0x14` → VP4
- `0x15` → AM4

## Where it's used

Every Fractal SysEx envelope. Validated on every inbound message;
emitted on every outbound message. Implementation: `fractal-midi/src/shared/checksum.ts`
(canonical, shared across all three devices).

Verification corpus:
- AM4: every captured envelope (~hundreds across factory bank captures)
- II: 8448/8448 messages across three Q8.02 factory banks
- III: forum + Mountain Utilities captures (`fractal-protocol-decode-status.md`)

## Misapplication failure modes

- **DO NOT** forget to mask with `& 0x7F`. An unmasked XOR can produce
  bytes ≥ 0x80, which break SysEx framing.
- **DO NOT** confuse with [[xor-fold-hash]]: that's the II preset
  binary FOOTER hash (16-bit XOR-fold of decoded ushorts), a separate
  primitive that lives INSIDE the preset push envelope. The
  per-envelope checksum here uses raw wire bytes; the footer hash uses
  decoded native ushorts.
- The checksum is over the WIRE bytes (raw SysEx form). Do NOT compute
  it over decoded payload values; payload decode happens AFTER checksum
  validation.

## Where it does NOT apply

- Hydrasynth (different vendor; ASM uses its own envelope + checksum
  scheme entirely).
- The II preset binary body's XOR-fold hash is NOT this primitive;
  see [[xor-fold-hash]].

## Verification path

`scripts/primitives-verify.ts#case-xor-7f-envelope-checksum` runs fixtures
across all three devices, asserting byte-exact match against captured
checksum bytes:
1. AM4 envelope from `samples/captured/<AM4 factory capture>`
2. II envelope from  capture
3. III envelope from public-capture corpus

Three fixtures = three devices = full generalization-axis coverage.

## Refinement history

- Codified in `docs/devices/am4/SYSEX-MAP.md` from initial AM4 RE work.
- : II verification at 8448/8448 messages (`docs/devices/axe-fx-ii/SYSEX-MAP.md` lines 117-128).
- III: same algorithm cited at `docs/devices/axe-fx-iii/SYSEX-MAP.md` line 29; `src/shared/checksum.ts` is the shared implementation.
- 2026-05-22 (primitives audit): inverted "Where does NOT apply". Earlier
  draft mistakenly said II/III lack this checksum; fixed to reflect
  that all three Fractal devices share the same envelope checksum.
  Status promoted from `matched-singleton` → `matched` (3-device axis
  is the strongest in the primitives corpus).
