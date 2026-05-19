# AM4 0x01 EDITOR_STREAM analysis — session 59 (2026-05-11)

Cross-action analysis of the 6 AM4 captures produced via
`scripts/capture-midi-passive.ts` while AM4-Edit was running and
the founder performed targeted actions in AM4-Edit's UI.

**Total: 21,036 messages across 6 captures, 99.97% function 0x01.**

## Wire format reminder (per session-04 RE)

```
F0 00 01 74 15 01 [addr:4] [action:1] 00 00 00 [len:1] [payload:N] [cs] F7
└─F0─┘ └─mfr─┘ └m─┘ fn  └─addr─┘  action     padding   len  └─bytes─┘  cs F7
                                                       (raw)
```

## Action-code distribution (combined across all 6 captures)

| Action byte | Count | Interpretation |
|---|---|---|
| `0x0D` | ~18,000+ | **DOMINANT READ** — most-polled param-read action. Likely the standard "read this param's current value" command. Not in wiki. |
| `0x26` | ~570 | Secondary read action — already documented in session-04 RE |
| `0x10` | ~675 | TEMPO action — wiki-documented |
| `0x0E` | ~840 | SCENE_NAME query — wiki-documented |
| `0x1F` | ~211 | Periodic poll, undocumented action — moderate count across all captures |
| `0x12` | ~318 | MODE_SWITCH — wiki-documented (used by mode changes + state queries) |
| `0x17` | ~87 | MIDI_CHANNEL — wiki-documented |
| `0x01` | ~10 | **WRITE** — per session-04 RE this is the standard parameter-set action |
| `0x02` | ~7 | New action — appears only in param-change. Possibly a typed write. |
| `0x00` | ~6 | Rare action — possibly a status null/sentinel query |

## Address-space size per action

| Capture | 0x01 messages | Unique addresses |
|---|---|---|
| edit-sync | 5,561 | 44 |
| preset-switch | 3,069 | 41 |
| param-change | 1,830 | **63** |
| block-bypass | 2,747 | 55 |
| block-type-swap | 5,530 | **79** ⭐ widest |
| scene-switch | 2,290 | not extracted |

Block-type-swap touches the most distinct addresses (79) — consistent
with the operation cascading state changes across many params when a
block's type is changed.

## Non-READ events surfaced — these are the protocol-RE gold

Stripping out polls/queries (actions 0x26, 0x0D, 0x10, 0x1F, 0x0E)
leaves ~300 messages across the 6 captures with **new payload shapes
not covered by our existing AM4 decode work**:

### Sample non-READ events from edit-sync

```
addr=[3e 00 0c 00] action=0x12 len=33  ← 33-byte payload at 0x12 action
addr=[25 00 01 7d] action=0x17 len=40  ← 40-byte payload at 0x17 action
addr=[4e 01 0b 00] action=0x12 len=32  ← 32-byte payload at 0x12 action
addr=[02 00 1c 00] action=0x00 len=40  ← 40-byte payload at 0x00 action
addr=[4e 01 0a 00] action=0x01 len=40  ← 40-byte payload at 0x01 (WRITE!)
```

**Critical finding:** AM4's `0x01` editor stream supports payloads
much larger than the **6-byte parameter values** we documented from
session-04. Action codes `0x12`, `0x17`, `0x00`, and even `0x01`
(WRITE) carry **32-40 byte payloads** in real AM4-Edit traffic.

This means **our existing AM4 protocol model is incomplete** — it
covers the param-set / param-read case (action 0x01 + 6-byte value,
action 0x26 + 0-byte read) but not the bulk-state operations AM4-Edit
uses for block-type swap, preset switch internals, and other complex
edits.

### Specific addresses worth investigating

These addresses showed write or large-payload activity — candidates
for new decode work:

- `[3e 00 0c 00]` — appears with action 0x12 + 33-byte payload (mode/state?)
- `[25 00 01 7d]` — appears with action 0x17 + 40-byte payload (channel
  config blob?)
- `[4e 01 0a 00]`, `[4e 01 0b 00]` — adjacent addresses, action 0x01/0x12
  + 32-40 byte payloads (preset-level state?)
- `[02 00 1c 00]` — action 0x00 + 40-byte payload (raw block?)
- `[3a 00 01 7d]` — appears in param-change with action 0x17 + 40 bytes
- `[4e 01 01 7d]` — also action 0x17 + 40 bytes
- `[46 00 01 7d]` — appears in bypass capture with action 0x17 + 40 bytes
- `[46 00 03 00]` — appears in bypass capture with action 0x01 + 40 bytes

The repeated `[XX YY 01 7d]` pattern suggests a structured address
space where the last two bytes (`01 7d`) might be a fixed marker
indicating a particular operation class.

## What this unlocks

1. **AM4 block-type swap decode** — the captures contain the wire
   sequence for changing a block's type via AM4-Edit. Reverse-
   engineering one `[46 00 ...] action=0x01 len=40` payload tells us
   how to programmatically swap blocks instead of just changing
   params.

2. **AM4 bulk-state operations** — the 40-byte payloads at addresses
   like `[02 00 1c 00]` and `[4e 01 0a 00]` are doing something
   bigger than param-set. Likely candidates: full block-state load,
   scene-state load, preset metadata write.

3. **Preset save wire format** — captures don't include an explicit
   "save preset" trigger but the block-type-swap capture is rich
   enough to potentially reveal save-class operations as side
   effects (AM4-Edit may save state implicitly after some edits).

4. **Cross-reference action 0x0D** — the dominant read action wasn't
   in our session-04 model (which documented 0x26 as the read action).
   AM4-Edit uses 0x0D far more than 0x26. Worth identifying what
   distinguishes them — different param classes? Different read
   semantics?

## Comparison to Axe-Fx II

| Property | AM4 | Axe-Fx II |
|---|---|---|
| Function bytes used | Almost exclusively `0x01` | Many distinct: 0x02, 0x14, 0x29, 0x74/0x75/0x76 |
| Dispatch | Action-byte within 0x01 (0x01, 0x0D, 0x26, 0x10, 0x12, 0x17 etc.) | Function byte at the envelope level |
| Bulk state | Within-0x01 with large payloads | Dedicated 0x74/0x75/0x76 triple |
| Idle broadcast | NONE (silent) | Continuous (0x10 tempo + 0x12 + 0x15 + 0x18) |

AM4 = unified action-based dispatch inside a single function byte.
Axe-Fx II = specialized function bytes per operation class. Two
different protocol architectures from the same vendor, reflecting
~2 generations of design evolution.

## Next-session pickup points

1. **Map each 0x0D read response to its address-space coordinate.**
   The captures contain ~18,000 reads — most addresses are repeats
   (AM4-Edit polling the same param multiple times). Sample 100
   distinct addresses and cross-reference against `cache-section2.
   json` / `cache-section3.json` to verify our address space matches
   the real AM4-Edit's polling pattern.
2. **Decode the 40-byte action-0x17 payloads.** They appear at
   multiple `[XX 00 01 7d]` addresses suggesting structured data.
   Compare across captures (preset-switch vs param-change vs bypass)
   to see what fields change.
3. **Decode block-type-swap.** Take the block-type-swap capture and
   isolate the write events that fire when the block-type is
   actually changed (vs preceding/following polls). The address
   touched is the block-type wire address; the payload contains the
   new block-type encoding.
4. **Identify action 0x0D vs 0x26.** Capture a single param read
   (close AM4-Edit, send our own GET via the MCP server, see what
   response action code comes back). If we see 0x26 only, then 0x0D
   is AM4-Edit-specific. If we see 0x0D, then AM4-Edit and our
   server use different read actions — significant architectural
   note.

## Sources

- `samples/captured/session-59-am4-*.syx` (gitignored, ~21K messages)
- Capture script: `scripts/capture-midi-passive.ts`
- Wire format origin: `docs/_private/SESSIONS.md` Session 04 (2026-04-14)
- Existing AM4 protocol reference: [`SYSEX-MAP.md`](SYSEX-MAP.md)
- Cross-device comparison: `docs/_private/AM4-VS-AXEFX2-BROADCAST-BEHAVIOR.md`
