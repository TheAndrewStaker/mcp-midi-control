# Testing: FM9

> The FM9 is the most confirmed gen-3 device. A community FM9 owner (firmware 11.0)
> hardware-confirmed reads **and continuous parameter writes** end-to-end through the
> server (2026-06-17): `get_param` + continuous `set_param` acked with the value
> confirmed on the FM9-Edit display, plus channel-specific reads and amp-name alias
> resolution. A follow-up full SET→GET roundtrip across the **entire FM9 parameter
> catalog** on hardware (2026-06-18) confirmed the read/continuous-write paths
> catalog-wide and surfaced the enum-routing fix now shipped (type/mode selectors are
> sent as discrete ordinals, not continuous floats). (Wire detail: model byte 0x12,
> scene fn 0x0C, STATUS_DUMP fn 0x13, all matching the III family.)
>
> **Done — please do NOT re-run these (already confirmed on hardware):** reads,
> continuous `set_param`, channel reads, alias resolution, and the catalog-wide
> roundtrip sweep. The model rosters and parameter ranges are also complete (a
> community cache file closed them; set-by-name works for the whole amp space).
>
> **Highest-value FM9 asks that remain** (each is a short front-panel confirmation,
> not another sweep):
> 1. **Discrete set-by-name confirmation** — does `"set amp 1 type to <model name>"`
>    (the server's `sub=0x09` discrete write) actually change the model on the panel?
>    This is the one write path still unconfirmed on the FM9 (the 2026-06-17 test
>    confirmed *continuous* writes; discrete is a different sub-action).
> 2. **`save_preset`** — confirm a save survives a preset switch. (`set_block`
>    placement is now confirmed: the 2026-06-19 verify probe placed a block and the
>    device's own fn=0x13 status dump listed it.)
> 3. **One log-taper knob SET capture** — see [captures-gen3.md C1](captures-gen3.md)
>    (the roundtrip used raw wire values, so it did not pin the log-taper curve).
> 4. **Live meters confirmation (new, community-beta)** — ask *"how much CPU is my
>    current preset using?"* and compare `get_preset`'s reported `cpu_percent` to the
>    FM9's own CPU meter (Home/Layout page). Also glance at whether `output_left/right`
>    track the output level meters while audio plays. Decoded from the `sub=0x2E` grid
>    frame and cross-validated against an FM9 capture, but not yet front-panel-confirmed.
>    (The device INPUT meter is intentionally not surfaced — its offset isn't portable
>    across the gen-3 family.)
>
> For everything the device can report about itself, the one-command read-only
> [harvest script](harvest-script.md) covers it with no capture tools.

See [README.md](README.md) for setup. Want to record raw protocol captures? See [captures-gen3.md](captures-gen3.md).

---

## T1 -- What's loaded?
**~2 min | no tools**

In Claude Desktop with your FM9 connected:

> "What's loaded on my FM9 right now?"

The preset number and name should match the panel. **A wrong name is the single highest-value bug to report.**

---

## T2 -- Run the probes *(highest value, do this one)*
**~5-10 min | no capture tools | Windows: double-click | Mac / source: one command**

**Quit FM9-Edit first** (it holds the USB port). There are two probes. Both are
**safe**: they never save, and the verify probe sets a restore point and reloads
your preset at the end (and on Ctrl-C / error), so the device ends exactly where
it started.

### Probe 2 -- write-verify (confirms your FM9 ACCEPTS our writes)
Continuous writes are already hardware-confirmed (2026-06-17), so this probe now
matters mainly for the **discrete set-by-name** path (changing an amp/drive *model*
by name) and `save_preset`, which are the writes still unconfirmed on the FM9
(`set_block` placement is now confirmed — the probe places a block and the device's
fn=0x13 status dump lists it). Run it if you can spare a few minutes; it sets a
restore point and reloads your preset at the end.
- **Windows:** double-click **`fm9-verify.cmd`** in the install folder.
- **Mac / source checkout:** `npm run fm9:verify`.
- Send back the JSON it writes, plus a note of anything the front panel did.

### Probe 1 -- read-back (confirms we can READ your FM9)
- **Windows:** double-click **`fm9-probe.cmd`** in the install folder.
- **Mac / source checkout:** `npm run fm9:probe`.
- Send back the **`fm9-probe-output.json`** it writes to your Desktop.

*Don't have the `.cmd` files? They ship in the release ZIP's install folder. From
a source checkout use the `npm run` commands above.*

---

## T3 -- Read a parameter
**~3 min | no tools**

> "Read the drive on Amp 1."

Paste the JSON and what the front panel shows. Also try bypass and channel.

---

## T4 -- Write a parameter *(conversational version of the T2 verify probe)*
**~3 min | no tools**

> "Set Amp 1 drive to 5.5, then read it back."

Report whether the front panel moved. If it reports success but the panel doesn't change, paste both responses. (The T2 `fm9-verify` probe is the more rigorous form of this check; this is the quick conversational version.)

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include: FM9 firmware, loaded preset, and what the panel did.
