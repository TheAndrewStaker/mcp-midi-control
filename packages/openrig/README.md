# OpenRig

A portable JSON schema for a musician's rig: **typed audio + MIDI topology**,
**per-device capabilities**, and **editable cross-device bindings**. Pure
TypeScript, zero runtime dependencies.

The problem: performance software knows what a device *can* do, and patch-cable
planners draw *where* things connect, but nothing models **both** together, the
typed audio and MIDI edges (which cable, which channel, which CC) plus each
device's capabilities, in one shareable, diffable, renderable file. OpenRig is
that file.

> **Status: incubating.** This is the reference implementation of the OpenRig
> spec, developed inside the `mcp-midi-control` monorepo (design doc:
> `docs/design/OPENRIG-SCHEMA.md`). It is authored to be extractable to a
> standalone repo at graduation. Package version tracks the **spec** version
> (`0.1.x`), not the host product.

## What's here (L1: topology)

- **`types.ts`** the domain model: `Rig`, `Node`, `Port`, `Edge`, `Signal`,
  `Binding`, `Routing`, and the fixed `Role` / signal enums. A directed
  multigraph where one physical cable (`edge`) carries a **set** of logical
  signals, a MIDI channel is a property of a signal (never a port), and a node's
  `routing` records how it consumes / passes / originates signals.
- **`validateRig(rig)`** two tiers, both pure: referential integrity (endpoints
  resolve, ids unique, port/signal kinds compatible, channel rules, binding
  references) and the cheap high-value graph checks (**MIDI feedback-loop
  detection** and **clock-subgraph well-formedness**). Honestly scoped: it
  validates the manifest's internal consistency and graph shape, not the
  physical world.
- **`schema/rig.schema.json`** the normative JSON Schema (draft 2020-12) so any
  consumer can structurally validate a manifest. `validateRig` adds the checks a
  structural schema cannot express.
- **`LOOPER_HUB_RIG`** the design doc's §10 worked example, as a typed fixture
  and the validator's happy-path golden.

## Usage

```ts
import { validateRig, LOOPER_HUB_RIG } from 'openrig';

const result = validateRig(myRig);
if (!result.ok) console.error(result.errors);
for (const w of result.warnings) console.warn(w.code, w.message);
```

## Roadmap

- **L1 topology model + validator + schema.** Done.
- **`bootstrapRig(seeds)` + `toCytoscapeElements(rig)`.** Done. `bootstrapRig`
  takes a generic `DeviceSeed[]` (the server adapts its registered descriptors
  to it, so this package stays zero-dependency) and seeds the nodes; the human
  authors the cables. `toCytoscapeElements` projects a rig to the Cytoscape.js
  render shape (device parents, port children, one summarized edge per cable).
- **Server integration (Phase C):** the descriptor to `DeviceSeed` adapter, and
  `describe_rig` reading / validating / bootstrapping a manifest.
- **L2 / L3:** repertoire (song library) and performance (the set, authored into
  hardware) layers.

Full design, prior-art rationale, and the hard modeling decisions:
`docs/design/OPENRIG-SCHEMA.md`.
