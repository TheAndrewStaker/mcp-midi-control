# Helping with the Fractal AM4

<!-- contribution-meta
device_id: am4
support_tier: verified
transport: midi
preset_class: layout
owned_by_maintainer: yes
-->

## Device

Fractal Audio's compact amp modeler. Its chain is a **serial four-slot line**,
not a grid: slot 1 through slot 4, each holding one block. Presets carry four
scenes, blocks carry A to D channels, and presets live at locations A01 through
Z04, 104 in total. The editor app is **AM4-Edit**.

The AM4 is the maintainer's own unit and the deepest-supported device in the
project.

Terminology on this page follows Fractal's own words, because one of them means
the opposite of casual usage: a **location** is where a preset is stored, A01 to
Z04. A **slot** is a position in the signal chain, 1 to 4. A preset is never
stored in a slot.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `set_param` / `set_params` | confirmed | Hardware-verified on the maintainer's unit. Capture-cited decodes live in the codec package at `packages/fractal-midi/docs/devices/am4/SYSEX-MAP.md` |
| `get_param` / `get_params` | confirmed | Same. The atomic read primitive returns a per-block chunk, hardware-validated across 17 audio blocks (`packages/am4/src/descriptor.ts`, the `atomic_read` note) |
| `set_block`, `set_bypass` | confirmed | Same |
| `switch_preset`, `switch_scene`, `save_preset` | confirmed | Same |
| `apply_preset` | confirmed | Same |
| `get_preset` on the active working buffer | confirmed | A full four-slot snapshot in roughly 250 ms, round-tripping through `get_param` byte-exactly |
| `get_preset` on a STORED location | hardware-unverified | The preset container decode is self-validating offline against the device's own CRC across all 104 factory presets. The live stored-dump request has not been confirmed end to end through the reader |
| Per-parameter values inside a stored `get_preset` | gated | Reported as labelled-omitted rather than guessed. The container body's field map is undecoded |
| `export_preset` / `import_preset` | confirmed | Same self-validating container |

Support tier: `verified`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/am4/src/descriptor.ts`, and preflight fails if the two
disagree.

## Confirmed on hardware

- Every live operation: parameter set and read, block placement, bypass, preset
  and scene switching, save, and whole-preset build and read, on the
  maintainer's unit.
- The atomic per-block read, validated across 17 audio blocks.
- Preset export and import, against a container that validates against the
  device's own CRC.

**Please do not re-run these.**

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Per-parameter values inside a stored-location `get_preset` | The preset container body's field map. The container itself is decoded and CRC-validated; where each parameter sits inside the body is not | Nothing a contributor can send today. This is offline decode work |
| Reading an INACTIVE scene's state | Not possible on this device. The AM4 only reports the active scene | Nothing can close it |
| Confirming a write to an UNPLACED block | The device accepts the frame and nothing observable happens, so a bad address cannot be distinguished from a successful write | Nothing can close it |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** AM4-Edit holds the USB port. Quit it fully before
  driving the server. On Windows check the system tray.
- **AM4-Edit is not ground truth.** It caches UI state: a freshly placed Volume
  block once showed 10.00 in the editor while the device was holding 0.00. When
  the editor and the front panel disagree, the front panel wins. Reload the
  preset in the editor to force a fresh read.
- **The AM4 USB driver must be installed** before any MIDI communication. It
  comes from Fractal's AM4 downloads page.
- **Firmware updates.** Never run a firmware update while the server holds the
  port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Confirm a stored-location preset read
**Tier: SESSION | ~3 minutes | read-only | unlocks: `get_preset` on a stored location**

The one AM4 capability that is decoded and shipping but has not been confirmed
end to end through the reader. The container decode is self-validating offline
across all 104 factory presets; what is unconfirmed is the **live request**
round-tripping through this server.

With the AM4 connected and AM4-Edit quit:

> "What's stored at A05?"

Compare the returned preset name and its four scene names to the front panel.
Any location works; A05 is just an example.

Per-parameter values will be reported as omitted with a label saying so. That is
expected and correct.

Report the response and the panel readings. A mismatch in the name or any scene
name is the valuable outcome.

### PROBE-1: Run the harvest sweep on your firmware
**Tier: PROBE | ~2 to 4 minutes | read-only by construction | unlocks: firmware-specific rosters, ranges and enum spellings**

The catalog was built against the maintainer's firmware. If you are on a
different one, your harvest file records what your unit actually says: model
name spellings, parameter ranges, block layout, and all 104 location names.

Read-only by construction: a mechanical gate checks every outgoing message
against a read-only whitelist before it reaches the wire, and the script refuses
to start if it finds AM4-Edit running.

Full instructions: [../tools/harvest-script.md](../tools/harvest-script.md).

### DONATE-1: Send your AM4-Edit definition cache
**Tier: DONATE | ~2 minutes | no device time | unlocks: cross-firmware dictionary confirmation**

If your AM4-Edit has synced with your device on a firmware other than the one
this project runs, the cache is the cheapest possible cross-check on rosters and
ranges.

Full instructions: [../tools/editor-cache-file.md](../tools/editor-cache-file.md).
For the AM4 the filename starts `effectDefinitions_15_`.

### SESSION-2: Report anything that behaves oddly
**Tier: SESSION | ~5 minutes | depends on what you try | unlocks: bug fixes**

This is a reference device, so the useful contribution is friction rather than
confirmation. A parameter that lands somewhere other than where you asked, a
model name the server does not recognise, an enum spelling that does not match
your firmware, a tool that reports success while the panel does nothing.

The front panel is the ground truth, not AM4-Edit. Say which one you read.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- AM4 firmware version,
- operating system,
- the loaded preset location and name,
- whether AM4-Edit was open at the same time,
- whether you read the front panel or the editor.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

The AM4 has its own codec and shares it with no other device here, so evidence
from this page does not transfer.
