<!-- Provenance: harvested from branch `hydrasynth-explorer` (commit d0d9aa7 "Hydrasynth: write up .hydra/.patch file-format probe findings"). Source path: docs/devices/hydrasynth-explorer/HYDRA-FILE-FORMAT.md. Inline paths updated to current monorepo layout. Format itself has not changed — this is local-file probe notes, not protocol RE. -->

# `.hydra` / `.patch` file format — investigation notes

**Status:** partially RE'd. Not blocking conversational patch building (NRPN
covers that, and `hydra_apply_patch` round-trips the SysEx envelope). Static
decoding of the on-disk `.hydra` / `.patch` container is queued as backlog
for the future "load patch from disk → edit → push" flow without device
attached.

## What we learned (Session — 2026-04-27)

### Container

`.hydra` is a ZIP archive. Each file inside is one `.patch` (binary)
named with a 2-digit prefix (00–7f) for the bank slot and the patch
title appended (e.g. `00Northern Heat RA.patch`). One `.hydra` file =
one bank of up to 128 patches.

### `.patch` file structure

Each `.patch` is a fixed **1762 bytes**. Sample of 10 patches: 61.5%
of bytes are identical across all patches (structural padding +
zero-filled unused slots), 38.5% vary by patch (parameter payload).

Byte map derived from cross-patch diff:

| Offset | Length | Field |
|---|---|---|
| `0x00`–`0x03` | 4 | Header tag — varies. Bytes 0–1 differ across patches (possibly per-patch CRC); byte 2 = patch slot index in bank (0..127); byte 3 typically `00`. |
| `0x04` | 1 | Suspected category byte (1..32, sometimes 0). |
| `0x05`–`0x14` | 16 | Patch name — ASCII, padded with spaces or nulls. |
| `0x15` | 1 | `00` terminator. |
| `0x16`–`0x17` | 2 | Unknown (sometimes patch-id-related, sometimes spaces). |
| `0x18`–`0x1B` | 4 | **Constant** `b0 04 00 00` = u32 LE 1200. Magic / version marker. |
| `0x1C`–`0x1F` | 4 | Encoder/version flags (varies modestly per patch). |
| `0x20`–`0x659` | 1594 | **Parameter payload.** Mostly variable bytes interleaved with 4–46-byte zero-filled regions. Likely sparse-encoded — known NRPN params packed in fixed slots, unused slots zero-filled. |
| `0x65A`–`0x6D6` | ~125 | **Macro label section.** Eight 17-byte slots holding ASCII labels + null padding. Default labels include `Wavescan`, `WavStack`, `PulsWdth`, `Delay`, `KeyVoice`, `PadVoice`, `Phaser`, `Reverb`. Patches override with custom names (e.g. `Pad Vol`, `Pad Wave`). |

### What this is NOT

The `.patch` format is **NOT** the same as the SysEx-decoded patch format
that edisyn's `references/SysexPatchFormat.txt` describes. Edisyn's
spec covers a ~2462-byte raw payload starting with `06 …` (Save to RAM
marker). The `.patch` file is ASM Manager's own packing — smaller,
different layout, no clear `06` magic.

Specifically:
- Edisyn's spec uses 2-byte slots per parameter (even byte = LSB,
  odd byte = MSB).
- ASM Manager's `.patch` is denser. Likely 1 byte per param slot for
  most parameters, with selective 2-byte slots for params that need
  the extra resolution. That accounts for the ~700-byte size
  difference. Aligns with the `/8` patch-buffer scaling described in
  `OVERVIEW.md` — the patch file packs `wire / 8` per byte for most
  engine knobs.

### Why fully decoding it is a multi-session project

To map every byte to its parameter:

1. Save a patch in ASM Manager.
2. Change one knob, re-save.
3. Diff the two files; the changed byte(s) identify which slot owns
   that knob.
4. Repeat for ~1175 known params — a few hundred device-side actions,
   then a parser written from the resulting byte map.

Tractable but tedious. ASM Manager source isn't open; community
parsers I found don't cover this format. Edisyn deliberately skipped
it ("the front-panel Send Patch / Send Bank emits a non-standard
`F0 01…` envelope … Edisyn declined to RE it. Skip — use the
documented flow instead").

## Recommendation — go around the format, not through it

The device exposes a **documented** SysEx flow for getting / setting
the current patch. Per `references/SysexEncoding.txt` it works like
this:

- Host sends a request SysEx → device responds with the current patch
  encoded in edisyn's documented format (the same 2462-byte map).
- Host can decode, edit, and send back via documented Save flow.

The **Save** side of this flow is already implemented in current
main as `hydra_apply_patch` (see
`packages/hydrasynth/src/sysexEnvelope.ts` +
`patchEncoder.ts`). The **Request** side (device → host patch dump)
is specified in `references/SysexEncoding.txt` but not yet wired
into a tool.

**For "load patch from disk and push", that means:**

- Convert `.hydra` → individual `.patch` files (already trivial; they're
  ZIP entries).
- Decode each `.patch` to `{name, value}` pairs **using the device as
  decoder**: send the patch via Save SysEx, then read it back via
  Request, get the documented format, parse with edisyn's spec.

Round-trip through the device sidesteps the `.hydra` decode entirely
for any flow that has the device on hand. The pure-offline case (read
`.hydra` without the device) still requires a real `.patch` decoder —
which stays as backlog.

## Pragmatic next step (when this becomes priority)

The Save half of the Request/Save flow is shipped. The remaining work:

1. Add a `hydra_request_patch` MCP tool wired to the device→host
   Request envelope from `references/SysexEncoding.txt`.
2. Wire a `hydra_load_hydra_file(path, slot)` that unzips a `.hydra`,
   sends each `.patch` as raw bytes via SysEx, and lets the device
   normalize them on its end. (If ASM Manager's `.patch` envelope is
   compatible enough that the device accepts it directly, this works
   immediately. If not, we fall back to the device-as-decoder loop.)
3. Build `.patch` static decoder if/when offline-edit becomes a real
   user request.

## Files involved

- `docs/devices/hydrasynth-explorer/references/nrpn.csv` — edisyn NRPN map (vendored).
- `docs/devices/hydrasynth-explorer/references/SysexPatchFormat.txt` — byte-level patch decode (vendored). Applies to the SysEx-Request response, NOT to the `.patch` file.
- `docs/devices/hydrasynth-explorer/references/SysexEncoding.txt` — envelope + base64 + CRC (vendored). Required for the Request / Save flow.
- `docs/devices/hydrasynth-explorer/references/ASMHydrasynth.java` — edisyn editor source (vendored). Holds enum tables already extracted to `packages/hydrasynth/src/enums.ts`; also has reference Java code for the Request/Save flow.
- `packages/hydrasynth/src/sysexEnvelope.ts` — envelope codec for the documented Save flow (shipped).
- `packages/hydrasynth/src/patchEncoder.ts` — byte-map writer for the patch payload (shipped).
