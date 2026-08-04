/**
 * Songsterr ARTICULATION: what each source marking becomes, and a mechanical
 * receipt for every source field the importer does not carry.
 *
 * Split out of `songsterr.ts` because it answers a different question. That
 * module walks the score and resolves `tuning[string] + fret` into pitches and
 * positions; this one decides what a palm mute, an accent, a let-ring, a
 * hammer-on and a slide DO to the note that comes out, and reports what was
 * left behind. Two concerns, two files.
 *
 * ## The three-stage pipeline, and why the order is the order
 *
 * Every articulation lands in exactly one of three stages, and a note carrying
 * several is resolved by running the stages in order, never by picking a winner:
 *
 *   1. VELOCITY (grid-free, resolved in the flattener).
 *      base = per-note `ghost` (40) > the sticky `velocity` ladder > plain (100)
 *      then `accentuated` ADDS its bump (level 1 = +20, level 2 = +34, clamped 127)
 *      then damping SCALES it (palm mute x0.85, dead x0.7).
 *      So a dynamic and an accent COMPOSE: the sticky marking sets the level the
 *      passage sits at and the accent is louder than ITS OWN NEIGHBOURS, which is
 *      what an accent means. Reading the accent as an absolute 120 instead would
 *      make an accented note inside a `p` passage louder than the unaccented `f`
 *      passage next to it, which is the opposite of the marking's meaning.
 *
 *   2. LENGTHEN (grid-aware, resolved at the cell boundary where step positions
 *      are known). `letRing` extends a note until its own pitch is struck again;
 *      a legato connection (`hp`, `slide:"legato"`, `slide:"shift"`) extends the
 *      launch note so it OVERLAPS the target's onset. Both take a MAX, so two
 *      lengthenings cannot fight.
 *
 *   3. DAMP (grid-aware, applied LAST, as a CAP). `palmMute`, `dead` and
 *      `staccato` can only SHORTEN. Applied last so damping beats lengthening:
 *      190 notes in the audit corpus are both palm-muted and hammered-on, and
 *      the physical truth is that the picking hand is on the strings, so the note
 *      cannot sustain into its target however legato the transition is notated.
 *      Damping also does NOT COMPOUND: a note that is both palm-muted and dead
 *      takes the STRONGEST single damping on gate and on velocity, rather than
 *      multiplying two scales into something neither marking asked for.
 *
 * ## Palm mute: gate AND velocity, weighted, and here is the argument
 *
 * A palm mute is two things at once: the note stops much sooner, and it is
 * darker. Only the first is expressible in a note message, so the temptation is
 * to do one and call it done. Both halves ship, deliberately, weighted very
 * differently:
 *
 *   - GATE is the load-bearing half and the definitional one. A palm-muted chug
 *     is percussive: it rings for a fixed short time regardless of how long the
 *     note is written, which is why the default is a CAP in absolute musical time
 *     (`palmMuteGateBeats`, 1/8 of a quarter beat ~= 69 ms at 108 bpm) rather
 *     than a fraction of the written length. Expressed in BEATS and converted to
 *     sixths at the grid, so the same marking rings for the same real time at a
 *     16th grid and at a 32nd grid.
 *   - VELOCITY is a MODEST trim (x0.85), not a big drop. A palm-muted chug is
 *     not played quietly, it is often picked harder; what drops is the perceived
 *     brightness. On most synth patches velocity reaches the filter as well as
 *     the amp, so a small trim buys some of the darkness the note field cannot
 *     say. It is small on purpose: on a patch that routes velocity to the amp
 *     alone, a large drop would turn a riff quiet, which is a different and worse
 *     wrongness than a riff that is merely not dark enough.
 *
 * Both halves are separately overridable and separately disable-able
 * (`palmMuteGateBeats: 0` / `palmMuteVelocityScale: 1`), and both are reported
 * per cell in `articulations` rather than applied invisibly.
 *
 * ## Slides read the STRING, never a boolean
 *
 * The source writes seven different slides and only two of them have a written
 * destination. `legato` and `shift` point at the next note, so gate overlap
 * carries them. The other five (`downwards`, `upwards`, `below`, `above`,
 * `belowupwards`) glide into or out of a pitch that is NOT in the score, so
 * there is no note to connect to and nothing in a step grid can hold them; they
 * are reported, not guessed. An unrecognised slide string is reported too rather
 * than being folded into either group, which is the whole reason this reads the
 * value instead of `slide === true`.
 *
 * ## Why the dropped-fidelity report is derived and not written by hand
 *
 * `SONGSTERR_FIELDS` declares a disposition for every field the importer knows
 * about. The census enumerates the fields a part ACTUALLY carries. Subtracting
 * one from the other means a field the source starts emitting next year shows up
 * as `not_parsed` with no one updating a list, which is the property the
 * `unmapped_numbers` report has and a hand-written warning does not.
 */

import type { SongsterrPart } from './songsterr.js';

// ── Slide kinds ──────────────────────────────────────────────────────

/** Whether a slide has a written destination note, and what it means. */
export interface SlideFact {
  /**
   * The next note in the voice IS this slide's destination, so the two are one
   * gesture and gate overlap can carry it.
   */
  connects: boolean;
  /** What the marking means, for the report. */
  means: string;
}

/**
 * Every `slide` value the audit corpus carries, with whether it has a
 * destination. Read by VALUE: coercing this to a boolean is exactly the bug
 * that would author a slide-out-of-nowhere as a legato connection to whatever
 * note happens to follow it.
 */
export const SONGSTERR_SLIDE_KINDS: Readonly<Record<string, SlideFact>> = {
  legato: { connects: true, means: 'legato slide to the next note, not re-picked' },
  shift: { connects: true, means: 'shift slide to the next note' },
  downwards: { connects: false, means: 'slide OUT of the note downwards, into no written pitch' },
  upwards: { connects: false, means: 'slide OUT of the note upwards, into no written pitch' },
  below: { connects: false, means: 'slide INTO the note from below, from no written pitch' },
  above: { connects: false, means: 'slide INTO the note from above, from no written pitch' },
  belowupwards: { connects: false, means: 'slide in from below AND out upwards, neither pitch written' },
};

// ── Velocity stage ───────────────────────────────────────────────────

/**
 * What `accentuated` level 1 and level 2 ADD to the base velocity.
 *
 * Anchored so nothing already shipped moves: an unmarked note is the compiler's
 * plain hit (100) and 100 + 20 lands exactly on its accent (120), which is the
 * number the sticky-`ff` path has always produced. Level 2 is the source's
 * rarer heavy-accent glyph (28 of Redbone's drum hits, 3 of Schism's guitar
 * notes against 471 at level 1), so it reads as the stronger of the two and
 * 100 + 34 clamps to 127.
 */
export const ACCENT_BUMP: Readonly<Record<number, number>> = { 1: 20, 2: 34 };

/** Palm-mute / dead-note velocity multipliers. See the header for the weighting argument. */
export const PALM_MUTE_VELOCITY_SCALE = 0.85;
export const DEAD_VELOCITY_SCALE = 0.7;

/**
 * How long a palm-muted note rings, in QUARTER-NOTE BEATS. 1/8 of a beat is
 * ~69 ms at 108 bpm, which is a real muted-chug decay. In beats rather than
 * sixths so the ring is the same REAL length at any grid resolution.
 */
export const PALM_MUTE_GATE_BEATS = 0.125;
/** How long a dead (X) note rings, in quarter beats. Half a palm mute: a click. */
export const DEAD_GATE_BEATS = 0.0625;
/** Staccato as a FRACTION of the written length; unlike a mute, staccato is proportional. */
export const STACCATO_SCALE = 0.5;
/** Sixths a legato launch note holds PAST its target's onset, so the two genuinely overlap. */
export const LEGATO_OVERLAP_SIXTHS = 2;
/** Cap on a let-ring extension, in quarter beats. One 4/4 bar. */
export const LET_RING_MAX_BEATS = 4;

/** The knobs on every articulation. Each is separately disable-able; see each field. */
export interface ArticulationOptions {
  /**
   * Master switch. Default true. False parses every marking and reports it as
   * `parsed_not_authored` rather than acting on it, which is the honest shape
   * for a caller who wants the flat reading back.
   */
  articulations?: boolean;
  /** Velocity added by `accentuated` level 1 / level 2. Default 20 / 34. 0 disables. */
  accentBump?: Readonly<Record<number, number>>;
  /** Palm-mute ring length in quarter beats. Default 0.125. 0 leaves the length alone. */
  palmMuteGateBeats?: number;
  /** Palm-mute velocity multiplier. Default 0.85. 1 leaves the velocity alone. */
  palmMuteVelocityScale?: number;
  /** Dead-note ring length in quarter beats. Default 0.0625. 0 leaves the length alone. */
  deadGateBeats?: number;
  /** Dead-note velocity multiplier. Default 0.7. 1 leaves the velocity alone. */
  deadVelocityScale?: number;
  /** Staccato length as a fraction of the written length. Default 0.5. 1 leaves it alone. */
  staccatoScale?: number;
  /** Let-ring extension cap in quarter beats. Default 4 (one 4/4 bar). 0 disables let-ring. */
  letRingMaxBeats?: number;
  /** Sixths a legato launch note holds past its target's onset. Default 2. 0 disables legato. */
  legatoOverlapSixths?: number;
}

/** Every articulation knob resolved to a number, so the appliers take no optionals. */
export interface ResolvedArticulation {
  on: boolean;
  accentBump: Readonly<Record<number, number>>;
  palmMuteGateBeats: number;
  palmMuteVelocityScale: number;
  deadGateBeats: number;
  deadVelocityScale: number;
  staccatoScale: number;
  letRingMaxBeats: number;
  legatoOverlapSixths: number;
}

export function resolveArticulationOptions(opts: ArticulationOptions = {}): ResolvedArticulation {
  const on = opts.articulations !== false;
  return {
    on,
    accentBump: opts.accentBump !== undefined ? { ...ACCENT_BUMP, ...opts.accentBump } : ACCENT_BUMP,
    palmMuteGateBeats: opts.palmMuteGateBeats ?? PALM_MUTE_GATE_BEATS,
    palmMuteVelocityScale: opts.palmMuteVelocityScale ?? PALM_MUTE_VELOCITY_SCALE,
    deadGateBeats: opts.deadGateBeats ?? DEAD_GATE_BEATS,
    deadVelocityScale: opts.deadVelocityScale ?? DEAD_VELOCITY_SCALE,
    staccatoScale: opts.staccatoScale ?? STACCATO_SCALE,
    letRingMaxBeats: opts.letRingMaxBeats ?? LET_RING_MAX_BEATS,
    legatoOverlapSixths: opts.legatoOverlapSixths ?? LEGATO_OVERLAP_SIXTHS,
  };
}

/** The damping markings on one note, as the velocity stage needs them. */
export interface DampingFlags {
  palmMute?: boolean;
  dead?: boolean;
}

/**
 * Stage 1: base velocity, then the accent bump, then the damping trim.
 *
 * `base` is whatever the caller's own dynamics resolution produced (ghost, the
 * sticky ladder, or the plain hit); this function owns only the two stages that
 * come after it. Returns `undefined` when nothing moved the base and the caller
 * passed `undefined`, so an unmarked part still emits no velocity at all and
 * stays byte-identical to what it produced before articulations existed.
 */
export function resolveArticulatedVelocity(
  base: number | undefined,
  plain: number,
  accent: number | undefined,
  damp: DampingFlags,
  art: ResolvedArticulation,
): number | undefined {
  if (!art.on) return base;
  const bump = accent !== undefined ? (art.accentBump[accent] ?? 0) : 0;
  // Damping does not compound: the strongest single scale wins (see the header).
  const scales: number[] = [];
  if (damp.palmMute === true) scales.push(art.palmMuteVelocityScale);
  if (damp.dead === true) scales.push(art.deadVelocityScale);
  const scale = scales.length === 0 ? 1 : Math.min(...scales);
  if (bump === 0 && scale === 1) return base;
  const from = base ?? plain;
  return Math.max(1, Math.min(127, Math.round((from + bump) * scale)));
}

// ── Length stages (2 and 3), on the quantized cells ──────────────────

/** The one cell shape the length stages need. Structurally satisfied by `MelodicCell`. */
export interface ArticulatedCell {
  step: number;
  pitches: number[];
  /** Written length in steps, ties already folded in. The SOURCE truth; never changed here. */
  duration_steps: number;
  /** The length to AUTHOR, in sixths of a step. Written by `applyLengthArticulations`. */
  gate_sixths?: number;
  letRing?: true;
  legato?: LegatoCause;
  palmMute?: true;
  dead?: true;
  staccato?: true;
  /** Human-readable list of what this cell's articulations did. */
  articulations?: string[];
}

/** Which marking asked for a legato connection. Named so the report can say which. */
export type LegatoCause = 'hp' | 'slide_legato' | 'slide_shift';

/** What the length stages did, for the receipt. */
export interface LengthArticulationReport {
  /** Cells whose gate GREW because the source let them ring. */
  let_ring_extended: number;
  /** Let-ring cells that hit `letRingMaxBeats` instead of reaching their own next strike. */
  let_ring_capped: number;
  /** Cells whose gate grew to overlap a legato target's onset. */
  legato_connected: number;
  /** Legato cells with no following onset in the row to connect to; left as written. */
  legato_unconnected: number;
  /** Cells shortened by palm mute / dead / staccato. */
  damped: number;
  /** Cells the source both damped and connected, where damping won (see the header). */
  damping_over_legato: number;
}

const SIXTHS = 6;

/**
 * Stages 2 and 3, in one pass over the row's occupied cells.
 *
 * Runs here, on the QUANTIZED cells, rather than in the flattener, because both
 * stages need to know where the next onset actually landed: a legato overlap
 * that does not reach the target's step is not an overlap, and a let-ring that
 * stops at the next strike needs the strike's real step. Mutates `gate_sixths`
 * and `articulations` on the cells it is given; nothing else.
 *
 * **Deliberately NOT capped at the gate field's 96-sixth ceiling.** A source note
 * can legitimately run longer than one token holds (After Dark's pad chords are
 * 24 and 32 steps), and the layout stage turns that into a TIED CHAIN. Clamping
 * here would silently destroy the length before the chain could be built, which
 * is the whole failure this module exists to stop; the ceiling belongs to the one
 * layer that can do something musical about it. What DOES bound a lengthening is
 * `letRingMaxBeats`, which is a musical bound, not a field bound.
 */
export function applyLengthArticulations(
  cells: readonly ArticulatedCell[],
  stepsPerBeat: number,
  art: ResolvedArticulation,
  minGateSixths: number,
): LengthArticulationReport {
  const report: LengthArticulationReport = {
    let_ring_extended: 0, let_ring_capped: 0, legato_connected: 0,
    legato_unconnected: 0, damped: 0, damping_over_legato: 0,
  };
  const ordered = [...cells].sort((a, b) => a.step - b.step);
  for (const c of ordered) c.gate_sixths = Math.max(minGateSixths, Math.round(c.duration_steps * SIXTHS));
  if (!art.on) return report;

  const note = (c: ArticulatedCell, what: string): void => {
    c.articulations = [...(c.articulations ?? []), what];
  };

  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    const next = ordered[i + 1];
    const written = c.gate_sixths as number;
    let gate = written;

    // ── Stage 2a: let-ring. The note sustains until its OWN pitch is struck
    // again (a re-strike must cut it, or the target holds a duplicate), bounded
    // by the end of the source's let-ring run and by the caller's cap.
    if (c.letRing === true && art.letRingMaxBeats > 0) {
      const capSteps = art.letRingMaxBeats * stepsPerBeat;
      let endStep: number | undefined;
      for (let j = i + 1; j < ordered.length; j++) {
        // The run ends where the source stops marking let-ring: past that the
        // player has damped, so the note must not ring on.
        if (ordered[j].letRing !== true) { endStep = ordered[j].step; break; }
        if (ordered[j].pitches.some((p) => c.pitches.includes(p))) { endStep = ordered[j].step; break; }
      }
      const wantSteps = (endStep ?? c.step + capSteps) - c.step;
      const bounded = Math.min(wantSteps, capSteps);
      const target = Math.round(bounded * SIXTHS);
      if (target > gate) {
        gate = target;
        report.let_ring_extended++;
        if (wantSteps > capSteps) report.let_ring_capped++;
        note(c, `let-ring to ${(bounded).toFixed(2).replace(/\.00$/, '')} step(s)${wantSteps > capSteps ? ' (capped)' : ''}`);
      }
    }

    // ── Stage 2b: legato. The launch note holds PAST the target's onset, so the
    // two overlap and the target is not heard as a fresh attack. Gate overlap,
    // NOT the tie flag: a tie into a different pitch is refused on purpose
    // (`layoutMelodicRow`), and a 130-file factory census found 279 notes whose
    // gate runs past the next onset at a different pitch, so overlap is normal
    // stored content that needs no tie.
    if (c.legato !== undefined && art.legatoOverlapSixths > 0) {
      if (next === undefined || next.step <= c.step) {
        report.legato_unconnected++;
      } else {
        const target = (next.step - c.step) * SIXTHS + art.legatoOverlapSixths;
        if (target > gate) {
          gate = target;
          report.legato_connected++;
          note(c, `${c.legato === 'hp' ? 'hammer-on/pull-off' : c.legato === 'slide_legato' ? 'legato slide' : 'shift slide'} overlaps the next onset by ${art.legatoOverlapSixths}/6 step`);
        }
      }
    }

    // ── Stage 3: damping, LAST, as a cap. Strongest damping wins; nothing
    // compounds. See the header for why this beats stage 2.
    const caps: number[] = [];
    if (c.palmMute === true && art.palmMuteGateBeats > 0) caps.push(Math.max(minGateSixths, Math.round(art.palmMuteGateBeats * stepsPerBeat * SIXTHS)));
    if (c.dead === true && art.deadGateBeats > 0) caps.push(Math.max(minGateSixths, Math.round(art.deadGateBeats * stepsPerBeat * SIXTHS)));
    if (c.staccato === true && art.staccatoScale < 1) caps.push(Math.max(minGateSixths, Math.round(written * art.staccatoScale)));
    if (caps.length > 0) {
      const cap = Math.min(...caps);
      if (cap < gate) {
        const wasConnected = gate > written && c.legato !== undefined;
        gate = cap;
        report.damped++;
        if (wasConnected) report.damping_over_legato++;
        const which = c.palmMute === true ? 'palm mute' : c.dead === true ? 'dead note' : 'staccato';
        note(c, `${which} caps the gate at ${cap}/6 step${wasConnected ? ' (damping beats the legato overlap: the hand is on the strings)' : ''}`);
      }
    }

    c.gate_sixths = Math.max(minGateSixths, Math.round(gate));
  }
  return report;
}

// ── The field census and the dropped-fidelity receipt ────────────────

/** Where in the source JSON a field lives. */
export type FieldLevel = 'part' | 'measure' | 'voice' | 'beat' | 'note';

/**
 * What the importer does with a field.
 *
 *  - `read`          the flattener consumes it. Whether it AUTHORS anything is
 *                    measured at runtime, not declared, so a field that is read
 *                    and then dropped reports itself.
 *  - `structural`    the container the walk recurses through, or the pitch decode.
 *  - `engraving`     draws the score and says nothing about the sound.
 *  - `in_duration`   already folded into `duration`; reading it would double-count.
 *  - `redundant`     the SAME fact reaches us through a field we do read (a
 *                    measure-level `rest` whose own beats also carry `rest`; the
 *                    part identifiers the song metadata already supplied).
 *  - `no_destination` a real musical loss with nowhere to put it yet.
 *  - `metadata`      not note-level: mix state, lyrics, identifiers.
 */
export type FieldDisposition = 'read' | 'structural' | 'engraving' | 'in_duration' | 'redundant' | 'no_destination' | 'metadata';

export interface FieldFact {
  level: FieldLevel;
  disposition: FieldDisposition;
  /** What the marking means, in one clause. */
  means: string;
  /** For a loss: what a target COULD hold it as, when anything could. */
  expressible_as?: string;
  /** For a loss: what would have to exist first. */
  needs?: string;
  /** Derive the report per VALUE rather than per field (a `slide` is seven markings). */
  per_value?: true;
}

/**
 * Every field the importer knows about, at every level, with what it does with
 * it. The gate (`scripts/verify-song-import.ts`) asserts that every field the
 * audit corpus actually carries has an entry here, so a field the source starts
 * emitting cannot slip in unnamed.
 */
export const SONGSTERR_FIELDS: Readonly<Record<string, FieldFact>> = {
  // ── part
  'part.measures': { level: 'part', disposition: 'structural', means: 'the measure list' },
  'part.tuning': { level: 'part', disposition: 'read', means: 'open-string MIDI notes; the melodic pitch decode' },
  'part.automations': { level: 'part', disposition: 'read', means: 'the tempo map' },
  'part.tuningFlat': { level: 'part', disposition: 'redundant', means: 'this staff is percussion; the ABSENCE of `tuning` already says so and is what the discriminator reads' },
  'part.instrument': { level: 'part', disposition: 'redundant', means: 'General MIDI instrument name; the song metadata carries it and the roster reads it there' },
  'part.strings': { level: 'part', disposition: 'redundant', means: 'string count; tuning.length is what the decode uses' },
  'part.frets': { level: 'part', disposition: 'engraving', means: 'fret count on the staff' },
  'part.trackAutomations': {
    level: 'part', disposition: 'no_destination', means: 'mid-song instrument/sound change map',
    expressible_as: 'a program change per switch point', needs: 'a program-change event in the neutral pattern model and a timeline to place it on',
  },
  'part.sounds': {
    level: 'part', disposition: 'no_destination', means: 'the patch roster trackAutomations switches between',
    expressible_as: 'a program change per switch point', needs: 'the same program-change path as trackAutomations',
  },
  'part.volume': { level: 'part', disposition: 'metadata', means: 'part mix level 0..1', expressible_as: 'a mixer level on the target', needs: 'a mixer-level input on the authoring path' },
  'part.balance': { level: 'part', disposition: 'metadata', means: 'part pan', expressible_as: 'a mixer pan on the target', needs: 'a mixer-pan input on the authoring path' },
  'part.newLyrics': { level: 'part', disposition: 'metadata', means: 'the full lyric with syllable hyphenation' },
  'part.withLyrics': { level: 'part', disposition: 'metadata', means: 'flag: this part carries the lyric' },
  'part.name': { level: 'part', disposition: 'redundant', means: 'contributor-supplied part name; the song metadata carries it' },
  'part.partId': { level: 'part', disposition: 'redundant', means: 'part index; the fetch already knows which part it asked for' },
  'part.songId': { level: 'part', disposition: 'redundant', means: 'song id; the fetch already knows it' },
  'part.revisionId': { level: 'part', disposition: 'redundant', means: 'tab revision id; the song metadata carries it' },
  'part.instrumentId': { level: 'part', disposition: 'redundant', means: 'numeric instrument id (1024 = drums); the roster reads it from the metadata' },
  'part.version': { level: 'part', disposition: 'metadata', means: 'source format version' },
  // ── measure
  'measure.voices': { level: 'measure', disposition: 'structural', means: 'the voice list' },
  'measure.signature': { level: 'measure', disposition: 'read', means: 'time signature, sticky' },
  'measure.marker': { level: 'measure', disposition: 'read', means: 'section name, sticky' },
  'measure.rest': { level: 'measure', disposition: 'redundant', means: 'the whole measure rests; its own beats each carry `rest` too, and those are read' },
  'measure.doubleBarline': { level: 'measure', disposition: 'engraving', means: 'a double barline is drawn here' },
  // ── voice
  'voice.beats': { level: 'voice', disposition: 'structural', means: 'the beat list' },
  'voice.rest': { level: 'voice', disposition: 'redundant', means: 'the whole voice rests here; its own beats carry `rest` too, and those are read' },
  // ── beat
  'beat.notes': { level: 'beat', disposition: 'structural', means: 'the note list' },
  'beat.duration': { level: 'beat', disposition: 'read', means: 'fraction of a whole note, dots folded in' },
  'beat.rest': { level: 'beat', disposition: 'read', means: 'this beat is silent' },
  'beat.velocity': { level: 'beat', disposition: 'read', means: 'sticky dynamic marking (pppp..ffff, sf, sfz)' },
  'beat.palmMute': { level: 'beat', disposition: 'read', means: 'palm mute: the note is damped, shorter and darker' },
  'beat.letRing': { level: 'beat', disposition: 'read', means: 'let-ring: the note sustains past its written length' },
  'beat.graceNote': { level: 'beat', disposition: 'read', means: 'this beat is a grace ornament on the next' },
  'beat.type': { level: 'beat', disposition: 'engraving', means: 'the note-head glyph to draw' },
  'beat.dots': { level: 'beat', disposition: 'in_duration', means: 'dot count; duration already has dots folded in' },
  'beat.beamStart': { level: 'beat', disposition: 'engraving', means: 'a beam begins here' },
  'beat.beamStop': { level: 'beat', disposition: 'engraving', means: 'a beam ends here' },
  'beat.tuplet': { level: 'beat', disposition: 'in_duration', means: 'tuplet grouping; duration is already tuplet-adjusted' },
  'beat.tupletStart': { level: 'beat', disposition: 'in_duration', means: 'tuplet bracket start; duration is already adjusted' },
  'beat.tupletStop': { level: 'beat', disposition: 'in_duration', means: 'tuplet bracket end; duration is already adjusted' },
  'beat.chord': { level: 'beat', disposition: 'engraving', means: 'the chord name printed above the staff' },
  'beat.text': {
    level: 'beat', disposition: 'no_destination', means: 'performance text / lyric printed on the beat',
    expressible_as: 'an annotation on the imported section', needs: 'an annotation field on the import result',
  },
  'beat.gradualVelocity': {
    level: 'beat', disposition: 'no_destination', means: 'a crescendo / decrescendo ACROSS notes',
    expressible_as: 'a per-note velocity ramp across the marked span',
    needs: 'span resolution (where the crescendo ends and what level it reaches); a single beat flag does not say',
  },
  'beat.vibrato': { level: 'beat', disposition: 'no_destination', means: 'vibrato on the beat', expressible_as: 'nothing in a note message', needs: 'a continuous-controller path (the pitch-bend / modulation work)' },
  'beat.vibratoWithTremoloBar': { level: 'beat', disposition: 'no_destination', means: 'whammy-bar vibrato', expressible_as: 'nothing in a note message', needs: 'a continuous-controller path' },
  'beat.tremolo': { level: 'beat', disposition: 'no_destination', means: 'tremolo picking at the given subdivision', expressible_as: 'a micro-step roll', needs: 'a decision on whether a written tremolo should become N real retriggers' },
  'beat.tapping': { level: 'beat', disposition: 'no_destination', means: 'tapped with the picking hand', expressible_as: 'nothing distinguishable in a note message', needs: 'nothing: an already-legato attack is the closest a note can get' },
  'beat.wahwah': { level: 'beat', disposition: 'no_destination', means: 'wah pedal position', expressible_as: 'nothing in a note message', needs: 'a continuous-controller path' },
  'beat.brushStroke': { level: 'beat', disposition: 'no_destination', means: 'a strummed chord spread over time', expressible_as: 'per-note micro-tick delays inside the step', needs: 'a per-note (not per-step) micro placement in the neutral model' },
  'beat.upStroke': { level: 'beat', disposition: 'no_destination', means: 'strum direction', expressible_as: 'the ORDER of a brushStroke spread', needs: 'the same per-note micro placement as brushStroke' },
  // ── note
  'note.fret': { level: 'note', disposition: 'structural', means: 'fret, or the GM percussion number on a drum staff' },
  'note.string': { level: 'note', disposition: 'structural', means: 'string index into tuning' },
  'note.rest': { level: 'note', disposition: 'read', means: 'this note is silent' },
  'note.tie': { level: 'note', disposition: 'read', means: 'held from the previous note, not re-struck' },
  'note.ghost': { level: 'note', disposition: 'read', means: 'a quiet, parenthesised hit' },
  'note.accentuated': { level: 'note', disposition: 'read', means: 'per-note accent, level 1 or 2', per_value: true },
  'note.hp': { level: 'note', disposition: 'read', means: 'hammer-on / pull-off to the next note' },
  'note.dead': { level: 'note', disposition: 'read', means: 'a dead (X) note: percussive, no pitch content' },
  'note.staccato': { level: 'note', disposition: 'read', means: 'detached, shorter than written' },
  'note.slide': { level: 'note', disposition: 'read', means: 'a slide; the VALUE says which of seven', per_value: true },
  'note.bend': {
    level: 'note', disposition: 'no_destination', means: 'a full pitch-bend envelope (tone + point list)',
    expressible_as: 'nothing in a note message: a stored step and the live stream are both note-only',
    needs: 'a continuous-controller field in the neutral model, a bend message in the realizer, and a target that accepts one',
  },
  'note.vibrato': { level: 'note', disposition: 'no_destination', means: 'vibrato on the note', expressible_as: 'nothing in a note message', needs: 'a continuous-controller path' },
  'note.wideVibrato': { level: 'note', disposition: 'no_destination', means: 'wide vibrato on the note', expressible_as: 'nothing in a note message', needs: 'a continuous-controller path' },
  'note.harmonic': { level: 'note', disposition: 'no_destination', means: 'natural / pinch / feedback / semi harmonic', expressible_as: 'the sounding harmonic pitch, if the partial were resolved', needs: 'a fret-to-partial table; the pitch we author is the fretted note, not the harmonic' },
  'note.harmonicFret': { level: 'note', disposition: 'no_destination', means: 'which fret the harmonic is touched at', needs: 'the same fret-to-partial table as harmonic' },
  'note.pickScrape': { level: 'note', disposition: 'no_destination', means: 'a pick scraped along the string', expressible_as: 'nothing pitched', needs: 'a noise voice; this is a sound effect, not a note' },
};

/** One field as the source actually carries it. */
export interface ObservedField {
  count: number;
  /** 1-based measure the field first appears in (matching the tab UI). */
  first_measure: number;
  /** Value histogram, for a field whose value is not a bare `true`. */
  values?: Record<string, number>;
}

/** Every field a part carries, keyed `"<level>.<field>"`. */
export type FieldCensus = Record<string, ObservedField>;

/** How many times the flattener ACTED on a field (or a `field=value`). */
export type AppliedFields = Record<string, number>;

/**
 * Walk a part and count every key it carries, at every level.
 *
 * Deliberately key-BLIND: it enumerates `Object.keys`, so it sees a field no
 * one has heard of. That is the whole point, and it is why this cannot be a
 * hand-written list.
 */
export function censusSongsterrFields(part: SongsterrPart): FieldCensus {
  const out: FieldCensus = {};
  const bump = (key: string, measure: number, value: unknown): void => {
    const cur = out[key] ?? { count: 0, first_measure: measure };
    cur.count++;
    if (typeof value === 'string' || typeof value === 'number') {
      cur.values = cur.values ?? {};
      const v = String(value);
      cur.values[v] = (cur.values[v] ?? 0) + 1;
    }
    out[key] = cur;
  };
  const rec = part as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec)) bump(`part.${k}`, 1, rec[k]);
  for (let mi = 0; mi < part.measures.length; mi++) {
    const measure = part.measures[mi];
    const mrec = measure as unknown as Record<string, unknown>;
    for (const k of Object.keys(mrec)) bump(`measure.${k}`, mi + 1, mrec[k]);
    for (const voice of measure.voices ?? []) {
      const vrec = voice as unknown as Record<string, unknown>;
      for (const k of Object.keys(vrec)) bump(`voice.${k}`, mi + 1, vrec[k]);
      for (const beat of voice.beats ?? []) {
        const brec = beat as unknown as Record<string, unknown>;
        for (const k of Object.keys(brec)) bump(`beat.${k}`, mi + 1, brec[k]);
        for (const note of beat.notes ?? []) {
          const nrec = note as unknown as Record<string, unknown>;
          for (const k of Object.keys(nrec)) bump(`note.${k}`, mi + 1, nrec[k]);
        }
      }
    }
  }
  return out;
}

/** One entry of the dropped-fidelity report. */
export interface DroppedFieldReport {
  count: number;
  first_measure: number;
  /** The values seen, when the field is not a bare boolean. */
  values?: string[];
  /** What the marking means. */
  means: string;
  expressible_as?: string;
  /** What would have to exist for this to be authored. */
  needs?: string;
  /** For `parsed_not_authored`: where the parsed value already sits. */
  where?: string;
  /** Why it did not reach the output. */
  why: string;
}

/**
 * What the source carried and the authoring path did not, split by the two
 * failure classes the audit separates.
 */
export interface DroppedFidelity {
  /**
   * Class A: never read. A real musical loss, honest about being unbuilt.
   * A field with no entry in `SONGSTERR_FIELDS` at all lands here too, which is
   * how a field the source adds later announces itself.
   */
  not_parsed: Record<string, DroppedFieldReport>;
  /**
   * Class B, the dangerous one: the value IS parsed and sits in the result, and
   * nothing downstream acts on it. Read this list first: every entry is
   * something the importer already has and threw away.
   */
  parsed_not_authored: Record<string, DroppedFieldReport>;
  /**
   * Fields deliberately unread with a written reason (engraving, or already
   * folded into `duration`). Not a loss, listed so the judgement is auditable
   * rather than silent.
   */
  not_a_loss: Record<string, string>;
}

/** Fields whose absence from the report needs no explanation. */
const SUPPRESSED: ReadonlySet<FieldDisposition> = new Set<FieldDisposition>(['structural']);

/**
 * Subtract what the flattener read from what the source carries.
 *
 * The three buckets are decided mechanically, never by a hand-kept list:
 *   - no entry in `SONGSTERR_FIELDS`     → `not_parsed`, flagged as unknown
 *   - `engraving` / `in_duration`        → `not_a_loss`
 *   - `no_destination` / `metadata`      → `not_parsed`, with the declared reason
 *   - `read` and applied at least once   → carried, omitted entirely
 *   - `read` and applied ZERO times      → `parsed_not_authored`
 *
 * A `per_value` field (`slide`, `accentuated`) is bucketed per VALUE, so a
 * `slide:"legato"` that IS authored does not vouch for a `slide:"downwards"`
 * that is not.
 */
export function deriveDroppedFidelity(census: FieldCensus, applied: AppliedFields): DroppedFidelity {
  const out: DroppedFidelity = { not_parsed: {}, parsed_not_authored: {}, not_a_loss: {} };
  for (const [key, obs] of Object.entries(census)) {
    const fact = SONGSTERR_FIELDS[key];
    if (fact !== undefined && SUPPRESSED.has(fact.disposition)) continue;
    if (fact === undefined) {
      out.not_parsed[key] = {
        count: obs.count, first_measure: obs.first_measure,
        ...(obs.values !== undefined ? { values: Object.keys(obs.values) } : {}),
        means: 'unknown to this importer',
        why: 'this field is not in the importer\'s own field table, so nothing reads it and no one has judged whether it matters. '
          + 'It is either new to the source format or newly used by this tab.',
      };
      continue;
    }
    if (fact.disposition === 'engraving' || fact.disposition === 'in_duration' || fact.disposition === 'redundant') {
      const label = fact.disposition === 'engraving'
        ? 'engraving only'
        : fact.disposition === 'in_duration' ? 'already folded into duration' : 'redundant, the same fact reaches us elsewhere';
      out.not_a_loss[key] = `${fact.means} (${label})`;
      continue;
    }
    const base = {
      count: obs.count, first_measure: obs.first_measure,
      means: fact.means,
      ...(fact.expressible_as !== undefined ? { expressible_as: fact.expressible_as } : {}),
      ...(fact.needs !== undefined ? { needs: fact.needs } : {}),
    };
    if (fact.disposition !== 'read') {
      out.not_parsed[key] = {
        ...base,
        ...(obs.values !== undefined ? { values: Object.keys(obs.values) } : {}),
        why: fact.disposition === 'metadata'
          ? 'not note-level: it describes the part, not what a note does, and the authoring path takes notes.'
          : 'nothing downstream can hold it. See `needs`.',
      };
      continue;
    }
    // `read`: whether it AUTHORED anything is measured, not declared.
    const variants = fact.per_value === true && obs.values !== undefined
      ? Object.entries(obs.values).map(([v, c]) => ({ key: `${key}=${v}`, count: c, values: [v] }))
      : [{ key, count: obs.count, values: obs.values !== undefined ? Object.keys(obs.values) : undefined }];
    for (const variant of variants) {
      if ((applied[variant.key] ?? 0) > 0) continue;
      out.parsed_not_authored[variant.key] = {
        ...base,
        count: variant.count,
        ...(variant.values !== undefined ? { values: variant.values } : {}),
        where: `the parsed value is on the flattened note/cell for ${key}`,
        why: 'the importer READ this and authored nothing from it. That is not a device limit, it is a gap in the '
          + 'authoring path; if it should sound, this is the one list worth fixing first.',
      };
    }
  }
  return out;
}

/**
 * Render the report as warning lines in the house style: name the count, name
 * the field, name the fix. `parsed_not_authored` is stated FIRST because it is
 * the indictment: the data was in hand.
 */
export function droppedFidelitySummary(d: DroppedFidelity): string[] {
  const lines: string[] = [];
  const list = (rec: Record<string, DroppedFieldReport>): string =>
    Object.entries(rec)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, r]) => `${k} x${r.count} (first m${r.first_measure})`)
      .join(', ');
  const pna = Object.keys(d.parsed_not_authored);
  if (pna.length > 0) {
    lines.push(
      `DROPPED FIDELITY, parsed then NOT authored (${pna.length} field(s)): ${list(d.parsed_not_authored)}. `
      + 'The importer read every one of these and authored nothing from them. Nothing about that is a device limit; '
      + 'see `dropped_fidelity.parsed_not_authored` for what each one would have meant.',
    );
  }
  const np = Object.entries(d.not_parsed).filter(([, r]) => r.count > 0);
  if (np.length > 0) {
    const unknown = np.filter(([, r]) => r.means === 'unknown to this importer');
    lines.push(
      `DROPPED FIDELITY, not parsed (${np.length} field(s)): ${list(Object.fromEntries(np))}. `
      + 'These are honest gaps: the source carries them and this importer has never read them. '
      + '`dropped_fidelity.not_parsed[field].needs` says what each would take.'
      + (unknown.length > 0
        ? ` ${unknown.length} of them (${unknown.map(([k]) => k).join(', ')}) are not even in the importer's field table, so no one has judged whether they matter.`
        : ''),
    );
  }
  return lines;
}
