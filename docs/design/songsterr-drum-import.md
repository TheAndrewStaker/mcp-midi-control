# Songsterr drum import

A third front-end for the song-import pipeline (alongside ASCII drum-tab and
Standard MIDI File): pull a song's **drum track** straight from Songsterr's own
JSON and feed it to the existing `drumScore` quantizer → `apply_pattern` →
Circuit author → upload. No tab-column parsing, no JS-rendered scraping —
Songsterr serves an already-quantized score.

## Why this source beats scraping tab HTML

The earlier web-tab route is dead (Ultimate Guitar 403s, Songsterr/drumtabs.app
render with JS, paywalls). Songsterr's *player* loads a structured JSON score
from its CDN, and on a drum track each hit stores its instrument as
`note.fret` = the **General-MIDI percussion note number** (36=kick, 38=snare,
42=closed-hat, …) — exactly what `gmDrumToVoice` already consumes. We get
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
| `notes[].fret` | **GM percussion note number** — *usually*. Tabs can write a layer on a NON-GM number (Like That hides its clap on `0`) | `drumMap` remap first (number → voice or GM number), then `gmDrumToVoice` → neutral voice. Unmapped numbers are skipped and reported **by number with hit counts** (`unmapped_numbers`), so the fix is one `drum_map` arg |
| `notes[].string` | drum-staff line (half-ints) | display only — **ignored** |
| `notes[].ghost` | per-note grace/ghost flag | `→ event.ghost` (soft hit). A repeated fret in one beat with one ghosted copy is **flam notation**: folds to ONE event (the main hit), counted in `flams_collapsed` (2026-07-02; previously these double-emitted and surfaced as phantom same-step collisions) |
| `duration` `[num,den]` | **actual** fraction of a whole note (dots already folded in: a dotted-8th is `[3,16]`) | quarter-beats = `num/den * 4`; accumulate for onset position |
| `velocity` | dynamics string (`fff`/`f`/`mf`/`p`…) | `ff`/`fff` → accent; `pp`/`ppp` → ghost (per-note `ghost` wins over the sticky dynamic) |
| `rest` / `notes:[{rest:true}]` | silence | advance position, emit nothing |
| `measures[].signature` | time signature, **on change only** | carried forward; measure span = `num*4/den` quarter-beats |
| `automations.tempo[].bpm` | tempo map | first mark → pattern BPM |

A "beat" can hold several simultaneous `notes` (kick+crash); each DISTINCT fret
emits its own event at the same onset (same-fret repeats are the flam fold above).

**Source→voice mapping principle (2026-07-02, refined same day):** the raw part
JSON carries NO drum-map legend (verified: a note is just `{fret, string,
ghost}`) — but Songsterr's PLAYER does: their `DrumLegend` component's
percussion-constants table was decoded from the production vendor bundle
(static3.songsterr.com, 2026-07-02) and registered as
`SONGSTERR_DRUM_EXTENSIONS` in `songsterr.ts`. It is GM plus their own
extensions — rim shot 91, half hi-hat 92, ride edge 93, cymbal chokes 94–98,
shaker 82, jingle bell 83, bell tree 84, castanets 85, surdo 86/87, extra
cowbells 99/102, GM2-style 27–34 — all applied automatically (lookup order:
caller `drumMap` → GM → extensions). So most "exotic" numbers are now a DECODE.
Numbers outside even Songsterr's table (Like That's clap on `0` — their legend
special-cases unknown numbers) remain a musical inference: named in warnings
with counts, judged by the agent/user from where they land, applied explicitly
via `drum_map`, confirmed by ear. GM is the *default dictionary*, not a
normalization target — the real target is the neutral voice model. The same
`drumMap` + named-unmapped machinery is on the SMF path (`importMidiDrums`
`channel`/`drumMap` options) for drum-library groove packs with vendor key maps
(Mixwave Sleep Token II: kit on ch16, 24 distinct sub-GM keys — map pending a
Kontakt mapping-screen read; note its GM-range keys 35–44 may also carry
non-GM meanings and should be covered by the map, which overrides GM).

## Code layout

Mirrors the MIDI importer's pure-core / I/O-front-end split.

| Layer | File | Role |
|---|---|---|
| Parse + flatten (pure) | `packages/core/src/protocol-generic/patterns/songsterr.ts` | `flattenSongsterrDrums(part)` → `DrumEvent[]` in quarter-beats; `importSongsterrDrums(part, opts)` windows one section (mirrors `importMidiDrums`) |
| Whole-song decompose (pure, source-neutral) | `packages/core/src/protocol-generic/patterns/songStructure.ts` | `decomposeToPatterns` (exact bank + `order`), `coalescePatterns` (fuzzy bank), `planArrangement` (scene-chain plan), `gridDistance`, `arrangementSummary` |
| Network fetch (core) | `packages/core/src/protocol-generic/patterns/songsterrFetch.ts` | the 3-hop fetch + gunzip + name→id search; pure `parseSongRef` / `selectDrumTrack` split out for testing. Shared by the tool and the script |
| MCP tool | `tools/patterns.ts` (`import_songsterr`) + `dispatcher/songsterr.ts` | read-only, device-free: returns tracks / sections / tempo, and (given a window) the `voices` grids + local tempo to feed `apply_pattern` |
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
window to a bank index — it IS the arrangement. The bank must fit the 8 pattern
slots; the window count never does (it's the song length) — which is why we
decompose + dedup rather than store every bar.

### Fuzzy coalesce (`coalescePatterns`)

Exact dedup barely collapses a *human-played* track: a ghost note or a turnaround
fill makes each "same" 2-bar groove a distinct grid (39 windows → **31 unique**
on the Tom Petty test). `coalescePatterns` merges windows whose **onset distance**
(`gridDistance`: normalized Hamming over `voice × step` cells, accents/rolls
ignored — they don't change which groove a bar *is*) is within `maxDistance`.
Greedy in song order: a groove's first appearance seeds a cluster, later
near-variants fold in, a genuinely new section seeds a fresh cluster (so labels
stay musical — `A` is the opening groove). Each cluster stores its **medoid** (the
member most typical of the group); `variantCount` reports how many exact variants
folded in, and the individual fills of non-medoid members are flattened — the
right trade when the goal is "fit the song into the hardware."

On "Breakdown" at the default `maxDistance: 0.10`, the song reduces to **3 grooves**
— a clean verse / fill / chorus split — with the 5 remaining slots free; tightening
to `0.05` keeps 13 (over 8 slots). So the threshold is the fidelity↔fit knob
(`--fuzz N`, `--exact` to disable).

### Two advancement axes → the scene-chain plan (`planArrangement`)

The Circuit advances content on **two axes**, and a long song uses both:

- **Pattern advance** (within a project): the chain auto-steps patterns 1→2→…→N
  then loops. Linear, ≤ 8 slots. This is the *fine grain inside a section* — a
  verse that alternates two 2-bar bars (`A B A B`) is a 2-pattern chain.
- **Scene advance** (the scene-chain): scenes sequence; each scene selects a
  pattern (or a chain range) + per-track state. This is the *song axis* —
  verse→chorus→verse→bridge, unbounded in length.

`planArrangement` compiles a decomposition into a **bank** (the patterns to load
into slots; fuzzy-coalesced so `bankSize ≤ 8`) + a **scene-chain** = the
run-length of `order`. Each run (a maximal stretch of one pattern) becomes one
scene that selects that pattern and holds for the run's window count. On
"Breakdown": bank 3/8, a 14-step scene-chain (`A×15 B A×3 B×2 C×5 …`). Flags
report what each layer reaches: `fitsInOnePattern`, `fitsViaChainOnly` (each
pattern once, in order — a plain chain reproduces it, no scenes), `fitsInPatternSlots`.

**When scene coding lands, `scenes` is the encoder's direct input** — nothing
above needs re-deriving. The natural next step for in-section richness: detect a
repeating *subsequence* within a run (`A B A B`) and emit it as a short
**chain range** the scene points at, so pattern-advance carries the 2-bar
phrasing and scene-advance carries the section moves.

## Tempo map, measures index, section addressing (2026-06-23)

`flattenSongsterrDrums` now carries the full structure, not just `tempo[0]`:

- **`tempos: {measure,beat,bpm}[]`** — the whole tempo map, each mark's measure
  resolved to a quarter-beat. `tempoAtBeat(flat, beat)` returns the tempo IN
  FORCE at a position. `importSongsterrDrums` reports the window's local tempo,
  not the song's opening one. (Bug it fixes: Gethsemane is 71→141→148→74 bpm;
  the bridge is 74, and verses 141/148 were being reported/streamed at 71 ≈ half
  speed.) `--whole-song` is still single-tempo and now warns loudly when the song
  has >1 tempo (per-scene tempo lands with scene-chain encoding).
- **`measures: {index,startBeat,signature,bpm,marker}[]`** — a per-measure index
  (flatten already ran a `measureStart` accumulator). Enables addressing a window
  by **DISPLAYED measure** (`--from-measure`/`--to-measure`, 1-based to match the
  tab UI) or **section name** (`--section "Bridge"`), instead of hand-computed
  beat offsets. Section names are sticky in the source and carried forward;
  duplicate names (Gethsemane has two "Bridge"s) warn and pick the first.
- **Sticky dynamics** — `velocity` is now carried forward like `signature`
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
applies. Two-step flow:

1. `import_songsterr({ url | query })` → the drum **tracks** (with names/views, so
   "the electronic-hat layer" resolves to the right one of several), the
   **sections** (Intro/Verse/Bridge…), and the **tempo map**.
2. `import_songsterr({ url, section | from_measure })` → the per-voice step
   **grids** + the **local tempo** for that window, plus a `next_step` string.
   Feed those `voices` and `bpm` to `apply_pattern`.

`query` resolves a name → songId via Songsterr's own search (closing the A3
discovery gap). The fetch + track-selection live in core (`songsterrFetch.ts`)
and are shared with the CLI, so the two never drift. `apply_pattern` is
unchanged — it stays device-focused and consumes `voices` like any inline grid.

## Chain → device (D2, partial)

`coalescePatterns` reduces a song to a small bank that usually fits the Circuit's
8 pattern slots; a chain over `[0, bankSize-1]` would auto-advance them as the
song. The chain primitive is now a tested codec module
(`circuit-tracks/ncs/chain.ts`: `setAllDrumLengths`, `setDrumChain`), but only
the `[0,1]` range is hardware-confirmed — wider ranges are decoded-beta pending a
capture (`docs/design/circuit-chain-range.md`). The remaining half (authoring the
bank into the 8 pattern slots of one project — `authorPlanIntoProject` writes
only pattern 0 today) is queued with that capture.

## Status / caveats

- **Prototype, read-only.** Hits an unofficial CDN endpoint. Fine for local use;
  revisit ToS before shipping as a product feature.
- `partId`-by-index is verified on one song — confirm on a second multi-track
  song before relying on it broadly.
- Off-grid onsets (32nd/triplet ornaments) round to the 16th grid and are
  flagged, same as the MIDI path; raise `--steps 8` for a 32nd grid.
