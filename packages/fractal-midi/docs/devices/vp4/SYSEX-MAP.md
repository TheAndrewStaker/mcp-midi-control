# VP4 SysEx map

**Authoritative source for the VP4 protocol layer.** The VP4 (model byte `0x14`)
is a gen-3 Fractal effects pedal: it shares the III's SysEx envelope, XOR checksum,
septet encoding, and block effect-ID table, but is AM4-shape on the panel (serial
4-slot chain, 4 scenes, A-D channels, A01-Z04 locations, no amp/cab). See the
III map for the shared family layer; this doc records VP4-specific, **hardware-confirmed**
wire shapes.

## Capture provenance

- **`samples/captured/vp4-edit-preset-sync-poll-fw403-kevin-iudicello-2026-06-08.mmon`**
  (MIDI Monitor macOS spying capture; VP4 fw **4.03**; VP4-Edit open). Community
  capture from Kevin Iudicello, 2026-06-08. Decode + scripts:
  `samples/captured/decoded/vp4-403/` (gitignored), full writeup in `FINDINGS.md` there.
  1000 frames, 100% `fn=0x01`, all checksum-valid. The file is the **last 2.58 s tail of a
  longer session** (exactly 1000 messages, no handshake, starts mid-poll): VP4-Edit polls at
  ~390 msg/s and MIDI Monitor's message cap evicted the earlier edit-writes, so what
  survived is pure read-poll. Writes were made during recording but aged out of the buffer.
- **`samples/captured/vp4-edit-edit-session-fw403-kevin-iudicello-2026-06-09.mmon`**
  (same setup, **buffer raised**). Community capture, 2026-06-09. Decode:
  `samples/captured/decoded/vp4-403-v2/FINDINGS.md`. 27,104 frames / 79 s / 100% `fn=0x01` /
  all checksum-valid. **Contains the writes** — an annotated edit session (move / param drag
  / save / scene / bypass / save). This is the source for the **PARAMETER SET** section below.

## Envelope (confirmed on VP4 fw 4.03)

```
F0 00 01 74 14 cc dd ... cs F7
```
- `00 01 74` Fractal mfr prefix; `14` VP4 model byte.
- `cc` function opcode.
- `cs` = `XOR(F0..last payload byte) & 0x7F`. **1000/1000 frames pass.**

## fn=0x01 PARAMETER GET — query (✅ confirmed)

VP4-Edit reads every parameter with `fn=0x01` and **no sub-action** (this differs
from the III SET frame, which carries a `09 00`/`52 00` sub-action at pos 6-7, and
from `fractal-midi`'s `buildGetParameter`, which injects `09 00`). 16-byte query
(18 with F0/F7):

```
F0 00 01 74 14 01 [eid_lo eid_hi] [pid_lo pid_hi] [tc] 00 00 00 00 cs F7
pos:           5   6      7         8      9        10
                  └ effectId 14b ┘ └ paramId 14b ┘  └ typecode
                  LSB-first septet  LSB-first septet
```

`typecode` selects the response representation:

| tc | meaning | response length |
|------|---------|-----------------|
| `0x0d` | full value + descriptor | 62 B (78 B for some) |
| `0x26` | compact scalar value (4-byte LE int) | 21 B |
| `0x1f` | large septet-packed blob (routing/grid descriptor) | 236 B |

Example query (Delay block, DELAY_TIME): `F0 00 01 74 14 01 46 00 0C 00 26 00 00 00 00 XX F7`.

**typecode is param-type-driven, not a free choice.** Each paramId has a fixed read
form: for the Delay block, pid 10/2013/2022 are read only via `0x0d`; pid 0/1/12/14/
31/46/82/84 only via `0x26`; pid 3 (BYPASS) is the lone dual-read.

## fn=0x01 PARAMETER GET — response (✅ shape confirmed; value calibration open)

`0x0d` form (bytes shown F0-stripped, as MIDI Monitor stores them):
```
[eid:2] [pid:2] 0d 00 00 00 [marker] [.. value + descriptor ..] cs
                            pos13
```
- `marker` is a count-like field (`0x28`=40 typical; `0x36`=54 for the larger
  pid-2013 descriptor).
- **Global telemetry field** at data[17-18] of the **62-byte** form: identical across
  ALL blocks within one poll cycle, cycling among 4 values (`00 00`/`04 60`/`0c 30`/
  `0b 20`) over ~9 transitions — a per-poll device broadcast (meter/tempo/heartbeat),
  **not** stored data. In the **78-byte** form (always pid 2013) data[17-18] is instead
  stable per-eid (stored descriptor), so scope the telemetry reading to the 62-byte form.

`0x26` form: length-prefixed `… 26 00 00 00 04 [4 bytes]` (`04` = byte-count). Every
sampled Delay param returned `00 00 00 00`, including a present block's LEVEL/MIX — so
treat `0x26` as an unconfirmed value read, not a reliable scalar, until a param-change
capture confirms its semantics.

`0x1f` form (eid 206 pid 0): the whole-preset STRUCTURE blob — **fully field-decoded
2026-07-01**, see the dedicated section below. (The earlier framing here — "routing/grid
descriptor, not field-decoded, slot assignment unknown" — is superseded.)

## eid206 pid0 tc=0x1f — whole-preset STRUCTURE blob (✅ decoded 2026-07-01)

The VP4's system block **eid 206** answers `fn=0x01` GET on paramId 0, typecode `0x1f`
with ONE septet-packed blob carrying the active preset's structure: preset name, the
four scene names, the current scene, and the serial 4-slot chain. This is the register
VP4-Edit itself polls to render the chain — 392 responses across the two captures.
Codec: `src/gen3/vp4/structureBlob.ts` (`buildVp4GetStructureBlob` /
`parseVp4StructureBlob`); goldens: `test/gen3/vp4/structureblob.test.ts`; cookbook:
`vp4-eid206-structure-blob`.

Request (18 bytes, verbatim in both captures, 202×):
```
F0 00 01 74 14 01 4E 01 00 00 1F 00 00 00 00 00 cs F7
                  └eid 206─┘ └pid 0┘ tc      └len=0┘
```

Response (238 bytes): same header through `tc=0x1f`, then `00 00 00`, a 14-bit
LSB-first length tag `40 01` (= **192** raw bytes — the same length-tag convention as
the write frame's `04 00`), then **220 packed bytes**, cks, F7. The packed region
unpacks 8→7 with the CHUNKED LSB-first-with-carry scheme (cookbook
`iii-byte-stream-septet-pack-8to7`; `unpackValueChunked` — carry restarts every
8 wire / 7 raw bytes) into a 192-byte raw record:

| raw offset | field |
|---|---|
| `[0]` | u8 status flag: `0x00` fresh-loaded, `0x60` after the first structural edit |
| `[4]` | 1-bit toggle FLIPPING on every structural command (delete/move/save/scene) — NOT a clean dirty flag |
| `[8]` | u8 **CURRENT SCENE**, 0-based |
| `[12..15]` | float32 LE **live telemetry** — varies per poll; never fingerprint/byte-compare raw blobs |
| `[16..47]` | preset name, ASCII, space-padded 31 chars + NUL |
| `[48..175]` | scene 1..4 names, 4 × 32-byte records (31 ASCII + NUL) |
| `[176..191]` | **CHAIN TABLE**: 4 × u32 LE effectId (shared gen-3 table), slots 1..4 in order; `0` = empty slot |

**Oracles (byte-exact, action-annotated):**
- **Chain / move cascade (v2):** `[118,78,70,66]` (DRV/CHO/DLY/RVB) → the `pid10` write
  at 4.78 s (Drive delete) → `[0,78,70,66]` → the `pid15`/`pid16` pair at 10.73 s (Delay
  move) → `[70,0,78,66]` = exactly the annotated cascade [DLY, empty, CHO, RVB].
- **Chain (v1, second preset):** `[70,118,90,94]` = precisely its four annotated blocks
  (DLY/DRV/PHR/WAH).
- **Current scene (N=2):** the annotated v2 scene 1→3 switch (`pid13` write, 41.15 s)
  flips raw[8] `0→2`; the v1 capture (also post scene-1→3) independently reads `2`.
  **This corrects the earlier claim that no readable register exposes the scene index.**
- **Names:** "Virtual Pedalboard" / "Main Bank" + all eight scene names, clean ASCII in
  both captures. **This overturns the v1-capture negative "the preset name is not in the
  capture"** — the name was always in the 0x1f blob; the earlier 7-in-8 unpack attempt
  used the wrong scheme/alignment (same failure class as
  `_negative/gen3-septet-label-wrong-offset`). Likewise the v1 "slot order not
  recoverable by blind unpack" negative: the chain IS a plain slot→effectId list, but as
  u32 LE words in the CHUNKED unpack domain, not effectId bytes in the packed stream.

**Register identities on eid206 (write side, from the same causality pass):** `pid10` =
DELETE gesture, `pid15`+`pid16` = MOVE pair, `pid13` = SCENE gesture. These are
identities only — the value math (≈33.x floats for placement; scene value `0x01` for a
1→3 switch) remains OPEN, so `set_block` / `switch_scene` writes still do NOT ship.

Consumed by `fractal-gen3` `get_preset` (active buffer) on VP4: one blob read returns
name + scene names + current scene + the 4-slot chain (community-beta; the blob layout
is capture-decoded but this server issuing the read is untested on hardware).

## Block effect-ID addressing (✅ confirmed == shared gen-3 table)

The effectId field is the **shared gen-3 block table** (`axe-fx-iii/blockTypes.ts`).
Confirmed values from the capture (preset was 4CM: WAH, DRV, 4CM, PHR, DLY):

| eid | block | note |
|----:|-------|------|
| 70  | Delay #1 | matches "DLY" |
| 90  | Phaser #1 | matches "PHR" |
| 94  | Wah #1 | matches "WAH" |
| 118 | Drive #1 | matches "DRV" |
| 2   | Controllers | preset modifiers |
| 1   | VP4 system block | global/meta (id < III roster) |
| 206 | VP4 system block | routing/grid descriptor (6× `0x1f` blobs); id beyond III roster |

All effect blocks address as a single instance (`#1`) — consistent with VP4's serial
single-row design.

## Param catalog — device-true mine validated on hardware

For the fully-read Delay block, every observed paramId is present in the VP4-Edit-mined
catalog (`src/gen3/vp4/params.ts`) at its device-true offset:
`10=DELAY_MODEL, 12=DELAY_TIME, 14=DELAY_FEED, 31=DELAY_HOLD, 46=DELAY_ATTEN,
82=DELAY_RATE4, 84=DELAY_DEPTH4` + BLOCK wrapper `0=LEVEL, 1=MIX, 3=BYPASS`. This is
the first hardware confirmation that the mined VP4 paramIds are the real wire paramIds.

**Meta-registers** `2013` (0x7DD) and `2022` (0x7E6) are NOT in the XML mine — firmware
status/type/descriptor registers the editor uses to discover slot contents. `2022` is
read on all 7 effectIds; `2013` only on {2,70,90,94,118} (not the system blocks eid1 /
eid206). Not added to the catalog (not guessed).

## fn=0x01 PARAMETER SET — write (✅ decoded from the 2026-06-09 edit-session capture)

Second community capture (`vp4-edit-edit-session-fw403-kevin-iudicello-2026-06-09.mmon`;
fw 4.03; 27,104 frames / 79 s / all checksum-valid; buffer raised so writes were retained).
69 write frames decoded, mapped 1:1 to an annotated action sequence (move / param drag /
save / scene / bypass / save). Full writeup: `samples/captured/decoded/vp4-403-v2/FINDINGS.md`.

**Write frame (21 B), same eid/pid layout as the GET — the `tc` byte is the sub-opcode:**
```
F0 00 01 74 14 01 [eid_lo eid_hi] [pid_lo pid_hi] [tc] 00 00 00 04 00 [value:5] cs F7
pos:           5   6      7         8      9        10 11 12 13 14 15..19
                  └ effectId 14b ┘ └ paramId 14b ┘  tc          └ value (5 septets)
```
No `09 00`/`52 00` sub-action (consistent with the GET and the FM-family finding).

**`tc` sub-opcodes:**

| tc | meaning |
|------|---------|
| `0x01` | discrete SET (bypass, scene, routing, type selects) |
| `0x02` | continuous / drag SET (knob sweep) |
| `0x17` | begin/end-edit gesture marker (carried on pid `16001`/`0x7D01`, value 0) |
| `0x1b` | **SAVE / store preset** |
| `0x00` | Controllers (modifier) refresh |

**Value encoding (cracked):** the 5 value bytes `[d15,d16,d17,d18,d19]` map to septets
`[s0,s1,s2,s4,s3]` — i.e. **d18 = s4 (high septet), d19 = s3** (the top two septets are
swapped vs normal LE order):
```
u32 = s0|s1<<7|s2<<14|s3<<21|s4<<28  (s0=d15 s1=d16 s2=d17 s3=d19 s4=d18)  →  float32(u32)
```
(The non-swapped order decodes to ~1e-36 garbage, confirming the swap.) Continuous params
carry a **normalized [0,1]** float (same as the III continuous SET, plus the VP4 septet-swap);
commands/discrete carry a small raw int in the low septet. **Calibration is single-point and
soft:** the Delay feedback drag (`eid70 pid14 tc02`) decodes to plausible normalized floats in
two oscillating clusters (early ≈0.50–0.60, first frame 0.503; late ≈0.13–0.16) — consistent
with 15%→negative but NOT an exact `%`↔normalized map (the late cluster back-solves to ≈-71%,
not Kevin's "-45% or so"). Treat continuous display calibration as undecoded.

**Confirmed command frames:**
- **SAVE** (byte-identical both times Kevin saved):
  `F0 00 01 74 14 01 00 00 00 00 1B 00 00 00 04 00 30 00 00 00 00 3F F7` (eid0 pid0 tc1b, val 0x30).
  → answered by a distinct 16-byte **completion ack** ~+153 ms:
  `F0 00 01 74 14 01 00 00 00 00 1B 00 00 00 00 00 0B F7` (value zeroed; byte-identical both saves).
- **BLOCK BYPASS**: `eid<block> pid3 tc01` — enable = float **0.0**; bypass-on = `00 00 10 03 78`
  (decodes 0.5156 — replicate verbatim, undecoded as a boolean). Note: the pid3 `0x0d`
  **readback** field is telemetry (cycles in lockstep across all blocks, collides with the
  bypass-on value), so it cannot confirm bypass state — use the write echo.
- **PARAM SET continuous**: `eid pid tc02` + normalized float (Delay feedback example above).
- **BLOCK PLACEMENT / routing**: `eid206 pid10..16 tc01`. NOT one atomic cascade — `pid10`
  (val→33.5) fired at 4.78 s, `pid15`/`pid16` (val→33.06) together at 10.73 s, ~6 s apart =
  two separate gestures. Register identities now pinned by the structure-blob chain diff
  (see the STRUCTURE blob section): **`pid10` = delete gesture, `pid15`/`pid16` = move
  pair**. Placement STATE lives in the `eid206 pid0 0x1f` blob (now field-decoded).
  Value→slot math **still not decoded** (needs isolated minimal-pair moves) — placement
  writes do not ship.
- **SCENE switch**: `eid206 pid13 tc01` = the scene GESTURE (value `0x01` for a 1→3
  switch — value↔scene mapping still to confirm). The CURRENT scene is readable: byte
  [8] of the eid206 pid0 `0x1f` structure blob (corrects this doc's earlier "no readable
  register exposes scene index" claim).

**Other meta-register:** `pid 2028` (0x7EC) — 163-byte `0x0d` descriptor responses on effect
blocks {66,70,78}, clustered around edits. A third firmware descriptor register alongside 2013/2022.

**Acknowledged-write contract (CORRECTED):** **every write IS synchronously echoed** — all
69/69 writes are answered by the immediately-following From-VP4 frame (~+1 ms) with the same
eid/pid/tc and the value echoed verbatim for discrete writes (consistent with the III's
synchronous value-echo). Confirm a write by matching that echo; have `save_preset` wait for
the 16-byte SAVE ack above. Do NOT use `get_param` for confirmation (telemetry-mixed readback
+ our shared GET uses the unconfirmed fn=0x1F path).

## Codec change plan (CORRECTED after review — see `vp4-403-v2/CODEC-PLAN.md`)

1. Add VP4-specific builders in `fractal-midi/src/gen3/vp4/setParam.ts` (NOT a mutation of the III
   builders — III divergence is total): the swapped-septet float32 primitive + `buildVp4Save`,
   `buildVp4SetBypass`, a write-echo parser, and (scoped) `buildVp4SetParam`. Golden cases +
   a cookbook entry + `cookbook-verify`/`verify-msg` cases (preflight requires them).
2. **Shipped community-beta `untested`** (in `fractal-gen3` via `write_allowlist`):
   continuous `set_param`/`set_params` (raw 0..65534 wire value → normalized float; %/ms
   calibration pending), `set_bypass` (enable=0.0 / bypass-on replicated), `save_preset`
   (exact frame). DISCRETE `set_param` (enum/type) refuses — zero captured evidence.
3. Keep **block placement / `set_block` / `apply_preset`** gated — the value→slot math is
   genuinely undecoded (we cannot construct a move), not merely untested.
4. Keep **`switch_scene`** gated (value↔scene mapping unconfirmed).
5. Use the **synchronous echo** for confirmation (not `get_param`); per-capability gate map with
   default-refuse for unproven capabilities; rewrite the `vp4.ts` `beta_status`/`device_note`
   strings (they currently say "READS ONLY").

## Not yet decoded / still gated

- **Block placement value→slot math** (`eid206 pid10–16` routing writes) — register
  identities pinned (pid10 delete, pid15/16 move pair), values open. The one capability
  that stays gated. The structure blob's chain table is the read-side diff oracle for
  cracking it (minimal-pair single moves — see `captures-vp4.md`).
- **Scene write value↔index** (`pid13` gesture value math; the READ side is solved via
  the structure blob) and the **bypass "bypassed" value** (enable=0.0 is solid).
  Zero-cost alternative: probe whether the VP4 answers the family-documented read-only
  `fn=0x0C` scene query (`F0 00 01 74 14 0C 7F cs F7`) — if it does AND accepts the
  fn=0x0C SET form, `switch_scene` ships without decoding pid13 at all.
- **Continuous-param display calibration** beyond normalized [0,1] (per-param % / ms / Hz
  range).
- **eid206 compact registers** `0x0d` pid 19/20/21/22 (19/21 share one record, 20/22
  another) and pid 63 (stable 20-byte packed descriptor) remain unidentified. Less urgent
  now that the pid-0 `0x1f` blob is field-decoded (name/scenes/scene-index/chain solved);
  still candidates for per-scene bypass/channel state.
- **Negative results** (updated 2026-07-01): the earlier "preset name is NOT in the
  capture" and "slot order not recoverable by blind unpack" verdicts are **OVERTURNED** —
  both were unpack-scheme misses (the name and the chain live in the pid-0 `0x1f` blob
  under the CHUNKED 8→7 unpack; see the STRUCTURE blob section). Still standing: no
  4CM-separator / send-return block was polled in capture #1.
- **Read-path action item (stands):** `fractal-gen3` ships an `fn=0x1F` bulk-poll reader
  for per-param VALUES; VP4-Edit uses `fn=0x01` GET instead and no capture shows VP4
  answering `fn=0x1F`. The structure-blob read (fn=0x01, decoded) now covers the
  name/scene/chain half; the per-param fn=0x01 GET reader is still the open item.
