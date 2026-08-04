# RC-505mk2 `.RC0` memory-file schema (DRAFT, sibling-derived)

Working schema for authoring Boss RC-505mk2 memories/system settings via the USB
storage-file transport. This is the STORAGE half of the planned hybrid `rc-505`
device package (the live-MIDI half is in
[`RC-505mk2-MIDI-CONTROL-SYNTHESIS.md`](RC-505mk2-MIDI-CONTROL-SYNTHESIS.md)).

**Status: VALIDATED against real mk2 files (2026-07-07).** The structural schema
was sibling-derived, then confirmed byte-exact against a real device's full
`ROLAND/` tree, the write path was proven on-device, and the ASSIGN field
dictionary was decoded and cross-checked against the unit's own front-panel
display. See "Hardware confirmation (2026-07-07)" and "ASSIGN block field
dictionary (device-confirmed)" below. Remaining `[mk2?]` markers are fields not
yet exercised, not unvalidated guesses.

---

## 1. The oracle situation: mk2 = RC-600 tag scheme + 5 tracks

The Boss RC looper family stores memories as plain-text XML `.RC0` files, but the
family splits into two tag dialects:

| Model | Tag dialect | Tracks | NAME tags | Best-known parser |
|---|---|---|---|---|
| RC-500 | **named** (`<Rev>`, `<PlyLvl>`, `<Pan>`) | 2 | `C01..C12` | dfleury2/boss-rc500-editor (MIT) |
| RC-505 **mk1** | **named** (`<TrkFx>`, `<PlyMod>`) | 5 | (mk1 set) | westlicht/rc505-editor (GPLv3, ref-only) |
| RC-600 | **single-letter** (`<A>`, `<B>`, ...) | 6 | `A..L` | paulelong/RCEditor (MIT) |
| **RC-505mk2** | **single-letter** (RC-600 generation) | **5** | `A..L` `[mk2?]` | closed rc600editor.com edits BOTH |

The RC-505mk2 shares the RC-600's *generation, editor, and single-letter tag
dialect* (one closed editor, rc600editor.com, auto-detects and edits both), but
has **5 tracks like the mk1**, not 6. So neither sibling is a perfect oracle:

- Use **RC-600 (paulelong, MIT)** as the tag-layout + envelope + enum oracle.
- Expect **5 tracks** (drop `TRACK6`) and a mk2-specific I/O + effect roster.

### Downloadable real oracle files (raw, no login, no hardware)

- RC-600, 198 real device files: `https://raw.githubusercontent.com/paulelong/RCEditor/main/SupportDoc/RolExample/DATA/MEMORY001A.RC0` .. `MEMORY099B.RC0`, plus `SYSTEM1.RC0`, `SYSTEM2.RC0`, `RHYTHM.RC0`. A local copy of `MEMORY001A.RC0` is saved at `samples/rc505mk2-oracle/RC600_MEMORY001A.RC0` (gitignored).
- RC-505 **mk1** factory bank: `https://raw.githubusercontent.com/westlicht/rc505-editor/master/resources/MEMORY.RC0` (1.67 MB) + `resources/SYSTEM.RC0`. GPLv3 repo, so treat as READ-ONLY reference (do not vendor code; a data file is fine as a format oracle).
- RC-500: `https://raw.githubusercontent.com/dfleury2/boss-rc500-editor/master/resources/ROLAND/DATA/MEMORY1.RC0` + clean templates under `resources/templates/`.

No free RC-505mk2 `.RC0` sample exists publicly; the mk2 delta needs the owner's file.

---

## 2. Container envelope (confirmed against RC-600 `MEMORY001A.RC0`)

```
<?xml version="1.0" encoding="utf-8"?>
<database name="RC-600" revision="0">   <- name = model string [mk2?: "RC-505MK2" or similar], revision int
<mem id="0">
  ...sections...
</mem>
</database>
<count>001F</count>                     <- TRAILING sibling AFTER </database>, hex, no newline
```

Facts (real-file confirmed unless noted):
- One `.RC0` = one memory (RC-600 splits A/B variations as `MEMORY###A.RC0` /
  `MEMORY###B.RC0`; mk2 filename layout is `[mk2?]` - could be per-variation
  files or a single `MEMORY.RC0` holding many `<mem id=N>`; a real backup resolves it).
- `<count>HHHH</count>` is a trailing token in HEX after `</database>` (`001F` = 31),
  round-tripped verbatim by editors and NOT recomputed. Treat as opaque; preserve.
- **Trailing region / checksum:** the RC-600 example ends exactly at `</count>`
  with no newline and no extra bytes. dfleury2's RC-500 reader nonetheless
  truncates everything after `</database>` on read (`buffer.erase(end_tag + 11)`),
  and no editor recomputes a checksum on write, so real device files MAY carry
  padding/checksum bytes some editors strip. **Authoring rule: read-modify-write,
  preserving the device's exact trailing region byte-for-byte rather than
  regenerating it** (same discipline as the SPD-SX byte-exact port). Confirm the
  mk2's trailing region from a real file before writing.
- Every leaf is a **plain integer text node**; no floats, no attributes on leaves,
  no enum-as-string. Display scaling (BPM x10, etc.) lives above the file layer.
- Indentation is a single tab per level, LF line endings (RC-600 example).

---

## 3. `<mem>` sections and their single-letter tag maps

Section order in the RC-600 file: `NAME, TRACK1..6, MASTER, REC, PLAY, RHYTHM,
ASSIGN1..N, control sections (ICTL*/ECTL*/INPUT/OUTPUT/ROUTING/MIXER/EQ/MASTER_FX)`,
then `<ifx>` / `<tfx>` as siblings after `</mem>`. Letter -> field mappings below
are from paulelong/RCEditor's model classes (community RE of the RC-600, so tag
letters carry that editor's uncertainty); map each to the mk2 param via the
[Parameter Guide synthesis](RC-505mk2-MIDI-CONTROL-SYNTHESIS.md).

### NAME (confirmed)
12 tags `A..L`, each an ASCII code integer, unused positions padded with `32`
(space). Real example: `66 97 115 105 99 65 32..` = `"Basic"`.
(RC-500/mk1 use `C01..C12` instead; mk2 uses `A..L`.)

### TRACK1..TRACK5 `[mk2?: 5 tracks, RC-600 has 6]`
RC-600 per-track letters (from `Track.cs`; `[unconf]` = tag letter not surfaced by
the model, resolve from a real dump):

| Tag | Field | Range / enum |
|---|---|---|
| A | Reverse | 0/1 |
| B | OneShot (1SHOT) | 0/1 |
| C | Pan | -50..50 |
| D | PlayLevel | 0..200 |
| E | StartMode | Immediate/Fade/InputLevel |
| F | StopMode | Immediate/Fade/RecStop/RecFade |
| G | OverdubMode (DUB) | Normal/Replace/Substract |
| I | PlayMode | Multi/Single |
| J | **derived/index field — DEVICE-CONFIRMED 2026-07-19, formula pinned but semantics open** | `J = S + 7` whenever `R=2` (fixed count) — confirmed on TWO independent tracks (Track1 S=8->J=15, Track2 S=4->J=11, same offset both times). Baseline (both FREE, R=1) had J=1 on every track, which does NOT fit the same formula, so `J` likely indexes into an internal enum where AUTO/FREE/etc occupy slots 0-6 and fixed counts start at slot 7. Not yet confirmed whether the device reads `J` directly or recomputes it on load — **author path must write `R`, `S`, and `J` together** until that's known. |
| R | **MeasureMode — DEVICE-CONFIRMED 2026-07-19** | `1`=FREE (baseline), `2`=FIXED (a number, paired with `S`). `0` presumed AUTO, not yet sampled (not needed for the target recipe). |
| S | **MeasureCount (fixed mode) — DEVICE-CONFIRMED 2026-07-19** | Plain integer measure count when `R=2`. Isolated diff, two tracks: Track1 `S=8`, Track2 `S=4`, both exactly matching what was set on the front panel. |
| L | **LoopSyncSw — DEVICE-CONFIRMED 2026-07-19** | `0`=OFF, `1`=ON. Isolated single-leaf diff on the owner's real Memory 01: toggling Track 1's LOOP SYNC OFF changed ONLY `TRACK1/L` (`1`->`0`) + the trailing `<count>` write-arbitration bump. No RC-600-derived guessing needed anymore for this one. |
| M | **TempoSyncSw — DEVICE-CONFIRMED 2026-07-19** | `0`=OFF, `1`=ON. Isolated diff: TRACK1/M `1`->`0`. **Side effect (unexplained, flagged not blocking):** the SAME write also changed `MASTER/A` (`810`->`999`) and `MASTER/B` (`130556`->`105856`) — untouched-by-us memory-level leaves, likely a cached total-length/timing value the device recomputes when a track's tempo-sync relationship changes. NOT yet decoded; the eventual author path must not assume `M` is safely isolated — needs its own diff pass. |
| N | TempoSyncMode | Pitch/Xfade |
| O | TempoSyncSpeed | Half/Normal/Double |
| Q,R,S,T | ~~InputRouting~~ **WRONG GUESS, CORRECTED 2026-07-19** — `R`/`S` are actually the measure-mode/measure-count fields (see `J`/`R`/`S` above), not input routing. |
| Q | **InputEnableMask — DEVICE-CONFIRMED 2026-07-19 (2 of 7 bits)** | Per-track bitmask, one bit per input jack, matching the manual's own INPUT-screen order (MIC1, MIC2, INST1 L, INST1 R, INST2 L, INST2 R, RHYTHM): bit0=1 MIC1, bit1=2 MIC2, **bit2=4 INST1 L (hardware-confirmed: TRACK1/Q `94`->`90`, isolated diff)**, bit3=8 INST1 R, **bit4=16 INST2 L (hardware-confirmed: TRACK5/Q `127`->`111`, isolated diff)**, bit5=32 INST2 R, bit6=64 RHYTHM. Two independently confirmed bits landing exactly where the manual's list order predicts, zero deviation — high confidence in the framework, though bits 0/1/3/5/6 aren't individually toggle-confirmed. Baseline Memory01: Track1 Q=94 (0b1011110: MIC2+INST1L+INST1R+INST2L+RHYTHM, no MIC1/INST2R), Track2-4 Q=95 (same +MIC1), Track5 Q=127 (all 7 on). |
| U | Tempo — **NOT Track-1-only, confirmed present on ALL 5 tracks** (owner's real Memory 01 capture, 2026-07-19: every TRACK1-5 block carries its own `U`, all reading `1200` = 120.0 BPM) | BPM x10, e.g. 1200 = 120.0 |
| V | Wav length | samples @44.1k, e.g. 88200 |
| Y | LoopSyncMode | Immediate/Measure/LoopLength |

FadeIn/FadeOut/OutputAssign exist as model props with `[unconf]` tag letters.

### MASTER / REC / PLAY / RHYTHM
Named sections, letter-indexed integer leaves. RHYTHM covers pattern / kit / tempo
/ time-sig + intro/ending/fill trigger enums. PLAY (from `specs/PatchDump.md`):
`C`=PlayMode(0 MULTI/1 SINGLE), `D`=LoopSync(0/1), `E`=SingleModeSwitch. Map the
full field set from the [synthesis](RC-505mk2-MIDI-CONTROL-SYNTHESIS.md) TARGET
catalog + a real mk2 file.

### ASSIGN1..ASSIGN16 (per-slot, confirmed letters against real file)
Real `<ASSIGN1>`: `A0 B0 C0 D0 E0 F127 G0 H0 I0 J1`.

| Tag | Field | Notes |
|---|---|---|
| A | Sw (enable) | 0/1 |
| B | Source id | enum (mk2 source roster in synthesis doc: TRK REC/PLY, PLY/STP, SYNC, CTL/EXP, `MIDI CC#01-31`/`#64-95`) |
| C | `[unknown]` | 0 in example - likely source-mode or invert |
| D | Action mode | 0 MOMENT / 1 TOGGLE |
| E | Active-range low | default 0 |
| F | Active-range high | default 127 |
| G | Target id | enum (mk2 TARGET catalog in synthesis doc) |
| H | `[unknown]` | 0 in example |
| I | Target min | int |
| J | Target max | int |

**Slot count `[mk2?]`:** the mk2 Parameter Guide documents `ASSIGN1..16` (16 per
memory). The RC-600 reader enumerated only 12; assume **16** for the mk2 and
confirm. **Source/target enum ORDINALS are model-specific** - do NOT reuse RC-600
catalog ids; the mk2 roster is in the synthesis doc and its numbering comes from a
real mk2 file.

### `<ifx>` / `<tfx>` input + track effects
4 banks (A-D) x 4 slots. Each effect stores its params in a **per-effect-type
named sub-block**, e.g. real RC-600 tail shows `<DD_VINYL_FLICK><A>50</A></...>`,
`<DD_BEAT_SCATTER><A>0</A><B>4</B></...>`. The effect TYPE roster is a 56-entry
enum (`EffectMappings.cs`; entries like `TAPE_ECHO_V505V2`, `ROLL_V505V2` confirm
shared DNA with the RC-505 line). **mk2 effect roster differs** - treat the
RC-600 type table as a structural template only; the mk2 INPUT-FX and TRACK-FX
type lists come from its Parameter Guide + a real file.

### Control sections
`ICTL1/2_TRACK`, `ICTL*_PEDAL`, `ECTL_*` (footswitch/pedal), and audio config
`INPUT` / `OUTPUT` / `ROUTING` / `MIXER` / `EQ_*` / `MASTER_FX`, each letter-indexed
integers. mk2 I/O differs (MIC1/2 + INST1/2 + MAIN/SUB/PHONES) - remap from the
synthesis doc's mixer/output TARGET list.

---

## 4. `SYSTEM.RC0`

Root `<database name=... revision=...>` wrapping a single `<sys>` with sections
`SETUP, COLOR, USB, MIDI, ICTL*, ECTL, PREF, INPUT, OUTPUT, ROUTING, MIXER, EQ`.
### MIDI section letter map — DEVICE-CONFIRMED 2026-07-19 (CORRECTS the RC-600-derived table)

This **supersedes** the RC-600-derived map previously published here. Two
corrections, both proven on a real mk2:

1. **The mk2 carries no `B` leaf.** Every field from `RxChRhythm` onward sits one
   letter EARLIER than the RC-600 layout.
2. **All channel leaves are 0-indexed** (stored value = channel - 1).

The old table's `E` = SyncClock was impossible: `E` reads `16`, outside a 0..3
enum. `E` is actually `TxCh`, where `16` is the "RX CTL" option past channels
1-16. That anomaly is what exposed the shift.

| Tag | Field | Values | Evidence |
|---|---|---|---|
| A | RxChCtl | 0-indexed | `4` = ch5, cross-checked vs the owner's Assign CCs arriving on ch5 |
| — | *(no `B` on the mk2)* | — | absent from every real mk2 `SYSTEM*.RC0` |
| C | RxChRhythm | 0-indexed | change-and-diff `9`->`10` when the panel went ch10 -> ch11 |
| D | RxChVoice | 0-indexed | change-and-diff `0`->`11` when the panel went ch1 -> ch12 |
| E | TxCh | 0-indexed; `16` = "RX CTL" | panel displayed "RX CTL" while the leaf held `16` |
| F | SyncClock | 0 AUTO / 1 INTERNAL / 2 MIDI / 3 USB | change-and-diff `1`->`0` when the panel went INTERNAL -> AUTO |
| G | ClockOut (SYNC OUT) | 0/1 | change-and-diff `1`->`0` when the panel went ON -> OFF |
| H | StartSync | 0 OFF / 1 ALL / 2 RHYTHM | change-and-diff `0`->`2` when the panel went OFF -> RHYTHM |
| I | PcOut | 0/1 | bracketed: the only documented param remaining, between confirmed `H` and `J` |
| J | Thru | 0 OFF / 1 MIDI OUT / 2 USB OUT / 3 USB&MIDI | change-and-diff `1`->`3` when the panel went MIDI OUT -> USB&MIDI. `3` is a value no neighbouring leaf can hold, so this anchors the tail and forces `I` |
| K | `[unknown]` | reads `0` | a 10th leaf with no counterpart in the documented MIDI menu |

**Test design note.** The tail was pinned deliberately: with `F` and `H` already
confirmed, changing THRU to the *unique* value `3` bracketed `G` and `I` in a
single panel edit. Prefer a distinctive-value change over same-value toggles
(e.g. two fields both going `1`->`0` cannot discriminate a one-letter shift).

`SYSTEM1.RC0` / `SYSTEM2.RC0` are an A/B double buffer exactly like the memory
pairs: the device reads the higher trailing `<count>` and a save writes the OTHER
file at count+1. Author path (dry-run by default, backs the overwritten slot up
to `<file>.bak`):
[`scripts/_research/probe-rc505-system-midi-author.ts`](../../../scripts/_research/probe-rc505-system-midi-author.ts).

USB section: `A`=Storage, `B`=AudioMode, `C`=Routing, `D`=InputLevel, `E`=OutputLevel.

---

## 5. Comparison to the SPD-SX `.spd` XML (what our codec pattern reuses)

Our SPD-SX storage codec (`packages/spd-sx/src/codec/kitXml.ts`) already does
byte-exact XML authoring of a Roland device's stored files. The RC-505mk2 is the
same *class* of problem, so the approach transfers; the differences are additive.

| Dimension | SPD-SX `.spd` | RC-505mk2 `.RC0` |
|---|---|---|
| Encoding | plain XML, integer text nodes | same |
| Name field | `<Nm0..Nm7>` char codes, NUL(0)-pad | `<A..L>` ASCII codes, space(32)-pad |
| Empty sentinel | `-1` (`<Wv>-1</Wv>`) | `-1` seen in siblings |
| Repeated records | `<PadPrm>` x15 (named tags) | `<mem>` per memory; per-section **single-letter positional** tags |
| Envelope | none (root `<KitPrm>` per file) | `<database><mem></database>` + trailing `<count>` (+ possible checksum region) |
| File granularity | one file per kit (`KIT/kitNNN.spd`) | one file per memory-variation (`DATA/MEMORY###A/B.RC0`) `[mk2?]` |
| Authoring proof | byte-exact round-trip golden vs real device files | same plan: round-trip golden vs the sibling corpus, then vs a real mk2 file |
| Indentation | tab, LF | tab, LF (RC-600) |

**Reuse verdict.** The SPD-SX codec technique carries directly: string-template
encode + regex/section parse + a **byte-exact round-trip golden against real files**
(we already hold a 198-file RC-600 corpus + the mk1 bank as goldens). Genuinely new
for the RC family, and what the mk2 codec must add:
1. A per-section **tag-letter dictionary** (positional letter -> field), vs SPD-SX's self-describing named tags.
2. The `<database>/<mem>` **envelope + trailing-region preservation** (read-modify-write, keep `<count>`/checksum bytes verbatim).
3. **Model-specific enum tables** (ASSIGN source/target, effect types) derived from the mk2 file, not reused from RC-600.

The storage **transport** (mount discovery, backup-before-write, append-only
safe-write) is NOT re-implemented per device: it is the shared `packages/core/src/storage/`
layer to be extracted from SPD-SX at this second-consumer moment (the sequencing
Steph chose: RE-first, extract at second use). See
[`docs/design/device-archetypes-and-transport.md`](../../design/device-archetypes-and-transport.md).

---

## 6. What ONE real mk2 file copy resolves (the only remaining unknowns)

All items tagged `[mk2?]` above collapse from a single owner backup. Fastest oracle:
save the SAME memory twice with ONE parameter changed on the device, then diff the
two `.RC0` files (one capture per hypothesis). That pins:

1. `<database name>` / `revision` string for the mk2.
2. `DATA/` filename layout (per-variation files vs single MEMORY file; how many memories).
3. The 5-track field set + exact tag-letter order (vs RC-600's 6-track set).
4. ASSIGN slot count (12 vs 16) and the `C` / `H` sub-fields.
5. ASSIGN source/target enum ORDINALS (mk2 roster numbering).
6. INPUT-FX / TRACK-FX type roster + the bank/slot tag layout.
7. Trailing region: is there a checksum/padding after `<count>`, and its format.
8. SYSTEM.RC0 tag letters for the mk2 MIDI/routing/output menus.

## 7. Build sequence (no hardware needed until step 4)

1. **DONE:** MIDI-control synthesis + this schema draft + real sibling corpus in hand.
2. **DONE:** RC-600 corpus + mk1 bank + RC-500 pulled into `samples/rc505mk2-oracle/` (gitignored) as round-trip goldens.
3. **DONE:** prototype `.RC0` parse/encode codec + validation:
   - Codec: [`scripts/_research/rc0-codec.ts`](../../../scripts/_research/rc0-codec.ts) - structure-preserving line model: `parseRc0` / `serializeRc0` (byte-exact) + path-addressable `getLeaf` / `setLeaf` (surgical read-modify-write) + `decodeCharCodes`.
   - Verify: [`scripts/_research/verify-rc0-roundtrip.ts`](../../../scripts/_research/verify-rc0-roundtrip.ts) (run `npx tsx scripts/_research/verify-rc0-roundtrip.ts`; manual, not in preflight - corpus is gitignored). A self-contained synthetic golden also runs with no corpus.
   - **Result: byte-exact round-trip on ALL corpus files** across every dialect (RC-600 single-letter, mk1/RC-500 named), up to 1.67 MB / 77,616 leaves; the RC-600 memory indexes 20,864 addressable leaves; surgical `setLeaf` changes exactly one line and preserves the trailing `<count>` + every other byte; NAME decodes ("BasicA"); repeated `<A>` tags across sections disambiguate by path. Note: `RHYTHM.RC0` is BINARY pattern data (a `PTN_0000` header, not XML) - the codec round-trips it byte-exact and correctly indexes 0 leaves, so binaries pass through untouched. Files are read/written as byte-preserving latin1 (the settings XML stores names as integer char CODES, so there is no multibyte concern).
   - **The mk2 inherits this for free:** because round-trip is structural (dialect-agnostic), a real mk2 `MEMORY.RC0` will round-trip on arrival; only the field DICTIONARY (which path = which param) is mk2-specific.
4. Owner does ONE `STORAGE: CONNECT` copy (+ a one-param-change diff). Pin the `[mk2?]` deltas (schema section 6).
5. Extract the shared `core/storage` layer from SPD-SX (co-designed with RC-505), refactor SPD-SX onto it, move the codec to the FAMILY package `packages/boss-rc/src/codec/rc0.ts` + a committed golden, build the `boss-rc` hybrid device package on top. Bare verbs, no `rc505_*` prefix.

### Generalize the whole Boss RC family (decision 2026-07-04)

Do NOT build an `rc-505`-only package. The `.RC0` codec already round-trips
RC-500 / RC-505 mk1 / RC-505mk2 / RC-600 byte-exact (dialect-agnostic), so the
family generalizes like Fractal gen-3 (one codec, per-device CONFIGS):
- **Codec package `boss-rc`** (mirrors `fractal-midi`): owns the `.RC0` codec +
  a per-model FIELD DICTIONARY (path -> param) per device. NOT `roland-midi`
  (that is address-SysEx DT1/RQ1; `.RC0` is a storage-file XML codec).
- **Device package `packages/boss-rc`** (mirrors `fractal-gen3`): holds
  `rc-505mk2` / `rc-600` / `rc-500` / `rc-505mk1` as configs. Ship the mk2
  config first; siblings are added configs (their real files are already
  goldens in `samples/rc505mk2-oracle/`).
- Tools stay bare "Looper" archetype verbs dispatched by `port`; no per-device tools.
- **Per-model limit:** ASSIGN source/target + FX-type enum ORDINALS differ per
  model. Those are per-config DATA confirmed against each model's real file,
  never shared blindly. Generalize the architecture now; fill each dictionary as
  validated.

### Hardware confirmation (2026-07-07): real mk2 files + write path + `<count>` A/B selector

A real RC-505mk2's full `ROLAND/` tree was captured over `STORAGE: CONNECT` (a
plain file copy; a full-device backup lives outside the repo, the `.RC0` oracle
subset is in gitignored `samples/rc505mk2-oracle/DATA/`). This closes schema
step 4 and hardware-confirms the write path:

- **Codec validated byte-exact against the REAL mk2 files** (not just siblings):
  every memory (287,784 B / 20,864 leaves), both `SYSTEM*.RC0` (7,016 B / 435
  leaves), and `RHYTHM.RC0` round-trip byte-exact; surgical `setLeaf` +
  `decodeCharCodes` work. `name="RC-505MK2"`, single-letter dialect, **5 tracks**
  - the `[mk2?]` envelope guesses are confirmed.
- **RX CTL channel decoded** from `SYSTEM1.RC0` `<MIDI><A>4</A>` (stored
  0-indexed -> channel 5), cross-checked against the owner's rig (looper Assign
  CCs arrive on ch 5). So `<MIDI>/A` = RX CTL CH (0-indexed).
- **`<count>` is the A/B double-buffer version selector (NOT a constant).**
  Each memory is stored as a redundant pair `MEMORY###A.RC0` / `MEMORY###B.RC0`;
  the trailing `<count>NNNN</count>` (4-char HEX, after `</database>`) is a
  version counter and **the device reads whichever file of the pair has the
  higher count**. On save it writes the *other* slot with count+1, so the newest
  copy is always the max-count file. Evidence: pristine mem 99 A=`0001` / B=`0002`
  (B active, shows "Memory99"); used mem 1 A=`000B` / B=`000A` (A active). An
  earlier "count is a constant" read was WRONG - it only compared A-to-A.
- **Write path HARDWARE-CONFIRMED end-to-end.** Edited `MEMORY099A.RC0` name to
  "MCP TEST" (7 NAME char-code leaves) and bumped its `count` `0001`->`0003`
  (above B's `0002`); on storage disconnect the device displayed **"MCP TEST" on
  memory 99 with no power cycle** (it re-reads the card on disconnect). A stale
  edit to the LOWER-count file is silently ignored - the first write to A alone
  (count still `0001` < B `0002`) did not show until the count was raised.

**Implication for the descriptor's author path:** writing a memory is not "edit
the file" - it is "write the edited memory to the pair-slot whose `<count>` you
set above its sibling" (mirroring the device's own save: target the currently-
inactive slot, set count = sibling+1). Bake the A/B count arbitration into the
`boss-rc` storage author path; a memory read should likewise pick the
higher-count file of each pair.

### ASSIGN block field dictionary (device-confirmed 2026-07-07)

Each memory holds `ASSIGN1`..`ASSIGN16` under `database/mem#<id>/ASSIGN<n>`, every
block exactly 10 leaves `A`..`J`. Decoded by reading the owner's Memory 1 Assign
pages on the RC-505mk2 front panel and matching each screen to the file bytes
(SOURCE + TARGET + MODE + ACT.LO/HI + MIN/MAX all cross-checked). Every mapping
below is CONFIRMED against the device unless marked inferred.

| Leaf | Field | Values |
|---|---|---|
| `A` | SW | `0`=OFF, `1`=ON |
| `B` | SOURCE MODE | `0`=MOMENT (TOGGLE=`1`, inferred) |
| `C` | SOURCE | ordinal - see source map |
| `D` | (unused/reserved) | `0` in every sampled assign |
| `E` | SOURCE ACT.LO | `0`..`127` |
| `F` | SOURCE ACT.HI | `0`..`127` |
| `G` | (unused/reserved) | `0` in every sampled assign |
| `H` | TARGET | ordinal - see target model |
| `I` | TARGET MIN | `0`=OFF (on/off targets) |
| `J` | TARGET MAX | `1`=ON (on/off targets) |

**SOURCE ordinals (`C`) - partial, confirmed:**
- CTL footswitches are **sequential from 33**: `CTL1`=`33`, `CTL2`=`34`
  (confirmed 2026-07-07), `CTL3`=`35` (**confirmed 2026-07-19**: an assign
  authored at ordinal 35 drove the owner's right-hand FS-5U on its target track,
  turning the earlier extrapolation into a device-verified mapping). `CTL4` is
  very likely `36` by the same stride but is UNSAMPLED; the codec refuses it
  rather than guessing. These are the rear CTL/EXP-jack footswitches, e.g. an FS-5U.
- **MIDI CC in the 64-95 range: `C = CC# + 6`** - device-confirmed at CC#80->`86`,
  CC#81->`87`, CC#82->`88`. So CC#83->`89` ... CC#95->`101`, CC#64->`70`
  (extrapolated WITHIN the confirmed 64-95 range only).
- The `MIDI CC#01-31` range offset is NOT sampled - do not author a CC#01-31
  source without a device check (may use a different base than the 64-95 range).

**TARGET ordinals (`H`) - per-track model, confirmed:**
- **`H = (track-1) * 11 + fn`**, i.e. each track owns an 11-wide block matching
  the 11 per-track functions in the parameter guide.
- Function offset `fn`: REC/PLY=`0`, PLY/STP=`1`, STOP=`2`, CLEAR=`3`,
  REVERSE=`4`, UN/RED=`5`, M.BACK=`6`, R.BACK=`7`, M.SET=`8`, M.CLEAR=`9`,
  LEVEL=`10` (order from the guide; REC/PLY / PLY/STP / STOP confirmed on-device,
  the rest inferred from list order + the 11-stride).
- Track blocks: TRK1 `0-10`, TRK2 `11-21`, TRK3 `22-32`, TRK4 `33-43`, TRK5
  `44-54`. **Confirmed points:** TRK2 REC/PLY=`11`, TRK2 PLY/STP=`12`, TRK3
  REC/PLY=`22`, TRK3 PLY/STP=`23`. TRK2 STOP=`13` / TRK3 STOP=`24` corroborated by
  the owner's symmetric footswitch pair (below).
- Non-per-track targets (CUR.TRK, global transport, FX, mixer/mic) are NOT yet
  sampled - decode from more assigns before authoring them.

**Reference decode - the owner's Memory 1 (all 16 assigns, 2026-07-07):**

| # | SW | SOURCE (`C`) | TARGET (`H`) | Meaning |
|---|---|---|---|---|
| 1 | ON | CTL2 (`34`) | `11` | FS-5U sw2: TRK2 REC/PLY |
| 2 | ON | CTL2 (`34`) | `24` | FS-5U sw2: TRK3 STOP |
| 3 | ON | CTL1 (`33`) | `22` | FS-5U sw1: TRK3 REC/PLY |
| 4 | ON | CTL1 (`33`) | `13` | FS-5U sw1: TRK2 STOP |
| 5 | off | CC#80 (`86`) | `22` | (disabled) TRK3 REC/PLY |
| 6 | ON | CC#81 (`87`) | `12` | scene 2: TRK2 PLY/STP |
| 7 | ON | CC#82 (`88`) | `23` | scene 3: TRK3 PLY/STP |
| 8-16 | off | `0` | `0` | blank |

So each FS-5U switch already fires a PAIR (play one track + stop the other): CTL2
= REC/PLY trk2 + STOP trk3 (assigns 1+2); CTL1 = REC/PLY trk3 + STOP trk2 (assigns
3+4). The MIDI side (assigns 6-7, driven by AM4 scene CCs 81/82) currently only
PLY/STPs one track and does NOT stop the other - that is the gap to close by
authoring `CC#81 -> TRK3 STOP (H=24)` and `CC#82 -> TRK2 STOP (H=13)` into free
slots. CC#n maps to AM4 scene via scene N -> CC (79+N): CC#80=scene1 ... CC#83=scene4.

### END-TO-END COORDINATION CONFIRMED ON HARDWARE (2026-07-07)

The full feature was proven live. Using the storage author path we wrote a
scene-2/3 ping-pong into Memory 1 (assigns 1-4 = AM4/MIDI: `CC#81 -> TRK2 PLY/STP
+ TRK3 STOP`, `CC#82 -> TRK3 PLY/STP + TRK2 STOP`; FS-5U moved to 5-8), bumping
the active copy's `<count>` on each write. Back in USB-MIDI mode, sending
`CC#81` on ch 5 played track 2 and **stopped track 3**; `CC#82` played track 3 and
**stopped track 2** - both directions confirmed by ear/panel. This closes all
three legs at once: `.RC0` storage authoring, the ASSIGN ordinal decode, and the
live-MIDI Assign trigger. Remaining work is packaging (the `boss-rc` descriptor),
not protocol - the format and control surface are decoded and hardware-verified.

**Author-path defaults (bake into the descriptor):** an Assign is fully specified
by `(SW, SOURCE-CC, TARGET=track+fn)`; the other seven fields are always the same
defaults (MODE=MOMENT `B=0`, ACT.LO `E=0`, ACT.HI `F=127`, MIN `I=0`/OFF, MAX
`J=1`/ON, `D=G=0`). Write the memory to the pair-slot whose `<count>` you raise
above its sibling (see the A/B selector above).
