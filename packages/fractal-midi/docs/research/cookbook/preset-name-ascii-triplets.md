---
name: preset-name-ascii-triplets
class: struct-layout
status: matched-singleton
discovered: 
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
firmware_sensitive: false
golden: scripts/verify-preset-dump-ii.ts (extractPresetName across the 128-entry factory corpus)
relates_to: [vendor-envelope-descriptor-table, septet-21bit-byte2-mask-preservation]
consumed_in:
  - packages/fractal-gen2/src/presetDump.ts (extractPresetName)
---

# Preset name ASCII triplets (II)

Axe-Fx II preset names are stored as 32 × 3-byte ASCII triplets at
CHUNK00 byte offsets 008..103. Each triplet is `[ch, 0x00, 0x00]` where
`ch` is the ASCII character.

## Formal definition

Preset name field layout: 32 character slots × 3 bytes each = 96 bytes,
starting at CHUNK00 offset 008.

```
encode(name): for each char i (0..31), bytes[8 + 3*i] = name.charAt(i) (ASCII), padded with spaces; the next 2 bytes are 0x00, 0x00
decode(bytes): char i = bytes[8 + 3*i]; concatenate; trim trailing spaces
```

The 2 zero bytes after each character are the [[septet-21bit-byte2-mask-preservation]]
alignment artifact: the preset binary is uniformly 3 bytes per ushort,
and each ASCII character fits in 7 bits = 1 septet (the low byte of
the ushort), leaving the other 2 bytes zero. The 96-byte preset name
field is therefore 32 native ushorts each carrying a single ASCII
character in the low byte.

## Where it's used

- II preset binary parser/serializer at the CHUNK00:008-103 byte range.
- Used by `axefx2_set_preset_name` (working-buffer name write) and the
  `dump_preset` / `restore_preset` round-trip path.

## Misapplication failure modes

- **DO NOT** treat as a packed 96-byte ASCII string — that's a 96-char
  name (the field is 32 characters max, not 96).
- **DO NOT** ignore the zero-byte padding — if you write a non-zero
  byte in those positions, the parser will misalign and the next field
  in the binary may be corrupted.

## Where it does NOT apply

- AM4 preset names use a different encoding entirely. See
  `scripts/_research/decode-am4-preset-name.ts` for the AM4 decoder.
- Axe-Fx III — transfer candidate (`iii-preset-receiver.txt` un-mined).

## Verification path

`scripts/verify-preset-dump-ii.ts` decodes the name region via
`extractPresetName` across the 128-entry factory corpus (local
captures). Reference round-trip: encode "Test Crunch" → 96 bytes →
decode → "Test Crunch" (trimmed).

## Refinement history

- : byte range CHUNK00:008-103 + triplet structure
  decoded from captured preset.
- Cookbook entry created from STATE.md table reference.
