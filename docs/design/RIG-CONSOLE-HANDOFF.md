# Rig Console: session handoff

> Written 2026-08-04, at the end of the design session that produced
> [`RIG-CONSOLE-DESIGN.md`](RIG-CONSOLE-DESIGN.md). A fresh session should be able
> to resume from this file alone.
>
> **SUPERSEDED IN PART, 2026-08-04 (same day).** The read-only console SHIPPED, as
> a generated self-contained HTML file rather than as an HTTP host, and it covers
> the read halves of P1, P2 and P3 at once. Read
> [`RIG-CONSOLE-NEXT.md`](RIG-CONSOLE-NEXT.md) FIRST: it records what was built,
> why the phase boundary moved, what the first run surfaced, and the three ways
> the live editing app could be served. The "Start here" and "no console code has
> been written yet" statements below are the parts that no longer hold. Everything
> else, the open decisions and the traps, still stands.

## Status in one paragraph

The Rig Console is a **local app UI over the rig, the performance, and what is on
the gear**, dogfooded by the maintainer, editable from both a browser and the
Claude Desktop agent. The plan is complete and reviewed:
`RIG-CONSOLE-DESIGN.md` (1,017 lines) is the design of record and is ready to
build from. **Nothing in it is implemented.** What DID ship this session is
unrelated to the console itself: four release-bundle bugs found while reviewing
the plan, all fixed and released in `v0.8.0` (commit `5904717`).

## What shipped in v0.8.0 (done, verified, no follow-up needed)

Found while fact-checking the plan, not part of the console work.

| Bug | Fix |
|---|---|
| `arturia` missing from BOTH bundle builders. `server-all` imported it statically since 2026-07-26, so the next Windows ZIP and every `.mcpb` would die at boot with `ERR_MODULE_NOT_FOUND` | Both builders now DERIVE their package list from `server-all`'s transitive workspace closure (`scripts/_lib/bundle-packages.ts`). The hardcoded lists are deleted |
| `release-gate` was red. Three assertions in `verify-release-zip.ts` expected pretty-printed JSON; commit `8a2647d` made tool output compact | Whitespace-tolerant regexes (`"ok":\s*true`) |
| The ZIP gate's device roster was hardcoded and stale, omitting `microfreak`/`minifreak`, so it never exercised `arturia` and **could not have caught the first bug even if it had run** | Roster derived from `docs/contributing/devices/*.md`, which `verify-contribution-guides.ts` already holds 1:1 against descriptors |
| The `.mcpb` bundle had NO verification at all and had not been built since v0.5.1 (2026-06-19), six weeks | `scripts/verify-mcpb-bundle.ts` + `build:mcpb` added to `release-gate` |

New gates: `verify-bundle-package-lists` (in `preflight`, ~2 s, includes an
**import oracle** that scans sources for workspace imports absent from the
closure) and `verify-mcpb-bundle` (in `release-gate`, expensive).

**The pattern worth remembering:** three hardcoded lists caused three bugs, and
two of them were the *fix* for the previous instance of the same bug. Issue #15
shipped ve-500 and boss-rc absent for two releases; its fix was a hand-written
port list that then went stale for arturia. Everything now derives from a source
that cannot drift. **Reach for derivation, not a list, whenever a gate needs to
know "all of X".**

## The console plan, in brief

Read `RIG-CONSOLE-DESIGN.md` for the full design. The shape:

- **One process, two transports.** MIDI and serial ports are exclusive, so the
  HTTP host lives inside the MCP server process Claude Desktop already launches.
  A second process fighting for a port is the most common "nothing happens"
  failure in this project.
- **Plain REST over `node:http`**, not MCP JSON-RPC over HTTP. Reversed mid-session
  after the original rationale ("the executors return structured objects") proved
  only ~2/3 true. The reversal and its reasoning are recorded in the design doc;
  do not re-open without reading that section.
- **Data model is OpenRig L1/L2/L3**, not a new model. `OPENRIG-SCHEMA.md` §7
  already specifies Repertoire (L2) and Performance (L3) and says the two "must
  not diverge". Songs = L2, sets = L3, "related kits/patches/presets" = L3's
  per-song `authored{}` block. Multiple performances falls out free.
- **Six phases**, re-cut so something visible ships first: (1) rig-view generator
  + chat artifact, (2) read-only HTTP host, (3) songs/performances/assets/settings
  as data, (4) rig editing via `edit_rig`, (5) standalone + single-instance lock,
  (6) device-touching edits.

### Start here

**DONE 2026-08-04.** The generator shipped as `buildRigView` / `renderRigText`
(`packages/openrig/src/view.ts`, golden-tested) plus `npm run rig-console`, which
writes the whole read-only console to one self-contained HTML file. The
hand-pasted `const RIG = {...}` literal is retired as a data path. Details, and
the three options for serving the live editing app, are in
[`RIG-CONSOLE-NEXT.md`](RIG-CONSOLE-NEXT.md).

**Next: evaluate MCP Apps (SEP-1865) before building the P2 HTTP host.** The
earlier "stdio is excluded" ruling was withdrawn on 2026-08-01; stdio is the
documented primary transport and the remaining blocker is an intermittent host
mount bug. If it lands, it delivers the interactive app without a listener, a
token, a firewall prompt or a lock, and it reaches the phone, which a loopback
bind structurally cannot.

## Open decisions, waiting on the maintainer

1. **`release-bundle.yml` currently fires on nothing.** It triggers on
   `push: release/**`, and `git ls-remote --heads origin` shows **zero** release
   branches. Work is now on `main` directly. Either push release branches, or
   retarget the workflow. `preflight.yml` is main-only, which is fine now that
   main is where work lands, so the fast static gate does run.
2. **The six song-doc contradictions** listed in the design doc: adjudicate now,
   or resolve them in the songs panel as originally proposed.
3. **`MCP_RIG_HOME`** defaulting to `~/mcp-midi-control/` with the dogfood
   instance pointing at an ABSOLUTE path to `docs/_private/rig/`. A relative value
   is a trap: Claude Desktop's cwd is `C:\Windows\System32`.
4. **LAN bind for phone access** was evaluated and recommended AGAINST; the chat
   artifact is the mobile path. Revisit only if the artifact proves insufficient.

## Traps this session hit, so the next one does not

- **`verify-release-zip` is in `release-gate`, NOT `preflight`**, and cannot be in
  preflight: it needs a built ZIP, which downloads a Node runtime.
- **Do not hand-count the song corpus.** Three counts were produced this session
  (13/3, 16/4, 15/5) and no two agreed. `verify-song-docs.ts` gets written FIRST
  and the census comes from the script. No number belongs in a doc until then.
- **Songsterr `image` hashes are unrecoverable.** The field exists in only 3 of 16
  caches and its value there is the literal placeholder `"img"`. `revisionId` IS
  present in all 16 and is backfillable.
- **`inventory.json` IS consumed** (`dispatcher/discovery.ts:558`, used at `:652`).
  It merely loads `unconfigured` because `MCP_RIG_INVENTORY` is set nowhere.
- **`edit_rig` opens no device port.** `executeRigEdit` validates and writes a
  file. Rig-manifest editing is therefore NOT gated on connection-arbiter Phase B;
  only device-touching edits are.
- **Reads are not proven concurrency-safe.** SysEx carries no correlation id and
  responses route by request-shape predicate on a shared handler set, so two
  concurrent reads can cross-resolve. Do not assume "view-only is safe".
- **`describe_rig` has 7 characters of `tools/list` headroom** (1,793 against a
  frozen 1,800; total 170,688/171,500). Any new argument requires a re-freeze with
  a stated reason.
- **Check exit codes without a pipe.** `cmd | tail; echo $?` reports `tail`'s
  status, not the command's. This nearly caused a false "gate passes" reading.

## Verification commands

```
npm run verify-bundle-package-lists     # fast, in preflight
npm run preflight                       # full local gate
npm run build:mcpb && npm run verify-mcpb-bundle    # macOS/Desktop bundle
npm run build:installer && npm run verify-release-zip   # Windows ZIP
```

## File map

| Path | What |
|---|---|
| `docs/design/RIG-CONSOLE-DESIGN.md` | The design of record. Start here |
| `docs/design/OPENRIG-SCHEMA.md` | §7 L2/L3, §11 inventory. The console must not fork these |
| `docs/design/OPENRIG-UI-RESEARCH.md` | Prior research; its "do not build local-web" line is superseded |
| `docs/design/connection-arbiter.md` | Phase B (R1+R3) unstarted; gates phase 6 |
| `docs/design/accessibility-blind-support.md` | Why the text rendering is a phase-1 ship gate |
| `docs/_private/rig/rig.json` | The live 12-node manifest |
| `docs/_private/rig/prototypes/` | Stale hand-pasted HTML; phase 1 replaces the data path |
| `packages/openrig/src/` | Types, validate, compat, audio, capacity, cytoscape, edit |
