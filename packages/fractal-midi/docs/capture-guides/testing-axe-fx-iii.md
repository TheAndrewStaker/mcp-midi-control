# Testing: Axe-Fx III

> **Foundation confirmed (2026-06-17):** a community III owner (firmware 25.04)
> hardware-confirmed the server's continuous `set_param` (amp gain, channel A) with a
> device echo, and a `get_param` read-back matching the front panel — the first
> on-device confirmation of the III, the gen-3 byte-identity anchor. A full SET→GET
> roundtrip across the entire III catalog followed (2026-06-18). **Please do NOT
> re-run reads or continuous writes — those are done.**
>
> **Highest-value III ask now: the editor cache file** (offline, no tools, no
> hardware time — see [captures-gen3.md C2](captures-gen3.md)). The III cache copies we
> currently hold are *unsynced placeholder stubs* (no enum/model vocabulary). The III's
> type/mode selectors were corrected to discrete routing in 2026-06-20 using the
> roundtrip above as the oracle, but a cache from an III-Edit install that has
> **synced to your device** is the device's own dictionary: it mechanically confirms
> that correction, adds every enum's name list, and pins device-true display
> ranges/steps/tapers — the same file unlocked ~351 corrected params on the FM9. This
> is the single biggest III unlock and needs zero capture tooling.
>
> **Remaining write confirmations**: discrete set-by-name (T3), `save_preset` (T4),
> and `set_block`. Continuous writes (T3's gain example) are already confirmed. The
> fastest way to close everything except `save_preset` in one sitting is the
> **write-verify probe (T6)** — one self-restoring run covers discrete set-by-name,
> `set_bypass`, `switch_scene`, and `set_block`.

See [README.md](README.md) for setup. Want to record captures too? See [captures-gen3.md](captures-gen3.md).

---

## T1 -- What does the server see?
**~2 min | no tools**

In Claude Desktop with your III connected:

> "What can you see about my Axe-Fx III?"

Paste the response. Confirms detection and device routing. A missing or wrong device name means the port matcher needs adjustment.

---

## T2 -- Read a parameter
**~3 min | no tools**

Load a preset with a reverb or delay block. Ask:

> "What's the current reverb type on my Axe-Fx III?"

Paste the full JSON response and what the front panel shows. A working response shows the parameter name and a value. Note: many amp and reverb knobs are display-calibrated and read back as a panel-style number (drive, treble, master read as `0..10`); enum types like reverb type read back as a name or ordinal; any uncalibrated param still returns a raw `0..65534` integer and the response says so. What matters is that it returns *something* and that reading it back after a write round-trips.

---

## T3 -- Write a parameter *(most critical)*
**~3 min | no tools**

> "Set the Amp 1 drive to 5.5, then read it back."

Report whether the front panel moved and paste both responses. If it reports success but the panel doesn't change, that's the most valuable finding -- paste both responses.

Continuous knob writes like this gain example are **already hardware-confirmed**
(2026-06-17). The write still worth confirming is **discrete set-by-name** — changing
an amp or drive *model* by name (e.g. "set Amp 1 to a Plexi"), which rides a different
sub-action (`sub=0x09`) than the continuous drag. Try that and report whether the
model on the panel changes.

---

## T4 -- Save a preset
**~5 min | no tools**

> "Save this preset to location 5."

Check the preset name at location 5 after saving and report whether it landed. The save envelope is hardware-unverified on gen-3.

---

## T5 -- Read-back probe
**~5 min | no capture tools**

A read-only diagnostic that ships with the tool. It polls your active preset, runs a few read-only queries, and writes a JSON to your Desktop. It never writes or changes a preset.

Quit Axe-Edit III, then double-click **`axefx3-probe.cmd`** in the install folder (Windows ZIP), or run `npm run axefx3:probe` in the install directory terminal (Mac / source install). Send back `axefx3-probe-output.json`.

---

## T6 -- Write-verify probe *(closes the remaining write confirmations in one run)*
**~5 min | no capture tools**

The companion diagnostic that confirms the device **accepts and applies our writes**: it sends each shipped write op against the loaded preset and reads the result back — continuous `set_param` (both wire forms), discrete set-by-name (it sets reverb type to *Music Hall*, a value chosen to be decisive for the corrected wire), `set_bypass`, `switch_scene`, and `set_block`. One run flips those from "untested" to "confirmed" for the III — and because the III is the gen-3 byte-identity anchor, family-wide.

**Safe:** it NEVER saves; it records your active preset number first and reloads it at the end (and on Ctrl-C), which discards every working-buffer change. It does discard any unsaved edits you had open, so store or abandon those first.

Quit Axe-Edit III, then double-click **`axefx3-verify.cmd`** in the install folder (Windows ZIP), or run `npm run axefx3:verify` (Mac / source install). Load a preset that **has a Reverb block and no Drive block** first — the probe skips the reverb tests if no reverb is placed, and skips `set_block` if a Drive is already there. Send back `axefx3-verify-output.json` from your Desktop (Windows) or `axe-fx-iii-verify-output.json` from the install directory (Mac).

---

## Submitting results

Paste JSON responses and front-panel observations in a [GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`). No GitHub account? Reply to the Reddit thread.

Include: III firmware version, the loaded preset (number and name), and what the panel did for each ask.
