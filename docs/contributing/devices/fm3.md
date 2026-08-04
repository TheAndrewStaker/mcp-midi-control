# Helping with the Fractal FM3

<!-- contribution-meta
device_id: fm3
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's compact floor amp modeler and multi-effects unit, on the modern
gen-3 codec shared with the Axe-Fx III, FM9 and VP4
(`packages/fractal-gen3/src/configs/fm3.ts`). Fractal's editor app is
**FM3-Edit**, and **Fractal-Bot** handles preset transfers.

Two shape differences matter for asks on this page:

- The FM3 runs a **four-row, twelve-column grid**. The FM9 and III use a larger
  one. That matters for block placement and for the live grid read.
- **The FM3 is not a USB MIDI device on any operating system.** Over USB its
  control channel is a serial port carrying raw MIDI bytes, and this server
  reaches it that way automatically. The descriptor still declares a `midi`
  transport kind because the serial path is chosen in the connection layer, not
  in the descriptor.

### How the FM3 connects

- **Windows:** install Fractal's **FM3 USB Serial Driver**, which is separate
  from the audio driver and comes in the same download. The FM3 then appears
  under "Ports (COM and LPT)" as "FM3 Communications Port", not in any MIDI port
  list. The server finds it automatically.
- **macOS:** no driver needed. The FM3 enumerates as `/dev/cu.usbmodem...` and
  the server finds it automatically.
- **The serial port is exclusive.** FM3-Edit and Fractal-Bot must be fully quit
  while the server is connected, and the other way round.
- If auto-detection misses it, set `MCP_FM3_SERIAL_PATH`, for example `COM5` or
  `/dev/cu.usbmodemXXXXX`.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `get_param` / `get_params` | confirmed | A community field test on firmware 12.00, macOS, ran the whole read path end to end over the serial transport through this server's own probes |
| `set_param` continuous knobs | confirmed | Same field test |
| `set_param` discrete set-by-name | confirmed | A community session sent frames byte-identical to this server's encoder from the tester's own rig |
| `set_bypass` | confirmed | Same field test |
| `switch_scene`, `switch_preset` | confirmed | Same field test |
| Serial transport, discovery and framing | confirmed on macOS, hardware-unverified on Windows | The field tests were macOS. The Windows serial-driver path is implemented and unconfirmed |
| `set_block` placement | confirmed | An independent app built on this codec placed blocks on a real FM3 over Linux USB serial. The FM3 needs an extra cell-select frame ahead of the insert, which this server already sends automatically for four-row grids |
| `set_block` / `set_bypass` on the 15 multi-word blocks | **hardware-unverified, newly reachable** | These never resolved before 2026-08-03: the write path matched display names and group codes against the descriptor SLUG, so `graphic_eq`, `parametric_eq`, `gate_expander`, `volume_pan`, `pan_tremolo`, `multitap_delay`, `megatap_delay`, `ten_tap_delay`, `plex_delay`, `ring_modulator`, `multiband_compressor`, `tone_match`, `ir_capture`, `ir_player` and `real_time_analyzer` returned "unknown block" for a block the device really has. The resolver now matches the read path, but none of THESE blocks has been exercised on hardware |
| Grid routing, cable connect and disconnect | confirmed | Same independent field test |
| `get_preset` live grid read | hardware-unverified | The four-row grid decode was pinned offline against the field-test capture. Never compared to a real panel |
| `save_preset` | hardware-unverified | The save envelope is unconfirmed on any gen-3 device |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen3/src/configs/fm3.ts`, and preflight fails if
the two disagree.

The FM3 is the most hardware-confirmed member of the gen-3 family for its core
surface.

## Confirmed on hardware

- The USB serial transport, discovery and framing, on macOS.
- The entire read path.
- Continuous `set_param`, `set_bypass`, `switch_scene` and preset switching.
- Discrete set-by-name `set_param`, via byte-identical frames.
- `set_block` placement and grid routing, on Linux USB serial, through an
  independent application built on the same codec.

**Please do not re-run these.** The core surface is done on macOS and Linux.

## Blocked, and on what

Nothing on the FM3 is refused for an undecoded wire shape.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Device-true display ranges, steps, tapers and enum name lists | The FM3 cache copies on hand are small unsynced stubs | DONATE-1 |
| The Windows serial-driver path | No Windows run has happened. Both field tests were macOS, and the third was Linux | SESSION-1 |
| Confirmation of the discrete routing classification | The FM3's type and count selectors were classified as discrete by joining sibling evidence on symbol, not on parameter id, because no FM3 catalog round-trip exists yet | SESSION-2 |
| Named tempo divisions on any gen-3 device | The wire encoding for the TEMPO division select is undecoded | See [axe-fx-iii.md](axe-fx-iii.md) CAPTURE-2 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **The serial port is exclusive, and this is stricter than the MIDI case.**
  FM3-Edit and Fractal-Bot must be fully quit while the server is connected. On
  Windows check the system tray.
- **The harvest script cannot reach an FM3.** It talks MIDI ports directly and
  the FM3 is serial-only over USB. Use the conversational asks below, or send the
  cache file, which is the higher-value contribution anyway.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  or a probe holds the serial port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Anything at all, on Windows
**Tier: SESSION | ~5 minutes | reads first, then one write | unlocks: the Windows serial-driver path**

The single most useful FM3 contribution right now, because it is the only gap
that no amount of decoding can close. Both field tests were macOS and one was
Linux. Nobody has run the Windows serial driver end to end.

Install Fractal's FM3 USB Serial Driver, quit FM3-Edit, and in your MCP host:

> "What can you see about my FM3?"

then

> "What's loaded on my FM3 right now?"

then

> "Set Amp 1 drive to 5.5, then read it back."

Report whether the server found the device at all, what the port looked like,
and whether the front panel moved. **A failure here is as valuable as a
success**, and more so: it tells us the Windows driver path needs work, which is
currently an unknown rather than a known-good.

### DONATE-1: Send your FM3-Edit definition cache
**Tier: DONATE | ~2 minutes | no device time | unlocks: device-true ranges, steps, tapers and every enum name list**

The FM3 catalog still lacks device-true display ranges, and the cache is where
they live. It needs no capture tooling and no hardware time.

Full instructions: [../tools/editor-cache-file.md](../tools/editor-cache-file.md).
For the FM3 the filename starts `effectDefinitions_11_`.

The FM3 copies on hand are small unsynced stubs. Make sure your FM3-Edit has
connected to the device at least once before you grab the file; the linked page
explains how to tell.

### SESSION-2: Compare the live grid read to your panel
**Tier: SESSION | ~5 minutes | read-only | unlocks: `get_preset` live grid read**

The FM3's four-row grid decode was pinned offline against a capture and never
compared to a real panel.

Load a preset with **three or more placed blocks**, then:

> "What's the layout of my current FM3 preset?"

Compare the reported block positions to the FM3-Edit grid or the front panel
layout page. A match flips this read from `hardware-unverified` to `confirmed`.
A mismatch, with a description of what the grid actually looks like, is more
valuable still.

### SESSION-3: Confirm a save
**Tier: SESSION | ~5 minutes | writes and then PERSISTS | unlocks: `save_preset`**

The save envelope is unconfirmed on every gen-3 device. Use a preset location
you do not care about.

> "Save this preset to location 5."

Then switch away and back, and check the preset name at location 5. Report
whether it landed.

### CAPTURE-1: Receive one preset with Fractal-Bot
**Tier: CAPTURE | ~5 minutes | sniffer plus Fractal-Bot | unlocks: frame-count confirmation**

Preset receive is confirmed on the FM9. The FM3 shares the envelope but differs
in frame count, so one receive capture confirms the count is right for this
device.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

1. Start the capture with the FM3 connected.
2. In Fractal-Bot choose **Receive** and grab a single preset from the device.
3. Stop right after it finishes. Send the capture plus device model and
   firmware.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- FM3 firmware version,
- operating system, and on Windows whether the FM3 USB Serial Driver is
  installed,
- the loaded preset, number and name,
- FM3-Edit version,
- whether FM3-Edit or Fractal-Bot was open at the same time,
- for a SESSION ask, what the front panel did.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**, or reduce it to a one-line closed
   note if a sibling gen-3 device still needs it.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

Because the gen-3 family shares one codec, check whether the same evidence
closes a row on [axe-fx-iii.md](axe-fx-iii.md), [fm9.md](fm9.md) or
[vp4.md](vp4.md) too.
