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
| Serial transport, discovery and framing | confirmed on macOS, Linux and Windows | The field tests were macOS and Linux. A community session on firmware 12.00, Windows 11, with Fractal's USB serial driver ran reads, writes, preset and scene switching and a save through the release build |
| `set_block` placement | confirmed | An independent app built on this codec placed blocks on a real FM3 over Linux USB serial. The FM3 needs an extra cell-select frame ahead of the insert, which this server already sends automatically for four-row grids |
| `set_block` / `set_bypass` on the 15 multi-word blocks | **hardware-unverified, newly reachable** | These never resolved before 2026-08-03: the write path matched display names and group codes against the descriptor SLUG, so `graphic_eq`, `parametric_eq`, `gate_expander`, `volume_pan`, `pan_tremolo`, `multitap_delay`, `megatap_delay`, `ten_tap_delay`, `plex_delay`, `ring_modulator`, `multiband_compressor`, `tone_match`, `ir_capture`, `ir_player` and `real_time_analyzer` returned "unknown block" for a block the device really has. The resolver now matches the read path, but none of THESE blocks has been exercised on hardware |
| Grid routing, cable connect and disconnect | confirmed | Same independent field test |
| Per-scene channel select (fn=0x0B) and per-scene bypass | confirmed | A 2026-09-14 macOS session on firmware 12 selected each scene, sent SET_CHANNEL and SET_BYPASS, stored, and read every scene's channel and bypass back from the stored preset. This is the sequence `apply_preset` `scenes[]` and `set_param` `channel` now send; before that fix both silently dropped the channel and the scene map |
| `get_preset` live grid read | hardware-unverified | The four-row grid decode was pinned offline against the field-test capture. Never compared to a real panel |
| Block list in a stored `get_preset` | hardware-unverified | Named by pairing the stored block chain with the grid. Checked offline against two fw 13 captures, where the older size-based naming dropped Delay, Drive and Chorus |
| `save_preset` | confirmed | The same Windows session saved to the loaded location; the state survived switching presets and a full power cycle. Saving to a different location than the loaded one is still unrun on the FM3 |

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
- The Windows serial-driver path, on firmware 12.00: reads, `set_param`, preset
  and scene switching, and `export_preset` (24 exports re-imported cleanly).
- `save_preset` to the loaded location, which survived a power cycle.

**Please do not re-run these.** The core surface is done on macOS, Linux and Windows.

## Blocked, and on what

Nothing on the FM3 is refused for an undecoded wire shape.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Device-true enum NAME rosters wired into the catalog | Not donation-blocked anymore. Device-true display ranges SHIPPED 2026-08-11 from the 2026-06-27 community cache (1831 rows / 39 families, gated by `npm run verify-fm3-ranges`), and that same cache carries the full enum name vocabulary (all 331 amp models named), so mining FM3-true rosters is queued offline engineering work | Engineering (roster mining); DONATE-1 adds fresher-firmware cross-validation |

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
- **Never sweep the Foot Controller's parameter space.** A contributor's own
  script sent read requests to the Foot Controller block (effect id 199) for
  parameter ids 0 to about 2000 on firmware 12.00, and the FM3 froze until it was
  power cycled (presets were intact). This server only reads the catalogued Foot
  Controller parameters, one at a time. Do not do this with raw SysEx.
- **Moving a block clears the source of modifiers that target it.** Clearing a
  grid location and placing the block elsewhere keeps its parameters, channels
  and scene states, but every modifier pointed at it loses its source (Pedal 1
  to Wah, for example). Reassign the modifier on the unit after a move.
- **A new Feedback Return block is silent.** It is placed with its level at 0;
  raise the Return level before judging the result.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  or a probe holds the serial port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

SESSION-1 (anything at all on Windows) and SESSION-3 (confirm a save) are closed
by the Windows session above. The Axe-Fx III and FM9 still need a save
confirmation; see their pages.

### DONATE-1: Send your FM3-Edit definition cache
**Tier: DONATE | ~2 minutes | no device time | unlocks: cross-validation of ranges and enum rosters on your firmware**

The 2026-06-27 community cache already delivered the FM3's device-true display
ranges (shipped, gated by `npm run verify-fm3-ranges`) and carries the full enum
name vocabulary, so the original ask is closed. A cache from YOUR install still
helps: a second cache from a different firmware cross-validates both, which is
exactly how the FM9's fw 11.0 and 12.0 caches caught its amp-roster growth.

Full instructions: [../tools/editor-cache-file.md](../tools/editor-cache-file.md).
For the FM3 the filename starts `effectDefinitions_11_`. Make sure your FM3-Edit
has connected to the device at least once before you grab the file; the linked
page explains how to tell.

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
