# Sending your editor's definition cache file

**Tier: DONATE. About two minutes, offline, no capture tools, the device does
not even need to be plugged in when you send it.**

This is the highest-value-per-minute contribution that exists for the Fractal
devices, and it is the model for what a DONATE ask looks like on any brand.

## What the file is

Each Fractal editor stores its device's **complete parameter dictionary** in a
definition cache, written the first time the editor syncs with a real device:

- every block's model roster (amp, drive, reverb, cab, by name),
- every parameter's device-true display range, step and taper,
- every enum's name list, spelled the way your firmware spells it.

The cache format is fully decoded, so one file makes the server device-true for
your unit. That is not a small delta. One community cache file corrected around
351 FM9 parameters from a wrong wire form to the right one: type and mode
selectors that had been sent as continuous floats are discrete ordinals, and the
cache is the device's own dictionary saying so. It also delivered the FM9's full
amp roster, which is what makes set-by-name work across the whole amp space.

It contains no presets and no personal data. It is the device's dictionary, not
your work.

## Where it lives

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Fractal Audio/<Editor>/` |
| Windows | `%APPDATA%\Fractal Audio\<Editor>\` |

The file is named `effectDefinitions_<modelbyte>_<fw>.cache`. The leading number
is the device's model byte in hex:

| Model byte | Device |
|---|---|
| `10` | Axe-Fx III |
| `11` | FM3 |
| `12` | FM9 |
| `14` | VP4 |
| `15` | AM4 |

So `effectDefinitions_11_28p0.cache` is an FM3 on firmware 28. The editor keeps
one file per firmware version it has run. **Send the newest, or send the whole
set** and we will use the one that carries real rosters.

Ignore the other files in that folder (`color-assignments*`, `*.settings`).

## The one requirement, and how to check it

**The editor must have connected to your device at least once.** That sync is
what fills the file.

An install that has never connected writes a **placeholder stub**: no model
names, filler ranges, and often only a few dozen records. Those are useless, and
several have already been sent in good faith.

How to tell: open the file in a text editor and search for an amp name you know
your device has, something like `Plexi` or `Bassguy`. If you find model names,
it is a real cache. If it is all numbers and no vocabulary, connect the editor
to your device once, let it finish syncing, quit the editor, and grab the file
again.

## What to send

The `.cache` file itself, plus:

- your device model and firmware version,
- your editor version,
- confirmation that the editor had synced with the device.

See [../SUBMITTING.md](../SUBMITTING.md).

## Why this comes before any capture ask

Ask order on this project is: **cache file first, read-only probe second, and a
wire capture only for the few shapes neither one reaches.** A cache file closes
dozens of would-be capture asks for a device in one file, with no tooling, no
device time and no risk. If you can find yours, do that instead of anything else
on your device's page.

If you cannot find or sync the cache, the one-command read-only
[harvest script](harvest-script.md) collects much of the same self-description
straight from the device over USB.
