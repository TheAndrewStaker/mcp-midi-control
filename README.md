# MCP MIDI Control

Talk to Claude. Control your MIDI gear.

MCP MIDI Control is a local [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server that lets Claude drive USB MIDI hardware in plain English.
First-class support today for the **Fractal Audio AM4**, **Fractal
Axe-Fx II XL+**, and **ASM Hydrasynth Explorer**: block layout, amp/
oscillator/filter type, drive/cutoff, delay/envelopes, reverb/mutators,
scenes, and preset names all updateable in real time. Thirteen generic-
MIDI primitives (CC, NRPN, SysEx, program change, ...) work against any
USB MIDI device, so synths, looper pedals, and other gear are reachable
from day one.

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

## Status

v0.1.0, first public release. The protocol layer is hardware-verified
across Fractal AM4, Axe-Fx II XL+, and ASM Hydrasynth Explorer; **58
MCP tools** are live; every wire-level tool ships with byte-exact
goldens against real captures. Axe-Fx II preset authoring is
audio-confirmed end-to-end on Q8.02 firmware: building "Comp + Amp +
Cab + Reverb" in chat saves an audible preset on a fresh-empty slot,
no manual re-routing in AxeEdit required. Multi-scene authoring
(distinct per-scene bypass + channel state) is hardware-verified too.
`apply_preset` now configures all block types (including non-channel
blocks like filter, chorus, and compressor) in a single call, so a
full song preset builds cleanly in one conversational turn.

> **🟡 Axe-Fx III, community beta.** The Axe-Fx III protocol layer is
> scaffolded from Fractal's published "Axe-Fx III MIDI for Third-Party
> Devices" v1.4 PDF and the AxeEdit III editor assets (47-block roster
> verified). Device identification, `describe_device`, `switch_preset`,
> and `switch_scene` work today; write tools (set_param, apply_preset,
> save_preset) refuse with structured "pending community capture"
> errors because Fractal deliberately omits per-block parameter IDs
> from the public spec. **III owners: we need your help.** Five
> 5-minute test sessions per the
> [community beta-testing guide](./docs/community/axefx3-beta-testing.md)
> take the III from 🟡 community-beta to 🟢 hardware-verified. The wire
> shapes are already decoded from public captures; what's missing is
> someone with a real III running the calls and pasting the JSON
> responses into a GitHub issue. No capture tools, no Wireshark, no
> developer setup required.

Two surfaces cover the common path; a third covers device-specific
edge cases:

- **Unified surface (17 tools):** `set_param`, `get_param`,
  `apply_preset`, `apply_setlist`, `switch_preset`, `save_preset`,
  `switch_scene`, `set_block`, `set_bypass`, `set_params`,
  `get_params`, `list_params`, `describe_device`, `rename`,
  `scan_locations`, `lookup_lineage`, `restore_defaults`. Port-
  dispatched and device-agnostic: same tool name, every registered
  device. **This is the surface to learn first**; it's the tool
  contract. Adding a new device means writing a `DeviceDescriptor`,
  not new tools.
- **Generic-MIDI primitives (13 tools):** `send_cc`, `send_note`,
  `send_program_change`, `send_nrpn`, `send_sysex`, plus `send_panic`,
  `send_pitch_bend`, `send_clock_*`, etc. Work against any USB MIDI
  device the OS exposes, including ones with no registered descriptor.
- **Device-namespaced tools (~25 tools, `am4_*` / `axefx2_*` /
  `hydra_*`):** kept for capabilities the unified contract doesn't
  yet cover (Axe-Fx II's 4×12 grid, Hydrasynth's NRPN patch dump,
  per-device state reads). Documented in the
  [device-namespaced appendix](#appendix--device-namespaced-tools).

> **Your presets stay safe.** Every save is gated behind explicit
> user save-intent language; the server refuses silent saves and
> warns before navigating away from edited buffers. Recovery is one
> tool call (`restore_defaults`). See
> [`docs/SAFETY-FOR-MUSICIANS.md`](docs/SAFETY-FOR-MUSICIANS.md) for
> the trust model in plain English.

Distribution is a Windows ZIP that bundles a Node runtime plus the
server. No Node or developer tooling required.

---

## What you can ask Claude to do today

Once connected, Claude can:

- **Build a full preset in one sentence.** *"Build me a clean preset with
  a compressor, a Deluxe Verb Normal amp at gain 4 and bass 6, a 350 ms
  analog delay, and a Deluxe spring reverb at 35% mix."*
- **Tweak individual params.** *"Drop the gain to 3 and bump the reverb
  mix to 50%."*
- **Place, clear, or change effect blocks.** *"Put a Klon-style drive in
  slot 1 and swap the reverb for a plate."*
- **Name and save presets.** *"Save this to Z4 and call it 'Clean
  Machine'."*
- **Manage scenes.** *"Name scene 2 'verse', scene 3 'chorus', scene 4
  'solo'."* / *"Switch to scene 3."*
- **Research tones by real gear.** *"What's the closest drive to a
  Klon?"* / *"Which amp on the AM4 is inspired by a Matchless DC-30?"*
- **Switch presets.** *"Load A1."*

Under the hood Claude reaches for one of the 17 unified-surface tools
(or one of the 13 generic-MIDI primitives if the device isn't a
registered one) and sends SysEx, CC, or NRPN to the device. Tool
round-trips land in roughly 30–60 ms; whole-preset builds take under
a second.

The unified surface (`set_param`, `get_param`, `apply_preset`,
`switch_preset`, `save_preset`, `switch_scene`, `set_block`,
`set_bypass`, `lookup_lineage`, `scan_locations`, `describe_device`,
...) works against any registered device. Pass the `port` argument and
the dispatcher routes to the right device. The device-namespaced tools
that remain (`am4_*`, `axefx2_*`, `hydra_*`) carry device-unique
capabilities with no cross-device equivalent (e.g. Axe-Fx II's
`axefx2_get_grid_layout` for the 4×12 routing grid, Hydrasynth's
`hydra_apply_patch` for its full NRPN-style patch dump). Per-device
behavioral guidance (channel/scene model, applicability rules, iconic-
amp tables) lives in `describe_device(port).agent_guidance`. Call it
once per session before any tone-building work.

Generic-MIDI primitives (`send_cc`, `send_note`, `send_program_change`,
`send_nrpn`, `send_sysex`, ...) work against any USB MIDI device the OS
exposes, not just registered hardware. See [Generic MIDI
quick-start](#generic-midi-quick-start) below.

---

## Requirements

- **Windows 10/11.** macOS / Linux builds are a future item (P5-006).
- At least one registered MIDI device connected by USB. Currently
  registered: **Fractal AM4** ([USB driver](https://www.fractalaudio.com/am4-downloads/)),
  **Fractal Axe-Fx II XL+** (Q8.02 firmware, hardware-verified),
  **Fractal Axe-Fx III** (🟡 community beta, see Status above),
  **ASM Hydrasynth Explorer** (firmware 1.5.x). Unregistered USB MIDI
  devices still work through the generic-MIDI primitives.
- A Claude client that supports MCP: [Claude Desktop](https://claude.ai/download),
  [Claude Code](https://docs.claude.com/en/docs/claude-code), or any
  other MCP-capable host.
- For source-installs only: Node.js 18+ and Visual Studio Build Tools
  (to compile the `midi` native module, published on npm as `midi`,
  source at [justinlatimer/node-midi](https://github.com/justinlatimer/node-midi)).
  The release ZIP bundles Node so end users do not need either.

Editor apps (AM4-Edit, AxeEdit, Hydrasynth Manager) can stay open
while the MCP server runs; Windows MIDI ports are shareable. If a
tool call doesn't reach the device, see the troubleshooting tips for
port-not-found errors. After install, run `verify-midi.cmd` to
confirm each device is visible to the server.

---

## Install

### From the release ZIP (recommended)

1. Download `mcp-midi-control-v0.1.0.zip` from [the latest release](https://github.com/TheAndrewStaker/mcp-midi-control/releases/latest).
2. Right-click the ZIP, choose Properties, tick **Unblock**, then
   click OK. (Windows tags downloaded files with a "came from another
   computer" flag; unblocking now avoids per-file warnings later.)
3. Extract the folder anywhere you like (your home directory, an
   Apps folder, wherever).
4. Make sure Claude Desktop is fully closed (system tray right-click
   → Quit, not just the window's X).
5. Double-click `setup.cmd` inside the extracted folder. A console
   window opens, registers the server with Claude Desktop, and waits
   for a keypress.
6. (Optional but recommended) Double-click `verify-midi.cmd`. It asks
   the OS directly which MIDI devices are visible and reports
   `[OK] Fractal AM4`, `[OK] Fractal Axe-Fx II`, etc., confirming the
   USB / driver side is healthy before you open Claude Desktop. If
   nothing is detected, the script prints driver download links and
   the next thing to try (usually replug the USB cable).
7. Open Claude Desktop. The mcp-midi-control server appears in the
   connector panel (the + button near the chat input).

To uninstall: double-click `uninstall.cmd` to remove the entry from
Claude Desktop's config (any other MCP servers you have stay intact),
then delete the extracted folder.

> **First time using it?** [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)
> walks through 6 day-one conversations with literal prompts to paste,
> expected behavior, and the audition-vs-save vocabulary. Read it
> before you ask Claude to "save" anything. Pair with
> [`docs/SAFETY-FOR-MUSICIANS.md`](docs/SAFETY-FOR-MUSICIANS.md) for
> the full trust model.

> **Note on signing.** This is an unsigned community release. Windows
> shows a "this came from another computer" warning until you Unblock
> the ZIP. The source is open here on GitHub if you want to read every
> line of the install scripts before running them.

### From source (for development or contributing)

Clone the repo, install dependencies, and run the hardware smoke test:

```bash
git clone https://github.com/TheAndrewStaker/mcp-midi-control.git
cd mcp-midi-control
npm install
npm run preflight    # typecheck + protocol goldens + MCP smoke test
npm run write-test   # changes amp gain on the device (confirms MIDI path)
```

If `write-test` flips the amp gain on the AM4's display, the hardware
path is good. Then register the server with Claude Desktop in one
command:

```bash
npm run setup-claude-desktop
```

This builds `dist/`, detects whether you have the direct-download or
Microsoft Store variant of Claude Desktop (or both), and writes our
entry into the right `claude_desktop_config.json` without disturbing
other MCP servers you have. Restart Claude Desktop fully (system tray
→ Quit) and the tools appear in the connector panel.

After source changes that touch `src/`, run `npm run setup-claude-
desktop` again (it re-runs the build + re-writes the config) and
restart Claude Desktop. Claude Desktop runs the compiled `dist/`
output, not the TypeScript source, so a rebuild is required for
changes to take effect.

> Windows-only for now. macOS / Linux source installs work (preflight
> + smoke pass cleanly) but the bootstrap script relies on PowerShell.
> Mac / Linux contributors hand-edit `claude_desktop_config.json` per
> [Connect to Claude](#connect-to-claude) Option 1 below.

---

## Connect to Claude

> If you installed from the release ZIP, `setup.cmd` already
> registered the server with Claude Desktop. Skip ahead to
> [Confirm it works](#confirm-it-works); the options below are for
> source installs and non-Claude-Desktop MCP clients.

### Option 1: Claude Desktop (GUI config)

Run `npm run build` first to produce `dist/`. Then edit Claude
Desktop's config and add the entry below.

**Where the config file lives:**

| Claude Desktop variant | Config path |
|---|---|
| Windows (direct download) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windows (Microsoft Store) | `C:\Users\<you>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

If the file doesn't exist, create it. If both Windows variants of
Claude Desktop are installed, edit both files. macOS users replace
the Windows path in the JSON below with their
`packages/server-all/dist/server/index.js` absolute path (e.g.
`/Users/you/code/mcp-midi-control/packages/server-all/dist/server/index.js`)
and use forward slashes.

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

Adjust the path. Fully quit Claude Desktop (system tray → Quit, not
just the window's ✕) and relaunch. The tools appear under the **`+`
button → Connectors** in a new chat.

> The bootstrap script `npm run setup-claude-desktop` automates all
> of this. It runs the build, detects which Claude Desktop variant(s)
> are installed, and writes the config without disturbing other MCP
> servers. Skip this option entirely if you ran that.

> **Why not `npx tsx <src/...>`?** It looks tempting (no build step!)
> but Claude Desktop spawns the MCP server with cwd set to
> `C:\Windows\System32`, so `tsx` can't find the project's workspace
> tsconfigs and intra-package imports fail to resolve. Pointing
> Claude Desktop at the built `packages/server-all/dist/server/index.js`
> sidesteps that: every cross-package import resolves through
> `node_modules` symlinks created by npm workspaces.

### Option 2: Claude Code (CLI)

From your project directory, after `npm run build`:

```bash
claude mcp add mcp-midi-control -- node C:\path\to\mcp-midi-control\packages\server-all\dist\server\index.js
```

Then start `claude` and the tools are available in your session.

### Option 3: Any MCP client (raw stdio)

For development, launch with:

```bash
npm run server   # tsx-based, picks up source changes immediately
```

For wiring into another MCP client (cwd-agnostic):

```bash
node C:\path\to\mcp-midi-control\packages\server-all\dist\server\index.js
```

The server speaks MCP over stdio in either case.

---

## MCP host compatibility

The server implements the open [Model Context Protocol](https://modelcontextprotocol.io)
spec, so it works with any spec-compliant MCP host. The protocol layer
is host-agnostic; only the config file location differs.

| Host | Status | Config location |
|---|---|---|
| **Claude Desktop** (Anthropic) | ✅ Primary target | `claude_desktop_config.json` (per-platform path; `npm run setup-claude-desktop` finds it for you) |
| **Claude Code** (CLI) | ✅ Tested | `claude mcp add` registers it; or `~/.claude.json` |
| **Cursor** | ✅ Spec-compliant, works | `.cursor/mcp.json` (project) or global settings |
| **Windsurf** (Codeium) | ✅ Spec-compliant | `~/.codeium/windsurf/mcp_config.json` |
| **Continue.dev** (VS Code) | ✅ Spec-compliant | `~/.continue/config.json` |
| **VS Code GitHub Copilot Chat** | ✅ Spec-compliant | VS Code settings → `chat.mcp.servers` |
| **Cline / Roo Code** (VS Code) | ✅ Spec-compliant | Extension-specific JSON |
| **LM Studio, Goose, Ollama-based hosts** | ✅ Most support MCP | Per-host config |
| **ChatGPT Desktop** (OpenAI) | 🟡 Partial. MCP support added 2025; tool descriptions on this project are large (~10 KB), may hit description-length limits in some surfaces | OS-specific |
| **Microsoft Copilot Studio** | 🟡 Better for cloud-hosted MCP servers than local-stdio | Azure-side |
| **Google Gemini first-party** | ⚠️ Native MCP not shipped at the time of writing; Gemini Extensions / function-calling is similar-but-distinct. Adapter layers exist | Adapter-specific |

The JSON shape is near-universal across hosts:

```json
{
  "mcpServers": {
    "mcp-midi-control": {
      "command": "node",
      "args": ["/path/to/packages/server-all/dist/server/index.js"]
    }
  }
}
```

What differs per host: the file location, the top-level key name (some
use `mcpServers`, some `mcp.servers`), and whether they honor `cwd` /
`env` fields (Claude Desktop does not honor `cwd`, which is why we
recommend the absolute-path-to-`dist` setup rather than `tsx` against
source). After editing whichever config your host uses, restart it.

Primary target is Claude Desktop because of how cleanly the
Connectors panel surfaces tool calls, but any spec-compliant host
should work. Hardware features (USB MIDI, the AM4 / Axe-Fx II
drivers) are the same regardless of host.

---

## Confirm it works

1. Open a new chat in your Claude client. Make sure the AM4 is powered
   on and connected by USB.
2. Ask: **"Using mcp-midi-control, list the MIDI ports you can see."**
   Claude calls `list_midi_ports` and reports a verdict like *"AM4
   detected (in: AM4, out: AM4)"*. If it says the AM4 isn't visible,
   replug the USB cable.
3. Ask: **"Place a compressor in slot 1 and set the level to 6."**
   Watch the AM4 display. Slot 1 should flip to Compressor and the
   level knob should jump to 6. Round-trip is under a second.

If step 3 works, you're done. Move on to building full presets.

### Troubleshooting

- **"AM4 not found in MIDI device list":** the server couldn't open
  the USB port. Check the AM4 is powered on, the USB cable is seated,
  and the driver is installed. Power-cycle the AM4 if needed.
- **Tool call hangs in Claude Desktop:** the server writes to MIDI
  synchronously, so hangs usually mean the `midi` native module
  couldn't load. Check Claude Desktop's MCP log for stderr output
  from the server.
- **Parameter out of range:** `set_param` validates against the
  parameter's `displayMin`/`displayMax`. Ranges are derived from the
  AM4's own metadata cache.

---

## The tool surface

Claude reaches for one of two cross-device tool families almost all
the time: the **unified surface** for any registered device (AM4,
Axe-Fx II, Hydrasynth), and the **generic-MIDI primitives** for any
other USB MIDI gear. Together that's 30 tools, the surface a guitarist
actually needs to learn. The device-namespaced tools (`am4_*`,
`axefx2_*`, `hydra_*`) are a smaller surface kept for capabilities the
tool contract doesn't yet cover; they're documented in the
[device-namespaced appendix](#appendix--device-namespaced-tools) at
the end.

### Unified surface (17 tools): same name, every device

Pass `port` to select which device (id, display_name, or any MIDI
port-name substring match). Adding a new device means writing a schema
descriptor + wire adapter; no new tools.

| Tool | What it does |
|---|---|
| `describe_device(port)` | Capabilities + canonical vocabulary + block roster. Pure introspection. Call once per session to learn what a device offers. |
| `list_params(port, block?, name?)` | Enumerate named params. With `block`+`name` on an enum-typed param, returns the full enum table. |
| `get_param(port, block, name, channel?)` | Single read, returns display-shaped value. |
| `set_param(port, block, name, value, channel?)` | Single write. Display values for numerics ("4.5"); enum names or wire index for enums. |
| `get_params(port, queries[])` | Batch read. Continues past per-query failures. |
| `set_params(port, ops[])` | Atomic batch write; validates every entry up-front. |
| `set_block(port, slot, block_type)` | Place/clear a block at a slot. |
| `set_bypass(port, block, bypassed)` | Silence/activate a block on the active scene. |
| `apply_preset(port, spec, target_location?)` | Build a whole preset in one call (blocks + params + scenes + name). Without `target_location`, writes to the working buffer only; with it, switches to the target slot and saves. |
| `apply_setlist(port, entries[])` | Batch preset write across N entries. Each entry has the same shape as `apply_preset`. |
| `switch_preset(port, location)` | Load a stored preset into the working buffer. |
| `save_preset(port, location, name?)` | Persist working buffer (optional rename first). Only on explicit user save phrase; apply_preset is reversible, save_preset is not. |
| `switch_scene(port, scene)` | Switch scene. Capability-gated (devices without scenes reject). |
| `rename(port, target, name)` | Rename `'preset'` or `'scene:N'`. Working-buffer scope; pair with `save_preset` to persist. |
| `scan_locations(port, from, to)` | Bulk-scan stored preset names across a location range. Setlist-load opener. |
| `lookup_lineage(port, block_type, query)` | Authored lineage data: real-hardware inspiration, manufacturer/model, developer quotes. AM4 + Axe-Fx II ship lineage corpora. |
| `restore_defaults(port, from, to?)` | Reset a single location or inclusive range to factory state. Capability-gated; only devices with `supports_factory_restore=true` (currently AM4) honor it. |

### Generic MIDI primitives (13 tools)

Work with any USB MIDI device the OS exposes, registered or not.
Channels are 1..16 at the tool boundary (musician convention); the
wire layer converts to 0..15 once. Reach for these when the target
device doesn't have a registered descriptor yet, or when you want
to send raw MIDI rather than addressing named params. Conversational
examples in [Generic MIDI quick-start](#generic-midi-quick-start)
below.

| Tool | What it does |
|---|---|
| `send_cc` | Send a Control Change. Channel 1..16, controller 0..127, value 0..127. |
| `send_note` | Play a note (Note On + Note Off after `duration_ms`, default 500, max 5000). |
| `send_program_change` | Switch patches. Optional Bank Select MSB/LSB prefix. |
| `send_nrpn` | Write a Non-Registered Parameter Number. 7-bit by default; `high_res: true` unlocks 14-bit values (0..16383). |
| `send_sysex` | Send a raw System Exclusive frame. Validates F0/F7 framing; otherwise sends bytes verbatim. |
| `send_panic` | All notes off + reset controllers across all 16 channels. |
| `send_pitch_bend` | 14-bit pitch bend (-8192..+8191). |
| `send_channel_pressure` | After-touch / aftertouch on a channel. |
| `send_song_position` | MIDI clock song-position pointer. |
| `send_reset_controllers` | Reset all controllers on a channel. |
| `send_clock_start` / `_stop` / `_continue` | MIDI clock transport commands. |
| `list_midi_ports` | Enumerate input/output ports the OS exposes. |
| `reconnect_midi` | Force-reopen a stale MIDI handle. |

Full tool descriptions surface inside Claude automatically (just ask).

---

## Generic MIDI quick-start

The five `send_*` primitives let Claude drive any MIDI device with a
published implementation chart. Below are conversational examples
targeting non-AM4 gear so the generality is obvious; substitute the
`port` substring for whatever name your device shows up as in
`list_midi_ports`.

**Tweak a synth filter cutoff (CC 74).** Most synths follow the standard
MIDI CC chart for tone-shaping controls.

> *"Set the filter cutoff on my Hydrasynth to 80."*

Claude calls:

```
send_cc { port: "hydra", channel: 1, controller: 74, value: 80 }
```

**Play a single note.** Useful for confirming a synth is responding and
for one-shot triggers.

> *"Play middle C on the Hydrasynth for half a second."*

```
send_note { port: "hydra", channel: 1, note: 60, velocity: 100, duration_ms: 500 }
```

**Switch patches with a bank select.** Devices that expose more than 128
patches need a Bank Select prefix before the Program Change.

> *"Load patch 12 on bank 2 of the Hydrasynth."*

```
send_program_change { port: "hydra", channel: 1, program: 12, bank_msb: 0, bank_lsb: 2 }
```

**Address a 14-bit NRPN.** Some synths expose deeper engine controls
through NRPN at higher resolution than CC.

> *"Set Hydrasynth NRPN parameter (0, 74) to 8192 in 14-bit mode."*

```
send_nrpn { port: "hydra", channel: 1, parameter_msb: 0, parameter_lsb: 74, value: 8192, high_res: true }
```

**Send a raw SysEx frame.** The escape hatch for ad-hoc reverse
engineering or one-offs that don't have a wrapper yet.

> *"Send these bytes to the AM4 verbatim: F0 00 01 74 15 12 4A 48 F7"*

```
send_sysex { port: "am4", bytes: [0xF0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x4A, 0x48, 0xF7] }
```

Tools default to the AM4 only on `reconnect_midi` and `list_midi_ports`;
every `send_*` tool requires the `port` argument explicitly so there's
no ambiguity about which device is being driven.

---

## Opinionated UX guarantees

This project takes opinionated stances about destructive operations
on your hardware. Across **every** supported device (AM4, Axe-Fx II,
Hydrasynth, and any device added later), the same rules apply:

**No silent saves.** When you ask Claude to "build a tone at A3" (AM4)
or "build a tone at slot 614" (Axe-Fx II) the tool builds it in the
working buffer (you can audition immediately) but does **not** save
unless you also said "save it" / "store it" / "put it on A3" / similar.
The only exception is multi-preset requests ("build a setlist for
G1-G4"), where save intent is implicit because a setlist without
persistence isn't a setlist.

**No silent edit loss.** If you've been tweaking a preset and then ask
Claude to do something that would navigate away from it (load another
preset, build at a different slot), the tool refuses and asks "you
have unsaved edits on slot Y, save first, discard, or cancel?" before
it touches anything. The dirty-state detection is device-sourced where
the hardware exposes it (Axe-Fx II via state-broadcast, confirmed) and
heuristic-fallback where it doesn't (AM4 pending decode, Hydrasynth has
no MIDI-exposed dirty signal; limitations are documented per-tool).

**No silent overwrites.** Multi-preset requests pre-flight scan the
target range before writing. If any target slot already holds a named
preset, the tool surfaces what would be lost so Claude can ask you to
confirm before proceeding.

**Every write is acknowledged.** `set_param` and friends wait for the
device's write echo (up to 300 ms on AM4, configurable on Axe-Fx II)
before returning success. "The tool succeeded" means "the device
actually took the write." No silent fail.

**Read-only probes stay read-only.** `scripts/probe.ts` and the
`axefx2_probe_sysex` diagnostic tool never issue store/save SysEx;
they're the designated safe introspection paths for protocol RE.

See [`docs/SAFE-EDIT-WORKFLOW.md`](./docs/SAFE-EDIT-WORKFLOW.md) for
the full contract, including the per-device implementation table and
the test scenarios every device must pass.

---

## Project layout

The source is organized as five npm workspace packages under
`packages/`. Each package builds independently to its own `dist/`
and depends on `@mcp-midi-control/core` for cross-device foundations.

```
packages/
├── core/                         # @mcp-midi-control/core
│   └── src/
│       ├── midi/                 #   node-midi transport + message builders
│       ├── fractal-shared/       #   checksum, packValue, device base,
│       │                         #     lineageLookup + lineage JSON data
│       ├── protocol-generic/     #   dispatcher + unified tool surface
│       └── server-shared/        #   connection registry, safeEdit,
│                                 #     bufferDirty
├── am4/                          # @mcp-midi-control/am4
│   └── src/
│       ├── tools/                #   AM4 MCP tool surface (split by family)
│       └── (params, setParam, blockTypes, locations,
│            factoryBank, midi.ts, descriptor/, …)
├── axe-fx-ii/                    # @mcp-midi-control/axe-fx-ii
│   └── src/
│       ├── tools/                #   Axe-Fx II XL+ tool surface
│       └── (params, setParam, blockTypes, midi.ts, descriptor/, …)
├── hydrasynth/                   # @mcp-midi-control/hydrasynth
│   └── src/
│       ├── tools/                #   Hydrasynth tool surface (single-file
│       │                         #     pattern; NRPN-driven engine)
│       └── (params, encoding.ts, sysexEnvelope.ts, midi.ts, …)
└── server-all/                   # @mcp-midi-control/server-all
    └── src/
        ├── server/               #   MCP server boot
        │   ├── index.ts          #     one register*Tools(server) call
        │   │                     #     per device + 2 generic-MIDI families
        │   └── tools/            #   device-AGNOSTIC tool families
        │       ├── midi-primitives.ts   # send_cc / _note / _nrpn / _sysex
        │       └── midi-control.ts      # list_midi_ports / reconnect_midi
        ├── cli/                  #   verify-midi.ts entry point
        └── fractal-registry/     #   v0.1.1+ scaffolding for runtime
                                  #     device-identify

docs/                             # protocol reference, decisions, research
samples/captured/                 # RE captures + decoded cache data (gitignored)
scripts/                          # probes, verifiers, smoke test
```

**Adding a new device.** Stand up a new workspace package under
`packages/<vendor>-<device>/` (mirror axe-fx-ii's layout). Implement
a `DeviceDescriptor`, register it in
`packages/server-all/src/server/index.ts`, and add the package as a
dependency in `packages/server-all/package.json`. The unified tool
surface (`set_param`, `apply_preset`, etc.) automatically dispatches
to your device once the descriptor is registered. No new tools needed.

- [`docs/03-ARCHITECTURE.md`](./docs/03-ARCHITECTURE.md): system overview
  + per-layer responsibilities.
- [`docs/SYSEX-MAP.md`](./docs/SYSEX-MAP.md): AM4 wire protocol reference.
- [`docs/SYSEX-MAP-AXE-FX-II.md`](./docs/SYSEX-MAP-AXE-FX-II.md):
  Axe-Fx II wire protocol reference.
- [`docs/DECISIONS.md`](./docs/DECISIONS.md): non-obvious architectural
  + library choices, with rationale and rejected alternatives.

---

## Appendix: Device-namespaced tools

The 25 device-namespaced tools (`am4_*`, `axefx2_*`, `hydra_*`) are
the ones with semantics the unified surface doesn't yet cover:
device-state reads, grid-specific writes, raw-protocol probes. Most
day-one tone-building won't need them: `apply_preset`, `set_param`,
`switch_preset`, etc. on the unified surface handle the common path.
Reach for these when you need device-specific introspection or
hardware that has no cross-device equivalent (e.g. the Axe-Fx II
4×12 routing grid). Pass `port='am4' | 'axe-fx-ii' | 'hydrasynth'`
to target a device on any unified tool.

### AM4 (5 tools): device-state reads + non-destructive working-buffer dump

| Tool | What it does |
|---|---|
| `am4_get_active_location` | Read the currently-loaded preset location (A1-Z4). |
| `am4_get_active_scene` | Read which scene (1..4) is currently selected. |
| `am4_get_block_layout` | Read what's in each of the four signal-chain slots. |
| `am4_get_block_bypass` | Read whether a block is bypassed in the active scene. |
| `am4_request_active_buffer_dump` | Non-destructive full working-buffer dump (advanced; for protocol RE). |

### Axe-Fx II XL+ (10 tools): grid reads, cell-level placement, raw-protocol probes

| Tool | What it does |
|---|---|
| `axefx2_get_active_preset_number` | Read the currently-loaded preset number. |
| `axefx2_get_preset_name` | Read the active preset's stored name. |
| `axefx2_get_grid_layout` | Read the 4×12 routing grid: block ID + input mask per cell. |
| `axefx2_get_block_channel` | Read which channel (X / Y) a block is currently on. |
| `axefx2_set_block_channel` | Switch a block's channel (X / Y). |
| `axefx2_set_block_at_cell` | Place a single block at a specific `(row, col)`. Multi-row placement is exposed here. |
| `axefx2_set_cell_routing` | Add or remove a cable between two adjacent-column grid cells. Cross-row cables (parallel chains, FX loops, mergers) are supported. |
| `axefx2_test_apply` | Working-buffer apply + chain-integrity verify in one call. Returns `ok=true` only if every cell past col 1 has a non-zero routing mask. |
| `axefx2_probe_sysex` | Raw SysEx send + inbound capture. Developer tool for protocol RE. |
| `axefx2_reconnect_midi` | Force-reopen the Axe-Fx II MIDI handle. |

### ASM Hydrasynth Explorer (11 tools): patch-based architecture (no scenes); NRPN-driven engine

| Tool | What it does |
|---|---|
| `hydra_apply_init` | Dump the factory INIT patch via SysEx (resets the active patch to defaults). |
| `hydra_apply_init_to` | Same as `hydra_apply_init`, targeting a named slot. |
| `hydra_apply_patch` | Build a full patch with sparse overrides on top of the factory INIT buffer. Optional `save: true` (gated by `save_authorized`). |
| `hydra_set_param` | Set a system CC (master volume, mod wheel, sustain). 7 system params only. |
| `hydra_set_engine_param` | Set one of 1175 engine params (oscillators / filters / envelopes / FX) via NRPN. |
| `hydra_set_engine_params` | Batch engine-param write; same shape as `hydra_set_engine_param`. |
| `hydra_set_macro` | Set a macro (1..8) value. |
| `hydra_play_note` | Send a Note On + Note Off pair to the device for audition. |
| `hydra_get_active_patch` | Read the active patch's bank/slot indices. |
| `hydra_navigate_to` | Navigate to a specific Bank/Patch on the device. |
| `hydra_reconnect_midi` | Force-reopen the Hydrasynth MIDI handle. |

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Short version: run
`npm run preflight` locally before opening a PR, and add a byte-exact
golden against a real capture if you touch the wire protocol.

Security issues: see [`SECURITY.md`](./SECURITY.md).

---

## License

Apache License 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
