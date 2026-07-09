# Device archetypes, tool naming, and the transport abstraction

Design record for the multi-device scaling decisions taken 2026-06-27. This
governs how new gear (Line 6 Helix, NAM modelers, Boss VE-500, Boss RC-505,
more drum samplers / sequencers) is added without the tool surface exploding,
and how non-MIDI transports (USB mass storage) fold into the one unified
dispatcher. It is the "why" behind the `transport` field on `DeviceDescriptor`
and the storage-transport path in `openCtx`.

## The problem

The unified surface (`set_param`, `apply_preset`, `switch_scene`, …) was built
for guitar preset devices and scales cleanly there: a new Fractal device is a
descriptor, not new tools. But newer device *shapes* started minting
device-specific tools: Circuit Tracks (`apply_pattern`, `upload_project`),
SPD-SX (`spdsx_status`, `spdsx_list_kits`, `spdsx_author_kit`, …). The registered
surface crossed ~53 tools. Two real costs, neither a round number:

1. **Context tax, paid every turn.** Every tool's name + description + schema is
   serialized into the model's context on *every* conversation turn, before a
   device is even named. At 20 devices each contributing ~6 device-specific
   tools, that's 120+ tools of mostly-irrelevant guidance.
2. **Selection accuracy.** Models degrade at picking the right tool as the menu
   grows, fastest when tools are near-duplicates (`spdsx_author_kit` vs
   `upload_kit` vs `apply_kit`).

There is no magic cap (40, etc.). The governing rule is below.

## Decision 1: tools scale with capability ARCHETYPES, not with devices

Our devices are ~5 shapes, and each shape wants *one* tool family, most of
which already exist as the base unified surface that **every** device shares:

| Archetype | Devices (owned + wanted) | Tool family |
|---|---|---|
| Preset signal processor | AM4, Axe-Fx II/III, FM3/FM9, VP4, gen-1, **Helix, NAM, Boss VE-500** | `apply_preset` / `set_param` / `switch_scene` / `save_preset` (exists) |
| Synth (patch) | Hydrasynth, future synths | `apply_patch` / `init_patch` (exists) |
| Sequencer / groovebox | Circuit Tracks | `apply_pattern` (exists, sequencer-only) |
| Sampler (storage) | SPD-SX, future drum samplers | base verbs over a storage transport (this doc) |
| Looper (projects/tracks) | **Boss RC-505**, future loopers | record/overdub runtime verbs (not built yet) |

### Naming rule (the law for new tools)

1. **No device prefixes in the registered surface, ever.** `spdsx_*` is the last
   holdout of the pattern already killed for `am4_*` / `axefx2_*`. Finish it.
2. **If an existing bare verb covers the capability, use it.** The descriptor
   specializes behavior; `describe_device` specializes the words.
3. **Mint a new bare verb only for a genuinely novel CAPABILITY**, named for the
   capability, never the device (`apply_pattern`, not `circuit_sequence`).
4. **The only thing that distinguishes devices at the tool layer is the
   endpoint argument (`port`).**

### Do NOT unify the archetypes themselves

Unify the *verbs* (params + preset-container + sample-pool, already the base
surface). Do **not** build a shared "sequencer/sampler/looper" tool family: a
step sequencer, a pad sampler, and a live looper share almost nothing at the
runtime level. `apply_pattern` means nothing to a looper; record/overdub means
nothing to a step sequencer. Forcing them together makes every description hedge
across three behaviors, which hurts model tool-selection. Archetype-specific
runtime verbs stay separate and minimal; a new verb appears only when a real new
capability does (e.g. looper record/overdub when the RC-505 lands).

### Per-device teaching stays in describe_device

The vocabulary lives in `agent_guidance` (already exposed as individually
pullable MCP resources via `registerDeviceResources`). `save_preset` is generic;
`describe_device('spd-sx')` teaches "a preset here is a KIT (1–100); a slot maps
a pad to a wave; power-cycle after writing." Pulled on demand, not paid as
context tax every turn. This is strictly better for device-specific teaching
than device-prefixed tool names.

## Decision 2: multi-device performance orchestration, agent over mechanical tools

The north star: **"tell an agent a performance (a set of songs or pieces) and it
configures the whole rig, song by song, including the live transitions between
pieces."** A rig is set up for a show of many songs, not one song in isolation
(the per-song setup AND the song→song transitions both matter). Two ways to build
it:

- **A: mega-tool (`apply_setlist`)**: one tool whose TypeScript does the musical
  reasoning (what each device needs for the song). Rejected: it freezes the
  song-understanding in code, bypasses the safe-edit gates and per-device
  guidance, and is a black box on partial failure.
- **B: mechanical tools, agent orchestrates (CHOSEN)**: small single-purpose
  tools (`describe_rig`, the bare verbs). The *model* does the musical reasoning
  and calls the tools in sequence.

Why B: it tracks "improve as AI models improve" (the reasoning is the model's
job, so a better model = a better rig setup with zero code change); it puts the
open-ended musical problem where LLMs excel and the closed mechanical problem
where code excels; it reuses every existing gate and guidance; and partial
failure is legible and recoverable.

**B is not "do nothing."** Code must own the boring, closed, dangerous parts:

- A **connection arbiter / scheduler**: the no-ack-on-concurrent-MIDI and
  stale-handle problems. The agent must never reason about "is this port free
  right now / rotate the connection." This lives in the `ensureConnection` /
  `openCtx` layer (see Decision 3, same investment).
- A **`describe_rig`** capability (the agent can't orchestrate what it can't see).
- Honest per-tool acks.

The one legitimate high-level tool is **persistence, not intelligence**: a future
`save_setlist` / `apply_setlist` that records and replays a *resolved*
configuration the agent already computed (specific presets/patterns/tempos to
specific ports). A cache of intelligence, never the source of it.

## Decision 3: generalize the transport abstraction now (hybrid SPD-SX)

There are two transport layers, and storage belongs to the upper one:

- **`MidiConnection`** (byte-stream): serial (FM3 over USB-CDC) already rides
  here because serial carries raw MIDI byte frames. Same protocol, different
  pipe. Done.
- **`DispatchCtx` / `openCtx`** (endpoint): USB mass storage (SPD-SX in WAVE MGR
  mode) is a mounted filesystem, **not** a byte stream of MIDI messages. It can
  never be a `MidiConnection`. So the generalization happens one level up.

### Concrete shape

- `DeviceDescriptor.transport?: { kind: 'midi' | 'serial' | 'storage' | 'hybrid';
  resolveRoot?: () => string | undefined }`. Default `'midi'`; every existing
  device is untouched.
- `DispatchCtx` keeps `conn` (required) and gains `storage?: { root: string }`.
  For the storage path `conn` is a **null-object `MidiConnection`** that throws
  loudly if any MIDI I/O is attempted (storage methods never touch it, so the
  throw never fires; it just catches a miswired method). Keeping `conn` required
  avoids churning the 156 `ctx.conn` sites across 21 files in hardware-confirmed
  code.
- `openCtx` branches on `transport.kind`. Storage requires a mounted root or
  throws `device_not_mounted`.

### Hybrid (the SPD-SX decision)

SPD-SX is two transports on one device, **mutually exclusive by USB mode**: MIDI
(kit recall / pad triggers, AUDIO/MIDI mode) vs storage (kit/wave authoring,
WAVE MGR mode). Chosen: **one descriptor, `kind: 'hybrid'`.** `openCtx` resolves
at call time: drive mounted → storage methods; else MIDI port present → MIDI
methods; else (NEITHER connected) `device_not_mounted` whose message names BOTH
surfaces (the storage mount steps AND the MIDI path), so a storage verb on a
fully-disconnected device is not mis-directed toward a MIDI port it never needs
(`openCtx` tries the MIDI surface and converts its port-not-found into the
both-surfaces error; 2026-06-28). One device identity, one `describe_device`.
A verb that needs the other mode returns `capability_not_supported` with a
"the unit is in the other USB mode" message. (Rejected Option A (two
descriptors) because a user thinks "my SPD-SX," not two ports.)

### The payoff: SPD-SX's 6 device tools collapse into the base contract

The storage logic already exists as plain functions; it just moves into the
`DeviceReader`/`DeviceWriter` the descriptor already declares:

| Existing storage fn | Unified contract method | Unified tool |
|---|---|---|
| `readKits` | `reader.scanLocations` | `scan_locations` |
| `readKits` (one kit's pad map) | `reader.getPreset({location})` | `get_preset` |
| `readWaves` | `reader.readSampleDirectory` | `list_samples` (renamed from `read_sample_directory`) |
| `backup` (one kit) | `reader.dumpStoredPresetBinary` | `export_preset(location)` |
| `addWaves` | `writer.uploadSample` (slot omitted → append) | `upload_sample` |
| `authorKit` | `writer.authorKit` | `author_kit` (new bare verb) |

### What shipped (reconciliation, 2026-06-27)

The implementation matches this table except for two deliberate refinements,
recorded here so the plan and the code agree:

1. **`author_kit` is a new bare verb, not `save_preset`/`apply_preset`.** The
   original plan reused the preset-container verbs, but a sampler kit is a
   *pad→wave map written straight to a stored location*, with no audition/working
   buffer behind it; the `save_preset` (persist the working buffer) and
   `apply_preset` (build into the working buffer) models both assume a buffer the
   SPD-SX does not have. Forcing the kit author through them would have made both
   descriptions hedge across a buffer-based and a bufferless meaning, the exact
   selection-accuracy cost Decision 1 avoids. So this is naming-rule #3: a
   genuinely novel capability (author a pad map) gets one new capability-named
   bare verb (`author_kit`), shared by every future storage sampler. `upload_sample`
   (append a wave to the pool) was reused as planned. The wave pool / kit-author
   split keeps the two-step build (import waves → author kit) explicit.

2. **`export_preset` backs up ONE kit, not the whole device.** The mapping is
   per-kit by design (`dumpStoredPresetBinary(location)` → that kit's `.spd`). The
   Python `spdsx_backup.py` whole-tree dump (KIT/ + WAVE/PRM/ + SYSTEM/) is **not**
   exposed as a unified tool; single-kit backup is the supported surface for now
   (a whole-device backup verb has no existing archetype home, so it is deferred
   rather than forced into one). The script remains for a full manual backup.

Net change to the tool surface: `registerSpdsxStorageTools` (6 `spdsx_*` tools)
deletes entirely; `author_kit` is added and `read_sample_directory` is renamed to
`list_samples`. Net **−5** (53 → 48 registered tools).

### Why now, not later

The connection arbiter the song-orchestration vision (Decision 2) needs lives in
exactly this layer. Generalizing `openCtx` from "open the MIDI handle" to
"resolve and open whatever endpoint this device uses, when it's free" is step one
of the arbiter. The transport generalization is not a detour from the song
vision; it is its foundation.

## Rollout

1. Core foundation: types + null-conn + transport-aware `openCtx` + error code
   (contained; default `'midi'`; zero behavior change).
2. SPD-SX hybrid descriptor: wrap storage fns into reader/writer; mode guards;
   `describe_device` vocabulary.
3. Delete `spdsx_*`; add the `author_kit` bare verb; rename
   `read_sample_directory` → `list_samples`; update `docs/TOOLS.md`.
4. Tests + `npm run preflight`.
