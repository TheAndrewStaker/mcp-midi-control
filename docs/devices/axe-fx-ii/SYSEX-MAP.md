# Axe-Fx II Family SysEx Map — Working Protocol Reference

> **Status:** Discovery artefact. Wiki + manual + bank-file evidence
> consolidated 2026-05-09 (Session 53). Some entries hardware-confirmed
> against an Axe-Fx II XL+ Q8.02 export; others sourced from the
> Fractal Audio Wiki and pending hardware verification.
>
> **Sister docs:**
> - [`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md) — AM4-resolved
>   protocol map (deepest current coverage; many AM4 findings transfer
>   to Axe-Fx II since both use the same envelope and checksum scheme).
> - [`component-catalog.md`](component-catalog.md) — Axe-Edit
>   `<EditorControl>` catalog (UI structure, type-applicability gates)
>   generated from the JUCE BinaryData ZIP.
> - [`docs/MULTI-DEVICE-ROADMAP.md`](../../MULTI-DEVICE-ROADMAP.md) —
>   overall multi-device strategy.

---

## Legend

- 🟢 **CONFIRMED** — Documented for the Axe-Fx II family on the
  Fractal Audio wiki (`wiki.fractalaudio.com/wiki/MIDI_SysEx`),
  cross-checked against [`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md), or verified by inspecting
  real wire bytes in the cached factory bank export. Safe to use.
- 🟡 **WIKI-DOCUMENTED, NOT YET HARDWARE-VERIFIED** — Wiki spec exists
  but we haven't yet captured live Axe-Fx II ↔ Axe-Edit traffic to
  prove the device honours the spec at the current firmware. First
  hardware test would shift this to 🟢.
- 🔴 **UNKNOWN** — No wiki coverage, no AM4 analogue. Capture-based
  RE required.

---

## 1. Family overview

The Axe-Fx II family covers four wire-distinct variants of the same
product line. All share the SysEx envelope, the XOR & 0x7F checksum,
and the function-ID conventions documented in the wiki.

| Model byte | Device | Notes |
|------------|--------|-------|
| `0x03` | Axe-Fx II (Mark I / Mark II) | Original Axe-Fx II generations. |
| `0x06` | Axe-Fx II XL | Expanded memory + peripherals. |
| `0x07` | **Axe-Fx II XL+** | **Founder owns this; wire-confirmed Session 53.** |
| `0x08` | AX8 | Floor unit using the same engine. |

The Axe-Edit `__block_layout.xml` (catalog source) declares
`<Device model="3"/>`, `<model="6"/>`, `<model="7"/>` in its
header — Axe-Edit's internal numbering for the three Axe-Fx II
generations using the same model byte values.

Family wire shape (envelope + checksum) is identical to AM4. See
[`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md) §2 (Envelope Format) and §3 (Checksum Algorithm).

## 2. Source documents and where each fact comes from

| Source | URL / path | Coverage |
|--------|------------|----------|
| Fractal Audio Wiki — `MIDI_SysEx` | `https://wiki.fractalaudio.com/wiki/index.php?title=MIDI_SysEx` | Authoritative protocol spec for Axe-Fx II / AX8 / AM4 / VP4 / III/FM family. **Cached at `docs/_private/wiki-cache/axe-fx-ii-midi-sysex.html`.** Includes the full per-block parameter ID tables (CPR / GEQ / PEQ / AMP / CAB / REV / DLY / etc.) — these are the wire-IDs missing from the Axe-Edit XML catalog. The wiki disclaims the SysEx info is "printed here with the permission of Fractal Audio." |
| Fractal Audio Wiki — `Axe-Fx_SysEx_Documentation` (gen1) | `https://wiki.fractalaudio.com/gen1/index.php?title=Axe-Fx_SysEx_Documentation` | Original Axe-Fx Standard / Ultra protocol — direct ancestor. **Cached at `docs/_private/wiki-cache/axe-fx-gen1-sysex-documentation.html`.** Useful for understanding the function-ID space evolution. |
| Axe-Fx II Owner's Manual (Q7.0) | `docs/devices/axe-fx-ii/manuals/Axe-Fx-II-Owners-Manual.{pdf,txt}` | Hardware-anchored facts: SysEx ID `00 01 74` (cannot be changed), preset count (768 on XL/XL+, 384 on Mark I/II), 8 scenes, MIDI Implementation Chart at §17.3. |
| Factory bank export (Quantum 8.02) | `samples/factory/Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx` | **Wire-canonical preset binary on the founder's hardware.** Three banks × 128 presets × 66 messages each = 8448 SysEx messages per bank. Used for 0x77/0x78/0x79 envelope validation Session 53. |
| Axe-Edit `__block_layout.xml` | `samples/captured/decoded/binarydata/axe-edit-extracted/__block_layout.xml` | UI-side: 39 block types, 2482 editor rows, 1035 unique parameter names, 160 type-applicability gates. Catalogued in [`component-catalog.md`](component-catalog.md). **Does not contain wire IDs** — for those, use the wiki tables. |

## 3. SysEx envelope 🟢

```
F0 00 01 74 [model] [function_id] [...payload...] [checksum] F7
```

Identical to AM4. Per the Owner's Manual:

> **SysEx ID: 00 01 74 (cannot be changed)** — `[I/O > MIDI > SysEx ID]`
> menu, which is read-only on Axe-Fx II.

Manufacturer ID octets `00 01 74` were assigned to Fractal in firmware
10.02. Earlier Standard/Ultra firmwares used `00 00 7D` — no longer
relevant; Axe-Fx II / AX8 / AM4 / VP4 / III all use `00 01 74`.

## 4. Checksum scheme 🟢

```typescript
const checksum = bytes
  .slice(0, -2)              // F0 .. last_payload_byte (exclude existing cs+F7)
  .reduce((acc, b) => acc ^ b, 0) & 0x7F;
```

XOR every byte from `F0` through the last data byte, mask to 7 bits.
Insert before the trailing `F7`.

**Verified Session 53** against 8448/8448 messages in
`Axe-Fx-II_XL+_Bank-A_Q8p02.syx` and equivalents B and C. 100% match.

## 5. Function ID space — Axe-Fx II / AX8

The wiki documents the full set. Reproduced here with hardware-
verification status against the founder's XL+ where applicable:

| ID | Symbolic name | Direction | Status on XL+ |
|----|---------------|-----------|---------------|
| 0x01 | GET_BLOCK_PARAMETERS_LIST | both | 🟡 wiki |
| 0x02 | GET / SET_BLOCK_PARAMETER_VALUE | both | 🟡 wiki — 16-bit value packed into 3×7-bit septets |
| **0x06** | **SET_CELL_ROUTING** (undocumented) | req | **🟢 hardware-decoded on Q8.02 XL+ (Session 70, 2026-05-13)** — 3-byte payload `[src_cell, dst_cell, connect]` adds/removes a cable between adjacent-column cells. Byte-exact golden in `scripts/verify-axe-fx-ii-encoding.ts`. See § 5c. |
| 0x07 | GET / SET_MODIFIER_VALUE | both | 🟡 wiki |
| 0x08 | GET_FIRMWARE_VERSION | both | 🟡 wiki |
| 0x09 | SET_PRESET_NAME | req | 🟡 wiki |
| 0x0D | TUNER_INFO | resp | 🟡 wiki — no checksum on this message |
| 0x0E | PRESET_BLOCKS_DATA | both | 🟡 wiki — 5-byte chunks per block |
| 0x0F | GET_PRESET_NAME | both | 🟡 wiki |
| 0x10 | MIDI_TEMPO_BEAT | resp | 🟡 wiki — no checksum |
| 0x11 | GET / SET_BLOCK_XY | both | 🟡 wiki |
| 0x12 | GET_CAB_NAME / GET_ALL_CAB_NAMES | both | 🟡 wiki |
| 0x13 | GET_CPU_USAGE | both | 🟡 wiki |
| 0x14 | GET_PRESET_NUMBER (read) / MIDI_SET_PRESET (legacy write) | both | 🟡 wiki — 14-bit preset number (XL+ range 0-767). **Captured response payload is MSB-first**, not LSB-first as the wiki suggests — see § 6b below. |
| 0x17 | GET_MIDI_CHANNEL | both | 🟡 wiki |
| **0x1C** | **BANK_DUMP_REQUEST** | req | **🟢 wire-confirmed** (community capture, multiple authors) — 2-byte payload `[bank_id, cs]` where bank_id = 0 (Bank A), 1 (B), 2 (C), 3 (System). Device responds with the corresponding bank as a 0x77/0x78/0x79 envelope sequence. Captured wire: `F0 00 01 74 03 1C 00 1A F7` (Bank A), `…1C 01 1B F7` (B), `…1C 02 18 F7` (C), `…1C 03 19 F7` (System). |
| **0x1D** | **STORE_PRESET (save-to-location)** | req | **🟢 wire-confirmed XL+ Q8.02 (Session 61 capture + HW-102 round-trip, 2026-05-11)** — 2-byte payload `[preset_high, preset_low]` MSB-first; device responds with 0x64 echoing 0x1D + result_code |
| **0x20** | **GET_GRID_LAYOUT_AND_ROUTING** | both | **🟢 wire-confirmed XL+ Q8.02 (Session 69 captures, 2026-05-12)** — 200-byte frame, 192-byte payload, column-major (12 cols × 4 rows × 4 bytes/cell). Each cell `[blockId_lo, blockId_hi, routing_mask, byte3]`. See § 5c. |
| 0x21 | FRONT_PANEL_CHANGE_DETECTED | resp | 🟡 wiki — broadcast by device after 0x08 handshake |
| 0x23 | MIDI_LOOPER_STATUS_ENABLE / MIDI_LOOPER_STATUS | both | 🟡 wiki |
| 0x29 | GET / SET_SCENE_NUMBER | both | 🟡 wiki — scene 0..7 (8 scenes) |
| 0x2A | GET_PRESET_EDITED_STATUS | both | 🟡 wiki |
| 0x2E | SET_TYPED_BLOCK_PARAMETER_VALUE | req | 🟡 wiki — 32-bit float variant for typed-input edits |
| 0x32 | BATCH_LIST_REQUEST_START | resp | 🟡 wiki |
| 0x33 | BATCH_LIST_REQUEST_COMPLETE | resp | 🟡 wiki |
| 0x37 | SET_TARGET_BLOCK | req | 🟡 wiki — must precede modifier and monitor-graph requests |
| 0x3C | SET_PRESET_NUMBER | req | 🟡 wiki |
| 0x42 | DISCONNECT_FROM_CONTROLLER | req | 🟡 wiki — clean-shutdown after 0x08 |
| 0x64 | MULTIPURPOSE_RESPONSE | resp | 🟡 wiki — `[echoed_fn, result_code]` |
| 0x7A | MIDI_START_IR_DOWNLOAD | req | 🟡 wiki — IR download begin |
| 0x7B | MIDI_G2_IR_DATA | req | 🟡 wiki — IR sample chunks (64 messages × 32 chunks) |
| 0x7C | MIDI_CLOSE_IR_DOWNLOAD | req | 🟡 wiki — IR download end + cumulative checksum |
| **0x77** | **PRESET_DUMP_HEADER** | both | **🟢 wire-confirmed XL+ Q8.02 (Session 53)** — 4-byte payload `[bank, preset, 0x00, 0x20]` |
| **0x78** | **PRESET_DUMP_CHUNK** | both | **🟢 wire-confirmed XL+ Q8.02** — 194-byte payload, 64 chunks per preset |
| **0x79** | **PRESET_DUMP_FOOTER** | both | **🟢 wire-confirmed XL+ Q8.02** — 3-byte payload (likely whole-preset checksum) |

(0x77 / 0x78 / 0x79 are not documented in the wiki's main function-ID
table — they live under "MIDI SysEx: Importing/Exporting Presets" which
the wiki section is mostly empty. AM4's [`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md) §10b
decoded the same three bytes for AM4. Today's bank-file inspection
confirms identical envelope shape on Axe-Fx II XL+ Q8.02.)

## 5b. STORE_PRESET (function 0x1D) — save-to-location 🟢

**Wire envelope (request, host → device):**

```
F0 00 01 74 [model] 1D [preset_high] [preset_low] [cs] F7
  preset_high = (preset_number >> 7) & 0x7F
  preset_low  = preset_number & 0x7F
  cs          = XOR of bytes [F0 .. preset_low] masked to 7 bits
```

**Wire envelope (response, device → host):** standard MULTIPURPOSE_RESPONSE.

```
F0 00 01 74 [model] 64 1D [result_code] [cs] F7
  result_code = 0x00 (OK) | 0x05 (parsed but not honored) | ...
```

**Byte ordering is MSB-first** for the preset number — `[preset_high,
preset_low]` — which differs from the wiki's documented LSB-first
ordering for related functions (0x14 GET_PRESET_NUMBER, 0x3C
SET_PRESET_NUMBER). The wiki has no 0x1D entry; the MSB-first ordering
comes from bspaulding/axe-fx-midi and is empirically confirmed against
Q8.02 XL+ (see § 6b for the disambiguating evidence).

**Effect on device state:** commits the active working buffer to
user preset slot `preset_number`. The working buffer is not cleared;
the saved slot now matches the working buffer byte-for-byte. Slot
0-indexed on the wire; front-panel display is 1-indexed (slot
display N corresponds to wire `preset_number = N - 1`).

**Decoding evidence (Session 61, 2026-05-11):**

Passive capture of AxeEdit's File → Save Preset operation to slot 700
on Q8.02 XL+ produced three `0x64` MULTIPURPOSE_RESPONSE messages from
the device:

```
F0 00 01 74 07 64 1D 00 7B F7    ← echoed_fn=0x1D, result=0x00 (STORE OK)
F0 00 01 74 07 64 3C 00 5A F7    ← echoed_fn=0x3C, result=0x00 (post-save preset switch)
F0 00 01 74 07 64 09 00 6F F7    ← echoed_fn=0x09, result=0x00 (SET_PRESET_NAME)
```

Capture file: `samples/captured/session-61-save-attempt.syx`.
Decoder: `scripts/decode-session-61-save.ts`.

**Cross-reference:** bspaulding/axe-fx-midi (Rust, MIT, archived) ships
`store_in_preset` with byte-exact test case for Mark II preset 217:
`[F0 00 01 74 03 1D 01 59 43 F7]`. Math checks out: 217 = (1<<7)+0x59,
XOR across body = 0xC3 → cs = 0x43. Same encoder shape, just our
model byte (0x07 XL+) vs bspaulding's 0x03 Mark II.

**End-to-end round-trip (HW-102, 2026-05-11):** our `buildStorePreset`
encoder fired against Q8.02 XL+ produced byte-identical wire output;
device returned `0x64 1D 00` (OK) and the founder confirmed the
working buffer landed at slot 700 via front-panel inspection. First
attempt success — no encoder bugs in the path.

## 5c. Routing grid wire format (function 0x20 + fn 0x06) 🟢

**fn 0x20 GET_GRID_LAYOUT_AND_ROUTING response — wire-confirmed XL+ Q8.02.**

```
F0 00 01 74 07 20 [192-byte payload] [cs] F7
```

Payload is **column-major**: 12 columns × 16 bytes/column. Each
16-byte column packs 4 rows × 4 bytes/cell:

```
column N (16 bytes) = row0[4 bytes] | row1[4 bytes] | row2[4 bytes] | row3[4 bytes]
cell  (4 bytes)     = [blockId_lo, blockId_hi, routing_mask, byte3_unknown]
```

- `blockId` = 14-bit septet pair (`blockId_lo | (blockId_hi << 7)`).
  Empty cells have blockId = 0; SHUNT cells have blockId = 201.
- `routing_mask` at byte offset +2 is a **4-bit input mask** — each bit
  N (0..3) set means "feed this cell from row N+1 of the previous
  column." So `0x02` (bit 1) = "feed from row 2 of prev col."
  Multi-bit masks encode parallel-path merges (e.g. `0x06` = feed from
  both row 2 AND row 3 of prev col). The mask lives on the
  **destination** cell, not the source. Cabling Amp(R2C2)→Cab(R2C3)
  sets *Cab's* mask to 0x02, leaving Amp's mask untouched.
- `byte3` semantics unknown — likely channel state or per-cell flags.

**State-broadcast `op_flag = 0x03` = "routing changed".** When a
cable is added or removed, the device emits a 0x74/0x75/0x76 triple
targeting the **source** block of the affected cable, with
`op_flag` = 0x03 (distinct from 0x00 = preset structure, 0x01 = block
edit decoded Session 60). Listeners can use this to detect routing
changes without polling the full grid.

**Decoding evidence (Session 69, 2026-05-12):**

Two passive captures (`samples/captured/session-68-click-connect.syx`
and `session-69-click-connect-ctrl.syx`) of AxeEdit's "Click to
connect" gesture on slot 666 "Glassy Clean":

- First capture: clicked + between Comp (R2C1) and Amp (R2C2). Diff
  of pre/post grid frames showed Amp's mask flipped 0x00 → 0x02
  (cell at col 1 row 1, byte offset 6 within the 16-byte column
  stride = byte 2 of row 1's 4-byte cell).
- Control capture: clicked + between Amp (R2C2) and Cab (R2C3). Final
  grid shows Comp(0x02) → Amp(0x02) → Cab(0x02) → Reverb(0x00),
  matching the visible cable chain.

Decoder: `scripts/diff-axefx2-grid-state.ts`.

**fn 0x06 SET_CELL_ROUTING — hardware-decoded Session 70 (2026-05-13).**

Wire envelope:

```
F0 00 01 74 [model] 06
  [src_cell_idx]    ← col-major linear index: (col-1)*4 + (row-1)
  [dst_cell_idx]    ← col-major linear index; MUST be src_col + 1
  [connect]         ← 0x01 = add cable, 0x00 = remove cable
  [cs] F7
```

The device updates `dst_cell.routing_mask` by setting (connect=1) or
clearing (connect=0) the bit at index `src_row_0indexed`. Since the
mask is the destination's INPUT mask (see § 5c above), this is the
inverse of what one might naively guess from the function name —
*"set cell routing"* sets the **destination cell's** mask, not the
source's.

**Captured oracle** (`samples/captured/session-69-click-connect-ctrl.syx`,
AxeEdit click-to-connect on Amp(R2C2) → Cab(R2C3)):

```
F0 00 01 74 07 06 05 09 01 09 F7
  src_cell = 5  = (2-1)*4 + (2-1) = R2C2 (Amp's cell)
  dst_cell = 9  = (3-1)*4 + (2-1) = R2C3 (Cab's cell)
  connect  = 1  = add cable
  cs       = 09 (XOR of F0..01 inclusive, & 0x7F)
```

**Replayed by `scripts/verify-axefx2-routing-write.ts`** against
Q8.02 XL+: device acked `F0 00 01 74 07 64 06 00 [cs] F7` (result
code 0x00 = OK) and the grid-state read confirmed Cab's routing
mask flipped 0x00 → 0x02 ("Cab now feeds from row 2 of col 2 = Amp").

**Critical bug rooted out:** prior probe scripts (`probe-axefx2-
routing.ts`, `probe-axefx2-routing-sweep.ts`) used a local checksum
that started XOR at index 1 (excluding the leading F0). Fractal's
canonical checksum INCLUDES F0 (`src/fractal/shared/checksum.ts`).
Switching probes to the canonical `fractalChecksum` flipped most
of Session 68's 0x01 acks to 0x00 OK — the "payload shapes failed"
finding was a cs-validation failure misdiagnosed as shape rejection.

**Result codes observed on Q8.02 XL+:**
- `0x00` — OK, routing updated
- `0x01` — request rejected (e.g. non-adjacent columns, malformed)
- `0x0C` — payload length too short

**Implementation:** `buildSetCellRouting({srcRow, srcCol, dstRow,
dstCol, connect})` in `src/fractal/axe-fx-ii/setParam.ts`. The
applyExecutor uses it to wire EVERY adjacent pair in row 2, both
between content blocks (cols 1→2, 2→3, ..., N-1→N) AND through the
shunt-chain extension (cols N→N+1 through 11→12). Closes the
silent-preset bug (HW-105) that was the Axe-Fx II MVP ship gate.

**Content blocks do NOT auto-route on fn 0x05 placement.** Session 70
slot-601 hardware test (2026-05-13) proved this empirically: Comp /
Amp / Cab / Reverb placed via fn 0x05 SET_GRID_CELL came up with
routing_mask=0 across all four cells. The earlier "device auto-cables
Comp→Amp→Cab→Reverb on row 2" assumption was wrong — what actually
happened in pre-Session-70 tests was that the SOURCE slot (e.g.
slot 666 "Glassy Clean") already had the cables saved from a prior
authoring session, and our apply was inheriting that wiring. Once
applied to a truly-empty target slot (601), the content blocks land
unwired. Fix: emit explicit fn 0x06 cables for every adjacent pair
from col 2..12, regardless of whether the source cell is a content
block or a shunt. Byte 3 of fn 0x05 confirmed unrelated to routing
(probed values 0x00, 0x01, 0x02, 0x04, 0x08, 0x0F — all accepted by
device, none mutate the routing_mask).

**Each shunt position needs a UNIQUE block instance ID.** Session 71
in-to-out-route capture (`samples/captured/session-71-in-to-out-
route.pcapng`, 2026-05-13) shows AxeEdit placing 6 shunts at cols 7-12
using `blockId` 200, 201, 202, 203, 204, 205 — one unique instance
per cell. Reusing the same blockId across positions triggers the
device's documented "move on duplicate" behavior (`setParam.ts:797`):
the second placement clears the first cell as a side effect, leaving
only the LAST placement persisted. Per-cell mask=0 broke the chain
even after cabling — silent preset. Fix: use `SHUNT 1`..`SHUNT N`
(`blockId 200 + (n-1)`) for each shunt position, never repeating an
instance ID within a single preset.

**fn 0x05 envelope is 3 payload bytes in AxeEdit's wire format**, not
4 — `F0 00 01 74 [model] 05 [block_lo] [block_hi] [cell_idx] [cs] F7`
(11 bytes total). Our `buildSetGridCell` appends a 0x00 "reserved"
byte (12 bytes total). Device accepts both — 4-byte format was
hardware-verified in Session 62/63 probes — but AxeEdit's canonical
form omits the trailing byte. No known semantic difference under
Q8.02, but minimizing protocol drift is preferable; pending future
session to retire byte 3.

## 6b. 0x14 GET_PRESET_NUMBER byte-ordering correction 🟢

**Wiki says:** the 0x14 response payload is `[bits 6-0, bits 13-7]` —
LSB-first. **Q8.02 XL+ actually emits MSB-first** — `[bits 13-7,
bits 6-0]` — at least for the response side.

**Evidence:** session-61 passive capture, captured immediately after
AxeEdit saved the working buffer to slot 700:

```
F0 00 01 74 07 14 05 3B 28 F7    ← payload bytes: 05 3B
```

- **LSB-first decode** (per wiki): `0x05 + (0x3B << 7) = 5 + 7552 = 7557`
  — impossible (XL+ user preset range is 0..767).
- **MSB-first decode**: `(0x05 << 7) + 0x3B = 640 + 59 = 699` — matches
  the founder's reported save target (front-panel display "slot 700"
  is wire preset 699 per the 0-vs-1-indexing finding HW-100).

The wiki appears to be wrong about ordering for at least the response
side. The request side (0x3C SET_PRESET_NUMBER) hasn't been
disambiguated against hardware for `preset_number ≥ 128`; our
`buildSwitchPreset` currently emits LSB-first per wiki, only verified
on preset 0 (HW-100) where the orderings are indistinguishable. Open
item: HW-103 will verify 0x3C on a non-zero preset to either confirm
the wiki or correct it.

## 6. Preset binary format on the wire 🟢

Verified Session 53 by inspecting `samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx`
via `scripts/inspect-axe-bank-syx.ts`:

### Bank file structure

A factory bank export is a flat concatenation of N presets, each preset
laid out as **1 header + 64 data chunks + 1 footer** = **66 messages**.
A bank file holds 128 presets (8448 messages, ~1.6 MB). The XL+ ships
3 factory banks (A / B / C), totaling 384 presets in the factory bundle
(of the device's 768-slot user capacity).

```
preset_dump = [
  F0 00 01 74 07 77 [bank] [preset] 00 20 [cs] F7    ← 12 bytes
  F0 00 01 74 07 78 [194-byte payload] [cs] F7        ← 204 bytes × 64 chunks
  F0 00 01 74 07 79 [3-byte payload] [cs] F7          ← 10 bytes
]
```

### Header payload semantics

| Bytes | Bank A first | Bank B first | Bank C first |
|-------|--------------|--------------|--------------|
| `payload[0]` | `0x00` | `0x01` | `0x02` |
| `payload[1]` | `0x00` | `0x00` | `0x00` |
| `payload[2]` | `0x00` | `0x00` | `0x00` |
| `payload[3]` | `0x20` | `0x20` | `0x20` |

`payload[0]` is the bank index. `payload[1]` is the preset index
within bank (`0x00..0x7F` for the 128 presets of each bank).
`payload[2..3]` = `00 20` are constants — purpose unverified, likely
a payload-size or magic-number field. The same constants appear on
AM4's `0x77` payload (`[bank A..Z, sub_index 0..3, 00, 20, 00]`)
suggesting a shared family layout where the constant bytes pad to a
fixed-width header.

### Preset name encoding

Visible at chunk #0, byte offset 8 of payload, in 3-byte triplets:
each character is one ASCII byte followed by two zero bytes. Examples
extracted from the factory bank:

- A001 = `"59 Bassguy"`
- B001 = `"Galaxy Formation"`
- C001 = `"Squashed"`

The two zero bytes following each character likely reserve space for
larger character sets (UTF-something) but are unused for ASCII. AM4
encodes preset names without this padding — the family format is not
identical at every level.

## 7. Block IDs (from wiki) 🟡

The wiki lists 70+ block IDs in the range 100..170 (effects) and
200..235 (shunts). Excerpt of the most-iconic blocks:

| ID | Block | Wiki group | XML name |
|----|-------|-----------|----------|
| 100, 101 | Compressor 1, 2 | CPR | Compressor |
| 102, 103, 160, 161 | Graphic EQ 1..4 | GEQ | GraphicEQ |
| 104, 105, 162, 163 | Parametric EQ 1..4 | PEQ | ParametricEQ |
| **106, 107** | **Amp 1, 2** | **AMP** | **Amp** |
| **108, 109** | **Cab 1, 2** | **CAB** | **Cab** |
| 110, 111 | Reverb 1, 2 | REV | Reverb |
| 112, 113 | Delay 1, 2 | DLY | Delay |
| 114, 115 | Multi Delay 1, 2 | MTD | MultiDelay |
| 116, 117 | Chorus 1, 2 | CHO | Chorus |
| 122, 123 | Phaser 1, 2 | PHA | Phaser |
| 124, 125 | Wah 1, 2 | WAH | Wah |
| 130, 153 | Pitch 1, 2 | PIT | Pitch |
| 133, 134 | Drive 1, 2 | DRV | Drive |
| 141 | Controllers | CONTROLLERS | Controllers |
| 144, 145 | Synth 1, 2 | SYN | Synth |
| 169 | Looper | LPR | Looper |
| 170 | Tone Match | TMA | _(no XML — Tone Match is recipe-driven, no editor surface)_ |

Multiple instances per block (e.g. Amp 1 / Amp 2) reflect that an
Axe-Fx II preset can have two of each block in its 4×12 grid. AM4
has only one amp slot; XL+ has two.

Full table at `docs/_private/wiki-cache/axe-fx-ii-midi-sysex.html`,
section "Axe-Fx II MIDI SysEx: Block IDs".

## 8. Per-block parameter tables (wiki) 🟡

The wiki documents per-block parameter tables with `(block, paramId,
name, type, options/range, modifier-assignable, fw-added)` columns
for every block group (CPR / GEQ / PEQ / AMP / CAB / REV / DLY / MTD /
CHO / FLG / ROT / PHA / WAH / FRM / VOL / TRM / PIT / FIL / DRV / ENH /
FXL / INPUT / OUTPUT / CONTROLLERS / SYN / GTE / RNG / LPR / SND / RTN /
MIX / MBC / XVR / MGT). These are the wire-IDs needed to implement
`buildSetParam` / `buildReadParam` — the closest analogue to AM4's
hand + generated `KNOWN_PARAMS`.

Highlights from the AMP table (Quantum 8.02):

- 259 amp models in the EFFECT TYPE enum (param 0): from `0: 59 BASSGUY`
  through `258: 5F1 TWEED EC`.
- 108 entries in the TONE STACK enum (param 34): `ACTIVE`, `DEFAULT`,
  `BROWNFACE`, `BLACKFACE`, ...
- ~75 first-page + advanced knobs — covers everything the Axe-Edit
  XML's Amp `<EditorControl>` rows reference.

Cross-validation between the XML catalog and wiki tables is the
checkable path for `paramName ↔ paramId` mapping: where both sources
list a parameter on the same block, the XML's `parameterName` symbol
+ the wiki's `(block, paramId)` identify the same wire entry.

**Status (Session 54):** generator landed.
`scripts/extract-axe-fx-ii-params.ts` joins the wiki HTML and the XML
catalog and emits `src/fractal/axe-fx-ii/params.ts` (929 params,
72% XML join rate). Regenerate via `npm run extract-axe-fx-ii-params`.
Every entry stays 🟡 wiki-documented; hardware verification (HW-074)
would promote to 🟢.

## 9. Parameter value encoding 🟢

Per wiki section "MIDI SysEx: obtaining parameter values":

- **0-65534 range (Axe-Fx II), unlike Standard/Ultra's 0-254.**
- Encoded as 3 septets `[XX YY ZZ]`:
  - `XX` = bits 0-6 of the value
  - `YY` = bits 7-13
  - `ZZ` = bits 14-15 (top 2 bits, padded into a 7-bit byte)

Encoder/decoder code samples in the wiki C++ snippets. AM4's
`src/fractal/shared/packValue.ts` is the reference implementation
for the same family of bit-packing.

## 10. What this leaves blocked

Hardware-free work this consolidates unlocks:

- ✅ **Axe-Fx II `blockTypes.ts`** — Session 54: generated from wiki Block IDs
  table. 71 entries with `id`, `name`, `groupCode`, `canBypass`,
  `availableOnAX8`. See `src/fractal/axe-fx-ii/blockTypes.ts`.
- ✅ **Axe-Fx II `params.ts`** — Session 54: generated from wiki
  per-block parameter tables joined with the XML catalog's
  `parameterName` symbols (case-insensitive label match).
  929 parameters across 34 wiki groups, 669 (72%) joined to XML
  symbols. Includes inlined enum tables (e.g. `AMP_EFFECT_TYPE_VALUES`
  with 259 amp models), type-applicability gates from XML, and
  per-param wiki provenance (`wikiName`, `fwAdded`, `modifierAssignable`).
  See `src/fractal/axe-fx-ii/params.ts`. Regenerator:
  `npm run extract-axe-fx-ii-params`.
- ✅ **`setParam.ts` encoder** — Session 54: hand-written GET/SET_BLOCK_
  PARAMETER_VALUE envelope (function 0x02) with the wiki's 3-septet
  16-bit value packing, default modelByte 0x07 (XL+) and override for
  Mark I/II / XL / AX8. Byte-exact goldens in
  `scripts/verify-axe-fx-ii-encoding.ts` (in `npm test`).
- **Bank file parser** — replay or modify factory presets via the same
  `0x77 / 0x78 / 0x79` codepath AM4 uses (`src/fractal/am4/safety/backup.ts`
  + `src/fractal/am4/factoryBank.ts` are the analogues).

Hardware-blocked:

- **Live Axe-Edit ↔ device USBPcap capture** to confirm wiki-documented
  function IDs land on Quantum 8.02 firmware and decode any that the
  wiki marks "?".
- **Per-parameter unit/range/scaling rules** — the wiki gives min/max
  and step for some entries but not the display-unit conversion for
  log-curve params (frequency, time, etc.). AM4's
  `typeApplicability.ts` + `cacheParams.ts` learnt these per-knob via
  hardware spotchecks; same path applies.
- **Save/load semantics** — does sending a captured bank dump back over
  the wire actually persist on Axe-Fx II XL+? AM4 confirmed yes via
  Session 51; XL+ is unverified.

See the project's local hardware-tasks queue for the work order.
