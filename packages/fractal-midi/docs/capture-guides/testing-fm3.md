# Testing: FM3

> **Status (2026-06 hardware sessions, fw 12.00, macOS):** the serial
> transport, discovery, framing, the whole read path, continuous `set_param`,
> `set_bypass`, `switch_scene`, and the SysEx preset switch are
> **hardware-confirmed end-to-end through this server's own probes**
> (2026-06-12 field test), and **set-by-name discrete `set_param` is
> hardware-confirmed** via a 2026-06-10 community session (frames
> byte-identical to this server's encoder, sent from the tester's own rig).
> What remains unconfirmed: **`set_block`** (needs a loaded preset WITHOUT a
> Drive block so the probe's placement test can run) and **`save_preset`**
> (T4 below, never auto-tested by design). A Windows serial-driver run would
> also be new coverage (the field tests were macOS).
>
> **Highest-value FM3 ask: run the catalog-wide SET→GET roundtrip script**,
> the same sweep community FM9 and Axe-Fx III owners ran on 2026-06-18. The
> FM3 now ships the discrete enum-routing correction its siblings got
> (type/count selectors sent as discrete ordinals, not continuous floats),
> classified by FAMILY JOIN against the FM9/III evidence because no FM3
> roundtrip exists yet; the roundtrip is the device's own oracle that confirms
> (or corrects) that classification in one session, and its output regenerates
> the overlay mechanically (`scripts/generate-gen3-roundtrip-discrete.ts`).
> It is read-and-restore only (each param is SET then read back and restored).
>
> Beyond the tests below, the highest-value FM3 artifact needs no capture tools at all: the editor's cache file (the device's complete parameter dictionary, including the display ranges the catalog still lacks for FM3, offline, see [captures-gen3.md C2](captures-gen3.md)). The [harvest script](harvest-script.md) does NOT work on the FM3 (it talks MIDI ports; the FM3 is serial-only over USB).

See [README.md](README.md) for setup. Want to record captures too? See [captures-gen3.md](captures-gen3.md).

## How the FM3 connects (read first)

The FM3 is **not a USB MIDI device** on any OS (Fractal's docs are explicit).
Over USB its control channel is a serial port, and the server speaks raw MIDI
over it (hardware-confirmed on macOS, 2026-06-12; Windows serial-driver path
still unconfirmed):

- **Windows:** install Fractal's **FM3 USB Serial Driver** (separate from the
  audio driver; both come in the FM3 driver download). The FM3 then appears
  under "Ports (COM & LPT)" as "FM3 Communications Port", not in any MIDI
  port list. The server finds it automatically.
- **macOS:** no driver; the FM3 enumerates as `/dev/cu.usbmodem…` and the
  server finds it automatically.
- **The serial port is exclusive.** FM3-Edit / Fractal-Bot must be fully quit
  while the server is connected (and vice versa).
- If auto-detection misses, set `MCP_FM3_SERIAL_PATH` (e.g. `COM5` or
  `/dev/cu.usbmodemXXXXX`) in the server's environment.

Note: the FM3 runs a **4-row, 12-column effect grid** (the FM9/III use a 6-row, 14-column grid). That matters for `set_block` and for the live grid read inside `get_preset`; the FM3's 4×12 grid decode was pinned offline (2026-07-01) against the 2026-06-12 probe capture, so a quick way to help: ask for the active preset's layout on a preset with three or more placed blocks and compare it to the FM3-Edit / front-panel grid. A match flips the FM3 live-grid read from "untested" to "confirmed".

---

## T1 -- What does the server see?
**~2 min | no tools**

In Claude Desktop with your FM3 connected:

> "What can you see about my FM3?"

Paste the response. Confirms detection and device routing.

---

## T2 -- Read a parameter
**~3 min | no tools**

Load a preset with a reverb or delay block:

> "What's loaded on my FM3 right now?"

The preset number and name should match the panel. **A wrong name is the single highest-value bug to report.** Then:

> "Read the drive on Amp 1."

Paste the full JSON and what the front panel shows.

---

## T3 -- Write a parameter *(most critical)*
**~3 min | no tools**

> "Set Amp 1 drive to 5.5, then read it back."

Report whether the front panel moved and paste both responses. The write frames themselves are hardware-confirmed on FM3 (community collaborator, fw 12.00); what this test confirms is this server delivering them over the FM3's serial channel. If it reports success but the panel doesn't change, paste both responses -- that's the most valuable finding.

---

## T4 -- Save a preset
**~5 min | no tools**

> "Save this preset to location 5."

Report whether it landed: check the preset name at that location after saving.

---

## T5 -- Probe (Windows only)
**~5 min | no capture tools | Windows**

Quit FM3-Edit, then double-click **`fm3-probe.cmd`** in the install folder. Send back `fm3-probe-output.json` from your Desktop. Read-only -- never changes a preset.

*Mac users: the probe runs via `npm run fm3:probe` in the install directory terminal. T2--T4 above cover the same ground without it.*

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include: FM3 firmware, loaded preset, FM3-Edit version, and what the panel did.
