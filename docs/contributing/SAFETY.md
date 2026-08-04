# Safety, and what we will never ask you to do

Read this once. Every device page links back here and only adds the parts that
are specific to that box.

## 1. What this project will never ask you to do

- No firmware modification, and no running anything unofficial on your device.
- No opening the unit.
- No factory reset.
- No bypassing any protection, code signing, or access control, on the device
  or on a vendor application.

If an ask on a device page reads like it needs one of those, that is a bug in
the page. Report it as one.

The same line applies to how evidence is sourced: decoded facts come from a
manufacturer's publicly published spec, from wire traffic you captured from
hardware you own, or from a vendor editor only where that editor's license does
not prohibit it. See the sourcing rules in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## 2. The port trap, stated once

**This server holds a device's MIDI or serial port exclusively, and while it
holds that port nothing else can have it.** That includes the vendor editor and,
critically, the vendor firmware updater.

Contributors hit this. It is the single most common reason "nothing happens"
during a test.

Three consequences, in increasing severity:

1. A vendor editor open at the same time as this server can make either one
   silently fail to see the device. You get a tool call that reports a port and
   no device response, or an editor that shows a disconnected unit.
2. Two processes fighting over a Windows MIDI port can wedge the driver layer
   and freeze the device front panel until both processes are killed. This is
   the failure the harvest script's startup check exists to prevent: it refuses
   to run if it finds a vendor editor already running, and names the process to
   quit. See [tools/harvest-script.md](tools/harvest-script.md).
3. **A firmware updater cannot get the port while this server holds it.** Always
   fully quit your MCP host before running any vendor firmware update. Do not
   attempt an update with the server running and hope it fails cleanly.

**Fully quit means fully quit.** On Windows, closing a window leaves the process
alive; check the system tray, and quit the MCP host from there. On macOS, use
Cmd+Q rather than closing the window. An MCP host keeps its server child alive
as long as the host is running.

The safe default for every ask on every device page: **quit the vendor editor
before you start, and quit this project's MCP host before you open the vendor
editor again.** Where a specific device is known to tolerate sharing, its page
says so; assume it does not otherwise.

## 3. What "read-only" means here, and how you can check

A PROBE-tier script is read-only **by construction**, not by good intentions.

- It sends only documented query and dump-request messages, the same reads the
  official editor performs when it syncs.
- It never saves, never overwrites a preset, never switches your preset or
  scene, never changes a parameter value.
- The strongest form, used by the harvest script, is a mechanical gate inside
  the script that checks every outgoing message against a read-only whitelist
  before it reaches the wire. A write cannot leave the program even through a
  bug.
- Probes carry a hard runtime cap and write out whatever they collected if
  interrupted, so Ctrl-C is always safe.

The source is open and the gate is one function you can read. A device page
only offers a script at PROBE tier when that script is read-only; if you find
one that is not, that is a bug in the page.

## 4. Probes that need you to watch the device are interactive, never timed

When a script needs you to read the front panel, it waits for you to type what
you saw and press Enter before it moves on. It never counts down at you.

This is a hard rule for every script this project points a contributor at,
stated in the repo's own contributor rules under "Hardware probe script design
rule". A person cannot reliably watch a device and note what appeared during an
automatic countdown; you might be mid-sentence, looking away, or still reading
the previous result. Timed sweeps are only acceptable when the script itself
validates the result and no human is watching anything.

If a script ever counts down at you while asking what you see, that is a bug.
Stopping is the right response.

## 5. Writes, saves, and what is reversible

- **SESSION-tier asks write to the working buffer.** That is reversible:
  reloading or switching the preset discards it.
- **Saving is not reversible**, and it never happens unless you ask for it in
  your own words. The server refuses to save on its own; a save needs explicit
  save-intent language from you.
- **Self-restoring verify probes** record your loaded preset first and reload it
  at the end, and on Ctrl-C, and on error. That also discards any unsaved edits
  you had open, so store or abandon those before running one.
- Before anything is written to a stored location, the current contents are read
  and surfaced first. Nothing gets overwritten silently.

## 6. What is in the file you send us

Every DONATE and PROBE ask states what its artifact contains before asking for
it. In general:

- A **probe output file** is plain JSON: raw hex of every request and response,
  decoded labels where we know the format, your preset names and the parameter
  values of the currently loaded preset. No personal data beyond that.
- An **editor definition cache** is the device's parameter dictionary: block
  rosters, model names, ranges, steps. It is not your presets.
- A **preset or project or kit backup** obviously contains your own work. Send
  one you are happy to share, or say what you would like left out.

You are encouraged to open any of these before sending. Most are plain text or
plain JSON.

## 7. If something goes wrong

- Nothing here can brick a device. The worst realistic outcome is a wedged USB
  port that a reboot clears, or a working-buffer edit you did not want, which a
  preset reload discards.
- If the device stops responding, quit everything holding the port, unplug and
  replug USB, and if the front panel is still frozen, power-cycle the unit.
- Then tell us what happened. A failure report is worth more than a success
  report. See [EVIDENCE.md](EVIDENCE.md).
