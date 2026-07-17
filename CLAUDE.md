# MCP MIDI Control, Claude Code Context

Read by Claude Code at the start of every session.

---

## Project Purpose
A local MCP server that lets Claude (or any MCP host) control MIDI gear
over USB by conversation. It is an opinionated project: a set of strict
rules for controlling music gear (display-first units, no silent
saves/overwrites, acknowledged writes, tempo-first, read-before-write)
that apply consistently to every device. Generic-MIDI primitives reach
any USB MIDI device; a first-class tier gets full preset/patch authoring.
The deepest current support is for the Fractal AM4, Axe-Fx II, and ASM
Hydrasynth, with the modern Fractal family (Axe-Fx III / FM3 / FM9) and the
original Axe-Fx Standard/Ultra (gen-1, set + parameter read) in community beta. Consistency across
devices is a core value, and adding new gear (Line 6 Helix and other
popular modelers, instruments, and synthesizers are the wanted targets)
is a descriptor, not new tools.

## Current Phase
**Status:** pre-release. AM4 + Hydrasynth functional; Axe-Fx II functional; the modern Fractal family (Axe-Fx III / FM3 / FM9) in community beta via one shared gen-3 codec factory; the FM3's core surface (USB-serial transport, reads, continuous param writes, bypass, scenes, preset switching) is hardware-CONFIRMED end-to-end through this server's own probes by a 2026-06-12 community field test, and set-by-name discrete param writes are FM3-hardware-confirmed via a 2026-06-10 collaborator session (frames byte-identical to our encoder, sent from the tester's rig); set_block, save_preset, and the Windows serial-driver path still await on-device confirmation. The **FM9** is now also community-confirmed for the read + continuous-write path: a 2026-06-17 owner test (fw 11.0 / macOS) round-tripped `get_param` + continuous `set_param` on hardware through this server (acked, values confirmed on the FM9-Editor display), plus channel-specific reads and alias resolution. A 2026-06-19 Windows verify probe then hardware-confirmed `set_block` placement (a placed block appeared in the device's own fn=0x13 status dump) and `switch_scene` round-trip on the FM9, and reading a block's current type/model by NAME is wire-confirmed (fn=0x01 sub=0x1F → the device's own name string); discrete set-by-name, `save_preset`, and the live grid read (fn=0x01 sub=0x2E) stay community-beta on the FM9. The **Axe-Fx III** (the gen-3 byte-identity anchor) is now also hardware-confirmed end-to-end for the first time: the same 2026-06-17 owner test ran `set_param` (amp gain, channel A) with a device echo and a `get_param` read-back matching the front panel (same beta carve-outs as the FM9). A 2026-06-18 community roundtrip then exercised SET→GET across the entire FM9 and III catalogs on hardware: it confirmed the read + continuous-write paths catalog-wide and surfaced one fixed catalog bug: FM9 enum/type selectors were routing as continuous floats instead of discrete ordinals (~351 params corrected, gated on the FM9's own editor-cache enum data, so only the FM9 changed and the III byte-identity is intact). The III then got the same correction on 2026-06-20: the 2026-06-18 III roundtrip is itself the device oracle (the wire values it returned ARE the device's quantized image), so ~92 III type/model/count selectors that had been routing as continuous floats are now routed discrete; byte-identity intact (no wire builder changed, only kind-classification at the catalog boundary). The earlier framing that III/FM3/VP4 "need a fresh device-synced editor cache, the copies on hand are unsynced stubs" was too strong: the on-disk editor cache IS an enum-less stub, but a SET→GET roundtrip is an equally valid oracle and unblocks the fix with data in hand (FM3/VP4 simply lack a roundtrip capture so far). That roundtrip is device-behavior evidence from an independent rig; this server's own discrete write frame stays community-beta. The original Axe-Fx Standard/Ultra (gen-1, model 0x01) in community beta, with parameter set + read decoded from the published gen-1 SysEx spec. See ROADMAP.md.

Start a session by reading the maintainer's private operational notes
(gitignored, not in the public tree): the current-state doc names the
phase, the single next action, and recent findings, with per-device
shards for device-targeted work. A private per-device hardware-task list
queues the hardware actions the maintainer owes; if a pending task gates
the work you are about to do, flag it before proceeding.

The maintainer's private operational scratch (gitignored: state,
hardware tasks, session log, backlog, decisions log, test plans) lives
outside the committed tree. Committed `docs/` files cover MCP-server
architecture and contract (ARCHITECTURE.md, BLOCK-PARAMS.md,
PROJECT-VISION.md, SAFE-EDIT-WORKFLOW.md, etc.). Protocol RE (per-device
SYSEX-MAP, capture guides, Ghidra scripts, encoding-primitive corpus) lives in
the [`fractal-midi`](https://github.com/TheAndrewStaker/fractal-midi)
codec package under `packages/fractal-midi/docs/`.

## Shipping bar: evidence, not hardware (read this before deferring anything)

**The bar for shipping a capability is EVIDENCE, not a device key-press.** If the
wire/decode logic is derived from evidence we can actually check, SHIP IT and mark
it untested; do not withhold or discount it for lack of hardware verification.
Withholding likely-correct capability is the failure mode this project keeps hitting;
it holds us back and confuses what the product can actually do.

Judge work on **two independent axes**, and never collapse them into one "unverified":

1. **Evidence strength**: is the logic grounded in something checkable?
   - STRONG: byte-exact against a real capture we hold; self-validating (the device's
     own CRC/checksum gates it, e.g. the gen-3 `.syx` CRC); byte-identical round-trip;
     cross-validated against a reference oracle; derived from a published spec read
     byte-for-byte. → **Ship it. Mark "untested / community-beta." It is DONE pending a
     confirmation key-press, not "not done."**
   - WEAK: a guess with no way to catch a wrong answer, an unvalidated join, an
     inferred offset with no oracle, bytes contradicted by a capture. → This is the
     ONLY thing that stays out. If shipped at all, it ships behind a DISTINCT, louder
     label ("experimental / unvalidated, values may be wrong"), NEVER under the same
     "untested" banner as strong-evidence work, so a user never mistakes a guess for a
     confident-but-unconfirmed value.

2. **Hardware confirmation**: has a device confirmed it end-to-end? This axis NEVER
   gates shipping. It only flips a label from "untested" → "confirmed."

**`untested` ≠ `unbuilt`.** When reporting status, say what is BUILT-and-evidence-backed
(works end-to-end, awaiting a key-press) separately from what is GENUINELY blocked
(missing data/capture/oracle). Do not report evidence-backed-but-unconfirmed work as a
gap. The honest label is "untested," and untested capability still ships.

This is the same line as the no-guessed-wire-paths rule: **the line is evidence, not
"tested."** Decoded-with-evidence ships (community-beta); guessed/contradicted stays out
or ships loudly-flagged. Use accurate support-status language
(`hardware-unverified` / `set-only` / `confirmed`), never release-cadence words.

## Stack
- TypeScript / Node.js (**ES modules**, not CommonJS: `package.json` has `"type": "module"`, `tsconfig.json` uses `"module": "NodeNext"`)
- `tsx` is the TypeScript runner for scripts (not `ts-node`); invoke via `npm run <script>` or `npx tsx <path>`
- `@julusian/midi` for USB MIDI (an API-compatible node-midi fork that ships N-API prebuilt binaries for every platform we target: darwin-arm64/x64, win32-x64/arm64/ia32, linux). N-API is ABI-stable, so the prebuilt loads regardless of Node major; a toolchain (VS Build Tools / Xcode CLT) is needed only as a compile fallback when no prebuild matches the platform. End users get a release ZIP with bundled Node + the prebuilt binary, no toolchain. (Swapped from `midi`/justinlatimer-node-midi, which shipped no prebuilds and compiled on every install; the prebuild swap is what unblocks the macOS `.mcpb` Desktop Extension and a no-Xcode Mac install.)
- serialport for the **FM3 only**: the FM3 is not a USB MIDI device on ANY OS; its control channel is USB-CDC serial (Windows "FM3 Communications Port" via Fractal's serial driver, Mac `/dev/cu.usbmodem*`, Linux `/dev/ttyACM*`) carrying raw MIDI bytes. `packages/core/src/midi/serialTransport.ts` implements `MidiConnection` over it (deferred-open facade; exclusive port; `MCP_FM3_SERIAL_PATH` override). Every other Fractal device (III/FM9/VP4/AM4) is MIDI-class on Mac/Linux and driver-gated MIDI on Windows; do not generalize the FM3's serial path to them.
- @modelcontextprotocol/sdk for MCP
- No framework. No ORM. Keep it simple.

## Monorepo layout

`fractal-midi` is a **workspace package** inside this repo at `packages/fractal-midi/`. It owns all wire codec logic (builders, parsers, param dictionaries, block tables, calibration, lineage) and is published independently to npm so other consumers can use it without the MCP server.

| Package | Location | What |
|---|---|---|
| **`fractal-midi`** | `packages/fractal-midi/` | Pure-TypeScript codec. Published to npm. NO MIDI transport, NO MCP server. |
| **`@mcp-midi-control/core`** | `packages/core/` | Shared dispatcher, param-kind resolver, protocol-generic types. |
| **`@mcp-midi-control/am4`** | `packages/am4/` | AM4 device descriptor, writer, reader, tools. |
| **`@mcp-midi-control/fractal-gen2`** | `packages/fractal-gen2/` | Axe-Fx II (gen-2) device descriptor, writer, reader, tools. |
| **`@mcp-midi-control/fractal-gen1`** | `packages/fractal-gen1/` | Axe-Fx Standard/Ultra (gen-1) device descriptor. Its **own** nibble-split codec (model `0x01`, fn `0x02`, trailing query(0)/set(1) flag, not gen-2 septet, not gen-3 sub-action), in `fractal-midi/gen1`. **Set + parameter read, community beta**: decoded byte-exactly from the published gen-1 SysEx spec (no hardware). `get_param`/`get_params` query via fn 0x02 (flag 0) → MIDI_PARAM_VALUE (value + device label); `get_preset` ships the patch dump's spec-pinned subset (fn 0x03→0x04: name + effect-grid layout + source flag; param region unpinned → byte count only; bank-C ≥256 refuses); save/switch/scene/channel omitted. 922 params / 35 blocks generated from the doc. |
| **`@mcp-midi-control/fractal-gen3`** | `packages/fractal-gen3/` | Modern Fractal family (gen-3): Axe-Fx III / FM3 / FM9 / VP4. One `createModernFractalDescriptor` factory + per-device configs; they share one codec + block effect IDs, differing by model byte, grid/scene shape, and a **device-true param catalog** (FM3/FM9/VP4 mined from their own editor binaries: `fractal-midi/gen3/fm3`,`/fm9`,`/vp4`; the III is the byte-identity anchor). paramIds are device-specific, never reused across the family. VP4 is AM4-shape (serial 4-slot, no amp/cab); ships reads + the decoded community-beta writes `set_param`/`set_params` (continuous knobs, raw wire value; enum/TYPE set refuses), `set_bypass`, and `save_preset` (from a fw 4.03 capture), with the rest gated. |
| **`@mcp-midi-control/hydrasynth`** | `packages/hydrasynth/` | Hydrasynth device descriptor, writer, reader, tools. |
| **`@mcp-midi-control/circuit-tracks`** | `packages/circuit-tracks/` | Novation Circuit Tracks: synth/drum control + pattern target + `.ncs` project / WAV sample transfer (SysEx file-transfer over USB MIDI). |
| **`@mcp-midi-control/spd-sx`** | `packages/spd-sx/` | Roland SPD-SX. **Two transports:** a MIDI descriptor (kit recall via `switch_preset` + pad triggers, AUDIO/MIDI mode) AND a **storage-transport** tool family (`spdsx_*`, WAVE MGR mode) that reads/authors the device's kits + wave pool over the mounted `Roland/SPD-SX` drive. Storage ops are filesystem, NOT MIDI: `codec/` (kit/WvPrm XML + canonical WAV) + `storage/` (drive discovery, append-only wave import, kit author, backup), ported byte-exact from the hardware-confirmed `scripts/spdsx/*.py`. Building a kit is two steps: `spdsx_import_waves` → `spdsx_author_kit`. See `docs/_private/STATE-SPDSX.md`. |
| **`@mcp-midi-control/server-all`** | `packages/server-all/` | MCP server entry point. Composes all device packages. |

**One package per codec generation, not per brand or device.** Devices that share a wire codec live in one generation package as per-device *configs*, not separate packages. The Fractal packages are named by codec generation: `fractal-gen1` (Standard/Ultra, nibble-split codec), `fractal-gen2` (Axe-Fx II; a future AX8 is a config here), and `fractal-gen3` (Axe-Fx III / FM3 / FM9 / VP4): `createModernFractalDescriptor(config)` binds the shared gen-3 codec to a model byte + grid/scene shape. The codec package mirrors this: `fractal-midi/gen1`, `fractal-midi/gen2/axe-fx-ii`, `fractal-midi/gen3/<device>` (npm subpaths renamed in 0.4.0; `catalog/*.json` filenames unchanged). AM4 keeps its own package (its own codec, not any of the three generations). A new brand (Line 6 Helix, Roland) is a new codec → a new package; a new device on an existing codec is a new config file. VP4 (gen-3, model 0x14) is registered as a `fractal-gen3` config (`configs/vp4.ts`): AM4-shape (serial 4-slot, 4 scenes, A-Z04), no amp/cab, catalog from `fractal-midi/gen3/vp4`. The VP4 fn=0x01 write frame is its OWN shape (decoded byte-exact from community captures, fw 4.03: no sub-action, a `tc` sub-opcode, a swapped-septet float; `fractal-midi/gen3/vp4/setParam.ts`). It ships READS plus community-beta (untested-on-hardware) writes (`set_param`/`set_params` for continuous knobs only: raw 0..65534 wire value, calibration pending, enum/TYPE set refuses; `set_bypass`; `save_preset`; see `write_allowlist`), while `set_block` (placement value→slot math undecoded), `switch_scene` (value mapping), `switch_preset`, and `rename` stay gated. Per-capability gating is via `write_allowlist` on top of `writes_gated`.

**Build order matters.** `fractal-midi` builds first (all other packages import from it via `from 'fractal-midi/...'`). The root `npm run build` chains them in dependency order. `npm run preflight` runs build, typecheck, and the full test suite across all packages.

**Codec changes are first-class.** When a task touches wire encoding, param dictionaries, builders, parsers, or calibration, edit `packages/fractal-midi/` directly. When it touches tool descriptions, dispatching, or MCP server behavior, edit the relevant `@mcp-midi-control/*` package. Many tasks require changes across both layers. The workspace ensures a single `tsc --noEmit` catches type mismatches and a single `npm test` exercises everything.

**Publishing `fractal-midi` to npm:** bump the version in `packages/fractal-midi/package.json`, then publish from that directory (`cd packages/fractal-midi && npm publish`). The npm package is independent of the MCP server packages, which are private.

**Cross-package regression discipline:** when changing a codec builder's contract (argument types, encoding format, return shape), grep all callers across all packages. A builder may be called from: (a) the codec's own tests, (b) a device package's writer/reader, (c) the apply executor, (d) golden scripts. The fn=0x02 to fn=0x2e migration broke the apply_preset path because the builder's callers in the executor were not updated to match the new display-value contract. Every contract change requires a caller audit.

Protocol docs (`SYSEX-MAP.md`, opcode tables, capture guides, Ghidra mining scripts, encoding-primitive corpus) live in `packages/fractal-midi/docs/`; see per-device pointers in "External References" below.

## Target User
A working guitarist with a Claude account, not a developer. Every UX, install, and distribution decision prioritizes the non-technical user. The MVP ships as a Windows ZIP that bundles Node + a prebuilt native MIDI binary and runs `setup.cmd` to register the server with Claude Desktop; users never install Node, a C++ toolchain, or edit JSON. See the maintainer's private decisions log for the full reasoning.

## Decision Log
Non-obvious architectural and library choices live in the maintainer's private decisions log. Read it before proposing changes to the MIDI library, module system, TypeScript runner, distribution model, or wiki-scrape workflow.

## External References
Manuals, protocol specs, factory preset banks, and generated working docs are catalogued in `docs/REFERENCES.md`. Check there before searching the web; most common questions are answered by a local PDF (all extracted to `.txt` for grep-ability).

Per-device spec quick-references (read these before WebFetching or speculating about wire shapes):

- **AM4**: `packages/fractal-midi/docs/devices/am4/SYSEX-MAP.md` + `packages/fractal-midi/docs/devices/am4/param-rename-audit.md`
- **Axe-Fx II**: `packages/fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md` + `packages/fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md` (94 wire opcodes)
- **Axe-Fx III**: `packages/fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md` + `packages/fractal-midi/docs/devices/axe-fx-iii/preset-format-research.md`
- **Axe-Fx Standard/Ultra (gen-1)**: `packages/fractal-midi/docs/devices/axe-fx-gen1/SYSEX-MAP.md`
- **Hydrasynth**: `packages/fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md` + `packages/fractal-midi/docs/devices/hydrasynth/OVERVIEW.md`; the maintainer's private test-tone portfolio for the test set

## Reverse-engineering workflow

**Before any decode, capture analysis, or new probe script, read [`docs/RE-WORKFLOW.md`](docs/RE-WORKFLOW.md) end-to-end.** It contains the session-start reading order, capture-method preference, scientific discipline rules, 5-check capability-application pre-flight, cross-device transfer reflex, and same-session artifact registration. Skipping it has cost multi-session dead-ends (a 21-capture plan that produced nothing, a WinDbg trap that cannot fire).

The discipline rules in RE-WORKFLOW.md exist because each one closes a specific class of bug that has hit this project at least once. They are not theoretical.

### Hardware probe script design rule

**Probe scripts that ask the maintainer to observe the device MUST be interactive, not timer-based.** Use `readline` to wait for the user to type what they see and press Enter before advancing to the next value. Never use `setTimeout`/`sleep` as the gate for advancing; the maintainer cannot reliably watch a device and note what appeared during an automatic countdown. They may be mid-sentence, looking away, or reading a previous result.

The correct pattern:
```ts
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(r => rl.question(q, r));
// ...
conn.send(buildSetParam(key, i));
const label = await ask(`  index ${i}: `);  // waits for user to type + Enter
```

The wrong pattern (do not use):
```ts
conn.send(buildSetParam(key, i));
await sleep(3000);  // user cannot know how long this is or time their observation
```

This rule applies to every probe script that relies on the maintainer reading the device front panel, AM4-Edit, or any external display. Time-based sweeps are only acceptable when the probe is fully automated with no human observation step (e.g. a read-and-compare script where the script itself validates the result).

### Always-loaded rules (high-firing, contradict habit)

- **Front panel + `get_param` echo are ground truth.** AxeEdit and AM4-Edit cache stale UI state (a freshly-placed Volume block once showed 10.00 in the editor while the device held 0.00). On disagreement, the editor is wrong.
- **Read before write.** Every device tool gates writes behind a fingerprint read. Do not bypass this in new probe scripts unless they are explicitly read-only (`scripts/probe.ts` is read-only forever, by policy).
- **Septet-encode every 14-bit field, not just `pidLow`.** action codes, effect IDs, preset numbers, tempo BPM, location bytes; all 7-bit-pair encoded. Forgetting once produces wire mismatch.
- **One capture per hypothesis.** Two simultaneous edits produce ambiguous diff bytes and cost days.
- **Re-mine before you request.** Before asking anyone for new evidence, re-examine the captures already on disk against every primitive decoded SINCE they were filed; a capture opaque in May is often transparent in July because a sibling device supplied the container/packing/oracle. The 2026-07-02 session produced FOUR decodes this way (AM4=gen-3 container, FM3 grid, VP4 structure blob, II Huffman-claim refuted) from zero new captures. The synthesis cadence (`docs/process/synthesis-prompt.md` → `synthesis-log/`) exists to force this; the primitives-verify staleness warning means "decodes are sitting on disk unclaimed." Full principle: RE-WORKFLOW.md "Re-mine before you request".

### Methods ruled out, do NOT re-attempt

Each entry has full evidence and scope in the primitives corpus. Grep before re-attempting:

- **WinDbg trap-after-launch** on editor labels. Use JUCE BinaryData. See `primitives/_negative/windbg-trap-after-launch.md`.
- **Positional XML to wire-id binding.** 20 to 40% inversion rate. See `primitives/_negative/positional-xml-cache-binding.md`.
- **Virtual MIDI driver bridges** as editor interposers. Fractal editors filter these by driver class. Use USBPcap + Wireshark. See `primitives/_negative/virtual-midi-bridge-interposition.md`.
- **Byte-literal 5-byte SysEx envelope search in Ghidra.** Model byte loaded at runtime; search the 4-byte prefix `F0 00 01 74` and inspect the next instruction. See `primitives/_negative/byte-literal-envelope-ghidra-search.md`.
- **Param table as flat `-1`-terminated `int` array.** Actual layout is 16-byte `ParamDescriptor`. See `primitives/_negative/flat-int-stride4-param-table.md` and positive [[param-descriptor-16byte]].
- **AM4-shaped `0x77` envelope as save attempt on II.** Inert. Note: II uses `0x77/0x78/0x79` for its OWN preset-dump envelope, a different shape. See `primitives/_negative/am4-77-as-save-on-ii.md`.
- **Flat-byte-offset diff of II `0x77/0x78/0x79` preset binary, corrected 2026-07-02.** The body is NOT Huffman (that was a gen-3 misattribution): it is a deterministic 64×64-word fixed-layout image with STABLE offsets, but diff it at the DE-FRAMED word layer, not raw framed bytes (checksum/reserved-bit noise). The atomic read primitive for param sync is still **`fn=0x1F` SYSEX_GET_ALL_PARAMS**. See the corrected `primitives/_negative/ii-preset-binary-flat-byte-diff.md` and positive [[ii-fn1f-atomic-read]].
- **III block-name string-cascade** does NOT transfer from II. III preset serialization is descriptor-table-driven, not strcmp-cascade. See `primitives/_negative/iii-block-name-string-cascade.md`.

### Ghidra is viable for II

`SeekParamTablesII.java` direct-pattern-scan recovers 1,113 `(paramId, symbol)` entries at 99% indexed-symbol coverage on the 32-bit AxeEdit II binary. Direct pattern scan and string-walk both work; the dispatcher-xref technique does not, so reach for pattern scan.

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

### Grid devices (Axe-Fx II / III / FM3 / FM9): grid, shunts, and how to COUNT blocks

The AM4 (and VP4) chain is a serial 4-slot line. The larger Fractal units lay
blocks on a **grid** instead. When wording anything about a grid device (tool
descriptions, `chain_integrity` / `describe_device` output, agent guidance,
docs), use these exact words. **When II and III phrasing differ, lean to the
III's wording** (it is Fractal's current, and it is what generalizes across the
whole modern family):

| Term | What it means |
|---|---|
| **Grid** | The layout matrix a preset's blocks sit on. 12 columns × 4 rows on Axe-Fx II / III / FM3 / FM9. |
| **Grid location** | One cell of the grid `(row, col)`. Fractal also says "**slot**" for a grid position (Axe-Fx II usage); prefer "grid location" when a bare "slot" could be read as the AM4 1-4 effect-slot. |
| **Block** | ANY component placed in a grid location. Fractal groups Amp, Cab, EQ, and every effect all as "blocks" (III Owner's Manual: "another block like an Amp, Cab, or effect"). This is the word for a total placed-block count. |
| **Effect block** | A NARROWER subset: an effect block excludes Amp / Cab / EQ. Do NOT use "effect block" for a total count; it undercounts. Use it only when you specifically mean the effects, not the amp/cab/eq. |
| **Shunt** | A passive connector / "sonically transparent" block (III), a signal pass-through wire that fills a grid location with no processing. NOT a content block; a full row always fills its remaining cells with shunts. |

**Counting rule (the decision that drove the `chain_integrity` wording).** When
you report how many things are on the grid, count **blocks** (content) and call
out **shunts** separately; never fold shunts into the block count, and never
report the raw placed-*cell* count as a block count (a filled row is 12 cells =
content blocks + connecting shunts). The correct shape is
`"intact across N blocks (+M shunts)"`, not `"12 placed cells"`. Misreading the
cell count as a block count is exactly the BUG-8 misdiagnosis (a 5-block preset
read as "12 blocks"); the count MUST split content blocks from shunts.

Anti-patterns (grid): "12 blocks" for a row that is 5 content blocks + 7 shunts
(count content only); "effect block" as a synonym for "block" in a total (it
excludes amp/cab/eq); a bare "slot" on a grid device where it reads as the AM4
1-4 effect slot (say "grid location").

## Safe-edit workflow (cross-device contract)

Every MCP tool that navigates or persists enforces three gates across AM4, Axe-Fx II, Hydrasynth, and any future device:

1. **Buffer-dirty gate** (`on_active_preset_edited`). Check `isDirty(device)` before navigating. If dirty and the caller did not pass `'discard'` or `'save_active_first'`, refuse with a structured warning.
2. **Save-authorization gate** (`save_authorized`). Tools that apply AND persist in one call default to `false` and refuse unless the agent passes `true` (only when the user used save-intent language).
3. **Multi-preset overwrite gate.** Multi-preset tools pre-flight scan the target range and surface what would be overwritten.

Full contract, per-device implementation status, and fallback rules (Hydrasynth has no MIDI dirty signal; AM4 uses working-buffer fingerprint polling) in **[`docs/SAFE-EDIT-WORKFLOW.md`](docs/SAFE-EDIT-WORKFLOW.md)**. Port these gates before considering a new device production-ready.

## Tool surface architecture

**Two surfaces ship in parallel during the pre-release line.**

1. **Unified surface** (`src/protocol/generic/tools.ts`): port-dispatched, device-agnostic. 14 tools (`set_param`, `get_param`, `apply_preset`, `switch_preset`, `save_preset`, `switch_scene`, `set_block`, `set_bypass`, `set_params`, `get_params`, `list_params`, `describe_device`, `rename`, `scan_locations`, `lookup_lineage`) cover every registered device. Adding a new device means writing a schema descriptor + wire adapter; no new tools. Dispatcher: `src/protocol/generic/dispatcher.ts`.
2. **Device-namespaced surface** (`am4_*`, `axefx2_*`, `hydra_*`): first-generation pattern. Kept in parallel because the long tool descriptions carry device-specific behavioral guidance the LLM relies on during tone-building. Slated for removal in a later release once the guidance migrates into per-device `describe_device` responses.

**When adding a new tool, prefer the unified surface.** New device-namespaced tools are technical debt. If a new capability does not fit, design the contract change first (extend `DeviceWriter` / `DeviceReader` / capabilities), then register the unified tool.

**Before adding or substantially modifying a tool, read [`docs/TOOL-AUTHORING-GUIDE.md`](docs/TOOL-AUTHORING-GUIDE.md).** It captures the patterns from senior MCP design reviews and names the common pitfalls (wire-ack-not-audible, type-gated silent no-op, opcode-not-portable-across-model-bytes) the codebase has burned cycles relearning.

## Tool API conventions

**Display-first.** Every MCP tool surface (every device, present and future) accepts and returns **display units**: what a musician reads on the front panel (0..10 knob, dB, ms, ratio `4:1`, enum string `'Plexi 100W High'`). Wire-format details (septet-encoded 14-bit ints, packed-float bytes, fixed-point scaling) are internal and never leak through tool I/O. Error messages use display shape too: `"amp.gain out of range [0..10]: 12.5"`, never `"wire value 0x4800 invalid"`.

Display to wire coercion happens once at the tool boundary via `resolveValue` / `resolveEnumValue`. Everything below the tool layer takes wire and is type-checked against it. Rationale: the maintainer's private decisions log.

**The trap is non-linear params.** Display-first is automatic for linear knobs (cutoff 55 → 55.0). It is *tempting to violate* when the wire↔display mapping is non-linear (the Hydrasynth env/LFO time tables are exponential bucket schedules), because the lazy path exposes the wire-shaped 0..128 index. Don't: the codec must own the inverse so the caller passes the panel reading (ms / `"2.5s"`). This rule is **enforced, not just documented**: `npm run hydra:verify-display-first` (in preflight) round-trips every display-first param over its full on-grid sample set and fails if any input/output leaks an internal index/wire. When adding a device or a non-linear param, give its display formula both `decode` (wire→display) and `encode` (display→wire), or add it to the gate's tracked allowlist with a reason. The Fractal devices have the same gate: `npm run verify-display-first-fractal` (in `test:codec`) enforces family coverage + exact on-grid round-trip identity across AM4 / Axe-Fx II / gen-3 (III/FM3/FM9/VP4) / gen-1, with a per-device parity-pending allowlist whose ceilings freeze the raw-wire debt (a new uncalibrated or one-sided param fails the gate).

## Performance budget

MCP tool calls are part of a conversation. Users tolerate short waits during overt batch actions; individual tool calls should feel instantaneous.

- **Ideal:** < 200 ms per tool call (single `set_param`, `set_block_type`). SysEx round-trips land in 30-60 ms with a 300 ms ack window.
- **Acceptable:** < 1 s for tools that make 2-5 wire transactions (e.g. `apply_preset` with a handful of blocks).
- **Requires explicit progress:** anything > 1 s tells the user upfront ("This will probe 16 preset locations, ~1 second"). Never make the user wait silently.
- **Avoid altogether:** > 5 s of wire work in a single conversational turn. Cache, batch into a dedicated command, or design around the probe.

Estimate wire-round-trip count up front. SysEx is serial: N reads ≈ N × 50 ms minimum. If the math says > 1 s, redesign before implementing.

## Key Constraints
- Windows ThinkPad. Use Windows paths.
- `@julusian/midi` normally installs a prebuilt N-API binary (no toolchain). It only falls back to a node-gyp compile when no prebuild matches the platform; if that fallback runs and fails on Windows, install VS Build Tools and `npm rebuild @julusian/midi`.
- AM4 USB driver must be installed before any MIDI communication. Driver: https://www.fractalaudio.com/am4-downloads/
- Never write to a preset location without reading it first.
- Always confirm before overwriting non-empty, non-factory locations.

## File Conventions
- All `.syx` binary samples + USB captures + decoded analysis go in `samples/`; **the entire directory is gitignored**. Treat as local debug scratch.
- Reverse-engineering notes live in [`fractal-midi/docs/devices/<device>/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/tree/main/docs/devices) (codec-domain).
- Block parameter tables live in `docs/BLOCK-PARAMS.md` (MCP contract docs).
- Sniffing session logs go in the maintainer's private session log.
- Tests that require hardware are in `tests/integration/` and skipped in CI.

## Testing and sign-off

- **`npm run preflight`** is the single command to run before every commit. Runs: `build` (all 7 packages in dependency order), `typecheck` (per-package tsconfigs), `test` (fractal-midi + codec + cross-device + per-device + server smoke), `verify-no-internal-refs`, `primitives-verify`, `tools:inventory-check`.
- `npm test` alone runs the test suites without building or typechecking; handy for iterating on the protocol layer. Requires `dist/` to exist (run `npm run build` first on a fresh clone).
- **When adding a new pidHigh to `params.ts`, add a matching case to `verify-msg.ts` built from captured bytes.** That is the only mechanical guard against misreading septet-encoded pidHighs as little-endian bytes (that bug class).

**Failing tests get fixed, not annotated.** See global CLAUDE.md for the principle. Project-specific: when `npm run preflight`, `launch-verify`, `live-regression`, or `agent-sweep` fails, investigate root cause; update assertions only when production behavior changed deliberately (e.g. a deliberate dispatcher-shape change); never `skip` with a "fix later" comment; if you cannot fix in this session, escalate before declaring work complete.

**Adding new tests** alongside new features:
- New unified tool → case in `scripts/launch-verification.ts`
- New device capability requiring hardware → case in `scripts/live-regression.ts` (self-restoring mutations only)
- New agent-facing tool description or alias → case in `scripts/agent-regression/cases-<device>.ts`
- New wire builder/parser → golden in `scripts/verify-msg.ts` or `scripts/verify-pack.ts`

## Versioning and releases

Semantic versioning. Pre-1.0 (current line):

- **Patch (`0.0.x`)** bundles bug fixes. Group several fixes and ship them as
  one patch; it is NOT one-fix-per-patch. Fixes only, no new capability.
- **Minor (`0.x.0`)** adds entirely new features or new device support.
- **`1.0.0`** is a one-time maturity milestone, cut after meaningful community
  adoption and broader device coverage. It is NOT triggered by a breaking
  change. After 1.0.0, standard semver resumes: a major bump (`2.0.0`) is
  reserved for breaking changes.

**One squashed commit per release.** Each release is a single commit on top of
the previous release commit, with development work squashed in at release time
so there is no progress-noise in history. Every release commit carries, 1:1:
the version bump, its annotated `v<x.y.z>` tag, one matching `CHANGELOG.md`
entry, and the GitHub release that the tag push triggers. The result is a clean
chain where every commit is meaningful and maps to exactly one version / tag /
release / changelog entry. The 0.1.0 history was collapsed to a single orphan
commit for the public launch; do NOT re-orphan on later releases, just append
one squashed release commit each time (parent = the prior release).

**`fractal-midi`'s version tracks the product release.** It is bumped to the
same `x.y.z` in the SAME release commit as the product (so every remote commit
maps 1:1 to a version across the whole repo, including the codec package), and
published to npm as part of cutting that release. The version bump, the
`v<x.y.z>` tag, the `CHANGELOG.md` entry, the GitHub release, and the
`fractal-midi` npm publish all ship together. (This supersedes the earlier
"versioned independently" policy: keeping the OSS codec push and its npm
publish in lockstep with the product release avoids drift between what's on
GitHub and what's on npm.)

## Verification sources of truth

For "what does the device actually hold right now," trust in order:

1. **Front panel display** on the hardware. Ground truth.
2. **`get_param` response.** The device echoes its own display label in the response payload (wire-level truth as the device understands it).
3. **AxeEdit / AM4-Edit panel display.** Useful but **not authoritative**: editors cache UI state (the stale-editor example above). If front panel or `get_param` disagrees with the editor, the editor is wrong. Reload the preset in the editor to force a fresh read.

When writing a hardware-verification task, name which source the maintainer should read. Do not accept "checked the editor, looks right" when the question is "did the write actually land."

## Rebuilding for Claude Desktop testing

Claude Desktop launches the MCP server from the **compiled workspace build** (`node packages/server-all/dist/server/index.js`), not the TypeScript source. The dist is loaded into Node once when the child process spawns; overwriting `src/` does NOT reach the live server.

**If the maintainer will test via a Claude Desktop conversation, do all three or the test runs against stale code:**

1. `npm run preflight` (build + typecheck + test + lint all pass)
2. Tell the maintainer to fully quit and relaunch Claude Desktop (closing the window leaves the MCP child alive in the tray).

If you only changed `scripts/`, `docs/`, or `samples/`, preflight is enough. **Default at session end:** if any TypeScript under `src/` changed and the next user step is Claude Desktop testing, run `npm run build` and surface the relaunch reminder.

## Living documentation, update before declaring complete

The general principle (update docs in the same session as the underlying change) is in global CLAUDE.md. This table names which docs are "living" for this project:

The private-tracker rows below describe the maintainer's gitignored operational notes; they are not part of the public tree but still need same-session updates.

| Doc | Update when... |
|---|---|
| The private state doc (and its per-device shards) | Any substantive session. Device-specific writeups go in the matching device shard; cross-device + primitives + MCP-architecture stays in the main state doc |
| The private prompt-coverage doc | A new MCP tool ships, a protocol decode lands, or maintainer testing surfaces a new user prompt pattern |
| The private per-device hardware-task lists | A hardware task completes (mark ✅) or a new hardware action is identified |
| The private backlog | A new backlog item is identified, ships, re-scopes, or is superseded |
| Per-device SYSEX-MAP (in fractal-midi) | A new protocol decode is confirmed against captured bytes; cite capture path + byte offset |
| The private session log | A session produces a chronological-worthy finding |
| The private decisions log | A non-obvious architectural or library choice is made |
| The private tool-archive notes | A registered MCP tool is removed (record the capability + revival path) |
| **Primitives corpus** in fractal-midi | An encoding primitive is discovered, refined, or ruled out. Same-session: add the entry + golden case in `scripts/primitives-verify.ts` |
| **`fractal-midi/scripts/ghidra/README.md`** | A new Ghidra script is added |
| **`captured-artifacts.md`** | A new decompile dump or capture-of-interest is produced (public in the codec repo, private here) |
| **Capture guides** in `packages/fractal-midi/docs/capture-guides/` | A community capture comes in and a gap closes (mark ✅ in the relevant `captures-<device>.md`); a capability lands and testing asks become moot (update or remove the ask in `testing-<device>.md`); device status changes (update the table in `README.md`). The per-device split is: `testing-<device>.md` for no-tools verification asks; `captures-<device>.md` for raw protocol capture asks. |

## Do Not
- Do not use AM4-Edit as a dependency or requirement.
- Do not hardcode preset-location values; always use A01-Z04 naming via `parseLocationCode` / `formatLocationCode`.
- Do not skip the safety read before any write.
- Do not guess parameter names; verify against the manual or sniffed data.
- Do not issue any preset-store / save-to-location SysEx from `scripts/probe.ts`. Probe is read-only forever.
- Do not auto-save after `apply_preset`. Saves require an explicit save phrase from the user ("save this", "put it on M03", "keep it"). `apply_preset` is reversible (switching presets discards the working buffer); save is not.
- Before overwriting a non-empty preset location, read the current contents, surface what's there, and ask. Saving to an inactive location is a real workflow; there is no ubiquitous "scratch" location, so don't assume one.
