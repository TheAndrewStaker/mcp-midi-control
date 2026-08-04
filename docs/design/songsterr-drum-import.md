# Songsterr drum import

A third front-end for the song-import pipeline (alongside ASCII drum-tab and
Standard MIDI File): pull a song's **drum track** straight from Songsterr's own
JSON and feed it to the existing `drumScore` quantizer → `apply_pattern` →
Circuit author → upload. No tab-column parsing, no JS-rendered scraping:
Songsterr serves an already-quantized score.

## Why this source beats scraping tab HTML

The earlier web-tab route is dead (Ultimate Guitar 403s, Songsterr/drumtabs.app
render with JS, paywalls). Songsterr's *player* loads a structured JSON score
from its CDN, and on a drum track each hit stores its instrument as
`note.fret` = the **General-MIDI percussion note number** (36=kick, 38=snare,
42=closed-hat, …), exactly what `gmDrumToVoice` already consumes. We get
`(GM note, rational duration, velocity)` triples directly; the hard part
(quantizing tab columns) is already done.

## The fetch chain (3 hops, no auth)

| # | Request | Yields |
|---|---|---|
| 1 | URL `…-s23527` (regex `-s(\d+)`) | `songId` = 23527 |
| 2 | `GET https://www.songsterr.com/api/meta/{songId}` (plain JSON) | `revisionId`, `image` (a CDN hash), `tracks[]` |
| 3 | `GET {cdn}/{songId}/{revisionId}/{image}/{partId}.json` | the part score (**gzip**) |

- **Drum track** = the `tracks[]` entry with `instrumentId == 1024`
  (`instrument == "Drums"`).
- **`partId` = the track's index in `tracks[]`.** Verified on song 23527 (drums
  at index 6 → `…/6.json` decoded as the drum score). The page's `#state` script
  carries an explicit `partId` per track if we ever need to stop trusting the
  index.
- **CDN host:** primary `https://dqsljvtekg760.cloudfront.net`, fallback
  `https://d3d3l6a6rcgkaf.cloudfront.net` (same path). Browser-like `User-Agent`
  required (bare requests 403).
- Body is `Content-Encoding: gzip` (`1f 8b` magic). The fetcher detects the
  magic and gunzips, so it works whether or not the runtime auto-inflates.

## The drum JSON shape

```jsonc
{ "instrumentId": 1024, "partId": 6,
  "automations": { "tempo": [{ "measure": 0, "position": 0, "bpm": 108 }] },
  "measures": [
    { "signature": [4, 4],                 // emitted ONLY when it changes
      "voices": [ { "beats": [
        { "notes": [{ "fret": 36, "string": 3.5 }],
          "velocity": "fff", "duration": [1, 32] },   // 32nd-note kick
        { "notes": [{ "rest": true }], "rest": true, "duration": [1, 8] },
        { "notes": [{ "fret": 42 }, { "fret": 36 }],  // simultaneous hat + kick
          "velocity": "f", "duration": [1, 8] }
      ] } ] }
  ] }
```

| Field | Meaning | How we use it |
|---|---|---|
| `notes[].fret` | **GM percussion note number**, *usually*. Tabs can write a layer on a NON-GM number (Like That hides its clap on `0`) | `drumMap` remap first (number → voice or GM number), then `gmDrumToVoice` → neutral voice. Unmapped numbers are skipped and reported **by number with hit counts** (`unmapped_numbers`), so the fix is one `drum_map` arg |
| `notes[].string` | drum-staff line (half-ints) | display only, **ignored** |
| `notes[].ghost` | per-note ghost flag: a quiet, parenthesised hit | `→ event.ghost` → **velocity 40 at quantize time. A ghosted hit SOUNDS, quietly; it is never dropped** (see the ghost policy below), and the total is reported as `ghosts`. A repeated fret in one beat with one ghosted copy is **flam notation**: folds to ONE event (the main hit), counted in `flams_collapsed` (2026-07-02; previously these double-emitted and surfaced as phantom same-step collisions) |
| `notes[].tie` | tie-continuation (held, not re-struck) | **melodic parts only** in every tab censused (Sugar's bassoon carries 34; its drum part and Gethsemane's carry none, as expected: a drum hit has no sustain to tie into). Declared on `SsNote` so it is not mistaken for undecoded; the drum flattener does not read it |
| `graceNote` (beat) | grace ornament attached to the next beat. A **string**, `"onBeat"` (Sugar) or `"beforeBeat"` (Gethsemane), *not* a boolean | Songsterr's SECOND flam encoding. Its `duration` is an engraving hint, **not measure time**: the notes are emitted at the current position as ghosts and the cursor does **not** advance, counted in `graces_folded`. Same-voice grace + main then share a step and the quantizer keeps the loud one (the flam policy); a cross-voice grace keeps its own hit |
| `duration` `[num,den]` | **actual** fraction of a whole note (dots already folded in: a dotted-8th is `[3,16]`) | quarter-beats = `num/den * 4`; accumulate for onset position |
| `velocity` | dynamics string (`fff`/`f`/`mf`/`p`…) | resolved through the **full ladder** `SONGSTERR_DYNAMIC_VELOCITY` (see below), not three buckets. `ff`/`fff` still set the accent flag and `pp`/`ppp` the ghost flag (per-note `ghost` wins over the sticky dynamic); the ladder additionally carries `p`/`mp`/`mf` as real velocities |
| `rest` / `notes:[{rest:true}]` | silence | advance position, emit nothing |
| `measures[].signature` | time signature, **on change only** | carried forward; measure span = `num*4/den` quarter-beats |
| `automations.tempo[].bpm` | tempo map | first mark → pattern BPM |

A "beat" can hold several simultaneous `notes` (kick+crash); each DISTINCT fret
emits its own event at the same onset (same-fret repeats are the flam fold above).

**Source→voice mapping principle (2026-07-02, refined same day):** the raw part
JSON carries NO drum-map legend (verified: a note is just `{fret, string,
ghost}`), but Songsterr's PLAYER does: their `DrumLegend` component's
percussion-constants table was decoded from the production vendor bundle
(static3.songsterr.com, 2026-07-02) and registered as
`SONGSTERR_DRUM_EXTENSIONS` in `songsterr.ts`. It is GM plus their own
extensions: rim shot 91, half hi-hat 92, ride edge 93, cymbal chokes 94–98,
shaker 82, jingle bell 83, bell tree 84, castanets 85, surdo 86/87, extra
cowbells 99/102, all applied automatically (lookup order:
caller `drumMap` → GM → extensions). So most "exotic" numbers are now a DECODE.

**But `DrumLegend` is a NOTATION legend, so 27–34 were REMOVED from it
(2026-07-27).** The legend says what glyph and label to *draw* for a number;
registering all of it as a *sounding* map was a render table doing duty as a
voice table. Numbers 27–34 are the GM2/GS **effect** block (High Q, Slap,
Scratch Push, Scratch Pull, Sticks, Square Click, Metronome Click, Metronome
Bell): studio and engraving artefacts, not kit voices anyone plays, and a
metronome click is emphatically not part of the song. Sleep Token "Sugar"
(s560358 rev 3001145, part 10) writes **103 of its 964 notes** as
`{fret:30, string:-1.5, ghost:true}` (all of them ghosted, m25–m86, at the same
off-staff position the tab uses for fret 52, Chinese Cymbal), and Songsterr's
own player sounds none of them. We folded all 103 to `perc` → GM 56 → an SPD-SX
china pad, which the maintainer heard interleaved through the clap/snare part.
Corpus exposure measured the same day: Amber, Caught A Glimpse, Gethsemane and
Lost Child use none of 27–34; Sugar was the only affected song, at 10.7% of the
part. The code path was unconditional, so the defect was general.
With the entries gone those hits route to `unmapped_numbers`, so the import
**reports** "103 hits on number 30" instead of inventing a voice, and a caller
who decides they should sound passes `drum_map: {"30": "snare"}`, which
overrides everything. Do not restore 27–34 without a per-number musical
justification. Golden: `scripts/verify-song-import.ts`, the "effect block" block.

**Ghost policy: a ghosted hit sounds, quietly (2026-07-27).** It is tempting to
drop ghosts, since Songsterr's playback of Sugar's ghosted number-30 notes is
silent, but that reads the wrong cause. Those notes were inaudible because of
the *mapping* defect above, not the ghost flag. The same Sugar part ghosts 3 of
its 61 snare hits, 2 electric snares, a tom and all 3 pedal-hat hits, all real
groove that a blanket drop would silently delete; in drum notation a ghost note
*is* played, just very quietly, and Tom Petty's "Breakdown" turns on exactly such
a soft tail snare. So ghosts import as soft hits at `GHOST_HIT_VELOCITY` = **40**
(the same value the ASCII-tab `g` glyph emits and the threshold the SMF path
reads back as a ghost, so all three importers agree on one number; 40% of the
compiler's plain hit of 100, well under its accent of 120). The total is
surfaced in a TRACK-WIDE warning and the level is tunable per import with
`ghost_velocity` (1–127), so the policy is inspectable and adjustable rather than
magic. There is deliberately **no value that silences a ghost**; a caller who
wants a ghosted layer gone routes it elsewhere with `drum_map`.

**Dynamics are a LADDER, not accent / plain / ghost (2026-07-27).** Tom Petty
"Breakdown" (s23527 part 6) carries *no* per-note `ghost` flag at all; its drum
dynamics live entirely in the sticky beat marking: `fff`×112, `f`×101, `p`×24,
`mf`×8, `mp`×2. The measure-1 tail snare the maintainer hears as a "light snare
tail hit" is literally `{"fret":38,"velocity":"p"}`. With only an ACCENT set
(`ff`/`fff`/`ffff`/`sf`/`sfz`) and a GHOST set (`pp`/`ppp`/`pppp`), `p`, `mp`,
`mf` and `f` all fell through to the same plain hit, so that snare came out
exactly as loud as the backbeat and the groove was unrecognisable. Three levels
cannot carry a five-level source. `SONGSTERR_DYNAMIC_VELOCITY` now maps the whole
ladder, anchored on the numbers already in the codebase so nothing that works
today moves:

| `pppp` | `ppp` | `pp` | `p` | `mp` | `mf` | `f` | `ff` | `fff` | `ffff` |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 28 | **40** (ghost) | 60 | 75 | 90 | **100** (plain) | 112 | **120** (accent) | 127 |

The accent/ghost *flags* are unchanged, and a velocity is carried on the event
only when the flags alone would get it wrong. So a tab written in `fff`/`f`/`pp`
flattens byte-identically to before, and one written in `p`/`mp`/`mf` gains real
dynamics. Override per import with `FlattenOptions.dynamicVelocity`.
Numbers outside even Songsterr's table (Like That's clap on `0`, their legend
special-cases unknown numbers) remain a musical inference: named in warnings
with counts, judged by the agent/user from where they land, applied explicitly
via `drum_map`, confirmed by ear. GM is the *default dictionary*, not a
normalization target; the real target is the neutral voice model. The same
`drumMap` + named-unmapped machinery is on the SMF path (`importMidiDrums`
`channel`/`drumMap` options) for drum-library groove packs with vendor key maps
(Mixwave Sleep Token II: kit on ch16, 24 distinct sub-GM keys, map pending a
Kontakt mapping-screen read; note its GM-range keys 35–44 may also carry
non-GM meanings and should be covered by the map, which overrides GM).

## Code layout

Mirrors the MIDI importer's pure-core / I/O-front-end split.

| Layer | File | Role |
|---|---|---|
| Parse + flatten (pure) | `packages/core/src/protocol-generic/patterns/songsterr.ts` | `flattenSongsterrDrums(part)` → `DrumEvent[]` in quarter-beats; `importSongsterrDrums(part, opts)` windows one section (mirrors `importMidiDrums`) |
| Whole-song decompose (pure, source-neutral) | `packages/core/src/protocol-generic/patterns/songStructure.ts` | `decomposeToPatterns` (exact bank + `order`), `coalescePatterns` (fuzzy bank), `planArrangement` (scene-chain plan), `gridDistance`, `arrangementSummary` |
| Network fetch (core) | `packages/core/src/protocol-generic/patterns/songsterrFetch.ts` | `fetchSongsterrPart` (3-hop fetch + gunzip) and `fetchSongsterrTracks` (hops 1-2, roster only) + name→id search; pure `parseSongRef` / `trackChoices` / `selectDrumTrack` split out for testing. Shared by the tool and the script. `fetchSongsterrDrums` is a back-compat alias of `fetchSongsterrPart` |
| MCP tool | `tools/patterns.ts` (`import_songsterr`) + `dispatcher/songsterr.ts` | read-only, device-free: returns the part roster / sections / tempo, and (given a window) the `voices` grids + local tempo to feed `apply_pattern` |
| CLI front-end | `scripts/songsterr-drum-import.ts` | single-window + `--whole-song` modes (reuses the core fetch) |
| Golden test (no net) | `scripts/verify-song-import.ts` | flatten positions, dynamics→accent, signature carry, dedup, arrangement (in `test:circuit`) |

`decomposeToPatterns` takes the same `DrumEvent[]` the MIDI front-end emits, so
it serves every source, not just Songsterr.

## Incorporating as much of the song as possible (the SCENE-gated roadmap)

A Circuit drum pattern holds at most **32 steps = two 4/4 bars**. A song is
dozens of bars, so full playback means **decomposing**: chop the track into
2-bar windows, quantize each, **deduplicate** identical windows (verse/chorus
recur), and record the play **order**. `decomposeToPatterns` does this now and
emits both the deduped bank and the full `order`.

What each device layer can express:

| Layer | Reach | Status |
|---|---|---|
| one pattern | ≤ 2 bars | shipping |
| patterns + **chain** (contiguous `[start,end]` loop over a track's 8 slots) | ≤ 8 pattern plays in order = ~16 bars, then loops | **SHIPPING** (2026-07-01: `apply_pattern arrangement`, chain HW-confirmed) |
| patterns + **scenes** + **scene-chain** (song arrangement) | ≤ 4 scene steps, each playing a contiguous pattern range once (scene tables decoded 2026-07-01; scenes 1..4 device-confirmed stride) | **SHIPPING community-beta** (same tool, auto-selected when the chain doesn't fit) |

**The whole flow is now one tool round-trip (2026-07-01):**
`import_songsterr {url, whole_song:true}` → `arrangement {sections, order}` (the
deduped bank as char grids + play order by section label, `fuzz` = the
fidelity↔fit knob) → paste into `apply_pattern {arrangement, mode:'ncs_upload'}`,
which packs sections into pattern slots and wires the chain (or ≤4 scene steps),
empty-filling tracks a section doesn't use. Repeats duplicate pattern slots
(chain is the most-hardware-confirmed primitive) before falling back to scenes.
Beyond 8 plays / 4 scene runs the tool errors honestly (raise `fuzz`, or arrange
a sub-span). Remaining gaps: per-scene tempo (multi-tempo songs warn + play at
one bpm), scenes 5..16 (stride capture), arbitrary scene→pattern reuse past
consecutive runs.

### Windows vs. unique patterns

A **window** is one fixed-length slice of the song timeline in playback order
(2-bar windows → a 78-bar song is 39 windows). A **unique pattern** is a distinct
grid *content* after dedup. The `order` array (length = windowCount) maps each
window to a bank index; it IS the arrangement. The bank must fit the 8 pattern
slots; the window count never does (it's the song length), which is why we
decompose + dedup rather than store every bar.

### Fuzzy coalesce (`coalescePatterns`)

Exact dedup barely collapses a *human-played* track: a ghost note or a turnaround
fill makes each "same" 2-bar groove a distinct grid (39 windows → **31 unique**
on the Tom Petty test). `coalescePatterns` merges windows whose **onset distance**
(`gridDistance`: normalized Hamming over `voice × step` cells, accents/rolls
ignored, they don't change which groove a bar *is*) is within `maxDistance`.
Greedy in song order: a groove's first appearance seeds a cluster, later
near-variants fold in, a genuinely new section seeds a fresh cluster (so labels
stay musical, `A` is the opening groove). Each cluster stores its **medoid** (the
member most typical of the group); `variantCount` reports how many exact variants
folded in, and the individual fills of non-medoid members are flattened, the
right trade when the goal is "fit the song into the hardware."

On "Breakdown" at the default `maxDistance: 0.10`, the song reduces to **3 grooves**
(a clean verse / fill / chorus split) with the 5 remaining slots free; tightening
to `0.05` keeps 13 (over 8 slots). So the threshold is the fidelity↔fit knob
(`--fuzz N`, `--exact` to disable).

### Window identity is the UNION of the build's layers (2026-07-29)

The dedup key used to be the drum grid alone, and on a multi-part build that is
a false certificate: two windows with identical drums but DIFFERENT melodic /
synth content merged as "the same section" (the Amber rebuild plan hit this;
Amber survived only because its pad alternated in lockstep with the drums). Now
`whole_song` with `parts` builds the bank with every other selected part as an
**identity layer** (`DecomposeLayer`: melodic onsets tokenized `pitch:gateSteps`,
extra percussion parts by voice), so two windows share a letter only when EVERY
layer matches, and `coalescePatterns` holds the fuzz threshold **per layer**
(`layerDistance`; the weakest layer vetoes a merge — never drums-only). The
receipt names the layers compared. A drum-only call keys exactly as before,
byte-stable. Two bank sections may therefore carry identical drum grids under
different letters: they differ on a melodic layer, and that is the point.

### Two advancement axes → the scene-chain plan (`planArrangement`)

The Circuit advances content on **two axes**, and a long song uses both:

- **Pattern advance** (within a project): the chain auto-steps patterns 1→2→…→N
  then loops. Linear, ≤ 8 slots. This is the *fine grain inside a section*: a
  verse that alternates two 2-bar bars (`A B A B`) is a 2-pattern chain.
- **Scene advance** (the scene-chain): scenes sequence; each scene selects a
  pattern (or a chain range) + per-track state. This is the *song axis*:
  verse→chorus→verse→bridge, unbounded in length.

`planArrangement` compiles a decomposition into a **bank** (the patterns to load
into slots; fuzzy-coalesced so `bankSize ≤ 8`) + a **scene-chain** = the
run-length of `order`. Each run (a maximal stretch of one pattern) becomes one
scene that selects that pattern and holds for the run's window count. On
"Breakdown": bank 3/8, a 14-step scene-chain (`A×15 B A×3 B×2 C×5 …`). Flags
report what each layer reaches: `fitsInOnePattern`, `fitsViaChainOnly` (each
pattern once, in order, a plain chain reproduces it, no scenes), `fitsInPatternSlots`.

**When scene coding lands, `scenes` is the encoder's direct input**; nothing
above needs re-deriving. The natural next step for in-section richness: detect a
repeating *subsequence* within a run (`A B A B`) and emit it as a short
**chain range** the scene points at, so pattern-advance carries the 2-bar
phrasing and scene-advance carries the section moves.

## Tempo map, measures index, section addressing (2026-06-23)

`flattenSongsterrDrums` now carries the full structure, not just `tempo[0]`:

- **`tempos: {measure,beat,bpm}[]`**: the whole tempo map, each mark's measure
  resolved to a quarter-beat. `tempoAtBeat(flat, beat)` returns the tempo IN
  FORCE at a position. `importSongsterrDrums` reports the window's local tempo,
  not the song's opening one. (Bug it fixes: Gethsemane is 71→141→148→74 bpm;
  the bridge is 74, and verses 141/148 were being reported/streamed at 71 ≈ half
  speed.) `--whole-song` is still single-tempo and now warns loudly when the song
  has >1 tempo (per-scene tempo lands with scene-chain encoding).
- **`measures: {index,startBeat,signature,bpm,marker}[]`**: a per-measure index
  (flatten already ran a `measureStart` accumulator). Enables addressing a window
  by **DISPLAYED measure** (`--from-measure`/`--to-measure`, 1-based to match the
  tab UI) or **section name** (`--section "Bridge"`), instead of hand-computed
  beat offsets. Section names are sticky in the source and carried forward;
  duplicate names (Gethsemane has two "Bridge"s) warn and pick the first.
- **Sticky dynamics**: `velocity` is now carried forward like `signature`
  (Songsterr emits both only on change). A `fff` accents following hits until the
  next marking; a `pp` switches them to ghost.

Warning honesty (the dense-roll case): the off-grid warning now names 32nds/64ths
(not just triplets); the collision warning no longer advises "raise stepsPerBeat"
at a fine grid (it can't help past the 32-step ceiling) and instead points at the
buzz-roll / baked-roll-sample route; and `--whole-song` now rolls up per-window
**collision** drops (the larger loss on a 64th roll), not just off-grid rounding.

## `import_songsterr` MCP tool (the conversational path, 2026-06-23)

The fetch is now a first-class read-only tool, kept SEPARATE from `apply_pattern`
(not folded into a single multi-step verb): the agent fetches, inspects, then
applies. Flow:

0. *(optional)* `import_songsterr({ url | query, list_tracks: true })` → the
   song's FULL part roster and nothing else: one metadata GET, no part download,
   no selection, no authoring. This is the discovery answer to "what parts does
   this song have?", and it is the only shape that works on a song with **no**
   drum part (the default path refuses that). Returns `mode: "list_tracks"` with
   `tracks[]` (`partId` / `name` / `instrument` / `is_drums`), the drum subset,
   and a `notes[]` scope line.
1. `import_songsterr({ url | query })` → the resolved part, the drum **tracks**
   (with names/views, so "the electronic-hat layer" resolves to the right one of
   several), `all_tracks` (every other part, with the `partId` to pass back as
   `track`), the **sections** (Intro/Verse/Bridge…), and the **tempo map**.
2. `import_songsterr({ url, section | from_measure })` → the per-voice step
   **grids** + the **local tempo** for that window, plus a `next_step` string.
   Feed those `voices` and `bpm` to `apply_pattern`.

`query` resolves a name → songId via Songsterr's own search (closing the A3
discovery gap). The fetch + track-selection live in core (`songsterrFetch.ts`)
and are shared with the CLI, so the two never drift. `apply_pattern` is
unchanged; it stays device-focused and consumes `voices` like any inline grid.

### Any part, but only drum GRIDS (say both, 2026-07-26)

Two claims that are easy to collapse into one wrong one, in either direction:

- **Selection is instrument-agnostic.** `fetchSongsterrPart` (renamed from
  `fetchSongsterrDrums`, which kept the old name as an alias) pulls whichever
  part index it is handed, and `track` / `trackId` / `track_name` resolve
  against the WHOLE roster. Reading the old name as a constraint is how a later
  session concluded this path was drum-only when it never was.
- **Grid conversion is not.** `flattenSongsterrDrums` reads each note's `fret`
  as a General MIDI percussion number, which is how Songsterr stores a *drum*
  track. A melodic part carries `string` + `fret` instead, so it fetches
  cleanly and its sections / tempo map / measures are correct, but its `voices`
  come back empty or meaningless. The tool says so in three places: the tool
  description, the `notes[]` on a `list_tracks` roster, and a `PART n is
  "<instrument>", not a drum track` warning when a non-drum part is selected.

Making melodic parts produce pitched grids means resolving `(string, fret)`
against the track's tuning from `meta`. That is a feature, not a wording fix,
and is not built.

## Articulations: what each marking becomes (2026-07-27)

The source carries far more per-note detail than pitch and duration, and until
this pass none of it was read. Owned by
`packages/core/src/protocol-generic/patterns/songsterrArticulation.ts`; the walk
in `songsterr.ts` parses the markings and hands them over.

Every articulation lands in exactly one of **three stages**, and a note carrying
several is resolved by running the stages in order, never by picking a winner:

| Stage | Markings | Operator | Where |
|---|---|---|---|
| 1. Velocity | `ghost` / sticky `velocity` set the BASE, then `accentuated` ADDS (+20 level 1, +34 level 2), then damping SCALES (palm mute ×0.85, dead ×0.7) | base → bump → scale | the flattener (velocity needs no grid) |
| 2. Lengthen | `letRing` (to the next strike of the same pitch), `hp` / `slide:"legato"` / `slide:"shift"` (gate OVERLAPS the next onset) | `max` | the cell boundary (needs quantized step positions) |
| 3. Damp | `palmMute`, `dead`, `staccato` | `min`, applied LAST | the cell boundary |

Four decisions worth naming, because each one had a plausible-looking
alternative:

- **A dynamic and an accent COMPOSE.** Schism part 1 m12 alternates a `p` melody
  note carrying an accent glyph against an `f` pedal note. Read as an absolute
  120, the accented `p` note would come out LOUDER than the unaccented `f` one
  and invert the tab's own written dynamic. Composed, it lands just under it
  (68 vs 85), which is what the part does.
- **Palm mute is gate AND velocity, weighted.** The gate is the definitional and
  load-bearing half, a CAP in absolute musical time (`palmMuteGateBeats`, 1/8 of
  a quarter beat ≈ 69 ms at 108 bpm) rather than a fraction of the written length,
  because a muted chug rings for a fixed short time however long it is written.
  The velocity trim is deliberately small (×0.85): velocity reaches the filter on
  most patches so it buys some of the darkness a note cannot say, but a big drop
  would turn a riff quiet on a patch that routes velocity to the amp alone, which
  is a worse wrongness than a riff that is merely not dark enough.
- **Damping beats lengthening, and does not compound.** 190 corpus notes are both
  palm-muted and hammered-on; the picking hand is on the strings, so the note
  cannot sustain into its target however legato the transition is notated. Two
  dampings on one note take the STRONGEST scale and cap, never the product.
- **Legato is gate OVERLAP, not the tie flag.** `layoutMelodicRow` deliberately
  refuses to tie into a different pitch, and a 130-file factory census found 279
  real notes whose gate runs past the next onset at a different pitch, so overlap
  is normal stored content that needs no tie.

Slides read the **string**, never a boolean. Only `legato` and `shift` have a
written destination; `downwards` / `upwards` / `below` / `above` /
`belowupwards` glide into or out of a pitch the score never states, so there is
nothing to connect a gate to and they are reported rather than guessed. An
unrecognised slide value is reported too.

Sub-step gates required one grammar addition and closed one long-standing hole:
`miniNotation.ts` gained a **`@vel` velocity suffix**. Velocity resolved
correctly, reached `cells[].velocity` and `steps[].velocity`, and then died at
the notation boundary, which is the boundary the documented workflow actually
pastes into `apply_pattern`. The gate already accepted a fraction (`":1/2"`), so
a palm mute writes as `a#3:1/2@68`.

### `dropped_fidelity`: reporting what we do NOT carry

Every reply carries a `dropped_fidelity` block, **derived, not hand-written**:

- `SONGSTERR_FIELDS` declares a disposition for every field the importer knows
  (`read` / `structural` / `engraving` / `in_duration` / `redundant` /
  `no_destination` / `metadata`), each with a written reason.
- the flatteners count every field they ACT on (`fields_applied`), per value for
  `slide` and `accentuated`.
- `censusSongsterrFields` enumerates `Object.keys` at every level, so it is
  key-BLIND and sees a field nobody has heard of.
- subtracting one from the other gives three buckets: `not_parsed` (never read,
  an honest gap), `parsed_not_authored` (read and then thrown away, the dangerous
  one, listed first in prose), and `not_a_loss` (engraving / already-in-duration /
  redundant, listed so the judgement is auditable rather than silent).

Two properties fall out. A field the source starts emitting appears as
`not_parsed` with nobody updating a list. And a `slide:"legato"` that IS authored
does not vouch for a `slide:"downwards"` that is not, because a `per_value` field
is bucketed per value.

The GATE that stops this class of defect recurring is in
`scripts/verify-song-import.ts`: it asserts every field the audit corpus carries
has a declared disposition, so a new source field fails before it ships.

## Chain → device (D2, partial)

`coalescePatterns` reduces a song to a small bank that usually fits the Circuit's
8 pattern slots; a chain over `[0, bankSize-1]` would auto-advance them as the
song. The chain primitive is now a tested codec module
(`circuit-tracks/ncs/chain.ts`: `setAllDrumLengths`, `setDrumChain`), but only
the `[0,1]` range is hardware-confirmed; wider ranges are decoded-beta pending a
capture (`docs/design/circuit-chain-range.md`). The remaining half (authoring the
bank into the 8 pattern slots of one project, `authorPlanIntoProject` writes
only pattern 0 today) is queued with that capture.

## Status / caveats

- **Prototype, read-only.** Hits an unofficial CDN endpoint. Fine for local use;
  revisit ToS before shipping as a product feature.
- `partId`-by-index is verified on one song; confirm on a second multi-track
  song before relying on it broadly.
- Off-grid onsets (32nd/triplet ornaments) round to the 16th grid and are
  flagged, same as the MIDI path; raise `--steps 8` for a 32nd grid.
