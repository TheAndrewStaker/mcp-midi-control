# Novation Circuit Tracks: control map

What every labelled control on the Circuit Tracks maps to over MIDI through
this server, or why it has no MIDI path. "Support a button" means control
the function it reaches, not emulate the physical press (the Circuit exposes
parameters and selection over MIDI, not button events).

Source of truth: Circuit Tracks Programmer's Reference Guide v3 (wire) +
User Guide v3 (operation). Drum notes and the drum/synth/project CC+NRPN map
are hardware-cross-checked against the PDF; a single drum trigger and the
transport path are owner-confirmed on hardware (2026-06-18).

## Channel model

One USB MIDI endpoint, multiplexed by channel: Synth 1 = ch1, Synth 2 = ch2,
MIDI 1/2 = ch3/ch4 (external gear), Drums = ch10, Project/global = ch16.
`set_param` targets Synth 1 by default; pass `instance:2` to address the same
synth param on Synth 2.

## Addressable over MIDI (via `set_param` / `set_params` unless noted)

| Labelled control | Tool + target | Channel | Status |
|---|---|---|---|
| **Synth 1** voice/osc/mixer/filter/env/lfo/fx/eq | `set_param` blocks `osc1 osc2 mixer filter env1 env2 env3 lfo1 lfo2 fx eq voice` | ch1 | registered |
| **Synth 2** (same param set) | same blocks + `instance:2` | ch2 | registered |
| **Macros 1-8** (knob positions) | `set_param` block `macros`, `macro_1`..`macro_8` | ch1 (instance:2 = ch2) | registered |
| **Macro A-D routing** (8 knobs x 4 slots x dest/start/end/depth) | `set_param` blocks `macro1`..`macro8` (`a_destination`/`a_start`/`a_end`/`a_depth` .. `d_*`) | ch1 (instance:2 = ch2) | registered |
| **Mod matrix** (12 slots) | `set_param` blocks `mod1`..`mod12` (`source1`/`source2`/`depth`/`destination`) | ch1 (instance:2 = ch2) | registered |
| **Sidechain** (per synth: source/attack/hold/decay/depth) | `set_param` blocks `sidechain1` `sidechain2` | ch16 | registered (synth2 depth addr flagged VERIFY) |
| **Drum 1-4** params | `set_param` blocks `drum1`..`drum4` (patch/level/pitch/decay/distortion/eq/pan) | ch10 | registered, kick hw-confirmed |
| **Drum 1-4** triggers | `send_note` notes 60/62/64/65, or `apply_pattern` | ch10 | hw-confirmed (kick) |
| **Mixer** (synth levels + pans) | `set_param` block `track_mixer` | ch16 | registered |
| **FX**: Reverb / Delay params + per-track sends, FX bypass | `set_param` blocks `reverb` `delay` `fx` (sends `synth1_send`..`drum4_send` in `reverb`/`delay`) | ch16 | registered |
| **Master Filter** (freq/res) | `set_param` block `master_filter` | ch16 | registered |
| **Preset / Project** select | `switch_preset` (project 0-63) | ch16 PGM | registered |
| Synth **patch** select | `send_program_change` | ch1/ch2 PGM | generic primitive |
| **Tempo** / transport | `send_clock_start/stop/continue`, `send_song_position` | system | generic primitive |
| **MIDI 1 / MIDI 2** | pass-through sequencer tracks to external gear; no internal params (drive the downstream device's own port) | ch3/ch4 | n/a (external) |

## Deferred (addressable, data-only follow-on, not yet registered)

- **LFO toggle bus** (NRPN 0:122 packed flags + 0:123 fade mode): lfo1/lfo2 one-shot / key-sync / common-sync / delay-trigger / fade-mode. Needs a shared-NRPN enum-bus addr kind (8 toggles emit disjoint value windows into one NRPN), so it is a small codec touch, not pure data.
- **Audio-input** table (Audio 1/2 level/reverb/delay/pan, CC 13/15/31-36): channel unconfirmed in v3 and the CCs collide with synth assignments — flagged VERIFY, blocked on a hardware check, not on effort.

## Physical-only: no MIDI path (cannot be driven remotely)

These are device-resident sequencer/navigation functions with no documented
MIDI binding. Confirmed dead-ends, not gaps:

- **Note / Velocity / Gate / Probability** step editors (pattern step data).
- **Pattern** select and **Scene** select WITHIN a project (only whole-project select exists, via `switch_preset` / PGM ch16; 64-127 = queued).
- **Clear / Duplicate**, **Grid / Setup / Shift / View Lock** navigation. PROJECT Save is a device/Components action (no MIDI path) — but a synth PATCH now DOES have a MIDI save path via `save_preset` (Replace Patch to a Flash slot; see "Patch save + read" above).
- **Play / Record** as buttons (transport is reachable via MIDI clock; the buttons themselves are physical).

## Recording a pattern onto the device

- **Drum tracks do NOT record external MIDI** (manual p.38 + on-device test 2026-06-18): external drum notes trigger the pad sound but the drum sequencer captures only physical pad taps / step entry. So a drum beat can be **auditioned** live (`apply_pattern mode:live_stream`) but not landed on the device over MIDI.
- **Synth tracks DO record external MIDI** ("Recording from an external controller", ch1/ch2) `,` the basis for the `record_capture` realizer (synth-track scope).
- The only programmatic way to put a **drum** pattern onto the device is **NCS offline project authoring + upload** (`apply_pattern mode:ncs_upload`), which is built and hardware-confirmed (drum codec + note-track authoring + SysEx transfer all verified on-device 2026-06-18/19).

## Patch save + read (synth patches) — community-beta

**`save_preset({location, instance})` persists a synth part's live (RAM) sound to
a Flash PATCH slot 0-63.** It reads the current patch back via a Current Patch Dump
Request, then re-frames the 340-byte body as a "Replace Patch" write — the body is
an opaque container, so live `set_param` edits are preserved verbatim. `instance` 1
= Synth 1 (default), 2 = Synth 2. The overwrite gate **refuses by default** — a
Flash slot cannot be previewed (no random-access stored-patch read), so
`confirm_overwrite:true` is required. PATCH slots are distinct from the PROJECT
slots `switch_preset` / `upload_project` use. `supports_save` is **true**:
persistence is hardware-verified (2026-07-03; a saved patch survives a power-cycle).

**`get_param` / `get_params` read SYNTH PATCH params** (osc / filter / env / lfo /
mixer / fx / eq; `instance` 1/2 = Synth 1/2). They request a live Patch Dump and
decode the 340-byte body at each param's §13 offset (`codec/patchLayout.ts`, offsets
32-123), converting to display units via the registry schema. The offset map is
**oracle-confirmed against 128 real factory patch dumps** (`scripts/decode-circuit-patches.ts`:
every mapped offset in range across all 128, 9 distinctive anchor defaults matched).
`get_params` dumps once per part (batched) and memoizes a transport failure so an
offline device fails fast. Drum / project / macro / mod-matrix state has **no MIDI
readback** and refuses honestly (never a fabricated value).

**`get_preset({location})` works** for stored PROJECTS: it downloads a stored project
off a Flash slot (0-63) over the `.ncs` SysEx transfer protocol (`downloadProject`,
hardware-confirmed byte-exact 2026-06-18) and decodes its sequencer content — the
four note tracks (Synth 1/2, MIDI 1/2) and four drum tracks, pattern 1 — into a
readable snapshot. It reads **saved slots only**: the live working buffer is not a
slot, so unsaved edits must be Saved on the device first. This is the read half of
a read-modify-write loop (read slot → edit → `apply_pattern mode:ncs_upload`).

**`get_preset("patch:N")` works** for a stored synth PATCH (N = 0..63; device Patch N+1).
It reads the actual synth BANK — the store `save_preset` writes to — by loading the slot into
Synth 1's working buffer (Program Change on the synth channel) and dumping it, then RESTORING
the prior buffer (non-destructive to an unsaved edit). It returns the patch NAME + all decoded
patch-dump params (osc/filter/env/lfo/mixer/fx/eq) and reflects freshly-saved patches
(HW-confirmed 2026-07-03: read `PROBE85` / filter.frequency=85 back from slots 62/63 right after
saving). A Program Change to an EMPTY slot loads nothing. Note the file-transfer read
(`readStoredPatch`, fileType 0x04) reads the pack's sparse FILE store instead and does NOT see
bank-only saves — it stays wired into `checkOverwriteTarget` only, where it must not disturb the
buffer `save_preset` is about to persist.

### Hardware confirmation status

- **READ path — ✅ CONFIRMED 2026-07-03.** A live `get_param filter.frequency`
  returned Synth 1 = 45 and Synth 2 (`instance:2`) = 46 (distinct values → the
  `loc` byte is honored), sub-second, no timeout. The dump request → reply round
  trip works on hardware for both synth parts.
- **WRITE path (Flash) — ✅ CONFIRMED 2026-07-03 (survives power-cycle).** `save_preset`
  persists a synth patch to a Flash slot 0..63 (`instance` 1/2 = Synth 1/2); on the device
  it is **Patch <slot+1>** (1-indexed). Two patches saved this way were confirmed by ear
  after a power-cycle. The write protocol (`codec/patchTransfer.ts savePatch`, decoded from
  Components captures + a 7-agent capture review) is: dump the live patch, **clean its
  dirty-edit marker (`body[17]=0x00`)**, wrap a byte-clean Replace-Patch in a file-transfer
  session (OPEN → handshake → browse the target page → CLOSE → wait the device's post-CLOSE
  `0x08`), and send the Replace-Patch **FIRE-AND-FORGET as the last message** — the device
  commits to flash silently over a few seconds; any session opened afterward aborts the
  commit. Two earlier failures were: (a) flashing the device's *dirty* live-buffer body
  (`body[17]=0x01`), and (b) an in-band verify read aborting the commit. The device never
  acks a save even on success. **Verify by ear / power-cycle** (no patch-name display), or
  read it back with `get_preset("patch:N")` — that now reads the synth BANK (see below).

**Two storage namespaces (do not conflate):** a synth PATCH bank (128 slots, selected/
reloaded by `send_program_change` on ch1/ch2 = `save_preset`'s target) is SEPARATE from a
PROJECT (64 slots, selected by `switch_preset` = PGM ch16). A project reload does not pull
a fresh bank patch, and the hardware Save button (×2) stores the PROJECT, not the bank —
so on-device manual "save" and `save_preset` exercise genuinely different mechanisms.

Deferred structured-read region: the mod-matrix (offsets 124-203, 20 slots × 4) and
macro (204-339, 8 knobs × 17) record arrays — `get_param` refuses those pending a
single-param-edit capture pass to bind the record fields.

## Sample upload (drum samples)

Load your own WAV drum samples onto the device over USB, replacing the manual
Novation Components web-app workflow:

- **`upload_sample(port, file, slot 1..64, name?)`** — one WAV to one drum-sample slot.
- **`upload_kit(port, folder, kit?, start_slot?)`** — a folder of WAVs to consecutive slots.

The **64 sample slots are the shared drum pool** the four drum tracks pick from
(synths use **patches**, not samples — there is no "synth sample"). Without a
microSD card the device holds **one Pack** in internal flash (64 projects + 128
patches + 64 samples); a `.ncs` is one *project*, not the Pack. WAVs are
normalized to the device format **48 kHz / mono / 16-bit** on upload (resampled /
channel-folded / re-quantized if they differ; sent verbatim if they already
match). The wire is the project file-transfer protocol with **file-type `0x05`**
(projects are `0x03`) and the WAV as the payload — decoded **byte-exact from a
real Components capture** and validated byte-identical (community-beta;
hardware-unconfirmed). Each upload **overwrites** its slot (advisory, not gated).

## Drum voice bleed (round-robin, anti-choke)

Each drum track is a **single monophonic voice**: a new hit retriggers (chokes)
the previous hit on that *same* track, so a fast ringing sound (open hat, ride,
cymbal, snare roll) cuts itself off and sounds abruptly unnatural. A single track
cannot be made polyphonic. Ways to get acoustic-style bleed:

- **`apply_pattern round_robin`** — spread a voice across 2+ drum tracks so the
  tails overlap, e.g. `round_robin: {"hat": ["drum3","drum4"]}` deals consecutive
  hits drum3 → drum4 → drum3 …. **Load the same sample on each target track** for
  it to sound like one instrument. Works in `live_stream` and `ncs_upload`.
- **A pre-baked roll/cymbal sample triggered once** (`upload_sample`) instead of
  micro-step retriggers — the musical fix for the abrupt micro-step buzz.
- **Drum Decay macro (Macro 4)** to lengthen each hit's ring.
- **Reverb / delay sends** — an ambient tail rings past the choke.
- **Isolate a ringing sound on its own track**, away from a busy pattern.

## Per-step sample flips (multiple drum pieces on one track)

A drum track plays one sample *at a time* (the choke above), but **each step can
play a different sample** via the device's **Sample Flip** feature — so several
drum pieces (kick + snare + sticks) share one track, freeing the other three for
more parts. The per-step selector is the drum step's **`drum_choice`** byte:

> **`drum_choice` = the absolute sample slot 0..63; `0xFF` = no flip (play the
> track's default/selected sample).** Hardware-confirmed both directions
> (2026-06-22): a snare flipped to slot 2 and sticks to slot 15 read back as
> `drum_choice` 2 and 15, and authoring those values reproduced the device's own
> Sample Flip byte-for-byte. (Device "Sample N" = wire slot N−1.)

- **Author flips:** `apply_pattern` `drum_flips` — `{"drum1": {"9": 2, "13": 15}}`
  flips Drum 1's step 9 to sample slot 2 and step 13 to slot 15, while its other
  hits play the track default. The step must already be a hit (a flip on a rest
  is reported and ignored). `ncs_upload` only.
- **Read flips:** `get_preset` surfaces `sample_flips` per drum track (the raw
  `drum_choice` value per flipped step), the read half of read-modify-write.
- **Constraint:** one sample per *step* — two pieces that must sound on the SAME
  step still need two tracks. Pieces that never collide on a step pack onto one
  track losslessly. This is the basis for a future GM-import "collision-graph
  packer" (4-colour the voices so co-occurring pieces land on different tracks).
- **Not yet decoded:** the track's *default*-sample field (so today every step
  is either the template default or an explicit flip).
