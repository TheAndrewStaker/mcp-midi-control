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
    bootstrap.ts        # bootstrapRig(seeds): seed nodes from a generic DeviceSeed[]
    cytoscape.ts        # toCytoscapeElements: view-only render projection
    examples/looperHub.ts  # the §10 worked example, typed fixture + golden
    index.ts            # public surface
  schema/rig.schema.json # normative JSON Schema (draft 2020-12); hand-kept in sync with types.ts
  test/run-all.ts       # self-contained golden runner (npm test)
```

**Three checks, three questions (keep them separate).** `validateRig` = "is the
graph well-formed?" (referential integrity, MIDI cycles, clock topology).
`checkRigCompatibility` = "will the cross-device MIDI coordination WORK?" (do a
binding's two ends agree, is the mapping legal for the gear, for governed
bindings AND for ungoverned cables; needs an injected
`CapabilityLookup` so the package stays zero-dep). `checkAudioOutput` = "will I
actually HEAR each instrument?" (audio reaches a monitor node). Do not fold them
together: each answers a distinct question and the `§10` example must stay
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
