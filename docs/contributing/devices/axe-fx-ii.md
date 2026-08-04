# Helping with the Fractal Axe-Fx II

<!-- contribution-meta
device_id: axe-fx-ii
support_tier: verified
transport: midi
preset_class: layout
owned_by_maintainer: yes
-->

## Device

Fractal Audio's second-generation rackmount amp modeler and multi-effects
processor. Blocks sit on a four-row by twelve-column grid, presets carry eight
scenes, and blocks carry **X and Y** channels rather than the AM4's A to D. The
editor app is **Axe-Edit**, and **Fractal-Bot** handles transfers.

The Axe-Fx II family spans several model bytes. This descriptor targets the
**XL+**, model byte `0x07`, which is the maintainer's own unit and the
hardware-verified anchor for the whole gen-2 codec
(`packages/fractal-gen2/src/configs/xl-plus.ts`). The AX8 is a separate config
on the same codec; see [ax8.md](ax8.md).

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `set_param` / `set_params` | confirmed | Hardware-verified on the maintainer's Quantum 8.02 XL+ unit |
| `get_param` / `get_params` | confirmed | Same |
| `set_block`, `set_bypass` | confirmed | Same |
| `switch_preset`, `switch_scene`, `save_preset` | confirmed | Same |
| `save_preset` overwrite pre-check | confirmed (both directions, 2026-08-03) | This device can read which preset is ACTIVE but has no decoded read for the name stored at an arbitrary location (`buildGetPresetName` takes no location argument, and `scan_locations` here works by navigating, which would discard the buffer being saved). Since 2026-08-03 a save to a NON-ACTIVE location REFUSES until the caller passes `confirm_overwrite: true`, and says plainly that no occupancy check was possible rather than implying one happened. Saving back to the location being edited is unaffected. A real occupancy read is an open gen-2 decode task. **Hardware-confirmed 2026-08-03/04** on a live XL+, including against the FRONT PANEL: the server's active-slot read agreed with the panel (server 5, panel `005`), the unconfirmed save to a non-active slot refused, and the panel read `005` both before and after it, so the refusal is inert at the device rather than only in the response. `confirm_overwrite: true` was then acked by the device |
| `apply_preset`, `get_preset` | confirmed | Same |
| `export_preset` / `import_preset` | confirmed | Same |

Support tier: `verified`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen2/src/configs/xl-plus.ts`, and preflight
fails if the two disagree.

Every operation in this descriptor is hardware-confirmed. Capture-cited decodes
live in the codec package's per-device protocol map at
`packages/fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md`.

## Confirmed on hardware

- Every shipped operation: parameter set and read, block placement, bypass,
  preset and scene switching, save, whole-preset build, whole-preset read, and
  preset export and import. All on a Quantum 8.02 XL+.

- The `save_preset` overwrite gate, both directions, 2026-08-04: a save to a
  non-active location refuses and sends nothing (front panel unchanged across
  the refusal), and `confirm_overwrite: true` is acked. The server's
  active-preset read was checked against the front panel in the same run.

**Please do not re-run these.** The XL+ is the reference device for this codec.

## Blocked, and on what

Nothing is gated on the XL+. Every write ships un-gated.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Model bytes other than `0x07` | The family spans several model bytes, from the Mark I and II up to the XL+. Only the XL+ is on hand and only its byte is exercised | REPORT-1 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** Axe-Edit and Fractal-Bot hold the USB port. Quit them
  fully before driving the server. On Windows check the system tray.
- **Channels are X and Y here**, not A, B, C, D. That is the AM4's model. If a
  tool or a page says A or B for this device, that is a bug.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  holds the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### REPORT-1: If you own a Mark I, Mark II or non-plus XL, tell us
**Tier: REPORT | ~2 minutes | nothing is sent to the device | unlocks: family coverage beyond the XL+**

The codec here is exercised only against model byte `0x07`. The earlier family
members use different model bytes, and nobody has confirmed that the descriptor
routes correctly to them.

In your MCP host:

> "List the available MIDI ports."

then

> "What can you see about my Axe-Fx?"

Paste both, and say which model you have. If the server identifies it as an XL+
when it is not, that is the finding: the port matcher is broad on purpose and
the model byte is fixed in this config.

### SESSION-1: Report anything that behaves oddly
**Tier: SESSION | ~5 minutes | depends on what you try | unlocks: bug fixes**

This device is the reference unit, so the useful contribution here is not
confirmation, it is friction. Anything that surprises you is worth an issue: a
tool that reports success while the panel does nothing, a parameter that lands
somewhere other than where you asked, a block name the server does not
recognise, an enum whose spelling does not match your firmware.

The front panel is the ground truth. Axe-Edit caches UI state and can show a
value the device is not holding, so when the two disagree, believe the panel and
say so in the report.

### PROBE-1: Run the harvest sweep on your firmware
**Tier: PROBE | ~2 to 4 minutes | read-only by construction | unlocks: firmware-specific rosters, ranges and enum spellings**

The catalog was built against one firmware. Enum spellings and parameter ranges
move between firmware versions, and the harvest file records exactly what your
unit says.

The Axe-Fx II sweep is the longest of any device here, because it walks every
parameter of every placed block, and it also pulls the device's own enum label
tables. It is read-only by construction: a mechanical gate checks every outgoing
message against a read-only whitelist before it reaches the wire.

Full instructions: [../tools/harvest-script.md](../tools/harvest-script.md).

### DONATE-1: Send a preset export from an unusual firmware
**Tier: DONATE | ~3 minutes | no device time | unlocks: cross-firmware container confidence**

If you are running a firmware other than Quantum 8.02, a single preset `.syx`
exported from Fractal-Bot tells us whether the preset container decode holds
across firmware versions.

Send the file plus your exact firmware version and the preset's name as the
front panel shows it, so the decoded name can be checked against ground truth.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- exact model, Mark I, Mark II, XL or XL+,
- firmware version,
- operating system,
- the loaded preset, number and name,
- whether Axe-Edit was open at the same time.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

The AX8 shares this codec, so a decode confirmed here also applies to
[ax8.md](ax8.md).
