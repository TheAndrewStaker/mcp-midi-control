# Architecture: MCP MIDI Control

## System Overview

```
┌─────────────────────────────────────────────────────┐
│  Claude Desktop (claude.ai)                         │
│  User types: "Amber by 311, 4 scenes"               │
└──────────────────────┬──────────────────────────────┘
                       │ MCP protocol (stdio)
┌──────────────────────▼──────────────────────────────┐
│  MCP Server  (Node.js / TypeScript)                 │
│  - Tool definitions                                 │
│  - Tone research context                            │
│  - Preset safety logic                              │
│  - Slot management                                  │
└──────────────────────┬──────────────────────────────┘
                       │ TypeScript function calls
┌──────────────────────▼──────────────────────────────┐
│  AM4 Protocol Layer  (TypeScript)                   │
│  - SysEx encoder/decoder                           │
│  - Checksum calculation                            │
│  - Block parameter maps                            │
│  - Preset/scene binary format                      │
└──────────────────────┬──────────────────────────────┘
                       │ node-midi
┌──────────────────────▼──────────────────────────────┐
│  USB/MIDI Transport                                 │
│  - Fractal AM4 USB driver (Windows)                │
│  - node-midi input/output ports                    │
└──────────────────────┬──────────────────────────────┘
                       │ USB cable
┌──────────────────────▼──────────────────────────────┐
│  Fractal AM4 Hardware                               │
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

### 2. Unified tool surface (`packages/core/src/protocol-generic/`)

The 17-tool device-agnostic surface (`apply_preset`, `set_param`,
`get_param`, `switch_preset`, `save_preset`, `switch_scene`, `set_block`,
`set_bypass`, `set_params`, `get_params`, `list_params`,
`describe_device`, `rename`, `scan_locations`, `lookup_lineage`,
`apply_setlist`, `restore_defaults`). Each tool dispatches through the
`port` argument to a registered `DeviceDescriptor`.

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
    lineage/                  ← Fractal amp/drive/etc. lineage JSON data
    lineageLookup.ts          ← lookup_lineage engine
```

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
  factoryBank.ts      ← factory preset restore bytes
  tools/
    applyExecutor.ts  ← apply_preset core logic (validation + wire-send)
    navigation.ts     ← switch_preset / save_preset / scan_locations
    safeEdit.ts       ← AM4-specific guardActiveBufferOrSave

packages/axe-fx-ii/src/
  descriptor.ts       ← Axe-Fx II DeviceDescriptor
  midi.ts             ← bidirectional MIDI handle + dirty-state classifier
  setParam.ts         ← wire-byte builders (buildSetBlockParameterValue…)
  params.ts           ← KNOWN_PARAMS registry
  tools.ts            ← legacy device-namespaced tools (axefx2_*)

packages/axe-fx-iii/src/
  descriptor.ts       ← Axe-Fx III descriptor (community beta, betaRefusals
                          on write ops pending capture)
  device.ts           ← exports AXEFX3_DESCRIPTOR + midi side-effect

packages/hydrasynth-explorer/src/
  descriptor.ts       ← Hydrasynth DeviceDescriptor
  server.ts           ← legacy device-namespaced tools (hydra_*)
```

**Adding a new device.** Write a `DeviceDescriptor` (copy
`packages/axe-fx-iii/src/descriptor.ts` as a template), register it
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
- Pre-overwrite scan: `apply_setlist` pre-flight-scans the target range
  before any write.
- Factory preset verification: pre/post-name comparison in
  `restore_defaults` catches no-op restores.

### 4. AM4 Protocol Layer (`packages/am4/`)
Pure TypeScript. No Claude, no MCP. Testable in isolation against
captured wire bytes via `scripts/verify-msg.ts` and friends.

Per-vendor packages (`packages/axe-fx-ii/`, `packages/hydrasynth-explorer/`)
follow the same layout. Each device's wire layer is self-contained.

### 5. Intermediate Representation (post-MVP)
Device-agnostic preset format. Claude builds this; encoder converts it to SysEx.

```typescript
interface AM4Preset {
  name: string;           // max 32 chars
  tempo: number;          // BPM
  inputGate: InputGate;
  // slot1..slot4 are the four effect slots; any slot may hold any block type; Drive may appear in up to two slots.
  blocks: {
    slot1: Block | null;  // AM4 has 4 effect slots
    slot2: Block | null;
    slot3: Block | null;
    slot4: Block | null;
  };
  scenes: [Scene, Scene, Scene, Scene];  // exactly 4 scenes (index 0..3 in SysEx, displayed 1..4 on hardware)
}

interface Scene {
  name: string;
  blocks: {
    slot1: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
    slot2: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
    slot3: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
    slot4: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
  };
}
```

### 6. Transport Layer (`packages/core/src/midi/`)
Thin wrapper around node-midi. Handles port discovery, connection
lifecycle, and raw SysEx send/receive.

```typescript
interface AM4Transport {
  connect(): Promise<void>;
  disconnect(): void;
  send(sysex: number[]): Promise<void>;
  request(sysex: number[], timeoutMs?: number): Promise<number[]>;
  onMessage(handler: (data: number[]) => void): void;
}
```

---

## Slot Naming Convention
The AM4 uses Fractal's native bank/letter system. The app uses this natively.

```
Format: [Bank Letter][Two-digit number]
Banks:  A through Z (26 banks)
Slots:  01 through 04 per bank (4 slots each)
Total:  104 preset slots

Examples:
  A01: Bank A, slot 1 (first factory preset)
  Z04: Bank Z, slot 4 (last slot, #104)
  M02: Bank M, slot 2

Flat index mapping (for internal use):
  index = (bankIndex * 4) + (slotNumber - 1)
  A01 = 0, A02 = 1, A03 = 2, A04 = 3, B01 = 4 ...
```

---

## Preset Safety System

```
┌─────────────────────────────────────────────────────┐
│  BEFORE ANY WRITE OPERATION                         │
│                                                     │
│  1. Read current slot contents                      │
│  2. Check against factory preset checksum table     │
│     → Factory: show "slot contains factory preset"  │
│     → Unknown/custom: show "slot contains           │
│       user preset, backup recommended"              │
│     → Empty: show "slot is empty, safe to write"    │
│                                                     │
│  3. Present compact confirmation summary:           │
│     Writing: AMBER 311                              │
│     Slot:    M01                                    │
│     Current: [Empty / Factory A01 / User preset]   │
│     Backup:  [N/A / Not needed / Saved as M01_bak] │
│     Confirm? [Yes / No]                             │
│                                                     │
│  4. On confirm: backup if needed, then write        │
└─────────────────────────────────────────────────────┘
```

---

## Repo Structure
```
mcp-midi-control/
  packages/
    core/           Cross-device foundation (MidiConnection, unified
                       dispatcher, DeviceDescriptor types, server-shared
                       helpers, fractal-shared lineage data)
    am4/            Fractal AM4 wire layer + DeviceDescriptor
    axe-fx-ii/      Fractal Axe-Fx II XL+ wire layer + DeviceDescriptor
    axe-fx-iii/     Fractal Axe-Fx III community-beta descriptor
    hydrasynth-explorer/ ASM Hydrasynth Explorer descriptor
    server-all/     MCP server entry point (imports all device packages)
  scripts/
    verify-*.ts     Byte-exact golden verifiers (run without hardware)
    mcp-*.ts        Hardware integration test harnesses
    capture-*.ts    Passive MIDI capture utilities
    launch-verification.ts: Full end-to-end smoke test (requires hardware)
  samples/          Local-only debug scratch (entire dir gitignored)
    factory/        Factory .syx preset files
    captured/       USB / MIDI-OX captured traffic sessions
  docs/
    SYSEX-MAP.md    Reverse-engineered SysEx reference (public)
    BLOCK-PARAMS.md AM4 block parameter tables
    SAFE-EDIT-WORKFLOW.md Cross-device safe-edit contract
    community/      Contributor guides (device capture workflows)
    _private/       Operational scratch (gitignored): STATE.md,
                       SESSIONS.md, HARDWARE-TASKS-*.md, BACKLOG.md
  CLAUDE.md         Context file for Claude Code
  CONTRIBUTING.md   Contributor guide
  package.json      npm workspace root
  tsconfig.json     Root path mappings for tsx script resolution
```

---

## Development Phases

### Phase 0: Feasibility Scripts
`scripts/probe.ts` proves USB MIDI communication works.
`scripts/sniff.ts` captures AM4-Edit traffic for analysis.
No MCP yet. Pure Node.js CLI.

### Phase 1: Protocol Layer
Build encoder/decoder from sniffed data.
`scripts/diff-syx.ts` and `scripts/annotate.ts` support this.
Full unit test coverage of round-trips before moving on.

### Phase 2: MCP Server MVP
Wire protocol layer to MCP tools.
Test with Claude Desktop using `claude_desktop_config.json`.
Goal: "set amp to Plexi, gain 6" works end to end.

### Phase 3: Intelligence Layer
Add block reference knowledge to Claude project.
Famous tone research capability.
Iterative refinement loop.

### Phase 4: Library Management
Backup/restore system.
Setlist concept.
Slot safety enforcement.
