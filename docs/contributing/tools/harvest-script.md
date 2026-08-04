# Harvest: the one-command device self-describe sweep

**~2-4 min | no capture tools | any Fractal AM4, Axe-Fx II, Axe-Fx III, FM3, FM9, or VP4**

One command. The script connects to your device, asks it every "describe yourself" question we know about, and writes **one JSON file** you send back. That single file replaces most of the itemized capture asks on the per-device pages: firmware identity, preset and scene names, which blocks are placed, per-parameter ranges and defaults, and the device's own enum label tables (amp model names, reverb types, and so on), exactly as your firmware spells them.

If you only do one thing from these guides, do this one.

---

## Is it safe? Yes: it reads, it never writes.

The script is **read-only by construction**:

- It only sends documented query and dump-request messages, the same reads the official editor performs when it syncs.
- It never saves, never overwrites a preset, never switches your preset or scene, never changes a parameter value.
- A mechanical safety gate inside the script checks every single outgoing message against a read-only whitelist before it touches the wire. A write cannot leave the program, even by bug.

When it finishes, your device is exactly as it was. The current preset is untouched.

It is also **bounded by construction**: every question has a hard timeout, requests are paced so your device's screen stays usable, and the whole run is capped at 10 minutes (it normally takes 1 to 3). The device front panel may respond slowly during the sweep; this is normal and ends when the run finishes (max 10 minutes). If something goes wrong mid-run, the script still writes everything it collected up to that point, and Ctrl-C exits cleanly the same way.

---

## Run it

**You need:** the device connected over USB, powered on, and the Fractal editor (FM9-Edit, AM4-Edit, AxeEdit, Fractal-Bot, ...) **fully closed**. The editor holds the USB port, and an editor plus the script talking at the same time can wedge the Windows MIDI driver layer (a stuck run that holds the port and freezes the device front panel until processes are killed).

The script now **checks for running Fractal editors at startup and refuses to run** if it finds one, printing which process to quit. Fully quit the editor (on Windows, check the system tray too), then re-run. If you are certain you need to bypass the check, `--ignore-editors` overrides it; for a normal harvest, don't.

From a source checkout of the `mcp-midi-control` repo (needs [Node.js](https://nodejs.org) 18 or newer):

```
git clone https://github.com/TheAndrewStaker/mcp-midi-control.git
cd mcp-midi-control
npm install
npm run build
npx tsx scripts/harvest-device-metadata.ts
```

The first four lines are one-time setup. After that, the harvest is the single last command.

- **Windows:** run the commands in PowerShell or Git Bash. If `npm install` complains about build tools (the MIDI module compiles a small native piece), install "Visual Studio Build Tools" with the C++ workload and retry.
- **Mac:** run the commands in Terminal. No driver needed; macOS sees Fractal devices natively.
- **FM3: the harvest script cannot reach it (yet).** The FM3 is a USB **serial** device, not a MIDI device, on every OS, and this script talks MIDI ports directly. The MCP server itself reaches an FM3 over serial; the harvest script has not been ported to that transport. FM3 owners: the SESSION-tier asks on [../devices/fm3.md](../devices/fm3.md) cover the same ground, and the FM3-Edit cache file (no tools at all) is the higher-value contribution anyway.

The script auto-detects your device. It prints progress as it sweeps (expect 1 to 3 minutes, hard-capped at 10; the Axe-Fx II sweep is the longest because it walks every parameter of every placed block), and ends with:

```
Wrote: harvest-fm9-2026-06-09.json
```

Alongside the JSON it writes a matching `.log` file (e.g. `harvest-fm9-2026-06-09.log`) with a timestamped line per request. You normally don't need it, but if a run ever aborts early or behaves oddly, send the `.log` file along with the JSON; it shows exactly where the run got to.

A few useful flags:

- `--verbose` prints every request and every received frame as it happens.
- `--max-minutes <n>` changes the total-runtime cap (default 10). If the cap is hit, the script writes everything collected so far and says so in the file.
- `--ignore-editors` skips the running-editor startup check (see above). Only for deliberate listen-only setups.

### If it cannot find the device

- `--port <name>` picks the MIDI port by name fragment, e.g. `--port FM9` or `--port AM4`. The error message lists every port it can see.
- `--device am4|axefx2|gen3` skips auto-detection if your port has an unusual name (`gen3` covers III / FM3 / FM9 / VP4).
- Still nothing? Check the USB cable, power, that the editor is really quit (check the system tray on Windows), and on Windows that the Fractal USB driver is installed.

### Optional: `--experimental` (gen-3 only)

Adds two extra read-requests (`fn=0x40` and `fn=0x1a`) whose replies we believe carry the device's internal parameter dictionaries. The requests are read-only and safe, but their meaning is not yet decoded, so whatever comes back is simply recorded and labeled experimental in the file. If you are comfortable running it, the extra data is welcome:

```
npx tsx scripts/harvest-device-metadata.ts --experimental
```

---

## What to send back

Just the one file the script wrote, e.g. `harvest-fm9-2026-06-09.json` (it lands in the folder you ran the command from). Attach it to a [GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) with the label `community-beta`, or reply to the Reddit thread. Please include:

- your device and firmware version (the file records what the device reported, but a human-confirmed version helps),
- anything odd you noticed (error lines, a surface reported `silent`, the run aborting early).

The file contains raw hex of every request and response plus decoded labels where we know the format. It contains your preset names and parameter values for the currently loaded preset, but no personal data beyond that. Skim it before sending if you like; it is plain JSON.

---

## What it sweeps (per device)

For the protocol-curious. Every request is a documented read; raw hex is always recorded so the file stays minable as decodes improve.

| Device | Surfaces |
|---|---|
| **AM4** | firmware (fn=0x08), device info (fn=0x47), preset number / patch name / scene name / scene (fn=0x14 / 0x0D / 0x0E / 0x0C), status (fn=0x13), active working-buffer dump (fn=0x03), per-block parameter dumps (fn=0x1F, full effectId sweep), all 104 preset location names, plus a few fn=0x28 enum-dump probes (an Axe-Fx II primitive the AM4 has never answered or refused on record; either result is useful) |
| **Axe-Fx II** | firmware (fn=0x08), sysinfo (fn=0x47), preset number / name / scene (fn=0x14 / 0x0F / 0x29), grid layout (fn=0x20), block states (fn=0x0E), per-block parameter dumps (fn=0x1F), per-parameter descriptors for every placed block (fn=0x16: default, min, max, step), and the device's own enum label tables for every enum parameter found (fn=0x28) |
| **III / FM3 / FM9 / VP4 (gen-3)** | identify + firmware + sysinfo (fn=0x00 / 0x08 / 0x47), tempo / patch name / scene name / scene (fn=0x14 / 0x0D / 0x0E / 0x0C), status (fn=0x13), layout map (fn=0x01 sub=0x2e), placed-block flags (sub=0x7b, full roster sweep), block descriptors (sub=0x01), per-block bulk reads (fn=0x1F, the 0x74/0x75/0x76 burst), parameter-info reads (sub=0x1a), directory entries (sub=0x2a), and a bounded walk of the label stream (sub=0x1f), which is where the editor gets its dropdown names. `--experimental` adds the fn=0x40 / fn=0x1a dictionary-dump requests |

---

## Why this matters

Most of what is still missing for community-beta devices is not a protocol mystery, it is device-resident data we cannot read without a device: the FM9's amp roster ordinals, the VP4's type tables, per-firmware enum spellings, non-AM4 parameter ranges. Your harvest file carries that data straight out of your unit, in one shot, with no capture tooling installed.
