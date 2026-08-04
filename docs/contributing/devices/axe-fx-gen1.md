# Helping with the Fractal Axe-Fx Standard and Ultra

<!-- contribution-meta
device_id: axe-fx-gen1
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's original rackmount processors, the Axe-Fx Standard and the
Axe-Fx Ultra. This page covers both; they share one wire protocol and one
descriptor (`packages/fractal-gen1/src/descriptor.ts`). The era's editor app is
gen-1 **Axe-Edit**, and **Fractal-Bot** handles transfers.

These are not on the modern codec. Gen-1 has its **own** nibble-split codec:
eight-bit fields split into two low-nibble-first bytes, function `0x02`, a
trailing query or set flag, and no checksum. It is not the Axe-Fx II's
septet-packed form and it is not the modern family's sub-action form. This
hardware predates scenes and X or Y channels, so scene, channel and save tools
are deliberately absent rather than gated.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `set_param` / `set_params` | hardware-unverified | 922 parameters across 35 blocks, decoded byte-exactly from the published gen-1 SysEx parameter-set document and its 0 to 255 conversion table |
| `get_param` / `get_params` | hardware-unverified | Function `0x02` with the set flag cleared returns the live value plus the device's own display label. Decoded from the fuller published gen-1 specification |
| `get_preset` | hardware-unverified, partial by design | The patch dump's spec-pinned subset: preset name, the four-by-twelve effect-grid layout, and the source flag. The dump's roughly 1790-byte parameter region is explicitly undetermined in the spec and is surfaced honestly as a byte count rather than guessed |
| `switch_preset` | hardware-unverified | Standard MIDI Program Change |
| `get_preset` for bank C, presets 256 and up | gated | The request byte for the high bank is left open in the spec |
| `apply_preset`, block placement, `save_preset` | gated | The structural wire messages are not in the published spec at all |
| Scenes, channels | not applicable | The hardware predates both |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen1/src/descriptor.ts`, and preflight fails if
the two disagree.

Everything here is decoded from a published specification, read byte for byte.
Nothing has been confirmed on real gen-1 hardware, because this project owns
none.

## Confirmed on hardware

Nothing yet.

That is not the same as nothing working. The spec is a strong-evidence source
and the whole surface above ships on the strength of it. See
[../EVIDENCE.md](../EVIDENCE.md). The asks below convert that into
confirmations, and the first two take about five minutes combined.

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| `apply_preset`, block placement, `save_preset` | The bytes the era's editor sends for structural edits. The spec documents the parameter function and part of the dump, and nothing about structural editing | CAPTURE-2 |
| Per-parameter values inside `get_preset` | The dump's roughly 1790-byte parameter region, which the spec explicitly leaves undetermined | DONATE-1 |
| `get_preset` for bank C | The high-bank request byte, which the spec hedges with an "or'd with unknown value" note | CAPTURE-1 |
| Whether the dump really totals 2060 bytes | The spec hedges even that | DONATE-1 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** Axe-Edit and Fractal-Bot hold the USB or MIDI interface.
  Quit them fully before driving the server. On Windows check the system tray.
  The exception is CAPTURE-2, which wants the editor running.
- **Port naming is itself an open question.** Older hardware can enumerate under
  a name that would route to the wrong codec. That is what REPORT-1 settles, and
  it is the first thing to do.
- **Firmware updates.** Never run a firmware update while the server holds the
  port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### REPORT-1: Tell us your exact port name
**Tier: REPORT | ~2 minutes | nothing is sent to the device | unlocks: correct routing, and everything downstream of it**

Do this before anything else on this page.

The server matches your device by port name to route it to the correct codec. It
looks for an Axe-Fx Standard or Ultra pattern, and registers that pattern ahead
of the Axe-Fx II's broader one for exactly this reason. Older hardware may
enumerate as something like "Axe-Fx MIDI", which would route to the gen-2 codec
and silently produce wrong bytes.

In your MCP host:

> "List the available MIDI ports."

Paste the **full** output, not just the line you think matters. Your exact port
name is the only thing needed to confirm or fix the routing before you try
anything else.

### DONATE-1: Two preset exports with one parameter changed between them
**Tier: DONATE | ~5 minutes | no capture tools | unlocks: per-parameter values inside `get_preset`**

The highest-value ask that needs no capture tooling, and it finishes the preset
read.

The published spec pins the dump's header, its twenty-character name, and its
four-by-twelve effect grid, then explicitly leaves the remaining roughly 1790
bytes undetermined. One byte diff with known ground truth pins both a
parameter's offset and its value encoding in a single shot.

1. Export the edit buffer to a `.syx` file, using Fractal-Bot or gen-1 Axe-Edit.
2. Change **exactly one** parameter, for example AMP1 GAIN, and **write down the
   before and after values from the front panel**.
3. Export again to a second `.syx` file.
4. Send both files plus which parameter you moved and its two values.

Weaker but still useful: any single preset `.syx` you already have, plus a note
of a few parameter values you know that preset holds, such as amp type and gain,
and your firmware version.

Either version also settles whether the dump really totals 2060 bytes.

### SESSION-1: Confirm a write, then a read
**Tier: SESSION | ~5 minutes | writes to the working buffer | unlocks: `set_param` and `get_param`**

Pick any parameter you can see on the front panel.

> "Set the amp gain to 7 on my Axe-Fx."

Confirm the front panel moved, and paste the response. Then:

> "What's the amp gain on my Axe-Fx right now?"

Compare the reported value and label to the front panel. If it matches, gen-1
read-back works on your hardware, which has never been confirmed. If it times
out or reports a wrong value, **that is the most valuable report**: paste the
full response and note your firmware version.

### SESSION-2: Read a preset's name and block layout
**Tier: SESSION | ~3 minutes | read-only | unlocks: `get_preset`**

With any preset loaded:

> "What preset is loaded on my Axe-Fx, and what blocks does it have?"

Compare the reported preset **name** and the block list to the front panel's
layout screen.

The response will say per-parameter values are not included. That is expected
and correct: that region of the dump is undecoded and is reported as a byte count
rather than guessed. If the name or the block list is wrong, or the call times
out, paste the full response and your firmware version.

### DONATE-2: Any legacy captures you already have
**Tier: DONATE | ~2 minutes | no device time | unlocks: read-path confirmation**

If you have anything from an old Axe-Edit or Fractal-Bot session, it is still
useful. The wire protocol for these units is fixed, so age does not matter.

- `.pcapng` files from USBPcap or Wireshark
- `.syx` files exported from Fractal-Bot or Axe-Edit
- MIDI Monitor logs from macOS

What we are looking for above all is **device-to-host** traffic, the messages the
hardware sends back. `get_param` is wired from the spec, so one capture of a real
parameter-value response confirms it on hardware.

### CAPTURE-1: A bank C request
**Tier: CAPTURE | ~5 minutes | sniffer required | unlocks: `get_preset` for presets 256 and up**

The spec's high-bank request byte is left open with an "or'd with unknown value"
note, so requests for presets 256 and above currently refuse rather than guess.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

Start recording, then use the era's editor or Fractal-Bot to request a **bank C**
preset, one numbered 256 or higher. Note which one. Stop and send.

Any capture of the era's editor requesting a high-bank preset pins the byte.

### CAPTURE-2: One structural editing session
**Tier: CAPTURE | ~15 minutes | sniffer required | unlocks: `apply_preset`, block placement and save**

**The single highest-value ask on this page.** It converts gen-1 from "tweak the
loaded preset" into full preset authoring.

The executor that builds presets on the other Fractal devices is
device-generic. The only missing piece is the bytes the gen-1 editor sends for
structural edits, and nothing in the published spec covers them.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

With the recorder running and the era's Axe-Edit driving your Standard or Ultra,
do each of these **once, slowly, one at a time**, with a pause between. One
action per capture file is ideal; one file with noted timings works too.

1. **Place a block** into an empty grid cell, for example add a Delay.
2. **Connect two blocks**, drawing the cable.
3. **Remove a block.**
4. **Rename the preset.**
5. **Save** the preset. The same location is fine, as long as it is one you do
   not care about.

That host-to-device traffic **is** the missing protocol. As a bonus, any
device-to-host frames in the same session double as the read-path confirmation
from DONATE-2.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- model, Standard or Ultra,
- firmware version if you know it,
- your exact USB or MIDI port name from REPORT-1,
- operating system,
- whether Axe-Edit or Fractal-Bot was open at the same time.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

Gen-1 shares no codec with any other device here, so evidence from this page
does not transfer to another page and vice versa.
