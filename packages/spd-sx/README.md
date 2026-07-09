# @mcp-midi-control/spd-sx

Roland SPD-SX support for the MCP MIDI Control server. The SPD-SX exposes
**two independent surfaces** depending on its `USB MODE`, and this package
implements both:

| USB MODE | Surface | How |
|---|---|---|
| **AUDIO/MIDI** | Kit recall + pad triggers | MIDI surface (`switch_preset`, `apply_pattern` live-stream). The unit is a MIDI sound module. |
| **WAVE MGR** | Read + author kits and the wave pool | Storage surface (the unit mounts as a USB drive; its `.spd` files are the kit/wave format). |

It is **one hybrid-transport descriptor** (`transport: { kind: 'hybrid' }`):
the dispatcher's `openCtx` resolves the live surface per call: drive mounted →
storage, else a MIDI port → MIDI. There are **no device-specific tools**; both
surfaces are driven by the unified verb set, and a verb invoked in the wrong USB
mode returns `capability_not_supported` naming the mode to switch to. The two
modes are mutually exclusive on the hardware, so a session uses one or the other.

## Storage transport (WAVE MGR mode)

In WAVE MGR mode the SPD-SX is plain USB mass storage: a mounted drive with a
`Roland\SPD-SX\` tree of XML `.spd` config files (kits, per-wave params) and
plain 44.1 kHz / 16-bit WAVs. There is no MIDI involved. This is **not** the
project's MIDI dispatcher; the storage tools resolve the mounted drive
(`storage/discovery.ts`) and operate on the filesystem.

The format was decoded byte-exact from device snapshots and is
**hardware-confirmed**: a Python pipeline (`scripts/spdsx/*.py`) built kits that
play on the device after a power-cycle. This package is a byte-faithful
TypeScript port of that pipeline, proven against the same snapshot corpus by
`scripts/verify-spdsx.ts`.

### Unified verbs (WAVE MGR mode)

A kit IS a stored preset addressed by location (kit 1..100), so the SPD-SX reuses
the unified surface rather than device-specific tools:

- `scan_locations(from, to)`: list kits (name + which are empty) over a range.
- `get_preset(location)`: one kit's full pad→wave map.
- `list_samples`: the wave pool (index + name); kits reference waves by index.
- `export_preset(location)`: back up one kit's `.spd` to a file (an empty kit reports `empty`).
- `upload_sample`, **step 1**: append a WAV to the pool (omit `slot`; append-only), returns its index.
- `author_kit(location, name, pads)`, **step 2**: write a kit mapping waves (by index or name) to pads.

Building a kit is two explicit steps: import the WAVs (`upload_sample`), then
author a kit (`author_kit`) that references them by index or name.

### Requirements + gotchas

- **WAVs are normalized on import.** `upload_sample` accepts any uncompressed
  PCM/float WAV (any sample rate, 8/16/24/32-bit int or 32-bit float, mono or
  stereo) and resamples + requantizes to the device's 44.1 kHz / 16-bit,
  **preserving channel count** (the result reports `converted:true`). A stray
  metadata chunk is stripped (the "acked but silent" trap). The resampler is
  linear (fine for drum one-shots); for full-band tonal material a higher-quality
  pre-convert (`bouncer spdsx`) is better.
- **Local files only.** The `file` path is read by the server, so it must be on
  the machine running the server (a local disk path), not a chat-sandbox file.
- **Duplicate warnings (non-blocking).** `upload_sample` warns when the incoming
  audio is BYTE-IDENTICAL to an existing pool wave (it still appends, since the
  pool is append-only; reference the existing index instead) or when another wave
  already has the same name (a softer heads-up; names are not unique). It catches
  exact re-uploads only, not acoustically-similar re-encodes.
- **Windows needs the Roland SPD-SX driver** (separate from Wave Manager); use a
  direct USB-2.0 port, not a hub. macOS mounts class-compliant at
  `/Volumes/SPD-SX` with no driver.
- **Power-cycle the unit** after writing to pick up directly-written files.
- **Append-only.** Wave import never renumbers/overwrites an existing wave; kit
  authoring refuses to overwrite an occupied kit without `confirm_overwrite`
  (which backs the old kit up first).
- Override drive discovery with the `MCP_SPDSX_ROOT` env var (point it at the
  `...\Roland\SPD-SX` folder).

### Layout

```
src/
  descriptor.ts        # hybrid descriptor: MIDI surface (kit recall + pad triggers)
                       #   + storage surface (reader/writer wrapping storage/*)
  codec/               # pure .spd encoders/parsers + canonical WAV (byte-exact)
    kitXml.ts  verifyKit.ts  wavePrm.ts  wav.ts
  storage/             # filesystem transport
    discovery.ts  waveStore.ts  inventory.ts  authorKit.ts  backup.ts
```

The licence boundary: `bouncer` is GPLv3 and is never imported here (this
package is Apache-2.0). The MCP operates on already-spec WAVs; conversion stays
in `bouncer`.

The storage codec and transport are byte-exact against the device's own `.spd`
and WAV files, ported from a hardware-confirmed Python pipeline; the decode and
design detail live alongside the code in `src/codec/` and `src/storage/`.
