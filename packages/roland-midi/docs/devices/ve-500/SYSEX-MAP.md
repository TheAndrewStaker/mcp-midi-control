# Boss VE-500 SysEx map

Roland address-based SysEx (DT1/RQ1). Decoded from the BOSS VE-500 Editor's own
wire code (the manufacturer's authoritative encoder) and hardware-confirmed
end-to-end on the maintainer's unit (2026-06-28 for the core param/read/bypass/
recall surface, 2026-07-08 for the Communication-Mode save handshake). The
editor's published SysEx spec is "not opened for users," so this is decoded from
the editor app, not a published chart.

## Envelope

```
DT1 (write):  F0 41 <dev> 00 00 00 55 12 <addr:4> <data:N>   <cksum> F7
RQ1 (read):   F0 41 <dev> 00 00 00 55 11 <addr:4> <size:4>   <cksum> F7
```

| Field | Value |
|---|---|
| Manufacturer | `0x41` (Roland) |
| Device ID `<dev>` | `0x10` default (configurable); replies accepted from `0x10` or broadcast `0x7F` |
| Model ID | `00 00 00 55` |
| Command | `0x12` DT1 (data set / write), `0x11` RQ1 (data request / read) |
| Checksum | `(128 - (Σ addr+data bytes) % 128) & 0x7F` (Roland standard) |

A read is RQ1 → the device replies with a DT1 carrying the current value at that
address. The VE-500 does **not** echo DT1 writes.

## Addresses

Internal addresses are a packed 28-bit integer; on the wire each of the 4 bytes
carries 7 bits. `sevenBitize` spreads internal→wire, `nibbleAddr` is the inverse
(used to parse a reply's address). See `src/shared/address.ts`.

```
sevenBitize(a) = ((a & 0x0fe00000)<<3) | ((a & 0x001fc000)<<2) | ((a & 0x00003f80)<<1) | (a & 0x7f)
```

### Memory map (regions)

| Region | Internal base | Notes |
|---|---|---|
| Setup | `0x00000000` | editor/global setup |
| System | `0x02000000` | global: MIDI, USB, tuner, preference, input + input-EQ |
| **Temporary** (active patch) | `0x04000000` | the LIVE edit buffer, `set_param`/`get_param` target this |
| UserPatch(n) n=1..99 | `0x04040000 + 0x40000·(n-1)` | each reuses the Temporary layout |

### Active-patch section bases (relative to `0x04000000`)

`PatchCommon`(name) `0x0000` · `BEND` `0x0800` · **Enhancer** `0x1000` · **Pitch
Correct** `0x1800` · LeadFX `0x2800` · **Harmony 1/2/3** `0x3800/0x4800/0x5800`
(+MIDI subblocks) · **Vocoder** `0x6800` · UserInterval 1-4 `0x7000..0x8800` ·
**FX1-4** `0x9000/0x9800/0xA000/0xA800` (0x88 each, 20 types) · **REV1/REV2**
`0xB000/0xB800` · **LOOP** `0xC000` · KEY `0xC800` · **MASTER** `0xD800` · CTL
`0x10000` · **ASSIGN 1-8** `0x11000..0x14800`.

The full per-parameter address/range table is generated into
`src/ve-500/catalog.generated.ts` (873 settable params + the 16-char patch name)
by `scripts/generate-ve500-catalog.ts`, which evaluates the editor's
`address_map.js` directly.

## Value packing (`src/shared/packValue.ts`)

| `size` | Wire | Encoding |
|---|---|---|
| `INTEGER1x1..1x7` | 1 byte | `(value + ofs) & 0x7F` (N significant bits) |
| `INTEGER2x4 / 3x4 / 4x4 / 6x4` | 2/3/4/6 bytes | value split into big-endian 4-bit nibbles, one per byte |
| `PADDING \| n` | n bytes | one byte repeated (reserved fields) |
| raw count (e.g. 16) | n bytes | ASCII, space-padded, `charCode & 0x7F` (patch name) |

`ofs` is a signed-value bias (display = wire − ofs); all VE-500 params currently
have `ofs = 0`.

## Patch recall

**BARE Program Change** (NO Bank Select): PC 0..98 → user memory U01..U99.
Hardware-confirmed 2026-06-28: a Bank Select (CC0/CC32) *prepended* to the PC
makes the VE-500 **ignore** the recall, so none is sent. Requires `PC IN = ON`
and `RX CH = OMNI`/`Ch.1` on the device. Preset (P01..P50) recall uses a
different bank whose select values are **not yet decoded**, gated, not guessed.

## Golden anchor

`enhancer.enhance = 50` on the active patch
(addr `0x04001001`):
`F0 41 10 00 00 00 55 12 20 00 20 01 32 0D F7`.

## Status

- **Hardware-confirmed (2026-06-28, maintainer's unit):** `set_param` /
  `set_params` / `get_param` / `get_params` (RQ1→DT1 round-trip) / `set_bypass` /
  `switch_preset` for user memories. Reused unified verbs; no device-specific tools.
- **Enum/type/mode/voice selectors carry panel labels** (220 params), joined from
  the editor option tables (`option-tbl.js`) in `scripts/generate-ve500-catalog.ts`,
  validated by exact length match. They accept/echo the label by name (e.g. FX type
  "Chorus", reverb "Hall", harmony voice "+3RD", EQ gain "+6dB"). `apply_preset`
  builds a whole patch from these (hardware-confirmed).
- **`save_preset` (store the active edit buffer to a USER memory) hardware-confirmed
  (2026-07-08):** a bare store command (DT1 `0x7F000104`) did not persist, so
  `save_preset` first sends the editor's **Editor Communication Mode ON** handshake
  (which gates the device's command register), then the store, then waits for the
  device's store-ack echo. A set + save + flash-reload round-trip persisted on the
  unit. The 16-char ASCII patch NAME is set as part of `save_preset(location, name)`.
- Not yet decoded (deferred): factory preset (P01–P50) recall bank mapping (gated),
  whole-patch `get_preset`, and the global SYSTEM params (input/mic/EQ, base
  `0x02000000`, out of the per-patch walk).
