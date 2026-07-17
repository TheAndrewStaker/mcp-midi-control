---
name: gen3-editor-sync-read-surface
class: envelope-shape
status: matched-singleton
discovered: 2026-06-04 (codec-backed device-simulator session, no-hardware loopMIDI)
verified_on:
  - fm9
  - fm3 (query surface + model byte + handshake only; single-port loopback has no device responses)
golden: scripts/primitives-verify.ts#case-gen3-editor-sync-read-surface
relates_to: [gen3-fn1f-poll-block-bulk-read, gen3-fn01-grid-set-position-insert, septet-14bit, xor-7f-envelope-checksum]
consumed_in:
  - packages/fractal-gen3/src/simResponders.ts
---

# Gen-3 editor connect/sync read surface (fn=0x01 sub-action reads)

When a gen-3 editor (III-Edit 0x10 / FM3-Edit 0x11 / FM9-Edit 0x12) connects, it
drives a high-frequency read loop over `fn=0x01` sub-actions to learn which
blocks are placed, their descriptors, and the grid layout, then renders the
grid. These are the reads a codec-backed device simulator must answer for the
editor to draw the grid with no hardware. Decoded from a real FM9 connect+sync
capture while building the simulator.

## The invariant that makes a simulator possible

**Every `fn=0x01` response ECHOES the query's bytes 5..11 verbatim**: the fn
byte (`0x01`), the sub-action (byte 6), and the 4-byte address region (bytes
8..11, which carry the 14-bit effectId at 8..9 for block-addressed reads). The
device fills a fixed-length tail after byte 11, then the XOR-7 envelope checksum
([[xor-7f-envelope-checksum]]), then `F7`. This held on 100% of ~18,900 captured
query/response pairs, so a simulator can frame any response by echoing bytes
5..11 and filling the tail, centralized in `simResponders.gen3EchoFrame`.

## Sub-action → response length (FM9 capture)

| sub | meaning | resp len |
|---|---|---|
| `0x2e` | whole-preset layout map | 755 |
| `0x01` | per-block descriptor | 115 (172 when the block is the selected/expanded one) |
| `0x1a` | get-parameter-info | 60 |
| `0x09` | typed GET / SET echo | 60 |
| `0x2a` | preset directory entry | 60 |
| `0x4b` | global table | 60 |
| `0x56` | enum list | 60 |
| `0x1c` | enum-label sweep | 65 |
| `0x7b` | placed-flag status | 23 |
| `0x1b` | param flags | 23 |
| `0x37` | meter/stream | 23 |

`0x1f` is the enum-label READ stream: variable-length (26..53), sequential (the
same address returns the next label each call), so it is NOT address-stable and
a verbatim address store cannot reproduce a given frame; it is harvest-surface,
not render-gating.

## Placed-flag (sub=0x7b)

A block renders as PLACED iff the value bytes 12..13 of its `0x7b` response are
nonzero; the remaining tail is zero. The captured placed set was exactly
`{1, 2, 58, 59, 66, 118}` (eff 1 = the preset/system pseudo-block, carrying the
family signature `1a 21 02 00` at bytes 12..15). The editor only polls `0x7b`
for blocks it already believes are placed (learned from the layout map), so the
**absent-block (all-zero) shape is uncaptured**: the simulator emits all-zero
for an absent block as a hypothesis, confirmed live when a block is deleted.

## Live render validation (FM9-Edit, codec-backed simulator)

The codec-backed simulator (`scripts/_research/sim/` + `simResponders.ts`),
seeded from the FM9 connect+sync capture and driven against a live **two-port**
FM9-Edit over loopMIDI (editor Out -> "AXEloopMIDI Port" -> us; us -> "AXEloopMIDI
Reply" -> editor In), **rendered a full preset grid with no hardware**: FM9-Edit
drew "Super Duos2" (In/Drive/Amp/Cab/Chorus/M-Comp/Reverb/Filter/Out1/Out2 with
routing + scene names), reported "Connected! FM9 FW: 11.00", and populated block
param pages with REAL decoded values (Amp tone stack, Reverb time/size/mix) from
the seeded `fn=0x1F` bulk-read bursts. This is the read surface above, served
verbatim-by-address for the render-gate frames and projected for the decoded
ones. (Single-port editors like FM3-Edit cannot be interposed this way; the
two-port wiring is required.)

### The post-render param-definition stream (`sub=0x1f`) and the insert gate

After the grid draws, FM9-Edit runs an operation it names **"Query All Param
Definitions: clear_editor_refresh"**, a CURSOR-PAGED streaming read on
`sub=0x1f`: the query advances a 14-bit cursor at bytes 10..11 (observed
climbing from 99 to ~14,900 across one block) and the device returns the next
chunk (variable 26..53 bytes). A fixed same-sub fallback answer never advances
the cursor, so the editor re-asks forever and floods; returning EMPTY instead
lets the editor's own timeout fire gracefully (recoverable). The simulator
therefore excludes `sub=0x1f` from its same-sub fallback (`STREAMED_SUBS`).

Block insert is a SEQUENCE that the editor **acks step-by-step**: `sub=0x30`
(select cell) -> `sub=0x32` (insert). The editor stalls before `sub=0x32` if the
`sub=0x30` select is not acked (dialog: "Insert Block : grid_set_position"). The
original single-port capture worked because self-loopback echoed the editor's own
write back, which served as the ack. The two-port simulator reproduces that by
**echoing a write frame back when the mutator has no specific reply** (SimDevice
write branch); with that ack, FM9-Edit advances and emits `sub=0x32` live. Three
inserts captured this way through the running simulator, byte-exact to
[[gen3-fn01-grid-set-position-insert]]:

```
sub=0x32 : f0 00 01 74 12 01 32 00 73 00 00 00 2b 00 ...  eff 115 @ gridPos 43 (r2c8)
           f0 00 01 74 12 01 32 00 43 00 00 00 2c 00 ...  eff 67  @ gridPos 44 (r3c8, Reverb 2)
           f0 00 01 74 12 01 32 00 2e 00 00 00 1f 00 ...  eff 46  @ gridPos 31 (r2c6, Compressor)
```

gridPos = col*6+row confirmed live (43=7*6+1, 44=7*6+2, 31=5*6+1). The inserted
block does NOT re-render (the `sub=0x2e` layout map is served verbatim from the
captured preset, so it can't show new occupancy; projecting the layout from
state is the follow-up). The block-TYPE dropdowns render with N correct entries
(count from the served param structure) but garbage labels ("CC #118") because
the names live in the unseeded `sub=0x1f` stream, so the `{name -> raw-id}`
enum harvest stays gated on serving `sub=0x1f`.

**Enum WRITE-leg harvest does NOT work against the simulator (empirically
falsified, controlled live session).** The hope was: pick dropdown entries by
ORDINAL position → the editor emits a `sub=0x09` SET carrying that entry's raw-id
→ join to the catalog's ordinal→name. It fails: with the dropdown unpopulated
(no `sub=0x1f`), clicking a placeholder entry does NOT commit a selection; the
editor emits a value-0 GET (`sub=0x09` eff/param with value 0), never a raw-id
SET. Confirmed: 9 clicks across the Reverb (eff 66 param 10) and Amp (eff 58
param 10) type dropdowns all returned value 0; the on-screen selection never
changed. The captured reverb raw-ids (524 Spring/529 Hall) came from a REAL
device whose `0x1f` populated the dropdown so a true SET could fire. So the enum
write-leg and the read-name leg are gated on the SAME thing: a device-side
`sub=0x1f` capture (the sim cannot synthesize one; its frame format is
unobserved).

### Live wire confirmations from this session

Driving the live editor confirmed two envelope layouts byte-for-byte:

```
sub=0x30 cell-select : f0 00 01 74 12 01 30 00 00 00 00 00 32 00 ...  -> gridPos @ bytes 12..13 = 50 (r3c9)
sub=0x09 typed       : f0 00 01 74 12 01 09 00 42 00 0a 00 00 00 00 00 00 00 ...
                       -> eff @ 8..9 = 66, paramId @ 10..11 = 10 (Reverb TYPE on FM9), value @ 12..16
```

The `sub=0x09` layout is byte-identical to `buildSetParameter` (eff@8..9,
paramId@10..11, 5-septet LE float32 value @ 12..16, see
[[gen3-fn01-set-float32-ordinal]]), the first live FM9 confirmation of the gen-3
`set_param` envelope through the simulator (value was 0.0, a type GET). The
`sub=0x30` gridPos slot (bytes 12..13) is the same slot
[[gen3-fn01-grid-set-position-insert]] uses for the insert.

The full editor WRITE surface was exercised live through the simulator (one
session): `sub=0x32` insert (3 frames byte-exact) + shunt (byte9=0x08,
auto-inserted in a cable gap at r1c7), `sub=0x30` select, `sub=0x35` routing (2
frames, 26 bytes, endpoint data in the varying tail bytes 21..23, advances the
partial routing decode), `sub=0x26` store (presetNum 151, first >=128 capture,
see [[gen3-fn01-store-preset]]), and `sub=0x52` continuous param drag:

```
sub=0x52 drag : f0 00 01 74 12 01 52 00 3a 00 0c 00 [25 41 43 76 03] 00 00 00 00 cs F7
                f0 00 01 74 12 01 52 00 3a 00 0c 00 [78 18 65 7a 03] 00 00 00 00 cs F7
```

eff@8..9 = 58 (Amp), paramId@10..11 = 12, and the **value is a 5-septet float32
at bytes 12..16** (`decode5SeptetFloat32`), NORMALIZED to [0,1]: the two frames
decode to 0.4080 and 0.8488. This is the first live confirmation of the gen-3
continuous param SET (`sub=0x52`) in the SET direction (was beta). The on-screen
value reverts because the simulator does not echo the drag value back.

### Editor WRITE surface: sub=0x35 routing decode (mined from the sim sessions)

The live sim sessions logged BOTH directions, so the editor's `sub=0x35` cable
writes are recoverable with no hardware (`scripts/_research/sim/mine-editor-writes.ts`
extracts them deduped + decoded). Every `sub=0x35` frame is **26 bytes with a
fixed skeleton, only four bytes vary**:

```
f0 00 01 74 12 01 35 00 | 00 00 00 00 | OP | 00 00 00 00 00 00 | 02 | 00 | RM EP DR | cks f7
idx 0..7                  8  9 10 11    12   13 14 15 16 17 18   19   20   21 22 23   24 25
```

| byte | name | reading |
|---|---|---|
| 12 | OP | **`0x01` = connect, `0x02` = disconnect**. |
| 19 | n/a | `0x02` constant (edge-record marker). |
| 21 | B21 | **`floor(srcGridPos / 2)`**, universal across all source rows/cols. `srcGridPos = (srcCol−1)·rows + (srcRow−1)`. |
| 22 | B22 | **`((srcGp & 1) << 6) \| (colTerm(srcCol) + destSign)`**: `colTerm(c) = floor(3·(c−1)/2)+1`; `destSign = destRow≥3 ? 1 : 0`. Universal for source rows 2-6. Row-1 odd-col passes; row-1 even-col (c2,c4,...) is refused (byte22 breaks, see `buildSetGridRouting` error). |
| 23 | B23 | **`((|destRow−3| + (srcCol even ? 2 : 0)) % 4) << 5`**, universal across all dest rows/cols. |

**DECODED and shipped (2026-06-05).** `buildSetGridRouting` in
`fractal-midi/src/gen3/axe-fx-iii/setParam.ts` (golden:
`scripts/primitives-verify.ts#case-gen3-fn01-grid-routing`). Wired into
`fractal-gen3/src/writer.ts` `apply_preset` (step 1.5). Validated by two
controlled-capture sweeps (FM9-Edit 0x12, loopMIDI, no hardware, 2026-06-05):
26 corpus cables total, 26/26 byte-exact (source rows 2-6 all cols + row-1 odd
cols). Dest col is implicit: always src col + 1. Drawing onto an empty dest
cell auto-inserts a shunt there first (confirms dest geometry), then the
`sub=0x35` follows.

**Corpus anchor cables:**

| cable | src (r,c) | dst | byte21 | byte22 | byte23 |
|---|---|---|---|---|---|
| A | r2,c3 | r3,c4 | `0x06` | `0x45` | `0x00` |
| C | r3,c3 | r3,c4 | `0x07` | `0x05` | `0x00` |
| D | r2,c5 | r3,c6 | `0x0c` | `0x48` | `0x00` |
| sweep r3c3→r1c4 | r3,c3 | r1,c4 | `0x07` | `0x04` | `0x40` |
| sweep r3c3→r6c4 | r3,c3 | r6,c4 | `0x07` | `0x05` | `0x60` |
| r1c3→r1c4 | r1,c3 | r1,c4 | `0x06` | `0x04` | `0x40` |
| r4c3→r1c4 | r4,c3 | r1,c4 | `0x07` | `0x44` | `0x40` |

**One remaining gap:** row-1 even-column sources (r1c2, r1c4, ...). byte22
breaks here; `buildSetGridRouting` refuses them with a clear message. Close
with 3 cables from an even-col row-1 source (e.g. r1c2→r1c3, r1c2→r3c3,
r1c2→r5c3) via `controlled-capture.ts --capture routing --model 12`.
FM3 (4-row grid) is also excluded from the formula (destRow baseline and mod-4
wrap may differ); pending an FM3-Edit `--model 11` routing capture.

Ghidra static route was tried (2026-06-04) and is a DEAD END; don't re-dig:
the III composes routing via an object-builder + serializer (`FUN_1402298a0`
field-appends on `param_1[0x475]`), not inline byte arithmetic, so the byte
21/22/23 formula is not cheaply recoverable from the decompile (`FUN_1401f4390`
`case 0x35` is the model handler; `FUN_14033ec70` is a generic septet serializer).

## What is NOT projectable from state yet

The `0x2e` layout map (755 bytes, only ~9 volatile: a transient meter region)
and the `0x01` descriptor encode grid occupancy in bytes that are **undecoded
from a single-preset corpus**, so a simulator serves these two render-gate
frames VERBATIM (checksum recomputed) for M1.

What the sim sessions DID newly establish about `0x2e`: its body is
**septet-packed (7→8, MSB-first, [[iii-byte-stream-septet-pack-8to7]])**: the
long runs of `40 20 10 08 04 02 01 00` (each byte = the previous `>>1`) unpack
to a constant `0x40` background, with the sparse non-`0x40` unpacked bytes
carrying the real layout. It encodes **occupancy + routing, NOT effect types**:
the placed effectIds (58=Amp, 66=Reverb) do not appear anywhere in `0x2e`,
packed or unpacked; types come from the `sub=0x01` descriptors / `sub=0x7b`
placed-flag, addressed by effectId. So projecting `0x2e` from state means
modeling an occupancy/routing bitmap, not block ids. Closing it is gated on a
diff capture: render an EMPTY preset, place ONE block live, capture the new
`0x2e`, and diff the unpacked bytes to isolate the occupancy bit for that cell.

## Controlled-capture runner (closes the open decodes, no hardware)

`scripts/_research/sim/controlled-capture.ts` drives FM-Edit against the
simulator and auto-decodes ONE isolated action. Three kinds:

- `--capture routing`: drag one cable between two named cells; prints the lone
  `sub=0x35` field decode to bind byte 21 (rowMask) / byte 22 (endpoint) /
  byte 12 (connect-vs-disconnect direction) to the known source→dest. Fully
  offline.
- `--capture enum`: pick each TYPE-dropdown value / insert each block type;
  prints raw-ids (`sub=0x09`) + effectIds (`sub=0x32`) in click order to map to
  names. This is the gen-3 enum roster ({name→raw-id}) with **no hardware**:
  the WRITE leg replaces the unservable `sub=0x1f` name-stream.
- `--capture layout`: `0x2e` is a device→editor response the sim only replays,
  so this records the editor's incremental writes (the ground-truth grid) and
  diffs any full-length `0x2e` seen; the decode itself needs a second
  known-layout `0x2e` from a real device, then `--analyze` diffs it.

Re-run any kind's report on an existing session log with
`--analyze <annotated.jsonl>` (no MIDI). Offline write-frame mining:
`scripts/_research/sim/mine-editor-writes.ts`.

## Verification path

`scripts/primitives-verify.ts#case-gen3-editor-sync-read-surface` asserts the
echo-of-bytes-5..11 invariant, the `0x7b` placed marker + 23-byte length, and
the 12-byte `0x74` head (no flag byte) on embedded FM9 frames. The full
connect-sweep (every query served with length + echo match for the render-gate
subs) runs in `scripts/verify-fractal-gen3-sim.ts`.

## FM3 cross-family confirmation (query side)

FM3-Edit (model byte `0x11`, wire-confirmed for the first time from a live
editor, previously spec/wiki only) drives the **same** `fn=0x01` editor read
surface as FM9, captured 2026-06-04 over single-port loopMIDI self-loopback:

```
fn=0x00 7a              broadcast identify (model 0x7F, payload 0x7a)
fn=0x11 08 1c           WHO_AM_I   (FM9 used 08 1f)
fn=0x11 47 53           INIT       (FM9 used 47 50)
fn=0x11 01 2e 00 00 00 00 00 …   layout-map query, byte-identical address to FM9
fn=0x11 01 01 00 <eid:14b> …     block descriptor by effectId at bytes 8..9 (same)
```

Sub-actions seen: `0x01 0x1a 0x1b 0x2a 0x2e 0x4b 0x1c 0x09` plus `0x03` / `0x20`
(FM3's high-frequency poll leans on `0x4b` + `0x03`, where FM9 leaned on `0x7b` +
`0x37` + fn=0x1F; the steady-state poll sub mix differs per model/editor-state,
but the descriptor/layout READ surface is shared).

What FM3 did NOT confirm: the device RESPONSE shapes (per-sub lengths,
placed-flag value bytes, the 12-byte burst head). A single-port loopback has no
device answering, so the capture is the editor's QUERY side only. The
response-side facts above stay FM9-singleton until an FM3 device (or the
simulator answering FM3-Edit) is captured. This is also why the entry stays
`matched-singleton`: FM3 is a partial second axis (query surface + model byte +
handshake), not a full response-shape confirmation.

## Refinement history

- 2026-06-04: decoded while building the codec-backed device simulator
  (`scripts/_research/sim/` + `packages/fractal-gen3/src/simResponders.ts`).
  Echo invariant + per-sub length gates + placed-flag semantics confirmed from
  the FM9 connect+sync capture; the `0x74` head-is-12-bytes correction is logged
  in [[gen3-fn1f-poll-block-bulk-read]].
- 2026-06-04 (FM3-Edit loopMIDI capture): FM3 model byte `0x11` wire-confirmed;
  FM3 drives the identical `fn=0x01` editor read surface (same sub-actions, same
  `sub=0x2e` layout query, same effectId-at-bytes-8..9 block addressing, same
  fn=0x00/0x08/0x47 handshake structure). Confirms the QUERY surface generalizes
  III→FM3→FM9; the device RESPONSE shapes remain FM9-only (single-port loopback
  has no device to answer).
- 2026-06-04 (live FM9-Edit render via the codec-backed simulator): the
  simulator rendered a full preset grid on a live two-port FM9-Edit with no
  hardware, param pages populated with real bulk-read values. Decoded the
  post-render `sub=0x1f` "Query All Param Definitions" cursor-paged stream
  (enum-name gate), and byte-confirmed the `sub=0x09` typed-SET envelope (==
  `buildSetParameter`) + the `sub=0x30` gridPos slot live. The same-sub fallback
  that unblocks fixed reads must exclude the cursor-streamed `sub=0x1f` (a fixed
  answer floods it; empty -> graceful timeout).
- 2026-06-04 (M2 live-validated): echoing a write frame back as the per-step ack
  (SimDevice write branch) let FM9-Edit advance past the `sub=0x30` select and
  emit `sub=0x32` insert; **three inserts captured live through the simulator,
  byte-exact to [[gen3-fn01-grid-set-position-insert]]** (eff 115@r2c8, 67@r3c8
  Reverb 2, 46@r2c6 Compressor; gridPos=col*6+row confirmed). Supersedes the
  prior note that a live `sub=0x32` could not be captured (that was true only
  without the write-ack echo).
