# Rig Console: a local app UI over the rig, the performance, and what is on the gear

> Status: **design, revised 2026-08-03** after two adversarial reviews. Every
> defect those reviews found is resolved in the text below, and every load-bearing
> claim was re-checked against the code on 2026-08-03 with a `file:line` citation.
>
> **P2 + the P4 op layer BUILT, 2026-08-06** (the workplan's five-chunk
> tranche; per-chunk status + deviations in
> [`RIG-CONSOLE-WORKPLAN.md`](RIG-CONSOLE-WORKPLAN.md)): the read-only HTTP
> host with the full security posture below (`open_rig_editor` /
> `npm run rig-console:serve`), the renderer extracted to
> `@mcp-midi-control/rig-console-render`, the full `edit_rig` op expansion at
> the `applyRigEdit` layer (MCP tool schema still the original five ops), the
> single-instance port lease, SSE change propagation, and the owed
> `VISUAL_SIGNOFF.md`. **The per-endpoint read mutex (this doc's own P2
> requirement) is BUILT, 2026-08-06**: connection-arbiter Phase B R1 shipped
> as the `withEndpoint` seam in the dispatcher (per-endpoint lock, ctx only
> obtainable under it, `device_busy` on contention, `reconnect_midi` through
> the lock; gate `verify-endpoint-arbiter` in preflight). A future webhost
> route that opens a device handle inherits the lock by construction, because
> it can only reach a ctx through the same `execute*` dispatchers. R3
> cancellation remains open in connection-arbiter.md.
> Known CSP deviation: `style-src-attr 'unsafe-inline'` (rationale in
> `webhost/host.ts`).
>
> **PARTLY BUILT, 2026-08-04.** The read-only console shipped as a GENERATED
> self-contained HTML file, covering the read halves of P1, P2 and P3 in one step:
> `npm run rig-console`. The phasing below is cut by infrastructure layer, and
> every input to those three panels is a static local file, so the P2 HTTP host
> bought nothing for them. This document remains the plan of record for the
> EDITING phases (P4 onward) and for the host itself. Read
> [`RIG-CONSOLE-NEXT.md`](RIG-CONSOLE-NEXT.md) for what was built, what the first
> run surfaced, and the serving options for the live app.
>
> Supersedes the "do not build the local-web editor" line in
> [`OPENRIG-UI-RESEARCH.md`](OPENRIG-UI-RESEARCH.md): options 1 and 2 there are now
> built (the view prototypes exist, `edit_rig` ships), so option 3 is the next step
> rather than a deferred one.

## The ask

A first-party app UI for everything except authoring presets and patches, which
stay with the manufacturer editors. Four surfaces, in this order:

1. The rig: devices, cabling, MIDI integrations.
2. The performance: songs in the set, with support for more than one set.
3. The related kits / patches / presets / projects on every device. Not
   everything stored on the gear, only what the rig and the performance use.
4. The related settings on each device.

View first, edit later. Editable from both the app and the Claude Desktop agent,
so the two agree and either one can confirm the rig is configured correctly. The
app must play nice with the manufacturer editors, run standalone, support more
than one persistence approach, and exist as both a chat surface and a larger
webpage.

## Decisions taken

| Question | Decision |
|---|---|
| Song data | **Full migration to JSON.** Markdown is generated from the JSON, not parsed into it |
| App hosting | **Served by the MCP server process itself**, because MIDI ports are exclusive |
| Store location | **User data dir, with an env override** pointing the dogfood instance at `docs/_private/rig/` |
| First slice | **Rig + connections, view-only, on real data** |
| Wire format | **Plain REST over `node:http`**, not MCP JSON-RPC (reversal recorded below) |
| Data model | **OpenRig L2/L3**, not a new song/performance model |
| Phone / mobile | **The chat artifact**, not the browser console |
| Standalone | The app must run without Claude Desktop open |

## The governing principle

`OPENRIG-UI-RESEARCH.md:136` set the boundary on 2026-07-12: the server exposes
composable primitives, and the agent is the shape-shifting UX. A first-party app
looks like a reversal of that. It is not, under one rule:

> **The app is a second client of the same dispatcher layer, and it gets no
> capability that layer does not already expose to the agent.**

When a panel needs something the primitives cannot express, the primitive is
wrong, and the app is what makes that visible. That keeps the tool surface honest,
because a capability cannot be quietly added "just for the UI".

Two honest amendments to how this was stated in the previous draft:

- The rule says **dispatcher layer**, not "executors". The `execute*` prefix is not
  a reliable boundary marker (see the next section), so the rule is enforced by an
  import allowlist, not by a naming convention.
- The app's **scope is deliberately narrower** than the agent's. Parity means the
  app gets nothing extra, not that it reaches everything.

**What the app is not.** It is an authoring and confirmation tool. The rig must
work with the laptop closed, so nothing here is a live performance surface, and no
panel should ever be designed to be tapped during a gig.

## Scope: where the gates actually live

The previous draft asserted "the gates live in the executors". **That is false**,
and the design depended on it, so it is worth stating precisely what is true.

Measured 2026-08-03: there are **57 `registerTool` call sites** across the
packages (55 registered; `hydra_navigate_to` and `axefx2_atomic_apply` are
deliberately not registered), and **29 of them reference an `execute*` symbol**.
The remainder either call a differently-named dispatcher function or do the work
inline. Concretely:

| Case | Where | What it means |
|---|---|---|
| `apply_patch`'s save-authorization gate | `packages/hydrasynth/src/tools/patch.ts:269` | A safe-edit gate in the **tool layer**, returning prose with `isError`, with no `executeApplyPatch` anywhere in the tree |
| `export_preset`'s `mkdir` / `writeFile` / `recordBackup` | `packages/core/src/protocol-generic/tools/preset.ts:294-317` | Real filesystem side effects in the tool layer; no `executeExportPreset` exists |
| `edit_rig`'s argument cross-validation | `packages/core/src/protocol-generic/tools/discovery.ts:198-231` | The five operations are validated and assembled into a `RigEditOp` in the tool layer, before `executeRigEdit` is called |
| The whole `send_*` family | `packages/server-all/src/server/tools/midi-primitives.ts` | No dispatcher layer at all |
| `describe_device` | `packages/core/src/protocol-generic/tools/discovery.ts:20-22` | Calls `describeDevice()` / `describeDeviceGuidance()`: correctly below the tool layer, but not named `execute*` |

**Resolution: scope the console to capabilities whose gates live below the tool
layer.** That boundary lands almost exactly on the user's own exclusion, since
`apply_patch` and `apply_preset` are the two clearest tool-layer-gated cases and
both are already out of scope by the ask. Where it is imperfect, say so rather
than discovering it during implementation:

- **`export_preset`** is a backup, which is arguably a console feature, but its
  file I/O is in the tool layer. Either the console does not offer it, or that I/O
  moves into a dispatcher function first. Recommendation: leave it out through P3,
  and do the small contained refactor if and when a backups panel is wanted.
- **`edit_rig`** is the sharpest instance. A REST route calling `executeRigEdit`
  directly would **bypass** the cross-validation at `tools/discovery.ts:198-231`.
  So op construction and validation must move out of the tool layer into a shared
  function that both the tool and the route call. This is a **prerequisite for
  P4**, not a nicety.
- **The `send_*` primitives** have no dispatcher layer. They are out of console
  scope anyway (live-MIDI primitives, and the console is not a performance
  surface), so this costs nothing here. Recorded so nobody later assumes parity.

## Architecture

### One process, two transports

Claude Desktop launches `packages/server-all/src/server/index.ts` over stdio. That
process owns the open MIDI and serial handles (`core/src/server-shared/connections.ts`,
`core/src/midi/transport.ts`, both process-global singletons with `process.on('exit')`
closers). A second process opening the same ports is the single most common
"nothing happens" failure in the project, and it is why the app lives here rather
than beside it.

```
                  ┌───────────────────────────────────────────────┐
  Claude Desktop ─┤ stdio ── McpServer ──┐                        │
                  │                      ├── DISPATCHER ── ports  │
  Browser ────────┤ HTTP ── REST routes ─┘   (the shared layer)   │
                  └───────────────────────────────────────────────┘
```

Refactor: extract `createMcpServer()` into `packages/server-all/src/server/createServer.ts`,
leave `index.ts` at its current path as the stdio entry (Claude Desktop's
configured `args` must not move), and add `packages/server-all/src/server/ui.ts`
as the standalone entry.

One process is also what makes cache coherence free: `writeRigManifest` clears the
parse cache at `manifest.ts:96`, and because the browser and the agent share the
process, an edit from either is immediately visible to the other on the next read.

### The browser talks REST to the same dispatcher

**Decided 2026-08-03, reversing an earlier draft that had the browser speak MCP
JSON-RPC over HTTP. The reversal stands.**

It turns on one fact: the dispatcher already returns structured objects.
`executeDescribeRig()` returns `{total_registered, connected_count, devices,
manifest?, ...}`, and the MCP tool layer is a thin wrapper that `JSON.stringify`s
it into a text block (`tools/shared.ts:124`). So **the parity guarantee comes from
sharing the dispatcher layer, not from sharing the wire protocol.** A REST route
calling the same function gets the identical object and the identical gates, and
hands the UI typed JSON instead of a JSON string nested in a content block.

What MCP-as-wire would have cost, all of it real:

- Every request is `POST /mcp` with an opaque body, so DevTools shows a wall of
  identical rows and nothing is curl-able or pasteable into an address bar.
- Session ceremony for a single-user loopback app: `initialize`,
  `notifications/initialized`, session-id tracking, protocol-version headers,
  expiry handling.
- Double encoding, with the UI parsing back into the object the dispatcher had.
- **Paging the browser does not need.** Reads fit to 40,000 characters because of
  the 50,000-character *host delivery cliff*. A browser on a local socket has no
  such cliff, so the app would be paying an agent-shaped tax for nothing.
- `tools/list` is 170,688 characters of LLM-facing prose, downloaded to generate a
  UI from descriptions written for a model.
- The seam leaks anyway. The rig graph is already not a tool, and the songs and
  asset panels want read shapes no agent needs, so the design ends up hybrid
  regardless and the "cannot drift" claim erodes quietly.

**What is given up.** Parity stops being structural and becomes a convention. It
is restored by one mechanical check, not by discipline:

> **`verify-route-imports.ts`.** The HTTP route modules may import only from
> `packages/core/src/protocol-generic/dispatcher/**` and the store module. Any
> import of a device package's writer or reader, or of `fractal-midi`, fails the
> gate.

This is stated as an **import allowlist rather than a call-name rule** precisely
because of the scope section above: `describe_device` reaches the dispatcher
through `describeDevice()`, so a check for an `execute*` prefix would produce false
failures and teach contributors to work around it.

**UI-only read routes are allowed**, under this rule:

> A UI-only route may exist only if it is read-only, opens no device handle, and
> derives from the same loader the tools use. Anything that touches a port or
> writes a file goes through the dispatcher.

`GET /api/rig-graph` is the first: `toCytoscapeElements()` (`packages/openrig/src/cytoscape.ts:113`)
is called by nothing outside its own test today, the UI needs it, and putting it on
`describe_rig` would spend the agent's response budget on data it will not read.

### The generic escape hatch is dropped

The previous draft specified `POST /api/tool/:name` "dispatching through the same
registry the MCP surface uses". **There is no such registry.**
`packages/core/src/protocol-generic/registry.ts` is a **device** registry
(`registerDevice`, `unregisterDevice`, `clearRegistry`, `listRegisteredDevices`,
`getDeviceById`, `resolveDevice`), and tool handlers live in `McpServer`'s
`_registeredTools`, declared `private` in the SDK
(`@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:21`). Nothing in the repo
touches it.

Three options and their costs:

| Option | Cost |
|---|---|
| Reach into the private field | Breaks on any SDK minor, needs a cast through `unknown`, and is exactly the unsupported-internals dependency the project avoids |
| Maintain a parallel tool registry | A second registration path across 57 call sites in 8 packages, a new drift class where CLAUDE.md already warns about caller audits, and it would hand the browser double-encoded MCP content blocks, undoing the REST decision's main benefit |
| **Drop it (chosen)** | "Can the app do what the agent can" is answered by a list of routes rather than by construction, and each new panel needs a typed route |

Dropping it is right for a second reason: the console's scope is deliberately
**narrower** than the tool surface, so a universal hatch would reach precisely the
capabilities the scope excludes.

### Security

The checklist at `OPENRIG-UI-RESEARCH.md:66-79` is treated as requirements.

- Bind `127.0.0.1` explicitly, port `0` (ephemeral) unless `MCP_WEB_UI_PORT` pins it.
- Per-launch token, `randomBytes(32)`, memory only, never written to disk or into
  `rig.json`, compared with `timingSafeEqual`.
- **Token in the URL fragment, not the query string**: `http://127.0.0.1:PORT/#t=TOKEN`.
  A fragment is never transmitted to a server, never lands in `Referer`, never in
  history after the shell `replaceState`s it away.
- `Host` must equal `127.0.0.1:PORT` or `localhost:PORT` exactly. This is the
  anti-DNS-rebinding control. `Origin`, when present, allowlisted the same way, and
  required on every state-changing method.
- Failed check: 403, fixed terse body, no detail echoed. Never emit
  `Access-Control-Allow-Origin` at all.
- Idle expiry after 30 minutes with no authenticated request. This also bounds the
  one real leak: the token rides in a tool result, so it lands in the Desktop
  transcript.

Precedent to cite: the MCP Inspector added exactly these controls after
CVE-2025-49596, a DNS-rebinding RCE caused by binding broadly with no auth.

#### Static assets cannot carry a bearer, so they carry a scoped cookie

The previous draft required the bearer on "every other route, **including static
assets**". **That is not implementable.** A browser will not attach an
`Authorization` header to `<script src>` or `<link rel=stylesheet>`; there is no
API to do so. As written, the app could not load its own JavaScript.

The scheme, chosen after evaluating the alternatives:

1. `GET /` serves a **constant, information-free** HTML shell, unauthenticated. It
   contains no inline script (CSP forbids it) and one tag: `<script src="/boot.js">`.
2. `GET /boot.js` is **also unauthenticated**, and is likewise a constant,
   information-free byte string, identical for every user and every launch.
3. `boot.js` reads `location.hash`, `POST`s the token to `/api/session`, and
   `replaceState`s the fragment away. `/api/session` validates with
   `timingSafeEqual` and responds with
   `Set-Cookie: rc_assets=<opaque>; SameSite=Strict; HttpOnly; Path=/assets`.
4. `boot.js` keeps the bearer in JavaScript memory and injects the real asset tags.
   Assets under `/assets/*` authenticate by that cookie; **`/api/*` continues to
   require `Authorization: Bearer` and never accepts the cookie.**

The trade-offs, stated plainly rather than smoothed over:

- **Two unauthenticated routes instead of one.** Both are constant and carry zero
  information about the user, the rig, or the gear. That is the actual cost.
- **The asset cookie is a genuine ambient credential**, which is the thing the
  bearer design was chosen to avoid. It is scoped to `Path=/assets`, so it is never
  sent to `/api`, which keeps CSRF structurally impossible for every route that
  reads or changes anything. `SameSite=Strict` means it is not sent on cross-site
  requests at all. `HttpOnly` means script cannot read it back, so an XSS cannot
  exfiltrate a durable credential. What a cross-site page could achieve at most is
  causing a fetch of constant application code.
- **Rejected: one big inlined HTML file.** It forces `'unsafe-inline'` into the CSP
  and makes a vendored graph library uncacheable on every load.
- **Rejected: a token in the asset query string.** It lands in server logs and
  `Referer`, and makes every asset URL unique per launch, killing caching.

#### CSP

`default-src 'none'` alone **blocks the app's own JavaScript and CSS**, which is
what the previous draft specified. Each directive the app actually needs must be
granted explicitly:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self';
  base-uri 'none';
  form-action 'none';
  frame-ancestors 'none'
```

`frame-ancestors 'none'` is what stops a malicious page framing the console and
clickjacking a rig write. `connect-src 'self'` is what permits the `fetch` calls to
`/api/*`; without it the page loads and every request fails. Served alongside
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Cache-Control: no-store` on `/api/*`.

The exact header string is asserted by a test (see "Testing"), because a CSP that
is subtly wrong fails open in one direction and breaks the app in the other, and
neither is obvious from reading it.

### Lifecycle

**Lazy, opt-in, via an `open_rig_editor` tool.** Not an env var, not always-on.
The deciding argument is that only a tool call can hand the URL to the agent, and
the URL contains a per-launch token the agent has to speak to the user. Secondary:
Desktop launches this server on every app start, and a listener open for hours of
sessions that never touch the UI is waste.

In standalone mode the host starts eagerly and prints the URL to stdout.

**stdout is the protocol channel.** Every runtime write in the server's import
graph already goes to stderr; all 69 log sites were checked and no existing bug was
found. But this feature adds the first code with a legitimate reason to print a
URL, so take the only defence that survives a future contributor: hand the sole
fd-1 handle to the transport and redirect `process.stdout.write` to stderr in stdio
mode. Back it with `scripts/verify-no-stdout-writes.ts` in preflight.

### Static assets

A built asset directory at `packages/server-all/src/web/`, not an inlined file.

`tsc` emits no non-`.ts` files and `build-installer.ts` copies only `dist`, so
shipping is one line in `scripts/copy-build-assets.ts`'s `COPIES` array. Serve from
an explicit `Map<pathname, {file, contentType}>`, resolved with
`fileURLToPath(new URL('../web/', import.meta.url))`, the same idiom `index.ts:239`
already uses for `package.json`, which works both in the repo and in the extracted
ZIP. Never a path join against user input, so there is no traversal surface.

### Dependencies

**Zero new dependencies.** `node:http` alone covers the listener, routing, auth,
header validation, static serving, and the change-propagation stream:
`http.createServer(handler)`, `new URL(req.url, 'http://127.0.0.1')` for routing,
`req.headers.authorization` for the bearer, and a held-open `text/event-stream`
response for events.

This is a direct benefit of the REST decision. Speaking MCP over HTTP would have
pulled in `StreamableHTTPServerTransport`, which statically imports
`@hono/node-server`; that dependency already ships inside the SDK, but it would
have been a framework in the graph for no gain.

## The data model

### It is OpenRig L1/L2/L3, not a new model

The previous draft listed songs and performances as "new". **They are not.**
[`OPENRIG-SCHEMA.md`](OPENRIG-SCHEMA.md) §7 already specifies them, and says in its
own text that **L2 "IS that manifest, not a second graph beside it; the two must
not diverge"** (§7, L2 heading). Building a parallel song model would be the exact
divergence that document forbids.

So the console's four surfaces map onto the existing layer stack:

| Console surface | OpenRig layer | Where it is specified | Status |
|---|---|---|---|
| Rig, connections, MIDI integrations | **L1 topology** + §4 bindings | §3, §4 | **Built.** `packages/openrig/src/types.ts` |
| What I own (feeds the empty state and the proposer) | **Inventory** | §11 | **Built.** `packages/openrig/src/inventory.ts` |
| Songs | **L2 Repertoire** | §7 | Specified, unbuilt |
| The performance / set, and more than one of them | **L3 Performance** | §7 | Specified, unbuilt |
| Kits / patches / presets / projects in use | L3 `authored{}` per song, plus the asset registry below | §7 | Partly specified |
| Per-device settings | Settings registry below | new | new |

Two consequences that change the work:

- **"Related assets, not everything stored" is already the L3 shape.** §7's
  `authored{}` block per song (`{am4:{scene}, circuit:{project}, rc505:{memory},
  spdsx:{kit}}`) is exactly "what this song uses on each device". The asset registry
  is the *index* over those references plus rig-level pins, not a second model.
- **"Possibly multiple performances" is free.** L3 is already one document per show
  referencing a shared L2 library, so more than one set is the default shape rather
  than a feature.

What genuinely is new is the **settings** surface (§4 covers cross-device bindings
but not per-device global setup) and the **asset registry** as an index. Both are
described below and both must reference L1/L2/L3 rather than restate them.

### Store resolution and the persistence seam

Add **`MCP_RIG_HOME`**, resolving the artifact paths beneath it, with the existing
per-file vars (`MCP_RIG_MANIFEST`, `MCP_RIG_INVENTORY`) kept as overrides for anyone
already wired up. Default `~/mcp-midi-control/`, following the existing
`~/mcp-midi-backups/` precedent (`dispatcher/backupIndex.ts:44` uses
`path.join(homedir(), 'mcp-midi-backups')`) rather than inventing a second
convention.

**`MCP_RIG_HOME` must be absolute, or it is resolved against the user's home
directory.** A relative value is a trap: Claude Desktop launches the server with a
working directory of `C:\Windows\System32`, so `MCP_RIG_HOME=docs/_private/rig`
would resolve there and silently miss. The loader rejects a relative path with a
message naming the absolute form, and the dogfood instance sets the absolute path.

**The persistence seam.** The user asked to "support different persistence
approaches" (local now, possibly web later). That needs a seam now and exactly one
implementation now:

```ts
type StoreStatus<T> =
  | { status: 'loaded'; value: T; source: string }
  | { status: 'absent'; source: string }        // configured, nothing there yet
  | { status: 'error'; error: string; source: string }
  | { status: 'unconfigured' };

interface RigStore {
  load<T>(kind: StoreKind, id?: string): StoreStatus<T>;
  save<T>(kind: StoreKind, id: string | undefined, value: T): SaveResult;
  list(kind: StoreKind): ListResult;
  backup(kind: StoreKind, id?: string): BackupResult;
  invalidate(kind?: StoreKind): void;
}
```

- **Status-shaped, never throwing.** This is a generalization of the shipped
  `LoadedRigManifest` union (`openrig/manifest.ts:22-25`), not a parallel idea.
- **`absent` is a distinct state** from `error` and from `unconfigured`. Today
  "configured but the file is missing" collapses into `error`
  (`manifest.ts:36-38`), and that conflation is what makes the first-run deadlock
  below unrecoverable.
- **One implementation today: `FilesystemRigStore`,** rooted at `MCP_RIG_HOME`. Do
  not build a second one now. The seam exists so a later approach is an
  implementation rather than a refactor.

### First run: the deadlock that must be fixed before any empty state ships

"Create a rig" cannot work today, and it fails in two different ways:

- With `MCP_RIG_MANIFEST` **unset**: `loadRigManifest()` caches
  `{status:'unconfigured'}` (`manifest.ts:61-64`), `writeRigManifest()` throws
  because there is no path (`manifest.ts:87-89`), and `executeRigEdit` refuses
  before reaching either (`openrig/edit.ts:57-59`).
- With the var **set but the file absent**: `load()` returns `status:'error'`
  (`manifest.ts:36-38`), **that error is cached**, `executeRigEdit` refuses on it
  (`openrig/edit.ts:60-62`), and creating the file externally will not be noticed
  until the process is relaunched. Nothing clears the cache except a successful
  write or the test-only `clearRigManifestCache()` (`manifest.ts:67-69`).

Required fixes, all small:

1. A **create path** that resolves a default target under `MCP_RIG_HOME` instead of
   requiring `MCP_RIG_MANIFEST`, seeds via the existing `bootstrapRig(seeds)`, and
   writes it.
2. **`absent` treated as a first-class empty state** with a create action, distinct
   from `error`.
3. **Promote `clearRigManifestCache()` from test-only** to the store interface's
   `invalidate()`, and call it whenever the resolved path changes or a create
   succeeds.

### `.bak` accumulation and the missing transaction

`writeRigManifest` writes one `.bak` per edit (`manifest.ts:92-93`) and **nothing
prunes them**. A guided wizard makes this much worse, because each wizard step is
several edits.

`executeRigEdit` also takes **one** op (`openrig/edit.ts:54`) and writes on each.
A four-op wizard step (add device, add port, add cable, add binding) persists four
times, backs up four times, and can stop half-way, leaving a device with no cable
in a file the user now owns.

Both need fixing together:

- **`executeRigEdit(ops: RigEditOp[])`**: apply every op in memory, validate
  **once** at the end, write **once**. All-or-nothing. A wizard step becomes one
  transaction, and four backups collapse to one.
- **Prune inside `writeRigManifest`** so both callers inherit it: keep the most
  recent N (20 is reasonable) plus anything younger than 7 days.

### Songs: what the migration actually is

**The census comes from a script, not from a hand count.** Three different
hand-counts exist across the working docs (13/3, 16/4, 15/5) and no two agree; the
ambiguity is real, because `docs/_private/rig/songs/` holds 47 markdown files that
mix canonical song docs with interviews, build plans, rebuild plans, and dated
research. Any number written into this document would be a fourth wrong count.

So: **`scripts/verify-song-docs.ts` is written FIRST**, before the schema work. It
defines what counts as a canonical song doc, and the census is whatever it reports.
It is the checker the song schema has always described and never had.

What the migration is, independent of the count:

- A mechanical heading-to-field conversion loses a large fraction of the content, so
  the schema needs a typed core plus an ordered free-section escape hatch
  (`NarrativeSection[]`). This is a **reconciliation project, not a conversion**.
- **`capabilities` must be `CapabilityRequirement[] | null`**, where `null` means
  never audited and `[]` means audited and nothing applied. Most songs lack the
  mandated capability table. Flattening those to `[]` would silently assert they
  demanded nothing of the rig, destroying the exact argument the capability matrix
  exists to make.
- Most songs carry song-specific narrative headings with real content that fits no
  field (a MicroFreak drone writeup with its own cell table, a medley section,
  carry-over verdicts, a source story). This is the largest "nothing may be lost"
  exposure in the job.
- Most songs carry verbatim maintainer speech the schema rules require be preserved
  rather than paraphrased, hence a `Quote` type with attribution and date.
- Several carry hand-authored layers no pipeline can regenerate, so track content is
  a discriminated union, not a `partId`.

Contradictions the migration must **resolve rather than import**. These need
decisions from the maintainer, and they are the first real job for the songs panel:

1. **Slot numbering base.** One doc distinguishes stored slot from displayed project
   number; others state a range without saying which they mean. Get this wrong and a
   song lands one slot off.
2. **Docs that say both "built" and "not built" internally** (the status banner was
   updated, the tail section was not). Reading the banner gives one answer and
   reading the last section the opposite. This is the strongest argument for a typed
   `BuildStage`.
3. **A drum binding a later document explicitly calls wrong**, still carried as a
   hazard warning in the song doc. Importing it verbatim imports a false hazard.
4. **A kit choice that supersedes the plan docs**, where the kit is settled and the
   per-pad mapping under it has not been re-checked.
5. **The setlist's "Built?" column is stale**, and its own notes admit the column was
   inferred and wrong more than once. Build state must live on the Song and be read
   through, never restated on a setlist entry.
6. Facts that live only in the performance-test doc with no per-song home, including
   a cross-song conflict where two songs' individually correct decisions are mutually
   incompatible. Hence `CrossSongConflict` on the L3 Performance.

**Correction to the source material, re-verified 2026-08-03.** Both previous
accounts of the Songsterr cache were wrong. The actual contents of the 14
`samples/songsterr-cache/*/meta.json` files:

- Top-level key union: `songId`, `revisionId`, `title`, `artist`, `bassPartId`,
  `roster`, `allTracks`, `image`, `popularTrackDrum`, `tracks`. Two generations are
  present: an older shape with `tracks[]`, a newer one with `allTracks[]`.
- **`revisionId` is present in all 14** and is therefore backfillable.
- **`image` is present in 3 of 14**, and in all three its value is the literal
  placeholder `"img"`. Track entries likewise carry `hash: "h0"`, `"h1"`. These are
  redacted placeholders, not hashes.

So the conclusion the schema needs is unchanged, but for the right reason: the
image hash is **not** recoverable, because where the field exists it was redacted,
not because the field is absent. Treat it as permanently "never recorded" and
backfill `revisionId`.

### Device assets and settings

An asset is a stable reference to one stored thing:
`{device_id, space?, location, pack?}`.

Two judgement calls worth stating, because they are what keeps the model honest:

**`location` is stored exactly as you would type it into `switch_preset`, in
front-panel numbering, never as a wire value.** There are two documented
off-by-ones that silently load the wrong patch rather than failing (Hydrasynth
`A015` to PC 14, MicroFreak `39` to PC 38), and both are already handled inside the
descriptors. A registry storing the wire value would be a second, competing parser
that goes wrong the first time a descriptor is corrected. A registry row should be
copy-pasteable into a tool call. Likewise the registry stores the address and the
*descriptor* supplies the noun ("preset" / "project" / "kit" / "memory").

**A setting the server can never read back is a different type from one it can, not
a flag on the same type.** `RIG-CONTROL-MATRIX.md` defines five states, and they
conflate two independent questions: what the server can do, and why it cannot do
more. `gap` is temporary and has an RE task named. `external` is permanent, and the
Circuit's entire global setup, the AM4's SETUP > MIDI/Remote, the Hydrasynth's RX
channel and the SPD-SX global channel are all in it. So `SettingControl` is a
discriminated union in which the `external` variant **carries no param reference at
all**, and therefore no code path can attempt to read it. It carries a
`HandConfirmation` instead, whose method enum structurally excludes `device_read`.

That makes the checkbox table in `CURRENT-RIG.md` a computed view rather than a
hand-maintained one, and `RIG-CONTROL-MATRIX.md` becomes generated from the registry
rather than maintained alongside it.

**Declared is not actual.** Every declaration carries how and when it was last
checked, ranked by the project's own verification hierarchy (front panel > device
read > behavioural > file bytes > editor > self-report > assumed). Staleness is
computed per method, not stored, and `assumed` has a half-life of zero so it
surfaces immediately instead of aging quietly into a fact.

Two free invalidators: `~/mcp-midi-backups/index.jsonl` already logs every
write-adjacent event with device, location, pack and timestamp, so any entry newer
than a verification invalidates it with no MIDI round trip; and edit-buffer settings
expire at power-off, which matters because at least one live setting is
edit-buffer-only while its stored value differs.

**For an unplugged device the UI shows the declared state in full, labelled with its
verification age, with status `device_absent`.** Never "match" (nothing was
checked), never "empty" (nothing said so), never an error. Most of the rig is
routinely offline; unplugged is the normal state of a rig at rest.

**Scope rule.** An asset is in the registry if and only if a typed reason says so:
referenced by a song, pinned for a rig-level role, or manually pinned with a note.
Discovery **proposes**, a human disposes. Auto-tagging is refused deliberately: the
bytes cannot tell a song section from a purchased groove whose name is a community
guess from protocol scratch, and conflating the first two is an error these docs
have already made once and had to correct. Nothing is ever auto-removed; an asset
that loses its last reason becomes a reported orphan, and retirement supersedes
rather than deletes.

**Seeding is mostly mechanical.** `scripts/_lib/circuit-card-roster.ts` (~110
entries) maps almost field for field, including its
`confidence: 'verified' | 'intended'` split which becomes a verification record. A
live `scan_locations` sweep across the descriptors that support it fills in names and
occupancy. Settings and by-ear patch choices are hand-entered and always will be.

### `inventory.json` is consumed

Correcting the previous draft, which said nothing consumed it:
`buildRigInventorySummary()` is defined at
`packages/core/src/protocol-generic/dispatcher/discovery.ts:558` and **called at
:652**, surfacing as `describe_rig`'s `inventory` field with the in-rig-vs-spare
cross-reference. It reports `unconfigured` only because **`MCP_RIG_INVENTORY` is set
nowhere**: the string appears in code and docs and in no launch configuration. The
fix is a store-root default, not new code.

## Playing nice with the manufacturer editors

The ask says the app must play nice with the vendor editors. As runtime behaviour
that is unaddressed by anything shipped, and it is not a small point: **a MIDI or
serial port is held by exactly one process.** If AxeEdit, AM4-Edit, FM3-Edit or
FM9-Edit holds a device, this server cannot, and the reverse. This is already the
project's most common "nothing happens" failure, and the canonical statement of the
rule is `docs/contributing/SAFETY.md`.

The console owes three behaviours:

1. **Distinguish "not plugged in" from "plugged in but held elsewhere."** The second
   is actionable and the first is not, and presenting them identically is what makes
   users conclude the app is broken. Reuse the existing `device_absent` shape rather
   than inventing a second unavailable state, with a distinct reason
   `port_held_elsewhere` so the UI can say why.
2. **An explicit Release device action, per endpoint.** The console closes this
   server's handle for one device without killing the process, so the user can hand
   that device to the vendor editor and take it back afterwards. Today
   `reconnect_midi` is recovery-only, it reopens; there is no deliberate release.
   Release is its counterpart and must be per-endpoint, never global, so releasing
   the FM3 does not drop the AM4. Re-acquire on demand, never on a timer, so the
   console does not race the editor for a port the user deliberately handed over.
3. **Never present a value it did not read.** The project rule is that the front
   panel and `get_param` are ground truth and the vendor editor caches stale UI
   state. The console has no channel to the editor and no way to invalidate its
   cache, so it must not attempt reconciliation. It shows its own read, labelled
   with where it came from and when, and states plainly that a vendor editor open at
   the same time may be showing something different. While the editor holds the
   port, the console can show only declared and last-read state, with its age.

## Concurrency: what actually blocks what

`docs/design/connection-arbiter.md:3`: Phase A shipped 2026-07-09. **Phase B R1
(per-endpoint serialization + contention) shipped 2026-08-06; R3 cancellation is
the remaining half.** The single-instance lock shipped in the same tranche
(`instanceLock.ts`, chunk 4 of the workplan); the paragraphs below predate both
and are kept for the reasoning.

That doc says current write safety is incidental: one chat serializes tool calls,
which the MCP spec never guaranteed. **This feature removes that assumption by
design**, since a browser reading the rig next to Desktop is the entire point.

### "View-only is safe today" was unproven, and it is wrong

SysEx has **no correlation id**. `makeSysExReceiver`
(`packages/core/src/midi/transport.ts:499-521`) registers a predicate handler on a
**shared handler Set**; every inbound SysEx is offered to every handler, and the
first whose predicate returns true resolves and removes itself. Correlation is
therefore by predicate plus arrival order, nothing else.

For AM4 preset-name reads that is not enough to tell two requests apart:

- `isPresetNameReadResponse` (`packages/am4/src/shared/readOps.ts:130-142`) compares
  only bytes 0 through 15.
- Every byte it compares is a **constant across all 104 locations**: `pidLow` 0x00CE,
  `pidHigh` 0x000B, action 0x0012, hdr3 0, hdr4 0x0020
  (`packages/fractal-midi/src/am4/setParam.ts:969-978`). The location rides in the
  packed payload **after** byte 15.
- The codec says so itself at `setParam.ts:986-989`: "The wire response does NOT
  carry the location; AM4-Edit correlates request-with-response by arrival order."

So two in-flight preset-name reads for different locations are **indistinguishable**,
and a `scan_locations` sweep racing a browser read can bind a name to the wrong
location. Nothing errors; the user sees a plausible wrong answer, which is the worst
available failure mode.

Corrected table:

| Capability | Blocked on |
|---|---|
| View-only, in-process, browser + Desktop together | **UNBLOCKED 2026-08-06**: the per-endpoint mutex shipped (`withEndpoint`, arbiter Phase B R1), so concurrent reads on one device serialize by construction |
| Rig-manifest editing from the app | **Nothing on the port side.** `executeRigEdit` opens no device handle (see below). Blocked on the op expansion and the shared validation function |
| Device-touching edits from the app | **The `withEndpoint` seam exists (2026-08-06)**; remaining: the write routes themselves, and R3 cancellation for escaping long holders |
| Standalone `npm run ui` | Single-instance lock — **shipped 2026-08-06** (`instanceLock.ts`); remaining: the standalone entry itself (P5) |

**What is needed, and it is not new machinery.** Route every console read through a
per-endpoint mutex, which is exactly Phase B's R1 `withEndpoint`. Introduce that
seam when the HTTP host lands (P2), even before Phase B's cancellation half, and put
both the console's reads and the tool layer's reads behind it. A per-endpoint mutex
is small; the reason it must exist before P2 ships is that the defect above is
invisible when it fires.

**`edit_rig` opens no port.** `executeRigEdit` (`openrig/edit.ts:54-96`) loads a
file, calls `applyRigEdit`, validates, and writes. It touches no `MidiConnection` at
any point. The previous draft gated **all** app editing on Phase B, which was wrong
and pushed the most valuable editing surface behind the longest-lead dependency.

## Change propagation

The stated premise is that the app and the agent edit the same things and agree.
Today there is no channel from the server to an open browser, so an agent-side edit
leaves the page stale with no indication.

- **Server to browser: `GET /api/events`, Server-Sent Events**, on the same
  `node:http` listener. SSE is a `text/event-stream` response held open and written
  to; it needs no dependency and no WebSocket. Emit on every successful store write,
  carrying the kind and id that changed; the browser refetches that resource. Not a
  push of the data itself, so there is one read path rather than two.
- **Browser to agent: nothing needed.** The agent re-reads on its next tool call,
  and `writeRigManifest` already clears the parse cache at `manifest.ts:96`. Because
  the app and the agent are the same process by design, this is coherent for free.
  That is a concrete payoff of the one-process decision.

## The agent surface, and its hard ceiling

Measured 2026-08-03 by `scripts/verify-tools-list-budget.ts`:

- **Total: 170,688 of a 171,500 ceiling. 812 characters of headroom** across 55
  tools, paid on every session before the first tool call.
- **`describe_rig`: 1,793 against its frozen ceiling of 1,800
  (`scripts/verify-tools-list-budget.ts:139`). Seven characters.**

Seven characters means **the previous plan's "songs, performances, assets and
settings reach the agent as optional arguments on `describe_rig`" cannot land.** The
cheapest possible optional argument, a name plus a type plus a one-line description,
is on the order of 100 characters of schema. And the previous plan's rule, "re-freeze
only when `open_rig_editor` lands, and not before", **forecloses the very re-freeze
that argument requires**.

A real budget plan, three moves, stated up front:

1. **`open_rig_editor` lands with a hard cap of 700 characters**: two sentences, no
   arguments. For calibration, `list_midi_ports` measures 1,134 total with a 579-char
   description and one optional argument. Pay for it out of the 812 total headroom,
   leaving roughly 112.
2. **`describe_rig`'s per-tool ceiling rises when its argument surface lands**, with
   a stated reason, and the **total** is paid for by cutting in the same commit. The
   only place with real slack is argument prose in the two largest tools:
   `apply_pattern` is 25,745 characters of which **17,367 is argument prose**, and
   `apply_preset` is 17,087 of which **8,232 is argument prose**. The gate already
   flags both as advisory for exactly this reason.
3. **No tool per noun.** Songs, performances, assets and settings reach the agent
   through `describe_rig` arguments and the existing fat editors. A family of new
   tools does not fit and will not fit.

The standing rule is unchanged and worth repeating: **re-freeze with a stated reason
and a paid-for total, never to make a red run green.**

The app pays none of this; only the agent surface does. Exploit that asymmetry
deliberately: rich exploration lives in the browser, and the agent gets the summary
plus the argument that fetches detail.

**Response sizes are gated separately.** The asset registry rendered whole is well
past the 50,000-character host delivery cliff that has already caused three silent
outages. So `describe_rig`'s asset field carries counts and drift totals only,
row-returning reads fit to 40,000 and page, and a shortened response says so.

**The app inherits paging, because the budget lives in the dispatcher**
(`dispatcher/discovery.ts:898`, `dispatcher/backupSweep.ts:438`), not in the tool
wrapper. A browser on a local socket has no delivery cliff, so this is a tax it does
not owe. Take the cheap path first: **the UI walks `next_offset` in a loop.** On
localhost that is microseconds and it keeps exactly one code path. If it becomes
genuinely annoying, promote the budget to an explicit dispatcher *parameter* the
route can raise. Do not add a "browser mode": a mode is a second behaviour for one
function and that is the drift this design exists to prevent, whereas a parameter is
the same behaviour with a different bound.

## `edit_rig` cannot express the authoring surface yet

`edit_rig` has **five operations**, assembled at
`packages/core/src/protocol-generic/tools/discovery.ts:198-231`: `add_cable`,
`add_device`, `remove_device`, `remove_cable`, `set_cable_enabled`. That set cannot
express a guided wizard, and two of the gaps break contracts `OPENRIG-SCHEMA.md`
has already locked.

| Gap | Consequence |
|---|---|
| No `update_cable` | "Move the Hydra to channel 3" is only expressible as remove + add, which **regenerates the edge id and drops `note`**. §8 requires ids be "stable and opaque, authored once, never regenerated on edit (so re-cabling an edge is a *modify*, not delete+add)". The current op set actively violates it |
| No binding CRUD at all | §4 calls the binding "the SINGLE authoritative source for a governed signal". The app cannot author the thing the schema calls authoritative. Meanwhile `remove_device` **destroys** bindings as collateral, so the surface can delete them but not create them |
| No way to set `output_role` (no port ops at all) | `checkAudioOutput` walks to a monitor/OUT node, and `output_role` is an output-port field (§3). **An app-authored rig can never satisfy `checkAudioOutput`**, so the console would ship showing a permanent failure on its own output stage |
| No `update_device` / rename | A typo in a device name is unfixable without hand-editing the JSON the app exists to replace |
| No way to declare `routing` | §5.6 makes `routing` what allows reachability to be computed *through* a node. Every app-authored node stays "unknown / pass-through" |
| No way to declare `capabilities` | §4's progressive capability model is unreachable from the app |
| `buildSignal` always emits a one-element array | "One cable carries a SET of signals" (§5.1) is unreachable. That invariant is the stated reason Cytoscape was chosen over JSON Graph Format (§2) |

Required op expansion:

- `update_cable` (edge id preserved; patches channel / cc / notes / note_map /
  enabled / note)
- `add_signal`, `remove_signal` on an existing cable, for the multi-signal invariant
- `add_binding`, `update_binding`, `remove_binding`
- `update_device` (rename, roles, `server_device_id`, note)
- `add_port`, `update_port`, `remove_port`, where `update_port` carries `output_role`
- `set_routing` (consume / pass / originate for one node)
- **and the batch form** from the transaction section above, since a wizard step is
  several of these at once

Alongside it, the validation currently at `tools/discovery.ts:198-231` moves into a
shared function both the tool and the REST route call. Otherwise the route bypasses
it, which is defect-by-construction.

## Mobile, and the chat surface

**Decision: the browser console is desktop and laptop only. The phone answer is the
chat artifact.** Stating this explicitly rather than leaving it implicit, because
the previous draft dropped mobile silently while carrying mobile-first research.

The tension is real. The prototypes are mobile-first (`rig-view.html:28` sets
`max-width:560px`, and the layout is a phone column), and the researched edit model
is IFTTT-shaped **for mobile**. But the console binds `127.0.0.1` by design, so a
phone cannot reach it at all. Shipping a mobile-shaped layout nothing mobile can
open would be the worst of both.

The resolution keeps the research:

- **The rig-view generator is shared, and it has two renderers.** One emits the chat
  artifact (`OPENRIG-UI-RESEARCH.md` option 2, already the recommended near-term
  surface), one feeds the console. The artifact runs wherever Claude runs, including
  the phone, and it satisfies the "Chat UI" half of the ask directly.
- That makes the artifact a **first-class surface**, not a fallback: it is P1, it
  ships before the console, and the console is the "larger, better webpage" half of
  the same ask.

**LAN bind as an opt-in: evaluated, recommended against.** Binding a wider interface
would give a phone the real console, and it is tempting. Four costs:

1. Every control in the security checklist's threat model goes live on an untrusted
   network. Green-room and venue wifi are exactly the wrong place for it.
2. The `Host` header anti-rebinding check becomes meaningless as written, since the
   host is no longer `127.0.0.1`.
3. Either a real certificate story, or the bearer rides in plaintext over the air.
4. It triggers a Windows Firewall prompt on a broad scope, which for this project's
   target user is an alarming dead stop (see below).

Recommendation: **do not ship it in this design.** If it is ever wanted it is its own
design with its own review, and the artifact path should be exhausted first, because
it costs nothing and reaches the phone today.

## Accessibility

`docs/design/accessibility-blind-support.md` and
`docs/design/runtime-accessibility-polish.md` are first-class commitments, prompted
by a real blind Fractal owner. This console would be the project's **first
pre-rendered visual**, so the tension has to be named rather than skipped.

**The existing rule is not being dropped.** `runtime-accessibility-polish.md` forbids
**tools** from pre-rendering layout (ASCII grids, aligned tables), enforced by
`verify-no-visual-tables` in preflight. Its stated principle is that tools are the
data layer and the model is the presentation layer. The console is a **renderer**,
not a tool, so it does not violate that rule, and the rule keeps applying unchanged
to everything the console calls. Recorded explicitly so a later reader does not
conclude the commitment was quietly relaxed.

What the console owes:

1. **A text rendering that is the primary artifact, not an afterthought.** The
   generator emits the structured rig model; the graph and the text list are two
   renderings of it. The text rendering must answer the same questions the graph
   does: what connects to what, on which channel, and what fails a check. A musician
   who cannot see the graph must never be told to look at it.
2. **The graph is `role="img"` with a summarising `aria-label`,** and the
   accompanying list is the accessible content. Do not attempt node-by-node keyboard
   navigation inside an SVG or canvas graph; it is a large amount of work with a poor
   payoff against a well-built list.
3. **Full keyboard operation** for every control, visible focus, no hover-only
   affordance. The `validation` / `compatibility` / `audio` results must be reachable
   and readable in the list, since they are the actionable part.
4. **Colour is never the only channel.** The prototypes paint `checkAudioOutput`
   failures red; every such state must also carry text.
5. Respect `prefers-reduced-motion` and `prefers-color-scheme`.

**The text rendering is a ship gate for P1, not P4 polish.** A console that works
only visually would be the first surface in this project to exclude the person whose
feedback created the commitment.

## The non-technical user

The target user is a working guitarist, not a developer. Three things stand between
this design and that person:

- **There is no double-clickable entry point.** The installer bundle already ships
  `setup.cmd`, `verify-midi.cmd`, `update.cmd`, `uninstall.cmd`, and per-device
  `*-probe.cmd` / `*-verify.cmd`, with `.command` siblings for macOS
  (`fm3-verify.command`, `fm9-verify.command`, `axefx3-verify.command`). The missing
  artifact is obvious: **`rig-console.cmd` and `rig-console.command`**, which start
  the standalone host and open the default browser at the tokenised URL. Without it
  the feature is unreachable for the person it is for.
- **Windows Firewall.** A process calling `listen()` normally raises the Windows
  Defender Firewall prompt, and "Windows is asking me to allow something" is exactly
  where a guitarist stops. Binding explicitly to `127.0.0.1` rather than `0.0.0.0` is
  what usually avoids the prompt entirely, which makes the loopback bind a
  user-experience decision as well as a security one. **Verify on a clean Windows
  machine before ship.** If a prompt appears anyway, `instructions.txt` must say to
  click Cancel and that the console still works, because loopback needs no exception.
- **The empty state must not be a dead end.** The previous phasing put rig authoring
  last, so at ship time the first run would render nothing and offer no way forward,
  on top of the create-a-rig deadlock documented above. The re-cut phasing fixes the
  ordering and the create path fixes the deadlock; both are required before this
  ships to anyone but the maintainer.

## Phasing

Re-cut so something visible ships first, and so the only work genuinely blocked on
connection-arbiter Phase B is last.

**P1: the rig-view generator and the chat artifact.** Ships user-visible value with
no HTTP listener, no security surface, no dependency, and no browser test
infrastructure. The prototypes in `docs/_private/rig/prototypes/` render a
**superseded rig**: their embedded literal still says "RC-505 looper hub"
(`rig-app.html:147`, `rig-matrix.html:100`, `rig-view.html:122`,
`rig-view-data.json:2`) while the live manifest is "Fork B
(Circuit master, Quadra fan-out)" with 12 nodes, 20 edges and 2 bindings. There is no
generator; the data was pasted by hand. So the real work is building the generator
that never existed, wiring `toCytoscapeElements` and the checks through it, and
retiring the hand-pasted literal for good. The text rendering is a ship gate.

**P2: the read-only HTTP host.** `createMcpServer()` extraction, store root
resolution, the listener with the full security posture above, `open_rig_editor`, the
stdout guard and its gate, the asset copy line, the release-ZIP leg, and **the
per-endpoint read mutex**, because two clients reading concurrently is not safe
today. Serves P1's generator output. No writes.

**P3: songs, performances, assets and settings as data.** The L2/L3 schemas, the song
migration with its conflict list surfaced as a panel to resolve, the asset registry
seeded from the Circuit roster plus a live sweep, and the settings view with
`external` rendered as hand-confirmation rows. Read-only in the console. This is the
"very soon" half of the ask and it needs no write path at all.

**P4: rig editing via `edit_rig`.** The op expansion, the batch transaction, `.bak`
pruning, the create-a-rig path, the shared validation function, and SSE change
propagation. **Not gated on Phase B**, because `executeRigEdit` opens no port. Browser
test infrastructure arrives here.

**P5: standalone and the single-instance lock.** `rig-console.cmd` / `.command`, the
standalone entry, and a lockfile with a PID liveness check. Small, but a prerequisite
rather than a nicety: the target user will leave Desktop open, and the failure mode is
the one the arbiter doc already logs, writes reporting success into a dead port.

**P6: device-touching edits.** Genuinely gated on connection-arbiter Phase B (R1
per-endpoint serialization, R3 cancellation). The Release-device affordance and any
write that opens a port live here.

## Testing

The repo has no browser-test infrastructure, and this is its first UI. Do not add a
browser runner for P1 or P2, because what those phases need is testable without one:

- **The generator is a pure function.** Golden-test it in `packages/openrig`, which is
  already zero-dependency and golden-tested, against the real manifest shape.
- **The HTTP layer is testable with `fetch` against an in-process listener**, no
  browser. Assert: 401/403 without a bearer; `Host` header rejection; the exact CSP
  header string; that `/` and `/boot.js` are the **only** unauthenticated routes; that
  the asset cookie is never accepted on `/api/*`; and that the token in a fragment
  never reaches the server. That covers everything security-relevant.
- **A browser runner (Playwright) arrives at P4**, scoped to the wizard flows, when
  there is interactive editing to drive. Not before.

**`VISUAL_SIGNOFF.md` is required.** Global CLAUDE.md mandates it for any feature with
a visible UI surface, and this is the project's first. It lands at
`docs/sprints/sprint-NNN/rig-console/VISUAL_SIGNOFF.md`, written by QA, checked off by
the maintainer. The P1 checklist must include at minimum:

- The rendered graph matches the live manifest's node and edge counts.
- The text rendering answers the same questions as the graph, read aloud end to end.
- An unplugged device renders as declared-with-age, not as an error.
- A device held by a vendor editor renders as `port_held_elsewhere`, not as absent.
- The empty state offers a create action rather than a dead end.
- Keyboard-only operation reaches every control, with visible focus.

## Gates, and where each one runs

| Gate | Runs in | What it does |
|---|---|---|
| `verify-song-docs.ts` | `preflight` | **Written first.** Validates song JSON, and **produces the census**; no hand count goes in any doc |
| `verify-no-stdout-writes.ts` | `preflight` | Walks the server import graph, fails on `console.log` / `process.stdout.write`, allowlists the standalone entry |
| `verify-route-imports.ts` | `preflight` | The import allowlist for HTTP route modules. Replaces the previous draft's name-based "routes may only call executors" rule, which the scope section shows is not checkable by name |
| `verify-response-budget.ts` | `preflight` | New cases for every row-returning read added here |
| `verify-tools-list-budget.ts` | `preflight` | Re-freeze per the three-move budget plan, with a stated reason and a paid-for total |
| HTTP security tests | `npm test` | Auth, `Host`, CSP string, unauthenticated-route allowlist, cookie scoping |
| `verify-release-zip.ts` | **`release-gate`, not `preflight`** | New leg asserting `dist/web/index.html` survives into the extracted ZIP |

**Correcting the previous draft on that last row:** `verify-release-zip` cannot be in
`preflight`. It requires a built ZIP, and `build:installer` downloads a Node runtime.
It is already registered in `release-gate` in `package.json`, which runs `preflight`
first and then `build:installer && verify-release-zip`. The new leg goes into that
script and runs at release time. Without it the assets go missing exactly the way
`openrig` did in issue #15, resolving fine in dev via workspace hoisting and failing
only in the ZIP.

A gate that is not in `preflight` does not exist, **and a gate that cannot run in
`preflight` must say where it does run.** `verify-response-budget.ts` was written,
committed, and referenced by nothing for a full release cycle while it measured four
tools past the delivery cliff.

## Living docs and the decisions log

**This design amends a logged decision.** `ROADMAP.md:38` records "Local stdio
transport. The server runs on the user's machine next to the USB MIDI hardware. **No
network surface**, no cloud dependency, and the user's presets and gear stay local."
An HTTP listener is a network surface, even bound to loopback. That needs a decisions-log
entry recording the amendment and its bound (loopback only, lazy, opt-in, per-launch
token, no LAN bind), not a silent contradiction. Personal CLAUDE.md requires a
decisions-log entry for every non-obvious architectural choice; this document contains
several, and at minimum the REST-over-JSON-RPC reversal, the L2/L3 decision, the
mobile-goes-to-chat decision, and the dropped escape hatch each need one.

Docs to update in the same session as the change:

| Doc | Why |
|---|---|
| `ROADMAP.md` decisions log | The network-surface amendment, plus the four decisions above |
| `OPENRIG-UI-RESEARCH.md` | Superseded recommendation |
| `OPENRIG-SCHEMA.md` | L2/L3 move from "deferred sketch" to specified-and-being-built; the `edit_rig` op expansion touches §4 and §8 contracts |
| `docs/_private/rig/prototypes/README.md` | Direction, and the retirement of the hand-pasted literal |
| `docs/TOOLS.md` and the README tool count | `open_rig_editor` |
| `docs/ARCHITECTURE.md` | The second transport |
| `RIG-CONTROL-MATRIX.md`, `CURRENT-RIG.md` | Become generated views |
| `SONG-DOC-SCHEMA.md` | Becomes the generator's output contract |
| `README.md` | A user-facing feature with a new entry point |
| `docs/GETTING-STARTED.md` | How a user opens the console |
| `installer/instructions.txt` | `rig-console.cmd`, and the firewall note |
| `docs/SAFETY-FOR-MUSICIANS.md` | A second client can now touch the rig |
| `docs/contributing/SAFETY.md` | The canonical port-exclusivity statement; the Release-device affordance is new behaviour under it |
| `docs/PROJECT-VISION.md` | A first-party UI is a scope statement, not an implementation detail |
