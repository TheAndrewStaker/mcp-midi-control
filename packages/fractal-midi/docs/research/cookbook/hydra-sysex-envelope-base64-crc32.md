---
name: hydra-sysex-envelope-base64-crc32
class: checksum
status: matched-singleton
discovered: Pre-extraction (codec ported from edisyn Sean Luke 2023)
verified_on:
  - hydrasynth-explorer-v2.2.0
firmware_sensitive: false
golden: scripts/hydrasynth/verify-sysex-envelope.ts (worked-example + checksum goldens)
relates_to: []
consumed_in:
  - packages/hydrasynth/src/sysexEnvelope.ts
  - scripts/hydrasynth/verify-sysex-envelope.ts
---

# Hydrasynth SysEx envelope (base64 payload + CRC32-derived checksum)

ASM Hydrasynth (Explorer + Deluxe) wraps every SysEx message in a
fixed prefix, then base64-encodes a payload that itself begins with a
4-byte CRC32-derived checksum. Distinct from Fractal's universal
XOR-7F envelope ([[xor-7f-envelope-checksum]]) at every layer: framing
bytes differ, payload is ASCII-encoded, checksum algorithm is CRC32
(not XOR-fold).

The envelope spec was reverse-engineered by Sean Luke for the edisyn
patch editor (2023) and ported to TypeScript at
`packages/hydrasynth/src/sysexEnvelope.ts`.

## Formal definition

Wire framing:

```
F0 00 20 2B 00 6F <ASCII-base64(payload)> F7
```

Where:

- `00 20 2B` is the ASM manufacturer ID.
- `00 6F` is the Hydrasynth model + device ID prefix.
- `payload` is a binary buffer `[checksum(4)] [info...]`.

Checksum derivation (4 bytes prefixed to `info` inside the base64):

```
crc = crc32(info)                  # standard IEEE 802.3 / zlib CRC-32
                                   # reversed polynomial 0xEDB88320, init 0xFFFFFFFF
checksum[0] = (crc >> 24) & 0xFF   # CRC bytes treated AABBCCDD, MSB first
checksum[1] = (crc >> 16) & 0xFF
checksum[2] = (crc >>  8) & 0xFF
checksum[3] = (crc >>  0) & 0xFF
```

The checksum bytes are placed verbatim ahead of `info`; then the full
`[checksum][info]` buffer is base64-encoded; then the base64 ASCII is
sandwiched between the framing prefix `F0 00 20 2B 00 6F` and the
trailing `F7`.

## Where it's used

Every host-to-device or device-to-host Hydrasynth SysEx message uses
this envelope. The codec is `wrapSysex` / `unwrapSysex` in
`packages/hydrasynth/src/sysexEnvelope.ts`. Validation goldens at
`scripts/hydrasynth/verify-sysex-envelope.ts` cover the worked example
from the edisyn spec byte-exactly.

Used by every Hydra MCP tool that ships in the project.

## Misapplication failure modes

- **DO NOT** apply [[xor-7f-envelope-checksum]] (the universal Fractal
  envelope checksum) to Hydrasynth wire frames. Different vendor,
  different envelope, different checksum algorithm.
- **DO NOT** omit the base64 ASCII layer. The payload is base64-encoded
  between the prefix and the F7; raw binary payload bytes inside the
  envelope will be rejected by the device.
- **DO NOT** assume the framing prefix is the same for all ASM devices.
  The `00 6F` byte pair is specific to Hydrasynth Explorer + Deluxe
  (model + device ID); other ASM devices use different IDs.
- **DO NOT** confuse this with the patch format. Patches are stored
  inside the `info` payload as a flat binary blob with its own per-byte
  layout (see [[hydra-nrpn-14bit-with-fxaware-resolution]] for the
  patch-byte addressing model); the envelope is just the wire wrapper.

## Where it does NOT apply

- Any Fractal device (AM4 / II / III) uses [[xor-7f-envelope-checksum]].
- Other vendor SysEx (e.g. Roland, Korg) uses entirely different
  envelopes.
- Hydrasynth's NRPN traffic goes through standard MIDI CC channels
  (not SysEx), so it does not use this envelope; see
  [[hydra-nrpn-14bit-with-fxaware-resolution]].

## Verification path

`scripts/cookbook-verify.ts#case-hydra-sysex-envelope-base64-crc32`
checks that `wrapSysex` produces the byte-exact spec example from
`packages/hydrasynth/src/sysexEnvelope.ts` and that `unwrapSysex` is
the byte-exact inverse.

The CRC32 implementation in the codec is the standard zlib polynomial;
any standard library's CRC32 should produce identical output.

## Refinement history

- Pre-extraction (codec ported 2023 from edisyn Sean Luke RE work).
  Goldens at `scripts/hydrasynth/verify-sysex-envelope.ts` exercise the
  envelope on the spec's worked example.
- 2026-05-22 (Rosetta-stone cookbook audit): promoted to cookbook
  primitive. Previously the cookbook had zero Hydrasynth entries; this
  is the foundational primitive every other Hydra wire interaction
  passes through.
