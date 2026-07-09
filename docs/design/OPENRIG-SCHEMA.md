# OpenRig: a portable schema for a musician's rig (design proposal)

> Status: **design proposal, not built.** Layer-1 (topology) design for review. No
> server code yet; build is sequenced **after 0.6.0 ships** (see "Sequencing").
> Working name: **OpenRig** (provisional). This doc seeds a future standalone
> open-spec repo; this MCP server is its reference implementation + first
> consumer, and the maintainer's real rig is its first (private) instance.
>
> **Hardened 2026-07-08** after a 5-lens adversarial review. Changes folded in:
> node-internal routing (consume/pass/merge, §3+§5.6), an exhaustive signal
> taxonomy with clock separated from transport + note/CC payloads (§3), an
> honestly-scoped validator (§6), a **configuration-vs-capability split with
> editable, change-propagating cross-device bindings + a compatibility check**
> (§4), instance disambiguation + a graph-diff keying contract (§8), a
> `$schema`/versioning contract (§3+§9), and cycle/clock-well-formedness checks
> (§6). Decisions locked: L3 is **authored-into-hardware** (§7), L2 **is** the
> setlist/recall manifest (§7), and sequencing stays **topology-first + standalone
> spec** (maintainer's call over the review's value-first counter, §9). Channels
> verified against the shipped Circuit descriptor + rig doc (ch3 Hydra, ch4 SPD-SX,
> ch5 RC-505 CTL, ch16 Circuit project, ch10 Circuit-internal drums).

## 1. Why this exists

The project's north star is **"configure my whole rig for a performance — a set
of songs or pieces — by conversation, and move through it live."** A rig is rarely
set up for one song in isolation; it is configured for a show / set of many songs,
and the hard part is BOTH the per-song setup AND the **transitions between songs**
(one stomp advancing the whole rig to the next piece — the RC-505 recalls its
memory, the Circuit loads the next project, the AM4 changes scene, all together).

The blocker: the server knows what each *supported* device can do (device
descriptors + `describe_rig`) but has **no structured model of how the gear is
actually wired** — which box feeds which, where the clock originates, what MIDI
flows on which channel. You cannot reason about "route the drums to the SPD-SX,"
"set the rig for this song," or "advance the whole rig to the next song" without
that graph.

And the manifest is not just a *record* — it is the **configuration layer** the
server uses to make devices **compatible**. The whole point of this project is
that the channels, CC numbers, and notes LINE UP across boxes (the AM4's scene CC
must be a CC the RC-505 can source and is assigned to a track; the note the
Circuit sends must be a note an SPD-SX pad answers on the channel it listens on).
So OpenRig actively **checks** those cross-device matches and, where the server
can write the setting, **reconciles** them — and every mapping is **user-editable
and change-propagating**: swap the note map (GM today, something else tomorrow),
move a device to a different channel, or renumber the AM4 trigger CC, and the tool
updates BOTH ends of the contract so they stay matched (see §4 "Configuration vs
capability, and bindings").

OpenRig is that graph plus the layers a performance needs on top of it: a
declarative manifest, **voice-authored**, **shareable**, **diffable**, and
**renderable** (view-only UI). Four layers; L1 is what this doc specifies, L2/L3
are deferred sketches:

| Layer | What | Status |
|---|---|---|
| **L0 — Device capabilities** | What each instrument can do (params, transport, scenes, voice map, save). | **Exists** in the device descriptors. OpenRig *references* it, never duplicates it. |
| **L1 — Rig topology** | Nodes (instruments + roles) + typed edges (audio cables AND MIDI links, with channel + direction). | **This doc.** The core new artifact. |
| **L2 — Repertoire** | The LIBRARY of songs/pieces you can play, each with its own target rig config (device recalls, routing, tempo) referencing L1. The reusable building blocks. | Deferred sketch (§7). |
| **L3 — Performance** | An ORDERED set of repertoire songs for a specific show, plus the transitions between them — how the rig moves song→song live. What the rig is actually configured FOR. | Deferred sketch (§7). |

## 2. Prior-art decision: invent-but-borrow

A landscape scan (Gig Performer, MainStage, Ableton `.als`, VCV Rack, JACK,
MIDI-CI Property Exchange, GraphML, Cytoscape, JSON Graph Format, Equipboard,
pedal planners) found **no format that models typed audio+MIDI edges + physical
topology + per-device capabilities together**. The topology world (JACK, VCV) has
no capability layer; the capability world (MIDI-CI PE) has no topology; the gear
world (Equipboard, pedal planners) exposes no structured connection graph. So we
define our own JSON manifest, but borrow four proven ideas so we neither reinvent
nor lock in:

1. **Serialization + render shape → Cytoscape.js `elements` model** (`nodes[]` +
   `edges[]`, each with `data.id`, edges with `data.source`/`data.target`). It is
   plain JSON (fits our TS/MCP stack), a JS library renders it directly (a UI is
   nearly free), and it allows **multiple edges between the same two nodes** plus
   **compound/parent nodes**. Chosen over JSON Graph Format, whose spec forbids
   mixing edge types in one graph — the exact thing a rig needs. We keep the
   manifest domain-native (rich typed fields) and treat "emit Cytoscape elements"
   as a trivial projection, so we are not boxed into a renderer's vocabulary.
2. **Physical connection points → the PORT concept (GraphML `sourceport`/
   `targetport`, JACK client→port→connection).** Every node has explicit **ports**
   (audio jacks incl. L/R, MIDI DIN in/out/thru, USB-MIDI); edges attach to a
   source-port and a target-port, not just node-to-node. This makes "channels vs
   ports" fall out cleanly and lets a renderer draw a cable to the right jack.
3. **Capability vocabulary → mirror MIDI-CI Property Exchange resources**
   (`DeviceInfo`, `ChannelList`, `ProgramList`, `ModeList`, Controller). It is the
   only standardized "what can this device do" model, it is already JSON, and
   mirroring it means a future MIDI 2.0 device could **auto-populate** its
   capability block by live query. It also aligns with our existing
   `describe_device` surface.
4. **Device type identity → the SysEx Identity Reply triple** (manufacturer ID /
   device family / family-member, + optional gear-catalog id). This is a stable
   **type key** distinct from a node's per-rig instance id — precisely what makes
   rigs comparable/diffable ("both rigs contain a Fractal FM3") and catalog-matchable.

We do **not** adopt GraphML as the on-disk format (XML, verbose, needs conversion
to render) — only its port ideas. We do **not** adopt MIDI-CI PE as the container
(a live SysEx protocol, no topology, membership-gated schema) — only its
capability vocabulary.

## 3. The topology model (L1)

A rig is a directed **multigraph**. Plain JSON:

```jsonc
{
  "$schema": "https://openrig.dev/schema/0.1/rig.json",  // RESERVED future URL (not live yet); the normative JSON Schema is stood up at graduation (§9). TS types are a projection of it.
  "openrig_version": "0.1",                              // semver; consumers MUST reject a higher MAJOR, MUST ignore unknown fields
  "id": "example-rig",
  "name": "Example looper-hub rig",
  "nodes": [ /* Node[] */ ],
  "edges": [ /* Edge[] */ ]
}
```

**Serialization + version contract.** The JSON Schema at `$schema` is the
normative artifact; TypeScript types are generated from it. `openrig_version` is
semver: evolution is **additive-only within a major** (new optional fields, new
enum members), a consumer **MUST ignore unknown fields** (so a newer rig opens in
an older tool, degraded) and **MUST reject a higher major**. The fixed `roles`
enum and `signal.type` enum grow only in minor bumps; a breaking change (field
removal/retype) is a major bump with a published migration. A loader runs a
**referential-integrity check** (every edge endpoint resolves to a node + a
declared port; node ids unique; no dangling `physical_link_id`).

### Node

```jsonc
{
  "id": "rc505",                         // instance id, unique within the rig
  "name": "RC-505mk2",                   // display
  "identity": {                          // stable TYPE key (borrowed from SysEx Identity)
    "manufacturer": "Boss",
    "family": "RC-505mk2",
    "catalog_id": null                   // optional external gear-DB id
  },
  "server_device_id": "rc-505mk2",       // links to a registered descriptor when supported; null for opaque gear
  "roles": ["looper", "clock_master", "midi_router", "mixer"],
  "ports": [
    { "id": "main_out", "kind": "audio_out", "label": "MAIN OUT L/R", "audio": "stereo" },
    { "id": "main_in",  "kind": "audio_in",  "label": "MAIN IN",      "audio": "stereo" },
    { "id": "midi_out", "kind": "midi_din_out", "label": "MIDI OUT" },
    { "id": "midi_in",  "kind": "midi_din_in",  "label": "MIDI IN" }
  ],
  // How this node treats signals arriving on its input ports — the load-bearing
  // fact topology alone can't hold (§5.6). Absent = "unknown / pass-through".
  "routing": {
    "consume": [ { "port": "midi_in", "kind": "midi", "type": "cc", "channel": 5 } ],   // acts on it, does NOT relay (RC-505 scene CC -> track flip)
    "pass":    [ { "port": "midi_in", "to": "midi_out", "kind": "midi", "type": "pc" } ],// soft-thru relays it (the ch16 PC -> Circuit)
    "originate":[ { "port": "midi_out", "kind": "midi", "type": "clock" } ],             // merges its OWN clock onto the out
    "priority": "midi>usb>internal"        // for clock-merge conflict resolution (device-documented)
  },
  "server_device_id": "rc-505mk2",       // links to a registered descriptor when supported; null for opaque gear
  "capabilities": null                   // OPTIONAL + progressive (§4). null = "not declared".
}
```

- **`ports[].kind`** (physical endpoint): `audio_out` / `audio_in` / `midi_din_in` /
  `midi_din_out` / `midi_thru` / `usb_midi` / `usb_serial` / `expression` /
  `footswitch` / `cv` / `analog_clock`. A `usb_midi` / `usb_serial` port may carry a
  `group` sub-address (Circuit MIDI1/MIDI2, FM3 virtual cables are addressable
  groups on one USB endpoint). An audio port declares `audio: "mono" | "stereo"`;
  two mono ports/edges that form one stereo pair share a `pair` id, and a mixer
  input is a summing destination (N edges in is legal).
- **`routing`** (per node): which incoming signals it **consumes** (acts on, does
  not relay), **passes** (soft-thru to an out-port), and **originates/merges** onto
  an out-port, each scoped by kind/type/channel. This is what makes reachability
  computable *through* a node instead of assuming a cable's signals arrive intact
  downstream (§5.6). A plain thru box is the degenerate pass-all case.
- **`roles`** — a **fixed core enum** (multi-valued; a node holds several), so
  rigs are comparable in a shared vocabulary. Not too limiting because (a) roles
  compose — you tag a device with as many as apply rather than needing one perfect
  label, (b) the enum is **versioned** and grows in spec revisions, and (c) an
  optional free-form **`extra_roles: string[]`** escape hatch carries anything the
  core set misses (advisory only — the diff/compare + standard matching key on the
  fixed `roles`, never on `extra_roles`, so extensions never fragment comparison).
  Core enum v0.1, grouped by dimension (stored as one flat set):
  - **audio:** `sound_source`, `effect`, `mixer`, `monitor`, `audio_interface`
  - **control:** `controller`, `clock_master`, `clock_follower`, `midi_router`, `host`
  - **performance:** `looper`, `sequencer`, `sampler`
  e.g. the RC-505 = `["looper","clock_master","midi_router","mixer"]`.
- **`server_device_id`** is a **soft reference** to a registered descriptor. When
  it resolves, the descriptor is authoritative for that node's capabilities, roles,
  and channel-bearing signals (§4) — do not restate them. When it does NOT resolve
  (a renamed/absent descriptor), the node **degrades to opaque** (identity + ports
  still valid) and the loader emits a drift *warning*, never an error. It is the
  authoritative **type-key** when present; `identity` is the fallback key for
  opaque gear, and the two must be consistent when both appear (§8).

### Edge

```jsonc
{
  "id": "rc505.midi_out->quadra.in",
  "from": { "node": "rc505", "port": "midi_out" },
  "to":   { "node": "quadra", "port": "in1" },
  "physical_link_id": "din-cable-3",     // shared by the two directed edges of one physical cable
  "directed": true,
  "signal": {
    "kind": "midi",
    "signals": [                         // MULTIPLE logical signals on ONE cable (§5.1)
      { "type": "clock" },
      { "type": "pc",  "channel": 16 },
      { "type": "cc",  "channel": 5, "cc_numbers": [80, 81, 82, 83] }
    ]
  }
}
```

Audio edge:

```jsonc
{
  "id": "am4.out->rc505.main_in",
  "from": { "node": "am4", "port": "out_lr" },
  "to":   { "node": "rc505", "port": "main_in" },
  "physical_link_id": "trs-pair-1",
  "directed": true,
  "signal": { "kind": "audio", "channels": ["L", "R"] }   // mono = ["M"]; a stereo pair split across two mono cables shares a `pair` id
}
```

**Signal taxonomy (exhaustive; the enum grows only in minor bumps).**
- **`signal.kind`**: `audio` · `midi` · `control_voltage` · `expression` ·
  `footswitch` · `analog_clock`. This is a strict superset of the non-audio/non-MIDI
  **port** kinds, so every port kind has an edge type that can attach to it (the
  FS-5U→CTL and AM4 EXP edges are now expressible; a modular/CV or DIN-sync rig
  too). **Invariant:** a port's `kind` constrains which `signal.kind` may attach —
  a free validator check.
- **`signal.type`** (for `kind: "midi"`): `clock` · `transport` (Start/Stop/Continue)
  · `spp` · `song_select` · `pc` · `cc` · `nrpn` · `note` · `sysex` ·
  `active_sensing`. **`clock` and `transport` are DISTINCT** — the rig deliberately
  runs clock with transport off (SYNC OUT=ON, START=OFF), so folding them into one
  "sync" type would make two differently-configured rigs diff as identical. A
  `channel` (1-16) is a **property of the signal**, never a port or node; `clock`
  and `transport` carry none. Note transport-Rx may be *bundled* with clock-Rx on
  the target (some devices can't separate them) — a source-side property the diff
  engine records.
- **Signal payload** (per-type detail, so an edge states the full cross-device
  contract, not just the channel): a `cc` signal carries `cc_numbers[]`; a `pc`
  signal a `values[]`/range; and a **`note` signal carries `notes[]`** and/or a
  **`note_map`** (note number -> voice/pad, e.g. `{36:"kick",38:"snare",42:"hat"}`).
  This makes the sequencer->sampler edge self-documenting: the Circuit
  MIDI-2 -> SPD-SX cable is `{kind:midi, type:note, channel:4, note_map:{36:kick,38:snare,42:hat}}`
  (the General MIDI map on ch4) which is a DIFFERENT note set from the Circuit's
  INTERNAL drum triggers (notes 60/62/64/65 on ch10) - the exact internal-vs-external
  confusion this project has to get right. For a supported device the note map is the
  descriptor's `voice_map` (source of truth, §4); the manifest declares the subset on
  the wire and the loader flags any note that does not match the target pad/kit.
- **`enabled`** (optional, default true): an edge/cable whose *meaning* changes per
  song (a re-patched patchbay, a per-memory ASSIGN/THRU change) toggles here so a
  performance step can activate a different sub-graph on the same physical cabling.

## 4. Capability layer (L0 reference, not duplication)

- **Supported gear** (`server_device_id` set): capabilities are **derived** from
  the registered descriptor at read time. The manifest stores the pointer, not a
  copy, so it can never drift from the code.
- **Opaque / unsupported / passive gear** (a DI box, a tube amp, a non-MIDI fuzz):
  a legitimate node with identity + ports + roles and **`capabilities: null`**.
  Capabilities are **optional and progressive** — filled only where there is
  evidence (owner-entered, MIDI-CI-queried, or catalog-matched), mirroring the
  project's evidence-not-guess ethos. An amp with audio ports and zero MIDI
  capability is correct, not a schema error, and must never force fabricated data.
- When declared, the capability block **mirrors MIDI-CI PE** shape
  (`device_info`, `channel_list`, `program_list`, `mode_list`, `controllers`) so a
  MIDI 2.0 device can auto-populate it later (and MIDI 2.0 UMP Endpoint / Function
  Block discovery is the topology-populating counterpart PE lacks).

### Configuration vs capability, and cross-device bindings

There are two different things and the manifest must not confuse them:
- **Capability** (from the descriptor, a fixed fact): what a device *can* do — the
  RC-505 *can* source an ASSIGN from a MIDI CC in 01-31 / 64-95; the SPD-SX pads
  *can* answer notes on their GLOBAL channel; the AM4 *can* emit scene MIDI on any
  channel.
- **Configuration** (in the manifest, the user's editable choice): what the user
  *decided* — the RC-505 RX CTL is on **ch5**, the SPD-SX GLOBAL is on **ch4**, the
  looper-track-3 trigger is **CC#80**, the drum notes are the **General Midi** map.
  These are not device facts; they are choices the user will change.

**Bindings — the cross-device contracts the tool keeps matched.** A coordination
only works when a sender's emitted signal equals a receiver's expectation on the
same channel. That match is a **binding**: one named, editable object that ties
both ends together, so a re-map updates BOTH, never one.

```jsonc
{
  "bindings": [
    {
      "id": "looper_track3_trigger",
      "from": { "node": "am4",   "emits":  { "type": "cc", "channel": 5, "cc": 80 } },   // AM4 scene MIDI slot
      "to":   { "node": "rc505", "expects":{ "type": "cc", "channel": 5, "cc": 80,       // RC-505 ASSIGN source
                                             "target": "TRK3 REC/PLY" } }
    },
    { "id": "song_part_select",
      "from": { "node": "am4",     "emits":   { "type": "pc", "channel": 16 } },          // -> Circuit Project
      "to":   { "node": "circuit", "expects": { "type": "pc", "channel": 16 } } },
    { "id": "drum_note_map",
      "from": { "node": "circuit", "emits":   { "type": "note", "channel": 4, "note_map": "GM" } },
      "to":   { "node": "spdsx",   "expects": { "type": "note", "channel": 4, "note_map": "GM" } } }
  ]
}
```

- **The binding is the SINGLE authoritative source for a governed signal — edges
  and node routing DERIVE from it, never restate it.** This is what makes
  change-propagation real instead of aspirational: a governed cross-device signal
  (the looper trigger, the part-select PC, the drum note map) is authored ONCE, in
  the binding. A governed edge references it by id (`{ "from": …, "to": …,
  "binding": "looper_track3_trigger" }`) and the edge's `signals[]` for that link is
  *projected* from the binding at load/render time; a node's `routing.consume`/`pass`
  entry for a governed signal likewise references the binding id rather than
  re-typing the channel/CC. So editing `looper_track3_trigger` CC#80 → CC#20 updates
  the one binding and every edge/routing projection follows automatically — there is
  no second copy to drift. (Ungoverned signals — a plain audio cable, a one-off CC —
  still carry their `signal` inline on the edge; bindings are only for the
  cross-device contracts you want kept matched.) The user owns the mapping; the
  binding is the one place it lives. Swap the note map away from GM, or move the
  SPD-SX to another channel, and every projection updates from the single edit.
- **Applying an edit writes each side where the server can**, and honestly flags
  where it can't: the AM4 scene-MIDI slot via `set_params` (live surface); the
  RC-505 ASSIGN via the boss-rc storage author path (storage surface). Because
  those are **two mutually-exclusive USB surfaces** on the RC-505 (live MIDI vs
  STORAGE mode), a single binding edit that touches both the RC-505 *and* a
  live-MIDI device cannot complete in one breath — the server applies what it can
  on the current surface and reports the pending side ("switch the RC-505 to
  STORAGE mode to finish writing this ASSIGN"). A device setting the server can't
  write at all (a hardware RX-channel switch) is surfaced as a manual step.
- **The compatibility check** verifies the binding against **hardware + capability**
  (not against the edges — those can't drift, they're derived): does the receiver's
  actual device config match what the binding says (is the RC-505 ASSIGN really on
  CC#80 → TRK3? is the SPD-SX GLOBAL really ch4?), and is the mapping
  **capability-legal** (a re-map to CC#40 is *rejected* — the RC-505 can only source
  ASSIGN CCs in 01-31 / 64-95; a note with no matching SPD-SX pad is flagged).
  Capability (descriptor) bounds the legal configuration; the binding records the
  choice within it.
- This is the L1 **addressing** contract (stable rig config: *which* CC/channel/
  note carries the looper-trigger / part-select / drum-hit). The per-song *values*
  (which project #, which kit #, whether the trigger fires) live in L2/L3, which
  reference these bindings rather than restating the addressing.

**Source-of-truth rule (who wins when the manifest and a descriptor disagree).**
For a `server_device_id`-backed node, the descriptor is authoritative for
**capability** (what the box can do); the manifest is authoritative for
**configuration** (the user's channel / CC / note-map choices) and for **cables,
opaque nodes, node-internal routing, and clock-source topology** the descriptor
cannot know. A configuration choice is rejected only when it **exceeds a
capability** (an illegal ASSIGN CC, a channel the device can't receive on) — NOT
merely because it differs from a default. The descriptor's
`external_tracks` / `voice_map` / `transport` / `pattern_realizers` **seed** a
node's ports/roles and the *default* channels (so a fresh manifest starts
correct and the §10 Circuit→SPD-SX example is ch4, not the ch10 an early draft
guessed), but the user then **overrides** them as configuration (the SPD-SX
GLOBAL is ch4, a deliberate choice, not drift from the descriptor's GM default).
The loader flags a `signal.channel` only when it is capability-illegal, never
when it is a legal override. This L1 configuration also supersedes the shipped
`MCP_RIG_LINKS` / `rig_links` host-track→device wiring `describe_rig` returns
today: OpenRig L1 is the one source of truth for wiring, and `describe_rig` reads
it rather than a second env-var map.

## 5. The hard modeling decisions (resolved)

1. **Physical cable ≠ logical signals.** One DIN/USB cable simultaneously carries
   clock + PC + CC + notes. An edge is one physical link (`physical_link_id`)
   carrying a **`signals[]` set**, each `{type, channel?, cc_numbers?}` — never a
   single "midi" type. This is why JSON Graph Format was rejected and Cytoscape/
   GraphML chosen (multigraph + multi-attribute edges).
2. **Channels vs ports.** A **port** is physical (anchors an edge). A **MIDI
   channel (1-16)** is a logical sub-address on that port and is a **property of
   the signal**, never its own node/port. A clock signal has no channel; a
   scene-control CC pins one.
3. **Bidirectional links → two directed edges** sharing a `physical_link_id`
   (USB-MIDI is duplex; DIN out↔in pairs are common). Directed edges keep clock/
   role semantics unambiguous (a clock master is the *source* of a `clock` edge)
   and render with correct arrowheads. "both" is UI sugar only.
4. **Splitters / mergers / thru-boxes / MIDI patchbays → first-class `midi_router`
   nodes with their own ports** (fan-out = multiple edges from its out-ports), not
   graph hyperedges. Keeping a plain directed multigraph (no hyperedges) stays
   Cytoscape-renderable and diffable. A patchbay's current routing is just which
   internal port-to-port edges are active.
5. **Opaque gear → capabilities optional/progressive** (see §4).
6. **A node transforms signals; topology alone is not reachability.** An edge's
   `signals[]` says what is *on a cable*, never what a node *does* with it. The
   rig's whole one-stomp orchestration is a transform *inside* the RC-505: it
   **consumes** the scene CC (→track flip, not relayed), **passes** the ch16 PC
   through soft-thru (→Circuit), and **merges** its own generated clock onto the
   same out-cable. So two rigs with identical nodes+edges behave differently
   depending on THRU/RX-channel settings a plain edge can't record. Resolution: the
   per-node **`routing`** block (§3) + legal **self-node edges**
   (`from.node === to.node`), and reachability is computed *through* those rules,
   not by assuming a cable's `signals[]` arrive intact downstream. A thru box is
   the degenerate pass-all case; the Quadra 1→N collapses to pass-all-to-N
   (removing the §10 duplication where every out-edge restates the same signals).

## 6. Authoring, rendering, validation

- **Bootstrap, don't dictate.** A rig is NOT hand-typed cable by cable. The server
  **seeds** the manifest from `listRegisteredDevices()` (nodes + `server_device_id`)
  and each descriptor's `external_tracks` / `voice_map` / `transport` (the
  channel-bearing signals it already knows), then the human corrects and adds the
  parts the server can't see (physical cables, opaque gear, clock topology,
  node-internal routing) by voice. Voice-dictating ~20 cables blind is the
  exception, not the design center.
- **Render** (view-only): a pure `toCytoscapeElements(rig)` projects the domain
  model (a labeled directed multigraph with ported endpoints and multi-signal
  edges) to Cytoscape `elements[]` — that projection (ports → parent nodes,
  multi-signal edge → one edge with typed metadata) is the actual work, after which
  a JS library renders/pans it. A song's active routing = a highlighted sub-graph;
  stepping a performance animates it. No editing in the UI — authoring stays voice.
- **Validate — honestly scoped.** `describe_rig` today only enumerates registered
  descriptors + matches OS port names, so mark every manifest fact as one of:
  - **runtime-confirmable** — a supported device's MIDI/storage *presence* (and even
    that is partial: a matched USB port name is not proof a DIN cable is plugged).
    Special-case the FM3 serial path, which reads `connected:false` when plugged, so
    it is **not** reported as drift (the doc's earlier "FM3 not found" example was
    the exact false-positive the code already warns about).
  - **declared, not server-observable** — every edge, every channel, every opaque
    node (no descriptor → never in the roster), all audio. The validator must NOT
    claim to "validate topology"; it confirms presence and reports declared-vs-seen
    drift only where it can actually see.
  - An optional **`verify_topology`** sends a probe (a PC on a declared channel) and
    asks the human to confirm receipt — the only way an edge/channel is checkable.
- **Cheap, high-value graph checks** (pure, from the topology, no hardware):
  **MIDI cycle detection** (a directed MIDI multigraph is exactly the structure that
  catches the feedback loops the rig fights with AM4 Thru=OFF / RX≠channel), and
  **clock-subgraph well-formedness** — exactly one `clock_master`, the clock
  sub-graph is acyclic, and every `clock_follower` actually receives a `clock` edge.
  A silent two-master or orphaned-follower ruins a performance; these catch it
  offline.

## 7. Repertoire + Performance (L2 / L3, deferred sketch)

The rig is set up for a **performance** (a set of songs/pieces), not one song in
isolation. So the song layer is two related structures, both deferred (designed
after L1 lands): a **repertoire** (the reusable library) and a **performance**
(an ordered set drawn from it for a show).

### L2 — Repertoire (the library) — IS the setlist/recall manifest

Every song/piece you can (or want to) play, each with its own target rig config.
Named **repertoire** (musician's term; carries a status naturally). This is the
"aspiring songs" idea with a real lifecycle. **It is not a parallel design: L2 IS
the setlist/recall manifest already scoped in the backlog** (the artifact that
binds each song to its device recalls — e.g. the Circuit project slot each AM4
scene's ch16 PC selects). OpenRig L2 *is* that manifest, not a second graph beside
it; the two must not diverge.

```jsonc
{
  "repertoire": [
    {
      "id": "song-slug",
      "title": "…",
      "source": { "kind": "songsterr", "id": 1467797 },   // or { kind: "midi", path } / manual
      "tempo_bpm": 72,
      "status": "aspiring",                                // aspiring | learning | gig_ready
      "rig_config": {                                      // OPTIONAL; references L1 nodes/ports/channels
        "sections": [ /* per-section device recalls (RC-505 memory, Circuit project,
                          AM4 scene), PC/scene, per-part routing — resolved against L1 */ ]
      }
    }
  ]
}
```

A song's `rig_config` references L1 by `node`/`port`/`channel`, so "what plays
this part" resolves against the topology. This is where RC-505 memory-recall, AM4
scenes, and Circuit project-per-part get orchestrated per song.

### L3 — Performance (the set / show)

An ordered selection of repertoire songs for a specific show, plus the
**transitions** between them — how the whole rig advances song→song.

**The transition model is AUTHORED-INTO-HARDWARE, not live agent-replay** (the
decided shape — the stage reality is feet-only, laptop off-stage). A transition
is a spec for what gets **written into the hardware ahead of the show** so that
one physical stomp moves the whole rig with no computer in the live path: the AM4
preset is authored to emit its scene-MIDI (a PC/CC per other box), the Circuit
pack + RC-505 memories are pre-loaded, etc. OpenRig L3 records that choreography;
applying it is the server writing those presets/packs offline (through the
existing bare verbs + safe-edit gates), then the musician performs it with feet.

```jsonc
{
  "performance": {
    "id": "set-summer",
    "name": "Summer set",
    "rig": "example-looper-hub",                     // the L1 rig this set targets
    "mode": "authored_into_hardware",                // default; "server_executed" = agent-present variant
    "songs": [                                       // ORDER = play order (a song may repeat)
      { "ref": "song-slug", "tempo_override": null,
        "authored": {                                // what is WRITTEN to hardware for this song, offline
          "am4":     { "scene": 2, "emits": [ { "type": "pc", "channel": 16, "value": 5 },
                                              { "type": "pc", "channel": 4,  "value": 12 },
                                              { "type": "cc", "channel": 5,  "cc": 81, "value": 127 } ] },
          "circuit": { "project": 5 },
          "rc505":   { "memory": 3 },
          "spdsx":   { "kit": 12 } },
        "advance": "am4_scene_stomp" }               // the ONE physical action that moves the rig here
    ]
  }
}
```

Each song declares what is **authored into each device** and the single physical
**advance** action (an AM4 scene stomp emitting the recalls). A `mode:
"server_executed"` variant exists for the agent-present case (rehearsal / studio,
laptop in the loop): there the recalls are replayed live — but strictly as a
**stored resolved plan the agent replays through the existing bare verbs under the
connection arbiter + safe-edit gates**, never a new reasoning engine (Decision 2).
A performance is the shareable "here's my whole show" artifact; the repertoire is
the reusable library it draws from.

## 8. Compare / diff

The per-rig `instance_id` vs the stable `identity` type-key is what makes rigs
comparable. Two use cases, both fall out of a declarative JSON manifest (`git
diff` / structural diff):

- **My rig over time (LEAD)** — version-control my setup; diff before/after a
  change. The first-built tooling: the manifest lives under version control and
  the primary view is a **timeline / before-after diff of my own rig** (what
  changed: a node added, a cable moved, a channel reassigned). Cheapest to build
  (plain structural diff) and the everyday use.
- **My rig vs. someone else's (NEXT)** — compatibility ("can I play their setlist
  on my rig?"), shared-rig community sharing. Same diff engine, a two-rig overlay
  keyed on the stable `identity` type-key. Fast-follow once the self-diff exists.

Decision: **lead with self-comparison** (rig over time), design the diff so the
two-rig overlay is a later reuse of the same engine, not a rewrite.

**Diff-keying contract (self-diff is the LEAD use case, so it must diff *well*).**
A naive `git`/structural diff over an array-of-objects multigraph is the worst
case for exactly the edits §8 advertises: reordering and id-churn both surface as
delete+add. So OpenRig diffs as a **graph**, not text:
- Node/edge `id`s are **stable and opaque** — authored once, never regenerated on
  edit (so re-cabling an edge is a *modify*, not delete+add). Pin **one** edge-id
  convention (semantic `am4-scene-cc`, not endpoint-derived `am4.out->rc505.in`,
  precisely so moving the cable keeps the id).
- The graph diff keys on `{stable node id + port role + signal type}`, so "moved a
  cable" / "reassigned a channel" render as targeted modifies.

**Duplicate instances (two identical devices).** `node.id` unique-within-rig is
not enough: two identical FM3s (or the two FS-5U's) share `identity`,
`server_device_id`, descriptor `port_match`, AND the arbiter lock key
(`connection_label ?? id`) — so the server would target the wrong unit and the
arbiter would falsely serialize two physical boxes as one. Contract: `node.id`
flows into an **instance-scoped endpoint / `connection_label`** (`fm3#2`) so
dispatch targets the right unit and the arbiter locks per physical endpoint; the
cross-rig diff key is `(type-key + per-instance ordinal)`. (v0.1 may constrain to
one-instance-per-model and defer this — see the open decisions.)

## 9. Sequencing

Sequencing is **topology-first + standalone spec from the start** — the
maintainer's call, made with the review's counter-argument on the table (the
review recommended a value-first internal recall-map MVP, deferring the public
spec until a second consumer, on the ground that one-producer-one-rig is a file
format not a standard; the maintainer chose to commit to the standard up front).

1. **Now:** this design doc (Layer-1 topology), committed **in this repo** under
   `docs/design/`. It is design-only — no code, nothing consumes it yet; committing
   it just versions the reviewed spec-of-record next to the code that will implement
   it (same as `device-archetypes-and-transport.md` / `connection-arbiter.md`).
2. **After 0.6.0 ships — build it, INCUBATED IN THIS REPO.** The JSON Schema, the
   validator, and the reference implementation live here first: this MCP server is
   the **reference implementation + first consumer** (`describe_rig` reads/validates
   a manifest, honestly scoped per §6, and auto-bootstraps it per §6), and the
   maintainer's real rig is the **first private instance** (a private `rig.json`,
   gitignored like today's `docs/_private/rig/`).
3. **Graduate to a standalone `openrig` repo ONLY at extraction** — when the schema
   has settled here and there is a reason to publish (a second consumer/author, or
   the deliberate "publish the standard" moment). Extraction moves the schema + spec
   docs + a public **sanitized** example out to their own repo and flips the
   reserved `$schema` URL live. Committing to the *standalone-standard intent* does
   not mean standing up the empty repo on day one; it means the schema is authored
   to be extractable (own `$schema`, versioning, no server-only assumptions) from
   the start.
4. **Later (phase two — song integration):** L2 (the setlist/recall manifest) then
   L3 (authored-into-hardware performance) and the view-only Cytoscape UI.

Keeping the build post-0.6.0 keeps the release feature-complete and gated only on
the hardware regression pass.

**Privacy / sanitize contract (sharing is not all-or-nothing).** A rig manifest
carries things that must NOT leave a private instance when shared: device serials,
`catalog_id` gear-DB ids (can point at a used-gear listing), custom node names,
and the entire L2/L3 layer (song titles, Songsterr ids, setlists). The spec
defines a canonical **`sanitize(rig)`** projection and a MUST-NOT-INCLUDE list;
"publish a sanitized example rig" means run that projection, never hand-redact.
The public example ships topology + types only, no repertoire.

## 10. Worked example (illustrative)

A minimal looper-hub rig: a looper acting as clock master + MIDI relay + audio hub,
an amp modeler feeding it audio and sending scene CCs, a groovebox sequencing a
sample pad, a MIDI thru box fanning clock/PC out, and one opaque passive cab.

```jsonc
{
  "openrig_version": "0.1",
  "id": "example-looper-hub",
  "name": "Example looper-hub rig",
  "nodes": [
    { "id": "rc505", "name": "RC-505mk2", "server_device_id": "rc-505mk2",
      "roles": ["looper","clock_master","midi_router","mixer"],
      "identity": { "manufacturer": "Boss", "family": "RC-505mk2" },
      "ports": [
        {"id":"main_in","kind":"audio_in"},{"id":"main_out","kind":"audio_out"},
        {"id":"midi_out","kind":"midi_din_out"},{"id":"midi_in","kind":"midi_din_in"} ] },
    { "id": "am4", "name": "Fractal AM4", "server_device_id": "am4",
      "roles": ["sound_source","effect"],
      "identity": { "manufacturer": "Fractal", "family": "AM4" },
      "ports": [ {"id":"out_lr","kind":"audio_out"}, {"id":"midi_out","kind":"midi_din_out"} ] },
    { "id": "circuit", "name": "Circuit Tracks", "server_device_id": "circuit-tracks",
      "roles": ["sequencer","sound_source"],
      "identity": { "manufacturer": "Novation", "family": "Circuit Tracks" },
      "ports": [ {"id":"out_lr","kind":"audio_out"},
                 {"id":"midi1","kind":"midi_din_out"}, {"id":"midi2","kind":"midi_din_out"} ] },
    { "id": "spdsx", "name": "SPD-SX", "server_device_id": "spd-sx",
      "roles": ["sampler","sound_source"],
      "identity": { "manufacturer": "Roland", "family": "SPD-SX" },
      "ports": [ {"id":"out_lr","kind":"audio_out"}, {"id":"midi_in","kind":"midi_din_in"} ] },
    { "id": "thru", "name": "MIDI Thru box", "server_device_id": null,
      "roles": ["midi_router"], "identity": { "manufacturer": null, "family": "generic-thru" },
      "ports": [ {"id":"in","kind":"midi_din_in"},
                 {"id":"out1","kind":"midi_din_out"}, {"id":"out2","kind":"midi_din_out"} ],
      "capabilities": null },
    { "id": "cab", "name": "Passive FRFR cab", "server_device_id": null,
      "roles": ["monitor"], "identity": { "manufacturer": null, "family": "passive-cab" },
      "ports": [ {"id":"in","kind":"audio_in"} ], "capabilities": null }
  ],
  "edges": [
    { "id":"am4-audio","from":{"node":"am4","port":"out_lr"},"to":{"node":"rc505","port":"main_in"},
      "directed":true,"physical_link_id":"trs-1","signal":{"kind":"audio","channels":["L","R"]} },
    { "id":"rc505-audio","from":{"node":"rc505","port":"main_out"},"to":{"node":"cab","port":"in"},
      "directed":true,"physical_link_id":"trs-2","signal":{"kind":"audio","channels":["L","R"]} },
    { "id":"am4-scene-cc","from":{"node":"am4","port":"midi_out"},"to":{"node":"rc505","port":"midi_in"},
      "directed":true,"physical_link_id":"din-1",
      "signal":{"kind":"midi","signals":[{"type":"cc","channel":5,"cc_numbers":[80,81,82,83]}]} },
    { "id":"rc505-clockhub","from":{"node":"rc505","port":"midi_out"},"to":{"node":"thru","port":"in"},
      "directed":true,"physical_link_id":"din-2",
      "signal":{"kind":"midi","signals":[{"type":"clock"},{"type":"pc","channel":16}]} },
    { "id":"thru-to-circuit","from":{"node":"thru","port":"out1"},"to":{"node":"circuit","port":"midi1"},
      "directed":true,"physical_link_id":"din-3",
      "signal":{"kind":"midi","signals":[{"type":"clock"},{"type":"pc","channel":16}]} },
    { "id":"circuit-to-spdsx","from":{"node":"circuit","port":"midi2"},"to":{"node":"spdsx","port":"midi_in"},
      "directed":true,"physical_link_id":"din-4",
      "signal":{"kind":"midi","signals":[
        { "type":"note","channel":4,"note_map":{ "36":"kick","38":"snare","42":"hat","46":"openhat" } },
        { "type":"pc","channel":4 } ]} }   // ch4 = Circuit MIDI-2; note_map = SPD-SX GM pads; PC ch4 = kit recall
  ]
}
```

Reads as: the AM4's amp audio goes into the RC-505 (which sums the loop) and out
to the cab; an AM4 scene change sends CC 80-83 on ch5 to the RC-505 to flip looper
tracks; the RC-505 is clock master and relays clock + a ch16 Program Change through
a thru box to the Circuit (project-per-song-part); and the Circuit sequences the
SPD-SX pads on its MIDI-2 out (ch4 = the Circuit's own `CH_MIDI2` default; the
SPD-SX's GLOBAL CH is *set* to 4 to match — a configuration choice on the SPD-SX
side, overriding its own descriptor default of ch10. An earlier draft wrote ch10
out of GM-drums reflex, exactly the hand-authored drift the source-of-truth rule
prevents). The cab and thru box are opaque nodes with no capability block.

---

**Resolved (2026-07-08):** (1) compare use case — **lead with self-comparison**
(my rig over time / version control), cross-rig overlay is a fast-follow on the
same diff engine (§8); (2) roles — **fixed core enum** (v0.1 in §3), multi-valued,
versioned, with an optional advisory `extra_roles[]` escape hatch that never keys
comparison; (3) name — **OpenRig** (chosen for now, pairs with `describe_rig`;
may revisit before the spec repo is public).
