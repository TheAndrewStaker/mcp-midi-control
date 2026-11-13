# MCP MIDI Control

[![preflight](https://github.com/TheAndrewStaker/mcp-midi-control/actions/workflows/preflight.yml/badge.svg?branch=main)](https://github.com/TheAndrewStaker/mcp-midi-control/actions/workflows/preflight.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**An opinionated MCP server for controlling your MIDI gear by conversation.**

MCP MIDI Control is a local [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server that lets Claude, or any MCP host, control your MIDI gear
over USB. You say what you want in plain language; the server speaks
SysEx, NRPN, and CC to the hardware and reads it back to confirm.

It holds the same strict opinions on every device, guitar modeler or
synth:

- **Display-first.** You pass and read the values on the front panel (a
  0 to 10 knob, dB, ms, a ratio, an enum name), never raw wire bytes or
  internal indices.
- **Nothing destructive happens silently.** It does not save, overwrite,
  or navigate away from your edits unless you say so, and every write
  waits for the device to acknowledge it before reporting success.
- **Tempo-first when the device supports it.** Time-based settings prefer
  syncing to the song tempo, so a dotted-eighth delay stays a
  dotted-eighth delay.

Generic-MIDI primitives (CC, NRPN, SysEx, program change, notes, clock)
reach any USB MIDI device the OS exposes. Registered devices get depth on
top: whole-preset and patch authoring, real-gear lineage data, and
cross-device tone translation. Adding a device is a descriptor, not a new
set of tools, and [contributions are open](#contributing).

![Building a preset on a Fractal AM4 by conversation, then applying it to the hardware](docs/assets/am4-apply-preset-demo.gif)

> **Unaffiliated community tool.** "Fractal Audio", "AM4", "Axe-Fx",
> "Axe-Fx II", "Axe-Fx III", "FM3", "FM9", "ASM", "Hydrasynth", and
> related product names are trademarks of their respective owners
> (Fractal Audio Systems, Inc. and Ashun Sound Machines). This project
> neither claims endorsement from, nor affiliation with, those
> manufacturers. It communicates with hardware the user already owns
> via SysEx / NRPN / CC messages, using publicly-documented protocol
> information (including Fractal Audio's own "MIDI for Third-Party
> Devices" specifications). See [`NOTICE`](./NOTICE) for the full
> trademark statement.

---

## Supported devices

Support tiers come straight from each device's descriptor, and the table
below is generated from them (`npm run device-status`; preflight fails on
drift):

- **Verified**: the wire protocol is hardware-confirmed on a real unit.
- **Community beta**: decoded from strong evidence and fully drivable; a
  write not yet confirmed on hardware says so in its response.
- **Generic MIDI only**: CC / Program Change with a curated map, no SysEx
  surface yet.

<!-- device-status:generated:start -->

| Device | Support | What works today | Owner's page |
|---|---|---|---|
| **Arturia MicroFreak** | Verified | Byte-exact preset read/write, full-library restore, globals | [microfreak](docs/contributing/devices/microfreak.md) |
| **ASM Hydrasynth Explorer** | Verified | Whole-patch authoring with mod-matrix and macro wiring | [hydrasynth](docs/contributing/devices/hydrasynth.md) |
| **Boss RC-505mk2** | Verified | Memory recall and looper control over MIDI; loop, tempo, track and MIDI-menu reads plus assign authoring over USB storage | [rc-505mk2](docs/contributing/devices/rc-505mk2.md) |
| **Boss VE-500 Vocal Performer** | Verified | Parameter set/read, whole-patch build, user-memory recall and save | [ve-500](docs/contributing/devices/ve-500.md) |
| **Fractal AM4** | Verified | Whole-preset authoring, scenes, lineage data, tone translation | [am4](docs/contributing/devices/am4.md) |
| **Fractal Axe-Fx II XL+** | Verified | Whole-preset authoring, scenes, X/Y channels, tone translation | [axe-fx-ii](docs/contributing/devices/axe-fx-ii.md) |
| **Novation Circuit Tracks** | Verified | Pattern and song authoring, sample and project transfer, any storage pack | [circuit-tracks](docs/contributing/devices/circuit-tracks.md) |
| **Roland SPD-SX** | Verified | Kit and sample authoring over USB storage, pad triggering over MIDI | [spd-sx](docs/contributing/devices/spd-sx.md) |
| **Fractal AX8** | Community beta | Axe-Fx II codec surface, preset and setlist authoring | [ax8](docs/contributing/devices/ax8.md) |
| **Fractal Axe-Fx III** | Community beta | Reads, writes, scenes, block placement, preset switching | [axe-fx-iii](docs/contributing/devices/axe-fx-iii.md) |
| **Fractal Axe-Fx Standard/Ultra** | Community beta | Parameter set and read, preset-structure read | [axe-fx-gen1](docs/contributing/devices/axe-fx-gen1.md) |
| **Fractal FM3** | Community beta | The same gen-3 surface over its USB-serial control channel | [fm3](docs/contributing/devices/fm3.md) |
| **Fractal FM9** | Community beta | Reads, writes, scenes, block placement, preset switching | [fm9](docs/contributing/devices/fm9.md) |
| **Fractal VP4** | Community beta | Reads, continuous-knob writes, bypass, save | [vp4](docs/contributing/devices/vp4.md) |
| **Akai MPC One G2** | Generic MIDI only | Sequence recall by Program Change, live drum patterns over MIDI, project reads from the SD card and internal storage | [mpc-one-g2](docs/contributing/devices/mpc-one-g2.md) |
| **Arturia MiniFreak** | Generic MIDI only | CC and Program Change with a curated control map | [minifreak](docs/contributing/devices/minifreak.md) |
| **Boss RC-600** | Generic MIDI only | Memory recall over MIDI, memory-file reads over USB storage | [rc-600](docs/contributing/devices/rc-600.md) |

17 registered devices. Generated by `npm run device-status` from each device's descriptor; preflight fails on drift.

<!-- device-status:generated:end -->

Each linked page carries that device's current evidence, per-device
caveats (drivers, firmware, transport quirks), and the exact help it
needs next. Unregistered USB MIDI devices still work through the
generic-MIDI primitives. Own one of these and have five minutes? Start at
[docs/contributing/README.md](docs/contributing/README.md).

---

## What you can ask Claude to do today

- **Build a full preset or patch in one sentence.** *"Build me a clean
  preset with a compressor, a Deluxe Verb Normal amp at gain 4 and bass 6,
  a 350 ms analog delay, and a Deluxe spring reverb at 35% mix."*
- **Build an expressive synth voice.** *"Make a warm OB-Xa-style brass and
  have the mod wheel open the filter."* On a synth the server wires the
  mod matrix and macros by name, not just static knobs.
- **Tweak individual params.** *"Drop the gain to 3 and bump the reverb
  mix to 50%."*
- **Place, clear, or change blocks.** *"Put a Klon-style drive in slot 1
  and swap the reverb for a plate."*
- **Name and save.** *"Save this to Z4 and call it 'Clean Machine'."*
- **Manage scenes.** *"Name scene 2 'verse', scene 3 'chorus', scene 4
  'solo'."* / *"Switch to scene 3."*
- **Research tones by real gear.** *"What's the closest drive to a Klon?"*
  / *"Which amp model is inspired by a Matchless DC-30?"*
- **Port a tone across devices.** *"Take my AM4 preset at A1 and rebuild
  it on the Axe-Fx II at location 614."* (`translate_preset` maps block
  roles and param vocabularies across devices.)
- **Verify the device matches intent.** Pass `verify_chain: true` to
  `apply_preset` and the server reads back every written param, reporting
  any drift before returning success.
- **Start from a named recipe.** Recipes are curated starting points
  called by `recipe_id` on `apply_preset` (guitar) or `apply_patch`
  (synth), with measured loudness data driving scene leveling.
- **Sequence beats and songs.** `apply_pattern` realizes drum and melody
  patterns on sequencer-class gear, and `import_songsterr` fetches a
  song's parts as step grids ready to place.
- **Switch presets.** *"Load A1."*
- **Read what is stored without loading it.** *"What's on Z3?"* returns
  an AM4 preset's blocks, channels and scenes from the stored location;
  *"Which looper memories have loops, and at what tempo?"* reads an
  RC-505mk2 in storage mode; *"What projects are on my MPC?"* lists the
  SD card and internal storage.
- **Describe and plan a whole rig.** `describe_rig` returns your devices,
  how they are cabled, and the setlist with a plan per song; `edit_rig`
  changes it.

Tool round-trips land in roughly 30 to 60 ms; whole-preset builds take
under a second.

---

## Requirements

- **Windows 10/11** via the one-click installer ZIP (bundles Node and the
  MIDI engine; no developer tooling). **macOS** via the one-click Claude
  Desktop Extension (`.mcpb`) or the one-command source build, see
  [docs/INSTALL-MAC.md](docs/INSTALL-MAC.md).
- A Claude client that supports MCP: [Claude Desktop](https://claude.ai/download),
  [Claude Code](https://docs.claude.com/en/docs/claude-code), or any other
  MCP-capable host ([docs/HOST-COMPATIBILITY.md](docs/HOST-COMPATIBILITY.md)).
- At least one USB MIDI device. Registered devices (the table above) get
  the full tool surface; anything else gets the generic-MIDI primitives.
  Per-device driver and setup notes live on each device's linked page.
- **FM3 owners:** the FM3's control channel is USB serial, not USB MIDI;
  the server reaches it automatically. On Windows install Fractal's FM3
  USB serial driver; macOS needs none. If auto-detection misses, set
  `MCP_FM3_SERIAL_PATH` (e.g. `COM5`). Details:
  [docs/contributing/devices/fm3.md](docs/contributing/devices/fm3.md).
- **Multi-device rigs:** set `MCP_RIG_LINKS` (a JSON map of host track to
  device, so "put the beat on MIDI 2" resolves outboard gear) or
  `MCP_RIG_MANIFEST` (an OpenRig JSON manifest that `describe_rig` /
  `edit_rig` work against; `npm run openrig:bootstrap` generates one).
- For source installs only: Node.js 20+. The native MIDI binding ships
  prebuilt binaries for common platforms, so a build toolchain is
  normally not needed.

**Quit the vendor editor before running the server, and quit the server
before opening the editor.** The safe assumption is that a MIDI port
cannot be shared: the holder blocks everyone else, including firmware
updaters, and the FM3's serial port is strictly exclusive. On Windows,
closing a window is not quitting; quit from the system tray. Full rule:
[docs/contributing/SAFETY.md](docs/contributing/SAFETY.md).

---

## Install

### From the release ZIP (recommended)

1. Download the `mcp-midi-control` ZIP from [the latest release](https://github.com/TheAndrewStaker/mcp-midi-control/releases/latest).
2. Extract the folder anywhere you like.
3. Make sure Claude Desktop is fully closed (system tray right-click
   → Quit, not just the window's X).
4. Double-click `setup.cmd` inside the extracted folder. It registers the
   server with Claude Desktop.
5. (Recommended) Double-click `verify-midi.cmd`. It asks the OS which
   MIDI devices are visible and reports `[OK] Fractal AM4`, etc.,
   confirming the USB / driver side is healthy. If nothing is detected,
   it prints driver links and the next thing to try.
6. Open Claude Desktop. The mcp-midi-control server appears in the
   connector panel (the + button near the chat input).

To uninstall: double-click `uninstall.cmd` (other MCP servers you have
stay intact), then delete the extracted folder.

> **First time using it?** [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)
> walks through 6 day-one conversations with literal prompts to paste and
> the audition-vs-save vocabulary. Read it before you ask Claude to
> "save" anything.

> **Note on signing.** This is an unsigned community release, so Windows
> may show a SmartScreen caution the first time you run `setup.cmd`
> (choose "More info" then "Run anyway"). The install scripts are open
> here on GitHub if you want to read every line first.

### From source (for development or contributing)

```bash
git clone https://github.com/TheAndrewStaker/mcp-midi-control.git
cd mcp-midi-control
npm install
npm run preflight    # build + typecheck + protocol goldens + MCP smoke test
npm run write-test   # changes amp gain on the device (confirms MIDI path)
```

Then register the server with Claude Desktop in one command:

```bash
npm run setup-claude-desktop
```

This builds `dist/`, detects which Claude Desktop variant(s) you have,
and writes the config entry without disturbing other MCP servers.
Restart Claude Desktop fully (system tray → Quit) and the tools appear
in the connector panel.

Claude Desktop runs the compiled `dist/` output, not the TypeScript
source. After changes under `src/`, run `npm run setup-claude-desktop`
again (it rebuilds and rewrites the config) and restart Claude Desktop.

> **macOS:** the easiest path is the one-click Claude Desktop Extension
> (`.mcpb`) attached to the [latest release](https://github.com/TheAndrewStaker/mcp-midi-control/releases),
> built per chip (Apple Silicon `darwin-arm64`, Intel `darwin-x64`).
> Open it in Claude Desktop (Settings → Extensions); no Terminal, no
> config editing. Prefer the Terminal? `npm run setup-mac` downloads the
> prebuilt MIDI engine and registers the server. See
> [docs/INSTALL-MAC.md](docs/INSTALL-MAC.md).

---

## Connect to Claude

> If you installed from the release ZIP, `setup.cmd` already registered
> the server with Claude Desktop. Skip ahead to
> [Confirm it works](#confirm-it-works); the options below are for source
> installs and non-Claude-Desktop MCP clients.

### Option 1: Claude Desktop (manual config)

Run `npm run build` first to produce `dist/`, then add the entry below to
Claude Desktop's config (`npm run setup-claude-desktop` automates all of
this):

| Claude Desktop variant | Config path |
|---|---|
| Windows (direct download) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windows (Microsoft Store) | `C:\Users\<you>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "mcp-midi-control": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-midi-control\\packages\\server-all\\dist\\server\\index.js"],
      "env": {}
    }
  }
}
```

Adjust the path (macOS users point at the same
`packages/server-all/dist/server/index.js` with forward slashes). If the
file does not exist, create it; if both Windows variants are installed,
edit both. Fully quit Claude Desktop (system tray → Quit) and relaunch.
The tools appear under the **`+` button → Connectors** in a new chat.

### Option 2: Claude Code (CLI)

After `npm run build`:

```bash
claude mcp add mcp-midi-control -- node C:\path\to\mcp-midi-control\packages\server-all\dist\server\index.js
```

### Option 3: Any MCP client (raw stdio)

```bash
npm run server   # development: tsx-based, picks up source changes
node C:\path\to\mcp-midi-control\packages\server-all\dist\server\index.js   # cwd-agnostic
```

The server speaks MCP over stdio in either case. Using a different MCP
host (Cursor, Windsurf, LM Studio, ...)? See
[docs/HOST-COMPATIBILITY.md](docs/HOST-COMPATIBILITY.md).

---

## Confirm it works

1. Open a new chat in your Claude client with a device (e.g. the AM4)
   powered on and connected by USB.
2. Ask: **"Using mcp-midi-control, list the MIDI ports you can see."**
   Claude calls `list_midi_ports` and reports a verdict like *"AM4
   detected (in: AM4, out: AM4)"*. If the device is not visible, replug
   the USB cable.
3. Ask: **"Place a compressor in slot 1 and set the level to 6."**
   Watch the display: slot 1 flips to Compressor and the level jumps
   to 6, in under a second.

If step 3 works, you're done. Move on to building full presets.

### Troubleshooting

- **Device not found in the MIDI port list:** the server could not open
  the USB port. Check power, cable seating, and the vendor driver;
  power-cycle the device if needed.
- **Tool call hangs in Claude Desktop:** hangs usually mean the native
  MIDI module could not load. Check Claude Desktop's MCP log for stderr
  output from the server.
- **Parameter out of range:** `set_param` validates against the device's
  own display ranges; the error names the legal range.
- **Axe-Fx II not visible on Windows 11:** Windows sometimes rejects the
  Axe-Fx II USB driver's signature. Remove the Fractal USB driver entries
  in Device Manager (checking "delete the driver software"), reinstall
  the official driver from [fractalaudio.com](https://www.fractalaudio.com),
  and confirm with Axe-Edit: if it connects, the server will see the
  unit too.

---

## The tool surface

<!-- tool-inventory:generated:start -->

**55 MCP tools registered.** Unified surface for tone-building across all supported devices, plus generic-MIDI primitives and device-specific extensions.

Full tool list with description-length stats: [`docs/TOOLS.md`](docs/TOOLS.md). Generated by `npm run tools:inventory`; preflight checks for drift.

<!-- tool-inventory:generated:end -->

One surface, four families, all dispatched by `port` so the same tool
name works on every registered device:

- **Unified surface**: `describe_device`, `set_param`, `apply_preset`,
  `translate_preset`, `get_preset`, `save_preset`, `switch_scene`,
  `set_block`, `lookup_lineage`, `backup_device`, and friends.
- **Voice-class tools** for synths: `apply_patch`, `set_mod_route`,
  `set_macro_route`, the modulation wiring that makes a voice expressive.
- **Sequencer, sample, and kit tools**: `apply_pattern`,
  `import_songsterr`, `upload_sample`, `author_kit`, `import_preset`.
- **Generic-MIDI primitives**: `send_cc`, `send_note`, `send_nrpn`,
  `send_sysex`, clock transport, for any USB MIDI device, registered
  or not.

Common param aliases and fuzzy enum names resolve per device, so one
instruction works across devices without rewording. Per-device guidance
lives in `describe_device(port).agent_guidance`. The full per-tool
reference is [`docs/TOOLS.md`](docs/TOOLS.md).

---

## Using it with a screen reader

The conversational interface is the accessibility win here: you describe
what you want in words, the server talks to the gear and reads the result
back as text: no spatial editor to navigate, no grid to point at. That is
exactly what a screen reader (VoiceOver, NVDA) wants. There is **no separate
"accessible mode" to turn on**; it works this way for everyone.

The tools return structured, display-unit data (knob `0..10`, dB, ms, enum
names), and Claude is instructed to narrate it for the ear: a signal chain
as a spoken path ("drive into amp into reverb"), each change confirmed in
one short sentence, and safety prompts as plain sentences that name the
target and the exact word to proceed. Tool output never contains ASCII
grids or aligned tables (a preflight check enforces this).

Install is the only barrier: macOS installs as a one-click Claude Desktop
Extension (`.mcpb`) with no Terminal at all, with the one-command source
build ([docs/INSTALL-MAC.md](docs/INSTALL-MAC.md)) as the fallback. **If
any reply reads badly aloud, or any install step fights your screen
reader, please
[open an issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues).
That feedback directly shapes the tool.**

---

> **Your presets and patches stay safe.** Every save is gated behind
> explicit user save-intent language; the server refuses silent saves and
> warns before navigating away from edited buffers. Use `switch_preset`
> to reload a stored preset over an edited working buffer. See
> [`docs/SAFETY-FOR-MUSICIANS.md`](docs/SAFETY-FOR-MUSICIANS.md) for
> the trust model in plain English.

---

## Contributing

**Own a device? Start at
[`docs/contributing/README.md`](docs/contributing/README.md)**: one page
per registered device with its asks ranked by value. No code required,
and testing on real hardware is the most useful contribution here.

Writing code: see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Run
`npm run preflight` before opening a PR, and add a byte-exact golden
against a real capture if you touch the wire protocol. Architecture and
repo layout live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

Security issues: see [`SECURITY.md`](./SECURITY.md).

## Credits

This project stands on community reverse-engineering. Thank you to:

| Contributor | Contribution |
|---|---|
| **Andrew Mercurio** (`BoodieTraps`), [fractal-syx-codec](https://github.com/drewmerc302/fractal-syx-codec) (Apache-2.0) | gen-3 (Axe-Fx III / FM3 / FM9) preset-file format spec and the read-ordinal model/type roster tables, independently cross-validated against our own hardware captures |
| **Harp** | FM9 hardware captures (read path, scene switching, preset receive, enum-label sweeps) that anchored the gen-3 decode |
| **Kevin** (`AggressiveFeckless`) | VP4 (fw 4.03) hardware captures that confirmed the VP4 read path and decoded the write path (parameter SET, save, bypass), and surfaced the family-wide gen-3 `fn=0x01` read-path finding |

Want your name here? See [Contributing](#contributing): testing, captures, and protocol decode all count.

---

## License

Apache License 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
