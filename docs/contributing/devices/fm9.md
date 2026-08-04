# Helping with the Fractal FM9

<!-- contribution-meta
device_id: fm9
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's floor-format amp modeler and multi-effects unit, on the modern
gen-3 codec shared with the Axe-Fx III, FM3 and VP4
(`packages/fractal-gen3/src/configs/fm9.ts`). Blocks sit on a grid; presets
carry scenes and per-block channels. Fractal's editor app is **FM9-Edit**, and
**Fractal-Bot** handles preset transfers.

The FM9 is the **most confirmed** gen-3 device, so most of what a new owner
could test here is already done. The remaining asks are narrow and specific.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `get_param` / `get_params` | confirmed | A community owner test on firmware 11.0, macOS, round-tripped reads through this server, including channel-specific reads and amp-name alias resolution |
| `set_param` continuous knobs | confirmed | The same owner test, acknowledged with the value confirmed on the editor display. A later catalog-wide SET then GET round-trip on hardware confirmed the continuous path across the whole FM9 catalog |
| `set_block` placement | confirmed for single-word blocks | A Windows verify probe placed a block and the device's own status dump listed it. That probe used a block whose slug equals its display name, which is the only kind that used to resolve at all |
| `set_block` / `set_bypass` on the 15 multi-word blocks | **hardware-unverified, newly reachable** | These never resolved before 2026-08-03: the write path matched display names and group codes against the descriptor SLUG, so `graphic_eq`, `parametric_eq`, `gate_expander`, `volume_pan`, `pan_tremolo`, `multitap_delay`, `megatap_delay`, `ten_tap_delay`, `plex_delay`, `ring_modulator`, `multiband_compressor`, `tone_match`, `ir_capture`, `ir_player` and `real_time_analyzer` returned "unknown block" for a block the device really has. The resolver now matches the read path. **The effect IDs come from the v1.4 spec table and the frame is the same wire-confirmed insert, but no one has placed one of THESE blocks on hardware.** Treat as untested |
| `switch_scene` | confirmed | Same probe run |
| Reading a block's current type or model by NAME | confirmed | Wire-confirmed: the device returns its own name string, byte-exact for reverb, amp and drive examples |
| `set_param` discrete set-by-name | hardware-unverified | The discrete wire form is byte-exact against real FM3 and FM9 captures. Type and mode selectors route as discrete ordinals, corrected using the FM9's own editor-cache enum data, which is why only the FM9 changed and the family byte-identity held (`packages/fractal-gen3/src/configs/fm9.ts`) |
| `save_preset` | hardware-unverified | The save envelope is unconfirmed on any gen-3 device |
| `get_preset` live grid read | hardware-unverified | Decoded from the shared gen-3 grid frame and cross-validated against an FM9 capture |
| Live CPU and output meters inside `get_preset` | hardware-unverified | Decoded from the same grid frame, not yet front-panel confirmed |
| `export_preset` / `import_preset` | hardware-unverified | Preset receive is confirmed on this device; the container is self-validating against the device's own CRC |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen3/src/configs/fm9.ts`, and preflight fails if
the two disagree.

## Confirmed on hardware

- Reads, including channel-specific reads and alias resolution: firmware 11.0,
  macOS, community owner.
- Continuous `set_param`: same test, plus a catalog-wide round-trip.
- `set_block` placement and `switch_scene`: a Windows verify probe, with the
  placed block appearing in the device's own status dump.
- Reading a block's current type or model by name.
- Preset receive, the dump path used by `export_preset`.
- Model rosters and parameter ranges are complete and device-true, from a
  community cache file. Set-by-name works across the whole amp space.

**Please do not re-run these.** They are done, and the catalog-wide sweep in
particular does not need repeating.

## Blocked, and on what

Nothing on the FM9 is refused for an undecoded wire shape. What remains is
either a key-press or a data gap.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Exact `ms` and `Hz` landing for log-taper knobs | Whether a continuous SET's normalized float is normalized in value space or knob-position space. The catalog round-trip used raw wire values, so it did not pin the curve | CAPTURE-1 |
| Per-block enum name rosters beyond reverb | The device only emits a model name when a model is actually selected, so the rosters for blocks other than reverb are incomplete | CAPTURE-2 |
| Named tempo divisions on any gen-3 device | The wire encoding for the TEMPO division select is undecoded | See [axe-fx-iii.md](axe-fx-iii.md) CAPTURE-2, which is device-independent |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** FM9-Edit holds the USB port. Quit it fully before running
  a probe or driving the server. On Windows check the system tray. The exception
  is a CAPTURE ask, which wants the editor running and this project's server
  quit.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  or a probe holds the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Confirm a discrete set-by-name write
**Tier: SESSION | ~3 minutes | writes to the working buffer | unlocks: `set_param` discrete**

The one write path still unconfirmed on the FM9. Continuous writes are already
confirmed; changing a **model by name** rides a different sub-action, so the
existing evidence does not carry over.

With the FM9 connected and FM9-Edit quit:

> "Set Amp 1 to a Plexi, then read back what model it is on."

Report whether the model on the front panel changed, and paste both responses.

### SESSION-2: Run the write-verify probe on a preset that has a reverb block
**Tier: SESSION | ~5 minutes | writes to the working buffer, self-restoring | unlocks: discrete set-by-name plus `save_preset` on Windows**

The rigorous form of SESSION-1, and it covers the save path too.

Load a preset that **has a Reverb block** first: the probe skips its reverb
tests if no reverb is placed, which is what a previous run hit.

Quit FM9-Edit, then:

- **Windows release package:** double-click `fm9-verify.cmd` in the install
  folder.
- **macOS or a source checkout:** `npm run fm9:verify`.

Self-restoring: it never saves on its own, and it records your active preset
first and reloads it at the end and on Ctrl-C. That discards any unsaved edits
you had open, so store or abandon those first.

Send back the JSON it writes, plus a note of anything the front panel did.

### SESSION-3: Check the live CPU and output meters
**Tier: SESSION | ~5 minutes | read-only in practice | unlocks: confidence in the meter decode**

The meters inside `get_preset` are decoded and cross-validated against a
capture, but no owner has compared them to the device's own display.

> "How much CPU is my current preset using?"

Compare the reported CPU percentage to the FM9's own CPU meter on its Home or
Layout page. Then, while audio is playing, glance at whether the reported left
and right output levels track the output meters.

Report both comparisons. The device INPUT meter is deliberately not surfaced;
its offset is not portable across the gen-3 family, so do not expect one.

### PROBE-1: Run the read-back probe
**Tier: PROBE | ~5 minutes | read-only | unlocks: read-path confirmation on your firmware**

A read-only diagnostic. It never writes and never changes a preset.

Quit FM9-Edit, then:

- **Windows release package:** double-click `fm9-probe.cmd`.
- **macOS or a source checkout:** `npm run fm9:probe`.

Send back `fm9-probe-output.json`.

For a wider sweep of everything the device will say about itself in one command,
see the read-only [harvest script](../tools/harvest-script.md).

### CAPTURE-1: One log-taper knob sweep with the panel readings
**Tier: CAPTURE | ~10 minutes | sniffer required | unlocks: exact `ms` and `Hz` landing**

Identical in shape to the III's version of this ask, and one capture from either
device answers it for the family. Full steps and the reason it is worth doing:
[axe-fx-iii.md](axe-fx-iii.md), CAPTURE-1.

The short version: sweep one log-taper knob, a Reverb or Delay **Time** or a Low
or High **Cut**, to at least five points across its range, pausing at each, and
**write down the exact number the display shows with its units** at every point.
Send the capture plus the ordered list of readings. Without the paired readings
the capture cannot be used.

### CAPTURE-2: Type-dropdown sweep for a block other than reverb
**Tier: CAPTURE | ~10 minutes | sniffer required | unlocks: per-block enum name rosters**

The wire records the ordinal; a screenshot records the name. Pairing them is
what builds a roster.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

1. Load a preset with the block you are covering placed. Open FM9-Edit.
2. **Before capturing:** open that block's **Model** dropdown and screenshot the
   full list, scrolling slowly until every name is captured. Multiple
   screenshots are fine.
3. Start the capture.
4. With it running, **select** each model **top to bottom**, about two seconds
   apart, in the same order you photographed.
5. Stop. Send the capture **plus all screenshots** together.

> Just opening a dropdown sends nothing. Names only cross the wire when you
> **select** a model. Step through them one at a time. A partial sweep, the top
> thirty or forty, still helps. The two reasons a previous sweep was unusable:
> the dropdown was opened rather than stepped through, and the screenshots were
> omitted so the ordinals had no names to bind to.

Reload the preset afterwards. Nothing is stored.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- FM9 firmware version,
- operating system,
- the loaded preset, number and name,
- FM9-Edit version,
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
closes a row on [axe-fx-iii.md](axe-fx-iii.md), [fm3.md](fm3.md) or
[vp4.md](vp4.md) too.
