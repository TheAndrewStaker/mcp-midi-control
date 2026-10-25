# MPC One G2 evaluation: is it an objective upgrade over the Circuit Tracks?

Handoff for a Claude Code session. Goal: verify every claim below as far as
possible **before** the maintainer buys an Akai MPC One G2, then run the
day-one hardware tests inside the retailer's return window.

Research done 2026-10-24/25 (claude.ai session). Primary source for MPC
behaviour: **MPC Standalone OS User Guide v3.10** (528 pages, supplied by the
maintainer; page numbers below are the printed page numbers). Everything else
is cited inline.

## How to use this document

1. Read the claim tables. Every row has a status:
   - **VERIFIED**: stated by a primary source (Akai manual, Akai support,
     release notes, our own repo's hardware-confirmed notes).
   - **VERIFIED-2ND**: stated by a reputable secondary source (review,
     retailer spec sheet, maintained OSS repo), not by the manufacturer.
   - **INFERRED**: follows from verified facts but nobody states it directly.
   - **UNVERIFIED**: plausible, no source found. Must be tested.
   - **RISK**: verified downside or known problem.
2. Phase 0 (no hardware) work can start immediately: see "Phase 0".
3. Phase 1 tests need the unit. Run them within the return window and record
   results in the "Results" column of the scorecard.
4. Do not upgrade the One G2 past MPC OS 3.9.1 until the firmware decision in
   section I is made (it is irreversible in practice for root access).

## The decision

The MPC One G2 replaces the **Novation Circuit Tracks** as sequencer + sound
source. It does **not** replace the **RC-505mkII** as the live looper (see C).
Target rig:

```
Hydrasynth L/Mono out --> MPC Input 1 \
MicroFreak out ---------> MPC Input 2  > MPC Main L/R --> RC-505mkII INST IN 1 (L/R)
AM4 Main L/R -------------------------------------------> RC-505mkII INST IN 2 (L/R)
Mic -> VE-500 XLR out ----------------------------------> RC-505mkII MIC IN
RC-505mkII Main --> PA / monitors

MPC DIN MIDI Out --> MIDI Solutions Quadra Thru (1 in, 4 out)
   Out 1 RC-505mkII (clock + start/stop) | Out 2 Hydrasynth | Out 3 MicroFreak | Out 4 spare (VE-500 or AM4)
```

It is an objective upgrade only if the scorecard at the end passes.

**Second goal (added 2026-10-25):** the maintainer is also weighing an Ableton
Push 2 or Push 3. He prefers working DAW-less, finds the Push 3 Standalone
(US$1,999) too expensive and too big, and would rather have one device that
(a) works standalone and (b) controls Ableton Live well enough to stand in
for a Push 2. Sections J and K cover Ableton control and the Ableton sync
automation Claude Code could build. The Claude Code agent should treat
"how close does the One G2 get to a Push 2 in Live?" as an open research
question, not a settled one.

---

## A. Product facts

| # | Claim | Status | Source |
|---|---|---|---|
| A1 | MPC One G2 announced/available 2026-06-18, US$799 / £729 / €849 | VERIFIED-2ND | [Sound On Sound](https://www.soundonsound.com/news/akai-pros-mpc-one-mpc-key-37-get-g2-upgrade), [MusicTech](https://musictech.com/news/gear/akai-mpc-one-g2-mpc-key-37-g2/) |
| A2 | 8-core CPU, 4 GB RAM, 64 GB storage, 7" touchscreen, 16 pressure pads, 4 touch Q-Links | VERIFIED | [Akai One G2 FAQ](https://support.inmusicstore.com/en/support/solutions/articles/69000879145-mpc-one-g2-frequently-asked-questions) |
| A3 | 16 stereo audio tracks, 32 plugin instances, 256 voices | VERIFIED-2ND | SOS (A1) |
| A4 | I/O: 2 balanced 1/4" TRS line inputs + Rec Vol knob, 2 line outs, 1/8" phones, 5-pin MIDI In + Out (no Thru), 8 CV/gate on 4 TRS jacks, USB-C, USB-A, SD slot | VERIFIED | Manual p.363-364 (One G2 front/rear panel) |
| A5 | **No** hi-Z instrument input, no mic preamp, no phantom power, no Line/Inst switch on the One G2 | VERIFIED | Manual p.364 lists only TRS line inputs + Rec Vol; Akai says single-coil guitars may need a preamp ([Akai guitar article](https://support.akaipro.com/en/support/solutions/articles/69000857290-mpc-standalone-how-to-record-a-guitar)). The Line/Inst and +48V text in the Looper chapter (p.338) applies to other models |
| A6 | No battery; no footswitch jack | VERIFIED | Manual p.104: only Live/Live II use battery; footswitch prefs are "MPC X/X SE only" (p.61) |
| A7 | USB-C works as device or host; 24-ch USB audio in standalone; class-compliant interfaces limited to 44.1 kHz | VERIFIED | Akai FAQ; [3.9 release notes](https://cdn.inmusicbrands.com/Software/15JM26PSBC/MPC%203.9%20Release%20Notes.pdf) |
| A8 | Clip launching (Clip Matrix) and Ableton project **import** need the paid **MPC Pro Pack** (~US$200; half price for One G2 / Key 37 G2 owners) | VERIFIED (Pro Pack required) / VERIFIED-2ND (price) | Manual p.485, p.527; [Akai Pro Pack](https://support.akaipro.com/support/solutions/articles/69000873513-akai-pro-mpc-series-mpc-pro-pack); [MPC-Forums Aug 2026](https://www.mpc-forums.com/viewtopic.php?p=1906530) |
| A9 | Known complaints: learning curve and menu depth (Audiofanzine 9/10), Wi-Fi password failures, confusing USB-C role setup | RISK | [Audiofanzine](https://en.audiofanzine.com/sampling-sequencer/akai/mpc-one-g2/editorial/reviews/akai-mpc-one-g2-review.html), Akai FAQ, [Akai troubleshooting](https://support.akaipro.com/en/support/solutions/articles/69000880590-mpc-one-g2-troubleshooting-guide) |
| A10 | Boot time on the G2 | UNVERIFIED | No measurement found. Time it on day one (T-HW-1) |

## B. Sequencing vs the Circuit Tracks (the core reason to buy)

| # | Claim | Status | Source |
|---|---|---|---|
| B1 | Circuit Tracks: 8 patterns x up to 32 steps per track; 16 steps default; chains must be consecutive; ~16 bars of unique material per track per project | VERIFIED | [Novation user guide](https://userguides.novationmusic.com/hc/en-gb/articles/26207128061458-Using-Circuit-Tracks-Synths-MIDI-Tracks-and-Drums); our `packages/circuit-tracks/src/ncs/format.ts`, `docs/CIRCUIT-TRACKS-SEQUENCING.md` |
| B2 | Our MCP must chain patterns for >32 steps, which consumes pattern slots and loses per-channel pattern switching | VERIFIED | `packages/circuit-tracks/src/descriptor/writer.ts` arrangement logic; Circuit has no pattern select over MIDI (`agentGuidance.ts` `no_pattern_selection_over_midi`) |
| B3 | MPC sequence length is set with the **Bars** field; a 64-step idea = a 4-bar sequence, one object | VERIFIED | Manual p.26, p.109 |
| B4 | Max sequence length 999 bars | VERIFIED-2ND | [MPC-Forums 2022](https://www.mpc-forums.com/viewtopic.php?p=1847354); not stated in the v3.10 manual. Test T-SEQ-1 |
| B5 | 128 sequences per project, each with own tempo and time signature | VERIFIED-2ND | [SOS MPC basics](https://www.soundonsound.com/node/4921455); community schema shows per-sequence `bpm` and `timeSignatureTrack` |
| B6 | Per-track independent length (e.g. 1-bar hats under a 4-bar bass) | VERIFIED | Manual p.116, p.177 |
| B7 | Grid View shows all pads (drum) or a piano roll (melodic) for the whole sequence, pinch zoom | VERIFIED | Manual p.165 |
| B8 | **Step Sequencer still pages:** 16 pads = 16 steps = 1 bar, one pad/sound at a time; Bar -/+ to move; 1/32 uses two pad banks | VERIFIED | Manual p.26, p.177-178. The One G2 has no dedicated step buttons (Live III/XL do) |
| B9 | Sequences, projects and tracks are named on screen; Next Sequence mode shows sequence names on pads | VERIFIED | Manual p.316 |
| B10 | Live part switching: Next Sequence mode, switch at end of sequence / Next Bar / Sudden | VERIFIED | Manual p.316-317 |
| B11 | Incoming Program Change can select a Sequence or a Track (Preferences) | VERIFIED | Manual p.61 ("Program Change: ... a Sequence or Track") |
| B12 | Song Mode chains sequences; Arrange mode timeline; "Convert Song to Sequence" | VERIFIED (Song/Arrange) / VERIFIED-2ND (convert) | Manual p.326 (TOC), p.163-164; 3.9 release notes |
| B13 | Note events stored at 960 PPQ with velocity, length, probability, ratchet | VERIFIED-2ND | [kurtjcu/MPC-project-file-definitions](https://github.com/kurtjcu/MPC-project-file-definitions) (firmware 3.7, 18 files) |
| B14 | MPC "gets to a loop" slower than the Circuit (instant power-on, no menus) | INFERRED | Reviews of menu depth (A9); Circuit has no screen/menus. Measure in T-SEQ-3 |

## C. Looping (why the RC-505mkII stays)

| # | Claim | Status | Source |
|---|---|---|---|
| C1 | Looper mode: Input source (1, 2, 1+2, resample), mono/stereo, insert FX (printed), Monitor, threshold start (Sync off), **Bars** length, Sync to transport, Record To Play/Overdub, Overdub vs Replace, Reverse, Clear, Export to Track / Pad | VERIFIED | Manual p.338-341 |
| C2 | No undo of a single Looper overdub | VERIFIED-2ND | [MPC-Forums 2020](https://www.mpc-forums.com/viewtopic.php?p=1785260); manual describes none. Test T-LOOP-1 |
| C3 | Looper is touchscreen-driven; no MIDI/footswitch control of Looper documented | INFERRED | Manual p.338-341 lists only on-screen controls; MIDI Learn targets exclude it (D2) |
| C4 | Clip Matrix: Record Launch modes, Clip Record To = Overdub or Play, Fixed Length Recording | VERIFIED | Manual p.489-490 |
| C5 | Forum consensus: MPC is not a good live looper | VERIFIED-2ND | [MPC-Forums 2026](https://www.mpc-forums.com/viewtopic.php?p=1903503), [2024](https://www.mpc-forums.com/viewtopic.php?p=1887989) |

## D. External control (footswitch, MIDI)

| # | Claim | Status | Source |
|---|---|---|---|
| D1 | Boss FS-5U cannot plug into the One G2 (no footswitch jack) | VERIFIED | A6 |
| D2 | MIDI Learn targets: mixer (volume/pan/mute/solo for tracks, returns, submixes, main), pad params, track params, insert FX params. Not transport, not clip launch | VERIFIED | Manual p.318-319 |
| D3 | MMC received: Deferred Play, Locate Zero + Play, Stop, Record Strobe (= Rec), Pause, Locate | VERIFIED | Manual p.454 |
| D4 | MMC Record and Overdub are the same message (pedal cannot choose) | VERIFIED (MPC sends the same Record Strobe for both, p.454) | Manual p.454 |
| D5 | Clips cannot be launched from external MIDI in standalone OS 3.x | VERIFIED-2ND | [MPC-Forums Oct 2025](https://www.mpc-forums.com/viewtopic.php?p=1897265) |
| D6 | RC-505mkII can map an FS-5U on its CTL jack to transmit a MIDI CC out of its MIDI OUT; the MPC can MIDI-Learn that CC to a track mute | VERIFIED (RC-505 side, repo) / INFERRED (end to end) | `docs/manuals/other-gear/RC-505mk2-MIDI-CONTROL-SYNTHESIS.md` (`MIDI CC#01-31` / `#64-127` assign targets); D2. Test T-CTL-2 |
| D7 | Footswitch-triggered fixed-length clip record that auto-plays (MMC Record Strobe + Clip Matrix "Record or Clip" + Fixed Length + Record To Play) | UNVERIFIED | Manual does not say MMC drives Clip Matrix recording. Test T-CTL-3 (needs Pro Pack) |

## E. Audio I/O and routing

| # | Claim | Status | Source |
|---|---|---|---|
| E1 | Synths at line level connect straight to MPC inputs | VERIFIED | Hydrasynth Explorer: 2 balanced 1/4" outs L/Mono + R ([AMS spec](https://www.americanmusical.com/p/asm-hydrasynth-explorer-synthesizer)); MicroFreak: 1/4" balanced line out ([Arturia](https://www.arturia.com/products/hardware-synths/microfreak/overview)) |
| E2 | Audio tracks can take a single input (Input 1 or Input 2) | VERIFIED | Manual p.141 ("a pair of inputs (Input 1,2) or a single input (Input 1, Input 2)") |
| E3 | Audio track Monitor **In** monitors the input whether armed or not, so the synths pass through the MPC mixer/FX live | VERIFIED | Manual p.141 |
| E4 | Two mono synths can be recorded in one pass on two audio tracks | INFERRED | E2 + multi-arm (manual p.490 Record Arm Multi). Test T-AUD-2 |
| E5 | Hydrasynth goes in mono when both synths share the two inputs | VERIFIED (consequence of A4) | A4 |
| E6 | Input monitoring latency through the MPC | UNVERIFIED | Not documented. Measure in T-AUD-1 |
| E7 | RC-505mkII inputs: MIC IN 1/2 XLR with 48V phantom, INST IN 1/2 jacks; MAIN OUT, SUB OUT 1/2 | VERIFIED-2ND | [Andertons spec](https://www.andertons.co.uk/boss-rc-505mkii-flagship-tabletop-looper-with-5-tracks-mic-inputs). Stereo L/R on each INST IN is **UNVERIFIED** (retailer text inconsistent). Check Boss owner's manual |
| E8 | VE-500 outputs: 2 XLR, level selectable -40 dBu or -10 dBu; DIN MIDI In and USB-MIDI, no DIN MIDI Out | VERIFIED-2ND | [B&H spec](https://www.bhphotovideo.com/c/product/1432339-REG/boss_ve_500_vocal_performer_pedal.html) |
| E9 | AM4: stereo 1/4" main outs, 3.5 mm TRS MIDI In/Out, USB-C audio | VERIFIED-2ND | [Thomann](https://www.thomannmusic.com/fractal_audio_am4_amp_modeller.htm) |
| E10 | Guitar direct into MPC is a poor match (line input loads passive pickups); go guitar -> AM4 -> RC-505 as planned | VERIFIED (level) / INFERRED (tone loss) | Akai guitar article (A5) |

## F. MIDI routing (incl. the Quadra Thru question)

| # | Claim | Status | Source |
|---|---|---|---|
| F1 | One DIN MIDI cable carries all 16 channels plus clock; MPC output ports have per-port Track and Sync enables | VERIFIED | MIDI spec; manual p.60 (Output Ports: Track, Sync); [Akai external gear article](https://support.akaipro.com/en/support/solutions/articles/69000868287-akai-pro-mpc-series-connecting-the-mpc-to-external-gear) (on the One/One+ the DIN port is named "MPC") |
| F2 | MIDI Solutions Quadra Thru copies **all** messages at its input to all 4 outputs (so clock reaches every output) | VERIFIED | [Quadra Thru manual](https://c3.zzounds.com/media/quadthru-aeb4695b1a59d452f5ace689216ca5cd.pdf) ("All MIDI messages appearing at the Quadra Thru's MIDI input are sent to its MIDI Thru outputs"). Clock is not named but is a MIDI message |
| F3 | Quadra Thru is MIDI-powered (no supply) and draws from the feeding MIDI Out; steady on/off LED flash = insufficient power; optional power adapter exists | VERIFIED | Quadra manual; [Eventide H9 failure report](https://www.eventideaudio.com/?p=112592) |
| F4 | **The One G2's DIN MIDI Out powers a Quadra Thru** | **UNVERIFIED** | No report found. An MPC-Forums thread "MPC Live and Midi Solutions Quad Thru compatibility" exists but could not be read: <https://www.mpc-forums.com/viewtopic.php?f=48&t=189376>. **Read it**, then test T-MIDI-1. Fallback: Quadra power adapter, or a powered thru box |
| F5 | With 5 MIDI destinations (Hydrasynth, MicroFreak, RC-505mkII, VE-500, AM4) the Quadra's 4 outputs leave one short; clock is not "dropped", the 5th device is just unconnected | VERIFIED (count) | Device list from maintainer |
| F6 | RC-505mkII: SYNC CLOCK AUTO/INTERNAL/MIDI/USB, SYNC START, and THRU routing MIDI IN -> MIDI OUT (so it can feed a 5th device) | VERIFIED | `docs/manuals/other-gear/RC-505mk2-MIDI-CONTROL-SYNTHESIS.md` lines on SYNC CLOCK / SYNC START / THRU (from the Boss parameter guide) |
| F7 | MicroFreak has a MIDI Thru setting that relays to its DIN out (hardware-confirmed in our repo) | VERIFIED | `docs/contributing/devices/microfreak.md` (midi_thru, output_dest; DIN relay test 2026-07-28) |
| F8 | Hydrasynth Explorer MIDI Out can be set to Thru | UNVERIFIED | Not found in this session. Check the Hydrasynth owner's manual |
| F9 | Hydrasynth, MicroFreak, AM4 use 3.5 mm TRS MIDI; use each unit's own adapter (TRS wiring varies) | VERIFIED-2ND (MicroFreak, AM4) / UNVERIFIED (Hydrasynth Explorer connector type) | Arturia page; Thomann; check Hydrasynth manual |
| F10 | The One G2 sends MIDI **out** to class-compliant USB synths on its USB-A host port (via a powered hub) | **UNVERIFIED (plausible)** | Manual p.60 says newly discovered MIDI devices can be enabled as track inputs **or outputs**; One G2 panel text only says "standard MIDI controller" (p.364). 2019 reports said MPC USB host exposed no MIDI outs ([MPC-Forums](https://www.mpc-forums.com/viewtopic.php?p=1759761)), likely outdated. Test T-MIDI-3 |
| F11 | Each MPC MIDI track can send a Program Change to recall a patch on the external synth | VERIFIED | Manual p.51 (MIDI track Program Change), p.116 (Program Ch field) |
| F12 | Keep the MPC as clock master: audio recording is disabled while the MPC **receives** MIDI clock | VERIFIED | Manual p.61 |

## G. Sharing with an Ableton user (Billy)

| # | Claim | Status | Source |
|---|---|---|---|
| G1 | Save > Ableton Live Set: Export MIDI As (Audio or MIDI), Include Volume/Pan, Bypass Track Effects Plugins, Audio Tail, bit depth, sample rate | VERIFIED | Manual p.67, p.164 |
| G2 | Audio mode renders drum, keygroup and plugin tracks as audio ("to preserve the sound of the instruments"); MIDI mode exports notes only, no plugin/patch data | VERIFIED (manual) / VERIFIED-2ND (no patch data: [MPC-Forums](https://www.mpc-forums.com/viewtopic.php?p=1862255)) | Manual p.67, p.164 |
| G3 | The export lands as a **clip row in Session view**; copy scene 1 to Arrangement to rebuild the timeline | VERIFIED (as of 3.4.1) | [3.4.1 release notes](https://cdn.inmusicbrands.com/akai/MPC3-NI/MPC%203.4.1%20Firmware%20Update%20Release%20Notes.pdf). Recheck on 3.10 (T-ALS-1) |
| G4 | MIDI tracks to external synths are a distinct track type (type 4, no sound engine) | VERIFIED-2ND | kurtjcu schema `02-track-types.md` |
| G5 | What an external-MIDI track becomes under "Audio": silent clip, omitted, or MIDI clip | **UNVERIFIED** | Nothing found. Forum thread "MPC3 Ableton Live Set Export just doesn't work?" unreadable: <https://www.mpc-forums.com/viewtopic.php?f=48&t=218748>. Test T-ALS-1 |
| G6 | "Export MIDI As" appears to be one setting for the whole export (cannot mix audio for internal + MIDI for external in one pass) | INFERRED | Manual wording p.67, p.164. Test T-ALS-1 |
| G7 | Workaround A: record external synths onto MPC audio tracks, then one Audio export. Workaround B: two exports (Audio, then MIDI), order irrelevant | INFERRED | G2 + E3/E4 |
| G8 | Save > All Tracks / Track as MIDI/Pattern writes .mid files | VERIFIED | Manual p.66 |
| G9 | Live Lite caps 8 tracks / Intro 16 | VERIFIED | [Ableton export docs](https://ableton.github.io/export/) |
| G10 | Minimum Live version that opens an MPC-exported .als | UNVERIFIED | Test with the collaborator's Live version |
| G11 | Getting files off: save to SD/USB stick, or Controller Mode mounts storage on the computer over USB (One/Key 37: SD mounts, USB stick in the MPC's USB-A does not) | VERIFIED | [Akai transfer article](https://support.akaipro.com/en/support/solutions/articles/69000824436-akai-pro-mpc-series-transferring-content-to-and-from-the-mpc-via-a-computer); manual p.364 |
| G12 | No Wi-Fi file sharing | INFERRED | Manual Wi-Fi section (p.59) covers updates, Splice, Link, network driver only |

## H. Programmability from our MCP server (no SysEx write API)

| # | Claim | Status | Source |
|---|---|---|---|
| H1 | No documented SysEx API for writing sequences; no remote "load project" command | VERIFIED (absence in manual) | Manual (no SysEx section beyond MIDI basics); community has none |
| H2 | `.xpj` (MPC 3.4+) = gzip, 5-line `ACVS` header, JSON with readable field names | VERIFIED-2ND | kurtjcu schema `00-format-reference.md`; [MPC-Forums](https://www.mpc-forums.com/viewtopic.php?p=1886903) |
| H3 | `.mpcpattern` = simple JSON note list, 960 PPQ; loads onto the next unused track of the current sequence | VERIFIED-2ND | [codmpm/medianmpc](https://github.com/codmpm/medianmpc) (tested 3.9.1); [MPC-Samples](https://www.mpc-samples.com/article/using-mpc-midi-patterns) |
| H4 | Standard .mid loads as a new sequence | VERIFIED-2ND | MPC-Samples; [MPC-Forums Nov 2025](https://www.mpc-forums.com/viewtopic.php?p=1898306). Not stated in the v3.10 manual. Test T-FILE-2 |
| H5 | "User Auto Load File" loads a chosen .xpj/.xpm at boot | VERIFIED | Manual p.63 |
| H6 | MPC 3 Desktop (Win/Mac) runs the same engine and saves .xpj; redeemable for registered hardware; free MPC 3 Beats tier | VERIFIED | [Akai MPC 3 Desktop FAQ](https://support.akaipro.com/en/support/solutions/articles/69000869156-akai-pro-mpc-3-desktop-public-beta-faq) |
| H7 | Desktop-saved .xpj loads on standalone (header line 5 differs: `Linux` vs desktop platform) | INFERRED | Akai transfer article implies project interchange; kurtjcu notes the platform line. Test T-FILE-3 |
| H8 | Live route: MCP streams notes over USB-MIDI into an armed MPC track with MMC Record + Play | INFERRED | D3, A7. Test T-MCP-1 |
| H9 | Loading a .mid creates a **new sequence**; type 0 and type 1 both load; a multi-track file lands on separate tracks; move events into an existing sequence with Copy Events | VERIFIED-2ND (MPC 2.x/3.x era reports) | [MPC-Forums 2021-22](https://www.mpc-forums.com/viewtopic.php?p=1832074), [2022](https://www.mpc-forums.com/viewtopic.php?t=213689&p=1846059) |
| H10 | 3.9 notes say "Importing a MIDI file into a sequence or clip should import its time signature", suggesting import into an existing sequence or clip may now be possible | VERIFIED (wording) / UNVERIFIED (behaviour) | [3.9 release notes](https://cdn.inmusicbrands.com/Software/15JM26PSBC/MPC%203.9%20Release%20Notes.pdf). Test T-FILE-4 |
| H11 | In MPC 3 imported .mid parts arrive as **MIDI tracks**; route them with MIDI Send to a drum/keygroup/plugin track, or set the output port/channel to an external synth | VERIFIED-2ND | [MPC-Forums Jan 2026 (3.6)](https://www.mpc-forums.com/viewtopic.php?p=1900085) |
| H12 | 3.6 bug: imported MIDI only played 2 bars; workaround copy the track with events onto itself at bar 1 | RISK | Same thread. Check on 3.10 (T-FILE-4) |
| H13 | Imports carry volume, pan, Program Change and CC events that may need cleaning | VERIFIED-2ND | [MPC-Forums 2021-22](https://www.mpc-forums.com/viewtopic.php?p=1832074) |
| H14 | Whether the tempo meta event is imported | UNVERIFIED | Not documented. Test T-FILE-4 |
| H15 | Drum programs play by **pad note map**; presets Chromatic C1 (A01 = note 36 ascending, current default), Chromatic C-2, Classic MPC; per track/program, no global GM preset; notes not in the map are silent | VERIFIED (manual p.125) / VERIFIED-2ND (default and no GM preset: [MPC-Forums 2022](https://www.mpc-forums.com/viewtopic.php?p=1852125), [Akai remap article](https://support.akaipro.com/en/support/solutions/articles/69000867733-akai-pro-mpc-series-how-to-remap-the-mpc-pads)) | |
| H16 | GM drum notes (36 kick, 38 snare, 42 closed hat, 46 open hat) under Chromatic C1 hit pads A01, A03, A07, A11; they only sound right if the kit's samples sit on those pads, otherwise remap the file or the program (a saved GM drum program template works) | INFERRED (arithmetic from H15) / VERIFIED-2ND (template advice) | MPC-Forums 2022 (H15) |
| H17 | Note-name offset: the MPC labels note 36 as C1 (so 60 = C3); our pattern grammar uses c4 = 60. Exchange **numbers**, not names | VERIFIED (MPC: "Chromatic C1" = 36, manual p.125; repo: `docs/CIRCUIT-TRACKS-SEQUENCING.md`) | |
| H18 | Our repo already **parses** SMF (`packages/core/src/protocol-generic/patterns/midiFile.ts`, GM drum mapping, drum map presets) but has no SMF **writer** | VERIFIED (repo) | |

## I. Community, root, firmware (affects future capability)

| # | Claim | Status | Source |
|---|---|---|---|
| I1 | MPC OS has a built-in Linux VST2 host; Open MPC catalog/installer (root needed) | VERIFIED-2ND | [sd88me/mpc-vst-plugins](https://github.com/sd88me/mpc-vst-plugins) (commit 2026-10-25) |
| I2 | Gen2 (One G2, Live III, Key G2) supported with aarch64 builds, confirmed on a Live III 2026-10-23; no Gen2 One G2 report | VERIFIED-2ND | `docs/GEN2.md` in that repo |
| I3 | Root on Gen2 via autorun USB stick on stock 3.9.1; **MPC OS 3.10.0 removes that mechanism** | VERIFIED-2ND | `docs/GEN2.md` (static diff of stock update images) |
| I4 | NAM (Neural Amp Modeler) runs as an MPC standalone VST2 | VERIFIED-2ND | [jacob-sabella/mpc-vst-nam](https://github.com/jacob-sabella/mpc-vst-nam) |
| I5 | TheKikGen/MPC-LiveXplore: SSH images, image tool, autorun hack up to 3.9 | VERIFIED-2ND | [repo](https://github.com/TheKikGen/MPC-LiveXplore) (commit 2026-10-24) |
| I6 | Licensing for our OSS: kurtjcu schema and medianmpc have **no license** (reference only); roger, mpc-keygroup-builder, Open MPC are licensed | VERIFIED (by file listing) | cloned 2026-10-25 |
| I7 | inMusic (Akai's parent) acquired Native Instruments, announced 2026-05-08; Battery/Kontakt libraries do not run on MPC | VERIFIED (deal) / VERIFIED-2ND (libraries) | [inMusic press](https://www.inmusicbrands.com/press/inmusic-native/); [Synth Anatomy](https://synthanatomy.com/2025/01/akai-partners-with-native-instruments-to-bring-new-benefits-to-midi-controllers-and-the-mpc-platform.html) |
| I8 | Which OS version a new One G2 ships with, and whether the Day-1 update is 3.9.x or 3.10 | UNVERIFIED | Akai FAQ says "ships with 3.9, needs Day-1 update". Check the unit's Info page **before** updating |

## J. Controlling Ableton Live (vs Push 2 / Push 3)

| # | Claim | Status | Source |
|---|---|---|---|
| J1 | Live Control Mode is supported on the One G2 over USB-C (no network driver needed); **not** on the original One/One+, Key 37, Key 61 | VERIFIED | Manual p.320 |
| J2 | Requires Ableton Live 10.1.2 or later; Wi-Fi route uses the Akai Network Driver | VERIFIED | Manual p.320-321 |
| J3 | Exact Live MIDI preferences (Control Surface / ports) for the **USB-C** route | UNVERIFIED | Manual setup text describes the network-driver route (port "Akai Network - DAW Control"). Test T-ABL-1 |
| J4 | Switch between standalone MPC and Live Control "without ever stopping playback" | VERIFIED (Akai claim) | Manual p.320. Test T-ABL-5 |
| J5 | Matrix View: 8x8 of Live's Session on screen with Live's names/colours; pads launch clips in a **4x4** focus (16 Level button toggles scene launch); Bank buttons move the focus; Quantize, Delete, Insert Scene, Rec (Arrangement record) | VERIFIED | Manual p.323, p.462-463 |
| J6 | Mixer View: levels, mute (activator), solo, arm, pan, sends, A/B cue | VERIFIED | Manual p.324 |
| J7 | Device Control View: follows Live's "blue hand"; parameter sliders, Device -/+, Bank -/+, Device On; Q-Link banks 1-2 = 8 track volumes, banks 3-4 = current device | VERIFIED | Manual p.325 |
| J8 | Control bar presets Session / Arrangement / Performance: BPM, phase nudge, metronome, follow, position, MIDI arrangement overdub, automation arm, arrangement loop start/length | VERIFIED | Manual p.322 |
| J9 | Buttons in Live Control: Copy (duplicate clip), Erase, Undo/Redo, Tap tempo (Shift: metronome), Rec = Arrangement Record, Overdub = Session Record, Play, Play Start, Stop | VERIFIED | Manual p.462-463 |
| J10 | **Not documented** in Live Control Mode (Push 2 does all of these): playing Live instruments/Drum Racks from the pads with scale/melodic layouts, step-sequencing Live clips, editing clip notes, browsing and loading devices/samples, Simpler slicing, a 64-pad grid, MPE (Push 3) | VERIFIED (absent from manual chapter p.320-325 and control map p.462-463) | Test T-ABL-4 to see what is actually possible |
| J11 | Workarounds for playing Live instruments from the MPC: MIDI Control Mode (custom note/CC per pad, per-pad velocity and poly aftertouch, Q-Links, XY) or a standalone MIDI track routed out USB-C to the computer | VERIFIED (features exist, p.331-332; USB-C carries 32 MIDI channels, Akai FAQ) / INFERRED (that they coexist with Live Control) | Test T-ABL-4 |
| J12 | Ableton Link sync supported (send/receive), Ableton Start/Stop Sync option | VERIFIED | Manual p.55, p.61 |
| J13 | MPC imports Ableton Live sets (.als) with the Pro Pack: Session clips, Arrangement, colours, audio clips with warp/loop, MIDI at 960 PPQ, basic Drum Rack / Impulse to drum kit, Sampler/Simpler to keygroup; plugin instruments become MIDI tracks; requires "Collect All and Save" in Live | VERIFIED | Manual p.527 |
| J14 | Akai positions the G2 as an Ableton bridge ("Ableton Live Control Mode and seamless Ableton project import/export") | VERIFIED | [inMusic G2 press release](https://www.inmusicbrands.com/press/mpc-g2/) |
| J15 | Push 3 Standalone US$1,999, Push 3 controller US$999, upgrade kit US$1,049; standalone has no third-party plugins, ~2 to 2.5 h battery, runs hot, no Arrangement view | VERIFIED-2ND | [SOS Push 3 review](https://www.soundonsound.com/reviews/ableton-push-3); [Push Patterns 2026](https://www.pushpatterns.com/blog/ableton-push-3-standalone-in-2026-is-it-still-worth-buying) |
| J16 | Push 3 controller: 64 MPE pads, 2-in/2-out audio interface, 2 pedal inputs, ~6.8 lb | VERIFIED-2ND | [Equipboard](https://equipboard.com/items/ableton-push-3-controller) |
| J17 | Push 2: discontinued (2015-2022), 64 pads, colour screen, step sequencing, scales; no audio interface; used ~US$300-475 | VERIFIED-2ND | [Equipboard](https://equipboard.com/items/ableton-push-2) |
| J18 | Hands-on reviews comparing MPC G2 Live Control with Push | UNVERIFIED | None found. One review says USB-C "functions reliably as an Ableton Live controller" ([ANR](https://audionewsroom.net/2026/06/akai-mpc-one-g2-and-key-37-g2-a-needed-yet-cynical-upgrade.html)) with no detail. Agent: search YouTube/forums again, ideally for side-by-side videos |

**Working conclusion to test, not a verdict:** the One G2 looks like a capable
Session-view clip launcher, mixer and device-knob controller for Live, plus a
full standalone instrument. On paper it is **not** a Push 2 replacement for
*playing and programming* inside Live (no documented note/drum layouts, step
sequencing or browsing in Live Control Mode, 16 pads vs 64). T-ABL-4 and
T-ABL-8 decide how much of that gap MIDI Control Mode closes. The cheapest
Push-class alternative for comparison is a used Push 2 (~US$300-475)
alongside the MPC, versus a Push 3 controller (US$999) or Standalone
(US$1,999).

## K. MPC to Ableton sync: automation Claude Code could build

These are design proposals backed by the claims above. None is built.
Ordered by value per effort. Each needs its own fixtures before code
(evidence bar in `CLAUDE.md`).

| # | Automation | What it fixes | Feasibility evidence |
|---|---|---|---|
| K1 | **ALS post-processor:** open the MPC-exported `.als` (Ableton sets are gzipped XML), move the exported Session clip row into the Arrangement at bar 1, keep tempo, track names and colours | G3 (export lands as a single Session row) | G3; the `.als` gzip/XML container is widely documented. Needs a real MPC export as a fixture (T-ALS-1) |
| K2 | **Merge the two exports:** take baked audio tracks from the "Audio" export and the external-synth MIDI tracks from the "MIDI" export, write one `.als` | G5, G6 (one export mode per pass) | Same as K1; depends on T-ALS-1 results |
| K3 | **Rebuild the song structure:** read the MPC `.xpj` (sequence names, bar lengths, BPM; Song Mode order once decoded) and place clips/locators in Live's Arrangement in song order | Export only carries the arrangement / clip row, not Song Mode order | H2, B12; Song Mode is undecoded in the community schema (T-FIX-1 must capture it) |
| K4 | **External synth tracks done right:** on MIDI tracks for Hydrasynth/MicroFreak, insert Live's External Instrument device and name the track after the synth, so the collaborator (or the maintainer) can re-record or replace the part | MIDI tracks arrive with an empty device chain (G2) | Needs `.als` fixture; device XML for External Instrument is standard Live content |
| K5 | **One-command handoff:** with the MPC in Controller Mode, detect the mounted SD card, find the newest export, run K1/K2, zip with samples, copy to a shared folder (Dropbox/Drive), write a short readme (tempo, key, what each track is) | Manual copy/zip steps (G11) | G11; same pattern as the SPD-SX storage tools |
| K6 | **Ableton to MPC direction:** prepare a Live set for MPC import ("Collect All and Save" check, warn on plugin instruments that become empty MIDI tracks, Drum Rack limits) | J13 conversion limits | J13 |
| K7 | **Live session control from Claude:** evaluate existing Ableton MCP servers / remote-script bridges (for example `ahujasid/ableton-mcp`, `ideoforms/AbletonOSC`; not fetched this session) for building or tidying sets through Live's API instead of file edits | Lets an agent create tracks, clips and notes in a running Live | UNVERIFIED: agent should check licenses, Live 12 support and activity before relying on them |
| K8 | **Our MCP server live path:** stream notes into the MPC over USB-MIDI (T-MCP-1) and, separately, send the same pattern grammar to Live via K7, so one description can land on either target | Keeps `apply_pattern` device-neutral | H8 plus existing pattern orchestrator |

---

## Phase 0: before buying (no hardware)

1. **Read the two unreadable forum threads** (F4, G5) through a browser:
   - <https://www.mpc-forums.com/viewtopic.php?f=48&t=189376> (Quadra Thru on MPC)
   - <https://www.mpc-forums.com/viewtopic.php?f=48&t=218748> (ALS export problems)
2. **Install MPC 3 Beats (free) on the ThinkPad** (H6). Using it as a source of test files:
   - Save a blank project, then one change per save (1 note; velocity; length;
     bars 1 -> 4; add a MIDI track routed to an external port; add an audio
     track). Diff the gunzipped JSON. One capture per hypothesis
     (`docs/RE-WORKFLOW.md`).
   - Export each as an Ableton Live Set in Audio and in MIDI mode **if Beats
     allows it**, and inspect the `.als` (gzipped XML) for what the external-MIDI
     track became. This may answer G5/G6 without hardware.
   - Save Track as MIDI and as MPC Pattern; confirm `.mpcpattern` matches the
     medianmpc shape (H3).
   - Check whether the Beats tier limits any of the above; note it.
3. **Prototype a read-only `mpc` inspector** (gunzip + header + JSON) against
   those files. No writer until fixtures from a real 3.10 unit exist.
4. **Confirm the Hydrasynth Explorer MIDI connector type and Thru option**
   from its owner's manual (F8, F9) and the RC-505mkII INST IN stereo layout
   from the Boss owner's manual (E7).
5. **Confirm the retailer's return window** and that opened units are accepted.
6. In a store if possible: time power-on to playable (A10), try Grid View on a
   4-bar drum sequence, try Note Repeat recording, and try Live Control Mode
   next to a Push on a store laptop if they have one set up.
7. **Ableton control research (J18):** find hands-on videos or reviews of
   MPC Live Control Mode (any G2, Live II or X; same feature set) and of a
   Push 2 doing the same tasks. Fill the Push-parity checklist in T-ABL-8
   from evidence where possible.
8. **Evaluate K7 bridges:** check Ableton MCP servers / AbletonOSC for
   license, Live 12 support, last commit, and whether they can create
   Arrangement clips. Decide whether K1-K4 should be file-based or API-based.
9. **Grab a real Ableton `.als`** (any small set) and confirm the gzip/XML
   container and the Session vs Arrangement clip elements, so K1 has a
   reference before the MPC export fixture exists.

## Phase 1: day-one hardware tests (inside the return window)

Record pass/fail and notes for each.

| ID | Test | Pass criteria | Covers |
|---|---|---|---|
| T-HW-1 | Note OS version on the Info page; time cold boot to playable | Version recorded **before** any update; boot time recorded | A10, I8 |
| T-MIDI-1 | MPC DIN Out -> Quadra Thru (no adapter). Watch the Quadra LED | Solid/normal LED, no steady on/off flash; all 4 outs pass notes + clock | F3, F4 |
| T-MIDI-2 | Clock to all: Quadra outs to RC-505mkII (SYNC CLOCK = MIDI, SYNC START = ALL), Hydrasynth, MicroFreak | RC-505 follows MPC tempo and Start/Stop; synth LFO/arp synced | F1, F2, F6 |
| T-MIDI-3 | Powered USB hub on USB-A with Hydrasynth + MicroFreak; check Preferences > MIDI/Sync > Output Ports | Both appear as output ports; a MIDI track on each port plays the synth; Sync sends clock | F10 |
| T-MIDI-4 | Program Change from a MIDI track | Hydrasynth/MicroFreak change patch | F11 |
| T-MIDI-5 | 5th device: RC-505 THRU -> MIDI OUT (or MicroFreak Thru) feeding VE-500/AM4 | 5th device receives notes/PC/clock | F5, F6, F7 |
| T-AUD-1 | Two audio tracks, Input 1 and Input 2, Monitor In | Both synths audible through MPC outs; latency acceptable by ear while playing keys | E2, E3, E6 |
| T-AUD-2 | Arm both audio tracks, record one pass while MIDI tracks play | Two clean mono recordings, in time | E4 |
| T-SEQ-1 | Set a sequence to 64 bars, then try 999 | Accepted; note the real maximum | B4 |
| T-SEQ-2 | Build a 4-bar call/response drum + bass in Grid View; duplicate to Sequence 2; switch live in Next Sequence mode (end / Next Bar / Sudden) | Works without chaining; names visible on pads | B3, B7, B9, B10 |
| T-SEQ-3 | Stopwatch: idea to playing 4-bar beat, MPC vs Circuit, same idea | Record both times. MPC slower is expected; decide if acceptable | B14 |
| T-SEQ-4 | Program Change from computer selects a sequence (Preferences: Program Change = Sequence) | Sequence switches | B11 |
| T-LOOP-1 | Looper: record 4 bars over a beat, overdub twice, look for undo | Confirms no per-overdub undo | C1, C2 |
| T-CTL-1 | MMC from computer (or controller): Play, Stop, Record Strobe | MPC transport responds | D3 |
| T-CTL-2 | FS-5U on RC-505 CTL -> assign MIDI CC out -> MPC MIDI Learn to a track mute | Pedal toggles the mute | D6 |
| T-CTL-3 | (Pro Pack only) MMC Record Strobe with Clip Matrix Record or Clip + Fixed Length + Record To Play | Records the highlighted slot and auto-plays, or document failure | D7 |
| T-ALS-1 | Project: 1 drum track, 1 plugin synth, 1 MIDI track to Hydrasynth, 1 recorded audio track. Export Live Set as Audio, then as MIDI. Open both on a computer with no MPC software | Record exactly what each track became; confirm Session clip row layout | G3, G5, G6 |
| T-ALS-2 | Zip export folder, open on the collaborator's Live version | Opens, no missing files | G10, G11 |
| T-FILE-1 | Controller Mode over USB-C: SD card mounts on Windows; copy files both ways; eject; back to standalone | Works | G11 |
| T-FILE-2 | Load a .mid and an .mpcpattern written by us | .mid becomes new sequence; pattern lands on next unused track | H3, H4 |
| T-FILE-3 | Load a desktop-saved .xpj on the unit | Loads cleanly | H7 |
| T-FILE-4 | Load a type-1 .mid we write (960 PPQ; tempo + time signature at tick 0; one named track each for drums, bass, chords; notes closed with note-offs; end-of-track exactly on a bar line; no CC/PC) | Record: new sequence or chosen target; track types created; tempo imported?; plays full length (no 2-bar bug); track names kept? | H9-H14 |
| T-FILE-5 | Drum mapping: load a GM drum .mid onto a kit with the default Chromatic C1 map, then onto a saved GM-mapped drum program | First plays wrong or partial pads; second plays correctly | H15, H16 |
| T-FILE-6 | Route an imported MIDI track to the Hydrasynth (output port/channel) and another via MIDI Send to a plugin track | Both play | H11 |
| T-MCP-1 | From our server: generic `send_note` stream into an armed MPC MIDI track with MMC Record + Play | Notes recorded (quantize after) | H8 |
| T-FIX-1 | Save blank + 1-note projects on the unit; diff against Beats-saved equivalents and the kurtjcu schema. Include one project using Song Mode | Header and fields documented in our repo as device fixtures; Song Mode order located | H2, H7, K3 |
| T-ABL-1 | Live Control over USB-C: record the exact Live MIDI preference settings that make it work | Matrix View shows Live's session | J1-J3 |
| T-ABL-2 | Launch clips and scenes from pads, move the 4x4 focus, Session record with Overdub, Arrangement record with Rec | All behave as the control map says | J5, J9 |
| T-ABL-3 | Device Control on a Live device and on a third-party plugin (bank names vs numbers), Q-Link banks 3-4 | Usable hands-on control | J7 |
| T-ABL-4 | Play a Live Drum Rack and a Live synth from the MPC pads: first inside Live Control Mode, then via MIDI Control Mode, then via a standalone MIDI track out USB-C | Record which path works and how fluid it is | J10, J11 |
| T-ABL-5 | Switch standalone to Live Control and back during playback | No stop, no dropout | J4 |
| T-ABL-6 | Ableton Link between MPC and Live, plus Start/Stop Sync | Locked tempo and transport | J12 |
| T-ABL-7 | (Pro Pack) Import a collected Live set into the MPC | Contents match the J13 list | J13 |
| T-ABL-8 | Push-parity checklist, side by side with a Push 2 if one can be borrowed or tried in store: launch, record, mix, device control, play notes in key, step-sequence a clip, browse/load a device, slice a sample | Score each task: MPC equal / worse / impossible | J10, J18 |
| T-ABL-9 | Run the K1 prototype on the T-ALS-1 export | Clips land in Live's Arrangement at the right bars | K1 |

## Objective-upgrade scorecard

The purchase is an objective upgrade only if every **Must** passes.

| Criterion | Must/Want | Evidence | Result |
|---|---|---|---|
| 64-step (4-bar) parts as one object, editable and visible as a whole | Must | B3, B7, T-SEQ-2 | |
| Named projects/sequences, live part switching | Must | B9, B10, T-SEQ-2 | |
| Drives Hydrasynth + MicroFreak MIDI with clock, per-track channels | Must | F1, T-MIDI-2/3 | |
| Clock master for RC-505mkII | Must | F6, T-MIDI-2 | |
| Synth audio in and through to RC-505 | Must | E3, T-AUD-1 | |
| Ableton handoff the collaborator can open without MPC software | Must | G1-G3, T-ALS-1/2 | |
| Programmable from our MCP (files and/or live MIDI) | Must | H3-H8, T-FILE-2, T-MCP-1 | |
| Quadra Thru works on MPC DIN out (or cheap fix) | Want | F4, T-MIDI-1 | |
| Footswitch control of anything useful | Want | D6, T-CTL-2 | |
| Idea-to-beat time acceptable vs Circuit | Want | T-SEQ-3 | |
| Root/VST route kept open (stay on 3.9.1) | Want (decide) | I3, T-HW-1 | |
| Controls Live's Session, mixer, devices and transport reliably over one USB-C cable | Must | J1-J9, T-ABL-1/2/3/5 | |
| Close enough to a Push 2 for playing and programming in Live that no Push is needed | Want (decides Push purchase) | J10, J11, T-ABL-4/8 | |
| MPC project lands in Live arranged and ready (with or without K1-K5 automation) | Want | G3, K1-K5, T-ABL-9 | |

**Push decision rule:** if T-ABL-8 shows the MPC is "impossible" for playing
notes in key or step-sequencing in Live, compare total cost: One G2 plus a
used Push 2, versus a Push 3 controller plus a laptop, versus Push 3
Standalone alone. Record the result here.

Things it does **not** do, by design of this plan (not failures): replace the
RC-505mkII as a looper (C), take a guitar or mic directly (A5), run Battery or
Maschine libraries (I7).

## Repo follow-ups if bought

- New device page `docs/contributing/devices/mpc-one-g2.md` and a descriptor
  (generic MIDI tier first: notes, PC, MMC transport, clock).
- A storage-transport tool family modelled on the SPD-SX `spdsx_*` tools:
  write `.mid` / `.mpcpattern` / drum `.xpm` to the mounted SD with
  no-overwrite and backup gates; read-only `.xpj` inspector.
- Fixtures under `samples/` (gitignored) from T-FIX-1; promote fields to
  "confirmed" only from device-saved files.
