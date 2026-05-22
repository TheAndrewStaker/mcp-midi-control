# MCP MIDI Control, Claude Code Context

Read by Claude Code at the start of every session.

---

## Project Purpose
Build a local MCP server that lets Claude Desktop control a Fractal AM4
guitar amp modeler over USB/MIDI via natural language conversation.

## Current Phase
**Status:** v0.1.0 pre-release. AM4 + Hydrasynth functional; Axe-Fx II + III in beta. See ROADMAP.md.

Always start a session by reading `docs/_private/STATE.md` (and the
per-device shard `STATE-AM4.md` / `STATE-AXEFX2.md` / `STATE-AXEFX3.md`
/ `STATE-HYDRA.md` when the work targets one device). STATE names the
current phase, the single next action, and recent findings. Cross-
device sessions stay in main STATE.md.

Hardware tasks the founder owes are queued per device under
`docs/_private/HARDWARE-TASKS-<DEVICE>.md`, indexed by
`HARDWARE-TASKS.md`. Closed tasks live in `HARDWARE-TASKS-ARCHIVE.md`.
At session start, scan the relevant device's file; if a Pending task
gates the work you are about to do, flag it before proceeding.

`docs/_private/` is the founder's operational scratch (gitignored): STATE, HARDWARE-TASKS, SESSIONS log, BACKLOG, DECISIONS log, HW-NNN test plans, marketing drafts. Committed `docs/` files cover MCP-server architecture and contract (ARCHITECTURE.md, BLOCK-PARAMS.md, PROJECT-VISION.md, SAFE-EDIT-WORKFLOW.md, etc.). Protocol RE (per-device SYSEX-MAP, capture guides, Ghidra scripts, encoding cookbook) lives in the [`fractal-midi`](https://github.com/TheAndrewStaker/fractal-midi) codec repo.

## Stack
- TypeScript / Node.js (**ES modules**, not CommonJS: `package.json` has `"type": "module"`, `tsconfig.json` uses `"module": "NodeNext"`)
- `tsx` is the TypeScript runner for scripts (not `ts-node`); invoke via `npm run <script>` or `npx tsx <path>`
- node-midi for USB MIDI (native module; requires VS Build Tools on Windows dev machines. End users get a release ZIP with bundled Node + prebuilt native binary, no toolchain needed)
- @modelcontextprotocol/sdk for MCP
- No framework. No ORM. Keep it simple.

## Two-repo layout

This project consumes a SEPARATE npm package, `fractal-midi`, that owns all wire codec logic. **The codec is NOT in this repo.**

| Lives in | What |
|---|---|
| **`C:/dev/fractal-midi/`** (separate git repo, published as `fractal-midi@0.1.0-alpha.0`) | Pure-TypeScript codec: `src/{shared,am4,axe-fx-ii,axe-fx-iii}/`. Builders, parsers, param dictionaries, block tables, calibration, fractal-shared lineage. NO MIDI transport, NO MCP server. |
| **`C:/dev/mcp-midi-tools/`** (this repo) | MCP server, descriptors, dispatcher, agent guidance, tool registrations. Imports from `fractal-midi/*`. Consumes the codec; does not define it. |

**Workflow for a codec change:** edit in `C:/dev/fractal-midi/`, run that repo's `npm test`, `npm pack`, then `npm install /path/to/.tgz` here. For quick iteration use `npm link`; reset to a published version before committing.

Protocol docs (`SYSEX-MAP.md`, opcode tables, capture guides, Ghidra mining scripts, encoding cookbook) all live in [`fractal-midi/docs/`](https://github.com/TheAndrewStaker/fractal-midi/tree/main/docs); see per-device pointers in "External References" below.

## Target User
A working guitarist with a Claude account, not a developer. Every UX, install, and distribution decision prioritizes the non-technical user. The MVP ships as a Windows ZIP that bundles Node + a prebuilt native MIDI binary and runs `setup.cmd` to register the server with Claude Desktop; users never install Node, a C++ toolchain, or edit JSON. See `docs/_private/DECISIONS.md` for the full reasoning.

## Decision Log
Non-obvious architectural and library choices live in `docs/_private/DECISIONS.md`. Read it before proposing changes to the MIDI library, module system, TypeScript runner, distribution model, or wiki-scrape workflow.

## External References
Manuals, protocol specs, factory preset banks, and generated working docs are catalogued in `docs/REFERENCES.md`. Check there before searching the web; most common questions are answered by a local PDF (all extracted to `.txt` for grep-ability).

Per-device spec quick-references (read these before WebFetching or speculating about wire shapes):

- **AM4**: [`fractal-midi/docs/devices/am4/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/am4/SYSEX-MAP.md) + [`param-rename-audit.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/am4/param-rename-audit.md)
- **Axe-Fx II**: [`fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/SYSEX-MAP.md) + [`axeedit-opcode-table.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/axeedit-opcode-table.md) (94 wire opcodes)
- **Axe-Fx III**: [`fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-iii/SYSEX-MAP.md) + [`preset-format-research.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-iii/preset-format-research.md)
- **Hydrasynth**: [`fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/hydrasynth/SYSEX-MAP.md) + [`OVERVIEW.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/hydrasynth/OVERVIEW.md); `docs/_private/HYDRASYNTH-ICONIC-TONES.md` for the test portfolio

## Reverse-engineering workflow

**Before any decode, capture analysis, or new probe script, read [`docs/RE-WORKFLOW.md`](docs/RE-WORKFLOW.md) end-to-end.** It contains the session-start reading order, capture-method preference, scientific discipline rules, 5-check capability-application pre-flight, cross-device transfer reflex, and same-session artifact registration. Skipping it has cost multi-session dead-ends (Session 103: 21-capture plan; Session 46: WinDbg trap that cannot fire).

The discipline rules in RE-WORKFLOW.md exist because each one closes a specific class of bug that has hit this project at least once. They are not theoretical.

### Always-loaded rules (high-firing, contradict habit)

- **Front panel + `get_param` echo are ground truth.** AxeEdit and AM4-Edit cache stale UI state (HW-086: a freshly-placed Volume block showed 10.00 in the editor while the device held 0.00). On disagreement, the editor is wrong.
- **Read before write.** Every device tool gates writes behind a fingerprint read. Do not bypass this in new probe scripts unless they are explicitly read-only (`scripts/probe.ts` is read-only forever, by policy).
- **Septet-encode every 14-bit field, not just `pidLow`.** action codes, effect IDs, preset numbers, tempo BPM, location bytes; all 7-bit-pair encoded. Forgetting once produces wire mismatch.
- **One capture per hypothesis.** Two simultaneous edits produce ambiguous diff bytes and cost days.

### Methods ruled out, do NOT re-attempt

Each entry has full evidence and scope in the cookbook. Grep before re-attempting:

- **WinDbg trap-after-launch** on editor labels (Session 46). Use JUCE BinaryData. See `cookbook/_negative/windbg-trap-after-launch.md`.
- **Positional XML to wire-id binding** (Session 46 cont 2). 20-40% inversion rate. See `cookbook/_negative/positional-xml-cache-binding.md`.
- **Virtual MIDI driver bridges** as editor interposers. Fractal editors filter these by driver class. Use USBPcap + Wireshark. See `cookbook/_negative/virtual-midi-bridge-interposition.md`.
- **Byte-literal 5-byte SysEx envelope search in Ghidra** (Session 82). Model byte loaded at runtime; search the 4-byte prefix `F0 00 01 74` and inspect the next instruction. See `cookbook/_negative/byte-literal-envelope-ghidra-search.md`.
- **Param table as flat `-1`-terminated `int` array** (Session 82, confirmed Session 94). Actual layout is 16-byte `ParamDescriptor`. See `cookbook/_negative/flat-int-stride4-param-table.md` and positive [[param-descriptor-16byte]].
- **AM4-shaped `0x77` envelope as save attempt on II** (HW-094, Session 94). Inert. Note: II uses `0x77/0x78/0x79` for its OWN preset-dump envelope, a different shape. See `cookbook/_negative/am4-77-as-save-on-ii.md`.
- **Flat-byte-offset diff of II `0x77/0x78/0x79` preset binary** (rejected Session 103). Body is Huffman-compressed; offsets unstable. The atomic read primitive is **`fn=0x1F` SYSEX_GET_ALL_PARAMS** (not the preset-binary envelope). See `cookbook/_negative/ii-preset-binary-flat-byte-diff.md` and positive [[ii-fn1f-atomic-read]].
- **III block-name string-cascade** does NOT transfer from II (Session 117 cont 2). III preset serialization is descriptor-table-driven, not strcmp-cascade. See `cookbook/_negative/iii-block-name-string-cascade.md`.

### Positive counter-entry: Ghidra IS viable for II

The historical "skip Ghidra for II" guidance was formally overturned 2026-05-17. `SeekParamTablesII.java` direct-pattern-scan recovers 1,113 `(paramId, symbol)` entries at 99% indexed-symbol coverage on the 32-bit AxeEdit II binary. The old guidance closed only the dispatcher-xref technique; direct pattern scan and string-walk both work. Don't re-inherit the dead rule.

### Param-coverage audit reflex

When grepping `fractal-midi/src/<device>/params.ts` to confirm a param is registered, the registered name often differs from the Blocks Guide / Owner's Manual spelling (renamed for AM4-Edit / front-panel UI-label match). Re-grep using the device's short canonical spellings (`_sw`, `_fb`, `preamp_*`, `nfb_*`, `in_*`) before opening a "missing param" investigation. Full known-divergence table: [`fractal-midi/docs/devices/am4/param-rename-audit.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/am4/param-rename-audit.md).

## AM4 SysEx, quick facts

Full envelope, checksum, function-byte table, and capture-cited decodes live in **[`fractal-midi/docs/devices/am4/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/am4/SYSEX-MAP.md)**. The basics:

- **Model byte:** `0x15`. Envelope: `F0 00 01 74 15 [fn] [...] [cksum] F7`.
- **Checksum:** `bytes.reduce((a,b)=>a^b,0) & 0x7F` over `F0`..last payload byte.
- **Preset locations:** A01-Z04 (104 total). Use `parseLocationCode` / `formatLocationCode` from `src/protocol/locations.ts`; never hardcode.

## Fractal terminology (use these exact words)

Fractal's docs use specific words for AM4 concepts. Our code and user-facing strings MUST match, because one of the words ("slot") has opposite meanings in casual use:

| Term | What it means |
|---|---|
| **Bank** | A letter A-Z grouping 4 preset locations |
| **Preset** | The stored patch (blocks + params + scenes + name) |
| **Location** | Where a preset is stored: "A01" through "Z04", 104 total. NOT called a "slot" |
| **Slot** (or **effect slot**) | A position 1-4 in a preset's signal chain. The slot is the container; the block is what fills it |
| **Block** | The effect occupying a slot (amp, drive, delay, reverb, chorus, ...) |
| **Scene** | One of 4 performance variations within a preset (bypass + channel state, not a copy of the blocks) |
| **Channel** | Per-block A/B/C/D variation of that block's settings (AM4); X/Y on Axe-Fx II |

Anti-patterns: "preset slot" (wrong, presets occupy *locations*); "save to slot N" in user-facing text (wrong, "save to location N").

## Safe-edit workflow (cross-device contract)

Every MCP tool that navigates or persists enforces three gates across AM4, Axe-Fx II, Hydrasynth, and any future device:

1. **Buffer-dirty gate** (`on_active_preset_edited`). Check `isDirty(device)` before navigating. If dirty and the caller did not pass `'discard'` or `'save_active_first'`, refuse with a structured warning.
2. **Save-authorization gate** (`save_authorized`). Tools that apply AND persist in one call default to `false` and refuse unless the agent passes `true` (only when the user used save-intent language).
3. **Multi-preset overwrite gate.** Multi-preset tools pre-flight scan the target range and surface what would be overwritten.

Full contract, per-device implementation status, and fallback rules (Hydrasynth has no MIDI dirty signal; AM4 uses working-buffer fingerprint polling) in **[`docs/SAFE-EDIT-WORKFLOW.md`](docs/SAFE-EDIT-WORKFLOW.md)**. Port these gates before considering a new device production-ready.

## Tool surface architecture

**Two surfaces ship in parallel through v0.1.0.**

1. **Unified surface** (`src/protocol/generic/tools.ts`): port-dispatched, device-agnostic. 14 tools (`set_param`, `get_param`, `apply_preset`, `switch_preset`, `save_preset`, `switch_scene`, `set_block`, `set_bypass`, `set_params`, `get_params`, `list_params`, `describe_device`, `rename`, `scan_locations`, `lookup_lineage`) cover every registered device. Adding a new device means writing a schema descriptor + wire adapter; no new tools. Dispatcher: `src/protocol/generic/dispatcher.ts`.
2. **Device-namespaced surface** (`am4_*`, `axefx2_*`, `hydra_*`): first-generation pattern. Kept in parallel because the long tool descriptions carry device-specific behavioral guidance the LLM relies on during tone-building. Slated for removal in v0.3 once the guidance migrates into per-device `describe_device` responses.

**When adding a new tool, prefer the unified surface.** New device-namespaced tools are technical debt. If a new capability does not fit, design the contract change first (extend `DeviceWriter` / `DeviceReader` / capabilities), then register the unified tool.

**Before adding or substantially modifying a tool, read [`docs/TOOL-AUTHORING-GUIDE.md`](docs/TOOL-AUTHORING-GUIDE.md).** It captures the patterns from senior MCP design reviews and names the common pitfalls (wire-ack-not-audible, type-gated silent no-op, opcode-not-portable-across-model-bytes) the codebase has burned cycles relearning.

## Tool API conventions

**Display-first.** Every MCP tool surface (every device, present and future) accepts and returns **display units**: what a musician reads on the front panel (0..10 knob, dB, ms, ratio `4:1`, enum string `'Plexi 100W High'`). Wire-format details (septet-encoded 14-bit ints, packed-float bytes, fixed-point scaling) are internal and never leak through tool I/O. Error messages use display shape too: `"amp.gain out of range [0..10]: 12.5"`, never `"wire value 0x4800 invalid"`.

Display to wire coercion happens once at the tool boundary via `resolveValue` / `resolveEnumValue`. Everything below the tool layer takes wire and is type-checked against it. Rationale: `docs/_private/DECISIONS.md` (2026-04-28).

## Performance budget

MCP tool calls are part of a conversation. Users tolerate short waits during overt batch actions; individual tool calls should feel instantaneous.

- **Ideal:** < 200 ms per tool call (single `set_param`, `set_block_type`). SysEx round-trips land in 30-60 ms with a 300 ms ack window.
- **Acceptable:** < 1 s for tools that make 2-5 wire transactions (e.g. `apply_preset` with a handful of blocks).
- **Requires explicit progress:** anything > 1 s tells the user upfront ("This will probe 16 preset locations, ~1 second"). Never make the user wait silently.
- **Avoid altogether:** > 5 s of wire work in a single conversational turn. Cache, batch into a dedicated command, or design around the probe.

Estimate wire-round-trip count up front. SysEx is serial: N reads ≈ N × 50 ms minimum. If the math says > 1 s, redesign before implementing.

## Key Constraints
- Windows ThinkPad. Use Windows paths.
- node-midi requires node-gyp / native build tools on Windows. If build fails, try `npm install --global windows-build-tools`.
- AM4 USB driver must be installed before any MIDI communication. Driver: https://www.fractalaudio.com/am4-downloads/
- Never write to a preset location without reading it first.
- Always confirm before overwriting non-empty, non-factory locations.

## File Conventions
- All `.syx` binary samples + USB captures + decoded analysis go in `samples/`; **the entire directory is gitignored**. Treat as local debug scratch.
- Reverse-engineering notes live in [`fractal-midi/docs/devices/<device>/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/tree/main/docs/devices) (codec-domain).
- Block parameter tables live in `docs/BLOCK-PARAMS.md` (MCP contract docs).
- Sniffing session logs go in `docs/_private/SESSIONS.md`.
- Tests that require hardware are in `tests/integration/` and skipped in CI.

## Testing and sign-off

- **`npm run preflight`** is the single command to run before every commit. Runs `tsc --noEmit`, then `npm test` (which chains `verify-pack`, `verify-msg`, `verify-transpile`, `cookbook-verify`).
- `npm test` alone runs just the goldens; handy for iterating on the protocol layer without waiting for typecheck.
- **When adding a new pidHigh to `params.ts`, add a matching case to `verify-msg.ts` built from captured bytes.** That is the only mechanical guard against misreading septet-encoded pidHighs as little-endian bytes (the Session 08 bug class).

**Failing tests get fixed, not annotated.** See global CLAUDE.md for the principle. Project-specific: when `npm run preflight`, `launch-verify`, `live-regression`, or `agent-sweep` fails, investigate root cause; update assertions only when production behavior changed deliberately (e.g. BK-059 dispatcher shape); never `skip` with a "fix later" comment; if you cannot fix in this session, escalate before declaring work complete.

**Adding new tests** alongside new features:
- New unified tool → case in `scripts/launch-verification.ts`
- New device capability requiring hardware → case in `scripts/live-regression.ts` (self-restoring mutations only)
- New agent-facing tool description or alias → case in `scripts/agent-regression/cases-<device>.ts`
- New wire builder/parser → golden in `scripts/verify-msg.ts` or `scripts/verify-pack.ts`

## Verification sources of truth

For "what does the device actually hold right now," trust in order:

1. **Front panel display** on the hardware. Ground truth.
2. **`get_param` response.** The device echoes its own display label in the response payload (wire-level truth as the device understands it).
3. **AxeEdit / AM4-Edit panel display.** Useful but **not authoritative**: editors cache UI state (HW-086 example above). If front panel or `get_param` disagrees with the editor, the editor is wrong. Reload the preset in the editor to force a fresh read.

When writing a HW-NNN task that involves verification, name which source the founder should read. Do not accept "checked the editor, looks right" when the question is "did the write actually land."

## Rebuilding for Claude Desktop testing

Claude Desktop launches the MCP server from the **compiled workspace build** (`node packages/server-all/dist/server/index.js`), not the TypeScript source. The dist is loaded into Node once when the child process spawns; overwriting `src/` does NOT reach the live server.

**If the founder will test via a Claude Desktop conversation, do all three or the test runs against stale code:**

1. `npm run preflight` (typecheck + goldens pass)
2. `npm run build` (rebuilds packages in dependency order, copies lineage JSON)
3. Tell the founder to fully quit and relaunch Claude Desktop (closing the window leaves the MCP child alive in the tray).

If you only changed `scripts/`, `docs/`, or `samples/`, preflight is enough. **Default at session end:** if any TypeScript under `src/` changed and the next user step is Claude Desktop testing, run `npm run build` and surface the relaunch reminder.

## Living documentation, update before declaring complete

The general principle (update docs in the same session as the underlying change) is in global CLAUDE.md. This table names which docs are "living" for this project:

| Doc | Update when... |
|---|---|
| `docs/_private/STATE.md` | Any substantive session. Device-specific writeups go in the matching `STATE-<DEVICE>.md` shard; cross-device + cookbook + MCP-architecture stays in main STATE.md |
| `docs/_private/PROMPT-COVERAGE.md` | A new MCP tool ships, a protocol decode lands, or founder testing surfaces a new user prompt pattern |
| `docs/_private/HARDWARE-TASKS-<DEVICE>.md` | A HW-NNN item completes (mark ✅) or a new hardware action is identified |
| `docs/_private/04-BACKLOG.md` | A new backlog item is identified, ships, re-scopes, or is superseded |
| Per-device SYSEX-MAP (in fractal-midi) | A new protocol decode is confirmed against captured bytes; cite capture path + byte offset |
| `docs/_private/SESSIONS.md` | A session produces a chronological-worthy finding |
| `docs/_private/DECISIONS.md` | A non-obvious architectural or library choice is made |
| `docs/TOOL-ARCHIVE.md` | A registered MCP tool is removed (add entry in the same commit as the removal) |
| **Cookbook** in fractal-midi | An encoding primitive is discovered, refined, or ruled out. Same-session: add the entry + golden case in `scripts/cookbook-verify.ts` |
| **`fractal-midi/scripts/ghidra/README.md`** | A new Ghidra script is added |
| **`captured-artifacts.md`** | A new decompile dump or capture-of-interest is produced (public in fractal-midi, private in mcp-midi-tools) |

## Do Not
- Do not use AM4-Edit as a dependency or requirement.
- Do not hardcode preset-location values; always use A01-Z04 naming via `parseLocationCode` / `formatLocationCode`.
- Do not skip the safety read before any write.
- Do not guess parameter names; verify against the manual or sniffed data.
- Do not issue any preset-store / save-to-location SysEx from `scripts/probe.ts`. Probe is read-only forever.
- Do not auto-save after `apply_preset`. Saves require an explicit save phrase from the user ("save this", "put it on M03", "keep it"). `apply_preset` is reversible (switching presets discards the working buffer); save is not.
- Before overwriting a non-empty preset location, read the current contents, surface what's there, and ask. Z04 remains the conventional scratch location, but save-to-inactive-location is a real workflow (HW-064).
