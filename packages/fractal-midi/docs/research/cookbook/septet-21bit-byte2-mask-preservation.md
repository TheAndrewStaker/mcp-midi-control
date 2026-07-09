---
name: septet-21bit-byte2-mask-preservation
class: bit-level
status: matched-singleton
discovered:  (NACK 0x13 bug-fix evidence)
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-septet-21bit-byte2-mask-preservation
relates_to: [septet-14bit, vendor-envelope-descriptor-table, xor-fold-hash, ii-fn0e-query-states, ii-state-broadcast-triple-write]
consumed_in:
  - packages/fractal-gen2/src/presetDump.ts (writeback path)
  - packages/fractal-gen2/src/blockBinaryLayout.ts
  - scripts/_research/bk070-modified-push-with-hash.ts
---

# Septet 21-bit with byte2 high-5-bits mask preservation

When packing a 21-bit unsigned value into 3 wire bytes (Axe-Fx II preset
binary's native ushort representation, used in the fn 0x77/0x78/0x79
preset-binary push and writeback), the high 5 bits of byte 2
(`byte2 & 0x7c`) MUST be preserved across writeback operations. Zeroing
them triggers fn 0x79 NACK 0x13.

## Formal definition

A 21-bit value `v` (0 ≤ v < 2²¹) is packed into 3 wire bytes:

```
byte0 = v & 0x7F                              // low septet
byte1 = (v >> 7) & 0x7F                       // mid septet
byte2 = (originalByte2 & 0x7C) | ((v >> 14) & 0x03)   // high 2 bits ONLY
```

The high 5 bits of byte 2 (`0x7C` = bits 2-6, plus bit 7 always 0 to keep
the byte SysEx-safe) are reserved by the firmware for something we do
NOT yet understand: possibly a record-type tag, possibly a continuity
marker. They must be preserved verbatim across reads.

Decode (read side):

```
v = byte0 | (byte1 << 7) | ((byte2 & 0x03) << 14)
```

## Where it's used

- II preset binary native ushort encoding throughout the 3072-byte
  envelope (decoded as 1024 ushorts each spanning 3 wire bytes).

This scheme does NOT apply to the fn 0x0E QUERY_STATES response, which
tiles into 5-byte records of four plain septets (no reserved-bit
preservation, checksum-less); see [[ii-fn0e-query-states]]. Nor does it
apply to the fn 0x1F state-broadcast-triple reply, which uses
`packValue16` (byte2 only 2 value bits); see
[[ii-state-broadcast-triple-write]].

Empirical bug evidence: initial writeback used
`byte2 = (v >> 14) & 0x7F` (zeroing the reserved bits 2-6). Result:
fn 0x79 NACK code 0x13 on multi-modification pushes. Fix:
`byte2 = (originalByte2 & 0x7C) | ((v >> 14) & 0x03)`. NACKs eliminated;
390/390 preset round-trips verified.

## Applicability

Apply when packing or unpacking any 21-bit value in the II preset binary
envelope family. The XOR-fold hash ([[xor-fold-hash]]) computes over the
DECODED 21-bit ushorts, not the raw 3-byte wire form, so a missing
preservation rule corrupts both the data AND the hash.

Cost: zero (encode/decode is in `packages/fractal-gen2/src/presetBinary/`).

## Misapplication failure modes

- **DO NOT** use `(v >> 14) & 0x7F` for byte 2 high bits. That zeroes
  the reserved bits and triggers NACK 0x13. Use `& 0x03` for the value
  contribution and OR with `originalByte2 & 0x7C`.
- **DO NOT** assume byte 2 reserved bits are always 0. They are not;
  they carry firmware-defined state. Read-modify-write is required;
  blind-write is wrong.
- **DO NOT** confuse with [[septet-14bit]]. 14-bit septet uses 2 bytes,
  no reserved bits. 21-bit-in-3-bytes is a distinct primitive with the
  byte2 preservation rule.

## Where it does NOT apply

- Axe-Fx III preset binary: transfer candidate. The III envelope spec
  is byte-identical in shape to II (see
  [[vendor-envelope-descriptor-table]]), and III's `byte_count` field
  values are consistent with 3-bytes-per-ushort packing
  (`byte_count = 768` for 256 ushorts; `byte_count = 192` for 64 ushorts).
  III byte 2 preservation rule is a same-session test as soon as a III
  owning contributor is available.
- AM4: AM4 envelopes use 14-bit septet only; no 21-bit field observed.
- Fn 0x01 SET_PARAMETER tail: uses [[septet-14bit]], not this primitive.
- fn 0x0E QUERY_STATES and fn 0x1F state-broadcast triples use
  4-plain-septet records / `packValue16`, not the 21-bit
  byte2-preservation scheme. This primitive is the preset-binary
  (0x77/0x78/0x79) path only.

## Verification path

`scripts/cookbook-verify.ts#case-septet-21bit-byte2-mask-preservation`
runs two fixtures:
1. Read-then-write round-trip: read a known preset, write it back
   unchanged, assert byte-exact match with captured original.
2. Modify-then-write round-trip: read, modify one ushort, write back,
   verify modification AND verify untouched bytes remain identical.

Both fixtures cite the  capture set.

## Refinement history

- 2026-05-22: bug found + fixed. Initial encode
  zeroed bits 2-6 of byte 2 → NACK 0x13. Fix landed in `BLOCK_LAYOUT_MAP`
  writeback path; 390/390 preset push verified.
- Cookbook entry created from synthesis pass 2026-05-22, promoting the
  bug-fix detail from -DECODE-NOTES.md to a primitive because it
  generalizes to III preset binary handling.
- 2026-05-28: scope corrected. Removed the claim that this scheme governs
  the fn 0x0E QUERY_STATES response (5-byte plain-septet records) and the
  fn 0x1F reply (`packValue16` state-broadcast triple). This primitive is
  the preset-binary 0x77/0x78/0x79 path only.
