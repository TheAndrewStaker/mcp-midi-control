# Community help wanted

This server controls Fractal Audio gear by conversation. The modern Fractal
family (Axe-Fx III / FM3 / FM9, and VP4 with reads plus first writes) already works today: you can
set amps, drives, and reverbs by their real model names, build presets, switch
scenes, and read the device back. It is **community beta**, and three of the
modern devices now have on-hardware confirmation:

- **FM9**: reads and continuous `set_param` hardware-confirmed (2026-06-17 owner
  test, firmware 11.0), plus a full SET→GET roundtrip across the entire parameter
  catalog (2026-06-18), plus **`set_block` placement + `switch_scene`
  hardware-confirmed on Windows** (2026-06-19 verify probe: a placed block appeared
  in the device's own status dump). Reading a block's current type/model by NAME is
  wire-confirmed (`get_param` on an enum returns the device's own name). Model
  rosters and ranges complete from a synced cache.
- **Axe-Fx III**: continuous `set_param` + `get_param` hardware-confirmed
  (2026-06-17, firmware 25.04) and a full catalog roundtrip (2026-06-18). This is
  the gen-3 byte-identity anchor, so confirming it raises confidence family-wide.
- **FM3**: read and continuous-write paths hardware-confirmed end-to-end
  (2026-06-12 field test); set-by-name discrete write confirmed via a 2026-06-10
  community session.

Still unconfirmed on these (short front-panel checks, not sweeps): discrete
set-by-name on the III/FM9 and `save_preset`. (`set_block` placement and
`switch_scene` are now FM9/Windows hardware-confirmed, 2026-06-19 verify probe.)
Gen-1 (Axe-Fx
Standard / Ultra) supports full parameter WRITES (set_param / set_params) plus
reads, decoded from the spec and hardware-unconfirmed; preset authoring there
awaits one structural capture (see the gen-1 row below).

Four ways to move a device forward, **in priority order** -- try them top to
bottom and stop as soon as one works; the higher ones are easier and cover more:

1. **Send the editor cache file** -- offline, no tools, biggest win.
2. **Run the harvest script** -- read-only, one command over USB.
3. **Run the write-verify probe** -- confirms the write path on your unit.
4. **Record a calibration capture** -- only for the rare gap the first three miss.

## 1. Send your editor's definition cache file *(easiest, biggest win, no tools)*

Each Fractal editor stores its device's **complete parameter dictionary** in a
definition cache that appears once you've connected your real device to the
editor: every block's model rosters (amp, drive, reverb, cab by name) AND every
parameter's device-true display range, step, and taper. The cache format is fully
decoded, so one file makes the server **device-true** for your unit, the same way
the FM9 got its full 331-amp / 86-drive / 79-reverb rosters and its 1,891 device
parameter ranges.

- **macOS:** `~/Library/Application Support/Fractal Audio/<editor>/effectDefinitions_<model>_<fw>.cache`
- **Windows:** `%APPDATA%\Fractal Audio\<editor>\effectDefinitions_<model>_<fw>.cache`
- Model byte in the filename: `10` = Axe-Fx III, `11` = FM3, `12` = FM9, `14` = VP4, `15` = AM4.
- **The editor must have connected to your device at least once** (that sync is
  what fills the file). A never-synced install writes a placeholder with no model
  names; if yours has no amp names in it, connect the editor to the device once,
  let it finish syncing, then grab the file. Send the whole set if unsure; we use
  the one that carries real rosters.

This needs no capture tools and no front-panel work. It is the highest-value ask
for the Axe-Fx III, FM3, and VP4 right now (the FM9's is already in).

## 2. Run the harvest script *(read-only, one command, no tools, over USB)*

If you cannot find or sync the cache file, the **harvest script**
([harvest-script.md](harvest-script.md)) collects the same self-description
straight from the device over USB: firmware, every model name, parameter ranges,
and block layout, written to one file you send back. It is strictly read-only (it
never changes a setting) and finishes in a couple of minutes. Use it when the
cache file is unavailable, or to confirm what the cache already gave us.

## 3. Run the write-verify probe *(one command, confirms the write path)*

A read-only-safe diagnostic that confirms the device accepts the server's own
parameter writes. This is the single thing that flips a device's write path from
"untested" to "confirmed."

- **FM9:** `npm run fm9:verify` / **Axe-Fx III:** `npm run axefx3:verify` / **FM3:**
  `npm run fm3:verify` (or double-click `fm9-verify.cmd` / `axefx3-verify.cmd` /
  `fm3-verify.cmd` in the release ZIP).
- **Read-back diagnostics:** `npm run fm9:probe` / `fm3:probe` / `axefx3:probe`.
- Each device's testing page also has a quick conversational write test.

## 4. Record a calibration capture *(needs a capture tool, for display accuracy)*

The genuine wire-capture ask: a non-linear knob (reverb / delay **Time**) swept
with the front-panel readings noted, so display values land exactly. Full steps:
[captures-gen3.md](captures-gen3.md). One-time capture-tool setup: [SETUP.md](SETUP.md).

---

## Device status

| Device | Test / probe page | Captures | Top ask |
|---|---|---|---|
| Axe-Fx III | [testing-axe-fx-iii.md](testing-axe-fx-iii.md) | [captures-gen3.md](captures-gen3.md) | **Cache file** (#1) for device-true rosters/ranges; then **`axefx3:verify`** (T6 on the testing page: one self-restoring run closes discrete set-by-name, `set_bypass`, `switch_scene`, and `set_block`). Reads + continuous writes hardware-confirmed (2026-06-17/18); set-by-name + apply_preset work today via the shared gen-3 roster. |
| FM3 | [testing-fm3.md](testing-fm3.md) | [captures-gen3.md](captures-gen3.md) | Serial transport + read path + continuous write + bypass/scene/preset switch **hardware-CONFIRMED end-to-end** (2026-06-12 field test, macOS); set-by-name discrete write also hardware-confirmed (2026-06-10 community session, frames byte-identical to this server's encoder). Remaining: **set_block** (re-run the verify probe with a preset that has no Drive block), **save_preset** (T4), a **Windows** serial-driver run, and the **cache file** (#1) for device-true display ranges. |
| FM9 | [testing-fm9.md](testing-fm9.md) | [captures-gen3.md](captures-gen3.md) | Reads, continuous writes, **`set_block` placement + `switch_scene`** all hardware-confirmed (2026-06-17 / 2026-06-19); rosters + knob ranges device-true (cache in); current-type-name read confirmed. Remaining: **re-run `fm9:verify` on a preset that HAS a reverb block** (closes continuous `set_param` + discrete set-by-name + `save_preset` on Windows), and a **type-dropdown-OPEN sweep** for per-block name rosters beyond reverb (see captures-gen3.md). |
| VP4 | [testing-vp4.md](testing-vp4.md) | [captures-vp4.md](captures-vp4.md) | **Zero-cost fn=0x0C scene-query probe** (P0 in captures-vp4.md: one read-only frame, may unlock switch_scene) + **cache file** (#1) for rosters; then confirm the decoded writes (continuous-knob set_param, set_bypass, save_preset) AND the new whole-preset structure read (name/scenes/scene/chain in get_preset, decoded 2026-07-01) on hardware. Block placement + scene WRITE stay gated pending the surgical minimal-pair capture (C1). |
| Standard / Ultra | [testing-axe-fx-gen1.md](testing-axe-fx-gen1.md) | [captures-axe-fx-gen1.md](captures-axe-fx-gen1.md) | **Top ask: ONE structural editing-session capture (place block / route / save in gen-1 AxeEdit) -- the single unlock for apply_preset + save** (C2 in the guide). Also: port name + a write/read confirmation; legacy captures confirm reads + decode the patch-dump body. |
| AM4 | (first-class; no community guide) | n/a | Hardware-confirmed. **Owner-verify (stored `get_preset`, shipped 2026-07-02):** with the AM4 connected, ask "what's stored at A05?" and compare the returned preset name + 4 scene names to the front panel. Container decode is CRC-self-validating offline (104 factory presets); this confirms the live fn-0x03 stored-dump request round-trips end-to-end through the reader. Per-param VALUES stay labeled-omitted pending the body field-map decode. |

Because these devices share a protocol family, one good cache file, probe, or
capture often helps several at once.

---

## Setup

Both testing and capture contributors need [Claude Desktop](https://claude.ai/download) and the MCP server installed.

### Mac (source install)

1. Install [Claude Desktop](https://claude.ai/download) and create a free account at [claude.ai](https://claude.ai).
2. Install [Node.js v20+](https://nodejs.org).
3. Run `xcode-select --install` once -- required for the native MIDI module; `npm install` will fail without it.
4. In a terminal:
   ```
   git clone https://github.com/TheAndrewStaker/mcp-midi-control
   cd mcp-midi-control
   npm install
   ```
5. Double-click `setup-mac.command` in Finder, or run `npm run setup-mac` in terminal. Registers the server with Claude Desktop -- no manual JSON editing.
6. Fully quit Claude Desktop (Cmd+Q) and relaunch it.

### Windows (ZIP install)

1. Install [Claude Desktop](https://claude.ai/download) and create a free account at [claude.ai](https://claude.ai).
2. Download the release ZIP from the [GitHub releases page](https://github.com/TheAndrewStaker/mcp-midi-control/releases), extract, and run `setup.cmd`.
3. Fully quit Claude Desktop and relaunch it.

---

## Capture tool setup (only for ask #4)

One-time setup to record raw MIDI or USB traffic: [SETUP.md](SETUP.md).

- Windows: USBPcap + Wireshark -- see [usbpcap-wireshark.md](usbpcap-wireshark.md) for the detailed workflow.
- Mac: MIDI Monitor -- see [midi-monitor-mac.md](midi-monitor-mac.md) for spy-mode setup.

---

## How to submit

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) -- attach the `.cache` file, `.pcapng` / `.syx` capture, or probe JSON directly, or paste test results. No GitHub account? Reply to the Reddit thread -- all replies are read.
