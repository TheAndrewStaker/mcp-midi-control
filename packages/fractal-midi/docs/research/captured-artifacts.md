# Captured Artifacts, Public Manifest

Organized by **decode purpose**, not by session ID. This is the public
half of the captured-artifacts manifest, forum captures, third-party
public captures, and non-sensitive probe outputs that ship with the
OSS repo. Founder-private artifacts (decompile dumps, founder USB
captures, factory `.syx` files) live in the consumer repo's
founder-private captured-artifacts manifest (gitignored).

Both files share the same five-class schema (a, e). The public file
omits the sensitive entries; the private file has the full set.

The **artifact bytes themselves are gitignored** in both repos'
`samples/captured/` directories. Only the manifest text, what exists
+ what's been mined, is committed.

---

## How to use this manifest

Before proposing a new capture or Ghidra run, scan the relevant
section. If an artifact already exists with un-mined material:

1. Open the artifact (or its decode in the private dump corpus).
2. Apply the relevant primitive(s) from `primitives/INDEX.md`
, most decode work is "apply a known primitive to new bytes."
3. Write or extend a TS parser script in `scripts/_research/` that
   extracts the primitive-relevant payload.
4. Register your findings: refine primitive entries (with new
   fixtures), file new entries if they're genuinely new primitives.

If no existing artifact applies, then propose the new capture. Always
file `[hardware-task]` or `[capture-needed]` follow-ups in the
relevant device's `STATE-<DEVICE>.md` rather than blocking the
session.

---

## d. Public / forum / third-party captures

Provenance from outside our hardware. We don't control the conditions,
so the "one input per capture" rule may not hold. Value: cross-
validation against decoded behavior + decode confirmation for devices
we don't own.

### Axe-Fx III SET_PARAMETER captures (10 captures)
- **Source**: FC-12 controller public capture + a Mountain Utilities
  forum thread (2019)
- **Locks**: III fn=0x01 SET_PARAMETER wire shape (pivot from initial
  fn=0x02 hypothesis)
- **Captures archived inline** in
  [`docs/devices/axe-fx-iii/set-parameter-captures.md`](../devices/axe-fx-iii/set-parameter-captures.md)
- **Primitives**: applies [[../research/primitives/septet-14bit]] for
  paramId encoding; the sub-action code table was subsequently mined
  (2026-06-09: 57 fn=0x01 action14 codes charted from all 93 callers
  in the III decompile, see the founder-private manifest's
  actions-and-shapes entry)
- **Status**: ✅ wire shape locked

### Axe-Fx III preset format research (community RE)
- **Source**: Fractal Forum community RE thread #159885
- **Hypothesis**: III preset binary body uses Huffman codebook compression
- **Status**: 🟡 not byte-verified against device. Lives in
  `primitives/_scratch/iii-preset-huffman-codebook.md` pending hardware
  verification.
- **Synthesis pass 2026-05-22 finding**: the III envelope wrapper is
  byte-identical to II (descriptor tables at `0x1407ab440` +
  `0x1407aba40` match II's `0xe04440` + `0xdff900` shape, see
  [[../research/primitives/vendor-envelope-descriptor-table]]). The
  Huffman hypothesis is about the BODY content; the envelope is
  decodable from existing dumps without hardware.

### Axe-Fx III / FM3 effectDefinitions cache mine (gen-3 read-roster cross-validation, 2026-07-21)
- **Source**: two community-attached `effectDefinitions_<modelByte>_<fw>.cache`
  files, device-synced (not empty stubs — both walked CLEANLY: declared==walked
  at every section, zero resync errors). GitHub issue #13 (Axe-Fx III, model
  `0x10`, fw 32.06) and issue #8 (FM3, model `0x11`, fw 12.0).
- **Artifact**: `samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.cache`
  and `samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.cache`
  (both gitignored). Walked with `scripts/_research/parse-effectdefinitions-cache.ts`
  to sibling `.walk.json` files (thousands of records each).
- **Purpose**: first INDEPENDENT, device-native confirmation of the "III/FM3/FM9
  share one model-selector ordinal space" claim `GEN3_READ_ROSTERS` is built on
  (previously sourced only from an FM9 fw 11.0 cache + Drew Mercurio's
  factory-preset-correlated tables; see the header comment in
  `src/gen3/axe-fx-iii/gen3ReadRosters.ts`).
- **Locks (merged into `GEN3_READ_ROSTERS` via `scripts/_research/gen3-roster-generate.ts`,
  `AXEIII_TYPE_ROSTER_GAPS`/`FM3_TYPE_ROSTER_GAPS`)**: FUZZ_TYPE (+1: 86 "Swedish
  Metal", III only), CHORUS_TYPE (+10: 17-26, III; FM3 corroborates 17), FLANGER_TYPE
  (+10: III and FM3 byte-identical), PHASER_TYPE (+3, byte-identical), TREMOLO_TYPE
  (+1, byte-identical), FILTER_TYPE (+8, byte-identical). COMP_TYPE/WAH_TYPE were
  already dense (19/9 entries); both caches reconfirm every ordinal with nothing new.
  All additions: zero conflicts against the existing table AND, where both caches
  cover an ordinal, against each other.
- **Does NOT lock / deliberately NOT merged** (real, explained conflicts —
  refuse-on-conflict, not prefer-one-source):
  - **DISTORT_TYPE**: III fw 32.06 ordinal 283 = "Deluxe Tweed Bright" vs the
    committed (FM9 fw 11.0-derived) "Deluxe Tweed"; FM3 fw 12.0 agrees with the
    committed name. Reads as a fw-32.06-only rename (III also adds a new sibling
    "Deluxe Tweed Normal" at ordinal 331, alongside 4 more new amp names at
    332-335). Withheld family-wide (not just ordinal 283) per the family-level
    refuse-on-conflict rule.
  - **REVERB_TYPE**: the III cache prefixes every name with its front-panel
    category, e.g. `"Room: Small Room"`, `"Hall: Medium Hall"` (79/79 entries,
    same count as committed); FM3's cache does not (plain names, 79/79 exact
    match). After stripping the "Category: " prefix, III still disagrees with
    both the committed table and FM3 at 3 ordinals: 36 "Asylum" vs "Asylum Hall",
    68/78 "Vibra-King..." vs "Vibrato-King...". No new ordinals from either cache.
  - **DELAY_TYPE**: FM3 alone is clean and would add 3 gap ordinals (9 "Sweep
    Delay", 21 "Worn Tape", 23 "Stereo Trem Delay"). III's cache shows a 2-item
    mid-list insertion ("Diffused Delay", "Zephyr") starting at ordinal 21 on
    fw 32.06, shifting the committed/FM3 ordinals 21..26 up to III's 23..28 —
    so FM3's fills at 21/23 are apparently fw-12.0-stale for fw >= 32.06. Only
    ordinal 9 "Sweep Delay" is shift-free and agreed by both caches; the family
    as a whole was not merged.
- UNMINED[2026-07-21]: samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.cache and samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.cache — DISTORT_TYPE[283] rename + 5 new III-only amp ordinals (331-335), REVERB_TYPE's III-only category-prefix format + 3 stripped-name mismatches (36/68/78), and DELAY_TYPE's fw-32.06 2-item mid-list insertion (ordinals 21+ shift) all need a firmware-aware resolution (which name is current for which firmware floor) before merging; the section/id map for future re-mines: DISTORT_TYPE section 10 (III id 0, FM3 id 6), FUZZ_TYPE/REVERB_TYPE/CHORUS_TYPE/COMP_TYPE/FLANGER_TYPE/PHASER_TYPE/TREMOLO_TYPE/WAH_TYPE/FILTER_TYPE section 25/12/16/7/17/19/22/20/24 respectively, all id 0 except COMP_TYPE id 12; DELAY_TYPE section 13 (III id 0, FM3 id 6)
- **Primitives**: applies the existing cache-walk grammar
  [[../research/primitives/editor-cache-section-record-grammar]]; no new
  primitive, a new cross-validation data point for the existing "gen-3 shares
  one ordinal space" claim.
- **Status**: ✅ 6 families merged (FUZZ/CHORUS/FLANGER/PHASER/TREMOLO/FILTER
  TYPE), community-beta (device-native, cache-derived, hardware-unverified);
  ⛔ 3 families (DISTORT/REVERB/DELAY TYPE) deliberately withheld, conflict
  documented above, not blocking anything currently shipped.

### BK-054 outer fn-byte dispatch mine (2026-07-09, Ghidra + registry re-mine)
- **Source**: new Ghidra script `FindAxeEditIIIIndirectFnByteCallers.java`
  (run via `run-axeedit3-indirect-fn-callers.cmd` against the existing
  `ghidra-axe-edit-3` project) plus a full re-grep of the pre-existing
  `ghidra-axe-edit-iii-inbound-dispatcher.txt` async-workflow registry dump.
- **Output**: `samples/captured/decoded/ghidra-axe-edit-iii-indirect-fn-callers.txt`
  (gitignored). Decodes fn=0x00's two un-mined emit sites (fixed `0x7F`
  trailer, query-shaped); a broader non-`isCall()` reference scan on the
  fn=0x08/0x43 "no callers" wrappers (negative: only PE `.pdata` unwind-table
  rows found, no hidden workflow-name registry); a control check reproducing
  the known fn=0x77 builder's two call sites (PASS, rules out stale-pointer
  artifacts).
- **Locks**: `SYSEX_DSP_MESSAGE`'s function byte is UNBOUND, exhaustively,
  by THREE independent static techniques (string-offset-index fit,
  code-xref scan across 1.39M instructions, and this session's async-workflow
  registry name grep, zero DSP/CPU/meter/load-named workflow among ~140
  registered rows). Static analysis is exhausted; closing it needs a live
  USBPcap capture.
- **Decode doc**: [`docs/devices/axe-fx-iii/SYSEX-MAP.md`](../devices/axe-fx-iii/SYSEX-MAP.md)
  "BK-054: outer fn-byte dispatch mine" section.
- **Primitives**: updates [[../research/primitives/iii-host-emitter-fn-table]]
  (refinement history); the exhausted DSP-message binding is a new negative,
  [[../research/primitives/_negative/iii-sysex-dsp-message-unbound]].
- **Status**: ✅ outer fn-byte inventory consolidated (28 host-emitted fn
  bytes, cross-checked); ⛔ `SYSEX_DSP_MESSAGE` fn-byte closed as
  static-analysis-unrecoverable; the DSP/CPU-usage CAPABILITY itself already
  ships via a different opcode (`fn=0x01 sub=0x2E` live-meters payload, see
  the SYSEX-MAP "BK-055" subsection).

### Independent III MCP cross-reference
- **Source**: forum thread #219503; independent OSS author building a
  parallel III MCP
- **Status**: 🟡 monitor for cross-validation; no merged findings yet
- **Primitives**: may surface III analogs of II primitives if their
  decode work overlaps

### VP4 fw 4.03 editor-poll capture (read path)
- **Source**: community capture, Kevin Iudicello (Reddit u/AggressiveFeckless),
  emailed 2026-06-08. VP4 firmware 4.03, "Y1: Main Bank", 4CM preset
  (WAH/DRV/4CM/PHR/DLY), VP4-Edit open. MIDI Monitor (macOS) spying capture.
- **Artifact**: `samples/captured/vp4-edit-preset-sync-poll-fw403-kevin-iudicello-2026-06-08.mmon`
  (gitignored). Decode + scripts: `samples/captured/decoded/vp4-403/` (`FINDINGS.md`).
- **Locks**: VP4 `fn=0x01` PARAMETER GET read path (query + response shape, no
  sub-action), effectId == shared gen-3 block table, device-true paramId catalog:
  all byte-confirmed on real VP4 hardware. 1000 frames, 100% checksum-valid.
- **Does NOT lock**: any write path (read-only editor poll, no SET/bypass/scene/
  block-move frames). Full GET value calibration + the `0x1f` routing-blob layout
  remain open.
- UNMINED[2026-06-08]: samples/captured/vp4-edit-preset-sync-poll-fw403-kevin-iudicello-2026-06-08.mmon, full GET value calibration (display↔wire scale for continuous params); the 0x1f routing-blob item closed 2026-07-01 via [[../research/primitives/vp4-eid206-structure-blob]]
- **Decode doc**: [`docs/devices/vp4/SYSEX-MAP.md`](../devices/vp4/SYSEX-MAP.md).
- **Primitives**: applies [[../research/primitives/xor-7f-envelope-checksum]] +
  [[../research/primitives/septet-14bit]].
- **Status**: ✅ read path locked; ⛔ writes still gated.

### VP4 fw 4.03 edit-session capture (WRITE path)
- **Source**: community capture, Kevin Iudicello, 2026-06-09. VP4 fw 4.03, preset
  "Y1: Virtual Pedalboard", VP4-Edit open, MIDI Monitor buffer raised so the full session
  was retained. Annotated edit sequence: block move, param drag (Delay feedback 15%→~-45%),
  save, scene 1→3, reverb bypass/enable, save.
- **Artifact**: `samples/captured/vp4-edit-edit-session-fw403-kevin-iudicello-2026-06-09.mmon`
  (gitignored). Decode: `samples/captured/decoded/vp4-403-v2/FINDINGS.md`. 27,104 frames,
  100% `fn=0x01`, all checksum-valid; 69 write frames isolated.
- **Locks**: VP4 `fn=0x01` SET frame (21-byte, `tc` sub-opcode), the value codec (5-septet
  LE float32, top two septets swapped, normalized [0,1]), the **synchronous per-write echo**
  (+ the 16-byte SAVE completion ack), and the SAVE / continuous-param-SET / bypass frames:
  byte-exact, mapped to known actions. Strong-evidence: `set_bypass`, `save_preset`.
- **Does NOT lock**: generic discrete `set_param` (zero captured evidence), block-placement
  value→slot math (frames known, encoding open), scene value mapping, and continuous-param
  display calibration (single-point/noisy).
- UNMINED[2026-06-09]: samples/captured/vp4-edit-edit-session-fw403-kevin-iudicello-2026-06-09.mmon, block-placement value→slot math (69 isolated write frames, encoding open), scene value mapping, and continuous-param display calibration (single-point/noisy)
- **Decode doc**: [`docs/devices/vp4/SYSEX-MAP.md`](../devices/vp4/SYSEX-MAP.md) (PARAMETER SET section).
- **Status**: ✅ write path decoded (param/save/bypass); ⛔ block placement still gated.

### AM4 stored-preset body decode (warm-pair captures)
- **Source**: founder-private hardware warm-pair captures, a redump of the same
  stored preset before/after ONE isolated edit, so the decoded-body diff pins a
  single field. `samples/captured/am4-warm-pair-*-{before,after}.syx` (gitignored):
  1 no-op baseline, amp.gain chA, amp.gain chB, amp.master, amp type-swap.
- **Locks**: the AM4 decoded-BODY block-record chain for the AMP block:
  marker (== block pidLow) + `0x0E` header + 4 per-channel records at stride
  `0x130`; param word = `marker + ch*0x130 + 0x0E + pidHigh*2`. Four anchors
  byte-exact (amp.type, amp.gain chA @`0x0958` / chB @`0x0A88`, amp.master chA).
  Walker `decodeAm4AmpBlock` (`src/am4/bodyChain.ts`); swept over the 104-preset
  factory bank (amp base `0x0934`/`0x0A92`/absent = 70/17/17, zero false
  positives). AM4 stored `get_preset` now surfaces `whole_preset.amp`.
- **Does NOT lock**: the pidHigh+7 / `0x130`-stride formula for any NON-amp
  block. The amp is the only block with an ordinal-bounded TYPE enum to reject
  false-positive markers; cab / drive / delay / reverb share the chain structure
  but their per-block stride + param formula are untested (a naive effectId scan
  false-positives). Five isolated one-variable captures would confirm transfer.
- UNMINED[2026-07-02]: samples/captured/am4-warm-pair-* (5 new one-variable pairs needed), one warm pair each for delay.mix, drive.drive, a cab param, a scene-bypass toggle, and a per-block channel change, to confirm the amp block's pidHigh+7 / 0x130-stride formula transfers to non-amp blocks (unblocks whole_preset VALUES for every block, not just amp)
- **Decode doc**: [`docs/devices/am4/SYSEX-MAP.md`](../devices/am4/SYSEX-MAP.md)
  (§10b body block-record chain). Primitive [[../research/primitives/am4-gen3-preset-container]].
- **Status**: ✅ amp block VALUES surfaced (community-beta); ⛔ non-amp block VALUES pending the 5 captures.

### General purpose: any Fractal envelope from a third party
- Apply [[../research/primitives/xor-7f-envelope-checksum]], universal
  Fractal envelope checksum across II, III, AM4.
- Apply [[../research/primitives/septet-14bit]] for any 14-bit field.
- Apply [[../research/primitives/msb-first-14bit-preset-payload]] for
  preset-number REPLY payloads (LSB-first vs MSB-first easy to confuse).

---

## e. Probe-script-generated captures + decode outputs (non-sensitive subset)

Captures produced by our own probe scripts (`scripts/_research/probe-*.ts`)
+ the decode JSONs/tables they emit. The subset listed here is
publishable, output that doesn't reveal device-serial / firmware-
specific fingerprints. The full set lives in the founder-private
manifest.

### probe-axefx2-enum-dump output
- **Producer**: `scripts/_research/probe-axefx2-enum-dump.ts`
- **Output (gitignored)**: `samples/captured/probe-axefx2-enum-dump-findings.md`
  + `.syx`
- **Contents**: every Axe-Fx II enum table dumped via fn 0x28 (device-
  emitted labels). Original sweep: 145 probes, 1112 strings, 1/145
  truncated (amp.effect_type) by node-midi's 2048-byte WinMM
  fragmentation. That receive cap is FIXED (the transport reassembles
  fragments via `createSysExAssembler`); the 2026-06-09 re-run captured
  the full 266-entry amp table in one untruncated frame, 266/266
  display-equal vs the shipped catalog.
- **Mined**: 54 ENUM_VALUE_OVERRIDES + 4 wiki transcription
  corrections (CORNCOB → CORNFED) shipped in fractal-midi.
  Re-running probe against shipped catalog: 0 mismatches after
  trim-tolerant comparison.
- **Un-mined**: nothing, fully consumed.
- **Primitives**: [[../research/primitives/fn28-enum-dump]] +
  [[../research/primitives/trim-tolerant-display-match]]

---

## a, c. Founder-private artifact classes (manifest location)

These sections live in the consumer repo's founder-private manifest
(gitignored):

- **(a) Decompile dumps + binary extracts**: Ghidra output from
  AxeEdit, AM4-Edit, AxeEdit III binaries. ~30 files totaling ~4.3 MB
  per the synthesis pass 2026-05-22 inventory. **The III preset-binary
  envelope spec is decoded from `ghidra-axe-edit-iii-dump-descriptors.txt`
  and is byte-identical to the II envelope spec, record for record**
  (0x77/0x78/0x79 descriptor tables; the dump's opening tables, once
  mislabeled as the preset envelope, are actually the fn=0x75
  broadcast-body tables). The 0x79 footer is a 16-bit XOR-fold of the
  body words, validated by the editor's own receive path.
- **(b) USBpcap + Wireshark captures (.pcapng)**: founder USB
  captures of editor → device write paths
- **(c) Factory default .syx + reference dumps**: vendor-provided or
  founder-saved baseline state, used for cross-validation + byte-diff
  baselines

OSS contributors won't have access to (a)/(b)/(c). The narrative + the
primitives the decompiles supported are public; the raw
bytes are not. See `AGENTS.md` § "Decompile-derived contributions" for
the contributor IP rule.

---

## Adding to this manifest

When a new public capture, third-party reference, or non-sensitive
probe output is acquired or generated, register it in the same
session in this file. Manifest entries link to the doc that interprets
the artifact, not the other way around, so when a doc is refactored,
the manifest stays correct.

Primitive entries that cite an artifact use the relative path from
this file when possible.
