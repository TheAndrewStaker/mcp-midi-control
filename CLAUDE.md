# MCP MIDI Control â€” Claude Code Context

This file is read by Claude Code at the start of every session.

---

## Project Purpose
Build a local MCP server that lets Claude Desktop control a Fractal AM4
guitar amp modeler over USB/MIDI via natural language conversation.

## Current Phase
See **`docs/_private/STATE.md`** first. It names the current phase, the
single next action, and recent findings â€” start every session there.
`STATE.md` is kept current; the longer-lived reference docs are
`docs/PROJECT-VISION.md` and `docs/ARCHITECTURE.md`.

`npm run coverage-audit` auto-snapshots Ghidra-catalog coverage vs
`params.ts` vs `verify-msg.ts` goldens, plus per-device param counts.
It runs as part of `npm run preflight`, so every session-end pass
exercises it. **Not required at session start** anymore (Session 110):
AM4 has been at 100% catalog and II at ~97.4% for many sessions, and
the audit-as-drift-guard value has decayed. Run it manually when
touching codec / params.ts, after pulling fractal-midi changes, or
when STATE.md's "open follow-ups" feel out-of-sync with reality. Trust
the audit over any text claim that something is "open."

Hardware tasks the founder owes (USB captures, round-trip tests on
the device, reference dumps) are queued per-device under
`docs/_private/`:
- **`HARDWARE-TASKS.md`** â€” index file pointing at per-device files.
- **`HARDWARE-TASKS-AXEFX2.md`** â€” Fractal Axe-Fx II XL+ tasks.
- **`HARDWARE-TASKS-AM4.md`** â€” Fractal AM4 tasks.
- **`HARDWARE-TASKS-HYDRASYNTH.md`** â€” ASM Hydrasynth Explorer tasks.
- **`HARDWARE-TASKS-ARCHIVE.md`** â€” closed tasks across all devices.

Each active file groups tasks as ðŸ“· capture-required, ðŸŽ›ï¸ desktop test,
or ðŸ’¬ chat-only. Check the index at session start; if anything sits at
ðŸ”œ Pending in the relevant device's file, flag it before proceeding
with work that depends on it. When you identify a new hardware action
you can't perform yourself, append a `HW-NNN` entry to the right
device's file (NOT the index) with detailed steps the founder can
follow without re-reading the backlog.

`docs/_private/` is the founder's operational scratch (gitignored,
local-only): STATE, HARDWARE-TASKS, SESSIONS log, BACKLOG, DECISIONS
log, HW-NNN test plans, marketing drafts, internal data dumps. The
committed `docs/` files in THIS repo cover MCP-server architecture
+ contract (`ARCHITECTURE.md`, `BLOCK-PARAMS.md`, `PROJECT-VISION.md`,
`SAFE-EDIT-WORKFLOW.md`, `FRACTAL-PRESET-SCHEMA.md`,
`TYPE-KNOB-WORKFLOW.md`, etc.). Protocol RE (per-device `SYSEX-MAP.md`,
`*-research.md`, capture guides, Ghidra scripts) lives in the
[`fractal-midi`](https://github.com/TheAndrewStaker/fractal-midi)
codec repo — Session 103 doc migration. Both classes are OSS public
good; the split tracks the code split.

> Phase 0 (feasibility) completed 2026-04-14. Phase 1 (protocol RE) is in
> progress â€” USB capture of AM4-Edit's outgoing traffic is the current
> blocker. See `_private/STATE.md` for exact next steps.

## Stack
- TypeScript / Node.js (**ES modules**, not CommonJS â€” `package.json` has
  `"type": "module"`, `tsconfig.json` uses `"module": "NodeNext"`)
- `tsx` is the TypeScript runner for scripts (not `ts-node`) â€” invoke via
  `npm run <script>` or `npx tsx <path>`
- node-midi for USB MIDI (native module â€” requires VS Build Tools on Windows
  dev machines; end users get the release ZIP with a bundled Node runtime
  and a prebuilt native binary, so they need neither)
- @modelcontextprotocol/sdk for MCP
- No framework. No ORM. Keep it simple.

## Two-repo layout (`fractal-midi` extracted Session 98)

This project consumes a SEPARATE npm package, `fractal-midi`, that
owns all wire codec logic. **The codec is NOT in this repo.** When you
need to change wire shapes, builders, parsers, param dictionaries,
block tables, or anything else the device speaks:

| Lives in | What |
|---|---|
| **`C:/dev/fractal-midi/`** (separate git repo, published to npm as `fractal-midi@0.1.0-alpha.0`) | Pure-TypeScript codec: `src/{shared,am4,axe-fx-ii,axe-fx-iii}/`. Builders, parsers, param dictionaries, block tables, calibration, fractal-shared lineage. NO MIDI transport, NO MCP server. |
| **`C:/dev/mcp-midi-tools/`** (this repo) | MCP server + descriptors + dispatcher + agent guidance + tool registrations. Imports from `fractal-midi/*` (e.g. `import { KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii'`). Consumes the codec; doesn't define it. |

**Workflow for a codec change** (e.g. adding the `SYSEX_RESYNC` builder
or the new opcodes.ts enum from Session 103):

1. `cd C:/dev/fractal-midi` â€” edit `src/axe-fx-ii/setParam.ts` (or wherever).
2. Run that repo's tests (`npm test`).
3. Bump the version in `package.json` (alpha bump is fine pre-1.0).
4. `npm pack` produces a `.tgz`.
5. `cd C:/dev/mcp-midi-tools` and `npm install /path/to/.tgz` to consume.
6. Test the integration here.
7. When the codec change is solid, push the fractal-midi commits and tag
   `v0.1.0-alpha.N` â€” CI publishes to npm.

For QUICK iteration (you're still drafting), `npm link` between the two
repos avoids the pack/install cycle. Reset to a published version before
committing.

**Where protocol docs SHOULD live:** the wire-map docs
(`SYSEX-MAP.md`, `axeedit-opcode-table.md`) are codec-domain â€” they
belong in `C:/dev/fractal-midi/docs/`. They currently sit in this
repo for historical reasons (predate the extraction); a doc-migration
sweep is queued under [`fractal-midi/docs/devices/axe-fx-ii/ghidra-followups.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/ghidra-followups.md)
C5. Ghidra mining scripts in [`fractal-midi/scripts/ghidra/`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/scripts/ghidra/) are also codec-domain
and will move with the docs.

**Where research docs SHOULD live:** captures + decoded artifacts in
`samples/captured/` are project-scratch (gitignored). The committed
research narratives (`docs/research/*-research.md`) are publishable
OSS material â€” they'll likely move to `fractal-midi/docs/research/`
too in the same sweep.

## Target User
A working guitarist with a Claude account â€” not a developer. Every UX,
install, and distribution decision prioritizes the non-technical user.
The MVP ships as a Windows ZIP that bundles Node + a prebuilt native MIDI
binary and runs `setup.cmd` to register the server with Claude Desktop;
users never install Node, a C++ toolchain, or edit JSON. See
`docs/_private/DECISIONS.md` for the full reasoning and rejected alternatives.

## Decision Log
Non-obvious architectural and library choices live in `docs/_private/DECISIONS.md`.
Read it before proposing changes to: the MIDI library, module system,
TypeScript runner, distribution model, or wiki-scrape workflow.

## External References
Manuals, protocol specs, factory preset banks, and generated working docs
are catalogued in `docs/REFERENCES.md`. Check there first before searching
the web â€” most common questions are answered by one of the local PDFs
(all extracted to `.txt` for grep-ability).

**Per-device spec quick-references** (read these before WebFetching
or speculating about wire shapes):

- **AM4** → [`fractal-midi/docs/devices/am4/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/am4/SYSEX-MAP.md)
- **Axe-Fx II** â†’ [`fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/SYSEX-MAP.md)
- **Axe-Fx III** â†’ [`fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-iii/SYSEX-MAP.md) (covers Fractal v1.4 PDF; extracted text at [`fractal-midi/docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt)) + [`fractal-midi/docs/devices/axe-fx-iii/preset-format-research.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-iii/preset-format-research.md) (community RE of preset .syx format; Forum thread #159885 archived at `docs/_private/fractal-forum-text.txt`)
- **Hydrasynth** â†’ [`fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/hydrasynth/SYSEX-MAP.md) + [`fractal-midi/docs/devices/hydrasynth/OVERVIEW.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/hydrasynth/OVERVIEW.md) for capability landscape; [`fractal-midi/docs/devices/hydrasynth/preset-format-research.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/hydrasynth/preset-format-research.md) for the `.hydra` / `.patch` file format probe; `docs/_private/HYDRASYNTH-ICONIC-TONES.md` for the iconic-tones test portfolio

## Reverse-engineering workflow

Protocol RE is the bulk of this project's work. Following the workflow
below keeps sessions from re-treading dead ends and from publishing
claims that aren't byte-verified.

### Session start (read in this order)
1. **`docs/_private/STATE.md`** â€” current phase, single next action,
   recent breakthroughs. Always first.
2. **`docs/_private/captured-artifacts.md`** if it exists â€” founder-
   private manifest of decompile dumps + USB captures + factory dumps
   that don't ship to OSS. **Always grep `samples/captured/decoded/`
   before proposing a new Ghidra run** â€” the Axe-Fx III 25K-line
   decompile dump already contains material that closes BK-070's III
   equivalent without hardware.
3. **`../fractal-midi/docs/research/cookbook/INDEX.md`** â€” the encoding
   primitive Rosetta stone. Before researching any new wire shape,
   scan the cookbook â€” the shape may already be a known primitive
   (septet, XOR-fold, descriptor-table, etc.). Cookbook entries are
   the canonical source for "how Fractal encodes X."
4. **`npm run coverage-audit`** â€” code-state ground truth, not stale
   text (handled by the section above; restated here because RE
   sessions especially drift on this).
5. **[`fractal-midi/docs/research/fractal-protocol-decode-status.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/research/fractal-protocol-decode-status.md)** â€” per-device decode
   status table. Last full sweep Session 82â€“83. Read before opening
   any new investigation so you know what's already named vs. open.
4. **`docs/devices/captures-inventory.md`** â€” what `.pcapng` / `.syx`
   captures and Ghidra dumps already exist. **Always check this
   BEFORE asking the founder for more captures.** Session 103
   proposed a 70-minute, 21-capture plan without checking the
   inventory; 5+ relevant captures already existed in
   `samples/captured/`, and Ghidra mining of the existing
   already-analyzed AxeEdit.exe project produced the full 94-opcode
   wire-byte table in 30 minutes (zero hardware time).
5. **`docs/_private/HARDWARE-TASKS-<DEVICE>.md`** â€” open captures the
   founder owes. If a ðŸ”œ Pending task gates the work you're about to
   do, surface it instead of speculating around the missing data.
6. **Per-device wire map** â€” per-device wire maps in fractal-midi: https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/
   (AM4, Axe-Fx II, Axe-Fx III, Hydrasynth). The authoritative
   byte-shape doc for the device you're working on. For Axe-Fx II,
   also read [`fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/axeedit-opcode-table.md) (94
   wire opcodes recovered from AxeEdit.exe Session 103).
7. **`docs/REFERENCES.md`** â€” only the section for your device. Don't
   WebFetch for a manual we already have extracted to `.txt`.

### Capture methods (in order of preference)

**Hardware-free lanes â€” exhaust these BEFORE queuing founder time:**

- **Existing captures** â€” `samples/captured/` has 169 files spanning
  50+ session IDs (gitignored, local-only). Many decode targets are
  already covered. See `docs/devices/captures-inventory.md` for the
  full index by device + decode purpose. Session 103 retrospective:
  an agent nearly queued a 21-capture plan that 5+ existing captures
  would have answered.
- **Ghidra dispatcher mining** â€” canonical for paramId â†” name catalog
  discovery (99% wire-accuracy verified Session 82â€“83). Also for SysEx
  opcode-table decode: Session 103 mined the full AxeEdit II wire
  vocabulary (94 opcodes, opcode struct `{name; wire_byte+1}` in
  `.rdata`) via 6 iterative GhidraScripts in ~30 min wall time. The
  `ghidra-axe-edit` project at `C:\Users\Steph\` is already
  auto-analyzed; new scripts run read-only against it. See
  [`fractal-midi/docs/research/ghidra-mining-workflow.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/research/ghidra-mining-workflow.md),
  [`fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/axeedit-opcode-table.md), and the
  [`fractal-midi/scripts/ghidra/`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/scripts/ghidra/) directory (30+ existing scripts + their CMD
  launchers).
- **JUCE BinaryData extraction** â€” 5-minute label discovery from
  editor binaries via the embedded ZIP. 1,299 AM4-Edit labels and
  10,250 AxeEdit III labels recovered this way. See
  [`fractal-midi/docs/capture-guides/juce-binarydata-extraction.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/capture-guides/juce-binarydata-extraction.md).

**Hardware lanes â€” only after the above is exhausted:**

- **Directed probe scripts** (`scripts/probe*.ts`) â€” cheap, scriptable,
  default for unknown wire envelopes. One hypothesis per probe; keep
  the probe read-only unless explicitly designed to write.
- **Passive capture** â€” open the device MIDI input with no editor.
  Axe-Fx II broadcasts state continuously; AM4 is silent and needs an
  active query loop. See [`fractal-midi/docs/research/fractal-broadcast-vs-poll-research.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/research/fractal-broadcast-vs-poll-research.md).
- **USBPcap + Wireshark** â€” captures both directions at the USB-class
  layer when the editor â†’ device direction is needed. The maintainer's
  default for editor-write decode. See `CONTRIBUTING.md` for the
  step-by-step.

### Methods that have failed â€” don't re-attempt
- **WinDbg trap-after-launch** â€” stack-frame too shallow, label written
  before trap arms. Session 46. Use JUCE BinaryData instead.
- **Positional XML â†’ cache-record binding** â€” XML `parameterName` is a
  per-variant UI symbol, not a unique wire key. 20â€“40% inversions
  across variants. Session 46 cont 2.
- **Virtual MIDI driver bridges** (any class-compliant virtual port
  trying to interpose between editor and device) â€” Fractal editors
  filter these out by driver class via `midiInGetDevCaps` /
  `midiOutGetDevCaps`. Intentional filtering, not a bug. Use the
  USBPcap + Wireshark path instead.
- **Byte-literal full SysEx envelope (`F0 00 01 74 10`) search in
  Ghidra** â€” model byte loaded at runtime from a device-handle struct.
  Search the 4-byte `F0 00 01 74` instead and inspect the next
  instruction for the model load. Session 82.
- **Param table as flat `-1`-terminated `int` array** â€” actually a
  16-byte `ParamDescriptor` (paramId at +0, name pointer at +8).
  Stride-by-4 produces garbage. Session 82.
- **AM4 `0x77` preset-save envelope assumed portable to Axe-Fx II** â€”
  inert on II XL+ (Session 94). Each device family gets its own
  envelope decode; do not extrapolate across model bytes.
- **Flat-byte-offset diff of the II 0x77/0x78/0x79 preset binary** â€”
  proposed in Session 103 as a 21-capture decode plan. Two reasons
  to reject:
  1. The body is Huffman-compressed per III community RE (Fractal
     Forum thread #159885); same envelope family. Flat offsets are
     not stable across presets and the codebook decode is research
     of unknown duration.
  2. The atomic read primitive is `fn 0x0E SYSEX_QUERY_STATES`
     (recovered from AxeEdit.exe Session 103), NOT the preset-binary
     envelope. One `fn 0x0E` request â†’ device responds with the full
     per-block state. That's what AxeEdit actually uses for its
     "Read from Axe-Fx" sync flow â€” visible in
     `samples/captured/session-58-direct-sync.syx`.
  General lesson: don't propose multi-capture decode plans before
  checking what AxeEdit itself does via Ghidra + existing captures.

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
  is never sufficient â€” combine with a capture or the Ghidra paramId
  table.
- **Septet-encode every 14-bit field, not just `pidLow`.** `action`,
  effect IDs, preset numbers, tempo BPM, location bytes â€” all 7-bit-
  pair encoded. Forgetting once = wire mismatch and a confused
  device.
- **Cite captures with file path + byte offset** in `SYSEX-MAP*.md`
  so future agents can re-verify. "Confirmed via capture" without a
  reference is hearsay.

### Negative findings are valuable
When a probe rules a hypothesis OUT (e.g. Session 94 ruling that AM4's
`0x77` envelope doesn't work on Axe-Fx II), commit the result to
`docs/SYSEX-MAP-*.md` or `docs/_private/SESSIONS.md` with the search
terms a future agent would use ("AM4 0x77 portable to II â€” no"). This
saves a session every time someone re-asks the same question.

Also register the negative in `fractal-midi/docs/research/cookbook/_negative/<name>.md`
when it's a primitive-level claim ("this encoding scheme doesn't apply
to device X" / "this technique was ruled out"). The cookbook's
`_negative/` directory is the canonical "methods that don't work" home
that the next agent grep-s before re-attempting.

### Capability application discipline (5-check pre-flight)

Before wiring a decoded primitive into a shipping tool path, the agent
runs a 5-check pre-flight and cites the evidence in the commit body.
Designed to catch the misapplication failure class (the `get_preset`
regression: +1.5-2s latency, stale source-of-truth, wrong bug-fix
mapping, scaffolding placeholders) and the N=1 generalization-claim
trap (paramBase shipped as generalized when it only worked for Test
Crunch). The four-check + N=1 protocol:

1. **Latency check.** Estimate or measure round-trip cost; compare to
   the < 1 s tool-call budget. State the number in the commit body.
2. **Source-of-truth check.** Name which source the primitive reads
   (working buffer / stored binary at active location / stored binary
   at non-active location / cached snapshot / front-panel echo). If
   the existing code path read source S1 and your change demotes it
   to S2, that's a correctness regression — flip it back before
   shipping.
3. **Bug-fix mapping.** If claiming "this fixes bug X," name the code
   path X lives in (file:line). Name the code path being changed
   (file:line). If the two are different, the framing is wrong —
   STOP. Cookbook `Misapplication failure modes` sections name common
   bug-X-doesn't-live-here cases (e.g. `atomic-preset-dump` does NOT
   fix BK-058 channel-Y; channel-Y is a write-path bug).
4. **Scaffolding check.** Grep the diff for `0 ? undefined : undefined`,
   `// TODO`, `// scaffolding`, hardcoded `0` returned for "real later",
   typed-but-never-set fields. If any present, the change is WIP, not
   shippable.
5. **Generalization-claim check (N=1 trap).** When claiming a primitive
   "generalizes" (across blocks / across presets / across firmwares /
   across devices), cite ≥ 2 distinct test cases varying along the
   generalization axis. N=1 is not generalization. If only N=1 verified,
   ship as `cookbook/_partial/` with `status: partial-N1`; do NOT ship
   as generalized. If a co-resident or cross-variant probe is cheap
   (< 5 min wire time), run it BEFORE shipping.

The cookbook + cookbook-verify build gate mechanically enforces checks
3 + 5: any primitive marked `status: matched` with < 2 fixtures fails
the build; any `status: scratch` entry whose golden unexpectedly passes
fails the build (forces explicit promote-or-demote).

### Cross-device transfer reflex (at session close)

When you discover or refine a primitive on one device, scan the other
three device wire-maps + `fractal-midi/docs/research/cookbook/` for
analogous decode gaps. File same-session `[transfer-candidate]`
follow-ups in each affected device's `STATE-<DEVICE>.md` (or
`HARDWARE-TASKS-<DEVICE>.md`) naming the transfer hypothesis + the
cheapest test to confirm.

Real evidence: the Axe-Fx III preset binary envelope is byte-identical
in shape to the II envelope (same `(tag, mid, byte_count)` descriptor
table layout) — 5 sessions of II hardware-probe work could have been
recognized as a III-decodable target months ago if the transfer reflex
had been a session-close ritual. Don't repeat that miss. Cross-device
transfer findings are the highest-yield decode moves in the codebase.

### Same-session artifact registration

Every new Ghidra script, decompile dump, capture-of-interest, OR
encoding primitive must be registered in the appropriate index the
SAME SESSION it's produced:

- New Ghidra script → `fractal-midi/scripts/ghidra/README.md` registry
- New decompile dump or capture-of-interest → `fractal-midi/docs/research/captured-artifacts.md`
  (public) or `mcp-midi-tools/docs/_private/captured-artifacts.md`
  (private; founder hardware + factory dumps)
- New encoding primitive → `fractal-midi/docs/research/cookbook/<name>.md`
  with a matching golden case in `scripts/cookbook-verify.ts`
- New negative finding → `fractal-midi/docs/research/cookbook/_negative/<name>.md`

Not "I'll add it later." Same-session registration is the same
discipline as the existing "verify-msg golden per new pidHigh" rule —
promoted one level up.

### Param-coverage audit discipline (Session 113 cont 3)

When grepping `fractal-midi/src/<device>/params.ts` to confirm whether
a param is registered, **the registered name often differs from the
Blocks Guide / Owner's Manual spelling** because params are renamed
for AM4-Edit / front-panel UI-label match. Naive search for the
manual's wording produces false negatives.

Concrete examples (all registered, easy to miss with a naive grep):

| Manual / Blocks Guide name | Registered as |
|---|---|
| `amp.sag` | `amp.preamp_sag` |
| `amp.negative_feedback` | `amp.negative_fb` |
| `amp.saturation_switch` | `amp.saturation_sw` |
| `amp.boost_type` | `amp.in_boost_type` |

**Audit rule:** before opening a "missing param" investigation, re-grep
using AM4's short canonical spellings — `_sw`, `_fb`, `preamp_*`,
`nfb_*`, `in_*` prefix variants. Check comment headers for "renamed
for UI-label match (audit row: ...)". Don't trust the first negative
grep — a 30-minute re-investigation that ends in "actually we shipped
it already" is a worse outcome than a 5-minute careful first pass.

## AM4 SysEx â€” quick facts

Full envelope, checksum, function-byte table, and capture-cited
decodes live in **[`fractal-midi/docs/devices/am4/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/am4/SYSEX-MAP.md)**. The basics, here:

- **Model byte:** `0x15`. Envelope: `F0 00 01 74 15 [fn] [...] [cksum] F7`.
- **Checksum:** `bytes.reduce((a,b)=>a^b,0) & 0x7F` over `F0`..last payload byte.
- **Preset locations:** A01â€“Z04 (104 total). Use `parseLocationCode` /
  `formatLocationCode` from `src/protocol/locations.ts` â€” never hardcode.

## Fractal terminology (use these exact words)

Fractal's docs use specific words for AM4 concepts. Our code and user-
facing strings MUST match, because one of the words â€” "slot" â€” has
opposite meanings in casual use:

| Term | What it means |
|---|---|
| **Bank** | A letter Aâ€“Z grouping 4 preset locations |
| **Preset** | The stored patch (blocks + params + scenes + name) |
| **Location** | Where a preset is stored. "A01" through "Z04", 104 total. NOT called a "slot" |
| **Slot** (or **effect slot**) | A position 1â€“4 in a preset's signal chain. The slot is the container; the block is what fills it |
| **Block** | The effect occupying a slot (amp, drive, delay, reverb, chorus, â€¦) |
| **Scene** | One of 4 performance variations within a preset (bypass + channel state, not a copy of the blocks themselves) |
| **Channel** | Per-block A/B/C/D variation of that block's settings |

Anti-patterns to avoid:
- "preset slot" when you mean "preset location" (wrong â€” preset slots
  don't exist; presets occupy *locations*, not slots)
- "save to slot N" in user-facing text (wrong â€” "save to location N")
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
  fingerprint for the active location. Match â†’ proceed; mismatch â†’
  refuse / save-first / discard. Cache baselines are refreshed after
  every clean transition (post-switch, post-save). One source of truth,
  catches our writes + front-panel edits + parallel-editor edits in
  one ~200 ms round-trip per navigation. See `bufferFingerprint.ts` +
  `tools/safeEdit.ts`.

## Tool surface architecture

**Two surfaces ship in parallel through v0.1.0.**

1. **Unified surface** (`src/protocol/generic/tools.ts`) â€” port-
   dispatched, device-agnostic. `set_param(port, block, name, value)`,
   `get_param`, `apply_preset`, `switch_preset`, `save_preset`,
   `switch_scene`, `set_block`, `set_bypass`, `set_params`,
   `get_params`, `list_params`, `describe_device`, `rename`,
   `scan_locations`, `lookup_lineage`. 14 tools cover every registered
   device. Adding a new device means writing a schema descriptor
   (`src/<vendor>/<device>/descriptor.ts`) + wire adapter; no new
   tools. Dispatcher lives in `src/protocol/generic/dispatcher.ts`,
   types in `src/protocol/generic/types.ts`.

2. **Device-namespaced surface** (`am4_*`, `axefx2_*`, `hydra_*`) â€”
   first-generation pattern. Kept in parallel through v0.1 because
   the long tool descriptions carry device-specific behavioral
   guidance (AM4: relative-change discipline, tempo-sync model,
   channel/scene semantics, enum-naming conventions, reverb.type
   format) the LLM relies on during tone-building. Slated for removal
   in v0.3 once that guidance migrates into per-device
   `describe_device` responses.

**When adding a new tool, prefer the unified surface.** New device-
namespaced tools are technical debt â€” the unified surface is what
v0.3+ ships exclusively. If a new capability doesn't fit the unified
contract, design the contract change first (extend `DeviceWriter` /
`DeviceReader` / capabilities), then register the unified tool.

**Before adding or substantially modifying a tool, read
`docs/TOOL-AUTHORING-GUIDE.md`.** It captures the patterns the project
has accumulated from senior MCP design reviews: display-first contract,
refuse-don't-misroute on hardware quirks, symmetric capability flags,
snapshot-vs-spec response shape separation, performance characterization
above 1 s, idempotency annotation rules, wire-byte goldens, end-to-end
mocked-agent regression, no-em-dash convention, internal-refs lint
boundary, and the test-infrastructure summary. The guide also lists the
common pitfalls (wire-ack-not-audible, type-gated silent no-op,
opcode-not-portable-across-model-bytes) the codebase has burned cycles
relearning.

## Tool API conventions

**Display-first.** Every MCP tool surface â€” for every device, present
and future â€” accepts and returns **display units** (what a musician
reads on the front panel: `0..10` knob, dB, ms, ratio `4:1`, enum
string `'Plexi 100W High'`). Wire-format details (septet-encoded
14-bit ints, packed-float bytes, `value Ã— scale` fixed-point) are
internal and never leak through tool I/O. Error messages use display
shape too: `"amp.gain out of range [0..10]: 12.5"`, never `"wire value
0x4800 invalid"`.

Display â†” wire coercion happens once at the tool boundary via
`resolveValue` / `resolveEnumValue` (`src/server/shared/paramHelpers.ts`,
`src/fractal/am4/params.ts`). Everything below the tool layer takes
wire and is type-checked against it. Rationale + rejected
alternatives: `docs/_private/DECISIONS.md` (2026-04-28 entry).

## Performance budget

MCP tool calls are part of a conversation. Users tolerate short waits
during overt batch actions, but individual tool calls should feel
instantaneous.

- **Ideal:** < 200 ms per tool call (single `set_param`, `set_block_
  type`, etc.). SysEx round-trips against the AM4 land in 30â€“60 ms,
  with a 300 ms ack window.
- **Acceptable:** < 1 s for tools that make 2â€“5 wire transactions
  (`apply_preset` with a handful of blocks and params).
- **Requires explicit progress:** anything > 1 s must tell the user
  upfront ("This will probe 16 preset locations, ~1 second"). Never
  make the user wait silently.
- **Avoid altogether:** designs that require > 5 s of wire work in a
  single conversational turn. Either cache, batch into a dedicated
  command, or design around the probe.

When writing new tool specs, estimate the wire-round-trip count
up front. SysEx is serial â€” N reads â‰ˆ N Ã— 50 ms minimum. If the math
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
  in `samples/` â€” **the entire directory is gitignored**. Nothing in
  `samples/` is committed; treat it as local debug scratch.
- All reverse-engineering notes go in [`fractal-midi/docs/devices/<device>/SYSEX-MAP.md`](https://github.com/TheAndrewStaker/fractal-midi/tree/main/docs/devices) — protocol-RE is codec-domain and lives in the codec repo.
- All block parameter tables go in `docs/BLOCK-PARAMS.md` (this repo — MCP contract docs).
- Sniffing session logs go in docs/_private/SESSIONS.md
- Tests that require hardware are in tests/integration/ and skipped in CI

## Testing and sign-off

- **`npm run preflight`** is the single command to run before every
  commit. It runs `tsc --noEmit` and then `npm test`, which chains the
  three protocol-layer goldens:
  - `verify-pack` â€” 10-sample pack/unpack round-trip.
  - `verify-msg` â€” built messages vs. captured wire bytes (byte-exact,
    including checksum).
  - `verify-transpile` â€” IR â†’ command sequence goldens.
- `npm test` alone runs just the goldens; handy for iterating on the
  protocol layer without waiting for the typecheck.
- `npm run test:jest` is reserved for future Jest-based unit tests (the
  scaffolding exists; there are no tests yet).
- **When adding a new pidHigh to `params.ts`, add a matching case to
  `verify-msg.ts` built from captured bytes.** That is the only guard
  against misreading septet-encoded pidHighs as little-endian bytes
  (the class of bug that hit Session 08 â€” see SYSEX-MAP.md Â§6a note).

## Broken tests get fixed, not annotated

**No test stays red across sessions, and "not from my changes" is not
an acceptable answer.**

When you run `npm run preflight`, `npm run launch-verify`,
`npm run live-regression`, or `npm run agent-sweep` and a check fails,
that failure is your responsibility regardless of when it was introduced.
The codebase carries enough red tests for two reasons over time and
both are unacceptable:

- Agents say "this failure pre-existed on baseline" and move on. Even
  when factually true (you can `git stash` and confirm), this leaves
  the test red for the next agent, who repeats the same defense.
  After three sessions, nobody knows whether the test is wrong, the
  code is wrong, or both.
- The release-gate stops being a gate. If 22/24 is the new normal,
  the next regression hides in the noise.

**Workflow when a check fails:**

1. Investigate root cause. If the failure is in code you didn't touch,
   that's a clue, not an exit. Read the assertion + the production
   behavior. One of them is wrong.
2. Pick the fix that matches reality. Common patterns:
   - Behavior changed deliberately (e.g. dispatcher switched from
     throw to structured `{ok: false, validation_errors: [...]}` per
     BK-059), assertion is stale â†’ update the assertion to recognize
     the new shape. Document why in the test file's comment.
   - Behavior regressed accidentally â†’ fix the code.
   - Test was always flaky â†’ make it deterministic or delete it.
     Never `skip` it with a "fix later" comment.
3. Run the full suite (`npm run release-gate` if hardware connected,
   otherwise `npm run preflight && npm run launch-verify`) and confirm
   the count went UP, not just "didn't get worse."
4. If you cannot fix the failure in this session, **escalate to the
   founder before declaring work complete**. Don't silently leave a
   red test for the next agent.

**Adding new tests:** if you ship a new MCP tool, capability, or
codepath, add coverage in the appropriate suite the same session:
- New unified tool â†’ case in `scripts/launch-verification.ts`.
- New device capability that requires hardware â†’ case in
  `scripts/live-regression.ts`. Self-restoring mutations only.
- New agent-facing tool description or alias â†’ case in
  `scripts/agent-regression/cases-<device>.ts`.
- New wire builder / parser â†’ golden in `scripts/verify-msg.ts` or
  `scripts/verify-pack.ts`.

The rule: every failing test gets fixed in the session that surfaces it,
and every shipped feature has live coverage before the session ends.

## Verification sources of truth

For any test that needs to confirm "what does the device actually hold
right now," trust these in order:

1. **Front panel display** on the hardware itself. Ground truth.
2. **`axefx2_get_param` / `am4_get_param` response**. The device echoes
   its own display label in the response payload, so this is the wire-
   level truth as the device understands it.
3. **AxeEdit / AM4-Edit panel display.** Useful but **not authoritative**
   â€” editor apps cache UI state (HW-086 example: freshly-placed
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

1. **`npm run preflight`** â€” per-package typecheck + goldens pass.
2. **`npm run build`** â€” rebuilds every package in dependency order
   (`@mcp-midi-control/core` â†’ `@mcp-midi-control/am4|axe-fx-ii|
   hydrasynth` â†’ `@mcp-midi-control/server-all`) and copies
   lineage JSON into `packages/core/dist/fractal-shared/lineage/`.
3. **Tell the founder to fully quit and relaunch Claude Desktop.** Just
   closing the window keeps the MCP server child alive in the tray â€” it
   has to be a full quit. The relaunch respawns the child from the new
   dist.

If you only changed `scripts/` (run via `tsx`, never dist), `docs/`,
or `samples/` â€” preflight is enough; no rebuild needed.

**Default at session end:** if you've edited any TypeScript under
`src/` and the next user step is testing in Claude Desktop, run
`npm run build` and surface the relaunch reminder in your wrap-up.

## Living documentation â€” update before declaring a session complete

Certain docs must stay current because future sessions (human and
Claude) consult them as source of truth. When the underlying thing
changes, the doc must change in the same session â€” not as a followup.
Cheaper than discovering drift later.

| Doc | Update whenâ€¦ |
|---|---|
| `docs/_private/STATE.md` | A substantive session happens. Always â€” it's the session-start orientation doc. Update "single next action" and any relevant "recent breakthroughs" entry. |
| `docs/_private/PROMPT-COVERAGE.md` | A new MCP tool ships, a protocol decode lands, or founder testing surfaces a new user prompt pattern. Flip âš  â†’ âœ… when the blocker clears; flip âŒ â†’ âš  when a research item gets a concrete decode plan; add new rows for unanticipated prompts. |
| `docs/_private/HARDWARE-TASKS.md` | A HW-NNN item completes (mark âœ… + capture outcome), or a new hardware action is identified that Claude can't perform alone (append HW-NNN with step-by-step instructions). |
| `docs/_private/04-BACKLOG.md` | A new backlog item is identified, an existing item ships / re-scopes / is superseded, or a cross-reference between items is worth recording. |
| per-device wire maps in fractal-midi: https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/ | A new protocol decode is confirmed against captured bytes. Include the concrete capture reference and byte-exact example. (Public â€” protocol RE is the OSS public good.) |
| `docs/_private/SESSIONS.md` | A session produces a substantive finding worth a chronological entry (decodes, major tool changes, hardware-verified behavior). STATE.md is the summary; SESSIONS.md is the log. |
| `docs/_private/DECISIONS.md` | A non-obvious architectural or library choice is made. (Founder-private; gitignored. Useful to Claude Code agents working locally; not surfaced to OSS contributors.) |

**Session-wrap check.** Before declaring work complete, walk the table
above and update whichever rows apply to what changed. A one-line
reply at session end naming which docs were updated helps the founder
verify nothing was missed.

## Do Not
- Do not use AM4-Edit as a dependency or requirement
- Do not hardcode preset-location values â€” always use the A01â€“Z04 naming
- Do not skip the safety read before any write operation
- Do not guess parameter names â€” verify against AM4 manual or sniffed data
- Do not issue any preset-store / save-to-location SysEx command from
  `scripts/probe.ts`. Probe is read-only forever.
- Do not auto-save after `apply_preset` â€” saves require an explicit
  save phrase from the user ("save this", "put it on M03", "keep it").
  `apply_preset` is reversible (switching presets discards the working
  buffer); save is not.
- Before overwriting a non-empty preset location, confirm with the
  user â€” read the current contents, surface what's there, and ask
  before clobbering. **Z04 remains the conventional scratch location**
  for try-it-out work; the historical hard-gate to Z04 was lifted
  Session 49 once HW-064 confirmed save-to-inactive-location is a
  real workflow (founder builds multiple presets per session by
  saving to different locations from the same working buffer).

