# Guitar Pro / MusicXML import: research + design plan

**Status:** research (high-value follow-up). Triggered 2026-06-20 when Songsterr
proved unreadable to an agent (JS app shell; notes held as a binary Guitar Pro
file behind the player). The fix flips the problem: instead of scraping a site,
parse a file the user already downloaded.

## Why this matters

This is the single capability that unlocks the **"agent plays any song the user
wants"** vision. It sidesteps the web-readability wall entirely:

- The user downloads a `.gp` (Songsterr, Ultimate Guitar Pro, MuseScore) or a
  `.musicxml` (Guitar Pro export, MuseScore native), a one-click action they
  already do.
- We parse the file **offline**, extract the **drum part**, and feed it into the
  existing `apply_pattern` pipeline. No scraping, no JS rendering, no licensing
  gray area beyond "the user has the file for their own playback."

Everything DOWNSTREAM already exists: the neutral `Step`/voice model, the Circuit
`voice_map`, the `.ncs` author, the safe transfer. **The only new piece is the
file → `Step`-grid importer.**

## The formats (what we'd actually parse)

| Format | Shape | Parseable? |
|---|---|---|
| **Guitar Pro 7 `.gp`** | a **ZIP** archive; `Content/score.gpif` is **XML** (notes + beats + beaming) | ✅ directly: unzip + read the XML |
| Guitar Pro 6 `.gpx` | binary container (BCFS filesystem) | needs a library |
| Guitar Pro 3-5 `.gp3/4/5` | proprietary binary | needs a library |
| **MusicXML** `.musicxml`/`.xml` | open W3C XML standard; GP + MuseScore both **export** it | ✅ directly: XML parse |

Key facts confirmed by the research:
- **GP7 `.gp` is just a ZIP+XML.** Rename to `.zip`, unzip → `Content/score.gpif`
  is an XML file (each note = a `note` object + a `beat` object, grouped under
  `beats`). So GP7 needs no binary reverse-engineering.
- **Guitar Pro exports MusicXML** (File → Export → MusicXML), and **MuseScore**
  is MusicXML-native with a large community library. MusicXML is the **open,
  universal interchange**, the most future-proof target.

## The library option: alphaTab

[**alphaTab** (`@coderline/alphatab`)](https://github.com/CoderLine/alphaTab) is a
TS/JS library that **parses Guitar Pro 3-7, AlphaTex, AND MusicXML** into a data
model, with first-class **drum/percussion** support (percussion clef, drum tab,
multiple drum voices, cymbal articulations). It's an npm package, "web-first",
and can run **headless** for pure parsing (no rendering). Its data-model API
exposes tracks → bars → beats → notes programmatically.

- **Pro:** one dependency covers every GP version + MusicXML; battle-tested; we
  write zero binary parsing.
- **Con:** it's a large library (a full notation/render engine; we'd use only
  the importer). **License is MPL-2.0: VERIFY** current terms and that file-level
  copyleft is compatible with how we distribute (it should be, as a library dep).

## Two viable approaches

1. **Lightweight, no heavy dep (recommended MVP):** parse **MusicXML** (and/or
   **GP7 `.gp`** = unzip + `score.gpif` XML) ourselves with a small XML parser +
   Node's built-in unzip. Covers the modern formats users actually download today.
   No third-party-license question. Misses GP3-5 binary (rare now).
2. **Full coverage via alphaTab:** pull in `@coderline/alphatab`'s importer for
   every GP version + MusicXML. Reach for this only if GP3-5 binary support is
   needed and the dep weight + MPL-2.0 are acceptable.

**Recommendation:** start with **MusicXML** as the primary target (open, universal,
lightweight, MuseScore's whole library) plus **GP7 `.gp`** (ZIP+XML) since that's
what Songsterr/GP users download. Defer alphaTab unless we hit a format it's the
only answer for.

## Drum extraction + mapping

A GP/MusicXML percussion track maps each drum to a MIDI/GM percussion note (36 =
kick, 38 = snare, 42 = closed hat, 46 = open hat, 49 = crash, 51 = ride, toms,
...). The importer:

1. Find the **percussion/drum track** in the score.
2. Walk bars → beats → notes: each note = (drum voice, onset position, duration,
   tuplet flag).
3. Map the GM drum number → our **voice name** (kick/snare/hat/openhat/crash/
   ride/tom/perc), the same legend the ASCII-tab parser already uses.
4. **Quantize** onsets to a 16th/32nd **step grid** (GP/MusicXML are
   duration-based, not grid-based) and emit the `Step[]` voice map → straight
   into `apply_pattern`.

## Constraints (the same ones the tab parser hit, plus quantization)

- **32-step ceiling:** a full song is many bars; the importer picks/sections a
  ≤32-step window (or the agent loops over sections). Same Circuit cap as before.
- **4 pads:** map the most important 4 drum voices; the rest raise the honest
  unmapped-voice error. The user/agent chooses which 4.
- **Quantization loss:** 32nd notes and tuplets may not fit a 16th/32nd grid;
  flag what was rounded, don't silently mangle. *(Update 2026-07-02: the shared
  quantizer now PLACES off-grid onsets on micro-ticks (`Step.micro`, Front B)
  so on note-track / external routing they play at true wire micro-timing;
  internal drum tracks still round pending the Front-A mask capture.)*
- **Tuplets/rolls → the micro-step question:** GP triplets and buzz rolls are
  exactly the `2-5` masks we currently refuse ON THE INTERNAL DRUM TRACKS. A GP
  buzz roll → our verified `roll 6`; internal-drum triplet placement needs the
  **micro-mask capture** (Front A). On note tracks / external gear (SPD-SX)
  triplets already place faithfully via per-slot delay (Front B, B0-confirmed
  2026-07-02).

## Legal

Parsing a file the **user downloaded** for **their own playback** is the same
personal-use / interoperability footing as the rest of the project; we never
scrape, redistribute, or host the transcription. A custom XML parser carries no
third-party license. alphaTab (if used) is MPL-2.0; verify before adopting.

## Effort estimate

- MusicXML importer (drum track → Step grid + quantizer + GM-drum legend +
  section windowing): **moderate**: a new `patterns/musicXmlDrums.ts` + a `gp7`
  unzip shim, reusing the entire downstream pipeline. No device risk (pure file →
  pattern).
- alphaTab route: **low code, heavy dep**. Wire its importer, map its model to
  our `Step`. The cost is the dependency + license review, not the code.

## Recommendation summary

Build a **MusicXML + GP7 drum importer** (lightweight, no heavy dep), reusing the
existing `apply_pattern` → Circuit pipeline. It turns "agent plays any song" from
a scraping problem (unsolvable: Songsterr proved it) into a **file-parsing
problem (solved by an open standard)**. Pair it with the micro-step capture so
triplet/roll feels survive the import.
