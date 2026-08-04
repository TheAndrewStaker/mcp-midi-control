# Helping with the Fractal AX8

<!-- contribution-meta
device_id: ax8
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's floor-unit multi-effects pedalboard: the Axe-Fx II engine in a
different chassis, not a new protocol. The editor app is **AX8-Edit**, and
**Fractal-Bot** handles transfers.

The AX8 reuses the **same gen-2 wire codec** as the Axe-Fx II XL+, which this
project hardware-verifies on the maintainer's own unit
(`packages/fractal-gen2/src/configs/ax8.ts`,
`packages/fractal-gen2/src/configs/xl-plus.ts`). It differs by model byte
(`0x08`), by a reduced block roster, and by preset count.

Shape, cited from the AX8 Owner's Manual in the config's own header: a four-row
by twelve-column grid, eight scenes per preset, X and Y channels, and 512
presets across 64 banks.

The block roster is **reduced to single-instance-only** on several groups: no
Amp 2, no Cab 2, no Reverb 2, and others. Addressing an unavailable block or
instance refuses with a clear message rather than silently building a frame the
device would never answer.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| Model byte `0x08` | hardware-unverified | The Fractal Audio wiki's SysEx page, plus an independently-surfaced AX8 capture whose checksum byte matches this codec's own formula exactly, which is self-validating |
| Grid shape, preset count, scene count | hardware-unverified | Cited from the AX8 Owner's Manual |
| `set_param` / `set_params`, `get_param` / `get_params` | hardware-unverified | Shares the gen-2 codec that is hardware-confirmed on the Axe-Fx II XL+. Every frame is correctly model-byte-addressed |
| `set_block`, `set_bypass` | hardware-unverified | Same |
| `switch_preset`, `switch_scene`, `save_preset`, `scan_locations` | hardware-unverified | Same |
| `get_preset`, `export_preset`, `import_preset` | hardware-unverified | Same |
| `apply_preset` / `apply_setlist` | hardware-unverified | The multi-step build pipeline is parameterized by model byte, so every frame it emits carries `0x08`. Never run against real AX8 hardware |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen2/src/configs/ax8.ts`, and preflight fails if
the two disagree.

## Confirmed on hardware

Nothing yet. This project owns no AX8.

The whole surface above is evidence-backed rather than guessed: the model byte
comes from a published wiki page and is corroborated by a capture that
self-validates against this codec's checksum formula, and the codec itself is
hardware-confirmed on the sibling XL+. See [../EVIDENCE.md](../EVIDENCE.md).
What is missing is one owner round-trip, and any of the asks below provides it.

## Blocked, and on what

Nothing on the AX8 is refused for an undecoded wire shape. The AX8 shares the
Axe-Fx II codec, so there is no new wire shape to capture at all: no captures
page exists for this device on purpose.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Everything above | One owner round-trip on real AX8 hardware. Not a decode gap | SESSION-1 through SESSION-4 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** AX8-Edit and Fractal-Bot hold the USB port. Quit them
  fully before driving the server. On Windows check the system tray.
- **Port matching.** The server matches this device on an AX8 pattern,
  registered ahead of the Axe-Fx II's broader pattern. The two cannot actually
  collide, but SESSION-1 confirms the match on your unit anyway.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  holds the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Build a small preset in one step
**Tier: SESSION | ~5 minutes | writes to the working buffer, nothing is saved | unlocks: `apply_preset`, placement, cabling, param writes and bypass, in one pass**

**The single highest-value AX8 test.** It exercises grid placement, cabling,
parameter writes, bypass and the safety output mute together.

With the AX8 connected and AX8-Edit quit:

> "Build me a clean amp and reverb preset."

Expect the server to clear the working buffer's grid, place the blocks on a row,
cable them, set parameters and land audible.

Report three things:

1. Did sound come out?
2. Did the blocks appear on the grid? Check the front panel, or reload in
   AX8-Edit afterwards.
3. Paste any errors verbatim.

Nothing is saved. Switching presets discards the working buffer.

### SESSION-2: What does the server see?
**Tier: SESSION | ~2 minutes | read-only | unlocks: port matching and reported shape**

> "What can you see about my AX8?"

Paste the response. This confirms the port name the server matched and the
grid, preset and scene shape it reports. Both come from documentation rather
than from a device, so a mismatch here is a real finding.

### SESSION-3: Read the active preset
**Tier: SESSION | ~3 minutes | read-only | unlocks: `get_preset`**

> "What's loaded on my AX8 right now?"

Expect the preset name, the placed blocks with their grid positions, and
per-block bypass state. Compare to the front panel.

**A wrong block name, grid position or bypass state is the single highest-value
bug to report**, since this is the first hardware exercise of the AX8 read path.

### SESSION-4: Confirm the reduced block roster refuses cleanly
**Tier: SESSION | ~2 minutes | nothing reaches the device if it works | unlocks: confidence in the roster filter**

> "Can I place a second Amp block?"

The server should explain that the AX8 has no second Amp instance and refuse
cleanly, rather than building a frame the device would never answer. If it
instead tries and reports success, that is a bug worth reporting immediately.

### SESSION-5: Read and write one parameter
**Tier: SESSION | ~3 minutes | writes to the working buffer | unlocks: `set_param` and `get_param`**

> "Read the input drive on my amp block."

then

> "Set it to 6."

Confirm the read matches the panel, and that the write's audible and visible
effect matches what you asked for. Gen-2 parameter writes are fire and forget on
the wire with no device acknowledgement, so your eyes and ears are the
verification.

### PROBE-1: Run the harvest sweep
**Tier: PROBE | ~2 to 4 minutes | read-only by construction | unlocks: device-resident rosters, ranges and label tables**

One command that asks the device every "describe yourself" question and writes
one JSON file. Read-only by construction: a mechanical gate checks every
outgoing message against a read-only whitelist before it reaches the wire, so a
write cannot leave the program even through a bug.

Full instructions, including the running-editor check it performs at startup:
[../tools/harvest-script.md](../tools/harvest-script.md).

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- AX8 firmware version,
- operating system,
- the loaded preset,
- whether AX8-Edit was open at the same time,
- what the front panel did.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

The AX8 shares the gen-2 codec with the Axe-Fx II XL+, so a decode confirmed
here also applies to [axe-fx-ii.md](axe-fx-ii.md), and the other way round.
