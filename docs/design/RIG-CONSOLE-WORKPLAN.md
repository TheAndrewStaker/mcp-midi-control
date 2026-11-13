# Rig Console workplan: next tranche, hardware-free by construction

> Written 2026-08-06, after the session that shipped the MCP App shell, the
> rig-edit batch prerequisites, and the MCP v2 migration (units 1 + 2, commits
> `76740f6`, `26cb883`, `b85f8b6`). Every chunk below is chosen to need NO
> hardware test: it is either pure code with golden tests, or verifiable by the
> agent itself (stdio client harness with `MCP_MOCK_TRANSPORT=1`, the
> Playwright MCP browser, file-based rig reads). Hardware-gated work is parked
> in the last section, never a dependency of the first five.
>
> Plan of record for the HTTP host's security posture remains
> [`RIG-CONSOLE-DESIGN.md`](RIG-CONSOLE-DESIGN.md); this file sequences the
> work and records what changed since it was written.

## Corrections to the design doc, so nobody chases dead citations

- **The manifest loader and `executeRigEdit` live in
  `packages/core/src/protocol-generic/openrig/`**, not `packages/openrig/`
  (which is zero-dep and extractable by charter). Every `manifest.ts:NN`
  citation in RIG-CONSOLE-DESIGN.md points into core.
- The design's P4 prerequisites are DONE (commit `76740f6`): shared
  `buildRigEditOp` + exported `RIG_EDIT_SCHEMA`, batch
  `executeRigEdit(ops[])` (validate once, write once, `failed_op_index`),
  `.bak` pruning, `absent` status + `createRigManifest`, path-aware cache +
  `invalidateRigManifest`, all gated by `scripts/verify-rig-edit.ts` (43
  checks, in preflight).
- The server is on MCP v2 (`serveStdio`, fresh-factory, `legacy:'serve'`).
  The v2 HTTP packages are MCP-transport helpers; the console host stays
  REST over `node:http` as designed.
- tools/list headroom after v2: **2,164 chars** (169,336 / 171,500), enough
  for `open_rig_editor` at the design's 700-char cap.

## The tranche, in order

> **EXECUTED 2026-08-06, all five chunks.** What each landed, and the
> deliberate deviations, are noted per chunk below. Gates added to preflight:
> `verify-route-imports`, `verify-stdout-discipline`, `verify-webhost-security`,
> `verify-instance-lock` (plus expanded `verify-rig-edit` cases and the
> `open_rig_editor` ceiling in `verify-tools-list-budget`).
>
> **FOLLOW-UP LANDED (same day, later session): the per-endpoint read mutex**
> that chunk 3 allowed to trail by one chunk is built — connection-arbiter
> Phase B R1 (`withEndpoint` seam, `device_busy`, `reconnect_midi` through
> the lock, `verify-endpoint-arbiter` in preflight). The "must land before
> any webhost route opens a device handle" precondition is now satisfied
> structurally; see connection-arbiter.md's status banner (R3 cancellation
> still open).

### 1. `edit_rig` op expansion (the editing capability gate)

> **DONE.** 16 ops total in `applyRigEdit`: the original five plus
> `update_cable`, `add_signal` / `remove_signal`, `update_device`,
> `add_port` / `update_port` / `remove_port`, `add_binding` /
> `update_binding` / `remove_binding`, `set_routing`; `CableKind` widened to
> all eight cable kinds. Policy choices worth knowing: `remove_binding`
> REFUSES while an edge/signal/routing rule references the binding (silent
> de-governance would change what a routing rule matches; batch the
> de-govern + remove); `update_binding` patches BOTH ends at once so the
> contract cannot drift through the op; `remove_port` cascades its cables
> (reported) and strips routing rules naming the port. The MCP tool schema
> still exposes the original five (the budget decision stands); the new ops
> ride `executeRigEdit` for the app surfaces.

The design's op table, now unblocked by the batch executor. Add to
`packages/openrig/src/edit.ts` (switch is already `never`-exhaustive):
`update_cable` (edge id preserved; §8 contract), `add_signal` /
`remove_signal` (multi-signal edges, §5.1), `add_binding` / `update_binding` /
`remove_binding` (§4: the app must be able to author the thing the schema
calls authoritative), `update_device` (rename, roles, `server_device_id`),
`add_port` / `update_port` / `remove_port` (`update_port` carries
`output_role`, without which an app-authored rig can never satisfy
`checkAudioOutput`), `set_routing`. Also widen `add_cable`'s `CableKind`
narrowing (today `usb_midi` / `midi_thru` / `cv` / `expression` /
`analog_clock` cables are unreachable).

- **Test**: golden cases in `packages/openrig/test/run-all.ts` (four-assertion
  template), negative cases per new validator interaction, plus
  `verify-rig-edit` batch cases. Pure functions; zero hardware.
- **Tool-surface cost**: NONE yet. The expanded ops ride `executeRigEdit`
  for the app surfaces; widening the `edit_rig` MCP tool schema is a
  separate, budget-paying decision to take later.
- **Unblocks**: every editing UI on every surface.

### 2. Console renderer extraction to a workspace package

> **DONE.** `@mcp-midi-control/rig-console-render` owns the view-model types,
> the pure join (`joinSongs` / `parseSetlist` / `songKey` / `freeRuns`), the
> diagram, and the page renderer (plus `renderConsoleBody` /
> `CONSOLE_CSS` / `CONSOLE_INTERACTION_JS`, split out for the HTTP host).
> Regenerated console verified byte-identical modulo the generated-at stamp.
> The disk loaders stay in `scripts/_lib/console-sources.ts`, which re-exports
> the moved pure surface so script consumers keep one import.

`scripts/_lib/console-{sources,diagram,render}.ts` import `packages/*/src` by
relative path, which works under tsx and nowhere else. Extract the pure
renderer (diagram + page render + text peers) into a new workspace package
(working name `@mcp-midi-control/rig-console-render`) consumed by: the CLI
generator (unchanged output), the MCP App shell, and the future HTTP host.
Sources/join stay script-side where they read gitignored files.

- **Test**: root build green; regenerate the console and diff against a
  pre-extraction render of the same inputs (byte-identical modulo the
  generated-at stamp); openrig goldens untouched.
- **Unblocks**: chunk 3 and the richer MCP App panel without `src/` imports.

### 3. The P2 HTTP host, read-only first

> **DONE**, with three recorded deviations from the design text:
> (1) CSP is `style-src 'self'; style-src-attr 'unsafe-inline'`: the console
> body carries per-element style attributes (card pads wear their
> device-stored colour via `--pad`), which plain `style-src 'self'` blocks;
> attribute styles are re-admitted, inline `<style>` elements and inline
> script stay blocked. (2) No `web/` asset directory: the shell, boot.js and
> both assets are CONSTANT strings compiled into dist
> (`webhost/assets.ts`), so there is no copy-assets or release-zip leg to
> add and no path-traversal surface at all. (3) The panel data rides
> `GET /api/panels` (bearer) as `{title, body}` and the change stream is a
> bearer-carrying fetch-stream (EventSource cannot send Authorization).
> The SOURCES SEAM: the packaged server's `open_rig_editor` serves a live
> rig panel with card/setlist labelled absent (their loaders are repo-side);
> `npm run rig-console:serve` injects the script-side loaders for the full
> live three-panel page. Store writes emit via `onRigStoreWrite` (core), so
> an agent-side `edit_rig` refreshes an open page over SSE.

Exactly as designed (loopback `node:http`, fragment token, cookie-scoped
assets, CSP, `Host` check, `open_rig_editor` at <=700 chars), but land it
read-only: serve the rig view + card + setlist panels from the same loaders
the CLI uses, plus `GET /api/events` SSE. No write routes yet, so the
per-endpoint read mutex can trail by one chunk without a write racing it.

- **Test**: the design's own list, all agent-runnable: `fetch` against an
  in-process listener asserting 403 paths, the exact CSP string, the
  unauthenticated-route allowlist, cookie scoping, and
  `verify-route-imports` + `verify-stdout-discipline` gates in preflight.
  Playwright MCP browser drives the served page (panels render, keyboard,
  no console errors) with `MCP_MOCK_TRANSPORT=1`.
- **Unblocks**: the standalone entry (P5) and editing routes (P4-write).

### 4. Single-instance port lock in core

> **DONE** as specified: `instanceLock.ts`, checked at the
> `ensureConnection` handle-open seam, released synchronously from both exit
> closers, loser throws a `port_held_elsewhere` error only when a DEVICE
> open is attempted (file-backed surfaces keep working). The refusal is
> deliberately NOT cached in `connectionErrors`, so re-acquire-on-demand
> works the moment the holder exits. Lock dir override for tests:
> `MCP_INSTANCE_LOCK_DIR`.

> **Revised 2026-09-03 (owner: "one using, reserving it shortly"):** the lease
> is now released `MCP_PORT_IDLE_RELEASE_MS` (15 s) after an instance's last
> operation on the device (handle closed too), deferred while an op or a
> pinned primitive holds it; the Axe-Fx II opts out (`holdWhileIdle`). The
> lock file carries client name / pid / held-since / last-active; `withEndpoint`
> waits `MCP_PORT_WAIT_MS` (20 s) for a foreign holder; `list_midi_ports` lists
> every lease. Two Claude Code sessions had both stopped on "in use" with
> neither able to proceed; now the active one gets the port within seconds.

`packages/core/src/server-shared/instanceLock.ts`: per-label lease via
`fs.openSync(path, 'wx')` + `process.kill(pid, 0)` liveness + `startedAt`
PID-reuse guard, checked at the single handle-open seam
(`connections.ts:170`), released synchronously from BOTH exit closers
(`connections.ts:190`, `transport.ts:303`). Loser degrades to read-only
(files still render), never refuses to start; reason string
`port_held_elsewhere`.

- **Test**: two spawned processes contending over a temp lock dir with mock
  transport; steal-after-death; re-entrant reacquire on forced reconnect;
  a `verify-instance-lock.ts` gate in preflight. No hardware: the lock
  logic never needs a real port to be exercised.
- **Unblocks**: P5 standalone entry; makes the fourth run mode (Desktop +
  standalone simultaneously) safe by construction.

### 5. Playwright UI pass + the owed VISUAL_SIGNOFF.md

> **DONE.** `docs/sprints/sprint-001/rig-console/VISUAL_SIGNOFF.md`: eight
> agent-verified items (counts, keyboard, highlighting, live region,
> role="img", text peer, boot flow, zero console errors on both surfaces)
> and six human-judgment items left for the maintainer. The pass caught one
> real defect (served-page favicon 404), fixed with a `data:` icon in the
> shell.

The project's first UI still has no `VISUAL_SIGNOFF.md` (global-convention
debt, flagged in two handoffs). Write it for the generated console + the
HTTP host's read-only pages; the agent drives every checklist item it can
through the Playwright MCP plugin first (17-check precedent from the build
session), leaving only genuinely-human items (colour judgment against the
device, phone-artifact reading) for the maintainer.

## Parked: hardware-gated, explicitly NOT blocking the above

| Item | Needs |
|---|---|
| MCP App mount test (`show_rig_console` in Desktop) | Full Desktop quit + relaunch, then ask for the panel. Rebuilt dist is already in place |
| v2 server under a real Desktop session on hardware | The migration plan's §6 final step |
| Device-read sync ("synchronise by reading your device") | The port lock (chunk 4) first, then a device |
| `legacy:'reject'` flip | Anthropic confirming Desktop ships 2026-07-28 |
| MRTR for safe-edit save confirmations | Design the `-32021` no-capability fallback; then hardware-free implementation, but pointless to ship before a Desktop that can render it |

## Standing traps for the next session

- Preflight exit codes: NEVER pipe `npm run preflight` through anything.
- A "green" agent report is not a green tree: rerun the full gate yourself.
- `verify-contribution-guides` parses `createServer.ts` now; any further
  registration move must retarget it in the same commit.
- The generated console page is 166,883 chars: past the ~150k MCP Apps
  hydration ceiling, so the in-Desktop surface must stay a live shell, never
  the generated file.
- v2 client `connect()` defaults to LEGACY; `versionNegotiation:
  { mode: 'auto' }` is what exercises the modern path.

## Design direction from the 2026-08-23 exploration round (owner reactions)

Four divergent mockups (signal-flow schematic, channel strips, per-song gig
sheet, gate-driven status meters) were built as artifacts to harvest gut
reactions. Verdict from the owner, verbatim intent:

- **The EXISTING console's CONTENT wins** over all four mockups. Keep the
  rig + card + setlist substance; this is a redesign of presentation, not
  content.
- **Connections must be clear and SELECTABLE** — click/select a device to
  view more about it. Detail-on-demand, not everything-at-once.
- Aesthetic target: **"VERY sleek ... like a modern video game menu
  system"**, and it must PERFORM (instant response, no heavy page).
- He likes the **vertical nature** of the signal-flow mockup.
- The current one-long-scroll page is **"too vertical"** — break the content
  into PAGES (tabs/sections with navigation), not one column.

**The vertical-list-vs-connections challenge (asked for, answered):** a flat
vertical device list with connections implied by order is NOT quite worth its
simplicity on this rig, because Fork B is a hub-and-fan, not a chain — the
Quadra's four legs are siblings, and the two facts that actually bite
(MicroFreak eats ch3; AM4's PC is consumed, not relayed) are non-linear
facts a pure order hides. The compromise that keeps ~90% of the simplicity
and all of the truth: a vertical **TREE** (indentation encodes the fan,
order encodes flow) as the selection rail, with the selected device's OWN
connections (hears / filters / sends) in a detail pane — which is exactly
the video-game-menu pattern (left rail + right detail, up/down + enter).

**Round 2 brief:** one refined candidate — game-menu shell over the existing
console model: vertical tree rail (devices, selectable), per-device detail
pane (channels, settings, hazards, per-song role), paged sections for the
card/setlist content, SSE-live as today, honoring the ~150k MCP Apps
hydration ceiling (live shell, never the generated file). IntelliJ run
config for viewing the current console: `.run/Rig Console (serve).run.xml`.

### 2026-08-23 refinement (owner, same day)

The four round-1 mockups read as different SCREENS of one app, and that is the
structure now settled: **RIG is the primary, front-and-center page; SONG
MANAGEMENT is the second page/column; the Soundcheck readiness idea lives
INSIDE the song list as a STAGING section** (songs mapped but not yet
verified/authored on hardware). The remaining exploration axis is
PRESENTATION: not typical web design — "musician-friendly VST design that
resembles hardware." Round 2 shipped two interactive takes with that fixed
structure (working page nav, selectable device tree, keyboard up/down):
anodized-modern (Elektron/FabFilter flavor, OLED detail pane) vs
painted-steel-vintage (orange selection, VFD-green display). The npm-type
IntelliJ run config broke on the owner's IDE (Unknown type = JS plugin
unavailable); replaced with a Shell Script config, which every edition
bundles.

### 2026-08-23 round-2 reactions + round-3 brief (owner, with screenshots of the live console)

**Correction from the owner: the drawn connection TRACES in the existing
console diagram are the bread and butter.** Round 2's indented tree dropped
them; it may serve as the selection rail, but the graph with routed wires
stays. Round 3's base = the EXISTING renderer's diagram + detail column.

**Styling principles (owner-stated, binding for round 3):**
- Less webpagey: full-width flex app layout, never a centered content column.
- NO colored status dots/circles (left-of-row LEDs, top-right pips) — named
  them "obvious AI design tells." Status = engraved chips (the existing
  HEARD/GOVERNED chips are the right family) or typography, never a dot.
- The painted-steel take won; its Rig/Songs page BUTTONS are the physicality
  benchmark — everything should feel that tangible ("musician-friendly VST
  that resembles hardware").
- Inspiration direction to collect: Japanese game menus (Metal Gear Solid,
  Final Fantasy); owner will supply favorites later.

**Pack-grid challenge (wireframe SVG of the device vs simulated grid),
answered:** keep the simulation, skip the full chassis wireframe. The grid IS
the information — the Circuit stores a color per project and the grid matches
the Projects view under the hands; a chassis wireframe adds dead,
non-interactive decoration (knobs that do nothing), shrinks the 64 pads to
fit the case, and creates per-device artwork upkeep. The improvement that
DOES match the device further: render pads as lit-from-within rubber (unlit
= dark rubber, lit = the stored color with inner glow) sitting on a minimal
plate with the device name silk-screened — demonstrated on the steel
artifact's new Packs page. Open hardware question for the owner: the
physical Circuit pads are a 4×8 grid that PAGES across the 64 projects — if
hand-mapping fidelity matters more than overview, the grid could split into
two 4×8 banks to mirror the paging; the 8×8 overview matches Components
instead. His call on which mental model the page serves.

**Round-3 outline (real renderer restructure, code next session):**
1. ORDER: device list re-sorted by signal priority (clock master first, then
   Out-chain hops, then Quadra legs) — today's order is manifest order.
2. PAGES: split the one-scroll page into Rig / Songs (card+setlist with the
   staging split) / Packs sections behind hardware page buttons; full-width
   flex shell.
3. STYLE: steel treatment per the principles above; keep the SSE-live
   contract and the ~150k in-Desktop hydration ceiling (live shell only).
Touches packages/rig-console-render (page.ts, diagram.ts ordering seam) +
possibly scripts/_lib/console-sources.ts; multi-file, so the outline above
is the approach the owner approved to start from.

### 2026-08-23 node-graph library research (agent survey, web-verified) — VERDICT: NO PACKAGE

Owner asked whether a DAW/node-editor package should take over the connection
diagram (expand/collapse, customization; rendering-method change allowed).
Full survey ran against the real constraints (no-framework rule, vendored
assets under the webhost CSP, the ~150k in-Desktop hydration ceiling, and
edges that are PHYSICAL cables and must never be draggable). Ranked verdict:

1. **No package — progressively enhance our server-generated SVG.** The
   gutter-lane orthogonal router in diagram.ts IS the bread-and-butter look;
   every surveyed editor replaces it with generic beziers. renderDiagram is
   a pure function, so bundling it client-side + shipping the RigView JSON
   through /api/panels buys collapse/expand and live re-render with no
   dependency; pan/zoom is ~150 LOC of viewBox math (or vendor `panzoom`,
   MIT, 6.2KB gz). Small enough that BOTH surfaces (browser + in-Desktop)
   get the DAW feel — no dual-path fork; print/self-containment intact.
   Skip dagre/elkjs: auto-layout would fight the pinned ROLE_TIER ordering.
2. **AntV X6 (MIT, vanilla TS, actively maintained, ~200KB gz)** is the
   escape hatch ONLY if true free-form canvas becomes a hard requirement:
   the one surveyed lib with granular interacting flags ("nodes movable,
   edges frozen"). Cost: permanent dual-path (in-Desktop stays static).
3. Eliminated with cause: jsPlumb community (dead), ComfyUI litegraph fork
   (archived npm-deprecated; maintained lineage is GPL-3.0 — license-
   incompatible), React Flow/Svelte Flow + Rete + Baklava (framework
   conflicts), elkjs (EPL-2.0 + 433KB gz), Cytoscape (canvas print story +
   unmaintained collapse ext), JointJS (pan/zoom sits behind the commercial
   boundary), Drawflow (dormant, coarse modes, no orthogonal router).

Integration sketch (no-package path): per-device heights in diagram.ts
(collapsed card vs expanded chips), RigView JSON on /api/panels, a
CONSOLE_DIAGRAM_JS asset with renderDiagram + viewBox pan/zoom,
verify-response-budget re-measured, Playwright checks for pan/zoom/collapse.

### 2026-08-23 overlay direction (owner-supplied tactical-menu references)

Owner supplied three MGS V iDroid screens as the direction: floating
translucent bars over a live background layer, list+detail+table
composition, viewport-fit (minimal scroll, bottom-corner anchoring), icon
tab strip traversed by shoulder-key equivalents, gold/amber vs cyan/white
accent split on a deep blue ground, and the background layer (their map =
OUR WIRE GRAPH) passing visibly BEHIND the panels. Their mission-task
checklist maps 1:1 onto our staging checklist. We build an ORIGINAL take on
these conventions — patterns, not assets. Round-3 mockup published
demonstrating it with real data (song table + staging tasks + status
cluster over a dimmed wire map). A follow-up research pass on the iDroid's
full menu organization (top-level hubs, screen grammar, state marking,
input-hint footer) is running; its findings land here when done.

### 2026-08-23 menu-language research LANDED

The iDroid/FF menu-organization research is distilled into
**RIG-CONSOLE-MENU-LANGUAGE.md** (same folder): 24 numbered, reusable
interaction rules — places-not-actions top strip, two-tier traversal, the
four fixed corners, stack-in-place child menus, container/content two-lists,
brightness selection + tinted sort column, constant panel geometry, the
two-reserved-accents color contract, dimmed-in-place locked items, footer
verb chips, content-sheet-only motion, and the FF responsiveness
anti-patterns. Round 3 implements against that document. Font finding:
the game's face is commercial (Fontworks "New Cinema A"); the mockup embeds
Titillium Web + Share Tech Mono (SIL OFL, latin subsets, 66KB) as the
open stand-ins. CRT treatment decision: CSS/SVG layers (bloom via blurred
duplicate wire pass + text-shadow, scanline/vignette/dot-grid overlays), no
framework change; WebGL post-processing reserved for the background layer
only if barrel/convergence effects are ever wanted; no flicker animation by
design. Map-layer ruling: full-bleed graph with focal centroid upper-right
(the game's map is right-of-center full-bleed, not a quadrant); panels own
the left column + bottom band. Interactivity shipped in the mockup:
drag-pan, cursor-anchored wheel zoom, click-to-inspect on nodes AND cables.

### The pursuit plan (2026-08-23): mockups → real console, in four session-sized phases

The design becomes DETERMINISTIC the same way this repo makes wire formats
deterministic: one token source of truth + gates that verify conformance.
"Looks right" stops being a vibe and becomes a checkable property.

- **Phase A — the design system as data.** A tokens asset in
  packages/rig-console-render (CSS custom properties: the blue ground ramp,
  the two reserved accents, a spacing scale, a type scale, row heights, chip
  and bar specs) + a component stylesheet (panel headers, footer chips,
  tables with ruled padding, fill bars, inspect panes) implementing
  RIG-CONSOLE-MENU-LANGUAGE.md. Fonts vendored as webhost assets (Titillium
  Web + Share Tech Mono, OFL, latin subsets). The mockup CSS is the draft;
  the tokens file is the contract. Deterministic external anchors: WCAG
  contrast math for every accent/ground pair (computable, gateable), tap
  target + density minima from mature open design-system specs, a modular
  type-scale ratio. Add `verify-console-design` to the gate family: emitted
  pages use ONLY sanctioned color tokens (no ad-hoc hex), contrast pairs
  pass computed AA, and the no-status-dots rule holds (no circular status
  elements in the emitted DOM).
- **Phase B — structure.** The already-outlined restructure: signal-priority
  device ordering, paged Rig/Songs(+staging)/Packs shell, four fixed
  corners, footer verb chips, full-width flex. Content unchanged.
- **Phase C — the living map.** The no-package plan: RigView JSON on
  /api/panels, client-side renderDiagram, viewBox pan/zoom, click-to-inspect
  nodes and cables, collapse/expand via per-device heights. Bloom pass on
  wires (SVG filter). Both surfaces if the in-Desktop budget measures out.
- **Phase D — sign-off + regression.** VISUAL_SIGNOFF.md per the global
  convention (founder checklist); Playwright drives every checkable item
  first; screenshot-based visual regression once the design settles, so
  future changes diff against the approved look deterministically.

Each phase is one focused session and one commit. A is the enabler; B/C can
land in either order after it; D closes it.

### Phase A in progress (2026-08-23) — facts for the continuation

Owner approved start. Discovered so far: page.ts CSS is ALREADY token-driven
(:root dark + prefers-color-scheme light) — Phase A formalizes it into
theme.ts (typed tokens + tokensCss() + CONTRAST_PAIRS + sanctioned-hex set)
with the tactical palette. Violations the gate must catch are located:
.chip .dot (page.ts ~:297 CSS + ~:421 markup), .slot.flag::after circle,
diagram.ts:227-228 heard/unheard status CIRCLES (r=4), stray hexes #10141a
(.slot.used ink) and print #fff. Webhost: assets served as text constants
via sendConstant (host.ts ~:136, string-only — extend to Buffer for woff2),
asset routes at host.ts:185-190, CSP already `font-src 'self'`; APP_CSS =
CONSOLE_CSS re-export in assets.ts. Fonts ready: scratchpad
{tw400,tw600,tw700,stm400}.b64 (latin woff2 subsets, 66KB total, SIL OFL) →
generate fonts.generated.ts in webhost + @font-face prelude + routes.
Gate plan: scripts/verify-console-design.ts = sanctioned-hex scan of
CONSOLE_CSS, computed WCAG AA over declared CONTRAST_PAIRS (both themes),
no-dot rules (no border-radius:50%; no .dot/.led class; no circle status
glyphs in rendered SVG), font-size ladder conformance; register in
package.json AND preflight same commit. Mockup type sizes now: lists .8-.84rem
(map-anchored), corners .6-.7rem — carry this ratio into the theme scale.

### Phase A BUILT (2026-08-23) — awaiting the preflight verdict + owner commit

Shipped: `packages/rig-console-render/src/theme.ts` — the token contract
(ConsoleTheme with COMPLETE dark+light modes; TACTICAL as the active theme
with the pre-Phase-A quiet-dark revivable as an alternate; FONT_UI/FONT_MONO
stacks naming the vendored faces first; TYPE_SCALE_PX ladder;
CONTRAST_RULES; tokensCss(); sanctionedHex()). page.ts now interpolates
tokensCss() instead of hand-written :root blocks, resolves the stray hexes
(pad ink, print paper) through tokens, and the THREE status dots are gone
(source chips → border-left state edges; slot flag → square; diagram
heard/unheard circles → rects with titles kept). Fonts: fonts.generated.ts
in the webhost (OFL latin subsets, ~66KB, constant information-free bytes),
FONT_ASSETS decoded at load, @font-face prelude on APP_CSS naming
RigUI/RigMono, /assets/fonts/*.woff2 served under the SAME rc_assets cookie
gate (CSP font-src 'self' admits exactly this), sendConstant widened to
Buffer. The file:// generated page degrades to system stacks by design.
Gate: scripts/verify-console-design.ts (hex sanction, computed WCAG
contrast both modes, no-dots in CSS AND renderer sources, type ladder,
tokens-block-first) — registered in package.json AND preflight in the same
change. verify-webhost-security, verify-rig-edit, verify-describe-rig all
green post-change. NOTE for Phase B: the tactical palette now ships on the
EXISTING page structure; the restructure (signal-priority ordering, paged
shell, corners, footer chips) is Phase B's job, and the mockup remains the
visual reference until then.

### Phase B step 1 DONE (2026-08-23): one signal-priority order

`signalOrder()` exported from diagram.ts (the ROLE_TIER comparator that
already drove the diagram column, manifest-order ties preserved) and the
device LIST now consumes it — reading down the list IS reading down the
chain, and the two panels share one comparator so they can never disagree.
verify-console-design / rig-edit / describe-rig green. REMAINING in B: the
paged Rig / Songs+staging / Packs shell, the four fixed corners, footer
verb chips (page.ts restructure + CONSOLE_INTERACTION_JS + response-budget
re-measures; the overlay mockup is the visual reference).

### Phase B step 2 DONE (2026-08-23): the paged shell + corners + verb chips

page.ts now renders the shell: sticky SHELLBAR (identity stamp with the
amber location line, Rig/Songs/Packs tabs bracketed by their [ ] traversal
glyphs, source chips as the persistent top-right state), one DECK visible
at a time, sticky CHIPBAR foot (verb chips left, the vitals/stats cluster
right), provenance folded into the footer. The TEXT peer view deliberately
stays OUTSIDE the decks (its charter is Ctrl+F-findable; hidden decks are
not findable). Print shows every deck (pages are a screen convenience).
Paging JS rides CONSOLE_INTERACTION_JS: [ ] cycles, clicks select, and the
active page persists on <html data-rc-page> so it SURVIVES the served
shell's innerHTML refresh. Sticky .rigleft re-offset to clear the shellbar.
All console gates green (design gate incl. type ladder, rig-edit,
describe-rig, response-shape parity); real-data generation verified
(171KB — the in-Desktop surface remains a live shell per the 150k note).
REMAINING in B: the Songs-page staging split (verified-complete vs
staging groups needs the join model's per-song status fields — small,
data-driven, next slice). Then Phase C.

### Phase B COMPLETE (2026-08-24): board/staging split ships

setPanel groups the songs table by the MEASURED truth: "On the board —
the capture holds these" (on_card, including stale-claim rows whose warn
tags carry the drift; measurement wins) above "Staging — in the set, not
yet on the card" ('missing' disagreements + join.unplaced folded in as
dimmed-in-place rows). One table, one column geometry across groups
(rule 12); group headers as sunk uppercase rows. On the owner's current
card every set song is placed, so staging renders empty today — it
appears the moment a setlist song lacks projects, which is the point.
All console gates green; real-data generation verified. Phase B is
DONE (ordering + shell/corners/chips + staging). NEXT: Phase C — the
living map (RigView JSON on /api/panels, client-side renderDiagram,
pan/zoom, click-to-inspect, collapse; the audio/MIDI flow toggle with
the owner's RC-505-rooted reference tree as the audio spine; the rule-35
kink-free single-arc wire construction; the Circuit pack grid as the
first device mapping surface) — then Phase D sign-off.

### Phase C scope CORRECTED (2026-08-24, owner): the full overlay design lands here

The owner expected the mgsv-inspired overlay grammar on the real console;
A/B deliberately laid rails (tokens+gate; shell structure) without fully
reskinning the Rig page, since Phase C replaces its layout anyway. Phase C
therefore delivers the COMPLETE look he reviewed on the mockup, on the
real console, and he reviews the finished design (stress-testing the
connections with the flow toggle). Build order:
- C1 map-first Rig deck: client-rendered FULL-BLEED map from an embedded
  JSON model (works on file:// AND the served shell; the server-rendered
  SVG diagram remains as the no-JS/print fallback), band layout derived
  from connection kinds, rule-35 kink-free single-arc wires, pan/zoom,
  click-to-inspect filling a floating overlay panel (the old device-list
  detail becomes the inspect content).
- C2 flow toggle: AUDIO view (tree rooted at the RC-505 per the owner's
  confirmed reference tree, computed from audio edges) vs MIDI view (band
  layout from midi/timing edges); per-view deterministic layouts; devices
  animate between homes; non-focused flow ghosts.
- C3 glow/texture: scanlines/vignette/bloom via tokens with the calm
  toggle (rule 19).
- C4 the Circuit pack-grid mapping surface reachable from inspect
  (rules 29-31).

### Phase C COMPLETE (2026-08-24); Phase D opened with the sign-off checklist

C1 the living map (commit 96e1464): full-bleed client-rendered map from
the embedded JSON model; floating inspect projecting the server-rendered
device detail; pan/zoom; click-to-inspect on nodes AND cables; fallback
diagram+list stay for no-JS/print. C2 (91041ed): the audio/MIDI flow
toggle — AUDIO default rooted at the hub per the owner's reference tree,
MIDI as the band layout, per-view deterministic layouts from per-flow
edges, devices glide between homes, non-focused flow ghosts, absent-from-
flow devices hide. C3+C4 (cd94bd7): map atmosphere as layered CSS
backgrounds (texture on the ground, panels calm — no calm-toggle debt)
and the first mapping-surface cross-link (Circuit inspect → "View card
mapping" → the Packs deck's lit grids). Phase D begins:
RIG-CONSOLE-VISUAL-SIGNOFF.md written for the founder's live dogfood
review (the owner is stress-testing connections via the flow toggle while
playing music); Playwright drive + the screenshot-regression baseline
follow AFTER his sign-off settles the design. The voices-per-song
question on the checklist deliberately probes the next design slice.

### METHOD CORRECTION (2026-08-24, owner, binding): PORT THE MOCKUP, never approximate it

Two console iterations read as "webpage slop" because the look was
re-derived from memory instead of ported. Standing rule for all remaining
console presentation work: `rig-idroid-tpl.html` (the 16-iteration mockup
the owner approved, in the session scratchpad; copy preserved alongside
this doc as RIG-CONSOLE-MOCKUP-REFERENCE.html) IS the presentation source.
Its stylesheet, structure, and proportions port VERBATIM into page.ts
(token names mapped, real data + existing JS hooks fitted INTO it); real-
console content that has no mockup home is STRIPPED from the screen (it
survives in print + the text peer) rather than grafted on. Start from the
design and add data — never start from the old page and restyle.

**Port executed (2026-08-24).** page.ts's stylesheet and shell are now the
mockup's, spliced whole and aliased onto the token contract (the mockup's
translucents derive via color-mix from `ink`/`bg`, so the design gate's
hex sanction still binds); theme.ts carries the mockup's sea/cyan/gold
palette verbatim, with four foregrounds retuned brighter to clear the
gate's computed-contrast floors on the brighter panel value. Structure
followed the same rule: Songs is the mockup's two-column page (solid-bar
Song List scrolling internally + say-line desc; gold staging tasks panel
+ numbers cluster right), Packs is one bar-headed column of translucent
pack panels, and the Rig page IS the map — the checks grid, findings
list, and doctrine paragraphs left the screen for print + the text peer,
exactly per the strip rule. Inspect wears the mockup's ph/body grammar
(map.ts projects into it). Screenshot-driven fixes during the port: the
OS light-scheme no longer swaps the screen palette (the approved look is
single-theme; the light set now serves `@media print`, keeping both modes
gate-checked and real); `.map-fallback` hiding lost a specificity race
with `.riggrid{display:grid}` (scoped to `.deck .map-fallback`); band
layouts packed by MEASURED node width (even-centre spacing overlapped
150-450px name-driven boxes); and cross-band wires now exit vertically
and enter the facing side so every edge is pathFor's single quadratic —
the old side heuristic picked parallel horizontal normals across bands,
forcing the cubic fallback's S-diagonals (the exact kinks rule 35 bans).

**Readability round (2026-08-24, owner review of the static file).** Three
mechanical deltas from the mockup found and closed: (1) the static
file:// page rendered fallback Segoe/Consolas because the real faces
only shipped via the HTTP host's cookie-gated route — renderConsole()
now embeds the four OFL faces as a data-URI @font-face prelude
(rig-console-render/src/fonts.generated.ts, regenerated FROM the
server-all module; the hosted page keeps its /assets/fonts route and
CONSOLE_CSS stays lean); (2) the CRT overlay alphas were over-poured in
the color-mix translation (scanlines 60% vs the mockup's .16, vignette
80% vs .55) — the stripes were shredding every light bar; (3) node fill
returned to the mockup's 55%. Plus the owner's fit requirement: the map
now AUTO-FITS its content bbox to the viewport on load and on every flow
switch (fitView; svg meet + one units-per-px ratio for pan/zoom, fixing
the per-axis skew), rows compressed (140 pitch) and widths tightened
(9.5px/char) so no band overruns the viewBox, and the songs table wears
the mockup's short gold Pack / Slots mono columns instead of the long
"where" sentence (which stays in the say-line).

**Voices + pad inspect (2026-08-24, owner asks: "click Circuit pads for
details; see the voices chosen for each song").** Both land in existing
design grammar, no new language: (1) the mockup's gold VOICES panel is
now real on the Songs page — `attachVoices` (join.ts) matches the mapping
registry's claims (song-mappings.json, loaded repo-side by
`loadVoices` in console-sources.ts, wired into BOTH entries) onto the
join by songKey; one tbody per song toggled by row selection, the idle
row reporting coverage honestly (3 of the set filed; one further song is
filed but unknown to both setlist and 07-31 capture — carried as
`voices_unmatched`, reported, never dropped). (2) Packs pads are
click-to-inspect: a floating ph/body panel (bottom-right, purple song
accent) built from the pad's OWN server-rendered tooltip lines — no
second copy of the data; Esc / re-click / Show-everything clear it, pads
are keyboard-reachable. Map type is now ANCHORED (rule 25 made
mechanical): fitView sets a --maptx font-size so node labels render at
the list body size (13.5px) at every fitted view, whatever scale the fit
chose. The registry filing gap (13 unfiled songs) is the owner's task
the panel now surfaces each session.

**Wire routing v2 (2026-08-24, owner: "spaced from the items nicely and
organized based on the layout"; two research agents commissioned).** The
quadratic-arc router is replaced by rounded-orthogonal CORRIDOR routing,
rule 35 v2, distilled from the agents' specs (ELK/yFiles/libavoid layered
routing + PCB/transit/FUI practice — full specs in the session record):
horizontal runs live only in the corridors between bands, never at box
height; edges attach to the band-facing edge via perpendicular stubs at
ports ordered by the far endpoint's x and spread at a 14px pitch inside
the box span (so the RC-505's five audio ins comb evenly across its
bottom edge); a jog smaller than one corner-pair diameter snaps to a
single straight drop; corridor runs pack into lanes at 12px pitch by
left-edge interval packing; corners round at r=16 clamped to half the
shorter segment; in the MIDI flow a node side with 3+ attachments merges
into a bus (one backbone + one riser — the Quadra's fan-out), while
audio stays comb per the semantic rule (each cable keeps identity into
the looper). Style spec applied: bloom only on the focused layer, ghosts
thin (1px) and dim, round linecaps, governed dash 6 4 (3:2), and 5px
square terminal pads where a trace meets its box (the PCB connector
read). The map legend was corrected to match the wire styling exactly
(it had drifted: clock/notes shown dashed, governed shown purple).
Verified: all 9 audio routes' path data read clean (comb ports 661..839
at even 44.5 spacing on the hub), both flows screenshot-reviewed.

**Wire routing v3 — conduit (2026-08-24, owner refinement, supersedes
v2's ports-by-far-endpoint AND the momentary shared-center take).** The
owner's spec, verbatim intent: connections never overlap; a box's
attachments start from where the center point would have been and spread
out horizontally, each in its own lane, flowing like conduit that never
touches; "all of the connections are centered." Implementation: every
box side carries a CENTERED PORT FAN — k ports symmetric around the edge
centre at the 14px pitch, ordered by far-endpoint x so the fan never
crosses itself; the MIDI bus (a shared backbone is deliberate overlap)
is REMOVED — every edge keeps its own corridor lane; lanes assign
widest-run-first packed toward the hub band, which makes sibling runs
nest like brackets and their risers climb the fan's untouched central
gap. Snap-to-straight persists but may only move ports when BOTH ends
are single-attachment (a moved port inside a fan would break the
centred symmetry); exactly-aligned centers are free straights. Verified
by screenshot on both flows: the RC-505's five audio ins fan from its
bottom center into five nested lanes; the Quadra fan-out runs four
parallel conduit lanes; zero touching, right-angle crossings only.

**Conduit consistency fix (2026-08-24, owner: RC-505 connector off
centre; AM4-vs-MicroFreak spacing inconsistent; wants server-room
cable-tray parallels).** Measured root cause: fan slots were computed
over ALL edges INCLUDING the near-invisible ghost layer, so a ghost
displaced the visible wire by half a pitch on some boxes and not others
(AM4's out sat 7px off centre while the MicroFreak's happened to land
dead centre — exactly the inconsistency the owner's eye caught).
Focused wires now own the centred fan and ghosts take outer slots, so
visible geometry is identical whether or not context edges exist. And
the port pitch now EQUALS the lane pitch (one conduit constant, 13px),
so a bundle's gap no longer changes through a corner — with the
existing nesting order this makes paired corners concentric, the
cable-tray read. Verified numerically: every single connection starts
at its box's exact centre; the hub fan reads 724/737/750/763/776.

**Library research verdict + cable-tray router v4 (2026-08-24, owner:
"could you be using a tool like D3... clean engineering example, like
conduit and networking cables in server rooms").** A research agent
evaluated D3 (no edge router exists in it; its step curves cannot round
corners, open request since 2016), elkjs (433KB gzip — 1.6x the whole
page budget — and it owns node placement, which would discard the
approved layouts), dagre (curved polylines, no orthogonal routing),
libavoid-js (the one true tray engine: LGPL + WASM needing a CSP
loosening + beta — steal the GD'09 algorithm, not the code), X6 (583KB
editor, per-edge A* only), and xyflow's getSmoothStepPath (functionally
identical to our roundedPath). VERDICT: keep the ~200-line hand-rolled
router — the hard parts (corridor lanes, centred fans, bundle adjacency)
exist in NO shippable JS library. Its three finishing rules are now v4:
(1) ONE pitch for ports and lanes (13); (2) a fan's edges form an ATOMIC
BUNDLE on adjacent lanes ordered like the port fan (strays never
interleave); (3) corners are TRUE SVG ARCS with radius RAD+depth×PITCH —
concentric quarter-turns whose gap never changes, with a bundle-coherent
clamp (if one member's corner must shrink, the whole bundle shrinks by
the same delta so concentricity survives). Screenshot-verified both
flows: the hub fan splits into nested concentric turns; parallel pairs
hold one gap end to end.

**Owner verdict on v4 (2026-08-24): "great... might be perfect... pretty
geometrically with the way the curves are created, easy to follow
lines."** The cable-tray router is the accepted wire grammar. He will
stress-compare during dogfood; D3/charting libraries stay a
back-of-mind option only ("if at all") — no adoption planned, per the
research verdict above.

### Phase D BUILT (2026-08-24): the flow gate + screenshot baseline, plus the mid-dogfood layout round

`npm run verify-console-flows` (registered in preflight; CI installs
chromium and runs the flow half) drives the signoff checklist's checkable
items with Playwright: 18 flow specs + a 4-shot screenshot baseline
(win32-only, `tests/console-e2e/__screenshots__/`; re-baseline after a
deliberate design change with `--update-snapshots`). The suite runs on a
SYNTHETIC fixture (`tests/console-e2e/fixture.ts`: openrig's LOOPER_HUB_RIG
through the real buildRigView -> joinSongs -> attachVoices -> renderConsole
pipeline plus a constructed card/setlist/voices set), so it needs no
maintainer data and runs on any clone. The fixture caught a real renderer
defect on its first run: a setlist song with nothing on the card rendered
TWICE in the Staging group (once from join.songs, once from join.unplaced —
the unplaced list is a subset of songs, so mapping both double-drew), with
its task line doubled too; fixed in setPanel, regression spec added.

The owner's 2026-08-24 mid-dogfood feedback round landed in the same pass,
all covered by specs:
- **Top-right quadrant fit** (mgsv orientation): fitView scales the flow
  into x [40%..W-40] / y [90..62%H], cap 1.15x — inspect top-left, system
  status bottom-left, legend bottom-right stay clear for most rigs.
- **Rule 25 becomes a CAP**: map labels render at the list body size when
  the boxes can hold it; the quadrant fit on a wide rig (12 devices) caps
  them at what the narrowest box allows, so labels never collide. Pinning
  13.5px inside quadrant-scaled boxes is geometrically impossible for wide
  rigs; flagged on the signoff list as a judgment item.
- **One item always selected**: each flow layout nominates a primary (audio:
  the hub; MIDI: the clock master); load and every flow switch keep the
  inspect panel filled (selection survives when its device exists in the
  new flow).
- **Source chips -> bottom-left amber SYSTEM corner** (.sysinfo); the top
  strip is identity + tabs only. Hidden on Songs/Packs (the Songs deck's
  bottom-left belongs to the Voices panel) and in print.
- **Show Everything removed**: Esc already clears every selection and the
  map deliberately never empties, so the reset had no job.
- **Served-shell height fix**: `#rc-root{height:100%}` — without it the
  hosted page's flex column collapsed, stacking the foot bars under the top
  strip, which is what made the MIDI Flow button unclickable (the text-peer
  toggle sat over it) and scattered the legend/inspect into the crammed-top
  screenshots.

Remaining manual-only on the signoff list: the served shell's edit_rig
auto-refresh (host behavior a file:// gate cannot drive) and every
judgment call. VISUAL-SIGNOFF.md retires once the owner's judgment pass
signs off; the automated halves are annotated `[auto]` there.

### Layout rounds 2-3 (2026-08-24, same session): uniform modules, right-half vertical fill, tracks + spine

Owner feedback sequence mid-dogfood: (a) "map needs to take better space...
futuristic video game display... okay to overscan past the quadrant";
(b) "item names are too long causing the overall shape to be overly wide —
max width or standardize"; (c) "make it more vertical... fill the top right
AND bottom right quadrant"; (d) "MIDI flow is VERY wide... research this
stuff carefully"; (e) "smarter visual organization based on the voice
classes... grouped by both type AND connection order"; (f) the status
corner's "alignment looks busy... does the mgsv solve how to show list
detail with variable length?".

A dedicated research pass (ELK Coffman-Graham width-bounded layering,
Graphviz unflatten, barycenter sweeps, iDroid/Elite/EVE/NieR module-grid
conventions; full report in the session transcript) produced the design
now implemented in map.ts:

- **Uniform modules**: every node 190x48; labels wrap to <=2 lines inside
  (parenthetical suffixes dropped on the map only; full name stays on
  aria-label + inspect). TRAP fixed on the way: the client script ships in
  a TS template literal, so regex backslashes must be DOUBLED — an
  un-doubled \s emitted /s+/ and stripped the letter s from every label.
- **Width-bounded rows**: a band/depth splits into BALANCED rows of at
  most PERROW modules (5 -> 3+2, never 4+1), PERROW derived from the fit
  region (= 4). Coffman-Graham's bound with balanced fill.
- **Fixed column tracks + spine**: modules snap to 4 tracks spanning the
  region; short rows sit on consecutive tracks biased around track 1 (the
  SPINE), never centre-offset (the "#1 auto-laid-out tell" per the FUI
  research). The flow's primary (audio hub / clock master) is pinned to
  the spine track, which carries a dim full-height guide line.
- **Class-then-connection ordering** (owner ask (e)): connection order
  picks the row (hop depth / band); classRank orders within it (substring
  match over roles + extra_roles: sequencer, synth, sampler, drum, vocal,
  ...), so same-class devices sit adjacent.
- **Fit region = the right half** (FIT_X0=42%W .. W-30, y 70 .. H-30),
  scale cap 1.15; rule 25 stays a CAP (labels at list size when the
  module holds the longest visible line, bounded tighter for two-line
  labels).
- **Status ledger** (ask (f), per the research's iDroid/Elite convention):
  ragged-left small-cap labels in a fixed column, VALUES flush-right with
  tabular numerals, no dot leaders; compact labels; ISO timestamps
  squeezed to minute precision.

OPEN, deliberately not improvised (owner: "we can take our time"):
- **Tree-trunk branching for broadcast signals** (ask (d) cont.): the
  clock fan (one source, N receivers of the SAME signal) could render as
  a shared trunk that branches per receiver — semantically honest for
  broadcast, unlike point-to-point cables which keep their own lanes.
  This partially reverses the v3 "own lanes, never touching" ruling, so
  it needs the owner's explicit go. Sketch: group focused edges by
  (source port, kind) when >=3 siblings share both; route ONE trunk from
  the fan centre to the corridor, branch at each target's riser.
- **Barycenter ordering sweeps** within split rows (the research's
  in-row refinement) if class-adjacent ordering leaves visible crossing
  noise on the real rig.

### Regression round (2026-08-24, live dogfood queue): gutter risers, wire inks, ledgers, pad-detail column

The owner refreshed mid-session and filed six reports; all fixed + spec'd
in one batch:

- **Wires through boxes (worst)**: the vertical stack put boxes on shared
  column tracks, and the router only ever knew ADJACENT rows — a wire
  spanning intermediate rows satisfied snap-to-straight and drew straight
  THROUGH the box between (Hydrasynth->hub through Fractal AM4). Fix in
  the router: long spans are banned from straight paths and descend
  through the GUTTERS between tracks (box-free by construction), with a
  reservation table spreading concurrent risers (one pitch apart, spill
  to the neighbouring gutter) and their b-side corridor runs nudged half
  a pitch off centre so they cannot coincide with packed lanes.
- **Non-amber wires very faint**: cyan + footswitch hues sit close to the
  blue ground; new `--wire-midi` / `--wire-fsw` tokens lift luminance
  (62% hue / 38% ink), used by wires, terminal pads AND legend swatches
  (one source); base wire weight 1.8->2, opacity .85->.95.
- **Voices labels missing**: the idle row's bare em-dash label is now
  "Coverage", a song with nothing filed says "Not filed", and an OWED
  claim with no chosen preset shows its ROLE dimmed in the value cell so
  no row reads blank.
- **Status ledger, final ruling**: ALL LEFT-aligned (labels in a fixed
  left column, values left from the shared spine) — after trying
  flush-right values (research) and right/right (cluster grammar), the
  owner settled left/left.
- **Pack pads dim at rest**: the song-filter resting opacity .18 -> .55
  (readable, colours keep telling); the hit run pops via ring + glow.
  Spec asserts the readable band so it cannot silently regress.
- **Pad detail redesigned**: its own RESERVED left column on the Packs
  deck (the grids sit clear of it — nothing occluded, every pad clickable
  with the detail open, spec-asserted), amber/gold ph + border, and the
  facts as a LABELED ledger using the same .rew grammar as Voices
  (structured data attributes on the pads; no tooltip re-parsing).

Owner also named the console's own favourite elements as the reference
set (shellbar stamp+tabs, song-list rows, gold Voices ledger, numbers
cluster, staging checklist) and asked for direct MGSV design references —
filed BK-RC-MGSV-REFERENCE-LIBRARY.
