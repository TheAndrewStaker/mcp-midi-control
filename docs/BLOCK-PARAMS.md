# AM4 Block Parameters — Ground Truth Reference

> **Sources:**
> 1. **Ghidra-extracted parameter catalog** (Session 82, 2026-05-16) — the
>    authoritative wire-level paramId/name dictionary for every effect
>    family AM4-Edit exposes (50 families, 1732 paramId/name pairs).
>    Regenerate via `scripts/ghidra/run-am4-paramnames.cmd`; output lands in
>    `samples/captured/decoded/ghidra-am4-paramnames.json` (gitignored).
>    See `docs/research/ghidra-mining-workflow.md` for the recipe and
>    `docs/devices/am4/SYSEX-MAP.md` §6p for the wire mapping (pidLow=block,
>    pidHigh=paramId). Get a coverage report via
>    `scripts/_research/am4-catalog-coverage-report.ts`.
> 2. **Fractal Audio Wiki** (scraped 2026-04-14 via `scripts/scrape-wiki.ts P0`)
>    — model lists and effect-type names. Raw pages: see `docs/wiki/`
>    (gitignored — regenerate with the scraper).
> 3. **AM4 owner's manual** — for hand-verification and display-name
>    conventions.
>
> **Scope:** Effect TYPE names per block, plus block→catalog-family mapping.
> Parameter-level detail is now machine-extractable from the Ghidra catalog
> (paramId + symbolic name); per-param metadata (unit, range, enum values)
> requires hardware verification and remains in `packages/am4/src/params.ts`.

This document is the authoritative list of block types and effect-type names
usable when building AM4 presets. Type names are transcribed verbatim from the
Fractal wiki; anything marked `[FLAG — VERIFY]` is an ambiguity or gap that
needs confirmation against the AM4 owner's manual or a sniffed preset before
use in production code.

## Block ↔ catalog family quick reference

The Ghidra catalog (see SYSEX-MAP.md §6p) groups params by "effect family"
(Fractal's internal naming). Mapping for AM4's placeable blocks plus the
two non-placeable system blocks:

| Block | pidLow | Catalog family | Catalog case | Catalog params |
|---|---|---|---|---|
| amp | `0x003a` | DISTORT | 0xa | 143 (shared with drive) |
| drive | `0x0076` | DISTORT | 0xa | 143 (shared with amp) |
| cab | `0x003e` | CABINET | 0xb | 85 |
| reverb | `0x0042` | REVERB | 0xc | 63 |
| delay | `0x0046` | DELAY | 0xd | 80 |
| chorus | `0x004e` | CHORUS | 0x10 | 22 |
| flanger | `0x0052` | FLANGER | 0x11 | 26 |
| rotary | `0x0056` | ROTARY | 0x12 | 14 |
| phaser | `0x005a` | PHASER | 0x13 | 28 |
| wah | `0x005e` | WAH | 0x14 | 20 |
| tremolo | `0x006a` | TREMOLO | 0x16 | 15 |
| filter | `0x0072` | FILTER | 0x18 | 31 |
| enhancer | `0x007a` | ENHANCER | 0x1a | 8 |
| gate | `0x0092` | GATE | 0x23 | 13 |
| volpan | `0x0066` | VOLUME | 0x28 | 11 |
| geq | `0x0032` | GEQ | 0x8 | 13 |
| peq | `0x0036` | PEQ | 0x9 | 27 |
| compressor | `0x002e` | COMP | 0x7 | 28 |
| **ingate** | `0x0025` | INPUT | 0x29 | 8 (Input Noise Gate, not slot-placeable) |

---

## Global Block Architecture

- **4 effect slots per preset** (1 Amp+Cab integrated, 3 free effect slots).
- **4 channels per block** (A / B / C / D) — each channel independently
  selects its own TYPE and parameter values within the block.
- **4 scenes per preset** — each scene captures which channel is active
  per block plus per-block bypass state.

---

## Amp Block

- **Role:** amp modeler; always present as the core of a preset.
- **Cab integration:** Cabinet simulation is integrated with the Amp block
  on AM4 (DynaCab linking enabled by default; can be disabled).
- **Models:** ~437 amp models catalogued in `docs/wiki/Amp_models_list.md`,
  organized by era and family (vintage tweed, blackface/silverface,
  British plexi/plexi-derived, modern high-gain, boutique, bass).
- **Status:** Full model-name list not yet extracted into this document —
  the raw file is 289 KB and contains tables the wiki→markdown converter
  could not translate. **Treat Amp_models_list.md as the authoritative
  source until a structured extraction is produced.** [FLAG — VERIFY]
- **Wire-protocol layout (HW-041 / Session 38):** the AM4-Edit Expert
  page for the amp surfaces 4 UI tabs (Preamp / Power Amp / Cabinet /
  Speaker). Three of those (Preamp, Power Amp, Speaker) write to the
  amp `pidLow=0x003a`. The Cabinet tab writes to a **separate**
  `pidLow=0x003e`. See `SYSEX-MAP.md §6k` for the protocol details
  and `params.ts` HW-041 block for the 61 registered knobs (Preamp 12
  + Power Amp 21 + Cabinet 16 + Speaker 12).

## Cab Block (integrated with Amp on AM4)

- **Technology:** DynaCabs (dynamic mic-positioned cabinet modeling).
- **IR count:** 2 IRs per channel.
- **Mic options (DynaCab):** Dynamic 1 (SM57), Dynamic 2 (SM7B),
  Ribbon (Royer 121), Condenser (Soyuz 023).
- **Legacy support:** 189 legacy cabs from Axe-Fx II XL+/AX8.
- **User IR slots:** 256, UltraRes supported.
- **Factory DynaCabs:** must be installed separately per Fractal instructions.
- **Protocol address:** `pidLow=0x003e` (separate from the amp block's
  `0x003a`). User-facing namespace stays under `amp.*` for the four
  Expert tabs; cabinet entries in `params.ts` hold `pidLow=0x003e`
  directly. Confirmed HW-041 / Session 38; see `SYSEX-MAP.md §6k`.

## Drive Block

- **Role:** overdrive, distortion, boost, fuzz.
- **Type count:** 100+ models (file is 289 KB; full list not extracted here).
- **Categorization (from wiki):**
  - Clean Boost
  - Bass drive
  - Fuzz
  - Amp-in-a-box / Overdrive / Distortion
  - Metal / high-gain
  - Other
- **Reference pedals include:** TS808/TS9/TS9DX family, DS-1, RAT, Klon-style,
  Muff-style, various boutique clones. **Full verbatim list pending
  structured extraction from `docs/wiki/Drive_block.md`.** [FLAG — VERIFY]

## Delay Block

- **Type count:** 29
- **Types:**
  - 2290 W/ Modulation
  - Ambient Stereo
  - Analog Mono
  - Analog Stereo
  - Deluxe Mind Guy
  - Diffused Delay
  - Digital Mono
  - Digital Stereo
  - DM-Two Delay
  - Dual Delay
  - Dual Head Tape Delay
  - Ducking Delay
  - Graphite Copy Delay
  - Lo-Fi Tape
  - Mono BBD
  - Mono Tape
  - Pan Delay
  - Ping-Pong
  - Reverse Delay
  - Stereo BBD
  - Stereo Mind Guy
  - Stereo Tape
  - Stereo Trem Delay
  - Surround Delay
  - Sweep Delay
  - Vintage Digital
  - Wandering Delays
  - Worn Tape
  - Zephyr: FAS original

## Reverb Block

- **Core reverb classes:** Spring, Room, Chamber, Hall, Plate, Studio, Tunnel.
- **Named models / variations:**
  - London Plate (EMT 140-based)
  - Sun Plate
  - North Church (Bricasti-inspired)
  - South Church (Bricasti-inspired)
  - Andromeda
  - Aquarius
  - Capricorn
  - Centaurus
  - Gemini
  - Pegasus
  - Sagitarius
  - Ursa Major
  - Echo Plate
  - Echo Hall
  - Echo Room
- **Quality modes:** Economy, Normal, High, Ultra-High.
- **Notes:** Spring is mono; other types are stereo. Pre-Delay can act as a
  simple echo with Tempo / Feedback / Mix controls.
- [FLAG — VERIFY] The "pitch-shift reverbs" (Andromeda, Aquarius, etc.) may be
  reverb+pitch-shift hybrids rather than pure reverbs. Confirm against the
  AM4 manual before categorizing.

## Chorus Block

- **Core types:**
  - Digital Mono
  - Digital Stereo
  - Analog Mono
  - Analog Stereo
  - Japan CE-2
  - Warm Stereo
  - 80's Style
  - Triangle Chorus
  - 8-Voice Stereo
  - Tape Chorus
  - Dimension 1
  - Dimension 2
  - Dimension 3
  - 4-Voice Analog
  - 8-Voice Analog
  - Stereo Tri-Chorus
  - Dual Chorus
  - Tape Flanger
  - Japan CE-1 Chorus
  - Japan CE-1 Vibrato
  - Japan CH-1
  - MX234
  - Small Copy
  - Japan CE-2 Bass
  - Vibrato
  - Rockguy
  - MX234 Stereo
- **AM4-specific:** Vibrato 1, Vibrato 2.

## Flanger Block

- **Core types:**
  - Digital Mono
  - Digital Stereo
  - Analog Mono
  - Analog Stereo
  - Thru-Zero
  - Stereo Jet
  - Zero Flanger
  - Pop Flanger
  - MXF-117 (MXR 117-based)
  - BBF-2 (Boss BF-2-based)
  - Electric Mystery (EHX Electric Mistress)
  - Deluxe Mystery (EHX Deluxe Electric Mistress)
  - D/AD 185 (A/DA-based)
  - Manual Thru-Zero Flanger
  - Step Flanger
  - FAS Flanger
  - Binary Flange
  - Cancel Flange
  - Count of Flanging (Dream Theater reference)
  - Cuda Flange (Heart's Barracuda)
  - Harmonoflange
  - Hemisflange (Rush's Hemispheres)
  - Lofty Flange
  - Melodic Flange
  - 80's Rack Flanger
  - Scion Stereo Flange
  - Spirit Flange (Rush's Spirit of Radio)
  - Starship Flanger (Yes's Starship Trooper)
  - Trippy Flanger
  - Tubular
  - Vowel Flanger
- **AM4-specific:** Manual Cancel Flanger.

## Phaser Block

- **Types:**
  - Barber Pole
  - Block 90 (MXR Phase 90/45-based, four-stage)
  - Script 45
  - Script 90
  - Stripe 90 (EVH Phase 90)
  - Borg Phaser (Korg PHS-1-based)
  - Classic Vibe (Fulltone Deja-Vibe / Univibe-style)
  - FAS Vibe (custom Uni-Vibe)
  - Modern Vibe (updated buffer/LFO)
  - Mutated Twin-Phaser (Mutron Bi-Phase)
  - Naughty Rock (EHX Bad Stone, six-stage)
  - Stereo 8-Stage
  - Treadle-Phaser (Morley Pro PFA)
  - Ultra-Super-Mega Phaser
  - Virtuoso Phaser (Maestro MP-1, six-stage)
- **Notes:** Firmware 28 added LFO Mode (UNIVIBE/NORMAL), Low/High Cut,
  and the Modern Vibe type. Stages configurable in multiples of 2 up to 12.

## Wah Block

- **Types:**
  - Clyde (Vox Clyde McCoy)
  - Color-Tone (Sola Colorsound)
  - Cry Babe (Dunlop Cry Baby)
  - FAS Wah (Fractal custom)
  - Funk Wah (Shaft-era sound)
  - Mortal (Morley wah/volume)
  - Paragon (Tycobrahe Parapedal)
  - VX485 (Vox V845)
  - VX846 (Vox V846-HW, SRV-style)

## Filter Block

- **Types:**
  - Allpass
  - Auto-Wah
  - Band-Pass
  - Envelope Filter
  - Feedback Comb
  - Feedforward Comb
  - Highpass
  - High-Shelf
  - High-Shelf 2
  - Low-Pass
  - Low-Shelf
  - Low-Shelf 2
  - Notch
  - Null
  - Peaking
  - Peaking 2
  - Tilt EQ
  - Touch Wah
- **Notes:** "Null" type's purpose is not documented in the excerpt
  (likely a pass-through). [FLAG — VERIFY]

## Compressor Block

- **Types:**
  - Analog Compressor
  - Analog Sustainer
  - Citrus Juicer (Dan Armstrong Orange Squeezer-based)
  - Classic VCA Compressor (formerly "Studio FF Compressor")
  - Compander
  - Dynami-Comp Classic
  - Dynami-Comp Modern
  - Dynami-Comp Soft
  - Dynamics Processor
  - Econo-Dyno-Comp
  - JFET Pedal Compressor
  - JFET Studio Compressor
  - Modern VCA Compressor
  - Optical Compressor
  - Rockguy Compressor
  - Vari-Mu Tube Compressor (formerly "Tube Compressor")
  - VCA Bus Compressor
  - VCA FB Sustainer
  - VCA FF Sustainer

## Rotary Block

- **Types:** No discrete TYPE selector — the block is a continuous Leslie model.
- **Key parameters:** independent Horn/Drum rotor speeds, Chorale (slow) and
  Tremolo (fast) speed settings, mic spacing. Stereo by default; mono-capable.

## Tremolo/Panner Block

- **Types:**
  - Bias Trem (tube bias tremolo)
  - Harmonic Trem (Brownface, splits spectrum)
  - Neon Trem (optical, neon bulb)
  - Optical Trem 1 (LED-based depth)
  - Optical Trem 2 (mixer pot depth)
  - Panner (stereo L/R pan)
  - VCA Trem (formerly just "Tremolo")
- **Notes:** Harmonic Trem is full stereo; all types placeable pre- or post-Amp.

## Volume/Panner Block

- **Types:**
  - Volume
  - Auto-Swell

## Graphic EQ Block

- **Types:**
  - 3 Band Console
  - 3 Band Passive
  - 4 Band Passive
  - 5 Band Constant Q
  - 5 Band Passive
  - 5 Band Variable Q
  - 7 Band Constant Q
  - 7 Band Variable Q
  - 7 Band Pedal (Boss GE-7 / GE-7B)
  - 7 Band Bass Pedal
  - 8 Band Constant Q
  - 8 Band Variable Q
  - 2/3 Octave Constant Q
  - 2/3 Octave Variable Q
  - 10 Band Constant Q
  - 10 Band Variable Q
  - 5 Band Mark (Mesa Mark, non-authentic sliders)
  - 4 Band JM-PRE 1 (Dave Murray signature)

## Parametric EQ Block

- [FLAG — VERIFY] The scraped `Parametric_EQ_block.md` is a redirect stub —
  the page on the Fractal wiki points back to `EQ.md`. Parameter-level detail
  (band count, Q range, freq range per band) must be pulled from the AM4
  owner's manual.

## Enhancer Block

- **Types:**
  - Modern (multi-band, mono-compatible)
  - Classic (Haas-effect delay-based)
  - Stereoizer (high-order filter-based)

## Gate / Expander Block

- **Types (standalone block):**
  - Classic Expander (analog-style downward expander)
  - Modern Expander (novel envelope detector, soft-knee selectable)
  - Classic Gate (open/close with hold timer)
  - Modern Gate (linear-in-dB opening, swell-capable)

## Input Noise Gate (global, not a block slot)

- **Types:**
  - Classic Expander
  - Intelligent (with EMI filtering, dynamic line noise filter)
  - Noise Reducer
- **Notes:** Lives on the Input block, not a free slot. EMI filter is AC
  line-frequency dependent. Global Noisegate Offset available in SETUP.

---

## Cross-Cutting Notes

- **Per-channel type selection:** every effect block listed above exposes all
  its TYPES independently per channel A/B/C/D, except the Amp block (where
  the channel usually represents an amp-model variant or boost stage).
- **CPU budget:** drive and compressor types vary substantially in CPU cost;
  preset validation will need a cost table (not yet captured). See
  `docs/wiki/` once CPU_usage is added to the P0 scrape set.
- **Firmware drift:** type lists change between firmwares. Wiki scrape is a
  snapshot — when AM4 firmware updates arrive, re-run the scraper and diff
  `docs/wiki/` before trusting new type names.

## Extraction Gaps To Close

1. **Amp models** — structured extraction from `Amp_models_list.md` (289 KB).
2. **Drive types** — structured extraction from `Drive_block.md` (289 KB).
3. **Parametric EQ** — pull from the AM4 owner's manual; wiki page is a stub.
4. **Rotary** — confirm there is no TYPE selector; document the speed /
   spacing parameter ranges instead.
5. **Per-type parameter tables** — every TYPE here has its own parameter set
   (e.g. a Tape delay has Age/Bias/Hiss; a Digital delay does not). These
   will be captured incrementally as presets are built.
