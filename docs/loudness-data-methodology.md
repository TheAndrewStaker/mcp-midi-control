# Loudness data methodology

This doc explains where the data in
`packages/core/src/fractal-shared/lineage/loudness.json` comes from,
how precise it is, and how to extend it. The data ships as a JSON
corpus to support BK-064 (loudness intelligence rollup); the
descriptor wiring that consumes it lands in a follow-up commit.

## What the file is

`loudness.json` has two top-level keys, `amps` and `drives`. Each amp
entry carries:

- `master_sweet_spot_display` (number, 1.0 to 10.0). The master_volume
  display value (the 0-10 knob a musician sees on the front panel)
  that maps to "stage unity" for this amp model. Many amps are non-
  master designs; for those the value is locked to 10.0 by Fractal's
  per-type default (see Blocks Guide page 9).
- `relative_loudness_dB` (number, integer in plus/minus dB). The
  perceived loudness of this amp at its sweet spot, compared to the
  reference amp (Twin Reverb, "Double Verb Normal" in AM4 naming) at
  master=6.0. Negative = quieter, positive = louder. Precision is
  plus or minus 3 dB; this is for agent leveling guidance, not
  mastering.
- `notes` (string, 1-2 sentences). What the agent should know about
  this amp's master behavior. Includes non-master flag, voicing
  reference, and any sweet-spot rationale.

Each drive entry carries:

- `boost_response_dB` (integer dB). The typical loudness gain when
  drive.level moves from the default starting position to 7. The
  reference Tube Screamer 808 lands at +6 dB; transparent boosts
  cluster around +3 to +5; high-output fuzzes cluster around +9 to
  +10.
- `notes` (string). The original pedal lineage and any boost-
  response caveat.

The amp and drive name keys match the AM4 canonical names returned by
`lookup_lineage` (block: 'amp' / 'drive') so the descriptor wiring can
join on name with zero transformation. Axe-Fx II and III reuse the
same loudness data by joining on the per-record cross-mapping
(`axefx2Name` <-> `am4Name`) that the existing lineage records
already carry.

## Reference choice

**Reference amp: "Double Verb Normal"** (Fender Twin Reverb).
- Sweet spot: master=6.0.
- Relative loudness: 0 dB (by definition).
- Rationale: 85W master-volume design, broad clean headroom, treated
  as the canonical "loud clean" platform in pretty much every working
  guitarist's reference frame. Master 6 is the gig-unity setting
  cited across the Fractal Forum and the wiki amp pages.

**Reference drive: "T808 OD"** (Ibanez TS-808 Tube Screamer).
- Boost response: +6 dB.
- Rationale: the TS-808 is the de facto pedal-board reference for
  perceived overdrive boost. Forum consensus and the Blocks Guide
  drive section put it at roughly +6 dB at default drive.level=7
  (mid-knob position).

Everything else is calibrated relative to these two.

## Sources, in priority order

1. **`docs/manuals/Fractal-Audio-Blocks-Guide.txt`**. The power-amp
   section (pages 9-12 in the PDF) explicitly describes which amps are
   non-master designs ("if an original amp has no Master Volume
   control, meaning its power amp is 'wide open', the model will set
   Master to 10.0 to ensure accuracy"). That single sentence drives
   every `master_sweet_spot_display: 10.0` entry in the file. The
   drive block section (pages 89-92) names the original pedal each
   model is based on; perceived boost values cross-reference the
   wider pedal-builder community for each pedal class.
2. **`packages/.../fractal-midi/shared/lineage/`** (amp-lineage.json,
   drive-lineage.json, axefx2-amp-lineage.json, etc.). Fractal-
   authored prose per model. Most useful for confirming reference-
   amp identity (Plexi 100W reference is a '69 SLP per
   Fractal forum quote; Twin Reverb-class models all derive from the
   blackface circuit family) and for confirming the canonical names
   used as keys here.
3. **Community priors**, generic citations only (the project has a
   no-personal-names rule for committed files). Fractal Forum threads
   on amp master-volume sweet spots, pedal-builder forums for boost-
   pedal output measurements, the Fractal Wiki amp pages. Citations
   in the `notes` field are deliberately generic ("forum-cited" /
   "pedal-builder consensus").

## Precision discipline

These numbers are not measurements; they are leveling-guidance
priors. Plus or minus 3 dB is the working tolerance. The downstream
agent uses them to:

- Match scene-to-scene volume when picking a different amp for a
  build scene (clean vs. lead).
- Compensate Output 1 block level when swapping a high-relative-
  loudness amp (Plexi, Hipower) into a slot that was holding a
  lower-relative-loudness amp (Princeton Reverb, AC15).
- Compensate Output level when toggling a drive block on for a solo
  scene (subtract `boost_response_dB / 2` from the Output offset, or
  let the solo sit louder by that margin, depending on user intent).

A value being plus or minus 3 dB off is fine; the agent rounds to the
nearest 0.5 dB Output offset anyway. A value that's the wrong sign
(amp marked +4 dB louder when it's actually quieter) is a bug; fix
it and ship the correction.

## How to extend

The current commit covers 40 amps and 33 drives, biased toward the
famously-tricky ones (Plexis, Marshalls, Fenders, Mesas, Soldano,
Diezel, Friedman, Vox; Klon, TS808, RAT, Big Muff, OCD). It does NOT
cover the full amp catalog of 326 amps (AM4) / 259 amps (Axe-Fx II) /
~1000 (Axe-Fx III). The descriptor wiring treats a missing entry as
"no calibration data available" and emits a generic loudness note
based on amp family.

To add an amp:

1. Look up the canonical AM4 name in
   `node_modules/fractal-midi/dist/shared/lineage/amp-lineage.json`.
   Confirm the `family` and `basedOn.productName` fields to identify
   the real-amp inspiration.
2. Decide whether the amp is master-volume or non-master. Read the
   Fractal Wiki page for that amp (linked from the lineage record's
   fractalQuotes URLs) or the Blocks Guide drive table. If the real
   amp has no master volume knob, set `master_sweet_spot_display`
   to 10.0.
3. Pick the relative_loudness_dB by comparison with similar amps
   already in the corpus. Same power rating, same family (Marshall
   Plexi 50W vs. 100W = +2 dB step) is usually right.
4. Add a notes field that names the real amp, flags non-master if
   applicable, and cites the source of any non-obvious dB value.

To add a drive:

1. Look up the canonical AM4 name in
   `node_modules/fractal-midi/dist/shared/lineage/drive-lineage.json`.
2. Identify the original pedal from `basedOn.productName`.
3. Bucket the boost_response_dB: transparent boost +3 to +5,
   tube-screamer-class +6, hot OD / op-amp distortion +7 to +8,
   fuzz / high-output distortion +9 to +10.
4. Add a notes field that names the original pedal.

## What this file is NOT

It is not a substitute for actual measurement. Running the same amp
model at the same master setting through different cabs, different IRs,
different studio monitors, or different headphones will produce different
perceived loudness. The data here is a starting point the agent uses to
get the user to "roughly right" without spending five tool calls
adjusting master and Output offsets by trial and error.

The data is also not authoritative on tone. `relative_loudness_dB`
says nothing about midrange voicing, presence shimmer, or any other
tonal property. Those live in the existing lineage prose
(`fractalQuotes`, `artistNotes`, `notes`).

## Related files

- `packages/core/src/fractal-shared/lineage/loudness.json` (the data)
- `docs/_private/04-BACKLOG.md` BK-064 (the design)
- `packages/am4/src/descriptor/agentGuidance.ts` (where the amp
  voicing pitfall narrative lives that this data complements)
- `packages/axe-fx-ii/src/lineageLookup.ts` (the helper the descriptor
  wiring step will use to join amp loudness data into II lookups)
