# Ghidra-findings follow-ups — execution log

> Session 103 mined the Axe-Edit.exe binary and recovered the full
> 94-opcode SysEx vocabulary (`docs/devices/axe-fx-ii/axeedit-opcode-table.md`).
> This file tracks each downstream improvement so the findings don't go
> stale before they're exhausted.
>
> Status legend: ⏳ in progress · ✅ landed · 🔜 next · 🚫 dropped · ⏸ blocked
>
> **Repo layout note (corrects an earlier draft of this doc):** the
> `fractal-midi` codec was already extracted to its own repo at
> `C:/dev/fractal-midi/` (Session 98). All A3-style codec work lands
> THERE, not in mcp-midi-tools. See the "Two-repo layout" section in
> the root `CLAUDE.md` for the change workflow.

## Phase A — hardware-free, ship now

### A1. ✅ Opcode-table doc corrected with enum-vs-wire offset

The original `axeedit-opcode-table.md` listed raw enum values labeled
as "Wire" bytes. The preamble correctly stated `wire_byte = enum - 1`,
but the table rows didn't apply the offset, propagating confusion (e.g.
the row labeled `0x47 = SYSEX_PATCH_PLUS_CAB_DUMP` when the captured
fn 0x47 frame in `session-58-direct-sync.syx` is actually
`SYSEX_GET_SYSINFO`).

Fix: doc table rewritten with `wire = enum - 1` applied uniformly,
cross-checked against 15+ known wire bytes captured live on Q8.02.

### A2. ⏳ `docs/devices/axe-fx-ii/SYSEX-MAP.md` updated with new opcodes

9 wire bytes recovered from Ghidra that are not in the wiki:

| Wire | AxeEdit name | Notes |
|------|--------------|-------|
| 0x0C | SYSEX_SET_GRID | grid layout WRITE (write companion to fn 0x20 GET) |
| 0x0E | SYSEX_QUERY_STATES | atomic bulk state read (= PRESET_BLOCKS_DATA in wiki) |
| 0x16 | SYSEX_GET_PARAM_INFO | per-param metadata query |
| 0x18 | SYSEX_GET_MODIFIER_INFO | per-block modifier metadata |
| 0x1F | SYSEX_GET_ALL_PARAMS | bulk per-block param dump |
| 0x21 | SYSEX_RESYNC | request device state push (= FRONT_PANEL_CHANGE_DETECTED in wiki) |
| 0x28 | SYSEX_GET_PARAM_STRINGS | enum-value label query (firmware-version-tolerant) |
| 0x47 | SYSEX_GET_SYSINFO | device sysinfo (richer than fn 0x08) |
| 0x48 | SYSEX_FSGRID | footswitch grid |

Also rename or annotate 6 wiki entries where AxeEdit and wiki agree
semantically but use different names (`PARAM_RW` ↔ `PARAM_SET/DUMP`,
`STORE_PRESET` ↔ `SAVE_PATCH`, etc.).

### A3. 🔜 `fractal-midi/src/axe-fx-ii/opcodes.ts` — typed enum

A single source of truth for wire-byte constants. Replaces every
integer literal in `fractal-midi/src/axe-fx-ii/setParam.ts`
(`const FUNC_GET_PRESET_NUMBER = 0x14`) with
`OPCODES.GET_PRESET_NUMBER`. Generated from the Ghidra dump.

**Lives in: `C:/dev/fractal-midi/`** (separate repo). Workflow per
the root `CLAUDE.md` "Two-repo layout" section.

### A4. 🔜 fn 0x20 SYSEX_RESYNC sender + listener

Highest-value functional unlock that doesn't need HW-115. The device
emits state-broadcast triples (`0x74/0x75/0x76`) when it gets a
SYSEX_RESYNC. Our decoder already handles those triples
(`scripts/_research/decode-axefx2-chunk.ts`).

(Note the wire byte is `0x20`, not `0x21`. The earlier draft of this
doc said `0x21`. AxeEdit's enum 0x21 = SYSEX_RESYNC, applying the
`-1` offset gives wire `0x20`. See `axeedit-opcode-table.md` post-fix.
This collides with `GET_GRID_LAYOUT` per the wiki — likely a wiki
error that AxeEdit's table corrects.)

Pipeline:

1. Codec side (`C:/dev/fractal-midi/src/axe-fx-ii/setParam.ts`):
   add `buildResync()` builder.
2. MCP side (`C:/dev/mcp-midi-tools/packages/axe-fx-ii/src/`): add
   a `getWorkingBufferState()` method on the II reader that sends
   RESYNC, subscribes to inbound triples for ~1-2 s, decodes each
   via the existing position-as-paramId logic, and returns
   `Map<blockId, Map<paramId, wireValue>>`.
3. Wire it into a unified `get_preset(port)` v1 that turns the
   collected per-block state into a `PresetSpec`.
4. Goldens: send RESYNC, assert triples come back.

If fn 0x20 RESYNC works as named, this is the BK-070 atomic-read
deliverable WITHOUT needing the HW-115 capture. If it doesn't (the
device might require specific context or sender-side flags, OR the
wiki was right and 0x20 is grid-layout), the HW-115 capture-route
remains.

**Open question pre-implementation:** wire byte 0x20 already has a
working GET_GRID_LAYOUT envelope (Session 69). The conflict between
AxeEdit's table (RESYNC at 0x20) and wiki (GRID_LAYOUT at 0x20) is
real. One of these is wrong, or the device has two different
behaviors keyed on payload shape. Diagnose by probing:

1. Send `F0 00 01 74 07 20 [cs] F7` (no payload). Watch what comes
   back. If it's a GET_GRID_LAYOUT_RESPONSE, the wiki wins.
2. If it's a 0x74/0x75/0x76 state-broadcast triple stream, AxeEdit
   wins (RESYNC pushes state).
3. Both can be true — same wire byte, different request payloads.

The diagnose-via-probe takes ~5 min of founder time and resolves
the ambiguity definitively.

### A5. 🔜 AM4-Edit binary opcode-table mining

Apply the same Ghidra approach (`DumpAxeEditIIOpcodeTable.java`
adapted) to `AM4-Edit.exe`. Likely outputs:

- Full AM4 opcode table.
- Confirmation that wire bytes match between AM4 vs II for shared
  envelopes.
- Identification of AM4-specific opcodes the wiki / our codec
  doesn't cover.

The AM4 binary is already in the Ghidra project. Script + run-CMD
should clone in ~20 min.

### A6. 🔜 AxeEdit III binary opcode-table mining

Same as A5 for III. `MineAxeEditIII.java` exists for params; opcode
table is a separate sweep. Likely reveals III's `SET_PARAMETER` wire
shape (Session 97 still-pending HW-AXEFX3-002).

### A7. 🚫 `fn 0x0E SYSEX_QUERY_STATES` decode (response shape)

Dropped from Phase A — needs the HW-115 bidirectional capture to
decode response. Belongs in Phase B.

### A8. 🔜 Cross-device opcode comparison

After A5 + A6 land, produce `docs/devices/cross-device-opcode-comparison.md`
listing each opcode and whether it exists in AM4 / II / III with each
device's wire byte. Reveals firmware-family-shared opcodes (one
decode unlocks all three).

## Phase B — after HW-115 capture lands

### B1. ⏸ fn 0x0E response decode → atomic `get_preset`

The capture confirms the response binary layout. Then we ship the
atomic read primitive. ~1-2 s per call, no scene walk, no state
mutation.

### B2. ⏸ fn 0x1F response decode → per-block bulk param read

Alternative to per-param reads for "give me everything about Reverb 1
right now." ~1 round-trip per block.

### B3. ⏸ fn 0x47 response decode → enriched `device_info`

Capabilities, options, model variant beyond fn 0x08 firmware version.

### B4. ⏸ fn 0x28 SYSEX_GET_PARAM_STRINGS → runtime enum query

Eliminates the hardcoded amp-type-string drift between firmware
versions. `cross-device-enums.ts` becomes a runtime fallback rather
than the source of truth.

## Phase C — bigger initiatives

### C1. ⏸ Captures inventory for AM4 / III / Hydra

Currently II-focused. Apply the same inventory practice across
devices.

### C2. ⏸ `fractal-midi-opcodes.json` build artifact

Ghidra → JSON pipeline so the opcode table is regenerable. CI fails
if AxeEdit's table changes (firmware update) without a corresponding
refresh.

### C3. ⏸ `describe_device.capabilities.atomic_read` / `atomic_write` flags

Set true on devices where we've decoded the atomic read path. Agents
prefer atomic ops where available.

### C4. ⏸ Retire `axefx2_*` device-namespaced tools

Once `get_preset` lands, the agent's 22-call read pain (Session 102)
goes away and several namespaced tools become redundant.

### C5. ⏸ Move `SYSEX-MAP.md` + `axeedit-opcode-table.md` into the
extracted fractal-midi package

The wire protocol docs are codec material. When `fractal-midi`
extracts (per `project_fractal_midi_extraction_plan`), sweep both
files across with the codec in one atomic operation. Don't move
ahead of extraction — the docs cite Ghidra artifacts that live in
mcp-midi-tools.
