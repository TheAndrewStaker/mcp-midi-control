# Circuit Tracks `.ncs` project: decoded config fields (length / chain / scenes)

**Status:** decoded by on-device save→download→diff (2026-06-22/23), hardware-
confirmed. A `.ncs` is a fixed 160,780-byte project. Beyond the pattern step data
(`packages/circuit-tracks/src/ncs/{drumPattern,notePattern,format}.ts`), these
project-config fields were located by changing ONE thing on the device, saving,
downloading (`scripts/circuit-download-slot.ts`), and diffing vs a baseline.

## Pattern LENGTH (per drum pattern)

- **Offset:** byte 0 of each drum pattern's metadata block =
  `META_OFFSETS[drumBlockIndex(track, pattern)]` (`format.ts`).
- **Value:** `steps − 1`. `0x0f` = 16 steps (the default, only the first bar
  plays!), `0x1f` = 32 steps (full 2-bar pattern).
- **Why it matters:** authoring writes 32 steps of *data* but, until this was
  decoded, never set the length, so the device played 16 and looped. Set every
  used drum pattern's length byte to `0x1f` for full-length playback.
- Evidence: diff showed `@0xcdf4` (=`META_OFFSETS[16]` = Drum1 pattern1) and
  `@0xd49c` (Drum1 pattern2) flip `0x0f→0x1f` when length set to 32 on-device.

## Pattern CHAIN (per drum track, auto-advance)

- **Table @ `0x2d4`:** 4 bytes per drum track ×4 tracks =
  `[startPattern, endPattern, 0, 0]`. e.g. chain patterns 1–2 (0-indexed 0–1) =
  `00 01 00 00`; chain 3–4 = `02 03 00 00`.
- A chain LOOPS continuously (not a one-shot queue): a 2-pattern chain plays the
  full 64-step (4-bar) groove and repeats. Selecting a single pattern in Patterns
  View replaces the active chain (that's the "it stopped auto-advancing" gotcha).
- Validated: baking `[00,01]` made Drum 1↔2 auto-advance and loop on-device.

## SCENES (16 per project, recall a chain set with one pad)

- **Region:** scenes stack in the header at **`0x51 + N×~0x27`** (≈39-byte stride;
  observed Scene 1 `@0x51`, Scene 2 `@0x78`, Scene 3 `@0xa0`, Scene 4 `@0xc8`).
- Each scene stores its per-drum-track chain (4 bytes/track). Captured byte-exact
  for chains 1–2 / 3–4 / 5–6 / 7–8:
  - Scene 1 (chain 1–2): `01 00 00 00` per drum track
  - Scene 2 (chain 3–4): `02 03 00 00`
  - Scene 3 (chain 5–6): `04 05 00 00`
  - Scene 4 (chain 7–8): `06 07 00 00`
  - (Scene-1's `01 00` is a quirk of how that first chain was baked; it recalls
    groove 1 correctly. For authoring, replicate the captured bytes verbatim;
    do not over-derive the encoding.)
- Plus a small selected-scene state region near the file end (`@0x1a27a`,
  `@0x26fbc`, `@0x26fd2`) that tracks which scene is active.
- **Scenes are saved with the project** (Save twice), and a **Scene Chain**
  (Mixer View) auto-advances through scenes in order and loops = whole-song
  arrangement. Scene-chain region is NOT yet decoded.

## How this maps to authoring

- `scripts/circuit-set-length-chain.ts` sets length=32 on all drum patterns + bakes
  a chain.
- `scripts/circuit-bake-scenes.ts` (2026-06-23) replicates the 4-scene block from a
  scene-baked REFERENCE project into every `full4bar` project, so each song ships
  with Scene 1–4 = its four grooves (tap-to-switch, each a looping 2-pattern chain).
  It diffs the reference (slot 42 / Project 43, the_summoning full + scenes) against
  the song's own length+chain-processed baseline → the **scene delta**, and transplants
  that delta into each song. Because the scene block references chains by PATTERN
  INDEX (1-2/3-4/5-6/7-8, identical across every full4bar) and the header + state
  regions are song-independent, the delta is byte-exact for all songs. A hard gate
  aborts if any delta byte falls outside the scene windows (= a groove/length/chain
  mismatch, not a scene). **Done 2026-06-23**: baked into all 10 full4bar projects
  (Projects 43,45,…,61 = slots 42,44,…,60) and uploaded with per-file read-back
  byte-exact verification; on-device audible confirmation pending.
- **Scene footprint, now byte-validated against the device** (delta of slot 42 vs
  baseline): header scene-chain bytes in `0x40..0x2d0` (Scene 1@0x51, 2@0x78
  `02 03`, 3@0xa0 `04 05`, 4@0xc8 `06 07`, repeated per drum track at +4 stride with
  a trailing `0x01`), plus three scene-selection state bytes `@0x1a27a`=07,
  `@0x26fbc`=08, `@0x26fd2`=05 (transplanted verbatim, they set the initial
  selected scene/pattern and are song-independent).

## Open

- **Scene-CHAIN** region (song-arrangement auto-progression): next decode.
- **Drum-track → sample-slot pointer**: a Drum-3 sample reassign did NOT appear in
  the project diff, so the drum→sample binding likely lives outside the `.ncs`
  (a pack-level store). Reading/authoring it (for auto-binding D1–D4) is unsolved.
