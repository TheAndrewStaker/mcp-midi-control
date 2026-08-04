# Helping with the Fractal Axe-Fx III

<!-- contribution-meta
device_id: axe-fx-iii
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's flagship rackmount amp modeler and multi-effects processor.
Blocks sit on a grid, presets carry scenes and per-block channels. Fractal's
editor app is **Axe-Edit III**, and **Fractal-Bot** handles preset transfers.

The III is the **byte-identity anchor** for the modern Fractal family: the III,
FM3, FM9 and VP4 share one codec, differing by model byte, grid and scene shape,
and a device-specific parameter catalog
(`packages/fractal-gen3/src/configs/axe-fx-iii.ts`,
`packages/fractal-gen3/src/factory.ts`). Confirming something on the III raises
confidence family-wide, which is why III evidence is worth more than its own
device.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `get_param` / `get_params` | confirmed | A community owner test on firmware 25.04 read back a value matching the front panel |
| `set_param` continuous knobs | confirmed | The same owner test set amp gain on channel A with a device echo. A later community round-trip then exercised SET then GET across the entire III catalog on hardware |
| `set_param` discrete set-by-name | hardware-unverified | The discrete wire form is byte-exact against real captures and rides a different sub-action from the continuous drag. Type and model selectors were routed to that discrete form using the catalog round-trip as the oracle (`packages/fractal-gen3/src/configs/axe-fx-iii.ts`) |
| `get_preset`, including the live grid read | hardware-unverified | Decoded from the shared gen-3 grid frame |
| `set_block` placement | hardware-unverified | Placement is hardware-confirmed on the sibling FM9 and FM3. Not yet on the III |
| `set_block` / `set_bypass` on the 15 multi-word blocks | **hardware-unverified, newly reachable** | These never resolved before 2026-08-03: the write path matched display names and group codes against the descriptor SLUG, so `graphic_eq`, `parametric_eq`, `gate_expander`, `volume_pan`, `pan_tremolo`, `multitap_delay`, `megatap_delay`, `ten_tap_delay`, `plex_delay`, `ring_modulator`, `multiband_compressor`, `tone_match`, `ir_capture`, `ir_player` and `real_time_analyzer` returned "unknown block" for a block the device really has. Effect IDs come from the v1.4 spec table and the frame is unchanged, but none of THESE blocks has been placed or bypassed on hardware |
| `switch_scene`, `switch_preset` | hardware-unverified | Shared gen-3 wire, confirmed on siblings |
| `save_preset` | hardware-unverified | The save envelope is unconfirmed on any gen-3 device |
| `export_preset` / `import_preset` | hardware-unverified | The preset container is self-validating against the device's own CRC |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen3/src/configs/axe-fx-iii.ts`, and preflight
fails if the two disagree.

## Confirmed on hardware

- `get_param` and continuous `set_param`: confirmed on firmware 25.04 by a
  community owner. Amp gain on channel A, device echo, read-back matching the
  front panel.
- A catalog-wide SET then GET round-trip on hardware, which confirmed the read
  and continuous-write paths across the whole III parameter catalog and produced
  the oracle used to correct type and model selectors to discrete routing.

**Please do not re-run these.** Reads and continuous writes are done on the III.

## Blocked, and on what

Nothing on the III is blocked in the strict sense: no capability is refused for
an undecoded wire shape. Everything above either is confirmed or is
evidence-backed and shipping while it waits for a key-press.

One genuine data gap remains, and it is not a wire shape:

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Device-true display ranges, steps, tapers and enum name lists | The III cache copies on hand are unsynced placeholder stubs: one has around 1737 records and zero enum vocabulary entries | DONATE-1 |
| Exact `ms` and `Hz` landing for log-taper knobs | Whether the normalized float a continuous SET carries is normalized in value space or in knob-position space. The two readings differ a lot mid-range | CAPTURE-1 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** Axe-Edit III and Fractal-Bot hold the USB port. Quit them
  fully before running a probe or driving the server, and quit the MCP host
  before opening them again. On Windows check the system tray. The exception is
  CAPTURE-1, which wants the editor running and this project's server quit.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  or a probe holds the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### DONATE-1: Send your Axe-Edit III definition cache
**Tier: DONATE | ~2 minutes | no device time | unlocks: device-true ranges, steps, tapers and every enum name list**

The single biggest III unlock, and it needs zero tooling and no hardware time.

Full instructions, including where the file lives and how to tell a real cache
from a placeholder: [../tools/editor-cache-file.md](../tools/editor-cache-file.md).
For the III the filename starts `effectDefinitions_10_`.

Why it matters here specifically: the III copies on hand are unsynced stubs with
no enum vocabulary at all. A cache from an install that has **synced to your
device** is the device's own dictionary. It mechanically confirms the discrete
routing correction that currently rests on an indirect oracle, adds every enum's
name list, and pins device-true display ranges. The same kind of file corrected
around 351 parameters on the FM9.

### SESSION-1: Run the write-verify probe
**Tier: SESSION | ~5 minutes | writes to the working buffer, self-restoring | unlocks: discrete set-by-name, `set_bypass`, `switch_scene`, `set_block`**

The fastest way to close every remaining write confirmation except `save_preset`
in one sitting. It sends each shipped write op against the loaded preset and
reads the result back.

Quit Axe-Edit III first, then:

- **Windows release package:** double-click `axefx3-verify.cmd` in the install
  folder.
- **macOS or a source checkout:** `npm run axefx3:verify`.

Load a preset that **has a Reverb block and no Drive block** before you start:
the probe skips the reverb tests if no reverb is placed, and skips the placement
test if a Drive is already there.

Self-restoring: it never saves, it records your active preset number first and
reloads it at the end and on Ctrl-C, which discards every working-buffer change.
It also discards any unsaved edits you had open, so store or abandon those
first.

Send back the JSON it writes, plus a note of anything the front panel did.

### SESSION-2: Confirm a discrete set-by-name write
**Tier: SESSION | ~3 minutes | writes to the working buffer | unlocks: `set_param` discrete**

The conversational form of the one write path still unconfirmed on the III.
Continuous knob writes are already confirmed; changing a **model by name** rides
a different sub-action.

With the III connected and Axe-Edit III quit:

> "Set Amp 1 to a Plexi, then read back what model it is on."

Report whether the model on the front panel changed, and paste both responses.
If it reports success and the panel does not change, paste both anyway. That is
the most valuable outcome.

### SESSION-3: Confirm a save
**Tier: SESSION | ~5 minutes | writes and then PERSISTS | unlocks: `save_preset`**

The save envelope is unconfirmed on every gen-3 device. Use a preset location
you do not care about.

> "Save this preset to location 5."

Then switch away and back, and check the preset name at location 5. Report
whether it landed.

### PROBE-1: Run the read-back probe
**Tier: PROBE | ~5 minutes | read-only | unlocks: read-path confirmation on your firmware**

A read-only diagnostic. It polls your active preset, runs a set of read-only
queries, and writes a JSON file. It never writes and never changes a preset.

Quit Axe-Edit III, then:

- **Windows release package:** double-click `axefx3-probe.cmd`.
- **macOS or a source checkout:** `npm run axefx3:probe`.

Send back `axefx3-probe-output.json`.

If you would rather send everything the device will say about itself in one
sweep, the read-only [harvest script](../tools/harvest-script.md) covers more
ground in one command.

### CAPTURE-1: One log-taper knob sweep with the panel readings
**Tier: CAPTURE | ~10 minutes | sniffer required | unlocks: exact `ms` and `Hz` landing**

One narrow question, and only a capture answers it. A continuous SET carries a
normalized float. For a knob with a log taper, a Reverb or Delay **Time**, or a
Low or High **Cut**, we do not know whether that float is normalized in value
space or in knob-position space. Until it is settled, "set delay time to 500 ms"
may land somewhere else on the panel for log-taper knobs. Linear knobs like amp
Gain are already correct.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

1. Start the capture. Open the editor and pick a Reverb or Delay **Time** knob.
2. Drag it to a LOW value, pause, and **write down the exact number the display
   shows, with its units**, for example `0.30 s`.
3. Drag to a MID value, pause, write down the number.
4. Drag to a HIGH value, pause, write down the number.
5. Keep going to **at least five points across the full range**. More is better.
6. Stop. Send the capture **plus the ordered list of panel readings**.

> **The display readings are the whole point.** The wire floats alone cannot
> reveal the curve. Without the paired numbers the capture cannot be used, and
> that is the most common reason a calibration capture comes back unusable.

A second knob in a different unit, a frequency knob in Hz, in the same recording
roughly doubles the value for one extra minute.

Reload the preset afterwards to revert. Nothing is stored.

### CAPTURE-2: The tempo-division selector
**Tier: CAPTURE | ~3 minutes | sniffer required | unlocks: named tempo divisions**

Named tempo divisions are the one popular request the server cannot send on
gen-3: the wire encoding for the TEMPO division select is undecoded, so a dotted
eighth delay falls back to "set it on the device". The editor can set it, so the
bytes exist.

1. Load a preset with a **Delay** block. Start the capture.
2. In the editor, open the Delay's **TEMPO** control and select, in order, with
   about two second pauses, **writing each one down**: `OFF`, then `1/4`, then
   `1/8 dot`, then `1/2`, then back to the original value.
3. Stop. Send the capture plus the ordered list of what you selected.

A Reverb or modulation block's TEMPO control in the same recording is a free
bonus: it confirms the encoding is block-independent.

### CAPTURE-3: Receive one preset with Fractal-Bot
**Tier: CAPTURE | ~5 minutes | sniffer plus Fractal-Bot | unlocks: frame-count confirmation**

Preset receive is confirmed on the FM9. The III shares the envelope but differs
in frame count, so one receive capture confirms the count is right for this
device.

1. Start the capture with the III connected.
2. In Fractal-Bot choose **Receive** and grab a single preset from the device.
3. Stop right after it finishes. Send the capture plus device model and
   firmware.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- III firmware version,
- operating system,
- the loaded preset, number and name,
- Axe-Edit III version,
- whether the editor was open at the same time,
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
closes a row on [fm3.md](fm3.md), [fm9.md](fm9.md) or [vp4.md](vp4.md) too.
