# Axe-Fx III SysEx map

**Authoritative source for the III protocol layer.** Before searching
the web, reading other OSS libraries, or speculating about III wire
shapes, check this doc and the underlying text extraction.

## Spec text extraction (READ THIS FIRST)

- **Local extracted text:** [`docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`](../../manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt) (353 lines).
- **Original PDF:** [`docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.pdf`](../../manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.pdf), Revision 1.4, "supported in Axe-Fx III firmware 1.13 or greater."
- **Index entry:** [`docs/REFERENCES.md`](../../REFERENCES.md) row "Axe-Fx-III-MIDI-for-3rd-Party-Devices.pdf".

The PDF is the **only** public protocol document Fractal ships for
the III generation. Everything beyond what it covers is either
community reverse-engineering or unverified inference from the
Axe-Fx II spec. **Treat anything not in the .txt as 🟡 unverified.**

## Envelope

```
F0 00 01 74 10 cc dd dd dd ... cs F7
```

- `F0` — SysEx start
- `00 01 74` — Fractal manufacturer prefix
- `10` — Axe-Fx III model byte (FM3=0x11, FM9=0x12, VP4=0x14, AM4=0x15)
- `cc` — function / command opcode
- `dd ...` — variable payload
- `cs` — XOR of every byte from `F0` through last payload byte, AND `0x7F`
- `F7` — SysEx end

Checksum implementation: `packages/core/src/fractal-shared/checksum.ts`.

## Function table (from v1.4 PDF, verbatim)

| Opcode | Name | Direction | Notes |
|---|---|---|---|
| `0x0A` | SET / GET BYPASS | bidir | `id id dd` payload. `dd=0` engaged, `1` bypassed, `7F` query. Returns same shape with current state. |
| `0x0B` | SET / GET CHANNEL | bidir | `id id dd` payload. `dd=0..3` (A..D), `7F` query. |
| `0x0C` | SET / GET SCENE | bidir | `dd` payload. `7F` query. Spec line: "where dd is the current scene." |
| `0x0D` | QUERY PATCH NAME | host→device, response | **`dd dd` payload = preset number** (LS-first 7-bit pair); `dd dd = 7F 7F` to query the current preset. Response: `nn nn dd*32` (preset number + 32-char name). This is BOTH "what preset is active" and "what's the name of preset N." |
| `0x0E` | QUERY SCENE NAME | host→device, response | `dd` payload = scene index. `7F` for current scene. Response: `nn dd*32` (scene index + 32-char name). No SET variant. |
| `0x0F` | SET / GET LOOPER STATE | bidir | `dd` = button (0=Record, 1=Play, 2=Undo, 3=Once, 4=Reverse, 5=Half-speed). `7F` query. Response: `dd` bitfield (bit0=Record, bit1=Play, bit2=Overdub, bit3=Once, bit4=Reverse, bit5=Half-speed). |
| `0x10` | TEMPO TAP | host→device | No payload. Single-shot. Also the format of an unprompted "tempo down-beat" push (no checksum). |
| `0x11` | TUNER ON/OFF | host→device | `dd=0` off, `dd=1` on. The push-variant (sent when tuner is active) is `nn ss cc` (note, string, cents) without checksum. |
| `0x13` | STATUS DUMP | host→device, response | No request payload. Response: variable-length list of `id id dd` triples, one per effect in the active preset. `dd` bit layout: bit 0 = bypass, bits 3:1 = channel (0..7; current max is 3 → channels 0..3 = A..D), bits 6:4 = number of channels supported by this effect. |
| `0x14` | SET / GET TEMPO | bidir | `dd dd` payload = BPM (LS-first 7-bit pair). `7F 7F` query. |

**That is the ENTIRE documented function-byte set in v1.4.**
Notably absent — operations that exist in other Fractal devices but
are NOT in the III's third-party spec:

- **No `SET_PRESET_NUMBER` / `SWITCH_PRESET` function.** Remote preset
  switching on the III is via standard MIDI Program Change messages
  (PC), not SysEx. The III does NOT accept "switch to preset N" as a
  SysEx command from a third-party device.
- **No `SET_PARAMETER_VALUE` function.** Per-block parameter writes
  are not exposed in the spec. The Axe-Fx II spec exposes `0x02
  SET_PARAMETER_VALUE`; the III deliberately omits it.
- **No `STORE_PRESET` / `SAVE_PRESET` function.** The III's preset-
  store wire format is a community-reverse-engineered **18-frame
  envelope** (1× `0x77` header + 16× `0x78` body + 1× `0x79` footer
  for the III; 10-frame for FM3/FM9). Body content is **Huffman-
  compressed**. Full research log + post-by-post evidence chain in
  [`preset-format-research.md`](preset-format-research.md).
  Forum thread #159885 is archived locally at `docs/_private/fractal-forum-text.txt`.
- **No `FRONT_PANEL_CHANGE` push (0x21).** Our earlier design notes
  reference `0x21` as the III's dirty-state signal — it is NOT in
  v1.4. Source for that claim is unidentified; treat as unverified.
- **No `SET_GRID_CELL` / `SET_CELL_ROUTING`.** Grid topology authoring
  is not exposed.
- **No `SET_PRESET_NAME` / `SET_SCENE_NAME`.** Names are query-only
  via 0x0D / 0x0E.

## Effect IDs — Appendix 1 (from v1.4 PDF)

The PDF DOES enumerate effect IDs for the third-party MIDI surface.
These are the 14-bit values that go in `id id` payload slots for
functions `0x0A` SET_BYPASS, `0x0B` SET_CHANNEL, and `0x13`
STATUS_DUMP responses. **Earlier project docs claimed these IDs were
undocumented — that claim is wrong.**

Ranges below are derived from the C-enum auto-increment style the
PDF uses (each entry without an `= N` continues from the previous
explicit assignment).

| Block | Instance count | Effect IDs (1..N) |
|---|---|---|
| `ID_CONTROL` | 1 | 2 |
| (IDs 3-34 reserved / not enumerated in v1.4 — see "Anomalies" below) | | |
| `ID_TUNER` | 1 | 35 |
| `ID_IRCAPTURE` | 1 | 36 |
| `ID_INPUT1..5` | 5 | 37, 38, 39, 40, 41 |
| `ID_OUTPUT1..4` | 4 | 42, 43, 44, 45 |
| `ID_COMP1..4` (Compressor) | 4 | 46, 47, 48, 49 |
| `ID_GRAPHEQ1..4` | 4 | 50, 51, 52, 53 |
| `ID_PARAEQ1..4` | 4 | 54, 55, 56, 57 |
| `ID_DISTORT1..4` (Drive) | 4 | 58, 59, 60, 61 |
| `ID_CAB1..4` | 4 | 62, 63, 64, 65 |
| `ID_REVERB1..4` | 4 | 66, 67, 68, 69 |
| `ID_DELAY1..4` | 4 | 70, 71, 72, 73 |
| `ID_MULTITAP1..4` | 4 | 74, 75, 76, 77 |
| `ID_CHORUS1..4` | 4 | 78, 79, 80, 81 |
| `ID_FLANGER1..4` | 4 | 82, 83, 84, 85 |
| `ID_ROTARY1..4` | 4 | 86, 87, 88, 89 |
| `ID_PHASER1..4` | 4 | 90, 91, 92, 93 |
| `ID_WAH1..4` | 4 | 94, 95, 96, 97 |
| `ID_FORMANT1..4` | 4 | 98, 99, 100, 101 |
| `ID_VOLUME1..4` | 4 | 102, 103, 104, 105 |
| `ID_TREMOLO1..4` (Pan/Tremolo) | 4 | 106, 107, 108, 109 |
| `ID_PITCH1..4` | 4 | 110, 111, 112, 113 |
| `ID_FILTER1..4` | 4 | 114, 115, 116, 117 |
| `ID_FUZZ1..4` | 4 | 118, 119, 120, 121 |
| `ID_ENHANCER1..4` | 4 | 122, 123, 124, 125 |
| `ID_MIXER1..4` | 4 | 126, 127, 128, 129 |
| `ID_SYNTH1..4` | 4 | 130, 131, 132, 133 |
| `ID_VOCODER1..4` | 4 | 134, 135, 136, 137 |
| `ID_MEGATAP1..4` | 4 | 138, 139, 140, 141 |
| `ID_CROSSOVER1..4` | 4 | 142, 143, 144, 145 |
| `ID_GATE1..4` | 4 | 146, 147, 148, 149 |
| `ID_RINGMOD1..4` | 4 | 150, 151, 152, 153 |
| `ID_MULTICOMP1..4` | 4 | 154, 155, 156, 157 |
| `ID_TENTAP1..4` | 4 | 158, 159, 160, 161 |
| `ID_RESONATOR1..4` | 4 | 162, 163, 164, 165 |
| `ID_LOOPER1..4` | 4 | 166, 167, 168, 169 |
| `ID_TONEMATCH1..4` | 4 | 170, 171, 172, 173 |
| `ID_RTA1..4` | 4 | 174, 175, 176, 177 |
| `ID_PLEX1..4` (Plex Delay) | 4 | 178, 179, 180, 181 |
| `ID_FBSEND1..4` | 4 | 182, 183, 184, 185 |
| `ID_FBRETURN1..4` | 4 | 186, 187, 188, 189 |
| `ID_MIDIBLOCK` (Scene MIDI) | 1 | 190 |
| `ID_MULTIPLEXER1..4` | 4 | 191, 192, 193, 194 |
| `ID_IRPLAYER1..4` | 4 | 195, 196, 197, 198 |
| `ID_FOOTCONTROLLER` | 1 | 199 |
| `ID_PRESET_FC` | 1 | 200 |

### Anomalies in v1.4 effect-ID table

1. **AMP is missing from the effect-ID enumeration.** No `ID_AMP1..N`
   appears in the PDF. AMP IDs may be in the unaccounted-for 3..34
   range (32 reserved slots between ID_CONTROL and ID_TUNER), or
   may be deliberately omitted from the third-party MIDI surface.
   **Until verified on hardware, treat AMP bypass/channel control
   as 🟡 unsupported.** A test-against-hardware would be a single
   STATUS_DUMP call against a preset known to contain the AMP block —
   the response would reveal whichever ID corresponds to the AMP.

2. **Recent blocks are absent.** Spec is v1.4 / firmware 1.13 era
   (~2018). Current firmware is 32.03 (March 2026). Blocks added in
   later firmware are NOT in this table:
   - **Dynamic Distortion** (firmware 20.00 / 2022) — no ID
   - **NAM** (asset present in AxeEdit III but no release-note mention) — no ID
   - **Newer Multiplexer instances** beyond 4 (if any) — unknown
   - Their IDs are presumably ≥ 201, but we don't know which.

3. **`ID_FUZZ` is its own entry** separate from `ID_DISTORT`.
   Fractal's modern UI calls everything "Drive" — but the PDF
   distinguishes Distort (= drive) from Fuzz at the SysEx layer.
   Whether these are two separate placeable block types or one
   block-type with two ID ranges is unclear.

4. **`ID_DISTORT` is Fractal's older name for the Drive block.**
   For 3rd-party MIDI purposes, this is what populates as "DRV" in
   editor assets / wiki.

## Bugs found 2026-05-15 — RESOLVED

The Tier-A tools shipped earlier in the same session had the bugs
listed below. **All resolved in the cleanup commit** that landed:

- `setParam.ts` rewritten from scratch against v1.4 PDF spec
- `blockTypes.ts` now carries v1.4 Appendix 1 effect IDs
- `descriptor.ts` removed the broken `switchPreset`, added
  `setBypass` / `setChannel` using effect IDs
- Tool surface rewritten: `axefx3_switch_preset` removed (no such
  SysEx function); `axefx3_get_preset_name` merged with
  `get_active_preset_number` (0x0D returns both); new tools for
  bypass / channel / tempo / tuner / looper
- Byte-exact goldens updated for the new builders

The list below is preserved as a historical record:

| # | Bug | Code location | Spec says |
|---|---|---|---|
| 1 | `FN_SET_GET_PRESET_NUMBER = 0x0d` is a fiction. The spec has no SET_PRESET function; `0x0D` is QUERY PATCH NAME. | `setParam.ts:55` | 0x0D = QUERY PATCH NAME (preset name lookup by number). |
| 2 | `FN_QUERY_PRESET_NAME = 0x0f` is wrong. `0x0F` is SET/GET LOOPER STATE. | `setParam.ts:57` | 0x0F = LOOPER. Preset name is on 0x0D. |
| 3 | `buildSwitchPreset(N)` sends bytes the III interprets as "give me the name of preset N", not "switch to preset N." There is NO SysEx switch_preset on the III — use MIDI PC. | `setParam.ts:102-119` | No SET_PRESET in spec. |
| 4 | `buildSwitchPreset('query')` uses a single `7F` sentinel; spec calls for `7F 7F` (two-byte LS-first) per 0x0D's payload shape. | `setParam.ts:107` | "let dd dd = 7F 7F" — TWO 7F bytes for the current-preset query. |
| 5 | `axefx3_switch_preset` tool doesn't switch presets. It queries a preset name and returns nothing useful. | `tools/navigation.ts` | Use MIDI Program Change (PC) for III preset switching. |
| 6 | `axefx3_get_preset_name` uses 0x0F (LOOPER) — sends a looper-button command, not a name query. | `tools/navigation.ts` get_preset_name handler | Use 0x0D with `dd dd = 7F 7F` for current preset name. |
| 7 | `axefx3_get_active_preset_number` and `get_preset_name` ought to be one tool: 0x0D query returns BOTH the preset number AND its name. | both navigation.ts handlers | One 0x0D query gives `nn nn` (preset number) + `dd*32` (name). |
| 8 | `FN_SET_PARAMETER_VALUE = 0x02` is declared as a constant — but `0x02` is NOT in the v1.4 PDF. This is family inference from Axe-Fx II. | `setParam.ts:51` | The III's parameter-write opcode is NOT documented anywhere public. Family inference is the only path. |
| 9 | `FN_FRONT_PANEL_CHANGE = 0x21` is referenced in design notes as the III dirty signal. Not in v1.4 PDF. Source unidentified. | `setParam.ts:59`, [`design-notes.md`](design-notes.md) | Treat as unverified. The PDF documents only `0x10` (tempo down-beat) and `0x11` (tuner) as push frames. |
| 10 | Block roster (`blockTypes.ts`) ships every block with `id: null` claiming "effectId pending capture." Effect IDs ARE in the spec Appendix 1 — only AMP and post-firmware-1.13 blocks are unspecified. | `blockTypes.ts` | Populate `id:` from Appendix 1. Leave AMP, NAM, Dynamic Distortion as `null`. |

## 0x01 PARAMETER_SETGET — byte-verified from public captures 🟢 SET / 🟡 GET

**Status (Session 97, 2026-05-18 — PIVOT).** The III's parameter-write
opcode is **`fn=0x01`** with a 2-byte sub-action discriminator, NOT
`fn=0x02` as Sessions 85+86 had ported from the Axe-Fx II. The pivot
was triggered by an open-web research sweep that surfaced 6 byte-exact
public captures (Mountain Utilities forum, user "gabbernutter",
2019-03-13) of AxeEdit III writing Delay 1 TIME. Combined with the 4
FC-12 captures previously archived in [`fn01-decode.md`](
fn01-decode.md), the corpus is now **10 captures from 2
independent community sources spanning 2 effect blocks and 2 sub-action
codes** — all on `fn=0x01`, **zero on `fn=0x02`**. The Session 84-era
"port from II" was a reasonable hypothesis but contradicted every
captured III parameter-write on the open web.

**SET** wire shape is byte-verified; the encoder + parser in
`packages/axe-fx-iii/src/setParam.ts` ship with 4 byte-exact encoder
goldens + 4 capture-parse goldens in
`scripts/verify-axe-fx-iii-encoding.ts`. Full capture corpus +
field-layout table: [`set-parameter-captures.md`](
set-parameter-captures.md).

**GET** wire shape is still 🟡 hypothesis — and Session 97 research
clarified the response side is more subtle than initially framed.
Forum thread #203336 (j20056 + GlennO, April 2024) revealed that the
`04 01` STATE_BROADCAST sub-action is an **AxeEdit-driven heartbeat
poll**, NOT a device-initiated push-on-edit event. j20056 confirmed:
*"as soon as I quit Axe-Edit, then all MIDI traffic stops."* This
means a bare III (no editor running) will likely produce NO inbound
`04 01` frames at all — so the MCP `axefx3_get_parameter` tool's
250 ms timeout is the expected outcome on bare hardware, not a tool
error. Callers should fall back to 0x13 STATUS_DUMP (bypass+channel
only) for state queries, or hold the value optimistically after SET
and only re-read when explicit user request demands it.

Same passive-sniff capture also revealed an uncatalogued sub-action
`2E 00` (~245-byte device-emitted frame, likely preset/scene state
dump) — decode is unblocked, no hardware needed. See
[`axefx3-fn01-decode.md`](axefx3-fn01-decode.md) §"Sub-action `2E 00`".

### Evidence chain (10 captures, 2 sources)

**Source A — FC-12 footswitch (4 captures, Session 79 era).** Drive 1/2
boost ON/OFF, sub-action `52 00` (mouse-drag form, emitted by the FC-12
for binary toggles). Effect IDs 58/59 = `ID_DISTORT1` / `ID_DISTORT2`
per v1.4 Appendix 1. Originally decoded into the field-layout table in
[`axefx3-fn01-decode.md`](axefx3-fn01-decode.md).

**Source B — Mountain Utilities forum (6 captures, gabbernutter
2019-03-13).** AxeEdit III writing Delay 1 TIME. Effect ID 70 =
`ID_DELAY1`, paramId 2. Four frames sub-action `52 00` (mouse-drag,
intermediate values mid-drag) + two frames sub-action `09 00`
(typed-input, final value). Discovered Session 97 via open-web
research; bytes archived in [`axefx3-set-parameter-captures.md`](
axefx3-set-parameter-captures.md).

Each capture validates against the standard Fractal XOR-7bit checksum
algorithm. Field positions are consistent across both sources and both
sub-actions.

### Wire shape (23 bytes, sub-action 09 00 typed-input — what we ship)

```
F0 00 01 74 10 01
  [sub_lo sub_hi]    sub-action: 09 00 = typed-input SET (clean envelope)
                                  52 00 = mouse-drag SET (drag context at pos 12-14)
                                  04 01 = STATE_BROADCAST (device→host, unsolicited)
  [id_lo id_hi]      14-bit effect ID per v1.4 Appendix 1 (LS-first)
  [pid_lo pid_hi]    14-bit paramId (LS-first) — see Ghidra catalog
  [00 00 00]         drag-context bytes (zero for typed input)
  [v0 v1 v2]         16-bit value packed into 3 septets:
                       v0 = bits 6..0
                       v1 = bits 13..7
                       v2 = bits 15..14
                     (All observed III params use 14-bit values; v2 = 0.)
  [00 00 00]         reserved zeros
  [cs] F7            checksum + SysEx end
```

Total length 23 bytes. Value range carried forward as 0..65534
(16-bit) for II compatibility, though no observed III param exceeds
14-bit. Display ↔ wire conversion is the caller's responsibility — the
III publishes no per-param display calibration. For paramId → symbolic
name lookup, use the Ghidra catalog at
`samples/captured/decoded/ghidra-axeedit3-paramnames.json` (49 effect
families, 2216 paramIds, mined Session 82).

### Builder + parser surface

`packages/axe-fx-iii/src/setParam.ts` ships:

- `buildSetParameter(effectId, paramId, value)` — emits the 23-byte
  typed-input SET (sub-action `09 00`). 🟢 verified.
- `buildGetParameter(effectId, paramId)` — same envelope with value
  zeroed, hypothesis-only.
- `buildSetParameterBypass(effectId, bypassed)` — paramId 255
  convenience; the v1.4 PDF's `0x0A SET_BYPASS` is preferred for
  production bypass writes.
- `parseSetGetParameterResponse(bytes)` — accepts inbound fn=0x01
  frames; disambiguates by sub-action. STATE_BROADCAST `04 01`
  returns `paramId=0` (the broadcast doesn't carry paramId; caller
  tracks last-SET to attribute the value).

MCP tools `axefx3_set_parameter` + `axefx3_get_parameter` wrap these
and bracket every SET with a 250 ms `0x64 MULTIPURPOSE_RESPONSE`
listener. Rejections (e.g. `MIDI_ERROR_INVALID_FXID`,
`MIDI_ERROR_INVALID_PARAMID`) are surfaced inline in the tool reply —
not silent failure.

### Why the previous fn=0x02 port was wrong

Sessions 85+86 shipped `FN_SET_PARAMETER = 0x02` as a II→III model-byte
swap based on:

1. **AxeEdit III binary** (Ghidra Session 82) — opcode `0x02` appears
   in the message-builder caller list, so III firmware has code paths
   reachable via that opcode.
2. **Axe-Fx II community evidence** — prs22 (forum thread #49417),
   fret (#99763), Chris Hurley (#140602) all documented `fn=0x02`
   working on II Mark I/II/XL+.
3. **simonp54 (#140602)** — "No longer officially possible... the
   only 'supported' features are in the third party spec." Read as
   "fn=0x02 was removed from public docs but firmware still honors
   it on II."

The reasoning was internally consistent but didn't survive Session 97's
broader open-web sweep. **Every captured III parameter-write uses
`fn=0x01`**, not `fn=0x02`. The Ghidra binding `0x02 ∈ message-builder
caller list` is still consistent with the pivot — `fn=0x02` may exist
in III firmware for some other purpose (legacy II compatibility?
internal diagnostics?), but it is NOT the parameter-write opcode that
AxeEdit III invokes during normal use.

## §0x02 SET_PARAMETER — III byte-shape hypothesis (CLOSED Session 97)

**Status:** ❌ CLOSED. The Session 86-era hypothesis tree (H1..H5
candidate envelopes for III SET_PARAMETER) is **resolved.** The winner
was a variant of H4 (`fn=0x01`, 23-byte payload) — see the new "§0x01
PARAMETER_SETGET" section above for the byte-verified envelope.

The hypothesis tree below is preserved for historical context (showing
how Session 85+86 reasoned about the candidates before the open-web
sweep surfaced the 6 gabbernutter captures that disambiguated). H4
was correctly flagged as a candidate with the right `fn=0x01` and the
right Drive 1/2 captures, but ranked MEDIUM-LOW because of incomplete
field-layout decoding. Session 97's 6 additional captures (different
block, different paramId, different sub-action `09 00`) locked the
field layout.

**Probe script** `scripts/_research/probe-axefx3-setparam-hypothesis.ts`
was **deleted Session 97** — obsolete for SET_PARAMETER now that the
wire is byte-verified. The probe pattern is general-purpose; if a
future undocumented III opcode needs the same triage, re-implement
against a fresh probe-id list. Historical script content is
recoverable via `git log --diff-filter=D` if needed.

---

(Pre-pivot hypothesis tree retained below for archival reasons.)

The shipping encoder (Hypothesis 1 below) was one of several plausible
candidate wire shapes for III SET_PARAMETER. Each candidate had its
byte-exact frame, hypothesis ID, and rejection criteria documented so
the first III contributor could run a full sweep and lock the decode
in a single session. (Probe script retired Session 97; the captures
resolved the tree without needing the live probe.)

**How to identify the winner.** The probe sends each frame in turn
and listens 250 ms for inbound. A frame that earns an ECHO of its own
`fn` byte (e.g. `F0 00 01 74 10 02 …`) is the winner — the device
parsed it as a real SET_PARAMETER request. A `0x64
MULTIPURPOSE_RESPONSE` carrying the same echoed `fn` is a definitive
NEGATIVE for that envelope (parsed but rejected — the `result_code`
tells us why). Silence is ambiguous; pair with a follow-up `get`
read to disambiguate.

Ranked highest → lowest confidence:

### Hypothesis 1 — `fn=0x02`, II byte-shape, LS-first 14-bit fields, SET action

**Confidence: HIGHEST.** This is the currently shipping wire shape
(`packages/axe-fx-iii/src/setParam.ts:buildSetParameter` — Session 85
port from II).

**Wire shape** (16 bytes for `axefx3_set_parameter(block='Reverb 1',
param_id=0, value=0)`):

```
F0 00 01 74 10 02
   42 00          ← effectId 66 (Reverb 1) LS-first septet pair
   00 00          ← paramId 0 (REVERB_TYPE per Ghidra) LS-first septet pair
   00 00 00       ← value 0 packed across three 7-bit septets
   01             ← action 0x01 = SET commit
   54 F7          ← XOR-7bit checksum + SysEx end
```

**Evidence chain:**
- Axe-Fx II hardware-verified on Q8.02 XL+ (HW-075 + HW-077, 2026-05-10).
- AxeEdit III binary contains code paths reachable via opcode `0x02`
  (Ghidra Session 82 mining of `FUN_1403437d0` caller list).
- prs22, forum thread #49417 (2012) — published the literal II wire
  shape used as the port template.
- Chris Hurley, forum thread #140602 (2018) — used the opcode on an
  Axe-Fx II XL+ for amp drive / master control.

**Probe id:** `H1_II_PORT_0x02_LE`.

### Hypothesis 2 — `fn=0x02`, II byte-shape, QUERY action (read-only)

**Confidence: HIGH.** Identical envelope to H1 but with action byte
`0x00` (QUERY) instead of `0x01` (SET). The II's GET responds with
an echoed envelope + value (+ optional label string).

**Why probe this separately:** if the III silently ignores SETs but
honors GETs, H2 lights up where H1 doesn't — confirming the wire
shape without committing any state change. This is the recommended
**first** probe a III contributor runs: it's idempotent and lets us
confirm the envelope decode without touching the device's preset
buffer.

**Wire shape** (16 bytes):
```
F0 00 01 74 10 02 42 00 00 00 00 00 00 00 55 F7
```

**Evidence chain:** H1's chain plus the II's documented GET-vs-SET
asymmetry on certain blocks per Fractal wiki §"obtaining parameter
values".

**Probe id:** `H2_II_PORT_0x02_QUERY`.

### Hypothesis 3 — `fn=0x02`, MS-first 14-bit fields, LS-first value, SET

**Confidence: MEDIUM.** Swaps the byte ordering of the effectId and
paramId septet pairs from LS-first to MS-first; keeps the value
field LS-first (the 3-septet 16-bit pack doesn't have an "endian"
choice).

**Why this might be right:** Two other Axe-Fx II 14-bit fields turned
out to be MS-first despite wiki claims of LS-first — HW-100 / HW-102
hardware-verified `buildStorePreset` (0x1D) and
`parseGetPresetNumberResponse` (0x14) both as MS-first. If III's
SET_PARAMETER inherits the same firmware quirk, swapping the two id
pairs to MS-first lands the frame on the right effectId / paramId
instead of silently aliasing to a different (effectId, paramId).

**Wire shape** (16 bytes):
```
F0 00 01 74 10 02 00 42 00 00 00 00 00 01 54 F7
```

**Evidence chain:** II HW-100 (`buildSwitchPreset` MS-first verified)
+ II HW-102 (`parseGetPresetNumberResponse` MS-first verified). No
direct III evidence — pure cross-family quirk extension.

**Probe id:** `H3_0x02_MS_FIRST_IDS`.

### Hypothesis 4 — `fn=0x01`, 16-byte payload (AxeEdit III capture shape)

**Confidence: MEDIUM-LOW.** Public captures of AxeEdit III / FC-12
traffic show real `fn=0x01` SysEx frames with ~16-byte payloads — far
longer than anything in v1.4. The captured Amp 1 Boost on/off pair
(documented above in §"Function 0x01") differs only in the value
region (`7C 03 → 00 00`), so this IS some form of per-block param
write — just under a different fn byte than the II's `0x02`.

**Wire shape** (24 bytes total, value=0 / "off" shape):
```
F0 00 01 74 10 01 42 00 00 00 28 00 00 00 00 00 00 00 00 00 00 00 7E F7

structure:
   F0 00 01 74 10                ← envelope + III model byte
   01                            ← fn byte
   42 00                         ← effectId 66 (Reverb 1) LS-first
   00 00                         ← paramId 0 LS-first
   28 00 00 00 00                ← 5-byte ? (copied verbatim from observed capture)
   00 00 00 00 00 00             ← 6-byte value field zeroed
   00                            ← 1-byte trailing ? (zero in observed capture)
   7E F7                         ← XOR-7bit checksum + SysEx end
```

**Why probe this:** the III may have a fundamentally different
SET_PARAMETER opcode than the II, and `fn=0x01` is the only other
function byte we've seen long-payload traffic on in the wild. If H1
silently ignores and H4 acks, that's a positive III-specific
SET_PARAMETER and the entire `setParam.ts` builder needs to migrate.

**Evidence chain:** USB capture documented in SYSEX-MAP-AXE-FX-III.md
§"Function 0x01" (Amp 1 Boost on/off). Field semantics within the
payload are tentative (the on/off differ only in the value region,
but the leading 5-byte `28 00 00 00 00` and trailing `00` could be
context bytes, address fragments, etc.). Probe is binary — accepts
or rejects — so semantics don't need to be decoded to evaluate the
hypothesis.

**Probe id:** `H4_fn0x01_LONG_PAYLOAD`.

### Hypothesis 5 — `fn=0x12`, II byte-shape payload (Ghidra-mined undocumented opcode)

**Confidence: LOW.** Ghidra Session 82 mined AxeEdit III's caller
list of the generic SysEx message-builder (`FUN_1403437d0`) and
identified `fn=0x12` as undocumented (not in v1.4, 2 caller sites)
with a payload that includes the model byte loaded from a device-
handle struct.

**Why probe this:** the model-from-struct payload pattern matches
how SET_PARAMETER varies across the modern Fractal family. If the
II's `fn=0x02` is reserved for legacy II compatibility and the III
moved per-knob writes to `fn=0x12`, that would explain why opcode
`0x02` could be a no-op on III despite being reachable in the
binary (the AxeEdit III code may call `0x02` only for diagnostic
reasons, with `0x12` doing the actual UI work).

**Wire shape** (16 bytes — same II shape, just under `fn=0x12`):
```
F0 00 01 74 10 12 42 00 00 00 00 00 00 01 44 F7
```

**Evidence chain:** Ghidra Session 82 fn-byte inventory in this doc's
"Function bytes confirmed in the AxeEdit III binary" table. No
capture, no community mention — speculative but cheap to probe.

**Probe id:** `H5_fn0x12_II_SHAPE`.

### How to run the probe (RETIRED Session 97)

The probe script `scripts/_research/probe-axefx3-setparam-hypothesis.ts`
was deleted Session 97 once the H1..H5 tree was resolved by the public
captures. Historical reproduction is via git log if needed:

```bash
git log --diff-filter=D --pretty=oneline -- scripts/_research/probe-axefx3-setparam-hypothesis.ts
```

The probe pattern (send candidate frames, listen 250 ms, classify by
inbound) is general-purpose — re-implement against a new probe-id
list if a future undocumented III opcode needs the same triage.

Once the winner is identified, update this section with the
hardware-verified envelope and lock it via byte-exact goldens in
`scripts/verify-axe-fx-iii-encoding.ts`. The 🟡 untested marker on
the `axefx3_set_parameter` MCP tool flips to 🟢, and 2216 III
paramIds become writable from the MCP surface.

---

## Community-captured wire confirmations

Several of our builders have been independently verified against
real-world SysEx captures posted publicly to the Fractal Forum.
This is hardware-verification-equivalent for these operations even
though the project doesn't own an Axe-Fx III.

| Builder | Forum-confirmed wire | Our golden | Match |
|---|---|---|---|
| `set_bypass(Reverb 1, false)` (function 0x0A, effect ID 66 = Reverb 1) | `F0 00 01 74 10 0A 42 00 00 5D F7` (forum thread #184833, captured from a third-party MIDI controller) | `f0000174100a4200005df7` | ✓ |
| `switch_scene(1..8)` (function 0x0C, scenes wire 0..7) | All 8 wire forms `F0 00 01 74 10 0C [wire] [cs] F7` (forum thread #182318, 2022-03, "correct and tested") | All 8 matches | ✓ |
| `set_tempo(120)` (function 0x14, BPM 120 = 0x78) | `F0 00 01 74 10 14 78 00 79 F7` (forum thread #162904, community example) | `f0000174101478007 9f7` | ✓ |
| `get_tempo()` (function 0x14, sentinel 7F 7F) | `F0 00 01 74 10 14 7F 7F 01 F7` (forum thread #140602) | `f000017410147f7f01f7` | ✓ |

**Caveats:**

- **`get_tempo` reportedly had a side-effect on early-firmware III**
  (forum bug report 2018-09-06, firmware ~1.x era): sending the get
  request actually SET the tempo to 250 BPM (the max). Current
  firmware is 32.03 and the bug was reported to FractalAudio
  directly; assume fixed unless a tester reports otherwise. The
  tool description for `axefx3_get_tempo` should mention this so a
  user with weird tempo behavior on old firmware can blame the
  right thing.

- **`set_bypass` wire example** uses an external MIDI controller
  sending to the III's USB-MIDI port. Verifies the wire shape but
  not the round-trip ack (the III may or may not echo a 0x0A
  response — capture didn't include the response window).

- **Additional set_bypass capture** (forum thread #218547, user
  observing unwanted block muting): `F0 00 01 74 10 0A 25 00 01 3B F7`
  — function 0x0A, effect ID `25 00` = 37 (Input 1 per v1.4
  Appendix), dd=1 (bypassed), cs=0x3B. Verifies our effect-ID
  resolution for `Input 1`.

## Undocumented function bytes seen in the wild

The v1.4 PDF documents 0x0A through 0x14 plus 0x13. Several captures
show **function bytes outside that range** being used in real III
traffic. These are likely the "set parameter / set modifier" calls
the public spec deliberately omits.

### Function 0x01 — long-payload write (likely SET_PARAMETER / SET_MODIFIER)

Examples from captures of AxeEdit III / FC-12 footswitch traffic:

```
Amp 1 Boost on:  F0 00 01 74 10 01 52 00 3A 00 28 00 00 00 00 7C 03 00 00 00 00 2B F7
Amp 1 Boost off: F0 00 01 74 10 01 52 00 3A 00 28 00 00 00 00 00 00 00 00 00 00 54 F7
Amp 2 Boost on:  F0 00 01 74 10 01 52 00 3B 00 28 00 00 00 00 7C 03 00 00 00 00 2A F7
```

22-byte payload after the function byte. Tentative field shape:
`[effect_id × 2][param_id × 2][?? × 4][value × 6][?? × 6][cs] F7`.
The two examples that differ only by enable/disable (boost-on vs
boost-off) confirm the value field is the `7C 03 → 00 00` swap.
Decoding the field layout precisely would require pairing several
captures with known parameter values — a target for any future
`set_param` work.

Note that v1.4 doesn't reserve 0x01 for any documented purpose, and
the Axe-Fx II family uses 0x01 for `GET_BLOCK_PARAMETERS_LIST` (a
different function) — the III repurposed the same byte for what
appears to be parameter-write.

### Function 0x21 — front-panel-change auto-push

Multiple captures of "AxeFXIII MIDI Input receives TONS of messages"
threads show frames with function byte 0x21 streaming during
front-panel knob movement. Earlier this was attributed to design-
note speculation; the capture confirms it's a real device-emitted
function. Useful for any future dirty-state detection.

### Function 0x64 — MULTIPURPOSE_RESPONSE (error / ack channel)

In the v1.4 PDF as the response opcode. A real-world capture
confirms the wire shape when the III rejects a malformed request:

```
F0 00 01 74 10 64 [echoed_fn] [result_code] [cs] F7
```

Example: a host sent QUERY_SCENE_NAME (0x0E) with a bad checksum.
The III responded `F0 00 01 74 10 64 0E 00 7F F7` — function 0x64,
echoed 0x0E, result code 0x00, valid checksum 0x7F.

**Status: shipped (Session 80).** The III tools now bracket each
fire-and-forget SET write with a 250ms 0x64 listener
(`sendAndWatchForError` in `packages/axe-fx-iii/src/tools/shared.ts`).
When a 0x64 arrives it surfaces as a warning in the tool response
text — `(echoed_fn, result_code)` plus a human label for known codes.
Byte-exact predicate + parser goldens (including the community-captured
`F0 00 01 74 10 64 0E 00 7F F7` frame) live in
`scripts/verify-axe-fx-iii-encoding.ts`.

**Result code table (28 codes, decoded Session 81 from AxeEdit III
1.14.31 binary).** Index = result_code byte. Source: contiguous
`MIDI_ERROR_*` string table at .rdata offset 0x597108 in
`Axe-Edit III.exe`; 0x00 = `MIDI_ERROR_BAD_CHKSUM` matches the
empirically-verified bad-checksum capture above, so the index → code
mapping is high-confidence. See [`fn01-decode.md`](fn01-decode.md) for the
full extraction evidence.

| Code | Label | Meaning |
|---|---|---|
| 0x00 | MIDI_ERROR_BAD_CHKSUM | bad checksum |
| 0x01 | MIDI_ERROR_WRONG_SYSEX_ID | wrong SysEx manufacturer ID |
| 0x02 | MIDI_ERROR_WRONG_MODEL_NUM | wrong model number |
| 0x03 | MIDI_ERROR_BAD_ARGUMENT | bad argument |
| 0x04 | MIDI_ERROR_MSG_NOT_RECOGNIZED | message not recognized |
| 0x05 | MIDI_ERROR_INVALID_FXID | invalid effect ID |
| 0x06 | MIDI_ERROR_INVALID_PARAMID | invalid parameter ID |
| 0x07 | MIDI_ERROR_FX_NOT_IN_USE | effect not in use in this preset |
| 0x08 | MIDI_ERROR_NO_MODIFIERS_LEFT | no modifier slots left |
| 0x09 | MIDI_ERROR_WRONG_COUNT | wrong count |
| 0x0A | MIDI_ERROR_FX_NOT_ROUTABLE | effect not routable here |
| 0x0B | MIDI_ERROR_BAD_GRID_POS | bad grid position |
| 0x0C | MIDI_ERROR_DSP_OVERLOAD | DSP overload |
| 0x0D | MIDI_ERROR_FUNCTION_FAIL | function failed |
| 0x0E | MIDI_ERROR_INVALID_PATCHNUM | invalid patch number |
| 0x0F | MIDI_ERROR_ILLEGAL_MSG | illegal message |
| 0x10 | MIDI_ERROR_BAD_MSG_LENGTH | bad message length |
| 0x11 | MIDI_ERROR_IMAGE_SIZE_INCORRECT | image size incorrect (firmware) |
| 0x12 | MIDI_ERROR_BAD_IMAGE_CHKSUM | bad image checksum (firmware) |
| 0x13 | MIDI_ERROR_NOT_RDY_FOR_FW_UPD | not ready for firmware update |
| 0x14 | MIDI_ERROR_BUFFER_OVERRUN | buffer overrun |
| 0x15 | MIDI_ERROR_INVALID_CABNUM | invalid cab number |
| 0x16 | MIDI_ERROR_INVALID_MODIFIERID | invalid modifier ID |
| 0x17 | MIDI_ERROR_INVALID_BANKNUM | invalid bank number |
| 0x18 | MIDI_ERROR_FIRMWARE_ALREADY_CURRENT | firmware already current |
| 0x19 | MIDI_ERROR_CMD_NOT_SUPPORTED | command not supported |
| 0x1A | MIDI_ERROR_NULL_DATA | null data |
| 0x1B | MIDI_ERROR_FLASH_WRITE_FAILED | flash write failed |

Notable for our use: 0x05 INVALID_FXID supersedes a previously
mis-labeled "NACK" entry. 0x06 INVALID_PARAMID is the code we will
likely see if `axefx3_set_param` decode is wrong about a parameter
ID. 0x0C DSP_OVERLOAD is the same code that surfaces in AxeEdit III
when the user adds a block that exceeds the DSP budget.

## Effect IDs in v1.4 Appendix 1 that are NOT 3rd-party addressable

The Appendix 1 effect-ID table enumerates internal blocks too. Per
community confirmation in thread #140602 (2019), the following IDs
are in the list but **not controllable** via the 3rd-party MIDI
surface (0x0A bypass / 0x0B channel / 0x13 status dump):

- `ID_CONTROL` (2) — internal "control switch", FC-controlled
- `ID_MIDIBLOCK` (190) — internal-only
- `ID_FOOTCONTROLLER` (199) — FC interface only
- `ID_PRESET_FC` (200) — internal

**Status: shipped (Session 80).** `packages/axe-fx-iii/src/blockTypes.ts`
now marks these four entries `addressable: false`, and
`resolveEffectId` refuses them with a clean message naming the four
non-addressable IDs. `axefx3_list_blocks` surfaces the addressable
column so the agent can see the FC-only blocks before attempting a
write. Goldens in `scripts/verify-axe-fx-iii-encoding.ts` cover all
four refusal cases.

## Function bytes confirmed in the AxeEdit III binary (Session 82)

Ghidra mining (`MineAxeEditIIIv2.java` + `TraceAxeEditIIIMessageBuilders.java`,
both runnable via `scripts/ghidra/run-axeedit3-*.cmd`) identified
AxeEdit III's generic SysEx message-builder function (`FUN_1403437d0`
at v1.14.31) which takes the function byte as a runtime parameter.
Walking its 41 callers reveals **every fn byte AxeEdit III emits**.
The Fractal model byte is loaded from a device-handle struct field
at runtime (`param_1 + 0x30`), so `F0 00 01 74 10` doesn't appear as
a literal byte sequence in `.text` — explaining why v1 byte-pattern
scans returned 0 hits.

| fn byte | v1.4 documented? | Likely role |
|---|---|---|
| 0x0A | ✅ | SET/GET BYPASS |
| 0x0B | ✅ | SET/GET CHANNEL |
| 0x0C | ✅ | SET/GET SCENE |
| 0x0D | ✅ | QUERY PATCH NAME |
| 0x0E | ✅ | QUERY SCENE NAME |
| 0x0F | ✅ | SET/GET LOOPER STATE |
| 0x10 | ✅ | TEMPO TAP |
| 0x11 | ✅ | TUNER ON/OFF |
| 0x12 | ❌ | Undocumented (seen 2× in caller scan; payload `local_res10, 1, model-from-struct`) |
| 0x13 | ✅ | STATUS DUMP |
| 0x14 | ✅ | SET/GET TEMPO |
| 0x19 | ❌ | Undocumented (3-byte payload, FOOTSWITCH_*?) |
| 0x1a | ❌ | Undocumented (3-byte payload, FOOTSWITCH_*?) |
| 0x1b | ❌ | Undocumented (3-byte payload, FOOTSWITCH_*?) |
| 0x1f | ❌ | Caller `FUN_140339ed0(longlong*, ushort*)` packs a 16-bit value into 7-bit septets before calling. **Smaller payload than full SET_PARAM would need** (SET_PARAM needs effectId+paramId+value ~60 bits / 9 septets). Likely a 14-bit-payload-only SysEx — candidates: per-effect bypass, channel set, or status query. Re-classified from "high suspicion SET_PARAM" after Session 83 caller-decompile inspection. |
| 0x3f | ❌ | Caller `FUN_140336dd0(longlong, ushort*)` — same shape as 0x1f (16-bit input + septet pack). Likely paired with 0x40 as a 14-bit-value SysEx pair. |
| 0x40 | ❌ | Caller `FUN_140337060` — similar shape to 0x3f. |
| 0x46 | ❌ | Undocumented (paired with 0x47) |
| 0x47 | ❌ | Undocumented (paramless — like TEMPO TAP shape) |
| 0x5a | ❌ | Undocumented (scene-related? `+ 0x20 + 'Z'` arithmetic in caller) |
| 0x5b | ❌ | Undocumented |
| 0x5c | ❌ | Undocumented |
| 0x74 | ❌ | Preset-adjacent (caller chain near 0x77/0x78/0x79) |
| 0x75 | ❌ | Preset-adjacent |
| 0x76 | ❌ | Preset-adjacent |
| 0x77 | ❌ | PRESET-SAVE HEADER (community-RE; hardcoded in `FUN_14014d2a0`) |
| 0x78 | ❌ | PRESET-SAVE BODY (community-RE) |
| 0x79 | ❌ | PRESET-SAVE FOOTER (community-RE) |
| 0x7a | ❌ | Undocumented (preset-LOAD request?) |
| 0x7b | ❌ | Undocumented |
| 0x7c | ❌ | Undocumented |

That's **21 undocumented function bytes** confirmed in AxeEdit III's
code (v1.14.31), against 10 documented in v1.4. Each one is a real
SysEx opcode AxeEdit III sends to the device — payload structure
still needs USBPcap or further decompile analysis per caller.

### What the III's SET_PARAM (still) isn't

Session 83 inspected the callers of the candidate fn bytes (0x1f,
0x3f, 0x40) and found **none of them carry a SET_PARAM-shaped
payload**. Each caller packs a single 16-bit value (a `ushort`)
into septets before invoking the generic builder; SET_PARAM would
need at minimum a `(effectId, paramId, value)` triple (~60 bits =
9 septets after 14-bit splits + 32-bit float). The 16-bit-only
payload suggests these are configuration / bypass / channel-set
messages rather than per-knob parameter writes.

Three hypotheses for where III SET_PARAM actually lives:

1. **A fn byte we haven't seen invoked by AxeEdit III at runtime.**
   The Trace dump captures call SITES; if SET_PARAM is on a code
   path the editor doesn't hit during normal startup-and-poll, we
   wouldn't see it. (AxeEdit III may primarily use the existing
   STATUS DUMP `0x13` for read-back and emit fewer per-knob writes
   than AM4-Edit does.)
2. **A different protocol layer.** AxeEdit III communicates with
   the device over both SysEx AND a separate proprietary USB-bulk
   channel; per-knob writes might use the bulk channel, not SysEx.
3. **A different message-builder function.** `FUN_1403437d0` is
   one of two generic builders we identified; the other is
   `FUN_1403434b0` (only 4 callers). And there are hardcoded
   builders for specific fn bytes (`FUN_14014d2a0` for 0x77).
   SET_PARAM might be wrapped by a dedicated builder we haven't
   found yet.

The cleanest path to actual III SET_PARAM decode remains a USBPcap
capture of AxeEdit III firing a single-knob change — that surfaces
the actual wire bytes, regardless of which builder produced them.

## Effect-type parameter dictionary (Session 82)

Ghidra mining (`DumpAxeEditIIIParamNames.java`, runnable via
`scripts/ghidra/run-axeedit3-paramnames.cmd`) decoded
`FUN_140397a40`'s effect-type dispatcher in AxeEdit III. The
dispatcher is a switch statement with 49 cases (effect-type internal
enum 1..0x3b minus 4/6/0x1b which return -1). Each case returns a
pointer to a per-effect param table: an array of 16-byte structs
`{ int paramId, int padding, const char* nameStr }` terminated by
paramId == -1. The name strings are exactly the same `EFFECT_*` /
`REVERB_*` / `GLOBAL_*` etc. symbols the `__block_layout.xml` UI
config references.

**2216 paramId → paramName pairs extracted across 49 effect types.**
Full JSON: `samples/captured/decoded/ghidra-axeedit3-paramnames.json`
(gitignored; re-generate with the Ghidra script).

| case | family | params | v1.4 ID? |
|---|---|---|---|
| 0x01 | GLOBAL | 248 | — (system-wide) |
| 0x02 | CONTROLLERS | 189 | ID_CONTROL=2 (non-addressable) |
| 0x03 | MOD | 25 | — |
| 0x05 | IRCAPTURE | 4 | ID_IRCAPTURE=36 |
| 0x07 | COMP | 37 | ID_COMP1=46 |
| 0x08 | GEQ | 21 | ID_GRAPHEQ1=50 |
| 0x09 | PEQ | 33 | ID_PARAEQ1=54 |
| 0x0a | DISTORT (Drive) | 143 | ID_DISTORT1=58 |
| 0x0b | CABINET | 126 | ID_CAB1=62 |
| 0x0c | REVERB | 71 | ID_REVERB1=66 |
| 0x0d | DELAY | 89 | ID_DELAY1=70 |
| 0x0e | MULTITAP | 121 | ID_MULTITAP=74 |
| 0x0f | PLEX | 96 | ID_PLEXDELAY=178 |
| 0x10 | CHORUS | 32 | ID_CHORUS1=78 |
| 0x11 | FLANGER | 63 | ID_FLANGER1=82 |
| 0x12 | ROTARY | 21 | ID_ROTARY=86 |
| 0x13 | PHASER | 35 | ID_PHASER1=90 |
| 0x14 | WAH | 25 | ID_WAH=94 |
| 0x15 | FORMANT | 12 | ID_FORMANT=98 |
| 0x16 | TREMOLO | 22 | ID_PAN_TREMOLO=106 |
| 0x17 | PITCH | 114 | ID_PITCH=110 |
| 0x18 | FILTER | 37 | ID_FILTER=114 |
| 0x19 | FUZZ | 44 | ID_FUZZ=118 |
| 0x1a | ENHANCER | 12 | ID_ENHANCER=122 |
| 0x1c | MIXER | 23 | ID_MIXER=126 |
| 0x1d | FDBKSEND | 2 | ID_SEND=182 |
| 0x1e | FDBKRET | 6 | ID_RETURN=186 |
| 0x1f | SYNTH | 42 | ID_SYNTH=130 |
| 0x20 | VOCODER | 67 | ID_VOCODER=134 |
| 0x21 | MEGATAP | 35 | ID_MEGATAPDELAY=138 |
| 0x22 | CROSSOVER | 15 | ID_XOVER=142 |
| 0x23 | GATE | 19 | ID_GATE=146 |
| 0x24 | RINGMOD | 13 | ID_RINGMOD=150 |
| 0x25 | MULTICOMP | 37 | ID_MULTIBANDCOMP=154 |
| 0x26 | TENTAP | 49 | ID_TENTAPDELAY=158 |
| 0x27 | RESONATOR | 40 | ID_RESONATOR=162 |
| 0x28 | VOLUME | 15 | ID_VOLUME=102 |
| 0x29 | INPUT | 10 | ID_INPUT1=37 (case 0x29-0x2d share table) |
| 0x2e | OUTPUT | 26 | ID_OUTPUT1=42 (case 0x2e-0x31 share table) |
| 0x32 | LOOPER | 24 | ID_LOOPER=166 |
| 0x33 | TONEMATCH | 27 | ID_TONEMATCH=170 |
| 0x34 | RTA | 6 | ID_RTA=174 |
| 0x35 | MIDIBLOCK | 13 | ID_MIDIBLOCK=190 (non-addressable) |
| 0x36 | MULTIPLEXER | 7 | ID_MULTIPLEXER=191 |
| 0x37 | IRPLAYER | 26 | ID_IRPLAYER=195 |
| 0x38 | FC | 29 | ID_FOOTCONTROLLER=199 (non-addressable) |
| 0x39 | PRESET | 51 | ID_PRESET_FC=200 (non-addressable) |
| 0x3a | (empty) | 0 | — likely placeholder |
| 0x3b | DYNDIST | 14 | post-v1.4 (Dynamic Distortion) |

**Notably absent: the AMP block.** Cases 0x04, 0x06, 0x1b in the
dispatcher return -1 (no param table). AMP almost certainly uses a
separate parameter-resolver path; finding it is a Session 83+ task.

Family → first paramId for each effect is the canonical paramId for
that block's "type" knob (REVERB → paramId 0 = REVERB_TYPE; DELAY →
paramId 0 = DELAY_TYPE; ...). This is enough to start drafting
`packages/axe-fx-iii/src/params.ts` per-effect descriptors — the
remaining gap is the III's SET_PARAM wire envelope (which fn byte
sends a `{effectId, paramId, value}` triple).

## Function names confirmed in AxeEdit III binary

`Axe-Edit III.exe` v1.14.31 contains 23 ASCII strings starting with
`SYSEX_` in a contiguous-ish .rdata block at offset 0x5aaf80–0x5ab2b0.
Mining recipe in `scripts/_research/mine-axeedit3-sysex-table.ts`.
This pool confirms which SysEx-function symbols exist in AxeEdit
III's source code, but the offset-ordering does NOT encode the
function byte (verified Session 82 — see
[`axefx3-fn01-decode.md`](axefx3-fn01-decode.md) "Mined Session 82"
section for the negative result + scan that ruled out a parallel
u8/u16/u32 function-byte array).

**Documented in v1.4 PDF (function bytes known):**

- `SYSEX_SETGET_BYPASS` (0x0A), `SYSEX_SETGET_CHANNEL` (0x0B),
  `SYSEX_SETGET_SCENE` (0x0C), `SYSEX_GET_PATCHNAME` (0x0D),
  `SYSEX_GET_SCENENAME` (0x0E), `SYSEX_SETGET_LOOPER` (0x0F),
  `SYSEX_PATCH_STATUS` (0x13), `SYSEX_SETGET_TEMPO` (0x14)

**Confirmed to exist in AxeEdit III source — function bytes
unknown.** None of these are in the v1.4 PDF. Function-byte
assignment for these requires Ghidra against `Axe-Edit III.exe`
(none done yet), USBPcap of AxeEdit firing each, or community
sources that name the function byte:

| Symbol | Likely purpose |
|---|---|
| `SYSEX_DSP_MESSAGE` | DSP-usage / CPU-load query (Session 78 wanted this for `get_dsp_usage` MCP tool) |
| `SYSEX_EFFECT_DUMP` | Full-effect-state dump for one block |
| `SYSEX_GUI_CONTROL` | AxeEdit↔device UI-state coordination |
| `SYSEX_FS_MESSAGE` | Footswitch event message |
| `SYSEX_FS_PASSTHRU_MESSAGE` | Footswitch passthrough (FC↔III) |
| `SYSEX_FOOTSWITCH_START` | Footswitch-config session start |
| `SYSEX_FOOTSWITCH_DATA` | Footswitch-config payload chunk |
| `SYSEX_FOOTSWITCH_END` | Footswitch-config session end |
| `SYSEX_FOOTSWITCH_DUMP` | Read all footswitch config |
| `SYSEX_SYSTEM_DUMP` | Read global/system settings |
| `SYSEX_A3_TUNER` | Tuner data push (different from documented 0x11 SET-tuner) |
| `SYSEX_A3_TEMPO` | Tempo down-beat push (different from documented 0x14 SET-tempo) |
| `SYSEX_A3_SYSTEM_DATA_START` | System-data multi-frame envelope start |
| `SYSEX_A3_SYSTEM_DATA` | System-data payload |
| `SYSEX_A3_SYSTEM_DATA_END` | System-data envelope end |

The `A3_*` prefix is plausibly "Axe-Fx III gen-3" naming for push-
direction or A3-spec-revision messages — distinct from the
SET/GET request-direction functions.

## BPM table reference

Forum thread "All Axe Fx III BPM Tempo SysEx 1-200bpm" published
the full 1-200 BPM mapping for function 0x14. Pattern confirms our
`buildSetTempo` builder:

| BPM | Wire |
|---|---|
| 1 | `F0 00 01 74 10 14 01 00 00 F7` |
| 2 | `F0 00 01 74 10 14 02 00 03 F7` |
| 120 | `F0 00 01 74 10 14 78 00 79 F7` (matches our golden) |

For BPM > 127, the septet-pair encoding splits into the second byte
(spec: `dd dd` LS-first). Full 200-BPM dataset available in
`docs/_private/` corpus.

## Operations we CAN ship now from the spec alone

Given the function-byte map + Appendix 1 effect IDs:

- ✅ `axefx3_set_bypass(block_name, bypassed)` — 0x0A + known effect ID
- ✅ `axefx3_set_channel(block_name, channel)` — 0x0B + known effect ID
- ✅ `axefx3_get_preset_name_and_number()` — 0x0D `7F 7F` returns both
- ✅ `axefx3_get_preset_name_at(preset_number)` — 0x0D N N returns preset N's name
- ✅ `axefx3_switch_scene(scene)` — 0x0C set (correct already)
- ✅ `axefx3_get_active_scene()` — 0x0C query (correct already)
- ✅ `axefx3_get_scene_name(scene | 'current')` — 0x0E (correct already)
- ✅ `axefx3_tempo_tap()` — 0x10
- ✅ `axefx3_tuner(on)` — 0x11
- ✅ `axefx3_set_tempo(bpm)` / `axefx3_get_tempo()` — 0x14
- ✅ `axefx3_set_looper(action)` / `axefx3_get_looper_state()` — 0x0F (the REAL 0x0F)
- ✅ `axefx3_status_dump()` — 0x13 (correct already, parser too)
- ❌ `axefx3_switch_preset` — NOT possible via SysEx; use MIDI PC instead. Tool should be removed or relabeled `send_preset_change_pc`.
- ❌ `axefx3_set_param` — opcode is `0x02` family-inference only; param-IDs are not documented anywhere.
- ❌ `axefx3_save_preset` — multi-frame envelope (0x77/0x78/0x79); needs community capture or test against hardware.

## Cross-references

- **Project README and CLAUDE.md** — point at `docs/REFERENCES.md` for any "where do I find X" question. The III spec is row 30 there.
- **III package source** — `packages/axe-fx-iii/src/setParam.ts` carries an inline pointer to this doc at the top of the file (after edits land).
- **Community beta-testing workflow** — [`docs/AXEFX3-BETA-TESTING.md`](../../AXEFX3-BETA-TESTING.md). III owners run a small list of tool calls and report whether the front panel matches the response.
- **Design notes** (some predate the bug discovery here) — [`design-notes.md`](design-notes.md).
- **Forum reverse-engineering** of preset save format — Fractal Forum thread #159885 ("Axe-Fx III and deconstructing / parsing a .syx / sysex preset file"). Three-function envelope: `0x77` (header, contains destination), 16× `0x78` (body chunks), `0x79` (footer).
