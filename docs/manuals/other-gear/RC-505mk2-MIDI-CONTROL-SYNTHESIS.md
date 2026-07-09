# Boss RC-505mk2 Loop Station: MIDI Control Synthesis

Design source for a generic-MIDI-tier device descriptor (`packages/rc-505`) in this
MCP MIDI-control server. Every non-obvious claim cites a line number in
`RC-505mk2_Parameter_eng02_W.blocks.txt` (the reading-order extraction). The
`-layout` extraction (`RC-505mk2_Parameter_eng02_W.txt`) interleaves its
TARGET/Explanation columns, so it is used only for cross-check, never as the primary
citation.

Notation note: the source text extractions render the arrow glyph as the digit `0`.
So `A0D` means "A to D", `1020...50` means "1 to 2 ... to 5", and
`LPF0REVERSE REVERB` means "LPF to REVERSE REVERB". Device strings below are
normalized back to plain words; the raw enum tokens (`IN FX A-D TYP INC`, etc.) are
preserved verbatim because they become descriptor enum values.

---

## 1. Control model

The RC-505mk2 exposes NO address-style SysEx. There is no DT1/RQ1, no parameter
read-back, no memory dump over MIDI. All external control is ordinary channel-voice
and system-real-time MIDI: Control Change (CC), Program Change (PC), MIDI clock, and
Note messages. This is confirmed by the entire MIDI chapter (blocks lines 2318-2380)
describing only RX/TX channels, clock sync, PC out, and note reception, with no
data-request or bulk-dump machinery anywhere in the parameter guide.

What CAN be driven over MIDI:
- Memory (preset) switching via Program Change on the RX CTL channel (blocks 2322-2326:
  the RX CTL channel receives "messages (control changes) that switch memories or
  control the RC-505mk2"; PC OUT at 2365-2368 confirms program change is the
  memory-switch message class).
- Any function in the ASSIGN TARGET catalog (Section 2), by sending a CC that a
  per-memory Assign maps to that target.
- Tempo, by slaving the unit to incoming MIDI clock (CLOCK SYNC = AUTO/MIDI/USB;
  blocks 2338-2353), and start/stop of tracks and/or rhythm via MIDI Start with SYNC
  START (blocks 2357-2364).
- Rhythm triggering via Note messages on the RX RHYTHM channel, and the HARMONIST /
  VOCODER effects via Note messages on the RX VOICE channel (Section 5).

What CANNOT be done over MIDI:
- No read of any parameter, track state, level, or the Assign configuration itself.
- No verification that a write landed. The device never echoes a display value the way
  the Fractal `get_param` path does.
- No SysEx-based preset backup/restore (that path on this device is USB mass storage,
  not MIDI, and is out of scope for a MIDI descriptor).

### The ASSIGN system (the whole control surface)

External CC control is entirely indirect, routed through the device's ASSIGN system
(blocks 1842-2271). Each memory holds 16 assignments, ASSIGN1-16 (blocks 1845), and
each assignment has these fields (blocks 1849-2270):

| Field | Values | Meaning |
|---|---|---|
| SW | OFF, ON | Whether this assignment is active (blocks 1849-1851) |
| SOURCE | see Section 3 | The controller that drives the target (blocks 1852-1882) |
| SOURCE MODE | MOMENT, TOGGLE | Footswitch behavior (blocks 1883-1891) |
| SOURCE ACT. LO | 0-127 (default 0) | Low end of source's active range (blocks 1892-1897) |
| SOURCE ACT. HI | 0-127 (default 127) | High end of source's active range (blocks 1892-1898) |
| TARGET | see Section 2 | The function controlled (blocks 1899-2266) |
| TARGET MIN | target-dependent | Min value the target is driven to (blocks 2267-2269) |
| TARGET MAX | target-dependent | Max value the target is driven to (blocks 2267-2270) |

### The user-configured-CC caveat (state this loudly)

There is NO fixed factory CC-number-to-function chart on this device. The mapping from
an incoming CC number to a function is defined by the user, per memory, in that
memory's Assign slots. SOURCE can be set to `MIDI CC#01-31` or `MIDI CC#64-95` (blocks
1880-1882), and the SOURCE then points at whatever TARGET the user chose. An external
controller therefore just sends "CC number K on the RX CTL channel," and the RC-505mk2
does whatever the currently loaded memory's Assign table maps K to. The same CC can
mean different things in different memories, and can mean nothing if no Assign in the
loaded memory uses it.

The Assign settings are stored per memory and must be written to memory to persist
(blocks 1843-1844). They cannot be read, set, or verified over MIDI. This makes the
RC-505mk2 a generic-MIDI-tier device with no read-before-write fingerprint: our server
can send, but it cannot confirm the device's current Assign configuration or the
result of a send. Any coordination (Section 6) depends on the user having configured
the matching Assign on the device beforehand.

---

## 2. ASSIGN TARGET catalog (complete)

The complete assignable-target list, verbatim from blocks 1902-2266. `TRK1-5` / `TRK 1-5`
denotes five separate instances (one per track, tracks 1 through 5). `A-D` denotes four
instances (FX slots A, B, C, D of the currently selected FX bank). `AA-DD` denotes the
sixteen cross-bank FX cells (A-A through D-D). `CUR.TRK` / `CR` / `CUR` targets act on
whichever track or FX is currently selected. Ranges are given only where the doc states
one; where blank, TARGET MIN/MAX are target-dependent and unspecified in the guide
(blocks 2267-2270).

### Per-track (TRK1-5), blocks 1902-1924

| TARGET string | Range | Function |
|---|---|---|
| `TRK1-5 REC/PLY` | | record/play/overdub toggle for the track |
| `TRK1-5 PLY/STP` | | play/stop toggle for the track |
| `TRK1-5 STOP` | | stop record/play for the track |
| `TRK1-5 CLEAR` | | clear the track |
| `TRK1-5 REVERSE` | | reverse play on/off |
| `TRK1-5 UN/RED` | | undo/redo recording or last overdub |
| `TRK1-5 M.BACK` | | switch to the mark's recording state |
| `TRK1-5 R.BACK` | | restore to just-after-recording state |
| `TRK1-5 M.SET` | | set a mark at the overdub state |
| `TRK1-5 M.CLEAR` | | delete the set mark |
| `TRK1-5 LEVEL` | 0-200 | PLAY LEVEL of the track (blocks 1923-1924) |

### Current track (CUR.TRK), blocks 1925-1961

| TARGET string | Range | Function |
|---|---|---|
| `CUR.TRK REC/PLY` | | record/play/overdub toggle, current track |
| `CUR.TRK PLY/STP` | | play/stop toggle, current track |
| `CUR.TRK STOP` | | stop record/play, current track |
| `CUR.TRK CLEAR` | | clear current track |
| `CUR.TRK REVERSE` | | reverse play on/off, current track |
| `CUR.TRK UN/RED` | | undo/redo, current track |
| `CUR.TRK M.BACK` | | mark-back, current track |
| `CUR.TRK R.BACK` | | restore, current track |
| `CUR.TRK M.SET` | | set mark, current track |
| `CUR.TRK M.CLEAR` | | clear mark, current track |
| `CUR.TRK LEVEL` | 0-200 | PLAY LEVEL, current track (blocks 1954-1955) |
| `CUR.TRK INC` | | step current track up (1 to 2 ... to 5) |
| `CUR.TRK DEC` | | step current track down (5 to 4 ... to 1) |
| `CUR.TRK NUM` | | jump current track to the CURRENT TRACK setting |

### Transport / global, blocks 1962-1970

| TARGET string | Range | Function |
|---|---|---|
| `ALL ST/STP` | | start all tracks together; stop all if already playing/recording |
| `TAP TEMPO` | | set tempo by tap; long-press reverts to previous tempo |
| `TEMPO` | | control the tempo value |

### Input FX (per selected bank, A-D), blocks 1971-2013

| TARGET string | Function |
|---|---|
| `INPUT FX` | input FX on/off |
| `IN FX TGT INC` | knob switches input FX A to D (selected bank) |
| `IN FX TGT DEC` | knob switches input FX D to A |
| `IN FX BNK INC` | input FX bank A to D |
| `IN FX BNK DEC` | input FX bank D to A |
| `IN FX SW MODE` | toggles all A-D button modes (TOGGLE/MOMENT) at once |
| `IN FX A-D` | input FX A-D on/off |
| `IN FX A-D CTL` | control params per the A-D type |
| `IN FX A-D TYPE` | switch A-D type |
| `IN FX A-D TYP INC` | A-D type LPF to REVERSE REVERB |
| `IN FX A-D TYP DEC` | A-D type REVERSE REVERB to LPF |
| `IN FX A-D SW MODE` | A-D button mode (TOGGLE/MOMENT) |
| `IN FX A-D PRM1-4` | A-D parameters 1 through 4 |
| `IN FX A-D SEQ` | A-D FX-sequence on/off |
| `IN FX A-D S.SYNC` | A-D SYNC |
| `IN FX A-D S.RTRIG` | A-D RTRIG |
| `IN FX A-D S.RATE` | A-D STEP RATE |
| `IN FX A-D S.MAX` | A-D STEP MAX |

### Input FX cross-bank cells (AA-DD), blocks 2015-2047

| TARGET string | Function |
|---|---|
| `IN FX AA-DD` | A-A through D-D on/off |
| `IN FX AA-DD CTL` | control params per A-A..D-D type |
| `IN FX AA-DD TYPE` | switch A-A..D-D type |
| `IN FX AA-DD TYP INC` | type LPF to REVERSE REVERB |
| `IN FX AA-DD TYP DEC` | type REVERSE REVERB to LPF |
| `IN FX AA-DD SW MODE` | button mode for A-A..D-D |
| `IN FX AA-DD PRM1-4` | parameters 1 through 4 |
| `IN FX AA-DD SEQ` | FX-sequence on/off |
| `IN FX AA-DD S.SYNC` | SYNC |
| `IN FX AA-DD S.RTRIG` | RTRIG |
| `IN FX AA-DD S.RATE` | STEP RATE |
| `IN FX AA-DD S.MAX` | STEP MAX |

### Input FX current (CR / CUR), blocks 2048-2074

| TARGET string | Function |
|---|---|
| `IN FX CR` | current input FX on/off |
| `IN FX CR CTL` | control params per current type |
| `IN FX CR TYPE` | switch current type |
| `IN FX CR TYP INC` | current type LPF to REVERSE REVERB |
| `IN FX CR TYP DEC` | current type REVERSE REVERB to LPF |
| `IN FX CR SW MODE` | current button mode (TOGGLE/MOMENT) |
| `IN FX CUR PRM1-4` | current FX parameters 1 through 4 |
| `IN FX CUR SEQ` | current FX-sequence on/off |
| `IN FX CUR S.SYNC` | current SYNC |
| `IN FX CUR S.RTRIG` | current RTRIG |
| `IN FX CUR S.RATE` | current STEP RATE |
| `IN FX CUR S.MAX` | current STEP MAX |

Note the mixed prefixes in this group verbatim from the doc: `IN FX CR *` for the
on/off, CTL, TYPE, TYP INC/DEC, and SW MODE rows, but `IN FX CUR *` for PRM1-4, SEQ,
and the S.* rows. Preserve exactly as written.

### Track FX (per selected bank, A-D), blocks 2075-2118

| TARGET string | Function |
|---|---|
| `TRK FX` | track FX on/off |
| `TRK FX TGT INC` | knob switches track FX A to D (selected bank) |
| `TRK FX TGT DEC` | knob switches track FX D to A |
| `TRK FX BNK INC` | track FX bank A to D |
| `TRK FX BNK DEC` | track FX bank D to A |
| `TRK FX SW MODE` | toggles all A-D button modes at once |
| `T FX A-D` | track FX A-D on/off |
| `T FX A-D CTL` | control params per A-D type |
| `T FX A-D TYPE` | switch A-D type |
| `T FX A-D TYP INC` | A-D type LPF to VINYL FLICK |
| `T FX A-D TYP DEC` | A-D type VINYL FLICK to LPF |
| `T FX A-D SW MODE` | A-D button mode |
| `T FX A-D PRM1-4` | A-D parameters 1 through 4 |
| `T FX A-D SEQ` | A-D FX-sequence on/off |
| `T FX A-D S.SYNC` | A-D SYNC |
| `T FX A-D S.RTRIG` | A-D RTRIG |
| `T FX A-D S.RATE` | A-D STEP RATE |
| `T FX A-D S.MAX` | A-D STEP MAX |

Note: the on/off etc. rows use the `TRK FX *` prefix (bank/target/mode controls), while
the per-slot rows use the `T FX A-D *` prefix. Preserve both verbatim.

### Track FX cross-bank cells (AA-DD), blocks 2119-2151

| TARGET string | Function |
|---|---|
| `T FX AA-DD` | A-A through D-D on/off |
| `T FX AA-DD CTL` | control params per type |
| `T FX AA-DD TYPE` | switch type |
| `T FX AA-DD TYP INC` | type LPF to VINYL FLICK |
| `T FX AA-DD TYP DEC` | type VINYL FLICK to LPF |
| `T FX AA-DD SW MODE` | button mode |
| `T FX AA-DD PRM1-4` | parameters 1 through 4 |
| `T FX AA-DD SEQ` | FX-sequence on/off |
| `T FX AA-DD S.SYNC` | SYNC |
| `T FX AA-DD S.RTRIG` | RTRIG |
| `T FX AA-DD S.RATE` | STEP RATE |
| `T FX AA-DD S.MAX` | STEP MAX |

### Track FX current (CR / CUR), blocks 2152-2176

| TARGET string | Function |
|---|---|
| `T FX CR` | current track FX on/off |
| `T FX CR CTL` | control params per current type |
| `T FX CR TYPE` | switch current type |
| `T FX CR TYP INC` | current type LPF to VINYL FLICK |
| `T FX CR TYP DEC` | current type VINYL FLICK to LPF |
| `T FX CR SW MODE` | current button mode |
| `T FX CUR PRM1-4` | current FX parameters 1 through 4 |
| `T FX CUR SEQ` | current FX-sequence on/off |
| `T FX CUR S.SYNC` | current SYNC |
| `T FX CUR S.RTRIG` | current RTRIG |
| `T FX CUR S.RATE` | current STEP RATE |
| `T FX CUR S.MAX` | current STEP MAX |

### Rhythm, blocks 2177-2184, 2209-2212

| TARGET string | Range | Function |
|---|---|---|
| `RHYTHM ST/STP` | | rhythm start/stop toggle |
| `RHYTHM START` | | start the rhythm |
| `RHYTHM STOP` | | stop the rhythm |
| `RHYTHM LEVEL` | 0-200 | MIXER RHYTHM OUT level (blocks 2183-2184) |
| `RHYTHM VARI` | | switch rhythm pattern variation |
| `RHYTHM KIT` | | switch the drum kit |

### Mic / instrument input, blocks 2185-2190, 2213-2222, 2236-2237

| TARGET string | Function |
|---|---|
| `MIC IN MUTE` | mute MIC 1 and MIC 2 audio |
| `MIC1 IN MUTE` | mute MIC 1 audio |
| `MIC2 IN MUTE` | mute MIC 2 audio |
| `MIC 1, 2 LEVEL` | MIC 1, 2 input level |
| `INST1-L, R LEVE (*6)` | INST 1 input level (string truncated in source as "LEVE"; verify against device) |
| `INST1-L, R MUTE (*6)` | mute INST 1 input |
| `INST2-L, R LEVEL (*6)` | INST 2 input level |
| `INST2-L, R MUTE (*6)` | mute INST 2 input |
| `INST1, 2 GAIN` | INST 1 GAIN and INST 2 GAIN |

### Track mixer / fader controls, blocks 2191-2208

| TARGET string | Function |
|---|---|
| `TRK 1-5 FADER` | volume of the currently selected track |
| `TRK 1-5 1SHOT` | 1SHOT for the currently selected track |
| `TRK 1-5 PAN` | PAN for the currently selected track |
| `TRK 1-5 FX` | input FX / track FX of the currently selected track |
| `TRK 1-5 SPEED` | SYNC SPEED for the currently selected track |
| `TRK 1-5 BNC IN` | bounce recording on/off for the specified track |
| `DUB MODE` | DUB MODE |
| `AUTO REC` | auto recording on/off |
| `BOUNCE` | bounce recording on/off |

Caveat: the `TRK 1-5 FADER/1SHOT/PAN/FX/SPEED` explanations say "currently selected
track" despite the `TRK 1-5` label (blocks 2192-2200). `TRK 1-5 BNC IN` says "the
specified track." Treat the effective scope as per-doc; flag for device check if the
descriptor needs per-track fader addressing.

### Output levels / master, blocks 2223-2235

| TARGET string | Function |
|---|---|
| `LOOP LEVEL` | loop playback output level |
| `MAIN-L, R LEVEL (*6)` | MAIN output level |
| `SUB1-L, R LEVEL (*6)` | SUB 1 output level |
| `SUB2-L, R LEVEL (*6)` | SUB 2 output level |
| `PHONES LEVEL` | PHONES output level |
| `MASTER LEVEL` | overall level for MAIN-L,R / SUB 1-L,R / SUB 2-L,R OUT |

### EQ on/off, blocks 2238-2260

| TARGET string | Function |
|---|---|
| `EQ MIC1, 2` | EQ on/off for MIC 1, 2 |
| `EQ INST-1L, R (*6)` | EQ on/off for INST 1 |
| `EQ INST-2L, R (*6)` | EQ on/off for INST 2 |
| `EQ MAIN-L, R (*6)` | EQ on/off for MAIN |
| `EQ SUB1-L, R (*6)` | EQ on/off for SUB 1 |
| `EQ SUB2-L, R (*6)` | EQ on/off for SUB 2 |

### Routing / panel / MIDI-out, blocks 2245-2266

| TARGET string | Function |
|---|---|
| `INPUT THRU` | INPUT THRU for INPUT/RHYTHM in OUTPUT/ROUTING |
| `PANEL MODE` | switch PANEL PLAY / PANEL UNDO for CTL FUNC |
| `MIDI CC#01-31` | transmit a CC of that controller number from MIDI OUT (blocks 2263-2265) |
| `MIDI CC#64-127` | transmit a CC of that controller number from MIDI OUT (blocks 2266) |

Footnote `(*6)` (blocks 2271): when STEREO LINK is ON, the function set for the L side
is the one enabled.

Note the MIDI-out target range is `MIDI CC#01-31` and `MIDI CC#64-127`. This differs
from the ASSIGN SOURCE range, which is `MIDI CC#01-31` and `MIDI CC#64-95` (Section 3).
The source (external control in) tops out at 95; the target (CC echoed out of MIDI OUT)
extends to 127. Do not conflate the two.

---

## 3. ASSIGN SOURCE and SOURCE MODE

### SOURCE options (blocks 1852-1882)

The controller that drives the target. For our use (external MIDI), the relevant
entries are the two MIDI CC ranges; the rest are onboard controllers.

| SOURCE string | Meaning |
|---|---|
| `TRK1-5 REC/DB` | track transition playback/stop to record/overdub (state source) |
| `TRK1-5 PLY/STP` | track transition record/overdub to playback/stop (state source) |
| `SYNC ST/STP` | All Start/Stop message from an external MIDI device |
| `TRK1-5 FX (PLY)` | the [FX] button for the track |
| `TRK1-5 TR (PLY)` | the [TRACK] button for the track |
| `TRK1-5 FX (UND)` | the [FX] button for the track during undo/redo |
| `TRK1-5 TR (UND)` | the [TRACK] button for the track during undo/redo |
| `IN FX KNOB` | the [INPUT FX] knob |
| `TR FX KNOB` | the [TRACK FX] knob |
| `CTL1, 2` | footswitch on the CTL 1, 2/EXP jack |
| `CTL3, 4` | footswitch on the CTL 3, 4/EXP jack |
| `EXP1` | expression pedal on the CTL 1, 2/EXP jack |
| `EXP2` | expression pedal on the CTL 3, 4/EXP jack |
| `MIDI CC#01-31` | CC number 1 through 31 from an external MIDI device |
| `MIDI CC#64-95` | CC number 64 through 95 from an external MIDI device |

The two `MIDI CC#*` entries are one contiguous concept in the doc (blocks 1880-1881:
"Control Change message (1-31, 64-95) from an external MIDI device"). The controllable
CC numbers usable as an Assign source are therefore 1-31 and 64-95. CC 32-63 and 96-127
are NOT available as Assign sources on this device.

### SOURCE MODE (blocks 1883-1891)

Applies when a momentary footswitch is the source. Two values:

| SOURCE MODE | Behavior |
|---|---|
| `MOMENT` | off (min) normally, on (max) only while the switch is held |
| `TOGGLE` | alternates off (min) / on (max) each press |

For a MIDI CC source the same min/max mapping applies driven by the CC value against
the ACT LO/HI window.

### SOURCE ACT. LO / SOURCE ACT. HI (blocks 1892-1898)

Both 0-127. Defaults: ACT LO = 0, ACT HI = 127 (blocks 1897: "normally set ACT LOW to
0 and ACT HIGH to 127"). These bound the source's operational range that is mapped onto
the target. Incoming values are clamped/scaled within [ACT LO, ACT HI].

### TARGET MIN / TARGET MAX (blocks 2267-2270)

Bound the target parameter's variable range. The concrete min/max values depend on the
target parameter (a level target is 0-200, an on/off target is off/on, etc.). The
source's [ACT LO, ACT HI] window maps onto [TARGET MIN, TARGET MAX]. Inverting a
control (e.g. CC 127 = off) is done by setting TARGET MIN > TARGET MAX on the device.

---

## 4. MIDI system settings (blocks 2318-2380)

All under MENU > MIDI. Bold = factory default where the extraction preserved it.

| Setting | Values | Default | Behavior / channel it governs |
|---|---|---|---|
| RX CH CTL | 1-16 | not preserved in extraction (device default typically 1: verify) | Receive channel for CCs that switch memories or control the unit (blocks 2322-2326). This is the channel our CC/PC control targets. |
| RX CH RHYTHM | 1-16 | 10 (blocks 2327-2328, "1-10-16") | Receive channel for Note messages that play the rhythm. |
| RX CH VOICE | 1-16 | not preserved in extraction (verify against device) | Receive channel for Note messages used by the HARMONIST and VOCODER effects (blocks 2330-2333). |
| TX CH | 1-16, RX CTL | RX CTL when set to "RX CTL" | MIDI transmit channel. "RX CTL" makes TX equal to the RX CTL channel (blocks 2334-2337). |
| SYNC CLOCK | AUTO, INTERNAL, MIDI, USB (AUTO) | AUTO | Tempo clock sync source. AUTO uses internal tempo but slaves to MIDI clock when present; priority MIDI > USB > internal. INTERNAL never slaves. MIDI slaves to MIDI IN. USB slaves to USB (blocks 2338-2353). |
| SYNC OUT | OFF, ON | (see note) | Whether MIDI clock is transmitted (blocks 2354-2356). |
| SYNC START | OFF, ALL, RHYTHM | OFF | What starts on receipt of a MIDI Start: OFF = no sync start; ALL = track + rhythm; RHYTHM = rhythm only (blocks 2357-2364). |
| PC OUT | OFF, ON | (see note) | Whether Program Change messages are transmitted (blocks 2365-2368). |
| THRU (MIDI IN / USB IN) | OFF, MIDI OUT, USB OUT, USB & MIDI | (see note) | Re-output routing for messages received at MIDI IN or USB (blocks 2369-2380). |

Channel-listening summary (what to send where):
- Memory switch (Program Change): RX CTL channel.
- Function control (CC into the Assign system): RX CTL channel.
- Tempo slave (MIDI clock, Start/Stop/Continue): no channel (system real-time); gated by
  SYNC CLOCK and SYNC START.
- Rhythm-trigger notes: RX RHYTHM channel (default 10).
- HARMONIST / VOCODER notes: RX VOICE channel.

Defaults not preserved in the text extraction (RX CTL CH, RX VOICE CH, SYNC OUT,
PC OUT, THRU) should be confirmed on the device or in the PDF before hardcoding. The
extraction's bold-face default markers were lost for these rows.

---

## 5. Note-message control

Two distinct note paths, on two distinct RX channels:

1. Rhythm trigger, RX RHYTHM channel (default 10). Note messages on this channel play
   the rhythm (blocks 2328-2329). The OUTPUT/ROUTING RHYTHM OUT = LOOP mode explicitly
   lets you "perform loops while using the note messages from an external MIDI device to
   trigger the rhythm" (blocks 801-802). No note-number-to-drum-voice map is given in
   this parameter guide. Note range: NOT SPECIFIED in this document.

2. HARMONIST / VOCODER pitch, RX VOICE channel. Note messages on the VOICE channel feed
   the HARMONIST and VOCODER effects (blocks 2330-2333). The HARMONIST "adds harmony
   based on the MIDI note messages received (chords and chord progressions)" (blocks
   3256-3258; HRM MODE HYBRID/AUTO at 3283-3292 governs how the received chords are
   used). The VOCODER (OSC VOC variant) "creates a vocoder sound based on the MIDI note
   messages received" (blocks 3345-3346), pitching the carrier oscillator by received
   notes. Note range: NOT SPECIFIED in this document.

Because no note-number tables are published here, a descriptor's note-play control
should pass raw note numbers/velocities through and document that the mapping (which
note plays which rhythm voice, what note range the harmonizer tracks) is device/patch
dependent and unverifiable over MIDI.

---

## 6. Coordination recipe: "AM4 scene N starts looper track 3"

Target use case: one stomp on the AM4 both changes the AM4 scene and starts/stops an
RC-505mk2 loop track. This is a two-write pairing across two independent MIDI paths that
meet at a user-configured Assign.

Setup (once, by the user, on the RC-505mk2):
1. Set RX CTL CH on the RC-505mk2 to a known channel (say channel 1). The AM4 must
   transmit its scene-linked CC on that same channel.
2. In the target memory, configure an Assign: SW = ON, SOURCE = `MIDI CC#K`,
   SOURCE MODE per taste (TOGGLE for press-on/press-off, MOMENT for hold),
   TARGET = `TRK3 REC/PLY` (or `TRK3 PLY/STP` if you want play/stop rather than
   record-arm), ACT LO = 0, ACT HI = 127, TARGET MIN/MAX default.
3. Write the memory so the Assign persists (blocks 1843-1844).

Runtime:
- AM4 scene change transmits CC number K on the RC-505mk2's RX CTL channel.
- RC-505mk2 receives CC K, looks up its loaded memory's Assign table, finds
  SOURCE = MIDI CC#K to TARGET = TRK3 REC/PLY, and toggles track 3.

Our server's role is only the first write (send CC K on the RX CTL channel). It cannot
confirm the Assign exists or that track 3 responded (no read path). The pairing is only
as reliable as the user's device-side Assign configuration and which memory is loaded.

### RECOMMENDED DEFAULT ASSIGN MAP (OUR PROPOSAL, not from the device)

This is a suggested convention, NOT a factory chart. The RC-505mk2 has no default
CC map. If the user configures these Assigns once (in each memory they perform with, or
in a template memory they copy), our named descriptor controls will line up predictably.
All CC numbers are within the Assign-source-legal ranges (1-31 and 64-95). Chosen to
avoid the common sustain/soft/sostenuto pedal CCs (64/66/67) and to sit in a compact
block.

| Proposed CC# | Suggested TARGET | Named control |
|---|---|---|
| CC#20 | `TRK1-5 REC/PLY` (track 1) | rec_play_trk1 |
| CC#21 | `TRK1-5 REC/PLY` (track 2) | rec_play_trk2 |
| CC#22 | `TRK1-5 REC/PLY` (track 3) | rec_play_trk3 |
| CC#23 | `TRK1-5 REC/PLY` (track 4) | rec_play_trk4 |
| CC#24 | `TRK1-5 REC/PLY` (track 5) | rec_play_trk5 |
| CC#25 | `TRK1-5 STOP` (track 1) | stop_trk1 |
| CC#26 | `TRK1-5 STOP` (track 2) | stop_trk2 |
| CC#27 | `TRK1-5 STOP` (track 3) | stop_trk3 |
| CC#28 | `TRK1-5 STOP` (track 4) | stop_trk4 |
| CC#29 | `TRK1-5 STOP` (track 5) | stop_trk5 |
| CC#30 | `ALL ST/STP` | all_start_stop |
| CC#31 | `TAP TEMPO` | tap_tempo |
| CC#85 | `RHYTHM START` | rhythm_start |
| CC#86 | `RHYTHM STOP` | rhythm_stop |
| CC#87 | `RHYTHM ST/STP` | rhythm_start_stop |
| CC#88 | `CUR.TRK LEVEL` (0-200) | current_track_level |

Each Assign uses SOURCE MODE = MOMENT for the momentary transport targets (REC/PLY,
STOP, ALL ST/STP, RHYTHM START/STOP) so a single CC pulse acts as a trigger, and a
continuous CC (0-127) for `CUR.TRK LEVEL` mapped to TARGET MIN 0 / TARGET MAX 200. The
user is free to renumber; the descriptor should let the CC number per named control be
overridden in config, because the device side is user-owned.

---

## 7. Descriptor design implications (`packages/rc-505`, generic-MIDI tier)

Transport: standard USB MIDI (class-compliant; the RC-505mk2 is a normal USB MIDI device,
unlike the Fractal FM3's serial path). No SysEx codec, no `fractal-midi`-style wire
builders. This is a generic-MIDI-tier descriptor: it composes existing generic
primitives (`send_cc`, `send_program_change`, `send_clock_start/continue/stop`,
`send_note`), not a bespoke parser/writer.

Named controls the descriptor should expose (each resolves to "send CC#K on the RX CTL
channel," with K user-overridable per the Section 6 map):
- Per-track: `rec_play_trkN`, `stop_trkN`, and optionally `clear_trkN`,
  `reverse_trkN`, `undo_redo_trkN`, `level_trkN` for N in 1..5.
- Current track: `current_track_rec_play`, `current_track_stop`,
  `current_track_level`, `current_track_inc`, `current_track_dec`.
- Global transport: `all_start_stop`, `tap_tempo`, `tempo`.
- Rhythm: `rhythm_start`, `rhythm_stop`, `rhythm_start_stop`, `rhythm_level`,
  `rhythm_variation`, `rhythm_kit`.
- Mixer/output: `loop_level`, `master_level`, `main_level`, `sub1_level`,
  `sub2_level`, `phones_level`, mic/inst mutes and levels, EQ on/off toggles.
- Input FX / Track FX: on/off, type inc/dec, param 1-4, and sequence controls, as
  thin named CC controls if the user wants FX-mapped Assigns.

Non-CC controls:
- Memory (preset) switch: Program Change on the RX CTL channel (`send_program_change`).
  **CONFIRMED on-device 2026-07-07: the mapping is 0-indexed - `PC (M-1)` selects
  memory M** (sent PC 8 on ch 5 -> unit displayed Memory 9; PC 0 -> Memory 1). So
  memory 1 = PC 0 ... memory 99 = PC 98. (Subject to the device's MEMORY EXT MIN/MAX
  range if narrowed; default range accepted the test.) No Bank Select needed (99
  memories). NOTE: whether re-sending the CURRENTLY-loaded memory's PC reloads it
  (stopping playing tracks) or is a no-op is NOT yet confirmed - matters for where the
  AM4 memory-select PC is placed (entry scene vs every scene).
- Tempo slave: `send_clock_start` / `send_clock_continue` / `send_clock_stop` plus a
  clock stream; effective only when the device's SYNC CLOCK is AUTO/MIDI/USB and, for
  transport-linked start, SYNC START is ALL or RHYTHM.
- Rhythm trigger and HARMONIST/VOCODER: `send_note` on the RX RHYTHM channel (default
  10) and the RX VOICE channel respectively; note maps are device/patch dependent and
  undocumented.

Read/verify: IMPOSSIBLE per capability. There is no SysEx, no parameter read, no Assign
read. The descriptor has no read-before-write fingerprint and no post-write echo. It
uses send-and-return like the other generic-MIDI primitives: the tool call succeeds when
the bytes are transmitted, and correctness depends entirely on (a) the user's device-side
Assign configuration matching the descriptor's CC map and (b) the intended memory being
loaded. Every RC-505mk2 control response should state, in its description, that the
result cannot be confirmed over MIDI and that the matching Assign must exist on the
loaded memory.

---

## Accuracy flags (verify against device / PDF)

- RX CTL CH, RX VOICE CH, SYNC OUT, PC OUT, and THRU default values were not preserved
  by the text extraction (bold markers lost). Only RX RHYTHM CH default (10) survived.
  The task brief's "RX VOICE default 10" appears to be a conflation with RX RHYTHM;
  the doc bolds 10 for RHYTHM, and VOICE shows only "1-16." Confirm VOICE default on
  device.
- `INST1-L, R LEVE (*6)` is truncated in the source (blocks 2215); the sibling entries
  read `LEVEL`. Treat as `INST1-L, R LEVEL` but flagged.
- `TRK 1-5 FADER/1SHOT/PAN/FX/SPEED` are labeled `TRK 1-5` but explained as "currently
  selected track" (blocks 2192-2200). Effective per-track vs current-track scope needs
  device confirmation.
- No note-number ranges are published for rhythm trigger or HARMONIST/VOCODER; both
  marked NOT SPECIFIED.
- PDF page rendering was unavailable in this environment (poppler not installed), so
  garbled-in-both-extractions cases could not be disambiguated against the PDF image.
  The blocks extraction was clean for the full TARGET/SOURCE/MIDI tables, so no PDF
  fallback was needed for those; only the lost bold-default markers and the two string
  flags above remain open.
