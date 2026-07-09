# Multi-device roadmap

> **Status:** the single-repo workspace split has shipped. The codebase
> is a single npm-workspaces monorepo with one package per CODEC generation
> (`@mcp-midi-control/am4`, `fractal-gen1` (Standard/Ultra), `fractal-gen2`
> (Axe-Fx II), `fractal-gen3` (gen-3: Axe-Fx III / FM3 / FM9 / VP4),
> `hydrasynth`) plus shared `@mcp-midi-control/core` and an
> `@mcp-midi-control/server-all` entry point. The split into a framework
> repo plus per-vendor protocol-package repos (`fractal-midi`,
> `asm-midi`, and so on) is planned for later, after AM4 hardens and the
> unified-surface contract has absorbed one more vendor.
>
> This doc is the north star for that work. It states the architecture
> intent, the repo organization, the device target order, the framework
> boundary, and the migration plan, so future readers and contributors
> can understand where the project is going without re-deriving it from
> the codebase.

---

## Goal

A vendor-neutral MCP framework that lets a Claude conversation control
real music hardware (guitar amps, synths, loopers, drum pads) over USB
MIDI. The framework is the conversational and protocol scaffolding;
per-vendor *device packs* carry the protocol decoders and the
device-specific data that wrap them. Users install one framework plus
one or more device packs, and get a Claude Desktop integration that
knows their gear by name.

This is the inverse of the closed model the community lives with today:
one proprietary editor per device family, no shared substrate, no
extensibility for AI tooling. This project is the **open** counterpart:
shared substrate, vendor-specific packs, open source from day one
(Apache-2.0) so the community can build better tools together.

## Two-tier architecture

MCP is a top-layer concern, not a per-device concern. Vendor protocol
packages are pure MIDI, useful in non-MCP contexts (CLIs, web UIs,
Python wrappers). Vendor packages are also **vendor-grouped, not
device-grouped**: a single `fractal-midi` package will support the
entire Fractal product family (AM4, Axe-Fx II, Axe-Fx III, FM9, FM3,
VP4) since they share SysEx envelope, checksum, register shape, and most
lineage data. Same for ASM (Hydrasynth Explorer / Keyboard / Desktop /
Deluxe) and Roland/Boss (RC-505, VE-500, SPD-SX, JD-Xi).

| Tier | Responsibility | Examples | Shipped as |
|---|---|---|---|
| **L1, MCP project** (this repo) | The ONLY MCP layer. MCP server scaffolding, tool registration, port management, generic-MIDI primitive tools, the **unified tool surface** (port-dispatched `apply_preset` / `set_param` and the rest), display-first API conventions, the vendor-neutral `DeviceDescriptor` contract. | `mcp-midi-control` | One repo, npm workspaces; one package per device today, one external vendor package per family tomorrow |
| **L2, vendor protocol packages** | Pure MIDI / protocol decoders for one vendor's product family. NO MCP. Each package contains: SysEx envelope, checksum, shared encoding helpers (vendor-level), per-device protocol decoder, parameter registry, applicability data, lineage records (per-device subdirs within the vendor package). | Future: `fractal-midi` (AM4 + Axe-Fx II + Axe-Fx III + FM9 + FM3 + VP4), `asm-midi` (Hydrasynth family), `roland-midi` (RC-505 + VE-500 + SPD-SX + JD-Xi) | One repo per vendor, one npm package per vendor |
| **L3, user distribution** | Bundles `mcp-midi-control` plus native deps plus Claude Desktop config setup. End-user-installable artifact. | `setup.cmd` ZIP via `npm run build:installer` | Separate repo / artifact for distribution form |

L2 is pure code and data: no native deps, npm-friendly, Apache-2.0. The
MCP project depends on whichever vendor packages it wants to support.
That is the integration point where a protocol primitive becomes a
Claude-callable tool. L3 wraps the messy installer concerns.

**Why vendor-grouped, not device-grouped.** Within a vendor, devices
share more than they differ:

- Fractal: same SysEx envelope (`F0 00 01 74 <model> ...`), same XOR
  checksum, same packed-float wire format, overlapping lineage data,
  and editor apps that share JUCE BinaryData layout. One Fractal
  protocol package amortizes that work across the family. (This is also
  why `packages/core/src/fractal-shared/` already exists in the current
  repo: it is the seed of the future `fractal-midi` vendor-shared
  module.)
- ASM: published MIDI CC chart applies across Explorer / Keyboard /
  Desktop / Deluxe with the same engine.
- Roland/Boss: shared MIDI Implementation PDF conventions, similar
  SysEx framing across the family.

Device-grouped packages would force vendor primitives (envelope,
checksum, encoding) into an unstated shared dependency or duplicate them
N times. Vendor-grouped keeps them honest in one place.

## Repo organization

### Today (single repo, npm workspaces)

```
mcp-midi-control                       (single repo)
└── packages/
    ├── core/                        cross-device foundation
    │   └── src/
    │       ├── midi/                MidiConnection + @julusian/midi wrapper
    │       ├── protocol-generic/    unified surface
    │       │   ├── types.ts         DeviceDescriptor, DeviceWriter, DeviceReader
    │       │   ├── registry.ts      registerDevice / resolveDevice
    │       │   ├── dispatcher/      per-family dispatch
    │       │   ├── recipes/         block-stack + patch-archetype recipes
    │       │   └── tools/           MCP tool registrations
    │       ├── server-shared/       connections, bufferDirty, safeEdit
    │       └── fractal-shared/      Fractal vendor-shared primitives
    │           ├── lineage/         amp/drive/etc. lineage JSON
    │           └── lineageLookup.ts lookup_lineage engine
    ├── am4/                         Fractal AM4 wire layer + descriptor
    │   └── src/
    │       ├── descriptor.ts        AM4 DeviceDescriptor
    │       ├── descriptor/          reader, writer, agentGuidance
    │       ├── params.ts            KNOWN_PARAMS registry
    │       ├── blockTypes.ts
    │       ├── locations.ts
    │       ├── setParam.ts          wire-byte builders
    │       ├── applicability.ts
    │       ├── ir/                  preset IR + transpiler
    │       ├── safety/              fingerprint, location classification
    │       └── tools/               apply executor, navigation, safeEdit
    ├── axe-fx-ii/                   Fractal Axe-Fx II XL+ wire + descriptor
    │   └── src/
    │       ├── descriptor.ts
    │       ├── descriptor/          reader, writer, agentGuidance
    │       ├── midi.ts              bidirectional handle + dirty classifier
    │       ├── setParam.ts
    │       └── params.ts
    ├── axe-fx-iii/                  Fractal Axe-Fx III (community beta)
    │   └── src/
    │       ├── descriptor.ts
    │       └── device.ts
    ├── hydrasynth/                  ASM Hydrasynth descriptor (Explorer / KB / Deluxe / Desktop)
    │   └── src/
    │       ├── descriptor.ts
    │       ├── params.ts
    │       ├── nrpn.ts
    │       └── tools/
    └── server-all/                  MCP entrypoint (imports all devices)
        └── src/
            ├── server/
            │   ├── index.ts         boot + register-loop only
            │   └── tools/           generic-MIDI primitives + control
            └── fractal-registry/
```

`@mcp-midi-control/server-all` depends on every device package plus
`@mcp-midi-control/core`. Each device package depends only on `core`;
there are no cross-device deps. Adding a new device is a sibling folder
under `packages/`, a `DeviceDescriptor` export, and a registration line
in the server entry point. See `CONTRIBUTING.md`, "Adding a new device",
for the full step-by-step.

### After the vendor-package split (target: first Fractal expansion)

```
mcp-midi-control                       MCP project (this repo)
fractal-midi                           Fractal protocol family (extracted)
asm-midi                               ASM protocol family
roland-midi                            Roland/Boss protocol family (later)
mcp-midi-control-installer             L3 distribution (later)
```

`fractal-midi` would expose subpaths per device:

```
import { encodeAm4Param } from 'fractal-midi/am4';
import { encodeAxeFxIIPreset } from 'fractal-midi/gen2/axe-fx-ii';
import { fractalChecksum } from 'fractal-midi/shared';
```

The current `packages/core/src/fractal-shared/` and the
`packages/{am4,axe-fx-ii,axe-fx-iii}/` directories are the pre-split
shape. Extraction is mostly copying the trees, adjusting imports, and
publishing.

Naming conventions:

- MCP project: `mcp-midi-control`.
- Per-package npm names today: `@mcp-midi-control/<device>` (internal
  scope).
- Future vendor protocol packages: `<vendor>-midi` (for example
  `fractal-midi`, `asm-midi`, `roland-midi`). No `mcp-` prefix: these
  are not MCP packages, they are MIDI protocol libraries that anyone can
  consume.
- Distribution: separate, branded if and when needed.
- **Product names never include device names.** The MCP project is the
  product; vendor packages are reusable libraries.

## Boundary: what stays in mcp-midi-control vs what moves to vendor packages

This is the load-bearing decision the directory restructure encodes.

### L1 mcp-midi-control (this repo, the MCP layer)

Everything that knows about MCP, plus everything that is MIDI-generic
across vendors:

- **MCP server scaffolding.** `registerTool`, request/response types,
  the `@modelcontextprotocol/sdk` integration, error formatting,
  startup banner. Lives in `packages/server-all/src/server/`.
- **MIDI port management.** Port enumeration, open/close, hot-replug
  detection, error handling. Shipped as `list_midi_ports` and
  `reconnect_midi`. Generic @julusian/midi wrapper in
  `packages/core/src/midi/`.
- **Generic-MIDI primitive tools.** `send_cc`, `send_note`,
  `send_program_change`, `send_nrpn`, `send_sysex`, and the rest of the
  raw primitives. Channel 1 to 16, CC 0 to 127, NRPN 14-bit, raw SysEx
  framing. These work on *any* MIDI device; they are the
  lowest-common-denominator wire. Live in
  `packages/server-all/src/server/tools/midi-primitives.ts`.
- **Unified tool surface.** The device-agnostic tools (`apply_preset`,
  `set_param`, `get_param`, `switch_preset`, `save_preset`,
  `switch_scene`, `set_block`, `set_bypass`, `set_params`, `get_params`,
  `list_params`, `describe_device`, `get_preset`, `translate_preset`,
  `scan_locations`, `lookup_lineage`, `find_compatible_types`).
  Port-dispatched through registered `DeviceDescriptor`s. Lives in
  `packages/core/src/protocol-generic/`.
- **Voice-class tools.** Synth patch and routing tools (`apply_patch`,
  `init_patch`, `set_system_param`, `set_macro`, `set_macro_route`,
  `set_mod_route`) used by the Hydrasynth.
- **Tool conventions.** Display-first API: enums accept display names,
  knobs accept display values, the wire conversion happens at the tool
  boundary. Range validation, applicability advisory shape, error path
  conventions.
- **Cross-device safe-edit contract.** `bufferDirty.ts`, `safeEdit.ts`
  in `packages/core/src/server-shared/`. `save_authorized` and
  `on_active_preset_edited` gates enforced uniformly across devices.
  See `docs/SAFE-EDIT-WORKFLOW.md`.
- **`lookup_lineage` engine.** The MCP-callable wrapper. Lineage *data*
  per vendor lives in vendor-shared (today:
  `packages/core/src/fractal-shared/lineage/`).

### L2 vendor protocol packages (future `fractal-midi`, `asm-midi`, etc.)

Pure MIDI protocol code. **No MCP imports.** Anyone can consume these
from a CLI, web UI, Python wrapper via FFI, and so on.

- **Vendor-shared primitives.** SysEx envelope (model byte slot,
  framing), checksum (Fractal: XOR-and-mask; Roland: Roland-specific),
  packed-float / septet encoding helpers, byte-level utilities shared
  across the vendor's product family.
- **Per-device protocol decoder.** Subpath per device
  (`fractal-midi/am4`, `fractal-midi/gen2/axe-fx-ii`, and so on):
  - **Parameter registry.** The `KNOWN_PARAMS` equivalent: every
    exposed parameter, its wire address, display unit, range, scaling
    curve, enum table.
  - **Cache / cache-derived data.** A Fractal-specific artifact
    extracted from the editor app; equivalent metadata sources exist
    for other devices (Roland publishes MIDI Implementation PDFs;
    Hydrasynth's CC chart is in the manual; Axe-Fx II/III share
    Fractal's cache shape).
  - **Type/applicability tables.** Which knobs apply to which type (for
    example, compressor.ratio is gated to studio-comp types). XML or
    markdown source, generated tables checked in.
  - **Lineage data.** The records that feed `lookup_lineage`. Many are
    vendor-shared (AM4 and Axe-Fx II share most amp models); they live
    in `fractal-midi/shared/lineage` rather than per-device.
  - **Preset IR / transpiler.** When the device has a preset binary
    format (AM4 .syx dumps, Axe-Fx II .syx, and so on), the IR plus
    bidirectional transpiler lives in the device subdir.
  - **Distribution metadata.** Driver requirements (for example the
    AM4 USB driver), known-firmware-version compatibility, capability
    flags.

### Genuinely shared-across-vendors but not yet generic

A few pieces straddle the L1/L2 boundary today and need a third vendor
to fully clarify (Hydrasynth has helped, but ASM-vs-Fractal isn't
enough samples):

- **The `apply_preset`-shape pattern.** Compose-an-entire-preset-in-one-
  call is the right UX, but each device's "preset" is shaped differently
  (AM4: 4 slots, 4 channels, 4 scenes; Axe-Fx II: many blocks, 2
  channels each; Hydrasynth: flat patch with macros; RC-505: song). The
  unified surface absorbs this with a per-device adapter; the contract
  works today across AM4, Axe-Fx II, and Hydrasynth.
- **Channel/variant addressing.** AM4 has A/B/C/D channels per block,
  Axe-Fx II has X/Y, Hydrasynth has macros. Per-device.
- **Working-buffer vs persistent semantics.** AM4 and Axe-Fx II ship
  working-buffer-first with explicit `save_authorized` to persist.
  Hydrasynth omits `on_active_preset_edited` (no MIDI-exposed dirty
  signal). Documented per-device in tool descriptions.

## Device target order

| Order | Device | Package | Status | Why this order |
|---|---|---|---|---|
| **First** | Fractal AM4 | `@mcp-midi-control/am4` | First-class, hardware-verified | Maintainer owns it, deepest RE done, MVP-shape proven |
| **Second** | Fractal Axe-Fx II XL+ | `@mcp-midi-control/fractal-gen2` | First-class, hardware-verified | Maintainer owns it, same SysEx envelope as AM4 (large reuse, validates the `fractal-shared/` boundary), wiki and Blocks Guide published. First boundary-validation device: confirmed the vendor-package shape works |
| **Second** | ASM Hydrasynth (line) | `@mcp-midi-control/hydrasynth` | First-class, hardware-verified | Maintainer owns the Explorer model; same SysEx/NRPN engine ships across Keyboard / Deluxe / Desktop / Explorer per ASM. CC chart fully published, zero capture-RE for the engine. The non-Fractal vendor validation point: confirmed the unified surface absorbs a different protocol family |
| **Second** | Fractal Axe-Fx III | `@mcp-midi-control/fractal-gen3` | Community beta: byte-verified against the published spec and public captures, not yet confirmed on real hardware | Maintainer does not own a III. Same SysEx envelope as II. Anchors the gen-3 codec factory. Promotion to first-class waits on community fixes and captures |
| **Third** | Fractal FM3 / FM9 | `@mcp-midi-control/fractal-gen3` | Community beta | Gen-3 siblings of the III: same codec factory, different model byte (FM3 0x11, FM9 0x12) + grid/scene shape. Registered as per-device configs, not new packages. Block catalog reuses the III's pending FM-Edit mining. VP4 (0x14, serial-chain) is the next config once VP4-Edit is mined |
| **Third** | Roland / Boss family (RC-505 MKII, VE-500, SPD-SX, JD-Xi) | future `@mcp-midi-control/<device>` | Queued | Roland publishes MIDI Implementation PDFs, so zero capture-RE. Different SysEx family from Fractal but structurally simpler. Single vendor package across the family |
| **Beyond Fractal** | Line 6 Helix, then others | (TBD) | Candidate | Helix has a documented MIDI implementation and a large user base; it is the leading candidate to prove the architecture generalizes beyond guitar gear to any modeler that publishes a usable MIDI spec. Quad Cortex is closed-protocol and hardest |

AM4 depth gates the rest: don't promote multi-device until AM4 is
impressive, though side-branch exploration is fine while AM4 hardens.
The first-class devices (AM4, Axe-Fx II, Hydrasynth) are
hardware-verified today. Axe-Fx III is exposed as community beta and not
promoted until the community confirms it on hardware.

## Milestones

### Workspace split (done)

The monolith was restructured into the workspace layout:
`packages/{core,am4,axe-fx-ii,hydrasynth,server-all}/` with
`@mcp-midi-control/*` scoped names. `server-all` is the MCP entrypoint;
`core` carries the cross-device foundation; each device is a sibling
package.

- [x] Restructure into npm workspaces.
- [x] Axe-Fx III community-beta package scaffolded.
- [x] Installer rebuilt for the workspace layout.
- [x] Unified tool surface shipped: port-dispatched tools replace the
      old per-device patterns (`packages/core/src/protocol-generic/`).
- [x] Device-namespaced tools removed; the unified, voice-class,
      generic, and utility surface is the sole live contract.
- [x] Publish this roadmap doc as the architectural reference.

### Vendor-package extraction (in progress)

Trigger: the maintainer ships polish on Axe-Fx II writes plus
Hydrasynth patch sends, OR the AM4 surface is mature enough that
extraction earns its keep without slowing core iteration.

> **Detailed plan:** [`docs/research/fractal-midi-extraction-plan.md`](research/fractal-midi-extraction-plan.md)
> covers the per-file move table, consumer surface, blockers, and
> execution sequencing. Pick it up when the trigger above fires.

- [ ] Extract `packages/{am4,axe-fx-ii,axe-fx-iii}/` plus the
      Fractal-shared bits of `packages/core/src/fractal-shared/` into a
      standalone `fractal-midi` repo. Pure protocol package, no MCP.
      Subpaths per device (`fractal-midi/am4`, `fractal-midi/gen2/axe-fx-ii`,
      `fractal-midi/gen3/axe-fx-iii`).
- [ ] Update `mcp-midi-control` to depend on `fractal-midi` as an npm
      package instead of a local workspace.
- [ ] Extract `packages/hydrasynth/` into an `asm-midi` repo with an
      `asm-midi/hydrasynth` subpath; same pattern.

**Exit criteria:** a non-Fractal device ships using only the public
descriptor API, with no changes to `core` or the dispatcher.

### Multi-vendor

Add a non-Fractal modeler that publishes a MIDI spec. Line 6 Helix is
the leading candidate: documented MIDI implementation, large user base.
This step proves the architecture generalizes beyond Fractal and beyond
guitar gear into any modeler that publishes a usable MIDI
implementation.

**Exit criteria:** Helix (or an equivalent published-spec modeler)
ships as a first-class device.

### Community and beyond

Once `mcp-midi-control` consumes two or more vendor packages and the
contract is published, external contributors can author vendor packages
without touching the MCP project. Axe-Fx III graduates to first-class
through community fixes and captures. The plan:

- Per-vendor package repo template.
- Documented hardware-RE methodology (capture guides already exist for
  AM4; generalize for other devices).
- Conformance test suite (golden writes and reads against captures) any
  vendor package must pass before being listed.
- "Approved vendor packages" registry in the `mcp-midi-control` README,
  pinned versions per release.

**Exit criteria:** at least one community-contributed device package
merged, and Axe-Fx III confirmed on real hardware.

## Open questions

1. **Monorepo vs polyrepo.** The extraction milestone leans polyrepo
   (one repo per vendor pack). If we accumulate 10+ device packs, the
   workspace monorepo this project uses today may turn out to be the
   right long-term shape; re-evaluate when the next vendor lands.
2. **Versioning across packs.** Framework stable with packs at their own
   versions, or align? Practical answer is probably that the framework
   is semver-stable and packs version independently.
3. **Distribution form for end users.** ZIP plus `setup.cmd` today via
   `npm run build:installer`. An MCPB bundle is another option.
   Parked.
4. **Third-party pack discoverability.** A registry? A page in the
   framework README? Defer until there are third-party packs.
5. **License consistency.** Framework plus first-party packs all
   Apache-2.0. Third-party pack contributors choose their own license;
   we link to packs we trust.

## What this enables on launch day

The committed roadmap lets the project announcement say:

> "The headline release is `mcp-midi-control`, a vendor-neutral MCP
> framework. Fractal AM4, Axe-Fx II, and Hydrasynth Explorer are
> hardware-verified first-class devices, with a community-beta scaffold
> for Axe-Fx III. The MCP layer is the product; AM4 is the first
> hardened device. The Fractal protocol code will spin out to its own
> `fractal-midi` package in a follow-up release so it is reusable in
> non-MCP contexts (CLIs, web UIs, Python wrappers). Roadmap: [link to
> this doc]."

That posture is honest (single repo today, multi-repo planned),
specific (named devices, named order), and credible (workspace split
shipped, four device packages in-tree, the unified surface in
production). It also signals to non-MCP audiences that the protocol code
will be usable independently of the MCP layer, which wins respect from
the broader MIDI and tools community who don't care about MCP
specifically.

## References

- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md): current workspace
  architecture (kept in sync with code).
- [`ROADMAP.md`](../ROADMAP.md): top-level milestones and decision log.
- [`docs/SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md): cross-device
  safe-edit contract that every device package implements.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): "Adding a new device"
  step-by-step.
- The existing closed-source per-device editors that this project
  deliberately inverts (commercial third-party tools each gated to one
  vendor family, no extensibility for AI or scripting).
