# Reverse-engineering workflow

This is the long-form RE workflow for `mcp-midi-tools`. The project's
`CLAUDE.md` holds a one-paragraph pointer at this file. Read this
end-to-end before any decode session, capture analysis, or new probe
script. Skipping it has cost multi-session dead-ends (Session 103: a
21-capture, 70-minute plan; Session 46: WinDbg trap-after-launch that
cannot fire by construction).

The discipline below is the accumulated lesson set from Sessions 8
through 117. None of it is theoretical; every rule names the bug or
session that produced it.

---

## Session-start reading order

Read these in order before doing decode work. Each one rules out a
class of wasted effort the others do not.

1. **`docs/_private/STATE.md`** plus the per-device shard for the
   device you are working on (`STATE-AM4.md`, `STATE-AXEFX2.md`,
   `STATE-AXEFX3.md`, `STATE-HYDRA.md`). Cross-device sessions stay
   in main `STATE.md`; device-specific sessions live in the shards.
   Always first.
2. **`docs/_private/captured-artifacts.md`** (if present). Founder-
   private manifest of decompile dumps, USB captures, and factory
   dumps that do not ship to OSS. Always grep `samples/captured/decoded/`
   before proposing a new Ghidra run; there is significant material
   already mined.
3. **`../fractal-midi/docs/research/cookbook/INDEX.md`**, the encoding
   primitive Rosetta stone. Before researching any new wire shape,
   scan the cookbook. The shape may already be a known primitive
   (septet, XOR-fold, descriptor-table, etc.). Cookbook entries are
   the canonical source for "how Fractal encodes X."
4. **`../fractal-midi/docs/research/cookbook/_negative/`** for methods
   ruled out. Always grep before re-attempting a technique that
   "feels useful." Eight entries as of 2026-05-22; expect that count
   to grow.
5. **`../fractal-midi/docs/research/fractal-protocol-decode-status.md`**,
   the per-device decode status table. Read before opening any new
   investigation so you know what is already named vs. open.
6. **`docs/devices/captures-inventory.md`** lists what `.pcapng` /
   `.syx` captures and Ghidra dumps already exist. Always check this
   BEFORE asking the founder for more captures. Session 103 proposed
   a 21-capture plan without checking the inventory; multiple
   relevant captures already existed.
7. **`docs/_private/HARDWARE-TASKS-<DEVICE>.md`** lists open captures
   the founder owes. If a Pending task gates the work you are about
   to do, surface it instead of speculating around the missing data.
8. **Per-device wire map** at `../fractal-midi/docs/devices/<device>/SYSEX-MAP.md`.
   For Axe-Fx II also read `axeedit-opcode-table.md` (94 wire opcodes
   recovered Session 103). For AM4 also read `param-rename-audit.md`.
9. **`docs/REFERENCES.md`**, only the section for your device. Do
   not WebFetch for a manual already extracted to `.txt` locally.

`npm run coverage-audit` is no longer required at session start
(AM4 100%, II ~97.4%; the audit-as-drift-guard value has decayed).
Run it manually when touching codec / `params.ts`, after pulling
`fractal-midi` changes, or when STATE.md's "open follow-ups" feel
out-of-sync with reality.

---

## Capture methods, in order of preference

### Hardware-free lanes (exhaust these BEFORE queuing founder time)

- **Existing captures.** `samples/captured/` has ~170 files spanning
  50+ session IDs (gitignored, local-only). Many decode targets are
  already covered. See `docs/devices/captures-inventory.md` for the
  full index by device + decode purpose.
- **Ghidra mining.** Canonical for paramId ↔ name catalog discovery
  (99% wire-accuracy verified Session 82-83). Also for SysEx opcode-
  table decode: Session 103 mined the full AxeEdit II wire vocabulary
  (94 opcodes) via 6 GhidraScripts in ~30 minutes wall time. The
  "skip Ghidra for II" rule from earlier sessions was formally
  overturned 2026-05-17 by `SeekParamTablesII.java` (1,113
  paramId/symbol entries at 99% indexed-symbol coverage on the
  32-bit AxeEdit II binary). See
  [`fractal-midi/docs/research/ghidra-mining-workflow.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/research/ghidra-mining-workflow.md).
- **JUCE BinaryData extraction.** 5-minute label discovery from
  editor binaries via the embedded ZIP. 1,299 AM4-Edit labels and
  10,250 AxeEdit III labels recovered this way. See
  [`fractal-midi/docs/capture-guides/juce-binarydata-extraction.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/capture-guides/juce-binarydata-extraction.md).

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
  are easy to misread as little-endian. Session 08 cost a day on
  this class; the golden is the only mechanical guard against it.
- **Front panel + `get_param` echo are ground truth.** AxeEdit and
  AM4-Edit cache stale UI state (HW-086: a freshly-placed Volume
  block showed 10.00 in the editor while the device held 0.00). On
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
  table. See cookbook `_negative/positional-xml-cache-binding.md`.
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
to catch the misapplication failure class (the `get_preset`
regression: +1.5-2s latency, stale source-of-truth, wrong bug-fix
mapping, scaffolding placeholders) and the N=1 generalization-claim
trap (paramBase shipped as generalized when it only worked for Test
Crunch).

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
   wrong. STOP. Cookbook entries' `Misapplication failure modes`
   sections name common bug-X-doesn't-live-here cases (e.g.
   `atomic-preset-dump` does NOT fix BK-058 channel-Y; channel-Y
   is a write-path bug).
4. **Scaffolding check.** Grep the diff for `0 ? undefined : undefined`,
   `// TODO`, `// scaffolding`, hardcoded `0` returned for "real
   later," typed-but-never-set fields. If any are present, the
   change is WIP, not shippable.
5. **Generalization-claim check (N=1 trap).** When claiming a
   primitive "generalizes" (across blocks / across presets / across
   firmwares / across devices), cite ≥ 2 distinct test cases varying
   along the generalization axis. N=1 is not generalization. If only
   N=1 is verified, ship as `cookbook/_partial/` with `status: partial-N1`;
   do NOT ship as `matched`. If a co-resident or cross-variant probe
   is cheap (< 5 min wire time), run it BEFORE shipping.

### What the build gate enforces

`scripts/cookbook-verify.ts` mechanically enforces **check 5 only**:
`status='matched'` requires `verified_on` to list ≥ 2 axis points
(see `cookbook-verify.ts:332`). Checks 1, 2, 3, 4 are reviewer and
agent discipline, not mechanical gates. A `_scratch/` entry whose
golden unexpectedly passes is a policy violation per `INDEX.md`, not
a build-gated failure.

---

## Cross-device transfer reflex (at session close)

When you discover or refine a primitive on one device, scan the
other three device wire-maps + `fractal-midi/docs/research/cookbook/`
for analogous decode gaps. File same-session `[transfer-candidate]`
follow-ups in each affected device's `STATE-<DEVICE>.md` (or
`HARDWARE-TASKS-<DEVICE>.md`) naming the transfer hypothesis + the
cheapest test to confirm.

Real evidence: the Axe-Fx III preset binary envelope is byte-
identical in shape to the II envelope (same
`(tag, mid, byte_count)` descriptor table layout). Five sessions
of II hardware-probe work could have been recognized as a III-
decodable target months ago if the transfer reflex had been a
session-close ritual. Do not repeat that miss. Cross-device
transfer findings are the highest-yield decode moves in the
codebase.

---

## Negative findings are first-class artifacts

When a probe rules a hypothesis OUT (e.g. Session 94 ruling that
the AM4-shaped `0x77` envelope is inert as a save attempt on
Axe-Fx II), commit the result to:

- The relevant `SYSEX-MAP-*.md` or `docs/_private/SESSIONS.md`
  entry, with the search terms a future agent would use ("AM4 0x77
  as save on II, no").
- **`fractal-midi/docs/research/cookbook/_negative/<name>.md`** when
  it is a primitive-level claim ("this encoding scheme doesn't apply
  to device X" / "this technique was ruled out"). The cookbook's
  `_negative/` directory is the canonical "methods that don't work"
  home that the next agent greps before re-attempting.

A negative finding that is not registered will be re-attempted. The
project has paid that cost more than once.

---

## Methods ruled out, canonical references

For the full per-method analysis, read the cookbook `_negative/`
entries. One-line digest pointers (kept in `CLAUDE.md`):

- [`windbg-trap-after-launch`](../../../fractal-midi/docs/research/cookbook/_negative/windbg-trap-after-launch.md)
- [`positional-xml-cache-binding`](../../../fractal-midi/docs/research/cookbook/_negative/positional-xml-cache-binding.md)
- [`virtual-midi-bridge-interposition`](../../../fractal-midi/docs/research/cookbook/_negative/virtual-midi-bridge-interposition.md)
- [`byte-literal-envelope-ghidra-search`](../../../fractal-midi/docs/research/cookbook/_negative/byte-literal-envelope-ghidra-search.md)
- [`flat-int-stride4-param-table`](../../../fractal-midi/docs/research/cookbook/_negative/flat-int-stride4-param-table.md)
- [`am4-77-as-save-on-ii`](../../../fractal-midi/docs/research/cookbook/_negative/am4-77-as-save-on-ii.md)
- [`ii-preset-binary-flat-byte-diff`](../../../fractal-midi/docs/research/cookbook/_negative/ii-preset-binary-flat-byte-diff.md)
- [`iii-block-name-string-cascade`](../../../fractal-midi/docs/research/cookbook/_negative/iii-block-name-string-cascade.md)

---

## Same-session artifact registration

Every new Ghidra script, decompile dump, capture-of-interest, OR
encoding primitive must be registered in the appropriate index the
SAME SESSION it is produced. Not "I'll add it later."

- New Ghidra script → `fractal-midi/scripts/ghidra/README.md` registry
- New decompile dump or capture-of-interest →
  `fractal-midi/docs/research/captured-artifacts.md` (public) or
  `mcp-midi-tools/docs/_private/captured-artifacts.md` (private;
  founder hardware + factory dumps)
- New encoding primitive →
  `fractal-midi/docs/research/cookbook/<name>.md` with a matching
  golden case in `scripts/cookbook-verify.ts`
- New negative finding →
  `fractal-midi/docs/research/cookbook/_negative/<name>.md`
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
[`fractal-midi/docs/devices/am4/param-rename-audit.md`](../../fractal-midi/docs/devices/am4/param-rename-audit.md).

---

## Related references

- `CLAUDE.md` (root): the project's always-loaded context. Points
  at this doc.
- `../fractal-midi/docs/research/cookbook/INDEX.md`: encoding
  primitives Rosetta stone.
- `docs/_private/SESSIONS.md`: chronological session log.
- `docs/_private/STATE.md` and per-device shards: current state.
