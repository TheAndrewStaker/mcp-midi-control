# Reverse-engineering workflow

This is the long-form RE workflow for `mcp-midi-control`. The project's
`CLAUDE.md` holds a one-paragraph pointer at this file. Read this
end-to-end before any decode session, capture analysis, or new probe
script. Skipping it has cost multi-session dead-ends (a 21-capture,
70-minute plan in one case; a WinDbg trap-after-launch that cannot
fire by construction in another).

The discipline below is the accumulated lesson set from real decode
sessions. None of it is theoretical; every rule names the bug class
that produced it.

---

## Session-start reading order

Read these in order before doing decode work. Each one rules out a
class of wasted effort the others do not.

1. **The maintainer's private state notes (gitignored)** plus the
   per-device shard for the device you are working on (the maintainer
   keeps a main cross-device state file and one shard per device:
   AM4, Axe-Fx II, Axe-Fx III, Hydrasynth). Cross-device sessions stay
   in the main state file; device-specific sessions live in the shards.
   Always first.
2. **The maintainer's private captured-artifacts manifest (gitignored,
   if present).** Lists decompile dumps, USB captures, and factory
   dumps that do not ship publicly. Always grep `samples/captured/decoded/`
   before proposing a new Ghidra run; there is significant material
   already mined.
3. **`packages/fractal-midi/docs/research/primitives/INDEX.md`**, the encoding
   primitive Rosetta stone. Before researching any new wire shape,
   scan the primitives corpus. The shape may already be a known primitive
   (septet, XOR-fold, descriptor-table, etc.). Primitive entries are
   the canonical source for "how Fractal encodes X."
4. **`packages/fractal-midi/docs/research/primitives/_negative/`** for methods
   ruled out. Always grep before re-attempting a technique that
   "feels useful." Expect the entry count to grow over time.
5. **`packages/fractal-midi/docs/research/fractal-protocol-decode-status.md`**,
   the per-device decode status table. Read before opening any new
   investigation so you know what is already named vs. open.
6. **`docs/devices/captures-inventory.md`** lists what `.pcapng` /
   `.syx` captures and Ghidra dumps already exist. Always check this
   BEFORE asking the maintainer for more captures. A past attempt
   proposed a 21-capture plan without checking the inventory; multiple
   relevant captures already existed.
7. **Your local hardware-task notes (the maintainer keeps these per
   device, gitignored)** list open captures the maintainer owes. If a
   pending task gates the work you are about to do, surface it instead
   of speculating around the missing data.
8. **Per-device wire map** at `packages/fractal-midi/docs/devices/<device>/SYSEX-MAP.md`.
   For Axe-Fx II also read `axeedit-opcode-table.md` (94 wire opcodes).
   For AM4 also read `param-rename-audit.md`.
9. **`docs/REFERENCES.md`**, only the section for your device. Do
   not WebFetch for a manual already extracted to `.txt` locally.

`npm run coverage-audit` is optional at session start (coverage sits at
AM4 100%, II ~97.4%). Run it when touching the codec or `params.ts`,
after pulling `fractal-midi` changes, or when the maintainer's open
follow-ups feel out of sync with reality.

---

## Re-mine before you request (the highest-yield lane, proven repeatedly)

**Before asking anyone (the maintainer, a community owner, a collaborator)
for new evidence, re-examine the evidence already on disk against everything
decoded SINCE that evidence was filed.** Old captures don't expire; the tools
to read them improve. A capture that was opaque in May is frequently
transparent in July because a sibling device's decode supplied the container,
the packing primitive, or the oracle.

This is not theoretical. The single largest decode day in the project
(2026-07-02) produced FOUR results, all from data that had been sitting in
`samples/` for weeks, none requiring a new capture or a key-press:

- **AM4 preset dump = the gen-3 Huffman container**: the corpus (104 factory
  presets + warm pairs) was on disk since May; the container codec since
  early June. Nobody had pointed one at the other. Refuted the May
  "encoder non-determinism" negative and reopened the whole AM4
  stored/atomic/authoring lane.
- **FM3 live-grid geometry**: pinned from sub=0x2E replies captured
  2026-06-12 and flagged "un-mined" in the artifacts manifest ever since.
- **VP4 structure blob** (name, scene names, current scene, full chain):
  fully field-decoded from the 2026-06 captures using a packing primitive
  that was already in the primitives corpus; the two "not recoverable" negatives fell.
- **II preset-body "Huffman" claim refuted**: adjudicated entirely from
  dumps on disk; reopened the parked atomic-apply lane.

**The synthesis cadence exists to force exactly this.** Tunnel vision is the
default failure mode: each session solves what's in front of it and never
re-crosses old evidence with new primitives. The periodic synthesis pass
(`docs/process/synthesis-prompt.md`, committed artifacts in
`fractal-midi/docs/research/synthesis-log/`) is the mechanism; all four
2026-07-02 results trace to a single synthesis pass or the review that
triggered it. `scripts/primitives-verify.ts` warns when the newest primitive
entry outruns the newest synthesis artifact by 21+ days; treat that warning
as "decodes are sitting on disk unclaimed," not as noise. When a new
container/packing/oracle primitive lands, the cross-device transfer reflex
(below) plus a scan of `captured-artifacts.md` for "un-mined" entries is the
same move in miniature; do it same-session.

**The un-mined ledger is structured and machine-checked.** When a manifest
entry flags un-mined material, add one greppable line per item (keep the
surrounding prose; the structured line supplements it):
`UNMINED[YYYY-MM-DD]: <artifact path or pointer> (<what would close it /
which primitive is missing>)`, optionally suffixed
`(deferred: YYYY-MM-DD <reason>)` for consciously-parked items.
`scripts/verify-re-ledger.ts` (in preflight) warns on items older than 30
days, nags legacy prose markers into the structured form, sweeps
`samples/captured/` for on-disk artifacts absent from both manifests, and
under `--strict` (release gate) fails on non-deferred items older than 60
days. When an item is mined, delete or strike its UNMINED line in the same
session.

## Capture methods, in order of preference

**Community-ask hierarchy (changed 2026-06-09):** when asking a device owner
for evidence, the order is now (0) **re-mine what's already on disk against
current primitives (see above)**, then (1) the editor's
`effectDefinitions_*.cache` file (offline, the file already exists after one
editor sync; full dictionary, see the cache bullet below), (2) the
one-command harvest script (`scripts/harvest-device-metadata.ts`; device
connected, no capture tooling), and only THEN (3) a targeted wire capture for
the few shapes neither covers.

### Hardware-free lanes (exhaust these BEFORE queuing maintainer time)

- **Existing captures.** `samples/captured/` holds ~170 files
  (gitignored, local-only). Many decode targets are already covered.
  See `docs/devices/captures-inventory.md` for the full index by device
  and decode purpose.
- **Ghidra mining.** Canonical for paramId to name catalog discovery
  (99% wire-accuracy verified). Also for SysEx opcode-table decode:
  the full AxeEdit II wire vocabulary (94 opcodes) was mined via 6
  GhidraScripts in ~30 minutes wall time. Ghidra works for the 32-bit
  AxeEdit II binary too: `SeekParamTablesII.java` direct-pattern-scan
  recovers 1,113 paramId/symbol entries at 99% indexed-symbol coverage.
  See
  [`fractal-midi/docs/research/ghidra-mining-workflow.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/research/ghidra-mining-workflow.md).
  - **Enum VALUE tables (wire-index to option label): harder than it looks;
    the dropdown order is a TRAP and a raw Ghidra scan does not work either.**
    Do NOT transcribe enum option order from an AM4-Edit / AxeEdit dropdown:
    the editor sorts dropdowns for DISPLAY (alphabetical / by band-count /
    grouped), NOT wire-index order. Proven 2026-05-31: `amp.geq_type` reads
    wire=0 for "8 Band Var Q", but AM4-Edit lists it LAST (display pos 10/11).
    A screenshot gives the right label SET, a WRONG index map. The AM4 also
    echoes no ASCII label over MIDI (enum `get_param` returns the raw index).
    And a raw Ghidra `.rdata` scan ALSO fails: the option labels live in
    COMPRESSED JUCE BinaryData (ZIP/gzip in `.rsrc`) which Ghidra never
    inflates, so the discriminating labels are absent from a static memory
    walk (`SeekParamTables*` extracts (paramId, symbol) only; the 16-byte
    ParamDescriptor has no options pointer). Working lanes, in order: (1) the
    HARDWARE WIRE-SWEEP, which actually resolved the AM4 set 2026-05-31: set
    each wire index and read the DEVICE FRONT-PANEL value per step (NOT
    AM4-Edit, which owns the port and re-sorts its list).
    `scripts/_research/probe-am4-enum-sweep.ts` automates it and uses the
    readback clamp to auto-detect table size. CONFIRMED RULE: the device
    front-panel knob order (clockwise from start = index 0) IS the wire order;
    only the editor dropdown re-sorts. (2) JUCE BinaryData DECOMPRESSED
    (recovered 1,299 AM4-Edit labels, but NOT the dropdown option lists, which
    proved absent); (3) the editor cache `effectDefinitions_*.cache`, whose
    grammar is now fully decoded (see the cache bullet below): roster ordinals
    matched the wire ordinals at every hardware-checked anchor so far (FM9,
    II, AM4), but ALWAYS verify index 0 plus a mid-table point against
    hardware ground truth per device. Full writeup: primitives corpus
    `_negative/am4-edit-dropdown-order-not-wire-order`.
- **JUCE BinaryData extraction.** 5-minute label discovery from
  editor binaries via the embedded ZIP. 1,299 AM4-Edit labels and
  10,250 AxeEdit III labels recovered this way. See
  [`fractal-midi/docs/capture-guides/juce-binarydata-extraction.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/capture-guides/juce-binarydata-extraction.md).
- **Editor `effectDefinitions_*.cache` (the device-native dictionary; the FIRST
  community ask).** Each Fractal editor caches its per-firmware effect/param
  definitions at
  `%APPDATA%\Fractal Audio\<editor>\effectDefinitions_<modelByte>_<fw>.cache`
  (`_12_` = FM9, `_15_` = AM4, etc.). The format is FULLY DECODED
  (primitive [[editor-cache-section-record-grammar]], 2026-06-09): a
  count-driven section/record stream with a 22-byte record header that walks
  with ZERO resync and carries, per block family, every param's id, typecode,
  display min/max/default/step, and (for enums) the device-true label roster.
  One synced cache file yields the device's complete dictionary with no
  hardware probing; the FM9 device-true ranges
  (`packages/fractal-midi/src/gen3/fm9/ranges.generated.ts`) are generated from one.
  - **The typecode bitfield is decoded too**: nibble fields for unit,
    family/taper, and (newer cache formats) display precision. Families 4/5
    are log10 taper, hardware-confirmed; taper and display decimals are
    derivable for every cache float param from the file alone.
  - **Roster ordinals matched the wire ordinals at every hardware-checked
    anchor** (FM9 amp/drive/reverb; the II amp roster agrees with the shipped
    hardware-verified catalog at all 259 overlapping ordinals; AM4 amp
    anchors). Per the verify-index-0 rule above, still confirm ordinal 0 plus
    a mid-table point against hardware ground truth before shipping a new
    device's table. The record `id` equals the catalog `paramId`.
  - **Sourcing: needs a real-device-synced cache.** An editor that never
    connected to the device writes a roster-EMPTY placeholder stub (filler
    ranges, no names); detect a usable cache by ROSTER PRESENCE, never by file
    size or the firmware suffix. The cheap community ask is the FILE itself
    (it already exists after the owner has used their device once), far
    lighter than a capture: ask for it FIRST, before the harvest script,
    before any wire sweep. Decoder:
    `scripts/_research/parse-effectdefinitions-cache.ts` (strict zero-resync
    walker; `--verify` re-asserts the hardware anchors). Range codegen:
    `scripts/gen-fm9-ranges-from-cache.ts` + gate `scripts/verify-fm9-ranges.ts`.
- **One-command harvest script (`scripts/harvest-device-metadata.ts`).** The
  SECOND ask, right after the cache file (it needs the device connected, but
  no capture tooling). Read-only by construction (a whitelist gate checks
  every outgoing frame), it sweeps every documented "describe yourself"
  surface per device (AM4 / II / gen-3 families) and writes one JSON file with
  raw hex plus decoded labels. One run replaces most of the itemized per-device
  capture asks. Community guide:
  `packages/fractal-midi/docs/capture-guides/harvest-script.md`.

### Hardware lanes (only after the above is exhausted)

- **Directed probe scripts** (`scripts/probe*.ts`). Cheap, scriptable,
  default for unknown wire envelopes. One hypothesis per probe; keep
  the probe read-only unless explicitly designed to write.
- **Passive capture.** Open the device MIDI input with no editor.
  Axe-Fx II broadcasts state continuously; AM4 is silent and needs
  an active query loop. See
  [`fractal-midi/docs/research/fractal-broadcast-vs-poll-research.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/research/fractal-broadcast-vs-poll-research.md).
- **USBPcap + Wireshark.** Captures both directions at the USB-class
  layer when the editor → device direction is needed. The
  maintainer's default for editor-write decode. See `CONTRIBUTING.md`
  for the step-by-step.

---

## Scientific discipline

Rules forged by real bugs. Each one is the consequence of a specific
class of mistake; the rule names the class.

- **Every new `pidHigh` in `params.ts` requires a `verify-msg.ts`
  golden built from captured bytes.** Septet-encoded 14-bit fields
  are easy to misread as little-endian. An early session cost a day
  on this class; the golden is the only mechanical guard against it.
- **Front panel + `get_param` echo are ground truth.** AxeEdit and
  AM4-Edit cache stale UI state (a freshly-placed Volume block once
  showed 10.00 in the editor while the device held 0.00). On
  disagreement, the editor is wrong.
- **Read before write.** Every device tool gates writes behind a
  fingerprint read. Do not bypass this in new probe scripts unless
  they are explicitly read-only (`scripts/probe.ts` is read-only
  forever, by policy).
- **One capture per hypothesis.** When isolating an unknown field,
  change exactly one input on the editor or device. Two simultaneous
  edits produce ambiguous diff bytes and cost days.
- **Variant-dependent binding.** The same `parameterName` maps to
  different wire IDs across effect variants (e.g. `DISTORT_TONE` is
  `drive.id=12` in some variants, `drive.id=23` in others). XML alone
  is never sufficient. Combine with a capture or the Ghidra paramId
  table. See the primitives corpus `_negative/positional-xml-cache-binding.md`.
- **Septet-encode every 14-bit field, not just `pidLow`.** `action`,
  effect IDs, preset numbers, tempo BPM, location bytes are all
  7-bit-pair encoded. Forgetting once produces a wire mismatch and
  a confused device.
- **Cite captures with file path + byte offset** in every SYSEX-MAP
  entry so future agents can re-verify. "Confirmed via capture"
  without a reference is hearsay.

---

## Capability-application pre-flight (5 checks)

Before wiring a decoded primitive into a shipping tool path, run a
5-check pre-flight and cite the evidence in the commit body. Designed
to catch the misapplication failure class (e.g. a `get_preset`
regression with +1.5-2s latency, stale source-of-truth, wrong bug-fix
mapping, and scaffolding placeholders) and the N=1 generalization-claim
trap (e.g. a paramBase shipped as generalized when it only worked for
one amp model).

1. **Latency check.** Estimate or measure round-trip cost; compare
   to the < 1 s tool-call budget. State the number in the commit
   body.
2. **Source-of-truth check.** Name which source the primitive reads
   (working buffer / stored binary at active location / stored
   binary at non-active location / cached snapshot / front-panel
   echo). If the existing code path read source S1 and your change
   demotes it to S2, that is a correctness regression. Flip it back
   before shipping.
3. **Bug-fix mapping.** If claiming "this fixes bug X," name the
   code path X lives in (`file:line`). Name the code path being
   changed (`file:line`). If the two are different, the framing is
   wrong. STOP. Primitive entries' `Misapplication failure modes`
   sections name common bug-X-doesn't-live-here cases (e.g.
   `atomic-preset-dump` does NOT fix the channel-Y write loss bug;
   channel-Y is a write-path bug).
4. **Scaffolding check.** Grep the diff for `0 ? undefined : undefined`,
   `// TODO`, `// scaffolding`, hardcoded `0` returned for "real
   later," typed-but-never-set fields. If any are present, the
   change is WIP, not shippable.
5. **Generalization-claim check (N=1 trap).** When claiming a
   primitive "generalizes" (across blocks / across presets / across
   firmwares / across devices), cite ≥ 2 distinct test cases varying
   along the generalization axis. N=1 is not generalization. If only
   N=1 is verified, ship as `primitives/_partial/` with `status: partial-N1`;
   do NOT ship as `matched`. If a co-resident or cross-variant probe
   is cheap (< 5 min wire time), run it BEFORE shipping.

### What the build gate enforces

`scripts/primitives-verify.ts` mechanically enforces **check 5 only**:
`status='matched'` requires `verified_on` to list ≥ 2 axis points
(see `primitives-verify.ts:332`). Checks 1, 2, 3, 4 are reviewer and
agent discipline, not mechanical gates. A `_scratch/` entry whose
golden unexpectedly passes is a policy violation per `INDEX.md`, not
a build-gated failure.

---

## Cross-device transfer reflex (at session close)

When you discover or refine a primitive on one device, scan the
other three device wire-maps + `fractal-midi/docs/research/primitives/`
for analogous decode gaps. File same-session `[transfer-candidate]`
follow-ups in each affected device's private per-device state notes
(or hardware-task notes), naming the transfer hypothesis plus the
cheapest test to confirm.

Real evidence: the Axe-Fx III preset binary envelope is byte-
identical in shape to the II envelope (same
`(tag, mid, byte_count)` descriptor table layout). Multiple sessions
of II hardware-probe work could have been recognized as a III-
decodable target months ago if the transfer reflex had been a
session-close ritual. Do not repeat that miss. Cross-device
transfer findings are the highest-yield decode moves in the
codebase.

---

## Negative findings are first-class artifacts

When a probe rules a hypothesis OUT (e.g. confirming that the
AM4-shaped `0x77` envelope is inert as a save attempt on
Axe-Fx II), commit the result to:

- The relevant `SYSEX-MAP-*.md` entry, or the maintainer's private
  session log (gitignored), with the search terms a future agent would
  use ("AM4 0x77 as save on II, no").
- **`fractal-midi/docs/research/primitives/_negative/<name>.md`** when
  it is a primitive-level claim ("this encoding scheme doesn't apply
  to device X" / "this technique was ruled out"). The primitives corpus'
  `_negative/` directory is the canonical "methods that don't work"
  home that the next agent greps before re-attempting.

A negative finding that is not registered will be re-attempted. The
project has paid that cost more than once.

---

## Methods ruled out, canonical references

For the full per-method analysis, read the primitives corpus `_negative/`
entries. One-line digest pointers (kept in `CLAUDE.md`):

- [`windbg-trap-after-launch`](../packages/fractal-midi/docs/research/primitives/_negative/windbg-trap-after-launch.md)
- [`positional-xml-cache-binding`](../packages/fractal-midi/docs/research/primitives/_negative/positional-xml-cache-binding.md)
- [`virtual-midi-bridge-interposition`](../packages/fractal-midi/docs/research/primitives/_negative/virtual-midi-bridge-interposition.md)
- [`byte-literal-envelope-ghidra-search`](../packages/fractal-midi/docs/research/primitives/_negative/byte-literal-envelope-ghidra-search.md)
- [`flat-int-stride4-param-table`](../packages/fractal-midi/docs/research/primitives/_negative/flat-int-stride4-param-table.md)
- [`am4-77-as-save-on-ii`](../packages/fractal-midi/docs/research/primitives/_negative/am4-77-as-save-on-ii.md)
- [`ii-preset-binary-flat-byte-diff`](../packages/fractal-midi/docs/research/primitives/_negative/ii-preset-binary-flat-byte-diff.md)
- [`iii-block-name-string-cascade`](../packages/fractal-midi/docs/research/primitives/_negative/iii-block-name-string-cascade.md)

---

## Same-session artifact registration

Every new Ghidra script, decompile dump, capture-of-interest, OR
encoding primitive must be registered in the appropriate index the
SAME SESSION it is produced. Not "I'll add it later."

- New Ghidra script → `fractal-midi/scripts/ghidra/README.md` registry
- New decompile dump or capture-of-interest →
  `fractal-midi/docs/research/captured-artifacts.md` (public) or
  the maintainer's private captured-artifacts manifest (gitignored;
  maintainer hardware plus factory dumps)
- New encoding primitive →
  `fractal-midi/docs/research/primitives/<name>.md` with a matching
  golden case in `scripts/primitives-verify.ts`
- New negative finding →
  `fractal-midi/docs/research/primitives/_negative/<name>.md`
- New synthesis-review output →
  `fractal-midi/docs/research/synthesis-log/<slug>.md` committed the
  same session it is produced. The log is the only evidence the
  synthesis cadence is alive; without committed artifacts the
  cadence-rot fail-mode the discipline warns about is invisible.

Same-session registration is the same discipline as the existing
"verify-msg golden per new pidHigh" rule, promoted one level up.

---

## Param-coverage audit reflex

When grepping `fractal-midi/src/<device>/params.ts` to confirm
whether a param is registered, the registered name often differs
from the Blocks Guide / Owner's Manual spelling because params are
renamed for AM4-Edit / front-panel UI-label match. Naive search for
the manual's wording produces false negatives.

Before opening a "missing param" investigation, re-grep using the
device's short canonical spellings (`_sw`, `_fb`, `preamp_*`,
`nfb_*`, `in_*` prefix variants). For the full known-divergence
table on AM4, see
[`fractal-midi/docs/devices/am4/param-rename-audit.md`](../packages/fractal-midi/docs/devices/am4/param-rename-audit.md).

---

## Related references

- `CLAUDE.md` (root): the project's always-loaded context. Points
  at this doc.
- `packages/fractal-midi/docs/research/primitives/INDEX.md`: encoding
  primitives Rosetta stone.
- The maintainer's private session log (gitignored): chronological
  session log.
- The maintainer's private state notes and per-device shards
  (gitignored): current state.
