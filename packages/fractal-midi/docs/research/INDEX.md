# Research Index, fractal-midi

This is the entry point for anyone (human or agent) doing reverse-
engineering work on Fractal Audio's SysEx wire protocols. Read this
before opening a new probe, capture, or Ghidra dump, the answer may
already exist.

The primitives corpus (item 1 below) is the **encoding-primitive Rosetta stone**.
Most "I need to decode X" questions are actually "is X an instance of
a known primitive?", check the primitives corpus first.

---

## 1. Encoding Primitives (the Rosetta stone)

**[`primitives/INDEX.md`](primitives/INDEX.md)**: 18 primitive entries
(seed corpus), organized by name + status. Each entry has formal
definition, where it's used, edge cases, applicability + misapplication
notes, verification path, and refinement history. The primitives corpus turns
decode work from infinite-capture into mechanical composition.

Highlights of what's already in:

- Universal Fractal envelope checksum (XOR-7F, 3 devices)
- II preset binary descriptor tables (vendor envelope spec; III shape
  byte-identical and decodable without hardware from existing dumps)
- 21-bit septet packing with byte-2-mask preservation
- AEImageDepot alphabetical-cascade block ordering (`FUN_00595260`)
- Per-block 28-row width table + X→Y offsets (II preset binary layout)
- fn 0x28 device-emitted enum dump (hardware truth over wiki)
- JUCE BinaryData ZIP label extraction (5-minute label discovery)
- Q16 / log10 / trim-tolerant display ↔ wire coercion
- 8 more (preset name, scene state, block record, param descriptor,
  msb-first preset payload, etc.)

When you discover, refine, or rule out a primitive, register it the
same session. See `primitives/INDEX.md` § "Adding to this index" for the
discipline.

## 2. Per-device decode status

| Device | Wire-map | Decode status | Primitives coverage |
|---|---|---|---|
| **AM4** | [`devices/am4/SYSEX-MAP.md`](../devices/am4/SYSEX-MAP.md) | 100% catalog (mature) | ~7 primitives apply directly |
| **Axe-Fx II** | [`devices/axe-fx-ii/SYSEX-MAP.md`](../devices/axe-fx-ii/SYSEX-MAP.md) | ~97.4% catalog, preset-binary round-trip working | ~15 primitives apply (highest density) |
| **Axe-Fx III** | [`devices/axe-fx-iii/SYSEX-MAP.md`](../devices/axe-fx-iii/SYSEX-MAP.md) | SET shape locked; preset binary envelope shape byte-identical to II (decodable from existing dumps) | Transfer candidates from II for 6+ primitives |
| **Hydrasynth** | [`devices/hydrasynth/SYSEX-MAP.md`](../devices/hydrasynth/SYSEX-MAP.md) | Capability decode in progress | Limited, different vendor protocol |

Authoritative per-device status table:
**[`research/fractal-protocol-decode-status.md`](fractal-protocol-decode-status.md)**.

## 3. Captured artifacts (what we already have, before asking for more)

- **Public manifest**: [`research/captured-artifacts.md`](captured-artifacts.md)
, forum / public captures + non-sensitive probe outputs that ship
  with the OSS repo.
- **Founder-private manifest**: the consumer repo's private captured-artifacts
  manifest (gitignored, local to the founder's working tree): decompile
  dumps, founder USB captures, factory `.syx` files.

Both are organized by **decode purpose**, not by session ID. Before
proposing a new capture or Ghidra run, scan both for un-mined material.

## 4. Ghidra scripts

[`../scripts/ghidra/README.md`](../scripts/ghidra/README.md): per-
script registry. ~60 scripts; semantic naming (Mine* / Find* / Dump* /
Trace* / Seek* / Decode* / Probe* / Map*). Each script lists what it
discovers, what output file it produces, last run, and current status.
Check this before writing a new script.

## 5. Per-device follow-ups (research roadmap, status legend, open Ghidra targets)

- [`devices/axe-fx-ii/ghidra-followups.md`](../devices/axe-fx-ii/ghidra-followups.md)
- `devices/hydrasynth/ghidra-followups.md` (pending)
- AM4: deferred, currently at 100% catalog, no active open items.

## 6. Methodology + workflow guides

- **Ghidra mining workflow**: [`research/ghidra-mining-workflow.md`](ghidra-mining-workflow.md)
, canonical methodology + 5+ documented "what didn't work" entries
  (don't re-attempt).
- **Broadcast vs poll research**: [`research/fractal-broadcast-vs-poll-research.md`](fractal-broadcast-vs-poll-research.md)
- **Capture guides**: [`capture-guides/`](../capture-guides/): USBpcap
  + Wireshark setup, JUCE BinaryData extraction.

## 7. Synthesis reports

`research/synthesis-log/`, dated cross-cutting synthesis reports from
agent runs that look across the whole accumulated finding-corpus to
spot connections single sessions miss. The first synthesis surfaced
~4.3 MB of un-mined material across 30 dump files; cite reports back
into primitive entries' Refinement history when they trigger updates.

---

## How agents should use this

**Session start (codec/protocol RE work):**

1. Open `primitives/INDEX.md`, is the thing you're about to decode an
   instance of a known primitive?
2. If yes → apply the primitive, register a new fixture if it adds
   verification value.
3. If no → check `captured-artifacts.md` for un-mined material that
   might already contain what you need. Then check
   `../scripts/ghidra/README.md` to see if a script already exists.
4. If still no → propose the new probe / script / dump. Register the
   resulting artifact the same session.

**Session close (regardless of work type):**

1. **Cross-device transfer reflex**: if you discovered or refined a
   primitive on one device, file `[transfer-candidate]` follow-ups in
   the other 3 devices' STATE files (per the consumer repo's `CLAUDE.md` §
   "Cross-device transfer reflex").
2. **Same-session artifact registration**: any new script / dump /
   capture / primitive must be in its respective index BEFORE close.
3. **Synthesis trigger check**: if a primitive moved status `partial-N1`
   → `matched`, a new `_negative/` entry landed, a backlog workstream
   closed, or ≥ 10 sessions have passed since the last synthesis run,
   note "consider running `npm run synthesis-review`" in the close-out.

## OSS contributor IP rule

The codec is OSS-publishable. The narrative is welcome, paramId
tables, opcode enums, calling-convention writeups, decode methodology
all ship publicly. **Raw decompile listings are NOT.** PRs that
include raw disassembly or decompiled C from any Fractal binary,
AxeEdit, or AM4-Edit will be closed and the contributor asked to
resubmit as narrative + cited offsets + scripts to regenerate. See
[`AGENTS.md`](../../AGENTS.md) for the full contributor protocol.
