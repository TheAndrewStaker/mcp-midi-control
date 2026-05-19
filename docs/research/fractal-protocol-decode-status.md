# Fractal protocol decode — status & references

**One-stop reference** for the cross-device Fractal protocol RE
work. If you're a new session (human or agent) trying to figure
out "what do we know about the Fractal protocol family, and where
is everything documented?", start here.

Last meaningful update: Session 97 (2026-05-18 — III SET_PARAMETER
pivot: open-web research surfaced 6 byte-exact public captures
(Mountain Utilities forum, gabbernutter 2019) that contradicted the
shipping `fn=0x02` II-port envelope and corroborated the project's
own pre-existing `fn=0x01` decode. Combined with the 4 FC-12 captures
in `docs/devices/axe-fx-iii/fn01-decode.md`, the corpus is now **10 captures from
2 community sources** on `fn=0x01`. `packages/axe-fx-iii/src/setParam.ts`
pivoted to `fn=0x01` + sub-action `09 00` (typed-input SET); 4 encoder
goldens + 4 capture-parse goldens added in
`scripts/verify-axe-fx-iii-encoding.ts`. Capture provenance archived
in `docs/devices/axe-fx-iii/set-parameter-captures.md`. SET 🟡 → 🟢; GET still 🟡
(no captured response frames). HW-AXEFX3-002 reframed from "verify the
shipping envelope" to "verify the device responds to the captured
envelope shape" — still contributor-gated, but the SET wire shape no
longer needs hardware validation. Also Session 97 closed 15 more AM4
UI-MISSING entries (PEQ/COMP/GATE/INPUT/CHORUS/TREMOLO/ENHANCER),
lifting AM4 placeable coverage **91% → 93%**; drift guard
`WIRED_MISLABEL_CEILING=161 → 167`.

Prior meaningful update: Session 96 (2026-05-17 / 18 — HW-112 closed
(AM4 GLOBAL family `pidLow=0x0001` cracked + 98 entries wired);
HW-109 closed (Hydrasynth envelope time wire→ms tables verified
across 27 sample points); HW-105 closed (Axe-Fx II `apply_setlist`
3-preset round-trip on Q8.02 XL+); UI-MISSING closeout across PATCH /
CABINET / DISTORT lifted AM4 placeable coverage 84% → 91%;
`displayLabel` resolver landed in `list_params` `display_name` +
116-entry XML splice pass on shipped entries; cross-ref audit drift
guard at `WIRED_MISLABEL_CEILING=161` bumped from 154 for the
7 intentional context-disambig MISLABELs in the UI-MISSING closeout).

> **Run `npm run coverage-audit` before trusting any state claim in
> this doc.** The audit reads `packages/*/src/params.ts` +
> `scripts/verify-msg.ts` directly and reports current AM4-placeable
> coverage by-device — most reliable single-command answer to "where
> are we?" As of Session 96: AM4 placeable coverage is **91%**
> (716 catalog entries / 741 placeable params.ts entries; 791 total
> entries in `packages/am4/src/params.ts` once GLOBAL's 98 system-
> settings entries and CABINET cross-block bonus are counted). 183
> distinct (pidLow, pidHigh) goldens carry byte-exact wire tests
> in `scripts/verify-msg.ts`. Cross-ref audit
> (`scripts/_research/coverage-cross-ref-audit.ts`) joins Ghidra
> catalog ↔ AM4-Edit XML ↔ `params.ts` and currently reports
> **WIRED-MATCHED=585 / WIRED-MISLABEL=161 / UI-MISSING=28 /
> GHOST=49 / PIDLOW-UNKNOWN=909**. Wired into preflight as a drift
> guard at `WIRED_MISLABEL_CEILING=161`. (Note: GLOBAL family is now
> classified via `PIDLOW_TO_FAMILY[0x0001]='GLOBAL'` with a per-family
> carve-out that treats GLOBAL entries as WIRED-MATCHED whenever
> the wire address is bound — GLOBAL's `name` field is the canonical
> wire symbol; the user-facing label is surfaced via `displayLabel`.)

---

## Devices covered

| Device | Model byte | Protocol family | Editor binary | Ghidra project | Decode state |
|---|---|---|---|---|---|
| AM4 | `0x15` | Axe-Fx III (subset + extensions) | `AM4-Edit.exe` | `C:\Users\Steph\ghidra-am4-edit.gpr` | **Most complete.** 791 entries in `packages/am4/src/params.ts` (741 placeable + 98 GLOBAL system-settings + cross-block bonus); placeable coverage **91%** of AM4-placeable catalog. PATCH family closed Sessions 84–87 (routing — §6n-patch; scene-MIDI 48 params — §6n-scene-midi; scene-MIDI test-send partial — §6n-scene-midi-test, HW-111 open). **GLOBAL family closed Session 96** (`pidLow=0x0001` cracked from `samples/captured/session-95-am4-global-pidlow.pcapng`; 98 entries wired; see `docs/devices/am4/SYSEX-MAP.md` §6bb). **UI-MISSING closeout Session 96** added 50 PATCH / CABINET / DISTORT entries from the AM4-Edit XML → Ghidra catalog join (`scripts/_research/list-ui-missing.ts`). 1732 paramId/name pairs across 47 families mined Session 82 (catalog). Optional `displayLabel` field generated from AM4-Edit XML, now surfaced through `list_params` `display_name` resolver (Session 96); 116-entry XML splice pass made every MISLABEL entry resolver-friendly. Cross-ref audit: WIRED-MATCHED=585 / WIRED-MISLABEL=161 / UI-MISSING=28 / GHOST=49. |
| Axe-Fx III | `0x10` | Axe-Fx III (full spec + community RE) | `Axe-Edit III.exe` (v1.14.31) | `C:\Users\Steph\ghidra-axe-edit-3.gpr` | **Most of decode shipped via open-web captures, no III hardware needed.** v1.4 PDF opcodes shipping (bypass/channel/scene/tempo/looper/status). Ghidra Session 82 mined **2,216 paramIds across 49 families** + **21 fn bytes confirmed in binary** (vs 10 in v1.4 PDF). **Session 97 PIVOT**: SET_PARAMETER is `fn=0x01` + sub-action `09 00` (typed-input), 23-byte envelope — NOT `fn=0x02` as Sessions 85+86 had ported from II. Byte-verified against 10 public captures spanning two effect blocks (Drive 1/2 boost, Delay 1 TIME) and two sub-action codes (`09 00` typed-input + `52 00` mouse-drag) from FC-12 forum scrape (Session 79) + Mountain Utilities forum scrape (Session 97, gabbernutter 2019). Capture provenance: `docs/devices/axe-fx-iii/set-parameter-captures.md`. 4 encoder + 4 capture-parse goldens in `scripts/verify-axe-fx-iii-encoding.ts`. **SET wire 🟢; GET wire 🟡** (no captured response frames — the III's actual state-feedback channel appears to be the unsolicited `04 01` STATE_BROADCAST sub-action). HW-AXEFX3-002 reframed from "verify the shipping envelope" to "verify the device responds to the captured envelope shape" — still contributor-gated, but the SET wire no longer needs hardware validation. Preset-save 0x77/0x78/0x79 community-known (forum thread #159885 archived). **Session 97 cont 7 (2026-05-18): III lifted to Codec ✅ + Calibration ✅ in `fractal-midi` repo** — 302 round-trip codec goldens (build → parse → equality across 264 cases + 2 parseStateBroadcast assertions), `enumOverlay.ts` runtime vocabulary module with `provenance` tagging, `apply-calibration-overlay.ts` post-gen pass drove `'unverified'` 572 → 16 (string-typed only, exempted), calibration acceptance gate at `test/axe-fx-iii/calibration.test.ts`. The Phase-A mechanism is the template for FM3/FM9 — see `fractal-midi-extraction-plan.md` §"Post-extraction." |
| Axe-Fx II XL+ | `0x07` | Axe-Fx II (separate family) | `Axe-Edit.exe` | `C:\Users\Steph\ghidra-axe-edit.gpr` | **1,126 params shipping** via wiki + capture decode + Session 94 Ghidra direct-pattern-scan addendum (221 net-new entries). `0x02 SET_PARAMETER` hardware-verified (HW-075 / HW-077). `apply_setlist` 3-preset round-trip hardware-verified on Q8.02 XL+ (HW-105, Session 96 cont). Earlier "skip Ghidra for II" recommendation overturned Session 94 — the 32-bit binary's param tables are recoverable via byte-pattern scan even when dispatcher xrefs fail; see `scripts/ghidra/SeekParamTablesII.java`. |
| Hydrasynth (line) | (vendor: ASM, not Fractal) | NRPN-based | n/a | n/a | Functional but separate workstream — included here for cross-reference. Founder owns the Explorer model; same SysEx/NRPN engine across Keyboard / Deluxe / Desktop / Explorer per ASM. HW-109 closed Session 95 — envelope time wire→ms mapping verified across 27 sample points; `packages/hydrasynth/src/nrpnDisplay.ts` `timeTable` confirmed zero-correction against device. Verify script: `scripts/hydrasynth/verify-nrpn-display.ts`. |
| FM3 / FM9 / VP4 | `0x11` / `0x12` / `0x14` | Axe-Fx III family | (TBD if we add) | (TBD) | Not yet pursued. The III's Phase-A lift in `fractal-midi` (Session 97 cont 7 — round-trip codec goldens + post-gen calibration overlay + enum vocabulary module + acceptance gate) is the template for FM3/FM9. See `fractal-midi-extraction-plan.md` §"Post-extraction — III calibration ✅ + FM3/FM9 add" for the per-step plan. Founder action needed: pull FM3-Edit + FM9-Edit installers and extract JUCE BinaryData into `samples/captured/decoded/binarydata/{fm3,fm9}-edit-allzips/extracted/`. |

---

## What's in each doc

### Wire-format references (committed, public)

| Doc | Covers |
|---|---|
| [`docs/devices/am4/SYSEX-MAP.md`](devices/am4/SYSEX-MAP.md) | AM4 wire spec. §6a is the `0x01` SET_PARAM dispatcher; §6p is the canonical Session-82-83 finding: `pidLow=block, pidHigh=catalog paramId`. §6b value encoding (8-to-7 bit-pack), §6c block placement, §6k cab cross-block, §6l Main Levels (Session 84 — `preset.level / balance / scene_{1..4}_level`), §6m preset-name read, §6n-patch PATCH routing (Session 84), §6n-scene-midi 48 scene-MIDI params (Session 85+86), §6n-scene-midi-test test-send wire frame `action=0x0004 / pidHigh=0x0070` (Session 87 cont 🟡 partial — HW-111), §6bb GLOBAL family `pidLow=0x0001` (Session 96 — system settings, float32 LE encoding, enum ints packed as floats). |
| [`docs/devices/axe-fx-iii/SYSEX-MAP.md`](devices/axe-fx-iii/SYSEX-MAP.md) | III wire spec. Covers v1.4 PDF (10 documented functions) + 21 fn bytes confirmed via Ghidra caller trace + the 49-effect dispatcher catalog. **§0x02 SET_PARAMETER** documents the II→III port (model byte `0x03`→`0x10`, Sessions 85+86) with community-evidence chain and the one-call test that converts 🟡→🟢. Documents what III's SET_PARAM ISN'T (fn=0x1f ruled out Session 83). |
| [`docs/devices/axe-fx-ii/SYSEX-MAP.md`](devices/axe-fx-ii/SYSEX-MAP.md) | II wire spec — community RE work + Session 94 Ghidra direct-scan addendum. |
| [`docs/BLOCK-PARAMS.md`](BLOCK-PARAMS.md) | AM4 block reference. Header table maps each AM4 block to its pidLow, catalog family, dispatcher case, and catalog param count. Points at the Ghidra catalog as the primary source. |
| [`docs/research/ghidra-mining-workflow.md`](ghidra-mining-workflow.md) | **Workflow recipe**: how to mine a new Fractal editor binary. Captures the 3-tier proven technique, v1 failure modes to avoid, dispatcher discovery, ParamDescriptor struct layout, headless runner pattern, cross-block addressing pattern. Session 94 addendum: direct-pattern-scan technique for 32-bit binaries where dispatcher-xref fails. Read this first before opening a new Ghidra project. |
| [`docs/research/fractal-midi-extraction-plan.md`](fractal-midi-extraction-plan.md) | **Vendor protocol package plan** (Session 94). Per-file move table covering `packages/core/src/fractal-shared/`, `packages/am4/src/`, `packages/axe-fx-ii/src/`, `packages/axe-fx-iii/src/`; consumer-facing API surface for `fractal-midi` (codec-only, no `node-midi`). |

### Research / decode-history (committed)

| Doc | Covers |
|---|---|
| [`docs/devices/axe-fx-iii/fn01-decode.md`](devices/axe-fx-iii/fn01-decode.md) | III function 0x01 — three-mode envelope. Session 81-82 RE work. |
| [`docs/devices/axe-fx-iii/preset-format-research.md`](devices/axe-fx-iii/preset-format-research.md) | III preset-save format research (forum thread #159885 archive). |
| [`docs/devices/axe-fx-ii/community-re-methodology.md`](devices/axe-fx-ii/community-re-methodology.md) | II community RE methodology background. |
| `docs/_private/DECISIONS.md` (founder-private; gitignored) | Architectural decisions. 2026-05-16 entry covers the Ghidra-as-canonical-RE-method decision. 2026-05-17 entry locks in the `fractal-midi` vendor-package split. |

### Ghidra outputs (gitignored — regenerate locally)

All under `samples/captured/decoded/`:

| File | How to regenerate |
|---|---|
| `ghidra-am4-paramnames.json` | `scripts/ghidra/run-am4-paramnames.cmd` |
| `ghidra-axeedit3-paramnames.json` | `scripts/ghidra/run-axeedit3-paramnames.cmd` |
| `ghidra-axeedit3-message-builders.txt` | `scripts/ghidra/run-axeedit3-message-builders.cmd` |
| `ghidra-axeedit3-v2.txt` (mining sweep) | `scripts/ghidra/run-axeedit3-v2.cmd` (if exists; else run via GUI) |
| `am4-params-proposed.ts` | `npx tsx scripts/_research/generate-am4-params-from-catalog.ts` |
| `am4-coverage-report.md` | `npx tsx scripts/_research/am4-catalog-coverage-report.ts` |

---

## Ghidra scripts (committed, regenerate outputs locally)

Under `scripts/ghidra/`:

### Per-device scripts

| Script | Targets | Purpose |
|---|---|---|
| `MineAxeEditIII.java` / `MineAxeEditIIIv2.java` | Axe-Edit III.exe | Broad protocol-string sweep — symbol-table walk + byte-pattern hits + instruction-walk fallback |
| `MineAxeEditIIIParamResolver.java` | Axe-Edit III.exe | Rank functions by # of param-symbol references — identifies the dispatcher |
| `DumpAxeEditIIIParamNames.java` | Axe-Edit III.exe | Extract per-effect `(paramId, name)` pairs from the dispatcher |
| `DumpAxeEditIIIParamTables.java` / `V2.java` | Axe-Edit III.exe | Earlier table-extraction iterations (superseded by ParamNames) |
| `TraceAxeEditIIIMessageBuilders.java` | Axe-Edit III.exe | Walk callers of generic SysEx builders to enumerate fn bytes |
| `MineAM4EditParamResolver.java` | AM4-Edit.exe | AM4 equivalent of the III resolver script |
| `DumpAM4ParamNames.java` | AM4-Edit.exe | AM4 equivalent of the III param-names dumper |
| `MineAxeEditIIParamResolver.java` | Axe-Edit.exe (II) | II equivalent — dispatcher-xref dead end on the 32-bit binary; see SeekParamTablesII instead |
| `SeekParamTablesII.java` | Axe-Edit.exe (II) | **Session 94 direct-pattern-scan miner.** Recovers 1,113 (paramId, symbol) entries from the 32-bit II binary at 99% indexed-symbol coverage; works even when dispatcher xrefs fail. Output post-processed by `scripts/_research/generate-axe-fx-ii-params-from-ghidra.ts`. |
| `run-*.cmd` | (runners) | Headless invocation wrappers |
| Earlier-era scripts (`FindEncoder.java`, `FindAxeEditRouting.java`, etc.) | AM4-Edit / II | Original techniques the Session 82-83 work was built on |

### Analysis helpers (TypeScript)

Under `scripts/_research/`:

| Script | Purpose |
|---|---|
| `survey-axeedit3-anchors.ts` | Bucket strings JSON by prefix family to pick Ghidra anchors |
| `analyze-param-symbol-tables.ts` | Find contiguous runs in offset-sorted string lists |
| `find-axeedit3-sysex-fnbyte-array.ts` | Scan binary for parallel fn-byte arrays (negative result on III) |
| `mine-axeedit3-sysex-table.ts` | Extract+sort SYSEX_* strings |
| `parse-ghidra-axeedit3-mine.ts` | Post-Ghidra structured extraction (switch cases, decompile blocks) |
| `compare-am4-params-coverage.ts` / `v2.ts` | Audit params.ts against Ghidra catalog |
| `generate-am4-params-from-catalog.ts` | Emit proposed `params.ts` entries from catalog (verified wire mapping) |
| `generate-axe-fx-ii-params-from-ghidra.ts` | Emit proposed II `params.ts` entries from Session 94 direct-scan output, preserving the hardware-verified header + Ghidra addendum block across regens |
| `validate-params-against-catalog.ts` | Validate `params.ts` correctness against catalog + blockTypes.ts |
| `am4-catalog-coverage-report.ts` | Emit per-block markdown coverage report |
| `coverage-cross-ref-audit.ts` | **Three-way join (catalog ↔ XML ↔ params.ts)** — Session 87 cont, refreshed Session 96 with GLOBAL family classification + carve-out. Classifies every catalog entry as WIRED-MATCHED / WIRED-MISLABEL / UI-MISSING / GHOST / PIDLOW-UNKNOWN. Wired into preflight as a drift guard at `WIRED_MISLABEL_CEILING=161`. Output: `samples/captured/decoded/coverage-cross-ref-audit.md` |
| `list-ui-missing.ts` | Session 96 — uncapped UI-MISSING dump for one or more families (the shipping audit caps at top 50). `npx tsx scripts/_research/list-ui-missing.ts PATCH CABINET DISTORT` |
| `list-mislabel-without-displaylabel.ts` | Session 96 — surfaces WIRED-MISLABEL entries that the `displayLabel` resolver doesn't already cover. Drives the idempotent label-splice pass. |
| `inplace-patch-display-labels.ts` | Session 96 — idempotent regenerator. Joins (block_pidLow, pidHigh) → Ghidra catalog symbol → AM4-Edit XML label, splices `displayLabel: "..."` into any entry that doesn't already have one. Safe to re-run. |
| `generate-am4-global-block.ts` | Session 96 — regenerates the GLOBAL family params.ts block (98 entries under pidLow=0x0001) from the Ghidra catalog + XML labels. Source-of-truth for HW-112-derived GLOBAL entries. |
| `add-display-labels.ts` | Idempotent generator that populates the optional `displayLabel` field on `params.ts` entries from AM4-Edit XML |
| `decode-session-85-scene-midi.ts` | Decode scene-MIDI captures into 16-msg Type/Channel/Value rows (Session 85+86) |
| `decode-hw110.ts` | Decode HW-110 scene-MIDI test-send capture (Session 87 cont) |
| `probe-dirty-gate.ts` | Regression probe that hashes the AM4 working buffer twice + asserts dirty-after-set_param differs + asserts switch_preset refuses with structured warning. Locks in the Session 87 SysEx assembler fix. |

---

## Key findings cheat sheet

### Wire mapping (verified 99% on AM4)

- `pidLow` = block-type pidLow from `packages/am4/src/blockTypes.ts`
- `pidHigh` ≥ 10 = Ghidra catalog paramId for that block's family
- `pidHigh` 0-9 = generic shared params (0=level, 1=mix, 2=balance, 4=bypass_mode; 7+8 partially documented)
- `pidHigh` = 0x07D2 (2002) = channel-select register (separate code path)

### Cross-block addressing on AM4

- AMP + DRIVE both pull from DISTORT family (case 0xa, 143 params).
  AMP via `pidLow=0x003a`, DRIVE via `pidLow=0x0076`.
- AMP has NO separate dispatcher case. Closes the Session 82
  "missing AMP dispatcher" question.

### Non-placeable addressable blocks

These pidLows are addressable but not in `BLOCK_TYPE_VALUES`:

- `0x0025` Input Noise Gate (`ingate.*`, INPUT family)
- `0x003e` Cabinet (CABINET family, §6k)
- `0x00CE` PATCH family (case 0x3c, 85 params — preset.level/balance, scene_{1..4}_level, routing_slot_{2,3,4}, scene_{1..4}_midi_{1..4}_{type,channel,value}). Decoded Sessions 84–86 — §6n-patch + §6n-scene-midi. The PATCH `PATCH_SCENE_OUTPUT1..4` entries are NOT a phantom per-scene output mode — they're the Scene N Level knobs already shipping at `preset.scene_{1..4}_level` (Session 87 cont closure). `PATCH_4CM` is a firmware ghost with no AM4-Edit UI (4CM on AM4 is a wiring pattern, not a software toggle).
- `0x0001` GLOBAL family (case 0x1, 99 paramIds in catalog — system settings: USB level, tap-tempo mode, tuner reference, delay spillover, etc.). Closed Session 96 — see `docs/devices/am4/SYSEX-MAP.md` §6bb. 98 entries wired into `packages/am4/src/params.ts` under `block: 'global'`; two byte-exact verify-msg goldens (`global.usblevel1`, `global.tap_tempo_mode`) confirm the dispatcher path. Wire-value encoding: float32 little-endian written into the standard SET_PARAM tail (enum ints packed as floats — e.g. `GLOBAL_TAP_TEMPO_MODE = 1.0` = "Last Two").

### Transport-layer fix (Session 87)

`packages/core/src/midi/transport.ts:createSysExAssembler` (pure
exported function, ~50 LOC) buffers bytes between F0…F7 across
multiple WinMM callbacks before invoking downstream handlers.
RtMidi's WinMM input callback delivers SysEx in 1024-byte chunks
without waiting for `F7`, so a 3082-byte AM4 preset dump arrived
as 3–4 separate `message` events and the dirty-gate's preset-dump
receiver rejected every chunk as malformed → fingerprint cache
never populated → every navigation silently discarded dirty edits.
The fix is wired into `connect()` and covered by 7 byte-exact
goldens in `scripts/verify-sysex-assembler.ts` (3082-byte AM4
4-fragment case, 2KB 2-fragment case, single-fragment, back-to-
back SysEx, interleave, empty fragments). Affects every device
that reads messages >1024 bytes (AM4 preset dumps + factory
restore; II preset dumps are larger).

### III function-byte inventory (Session 82-83)

21 fn bytes confirmed via FUN_1403437d0 caller trace, vs 10 in v1.4 PDF:

`0x0A 0x0B 0x0C 0x0D 0x0E 0x0F 0x10 0x11 0x12 0x13 0x14 0x19 0x1A 0x1B 0x1F 0x3F 0x40 0x46 0x47 0x5A 0x5B 0x5C 0x74 0x75 0x76 0x77 0x78 0x79 0x7A 0x7B 0x7C`

III SET_PARAM status: **🟡 shipped untested** as `fn=0x02` ported from II by model-byte swap `0x03`→`0x10` (Sessions 85+86). fn=0x1f was the original suspect from a pre-port Session 83 walk-back; caller decompile shows it only carries a 16-bit payload, too small for SET_PARAM. One III hardware test (HW-AXEFX3-002 — `axefx3_get_parameter(block="Reverb 1", param_id=0)` against a scratch preset) converts the envelope 🟡→🟢 and unlocks all 2,216 III paramIds for SET_PARAM. See `docs/devices/axe-fx-iii/SYSEX-MAP.md §0x02 SET_PARAMETER` for the three-outcome decision tree.

---

## Open questions / next-session candidates

In rough order of impact:

1. **Verify the III responds to the byte-verified `fn=0x01` SET_PARAMETER envelope on real hardware** (Session 97 pivot) — wire shape now byte-verified against 10 public captures (`docs/devices/axe-fx-iii/set-parameter-captures.md`); what remains is confirming the device actually honors AxeEdit III's captured wire when re-sent by our MCP tool, AND decoding the response shape (sync echo? STATE_BROADCAST? silent?). The project maintainer doesn't own a III. A III-owning contributor running `axefx3_set_parameter(block="Reverb 1", param_id=0, value=N)` against a scratch preset and reporting the audible effect + any inbound bytes closes the remaining 🟡 GET shape and confirms SET 🟢 end-to-end. See [`docs/AXEFX3-BETA-TESTING.md`](AXEFX3-BETA-TESTING.md) for the contributor on-ramp.

2. **Close the 79 UI-MISSING AM4 params** — wired gaps where the catalog has the symbol AND XML exposes the control AND `params.ts` has no entry. Current top families per cross-ref audit: PATCH (29), DISTORT (19), CABINET (13), COMP (4), PEQ (2), GEQ (1), TREMOLO (2), GATE (1), CHORUS (1), ENHANCER (1), VOLUME (1), INPUT (5). Each needs a capture or AM4-Edit screenshot for range/unit (the catalog doesn't carry those). Route through `paramNames.ts` overrides not direct `params.ts` edits — blunt blind-merge corrupts unit metadata (Session 84 bug pattern).

3. **HW-111 — decode the scene-MIDI test-send per-row payload byte packing** (Session 87 cont). Per-scene "Send All" payload fully decoded: `byte[2] = (scene_idx<<5) | 0x0F`. Per-row payload partial. Closes SYSEX-MAP §6n-scene-midi-test from 🟡 → 🟢. P3, non-blocking.

4. **WIRED-MISLABEL review pass** (161 entries, ceiling at `WIRED_MISLABEL_CEILING=161`). After the Session 96 `displayLabel` resolver + 116-entry XML splice, every MISLABEL entry already surfaces the friendly AM4-Edit label to the LLM via `display_name` — the underlying `name`-vs-XML mismatch is a cosmetic audit metric, not a UX gap. Most are intentional disambiguation (cabinet `_1`/`_2` pairs, COMP `sidechain_*` prefixes, four `delay.lfo_{1,2,3,4}_type` entries all displaying as "LFO Type"). Targeted reviews tightened the count Sessions 90 / 95; further passes could lower the ceiling but the agent-facing UX is already covered by `displayLabel`. Use `scripts/_research/list-mislabel-without-displaylabel.ts` to find entries that still need `displayLabel` attention.

5. **action=0x0017 anomaly trigger still unknown.** Session 87 cont ruled out test-send buttons via HW-110 (16 per-row + 4 per-scene clicks → zero `action=0x0017` frames; test-send fires `action=0x0004 / pidHigh=0x0070` instead). Next candidate hypotheses: "Quick Build" button or another page-level AM4-Edit action. NOT blocking any user-facing feature.

6. **Investigate generic `pidHigh` 7 and 8** — currently seen on `delay.kill_dry` and `amp.out_boost_level` respectively. Are they cross-block (a fifth and sixth generic slot) or block-specific overflows?

7. **Verify `amp.cab1_distance` `pidHigh`** — ~~validator-flagged~~ **resolved Session 83**: hardware-verified at pidHigh=0x02 under cab pidLow=0x3e (cross-block addressing per §6k). Ghidra catalog's `CABINET_PROXIMITY1` (paramId 20) is a separate unbound cab param. Kept here as a pointer; not a real open question.

8. **`SYSEX_DSP_MESSAGE` decode** — confirmed string in III binary, fn byte unknown. Would unlock `get_dsp_usage` per Session 78 forum-wishlist Item 3.

9. **AM4-Edit alternate dispatcher hunt** — case 0x3a in `FUN_1402e3da0` returns an empty table. What's its purpose? (Same on III's `FUN_140397a40`.) Are there OTHER dispatchers we haven't found?

10. **Cross-publish AM4 / III catalogs** — both binaries use the same Fractal symbolic names. A shared `fractal-shared/catalog/` package could centralize the per-family paramId enums (so amp.gain on AM4 and reverb.time on III both pull canonical names from one source). Architectural — would prep BK-051 unified surface. Some of this prep landed Session 94 (`docs/research/fractal-midi-extraction-plan.md`).

**Closed since last update:**

- ~~Capture AM4 GLOBAL block pidLow~~ — closed Session 96 (HW-112): `pidLow=0x0001`, 98 entries wired, see SYSEX-MAP §6bb. Wire encoding: float32 LE, enum ints packed as floats.
- ~~Hydrasynth envelope time wire→ms decode~~ — closed Session 95 (HW-109): 27 (N, display) pairs verified front-panel against `packages/hydrasynth/src/nrpnDisplay.ts` timeTable; zero corrections needed. Verify script `scripts/hydrasynth/verify-nrpn-display.ts` now ships 39 hardware-locked goldens (was 12).
- ~~Axe-Fx II `apply_setlist` 3-preset round-trip~~ — closed Session 96 cont (HW-105): hardware-verified on Q8.02 XL+ via Claude Desktop; safe-edit overwrite gate confirmed working.
- ~~"Skip Ghidra for II" recommendation~~ — overturned Session 94: direct-pattern-scan (`scripts/ghidra/SeekParamTablesII.java`) recovered 1,113 (paramId, symbol) entries at 99% indexed-symbol coverage; 221 net-new params merged into `packages/axe-fx-ii/src/params.ts` (Session 94 addendum). 32-bit dispatcher-xref is still a dead end, but byte-pattern scan is not.
- ~~Capture AM4 PATCH block pidLow~~ — closed Session 84 (`pidLow=0x00CE`, §6n-patch).
- ~~Decode the 0x3e81 action=0x0017 scene-MIDI anomaly~~ — decoupled Session 85+86: scene-MIDI uses standard `action=0x0001 SET_PARAM`; the 0x0017 anomaly is a different (unknown-trigger) operation.
- ~~PATCH_SCENE_OUTPUT1..4 + PATCH_4CM coverage gaps~~ — closed Session 87 cont: the SCENE_OUTPUT entries ARE the Scene N Level knobs (already shipping); `PATCH_4CM` is a firmware ghost with no UI.
- ~~SysEx fragmentation breaking AM4 dirty-gate~~ — closed Session 87 (`createSysExAssembler` in `transport.ts` + 7 goldens).

---

## Where to find what

| Question | Answer |
|---|---|
| What does a SysEx envelope look like? | `docs/devices/am4/SYSEX-MAP.md` §2, `docs/devices/axe-fx-iii/SYSEX-MAP.md` "Envelope" |
| What pidLow does block X use? | `packages/am4/src/blockTypes.ts` (placeable) + `docs/devices/am4/SYSEX-MAP.md` §6p (non-placeable: cab, ingate, patch, global) |
| What params does block X have? | `samples/captured/decoded/ghidra-am4-paramnames.json` (regenerate via `.cmd`) + coverage report |
| What's verified vs hypothesized? | This doc's "Devices covered" + "Open questions" |
| How do I decode a new Fractal device? | `docs/research/ghidra-mining-workflow.md` |
| Why does AMP share DISTORT? | `docs/devices/am4/SYSEX-MAP.md` §6p + this doc's cross-block section |
| What's the next high-impact decode work? | This doc's "Open questions" — items 1-4 are the unlocks |

---

## Session log (high-level)

- **Sessions 1-77**: AM4 protocol reverse-engineering via USB capture
  + hand-decode. Built `params.ts` (~400 entries), all 4 slots, scenes,
  channels, preset save/rename. Detailed in `docs/_private/SESSIONS.md`
  (gitignored — founder's local log).
- **Session 78-79**: Mock transport for agent-regression; III forum-
  scrape research; III function 0x01 decode.
- **Session 80-81**: III 0x64 result-code table extracted from AxeEdit
  III binary (28 codes); III v1.4 non-addressable IDs marked
  (ID_CONTROL, ID_MIDIBLOCK, ID_FOOTCONTROLLER, ID_PRESET_FC).
- **Session 82** (2026-05-16): **Ghidra mining sweep**. Extracted
  full per-effect param dictionaries for AM4 (1732 pairs / 47
  families) and III (2,216 pairs / 49 families). 21 III fn bytes
  confirmed via caller trace.
- **Session 83** (2026-05-16 overnight): **AMP=DISTORT closure +
  documentation hardening**. Validator, coverage report, full
  workflow recipe, II mining script staged. fn=0x1f walk-back.
- **Session 84** (2026-05-16): **Two AM4 hardware decodes closed in
  one session.** HW-067a Main Levels (`preset.level / balance /
  scene_{1..4}_level`, §6l). PATCH family (`pidLow=0x00CE`,
  §6n-patch) — routing toggles, 10 new MCP params, 185/185
  verify-msg goldens green.
- **Sessions 85+86** (2026-05-16): **Scene-MIDI bank decoded
  end-to-end.** 48 new MCP-addressable params
  (`preset.scene_{1..4}_midi_{1..4}_{type,channel,value}`),
  Type-enum-folds-CC# encoding screenshot-confirmed (§6n-scene-midi).
  Axe-Fx III `0x02 SET_PARAMETER` ported from II 🟡 untested.
- **Session 87** (2026-05-16): **AM4 dirty-gate fixed at the
  transport root.** `createSysExAssembler` in
  `packages/core/src/midi/transport.ts` (~50 LOC pure function)
  buffers F0…F7 across WinMM's 1024-byte SysEx chunks; closes a
  bug where 3082-byte AM4 preset dumps arrived as 3–4 separate
  events and the dirty-gate silently fell through to proceed.
  Verified live against AM4 via `probe-dirty-gate.ts`.
- **Session 87 cont** (2026-05-16): **Cross-ref audit infra +
  displayLabel field + scene-MIDI test-send wire shape.**
  `coverage-cross-ref-audit.ts` joins catalog ↔ XML ↔ params.ts
  (WIRED-MISLABEL=135 / UI-MISSING=298 / GHOST=61 initially, wired
  into preflight). `Param.displayLabel` optional field added.
  HW-110 closed (test-send fires `action=0x0004 / pidHigh=0x0070`,
  NOT the 0x0017 anomaly); per-scene "Send All" payload decoded;
  per-row payload partial (HW-111 open). Coverage-audit now
  reports by-device with placeable-only TOTAL.
- **Sessions 88–93** (2026-05-16/17): **UI-MISSING closeout
  passes** lifted AM4 placeable coverage 50% → 84%. DISTORT,
  REVERB, DELAY, CHORUS, FLANGER, PHASER, FILTER, TREMOLO,
  ENHANCER, COMPRESSOR, CABINET batches handled via the
  paramNames-overlay path (no direct params.ts hand-edits).
  WIRED-MISLABEL drifted 135 → 158 then tightened to 154 via
  targeted REVERB rename pass (Session 95/96).
- **Session 94** (2026-05-17): **Axe-Fx II Ghidra direct-scan
  breakthrough.** `SeekParamTablesII.java` byte-pattern scans the
  32-bit Axe-Edit binary directly and recovers 1,113 (paramId,
  symbol) entries at 99% indexed-symbol coverage. 470 NEW II
  params became mineable (entire VOCODER/RESONATOR/MOD blocks).
  221 net-new entries paste-merged into `packages/axe-fx-ii/src/
  params.ts` (905 → 1,126). "Skip Ghidra for II" overturned —
  documented in `docs/research/ghidra-mining-workflow.md` Session 94
  technique addendum. Also: `docs/research/fractal-midi-extraction-plan.md`
  drafted (vendor protocol package, codec-only).
- **Session 95** (2026-05-17): **HW-109 closed.** Hydrasynth
  envelope time wire→ms tables verified across 27 (N, display)
  pairs front-panel — zero corrections to `nrpnDisplay.ts`
  `timeTable`. `scripts/hydrasynth/verify-nrpn-display.ts` grew
  12 → 39 hardware-locked goldens. Decoder seconds-format regex
  tightened to keep one decimal + match device suffix "Sec".
- **Session 96** (2026-05-17): **HW-112 closed — AM4 GLOBAL
  family cracked.** `pidLow=0x0001` decoded from
  `samples/captured/session-95-am4-global-pidlow.pcapng`. 98 of
  99 catalog GLOBAL paramIds wired into `packages/am4/src/
  params.ts` under `block: 'global'` with two byte-exact
  verify-msg goldens (`global.usblevel1`, `global.tap_tempo_mode`).
  Wire encoding: float32 LE, enum ints packed as floats. See
  SYSEX-MAP §6bb. `displayLabel` field now surfaced through the
  unified `list_params` `display_name` resolver (commit `077c1c0`).
  REVERB rename pass (commit `d7d7d78`) trimmed WIRED-MISLABEL
  158 → 154.
- **Session 96 cont** (2026-05-17): **HW-105 closed — Axe-Fx II
  `apply_setlist` 3-preset round-trip hardware-verified on Q8.02
  XL+** via Claude Desktop. Safe-edit overwrite gate confirmed
  working (pre-flight `scan_preset_range` surfaced existing names,
  agent paused for confirmation).
