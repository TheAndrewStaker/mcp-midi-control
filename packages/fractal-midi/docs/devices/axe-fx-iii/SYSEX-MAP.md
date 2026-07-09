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

- `F0`, SysEx start
- `00 01 74`, Fractal manufacturer prefix
- `10`, Axe-Fx III model byte (FM3=0x11, FM9=0x12, VP4=0x14, AM4=0x15)
- `cc`, function / command opcode
- `dd ...`, variable payload
- `cs`, XOR of every byte from `F0` through last payload byte, AND `0x7F`
- `F7`, SysEx end

Checksum implementation: `src/shared/checksum.ts`.

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
Notably absent, operations that exist in other Fractal devices but
are NOT in the III's third-party spec:

- **No *documented* `SET_PRESET_NUMBER` / `SWITCH_PRESET` function.** The
  documented remote-preset-switch path is standard MIDI Program Change +
  Bank Select (PC), not SysEx, and that is what the codec's default
  `switch_preset` (`buildSwitchPresetPC`) emits on the III and FM9. **But the
  gen-3 editor DOES switch presets over SysEx via an undocumented
  `fn=0x01 sub=0x27`** (preset# = 14-bit LE septet int at value pos 12;
  blockId/paramId zero). FM3-Edit capture, live-confirmed TWICE on FM3 fw
  12.00 hardware (BoodieTraps 2026-06-10: a server-issued frame moved the
  unit 475→100; 2026-06-12 field test: used as the working restore after the
  PC path failed). Exposed as `buildSwitchPresetSysEx`; **on the FM3 it IS
  the default switch_preset path** (`switch_preset_via: 'sysex'`), because
  the PC path is hardware-FALSIFIED there: **FM3 fw 12.00 IGNORES CC32 Bank
  Select with the v1.4 'standard' encoding**: a PC switch to preset 438
  (CC0=0, CC32=3, PC=54) landed on preset 54 = 438 mod 128 (2026-06-12 field
  test). The FM3 reads the bank from CC0 like the FM9 ('msb' mode), so the
  spec's "Axe-Fx III / FM3 standard encoding" claim is wrong for the FM3.
  PC + 'msb' on FM3 is untested (sub=0x27 made it moot).
  Note the pos-12 value is a PLAIN int here, int-or-float by sub-action
  (float32 for 0x09/0x52 SET), and LITTLE-endian, unlike the BIG-endian
  preset# in the `fn=0x03` dump request.
  **Do NOT use `fn=0x3C`** ("AxeFxControl / wiki set-preset"): it HARD-NACKs
  on FM3 (reply `fn=0x64` multipurpose, result `0x05`, the same
  received-but-rejected signature as the legacy `fn=0x02` mistake).
- **No `SET_PARAMETER_VALUE` function.** Per-block parameter writes
  are not exposed in the spec. The Axe-Fx II spec exposes `0x02
  SET_PARAMETER_VALUE`; the III deliberately omits it.
- **No spec-published `STORE_PRESET` / `SAVE_PRESET` function**, but the
  editor's own store op is decoded: **`fn=0x01 sub=0x26`** persists the
  working buffer to a preset location (destination presetNum septet @ 12-13,
  LSB-first). Captured byte-exact from III-Edit (0x10) and FM9-Edit (0x12)
  over loopMIDI; this is what the codec's `save_preset` now emits. See the
  editor-WRITE surface table below and cookbook `gen3-fn01-store-preset`.
  Distinct from the preset-binary **dump** formats, of which there are two
  (both read-confirmed on FM9, see the preset-dump RECEIVE section below):
  a **stored-preset** dump (`fn=0x03 [preset# BE]` → `0x77/0x78/0x79`) and an
  **edit-buffer** dump (`fn=0x43` no-args → `0x51/0x52`) of the currently-loaded
  preset. The unified `export_preset` (byte-exact backup of the *active* buffer)
  is wired to the edit-buffer dump (the gen-3 `reader.dumpActivePresetBinary`
  sends `fn=0x43` and collects the `0x51/0x52` run with a read-until-quiet
  terminator); exporting a *stored* location would use the `fn=0x03` path (not
  yet wired). The edit-buffer request is FM9-confirmed; III/FM3/VP4 share the
  gen-3 codec but are community-beta for this path. Full research log in
  [`preset-format-research.md`](preset-format-research.md). Forum thread
  #159885 is archived locally at `founder-private notes`.
- **No `FRONT_PANEL_CHANGE` push (0x21).** Our earlier design notes
  reference `0x21` as the III's dirty-state signal, it is NOT in
  v1.4. Source for that claim is unidentified; treat as unverified.
- **No `SET_GRID_CELL` / `SET_CELL_ROUTING`.** Grid topology authoring
  is not exposed.
- **No `SET_PRESET_NAME` / `SET_SCENE_NAME`.** Names are query-only
  via 0x0D / 0x0E.

## Effect IDs, Appendix 1 (from v1.4 PDF)

The PDF DOES enumerate effect IDs for the third-party MIDI surface.
These are the 14-bit values that go in `id id` payload slots for
functions `0x0A` SET_BYPASS, `0x0B` SET_CHANNEL, and `0x13`
STATUS_DUMP responses. **Earlier project docs claimed these IDs were
undocumented, that claim is wrong.**

Ranges below are derived from the C-enum auto-increment style the
PDF uses (each entry without an `= N` continues from the previous
explicit assignment).

| Block | Instance count | Effect IDs (1..N) |
|---|---|---|
| `ID_CONTROL` | 1 | 2 |
| (IDs 3-34 reserved / not enumerated in v1.4, see "Anomalies" below) | | |
| `ID_TUNER` | 1 | 35 |
| `ID_IRCAPTURE` | 1 | 36 |
| `ID_INPUT1..5` | 5 | 37, 38, 39, 40, 41 |
| `ID_OUTPUT1..4` | 4 | 42, 43, 44, 45 |
| `ID_COMP1..4` (Compressor) | 4 | 46, 47, 48, 49 |
| `ID_GRAPHEQ1..4` | 4 | 50, 51, 52, 53 |
| `ID_PARAEQ1..4` | 4 | 54, 55, 56, 57 |
| `ID_DISTORT1..4` (Amp) | 4 | 58, 59, 60, 61 |
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
| `ID_FUZZ1..4` (user-facing Drive pedal) | 4 | 118, 119, 120, 121 |
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

1. **There is no separate `ID_AMP` because `ID_DISTORT1..4` (58..61) IS
   the AMP block.** The enum auto-increments with no `ID_AMP`, `ID_DRIVE`,
   or `ID_NAM`, and the amp tone-stack + power section lives at effect IDs
   58..61. Confirmed: (a) the FM9 gen-3 broadcast head reports blockId 58
   with itemCount 588 = (146+1)*4, matching the DISTORT family's max wire
   paramId; (b) AxeEdit III `__amp_layout.xml model='16'` binds the block
   literally named "Amp" entirely onto the DISTORT_* params. AMP
   bypass/channel control is therefore addressable at 58..61.

2. **Recent blocks are absent.** Spec is v1.4 / firmware 1.13 era
   (~2018). Current firmware is 32.03 (March 2026). Blocks added in
   later firmware are NOT in this table:
   - **Dynamic Distortion** (firmware 20.00 / 2022): no ID
   - **NAM** (asset present in AxeEdit III but no release-note mention): no ID
   - **Newer Multiplexer instances** beyond 4 (if any): unknown
   - Their IDs are presumably ≥ 201, but we don't know which.

3. **`ID_FUZZ1..4` (118..121) is the user-facing Drive / OD / Fuzz
   pedal block**, a distinct placeable block from the amp. FM9
   hardware-confirmed: the broadcast head's itemCount 172 = (42+1)*4
   matches the FUZZ family's max wire paramId. This is the pedal the
   editor labels "Drive"; it carries drive/tone/level/mix, not a tone
   stack.

4. **`ID_DISTORT1..4` (58..61) is the AMP block, not a drive pedal.**
   The DISTORT family carries the amp tone stack (gain/bass/mid/treble/
   master/presence/level) and the amp MODEL selector (DISTORT_TYPE).
   `ID_DISTORT` is Fractal's firmware-internal name for the amp.

## Bugs found 2026-05-15, RESOLVED

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
| 3 | `buildSwitchPreset(N)` sends bytes the III interprets as "give me the name of preset N", not "switch to preset N." There is NO SysEx switch_preset on the III, use MIDI PC. | `setParam.ts:102-119` | No SET_PRESET in spec. |
| 4 | `buildSwitchPreset('query')` uses a single `7F` sentinel; spec calls for `7F 7F` (two-byte LS-first) per 0x0D's payload shape. | `setParam.ts:107` | "let dd dd = 7F 7F", TWO 7F bytes for the current-preset query. |
| 5 | `axefx3_switch_preset` tool doesn't switch presets. It queries a preset name and returns nothing useful. | `tools/navigation.ts` | Use MIDI Program Change (PC) for III preset switching. |
| 6 | `axefx3_get_preset_name` uses 0x0F (LOOPER): sends a looper-button command, not a name query. | `tools/navigation.ts` get_preset_name handler | Use 0x0D with `dd dd = 7F 7F` for current preset name. |
| 7 | `axefx3_get_active_preset_number` and `get_preset_name` ought to be one tool: 0x0D query returns BOTH the preset number AND its name. | both navigation.ts handlers | One 0x0D query gives `nn nn` (preset number) + `dd*32` (name). |
| 8 | `FN_SET_PARAMETER_VALUE = 0x02` is declared as a constant, but `0x02` is NOT in the v1.4 PDF. This is family inference from Axe-Fx II. | `setParam.ts:51` | The III's parameter-write opcode is NOT documented anywhere public. Family inference is the only path. |
| 9 | `FN_FRONT_PANEL_CHANGE = 0x21` is referenced in design notes as the III dirty signal. Not in v1.4 PDF. Source unidentified. | `setParam.ts:59`, [`design-notes.md`](design-notes.md) | Treat as unverified. The PDF documents only `0x10` (tempo down-beat) and `0x11` (tuner) as push frames. |
| 10 | Block roster (`blockTypes.ts`) ships every block with `id: null` claiming "effectId pending capture." Effect IDs ARE in the spec Appendix 1, only AMP and post-firmware-1.13 blocks are unspecified. | `blockTypes.ts` | Populate `id:` from Appendix 1. Leave NAM, Dynamic Distortion as `null`. (SUPERSEDED for AMP: AMP = `ID_DISTORT1..4` = 58..61, see Anomalies 1 + 4 above; only NAM / Dynamic Distortion stay `null`.) |

## 0x01 PARAMETER_SETGET, byte-verified from public captures 🟢 SET / 🟡 GET

> **CORRECTED 2026-06-08 (FM3 fw 12.00 lldb, BoodieTraps + our FM9 re-decode).** The SET
> value field is a **5-septet LE float32 at bytes 12-16** for BOTH sub-actions; there is
> NO separate "raw enum id" space. A DISCRETE type/model select (`sub 09 00`) carries
> `float32(read-ordinal)`; a CONTINUOUS knob (`sub 52 00`) carries `float32(normalized 0..1)`.
> The earlier "raw enum id 524, a different space from the dump ordinal 16" reading was a
> MISREAD: float32(16.0) = septets `[00,00,00,0c,04]`, whose nonzero high septets land at
> bytes 15-16 where a 3-septet `packValue16` would sit, so `pv16` read 524, coincidental
> alignment that only holds when the ordinal's low three septets are zero (e.g. powers of
> two). It is LOSSY: ordinals 16,17,18,19 all read 524 at pos 15. Our own FM9 reverb
> capture's SET frame decodes to `float32 16.0` at pos 12 (Medium Spring = ordinal 16), and
> the device's 60-byte echo returns `16/78 = 0.20512819` (index/(count-1)): the device
> received ordinal 16. **So the read-roster ordinal IS the set value; set-by-name resolves
> name → ordinal off the rosters we already ship, AMPS INCLUDED, no capture.** Builders:
> `buildSetParameter` (discrete, `float32(ordinal)`), `buildSetParameterContinuous`
> (`52 00`, `float32(normalized)`); a bare `52 00` stream commits with no `56 00` begin-
> gesture. Parsers: `decode5SeptetFloat32`, `parseSetGetParameterResponse` (reads pos 12),
> `parseGen3SetValueEcho`. Byte-exact vs the FM3 amp/reverb + FM9 oracle frames.

**Status (2026-05-18, PIVOT).** The III's parameter-write
opcode is **`fn=0x01`** with a 2-byte sub-action discriminator, NOT
`fn=0x02` as the earlier II-derived port assumed. The pivot
was triggered by an open-web research sweep that surfaced 6 byte-exact
public captures (a Mountain Utilities forum thread,
2019-03-13) of AxeEdit III writing Delay 1 TIME. Combined with the 4
FC-12 captures previously documented in [`fn01-decode.md`](
fn01-decode.md), the corpus is now **10 captures from 2
independent community sources spanning 2 effect blocks and 2 sub-action
codes**: all on `fn=0x01`, **zero on `fn=0x02`**. The original
"port from II" was a reasonable hypothesis but contradicted every
captured III parameter-write on the open web.

**SET** wire shape is byte-verified; the encoder + parser in
`src/gen3/axe-fx-iii/setParam.ts` ship with 4 byte-exact encoder
goldens + 4 capture-parse goldens in
`scripts/verify-axe-fx-iii-encoding.ts`. Full capture corpus +
field-layout table: [`set-parameter-captures.md`](
set-parameter-captures.md).

**GET** wire shape is still 🟡 hypothesis, and  research
clarified the response side is more subtle than initially framed.
Forum thread #203336 (j20056 + GlennO, April 2024) revealed that the
`04 01` STATE_BROADCAST sub-action is an **AxeEdit-driven heartbeat
poll**, NOT a device-initiated push-on-edit event. j20056 confirmed:
*"as soon as I quit Axe-Edit, then all MIDI traffic stops."* This
means a bare III (no editor running) will likely produce NO inbound
`04 01` frames at all, so the MCP `axefx3_get_parameter` tool's
250 ms timeout is the expected outcome on bare hardware, not a tool
error. Callers should fall back to 0x13 STATUS_DUMP (bypass+channel
only) for state queries, or hold the value optimistically after SET
and only re-read when explicit user request demands it.

Same passive-sniff capture also revealed an uncatalogued sub-action
`2E 00` (~245-byte device-emitted frame, likely preset/scene state
dump): decode is unblocked, no hardware needed. See
[`axefx3-fn01-decode.md`](axefx3-fn01-decode.md) §"Sub-action `2E 00`".

### Evidence chain (10 captures, 2 sources)

**Source A, FC-12 footswitch (4 captures,  era).** Drive 1/2
boost ON/OFF, sub-action `52 00` (mouse-drag form, emitted by the FC-12
for binary toggles). Effect IDs 58/59 = `ID_DISTORT1` / `ID_DISTORT2`
per v1.4 Appendix 1. Originally decoded into the field-layout table in
[`axefx3-fn01-decode.md`](axefx3-fn01-decode.md).

**Source B, Mountain Utilities forum (6 captures,
2019-03-13).** AxeEdit III writing Delay 1 TIME. Effect ID 70 =
`ID_DELAY1`, paramId 2. Four frames sub-action `52 00` (mouse-drag,
intermediate values mid-drag) + two frames sub-action `09 00`
(typed-input, final value). Discovered via open-web
research; bytes documented in [`axefx3-set-parameter-captures.md`](
axefx3-set-parameter-captures.md).

Each capture validates against the standard Fractal XOR-7bit checksum
algorithm. Field positions are consistent across both sources and both
sub-actions.

### Wire shape (23 bytes, sub-action 09 00 typed-input, what we ship)

```
F0 00 01 74 10 01
  [sub_lo sub_hi]    sub-action: 09 00 = typed-input SET (clean envelope)
                                  52 00 = mouse-drag SET (drag context at pos 12-14)
                                  04 01 = STATE_BROADCAST (device→host, unsolicited)
  [id_lo id_hi]      14-bit effect ID per v1.4 Appendix 1 (LS-first)
  [pid_lo pid_hi]    14-bit paramId (LS-first), see Ghidra catalog
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
14-bit. Display ↔ wire conversion is the caller's responsibility, the
III publishes no per-param display calibration. For paramId → symbolic
name lookup, use the Ghidra catalog at
`samples/captured/decoded/ghidra-axeedit3-paramnames.json` (49 effect
families, 2216 paramIds, mined ).

### Builder + parser surface

`src/gen3/axe-fx-iii/setParam.ts` ships:

- `buildSetParameter(effectId, paramId, value)`, emits the 23-byte
  typed-input SET (sub-action `09 00`). 🟢 verified.
- `buildGetParameter(effectId, paramId)`, same envelope with value
  zeroed, hypothesis-only.
- `buildSetParameterBypass(effectId, bypassed)`, paramId 255
  convenience; the v1.4 PDF's `0x0A SET_BYPASS` is preferred for
  production bypass writes.
- `parseSetGetParameterResponse(bytes)`, accepts inbound fn=0x01
  frames; disambiguates by sub-action. STATE_BROADCAST `04 01`
  returns `paramId=0` (the broadcast doesn't carry paramId; caller
  tracks last-SET to attribute the value).

MCP tools `axefx3_set_parameter` + `axefx3_get_parameter` wrap these
and bracket every SET with a 250 ms `0x64 MULTIPURPOSE_RESPONSE`
listener. Rejections (e.g. `MIDI_ERROR_INVALID_FXID`,
`MIDI_ERROR_INVALID_PARAMID`) are surfaced inline in the tool reply, not silent failure.

### Why the previous fn=0x02 port was wrong

The earlier port shipped `FN_SET_PARAMETER = 0x02` as a II-to-III model-byte
swap based on:

1. **AxeEdit III binary** (Ghidra): opcode `0x02` appears
   in the message-builder caller list, so III firmware has code paths
   reachable via that opcode.
2. **Axe-Fx II community evidence**: prs22 (forum thread #49417),
   fret (#99763), Chris Hurley (#140602) all documented `fn=0x02`
   working on II Mark I/II/XL+.
3. **simonp54 (#140602)**: "No longer officially possible... the
   only 'supported' features are in the third party spec." Read as
   "fn=0x02 was removed from public docs but firmware still honors
   it on II."

The reasoning was internally consistent but didn't survive an earlier
broader open-web sweep. **Every captured III parameter-write uses
`fn=0x01`**, not `fn=0x02`. The Ghidra binding `0x02 ∈ message-builder
caller list` is still consistent with the pivot; `fn=0x02` may exist
in III firmware for some other purpose (legacy II compatibility?
internal diagnostics?), but it is NOT the parameter-write opcode that
AxeEdit III invokes during normal use.

## §0x02 SET_PARAMETER, III byte-shape hypothesis (CLOSED )

**Status:** ❌ CLOSED. The -era hypothesis tree (H1..H5
candidate envelopes for III SET_PARAMETER) is **resolved.** The winner
was a variant of H4 (`fn=0x01`, 23-byte payload): see the new "§0x01
PARAMETER_SETGET" section above for the byte-verified envelope.

The hypothesis tree below is preserved for historical context (showing
how  reasoned about the candidates before the open-web
sweep surfaced the 6 Mountain Utilities captures that disambiguated). H4
was correctly flagged as a candidate with the right `fn=0x01` and the
right Drive 1/2 captures, but ranked MEDIUM-LOW because of incomplete
field-layout decoding. an earlier 6 additional captures (different
block, different paramId, different sub-action `09 00`) locked the
field layout.

**Probe script** `scripts/_research/probe-axefx3-setparam-hypothesis.ts`
was **deleted **: obsolete for SET_PARAMETER now that the
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
in a single session. (Probe script retired ; the captures
resolved the tree without needing the live probe.)

**How to identify the winner.** The probe sends each frame in turn
and listens 250 ms for inbound. A frame that earns an ECHO of its own
`fn` byte (e.g. `F0 00 01 74 10 02 …`) is the winner, the device
parsed it as a real SET_PARAMETER request. A `0x64
MULTIPURPOSE_RESPONSE` carrying the same echoed `fn` is a definitive
NEGATIVE for that envelope (parsed but rejected, the `result_code`
tells us why). Silence is ambiguous; pair with a follow-up `get`
read to disambiguate.

Ranked highest → lowest confidence:

### Hypothesis 1, `fn=0x02`, II byte-shape, LS-first 14-bit fields, SET action

**Confidence: HIGHEST.** This is the currently shipping wire shape
(`src/gen3/axe-fx-iii/setParam.ts:buildSetParameter`, port from II).

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
- Axe-Fx II hardware-verified on Q8.02 XL+ ( + , 2026-05-10).
- AxeEdit III binary contains code paths reachable via opcode `0x02`
  (Ghidra  mining of `FUN_1403437d0` caller list).
- prs22, forum thread #49417 (2012): published the literal II wire
  shape used as the port template.
- Chris Hurley, forum thread #140602 (2018): used the opcode on an
  Axe-Fx II XL+ for amp drive / master control.

**Probe id:** `H1_II_PORT_0x02_LE`.

### Hypothesis 2, `fn=0x02`, II byte-shape, QUERY action (read-only)

**Confidence: HIGH.** Identical envelope to H1 but with action byte
`0x00` (QUERY) instead of `0x01` (SET). The II's GET responds with
an echoed envelope + value (+ optional label string).

**Why probe this separately:** if the III silently ignores SETs but
honors GETs, H2 lights up where H1 doesn't, confirming the wire
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

### Hypothesis 3, `fn=0x02`, MS-first 14-bit fields, LS-first value, SET

**Confidence: MEDIUM.** Swaps the byte ordering of the effectId and
paramId septet pairs from LS-first to MS-first; keeps the value
field LS-first (the 3-septet 16-bit pack doesn't have an "endian"
choice).

**Why this might be right:** Two other Axe-Fx II 14-bit fields turned
out to be MS-first despite wiki claims of LS-first, / 
hardware-verified `buildStorePreset` (0x1D) and
`parseGetPresetNumberResponse` (0x14) both as MS-first. If III's
SET_PARAMETER inherits the same firmware quirk, swapping the two id
pairs to MS-first lands the frame on the right effectId / paramId
instead of silently aliasing to a different (effectId, paramId).

**Wire shape** (16 bytes):
```
F0 00 01 74 10 02 00 42 00 00 00 00 00 01 54 F7
```

**Evidence chain:** II  (`buildSwitchPreset` MS-first verified)
+ II  (`parseGetPresetNumberResponse` MS-first verified). No
direct III evidence, pure cross-family quirk extension.

**Probe id:** `H3_0x02_MS_FIRST_IDS`.

### Hypothesis 4, `fn=0x01`, 16-byte payload (AxeEdit III capture shape)

**Confidence: MEDIUM-LOW.** Public captures of AxeEdit III / FC-12
traffic show real `fn=0x01` SysEx frames with ~16-byte payloads, far
longer than anything in v1.4. The captured Amp 1 Boost on/off pair
(documented above in §"Function 0x01") differs only in the value
region (`7C 03 → 00 00`), so this IS some form of per-block param
write, just under a different fn byte than the II's `0x02`.

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
context bytes, address fragments, etc.). Probe is binary, accepts
or rejects, so semantics don't need to be decoded to evaluate the
hypothesis.

**Probe id:** `H4_fn0x01_LONG_PAYLOAD`.

### Hypothesis 5, `fn=0x12`, II byte-shape payload (Ghidra-mined undocumented opcode)

**Confidence: LOW.** Ghidra  mined AxeEdit III's caller
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

**Wire shape** (16 bytes, same II shape, just under `fn=0x12`):
```
F0 00 01 74 10 12 42 00 00 00 00 00 00 01 44 F7
```

**Evidence chain:** Ghidra  fn-byte inventory in this doc's
"Function bytes confirmed in the AxeEdit III binary" table. No
capture, no community mention, speculative but cheap to probe.

**Probe id:** `H5_fn0x12_II_SHAPE`.

### How to run the probe (RETIRED )

The probe script `scripts/_research/probe-axefx3-setparam-hypothesis.ts`
was deleted  once the H1..H5 tree was resolved by the public
captures. Historical reproduction is via git log if needed:

```bash
git log --diff-filter=D --pretty=oneline -- scripts/_research/probe-axefx3-setparam-hypothesis.ts
```

The probe pattern (send candidate frames, listen 250 ms, classify by
inbound) is general-purpose, re-implement against a new probe-id
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
  response, capture didn't include the response window).

- **Additional set_bypass capture** (forum thread #218547, user
  observing unwanted block muting): `F0 00 01 74 10 0A 25 00 01 3B F7`
, function 0x0A, effect ID `25 00` = 37 (Input 1 per v1.4
  Appendix), dd=1 (bypassed), cs=0x3B. Verifies our effect-ID
  resolution for `Input 1`.

## FM3 hardware field test (fw 12.00, macOS USB-CDC serial, 2026-06-12) 🟢

First hardware run of OUR code against an FM3 (community tester, full
`gen3-readback-probe` + `gen3-verify-probe` session over the serial
transport; report JSONs archived in the consumer repo's capture manifest).
Everything below is FM3 fw 12.00, model byte `0x11`, direct USB:

- **Serial transport leg confirmed end-to-end**: discovery by Fractal VID
  `2466`, open on `/dev/tty.usbmodem*`, raw-MIDI framing survived the whole
  session including broadcast bursts with zero malformed frames. (macOS
  note: serialport lists the `tty.*` node; the transport now prefers the
  `cu.*` callout twin when present.)
- **Universal MIDI identity request** (`F0 7E 7F 06 01 F7`) is answered by a
  **bare Fractal-framed `fn=0x64`** (`F0 00 01 74 11 64 F7`), the
  multipurpose/NACK carrier doing double duty as "I heard you", not a
  standard identity reply.
- **Documented queries all answer**: `0x0D` patch name, `0x0C` scene,
  `0x14` tempo, `0x13` status dump.
- **`fn=0x13` STATUS_DUMP reply decoded** (capture
  `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json`,
  documented_queries): `F0 00 01 74 11 13 25 00 40 2A 00 40 3A 00 40 72 F7`,
  three `id id dd` triples per the v1.4 table: blocks **37 (Input),
  42 (Output), 58 (Amp)**, each `dd=0x40` = engaged (bit 0 = 0), channel A
  (bits 3:1 = 0), **4 channels supported** (bits 6:4 = 4). Only those three
  blocks were placed in the active preset.
- **`fn=0x1F` bulk read confirmed across 35 of 42 block types**, itemCount ==
  valueCount on every one (Reverb 284 = 4×71, Delay 352 = 4×88, matches the
  FM3-true catalog). The 7 others (Tuner, IR Capture, Vocoder, Crossover,
  Tone Match, RTA, IR Player) each reply a SINGLE frame, **not-pollable
  block types**, not framing loss.
- **`fn=0x1F` polls answer for UNPLACED blocks**: the "unplaced block
  answers an `fn=0x64` NACK" model is **falsified on FM3 fw 12.00**: in this
  same session the `fn=0x13` status dump reported only **3 placed blocks**
  (Input/Output/Amp, above) while `fn=0x1F` polls were ANSWERED with full
  bursts for **35/42 block types**. A poll returns the block's working-buffer
  state regardless of placement; use `fn=0x13` for placement truth. Reads can
  therefore silently return unplaced-block state (cf. the AM4 phantom-param
  precedent, where a `set_param` on an unplaced block lands in state no dump
  surfaces). See the corrected fn=0x1F section below and cookbook
  [[gen3-fn1f-poll-block-bulk-read]].
- **Per-block channel count is NOT uniformly 4**: the FM3 itemCount sweep
  contradicts a universal `stride = itemCount / 4`: **Send = 2, Return = 6,
  Ring Mod = 26, Megatap = 70** (none divisible by 4), and **Looper = 24**
  with FM3-catalog max paramId 23 (→ 24×1), **Resonator = 80** with max
  paramId 39 (→ 40×2). Reverb 284 = 71×4 and Delay 352 = 88×4 do fit ×4.
  Corrected rule in the channel-blocked box below.
- **`sub=0x52` continuous float SET lands** (device value-echo + bulk
  read-back both moved).
- **`sub=0x09` float32 carries the param's NATURAL DISPLAY value on a
  continuous param**: float32(45.0) sent at REVERB_LOWCUT read back wire
  11540, which is EXACTLY 45.0 Hz under the log10 20..2000 Hz calibration
  (20×100^(11540/65534)). Single-point but exact; it unifies the discrete
  case (float32(ordinal), an ordinal IS a discrete param's natural value).
  ⚠️ **Catalog contradiction**: that exactness holds ONLY under a log10
  mapping: the shipped FM3/III/FM9 catalog rows for REVERB_LOWCUT are
  currently calibrated **linear** ("inferred from AM4"; linear decode of
  11540 over 20..2000 is ~369 Hz, nowhere near 45). The catalog calibration
  for the Hz-taper family needs a correction pass, consistent with the
  Axe-Fx II's hardware-confirmed log10 `low_cut`/`high_cut`.
- **The `0x75` body word for a DISCRETE param is the plain ordinal**: a
  float SET quantized to step 58 of the 79-entry reverb-type enum echoed
  0.7435896992683411 (`0x3f3e5be5`), one float32 ULP below round-nearest
  float32(58/78) (`0x3f3e5be6`), i.e. **the float32 truncation of 58/78**
  (matches to the last printed digit; some downward rounding happens in
  firmware, mechanism undetermined from one point). It identifies ordinal 58
  of the 79-entry table unambiguously (neighboring fractions are ~0.013
  away), and the bulk read-back word was plain 58. The decode
  (`unpackValue16` triples from byte 8) is byte-perfect.
- **`fn=0x01 sub=0x1f` at a type selector returns the CURRENT type's display
  NAME** (single-point hardware evidence): the probe's drive query
  (eff=118 FUZZ, pid=0 = FM3-true DRIVE TYPE) answered a 41-byte reply whose
  value region septet-decodes to ASCII **"Rat Distortion"**, the preset's
  current drive type. Capture:
  `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json`
  (job3_enumListDump, drive sub=0x1f entry); response
  `F0 00 01 74 11 01 1F 00 76 00 00 00 3A 00 00 00 00 00 00 0F 00 29 18 2E
  42 02 11 52 73 3A 1B 6E 27 23 25 5E 6E 00 00 78 F7`. Decode: the streaming
  MSB-first 8→7 septet regroup ([[iii-byte-stream-septet-pack-8to7]]) from
  byte 5 yields the name at decoded offset 14; the clean re-sync is at
  **wire byte 21** (0-indexed): wire bytes 21–38 decode to exactly
  `52 61 74 20 44 69 73 74 6F 72 74 69 6F 6E 00` ("Rat Distortion" + NUL).
  Bytes 19–20 = `0F 00` = 15 = the decoded byte count (likely a length
  prefix). The session's amp/reverb sub=0x1f probes were mis-addressed at
  the FM9-shaped pid 10, so behavior at the FM3-true amp TYPE pid 6 /
  reverb TYPE pid 0 is unconfirmed. **Implication:** a targeted sub=0x1f
  ordinal sweep is a mechanical path to device-fetched type rosters,
  consistent with the prior "editors fetch model names via sub=0x1f at
  runtime" hypothesis.
- **`set_bypass` (0x0A) accepted** (no 0x64); **`switch_scene` (0x0C)
  round-trip confirmed** (set wire 1, query read 1).
- **PC + Bank Select 'standard' encoding FALSIFIED on FM3** (CC32 ignored;
  see the SWITCH_PRESET bullet near the top). `sub=0x27` confirmed again as
  the restore.
- **paramId reminder, the bug this test caught**: reverb Mix/Type are
  paramIds 0/10 on the FM9 but 13/0 on the FM3 and III (and amp TYPE is
  10/6/0 on FM9/FM3/III). Never hardcode one device's paramIds into a
  cross-family tool; resolve from the device-true catalog.

Still unconfirmed on FM3 after this test: `set_block` placement and
`save_preset` (never auto-tested by design). The probe skipped `set_block`
believing "preset already had a Drive", but its poll-based placement detector
was false-positived by the unplaced-poll behavior above; the `fn=0x13` dump
shows NO Drive placed. For the same reason the session's reverb writes were
against an UNPLACED Reverb block (wire-acked working-buffer state, not an
audible change); the SET/read-back byte evidence stands, but audibility on a
placed block awaits the re-run.

## FM9 hardware verify (fw 11.0, Windows, gen3-verify probe, 2026-06-19) 🟢

A community FM9 owner on **Windows** ran the read + write-verify probes
(`samples/captured/fm9-windows-verify-2026-06-19/`; analysis
`docs/_private/FM9-WINDOWS-VERIFY-ANALYSIS-2026-06-20.md`). This is the FIRST
Windows gen-3 write confirmation; it overturned a transient "Windows writes fail"
hypothesis (writes work; the earlier Claude Desktop failures were an agent-layer
issue, not transport).

- **`set_block` PLACEMENT confirmed**: a Drive placed at r1c14 appeared in the
  device's own `fn=0x13` STATUS_DUMP afterward. (Was the only unconfirmed FM3 op;
  now hardware-confirmed on FM9.) The LIVE write path still has no positive ack,
  so the codec reports it `unconfirmed`, not `acked`.
- **`switch_scene` (0x0C)** set+read-back matched (set wire 1 → query read 1).
- **`fn=0x01 sub=0x1F` current-type-name read confirmed across three blocks**
  (extends the FM3 single-point result above): reverb (eff66/pid10) → "Small Room",
  amp (eff58/pid10) → "59 Bassguy Bright", drive (eff118/pid0) → "Rat Distortion".
  Reply layout: `idx19` = LEN (= nameLen+1), `idx21+` = the 8→7 packed name,
  NUL-terminated. **`sub=0x09` GET on a type param returns the SAME name** with the
  float32 value field zeroed (so "value 0" was a parser misread, since fixed).
  Goldens: `test/gen3/axe-fx-iii/typename.test.ts`.
- **`fn=0x01 sub=0x2E` is ONE layout for both target shapes** (corrected
  2026-07-01): the EMPTY-target query and a BLOCK-TARGETED `sub=0x2E`
  (effectId+paramId in the target slot) both return the same status frame:
  preset name (septet-packed), live meters, and the routing grid in the tail.
  The earlier "block-targeted = preset-name frame, NOT a grid" reading (FM9,
  2026-06-19) was vacuously true: that session's scratch preset had an all-zero
  grid region. Proof: the three block-targeted FM3 replies in
  `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json` (job3)
  carry a grid that exactly matches the same session's `fn=0x13` status dump
  (Input1 37 → Amp1 58 → Output1 42). `parseGen3GridLayout` accepts both shapes.
- **No catalog drift**: all 42 blocks' `fn=0x1F` item counts match the device-true
  FM9 catalog (channels × (maxPid+1)); the 6-channel Multiplexer (42=6×7) prompted
  widening the reader's channel-stride candidates to {6,4,3,2,1}.

Still community-beta on FM9: discrete enum **set**-by-name and `save_preset`
persistence (continuous `set_param` was skipped here: the scratch preset had no
placed block; re-run on a preset WITH a reverb to close it on Windows).

## Undocumented function bytes seen in the wild

The v1.4 PDF documents 0x0A through 0x14 plus 0x13. Several captures
show **function bytes outside that range** being used in real III
traffic. These are likely the "set parameter / set modifier" calls
the public spec deliberately omits.

### Functions 0x74 / 0x75 / 0x76: gen-3 STATE-BROADCAST burst (FM9 hardware-confirmed 🟢)

**Source:** first real gen-3 hardware capture, an **FM9** (model byte `0x12`,
firmware 11.00, FM9-Edit 1.03.19) contributed by a community tester, 2026-06-03.
Byte evidence is golden-tested in `test/axe-fx-iii/setparam.test.ts`. This is the
real device→host edit-broadcast channel; it **supersedes the earlier `0x21`
front-panel-push speculation** below for gen-3 dirty-state detection.

The device emits a four-frame burst whenever a block's working-buffer state
changes (front-panel edit) **and** as the response to an `fn=0x1F` bulk-read
poll. For block 66 (Reverb 1):

```
HEAD  F0 00 01 74 12 74 [blockId:14b] [itemCount:14b] [flag] [cs] F7   (12 B)
        e.g. F0 00 01 74 12 74 42 00 24 02 07 F7  → block 66, itemCount 292
BODY  F0 00 01 74 12 75 [sectionId] [flag] [N × packValue16] [cs] F7   (778 B: 256 params)
        e.g. F0 00 01 74 12 75 00 02 7E 7F 03 ...  → param[0]=65534
TAIL  F0 00 01 74 12 75 24 00 [...] [cs] F7                            (118 B: tail section)
END   F0 00 01 74 12 76 [cs] F7                                        (8 B)
```

- `blockId` / `itemCount` / values are **14-bit septet-LE**; values are the
  3-septet `packValue16` (lo7 / mid7 / top2).
- The body is **positional but CHANNEL-BLOCKED**; see the box below. It is NOT a
  flat paramId-indexed vector. Reverb index 0 = **Mix** on channel A, tracking the
  front-panel knob: `7E 7F 03` = 65534 = **100.00%** ⇒ full-scale ≈ 65534.

> ✅ **The 0x75 body is channel-blocked: `index = channel × stride + paramId`,
> `stride = itemCount / channelCount` (FM9 hardware-confirmed for 4-channel
> blocks, 2026-06-04; 5-refuter validated).**
> The body packs one contiguous copy of every paramId slot per channel
> (channels A–D on a 4-channel block, the per-block channel count the `0x13`
> STATUS_DUMP reports in `dd` bits 6:4).
>
> ⚠️ **`channelCount` is per-block, NOT uniformly 4** (FM3 field test,
> 2026-06-12; capture `samples/captured/fm3-community-2026-06-12/`
> `fm3-probe-output.json` job1_blockReads). FM3 itemCounts that refute a
> universal ÷4: **Send 2, Return 6, Ring Mod 26, Megatap 70** (none divisible
> by 4); and divisible-by-4 counts that still aren't 4-channel against the
> FM3 catalog: **Looper 24** (max paramId 23 → 24×1), **Resonator 80** (max
> paramId 39 → 40×2). **Reverb 284 = 71×4** and **Delay 352 = 88×4** do fit.
> Corrected rule: `stride = itemCount / channelCount` where `channelCount` is
> derived per block, from the `fn=0x13` `dd` bits 6:4, or from
> `itemCount / (catalog max paramId + 1)`. The FM9 examples below are all
> 4-channel blocks, so their ÷4 arithmetic stands (scoped, not falsified).
> A controlled amp-Balance drag (0 → −100; capture
> `fm9-amp-balance-0-to-neg100-*-2026-06-04`, blockId 58 = ID_DISTORT1) changed only
> **index 149 = 1×147 + 2**, channel **B**, `paramId 2` (`DISTORT_PAN`), while the
> channel-A/C/D copies (indices 2, 296, 443) stayed constant. `itemCount` matches
> the channel-blocked shape across **5 distinct blocks** observed in existing FM9
> captures (`itemCount = (max device-true paramId + 1) × 4`, every one divisible
> by 4, all five are 4-channel blocks; per-block `channelCount` varies, see the
> correction box above):
> **DISTORT 588 = 147×4**, **REVERB 292 = 73×4**, **Phaser 140 = 35×4**,
> **Filter 148 = 37×4**, **Drive/Fuzz 172 = 43×4**. The earlier "per-block offset 147 / two
> distinct index spaces" reading was incomplete: 147 is just `1 × stride` because the
> edit happened to be on channel B; it is NOT a permutation and NOT a fixed offset.
> Off-by-one note: the `0x75` body starts at byte 8; offsets 7/9 produce garbage (at
> offset 7 the changed value misreads as "→ index 2", the alignment trap).
>
> **Read path (shipped 2026-06-04, replaces the earlier DISTORT guard):**
> `fractal-gen3/src/reader.ts` projects `values[channel × stride + paramId]`.
> `get_param`/`get_params` honor a channel arg (always correct); with no channel they
> return the value when it is identical across all four channels (the common case)
> and otherwise REFUSE, listing each channel's value, so the caller re-asks with a
> channel rather than getting a silent guess. `get_preset` reads the channel-A copy
> (`paramId < stride`) and warns that per-channel params are reported as channel A.
> The old code's `values[paramId]` was silently "channel A only". The write path
> (`set_param` = `float32(ordinal)`/`float32(normalized)` at pos 12) is unaffected.

  **Continuous-param SET (mouse-drag), FM9-confirmed 2026-06-04:** the same capture
  byte-anchors the continuous-value write (prior FM9 SET confirmation was an enum/type
  change only). 9 OUT frames `F0 00 01 74 12 01 52 00 [eff:14b] [pid:14b] [v0..v4] 00 00 00 [cs] F7`
  (23 B), eff = ID_DISTORT1 (58), pid = 2, value = **5-septet LE float32 normalized
  [0,1]** at bytes 12–16, display = `norm*200 − 100` for Balance (0.5 → balance 0,
  0.0 → −100). The device answers each with a **60-byte IN echo** (`fn=0x01 len=60`,
  value re-quantized ≈ 1/630 at bytes 12–16); the first echo reports the pre-drag
  state. A stray `pid=16301` from a `sub=0x56` non-echo status frame is a known
  artifact to skip (appears once in the reverb capture too).
- Parsers: `parseGen3StateBroadcastHead` / `parseGen3StateBroadcastBody`
  (`src/gen3/axe-fx-iii/setParam.ts`), golden-tested against these bytes. Wired into
  gen-3 dirty-state (`fractal-gen3/src/midi.ts`): inbound `fn=0x74` marks the
  buffer dirty, so front-panel edits now trip the safe-edit gate on FM9/FM3/III.
- **Read-back GET** observed in the same capture: FM9-Edit reads a param via
  `fn=0x01` sub `01 00` (flat 14-bit ordinal @8-9, **no** effectId) → a 115-byte
  param-info response (value + range/type/label). Our codec's GET uses sub `09 00`
  + effectId; the `01 00` ordinal scheme is not yet mapped.

### Function 0x1F: block bulk-read POLL (host to device), our gen-3 read path

The `0x74/0x75/0x76` burst above is also the **reply to a host poll**. The poll is
a 10-byte frame carrying just the block/effect id:

```
POLL  F0 00 01 74 [model] 1F [effectId:14b septet-LE] [cs] F7   (10 B)
        e.g. F0 00 01 74 12 1F 42 00 [cs] F7  → poll Reverb 1 (block 66)
```

The device answers with the `0x74/0x75(×N)/0x76` burst ~1 ms later; there is **no
separate fn=0x1F response body**. This is structurally identical to the Axe-Fx II's
`fn=0x1F` SYSEX_GET_ALL_PARAMS atomic read (same opcode, same triple-frame answer,
same positional body); see cookbook [[am4-fn1f-atomic-read]] and the new
[[gen3-fn1f-poll-block-bulk-read]].

- **This is our gen-3 `get_param` / `get_params` read path** (the fn=0x01 sub=0x09
  per-param GET was never seen on the wire, and sub=0x01 is a descriptor query, not
  a value read). The reader polls the block, collects the burst, and indexes the
  positional `0x75` body by paramId.
- **Paging:** a whole-block dump pages across multiple `0x75` sections (Reverb =
  a 256-value section + a 36-value tail = itemCount 292). Concatenate the sections
  in arrival order; the tail **continues** the paramId sequence (section 0 →
  paramId 0..255, section 1 → 256..291).
- Builder + assembler: `buildBlockBulkReadPoll(effectId)` +
  `assembleGen3BlockBulkRead(frames)` (`src/gen3/axe-fx-iii/setParam.ts`), bound on the
  `ModernFractalCodec` factory and golden-tested in `test/gen3/modern-family/catalog.test.ts`.
  Reader: `fractal-gen3/src/reader.ts` (`collectBlockBulkRead`).
- 🟢 The poll→burst shape is FM9-confirmed, and **our code issuing the poll is
  FM3-hardware-confirmed end-to-end** (2026-06-12 field test: 35/42 block types
  assembled, itemCount == valueCount on every one; see the FM3 field-test section).
  Enum values are labeled via the read-leg overlay (`enum_values`).
  **A poll answers regardless of placement** (corrected 2026-06-12): the FM3
  field test answered polls with full bursts for 35/42 block types while the
  same session's `fn=0x13` status dump reported only 3 placed blocks. The
  earlier "an unplaced block answers a poll with an `fn=0x64`
  MULTIPURPOSE_RESPONSE NACK" claim was an AM4/II analogy never gen-3-observed
  and is **falsified on FM3 fw 12.00**. Use `fn=0x13` for placement truth;
  a bare poll-answered read can silently return UNPLACED-block working-buffer
  state (cf. the AM4 phantom-param precedent). Some block types are **not
  pollable** and answer a single frame regardless (FM3: Tuner, IR Capture,
  Vocoder, Crossover, Tone Match, RTA, IR Player).

### Functions 0x03 / 0x77 / 0x78 / 0x79: preset dump RECEIVE (FM9 hardware-confirmed 🟢, read direction)

A 2026-06-04 FM9 capture (fw 11.00 / FM9-Edit 1.03.19; Fractal-Bot "Receive" of a
run of presets) is the **first hardware confirmation of the device→host preset dump**
and its trigger. The 0x77/0x78/0x79 envelope previously documented below (under the
"PRESET-SAVE" community-RE rows) is confirmed in the **read** direction; the host→device
**write-back** direction is still NOT captured (the editor received, never sent).

```
OUT  F0 00 01 74 [model] 03 [preset#:14b BIG-ENDIAN septet] [cs] F7   (10 B) REQUEST_PRESET_DUMP
IN   F0 00 01 74 [model] 77 [preset#:14b BE] [wordCount:14b LE] [cs] F7  (13 B) DUMP HEAD
IN   F0 00 01 74 [model] 78 [2B chunk-discrim] [3072B septet body] [cs] F7 (3082 B) DUMP BODY ×N
IN   F0 00 01 74 [model] 79 [3B] [cs] F7                              (11 B) DUMP TAIL
```

- The preset number on `fn=0x03`/`fn=0x77` is **big-endian** septet (`(b6<<7)|b7`),
  unlike the little-endian param ids elsewhere. Captured FM9 requests decoded to valid
  indices 49, 129, 197, 273, 274, 355, 443, 444.
- Head word-count field (bytes 8-9, **little-endian** septet) = 8192 = the fixed preset
  word allocation. Reassembled body: word1 = `0xAA55` magic, ASCII name at word4+
  (2 chars/16-bit word), decoded e.g. `"4x12 Plexi DARK AltCab -'25f"`, the EXACT layout
  shipped in `packages/fractal-gen3/src/presetDump.ts` (`parsePresetDump` /
  `extractPresetName`). The codec's prior "structural lower bound, not byte-verified
  against a live device push" caveat is **discharged for the read direction**.
- Checksum: standard Fractal XOR-&0x7F; validated across all captured dump frames.
- **Edit-buffer dump:** `OUT fn=0x43` (no args, byte-exact `F0 00 01 74 [model] 43 [cs]
  F7`) → `IN fn=0x51` head (11B, payload `00 00 04`, a format tag not a count) + `fn=0x52`×N
  body (canonical **3082 B**, same word packing as `0x78`; inner section layout TBD).
  **No tail frame** (unlike the stored dump's `0x79`): the burst is a homogeneous `0x52`
  run that ends when the device goes quiet. Pulls the currently-edited preset; this is the
  active-buffer scope `export_preset` maps to. (Off-canonical body lengths seen in the
  USBPcap capture were drop/coalesce artifacts; production node-midi reads clean per-frame
  SysEx, so a read-until-quiet collector is exact.)
- **User cab / IR dump:** `OUT fn=0x19 [idx:14b][0x10]` → `IN fn=0x7a` head + `fn=0x7b`×~8
  (1290 B) body + `fn=0x7c` tail. Empty slots are all-`0x7F`. Bonus IR-backup capability,
  not yet wired.
- Full decode + evidence is in the maintainer's private session notes.

### Preset envelope spec: byte-identical to the II, footer = XOR-fold (Ghidra-decoded, 2026-06-09)

Mining the Axe-Edit III binary's envelope descriptor tables and its preset
RECEIVE path (`ghidra-axe-edit-iii-dump-descriptors.txt` +
`ghidra-axe-edit-iii-preset-receiver.txt` + `ghidra-axe-edit-iii-store-preset.txt`)
settled three structural questions:

- **The III preset-binary (0x77/0x78/0x79) descriptor tables are byte-identical
  to the II's, record for record** (`(tag, mid, byte_count)` stride-12 tables:
  0x77 head `(0,6,1)+(1,7,1)+(2,8,3)`, 0x78 chunk `(0,6,2)+(1,8,3072)` = 1024
  ushorts x 3 septet bytes, 0x79 footer `(0,6,3)`). The parser selects gen-3 vs
  older-generation tables by the model byte (`>= 0x10` vs `< 0x10`). Note: the
  descriptor dump's OPENING table pair, once mislabeled as the preset envelope,
  is actually the fn=0x75 broadcast-body pair (gen-3 256 ushorts/frame vs gen-2
  64).
- **The 0x79 footer value is a 16-bit XOR-fold of the de-framed body words.**
  The editor's receive path XOR-folds the assembled ushort buffer and rejects
  on mismatch; this matches the footer XOR already shipping in
  `packages/fractal-gen3/src/presetHuffman.ts` (validated across III + FM9
  factory presets). It is a separate layer from the inner raw-patch CRC.
  Cookbook: [[xor-fold-hash]].
- **No editor-side store hash exists.** The store-to-device flow re-emits the
  `.syx` file's 0x77/0x78/0x79 bytes verbatim, patching only the 0x77 header's
  preset-index field; the footer travels through untouched.

The same dispatcher mine also bound two previously unknown **multi-frame dump
families** (decoded from the binary, hardware-unverified): request `fn=0x40`
triggers a `0x67/0x68/0x69` head/body/tail dump (response-only family, no
editor emitter; the strong candidate for the device's param-definition /
library dictionary), and request `fn=0x1a` or `fn=0x40` triggers a
`0x5a/0x5b/0x5c` dump (system-data / footswitch-config candidate; head length
septet-coded at bytes 10-11, 256-unit chunks). One captured connect-and-sync
session would bind their semantics; the harvest script's `--experimental` flag
sends both requests and records the replies.

### Enum value labels DO cross the wire (septet-packed, FM9-confirmed 🟢)

Correcting the earlier "labels are device-resident, never on the wire" conclusion: enum
value names are transmitted **septet-packed**, decodable by the streaming MSB-first 8→7
unpack **starting at byte index 5** (the fn byte): `acc=(acc<<7)|byte; while(bits>=8){
bits-=8; emit (acc>>bits)&0xff}` over `frame[5 .. len-2]`. A one-byte misalignment
(starting at byte 6) yields garbage; that error is why prior full-capture scans reported
"zero labels."

- **WRITE leg = float32(read-ordinal), NO raw-id space (corrected 2026-06-08):** a typed
  SET (`fn=0x01 sub=0x09`, 23B OUT) carries `float32(read-ordinal)` at bytes 12-16; the
  device's 60B IN echo returns that value's name. The earlier "raw enum id" pairs
  (reverb 524/529, drive 523) were `float32(ordinal)` misread at pos 15: 524 = float32(16),
  529 = float32(40) (NOT 45, pos-15 is lossy), 523 = float32(14). Set-by-name uses the
  read ordinal directly; amps select the same way (`float32(ordinal)`), no `sub=0x1a`
  runtime fetch needed.
- **Value LISTS:** `fn=0x01 sub=0x2e` IN dumps a param's full value list as positional
  32-char fields; `sub=0x2a` dumps the cab/IR browser list; `sub=0x1f` the modifier
  sources; `sub=0x01` block instance names.
- **READ-leg {ordinal → name} (device-true, captured + verified):** pairing each
  `sub=0x1a` current-value label with the matching `fn=0x1F`→`0x75` bulk-read ordinal
  (arrival-order concat, `record[paramId]`) recovers FM9-true names. Verified points
  (FM9 fw 11.00): **AMP** (eff=58 pid=10, the gap AM4 cannot fill) ordinal
  264=`SV Bass 1`, 65=`SV Bass 2`, 179=`Texas Star Clean` (names match the tester's
  notes); REVERB (eff=66 pid=10) 1=`Medium Room`, 16=`Medium Spring`, 45=`Music Hall`;
  DRIVE (eff=118 pid=0) 15=`Blues OD`, 36=`Blackglass 7K`; FILTER (eff=114 pid=0)
  6=`Peaking`. The read ordinal IS the SET value (`float32(ordinal)`): "Music Hall" reads
  ordinal 45 and SET-writes `float32(45)`. Partial (only swept values); the full FM9 amp
  roster (amp ordinals are device-specific) still needs a Type-dropdown sweep to NAME the
  unswept ordinals, but set-by-name itself is unblocked for every named type.
- **To harvest full per-type tables:** open each block's *Type dropdown* (forces a sub=0x2e
  list dump per param), or re-mine the editor resources now that the 32-char septet format
  is known. The block-PANEL-open capture only yields current-value + cab-IR lists.
- Full evidence + recovered pairs are in the maintainer's private session notes.

### gen-3 editor-WRITE surface (loopMIDI-decoded, no hardware) 🟢

Driving the Fractal editors (III-Edit / FM9-Edit / FM3-Edit) against a
loopMIDI virtual port and reading their outbound SysEx decoded the gen-3
block-edit ops. All are `fn=0x01` with a sub-action byte at position 6; the
14-bit arg slots are septet pairs (effectId @ 8-9, gridPos/presetNum @ 12-13).

| sub | op | payload | status |
|---|---|---|---|
| `0x32` | block INSERT | effectId @8-9, gridPos @12-13 | matched (0x10/0x11/0x12) |
| `0x30` | cell RESET / CLEAR (also the insert companion) | gridPos @12-13 | matched; semantics Ghidra-anchored (see the 2026-06-09 mine section below) |
| `0x26` | STORE / save-to-location | presetNum @12-13 (LSB-first) | matched |
| `0x35` | routing / connect | 26-byte frame; b21/b22/b23 encode src+dest cell | matched (6-row + 4-row) |
| `0x2E` | live grid READ (status frame; empty OR block target) | request `01 2e 00` + zeros; reply ~755B (FM9) / 590-606B (FM3) with a TAIL-ANCHORED grid bitstream (byte 361 on the canonical lengths) | decoded; FM9-cross-validated + FM3 geometry pinned (read below) |

`gridPos = col*ROWS + row` (0-indexed, column-major). **Grid shapes
(wire + official-spec confirmed): III / FM9 = 6 rows × 14 cols; FM3 = 4
rows × 12 cols.** Shunt elements use the insert op with byte 9 (effectId
high septet) = `0x08`. Full decode + golden: cookbook
`gen3-fn01-grid-set-position-insert`, `gen3-fn01-store-preset`,
`gen3-fn01-grid-routing`; method:
`docs/capture-guides/loopmidi-editor-emulation.md`. The codec's `set_block`
now emits this confirmed `sub=0x32` insert op (was the ported, untested
`fn=0x05`); device-side persistence remains the hardware-verification step.

#### sub=0x35 SET_GRID_ROUTING: full decode

26-byte wire frame (same structure for all gen-3 model bytes):

```
F0 00 01 74 <model> 01 35 00 00 00 00 00 <OP> 00 00 00 00 00 00 02 00 <b21> <b22> <b23> <cs> F7
```

`OP` = `0x01` connect, `0x02` disconnect.

Two formula variants, selected by grid row count:

**6-row grids (III 0x10, FM9 0x12), 26/26 byte-confirmed, FM9-Edit loopMIDI, 2026-06-05:**

```
srcGp    = (srcCol − 1) × 6 + (srcRow − 1)
b21      = floor(srcGp / 2)
colTerm  = floor(3·(srcCol−1)/2) + 1
destSign = destRow ≥ 3 ? 1 : 0
b22      = ((srcGp & 1) << 6) | (colTerm + destSign)
b23      = ((|destRow−3| + (srcCol even ? 2 : 0)) mod 4) << 5
```

Constraint: srcRow=1 even srcCol is not yet captured for 6-row grids
(pattern not closed; capture r1c2→r1c3, r1c2→r3c3 with FM9-Edit to close it).

**4-row grids (FM3 0x11), 10/10 byte-confirmed, FM3-Edit loopMIDI, 2026-06-05:**

```
srcGp = (srcCol − 1) × 4 + (srcRow − 1)
b21   = floor(srcGp / 2)
b22   = ((srcGp & 1) << 6) | srcCol          ← colTerm = srcCol; no destSign
b23   = (destRow − 1) << 5                   ← linear 0-indexed encoding; no mod-4 wrap
```

All rows 1–4 and all srcCol parity (including row-1 even-col) work on the 4-row formula.
Row-1 even-col confirmed by capture r1c2→r1c3.

Key structural differences:
- 6-row b22 uses a `3/2`-scaled colTerm and a destRow threshold (destSign); 4-row uses srcCol directly.
- 6-row b23 is centered at row 3 with mod-4 wrap; 4-row is a flat `(destRow−1)×32` linear map.

Captures archived: `samples/captured/fm3-routing-probe-*.json` (gitignored).

#### sub=0x2E SET_GRID_LAYOUT (live grid READ): decoded, FM9-cross-validated, FM3 geometry pinned

The editors read a preset's whole routing grid live with an **empty-target**
`fn=0x01 sub=0x2E` query (no block id in the target slot):

```
request (23B):  F0 00 01 74 <model> 01 2E 00 00 00 00 00 00 00 00 00 00 00 00 00 00 <cs> F7
reply (~755B):  F0 00 01 74 <model> 01 2E 00 … <grid bitstream> … <cs> F7
```

The grid lives in a **7-bit-packed bitstream** that is **TAIL-ANCHORED**: the
last `ceil((46 + cols·rows·32) / 7)` bytes before the trailing `[checksum, F7]`.
On the canonical 755-byte FM9 frame that lands at mido byte 361; on the FM3 the
frames arrive as both 590 (→ 361) and 606 bytes (→ 377), and the tail anchor
decodes all of them without per-length cases. Cells are addressed by:

```
cell_start_bit = 46 + col·(rows·32) + row·32
   III/FM9: 6 rows × 14 cols (col stride 192)
   FM3:     4 rows × 12 cols (col stride 128)
bits  0-7  = (effectId | shuntIndex) << 1
bits  8-15 = block type   (0x08 = shunt, 0x00 = real block)
bits 16-23 = incoming-cable bitmask
```

Bits are read **MSB-first within each 7-bit byte** (`(data[bit/7] >> (6 - bit%7)) & 1`);
an 8-bit reader yields garbage (the tell-tale `0xE8/0xD8` "block type").

**Provenance + evidence:** decode contributed by the MIT-licensed
`ai-tone-assistant` community project (from its own FM9 captures) and
INDEPENDENTLY cross-validated here against our FM9 capture
`fm9-receive-preset-from-device-harp-2026-06-04` (model 0x12): all 10
empty-target sub=0x2E replies decode identically to a coherent grid
(Input@col0 → Pitch/Comp/Amp/Phaser/Drive/GEQ/Filter/Chorus/Amp/Cab/… →
Output@col11, 14 sequentially-indexed shunts) whose every real-block effect ID
resolves in `blockTypes.ts` (Amp 58, Cab 62, Comp 46, GEQ 50, Chorus 78, Drive
118). Cross-oracle validation = ships community-beta; awaits a device key-press
to confirm. Codec: `gridLayout.ts` (`buildRequestGridLayout` / `parseGen3GridLayout`);
goldens `test/gen3/axe-fx-iii/gridlayout.test.ts`; cross-validation
`scripts/verify-gen3-grid-layout.ts`. **Strides are FM9- and FM3-validated;
III shares the codec (community-beta). FM3 geometry (4×12, tail-anchored
region) pinned 2026-07-01 offline** against the three checksum-valid
block-targeted replies in
`samples/captured/fm3-community-2026-06-12/fm3-probe-output.json` (job3),
oracled by the same session's `fn=0x13` status dump: all three, including the
606-byte length variant, decode to exactly Input1(37)@r1c0 → Amp1(58)@r1c1 →
Output1(42)@r1c2 (cables 0x04). Goldens: the two embedded FM3 frames in
`test/gen3/axe-fx-iii/gridlayout.test.ts` + the capture cross-validation in
`scripts/verify-gen3-grid-layout.ts`.

#### sub=0x2E live-meters payload (CPU + output meters): decoded, FM9-cross-validated

The **same** empty-target sub=0x2E reply carries live telemetry in fixed low
offsets, **before** the grid region. Offsets are into the FULL frame WITH the
leading `F0` (so `f[0]=F0`, `f[5]=fn`, `f[6]=sub`):

```
cpu_percent   = 32 + f[37] * 0.5      (7-bit field → range 32.0 .. 95.5 %)
output_left   = f[35] / 127           (0..1, momentary peak)
output_right  = f[36] / 127           (0..1, momentary peak)
```

**Provenance + evidence:** offsets/arithmetic from the MIT-licensed **ForgeFX**
project (its own FM3 fw-12.0 hardware testing), INDEPENDENTLY cross-validated
here against our FM9 capture `fm9-receive-preset-from-device-harp-2026-06-04`
(model 0x12). The 10 sub=0x2E reads are all of the SAME static preset, so the
*behavioral oracle* is "a byte that VARIES across reads is live telemetry, a
byte that is CONSTANT is grid/preset data." In the capture, exactly `f[35]`
(32..122) and `f[36]` (7..119) vary widely, a stereo output meter bouncing
with the audio, while `f[37]` is CONSTANT at 66 (→ a steady 65.0 % DSP load,
plausible for a preset's fixed cost). This matches the CPU-steady /
meters-bouncing signature and agrees with ForgeFX's offsets. Codec:
`liveMeters.ts` (`parseGen3LiveMeters`); goldens
`test/gen3/axe-fx-iii/livemeters.test.ts`; the capture cross-validation runs in
`scripts/verify-gen3-grid-layout.ts`. Surfaced as `live_meters` on gen-3
`get_preset` (active buffer), free, since the grid read already pulls this frame.

**INPUT meter deliberately NOT surfaced.** ForgeFX reads an input meter at
`f[588]`, but that offset is FM3-frame-length-specific (the FM3 frame is ~590B,
so f[588] sits at its tail). On FM9 the frame is 755B and index 588 lands INSIDE
the static grid bitstream region (starts at 361): in our capture `f[588]` is
CONSTANT across all 10 reads (= grid data, not a live input level). Emitting it
as "input" would be a wrong, frame-coincidental value on every non-FM3 device,
so we ship only the three device-invariant low-offset fields. The
verify script asserts `f[588]` stays constant on FM9 to lock this rationale.

#### Scene / tempo current-state reads (fn=0x0C `7F` / fn=0x14 `7F 7F`)

Both are spec-documented, golden-verified query opcodes (`buildGetScene` /
`parseSceneResponse`, `buildGetTempo` / `parseTempoResponse`). gen-3
`get_preset` (active buffer) issues the **scene** query and surfaces the result
as `active_scene`; it is a safe read with no side-effect. The **tempo** query
is deliberately NOT auto-issued from `get_preset`: `get_tempo` (the `7F 7F`
sentinel) is reported to have SET the tempo to 250 BPM on *early-firmware* III,
so firing it as a side-effect of a status read would be a silent-write footgun.
Exposing tempo wants an explicit, opt-in `get_tempo` tool carrying that caveat,
not a get_preset side-effect.

### Ghidra-decoded write surface, 2026-06-09 actions-and-shapes mine (decoded / hardware-unverified)

Source: the full decompile mine of the Axe-Edit III binary's fn=0x01
builder callers and standalone-fn emitters
(`ghidra-axe-edit-iii-actions-and-shapes.txt`, 25,980 lines; charted
table in the maintainer's private mine notes plus
`iii-subaction-table.json`). Everything below is FACT-tier in the
Ghidra sense (string/symbol-anchored emission sites, exact field
writes), decoded with **no hardware confirmation**. Builders ship
community-beta in `src/gen3/axe-fx-iii/setParam.ts` with byte goldens in
`test/axe-fx-iii/subactions.test.ts`.

#### Block clear (fn=0x01 sub=0x30, companion sub=0x33)

The editor's "Clearing preset..." routine (`FUN_140218f80`, dump
L9821-9976) loops gridPos 0..0x53 (84 = 6x14 cells) and emits per cell:

```
CLEAR     F0 00 01 74 <model> 01 30 00 00 00 00 00 <gp:2> 00 00 00 00 00 00 00 <cks> F7
COMPANION F0 00 01 74 <model> 01 33 00 00 00 00 00 <gp:2> 00 00 00 00 00 00 00 <cks> F7
```

blockId14 = paramId14 = 0; the cell index rides in the value32 field as
a raw uint32 (NOT a float32, unlike the SET ops). Thin helper
`FUN_1403403e0` (dump L22283-22301) confirms the field map. This grounds
the semantics of the sub=0x30 frame already captured live as the
block-insert "cell SELECT companion" (table above): it is the cell
reset/clear (the editor clears the target cell before inserting).
The sub=0x33 companion's own semantics are uncharted ("clear-preset
companion step"); the clear loop always sends the pair, the insert
transaction sends 0x30 alone. Note the loop bound is 0x54 for ALL model
bytes including FM3 (4x12 = 48 cells), so the index space may be a
model-agnostic 84-entry slot table rather than the literal grid; for
III/FM9 the readings coincide. Builders: `buildClearBlock`,
`buildClearBlockCompanion`.

#### Name writes (fn=0x01 sub=0x28 preset, sub=0x2b scene)

Two name-write sub-actions, both carrying a 32-byte raw name as the
fn=0x01 tail (tailCount14 = 32 at payload 13-14, then the name 8-to-7
septet-packed to 37 wire bytes per `iii-byte-stream-septet-pack-8to7`;
60-byte total frame):

- **sub=0x28, preset name** (`FUN_140340560`, dump L8014-8053):
  blockId14 = paramId14 = 0. The clear-preset flow writes the literal
  `"<EMPTY>"` through it (dump L10410-10432), which is exactly what
  empty gen-3 preset slots display. Builder: `buildRenamePreset`.
- **sub=0x2b, indexed (scene) name** (`FUN_1403404a0`, dump
  L10522-10561): the index rides in the paramId14 field. The editor's
  "Clear All Names" command (`FUN_1402da550`, dump L17584-17612) loops
  index 0..7 with an empty name, matching the gen-3 8-scene count
  (scene-index reading is decoded inference; the byte shape is exact).
  Builders: `buildSetSceneName`, `buildClearAllSceneNames`.

Pad caveat: the editor formats the 32-byte field via `FUN_140386ac0`,
whose body is in no dump we hold, so the pad byte for short names is
NOT cited. The builders space-pad (0x20), matching every Fractal
32-char name field decoded so far (AM4 rename is hardware-confirmed
space-pad); flagged for capture confirmation.

#### Scene-blob transfer (standalone fn=0x5a header + fn=0x5c trailer)

`FUN_140328a10` (dump L22861-23053) emits a scene-targeted DATA
TRANSFER, not a bare scene switch:

```
HEADER  F0 00 01 74 <model> 5A <scene> <arg14:2> <wordCount21:3> <cks> F7   (14 bytes)
DATA    ... streamed in chunks of up to 0x100 uint32 words (chunk frame NOT decoded) ...
TRAILER F0 00 01 74 <model> 5C <xor32:5-septet, byte 4 = bits 28-31> <cks> F7  (13 bytes)
```

The scene number in header payload byte 0 is FACT; the 14-bit arg's
semantics are uncited (caller-supplied runtime value); the trailer is
the XOR-32 of all data words (standalone emitter `FUN_140336a40`, dump
L23059-23086). The dump generator's section label called this
"fn=0x15 Change Scene"; the bodies show fn=0x5a/0x5c. The editor never
emits a bare data-less fn=0x5a (a null data pointer aborts before any
send, dump L22915), so no "switch scene via 0x5a" builder ships; the
plain scene switch remains the spec-documented fn=0x0c. Builders:
`buildSceneBlobHeader`, `buildSceneBlobChecksum`, `xorChecksum32Words`.

Also from the same mine: the generator's PART B labels "fn=0x30 Reset
Block" and "fn=0x31 Move Block" are wrong; those emitters actually send
fn=0x43 (our REQUEST_EDIT_BUFFER_DUMP) and fn=0x08. Block reset/clear
is the fn=0x01 sub=0x30 above, and the highest-value capture asks are
one III/FM9 USBPcap of a scene change and of a block clear to flip
these from decoded to confirmed.

### Function 0x01, long-payload write (likely SET_PARAMETER / SET_MODIFIER)

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
captures with known parameter values, a target for any future
`set_param` work.

Note that v1.4 doesn't reserve 0x01 for any documented purpose, and
the Axe-Fx II family uses 0x01 for `GET_BLOCK_PARAMETERS_LIST` (a
different function): the III repurposed the same byte for what
appears to be parameter-write.

### Function 0x21, front-panel-change auto-push

Multiple captures of "AxeFXIII MIDI Input receives TONS of messages"
threads show frames with function byte 0x21 streaming during
front-panel knob movement. Earlier this was attributed to design-
note speculation; the capture confirms it's a real device-emitted
function. Useful for any future dirty-state detection.

### Function 0x64, MULTIPURPOSE_RESPONSE (error / ack channel)

In the v1.4 PDF as the response opcode. A real-world capture
confirms the wire shape when the III rejects a malformed request:

```
F0 00 01 74 10 64 [echoed_fn] [result_code] [cs] F7
```

Example: a host sent QUERY_SCENE_NAME (0x0E) with a bad checksum.
The III responded `F0 00 01 74 10 64 0E 00 7F F7`, function 0x64,
echoed 0x0E, result code 0x00, valid checksum 0x7F.

**Status: shipped.** The III tools now bracket each
fire-and-forget SET write with a 250ms 0x64 listener
(`sendAndWatchForError` in `src/gen3/axe-fx-iii/tools/shared.ts`).
When a 0x64 arrives it surfaces as a warning in the tool response
text, `(echoed_fn, result_code)` plus a human label for known codes.
Byte-exact predicate + parser goldens (including the community-captured
`F0 00 01 74 10 64 0E 00 7F F7` frame) live in
`scripts/verify-axe-fx-iii-encoding.ts`.

**Result code table (28 codes, decoded  from AxeEdit III
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

- `ID_CONTROL` (2): internal "control switch", FC-controlled
- `ID_MIDIBLOCK` (190): internal-only
- `ID_FOOTCONTROLLER` (199): FC interface only
- `ID_PRESET_FC` (200): internal

**Status: shipped.** `src/gen3/axe-fx-iii/blockTypes.ts`
now marks these four entries `addressable: false`, and
`resolveEffectId` refuses them with a clean message naming the four
non-addressable IDs. `axefx3_list_blocks` surfaces the addressable
column so the agent can see the FC-only blocks before attempting a
write. Goldens in `scripts/verify-axe-fx-iii-encoding.ts` cover all
four refusal cases.

## Function bytes confirmed in the AxeEdit III binary

Ghidra mining (`MineAxeEditIIIv2.java` + `TraceAxeEditIIIMessageBuilders.java`,
both runnable via `scripts/ghidra/run-axeedit3-*.cmd`) identified
AxeEdit III's generic SysEx message-builder function (`FUN_1403437d0`
at v1.14.31) which takes the function byte as a runtime parameter.
Walking its 41 callers reveals **every fn byte AxeEdit III emits**.
The Fractal model byte is loaded from a device-handle struct field
at runtime (`param_1 + 0x30`), so `F0 00 01 74 10` doesn't appear as
a literal byte sequence in `.text`, explaining why v1 byte-pattern
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
| 0x1a | ❌ | Request side of the `0x5a/0x5b/0x5c` dump family (bound 2026-06-09 from the inbound-dispatcher mine; system-data / footswitch-config candidate, hardware-unverified) |
| 0x1b | ❌ | Undocumented (3-byte payload, FOOTSWITCH_*?) |
| 0x1f | ❌ | Caller `FUN_140339ed0(longlong*, ushort*)` packs a 16-bit value into 7-bit septets before calling. **Smaller payload than full SET_PARAM would need** (SET_PARAM needs effectId+paramId+value ~60 bits / 9 septets). Likely a 14-bit-payload-only SysEx, candidates: per-effect bypass, channel set, or status query. Re-classified from "high suspicion SET_PARAM" after  caller-decompile inspection. |
| 0x3f | ❌ | Caller `FUN_140336dd0(longlong, ushort*)`, same shape as 0x1f (16-bit input + septet pack). Likely paired with 0x40 as a 14-bit-value SysEx pair. |
| 0x40 | ❌ | Caller `FUN_140337060`, similar shape to 0x3f. Bound 2026-06-09: request that triggers BOTH the `0x67/0x68/0x69` dump (response-only family, device-dictionary candidate) and the `0x5a/0x5b/0x5c` dump. Hardware-unverified; see the envelope-spec section above. |
| 0x46 | ❌ | Undocumented (paired with 0x47) |
| 0x47 | ❌ | Undocumented (paramless, like TEMPO TAP shape) |
| 0x5a | ❌ | Two decoded roles (2026-06-09, hardware-unverified): host-emitted scene-blob DATA-transfer header (see the scene-blob section above; NOT a scene switch) and head frame of the device's `0x5a/0x5b/0x5c` dump family (request `0x1a` or `0x40`) |
| 0x5b | ❌ | Body frame of the `0x5a/0x5b/0x5c` dump family (decoded, hardware-unverified) |
| 0x5c | ❌ | Trailer: scene-blob XOR-32 trailer on the host side; tail frame of the `0x5a/0x5b/0x5c` dump family on the device side (decoded, hardware-unverified) |
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
SysEx opcode AxeEdit III sends to the device, payload structure
still needs USBPcap or further decompile analysis per caller.

### What the III's SET_PARAM (still) isn't

 inspected the callers of the candidate fn bytes (0x1f,
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
capture of AxeEdit III firing a single-knob change, that surfaces
the actual wire bytes, regardless of which builder produced them.

## Effect-type parameter dictionary

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
| 0x01 | GLOBAL | 248 |, (system-wide) |
| 0x02 | CONTROLLERS | 189 | ID_CONTROL=2 (non-addressable) |
| 0x03 | MOD | 25 |, |
| 0x05 | IRCAPTURE | 4 | ID_IRCAPTURE=36 |
| 0x07 | COMP | 37 | ID_COMP1=46 |
| 0x08 | GEQ | 21 | ID_GRAPHEQ1=50 |
| 0x09 | PEQ | 33 | ID_PARAEQ1=54 |
| 0x0a | DISTORT (Amp) | 143 | ID_DISTORT1=58 |
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
| 0x3a | (empty) | 0 |, likely placeholder |
| 0x3b | DYNDIST | 14 | post-v1.4 (Dynamic Distortion) |

**Notably absent: the AMP block.** Cases 0x04, 0x06, 0x1b in the
dispatcher return -1 (no param table). AMP almost certainly uses a
separate parameter-resolver path; finding it is a + task.

Family → first paramId for each effect is the canonical paramId for
that block's "type" knob (REVERB → paramId 0 = REVERB_TYPE; DELAY →
paramId 0 = DELAY_TYPE; ...). This is enough to start drafting
`src/gen3/axe-fx-iii/params.ts` per-effect descriptors, the
remaining gap is the III's SET_PARAM wire envelope (which fn byte
sends a `{effectId, paramId, value}` triple).

## Function names confirmed in AxeEdit III binary

`Axe-Edit III.exe` v1.14.31 contains 23 ASCII strings starting with
`SYSEX_` in a contiguous-ish .rdata block at offset 0x5aaf80 to 0x5ab2b0.
Mining recipe in `scripts/_research/mine-axeedit3-sysex-table.ts`.
This pool confirms which SysEx-function symbols exist in AxeEdit
III's source code, but the offset-ordering does NOT encode the
function byte (verified, see
[`axefx3-fn01-decode.md`](axefx3-fn01-decode.md) "Mined "
section for the negative result + scan that ruled out a parallel
u8/u16/u32 function-byte array).

**Documented in v1.4 PDF (function bytes known):**

- `SYSEX_SETGET_BYPASS` (0x0A), `SYSEX_SETGET_CHANNEL` (0x0B),
  `SYSEX_SETGET_SCENE` (0x0C), `SYSEX_GET_PATCHNAME` (0x0D),
  `SYSEX_GET_SCENENAME` (0x0E), `SYSEX_SETGET_LOOPER` (0x0F),
  `SYSEX_PATCH_STATUS` (0x13), `SYSEX_SETGET_TEMPO` (0x14)

**Confirmed to exist in AxeEdit III source, function bytes
unknown.** None of these are in the v1.4 PDF. Function-byte
assignment for these requires Ghidra against `Axe-Edit III.exe`
(none done yet), USBPcap of AxeEdit firing each, or community
sources that name the function byte:

| Symbol | Likely purpose |
|---|---|
| `SYSEX_DSP_MESSAGE` | DSP-usage / CPU-load query ( wanted this for `get_dsp_usage` MCP tool) |
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
direction or A3-spec-revision messages, distinct from the
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
(spec: `dd dd` LS-first). Full 200-BPM dataset available in the
founder-private corpus.

## Operations we CAN ship now from the spec alone

Given the function-byte map + Appendix 1 effect IDs:

- ✅ `axefx3_set_bypass(block_name, bypassed)`, 0x0A + known effect ID
- ✅ `axefx3_set_channel(block_name, channel)`, 0x0B + known effect ID
- ✅ `axefx3_get_preset_name_and_number()`, 0x0D `7F 7F` returns both
- ✅ `axefx3_get_preset_name_at(preset_number)`, 0x0D N N returns preset N's name
- ✅ `axefx3_switch_scene(scene)`, 0x0C set (correct already)
- ✅ `axefx3_get_active_scene()`, 0x0C query (correct already)
- ✅ `axefx3_get_scene_name(scene | 'current')`, 0x0E (correct already)
- ✅ `axefx3_tempo_tap()`, 0x10
- ✅ `axefx3_tuner(on)`, 0x11
- ✅ `axefx3_set_tempo(bpm)` / `axefx3_get_tempo()`, 0x14
- ✅ `axefx3_set_looper(action)` / `axefx3_get_looper_state()`, 0x0F (the REAL 0x0F)
- ✅ `axefx3_status_dump()`, 0x13 (correct already, parser too)
- ⚠️ `axefx3_switch_preset`: the v1.4-PDF-documented path is MIDI PC + Bank
  Select (default). UPDATE 2026-06-10: a SysEx-native path also exists:
  `fn=0x01 sub=0x27` (`buildSwitchPresetSysEx`), FM3-hardware-confirmed. (The
  old `buildSwitchPreset` bug, which sent a *query-patch-name* frame, is a
  separate, real defect; see the known-bugs table above.)
- ✅ `axefx3_set_param`, opcode is fn=`0x01` PARAMETER_SETGET with sub-action `09 00` (typed-input), byte-verified against 10 public captures spanning two effect blocks and two paramIds (see the 0x01 PARAMETER_SETGET section above). NOT fn=`0x02` (that was the wrong II-port, now closed). Param-IDs come from the AxeEdit III binary mining, not the published third-party PDF. The SET wire shape ships verified; the GET response shape is still unverified.
- 🟢 `save_preset` (gen-3 path, used via the `port` argument), store-to-location is `fn=0x01 sub=0x26` (presetNum septet @12-13, LSB-first), captured byte-exact from III-Edit (0x10) and FM9-Edit (0x12) over loopMIDI; the codec now emits this. Wire shape confirmed; device persistence (front-panel confirm + flash write) is the remaining hardware-verification step. The 0x77/0x78/0x79 multi-frame envelope is the separate full preset-binary transfer (decoded: its descriptor tables are byte-identical to the II's, the 0x79 footer is a 16-bit XOR-fold of the body words, and the receive direction is FM9 hardware-confirmed; see the preset-dump and envelope sections above).

## Cross-references

- **Project README and CLAUDE.md**: point at `docs/REFERENCES.md` for any "where do I find X" question. The III spec is row 30 there.
- **III package source**: `src/gen3/axe-fx-iii/setParam.ts` carries an inline pointer to this doc at the top of the file (after edits land).
- **Community beta-testing workflow**: the community capture guides ([`../../capture-guides/testing-axe-fx-iii.md`](../../capture-guides/testing-axe-fx-iii.md)). III owners run a small list of tool calls and report whether the front panel matches the response.
- **Design notes** (some predate the bug discovery here): [`design-notes.md`](design-notes.md).
- **Forum reverse-engineering** of preset save format, Fractal Forum thread #159885 ("Axe-Fx III and deconstructing / parsing a .syx / sysex preset file"). Three-function envelope: `0x77` (header, contains destination), 16× `0x78` (body chunks), `0x79` (footer).
