# Architecture: MCP MIDI Control

## System Overview

This is an open-source MCP server for controlling music gear over USB
MIDI through natural-language conversation. It is device-agnostic by
design: a single unified dispatcher fans out every tool call to a
registered device descriptor over one shared transport, so the same
instruction behaves the same whether the target is a guitar amp modeler
or a synthesizer. The opinionated rules that make control trustworthy
are universal, applied to every device rather than coded per device:

- Display-first I/O (front-panel units, never wire bytes).
- No silent saves, no silent edit loss, no silent overwrites.
- Every write is acknowledged.
- Tempo-first, read-before-write.

Consistency across devices is a core value. Adding a device is a
descriptor, not a new set of tools, and synthesizers are first-class
targets rather than an afterthought. Any USB MIDI device works today via
generic-MIDI primitives (CC, NRPN, SysEx, program change, notes, clock).
Hardware-verified depth (whole-preset and whole-patch authoring, lineage,
cross-device translation) currently covers the Fractal AM4, Axe-Fx II
XL+, and ASM Hydrasynth Explorer. Several more devices are in community beta:
the modern Fractal family (Axe-Fx III / FM3 / FM9 / VP4), the original Axe-Fx
Standard/Ultra, the Novation Circuit Tracks (a groovebox sequencer), the Roland
SPD-SX (a sample pad on a hybrid storage/MIDI transport), the Boss VE-500 vocal
processor, and the Boss RC-505mk2 Loop Station (a looper on a hybrid
storage/MIDI transport whose memories are authored as `.RC0` files). Each is a
descriptor on the same unified surface, not a new tool family.

AM4 is used as the running example throughout this doc because it is the
device with the deepest decode, not because it is the whole picture.
Wherever AM4 appears below, read it as "one registered device descriptor
among several," all selected with the `port` argument on each tool call.

```
┌─────────────────────────────────────────────────────┐
│  Claude Desktop (claude.ai)                         │
│  User types: "Amber by 311, 4 scenes"               │
└──────────────────────┬──────────────────────────────┘
                       │ MCP protocol (stdio)
┌──────────────────────▼──────────────────────────────┐
│  MCP Server  (Node.js / TypeScript)                 │
│  - Tool definitions + per-tool agent guidance       │
│  - Tone research / lineage context                  │
│  - Safe-edit gates (dirty buffer, save auth)        │
│  - Unified dispatcher: routes each call by `port`   │
│    to a registered device descriptor                │
└──────────────────────┬──────────────────────────────┘
                       │ TypeScript function calls (dispatch by port)
┌──────────────────────▼──────────────────────────────┐
│  Device-package layer  (one package per device)     │
│                                                     │
│   AM4        Axe-Fx II     Hydrasynth   Axe-Fx III  │
│  (verified) (verified)    (verified)    (beta)      │
│                                                     │
│  Each package owns its descriptor (reader +         │
│  writer adapters). Wire codec (SysEx encode/decode, │
│  checksums, block/param tables, preset format)      │
│  lives in the shared fractal-midi package.          │
└──────────────────────┬──────────────────────────────┘
                       │ @julusian/midi (shared transport)
┌──────────────────────▼──────────────────────────────┐
│  USB/MIDI Transport                                 │
│  - Per-device USB drivers (Windows)                 │
│  - @julusian/midi input/output ports                │
└──────────────────────┬──────────────────────────────┘
                       │ USB cable
┌──────────────────────▼──────────────────────────────┐
│  Hardware: AM4 / Axe-Fx II / III / FM3 / FM9 /      │
│  VP4 / gen-1, ASM Hydrasynth, Circuit Tracks,       │
│  Roland SPD-SX, Boss VE-500, or any USB MIDI        │
│  device (via the generic-MIDI primitives)           │
└─────────────────────────────────────────────────────┘
```

---

## Layer Responsibilities

### 1. MCP Server (`packages/server-all/`)

The Claude-facing interface. `packages/server-all/src/server/index.ts`
is boot + register-loop only. Pure orchestration plus per-tool agent
guidance; no MIDI logic at this layer.

```
packages/server-all/src/
  server/
    index.ts                  ← boot + transport + descriptor registration
    tools/
      midi-primitives.ts      ← send_cc / _note / _program_change /
                                   _nrpn / _sysex (any MIDI device)
      midi-control.ts         ← list_midi_ports / reconnect_midi
```

### 2. Tool surface (`packages/core/src/protocol-generic/`)

The registered tool surface is four families. The unified, device-agnostic
family is the largest: it dispatches every call through the `port` argument
to a registered `DeviceDescriptor`, so adding a device adds no tools. The
other three families are voice-class tools (synth patch authoring plus
mod-matrix and macro routing by name), generic-MIDI primitives (CC, note,
NRPN, SysEx, transport, and friends that reach any USB MIDI device), and
two transport utilities. See [`docs/TOOLS.md`](TOOLS.md) for the full
per-tool list and the current count.

The unified family covers describe / list / read / write / block-placement /
whole-preset apply / preset translation / navigation / save / scene / scan /
lineage / compatible-type discovery. Each unified tool resolves its target
device from `port` and calls into that device's reader or writer adapter.

```
packages/core/src/
  midi/transport.ts           ← MidiConnection interface + AM4 connector
  protocol-generic/
    types.ts                  ← DeviceDescriptor, DeviceWriter, DeviceReader,
                                  PresetSpec, WriteResult, etc.
    registry.ts               ← registerDevice / requireDevice / resolveDevice
    dispatcher/               ← per-family dispatch (params, navigation, preset)
    tools/                    ← MCP tool registrations (param, nav, preset,
                                  discovery)
  server-shared/
    connections.ts            ← per-port MIDI registry, ensureConnection
    bufferDirty.ts            ← shared dirty-flag tracker (cross-device)
    safeEdit.ts               ← save_authorized + on_active_preset_edited
                                  guard helpers
  fractal-shared/
    lineage/loudness.json     ← per-amp / per-drive loudness corpus
                                  (the rest of the lineage data lives
                                  in fractal-midi; see below)
```

**Lineage data lives in the codec package.** The amp / drive / cab / wah
lineage JSON (the bulk of the corpus, hundreds of entries with
designer quotes and Fractal Cab Pack attributions) is in the
`fractal-midi` package at `src/shared/lineage/`. This MCP server consumes
it via the `fractal-midi` npm dep. Editing lineage data is a fractal-midi
change, not a top-level mcp-midi-control change; see
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for the package layout.

The `lookup_lineage` engine (the search + format step) lives at
`packages/core/src/protocol-generic/dispatcher/discovery.ts`
(executeLookupLineage); per-device readers contribute a
`reader.lookupLineage` hook in their descriptor.

### Preset-class architecture

Devices fall into one of three preset-shape classes. Each class has
exactly one canonical "apply the whole preset" tool. New devices
declare their class via `descriptor.preset_class` and inherit the
matching tool surface, with no per-device apply tool proliferation.

| Class | Shape | Apply tool | Example devices |
|---|---|---|---|
| **layout** | Signal chain: blocks at slots (linear int or grid `{row,col}`), per-block channels, scenes, optional routing edges. The preset is a topology graph. | `apply_preset` | Fractal AM4, Axe-Fx II, Axe-Fx III, FM9, Line 6 Helix, Boss VE-500 (vocal FX chain), Strymon BigSky multi-FX |
| **voice** | Sparse override on a fixed-topology synth voice or fixed-pad sampler. Every patch has the same module layout (osc / filter / env / lfo / fx on synths; pad1 / pad2 / pad3... / master FX on samplers); the agent authors a flat map of named param overrides on top of an INIT buffer. | `apply_patch` | ASM Hydrasynth, Roland SPD-SX (drum sampler, 9-pad fixed topology), future Roland synths, Prophet-X, Sub37 |
| **effect** | Flat name/value param map. No slots, no routing, no scenes: single algorithm or single-effect-per-preset. | `apply_settings` *(planned)* | Strymon single-effect pedals (Timeline, Mobius), Eventide H9 single-algorithm presets, MXR Carbon Copy MIDI |

**Why three tools, not one.** The semantic gap between layout and
voice classes is real: `apply_preset`'s `PresetSpec` requires
`slots[].block_type` from a cross-device union, and synth-voice modules
(`osc1` / `filter1` / `env1`) aren't in that union because they're
not placement-shaped on a signal chain. Forcing voice-class devices
through `apply_preset` would mean the schema accepts free-string
block_types (defeating the strict enum that makes apply_preset
reliable for layout devices), and the agent would have to learn two
different meanings of "slot" / "block_type" depending on port.
Each class gets its own tool with its own input shape.

**Why the class doesn't proliferate per-device.** Adding a Roland
synth means writing a `DeviceDescriptor` with `preset_class:'voice'`
and a writer that consumes the existing `apply_patch` input shape.
`apply_patch` is class-shaped, not device-specific: it carries a sparse
override map that any voice-class device can interpret. Voice-class
devices also expose mod-matrix and macro routing by name
(`set_mod_route`, `set_macro_route`), so the agent can wire an LFO to a
filter or a macro to a destination using the names a player reads on the
panel rather than raw matrix indices.

**Tool surface by class:**

| Tool family | Cross-class? | Per-class details |
|---|---|---|
| `set_param` / `set_params` / `get_param` / `get_params` | Yes | Same shape; device writer interprets the (block, name, value) tuple. |
| `set_block` / `set_bypass` / `switch_scene` | Layout only | Voice + effect devices return `capability_not_supported`. |
| `apply_preset` | Layout only | The 3-input-mode tool (`spec` / `recipe_id` / `recipe_id` + `overrides`). |
| `apply_patch` | Voice only | Sparse override map shape. |
| `apply_settings` | Effect only | (Planned.) Flat name/value map. |
| `describe_device` / `list_params` / `lookup_lineage` / `switch_preset` / `save_preset` | All classes | Discovery + navigation are uniform. |

### 3. Device packages

Each device lives in its own workspace package with no cross-device
dependencies (all depend on `@mcp-midi-control/core` only):

```
packages/am4/src/
  descriptor.ts       ← AM4 DeviceDescriptor (reader + writer adapters)
  descriptor/
    reader.ts         ← get_param / get_params / scan_locations
    writer.ts         ← set_param / apply_preset / save_preset / etc.
    agentGuidance.ts  ← AM4-specific guidance surfaced via describe_device
  params.ts           ← KNOWN_PARAMS registry (pidLow/pidHigh, range, enums)
  blockTypes.ts       ← block-name ↔ pidLow lookup
  locations.ts        ← A01..Z04 ↔ index conversion
  setParam.ts         ← wire-byte builders (buildSetParam, buildSetBlockType…)
  applicability.ts    ← type-gated knob applicability
  tools/
    applyExecutor.ts  ← apply_preset core logic (validation + wire-send)
    navigation.ts     ← switch_preset / save_preset / scan_locations
    safeEdit.ts       ← AM4-specific guardActiveBufferOrSave

packages/fractal-gen2/src/
  descriptor.ts       ← Axe-Fx II DeviceDescriptor
  midi.ts             ← bidirectional MIDI handle + dirty-state classifier
  setParam.ts         ← wire-byte builders (buildSetBlockParameterValue…)
  params.ts           ← KNOWN_PARAMS registry
  tools.ts            ← device-namespaced tools (code preserved, not registered)

packages/fractal-gen3/src/
  factory.ts          ← createModernFractalDescriptor (gen-3 family: III/FM3/FM9/VP4)
  catalog.ts          ← createModernCatalog (shared block roster + per-device params)
  configs/            ← per-device configs (axe-fx-iii, fm3, fm9, vp4)
  device.ts           ← exports AXEFX3_DESCRIPTOR / FM3_DESCRIPTOR / FM9_DESCRIPTOR
                          / VP4_DESCRIPTOR
                          (community beta: write ops attempt the wire and surface
                          any device rejection inline rather than refusing)

packages/hydrasynth/src/
  descriptor.ts       ← Hydrasynth DeviceDescriptor
  server.ts           ← device-namespaced tools (code preserved, not registered
                          except Hydra-specific tools not yet on unified surface)
```

**Adding a new device.** Write a `DeviceDescriptor` (copy
`packages/fractal-gen3/src/descriptor.ts` as a template), register it
in `packages/server-all/src/server/index.ts` before any descriptor
whose `port_match` regex it would shadow, and add the package to the
root `typecheck` + `build` scripts. See `CONTRIBUTING.md` §"Adding a
new device" for the step-by-step.

**Safety rules enforced uniformly via the unified surface:**
- `apply_preset(target_location)` defaults to `save_authorized: false`
  (audition-at-target). Requires explicit `save_authorized: true` plus
  user save-intent language to persist.
- `on_active_preset_edited` guard on every navigation tool refuses
  before losing unsaved edits, offers save/discard/cancel.
- Factory preset verification: pre/post-name comparison catches
  no-op restores when restoring via device-native flows.

### 4. Device-package layer (`packages/am4/`, `packages/fractal-gen2/`, ...)
Pure TypeScript. No Claude, no MCP at this layer. Each device package
owns its descriptor plus the device-specific reader, writer, and wire
builders, and is testable in isolation against captured wire bytes via
`scripts/verify-msg.ts` and friends.

`packages/am4/` is the example here; `packages/fractal-gen1/`
(descriptor-only), `packages/fractal-gen2/`, `packages/fractal-gen3/`,
and `packages/hydrasynth/` follow the same layout. The shared wire codec (envelope, checksum, septet encoding,
param dictionaries, preset format) lives in the `fractal-midi` package,
which every device package imports. Each device's wire handling is
self-contained on top of that shared codec.

### 5. Preset representation

The device-agnostic preset format is `PresetSpec` (write-side input for
`apply_preset`) and `PresetSnapshot` (read-side output from
`get_preset`). Both are defined in
`packages/core/src/protocol-generic/types.ts`. `PresetSpec` carries
per-slot block placement, per-channel params, scene bypass/channel
state, and optional routing edges. Each device's writer converts
`PresetSpec` into wire-native SysEx; each device's reader converts
wire responses back into `PresetSnapshot`.

### 6. Transport Layer (`packages/core/src/midi/`)
Thin wrapper around @julusian/midi (an API-compatible node-midi fork with N-API prebuilds). Handles port discovery, connection
lifecycle, and raw SysEx send/receive. The transport interface is
`MidiConnection` (defined in `packages/core/src/midi/transport.ts`),
which provides `send`, `request`, `onMessage`, and connection
management methods.

#### Transport abstraction (two layers)

Devices reach the host over more than one kind of pipe, and the
abstraction lives at two distinct layers; pick the right one when adding
a device:

- **Byte-stream layer: `MidiConnection`.** Anything that carries raw MIDI
  byte frames is a `MidiConnection`, regardless of the physical pipe. USB
  MIDI and the FM3's USB-CDC serial both live here: the FM3's
  `serialTransport.ts` implements `MidiConnection` over serial because
  serial just carries the same MIDI bytes through a different pipe. A new
  MIDI-over-X transport is a new `MidiConnection` implementation.

- **Endpoint layer: `DispatchCtx` / `openCtx`.** Some devices are not a
  MIDI byte stream at all. The Roland SPD-SX in WAVE MGR mode is a mounted
  USB mass-storage volume whose kits/waves are `.spd` files, a filesystem,
  not a stream of MIDI messages. That can never be a `MidiConnection`, so
  the generalization happens one level up, at the dispatch context.

`DeviceDescriptor.transport` declares the kind:

| `transport.kind` | Endpoint | `DispatchCtx` carries |
|---|---|---|
| `'midi'` (default) | USB MIDI port (via `ensureConnection`) | `conn` |
| `'serial'` | USB-CDC serial (FM3) | `conn` (serial-backed `MidiConnection`) |
| `'storage'` | mounted drive (`resolveRoot()`) | `storage.root` (+ a null-object `conn`) |
| `'hybrid'` | resolved at call time | `storage.root` if mounted, else MIDI `conn` |

`openCtx` (`dispatcher/core.ts`) branches on `transport.kind`. For
`'storage'` it requires a mounted root or throws `device_not_mounted`; the
`conn` it returns is a null object that throws on any MIDI I/O, so a
storage device's reader/writer methods read `ctx.storage.root` and never
touch the wire. Existing MIDI devices omit `transport` (default `'midi'`)
and are completely unaffected; `conn` stays required and the ~156
`ctx.conn` call sites are untouched.

**Hybrid devices** (SPD-SX) expose both surfaces on one descriptor, with
the two USB modes mutually exclusive on the hardware. `openCtx` resolves
the live transport per call: drive mounted → the storage reader/writer
methods (kit/wave authoring); else a MIDI port → the MIDI methods (kit
recall via `switch_preset`, pad triggers). A verb that needs the other
mode returns `capability_not_supported`. The full reasoning is in
[docs/design/device-archetypes-and-transport.md](design/device-archetypes-and-transport.md).

### 7. Audio sensing layer (`packages/core/src/audio/`)

A third sensing surface next to MIDI and storage: the OS audio layer,
read-only, never device-gated. `measure_loudness` captures N seconds from
any OS audio input (a modeler's own USB audio interface, a mic, an
interface bus) and returns ITU-R BS.1770 loudness (integrated LUFS,
momentary max, 4x-oversampled true peak). The measurement math
(`bs1770.ts`) is pure dependency-free TypeScript, golden-checked against
the spec's published coefficient table and cross-checked against ffmpeg's
`ebur128` filter. Capture (`capture.ts`) rides `audify` (RtAudio over
N-API, WASAPI/CoreAudio/ALSA) as an *optional* dependency, lazy-loaded at
call time: a platform without the prebuild keeps the full MIDI surface and
reports capture-unavailable only when asked to listen.

This is deliberately a rig capability, not a device feature: the same tool
levels AM4 scenes (which have no meter read over MIDI), balances looper
loops against a modeler, or checks a synth against the guitar bus. Writes
stay in the existing per-device paths behind the existing gates; the audio
layer only ever listens.

---

## Location Naming Convention
The AM4 uses Fractal's native bank/letter system. The app uses this natively.
A location is where a preset is stored; it is not a signal-chain slot.

```
Format: [Bank Letter][Two-digit number]
Banks:     A through Z (26 banks)
Locations: 01 through 04 per bank (4 locations each)
Total:     104 preset locations

Examples:
  A01: Bank A, location 1 (first factory preset)
  Z04: Bank Z, location 4 (last location, #104)
  M02: Bank M, location 2

Flat index mapping (for internal use):
  index = (bankIndex * 4) + (locationNumber - 1)
  A01 = 0, A02 = 1, A03 = 2, A04 = 3, B01 = 4 ...
```

---

## Preset Safety System

Every navigating or persisting tool enforces three gates uniformly across
devices. The full contract, per-device implementation status, and fallback
rules are in [`docs/SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md). In short:

1. **Buffer-dirty gate** (`on_active_preset_edited`). Check whether the
   working buffer holds unsaved edits before navigating away. If it does and
   the caller did not pass `discard` or `save_active_first`, refuse with a
   structured warning instead of silently losing the edit.
2. **Save-authorization gate** (`save_authorized`). Tools that apply and
   persist in one call default to `false` and refuse to write to a location
   unless the agent passes `true`, which it does only when the user used
   save-intent language. Applying a preset is reversible; saving is not.
3. **Multi-preset overwrite gate.** Tools that touch a range of locations
   pre-flight scan the targets and surface what would be overwritten before
   writing anything.

---

## Repo Structure
```
mcp-midi-control/
  packages/
    fractal-midi/   Pure-TypeScript wire codec, published to npm. Builders,
                       parsers, param dictionaries, block tables, checksums,
                       calibration, lineage data. No MIDI transport, no MCP.
                       Builds first; every device package imports from it.
    core/           Cross-device foundation (MidiConnection transport,
                       unified dispatcher, DeviceDescriptor types,
                       server-shared safe-edit + connection helpers,
                       fractal-shared loudness corpus)
    am4/            Fractal AM4 descriptor (reader + writer adapters)
    fractal-gen1/   Fractal Axe-Fx Standard/Ultra (gen-1) community-beta descriptor
    fractal-gen2/   Fractal Axe-Fx II XL+ descriptor
    fractal-gen3/   Modern Fractal family (Axe-Fx III / FM3 / FM9 / VP4)
                       community-beta descriptors
    hydrasynth/     ASM Hydrasynth descriptor (Explorer / KB / Deluxe / Desktop)
    server-all/     MCP server entry point (composes all device packages)
  scripts/
    verify-*.ts     Byte-exact golden verifiers (run without hardware)
    mcp-*.ts        Hardware integration test harnesses
    capture-*.ts    Passive MIDI capture utilities
    launch-verification.ts  Full end-to-end smoke test (requires hardware)
  samples/          Local-only debug scratch (entire dir gitignored)
    factory/        Factory .syx preset files
    captured/       Captured MIDI traffic sessions
  docs/
    ARCHITECTURE.md       This file
    TOOLS.md              Full registered tool surface (the authoritative count)
    BLOCK-PARAMS.md       AM4 block parameter tables (MCP contract)
    SAFE-EDIT-WORKFLOW.md Cross-device safe-edit contract
    community/            Contributor guides (device capture workflows)
  CLAUDE.md         Context file for Claude Code
  CONTRIBUTING.md   Contributor guide
  package.json      npm workspace root
  tsconfig.json     Root path mappings for tsx script resolution
```

Protocol reverse-engineering docs (per-device SYSEX-MAP, opcode tables,
capture guides, Ghidra mining scripts, and the encoding-primitive corpus) live in
the `fractal-midi` package under `packages/fractal-midi/docs/`, not in this
top-level `docs/` tree. Wire-format questions start there.

---

## Development Stages

### Feasibility scripts
`scripts/probe.ts` proves USB MIDI communication works.
`scripts/sniff.ts` captures AM4-Edit traffic for analysis.
No MCP yet. Pure Node.js CLI.

### Protocol layer
Build encoder/decoder from sniffed data.
`scripts/diff-syx.ts` and `scripts/annotate.ts` support this.
Full unit test coverage of round-trips before moving on.

### MCP server MVP
Wire protocol layer to MCP tools.
Test with Claude Desktop using `claude_desktop_config.json`.
Goal: "set amp to Plexi, gain 6" works end to end.

### Intelligence layer
Add block reference knowledge to Claude project.
Famous tone research capability.
Iterative refinement loop.

### Library management
Backup/restore system.
Setlist concept.
Location safety enforcement.
