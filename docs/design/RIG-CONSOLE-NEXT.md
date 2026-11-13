# Rig Console: what shipped, and how the real web app gets served

> Written 2026-08-04, the session after [`RIG-CONSOLE-DESIGN.md`](RIG-CONSOLE-DESIGN.md).
> The design doc stands as the plan of record for the editing phases. This file
> records what was BUILT, the phase boundary that was redrawn and why, and the
> three ways the live app could be served, one of which the maintainer asked to
> explore.

## What shipped

The read-only console, as a **generated self-contained HTML file**. `npm run rig-console`
reads three files and writes one page:

| Source | What it gives | Gitignored |
|---|---|---|
| `docs/_private/rig/rig.json` | the OpenRig L1 topology + all four checks | yes |
| newest `samples/circuit-ncs/card-backup-*` | all 320 sequencer projects, decoded | yes |
| newest `docs/_private/rig/setlists/*.md` | the intended performance order | yes |

Three panels: the rig as a vertical flow diagram plus a device list; the set in
performance order; the card as five 8x8 pad grids. A fourth section is the whole
page as text, always in the DOM.

| File | Owns |
|---|---|
| `packages/openrig/src/view.ts` | `buildRigView` + `renderRigText`. Pure, zero-dep, golden-tested. The reusable layer |
| `scripts/_lib/console-sources.ts` | loading + the setlist-to-card join |
| `scripts/_lib/console-diagram.ts` | the flow diagram, emitted as static SVG |
| `scripts/_lib/console-render.ts` | the page |
| `scripts/rig-console.ts` | the CLI |

## The phase boundary that moved, and why

The design cuts phases by infrastructure layer: P1 generator, P2 HTTP host, P3
songs. The ask ("show my rig and song list and where they are mapped on the
sequencer") spans all three, but only their READ halves.

**Every input is a file on disk and nothing is read from a device.** The rig is a
manifest. The card map is explicitly a snapshot of a backup. The setlist is a
markdown file. So the entire P2 apparatus, the listener, the per-launch token,
the fragment-to-cookie exchange, the CSP, the `Host` anti-rebinding check, the
Windows Firewall exposure, the single-instance lock, the stdout guard, buys
nothing here. All of it exists to make a LIVE, EDITABLE surface safe.

A generated file is strictly better for this deliverable: double-clickable (the
design names the missing entry point as a blocker for the target user), works
with Desktop closed and the server stopped, and holds no port the vendor editors
would have to fight for.

**P3's song migration was not needed either.** The design puts songs behind a
reconciliation of 47 markdown files with six unresolved contradictions. But "where
they are mapped on the sequencer" is already machine-derived: `circuit-card-scan.ts`
decodes every project from the `.ncs` bytes and `circuit-card-roster.ts` supplies
song, artist and part. The console joins those and links out to the markdown. The
migration is still worth doing; it is not on the path to this page.

**Nothing is thrown away.** `buildRigView` is the data layer either way, and the
HTTP host still gets built for the editing phases.

## What the join surfaced on the first run

Value that neither source held alone, which is the argument for joining them:

- **Nine songs where the setlist and the card disagree.** The setlist's `Built?`
  column says nine of the songs are not built; the capture holds projects
  for all nine. The console reads that column but never trusts it: build state is
  measured and the claim is only contrasted. That is the design's own rule
  ("build state lives on the Song and is read through") made mechanical.
- **Two malformed audio edges** in the live rig, `sm58-to-ve500` and
  `ve500-to-rc505-mic1`, carrying `{kind:'audio', signals:[]}` with no `channels`.
  They validated clean and crashed `summarizeSignal`, the only consumer. Both
  halves fixed: a new `audio-signal-no-channels` validator error, and a summariser
  that reports a malformed payload instead of throwing. **The manifest itself is
  still wrong and is the maintainer's to fix**; an SM58 into a VE-500 is `["M"]`.
- **Bindings are declared at SIGNAL level, not edge level.** Both of this rig's
  bindings are named on a `MidiSignal`, which is the correct form when one DIN
  cable carries clock plus transport plus three note streams. The first cut of the
  view model read only `Edge.binding` and reported a fully governed rig as fully
  ungoverned.
- **One project stores pad colour index 240**, outside the 14-colour palette.
  Reported as read rather than clamped.

## Colour: what is device truth and what is not

Each pad is painted in the colour the DEVICE stores for that project, read from
`.ncs` byte `0x0c`. On this card colour is per song (one song is Khaki, another
Cyan), so the grid matches the Projects view under the maintainer's hands.

**The names and palette order are Novation's**, from the codec's `PROJECT_COLOURS`.
**The hex values are not sampled from hardware.** Novation publishes no RGB for
this palette in the user guide or the programmer's reference, and the `.ncs` file
stores only the index. `PROJECT_COLOUR_HEX` in `console-render.ts` is a rendering
of the names as the hue walk the palette order describes. To make it exact,
sample the pads from a photograph of Projects view and replace that one table.

## Serving the live app: three paths

The generated file is the read-only answer. Editing needs something live. Three
options, and they are not exclusive.

### 1. Local HTTP host (the design's P2)

Specified in full in `RIG-CONSOLE-DESIGN.md`: `node:http` inside the MCP server
process, loopback, per-launch token in the URL fragment exchanged for a
`Path=/assets` cookie, strict CSP, `open_rig_editor` to hand over the URL.

- **For:** no host dependency, works in any browser, full control, already designed
  and adversarially reviewed.
- **Against:** the largest security surface in the project, a Windows Firewall risk
  for a non-technical user, a single-instance lock, and a stdout guard. It is
  ~4-6x the work of anything else here before a pixel appears.
- **Verdict:** still the right answer for editing, and the only one that works with
  Claude Desktop closed. Build it when there is something to edit.

### 2. MCP Apps (SEP-1865) — FIXED and CONFIRMED RENDERING 2026-08-10

**Resolved, not just diagnosed.** The panel now mounts and works inline in
Claude Desktop chat, confirmed on the maintainer's screen (not narrated):
`show_rig_console` produces a real rendered `<h1>Hello from Rig Console</h1>`
plus a live `ontoolresult` bridge delivery of the initiating tool call's own
result. This was genuinely implementation, not (only) an Anthropic host bug —
see the root-cause section immediately below, kept for the record because the
diagnostic path is worth not repeating.

**The fix:** `src/server/webapp-client/rig-console-app.ts` (new file) is
bundled by esbuild at build time (`npm run build:webapp`, pinned
`@modelcontextprotocol/ext-apps@^1.7.5` + `@modelcontextprotocol/sdk@^1.30.0`
devDependencies in `server-all/package.json`) into a single self-contained
script with zero runtime imports, which `apps.ts` reads once at module load
and inlines directly into the resource HTML — no CDN fetch, no `<script src>`
relative-path resolution inside the sandboxed iframe. `mcp-apps-smoke.mjs`
still uses the old broken CDN pattern (it's a throwaway diagnostic, not
shipped product code) and should not be trusted as a rendering test anymore.

**Current scope, deliberately minimal (hello-world checkpoint):** a status
line + Refresh button calling `describe_rig`, matching the official
`quickstart` example's shape. **Next:** grow this back into the original
device-list panel (name/connected-dot/transport per device) now that the
underlying bridge is proven solid end-to-end.

<details><summary>Root-cause diagnostic history 2026-08-10 (superseded by the fix above, kept as a record of the actual method)</summary>

### 2b. MCP Apps (SEP-1865) — root cause confirmed 2026-08-10: open Anthropic host bug, not our code

**Tested against the maintainer's Claude Desktop, then verified against the live
GitHub issue tracker (`gh issue view`, not secondhand).** `show_rig_console` and
the throwaway `scripts/mcp-apps-smoke.mjs` diagnostic both showed text only, no
panel. Root cause, confirmed:

- **Not `_meta.ui.domain`.** A controlled A/B
  ([claude-ai-mcp#165, Booyaka101, 2026-07-31](https://github.com/anthropics/claude-ai-mcp/issues/165))
  mounted the iframe 10/10 times with the field omitted (the correct, documented
  choice for a local server; we already do this). Omitting it only loses origin
  *stability* across conversations, which matters for OAuth-flow apps, not for us.
- **The real cause is an open, unresolved Claude Desktop host bug**: `resources/read`
  succeeds (confirmed in our own MCP log — `resources/read` + `tools/call` fire
  together, exactly once per call), then the iframe never receives `ui/initialize`
  and its script never runs. [TaherHaghverdi, 2026-08-07](https://github.com/anthropics/claude-ai-mcp/issues/165)
  reproduces this almost exactly (Desktop 1.26832.0) and confirms the SAME server
  renders fine through MCPJam and the ext-apps reference host on the same machine
  — i.e. Desktop-specific, not a spec-compliance problem in our resource/tool.
  Reproduced by a dozen+ reporters, multiple SDKs, both stdio and remote HTTP,
  continuously from April 2026 through the date of this test. No fix has landed.
- **Ruled out:** [claude-ai-mcp#830](https://github.com/anthropics/claude-ai-mcp/issues/830)
  (filed the same day, plugin-registered servers don't get the `io.modelcontextprotocol/ui`
  capability at all) does NOT apply — our servers are registered directly in
  `claude_desktop_config.json`, the path that DOES advertise the extension.

**Nothing to fix here.** `show_rig_console` is built correctly (nested
`_meta.ui.resourceUri`, no `ui.domain`, correct mimeType, text fallback as the
normative path) and will start rendering the day Anthropic fixes #165, with no
code change needed. Re-check that issue before re-investigating this from
scratch. One cheap, UNCONFIRMED thing worth trying if revisited: Booyaka101
reports (correlation only, not proven) that disconnecting and reconnecting the
connector closed their blank-render window.

**The standalone web page (`open_rig_editor`) is the reliable rich-view surface**,
confirmed working end-to-end this session (clickable link, live data, correct
edit-sync via SSE within one server process).

<details><summary>Original 2026-08-04 framing</summary>

**The blocking objection was withdrawn on 2026-08-01: stdio is NOT excluded.**
Anthropic documents stdio as the primary transport for MCP Apps. The remaining
known blocker is an intermittent host mount bug, not an architectural one. Rules
already recorded: never set `ui.domain`.

- **For:** no listener, no token, no firewall, no lock, no port contention. It
  renders inside Claude Desktop where the maintainer already is, and it reaches
  the phone, which loopback structurally cannot. It is also the closest thing to
  the "chat surface" half of the original ask.
- **Against:** host-version dependent, an intermittent mount bug to reproduce, and
  it does not work with Desktop closed.
- **Verdict:** **evaluate this before building the HTTP host.** If the mount bug is
  survivable it delivers the interactive app at a fraction of the cost, and the
  view model it would render is already built and tested. Start with a render
  smoke-test on the maintainer's Desktop build.

</details>

</details>

### 3. A server spun up from an MCP tool call

Mechanically this is option 1 with a different trigger, and the design already
chose that trigger: `open_rig_editor` starts the listener lazily and returns the
tokenised URL, because only a tool call can hand the URL to the agent. So this is
not a third architecture. Worth stating so it is not re-litigated as one.

**Superseded by the maintainer 2026-08-05: BOTH are wanted, and neither is a
fallback.** The console is to be a standalone app that does not require MCP at
all, and is extremely rich with it (MCP being the preferred path for applying
patches and presets to USB devices, plus quick device-read synchronisation).
MCP Apps stays wanted as the in-Desktop surface. So option 1 is not deferred to
the Desktop-closed case; it IS the standalone product, and option 2 is the
in-chat surface of the same thing.

That combination creates one genuinely hard problem, **two processes contending
for exclusive MIDI ports** once a standalone entry exists alongside an open
Desktop. Design the shared lockfile + read-only degradation BEFORE either serving
path; the full analysis is in `RIG-CONSOLE-HANDOFF-2.md` under "Product
direction". All surfaces consume the same `buildRigView` output regardless.

### The SDK v2 question is separate

`docs/_private/PLAN-mcp-sdk-v2-upgrade-2026-08-01.md` is the plan of record, and
its §0 is the thing to read first: there is no `@modelcontextprotocol/sdk@2.x`.
The major shipped under nine new package names. "Upgrade the SDK" and "speak
protocol 2026-07-28" are two separate decisions, and v1/v2 install side by side.
None of it is a prerequisite for either serving path. Do not bundle them.

## Known gaps

- `verify-song-docs.ts` is still unwritten, so the song-doc census still does not
  exist. The console needed no hand count, so nothing here is blocked on it, but
  the design's "write it FIRST" instruction stands for the migration.
- `release-bundle.yml` still fires on nothing: it triggers on `push: release/**`
  and origin has zero release branches. Untouched this session; still needs
  retargeting or deleting.
- No `VISUAL_SIGNOFF.md` yet, and **no automated UI test at all.** A Playwright
  screenshot + interaction script was written during the build and used to verify
  the page (17 checks: song-to-slot highlighting, device-to-cable highlighting,
  Escape, keyboard operation, no horizontal overflow, no console errors), then
  **removed along with its `playwright` devDependency**, deliberately: the
  project does not carry a dependency for a script no gate runs. Ad-hoc visual
  checks now go through the Playwright MCP plugin instead. Reinstate the
  dependency when there is a load-bearing UI test to hang on it, which is most
  likely when interactive editing arrives.
- The console is not in `preflight` and cannot be: it reads gitignored private
  data, so a contributor has nothing for it to run against.
