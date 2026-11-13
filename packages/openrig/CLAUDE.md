# openrig, Claude Code Context

Read by Claude Code when working inside `packages/openrig/`.

---

## What this package is

The reference implementation of **OpenRig**: a portable JSON schema for a
musician's rig (typed audio + MIDI topology + per-device capabilities + editable
cross-device bindings). Pure TypeScript, **zero runtime dependencies**, authored
to be **extractable** to a standalone `openrig` repo later.

The full design (prior-art rationale, the hard modeling decisions, L2/L3
sketches) is the spec-of-record: **`docs/design/OPENRIG-SCHEMA.md`** in the repo
root. Read it before changing the model. Section (§) references in the source
point at it.

## Versioning

Package version tracks the **spec** version (`openrig_version`, currently
`0.1.x`), NOT the host product's release lockstep. If a workspace-wide
`npm version` bump touches it, reset it to the spec version. It is `private` and
not published until the spec graduates (spec §9).

## Model invariants (do not regress)

- A physical cable carries a **set** of logical signals (`edge.signal.signals[]`),
  never a single "midi" type (§5.1).
- A MIDI channel (1-16) is a property of a **signal**, never a port or node
  (§5.2). `clock` and `transport` are DISTINCT and carry no channel (§3).
- A node **transforms** signals: `routing` (consume / pass / originate) is how
  reachability is computed through a node (§5.6). Topology alone is not
  reachability. Every reachability-shaped check goes through `routing.ts`
  (`relaysSignal` / `consumesSignal`), never raw node-to-node adjacency: a cycle
  drawn through a node that CONSUMES the signal is not a cycle, and a device only
  bounds the legality of signals it ACTS on. **The default is loud:** absent
  routing, or an in-port no rule names, means UNDECLARED, which is assumed to
  relay and to act. A check may only go quiet on a path the manifest declares
  safe; opaque gear keeps every warning. Do not invert this to "declare nothing,
  get silence".
- Capability is **optional + progressive**; opaque gear is a first-class node
  with `capabilities: null` (§4). Never fabricate capability data.
- A governed cross-device signal lives **once** in a `binding`; edges + routing
  derive from it (§4). This is what makes change-propagation real.
- `roles` is a **fixed core enum** (comparison keys on it); `extra_roles` is the
  advisory escape hatch that never keys diff (§3).
- **A cable runs from a jack that sends to a jack that receives, and a jack
  takes one plug.** Direction and occupancy live in `portRules.ts`, never
  re-derived. `validateRig` ERRORS on `edge-direction` and
  `port-direction-contradicts-kind`, and WARNS on `port-double-booked`;
  `applyRigEdit` refuses to create either (implicit jack selection takes the
  first FREE jack facing the right way and refuses rather than guess). Two
  exceptions, both spec'd: an `audio_in` on a `mixer`/`monitor` node sums N
  cables, and a duplex link (two directed edges, same `physical_link_id`, same
  two jacks) is one plug. `expression` and `footswitch` accept each other
  (dual-mode TRS control jacks). Found 2026-09-16: `add_cable` double-booked a
  thru box output and accepted a cable between two expression INPUTS.
- **Output is first-class.** An audio output port may carry an `output_role`
  (`main`/`monitor`/`sub`/`stem`/`cue`); the rig's output DESTINATION is an
  abstract OUT / front-of-house node (roles `["monitor"]`, `server_device_id:
  null`), not the specific mixer (§3). `note?` on Node/Edge marks provenance the
  graph cannot hold (`[planned]` / `[trialing]` cabling); advisory, never keys diff.

## Reference implementation (server side)

The zero-dep package is bound to this MCP server in
`packages/core/src/protocol-generic/openrig/` (the descriptor -> `DeviceSeed`
adapter + the `MCP_RIG_MANIFEST` loader) and surfaced through `describe_rig`.
That bridge lives in core, NOT here (keep this package extractable).

## Layout

```
packages/openrig/
  src/
    types.ts            # domain model (projection of schema/rig.schema.json)
    routing.ts          # relaysSignal / consumesSignal: how a node transforms a signal (§5.6)
    validate.ts         # validateRig: referential integrity + graph checks (§6)
    compat.ts           # checkRigCompatibility: cross-device BINDING + CABLE agreement + capability-legality (§4)
    audio.ts            # checkAudioOutput: "will I hear this instrument?" reachability to a monitor node
    portRules.ts        # port DIRECTION (kind default, declared `direction` wins) + OCCUPANCY (one plug per jack; summing inputs + duplex links excepted)
    capacity.ts         # checkRigCapacity: "where is there room to plug something in?" free/used/reserved ports
    attach.ts           # rankAttachments: "where should THIS new device plug in, and why there?" (planner, not a check)
    bootstrap.ts        # bootstrapRig(seeds): seed nodes from a generic DeviceSeed[]
    cytoscape.ts        # toCytoscapeElements: view-only render projection (for a Cytoscape.js renderer)
    view.ts             # buildRigView + renderRigText: the topology JOINED to all four checks
    repertoire.ts       # L2/L3 (§7): Song / Repertoire / Performance types, validateRepertoire, planSong (a plan is data: verbs to replay, never a save; a section_map `container` is a by-hand load)
    examples/looperHub.ts  # the §10 worked example, typed fixture + golden
    index.ts            # public surface
  schema/rig.schema.json # normative JSON Schema (draft 2020-12); hand-kept in sync with types.ts
  test/run-all.ts       # self-contained golden runner (npm test)
```

**Four checks, four questions (keep them separate).** `validateRig` = "is the
graph well-formed?" (referential integrity, MIDI cycles, clock topology).
`checkRigCompatibility` = "will the cross-device MIDI coordination WORK?" (do a
binding's two ends agree, is the mapping legal for the gear, for governed
bindings AND for ungoverned cables; needs an injected
`CapabilityLookup` so the package stays zero-dep). `checkAudioOutput` = "will I
actually HEAR each instrument?" (audio reaches a monitor node). `checkRigCapacity`
= "WHERE IS THERE ROOM to plug something in?" (free vs used vs reserved ports,
plus a `free_by_kind` lookup). Capacity exists because free capacity is a FACT of
the manifest that was being INFERRED and got inferred wrong: on 2026-07-25 the
manifest recorded a sequencer's second DIN out as `"MIDI Out (unused)"` and the
recommendation was still to daisy-chain around a full thru box. Consult
`free_by_kind` before ever proposing a chain, a thru box, or a splitter. Do not
fold them together: each answers a distinct question and the `§10` example must stay

**`buildRigView` (view.ts) is the RENDER model, and it runs all four checks
itself.** Every renderer wanted so far (a flow diagram, a text list, a chat
artifact) needs the check results joined onto the topology, and each was
re-deriving that join by hand; `toCytoscapeElements` drops them entirely. A
caller that ran three of four checks would produce a view quietly missing a
verdict, so the join owns the calls. `renderRigText` lives beside it because a
text rendering that answers the same questions as the diagram is an
accessibility ship gate (`docs/design/accessibility-blind-support.md`), and a
ship gate belongs where the golden tests are. Two traps this found on its first
real manifest, both now covered by negative cases: an audio edge may reach the
renderer with **no `channels`** (the type forbids it, JSON on disk does not), and
a binding is named on a **`MidiSignal`** as often as on the `Edge`, because one
DIN cable carries clock plus transport plus three note streams and only one of
them is the governed contract. Read only `Edge.binding` and a fully governed rig
reports as fully ungoverned.

**`rankAttachments` (attach.ts) is a PLANNER, not a fifth check.** Checks judge a
rig you already have; this one chooses between rigs you could have. Two rules it
must keep: hard constraints **eliminate** (a port that cannot carry the signal is
not a low-ranked candidate, it is not a candidate), and survivors rank
**lexicographically**, never by a weighted score. Do not "simplify" the tiers into
one number: hops and relay-dependencies share no unit, so any weighting is
invented and untestable. Read the header comment before changing the tier order,
it records why daisy-chaining loses on single-point-of-failure grounds rather
than the weaker latency argument.
`validateRig`-clean even while it is deliberately audio-incomplete (its Circuit /
SPD-SX have audio outs but no audio cables, so `checkAudioOutput` flags them,
correctly, which is why audio lives OUTSIDE `validateRig`).

## Build + test

`npm run build` (tsc), `npm run typecheck`, `npm test` (tsx test/run-all.ts).
Wired into the root `build` / `typecheck` / `test:no-server` chains, so root
`npm run preflight` covers it.

## Conventions

- ES modules, `NodeNext`, zero runtime deps (like `fractal-midi`).
- **No em dashes** anywhere (project-wide rule). Use commas / colons / parens.
- The JSON Schema is the normative artifact; `types.ts` is its projection. When
  the model changes, update BOTH and keep them in sync (an ajv-based conformance
  test is a Phase A.2 follow-up).
- When adding a validator check, add a targeted negative case in
  `test/run-all.ts`.
- Keep the model **extractable**: no imports from server packages, no
  server-only assumptions. This package may depend on nothing in the monorepo.
