# OpenRig visual UI: capability research + recommendation

> Status: **research complete (2026-07-12)**, no code yet. Question posed by the
> maintainer: "what very simple but still attractive UI, possibly local web, or
> something inside Claude Desktop, where we can move cable connections (audio and
> MIDI)?" This doc captures what is feasible and the recommended path. The
> existing `toCytoscapeElements(rig)` projection + the new `checkAudioOutput` /
> `checkRigCompatibility` checks are the assets a UI renders.

## Headline finding: interactive UI inside Claude Desktop is now officially possible

- **Base MCP has no interactive UI.** A tool result is a `content` array of typed
  blocks (text / image / audio / resource); resources are `text` or `blob`. The
  host displays those; it does **not** execute server-supplied HTML as a live app.
  So a cable editor is impossible via plain tool results / resources alone.
- **MCP elicitation is not custom UI.** It requests input mid-tool-call via a
  flat JSON Schema of primitive fields the CLIENT renders as a form. Host-rendered
  chrome, not a server-authored canvas, so it cannot be a drag-to-connect editor.
- **The answer is the "MCP Apps" extension (SEP-1865),** the first official MCP
  extension, launched **2026-01-26** (co-developed by Anthropic + OpenAI + the
  MCP-UI creators, building on the community MCP-UI project). A tool declares a
  `ui://` resource via `_meta.ui.resourceUri`; the host fetches that HTML page and
  renders it in a **sandboxed iframe in the chat**; the app talks back to the
  server over a postMessage JSON-RPC bridge that can proxy `tools/call` (host- and
  user-gated). **Claude Desktop is on the official client matrix**, and iframes
  mount for **local stdio servers** in the standard consumer (1P) path, so a
  local server like this one is in scope. A drag-to-connect node/patchbay editor
  is ordinary HTML/JS/SVG inside that iframe (the official examples ship a
  CesiumJS globe and Three.js scenes, so heavyweight interactivity works).
- **Caveat that gates it:** the feature is new and has **open Desktop rendering
  bugs** (Apr-May 2026: iframes negotiating the `io.modelcontextprotocol/ui`
  capability but failing to render, showing only fallback text). For a
  non-technical guitarist, a panel that silently falls back to text is worse than
  a reliable artifact. So MCP Apps is a **pilot-later** path, gated on a live
  end-to-end render smoke-test on the target Claude Desktop build.

## Options matrix

| Option | Feasibility | Effort | Editing | Verdict |
|---|---|---|---|---|
| **1. Self-contained HTML artifact** (Cytoscape/SVG view + audio/compat color overlays) | Today, no caveats | Low | View-only | **Build first.** Highest value per effort, zero risk; ships the color-overlay checks that are the actual point. |
| **2. Edit-by-conversation** (Claude edits `rig.json`, re-renders) | Today | Near-zero | By chat | **Ship alongside 1.** The honest substitute for sandboxed drag-edit-that-saves (impossible from an artifact). On-brand: "control your rig by conversation." |
| **3. Local-web editor** served by the MCP server (127.0.0.1 + token) | Well-trodden | Medium-high (security is the cost) | Real drag-to-connect, auto-saves | **Phase 2.** The only option with persistent in-canvas drag-edit. Opens a separate browser window (a mode switch away from chat). |
| **4. In-Desktop MCP App** (`ui://` iframe) | In spec; local stdio supported on 1P Desktop | Medium + maturity risk | Drag -> proxied `tools/call` -> server writes | **Pilot later,** gated on a render smoke-test. In-chat + interactive + write-back in one surface, IF it renders on the user's build. |

## Recommendation

**Build options 1 + 2 together as the deliverable.** A self-contained HTML view
that renders the real rig through `toCytoscapeElements(rig)` (or a bespoke SVG
layout) with `checkAudioOutput` + `checkRigCompatibility` results painted on as
color overlays (red node = an instrument that will not reach front-of-house; red
edge = a broken/illegal MIDI binding), paired with edit-by-conversation for the
write path (the user says "reroute the Hydra into INST 1"; Claude mutates the
edge, re-validates via the three checks, re-renders; the red overlay clears or
moves). The graph gives the user something concrete to point at, which makes the
conversation more precise. This is a thin render layer on a model that is already
half-built, needs no new protocol work, and reuses the maintainer's existing
strict-CSP self-contained artifact conventions.

**Then, when persistent in-canvas drag-edit is worth the surface, add option 3
(local-web).** Reuse the same Cytoscape editor asset; the cost is the mandatory
security checklist (below), not the plumbing. **Pilot option 4 (MCP App) later,**
gated on the render smoke-test, reusing the same editor asset again, so the
investment in the view compounds across all three surfaces.

## Local-web (option 3) security checklist (the real cost)

A browser talking to a loopback server is untrusted input; treat a `PUT /rig` as
adversarial. Mandatory before shipping:

- Bind **127.0.0.1**, never 0.0.0.0. Start it **lazily + opt-in** (a new
  `open_rig_editor` tool), not on every server launch.
- Mint a **per-launch random bearer token** in the URL; reject requests without it.
- Validate **Host + Origin** against an exact `localhost:PORT` allowlist
  (anti-DNS-rebinding), the MCP Inspector pattern.
- Apply the project's **read-before-write / confirm-before-overwrite** gates on
  the write endpoint exactly as the MIDI tools do.
- **stdio wrinkle:** the localhost URL MUST go to **stderr or a tool result,
  NEVER stdout** (stdout is the MCP JSON-RPC channel; a stray write corrupts it).

## Cytoscape notes (for options 1/3/4)

`toCytoscapeElements` already emits the exact `{nodes, edges}` shape, with device
-> port **compound nodes** (port child-nodes carry `data.parent`) and typed edges
(`signal_kind`, `disabled`, `governed` classes). Cytoscape.js is canvas-based,
zero-network, no `eval`, ~380 KB inlined, and satisfies the artifact strict CSP.
Drag-to-connect is the `cytoscape-edgehandles` extension (drag-off-to-disconnect,
move-the-plug reassign); it pulls in `lodash.memoize`/`throttle`, so bundle those
if used. A view-only POC needs only plain `cytoscape.min.js`. A hand-rolled SVG
layout is a valid alternative for a bespoke, more musician-friendly look and
avoids the 380 KB inline.

## Editing on mobile: don't draw cables (the interaction model)

**Added 2026-07-12** after the maintainer proposed a top-to-bottom, rows-by-type
layout (controllers at top, front-of-house at the bottom of an "inverted pyramid")
with a GUIDED connection flow: tap a source, pick the target TYPE (which selects a
row), pick the specific device in that row, pick the connection type
(audio/MIDI/...). Research shows this maps onto THREE proven, successful patterns,
none of which use free cable-dragging:

- **Slot / channel-strip chains (Audiobus, AUM on iOS).** AUM channel strips put
  the INPUT circle at the top and OUTPUT at the bottom (exactly the maintainer's
  top-to-bottom flow); Audiobus is Input -> Effect -> Output slots you tap `+` to
  fill. The most successful mobile audio/MIDI routing hubs, and they are slot/tap,
  not drag.
- **Connection matrix (Dante Controller, AUM routing tab, Ardour, PatchMatrix).**
  Sources across the top, destinations down the side; tap the crosspoint to
  connect (green check). Scales to big rigs via expand/collapse per device. Pro
  reviews say a matrix is "much easier than drawing wires." This is the canonical
  non-drag routing UI.
- **Guided trigger->action wizard (IFTTT, Zapier).** Pick this, then pick that,
  step by step, large buttons, quick screens; IFTTT is explicitly BUILDABLE ON
  MOBILE. The maintainer's "pick source -> target type -> target -> connection
  type" IS this wizard.

**The refinement over a naive version:** a strict "connect to the row directly
below" is too rigid (a footswitch cables to the hub several rows down; clock fans
UPWARD from the master). The maintainer's own fix, picking the target TYPE rather
than the adjacent row, removes the adjacency constraint, which is what the
wizard/matrix patterns already do.

**The differentiator (why this beats Audiobus/AUM/Dante for this project):** those
tools don't know your gear's capabilities, so they let you make dead connections.
Here, the `checkRigCompatibility` + capability data GATE the choices: the wizard
only offers LEGAL target types + connection types + channels (step by step), and a
matrix greys out illegal crosspoints. That turns the checks from after-the-fact
validation into **can't-make-a-mistake authoring**, and it is the payoff of the
whole OpenRig capability model.

**Recommendation:** VIEW with the vertical diagram (built); EDIT with a
capability-gated guided WIZARD (the maintainer's model, IFTTT-shaped, best for a
non-technical player on mobile) and offer a capability-gated MATRIX as a power
view later. Both ride the local-web or MCP-App editing surface (options 3/4 above).

## Design boundary: generic primitives + agent-composed UX (decided 2026-07-12)

After the MCP-App canvas was ruled out on stdio (see below), the maintainer set the
governing boundary, and it supersedes the "which UI do we build" question:

**The server exposes a few TRUE, composable primitives; the AGENT is the
shape-shifting UX.** Those primitives are `describe_rig` (the rig facts + the
compat/audio checks), `edit_rig` (safe mutation: validate + back up), and the
checks. Everything about *how a given user interacts* is the agent composing them:
generate an Excel grid (the matrix shape) to fill, read it back, diff, and apply
via `edit_rig`; read a photo/sketch of a pedalboard; run the pick source ->
target-type -> target -> connection-type wizard as conversation (offering only
legal options because the agent can call the checks); confirm via a regenerated
diagram; propose whole rigs from inventory. The server never learns about Excel;
Claude does.

This is the project's core value ("adding gear is a descriptor, not a new tool")
applied to interaction: **adding a way-to-interact is agent composition, not a new
tool.** It keeps the surface tiny/testable/host-portable and future-proof (a new
interaction style needs zero server changes), and it dissolves the canvas
dead-end (the "UI" is any artifact the agent generates + reads back, not a live
in-chat app). Corollary: the rig proposer (inventory -> candidate rigs -> scored
by the checks) stays AGENT-SIDE. The server's whole leverage is keeping
`describe_rig` rich, `edit_rig` safe, and the CHECKS sharp, because the checks are
what let the agent offer only-legal options and explain consequences in any format.

## What NOT to do

- Do not use **elicitation** for the editor (primitive host-rendered forms only).
- Do not build the **local-web** editor first (options 1+2 deliver the viewing
  goal and a working edit path without the security surface).
- Do not commit the primary UX to **MCP Apps** until it is smoke-tested on the
  target Desktop build (open rendering bugs as of mid-2026).
- Do not let any sandboxed artifact/iframe imply it auto-saves. An artifact
  cannot write `rig.json`; label any export "paste this back to save."
