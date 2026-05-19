# Multi-device roadmap

> **Status (2026-05-15):** Phase 1 (single-repo workspace split) shipped
> 2026-05-04 (commit `6f5a17e`). The codebase is a single npm-workspaces
> monorepo with one package per device (`@mcp-midi-control/am4`,
> `axe-fx-ii`, `axe-fx-iii`, `hydrasynth-explorer`) plus shared
> `@mcp-midi-control/core` and an `@mcp-midi-control/server-all` entry
> point. The split into a framework repo + per-vendor protocol-package
> repos (`fractal-midi`, `asm-midi`, …) is still planned for v0.2, after
> AM4 hardens and the unified-surface contract has absorbed one more
> vendor.
>
> This doc is the north star for that work — it states the architecture
> intent, the repo organization, the device target order, the framework
> boundary, and the migration plan. It exists so future readers (and
> contributors) can understand where the project is going without
> re-deriving it from the codebase.

---

## Goal

A vendor-neutral MCP framework that lets a Claude conversation control
real music hardware (guitar amps, synths, loopers, drum pads) over USB
MIDI. The framework is the conversational + protocol scaffolding;
per-vendor *device packs* carry the protocol decoders and the device-
specific tools that wrap them. Users install one framework + one or
more device packs, get a Claude Desktop integration that knows their
gear by name.

Inverse of the closed model the community currently lives with (one
proprietary editor per device family, no shared substrate, no
extensibility for AI tooling). This project is the **open**
counterpart: shared substrate, vendor-specific packs, OSS from day
one (Apache-2.0) so the community can build better tools together.

## Two-tier architecture

**Decided 2026-05-04:** MCP is a top-layer concern, not a per-device
concern. Vendor protocol packages are pure MIDI — useful in non-MCP
contexts (CLIs, web UIs, Python wrappers). Vendor packages are also
**vendor-grouped, not device-grouped**: a single `fractal-midi` package
will support the entire Fractal product family (AM4, Axe-Fx II, Axe-Fx
III, FM9, FM3, VP4) since they share SysEx envelope, checksum, register
shape, and most lineage data. Same for ASM (Hydrasynth Explorer /
Keyboard / Desktop / Deluxe) and Roland/Boss (RC-505, VE-500, SPD-SX,
JD-Xi).

| Tier | Responsibility | Examples | Shipped as |
|---|---|---|---|
| **L1 — MCP project** (this repo) | The ONLY MCP layer. MCP server scaffolding, tool registration, port management, General-MIDI primitive MCP tools, the **unified tool surface** (`apply_preset` / `set_param` / 15 more, port-dispatched), display-first API conventions, the vendor-neutral `DeviceDescriptor` contract. | `mcp-midi-control` | One repo, npm workspaces; one package per device today, one external vendor package per family tomorrow |
| **L2 — Vendor protocol packages** | Pure MIDI / protocol decoders for one vendor's product family. NO MCP. Each package contains: SysEx envelope + checksum + shared encoding helpers (vendor-level), per-device protocol decoder + parameter registry + applicability data + lineage records (per-device subdirs within the vendor package). | Future: `fractal-midi` (AM4 + Axe-Fx II + Axe-Fx III + FM9 + FM3 + VP4), `asm-midi` (Hydrasynth family), `roland-midi` (RC-505 + VE-500 + SPD-SX + JD-Xi) | One repo per vendor, one npm package per vendor |
| **L3 — User distribution** | Bundles `mcp-midi-control` + native deps + Claude Desktop config setup. End-user-installable artifact. | `setup.cmd` ZIP via `npm run build:installer` | Separate repo / artifact for distribution form |

L2 is pure code/data, no native deps, npm-friendly, Apache-2.0. The MCP
project depends on whichever vendor packages it wants to support — it's
the integration point where "this protocol primitive becomes a Claude-
callable tool" happens. L3 wraps the messy installer concerns.

**Why vendor-grouped, not device-grouped.** Within a vendor, devices
share more than they differ:
- Fractal: same SysEx envelope (`F0 00 01 74 <model> ...`), same XOR
  checksum, same packed-float wire format, overlapping lineage data,
  AM4-Edit / Axe-Edit / FM9-Edit all share JUCE BinaryData layout.
  One Fractal protocol package amortizes that work across the family.
  (This is also why `packages/core/src/fractal-shared/` already exists
  in the current repo — it's the seed of the future `fractal-midi`
  vendor-shared module.)
- ASM: published MIDI CC chart applies across Explorer / Keyboard /
  Desktop / Deluxe with the same engine.
- Roland/Boss: shared MIDI Implementation PDF conventions, similar
  SysEx framing across the family.

Device-grouped packages would force vendor primitives (envelope,
checksum, encoding) into an unstated shared dependency or duplicate
them N times. Vendor-grouped keeps them honest in one place.

## Repo organization

### Today (single repo, npm workspaces)

```
github.com/TheAndrewStaker/mcp-midi-control              ← single repo
└── packages/
    ├── core/                        ← cross-device foundation
    │   └── src/
    │       ├── midi/                ← MidiConnection + node-midi wrapper
    │       ├── protocol-generic/    ← unified surface (17 tools)
    │       │   ├── types.ts         ← DeviceDescriptor, DeviceWriter, DeviceReader
    │       │   ├── registry.ts      ← registerDevice / resolveDevice
    │       │   ├── dispatcher/      ← per-family dispatch
    │       │   └── tools/           ← MCP tool registrations
    │       ├── server-shared/       ← connections, bufferDirty, safeEdit
    │       └── fractal-shared/      ← Fractal vendor-shared primitives
    │           ├── lineage/         ← amp/drive/etc. lineage JSON
    │           └── lineageLookup.ts ← lookup_lineage engine
    ├── am4/                         ← Fractal AM4 wire layer + descriptor
    │   └── src/
    │       ├── descriptor.ts        ← AM4 DeviceDescriptor
    │       ├── descriptor/          ← reader, writer, agentGuidance
    │       ├── params.ts            ← KNOWN_PARAMS registry
    │       ├── blockTypes.ts
    │       ├── locations.ts
    │       ├── setParam.ts          ← wire-byte builders
    │       ├── applicability.ts
    │       ├── factoryBank.ts
    │       ├── ir/                  ← preset IR + transpiler
    │       ├── safety/              ← fingerprint, location classification
    │       └── tools/               ← apply executor, navigation, safeEdit
    ├── axe-fx-ii/                   ← Fractal Axe-Fx II XL+ wire + descriptor
    │   └── src/
    │       ├── descriptor.ts
    │       ├── descriptor/          ← reader, writer, agentGuidance
    │       ├── midi.ts              ← bidirectional handle + dirty classifier
    │       ├── setParam.ts
    │       ├── params.ts
    │       └── tools/               ← legacy axefx2_* device-namespaced tools
    ├── axe-fx-iii/                  ← Fractal Axe-Fx III (community beta)
    │   └── src/
    │       ├── descriptor.ts        ← betaRefusals on write ops pending capture
    │       ├── device.ts
    │       └── tools/
    ├── hydrasynth-explorer/         ← ASM Hydrasynth Explorer descriptor
    │   └── src/
    │       ├── descriptor.ts
    │       ├── server.ts            ← legacy hydra_* device-namespaced tools
    │       ├── params.ts
    │       ├── nrpn.ts
    │       └── tools/
    └── server-all/                  ← MCP entrypoint (imports all devices)
        └── src/
            ├── server/
            │   ├── index.ts         ← boot + register-loop only
            │   └── tools/           ← midi-primitives, midi-control (generic)
            └── fractal-registry/
```

`@mcp-midi-control/server-all` depends on every device package +
`@mcp-midi-control/core`. Each device package depends only on `core`
— there are no cross-device deps. Adding a new device is a sibling
folder under `packages/`, a `DeviceDescriptor` export, and a
registration line in `packages/server-all/src/server/index.ts`. See
`CONTRIBUTING.md` §"Adding a new device" for the full step-by-step.

### After Phase 2 split (target for v0.2 or first Fractal expansion)

```
github.com/TheAndrewStaker/mcp-midi-control            ← MCP project (this repo)
github.com/TheAndrewStaker/fractal-midi                ← Fractal protocol family (extracted)
github.com/TheAndrewStaker/asm-midi                    ← ASM protocol family
github.com/TheAndrewStaker/roland-midi                 ← Roland/Boss protocol family (later)
github.com/TheAndrewStaker/mcp-midi-control-installer  ← L3 distribution (later)
```

`fractal-midi` would expose subpaths per device:
```
import { encodeAm4Param } from 'fractal-midi/am4';
import { encodeAxeFxIIPreset } from 'fractal-midi/axe-fx-ii';
import { fractalChecksum } from 'fractal-midi/shared';
```

The current `packages/core/src/fractal-shared/` and the
`packages/{am4,axe-fx-ii,axe-fx-iii}/` directories are the pre-split
shape — extraction is mostly `cp -r` + adjust imports + publish.

Naming conventions:

- MCP project: `mcp-midi-control` (per [BK-029](_private/04-BACKLOG.md), decided 2026-04-19, shipped 2026-05-04 in commit `f5a8b19`).
- Per-package npm names today: `@mcp-midi-control/<device>` (internal scope).
- Future vendor protocol packages: `<vendor>-midi` (e.g. `fractal-midi`,
  `asm-midi`, `roland-midi`). NO `mcp-` prefix — these aren't MCP
  packages, they're MIDI protocol libraries that anyone can consume.
- Distribution: separate, branded if/when needed.
- **Product names never include device names**. The MCP project is the
  product; vendor packages are reusable libraries.

## Boundary — what stays in mcp-midi-control vs what moves to vendor packages

This is the load-bearing decision the directory restructure encodes.

### L1 mcp-midi-control (this repo, the MCP layer)

Everything that knows about MCP, plus everything that's MIDI-generic
across vendors:

- **MCP server scaffolding.** `registerTool`, request/response types,
  the `@modelcontextprotocol/sdk` integration, error formatting,
  startup banner. Lives in `packages/server-all/src/server/`.
- **MIDI port management.** Port enumeration, open/close, hot-replug
  detection, error handling. Shipped as `list_midi_ports` and
  `reconnect_midi`. Generic node-midi wrapper in
  `packages/core/src/midi/`.
- **General-MIDI primitive MCP tools.** `send_cc`, `send_note`,
  `send_program_change`, `send_nrpn`, `send_sysex`. Channel-1..16,
  CC 0..127, NRPN 14-bit, raw SysEx framing. Shipped in BK-030. These
  work on *any* MIDI device — they're the lowest-common-denominator
  wire. Live in `packages/server-all/src/server/tools/midi-primitives.ts`.
- **Unified tool surface.** The 17 device-agnostic tools (`apply_preset`,
  `set_param`, `get_param`, `switch_preset`, `save_preset`,
  `switch_scene`, `set_block`, `set_bypass`, `set_params`, `get_params`,
  `list_params`, `describe_device`, `rename`, `scan_locations`,
  `lookup_lineage`, `apply_setlist`, `restore_defaults`) plus
  `find_compatible_types`. Port-dispatched through registered
  `DeviceDescriptor`s. Lives in `packages/core/src/protocol-generic/`.
- **Tool conventions.** Display-first API (per project CLAUDE.md):
  enums accept display names, knobs accept display values, the wire
  conversion happens at the tool boundary. Range validation,
  applicability advisory shape, error path conventions.
- **Cross-device safe-edit contract.** `bufferDirty.ts`, `safeEdit.ts`
  in `packages/core/src/server-shared/` — `save_authorized` and
  `on_active_preset_edited` gates enforced uniformly across devices.
  See `docs/SAFE-EDIT-WORKFLOW.md`.
- **`lookup_lineage` engine.** The MCP-callable wrapper. Lineage *data*
  per vendor lives in vendor-shared (today: `packages/core/src/fractal-shared/lineage/`).

### L2 vendor protocol packages (future `fractal-midi`, `asm-midi`, etc.)

Pure MIDI protocol code. **No MCP imports.** Anyone can consume these
from a CLI, web UI, Python wrapper via FFI, etc.

- **Vendor-shared primitives.** SysEx envelope (model byte slot,
  framing), checksum (Fractal: XOR-and-mask; Roland: Roland-specific),
  packed-float / septet encoding helpers, byte-level utilities
  shared across the vendor's product family.
- **Per-device protocol decoder.** Subpath per device
  (`fractal-midi/am4`, `fractal-midi/axe-fx-ii`, …):
  - **Parameter registry.** The `KNOWN_PARAMS`-equivalent — every
    exposed parameter, its wire address, display unit, range,
    scaling curve, enum table.
  - **Cache / cache-derived data.** AM4-Edit's cache extraction is a
    Fractal-specific artifact; equivalent metadata sources exist for
    other devices (Roland publishes MIDI Implementation PDFs;
    Hydrasynth's CC chart is in the manual; Axe-Fx II/III share
    Fractal's cache shape).
  - **Type/applicability tables.** Which knobs apply to which type
    (e.g. compressor.ratio is gated to studio-comp types per HW-055).
    XML or markdown source, generated tables checked in.
  - **Lineage data.** The records that feed `lookup_lineage`. Many
    of these are vendor-shared (AM4 + Axe-Fx II share most amp
    models) — they live in `fractal-midi/shared/lineage` rather
    than per-device.
  - **Preset IR / transpiler.** When the device has a preset binary
    format (AM4 .syx dumps, Axe-Fx II .syx, etc.), the IR +
    bidirectional transpiler lives in the device subdir.
  - **Distribution metadata.** Driver requirements (e.g. AM4 USB
    driver), known-firmware-version compatibility, capability flags.

### Genuinely shared-across-vendors but not yet generic

A few pieces straddle the L1/L2 boundary today and need a third
vendor to fully clarify (Hydrasynth has helped, but ASM-vs-Fractal
isn't enough samples):

- **The `apply_preset`-shape pattern.** Compose-an-entire-preset-in-
  one-call is the right UX, but each device's "preset" is shaped
  differently (AM4: 4 slots × 4 channels × 4 scenes; Axe-Fx II: ~80
  blocks, 2 channels each; Hydrasynth: flat patch with macros; RC-505:
  song). The unified surface absorbs this with `PresetSpec` +
  per-device adapter logic — the contract works today across AM4,
  Axe-Fx II, and Hydrasynth.
- **Channel/variant addressing.** AM4 has A/B/C/D channels per
  block, Axe-Fx II has X/Y, Hydrasynth has macros. Per-device.
- **Working-buffer vs persistent semantics.** AM4 + Axe-Fx II ship
  working-buffer-first with explicit `save_authorized` to persist.
  Hydrasynth omits `on_active_preset_edited` (no MIDI-exposed dirty
  signal). Documented per-device in tool descriptions.

## Device target order

Per [BK-005 / BK-014 / BK-015 / BK-031 in the backlog](_private/04-BACKLOG.md):

| Wave | Device | Package | Status | Why this order |
|---|---|---|---|---|
| **0** | Fractal AM4 | `@mcp-midi-control/am4` | Shipping in v0.1.0 | Founder owns, deepest RE done, MVP-shape proven |
| **1** | Fractal Axe-Fx II XL+ | `@mcp-midi-control/axe-fx-ii` | In-repo, alpha | Founder owns, same SysEx envelope as AM4 (huge reuse — validates `fractal-shared/` boundary), wiki + Blocks Guide published. **First boundary-validation device** — confirmed the vendor-package shape works |
| **1** | ASM Hydrasynth Explorer | `@mcp-midi-control/hydrasynth-explorer` | In-repo, alpha (BK-031) | Founder owns. CC chart fully published (manual pp. 94–96), zero capture-RE for the engine. The **non-Fractal vendor** validation point — confirmed the unified surface absorbs a totally different protocol family |
| **1** | Fractal Axe-Fx III | `@mcp-midi-control/axe-fx-iii` | Community beta — descriptor scaffolded, write ops refused pending capture (BK-015) | Founder does not own. Same SysEx envelope as II. Scaffolded with `betaRefusals` so community contributors with hardware can iterate. |
| **2** | Fractal FM9 / FM3 / VP4 | future `@mcp-midi-control/<device>` | Community beta | Need community-owned hardware for capture. Same vendor package, sibling subdirs |
| **2** | Roland / Boss family (RC-505 MKII, VE-500, SPD-SX, JD-Xi) | future `@mcp-midi-control/<device>` | Queued | Roland publishes MIDI Implementation PDFs — zero capture-RE. Different SysEx family from Fractal but structurally simpler. Single vendor package across the family |
| **deferred** | Helix, Quad Cortex, others | (TBD) | — | Helix has JSON preset format (different protocol family); Quad Cortex is closed-protocol (hardest) |

AM4 depth gates Wave 1 device shipping: don't ship multi-device until
AM4 is impressive, but side-branch exploration is fine while AM4
hardens. Wave 1 packages are in-repo today but considered alpha —
they're behind AM4 on tool guidance, dirty-state coverage, and lineage
breadth. v0.1.0 ships AM4 as the headline; the others are exposed but
not promoted.

## Migration plan

### Phase 0 — Pre-launch decisions (2026-04-19 → 2026-05-04)

- [x] Decide framework name (`mcp-midi-control`, BK-029).
- [x] Rename `package.json` `name` field.
- [x] Build out General-MIDI primitives (BK-030) so the name isn't aspirational.
- [x] Decide multi-repo OSS architecture in principle.
- [x] Repo rename: `am4-tone-agent` → `mcp-midi-control`, GitHub remote
      pointed at https://github.com/TheAndrewStaker/mcp-midi-control
      (commit `f5a8b19`, 2026-05-04).

### Phase 1 — Workspace split (done 2026-05-04)

- [x] Restructure `src/` → `packages/{core,am4,axe-fx-ii,hydrasynth-explorer,server-all}/`
      (commit `6f5a17e`). Workspace npm setup with `@mcp-midi-control/*`
      scoped names. `server-all` is the MCP entrypoint; `core` carries
      cross-device foundation; each device is a sibling package.
- [x] Axe-Fx III community-beta package scaffolded
      (commit `1430dfb`, BK-015).
- [x] Installer rebuilt for workspace layout (commit `72009db`).
- [x] Unified tool surface shipped — 17 port-dispatched tools replace
      the per-device `am4_*` / `axefx2_*` / `hydra_*` patterns
      (`packages/core/src/protocol-generic/`).
- [x] Publish this roadmap doc as the architectural reference for
      launch posts ("here's where it's going").

### Phase 2 — Vendor protocol-package extraction (v0.2 or first non-AM4 Fractal expansion)

Trigger: founder ships polish on Axe-Fx II writes + Hydrasynth patch
sends, OR AM4 surface is mature enough that extraction earns its keep
without slowing core iteration.

> **Detailed plan:** [`docs/fractal-midi-extraction-plan.md`](fractal-midi-extraction-plan.md)
> — per-file move table, consumer surface, blockers, execution
> sequencing. Authored 2026-05-17 to be picked up when the trigger
> above fires.

- [ ] Extract `packages/{am4,axe-fx-ii,axe-fx-iii}/` + the Fractal-shared
      bits of `packages/core/src/fractal-shared/` into a standalone
      `fractal-midi` repo. Pure protocol package, no MCP. Subpaths per
      device (`fractal-midi/am4`, `fractal-midi/axe-fx-ii`, `…/axe-fx-iii`).
- [ ] Update `mcp-midi-control` to depend on `fractal-midi` as an npm
      package instead of a local workspace.
- [ ] Extract `packages/hydrasynth-explorer/` into `asm-midi` repo with
      `asm-midi/hydrasynth-explorer` subpath; same pattern.
- [ ] Keep device-namespaced MCP wrappers (`am4_*`, `axefx2_*`,
      `hydra_*`) deprecated through v0.2 — full removal in v0.3 once
      `describe_device` carries the per-device guidance the long tool
      descriptions provide today (per project CLAUDE.md "Tool surface
      architecture").

### Phase 3 — Multi-vendor + community (post-v0.2)

Once `mcp-midi-control` consumes 2+ vendor packages and the contract is
published, external contributors can author vendor packages without
touching the MCP project. The plan is:

- Per-vendor package repo template.
- Documented hardware-RE methodology (`docs/capture-guides/`
  already exists for AM4; generalize for other devices). The
  `docs/axe-fx-ii-community-re-methodology.md` is a first attempt
  at vendor-agnostic guidance.
- Conformance test suite (golden writes + reads against captures)
  any vendor package must pass before being listed.
- "Approved vendor packages" registry in the `mcp-midi-control` README,
  pinned versions per release.

## Open questions (revisit at Phase 2)

1. **Monorepo vs polyrepo.** Phase 2 commits to polyrepo (one repo
   per vendor pack). If we accumulate 10+ device packs, the workspace
   monorepo this project currently uses may turn out to be the right
   long-term shape — re-evaluate when the next vendor lands.
2. **Versioning across packs.** Framework v1.x with packs at their
   own versions? Or align? Practical answer probably: framework is
   semver-stable, packs version independently.
3. **Distribution form for end users.** ZIP + `setup.cmd` today via
   `npm run build:installer`. MCPB bundle (P5-008) is another option.
   Decision parking-lotted.
4. **Third-party pack discoverability.** A registry? A page in the
   framework README? Defer until there are third-party packs.
5. **License consistency.** Framework + first-party packs all
   Apache-2.0. Third-party pack contributors choose their own license;
   we link to packs we trust.
6. **When to drop device-namespaced tools.** Currently both surfaces
   ship in parallel. Removal is gated on `describe_device` carrying
   the per-device guidance the long descriptions provide today
   (planned for v0.3 per project CLAUDE.md).

## What this enables on launch day

The roadmap committed lets the launch post say:

> "v0.1.0 is `mcp-midi-control` — a vendor-neutral MCP framework with
> Fractal AM4 as the headline device, plus alpha support for Axe-Fx II,
> Hydrasynth Explorer, and a community-beta scaffold for Axe-Fx III.
> The MCP layer is the product; AM4 is the first hardened device. The
> Fractal protocol code will spin out to its own `fractal-midi` package
> in v0.2 so it's reusable in non-MCP contexts (CLIs, web UIs, Python
> wrappers). Roadmap: [link to this doc]."

That posture is honest (single repo today, multi-repo planned),
specific (named devices, named order), credible (workspace split
shipped, four device packages in-tree, the unified surface in
production), AND signals to non-MCP audiences that the protocol code
will be liberatable independently of the MCP layer — wins respect from
the broader MIDI / tools community who don't care about MCP specifically.

## References

- [`docs/_private/04-BACKLOG.md`](_private/04-BACKLOG.md) — BK-005 (other
  device support umbrella), BK-014 (Axe-Fx II), BK-015 (Axe-Fx III
  community beta), BK-029 (project rename, shipped), BK-031 (Hydrasynth
  Explorer)
- [`docs/DECISIONS.md`](DECISIONS.md) — vendor-neutral name decision,
  ESM choice, distribution model, workspace-split rationale
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md): current workspace
  architecture (kept in sync with code)
- [`docs/SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md) — cross-device
  safe-edit contract that every device package implements
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — "Adding a new device"
  step-by-step
- The existing closed-source per-device editors that this project
  deliberately inverts (commercial third-party tools each gated to
  one vendor family, no extensibility for AI / scripting)
