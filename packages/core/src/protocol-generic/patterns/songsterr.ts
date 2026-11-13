/**
 * Songsterr score JSON → step-grid importer (the parse + flatten half).
 *
 * A third front-end for the song-import pipeline, alongside the ASCII-tab and
 * Standard-MIDI-File paths. Songsterr serves an already-quantized score, and it
 * stores the two kinds of part DIFFERENTLY:
 *
 *   - a DRUM part writes each hit's percussion as `note.fret` = the General-MIDI
 *     percussion note number (36=kick, 38=snare, 42=closed-hat, …), exactly what
 *     `gmDrumToVoice` consumes → `flattenSongsterrDrums`;
 *   - a MELODIC part writes each note as `{fret, string}` against the part's own
 *     top-level open-string `tuning` array → `flattenSongsterrMelodic`, which
 *     resolves `pitch = tuning[string] + fret`.
 *
 * So this layer just walks the score and emits either the SAME `DrumEvent[]`
 * intermediate `midiFile.ts` produces, or a pitched `MelodicNote[]`; everything
 * downstream (quantize → apply_pattern → Circuit author → upload) is reused
 * unchanged.
 *
 * Like `parseMidiFile`, this module is PURE and dependency-free: it takes an
 * already-fetched, already-decompressed `DrumPart` object. The 3-hop fetch
 * (meta → CDN part JSON, gzip) is an I/O front-end and lives in the script
 * `scripts/songsterr-drum-import.ts`, not here.
 *
 * Source shape (only the fields we read), per live captures of three
 * songs:
 *   { tuning?:[64,59,55,50,45,40],              // MELODIC parts only (see below)
 *     tuningFlat?:true,                          // DRUM parts only
 *     measures:[ { signature?:[n,d],            // emitted only when it changes
 *                  marker?:{ text:"Bridge" },   // section name, only when it changes
 *                  voices:[ { beats:[
 *                    { duration:[num,den],       // ACTUAL fraction of a whole note
 *                      velocity?:"fff"|"f"|…,     // sticky dynamic (only on change)
 *                      rest?:true,
 *                      notes:[ { fret:36 } ] } ] } ] } ],
 *     automations:{ tempo:[ { measure, position, bpm } ] } }   // multi-tempo map
 *
 * **`tuning` is the melodic/drum discriminator, and it is free.** It sits at the
 * TOP level of the part JSON alongside `strings` and `frets`; a drum part carries
 * `tuningFlat: true` and no `tuning` at all. So the part we already downloaded
 * tells us which flattener it wants, with no extra fetch hop and no guessing from
 * the instrument name (`isMelodicPart`).
 *
 * Both `signature`, `marker`, and `velocity` are STICKY — Songsterr emits them
 * only when they change, so all three are carried forward. The tempo map is a
 * list of marks keyed by measure; a windowed section must use the tempo IN FORCE
 * at its start, not `tempo[0]` (a 4-tempo song would otherwise render every
 * section past measure 0 at the wrong — often half — speed).
 *
 * **ARTICULATION lives next door.** What a palm mute, an accent, a let-ring, a
 * hammer-on or a slide BECOMES is `songsterrArticulation.ts`, along with the
 * mechanical `dropped_fidelity` receipt for every source field this walk does
 * not carry. This module parses the markings onto the flattened note and hands
 * them over; it does not decide what they sound like.
 */

import type { Step } from './types.js';
import { GATE_SIXTHS_PER_STEP, MAX_GATE_SIXTHS, MIN_GATE_SIXTHS } from './types.js';
import { reduceToMonoVoice, renderGlideGestures, describeGlideGestures, type GlideGestureReport } from './pitchGestures.js';
import {
  gmDrumToVoice,
  quantizeDrumEvents,
  GHOST_HIT_VELOCITY,
  type DrumEvent,
  type QuantizedDrums,
} from './drumScore.js';
import {
  SONGSTERR_SLIDE_KINDS,
  applyLengthArticulations,
  censusSongsterrFields,
  deriveDroppedFidelity,
  droppedFidelitySummary,
  resolveArticulationOptions,
  resolveArticulatedVelocity,
  type AppliedFields,
  type ArticulationOptions,
  type DroppedFidelity,
  type FieldCensus,
  type LegatoCause,
  type LengthArticulationReport,
} from './songsterrArticulation.js';

/** The legato connections a SOURCE marking can ask for; `glide` is only ever inserted by the renderer. */
type SourceLegatoCause = Exclude<LegatoCause, 'glide'>;

/** Songsterr dynamics string → accent (loud) / ghost (soft) flags. */
const ACCENT = new Set(['ff', 'fff', 'ffff', 'sf', 'sfz']);
const GHOST = new Set(['pp', 'ppp', 'pppp']);

/** What the accent/ghost flags alone compile to (mirrors `compile.ts`). */
export const PLAIN_HIT_VELOCITY = 100;
export const ACCENT_HIT_VELOCITY = 120;

/**
 * Songsterr dynamic marking → MIDI velocity: the FULL ladder, not the
 * accent / plain / ghost triple.
 *
 * Why this exists (2026-07-27, one classic-rock tab's drum part). That tab's
 * drum part carries no per-note `ghost` flag at all; its dynamics are entirely in
 * the sticky beat marking, `fff`×112, `f`×101, `p`×24, `mf`×8, `mp`×2. The
 * measure-1 tail snare the maintainer describes as a "light snare tail hit" is
 * literally `{"fret":38,"velocity":"p"}`. With only an ACCENT set and a GHOST set,
 * `p`, `mp`, `mf` and `f` all fell through to the same plain hit, so that snare
 * came out exactly as loud as the backbeat and the groove was unrecognisable.
 * Three levels cannot carry a five-level source.
 *
 * The ladder is anchored on the numbers already in the codebase so nothing that
 * works today moves: `f` = the compiler's plain hit (100), `fff` = its accent
 * (120), `pp` = the shared ghost velocity (40). The rest interpolate. Override
 * per-import with `FlattenOptions.dynamicVelocity`.
 */
export const SONGSTERR_DYNAMIC_VELOCITY: Readonly<Record<string, number>> = {
  pppp: 20,
  ppp: 28,
  pp: GHOST_HIT_VELOCITY,   // 40, the shared ghost level
  p: 60,
  mp: 75,
  mf: 90,
  f: PLAIN_HIT_VELOCITY,    // 100, an unmarked hit
  ff: 112,
  fff: ACCENT_HIT_VELOCITY, // 120, the compiler's accent
  ffff: 127,
  sf: ACCENT_HIT_VELOCITY,
  sfz: 127,
};

// ── Songsterr JSON shapes (only the fields we read) ──────────────────

export interface SsNote {
  /**
   * DRUM part: the General-MIDI percussion number. MELODIC part: the fret,
   * which only becomes a pitch through `tuning[string] + fret`.
   */
  fret?: number;
  /**
   * MELODIC part: the 0-based string INDEX into the part's `tuning` array, and
   * the index runs DOWNWARD (0 = the highest-pitched string). DRUM part: a
   * fractional staff position (-1.5, -0.5, … 3.5), which is why a fractional
   * value here is a second, independent signal that a part is percussion.
   *
   * The direction is decoded, not assumed. On one song's melodic part
   * (`tuning=[64,59,55,50,45,40]`), `{"fret":6,"string":4}` reads as
   * `tuning[4]=45 + 6 = 51 = d#3`, and taking the whole song that way yields a
   * union of exactly 6 pitch classes across its four melodic parts (a coherent
   * key). Reversing the index yields 10 chromatic classes and a bass playing
   * tritones. The drum parts' own downward-running staff positions agree.
   */
  string?: number;
  rest?: boolean;
  /**
   * Per-note ghost flag: a quiet, parenthesised hit. Songsterr also uses it for
   * the soft half of a same-fret flam pair. It is NOT a silence flag; see the
   * ghost policy in the `flattenSongsterrDrums` header.
   */
  ghost?: boolean;
  /**
   * Tie-continuation: this note is held from the previous one, not re-struck.
   * MELODIC parts only in every tab censused (one song's bassoon part carries 34,
   * another's pad 144; the drum parts censused carry none), which is
   * expected, since a drum hit has no sustain to tie into. The DRUM flattener
   * still does not read it; `flattenSongsterrMelodic` does, folding the
   * continuation into the length of the onset it is held from and recording the
   * fact on `MelodicNote.tie` / `MelodicCell.tie`.
   */
  tie?: boolean;
  /**
   * HAMMER-ON / PULL-OFF, and it is ONE boolean covering both: the source does
   * not distinguish ascent from descent because the adjacent pitches already do.
   *
   * It sits on the note the transition STARTS from, decoded rather than assumed:
   * one song's bass m3 writes the riff `38[hp] 48[hp] 50`: three notes, two
   * transitions, and the flag on the two notes that LAUNCH one, never on the 50
   * that ends the run. Read as "hammered INTO from the previous note" it would
   * have had to be on 48 and 50, which the source does not do.
   *
   * 673 notes across the audit corpus, 274 of them one song's opening bass riff.
   */
  hp?: boolean;
  /**
   * Per-note ACCENT level, `1` (accent) or `2` (the rarer heavy accent). A
   * SECOND, independent dynamics channel from the sticky beat `velocity`: one tab
   * carries 471 of these and only 5 sticky marks on its drums, so for that tab
   * this is the ONLY dynamic information in the score. Composes with the ladder
   * rather than replacing it; see `songsterrArticulation.ts`.
   */
  accentuated?: number;
  /**
   * DEAD note (the X notehead): the string is fretted but muted, so it is a
   * percussive click with no pitch content. 489 in the audit corpus.
   */
  dead?: boolean;
  /** STACCATO: detached, shorter than written. 36 in the audit corpus. */
  staccato?: boolean;
  /**
   * SLIDE, and a STRING, not a boolean: `"shift"` `"legato"` `"downwards"`
   * `"below"` `"above"` `"upwards"` `"belowupwards"`. Only the first two have a
   * written destination note; the rest glide into or out of a pitch the score
   * never states. Coercing this to a boolean would author a slide-out-of-nowhere
   * as a legato connection to whatever note happens to follow it, which is why
   * the value is read. See `SONGSTERR_SLIDE_KINDS`.
   */
  slide?: string;
  /**
   * A full pitch-BEND envelope: `{tone, points:[{position, tone}]}`, `position`
   * 0..60 across the note's own duration and `tone` in hundredths of a whole
   * tone. Declared so the field census can see and report it; deliberately NOT
   * read, because a stored step and the live stream are both note-only and the
   * neutral model has nowhere to put a continuous controller.
   */
  bend?: { tone?: number; points?: { position: number; tone: number }[] };
  /** Vibrato on the note. Declared for the census; needs a continuous-controller path. */
  vibrato?: boolean;
  /** Wide vibrato. Declared for the census; needs a continuous-controller path. */
  wideVibrato?: boolean;
  /** `"natural"` / `"pinch"` / `"feedback"` / `"semi"`. Declared for the census. */
  harmonic?: string;
  /** Which fret the harmonic is touched at. Declared for the census. */
  harmonicFret?: number;
  /** A pick scraped along the string. Declared for the census. */
  pickScrape?: string;
}
export interface SsBeat {
  notes?: SsNote[];
  rest?: boolean;
  velocity?: string;
  /** ACTUAL fraction of a whole note (dots folded in): [num, den]. */
  duration: [number, number];
  /**
   * This beat is a GRACE ornament attached to the next one. A STRING in the
   * source, not a boolean: `"onBeat"` or `"beforeBeat"`,
   * Guitar Pro's two grace placements. Both fold to the same place at step
   * resolution, so the value is read for presence only.
   *
   * Its `duration` is an engraving hint, NOT time the measure spends: censusing
   * two tabs (2026-07-27), every voice's durations sum to exactly the
   * measure length once the grace beats are subtracted, and over it by exactly
   * the grace duration when they are not. So it must not advance the cursor.
   */
  graceNote?: string | boolean;
  /**
   * Guitar Pro's LET-RING: the note sustains past its written length, until the
   * same string is struck again. Acted on since 2026-07-27 (it used to reach
   * `MelodicCell.letRing` and stop there, with no warning that it went no
   * further, which is what silently dried out one song's whole 18-bar intro
   * piano, all 86 of whose onsets are marked). Now a GATE EXTENSION, bounded by
   * the next strike of the same pitch, the end of the source's own let-ring run,
   * and `letRingMaxBeats`; see `songsterrArticulation.ts`.
   *
   * Purely engraving fields on the same beat (`type`, `dots`, `beamStart`,
   * `beamStop`) stay unread: `duration` already has dots folded in.
   */
  letRing?: boolean;
  /**
   * PALM MUTE: the picking hand damps the strings, so the note is both SHORTER
   * and DARKER. The most frequent articulation in the audit corpus by a wide
   * margin (1,149 beats; 756 on one song's lead guitar alone, continuously from
   * m11 to m237), and the riffs of the songs that use it ARE the contrast between
   * muted chugs and open ringing notes.
   *
   * A note field can only say the "shorter" half, so the gate carries it and a
   * modest velocity trim stands in for the darkness. Both halves are reported and
   * separately overridable; the reasoning is in `songsterrArticulation.ts`.
   */
  palmMute?: boolean;
  /** Tapped with the picking hand. Declared for the census; no note-level equivalent. */
  tapping?: boolean;
  /** Vibrato on the beat. Declared for the census; needs a continuous-controller path. */
  vibrato?: boolean;
  /** A crescendo / decrescendo ACROSS notes. Declared for the census; needs span resolution. */
  gradualVelocity?: string;
  /** Tremolo picking at the given subdivision. Declared for the census. */
  tremolo?: [number, number];
  /** Wah pedal position. Declared for the census; needs a continuous-controller path. */
  wahwah?: string;
  /** Whammy-bar vibrato. Declared for the census; needs a continuous-controller path. */
  vibratoWithTremoloBar?: string;
  /** A strummed chord spread over time. Declared for the census. */
  brushStroke?: { direction?: string; duration?: number; shift?: number };
  /** Strum direction. Declared for the census. */
  upStroke?: number;
  /** Performance text / lyric printed on the beat. Declared for the census. */
  text?: { text?: string; width?: number };
}
export interface SsVoice {
  beats: SsBeat[];
  /** The whole voice rests in this measure. Unread: its beats carry `rest` too. */
  rest?: boolean;
}
export interface SsMeasure {
  voices: SsVoice[];
  /** Present only when the signature changes; carry the last one forward. */
  signature?: [number, number];
  /** Section marker (Intro/Verse/Bridge/…); present only when it changes. */
  marker?: { text?: string };
  /** The whole measure rests. Unread: its voices' beats carry `rest` too. */
  rest?: boolean;
  /**
   * Swing ("triplet feel"): `"8th"` / `"16th"` say the written straight 8ths / 16ths are PLAYED as
   * long-short triplet pairs; `"off"` ends it. Present only when it changes, so it is sticky.
   */
  tripletFeel?: string;
}
/**
 * One Songsterr part, drum or melodic.
 *
 * Named `DrumPart` before the melodic path existed; `SongsterrPart` is the
 * accurate name and the one to use in new code. Kept as one interface (rather
 * than a drum/melodic union) because the measure/voice/beat walk is identical
 * for both and only `tuning` differs.
 */
export interface SongsterrPart {
  measures: SsMeasure[];
  automations?: { tempo?: { measure: number; position?: number; bpm: number }[] };
  /**
   * MELODIC parts only: the open-string MIDI note of each string, indexed by
   * `SsNote.string`. Present at the TOP level of the part JSON next to `strings`
   * and `frets`. Its PRESENCE is the melodic/drum discriminator (`isMelodicPart`).
   */
  tuning?: number[];
  /** DRUM parts only: Songsterr's flag that the staff is percussion, not pitched. */
  tuningFlat?: boolean;
  /** String count (informational; `tuning.length` is what the decode uses). */
  strings?: number;
  /** General MIDI instrument name, when the part JSON carries one. */
  instrument?: string;
}
/** Back-compat alias of `SongsterrPart`; the shape was never drum-only. */
export type DrumPart = SongsterrPart;

/**
 * Does this part store pitched notes (string+fret against a tuning) rather than
 * GM percussion numbers? The check is the part's own `tuning` array, not the
 * instrument name: a tab can label a part anything, but only a melodic staff
 * carries open-string tunings, and only a percussion staff carries `tuningFlat`.
 */
export function isMelodicPart(part: SongsterrPart): boolean {
  return Array.isArray(part.tuning) && part.tuning.length > 0;
}

// ── Flattened forms ──────────────────────────────────────────────────

/** One measure's location + state, in quarter-note beats. */
export interface MeasureInfo {
  /** 0-based measure index (the JSON order). Displayed measure numbers are this + 1. */
  index: number;
  /** Quarter-note beat where this measure starts. */
  startBeat: number;
  signature: [number, number];
  /** Tempo (bpm) in force at this measure. */
  bpm?: number;
  /** Section marker text, if this measure begins one (Songsterr is sticky). */
  marker?: string;
  /** The swing in force (the source's sticky `tripletFeel`), when it is on and applied. */
  swing?: SwingFeel;
}

/** A triplet feel the importer plays: which written straight note value is swung. */
export type SwingFeel = '8th' | '16th';

/** The span (quarter beats) one long-short pair covers: an 8th feel swings each quarter, a 16th feel each 8th. */
const SWING_SPAN: Readonly<Record<SwingFeel, number>> = { '8th': 1, '16th': 0.5 };

/**
 * Where a WRITTEN position actually sounds under the measure's triplet feel. Each pair of straight notes
 * becomes a triplet long-short: the first half of every span stretches to 2/3 of it and the second half
 * squeezes into the last 1/3. Piecewise linear, so a note that ends where the next starts still does.
 */
export function swingBeat(measures: readonly MeasureInfo[], beat: number): number {
  let lo = 0;
  let hi = measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid].startBeat <= beat + 1e-9) lo = mid; else hi = mid - 1;
  }
  const m = measures[lo];
  if (m === undefined || m.swing === undefined) return beat;
  const span = SWING_SPAN[m.swing];
  const rel = beat - m.startBeat;
  const k = Math.floor(rel / span + 1e-9);
  const f = Math.max(0, rel - k * span);
  const half = span / 2;
  const g = f <= half ? f * (4 / 3) : (2 / 3) * span + (f - half) * (2 / 3);
  return m.startBeat + k * span + g;
}

/** A tempo mark, with its measure resolved to a quarter-note beat offset. */
export interface TempoMark {
  measure: number;
  beat: number;
  bpm: number;
}

/**
 * A detected pickup (anacrusis) bar: the song's FIRST measure is shorter than
 * the prevailing bar, so from MIDI Start every later barline sits `pad_steps`
 * off the 4-beat grid a clock-slaved device counts (a measure-quantized
 * looper record-start then NEVER lands on the song's one, and a chain whose
 * cycle is a non-whole-bar total compounds the offset every wrap — the
 * 2026-08-08 RC-505mk2 finding on two pickup-bar song builds).
 */
export interface PickupBarInfo {
  /** Steps in the partial first bar, at the import's step grid. */
  pickup_steps: number;
  /** Steps in the prevailing full bar (measure 2's signature). */
  prevailing_bar_steps: number;
  /** Rest steps to prepend so the head fills one whole prevailing bar. */
  pad_steps: number;
  /** e.g. "2/4". */
  pickup_signature: string;
  /** e.g. "4/4". */
  prevailing_signature: string;
}

/**
 * Detect a leading pickup bar. Deliberately conservative: fires only when m1
 * is SHORTER than m2's bar AND m1's signature occurs nowhere else in the song
 * — a signature that recurs is alternating/odd metre, not an anacrusis, and
 * padding it would corrupt the music. Returns undefined when either bar's
 * width is not a whole number of steps at this grid (nothing honest to say).
 */
export function detectPickupBar(
  measures: readonly MeasureInfo[],
  stepsPerBeat: number,
): PickupBarInfo | undefined {
  if (measures.length < 2) return undefined;
  const beatsOf = (m: MeasureInfo): number => (m.signature[0] * 4) / m.signature[1];
  const sigOf = (m: MeasureInfo): string => `${m.signature[0]}/${m.signature[1]}`;
  const b1 = beatsOf(measures[0]);
  const b2 = beatsOf(measures[1]);
  if (!(b1 < b2)) return undefined;
  const k1 = sigOf(measures[0]);
  for (let i = 1; i < measures.length; i++) {
    if (sigOf(measures[i]) === k1) return undefined;
  }
  const pickupSteps = b1 * stepsPerBeat;
  const barSteps = b2 * stepsPerBeat;
  if (!Number.isInteger(pickupSteps) || !Number.isInteger(barSteps)) return undefined;
  return {
    pickup_steps: pickupSteps,
    prevailing_bar_steps: barSteps,
    pad_steps: barSteps - pickupSteps,
    pickup_signature: k1,
    prevailing_signature: sigOf(measures[1]),
  };
}

/** A named section: the marker text + the measure/beat it begins at. */
export interface SectionInfo {
  name: string;
  startMeasure: number;
  startBeat: number;
}

export interface SongsterrFlat {
  /** Onsets moved by the source's triplet feel (swing), and how many measures it covers. */
  swung_onsets: number;
  swung_measures: number;
  events: DrumEvent[];
  /** Total length of the track in quarter-note beats. */
  totalBeats: number;
  /** First tempo mark, if any (kept for back-compat; prefer `tempoAtBeat`). */
  bpm?: number;
  /** Full tempo map (measure → beat → bpm), sorted by beat. */
  tempos: TempoMark[];
  /** Last time signature seen (carried forward). */
  signature: [number, number];
  /** Per-measure index (start beat, signature, local tempo, section marker). */
  measures: MeasureInfo[];
  /** Named sections (the subset of measures that begin a marker). */
  sections: SectionInfo[];
  /** Count of hits whose GM number mapped to no voice (exotic percussion). */
  unmapped: number;
  /**
   * WHICH percussion numbers went unmapped, with hit counts — the actionable
   * half of `unmapped` (a bare count told nobody what to fix; "number 0 × 75"
   * is a diagnosis). Remap via the `drumMap` option.
   */
  unmapped_numbers: Record<number, number>;
  /**
   * Grace/flam doublings folded into single hits: Songsterr writes a flam as
   * the same fret twice in one beat (one note ghosted). We cannot place a
   * sub-tick grace note, so the beat emits ONE event; the fold is counted here
   * (previously these surfaced as phantom same-step "collisions").
   */
  flams_collapsed: number;
  /**
   * Hits imported as GHOST (soft) rather than dropped: the source's per-note
   * `ghost` flag or a sticky `pp`/`ppp` dynamic. Reported so the ghost policy is
   * visible rather than magic: a ghost note is PLAYED, quietly (velocity 40 at
   * quantize time), because Songsterr uses the same flag for real ghost snares
   * and for engraving-only markers, and dropping every one would delete groove.
   */
  ghosts: number;
  /**
   * Grace-ornament beats folded onto the following onset. Songsterr's second
   * flam encoding: a separate beat flagged `graceNote`, whose `duration` is an
   * engraving hint rather than time the measure spends. Its notes are emitted at
   * the CURRENT position as ghosts and the cursor does not advance, so the rest
   * of the measure keeps its timing.
   */
  graces_folded: number;
  /**
   * Hits carrying the source's own per-note `accentuated` mark, imported as a
   * velocity BUMP on top of whatever the sticky dynamic already said. A second
   * dynamics channel: one drum part writes 28 heavy accents and NO sticky
   * marks at all, so before this was read its groove imported dead flat.
   */
  accents: number;
  /** Every source field this part carries, keyed `"<level>.<field>"`; the census the report subtracts from. */
  field_census: FieldCensus;
  /** How many times the flattener ACTED on each field. Zero on a read field means it was dropped. */
  fields_applied: AppliedFields;
}

/** The swing switch, shared by every flatten and import option set. */
export interface FeelOptions {
  /**
   * Read a swung tab STRAIGHT. Default false: a measure the source marks with a triplet feel
   * (`tripletFeel: "8th"` / `"16th"`) plays its written straight pairs as triplet long-short, which is
   * what the marking means and what Songsterr's own player does. True keeps the written grid.
   */
  straightFeel?: boolean;
}

export interface FlattenOptions extends FeelOptions {
  /**
   * Per-source percussion remap: source number → neutral voice name ("clap")
   * or GM number (39). Applied BEFORE the GM lookup, so numbers outside (or
   * wrongly inside) GM import correctly. Example: one tab writes its clap
   * layer on number 0 → `{0: 'clap'}`.
   */
  drumMap?: Readonly<Record<number, string | number>>;
  /**
   * Velocity for a hit the source marks `ghost:true`. Default
   * `GHOST_HIT_VELOCITY` (40) against a plain hit of 100. A ghost note always
   * SOUNDS; this sets how quietly, and there is deliberately no value that
   * silences it. Raise it if a target's pads are velocity-insensitive enough
   * that 40 is inaudible, lower it for a lighter touch.
   */
  ghostVelocity?: number;
  /**
   * Per-import overrides for the dynamic ladder, merged over
   * `SONGSTERR_DYNAMIC_VELOCITY`: marking → velocity, e.g. `{ p: 50 }`. Use when
   * a tab's engraver writes dynamics harder or softer than the default reading.
   */
  dynamicVelocity?: Readonly<Record<string, number>>;
}

/** Drum flatten options, plus the articulation knobs a drum hit can use (accent only). */
export interface DrumFlattenOptions extends FlattenOptions, ArticulationOptions {
  /**
   * OPT-IN: split the six GM toms (41/43/45/47/48/50) into distinct lanes
   * (`tom_flo`/`tom_fhi`/`tom_lo`/`tom_lm`/`tom_hm`/`tom_hi`) so two toms struck
   * together survive as separate voices instead of collapsing onto one `tom`.
   * Default **false** → byte-identical output (all toms → `tom`). Threaded only
   * to the GM lookup; the lanes fold back to `tom`/`snare`/`perc` on any device
   * that lacks them (`drumFold.ts`), so a single-tom kit still plays them.
   */
  splitToms?: boolean;
}

/**
 * Songsterr's OWN percussion numbering beyond GM — a DECODE, not a guess:
 * extracted 2026-07-02 from Songsterr's player code (the `DrumLegend` chunk's
 * percussion-constants object in the production vendor bundle at
 * static3.songsterr.com). GM defines 35-81; these are the extra numbers
 * Songsterr tabs legitimately carry. Each maps to the neutral voice of its
 * musical function; articulations a step grid cannot express (rim shot, half
 * hat, edge, chokes) collapse to their parent drum's voice. Note number 0 is
 * NOT in Songsterr's table either (their legend special-cases unknown numbers),
 * so a tab using it still needs an explicit `drumMap`. A caller `drumMap`
 * overrides every entry here.
 *
 * **`DrumLegend` is a NOTATION legend, not a voice map, so 27-34 are
 * deliberately absent (2026-07-27).** The legend says what glyph and label to
 * DRAW for a number; using it as a sounding map was the silent-china defect.
 * Numbers 27-34 are the GM2/GS *effect* block (High Q, Slap, Scratch Push,
 * Scratch Pull, Sticks, Square Click, Metronome Click, Metronome Bell): studio
 * and engraving artefacts, not kit voices anyone plays, and a metronome click is
 * emphatically not part of the song. One tab's drum part
 * writes 103 of its 964 notes as `{fret:30, string:-1.5, ghost:true}`
 * and Songsterr's own player does not sound one of them; we folded all 103 to
 * `perc` → GM 56 → an SPD-SX china pad, audibly wrong. Dropping the entries
 * routes those hits to `unmapped_numbers`, so the import REPORTS "103 hits on
 * number 30" instead of inventing a voice, and a caller who decides they should
 * sound passes `drumMap: {30: 'snare'}`, which overrides everything below.
 * DO NOT restore 27-34 without a per-number musical justification.
 */
export const SONGSTERR_DRUM_EXTENSIONS: Readonly<Record<number, string>> = {
  // 27-34 (the GM2/GS effect block) intentionally omitted; see above.
  82: 'maracas',    // Shaker
  83: 'perc',       // Jingle bell
  84: 'triangle',   // Bell tree
  85: 'claves',     // Castanets
  86: 'tom',        // Mute surdo
  87: 'tom',        // Open surdo
  91: 'snare',      // Snare rim shot
  92: 'hat',        // Half hi-hat
  93: 'ride',       // Ride edge
  94: 'ride',       // Ride cymbal choke
  95: 'crash',      // Splash cymbal choke
  96: 'crash',      // Chinese cymbal choke
  97: 'crash',      // Crash cymbal choke
  98: 'crash',      // Crash cymbal 2 choke
  99: 'perc',       // Low cowbell
  102: 'perc',      // High cowbell
};

/** The bpm in force at a given quarter-note beat (last mark at/before it). */
export function tempoAtBeat(flat: Pick<SongsterrFlat, 'tempos'>, beat: number): number | undefined {
  let bpm: number | undefined;
  for (const t of flat.tempos) {
    if (t.beat <= beat + 1e-9) bpm = t.bpm; else break;
  }
  return bpm ?? flat.tempos[0]?.bpm;
}

/** The part's timeline: where each measure starts, in what meter, at what tempo. */
interface MeasureIndex {
  measures: MeasureInfo[];
  sections: SectionInfo[];
  tempos: TempoMark[];
  /** Last signature seen (carried forward). */
  signature: [number, number];
  /** Total length of the part in quarter-note beats. */
  totalBeats: number;
}

/**
 * Walk the measure list ONLY (no notes): signature + marker carry-forward, each
 * measure's start beat, the resolved tempo map, and the total length. Shared by
 * the drum and melodic flatteners, which differ solely in how they read a note.
 *
 * `position` on a tempo mark is a sub-measure offset in the source; it is 0 in
 * every sample seen, so it is left unapplied.
 */
function indexMeasures(part: SongsterrPart, applied?: AppliedFields, straightFeel = false): MeasureIndex {
  const measures: MeasureInfo[] = [];
  const sections: SectionInfo[] = [];
  const apply = (key: string): void => { if (applied !== undefined) applied[key] = (applied[key] ?? 0) + 1; };
  let start = 0;
  let sig: [number, number] = [4, 4];
  // Sticky like the signature. An unrecognised value turns swing off rather than being guessed at, and
  // stays unapplied, so the dropped-fidelity report names it as parsed-not-authored.
  let swing: SwingFeel | undefined;
  if ((part.automations?.tempo ?? []).length > 0) apply('part.automations');
  for (let mi = 0; mi < part.measures.length; mi++) {
    const measure = part.measures[mi];
    if (measure.signature) { sig = measure.signature; apply('measure.signature'); }
    if (typeof measure.tripletFeel === 'string') {
      const feel = measure.tripletFeel;
      swing = !straightFeel && (feel === '8th' || feel === '16th') ? feel : undefined;
      if (swing !== undefined || (!straightFeel && feel === 'off')) apply('measure.tripletFeel');
    }
    const markerText = measure.marker?.text;
    if (markerText !== undefined) apply('measure.marker');
    measures.push({
      index: mi, startBeat: start, signature: [sig[0], sig[1]], marker: markerText,
      ...(swing !== undefined ? { swing } : {}),
    });
    if (markerText) sections.push({ name: markerText, startMeasure: mi, startBeat: start });
    start += (sig[0] * 4) / sig[1];
  }
  const tempos: TempoMark[] = (part.automations?.tempo ?? [])
    .map((t) => ({ measure: t.measure, beat: measures[t.measure]?.startBeat ?? 0, bpm: t.bpm }))
    .sort((a, b) => a.beat - b.beat);
  // Backfill each measure's in-force tempo now that the map exists.
  for (const m of measures) m.bpm = tempoAtBeat({ tempos }, m.startBeat);
  return { measures, sections, tempos, signature: sig, totalBeats: start };
}

/**
 * Walk measures → voices → beats → notes, accumulating each onset's position in
 * QUARTER-NOTE beats (the unit `quantizeDrumEvents` expects: stepsPerBeat=4 →
 * 16th grid). `duration` is the actual fraction of a whole note, so a length in
 * quarter beats = (num/den) * 4. Signature, marker, AND dynamic (velocity) are
 * all carried forward (Songsterr emits each only on change). Voices within a
 * measure each run their own timeline from the measure start.
 *
 * **Ghost policy: a ghosted hit SOUNDS, quietly (2026-07-27).** `ghost` marks a
 * quiet hit, not a silent one; it becomes velocity 40 (`GHOST_HIT_VELOCITY`),
 * overridable per import via `ghostVelocity`. There is deliberately no setting
 * that silences it. It is tempting to drop ghosts, since Songsterr's playback of
 * one tab's ghosted number-30 notes is silent, but that reads the wrong cause:
 * those 103 notes were inaudible because number 30 is a non-kit effect number,
 * now unmapped, NOT because they were ghosted. The same drum part ghosts 3 of
 * its 61 snare hits, 2 electric snares, a tom and all 3 pedal-hat hits: real
 * groove that a blanket drop would silently delete, and one classic-rock groove
 * turns on exactly such a soft tail snare. The count is surfaced as `ghosts` so
 * the policy is inspectable, and a caller who wants a ghosted layer routed
 * elsewhere still has `drumMap`.
 *
 * **Dynamics are a LADDER, not three buckets.** The sticky `velocity` marking
 * resolves through `SONGSTERR_DYNAMIC_VELOCITY`, so `p` / `mp` / `mf` land
 * between a ghost and a plain hit instead of collapsing onto the plain hit. Only
 * the values the accent/ghost flags cannot express are carried on the event, so
 * a tab written in fff / f / pp alone flattens exactly as it did before.
 *
 * **And the ladder is only ONE of the two dynamics channels.** The source's own
 * per-note `accentuated` mark is independent of it, and on some tabs it is the
 * only one present: one drum part carries 28 heavy accents and no sticky
 * marks whatsoever. It resolves as a BUMP on top of the ladder, never as a
 * replacement for it, so an accent inside a `p` passage is louder than its
 * neighbours without becoming louder than the `f` passage next door.
 *
 * A drum step has no gate field and no tie (verified in the `.ncs` layout), so
 * velocity is the ONLY articulation channel here: `palmMute` / `dead` / the
 * legato family are melodic-only and are reported by `dropped_fidelity` on a
 * percussion part rather than pretended at.
 */
export function flattenSongsterrDrums(part: SongsterrPart, opts: DrumFlattenOptions = {}): SongsterrFlat {
  const events: DrumEvent[] = [];
  let dynamic: string | undefined;
  let unmapped = 0;
  const unmappedNumbers: Record<number, number> = {};
  let flamsCollapsed = 0;
  let ghosts = 0;
  let gracesFolded = 0;
  let accents = 0;
  const ghostVel = opts.ghostVelocity ?? GHOST_HIT_VELOCITY;
  const art = resolveArticulationOptions(opts);
  const applied: AppliedFields = {};
  const apply = (key: string): void => { applied[key] = (applied[key] ?? 0) + 1; };
  const idx = indexMeasures(part, applied, opts.straightFeel === true);
  const dynVelocity = opts.dynamicVelocity !== undefined
    ? { ...SONGSTERR_DYNAMIC_VELOCITY, ...opts.dynamicVelocity }
    : SONGSTERR_DYNAMIC_VELOCITY;

  for (let mi = 0; mi < part.measures.length; mi++) {
    const measure = part.measures[mi];
    const measureStart = idx.measures[mi].startBeat;

    for (const voice of measure.voices ?? []) {
      let pos = measureStart;
      for (const beat of voice.beats ?? []) {
        if (beat.velocity) { dynamic = beat.velocity; apply('beat.velocity'); }   // sticky dynamic
        // A grace beat is an ORNAMENT: its notes belong on the following onset
        // and its duration is engraving, not elapsed time. Emitting it and then
        // advancing pushed the whole rest of the measure late by up to 0.375
        // quarter beats (1.5 sixteenth steps in one tab's m89), so the notes land
        // at the current position, ghosted, and the cursor stays put. Same-voice
        // grace + main then share a step and the quantizer keeps the loud one,
        // which is the existing flam policy; a grace on a DIFFERENT voice keeps
        // its own hit instead of being thrown away. Tested for PRESENCE, not
        // equality: the source writes "onBeat" / "beforeBeat" here, so a
        // `=== true` check silently matches neither.
        const isGrace = beat.graceNote !== undefined && beat.graceNote !== false && beat.graceNote !== '';
        const durBeats = isGrace ? 0 : (beat.duration[0] / beat.duration[1]) * 4;
        apply('beat.duration');
        if (beat.rest === true) apply('beat.rest');
        // Read whether or not the BEAT also rests: Songsterr writes a rest beat as
        // `{rest, notes:[{rest}]}`, and the census sees both levels.
        for (const n of beat.notes ?? []) if (n.rest === true) apply('note.rest');
        if (!beat.rest) {
          // Group the beat's notes by fret: a repeated fret is FLAM/grace
          // notation (one copy ghosted) — one musical hit, un-placeable at
          // sub-tick resolution, so it folds to a single event (counted).
          const byFret = new Map<number, SsNote[]>();
          for (const note of beat.notes ?? []) {
            if (note.rest || typeof note.fret !== 'number') continue;
            const group = byFret.get(note.fret) ?? [];
            group.push(note);
            byFret.set(note.fret, group);
          }
          for (const [fret, group] of byFret) {
            if (group.length > 1) flamsCollapsed += group.length - 1;
            // Lookup order: caller remap (number → voice name or GM number) →
            // GM dictionary → Songsterr's own extended numbering (decoded from
            // their player). Unmapped numbers are counted BY NUMBER so the
            // caller can see what to remap instead of a blind total.
            const remap = opts.drumMap?.[fret];
            const target = typeof remap === 'number' ? remap : fret;
            const v = typeof remap === 'string' ? remap : (gmDrumToVoice(target, opts.splitToms) ?? SONGSTERR_DRUM_EXTENSIONS[target]);
            if (v === undefined) {
              unmapped += group.length;
              unmappedNumbers[fret] = (unmappedNumbers[fret] ?? 0) + group.length;
              continue;
            }
            // Ghost: the note's own flag (every copy ghosted), a grace ornament,
            // or the sticky soft dynamic; a ghosted note is never also an accent.
            // Ghost means QUIET, not silent; see the ghost policy above.
            const noteGhost = isGrace || group.every((g) => g.ghost === true);
            if (group.some((g) => g.ghost === true)) apply('note.ghost');
            const ghost = noteGhost || (dynamic ? GHOST.has(dynamic) : false);
            const accent = !ghost && (dynamic ? ACCENT.has(dynamic) : false);
            if (ghost) ghosts++;
            if (isGrace) { gracesFolded++; apply('beat.graceNote'); }
            // Velocity from the FULL ladder. A per-note ghost is the more
            // specific mark, so it wins over the sticky dynamic. Carry the number
            // only when the accent/ghost flags alone would get it wrong, which
            // keeps a tab written in just fff / f / pp byte-identical to before
            // and adds real dynamics to one written in p / mp / mf.
            const flagVelocity = ghost ? GHOST_HIT_VELOCITY : accent ? ACCENT_HIT_VELOCITY : PLAIN_HIT_VELOCITY;
            const ladder = noteGhost ? ghostVel : (dynamic !== undefined ? dynVelocity[dynamic] : undefined) ?? flagVelocity;
            // The SECOND dynamics channel: the loudest per-note `accentuated`
            // level in the group bumps the ladder reading. Read the whole group
            // (a flam's two copies can differ) and take the strongest.
            const level = group.reduce<number | undefined>(
              (best, g) => (typeof g.accentuated === 'number' && (best === undefined || g.accentuated > best) ? g.accentuated : best),
              undefined,
            );
            if (level !== undefined) {
              accents++;
              if (art.on) apply(`note.accentuated=${level}`);
            }
            const velocity = resolveArticulatedVelocity(ladder, PLAIN_HIT_VELOCITY, level, {}, art) ?? ladder;
            events.push({
              voice: v, beat: pos,
              // The source number is the MIDI piece unless the caller remapped it to a voice
              // NAME: then the voice decides ({38: 'clap'} must not still play a snare).
              ...(typeof remap !== 'string' && target >= 27 && target <= 87 ? { gm: target } : {}),
              ...(accent ? { accent } : {}),
              ...(ghost ? { ghost } : {}),
              ...(velocity !== flagVelocity ? { velocity } : {}),
            });
          }
        }
        pos += durBeats;
      }
    }
  }

  // Swing moves where a written onset SOUNDS, so it runs after the walk: every position above is the
  // written one, which is what the voice cursor and the grace fold reason about.
  let swungOnsets = 0;
  for (const e of events) {
    const at = swingBeat(idx.measures, e.beat);
    if (Math.abs(at - e.beat) > 1e-9) { e.beat = at; swungOnsets++; }
  }
  events.sort((a, b) => a.beat - b.beat);
  return {
    swung_onsets: swungOnsets, swung_measures: idx.measures.filter((m) => m.swing !== undefined).length,
    events, totalBeats: idx.totalBeats, bpm: idx.tempos[0]?.bpm, tempos: idx.tempos,
    signature: idx.signature, measures: idx.measures, sections: idx.sections, unmapped,
    unmapped_numbers: unmappedNumbers, flams_collapsed: flamsCollapsed,
    ghosts, graces_folded: gracesFolded, accents,
    field_census: censusSongsterrFields(part), fields_applied: applied,
  };
}

/** Render the unmapped-number histogram as "0×75, 31×2" (empty string if none). */
export function unmappedSummary(flat: Pick<SongsterrFlat, 'unmapped_numbers'>): string {
  return Object.entries(flat.unmapped_numbers)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(', ');
}

export interface SongsterrImportOptions extends ArticulationOptions, FeelOptions {
  /** First quarter-note beat of the window (0-based). Default 0. Overridden by fromMeasure/section. */
  fromBeat?: number;
  /** Window length in quarter-note beats. Default: to the next section/measure boundary, else the whole track. */
  beats?: number;
  /** Grid resolution (steps per beat). 4 = 16ths (default), 8 = 32nds. */
  stepsPerBeat?: number;
  /** Start at this DISPLAYED measure number (1-based, matching the tab UI). Resolves to its beat. */
  fromMeasure?: number;
  /** End after this displayed measure number (1-based, inclusive). Sets the window length. */
  toMeasure?: number;
  /** Start at this named section ("Bridge"); case-insensitive. Length runs to the next section unless beats/toMeasure is given. */
  section?: string;
  /** Per-source percussion remap (see FlattenOptions.drumMap): number → voice name or GM number. */
  drumMap?: Readonly<Record<number, string | number>>;
  /** Velocity for a `ghost:true` hit (see FlattenOptions.ghostVelocity). Default 40; a ghost always sounds. */
  ghostVelocity?: number;
  /** Dynamic-ladder overrides (see FlattenOptions.dynamicVelocity), merged over SONGSTERR_DYNAMIC_VELOCITY. */
  dynamicVelocity?: Readonly<Record<string, number>>;
  /**
   * DRUM parts only: split the GM toms into distinct lanes (see `DrumFlattenOptions.splitToms`).
   * Declared here because `importSongsterrDrums` used to drop it: callers passed it through an
   * `as never` cast, the flattener never saw it, and every tom still collapsed onto one lane.
   */
  splitToms?: boolean;
}

export interface SongsterrDrumImport extends QuantizedDrums {
  /** Total quarter-note beats of drum content found (so a caller can window it). */
  total_beats: number;
  /** Tempo IN FORCE at the window start (not tempo[0]). */
  bpm?: number;
  signature: [number, number];
  /** The resolved window, for the caller to echo back. */
  window: { fromBeat: number; beats: number; fromMeasure?: number; section?: string };
  /** Hits carrying a per-note `accentuated` mark, folded into velocity as a bump. */
  accents: number;
  /**
   * TRACK-WIDE: every source field the authoring path did not carry, split into
   * "never read" and "read then dropped". A drum step has no gate and no tie, so
   * on a percussion part the length articulations land here honestly rather than
   * being pretended at.
   */
  dropped_fidelity: DroppedFidelity;
}

/** The timeline fields a window resolves against; drum and melodic flats both have them. */
type Windowable = Pick<SongsterrFlat, 'sections' | 'measures' | 'totalBeats'>;

/** Resolve fromMeasure/toMeasure/section into a concrete {fromBeat, beats} window. */
function resolveWindow(flat: Windowable, opts: SongsterrImportOptions): { fromBeat: number; beats: number; fromMeasure?: number; section?: string } {
  let fromBeat = opts.fromBeat ?? 0;
  let fromMeasure: number | undefined;
  let sectionName: string | undefined;
  let endBeat: number | undefined;

  if (opts.section !== undefined) {
    const want = opts.section.toLowerCase();
    const idx = flat.sections.findIndex((s) => s.name.toLowerCase().includes(want));
    if (idx < 0) throw new Error(`section "${opts.section}" not found. Available: ${flat.sections.map((s) => s.name).join(', ') || '(none)'}`);
    fromBeat = flat.sections[idx].startBeat;
    fromMeasure = flat.sections[idx].startMeasure + 1;
    sectionName = flat.sections[idx].name;
    endBeat = flat.sections[idx + 1]?.startBeat ?? flat.totalBeats;  // to the next section
  }
  if (opts.fromMeasure !== undefined) {
    const m = flat.measures[opts.fromMeasure - 1];                    // displayed (1-based) → index
    if (!m) throw new Error(`measure ${opts.fromMeasure} out of range (song has ${flat.measures.length} measures)`);
    fromBeat = m.startBeat;
    fromMeasure = opts.fromMeasure;
    endBeat = undefined;
  }
  if (opts.toMeasure !== undefined) {
    const next = flat.measures[opts.toMeasure];                       // measure AFTER the last (exclusive end)
    endBeat = next ? next.startBeat : flat.totalBeats;
  }

  const beats = opts.beats ?? (endBeat !== undefined ? endBeat - fromBeat : Math.max(1, Math.ceil(flat.totalBeats) - fromBeat));
  return { fromBeat, beats, fromMeasure, section: sectionName };
}

/**
 * Flatten a Songsterr drum part and quantize a WINDOW of it onto a step grid —
 * the single-pattern entry point, mirroring `importMidiDrums`. The window can be
 * addressed by beat (fromBeat/beats), by DISPLAYED measure (fromMeasure/toMeasure,
 * 1-based), or by section NAME ("Bridge"). The returned `bpm` is the tempo IN
 * FORCE at the window start, not the song's opening tempo. For the whole song
 * (a deduped bank + arrangement), feed `flattenSongsterrDrums(...).events` to
 * `decomposeToPatterns`.
 */
export function importSongsterrDrums(part: SongsterrPart, opts: SongsterrImportOptions = {}): SongsterrDrumImport {
  const flat = flattenSongsterrDrums(part, {
    drumMap: opts.drumMap,
    ...(opts.ghostVelocity !== undefined ? { ghostVelocity: opts.ghostVelocity } : {}),
    ...(opts.dynamicVelocity !== undefined ? { dynamicVelocity: opts.dynamicVelocity } : {}),
    ...(opts.articulations !== undefined ? { articulations: opts.articulations } : {}),
    ...(opts.accentBump !== undefined ? { accentBump: opts.accentBump } : {}),
    ...(opts.splitToms === true ? { splitToms: true } : {}),
    ...(opts.straightFeel === true ? { straightFeel: true } : {}),
  });
  const stepsPerBeat = opts.stepsPerBeat ?? 4;
  const window = resolveWindow(flat, opts);

  const windowed = flat.events
    .map((e) => ({ ...e, beat: e.beat - window.fromBeat }))
    .filter((e) => e.beat >= -0.001 && e.beat < window.beats);

  const q = quantizeDrumEvents(windowed, { beats: window.beats, stepsPerBeat });
  if (flat.unmapped > 0) {
    // Track-wide (not window-specific): name the NUMBERS so the fix is one
    // drumMap arg away, and so an empty window is not misread as "the track
    // dropped hits here".
    q.warnings.push(
      `TRACK-WIDE: ${flat.unmapped} hit(s) on non-GM percussion number(s) [${unmappedSummary(flat)}] were skipped. ` +
      `If a layer is missing, remap with drumMap (e.g. {0: 'clap'}) — check what the number plays against the song.`,
    );
  }
  if (flat.flams_collapsed > 0) {
    q.warnings.push(`TRACK-WIDE: ${flat.flams_collapsed} grace/flam doubling(s) folded into single hits (a flam is one hit at step resolution).`);
  }
  if (flat.graces_folded > 0) {
    q.warnings.push(`TRACK-WIDE: ${flat.graces_folded} grace-ornament beat(s) folded onto the following onset (a grace note takes no time in the measure).`);
  }
  if (flat.ghosts > 0) {
    q.warnings.push(
      `TRACK-WIDE: ${flat.ghosts} hit(s) are GHOSTED in the source and import as soft hits (velocity 40), not silence: ` +
      'a ghost note is played quietly. If a ghosted layer should not sound at all, route it with drumMap or drop it downstream.',
    );
  }
  if (flat.accents > 0) {
    q.warnings.push(
      `TRACK-WIDE: ${flat.accents} hit(s) carry the source's own per-note ACCENT mark, imported as a velocity bump on top of the `
      + 'sticky dynamic (level 1 = +20, level 2 = +34), not as a replacement for it. This is a SECOND dynamics channel and on some '
      + 'tabs it is the only one present, so a groove that used to import dead flat now has its accents. Tune with accentBump.',
    );
  }
  const dropped = deriveDroppedFidelity(flat.field_census, flat.fields_applied);
  q.warnings.push(...droppedFidelitySummary(dropped));
  // The window's LOCAL time signature (the measure it starts in), not the song's
  // final one: a windowed section can be in a different meter.
  const startMeasure = flat.measures.filter((m) => m.startBeat <= window.fromBeat + 1e-9).pop();
  const signature = startMeasure ? startMeasure.signature : flat.signature;
  return {
    ...q, total_beats: flat.totalBeats, bpm: tempoAtBeat(flat, window.fromBeat), signature, window,
    accents: flat.accents, dropped_fidelity: dropped,
  };
}

// ── Melodic parts: string + fret → MIDI pitch ────────────────────────
//
// The whole decode is `pitch = tuning[string] + fret`, where `tuning` is the
// part's own top-level open-string array and `string` indexes it DOWNWARD.
// Everything below is the bookkeeping around that one line: ties, chords,
// dynamics, and the step grid.

/**
 * Lowercase scientific-pitch names, sharps only. This is the spelling
 * `miniNotation.parsePitch` round-trips, so a token emitted here re-parses to
 * the same MIDI number; middle C = c4 = 60.
 */
const PITCH_TOKEN_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'] as const;

/** MIDI note → the mini-notation token `apply_pattern` parses ("d#3", "c-1", "g9"). */
export function pitchToken(midi: number): string {
  return `${PITCH_TOKEN_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Onsets within this many beats of a grid line count as on-grid (matches drumScore). */
const MELODIC_ONSET_TOLERANCE = 0.02;
/** Notes per chord token; the Circuit's note-slot limit, same cap the SMF importer uses. */
const MAX_CHORD_NOTES = 6;

/** One pitched onset, before quantization. */
export interface MelodicNote {
  /** Onset in QUARTER-NOTE beats from the track start (the unit the drum path uses). */
  beat: number;
  /** MIDI note number: `tuning[string] + fret`, plus any `transpose`. */
  pitch: number;
  /**
   * Sounding length in quarter-note beats, INCLUDING every tied continuation
   * folded into this onset. A source tie is held, not re-struck, so it shows up
   * here as length rather than as a second note.
   */
  durationBeats: number;
  /** MIDI velocity from the sticky dynamic; omitted when the part is unmarked or marked `f`. */
  velocity?: number;
  /** The source tied one or more following beats INTO this onset. */
  tie?: true;
  /** How many source beats were tied in (>= 1 whenever `tie` is set). */
  tiedBeats?: number;
  /** Guitar Pro let-ring on the beat: sustain past the written length. */
  letRing?: true;
  /** Source `ghost` flag. It does occur on melodic parts, unlike `dead` (guitar-only). */
  ghost?: true;
  /**
   * The source connects this note to the NEXT ONE by legato, and which marking
   * said so. Authored as gate overlap at the grid boundary, never as a tie: a
   * tie into a different pitch is refused on purpose.
   */
  legato?: LegatoCause;
  /** `accentuated` level 1 / 2. Already folded into `velocity`; kept so the receipt can say why. */
  accent?: number;
  /** Beat-level `palmMute`: damped, so shorter and (via a modest velocity trim) darker. */
  palmMute?: true;
  /** Note-level `dead` (X notehead): a percussive click with no pitch content. */
  dead?: true;
  /** Note-level `staccato`: detached, proportionally shorter. */
  staccato?: true;
  /**
   * The RAW `slide` string, when the note carries one that has no written
   * destination (`downwards` / `below` / …) or that this importer does not
   * recognise. Kept so `dropped_fidelity` can name the value instead of counting
   * an anonymous "slide". A targeted slide sets `legato` instead.
   */
  slideUnauthored?: string;
  /** The note is slid INTO from an unwritten pitch (`below` / `above`). Rendered only by `pitchGestures`. */
  slideIn?: 'below' | 'above';
  /** The note slides OUT to an unwritten pitch (`up` / `down`). Rendered only by `pitchGestures`. */
  slideOut?: 'up' | 'down';
  /** The raw source `slide` string whenever `slideIn` / `slideOut` is set, for the applied-field count. */
  slideKind?: string;
  /**
   * The source's bend envelope, verbatim: `position` 0..60 across the note, `tone` in hundredths of a
   * whole tone. Carried, not authored, unless `pitchGestures: 'glide'` renders it.
   */
  bend?: readonly { position: number; tone: number }[];
  /**
   * The length the bend envelope spans, in quarter beats: the struck beat's OWN duration. A tie folds
   * more length into `durationBeats`, and the envelope must not stretch over it; a tie that carries
   * its own bend extends the envelope (and this span) through the tie instead (`foldTieBend`).
   */
  bendBeats?: number;
  /**
   * Vibrato, from the source's note-level `vibrato` / `wideVibrato` or beat-level `vibrato` (the
   * beat-level whammy `vibratoWithTremoloBar` is not read). Carried, not authored, unless the
   * pitch-bend path renders it (songMidi.ts `vibrato`). `from` / `to` are quarter beats after the
   * onset: the struck beat's own span, moved or grown by a tied continuation that carries it.
   */
  vibrato?: { kind: 'normal' | 'wide'; from: number; to: number };
  /** Set on a note the pitch-gesture renderer INSERTED: what it stands for. */
  gesture?: 'scoop' | 'fall' | 'bend';
}

export interface SongsterrMelodicFlat {
  /** Onsets moved by the source's triplet feel (swing), and how many measures it covers. */
  swung_onsets: number;
  swung_measures: number;
  notes: MelodicNote[];
  /** The open-string tuning the decode used (the part's own, or the caller override). */
  tuning: number[];
  /** Total length of the track in quarter-note beats. */
  totalBeats: number;
  /** First tempo mark, if any (prefer `tempoAtBeat`). */
  bpm?: number;
  tempos: TempoMark[];
  signature: [number, number];
  measures: MeasureInfo[];
  sections: SectionInfo[];
  /** Notes whose `string` indexed outside `tuning`, or whose pitch left MIDI 0..127. Skipped, counted. */
  unresolved: number;
  /** Which string indices went unresolved, with counts (the actionable half of `unresolved`). */
  unresolved_strings: Record<number, number>;
  /** Tie continuations folded into the onset they are held from (length, not a re-strike). */
  ties_folded: number;
  /** Tie continuations with no abutting same-pitch onset to hold; imported as fresh attacks. */
  ties_orphaned: number;
  /** Grace-ornament notes dropped: a crush note has nowhere to go at step resolution. */
  graces_dropped: number;
  /** Beats that STRUCK more than one note at once (they become `+`-joined chord tokens). A beat of tied continuations is not one. */
  chords: number;
  /** Notes flagged `ghost` in the source (imported soft, never dropped). */
  ghosts: number;
  /** Lowest / highest MIDI note in the part; undefined when it has none. */
  range?: { low: number; high: number };
  /** Distinct pitch classes 0..11 present, ascending. A wrong string direction shows up here as chromatic mush. */
  pitch_classes: number[];
  /** Notes carrying a per-note `accentuated` mark, folded into their velocity as a bump. */
  accents: number;
  /** Notes the source palm-mutes: damped, so both shorter and (modestly) softer. */
  palm_mutes: number;
  /** Notes the source marks `dead` (the X notehead): a percussive click. */
  dead_notes: number;
  /** Notes the source marks `staccato`. */
  staccatos: number;
  /** Notes let-ring: their gate is extended at the grid boundary, where step positions are known. */
  let_rings: number;
  /** Notes legato-connected to the next onset, by marking: `hp` / a legato slide / a shift slide. */
  legato: Record<SourceLegatoCause, number>;
  /** Slide values with NO written destination (or unknown to this importer), by value. */
  slides_unauthored: Record<string, number>;
  /** Every source field this part carries, keyed `"<level>.<field>"`. */
  field_census: FieldCensus;
  /** How many times the flattener ACTED on each field. */
  fields_applied: AppliedFields;
}

export interface MelodicFlattenOptions extends ArticulationOptions, FeelOptions {
  /** Override the part's own open-string tuning (index = `SsNote.string`). */
  tuning?: readonly number[];
  /** Semitones added after `tuning[string] + fret`, e.g. -12 to drop a bass an octave. */
  transpose?: number;
  /** Velocity for a note the source marks `ghost:true`. Default `GHOST_HIT_VELOCITY` (40). */
  ghostVelocity?: number;
  /** Dynamic-ladder overrides, merged over `SONGSTERR_DYNAMIC_VELOCITY`. */
  dynamicVelocity?: Readonly<Record<string, number>>;
}

/** A note's vibrato mark: `wideVibrato` is the wide one; note- or beat-level `vibrato` the normal one. */
function vibratoKind(note: { vibrato?: boolean; wideVibrato?: boolean }, beat: { vibrato?: boolean }): 'normal' | 'wide' | undefined {
  if (note.wideVibrato === true) return 'wide';
  if (note.vibrato === true || beat.vibrato === true) return 'normal';
  return undefined;
}

/**
 * Append a tied continuation's bend to the note it is held from. The envelope's 0..60 then covers
 * the note's start through the end of the tie (`bendBeats` grows to match): the earlier points are
 * rescaled, the pitch holds at their last tone up to the tie, and the tie's own points follow.
 * `offset` is where the tie starts, in beats from the note's onset; `length` is its duration.
 */
function foldTieBend(n: MelodicNote, offset: number, length: number, points: readonly { position: number; tone: number }[]): void {
  const span = offset + length;
  const head = n.bend !== undefined && n.bendBeats !== undefined
    ? n.bend.map((p) => ({ position: (p.position * n.bendBeats!) / span, tone: p.tone }))
    : [{ position: 0, tone: 0 }];
  const held = head[head.length - 1].tone;
  const tail = points.map((p) => ({ position: ((offset + (p.position / 60) * length) / span) * 60, tone: p.tone }));
  n.bend = [...head, { position: (offset / span) * 60, tone: held }, ...tail]
    .filter((p, i, all) => i === 0 || p.position !== all[i - 1].position || p.tone !== all[i - 1].tone);
  n.bendBeats = span;
}

/**
 * Walk a MELODIC part and resolve every note to a MIDI pitch.
 *
 * Same measure/voice/beat walk as `flattenSongsterrDrums` (shared via
 * `indexMeasures`), differing only in how a note is read: `tuning[string] +
 * fret` instead of "fret IS a GM percussion number". Positions are in
 * quarter-note beats; signature, marker and the sticky dynamic all carry
 * forward exactly as they do on the drum path.
 *
 * **Ties are LENGTH, not a second attack.** A `tie:true` note is a continuation
 * of the note it is held from, so it extends that onset's `durationBeats` and
 * sets `tie` / `tiedBeats` on it rather than emitting a new `MelodicNote`. The
 * hold is tracked per VOICE INDEX across barlines (a pad holding a whole note
 * into the next measure is the normal case: one song's pad part carries 144
 * ties). A tie whose pitch has no abutting onset in that voice cannot be held
 * from anything, so it imports as a fresh attack and is counted `ties_orphaned`
 * rather than silently vanishing.
 *
 * **A grace ornament is DROPPED, and counted.** On the drum path a grace shares
 * a step with the note it decorates and the flam policy keeps the loud one. A
 * melodic crush note has no such fallback: folding its pitch onto the main onset
 * would invent a chord the tab never wrote. So its notes are dropped (counted as
 * `graces_dropped`), and, exactly as on the drum path, its `duration` is
 * engraving rather than elapsed time, so the cursor does not advance and the
 * rest of the measure keeps its timing.
 *
 * **Articulations are PARSED here and the grid-aware half is applied later.** The
 * markings (`palmMute`, `accentuated`, `letRing`, `hp`, `slide`, `dead`,
 * `staccato`) land on the `MelodicNote`, and the VELOCITY consequences resolve
 * here because velocity needs no grid. Everything that changes a LENGTH waits for
 * `importSongsterrMelodic`, where the notes have quantized step positions: a
 * legato overlap that does not reach its target's step is not an overlap, and a
 * let-ring that stops at the next strike of its own pitch needs that strike's
 * real step. See `songsterrArticulation.ts` for the whole pipeline.
 */
export function flattenSongsterrMelodic(part: SongsterrPart, opts: MelodicFlattenOptions = {}): SongsterrMelodicFlat {
  const tuning = [...(opts.tuning ?? part.tuning ?? [])];
  if (tuning.length === 0) {
    throw new Error(
      'This part carries no `tuning`, so string+fret cannot be resolved to a pitch. Songsterr writes a top-level '
      + '`tuning` array on every melodic part and `tuningFlat: true` on a percussion part; a drum part imports '
      + 'through flattenSongsterrDrums (its `fret` is a GM percussion number). Pass `tuning` explicitly to override.',
    );
  }
  const applied: AppliedFields = {};
  const apply = (key: string): void => { applied[key] = (applied[key] ?? 0) + 1; };
  if (opts.tuning === undefined && Array.isArray(part.tuning) && part.tuning.length > 0) apply('part.tuning');
  const idx = indexMeasures(part, applied, opts.straightFeel === true);
  const transpose = opts.transpose ?? 0;
  const ghostVel = opts.ghostVelocity ?? GHOST_HIT_VELOCITY;
  const art = resolveArticulationOptions(opts);
  const dynVelocity = opts.dynamicVelocity !== undefined
    ? { ...SONGSTERR_DYNAMIC_VELOCITY, ...opts.dynamicVelocity }
    : SONGSTERR_DYNAMIC_VELOCITY;

  const notes: MelodicNote[] = [];
  const unresolvedStrings: Record<number, number> = {};
  let dynamic: string | undefined;
  let unresolved = 0;
  let tiesFolded = 0;
  let tiesOrphaned = 0;
  let gracesDropped = 0;
  let chords = 0;
  let ghosts = 0;
  let accents = 0;
  let palmMutes = 0;
  let deadNotes = 0;
  let staccatos = 0;
  let letRings = 0;
  const legato: Record<SourceLegatoCause, number> = { hp: 0, slide_legato: 0, slide_shift: 0 };
  const slidesUnauthored: Record<string, number> = {};
  /** Per VOICE INDEX (positional, stable across measures): the last onset of each pitch. */
  const heldByVoice = new Map<number, Map<number, MelodicNote>>();

  for (let mi = 0; mi < part.measures.length; mi++) {
    const measure = part.measures[mi];
    const measureStart = idx.measures[mi].startBeat;
    const voices = measure.voices ?? [];
    for (let vi = 0; vi < voices.length; vi++) {
      let held = heldByVoice.get(vi);
      if (held === undefined) { held = new Map<number, MelodicNote>(); heldByVoice.set(vi, held); }
      let pos = measureStart;
      for (const beat of voices[vi].beats ?? []) {
        if (beat.velocity) { dynamic = beat.velocity; apply('beat.velocity'); }   // sticky dynamic
        const isGrace = beat.graceNote !== undefined && beat.graceNote !== false && beat.graceNote !== '';
        const durBeats = isGrace ? 0 : (beat.duration[0] / beat.duration[1]) * 4;
        apply('beat.duration');
        if (beat.rest === true) apply('beat.rest');
        // A note-level `rest` is read whether or not the BEAT also rests, and the
        // census sees both, so record it before the beat-rest short-circuit below.
        // Songsterr writes a rest beat as `{rest, notes:[{rest}]}`, so skipping it
        // there left `note.rest` looking parsed-then-dropped when it is neither.
        for (const n of beat.notes ?? []) if (n.rest === true) apply('note.rest');
        // BEAT-level articulations apply to every note on the beat. The COUNTS
        // below are of what the SOURCE marks, gated only by whether a note
        // actually sounds, never by `articulations`: a census is a census, and a
        // caller who opted out still needs to be told what they opted out of.
        // Only the `apply(...)` calls and the acted-on flags are gated.
        const palmMuted = art.on && beat.palmMute === true;
        const letRing = art.on && beat.letRing === true;
        if (!beat.rest) {
          const sounding = (beat.notes ?? []).filter((n) => n.rest !== true && typeof n.fret === 'number');
          if (isGrace) {
            gracesDropped += sounding.length;
            apply('beat.graceNote');
          } else {
            // Counted per ONSET, not per note: a beat of three TIED notes is
            // three continuations of a chord already sounding, not a new one.
            let newOnsets = 0;
            for (const note of sounding) {
              const open = typeof note.string === 'number' && Number.isInteger(note.string) ? tuning[note.string] : undefined;
              const pitch = open === undefined ? undefined : open + (note.fret as number) + transpose;
              if (pitch === undefined || pitch < 0 || pitch > 127) {
                unresolved++;
                if (typeof note.string === 'number') unresolvedStrings[note.string] = (unresolvedStrings[note.string] ?? 0) + 1;
                continue;
              }
              // A tie continues the onset it abuts: lengthen that note instead of
              // striking a new one. The abutment check (previous onset ends where
              // this beat starts) is what keeps a tie from re-attaching to some
              // unrelated earlier note of the same pitch.
              const prev = held.get(pitch);
              if (note.tie === true && prev !== undefined && Math.abs(prev.beat + prev.durationBeats - pos) < 1e-6) {
                // A tie's own bend (a hold, a release, a further rise) continues the held note's
                // envelope; its unwritten slide out (a fall off the release) ends the held note.
                if (Array.isArray(note.bend?.points) && note.bend.points.length > 0) foldTieBend(prev, pos - prev.beat, durBeats, note.bend.points);
                const tieSlide = typeof note.slide === 'string' ? SONGSTERR_SLIDE_KINDS[note.slide] : undefined;
                if (tieSlide?.out !== undefined) { prev.slideOut = tieSlide.out; prev.slideKind = note.slide; }
                // Vibrato on the tie: it starts there, or carries on a vibrato that runs up to it.
                const tieVib = vibratoKind(note, beat);
                const at = pos - prev.beat;
                if (tieVib !== undefined) {
                  if (prev.vibrato === undefined) prev.vibrato = { kind: tieVib, from: at, to: at + durBeats };
                  else if (Math.abs(prev.vibrato.to - at) < 1e-6) prev.vibrato = { ...prev.vibrato, to: at + durBeats };
                }
                prev.durationBeats += durBeats;
                prev.tie = true;
                prev.tiedBeats = (prev.tiedBeats ?? 0) + 1;
                tiesFolded++;
                apply('note.tie');
                continue;
              }
              if (note.tie === true) tiesOrphaned++;
              const ghost = note.ghost === true;
              if (ghost) { ghosts++; apply('note.ghost'); }
              const dead = art.on && note.dead === true;
              const staccato = art.on && note.staccato === true;
              const level = art.on && typeof note.accentuated === 'number' ? note.accentuated : undefined;
              // SLIDE reads the VALUE. Only `legato` and `shift` have a written
              // destination, so only those become a legato connection; the other
              // five glide into or out of a pitch the score never states, and an
              // unrecognised string is neither, so both are recorded by value for
              // the report rather than guessed at.
              let cause: SourceLegatoCause | undefined;
              let slideUnauthored: string | undefined;
              let slideFact: (typeof SONGSTERR_SLIDE_KINDS)[string] | undefined;
              if (typeof note.slide === 'string' && note.slide !== '') {
                const fact = SONGSTERR_SLIDE_KINDS[note.slide];
                slideFact = fact;
                // CLASSIFY first, then gate. A slide with a destination is a
                // legato connection whether or not we act on it; one without is
                // unauthorable either way, and so is a value we do not recognise.
                if (fact?.connects === true) {
                  if (art.on) cause = note.slide === 'shift' ? 'slide_shift' : 'slide_legato';
                } else {
                  slideUnauthored = note.slide;
                }
              }
              // `hp` is the stronger claim (a hammer-on IS the connection), so it
              // wins the cause label when a note carries both.
              if (art.on && note.hp === true) cause = 'hp';
              // ── STAGE 1: velocity. base (ghost > ladder > plain) → accent bump
              // → damping trim. A ghosted note is the more specific mark, so it
              // wins the BASE over the sticky dynamic; the accent then bumps
              // whatever that base is, which is what makes the two channels
              // compose rather than compete.
              const ladder = dynamic !== undefined ? dynVelocity[dynamic] : undefined;
              const base = ghost ? ghostVel : (ladder !== undefined && ladder !== PLAIN_HIT_VELOCITY ? ladder : undefined);
              const velocity = resolveArticulatedVelocity(
                base, PLAIN_HIT_VELOCITY, level, { palmMute: palmMuted, dead }, art,
              );
              const out: MelodicNote = { beat: pos, pitch, durationBeats: durBeats };
              if (velocity !== undefined) out.velocity = velocity;
              if (ghost) out.ghost = true;
              if (beat.letRing === true) letRings++;
              if (beat.palmMute === true) palmMutes++;
              if (note.dead === true) deadNotes++;
              if (note.staccato === true) staccatos++;
              if (typeof note.accentuated === 'number') accents++;
              if (letRing) { out.letRing = true; apply('beat.letRing'); }
              if (palmMuted) { out.palmMute = true; apply('beat.palmMute'); }
              if (dead) { out.dead = true; apply('note.dead'); }
              if (staccato) { out.staccato = true; apply('note.staccato'); }
              if (level !== undefined) { out.accent = level; apply(`note.accentuated=${level}`); }
              if (cause !== undefined) {
                out.legato = cause;
                legato[cause]++;
                apply(cause === 'hp' ? 'note.hp' : `note.slide=${note.slide}`);
              }
              if (slideUnauthored !== undefined) {
                out.slideUnauthored = slideUnauthored;
                slidesUnauthored[slideUnauthored] = (slidesUnauthored[slideUnauthored] ?? 0) + 1;
              }
              // The unwritten half of a slide (in from below/above, out up/down) and the bend envelope
              // are CARRIED on the note for the opt-in glide renderer; nothing here authors them.
              if (slideFact?.in !== undefined) out.slideIn = slideFact.in;
              if (slideFact?.out !== undefined) out.slideOut = slideFact.out;
              if (out.slideIn !== undefined || out.slideOut !== undefined) out.slideKind = note.slide;
              if (Array.isArray(note.bend?.points) && note.bend.points.length > 0) {
                out.bend = note.bend.points.map((p) => ({ position: p.position, tone: p.tone }));
                out.bendBeats = durBeats;
              }
              const vib = vibratoKind(note, beat);
              if (vib !== undefined) out.vibrato = { kind: vib, from: 0, to: durBeats };
              notes.push(out);
              held.set(pitch, out);
              newOnsets++;
            }
            if (newOnsets > 1) chords++;
          }
        }
        pos += durBeats;
      }
    }
  }

  // Swing, after the walk (ties abut on WRITTEN positions). The end moves with the start, so a note that
  // ran up to the next one still does; envelopes measured in beats scale with the note.
  let swungOnsets = 0;
  for (const n of notes) {
    const start = swingBeat(idx.measures, n.beat);
    const end = swingBeat(idx.measures, n.beat + n.durationBeats);
    if (Math.abs(start - n.beat) < 1e-9 && Math.abs(end - start - n.durationBeats) < 1e-9) continue;
    const scale = n.durationBeats > 0 ? (end - start) / n.durationBeats : 1;
    if (Math.abs(start - n.beat) > 1e-9) swungOnsets++;
    n.beat = start;
    n.durationBeats = end - start;
    if (n.bendBeats !== undefined) n.bendBeats *= scale;
    if (n.vibrato !== undefined) n.vibrato = { ...n.vibrato, from: n.vibrato.from * scale, to: n.vibrato.to * scale };
  }
  notes.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  const classes = new Set<number>();
  let low: number | undefined;
  let high: number | undefined;
  for (const n of notes) {
    classes.add(((n.pitch % 12) + 12) % 12);
    if (low === undefined || n.pitch < low) low = n.pitch;
    if (high === undefined || n.pitch > high) high = n.pitch;
  }
  return {
    swung_onsets: swungOnsets, swung_measures: idx.measures.filter((m) => m.swing !== undefined).length,
    notes, tuning, totalBeats: idx.totalBeats, bpm: idx.tempos[0]?.bpm, tempos: idx.tempos,
    signature: idx.signature, measures: idx.measures, sections: idx.sections,
    unresolved, unresolved_strings: unresolvedStrings,
    ties_folded: tiesFolded, ties_orphaned: tiesOrphaned, graces_dropped: gracesDropped,
    chords, ghosts,
    ...(low !== undefined && high !== undefined ? { range: { low, high } } : {}),
    pitch_classes: [...classes].sort((a, b) => a - b),
    accents, palm_mutes: palmMutes, dead_notes: deadNotes, staccatos, let_rings: letRings,
    legato, slides_unauthored: slidesUnauthored,
    field_census: censusSongsterrFields(part), fields_applied: applied,
  };
}

/**
 * One occupied step of the pitch row, in SOURCE terms: what the tab actually
 * wrote at this step, before the gate ceiling is applied.
 *
 * `duration_steps` here is the note's REAL length and may exceed the 16-step
 * gate ceiling (one song's pad chords run 24 and 32 steps). The `notation`
 * row splits such a note into a tied chain; this cell keeps the un-split truth,
 * so a caller comparing the two can see exactly what the ceiling cost.
 * Velocity, length and tie all reach `notation` as `:len` / `_` suffixes.
 */
export interface MelodicCell {
  /** 0-based step index within the window. */
  step: number;
  /** MIDI notes sounding on this step, ascending, at most 6. */
  pitches: number[];
  /** The mini-notation token: `"d#3"`, or `"d#4+d#5"` for a chord. */
  token: string;
  /** MIDI velocity, when the source's dynamics say something a plain hit does not. */
  velocity?: number;
  /**
   * WRITTEN length in STEPS (>= 1), tied continuations already folded in. This is
   * the SOURCE truth and articulations never change it, so a caller can always
   * see what the tab wrote by comparing it against `gate_sixths`.
   */
  duration_steps: number;
  /**
   * The length that will actually be AUTHORED, in sixths of a step (the neutral
   * unit, 1..96). `duration_steps * 6` when nothing articulated it; shorter when
   * the note is palm-muted / dead / staccato; longer when it lets ring or is
   * legato-connected to the next onset. `articulations` says which.
   *
   * Sixths, not steps, because a palm mute is HALF a step at a 16th grid and a
   * step count cannot say that. The `notation` row writes it back as an exact
   * step fraction (`"e2:1/2"`), which `parseVoice` reads to the same sixths.
   */
  gate_sixths?: number;
  /** The source explicitly TIED this note forward; it is held, not re-struck. */
  tie?: true;
  /** Guitar Pro let-ring: sustain past the written length (applied to `gate_sixths`). */
  letRing?: true;
  /** Legato-connected to the next onset, and by which marking. Authored as gate overlap. */
  legato?: LegatoCause;
  /** `accentuated` level 1 / 2. Already folded into `velocity`. */
  accent?: number;
  /** Palm-muted: gate capped and velocity trimmed. */
  palmMute?: true;
  /** Dead (X) note: gate capped hard and velocity trimmed. */
  dead?: true;
  /** Staccato: gate proportionally shortened. */
  staccato?: true;
  /**
   * What the articulations DID to this cell, in words, e.g.
   * `["palm mute caps the gate at 3/6 step"]`. Present only when something
   * changed, so an unarticulated cell stays as clean as it was before.
   */
  articulations?: string[];
}

// ── Emitting the row: note LENGTH and TIE as mini-notation suffixes ───
//
// The two halves of this already existed and did not meet. `parseVoice` accepts
// `"c3:16_"` (a length in steps, `_` = tie forward) and the flattener records
// `duration_steps` / `tie` per cell — but the row handed back carried pitch
// alone, so an agent pasting `voices` straight into `apply_pattern` authored
// every note ONE STEP long and got a clean receipt. A pad became a blip and
// nothing said so. Joining them here is the fix, and it belongs at this
// boundary because this is the only place that knows both the source length and
// the row's own step count.

/**
 * The longest note ONE gate token can hold, in steps: `MAX_GATE_SIXTHS` / 6 =
 * 16. A source note longer than this cannot be written as a single token, so it
 * becomes a TIED CHAIN (see `layoutMelodicRow`).
 */
export const MAX_GATE_STEPS = MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP;

/** One onset exactly as it is written into the `notation` row. */
export interface EmittedNote {
  /** 0-based step within the window. */
  step: number;
  /** MIDI notes this onset plays, ascending. */
  pitches: number[];
  /**
   * Note length in SIXTHS of a step, `MIN_GATE_SIXTHS`..`MAX_GATE_SIXTHS`. The
   * authoritative field: sixths are the neutral unit and the only one that can
   * hold a sub-step gate (a palm-muted chug is 3 sixths, half a step).
   */
  gate_sixths: number;
  /**
   * The same length in STEPS, which is what the `:len` suffix is written in.
   * FRACTIONAL for a sub-step gate (0.5 for a palm mute), so it is a derived
   * convenience: `gate_sixths` is the value to trust.
   */
  gate_steps: number;
  /** Held INTO the onset that follows it (the same note continuing); written as `_`. */
  tie: boolean;
  /** Carried from the cell that owns this onset; written as the `@vel` suffix. */
  velocity?: number;
  /** This onset is a RE-ARTICULATION of a longer source note, not a new attack. */
  continuation?: true;
}

/** What `layoutMelodicRow` produced, and what the ceiling cost to produce it. */
export interface EmittedRow {
  /** One entry per step; `undefined` = a rest. */
  row: (EmittedNote | undefined)[];
  /** Source notes too long for one token, written as a tied chain. */
  splits: number;
  /** Source notes too long for one token with NOWHERE to re-articulate; length lost. */
  clamps: number;
  /** Tie (`_`) flags written into the row. */
  ties: number;
  /** Per-note detail for `splits`, ready to quote in a warning. */
  split_detail: string[];
  /** Per-note detail for `clamps`, ready to quote in a warning. */
  clamp_detail: string[];
}

/** `[39,51,58]` → `"d#2+d#3+a#3"`; the token `parseVoice` reads back. */
const chordToken = (pitches: readonly number[]): string => pitches.map(pitchToken).join('+');

/**
 * Lay the window's cells out as one token per step, carrying each note's REAL
 * length and tie, and splitting anything past the 16-step gate ceiling.
 *
 * **The split is the device's own drone recipe, not an invention.** A note
 * longer than `MAX_GATE_STEPS` is written as a full-length TIED token (`:16_`)
 * plus a re-articulation of the identical token 16 steps later carrying the
 * REMAINDER — `:16_` then `:8` for a 24-step chord, never `:16` then `:16`,
 * because rounding the tail up would invent half a bar of pad the song does not
 * have. The tie is what stops the re-articulation being heard as a second
 * attack: the Circuit's rule (manual, and 524 of 524 real ties in a 274-file
 * corpus) is that a tied note's gate ends EXACTLY where the next onset begins,
 * which is what `at + MAX_GATE_STEPS` places.
 *
 * **When there is no room, the note is CLAMPED and reported.** A note wanting 34
 * steps from step 30 of a 32-step row has nowhere to put a re-articulation, and
 * neither does one whose landing step is already claimed by a different onset.
 * It then gets the ceiling length, untied, and rings past the row boundary —
 * the honest outcome, counted in `clamps` rather than snapped silently. It is
 * deliberately NOT tied: a tie into an unrelated note would slur two different
 * pitches together, and a tie into nothing is a device no-op.
 *
 * `_` therefore means exactly one thing in an emitted row: *the next onset is
 * this same note continuing*. A source tie that already folded into a length
 * the ceiling can hold needs no `_` at all — it IS the length.
 */
export function layoutMelodicRow(cells: readonly MelodicCell[], stepCount: number): EmittedRow {
  const row: (EmittedNote | undefined)[] = Array.from({ length: stepCount }, () => undefined);
  // Every step a real source onset claims, known UP FRONT: the walk below places
  // re-articulations ahead of cells it has not reached yet, so "is this step
  // free?" cannot be answered from `row` alone (that was the latent collision in
  // the hand-written script this replaces).
  const onsetSteps = new Set(cells.map((c) => c.step));
  const ordered = [...cells].sort((a, b) => a.step - b.step);
  let splits = 0;
  let clamps = 0;
  let ties = 0;
  const splitDetail: string[] = [];
  const clampDetail: string[] = [];

  for (const c of ordered) {
    if (c.step < 0 || c.step >= stepCount) continue;
    const pitches = [...c.pitches];
    const token = chordToken(pitches);
    const place = (step: number, gate: number, tie: boolean, continuation: boolean): void => {
      row[step] = {
        step, pitches: [...pitches], gate_sixths: gate, gate_steps: gate / GATE_SIXTHS_PER_STEP, tie,
        ...(c.velocity !== undefined ? { velocity: c.velocity } : {}),
        ...(continuation ? { continuation: true as const } : {}),
      };
      if (tie) ties++;
    };
    // The ARTICULATED length when one exists, the written length otherwise. This
    // is the join: a palm mute is a sub-step gate that only sixths can carry, and
    // reading `duration_steps` here would silently discard it.
    let remaining = c.gate_sixths ?? c.duration_steps * GATE_SIXTHS_PER_STEP;
    let at = c.step;
    const pieces: number[] = [];
    while (remaining > MAX_GATE_SIXTHS) {
      const next = at + MAX_GATE_STEPS;
      // No room ahead: past the row, or a different onset already owns that step.
      if (next >= stepCount || row[next] !== undefined || onsetSteps.has(next)) break;
      place(at, MAX_GATE_SIXTHS, true, at !== c.step);
      pieces.push(MAX_GATE_SIXTHS);
      remaining -= MAX_GATE_SIXTHS;
      at = next;
    }
    if (remaining > MAX_GATE_SIXTHS) {
      place(at, MAX_GATE_SIXTHS, false, at !== c.step);
      clamps++;
      clampDetail.push(
        `step ${at} ${token}: wants ${remaining / GATE_SIXTHS_PER_STEP} more step(s) and there is no room to re-articulate before step ${stepCount}, `
        + `so it holds the ${MAX_GATE_STEPS}-step maximum and rings past the row`,
      );
    } else {
      place(at, Math.max(MIN_GATE_SIXTHS, remaining), false, at !== c.step);
      pieces.push(remaining);
      if (pieces.length > 1) {
        splits++;
        splitDetail.push(
          `step ${c.step} ${token}: ${pieces.reduce((a, b) => a + b, 0) / GATE_SIXTHS_PER_STEP} steps -> `
          + `${pieces.map((p) => p / GATE_SIXTHS_PER_STEP).join('_ + ')} (${pieces.length} tokens, ${pieces.length - 1} tie)`,
        );
      }
    }
  }
  return { row, splits, clamps, ties, split_detail: splitDetail, clamp_detail: clampDetail };
}

/**
 * A gate in SIXTHS rendered as the exact step length the `:len` suffix takes:
 * 6 → `"1"`, 18 → `"3"`, 3 → `"1/2"`, 8 → `"4/3"`, 1 → `"1/6"`.
 *
 * Reduced to lowest terms and never decimalised, because `stepsToSixths` throws
 * on a length that does not land exactly on a sixth. A palm mute is 3 sixths, so
 * writing it as a decimal (`0.5`) would work but `2/6` would not reduce and a
 * value like 8 sixths has no finite decimal at all: the fraction form is the only
 * one that round-trips every gate the field holds.
 */
function gateToken(sixths: number): string {
  if (sixths % GATE_SIXTHS_PER_STEP === 0) return String(sixths / GATE_SIXTHS_PER_STEP);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(sixths, GATE_SIXTHS_PER_STEP);
  return `${sixths / g}/${GATE_SIXTHS_PER_STEP / g}`;
}

/**
 * Render a laid-out row as the mini-notation line `apply_pattern` parses:
 * `"d#2+d#3+a#3:16_ ~ … d#2+d#3+a#3:8 ~ …"`.
 *
 * The `:len` is written on EVERY hit, including a one-step note (`"c3:1"`),
 * rather than being left off as "the default". Two reasons, both learned here:
 * a bare token is indistinguishable from the old lengthless output, so an agent
 * (or a reviewer) cannot tell whether the row carries lengths at all; and
 * `apply_pattern`'s `preserve_template_gates` deliberately keeps a TEMPLATE's
 * hand-set gate on any step that states none, which would leave a stale 8-step
 * pad gate under a freshly imported 16th note.
 *
 * **Velocity is written too, as `@vel`, and that is what closes the last hole in
 * this row.** The dynamics were resolved correctly, reached `cells[].velocity`
 * and `steps[].velocity`, and then died here, because the row carried pitch and
 * length only and the row is what the documented workflow pastes into
 * `apply_pattern`. So every accent, every sticky dynamic and the palm-mute trim
 * were silently flattened the moment an agent used the tool the way the tool
 * tells it to. `@vel` is emitted only when the cell HAS a velocity, so an
 * unmarked part's row is byte-identical to what it was before.
 */
export function renderMelodicRow(row: readonly (EmittedNote | undefined)[]): string {
  return row
    .map((e) => (e === undefined
      ? '~'
      : `${chordToken(e.pitches)}:${gateToken(e.gate_sixths)}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.tie ? '_' : ''}`))
    .join(' ');
}

export interface SongsterrMelodicImport {
  /**
   * The pitch row as mini-notation, one token per step, space-joined, each hit
   * carrying its NOTE LENGTH in steps and its tie:
   * `"d#3:4 ~ ~ ~ d#3:2 ~ d4:4 ~ ~ ~ d4:2 ~ a#3:4 ~ ~ ~"`. Feed straight to
   * `apply_pattern` as a voice line; `parseVoice` reads the suffixes back to the
   * same gate and tie. Set `noteLengths: false` for the bare pitch row.
   */
  notation: string;
  /** The same row as parsed `Step`s (pitch, velocity, gate, tie), for programmatic callers. */
  steps: Step[];
  step_count: number;
  /** Per-step SOURCE detail: the un-split length, velocity, tie and let-ring. */
  cells: MelodicCell[];
  warnings: string[];
  total_beats: number;
  /** Tempo IN FORCE at the window start (not tempo[0]). */
  bpm?: number;
  signature: [number, number];
  window: { fromBeat: number; beats: number; fromMeasure?: number; section?: string };
  /** Onsets that were not on a step line and were SNAPPED to the nearest one. */
  off_grid: number;
  /** Distinct onsets that snapped onto a step already holding another onset and merged into its chord token. */
  merged: number;
  /** Notes outside the requested window; dropped. */
  out_of_window: number;
  /** Notes past the 6-note chord limit; dropped. */
  chord_overflow: number;
  /**
   * Consecutive same-pitch onsets FOLDED into the held note before them by the
   * opt-in `sustainRepeats` pass (a sustained pad/synth held once, not
   * re-picked). 0 unless the option is on. Only true-adjacent, same-strike cells
   * are merged; see `collapseSustainedRepeats`.
   */
  sustain_collapsed: number;
  /** Notes whose string/fret did not resolve to a MIDI pitch; skipped. */
  unresolved: number;
  /** Tie continuations folded into the onset they are held from. */
  ties_folded: number;
  /**
   * Notes longer than the 16-step gate ceiling written as a TIED CHAIN in
   * `notation` (`":16_"` + the remainder). Nothing is lost: the note still holds
   * its full source length.
   */
  gate_splits: number;
  /**
   * Notes longer than the ceiling with NOWHERE to re-articulate (the row ends,
   * or the landing step is taken). They hold the 16-step maximum and ring past
   * the row; the excess IS lost, which is why it is counted separately.
   */
  gate_clamps: number;
  /** Tie (`_`) flags written into `notation`. */
  ties_emitted: number;
  /** Lowest / highest note in the WINDOW, with display names. */
  range?: { low: number; high: number; low_name: string; high_name: string };
  /** What the LENGTH articulations did in this window (let-ring, legato, damping). */
  articulation: LengthArticulationReport;
  /**
   * Track-wide counts of every articulation the source marks, so the caller can
   * see the scale of what was carried without walking `cells`.
   */
  articulations: {
    accents: number;
    palm_mutes: number;
    dead_notes: number;
    staccatos: number;
    let_rings: number;
    legato: Record<SourceLegatoCause, number>;
    /** Slide values with no written destination (or unknown to us), by value. */
    slides_unauthored: Record<string, number>;
  };
  /**
   * TRACK-WIDE: every source field this part carries that the authoring path did
   * not, split into "never read" and the more damning "read and then dropped".
   * Derived by subtracting the fields the flattener acted on from the fields the
   * part actually contains, so a field the source starts emitting shows up here
   * with nobody updating a list.
   */
  dropped_fidelity: DroppedFidelity;
  /** TRACK-WIDE: chord notes dropped by `monoVoice` (0 when the option is off). */
  mono_dropped: number;
  /** TRACK-WIDE: what `pitchGestures: 'glide'` rendered; absent when the option is off. */
  pitch_gestures?: GlideGestureReport;
}

export interface MelodicImportOptions extends SongsterrImportOptions, MelodicFlattenOptions {
  /**
   * Write each note's LENGTH and TIE into the `notation` row as `:len` / `_`
   * suffixes. **Default true**, and the reason it is a default rather than a
   * flag is that the alternative fails silently: a bare pitch row authors every
   * note one step long, so a pad lands as a blip and the receipt still reads
   * clean. A caller who says nothing about durations should get correct ones.
   *
   * Set false only for the bare pitch row (`"d#3 ~ ~ ~"`): a target with no gate
   * model at all, a caller doing its own length pass, or a diff against output
   * from before lengths crossed this boundary. The per-cell lengths are in
   * `cells[]` either way.
   */
  noteLengths?: boolean;
  /**
   * OPT-IN: collapse consecutive same-pitch onsets into ONE held note, for a
   * SUSTAINED voice (a pad or synth held on a real synth) rather than a guitar
   * that re-picks. A pad the tab writes as `d#5:2` eight times is ONE note the
   * player holds for a bar; a guitar's eight down-picks are eight attacks, and
   * the source cannot tell the two apart — so the caller says which.
   *
   * **Default OFF**, because a guitar's repeats are real re-strikes and eating
   * them would be wrong. Turn it on for a pad/synth line. Only TRUE-adjacent
   * cells with an identical pitch set, velocity and articulation are merged; a
   * rest between (a gap), a pitch change, or a staccato / dead / accent / tie /
   * let-ring / legato / palm-mute / velocity change ends the hold and stays a
   * separate attack. The merged note keeps the first onset's velocity and
   * articulation and sums the durations. The count of onsets folded is reported
   * on `sustain_collapsed` and in a warning. See `collapseSustainedRepeats`.
   */
  sustainRepeats?: boolean;
  /**
   * OPT-IN: keep ONE voice of every chord onset, for a line a MONO synth plays. Counts from the
   * bottom (0 = lowest, 1 = the next up); negative counts from the top (-1 = highest). A chord with
   * fewer notes clamps to its nearest end, so `1` takes the upper note of an octave pair and the
   * middle of a triad. Default off (chords stay chords). See `reduceToMonoVoice`.
   */
  monoVoice?: number;
  /**
   * OPT-IN: render the source's BENDS and its slides into / out of unwritten pitches as overlapping
   * GLIDE notes, for a mono synth set to glide (MicroFreak: Envelope Legato ON, glide via ENV→Glide in
   * the Matrix). A stored step cannot carry pitch bend, so this is the approximation a sequencer can
   * store: a scoop is a grace note a step early, a fall is the note's last step, a bend is the note
   * then its bent pitch(es) on the nearest steps. Default off. See `pitchGestures.ts`.
   */
  pitchGestures?: 'glide';
  /** Semitones an unwritten slide starts from / falls to, for `pitchGestures`. Default 2. */
  slideSemitones?: number;
}

/** Two pitch sets are equal iff same length and same members in order (both ascending). */
function samePitchSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Two cells strike the SAME way iff their velocity and every articulation flag
 * match. Any difference (a louder repeat, a staccato'd repeat, a newly dead or
 * accented or tied note) is a real re-articulation, not a continued hold, so it
 * is NOT a collapse candidate. `undefined === undefined` for the absent flags.
 */
function sameStrikeArticulation(a: MelodicCell, b: MelodicCell): boolean {
  return a.velocity === b.velocity
    && a.tie === b.tie
    && a.letRing === b.letRing
    && a.legato === b.legato
    && a.accent === b.accent
    && a.palmMute === b.palmMute
    && a.dead === b.dead
    && a.staccato === b.staccato;
}

/**
 * OPT-IN collapse of consecutive same-pitch onsets into ONE held note, for a
 * SUSTAINED voice (a pad / synth held on a real synth) rather than a guitar that
 * re-picks. One song's pad part writes m3-4 as `d#5:2`
 * eight times then `c5:2` eight times; the player holds ONE note per bar, which
 * this folds to `d#5:16` + `c5:16` (matching m1-2's own single held notes).
 *
 * Merges `cell[n+1]` into `cell[n]` ONLY on TRUE adjacency, and never across a
 * re-strike:
 *   - `cell[n+1].step === cell[n].step + cell[n].duration_steps` — abutting, so
 *     NO rest sits between them and they do not overlap (a gap is a re-strike),
 *   - identical pitch set (a pitch change ends the hold),
 *   - identical velocity and articulation (`sameStrikeArticulation`: a louder or
 *     staccato'd or accented repeat is a genuine second attack, left alone).
 * The merged note keeps the FIRST onset's velocity and articulation and SUMS the
 * `duration_steps`. Because a merge grows the head's duration, the next
 * adjacency test is against the grown length, so a whole run chains into one.
 *
 * The first cell of each run is CLONED before its duration is grown, so the
 * input array (still referenced elsewhere as the sparse cell grid) is untouched.
 * Runs BEFORE `applyLengthArticulations` so the gate / let-ring / damping stage
 * sees one long note, not eight short ones — a collapsed 32-step hold then splits
 * into a tied chain by the same ceiling logic any long note does. Returns the
 * merged-onset count for the receipt.
 */
export function collapseSustainedRepeats(cells: readonly MelodicCell[]): { cells: MelodicCell[]; merged: number } {
  const out: MelodicCell[] = [];
  let merged = 0;
  for (const cell of cells) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined
      && cell.step === prev.step + prev.duration_steps
      && samePitchSet(prev.pitches, cell.pitches)
      && sameStrikeArticulation(prev, cell)
    ) {
      out[out.length - 1] = { ...prev, duration_steps: prev.duration_steps + cell.duration_steps };
      merged++;
      continue;
    }
    out.push(cell);
  }
  return { cells: out, merged };
}

/**
 * Flatten a MELODIC part and quantize a WINDOW of it into a mini-notation pitch
 * row, the melodic counterpart of `importSongsterrDrums`. The window is
 * addressed identically (fromBeat/beats, 1-based fromMeasure/toMeasure, or a
 * section NAME), and `bpm` is the tempo in force at the window start.
 *
 * **Off-grid onsets are SNAPPED, counted, and reported; never silently rounded.**
 * Mini-notation has one token per step and carries no micro-timing, so a triplet
 * or 32nd at a 16th grid moves to the nearest step line. `off_grid` says how many
 * did, and the warning names the fix (`stepsPerBeat: 8`). If a snapped onset
 * lands on a step that already holds a DIFFERENT onset, the two are merged into
 * one `+`-joined token (they genuinely sound together at that resolution) and
 * counted separately as `merged`, because that is the lossy case: a fast run
 * flattening into a chord is a different defect from a note nudged 1/32 early.
 * A note outside the window is dropped and counted as `out_of_window`.
 *
 * **The row carries NOTE LENGTH and TIE, by default.** Each hit is written
 * `pitch:len` in steps, plus `_` when it is held into the next onset, which is
 * exactly what `parseVoice` reads back, so pasting `voices` into `apply_pattern`
 * authors the lengths the tab actually wrote. Anything past the 16-step gate
 * ceiling becomes a tied chain (`gate_splits`) or, when there is no room for
 * one, a reported clamp (`gate_clamps`); see `layoutMelodicRow`. Pass
 * `noteLengths: false` for the old pitch-only row.
 *
 * **And it carries the ARTICULATIONS.** Palm mute, per-note accent, let-ring,
 * hammer-on/pull-off and the two targeted slides all become real gate and velocity
 * on the row, because this is the boundary that knows both the source marking and
 * the quantized step positions the marking has to be expressed against. Every one
 * is reported per cell in `cells[].articulations` and in aggregate in
 * `articulation` / `articulations`, and every one is overridable. What is NOT
 * carried is reported too, by field and by count, in `dropped_fidelity`.
 */
export function importSongsterrMelodic(part: SongsterrPart, opts: MelodicImportOptions = {}): SongsterrMelodicImport {
  const flat = flattenSongsterrMelodic(part, {
    ...(opts.tuning !== undefined ? { tuning: opts.tuning } : {}),
    ...(opts.transpose !== undefined ? { transpose: opts.transpose } : {}),
    ...(opts.ghostVelocity !== undefined ? { ghostVelocity: opts.ghostVelocity } : {}),
    ...(opts.dynamicVelocity !== undefined ? { dynamicVelocity: opts.dynamicVelocity } : {}),
    ...(opts.articulations !== undefined ? { articulations: opts.articulations } : {}),
    ...(opts.accentBump !== undefined ? { accentBump: opts.accentBump } : {}),
    ...(opts.palmMuteVelocityScale !== undefined ? { palmMuteVelocityScale: opts.palmMuteVelocityScale } : {}),
    ...(opts.deadVelocityScale !== undefined ? { deadVelocityScale: opts.deadVelocityScale } : {}),
    ...(opts.straightFeel === true ? { straightFeel: true } : {}),
  });
  const art = resolveArticulationOptions(opts);
  const spb = opts.stepsPerBeat ?? 4;
  const window = resolveWindow(flat, opts);
  const stepCount = Math.max(1, Math.round(window.beats * spb));

  // Mono reduction, then pitch gestures: both TRACK-WIDE, in beat time, before the window is taken,
  // so a scoop whose grace lands in the previous window still belongs to the note it leads into.
  let trackNotes: MelodicNote[] = flat.notes;
  let monoDropped = 0;
  if (opts.monoVoice !== undefined) {
    const mono = reduceToMonoVoice(trackNotes, opts.monoVoice);
    trackNotes = mono.notes;
    monoDropped = mono.dropped;
  }
  let gestures: GlideGestureReport | undefined;
  if (opts.pitchGestures === 'glide') {
    const g = renderGlideGestures(trackNotes, { stepBeats: 1 / spb, slideSemitones: opts.slideSemitones });
    trackNotes = g.notes;
    gestures = g.report;
    for (const [k, v] of Object.entries(g.applied)) flat.fields_applied[k] = (flat.fields_applied[k] ?? 0) + v;
  }

  const cells: (MelodicCell | undefined)[] = Array.from({ length: stepCount }, () => undefined);
  /** The source beat that first claimed each step, so a chord is not miscounted as a merge. */
  const claimedBy: (number | undefined)[] = Array.from({ length: stepCount }, () => undefined);
  let offGrid = 0;
  let merged = 0;
  let outOfWindow = 0;
  let chordOverflow = 0;

  // Take the window FIRST (as the drum path does), so `out_of_window` means
  // "this onset ROUNDED off the end of the grid", not "the other 133 measures of
  // the song are not in these two bars", which is not a fidelity problem at all.
  const inWindow = trackNotes.filter((n) => n.beat >= window.fromBeat - 1e-3 && n.beat < window.fromBeat + window.beats);
  for (const n of inWindow) {
    const exact = (n.beat - window.fromBeat) * spb;
    const step = Math.round(exact);
    if (Math.abs(exact - step) > MELODIC_ONSET_TOLERANCE * spb) offGrid++;
    if (step < 0 || step >= stepCount) { outOfWindow++; continue; }
    const durSteps = Math.max(1, Math.round(n.durationBeats * spb));
    const cur = cells[step];
    if (cur === undefined) {
      cells[step] = {
        step, pitches: [n.pitch], token: '', duration_steps: durSteps,
        ...(n.velocity !== undefined ? { velocity: n.velocity } : {}),
        ...(n.tie === true ? { tie: true as const } : {}),
        ...(n.letRing === true ? { letRing: true as const } : {}),
        ...(n.legato !== undefined ? { legato: n.legato } : {}),
        ...(n.accent !== undefined ? { accent: n.accent } : {}),
        ...(n.palmMute === true ? { palmMute: true as const } : {}),
        ...(n.dead === true ? { dead: true as const } : {}),
        ...(n.staccato === true ? { staccato: true as const } : {}),
      };
      claimedBy[step] = n.beat;
      continue;
    }
    if (claimedBy[step] !== undefined && Math.abs((claimedBy[step] as number) - n.beat) > 1e-6) merged++;
    if (!cur.pitches.includes(n.pitch)) {
      if (cur.pitches.length >= MAX_CHORD_NOTES) { chordOverflow++; continue; }
      cur.pitches.push(n.pitch);
      cur.pitches.sort((a, b) => a - b);
    }
    // One cell, one set of dynamics + one gate: the loudest and the longest win.
    if (n.velocity !== undefined) cur.velocity = Math.max(cur.velocity ?? 0, n.velocity);
    if (durSteps > cur.duration_steps) cur.duration_steps = durSteps;
    if (n.tie === true) cur.tie = true;
    // A step is ONE gate and ONE set of articulations, so several notes sharing it
    // merge their markings. LENGTHENING flags union (if any note on the step lets
    // ring, the step's gate can reach); DAMPING flags union too, and the length
    // stage then applies the strongest, which keeps the same "damping wins"
    // precedence a single note gets rather than inventing a per-step rule.
    if (n.letRing === true) cur.letRing = true;
    if (n.legato !== undefined && cur.legato === undefined) cur.legato = n.legato;
    if (n.accent !== undefined) cur.accent = Math.max(cur.accent ?? 0, n.accent);
    if (n.palmMute === true) cur.palmMute = true;
    if (n.dead === true) cur.dead = true;
    if (n.staccato === true) cur.staccato = true;
  }

  const filled: MelodicCell[] = [];
  for (const c of cells) {
    if (c === undefined) continue;
    c.token = chordToken(c.pitches);
    filled.push(c);
  }

  // OPT-IN sustained-voice collapse (a pad/synth held once, not re-picked). Runs
  // on `filled` BEFORE the length stage, so let-ring / damping / the gate ceiling
  // see the held note, not the eight short ones the tab re-wrote it as. Default
  // OFF — a guitar's repeats are real attacks. Rebuild `filled` in place so every
  // downstream reader (length stage, layout, `cells` return, range) sees the
  // collapsed set without a rename; `collapseSustainedRepeats` clones, so the
  // sparse `cells` grid the noteLengths:false path reads is left untouched.
  let sustainCollapsed = 0;
  if (opts.sustainRepeats === true) {
    const collapsed = collapseSustainedRepeats(filled);
    sustainCollapsed = collapsed.merged;
    filled.length = 0;
    filled.push(...collapsed.cells);
  }

  // STAGES 2 and 3: lengthen (let-ring, legato) then damp (palm mute, dead,
  // staccato). Here, not in the flattener, because both need the quantized step
  // positions. Also the place `gate_sixths` gets written on EVERY cell, so the
  // layout below has one field to read whether or not anything articulated it.
  const artReport = applyLengthArticulations(filled, spb, art, MIN_GATE_SIXTHS);

  // Join the lengths onto the row. Default ON: see `MelodicImportOptions.noteLengths`.
  const withLengths = opts.noteLengths !== false;
  const laid = withLengths ? layoutMelodicRow(filled, stepCount) : undefined;
  const notation = laid !== undefined
    ? renderMelodicRow(laid.row)
    : cells.map((c) => (c === undefined ? '~' : c.token)).join(' ');
  const steps: Step[] = laid !== undefined
    ? laid.row.map((e) => (e === undefined
      ? { on: false }
      : {
        on: true,
        notes: e.pitches.length === 1 ? e.pitches[0] : [...e.pitches],
        ...(e.velocity !== undefined ? { velocity: e.velocity } : {}),
        gate_sixths: e.gate_sixths,
        ...(e.tie ? { tie: true as const } : {}),
      }))
    : cells.map((c) => (c === undefined
      ? { on: false }
      : {
        on: true,
        notes: c.pitches.length === 1 ? c.pitches[0] : [...c.pitches],
        ...(c.velocity !== undefined ? { velocity: c.velocity } : {}),
      }));

  const warnings: string[] = [];
  if (filled.length === 0) {
    warnings.push(`This window holds no notes (${stepCount} rest steps). The part may rest here; try another section or from_measure.`);
  }
  if (flat.unresolved > 0) {
    const named = Object.entries(flat.unresolved_strings).sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}×${c}`).join(', ');
    warnings.push(
      `TRACK-WIDE: ${flat.unresolved} note(s) did not resolve to a pitch (string index outside the part's ${flat.tuning.length}-string tuning ` +
      `[${flat.tuning.join(', ')}], or a result outside MIDI 0..127) and were skipped: string ${named}.`,
    );
  }
  if (flat.ties_folded > 0) {
    warnings.push(
      `TRACK-WIDE: ${flat.ties_folded} tie continuation(s) were folded into the note they are held from, not re-struck. ` +
      (withLengths
        ? 'Their length is in `cells[].duration_steps` and reaches the `notation` row as the `:len` suffix on the onset that holds them.'
        : 'Their length is in `cells[].duration_steps` and the fact of the tie in `cells[].tie`; you asked for noteLengths:false, so the `notation` row carries pitch only and every note will author ONE STEP long.'),
    );
  }
  if (!withLengths && filled.length > 0) {
    warnings.push(
      'noteLengths:false — the `notation` row is PITCH ONLY, so authoring it makes every note one step long regardless of how long the source holds it. '
      + 'Join `cells[].duration_steps` yourself, or drop the option.',
    );
  }
  if (laid !== undefined && laid.splits > 0) {
    warnings.push(
      `${laid.splits} note(s) run longer than the ${MAX_GATE_STEPS}-step gate ceiling and are written as a TIED CHAIN in \`notation\` `
      + `(":${MAX_GATE_STEPS}_" then the remainder, the device's own drone recipe): ${laid.split_detail.join('; ')}. `
      + 'They hold their full source length; the re-articulation is tied, so it is not heard as a second attack.',
    );
  }
  if (laid !== undefined && laid.clamps > 0) {
    warnings.push(
      `${laid.clamps} note(s) run longer than the ${MAX_GATE_STEPS}-step gate ceiling with nowhere to re-articulate, so they hold the `
      + `${MAX_GATE_STEPS}-step maximum and RING PAST the end of this ${stepCount}-step row: ${laid.clamp_detail.join('; ')}. `
      + 'This is the one case where length is genuinely lost; widen the window so the note has room, or accept the ring-out.',
    );
  }
  if (flat.ties_orphaned > 0) {
    warnings.push(`TRACK-WIDE: ${flat.ties_orphaned} tie(s) had no abutting same-pitch note to hold from and were imported as fresh attacks.`);
  }
  if (flat.graces_dropped > 0) {
    warnings.push(`TRACK-WIDE: ${flat.graces_dropped} grace-ornament note(s) dropped (a crush note has no step of its own; the note it decorates keeps its pitch and timing).`);
  }
  if (flat.ghosts > 0) {
    warnings.push(`TRACK-WIDE: ${flat.ghosts} note(s) are GHOSTED in the source and import soft (velocity ${opts.ghostVelocity ?? GHOST_HIT_VELOCITY}) in \`cells[].velocity\`, never dropped.`);
  }
  if (offGrid > 0) {
    const gridName = spb === 4 ? '16th' : spb === 8 ? '32nd' : `1/${spb}-beat`;
    warnings.push(
      `${offGrid} onset(s) were off the ${gridName} grid and SNAPPED to the nearest step: a mini-notation row is one token per step ` +
      `and carries no micro-timing.${spb < 8 ? ' Re-import with steps:8 (32nds) if the line needs them.' : ''}`,
    );
  }
  if (merged > 0) {
    warnings.push(
      `${merged} onset(s) landed on a step already holding a different note and were MERGED into that step's chord token ` +
      '(they sound together at this resolution). This is the lossy case, unlike a plain snap: raise `steps` to separate them.',
    );
  }
  if (chordOverflow > 0) warnings.push(`${chordOverflow} note(s) dropped past the ${MAX_CHORD_NOTES}-note chord limit.`);
  if (outOfWindow > 0) warnings.push(`${outOfWindow} note(s) rounded past the end of the ${stepCount}-step window and were dropped.`);
  if (sustainCollapsed > 0) {
    warnings.push(
      `sustainRepeats: ${sustainCollapsed} consecutive same-pitch onset(s) were COLLAPSED into the held note before them `
      + '(a sustained voice held once, not re-struck). Only TRUE adjacency with an identical pitch set, velocity and '
      + 'articulation was merged; a rest between, a pitch change, or a staccato / accent / velocity change ends the hold '
      + 'and stays a separate attack. Turn the option off for a re-picking voice (a guitar).',
    );
  }

  // ── ARTICULATION receipts. Each names the count, what it became, and the knob
  // that changes it, so nothing here is magic and nothing here is unarguable.
  if (art.on) {
    if (artReport.damped > 0) {
      const pmSixths = Math.max(MIN_GATE_SIXTHS, Math.round(art.palmMuteGateBeats * spb * GATE_SIXTHS_PER_STEP));
      warnings.push(
        `${artReport.damped} note(s) are DAMPED in the source (palm mute / dead / staccato) and are authored SHORT: a palm mute `
        + `caps the gate at ${pmSixths}/6 of a step (${art.palmMuteGateBeats} of a quarter beat, so the same real ring at any grid) `
        + `and trims velocity by x${art.palmMuteVelocityScale}. The gate is the definitional half; the velocity trim is a modest `
        + 'stand-in for the darkness a note message cannot say. Tune with palmMuteGateBeats / palmMuteVelocityScale '
        + '(0 / 1 disables either half), or articulations:false for the written lengths.'
        + (artReport.damping_over_legato > 0
          ? ` ${artReport.damping_over_legato} of them were ALSO legato-connected, and the damping won: the picking hand is on the strings, so the note cannot sustain into its target however legato the transition is notated.`
          : ''),
      );
    }
    if (artReport.legato_connected > 0) {
      warnings.push(
        `${artReport.legato_connected} note(s) are LEGATO-connected in the source (hammer-on/pull-off, or a slide with a written `
        + `destination) and hold ${art.legatoOverlapSixths}/6 of a step PAST the next onset, so the target is not heard as a fresh `
        + 'attack. Gate overlap, not a tie: a tie into a different pitch is refused on purpose, and a 130-file factory census found '
        + '279 real notes overlapping the next onset at a different pitch, so this is normal stored content. '
        + 'Tune with legatoOverlapSixths (0 disables).'
        + (artReport.legato_unconnected > 0
          ? ` ${artReport.legato_unconnected} more had no following onset in this window to connect to and were left at their written length; widen the window if the target sits just past its edge.`
          : ''),
      );
    }
    if (artReport.let_ring_extended > 0) {
      warnings.push(
        `${artReport.let_ring_extended} note(s) are LET-RING in the source and now SUSTAIN, up to the next strike of their own pitch `
        + `(capped at ${art.letRingMaxBeats} quarter beat(s)). This used to be parsed and then dropped with no warning, which is what `
        + 'dried out an entire pedalled intro. Tune with letRingMaxBeats (0 disables).'
        + (artReport.let_ring_capped > 0 ? ` ${artReport.let_ring_capped} hit that cap rather than reaching their own next strike.` : ''),
      );
    }
    if (monoDropped > 0) {
      warnings.push(
        `TRACK-WIDE: monoVoice ${opts.monoVoice} kept one note of every chord onset for a mono synth and dropped ${monoDropped} `
        + 'chord note(s). Pick another index (0 = lowest, -1 = highest) if the wrong line survived.',
      );
    }
    if (gestures !== undefined) warnings.push(`TRACK-WIDE: ${describeGlideGestures(gestures, opts.slideSemitones ?? 2)}`);
    const slideValues = Object.entries(flat.slides_unauthored);
    if (slideValues.length > 0 && gestures === undefined) {
      warnings.push(
        `TRACK-WIDE: ${slideValues.reduce((a, [, c]) => a + c, 0)} slide(s) have NO written destination note `
        + `[${slideValues.map(([v, c]) => `${v}×${c}`).join(', ')}], so there is nothing to connect a gate to: they glide into or out `
        + 'of a pitch the score never states. A targeted slide (legato / shift) IS carried, as gate overlap. For a mono synth '
        + 'that glides, pitchGestures:"glide" renders the scoops and falls (and any bends) as overlapping glide notes; '
        + 'see `dropped_fidelity.parsed_not_authored`.',
      );
    }
  } else if (flat.palm_mutes + flat.let_rings + flat.accents + flat.dead_notes + flat.staccatos > 0) {
    warnings.push(
      'articulations:false was passed, so the source\'s palm mutes, accents, let-rings, dead notes and legato connections were READ and NOT '
      + 'applied, so every note authors at its written length and unarticulated velocity. They are listed in '
      + '`dropped_fidelity.parsed_not_authored`; drop the option to carry them.',
    );
  }

  const dropped = deriveDroppedFidelity(flat.field_census, flat.fields_applied);
  warnings.push(...droppedFidelitySummary(dropped));

  const startMeasure = flat.measures.filter((m) => m.startBeat <= window.fromBeat + 1e-9).pop();
  const signature = startMeasure ? startMeasure.signature : flat.signature;
  const pitches = filled.flatMap((c) => c.pitches);
  const low = pitches.length > 0 ? Math.min(...pitches) : undefined;
  const high = pitches.length > 0 ? Math.max(...pitches) : undefined;
  return {
    notation, steps, step_count: stepCount, cells: filled, warnings,
    total_beats: flat.totalBeats, bpm: tempoAtBeat(flat, window.fromBeat), signature, window,
    off_grid: offGrid, merged, out_of_window: outOfWindow, chord_overflow: chordOverflow,
    sustain_collapsed: sustainCollapsed,
    unresolved: flat.unresolved, ties_folded: flat.ties_folded,
    gate_splits: laid?.splits ?? 0, gate_clamps: laid?.clamps ?? 0, ties_emitted: laid?.ties ?? 0,
    ...(low !== undefined && high !== undefined
      ? { range: { low, high, low_name: pitchToken(low), high_name: pitchToken(high) } }
      : {}),
    articulation: artReport,
    articulations: {
      accents: flat.accents, palm_mutes: flat.palm_mutes, dead_notes: flat.dead_notes,
      staccatos: flat.staccatos, let_rings: flat.let_rings,
      legato: flat.legato, slides_unauthored: flat.slides_unauthored,
    },
    dropped_fidelity: dropped,
    mono_dropped: monoDropped,
    ...(gestures !== undefined ? { pitch_gestures: gestures } : {}),
  };
}
