---
name: gen1-nibble-split
class: bit-level
status: matched-singleton
discovered: (2026-06-05; decoded from the published Axe-Fx Ultra SysEx doc)
verified_on:
  - axe-fx-ultra-sysex-doc-10.05
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-gen1-nibble-split
consumed_in:
  - packages/fractal-midi/src/gen1/nibble.ts
  - packages/fractal-midi/src/gen1/setParam.ts
  - packages/fractal-midi/docs/devices/axe-fx-gen1/SYSEX-MAP.md
---

# gen-1 (Axe-Fx Standard/Ultra) nibble-split field encoding

The first-generation Fractal flagship (model byte `0x01`) encodes **every**
addressable wire field (block id, parameter id, and value) the same way: an
8-bit value `0..255` is transmitted as **two MIDI bytes, low nibble first**:

```
toWire(v)       = [v & 0x0f, (v >> 4) & 0x0f]   // each byte 0..15, high bit clear
fromWire(lo,hi) = (hi << 4) | lo
```

Because each transmitted byte carries a single nibble, the high bit is always
zero and the value is MIDI-safe by construction (no septet packing needed).

This is **distinct from the rest of the family**: gen-2 (Axe-Fx II, model `0x03`/
`0x07`) septet-packs a 16-bit value into three 7-bit bytes (see `septet-14bit`),
and gen-3 (III / FM3 / FM9) carries packed float32. The gen-1 encoding does not
transfer to or from those families.

## Set-parameter envelope

```
F0 00 01 74 01 02 [bb bb] [pp pp] [vv vv] 01 F7
```

- `01` = model byte (Ultra), `02` = set-parameter function.
- `bb bb` / `pp pp` / `vv vv` = block id / param id / value, each nibble-split.
- The trailing `01` is a **fixed byte, NOT a checksum**: the XOR of the worked
  example's `F0..value` payload is `0x02`, not `0x01`, so no checksum is applied.
  (Contrast AM4/II, which XOR-fold to a `& 0x7F` checksum.)

## Why matched-singleton (documentary, not hardware)

Only gen-1 uses this encoding, so there is a single verification axis. That axis
is unusually strong: the published doc prints both the decimal value and the
`0x 0x` hex pair for **every** cell in its tables AND a complete `0..255`
decimal→hexpair conversion table. The golden validates `toWire`/`fromWire`
against the doc's worked examples (value 163 → `03 0A`, block 100 → `04 06`, Amp
TYPE max 70 → `06 04`), the full `0..255` round-trip (256/256), and the complete
Compressor-2-Knee=SOFTER envelope. The encoding is byte-exact against the vendor
document; it is **not** hardware-verified (the project owns no gen-1 unit), so
the device ships community-beta.
