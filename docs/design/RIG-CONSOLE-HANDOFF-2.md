# Rig Console: handoff after the read-only console shipped

> Written 2026-08-05, at the end of the session that BUILT the read-only console.
> A fresh session should be able to resume from this file alone. Nothing in this
> session is committed; `git status` is dirty on purpose.
>
> Reading order for a fresh session:
> 1. **this file** (state, what to do next, the traps)
> 2. [`RIG-CONSOLE-NEXT.md`](RIG-CONSOLE-NEXT.md) (what shipped, why the phase boundary moved, the three serving options)
> 3. [`RIG-CONSOLE-DESIGN.md`](RIG-CONSOLE-DESIGN.md) (still the plan of record for the EDITING phases)
> 4. [`RIG-CONSOLE-HANDOFF.md`](RIG-CONSOLE-HANDOFF.md) (the previous session's handoff; its "Start here" is superseded, its traps are not)

## Status in one paragraph

The **read-only Rig Console ships**: `npm run rig-console` reads the rig manifest,
the newest sequencer card capture and the newest setlist, and writes one
self-contained HTML file that opens from `file://` with the MCP server stopped and
Claude Desktop closed. It covers the READ halves of the design's P1, P2 and P3 in
one step, with no HTTP listener, no token, no CSP, no lock and no new runtime
dependency. Everything is verified: `npm run preflight` exits 0, and the whole
page was driven in a real browser (song-to-slot highlighting, device-to-cable
highlighting, Escape, keyboard operation, no overflow at 1280 or 760, no console
errors). **What is NOT built is any editing path and any live server.**

## Product direction, stated by the maintainer 2026-08-05

**The console is a standalone app that does not require MCP, and is extremely rich
WITH it.** Both surfaces are wanted, and neither is a fallback for the other:

- It must run **without Claude Desktop open at all**. Someone who never wants to
  talk to an agent still gets the app.
- **MCP is the preferred path for editing**: applying patches and presets to
  USB-connected devices, and "quick ways to synchronise by reading your device."
- **MCP Apps** stays wanted as the in-Desktop surface.

This does not overturn the governing rule (the app is a second client of the same
dispatcher layer and gets no capability that layer does not already expose). It
DOES promote the design's P5 from "small, but a prerequisite" to a headline
requirement, and it makes device-reading sync a first-class feature rather than a
by-product.

### The hard problem this creates, and it is the one to design first

**A MIDI or serial port is held by exactly one process.** Four run modes fall out,
and only one of them is dangerous:

| Mode | Processes | Ports |
|---|---|---|
| Desktop open, UI in-chat (MCP Apps) | 1 | fine |
| Desktop open, UI in a browser served by the MCP server | 1 | fine |
| Desktop closed, standalone app | 1 | fine |
| **Desktop open AND standalone app running** | **2** | **contention** |

The fourth is not exotic; it is the default once a standalone entry point exists,
because the target user leaves Desktop open. The failure mode is the one the
connection-arbiter doc already logs: writes reporting success into a dead port.

**Recommended shape** (design it before writing either serving path):

1. A **lockfile with a PID liveness check**, shared by both entry points, not just
   by the standalone one. Whoever holds it owns the devices.
2. The loser **degrades to read-only rather than refusing to start.** Every panel
   this session ships reads from FILES, not from devices, so a second instance can
   render the whole console perfectly well; it just cannot open a port. It should
   say so plainly ("Claude Desktop is holding your devices; close it to edit
   here") instead of failing or, worse, appearing to work.
3. **Device-read sync goes through the holder.** "Synchronise by reading your
   device" is the one feature that genuinely needs a port, so it is exactly the
   feature that must be gated on the lock, and it is why the lock cannot be
   deferred to after the sync feature ships.

## What to do next

**Evaluate MCP Apps (SEP-1865) before building the design's P2 HTTP host.** The
reasoning is in `RIG-CONSOLE-NEXT.md` under "Serving the live app"; the short
version is that the "stdio is excluded" ruling was withdrawn on 2026-08-01
(Anthropic documents stdio as the primary transport), the remaining blocker is an
intermittent host mount bug rather than an architectural one, and MCP Apps needs
no listener, token, firewall prompt or single-instance lock while also reaching
the phone, which a `127.0.0.1` bind structurally cannot.

Concretely, in order:

1. **Render smoke-test on the maintainer's Desktop build.** Smallest possible MCP
   App that mounts and displays anything. If the mount bug is not survivable, stop
   and fall back to the P2 HTTP host as designed. **Never set `ui.domain`** (a
   standing rule from earlier work).
2. If it mounts, render `buildRigView` output in it. The view model, the text
   rendering, the diagram emitter and the page renderer already exist and are
   transport-agnostic; only the shell changes.
3. Editing comes after, and its prerequisites are unchanged from the design:
   `executeRigEdit(ops[])` taking a batch, the op expansion (`update_cable`,
   binding CRUD, port ops, `set_routing`), `.bak` pruning, the create-a-rig path,
   and moving the cross-validation at `tools/discovery.ts:198-231` into a shared
   function so a non-tool caller cannot bypass it.

**Do not bundle the SDK v2 migration with this.** `docs/_private/PLAN-mcp-sdk-v2-upgrade-2026-08-01.md`
is the plan of record and says so itself. Its §0 is counter-intuitive and worth
re-reading: there is no `@modelcontextprotocol/sdk@2.x`; the major shipped under
nine new package names, v1 and v2 install side by side, and "upgrade the SDK" and
"speak protocol 2026-07-28" are two separate decisions. Neither is a prerequisite
for either serving path.

## What was built, file by file

| File | Status | Owns |
|---|---|---|
| `packages/openrig/src/view.ts` | NEW | `buildRigView` (topology joined to all four checks) + `renderRigText`. Pure, zero-dep, golden-tested. **The reusable layer every future renderer consumes** |
| `packages/openrig/src/index.ts` | edited | exports `./view.js` |
| `packages/openrig/src/validate.ts` | edited | new `audio-signal-no-channels` + `audio-signal-bad-channel` errors |
| `packages/openrig/src/cytoscape.ts` | edited | `summarizeSignal` no longer throws on a malformed audio payload |
| `packages/openrig/test/run-all.ts` | edited | +26 checks: the view model, the text rendering as a ship gate, the two new validator rules, signal-level governance |
| `packages/openrig/CLAUDE.md` | edited | documents `view.ts` and the two traps it found |
| `scripts/_lib/console-sources.ts` | NEW | loads the three sources, joins setlist to card, reads per-project pad colour |
| `scripts/_lib/console-diagram.ts` | NEW | the vertical flow diagram, emitted as static SVG |
| `scripts/_lib/console-render.ts` | NEW | the page: CSS, three panels, the text peer view, the one small script |
| `scripts/rig-console.ts` | NEW | the CLI |
| `scripts/setlist-sync.ts` | NEW | rewrites the setlist's MEASURED column from the capture; never touches the hand-owned ones |
| `scripts/_lib/circuit-card-roster.ts` | edited | one song's missing artist filled in (was an explicit `undefined` cast) |
| `docs/_private/rig/setlists/loop-list-2026-07-29.md` | edited | synced + stale prose replaced with measured figures |
| `package.json` | edited | two scripts: `rig-console`, `setlist-sync` |
| `docs/design/RIG-CONSOLE-NEXT.md` | NEW | what shipped + the serving options |
| `docs/design/RIG-CONSOLE-{DESIGN,HANDOFF}.md` | edited | supersede headers |
| `docs/_private/rig/prototypes/README.md` | edited | supersede header: do not re-inject the hand-pasted literal |
| `docs/_private/rig/rig.json` | edited | the two-edge data fix below |

## Bugs found and fixed this session

All four were found by running code against real data for the first time. The
pattern is worth naming: **`toCytoscapeElements` had existed for weeks with a
green test suite and had never once been called on the live manifest.** Its own
test was its only caller.

1. **`summarizeSignal` crashed the entire render on a malformed audio payload.**
   The live manifest carried two edges with `{kind:'audio', signals:[]}` and no
   `channels`; `channels.join()` threw. Fixed two ways, deliberately: the
   summariser now reports `audio (channels not declared)` instead of throwing (a
   renderer that dies on one bad edge shows nothing at all), AND `validateRig`
   gained `audio-signal-no-channels` so the defect is caught mechanically. Neither
   `validateRig` nor `checkAudioOutput` had ever inspected `channels`.
2. **Bindings are declared at SIGNAL level, not edge level.** `Edge.binding` and
   `MidiSignal.binding` both exist and both are legal (§4). Real manifests use the
   signal-level form, because one DIN cable carries clock plus transport plus
   three note streams and only one of them is the governed contract. The first cut
   of `buildRigView` read only `Edge.binding` and reported a fully governed rig as
   fully ungoverned. `RigViewLink.bindings[]` now collects both.
3. **The §10 example fixture has no governed edge**, so the first version of the
   governance test passed vacuously (`0 === 0`). The test now asserts the fixture
   genuinely has none, then builds a governed variant, for both the edge-level and
   signal-level forms.
4. **Data fix applied to `docs/_private/rig/rig.json`** (backup at
   `rig.json.pre-audio-channels-fix.bak`): `sm58-to-ve500` and
   `ve500-to-rc505-mic1` had `"signals": []`, which is the MIDI payload field, on
   an audio signal. Both are now `"channels": ["M"]`. Every port involved was
   already declared `audio: "mono"` in the same manifest, so the value was
   unambiguous. Both edges were added the same day (`[confirmed 2026-07-26]`) with
   the identical wrong shape, so the cause was almost certainly a MIDI edge used
   as a copy-paste template. The rig now validates clean.

## What the console surfaced about the rig itself

Not bugs in code; findings about the maintainer's data. **These are open.**

- **Nine songs where the setlist and the card disagree.** The setlist's `Built?`
  column says nine of the songs are not built; the 2026-07-31 capture holds
  projects for all nine. The console reads that column but **never trusts it**:
  build state is measured from the capture and the claim is only contrasted. The
  setlist is the thing to update; the console will keep reporting the gap until
  someone does.
- **One project stores pad colour index 240** (Pack 1, project 64), outside the
  legal 0..13 palette. Reported as read rather than clamped, so it shows as
  "needs a look" rather than being silently rounded to a plausible colour.
- **Three songs on the card are not in the setlist.** Reported every run,
  never dropped.

## Storage, and where the source of truth actually is

Re-derived from the code on 2026-08-05, because the editing phases turn on it.

| Thing | Source of truth | Written by | Cached? |
|---|---|---|---|
| Rig topology | **`rig.json`** (via `MCP_RIG_MANIFEST`) | `edit_rig` → `executeRigEdit` → `writeRigManifest`, and humans by hand | **Yes**, module-level in `openrig/manifest.ts` |
| Inventory ("what I own") | `inventory.json` (via `MCP_RIG_INVENTORY`) | hand | no |
| **What is on the sequencer card** | **the DEVICE.** A capture is only ever a dated snapshot | `backup_device` writes `samples/circuit-ncs/card-backup-*` | no, read per run |
| What a project IS (song / groove / scratch) | `scripts/_lib/circuit-card-roster.ts`, hand-carried TypeScript | hand | no |
| Performance order | `docs/_private/rig/setlists/*.md` | hand | no |
| Per-song detail | `docs/_private/rig/songs/*.md`, 47 files | hand | no |
| Write-adjacent event log | `~/mcp-midi-backups/index.jsonl` | the backup tools | no |

**The rig has one source of truth already, and it is `rig.json`.** The console is
read-only, so it is a pure projection and cannot conflict. That stays true when
editing lands ONLY IF the rule the design states is kept: **one process, one
dispatcher.** Both the browser and the agent must reach `executeRigEdit`, which
writes the file and clears the parse cache at `manifest.ts:96`. That cache is the
whole reason the one-process rule exists.

**Three concrete cache facts the next session will trip over:**

1. `loadRigManifest()` caches at module level and the cache is cleared by exactly
   two things: a successful `writeRigManifest`, and the test-only
   `clearRigManifestCache()`. **An EXTERNAL edit is never noticed.** Editing
   `rig.json` in an editor (or with the Edit tool, as this session did for the
   audio-channels fix) leaves a running server holding the old parse until the
   process restarts. The design's `invalidate()` on the store interface is the fix.
2. A SECOND PROCESS holding the same file would have its own cache that the first
   process's write cannot clear. This is the concrete failure the one-process rule
   prevents, and it is why a standalone `npm run ui` needs the single-instance lock.
3. `writeRigManifest` copies a `.bak` on **every** write and nothing prunes them.
   A guided wizard makes this much worse, since each step is several edits. The
   design's batched `executeRigEdit(ops[])` plus pruning fixes both together.

**Songs and sets have NO single source of truth, and that is the open decision.**
Four hand-maintained places disagree by construction: the setlist markdown, the 47
song docs, the roster TypeScript, and the card capture (which is machine-derived
and therefore the only one that cannot lie about what is stored). The nine-song
disagreement this console surfaces is not a bug in any of them; it is what having
four sources looks like. The design's answer is correct and unchanged: **OpenRig
L2 Repertoire + L3 Performance as JSON, with markdown GENERATED from it**, not
parsed into it. When that lands, the roster's `song` / `artist` / `part` fields
should be read from L2 rather than hand-carried in a `.ts` file.

**`MCP_RIG_MANIFEST` is set in `.mcp.json` as a RELATIVE default**
(`${MCP_RIG_MANIFEST:-docs/_private/rig/rig.json}`). That resolves correctly under
Claude Code, whose cwd is the repo root. It will NOT resolve under Claude Desktop,
which launches the server with a working directory of `C:\Windows\System32`, and
it fails silently by reporting `unconfigured`-shaped emptiness rather than an
error. If the rig is ever expected to work in a Desktop session, that variable
needs an absolute path there. This is the trap the design flagged for
`MCP_RIG_HOME`, already live for `MCP_RIG_MANIFEST`.

## Design decisions taken this session, with their reasons

Recorded so they are not silently re-litigated.

1. **Generated file, not an HTTP host, for the read-only console.** Every input is
   a static local file (the rig is a manifest, the card map is a snapshot of a
   backup, the setlist is markdown) and nothing is read from a device, so the
   entire P2 security apparatus buys nothing. A generated file is also
   double-clickable, works with Desktop closed, and holds no port the vendor
   editors have to fight for. **The host is still the right answer for editing.**
2. **The song-doc migration was not on the path.** "Where they are mapped on the
   sequencer" is already machine-derived from the `.ncs` bytes
   (`circuit-card-scan.ts` + `circuit-card-roster.ts`). The console links out to
   the markdown rather than parsing it. The migration is still worth doing; it was
   not blocking this page.
3. **`buildRigView` runs all four checks itself** rather than taking them as
   arguments. A caller that ran three of four would produce a view quietly missing
   a verdict.
4. **The text rendering lives in `openrig`, beside the golden tests**, because it
   is an accessibility ship gate, and a ship gate belongs where the tests are.
5. **No graph library.** `toCytoscapeElements` remains for a future Cytoscape
   renderer; vendoring ~400 KB inside a self-contained file to draw twelve boxes
   in a column is not worth it. The diagram is emitted as static SVG server-side,
   so it survives with scripting off and prints.
6. **Role tiers, not a topological sort,** for diagram row order. This rig has a
   genuine cycle (the Circuit sends notes out to the MicroFreak and takes its
   audio back), so no topological order exists.
7. **Pads wear the DEVICE's stored colour** (`.ncs` byte `0x0c`), not invented
   category colours, so the grid matches the Projects view. Category moved to the
   tooltip and the text rendering.
8. **`playwright` was installed, used, and removed.** A 17-check screenshot +
   interaction script verified the page, then both it and the dependency were
   removed at the maintainer's direction: the project does not carry a dependency
   for a script no gate runs. Ad-hoc visual checks go through the Playwright MCP
   plugin (installed, enabled, one entry, connects at session start). Reinstate
   when there is a load-bearing UI test, most likely when editing arrives.

## Traps, so the next session does not hit them

- **The Playwright MCP plugin does not connect mid-session.** MCP servers load at
  session start. Installing the plugin during a session surfaces nothing until a
  restart. It is connected now.
- **`npx tsx -e` cannot resolve relative ESM imports**, and a scratch file outside
  the repo cannot resolve `playwright` or workspace packages. Probe scripts have
  to live inside the repo, or use absolute `file:` specifiers.
- **A heredoc inside a compound Bash command can hang the shell.** One `python3 - <<EOF`
  invocation timed out at two minutes this session. Prefer the Write tool.
- **The console cannot be a preflight gate.** All three of its inputs are
  gitignored private data, so a contributor has nothing for it to run against.
- **The colour hex table is an approximation and says so.** Names and palette
  order are Novation's (from the codec's `PROJECT_COLOURS`); the RGB is not
  sampled from hardware, because Novation publishes none in either manual and the
  `.ncs` stores only an index. To make it exact, photograph Projects view and
  replace `PROJECT_COLOUR_HEX` in `console-render.ts`. Nothing else changes.
- **Verify probes against the data, not against assumptions.** Three structural
  checks written this session "failed" because the probe assumed data the rig does
  not have (zero planned cables, no edge-level bindings, every instrument audible)
  or because a regex matched the container (`class="cables"` matching `class="cable`).
  Each looked like a product bug and was not.
- Carried forward from the previous handoff and still true: `verify-release-zip`
  cannot be in `preflight`; do not hand-count the song corpus; `inventory.json` IS
  consumed but `MCP_RIG_INVENTORY` is set nowhere; `edit_rig` opens no device
  port; reads are not proven concurrency-safe; `describe_rig` has 7 characters of
  `tools/list` headroom; check exit codes without a pipe.

## Still open, unchanged from the previous handoff

1. **`release-bundle.yml` fires on nothing.** It triggers on `push: release/**`
   and `git ls-remote --heads origin` shows zero release branches (its own header
   explains it was written for `release/0.8.0`, since squashed into main and
   deleted). Verified again this session. Retarget it or delete it.
2. **`verify-song-docs.ts` is unwritten**, so the song-doc census still does not
   exist. The console needed no hand count, so nothing shipped is blocked on it,
   but the design's "write it FIRST" instruction stands for the migration.
3. **The six song-doc contradictions** still need adjudication.
4. **`MCP_RIG_HOME`** is still undecided.
5. **No `VISUAL_SIGNOFF.md`.** Global CLAUDE.md mandates one for any feature with
   a visible UI surface, and this is the project's first. It is the clearest
   remaining documentation debt from this session.
6. **`STATE.md`'s inbox is at 19 items against a max of 10.** A standing triage
   signal, not from this session, still growing.

## Verification commands

```
npm run rig-console -- --no-open   # generate without opening
npm run rig-console                # generate and open
npm run preflight                  # full local gate; exits 0 as of this session
npx tsx packages/openrig/test/run-all.ts   # the view model + text-rendering gates alone
```

The console's CLI output is itself a report: it prints each source's state
(`loaded` / `absent` / `error`), every setlist-versus-card disagreement, every
song on the card but not in the set, and every rig validation error. A clean run
prints three `ok` lines and the output path.
