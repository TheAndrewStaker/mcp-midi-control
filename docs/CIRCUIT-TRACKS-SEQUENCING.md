# Circuit Tracks (Musical Sequencing): Direction & Handoff

This is the working brief for turning the Novation Circuit Tracks into a
**musical sequencing brain** an agent can drive by description. It captures the
maintainer's direction, what is built and hardware-confirmed today, the wire
facts a new contributor needs, and the open work, enough for a fresh session to
continue without re-deriving anything.

The Circuit Tracks is the project's first *sequencer-class* device. It is a
**pattern target**, not a tone/preset device: the deep value is authoring step
patterns into its `.ncs` project file and uploading them, so the maintainer can
prep named projects for a gig (the codec + upload are hardware-confirmed). The
device-neutral pattern orchestrator (`packages/core/src/protocol-generic/patterns/`)
is the surface this should grow into.

## The direction (maintainer's words, paraphrased)

The goal is to **describe beats and sequences in musical terms** and have the
agent realise them. Concretely:

- A curated, growing library of **good musical building blocks** for electronic
  and rock: e.g. "a cool minor chord", "a pulsing bass tone", "a catchy lead
  melody", named drum grooves. This curated vocabulary is the headline feature:
  the recipe library should become genuinely musical, not just generic test
  grids.
- **MIDI 1 and MIDI 2 routed to different external instruments.** The maintainer
  will send MIDI 1 → one instrument (e.g. ASM Hydrasynth) and MIDI 2 → another
  (e.g. Roland SPD-SX). Authoring those MIDI tracks is how the Circuit sequences
  a whole external rig.
- **Full arrangements**: drums + a MIDI track + (optionally) the internal synths,
  programmed together, with the internal synths usable on their own when wanted.
- Eventually **control everything useful**: the Circuit's labelled buttons,
  effects (e.g. reverb on drums, see below), and the deeper surface.

## Standout feature idea: Drum Tabs → drum patterns

The ultimate use case the maintainer wants: ask an agent for a song, e.g.
"Tom Petty: Breakdown", and have it author the real drum groove onto the
Circuit. **Drum tab notation is a near-perfect source of truth and maps almost
1:1 onto the Circuit's drum grid.** A drum tab is an ASCII grid, one row per
drum across fixed-width time columns:

```
C|----------------|   crash
H|x-x-x-x-x-x-x-x-|   hi-hat
S|----o-------o---|   snare
B|o-------o-o-----|   bass (kick)
```

Each column is a step (8ths/16ths), each `x`/`o` a hit, which is exactly the
Circuit's 4 drum tracks × up-to-32 steps. The agent workflow:

1. **Source the tab**: try the agent's own training first (famous songs are
   often memorized), then a web lookup. Tabs are community transcriptions, so
   accuracy is high but variants exist.
2. **Parse** the grid → per-row step lists (a drum-tab parser; the notation is
   fairly standardized: `B`/bass-kick, `S`/snare, `H`/hi-hat, `T`/tom,
   `C`/crash, `o`/`x`/`O` hit conventions, `-` rest, often 16 or 32 cols/bar).
3. **Map voices**: tab instrument → Circuit Drum 1–4 via the `voice_map`
   (the abstract-voice layer already exists for this).
4. **Author + upload** the `.ncs` (the drum codec + upload are confirmed).

This is a focused, high-value spike worth doing early: it turns "describe a
beat" into "name a song." Resolve tab column counts to the 16/32-step grid; a
fill or >32-column bar needs a length/multi-pattern decision.

## What is built and hardware-confirmed (as of this handoff)

| Capability | State |
|---|---|
| Drum-pattern `.ncs` codec (`ncs/drumPattern.ts`) | Built, byte-exact vs corpus, hardware-confirmed (kick four-on-the-floor played on device) |
| Note-track `.ncs` codec (`ncs/notePattern.ts`), Synth1/Synth2/MIDI1/MIDI2 | Built, byte-exact round-trip vs all 16 synth blocks, **hardware-confirmed both internally (synth played authored notes) and externally (Hydrasynth played an authored MIDI-1 line via the Circuit's MIDI out)** |
| Note-track authoring wired into `apply_pattern` (melodic/voice realizer) | Built + **hardware-confirmed (2026-06-19)**. `apply_pattern mode:ncs_upload` authors **drums AND the four note tracks**, routed by channel (ch1/2/3/4 → synth1/synth2/midi1/midi2). Device test: an octave bassline (Synth 1) + a kick (Drum 1) uploaded to a slot, loaded, and played back on the device clock, steps + pitches correct. `live_stream` melodies/chords/transpose also confirmed on Synth 1/2 the same day. Per-step pitch + chords come from note tokens in the neutral pattern (`Step.notes`); see below. Golden: `verify-circuit-ncs.ts` (`authorPlanIntoProject`) + `verify-patterns.ts` (pitch parsing + per-note compile + transpose). |
| Melodic note tokens in the pattern grammar | Built. The mini-notation parser accepts scientific-pitch tokens (`c2`, `eb3`, `f#4`, middle C = c4 = 60) and `+`-joined chords (`c3+eb3+g3`); a bassline/lead/chord/arp is one speakable string per voice. Curated melodic recipes shipped: `minor_triad`, `major_triad`, `octave_bass`, `minor_arp_up`, `lead_hook` (in C; agent transposes). |
| `.ncs` SysEx upload/download (`ncs/uploadProject.ts`, `ncs/transfer.ts`) | Hardware-confirmed end-to-end (read byte-identical to export; write + readback byte-exact; uploaded project loads via Program Change) |
| Blank base template | Device "Project 21" / **slot 20**, name "User Session": empty drums + notes, mixers audible. Re-export with `scripts/circuit-ncs-read-slot.ts 20`. |
| Generic live MIDI (send_note, send_program_change, CC, NRPN) | Works on the running server (drum hit confirmed on ch10) |

**Important display note:** the Circuit shows projects **1-indexed**; our slots
are **0-indexed**. The maintainer's "Project 21" = slot 20. Always quote both.
Empty/never-saved slots do **not** export (no `READ_INIT`); only device-saved
slots appear in the directory.

## Note-track step format (the wire facts)

All four note tracks share ONE 28-byte-per-step format (Synth1/2 play it
internally; MIDI1/2 send it out). Tracks differ only by metadata-block range:
synth blocks 0–15, MIDI blocks 48–63 (`format.ts` `NoteTrack` +
`noteStepBase`). Region = 32 steps × 28 bytes, ending at the block's metadata
offset. Per step:

```
[slotMask, probability, 0x00, 0x00]   header
[note, gate, delay, velocity] x 6     six note slots (a chord)
```

- **slotMask** is a BITMASK of active slots (bit n = slot n), NOT a count: a
  3-note chord is `0x07`, and a slot whose bit is 0 is silent even with stale
  bytes. This was the one subtlety that bit the first decode.
- **probability** 0–7 (7 = 100%, default); present even on empty steps
  (`00 07 00 00`).
- note slot order is **note, gate, delay, velocity** (delay = micro-step nudge
  0–5, forward-only; velocity 0–127).
  Empty slot = `00 00 00 60` (velocity 0x60 = device default, no note). Byte
  order cross-checked against the MIT `namirsab/circuit-tracks-tools` reference.
- **the gate byte is TWO fields, `tie << 7 | gate_sixths`** (corrected
  2026-07-26, hardware-confirmed 2026-07-27). ~~gate = micro-ticks, 6 per step,
  >6 ties across steps~~ was wrong: a magnitude over one step is just a longer
  note, not a tie. The magnitude is a note LENGTH in **sixths of a step, 1..96**
  (6 = one step, 96 = sixteen, the device's own Gate View unit) and **bit 7 is
  the documented per-step tie-forward flag**. It is NOT a plain 0..127 value and
  the ceiling is NOT 96 as a byte: 224 (`0x80 | 96`) is legal and common.
  Census: 274 files / 44,898 note slots; 43,850 with bit 7 clear top out at
  exactly 96 with nothing in 97..127, and all 1,048 with bit 7 set are exactly
  224. The two fields are **independent**, hardware-confirmed on 2026-07-27: a
  tie authored at magnitude 48 (raw byte 176) was loaded and SAVED on the unit
  and read back as 176, while the synth-1 mixer byte moved on its own, proving
  the device re-serialised from its own state rather than echoing our upload.
  Nothing is clamped or masked: the old 0..127 validator would have thrown on
  1,048 real notes, and masking the flag away would have deleted hand-set note
  lengths. Full decode: `docs/CIRCUIT-TRACKS-CONTROL-MAP.md` "Note length and
  tie".

Drum steps are a DIFFERENT (structure-of-arrays) format, see `ncs/drumPattern.ts`
and `ncs/format.ts`. Pattern playback settings (length/speed/direction) live in a
40-byte block at each block's metadata offset; the blank base defaults are
len=15 (16 steps), speed=3, forward, tempo 120: ideal, no surgery needed.

## Authoring melodic content (the note-token grammar)

The device-neutral pattern grammar (`packages/core/src/protocol-generic/patterns/`)
now carries pitch. A voice line can use **note tokens** instead of bare `x`/`.`:

- A pitch is scientific notation: letter, optional accidental (`#`/`s` sharp,
  `b` flat), octave integer. **Middle C = `c4` = MIDI 60.** Case-insensitive.
- A chord joins notes with `+`: `c3+eb3+g3` (up to 6, the note-track slot limit).
- So a bassline is `"c2 ~ g2 ~ eb2 ~ ~ ~"`, a chord stab `"c3+eb3+g3 ~ ~ ~"`,
  an arpeggio `"c3 eb3 g3 c4"`. `c3*4` repeats. A plain `x`/`X` hit stays
  un-pitched and takes the voice's default note from the `voice_map`.

This compiles to `Step.notes` (a single note or chord per step); `compileToPlan`
emits one event per pitch (so `live_stream` plays chords too), and the Circuit's
`authorPlanIntoProject` regroups same-(track, step) events into a chord and calls
`setNotePattern`. Routing is **by channel**: a voice's `voice_map` channel picks
the track (ch1/2/3/4 → synth1/synth2/midi1/midi2, ch10 → drum pads). The Circuit
`voice_map` exposes both neutral melodic names (`bass`/`chord` → Synth 1,
`lead`/`arp` → Synth 2) and explicit track names (`synth1`/`synth2`/`midi1`/
`midi2`) for deliberate placement (e.g. `midi1` → a Hydrasynth, `midi2` → an
SPD-SX). Pitch overrides per step; the `voice_map` note is only the default for
an un-pitched hit. **Key/transpose:** `apply_pattern` accepts `key` (root note
like `"G"`/`"Eb"`/`"F#"`, mode suffix ignored, the recipe carries its mode) or
`transpose` (raw semitones; takes precedence). It shifts `Step.notes` only;
drum triggers and un-pitched hits keep their `voice_map` note, so a transposed
pattern never re-routes a drum pad. An out-of-range result (past MIDI 0..127)
errors rather than silently clamping. A structured `melody:{...}` arg was considered and deferred:
note-token strings are easier for an agent to emit from natural language; revisit
if dictation-style input proves awkward.

## Scales: the device re-quantizes notes (don't get caught by this)

The Circuit constrains every note a synth/MIDI track plays to the **project Scale**
(a Scale type + Root, saved in the `.ncs` tail: root at `0x26D0C`, type at
`0x26D0D`; 16 types, `0 Natural Minor … 15 Chromatic`). It **re-quantizes stored
notes to that scale on playback** (user guide v3 p.30). Since our note tokens are
**absolute pitches**, a non-Chromatic scale silently shifts out-of-scale notes.
Hardware-confirmed 2026-06-19: an authored C-maj7 arpeggio `C-E-G-B` in the
device-default **C Natural Minor** played back as `C-Eb-G-Bb` (a Cm7); switching
the project to **Chromatic** restored `C-E-G-B` exactly.

So the codec is scale-aware (`ncs/scale.ts`: `getProjectScale` / `setProjectScale`
/ `resolveScaleName`), and `apply_pattern mode:ncs_upload`:
- **Defaults to Chromatic** whenever it writes a note track → authored pitches
  play **literally** (the right choice for exact transcriptions). Drums-only
  uploads never touch the scale (pads play samples, not scale tones).
- **Honors an explicit `scale`** (`scale:"C minor"`, `"G mixolydian"`, `"dorian"`,
  `"chromatic"`) → sets that scale so the pattern stays in-key and the user can
  twist the on-device **Scale** knob to remap it to other keys/modes live (the
  device's signature performance feature). Author in-scale notes so nothing shifts.

When a non-Chromatic `scale` is set, the codec compares the authored pitch-classes
against that scale (`notesOutsideScale`, using a per-scale interval table) and the
result string **warns how many notes the device will shift** if any fall outside it,
closing, on the opt-in path, the same silent-requantization hole the feature
exists to prevent. It's an advisory, not a gate (author in-key, or use Chromatic
to keep exact pitches). The result string also reports the prior→set scale and that
the upload **overwrote** the slot (advisory, not gated, same as the guitar save).

## Effects: reverb / delay sends (answers "how do I add reverb to drums?")

The Circuit has one global reverb and one global delay; each track has a **send**
amount into them, stored per-project in the `.ncs` tail. Offsets (relative to
`TAIL_OFFSET = 0x26CFC`, order S1, S2, D1, D2, D3, D4, M1, M2):

- reverb sends: `+748` (8 bytes)
- reverb params: `+756` (type, decay, damping)
- delay sends: `+764` (8 bytes)
- delay params: `+772`
- FX bypass: `+779`

So "give the drums some reverb" = raise the drum track's reverb-send byte (e.g.
Hello Tracks ships `D4 reverb_send = 15`). This is fully authorable from the
codec and is a natural next capability (a `setReverbSend`-style helper +
exposure through a tool). Mixer levels/pans are at `+800` / `+804` (S1, S2, M1,
M2): that's how the synth/MIDI track volumes are set without the physical
mixer; the maintainer's design rule is to keep mixers UP and author empty note
steps rather than muting (note tracks are note-gated → silent with no notes).

## Changing the Hydrasynth's preset (the maintainer asked)

Two independent paths, don't conflate them:

1. **From the agent/MCP, right now:** the Hydrasynth is a first-class USB device,
   so `send_program_change` (with bank-select CC0/CC32 if needed) on the Hydra's
   MIDI channel changes its preset directly. This works today and is the simplest
   way to have the agent recall Hydra patches.
2. **From the Circuit Tracks itself:** the Circuit can transmit Program Change on
   its MIDI tracks, but it is a device setting / per-pattern field, not on by
   default, which is why pressing Preset + the top buttons did **not** change the
   Hydra. NEXT-SESSION RESEARCH: confirm whether the Circuit MIDI track stores a
   per-pattern Program Change/Bank in the `.ncs` (so we can author "this pattern
   selects Hydra patch N"), and document the device-side Tx-PC enable. The MIT
   parser does not decode a PC field yet, so this is undecoded territory.

## MIDI channel (the maintainer's "do I match channels?" question)

The MIDI-track **Tx channel appears to be a global device setting, not stored in
the `.ncs`** (the thorough MIT parser has no channel field; a header diff between
two projects shows only a project-counter byte at `0x0C`, not a per-track
channel). So: set the external instrument's Rx channel to match the Circuit's
MIDI-1 / MIDI-2 Tx channel once on the device (or use Omni for a first test;
that already worked for the Hydra). NOT something to pin per-project unless a
controlled diff (change the channel on the device, re-export, diff) proves it
lives in the file after all. That controlled diff is the way to settle it.

## Open work (priority order for the musical-sequencing direction)

> **NEXT SESSION STARTS HERE: build the effects codec (item 4), then drum tabs
> (the §"Standout feature idea" above).** That order is the maintainer's choice.
> Item 4 below has the full, evidence-validated plan; nothing needs re-deriving.
> The authoring substrate is complete + hardware-confirmed: drums, all four note
> tracks, per-step pitch/chords, transpose/`key`, and scale-awareness all land on
> the device. Live `set_param` already covers the ch16 FX for non-stored tweaks.

1. ~~**Wire note-track authoring into `apply_pattern`**~~ **DONE + HARDWARE-CONFIRMED** (2026-06-19).
   `apply_pattern mode:ncs_upload` authors chords/basslines/leads onto
   `synth1/2` and `midi1/2` (routed by channel) as well as drums, into a
   template `.ncs`. Per-step pitch + chords are expressed with note tokens in
   the pattern grammar (`Step.notes`); the Circuit `voice_map` gained melodic
   voices (`bass/chord/lead/arp`) + explicit track voices (`synth1/synth2/midi1/
   midi2`). Confirmed on device: a bassline (Synth 1) + kick (Drum 1) uploaded,
   loaded, and played on the device clock. Remaining same-class checks (nice to
   have, not blocking): a chord-into-`.ncs` load-and-play (the live chord path is
   confirmed; the stored-chord slotMask is byte-exact-validated) and a
   `midi1`/`midi2` → external-gear upload.
2. **A curated MUSICAL recipe library**, the headline. *Started* this session:
   `minor_triad`, `major_triad`, `octave_bass`, `minor_arp_up`, `lead_hook`
   (all in C). Keep growing `patterns/library.ts` into named, genuinely good
   building blocks: 7th/sus chords, more bass shapes, lead-melody motifs,
   electronic + rock grooves. Transposition is wired: `apply_pattern` takes
   `key` ("G", "Eb", "F#") or `transpose` (semitones) and shifts the authored
   pitches (drum triggers untouched), so the C-based recipes play in any key.
   Mode-awareness (a recipe declaring its own scale so the agent can ask for
   "the same idea in Dorian") is the next refinement. **Scale-awareness is DONE +
   HARDWARE-CONFIRMED** (2026-06-19): the device re-quantizes notes to the project
   scale, so `ncs_upload` sets Chromatic by default (literal pitches) or honors a
   `scale` arg for in-key authoring that the device's Root/Scale knobs transpose +
   mode-morph live (confirmed on device). See the §Scales section. This is where
   the product value is.
3. **MIDI 2 → SPD-SX** test (prove the second MIDI track drives the second
   instrument; mirrors the confirmed Hydra path).
4. **Effects authoring: THE ACTIVE NEXT ITEM (maintainer-chosen, before drum tabs).**
   Author per-track reverb/delay **sends** into the stored `.ncs` so an agent can
   "give the drums some reverb." Offsets are **evidence-validated** (the MIT
   `ncs_parser.py` decoder matches the handoff byte-for-byte; same strong-evidence
   tier as the scale work), all relative to `TAIL_OFFSET = 0x26CFC`:
   - reverb sends `+748` (8 bytes, order S1,S2,D1,D2,D3,D4,M1,M2); reverb params
     `+756` (type, decay, damping)
   - delay sends `+764` (8 bytes, same order); delay params `+772`
     (time, sync, feedback, width, lr_ratio, slew)
   - FX bypass `+779` (0=on, 1=bypassed); reverb/delay preset select `+19`/`+18`
     (0-7 / 0-15); mixer levels/pans `+800`/`+804` (4 bytes: S1,S2,M1,M2)

   **Plan (mirror `ncs/scale.ts`):** new `ncs/effects.ts` with range-guarded
   get/set for sends + params + bypass + mixer (sends 0-127; pans bipolar center
   64), golden-tested against these offsets. **Surface:** an optional `fx` overlay
   on the `apply_pattern mode:ncs_upload` path (consistent with how `scale` was
   added; that path is already Circuit-specific via `ncs_template`/`ncs_slot`/
   `scale`). First increment = per-track **sends** (the headline knob); reverb/
   delay *params* + presets a fast follow-on. Then verify on hardware (e.g. drum
   reverb-send up, load, listen). After effects → **drum tabs** (the §Standout
   feature idea: ASCII drum-tab parser → drum grid → existing `ncs_upload`).
5. **Hydra preset recall**: `send_program_change` path now; Circuit-side PC
   research later.
6. **Confirm the note-slot gate/velocity behavior on hardware**: the first demo
   used a pre-fix codec (gate/velocity byte order was swapped, since corrected
   and byte-exact-validated); a quick re-test that authored gate/velocity behave
   as expected would promote it from "byte-correct" to "audibly confirmed."
   **Partly closed 2026-07-27**: the gate lane's ENCODING is hardware-confirmed
   (a tie at magnitude 48 survived a load-and-save on the unit, byte 176 in and
   176 out). What is still hardware-unverified is the audible half: a project
   authored WITH lengths, loaded, and HEARD holding.

## Where the code lives

- Codec (pure, no MIDI I/O): `packages/circuit-tracks/src/ncs/`
  (`format.ts`, `drumPattern.ts`, `notePattern.ts`, `transfer.ts`,
  `uploadProject.ts`).
- Device descriptor / live control: `packages/circuit-tracks/src/`
  (`descriptor.ts`, `descriptor/`, `params.ts`, `codec/`).
- Pattern orchestrator (device-neutral): `packages/core/src/protocol-generic/patterns/`.
- Control surface map (every labelled control → MIDI path or physical-only):
  `docs/CIRCUIT-TRACKS-CONTROL-MAP.md`.
- Hardware harnesses: `scripts/circuit-ncs-*.ts` (read a slot, read-verify,
  write-verify, upload a file). Goldens: `scripts/verify-circuit-*.ts`.
- Study-only reference (MIT, gitignored): `samples/circuit-tracks/pack0/ref/`.
