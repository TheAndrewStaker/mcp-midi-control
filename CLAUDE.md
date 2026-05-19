# MCP MIDI Control — Claude Code Context

This file is read by Claude Code at the start of every session.

---

## Project Purpose
Build a local MCP server that lets Claude Desktop control a Fractal AM4
guitar amp modeler over USB/MIDI via natural language conversation.

## Current Phase
See **`docs/_private/STATE.md`** first. It names the current phase, the
single next action, and recent findings — start every session there.
`STATE.md` is kept current; the longer-lived reference docs are
`docs/PROJECT-VISION.md` and `docs/ARCHITECTURE.md`.

**Then run `npm run coverage-audit`.** It auto-snapshots Ghidra-catalog
coverage vs `params.ts` vs `verify-msg.ts` goldens, plus per-device
param counts. This is the antidote to handoff-list drift — STATE.md
"open follow-ups" go stale silently when later sessions close them
without ticking off the prior handoff; the audit reads current code
state directly, so it can't lie about what's done. Trust the audit
over any text claim that something is "open." Wired into preflight,
so it also runs at session-end.

Hardware tasks the founder owes (USB captures, round-trip tests on
the device, reference dumps) are queued per-device under
`docs/_private/`:
- **`HARDWARE-TASKS.md`** — index file pointing at per-device files.
- **`HARDWARE-TASKS-AXEFX2.md`** — Fractal Axe-Fx II XL+ tasks.
- **`HARDWARE-TASKS-AM4.md`** — Fractal AM4 tasks.
- **`HARDWARE-TASKS-HYDRASYNTH.md`** — ASM Hydrasynth Explorer tasks.
- **`HARDWARE-TASKS-ARCHIVE.md`** — closed tasks across all devices.

Each active file groups tasks as 📷 capture-required, 🎛️ desktop test,
or 💬 chat-only. Check the index at session start; if anything sits at
🔜 Pending in the relevant device's file, flag it before proceeding
with work that depends on it. When you identify a new hardware action
you can't perform yourself, append a `HW-NNN` entry to the right
device's file (NOT the index) with detailed steps the founder can
follow without re-reading the backlog.

`docs/_private/` is the founder's operational scratch (gitignored,
local-only): STATE, HARDWARE-TASKS, SESSIONS log, BACKLOG, HW-NNN test
plans, marketing drafts, internal data dumps. The committed `docs/`
files (`devices/<device>/SYSEX-MAP.md`, `BLOCK-PARAMS.md`,
`DECISIONS.md`, `ARCHITECTURE.md`, `*-research.md`, `capture-guides/`,
etc.) are the
OSS public good — protocol RE, architecture, decision log, research
artefacts — and DO ship in the repo.

> Phase 0 (feasibility) completed 2026-04-14. Phase 1 (protocol RE) is in
> progress — USB capture of AM4-Edit's outgoing traffic is the current
> blocker. See `_private/STATE.md` for exact next steps.

## Stack
- TypeScript / Node.js (**ES modules**, not CommonJS — `package.json` has
  `"type": "module"`, `tsconfig.json` uses `"module": "NodeNext"`)
- `tsx` is the TypeScript runner for scripts (not `ts-node`) — invoke via
  `npm run <script>` or `npx tsx <path>`
- node-midi for USB MIDI (native module — requires VS Build Tools on Windows
  dev machines; end users get the release ZIP with a bundled Node runtime
  and a prebuilt native binary, so they need neither)
- @modelcontextprotocol/sdk for MCP
- No framework. No ORM. Keep it simple.

## Target User
A working guitarist with a Claude account — not a developer. Every UX,
install, and distribution decision prioritizes the non-technical user.
The MVP ships as a Windows ZIP that bundles Node + a prebuilt native MIDI
binary and runs `setup.cmd` to register the server with Claude Desktop;
users never install Node, a C++ toolchain, or edit JSON. See
`docs/DECISIONS.md` for the full reasoning and rejected alternatives.

## Decision Log
Non-obvious architectural and library choices live in `docs/DECISIONS.md`.
Read it before proposing changes to: the MIDI library, module system,
TypeScript runner, distribution model, or wiki-scrape workflow.

## External References
Manuals, protocol specs, factory preset banks, and generated working docs
are catalogued in `docs/REFERENCES.md`. Check there first before searching
the web — most common questions are answered by one of the local PDFs
(all extracted to `.txt` for grep-ability).

**Per-device spec quick-references** (read these before WebFetching
or speculating about wire shapes):

- **AM4** → `docs/devices/am4/SYSEX-MAP.md`
- **Axe-Fx II** → `docs/devices/axe-fx-ii/SYSEX-MAP.md`
- **Axe-Fx III** → `docs/devices/axe-fx-iii/SYSEX-MAP.md` (covers Fractal v1.4 PDF; extracted text at `docs/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`) + `docs/devices/axe-fx-iii/preset-format-research.md` (community RE of preset .syx format; Forum thread #159885 archived at `docs/_private/fractal-forum-text.txt`)
- **Hydrasynth** → `docs/devices/hydrasynth/SYSEX-MAP.md` + `docs/devices/hydrasynth/OVERVIEW.md` for capability landscape; `docs/devices/hydrasynth/preset-format-research.md` for the `.hydra` / `.patch` file format probe; `docs/devices/hydrasynth/ICONIC-TONES.md` for the iconic-tones test portfolio

## Reverse-engineering workflow

Protocol RE is the bulk of this project's work. Following the workflow
below keeps sessions from re-treading dead ends and from publishing
claims that aren't byte-verified.

### Session start (read in this order)
1. **`docs/_private/STATE.md`** — current phase, single next action,
   recent breakthroughs. Always first.
2. **`npm run coverage-audit`** — code-state ground truth, not stale
   text (handled by the section above; restated here because RE
   sessions especially drift on this).
3. **`docs/fractal-protocol-decode-status.md`** — per-device decode
   status table. Last full sweep Session 82–83. Read before opening
   any new investigation so you know what's already named vs. open.
4. **`docs/_private/HARDWARE-TASKS-<DEVICE>.md`** — open captures the
   founder owes. If a 🔜 Pending task gates the work you're about to
   do, surface it instead of speculating around the missing data.
5. **Per-device wire map** — `docs/devices/<device>/SYSEX-MAP.md`
   (AM4, Axe-Fx II, Axe-Fx III, Hydrasynth). The authoritative
   byte-shape doc for the device you're working on.
6. **`docs/REFERENCES.md`** — only the section for your device. Don't
   WebFetch for a manual we already have extracted to `.txt`.

### Capture methods (in order of preference)
- **Ghidra dispatcher mining** — canonical for paramId ↔ name catalog
  discovery (99% wire-accuracy verified Session 82–83). Three-tier
  technique with symbol-table walk, byte-pattern + xref, and
  instruction-walk fallback. See `docs/ghidra-mining-workflow.md`.
- **JUCE BinaryData extraction** — 5-minute label discovery from
  editor binaries via the embedded ZIP. 1,299 AM4-Edit labels and
  10,250 AxeEdit III labels recovered this way. See
  `docs/capture-guides/juce-binarydata-extraction.md`.
- **Directed probe scripts** (`scripts/probe*.ts`) — cheap, scriptable,
  default for unknown wire envelopes. One hypothesis per probe; keep
  the probe read-only unless explicitly designed to write.
- **Passive capture** — open the device MIDI input with no editor.
  Axe-Fx II broadcasts state continuously; AM4 is silent and needs an
  active query loop. See `docs/fractal-broadcast-vs-poll-research.md`.
- **USBPcap + Wireshark** — captures both directions at the USB-class
  layer when the editor → device direction is needed. The maintainer's
  default for editor-write decode. See `CONTRIBUTING.md` for the
  step-by-step.

### Methods that have failed — don't re-attempt
- **WinDbg trap-after-launch** — stack-frame too shallow, label written
  before trap arms. Session 46. Use JUCE BinaryData instead.
- **Positional XML → cache-record binding** — XML `parameterName` is a
  per-variant UI symbol, not a unique wire key. 20–40% inversions
  across variants. Session 46 cont 2.
- **Virtual MIDI driver bridges** (any class-compliant virtual port
  trying to interpose between editor and device) — Fractal editors
  filter these out by driver class via `midiInGetDevCaps` /
  `midiOutGetDevCaps`. Intentional filtering, not a bug. Use the
  USBPcap + Wireshark path instead.
- **Byte-literal full SysEx envelope (`F0 00 01 74 10`) search in
  Ghidra** — model byte loaded at runtime from a device-handle struct.
  Search the 4-byte `F0 00 01 74` instead and inspect the next
  instruction for the model load. Session 82.
- **Param table as flat `-1`-terminated `int` array** — actually a
  16-byte `ParamDescriptor` (paramId at +0, name pointer at +8).
  Stride-by-4 produces garbage. Session 82.
- **AM4 `0x77` preset-save envelope assumed portable to Axe-Fx II** —
  inert on II XL+ (Session 94). Each device family gets its own
  envelope decode; do not extrapolate across model bytes.

### Scientific discipline (rules forged by real bugs)
- **Every new `pidHigh` in `params.ts` requires a `verify-msg.ts`
  golden built from captured bytes.** Septet-encoded 14-bit fields are
  easy to misread as little-endian (Session 08). The golden is the
  only mechanical guard against the class.
- **Front panel + `get_param` echo are ground truth.** AxeEdit and
  AM4-Edit cache stale UI state (HW-086, freshly-placed Volume block
  showed 10.00 while device held 0.00). On disagreement, the editor
  is wrong.
- **Read before write.** Every device tool gates writes behind a
  fingerprint read. Don't bypass this in new probe scripts unless
  they're explicitly read-only (`scripts/probe.ts` is read-only
  forever, by policy).
- **One capture per hypothesis.** When isolating an unknown field,
  change exactly one input on the editor or device. Two simultaneous
  edits produce ambiguous diff bytes and cost days.
- **Variant-dependent binding.** The same `parameterName` maps to
  different wire IDs across effect variants (e.g. `DISTORT_TONE` is
  `drive.id=12` in some variants, `drive.id=23` in others). XML alone
  is never sufficient — combine with a capture or the Ghidra paramId
  table.
- **Septet-encode every 14-bit field, not just `pidLow`.** `action`,
  effect IDs, preset numbers, tempo BPM, location bytes — all 7-bit-
  pair encoded. Forgetting once = wire mismatch and a confused
  device.
- **Cite captures with file path + byte offset** in `SYSEX-MAP*.md`
  so future agents can re-verify. "Confirmed via capture" without a
  reference is hearsay.

### Negative findings are valuable
When a probe rules a hypothesis OUT (e.g. Session 94 ruling that AM4's
`0x77` envelope doesn't work on Axe-Fx II), commit the result to
`docs/SYSEX-MAP-*.md` or `docs/_private/SESSIONS.md` with the search
terms a future agent would use ("AM4 0x77 portable to II — no"). This
saves a session every time someone re-asks the same question.

## AM4 SysEx — quick facts

Full envelope, checksum, function-byte table, and capture-cited
decodes live in **`docs/devices/am4/SYSEX-MAP.md`**. The basics, here:

- **Model byte:** `0x15`. Envelope: `F0 00 01 74 15 [fn] [...] [cksum] F7`.
- **Checksum:** `bytes.reduce((a,b)=>a^b,0) & 0x7F` over `F0`..last payload byte.
- **Preset locations:** A01–Z04 (104 total). Use `parseLocationCode` /
  `formatLocationCode` from `src/protocol/locations.ts` — never hardcode.

## Fractal terminology (use these exact words)

Fractal's docs use specific words for AM4 concepts. Our code and user-
facing strings MUST match, because one of the words — "slot" — has
opposite meanings in casual use:

| Term | What it means |
|---|---|
| **Bank** | A letter A–Z grouping 4 preset locations |
| **Preset** | The stored patch (blocks + params + scenes + name) |
| **Location** | Where a preset is stored. "A01" through "Z04", 104 total. NOT called a "slot" |
| **Slot** (or **effect slot**) | A position 1–4 in a preset's signal chain. The slot is the container; the block is what fills it |
| **Block** | The effect occupying a slot (amp, drive, delay, reverb, chorus, …) |
| **Scene** | One of 4 performance variations within a preset (bypass + channel state, not a copy of the blocks themselves) |
| **Channel** | Per-block A/B/C/D variation of that block's settings |

Anti-patterns to avoid:
- "preset slot" when you mean "preset location" (wrong — preset slots
  don't exist; presets occupy *locations*, not slots)
- "save to slot N" in user-facing text (wrong — "save to location N")
- "effect in slot 3" is correct; "effect in position 3" is also OK but
  "slot" matches Fractal's wording

## Safe-edit workflow (cross-device contract)

Every MCP tool that navigates or persists must enforce three gates,
applied consistently across AM4, Axe-Fx II, Hydrasynth, and any future
device:

1. **Buffer-dirty gate** (`on_active_preset_edited`). Before navigating
   away from the active preset, check `isDirty(device)`. If dirty and
   the caller didn't pass `'discard'` or `'save_active_first'`, refuse
   with a structured warning naming the active preset. Reference impl:
   `src/fractal/axe-fx-ii/tools/shared.ts:guardActiveBufferOrSave`.

2. **Save-authorization gate** (`save_authorized`). Tools that apply
   AND persist in one call (`*_apply_preset_at`, `hydra_apply_patch`
   with target slot) default to `save_authorized: false` and refuse
   unless the caller passed `true`. The agent should only pass `true`
   when the user used save-intent language (save / store / keep /
   put-on / persist).

3. **Multi-preset overwrite gate.** Multi-preset tools (`*_apply_setlist`)
   do NOT need `save_authorized` (multi-preset intent implies save),
   but MUST pre-flight scan the target range and surface what would be
   overwritten before writing.

Full contract + per-device implementation status in
`docs/SAFE-EDIT-WORKFLOW.md`. When adding a new device, port these
three gates before considering the device "production-ready."

Per-device fallback rules when a device's MIDI surface doesn't expose
a dirty-state signal:

- **Hydrasynth has no MIDI-exposed dirty signal.** Hydra tools omit
  `on_active_preset_edited` entirely. The `save_authorized` gate still
  applies. Document the limitation in tool descriptions so the agent
  asks the user before navigating instead of relying on the API gate.
- **AM4 has no device-sourced dirty signal.** HW-107 closed Session 74
  as a negative finding: AM4 emits zero unsolicited MIDI on front-panel
  edits, so there is no push signal to listen for. The dirty gate
  instead polls the working buffer on the navigation seam: dump the
  buffer (HW-045), hash it, compare to the last cached "clean"
  fingerprint for the active location. Match → proceed; mismatch →
  refuse / save-first / discard. Cache baselines are refreshed after
  every clean transition (post-switch, post-save). One source of truth,
  catches our writes + front-panel edits + parallel-editor edits in
  one ~200 ms round-trip per navigation. See `bufferFingerprint.ts` +
  `tools/safeEdit.ts`.

## Tool surface architecture

**Two surfaces ship in parallel through v0.1.0.**

1. **Unified surface** (`src/protocol/generic/tools.ts`) — port-
   dispatched, device-agnostic. `set_param(port, block, name, value)`,
   `get_param`, `apply_preset`, `switch_preset`, `save_preset`,
   `switch_scene`, `set_block`, `set_bypass`, `set_params`,
   `get_params`, `list_params`, `describe_device`, `rename`,
   `scan_locations`, `lookup_lineage`. 14 tools cover every registered
   device. Adding a new device means writing a schema descriptor
   (`src/<vendor>/<device>/descriptor.ts`) + wire adapter; no new
   tools. Dispatcher lives in `src/protocol/generic/dispatcher.ts`,
   types in `src/protocol/generic/types.ts`.

2. **Device-namespaced surface** (`am4_*`, `axefx2_*`, `hydra_*`) —
   first-generation pattern. Kept in parallel through v0.1 because
   the long tool descriptions carry device-specific behavioral
   guidance (AM4: relative-change discipline, tempo-sync model,
   channel/scene semantics, enum-naming conventions, reverb.type
   format) the LLM relies on during tone-building. Slated for removal
   in v0.3 once that guidance migrates into per-device
   `describe_device` responses.

**When adding a new tool, prefer the unified surface.** New device-
namespaced tools are technical debt — the unified surface is what
v0.3+ ships exclusively. If a new capability doesn't fit the unified
contract, design the contract change first (extend `DeviceWriter` /
`DeviceReader` / capabilities), then register the unified tool.

## Tool API conventions

**Display-first.** Every MCP tool surface — for every device, present
and future — accepts and returns **display units** (what a musician
reads on the front panel: `0..10` knob, dB, ms, ratio `4:1`, enum
string `'Plexi 100W High'`). Wire-format details (septet-encoded
14-bit ints, packed-float bytes, `value × scale` fixed-point) are
internal and never leak through tool I/O. Error messages use display
shape too: `"amp.gain out of range [0..10]: 12.5"`, never `"wire value
0x4800 invalid"`.

Display ↔ wire coercion happens once at the tool boundary via
`resolveValue` / `resolveEnumValue` (`src/server/shared/paramHelpers.ts`,
`src/fractal/am4/params.ts`). Everything below the tool layer takes
wire and is type-checked against it. Rationale + rejected
alternatives: `docs/DECISIONS.md` (2026-04-28 entry).

## Performance budget

MCP tool calls are part of a conversation. Users tolerate short waits
during overt batch actions, but individual tool calls should feel
instantaneous.

- **Ideal:** < 200 ms per tool call (single `set_param`, `set_block_
  type`, etc.). SysEx round-trips against the AM4 land in 30–60 ms,
  with a 300 ms ack window.
- **Acceptable:** < 1 s for tools that make 2–5 wire transactions
  (`apply_preset` with a handful of blocks and params).
- **Requires explicit progress:** anything > 1 s must tell the user
  upfront ("This will probe 16 preset locations, ~1 second"). Never
  make the user wait silently.
- **Avoid altogether:** designs that require > 5 s of wire work in a
  single conversational turn. Either cache, batch into a dedicated
  command, or design around the probe.

When writing new tool specs, estimate the wire-round-trip count
up front. SysEx is serial — N reads ≈ N × 50 ms minimum. If the math
says > 1 s, redesign before implementing.

## Key Constraints
- Windows ThinkPad. Use Windows paths where relevant.
- node-midi requires node-gyp / native build tools on Windows.
  If build fails, try: `npm install --global windows-build-tools`
- AM4 USB driver must be installed before any MIDI communication.
  Driver: https://www.fractalaudio.com/am4-downloads/
- Never write to a preset slot without reading it first.
- Always confirm before overwriting non-empty, non-factory slots.

## File Conventions
- All .syx binary samples + USB captures + decoded analysis outputs go
  in `samples/` — **the entire directory is gitignored**. Nothing in
  `samples/` is committed; treat it as local debug scratch.
- All reverse-engineering notes go in docs/devices/am4/SYSEX-MAP.md
- All block parameter tables go in docs/BLOCK-PARAMS.md
- Sniffing session logs go in docs/_private/SESSIONS.md
- Tests that require hardware are in tests/integration/ and skipped in CI

## Testing and sign-off

- **`npm run preflight`** is the single command to run before every
  commit. It runs `tsc --noEmit` and then `npm test`, which chains the
  three protocol-layer goldens:
  - `verify-pack` — 10-sample pack/unpack round-trip.
  - `verify-msg` — built messages vs. captured wire bytes (byte-exact,
    including checksum).
  - `verify-transpile` — IR → command sequence goldens.
- `npm test` alone runs just the goldens; handy for iterating on the
  protocol layer without waiting for the typecheck.
- `npm run test:jest` is reserved for future Jest-based unit tests (the
  scaffolding exists; there are no tests yet).
- **When adding a new pidHigh to `params.ts`, add a matching case to
  `verify-msg.ts` built from captured bytes.** That is the only guard
  against misreading septet-encoded pidHighs as little-endian bytes
  (the class of bug that hit Session 08 — see SYSEX-MAP.md §6a note).

## Verification sources of truth

For any test that needs to confirm "what does the device actually hold
right now," trust these in order:

1. **Front panel display** on the hardware itself. Ground truth.
2. **`axefx2_get_param` / `am4_get_param` response**. The device echoes
   its own display label in the response payload, so this is the wire-
   level truth as the device understands it.
3. **AxeEdit / AM4-Edit panel display.** Useful but **not authoritative**
   — editor apps cache UI state (HW-086 example: freshly-placed
   Volume/Pan block reads `10.00` in AxeEdit while device holds wire
   `0`). If front panel or `get_param` disagrees with the editor, the
   editor is wrong. Reload-the-preset in the editor forces a fresh
   read.

When writing a HW-NNN task that involves verifying behavior, name which
source the founder should read. Don't accept a "checked the editor, looks
right" report when the question is "did the write actually land."

## Rebuilding for Claude Desktop testing

Claude Desktop launches this MCP server from the **compiled
workspace build** (`node packages/server-all/dist/server/index.js`
per `claude_desktop_config.json`), not the TypeScript source. The
dist is loaded into Node once when the child process spawns;
overwriting source files on disk does NOT reach the live MCP server.

**If the founder will test your changes via a Claude Desktop conversation
(any `*_get_*` / `*_set_*` / `*_apply_*` / etc. MCP tool call), you MUST
do all three of these or the test will run against stale code:**

1. **`npm run preflight`** — per-package typecheck + goldens pass.
2. **`npm run build`** — rebuilds every package in dependency order
   (`@mcp-midi-control/core` → `@mcp-midi-control/am4|axe-fx-ii|
   hydrasynth` → `@mcp-midi-control/server-all`) and copies
   lineage JSON into `packages/core/dist/fractal-shared/lineage/`.
3. **Tell the founder to fully quit and relaunch Claude Desktop.** Just
   closing the window keeps the MCP server child alive in the tray — it
   has to be a full quit. The relaunch respawns the child from the new
   dist.

If you only changed `scripts/` (run via `tsx`, never dist), `docs/`,
or `samples/` — preflight is enough; no rebuild needed.

**Default at session end:** if you've edited any TypeScript under
`src/` and the next user step is testing in Claude Desktop, run
`npm run build` and surface the relaunch reminder in your wrap-up.

## Living documentation — update before declaring a session complete

Certain docs must stay current because future sessions (human and
Claude) consult them as source of truth. When the underlying thing
changes, the doc must change in the same session — not as a followup.
Cheaper than discovering drift later.

| Doc | Update when… |
|---|---|
| `docs/_private/STATE.md` | A substantive session happens. Always — it's the session-start orientation doc. Update "single next action" and any relevant "recent breakthroughs" entry. |
| `docs/_private/PROMPT-COVERAGE.md` | A new MCP tool ships, a protocol decode lands, or founder testing surfaces a new user prompt pattern. Flip ⚠ → ✅ when the blocker clears; flip ❌ → ⚠ when a research item gets a concrete decode plan; add new rows for unanticipated prompts. |
| `docs/_private/HARDWARE-TASKS.md` | A HW-NNN item completes (mark ✅ + capture outcome), or a new hardware action is identified that Claude can't perform alone (append HW-NNN with step-by-step instructions). |
| `docs/_private/04-BACKLOG.md` | A new backlog item is identified, an existing item ships / re-scopes / is superseded, or a cross-reference between items is worth recording. |
| `docs/devices/<device>/SYSEX-MAP.md` | A new protocol decode is confirmed against captured bytes. Include the concrete capture reference and byte-exact example. (Public — protocol RE is the OSS public good.) |
| `docs/_private/SESSIONS.md` | A session produces a substantive finding worth a chronological entry (decodes, major tool changes, hardware-verified behavior). STATE.md is the summary; SESSIONS.md is the log. |
| `docs/DECISIONS.md` | A non-obvious architectural or library choice is made. (Public — committed for OSS contributors.) |

**Session-wrap check.** Before declaring work complete, walk the table
above and update whichever rows apply to what changed. A one-line
reply at session end naming which docs were updated helps the founder
verify nothing was missed.

## Do Not
- Do not use AM4-Edit as a dependency or requirement
- Do not hardcode preset-location values — always use the A01–Z04 naming
- Do not skip the safety read before any write operation
- Do not guess parameter names — verify against AM4 manual or sniffed data
- Do not issue any preset-store / save-to-location SysEx command from
  `scripts/probe.ts`. Probe is read-only forever.
- Do not auto-save after `apply_preset` — saves require an explicit
  save phrase from the user ("save this", "put it on M03", "keep it").
  `apply_preset` is reversible (switching presets discards the working
  buffer); save is not.
- Before overwriting a non-empty preset location, confirm with the
  user — read the current contents, surface what's there, and ask
  before clobbering. **Z04 remains the conventional scratch location**
  for try-it-out work; the historical hard-gate to Z04 was lifted
  Session 49 once HW-064 confirmed save-to-inactive-location is a
  real workflow (founder builds multiple presets per session by
  saving to different locations from the same working buffer).

