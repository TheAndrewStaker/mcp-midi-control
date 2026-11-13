/**
 * Song -> MIDI: decoded Songsterr parts plus a section table become a full-song `.mid`
 * (section markers, tempo + metre map) and one `.mid` per sequence, for any target that
 * plays sequences (an MPC, a DAW). Device-neutral: no step grid, no lane count, no bar
 * ceiling, so notes keep their source timing, length and velocity.
 *
 * Sequences follow the musical sections:
 *  - each section is one looping sequence at its full length;
 *  - a section whose last bar is a drum FILL (has drums, and differs from the section's groove:
 *    its commonest bar WITH drums, seen at least twice; every kit track counts together) also gets a one-bar fill sequence, and the loop plays the groove
 *    bar in its place so it repeats cleanly. Pitched parts keep their own last bar in both;
 *  - sections whose content is identical collapse into one sequence that lists every place
 *    it plays.
 *
 * Pitch gestures (a part's `bends`): off by default; `glide` writes them as overlapping notes a
 * mono legato synth glides through, `pitchbend` as real pitch-bend messages (see `SongMidiPart`).
 *
 * Measures are 1-based and inclusive, as the song docs write them ("Verse m11-26").
 */
import type { DrumEvent } from './drumScore.js';
import { GHOST_HIT_VELOCITY, GM_DRUM_TO_VOICE } from './drumScore.js';
import type { MeasureInfo, MelodicNote, SongsterrFlat, SongsterrMelodicFlat, TempoMark } from './songsterr.js';
import { ACCENT_HIT_VELOCITY, PLAIN_HIT_VELOCITY, tempoAtBeat } from './songsterr.js';
import { DEFAULT_TICKS_PER_BEAT, untangleNotes, writeMidiFile, type SmfNote, type SmfTrack } from './midiFileWrite.js';
import { bendAt, describeGlideGestures, reduceToMonoVoice, renderGlideGestures } from './pitchGestures.js';

const TPB = DEFAULT_TICKS_PER_BEAT;
const DRUM_TICKS = TPB / 8;          // a drum hit is a 32nd long: samplers play one-shots to the end anyway
const ROLL_SPAN_BEATS = 0.25;        // a roll's sub-hits share one 16th step (the importer's unit)
/** A scoop / fall lasts one 16th (the glide renderer's step, and the pitch-bend ramp). */
const GESTURE_STEP_BEATS = 0.25;
/** `bends: 'glide'`: how far a connected note runs past the next onset (a 64th), so the synth plays them legato. */
export const GLIDE_OVERLAP_TICKS = TPB / 16;
/** `bends: 'pitchbend'`: one bend sample per 64th note. */
const BEND_TICKS = TPB / 16;
export const DEFAULT_BEND_RANGE = 12;
/**
 * `vibrato`: semitones either side of the pitch. There is no published standard depth; a guitarist's
 * finger vibrato is commonly put at about a quarter tone either side, and Guitar Pro's wide mark is a
 * deeper one, so wide doubles it. Owner-tunable by ear.
 */
export const VIBRATO_DEPTH = { normal: 0.25, wide: 0.5 } as const;
/** `vibrato`: cycles per second (the 5-6 Hz of a sung or played vibrato), turned into ticks at the note's tempo. */
export const VIBRATO_HZ = 5.5;
/** `vibrato`: it starts this long into its span (a held note settles before it moves). */
const VIBRATO_DELAY_SECONDS = 0.12;
/** `vibrato`: one bend sample per 128th note (30 ticks), so a fast cycle keeps its shape. */
const VIBRATO_TICKS = TPB / 32;

/**
 * A note's pitch gestures as a pitch-bend curve (`SmfNote.bend`: ticks after the onset, semitones),
 * or undefined when it has none. The bend envelope (Songsterr: `position` 0..60 over `bendBeats`,
 * `tone` in hundredths of a whole tone) is sampled every `BEND_TICKS`; a scoop adds a ramp from
 * `slideSemitones` off to 0 over the first 16th, a fall a ramp to `slideSemitones` off over the last.
 *
 * With `vibrato` (the note's tempo), the note's `vibrato` span adds a sine of `VIBRATO_DEPTH` at
 * `VIBRATO_HZ` on top, sampled every `VIBRATO_TICKS`: it starts `VIBRATO_DELAY_SECONDS` in, stops on
 * the last whole half cycle that fits (so it ends centred, before any fall), and is left out when
 * not even one whole cycle fits.
 *
 * `view` (beats into the note, and a length): the curve as heard from a RE-STRIKE that far in (a note
 * a sequence carries in from before it, `window`). The written bend / slide carry on from where they
 * are; the vibrato restarts there (phase 0, after the settle), or is left out when no cycle fits.
 */
export function pitchBendCurve(
  n: MelodicNote, slideSemitones = 2, vibrato?: { bpm: number }, view?: { from: number; length: number },
): { at: number; semis: number }[] | undefined {
  const bend = n.bend !== undefined && n.bend.some((p) => p.tone !== 0) ? n.bend : undefined;
  const dur = n.durationBeats;
  const viewFrom = view?.from ?? 0;
  const viewEnd = view ? view.from + view.length : dur;
  const ramp = Math.min(GESTURE_STEP_BEATS, dur / 2);
  const span = Math.min(n.bendBeats ?? dur, dur);
  const scoop = n.slideIn === 'below' ? -slideSemitones : n.slideIn === 'above' ? slideSemitones : 0;
  const fall = n.slideOut === 'down' ? -slideSemitones : n.slideOut === 'up' ? slideSemitones : 0;
  let vib: { start: number; stop: number; cycle: number; depth: number } | undefined;
  if (vibrato !== undefined && n.vibrato !== undefined) {
    const beatsPerSecond = vibrato.bpm / 60;
    const cycle = beatsPerSecond / VIBRATO_HZ;
    const start = Math.max(n.vibrato.from, viewFrom) + VIBRATO_DELAY_SECONDS * beatsPerSecond;
    const limit = Math.min(n.vibrato.to, dur - (fall ? ramp : 0), viewEnd);
    const stop = start + Math.floor((limit - start) / (cycle / 2) + 1e-9) * (cycle / 2);
    if (stop - start >= cycle - 1e-9) vib = { start, stop, cycle, depth: VIBRATO_DEPTH[n.vibrato.kind] };
  }
  if (bend === undefined && n.slideIn === undefined && n.slideOut === undefined && vib === undefined) return undefined;
  const semisAt = (b: number): number => {
    let s = bend ? bendAt(bend, span > 0 ? Math.min(60, (b / span) * 60) : 60) : 0;
    if (scoop && b < ramp) s += scoop * (1 - b / ramp);
    if (fall && b > dur - ramp) s += fall * Math.min(1, (b - (dur - ramp)) / ramp);
    if (vib && b >= vib.start && b < vib.stop) s += vib.depth * Math.sin((2 * Math.PI * (b - vib.start)) / vib.cycle);
    return Math.round(s * 1e4) / 1e4 || 0;
  };
  const total = Math.max(1, tick(viewEnd - viewFrom));
  const ats: number[] = [];
  for (let t = 0; t < total; t += vib ? VIBRATO_TICKS : BEND_TICKS) ats.push(t);
  if (ats[ats.length - 1] !== total - 1) ats.push(total - 1);   // the fall's (or bend's) last value
  const out: { at: number; semis: number }[] = [];
  for (const t of ats) {
    const s = semisAt(viewFrom + t / TPB);
    if (!out.length || out[out.length - 1].semis !== s) out.push({ at: t, semis: s });
  }
  return out;
}

export interface SongMidiPart {
  name: string;
  /** 0..15. Drums conventionally 9 (GM channel 10). */
  channel: number;
  program?: number;
  /** Exactly one of these. */
  drums?: SongsterrFlat;
  melodic?: SongsterrMelodicFlat;
  /** Semitones added to every pitched note (the importer's octave fixes live here). */
  transpose?: number;
  /**
   * Merge a re-strike of the same pitch that starts exactly where the previous note ends (same
   * velocity) into one held note: a tab writes a held pad as repeated eighths.
   */
  sustainRepeats?: boolean;
  /**
   * Keep ONE voice of every chord onset first (`reduceToMonoVoice`: 0 = lowest, 1 = the one above,
   * -1 = highest): a lead a mono synth plays, or one pitch-bend channel bends as a single line.
   */
  monoVoice?: number;
  /**
   * How the tab's pitch gestures (bends, slides in from / out to an unwritten pitch) are written.
   * Omitted: they are not (plain notes, the default).
   *  - `glide`: as notes (`renderGlideGestures`: a bend is a semitone staircase, a scoop a grace
   *    note a 16th early, a fall the last 16th), each connected note OVERLAPPING the next by
   *    `GLIDE_OVERLAP_TICKS`, so a mono synth in legato mode with glide sweeps between them. Needs
   *    no pitch-bend support anywhere on the target.
   *  - `pitchbend`: the written notes plus real pitch-bend messages (exact, quarter tones too),
   *    scaled to `bendRange` and announced by RPN 0 at the start of every file. A scoop rises
   *    from `slideSemitones` off over the note's first 16th; a fall leaves over its last 16th.
   */
  bends?: 'glide' | 'pitchbend';
  /** `bends: 'pitchbend'`: the range in semitones (1..24) the bends are scaled to. Default 12. */
  bendRange?: number;
  /** Semitones an unwritten slide starts from or goes to. Default 2 (a whole tone). */
  slideSemitones?: number;
  /**
   * `bends: 'pitchbend'` only: also write the tab's vibrato marks as a periodic bend (`pitchBendCurve`,
   * `VIBRATO_*`). One channel bends every note sounding on it, so only a note sounding ALONE (no other
   * note at its onset, none overlapping it) gets its vibrato; the rest are counted in the report.
   */
  vibrato?: boolean;
  /**
   * A reference part (the owner plays it; muted on the target). It is written like any part but
   * never decides a fill: a muted tambourine entering is not a drum fill.
   */
  reference?: boolean;
}

export interface SongMidiSection {
  name: string;
  from: number;   // first measure, 1-based
  to: number;     // last measure, inclusive
  /** Parts that play in this section (by name). Omitted = every part. A part left out is silent. */
  parts?: string[];
  /**
   * Play a part's material from another place in the song: {part name: first measure}. The
   * borrowed window is this section's length. The owner's "unify the chorus bass" correction.
   */
  borrow?: Record<string, number>;
  /** false: never split a fill off; the last bar is part of the loop (a turnaround every cycle). */
  fill?: false;
  /** Plays once, not as a loop (a breakdown that leads straight on). */
  oneShot?: true;
  /**
   * This section's one tempo, replacing the tab's tempo map inside it (an owner ruling: "this
   * section runs at 72"). Notes keep their bars; only the speed changes.
   */
  bpm?: number;
}

export interface SongMidiSequence {
  /**
   * "01", "02b": the order NEXT SEQ walks; a `b` suffix is that section's fill. "c01": a chart
   * piece (`buildSongMidi` option `chart`), after every loop and fill.
   */
  index: string;
  name: string;
  /** `chart`: a stretch of the tab no loop covers, cut as written for the full-chart song. */
  kind: 'loop' | 'fill' | 'chart';
  /** false: the target plays it once (a one-shot section). */
  loop: boolean;
  from: number;
  to: number;
  bars: number;
  /** Quarter beats; the exact loop length. */
  beats: number;
  bpm: number;
  signature: [number, number];
  /** Every section this sequence stands for (more than one when repeats collapsed). */
  plays: string[];
  /** Notes per part name, for the receipt and for project writers. */
  notes: Record<string, SmfNote[]>;
  midi: Uint8Array;
}

export interface SongMidiBuild {
  full: Uint8Array;
  sequences: SongMidiSequence[];
  /** Non-fatal facts the caller should report (dropped dead notes, sections without a fill). */
  notes: string[];
  /** With option `chart`: the whole tab, bar 1 to the end, as a sequence order. */
  chart?: SongMidiChart;
}

/**
 * The full chart: `order` plays bar 1 to bar `bars` exactly once, in tab order. Each step names
 * the sequence and the tab bars it stands for there: a loop on its own from..to, or a chart piece
 * (which may also stand for a later stretch with the same notes). Bars are after any re-bar.
 */
export interface SongMidiChart {
  bars: number;
  order: { index: string; from: number; to: number }[];
}

export interface SongMidiOptions {
  /**
   * Cut every stretch of the tab that no loop covers literally (no loop has exactly that from..to)
   * into chart sequences, split at the tab's section markers, the spec's section boundaries and
   * barline tempo changes, and return the full-chart order. A chart piece plays the tab as written
   * (no fill split, no borrow) with the `parts` of the section before it in the tab (the first
   * section's for a stretch before every section). Refuses unless the order tiles the tab, keeps
   * its metre map, and every chart piece holds every tab note of the parts it plays.
   */
  chart?: boolean;
}

/**
 * One output track: a name, a channel, and the parts its notes come from. `notes` filters a drum
 * part to its kit pieces or its percussion (by `GM_KIT_NOTES`); omitted = every note.
 */
export interface SongMidiTrack {
  name: string;
  channel: number;
  program?: number;
  sources: { part: number; notes?: 'kit' | 'perc' }[];
}

/**
 * The basic kit pieces (the Drums track): GM 31 sticks, 35-38 kicks / side stick / snares,
 * 40-53 snare 2, toms, hats, crashes, rides, china, 55 splash, 57 crash 2, 59 ride 2, plus the
 * extended-kit numbers 23-26 and 88-127 (rolls and articulations a sampled kit maps there).
 * Every other note (39 clap, 54 tambourine, 56 cowbell, 58, 60-87) is percussion.
 */
export const GM_KIT_NOTES: ReadonlySet<number> = new Set([
  23, 24, 25, 26, 31, 35, 36, 37, 38,
  ...Array.from({ length: 14 }, (_, i) => 40 + i),
  55, 57, 59,
  ...Array.from({ length: 40 }, (_, i) => 88 + i),
]);

export const PERCUSSION_TRACK = 'Percussion';

export interface PercussionSplit {
  tracks: SongMidiTrack[];
  /** Index in `tracks` of the synthesized Percussion track; undefined when nothing moved. */
  percussion?: number;
  report: string[];
}

const GM_FOR_VOICE: Record<string, number> = {};
for (const [n, v] of Object.entries(GM_DRUM_TO_VOICE)) if (!(v in GM_FOR_VOICE)) GM_FOR_VOICE[v] = Number(n);
GM_FOR_VOICE.kick = 36;   // Bass Drum 1, the kick every GM kit maps (35 is the acoustic alternate)

/** The MIDI note a drum event plays (its source GM number, else its voice's GM note). */
export function drumEventNote(e: DrumEvent): number | undefined {
  return e.gm ?? GM_FOR_VOICE[e.voice];
}

/** One track per part, in order: what `buildSongMidi` writes without a layout. */
export function partTracks(parts: readonly SongMidiPart[]): SongMidiTrack[] {
  return parts.map((p, i) => ({ name: p.name, channel: p.channel, program: p.program, sources: [{ part: i }] }));
}

/**
 * Drums + Percussion: the kit pieces stay on the kit tracks and every other drum note goes to one
 * `Percussion` track (channel 9) inserted right after the first kit track.
 *  - a played (non-reference) drum part keeps its kit notes and gives up its percussion notes;
 *  - a drum part whose notes are ALL percussion (a tab's own Tambourine / Congas / Perc track,
 *    played or reference) is folded whole into Percussion (`merge`, the default) and its track
 *    disappears, or kept as its own track (`separate`);
 *  - a reference drum part that mixes kit and percussion notes is left alone.
 * Notes keep their timing and velocity; only the track they sit on changes. With no percussion
 * anywhere the layout is one track per part, exactly `partTracks`.
 */
export function splitPercussion(parts: readonly SongMidiPart[], mode: 'merge' | 'separate' = 'merge'): PercussionSplit {
  const counts = parts.map((p) => {
    if (!p.drums) return undefined;
    const c = new Map<number, number>();
    for (const e of p.drums.events) {
      const n = drumEventNote(e);
      if (n !== undefined) c.set(n, (c.get(n) ?? 0) + (e.roll && e.roll > 1 ? e.roll : 1));
    }
    return c;
  });
  const percOf = (c: Map<number, number>) => [...c].filter(([n]) => !GM_KIT_NOTES.has(n)).sort((x, y) => x[0] - y[0]);
  const allPerc = (i: number) => { const c = counts[i]; return !!c && c.size > 0 && percOf(c).length === c.size; };
  const folded = new Set(mode === 'merge' ? parts.flatMap((_, i) => (allPerc(i) ? [i] : [])) : []);
  const stray = new Set(parts.flatMap((p, i) => (p.drums && !p.reference && !allPerc(i) && percOf(counts[i]!).length ? [i] : [])));
  if (!folded.size && !stray.size) return { tracks: partTracks(parts), report: [] };

  const tracks: SongMidiTrack[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (folded.has(i)) continue;
    const p = parts[i];
    if (p.name === PERCUSSION_TRACK) throw new Error(`a part is already named "${PERCUSSION_TRACK}": rename it or fold it (all-percussion parts fold in merge mode)`);
    tracks.push({ name: p.name, channel: p.channel, program: p.program, sources: [{ part: i, ...(stray.has(i) ? { notes: 'kit' as const } : {}) }] });
  }
  const sources = parts.flatMap((_, i) => (folded.has(i) ? [{ part: i }] : stray.has(i) ? [{ part: i, notes: 'perc' as const }] : []));
  // After the first played kit track, else the first drum track left, else where the first folded part sat.
  const kitAt = (pred: (i: number) => boolean) => tracks.findIndex((t) => pred(t.sources[0].part));
  let at = kitAt((i) => !!parts[i].drums && !parts[i].reference);
  if (at < 0) at = kitAt((i) => !!parts[i].drums);
  const insert = at >= 0 ? at + 1 : tracks.filter((t) => t.sources[0].part < sources[0].part).length;
  tracks.splice(insert, 0, { name: PERCUSSION_TRACK, channel: 9, sources });

  const list = (c: [number, number][]) => c.map(([n, k]) => `${n} x${k}`).join(', ');
  const report = [
    ...[...stray].map((i) => `${PERCUSSION_TRACK}: ${parts[i].name} gives up ${list(percOf(counts[i]!))}`),
    ...[...folded].map((i) => `${PERCUSSION_TRACK}: ${parts[i].name} folded in whole (${list(percOf(counts[i]!))})`),
  ];
  return { tracks, percussion: insert, report };
}

function drumVelocity(e: DrumEvent): number {
  return e.velocity ?? (e.ghost ? GHOST_HIT_VELOCITY : e.accent ? ACCENT_HIT_VELOCITY : PLAIN_HIT_VELOCITY);
}

const tick = (beat: number): number => Math.round(beat * TPB);

/** A part's notes as absolute-tick SMF notes over the whole song. */
function partNotes(p: SongMidiPart, report: string[]): SmfNote[] {
  const out: SmfNote[] = [];
  if (p.drums) {
    for (const e of p.drums.events) {
      const note = drumEventNote(e);
      if (note === undefined) continue;
      const hits = e.roll && e.roll > 1 ? e.roll : 1;
      for (let i = 0; i < hits; i++) {
        out.push({ tick: tick(e.beat + (i * ROLL_SPAN_BEATS) / hits), note, velocity: drumVelocity(e), durationTicks: DRUM_TICKS });
      }
    }
  } else if (p.melodic) {
    let dead = 0;
    let src = p.melodic.notes as MelodicNote[];
    if (p.bends !== undefined && p.bends !== 'glide' && p.bends !== 'pitchbend') throw new Error(`part "${p.name}" bends must be "glide" or "pitchbend": ${String(p.bends)}`);
    if (p.bends !== 'pitchbend' && p.bendRange !== undefined) throw new Error(`part "${p.name}": bendRange needs bends "pitchbend"`);
    if (p.monoVoice !== undefined) {
      if (!Number.isInteger(p.monoVoice)) throw new Error(`part "${p.name}" monoVoice must be an integer: ${p.monoVoice}`);
      const r = reduceToMonoVoice(src, p.monoVoice);
      src = r.notes;
      if (r.dropped) report.push(`${p.name}: monoVoice ${p.monoVoice} keeps one note per chord (${r.dropped} note(s) left out)`);
    }
    const semis = p.slideSemitones ?? 2;
    if (p.bends === 'glide') {
      const g = renderGlideGestures(src, { stepBeats: GESTURE_STEP_BEATS, slideSemitones: semis });
      src = g.notes;
      report.push(`${p.name}: ${describeGlideGestures(g.report, semis)}`);
    }
    if (p.vibrato !== undefined && p.bends !== 'pitchbend') throw new Error(`part "${p.name}": vibrato needs bends "pitchbend"`);
    const onsets = [...new Set(src.filter((n) => !n.dead).map((n) => tick(n.beat)))].sort((x, y) => x - y);
    // vibrato: only on a note sounding alone (the channel-wide rule); the tempo sets its cycle in ticks.
    const vibOf = new Map<MelodicNote, { bpm: number }>();
    let vibMarked = 0;
    if (p.vibrato === true) {
      const live = src.filter((n) => !n.dead);
      for (const n of live) {
        if (n.vibrato === undefined) continue;
        vibMarked++;
        const end = n.beat + n.durationBeats;
        if (live.some((o) => o !== n && o.beat < end - 1e-6 && o.beat + o.durationBeats > n.beat + 1e-6)) continue;
        vibOf.set(n, { bpm: tempoAtBeat(p.melodic, n.beat) ?? p.melodic.bpm ?? 120 });
      }
    }
    const curveOf = (n: MelodicNote) => pitchBendCurve(n, semis, vibOf.get(n));
    // pitchbend: one channel bends every note sounding on it, so a chord onset's curve is its TOP
    // gestured note's (monoVoice avoids the question).
    const curveOwner = new Map<number, MelodicNote>();
    if (p.bends === 'pitchbend') {
      for (const n of src) {
        if (n.dead || curveOf(n) === undefined) continue;
        const o = curveOwner.get(tick(n.beat));
        if (!o || n.pitch > o.pitch) curveOwner.set(tick(n.beat), n);
      }
    }
    let bent = 0;
    for (const n of src) {
      if (n.dead) { dead++; continue; }
      const pitch = n.pitch + (p.transpose ?? 0);
      if (pitch < 0 || pitch > 127) continue;
      const t = tick(n.beat);
      let durationTicks = Math.max(1, tick(n.durationBeats));
      if (p.bends === 'glide' && n.legato !== undefined) {
        // A connected note runs just past the next onset: overlapping gates are what a mono synth plays legato.
        const next = onsets.find((o) => o > t);
        if (next !== undefined) durationTicks = Math.max(durationTicks, next - t + GLIDE_OVERLAP_TICKS);
      }
      const curve = curveOwner.get(t) === n ? curveOf(n) : undefined;
      if (curve) bent++;
      const vib = curve ? vibOf.get(n) : undefined;
      const restrike: GestureNote['restrike'] = vib && (
        (by, length) => pitchBendCurve(n, semis, vib, { from: by / TPB, length: length / TPB }));
      const note: GestureNote = { tick: t, note: pitch, velocity: n.velocity ?? PLAIN_HIT_VELOCITY, durationTicks, ...(curve ? { bend: curve } : {}) };
      if (restrike) note.restrike = restrike;
      out.push(note);
    }
    if (p.bends === 'pitchbend') {
      const range = p.bendRange ?? DEFAULT_BEND_RANGE;
      const peak = out.reduce((m, x) => Math.max(m, ...(x.bend ?? []).map((b) => Math.abs(b.semis))), 0);
      if (peak > range + 1e-9) throw new Error(`part "${p.name}" bends ${peak} semitones, past its bendRange ${range}: raise bendRange`);
      report.push(`${p.name}: ${bent} note(s) carry pitch bend (peak ${peak} semitones, range ${range}, RPN 0 at the start of every file)`);
      if (p.vibrato === true) {
        // A note alone owns its onset's curve; it carries vibrato when its curve differs from the plain one.
        const shaped = [...vibOf.keys()].filter((n) => JSON.stringify(curveOf(n)) !== JSON.stringify(pitchBendCurve(n, semis))).length;
        report.push(`${p.name}: vibrato on ${shaped} of ${vibMarked} marked note(s) (left plain: ${vibMarked - vibOf.size} with other notes sounding, ${vibOf.size - shaped} too short for one cycle)`);
      }
    }
    if (dead) report.push(`${p.name}: ${dead} dead (X) note(s) left out: a click with no pitch`);
    if (p.sustainRepeats) return mergeRepeats(out);
  }
  return out;
}

/**
 * What to leave out of one MELODIC part before the song is cut (`filterMelodicPart`). Drum parts
 * never take it: their ghosts are played soft by design (`flattenSongsterrDrums`, ghost policy).
 */
export interface MelodicPartFilter {
  /**
   * Leave out every note the tab marks `ghost` (a parenthesised note). A melodic tab sometimes
   * engraves a line in several octaves with the extra ones ghosted (one song's Tenor Sax: the
   * middle line plain, the octaves above and below ghosted); played, that is three octaves at once.
   */
  dropGhosts?: boolean;
  /**
   * Tab measure ranges, 1-based inclusive ([[61, 76]]), the part is silent in: a note STRUCK inside
   * is left out, and a note held into a range from before it stops where the range starts. Tab
   * measures, so it applies before any re-bar and before the sections are cut.
   */
  skipMeasures?: readonly (readonly [number, number])[];
}

/**
 * A melodic flat with `filter` applied: the notes it leaves out are gone (the flat's measures,
 * tempos and length are unchanged, so every part still cuts on the same bars). `report` names what
 * was left out, for the manifest.
 */
export function filterMelodicPart(name: string, flat: SongsterrMelodicFlat, filter: MelodicPartFilter): { flat: SongsterrMelodicFlat; report: string[] } {
  const report: string[] = [];
  let notes = flat.notes;
  if (filter.dropGhosts !== undefined && typeof filter.dropGhosts !== 'boolean') throw new Error(`part "${name}" dropGhosts must be true or false: ${String(filter.dropGhosts)}`);
  if (filter.dropGhosts) {
    const kept = notes.filter((n) => !n.ghost);
    report.push(`${name}: dropGhosts leaves out ${notes.length - kept.length} ghosted note(s) of ${notes.length}`);
    notes = kept;
  }
  const ranges = filter.skipMeasures ?? [];
  if (!Array.isArray(ranges)) throw new Error(`part "${name}" skipMeasures must be a list of [from, to] measure pairs`);
  const M = flat.measures.length;
  const spans = ranges.map((r) => {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < 1 || r[1] < r[0] || r[1] > M) {
      throw new Error(`part "${name}" skipMeasures ${JSON.stringify(r)} must be [from, to] tab measures inside 1..${M}`);
    }
    const start = flat.measures[r[0] - 1].startBeat;
    const end = r[1] < M ? flat.measures[r[1]].startBeat : flat.totalBeats;
    return { r, start, end };
  });
  for (const { r, start, end } of spans) {
    let struck = 0, clipped = 0;
    const kept: MelodicNote[] = [];
    for (const n of notes) {
      if (n.beat >= start - 1e-9 && n.beat < end - 1e-9) { struck++; continue; }
      if (n.beat < start && n.beat + n.durationBeats > start + 1e-9) {
        clipped++;
        kept.push({ ...n, durationBeats: start - n.beat });
        continue;
      }
      kept.push(n);
    }
    report.push(`${name}: skipMeasures m${r[0]}-${r[1]} leaves out ${struck} note(s)${clipped ? `, stops ${clipped} held into it` : ''}`);
    notes = kept;
  }
  return { flat: notes === flat.notes ? flat : { ...flat, notes }, report };
}

function mergeRepeats(notes: SmfNote[]): SmfNote[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const open = new Map<number, SmfNote>();
  const out: SmfNote[] = [];
  for (const n of sorted) {
    const prev = open.get(n.note);
    // A bent note never merges: its curve is timed to its own span (a fall would hold past it, a
    // scoop on the repeat would be lost).
    if (prev && prev.tick + prev.durationTicks === n.tick && prev.velocity === n.velocity && !prev.bend && !n.bend) {
      prev.durationTicks += n.durationTicks;
      continue;
    }
    const copy = { ...n };
    out.push(copy);
    open.set(n.note, copy);
  }
  return out;
}

interface Bar { start: number; end: number; sig: [number, number]; bpm?: number }

function bars(measures: readonly MeasureInfo[], totalBeats: number): Bar[] {
  return measures.map((m, i) => ({
    start: m.startBeat,
    end: i + 1 < measures.length ? measures[i + 1].startBeat : totalBeats,
    sig: m.signature,
    bpm: m.bpm,
  }));
}

/**
 * Notes inside [a, b), shifted to 0, clipped to end at b. `carry`: a note still sounding at `a`
 * (a pad held across the barline) starts the window too, struck at 0 for what is left of it,
 * so a held part is not silent in the section it rings into, unless the section strikes its own
 * note at 0. Drums never carry: their length is
 * nominal (a one-shot plays out anyway), and a hit just before the window is not this window's.
 */
function window(notes: readonly GestureNote[], a: number, b: number, carry = false): SmfNote[] {
  const out: SmfNote[] = [];
  const held: SmfNote[] = [];
  for (const n of notes) {
    const end = n.tick + n.durationTicks;
    if (n.tick >= a && n.tick < b) {
      const { restrike: _r, ...m } = n;
      out.push({ ...m, tick: n.tick - a, durationTicks: Math.max(1, Math.min(end, b) - n.tick) });
    } else if (carry && n.tick < a && end > a) {
      // Struck again at 0: a vibrato restarts from the re-strike (phase 0, after its settle), so the
      // curve is redrawn from there rather than cut mid-cycle; a plain bend carries its value in.
      const length = Math.min(end, b) - a;
      const { restrike, bend: _b, ...rest } = n;
      const bend = restrike ? restrike(a - n.tick, length) : n.bend ? shiftBend(n.bend, a - n.tick) : undefined;
      held.push({ ...rest, tick: 0, durationTicks: length, ...(bend ? { bend } : {}) });
    }
  }
  // A section that strikes on its own first tick starts fresh: a tail ringing in from before
  // (a let-ring bass) would otherwise restart on every loop.
  return held.length && !out.some((n) => n.tick === 0) ? [...held, ...out] : out;
}

/** A part's note, plus how to redraw its curve from a re-strike `by` ticks in (a note with vibrato). */
type GestureNote = SmfNote & { restrike?: (by: number, length: number) => { at: number; semis: number }[] | undefined };

/** A bend curve seen from `by` ticks into its note: the value in effect there at 0, then what follows. */
function shiftBend(bend: readonly { at: number; semis: number }[], by: number): { at: number; semis: number }[] {
  const before = bend.filter((p) => p.at <= by);
  return [{ at: 0, semis: before.length ? before[before.length - 1].semis : 0 }, ...bend.filter((p) => p.at > by).map((p) => ({ at: p.at - by, semis: p.semis }))];
}

const key = (notes: readonly SmfNote[]): string => notes.map((n) => `${n.tick}:${n.note}:${n.velocity}:${n.durationTicks}${n.bend ? `~${n.bend.map((b) => `${b.at}/${b.semis}`).join(';')}` : ''}`).join(',');
/** What a drum bar plays, velocity-blind: a ghost or accent change is not a different bar. */
const hitKey = (notes: readonly SmfNote[]): string => [...new Set(notes.map((n) => `${n.tick}:${n.note}`))].sort().join(',');

/**
 * `layout`: the output tracks (default one per part, `partTracks`). Sections, fills, borrows and
 * repeat collapsing are decided on the PARTS; the layout only regroups their notes into tracks
 * (`splitPercussion`), so a regrouped song has the same sequences as the plain one.
 */
export function buildSongMidi(
  title: string, parts: readonly SongMidiPart[], sections: readonly SongMidiSection[], layout?: readonly SongMidiTrack[],
  opts: SongMidiOptions = {},
): SongMidiBuild {
  const report: string[] = [];
  const ref = parts.find((p) => p.drums)?.drums ?? parts.find((p) => p.melodic)?.melodic;
  if (!ref) throw new Error('buildSongMidi needs at least one part');
  for (const p of parts) if (!p.drums === !p.melodic) throw new Error(`part "${p.name}" needs exactly one of drums / melodic`);
  const dupName = parts.find((p, i) => parts.findIndex((q) => q.name === p.name) !== i);
  if (dupName) throw new Error(`two parts are named "${dupName.name}": every part needs its own track name`);
  const grid = bars(ref.measures, ref.totalBeats);
  const tempos: TempoMark[] = ref.tempos.length ? ref.tempos : [{ measure: 0, beat: 0, bpm: ref.bpm ?? 120 }];
  const bpmAt = (beat: number): number => [...tempos].reverse().find((t) => t.beat <= beat + 1e-9)?.bpm ?? tempos[0].bpm;
  const all = parts.map((p) => partNotes(p, report));
  const outTracks = layout ?? partTracks(parts);
  const dupTrack = outTracks.find((t, i) => outTracks.findIndex((u) => u.name === t.name) !== i);
  if (dupTrack) throw new Error(`two tracks are named "${dupTrack.name}"`);
  for (const t of outTracks) {
    for (const src of t.sources) {
      if (!parts[src.part]) throw new Error(`track "${t.name}" takes notes from part ${src.part}, which does not exist`);
      if (src.notes && !parts[src.part].drums) throw new Error(`track "${t.name}" filters kit/perc notes of "${parts[src.part].name}", which is not a drum part`);
    }
  }
  /** One track's notes out of the per-part notes (a single unfiltered source passes through as is). */
  const gather = (perPart: readonly SmfNote[][], t: SongMidiTrack): SmfNote[] => {
    if (t.sources.length === 1 && !t.sources[0].notes) return perPart[t.sources[0].part];
    return t.sources.flatMap((src) => (src.notes
      ? perPart[src.part].filter((x) => GM_KIT_NOTES.has(x.note) === (src.notes === 'kit'))
      : perPart[src.part]));
  };
  // Every played kit track decides a fill together; reference (muted) drum parts do not.
  const drumIdx = parts.flatMap((p, i) => (p.drums && !p.reference ? [i] : []));

  const bendRangeOf = (t: SongMidiTrack): number | undefined => {
    const r = t.sources.map((src) => parts[src.part]).filter((p) => p.bends === 'pitchbend').map((p) => p.bendRange ?? DEFAULT_BEND_RANGE);
    if (new Set(r).size > 1) throw new Error(`track "${t.name}" mixes parts with different bendRange`);
    return r[0];
  };
  const track = (t: SongMidiTrack, notes: SmfNote[]): SmfTrack => {
    const bendRange = bendRangeOf(t);
    return { name: t.name, channel: t.channel, program: t.program, ...(bendRange !== undefined ? { bendRange } : {}), notes };
  };
  const meterRuns = (a: number, b: number) => {
    const out: { tick: number; numerator: number; denominator: number }[] = [];
    for (let m = a; m <= b; m++) {
      const [n, d] = grid[m].sig;
      const last = out[out.length - 1];
      if (!last || last.numerator !== n || last.denominator !== d) out.push({ tick: tick(grid[m].start - grid[a].start), numerator: n, denominator: d });
    }
    return out;
  };

  // A source whose first tempo mark sits after beat 0 still starts at that tempo (players
  // default to 120 without one at tick 0).
  const fullTempos = tempos.map((t) => ({ tick: tick(t.beat), bpm: t.bpm }));
  if (fullTempos[0].tick > 0) fullTempos.unshift({ tick: 0, bpm: fullTempos[0].bpm });
  const full = writeMidiFile({
    name: title,
    tempos: fullTempos,
    meters: meterRuns(0, grid.length - 1),
    markers: sections.map((s) => ({ tick: tick(grid[s.from - 1]?.start ?? 0), text: s.name })),
    tracks: outTracks.map((t) => track(t, gather(all, t))),
    // The last bar, or later if a final note rings past it (the full song is not a loop).
    endTick: all.flat().reduce((e, x) => Math.max(e, x.tick + x.durationTicks), tick(ref.totalBeats)),
  });

  /** One sequence over tab bars from..to (1-based). `sbpm`: a section's own tempo. */
  const makeSeq = (idx: string, name: string, kind: SongMidiSequence['kind'], from: number, to: number, raw: SmfNote[][],
    loops: boolean, sbpm: number | undefined): SongMidiSequence => {
    const notes = outTracks.map((t) => untangleNotes(gather(raw, t)));   // what the file holds, so the manifest counts match it
    const beats = grid[to - 1].end - grid[from - 1].start;
    const local = sbpm !== undefined ? [] : tempos.filter((t) => t.beat > grid[from - 1].start && t.beat < grid[to - 1].end)
      .map((t) => ({ tick: tick(t.beat - grid[from - 1].start), bpm: t.bpm }));
    const bpm = sbpm ?? bpmAt(grid[from - 1].start);
    if (local.length) {
      report.push(`${idx} ${name}: ${local.length} tempo change(s) inside (${local.map((t) => t.bpm).join(', ')} bpm); `
        + `a target that plays one tempo per sequence plays ${bpm}`);
    }
    return {
      index: idx, name, kind, loop: loops, from, to, bars: to - from + 1, beats, bpm,
      signature: grid[from - 1].sig, plays: [name],
      notes: Object.fromEntries(outTracks.map((t, i) => [t.name, notes[i]])),
      midi: writeMidiFile({
        name: `${title} - ${name}`,
        tempos: [{ tick: 0, bpm }, ...local],
        meters: meterRuns(from - 1, to - 1),
        tracks: outTracks.map((t, i) => track(t, notes[i])),
        endTick: tick(beats),
      }),
    };
  };
  // Same notes are one sequence only at the same length, metre map and tempo map (0-based bars a..b).
  const shapeOf = (a: number, b: number, sbpm: number | undefined): string => JSON.stringify([
    grid[b].end - grid[a].start, meterRuns(a, b), sbpm ?? bpmAt(grid[a].start),
    sbpm !== undefined ? [] : tempos.filter((t) => t.beat > grid[a].start && t.beat < grid[b].end).map((t) => [t.beat - grid[a].start, t.bpm]),
  ]);

  const sequences: SongMidiSequence[] = [];
  const seen = new Map<string, SongMidiSequence>();
  let n = 0;
  for (const s of sections) {
    if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || s.from < 1 || s.to < s.from || s.to > grid.length) {
      throw new Error(`section "${s.name}" m${s.from}-${s.to} is outside the song (1..${grid.length})`);
    }
    const a = s.from - 1, b = s.to - 1;
    const t0 = tick(grid[a].start), t1 = tick(grid[b].end);
    for (const name of [...(s.parts ?? []), ...Object.keys(s.borrow ?? {})]) {
      if (!parts.some((p) => p.name === name)) throw new Error(`section "${s.name}" names an unknown part "${name}"`);
    }
    for (const [name, at] of Object.entries(s.borrow ?? {})) {
      if (!Number.isInteger(at) || at < 1 || at - 1 + (b - a) >= grid.length) {
        throw new Error(`section "${s.name}" borrows "${name}" from m${at}: m${at}-${at + (b - a)} is outside the song (1..${grid.length})`);
      }
      for (let m = 0; m <= b - a; m++) {
        const x = grid[at - 1 + m].sig, y = grid[a + m].sig;
        if (x[0] !== y[0] || x[1] !== y[1]) {
          throw new Error(`section "${s.name}" borrows "${name}" from m${at}, but its bar ${m + 1} is ${x.join('/')} there and ${y.join('/')} here`);
        }
      }
    }
    const source = (i: number, from: number, to: number): SmfNote[] => {
      if (s.parts && !s.parts.includes(parts[i].name)) return [];
      const carry = parts[i].melodic !== undefined;
      const at = s.borrow?.[parts[i].name];
      if (at === undefined) return window(all[i], from, to, carry);
      const shift = tick(grid[at - 1].start) - t0;
      return window(all[i], from + shift, to + shift, carry);
    };
    let content = parts.map((_, i) => source(i, t0, t1));

    // Fill: the last bar's drums (velocity-blind) are NEW to the section, and the section has a
    // groove (a bar with drums seen at least twice). A last bar that already played earlier in
    // the section is part of the groove cycle, not a fill. The loop's last bar becomes the bar
    // the groove plays at that point of its cycle (the commonest bar at the same phase of the
    // groove's period), so a 2-bar groove still alternates up to the wrap. Pitched parts keep
    // their own last bar.
    let fill: SmfNote[][] | undefined;
    if (drumIdx.length && b - a >= 2 && s.fill !== false) {
      const barKey = (m: number) => drumIdx.map((i) => hitKey(source(i, tick(grid[m].start), tick(grid[m].end)))).join('/').replace(/^\/+$/, '');
      const lastLen = grid[b].end - grid[b].start;
      const same = (m: number) => Math.abs(grid[m].end - grid[m].start - lastLen) < 1e-9;
      const keys = new Map<number, string>();
      for (let m = a; m <= b; m++) keys.set(m, barKey(m));
      const counts = new Map<string, number>();
      for (let m = a; m < b; m++) {
        const k = keys.get(m)!;
        if (k !== '' && same(m)) counts.set(k, (counts.get(k) ?? 0) + 1);   // a drumless bar is a rest, never the groove
      }
      const last = keys.get(b)!;
      const hasGroove = [...counts.values()].some((c) => c >= 2);
      if (hasGroove && last !== '' && !counts.has(last)) {
        // The groove's period: the step (1, 2, 4 or 8 bars) at which the section repeats itself best.
        let period = 1, best = -1;
        for (const p of [1, 2, 4, 8]) {
          let hit = 0, tot = 0;
          for (let m = a + p; m < b; m++) { tot++; if (keys.get(m) === keys.get(m - p)) hit++; }
          if (tot >= 2 && hit / tot > best + 1e-9) { best = hit / tot; period = p; }
        }
        const phase = new Map<string, { n: number; m: number }>();
        for (let m = b - period; m >= a; m -= period) {
          const k = keys.get(m)!;
          if (k === '' || !same(m)) continue;
          const c = phase.get(k);
          phase.set(k, { n: (c?.n ?? 0) + 1, m: c?.m ?? m });   // the latest occurrence stands for it
        }
        const pick = [...phase.values()].sort((x, y) => y.n - x.n)[0]
          ?? { m: [...keys.entries()].find(([m, k]) => m < b && k !== '' && same(m) && (counts.get(k) ?? 0) >= 2)![0] };
        const lb0 = tick(grid[b].start), lb1 = tick(grid[b].end);
        fill = parts.map((_, i) => source(i, lb0, lb1));
        const g0 = tick(grid[pick.m].start), g1 = tick(grid[pick.m].end);
        content = content.map((notes, i) => (drumIdx.includes(i)
          ? [...notes.filter((x) => x.tick < lb0 - t0), ...source(i, g0, g1).map((x) => ({ ...x, tick: x.tick + (lb0 - t0) }))]
          : notes));
      }
    }

    if (s.bpm !== undefined && !(s.bpm >= 4 && s.bpm <= 999)) throw new Error(`section "${s.name}" bpm must be 4..999: ${s.bpm}`);
    const make = (idx: string, name: string, kind: 'loop' | 'fill', from: number, to: number, raw: SmfNote[][], loops = true): SongMidiSequence =>
      makeSeq(idx, name, kind, from, to, raw, loops, s.bpm);
    const shape = shapeOf(a, b, s.bpm);
    const k = `${shape}|${s.oneShot ? 'once' : 'loop'}|${content.map(key).join('/')}|${fill?.map(key).join('/') ?? ''}`;
    const dup = seen.get(k);
    if (dup) {
      dup.plays.push(s.name);
      for (const q of sequences) if (q.index === `${dup.index}b`) q.plays.push(`${s.name} Fill`);
      continue;
    }
    n++;
    const idx = String(n).padStart(2, '0');
    const loop = make(idx, s.name, 'loop', s.from, s.to, content, !s.oneShot);
    seen.set(k, loop);
    sequences.push(loop);
    if (fill) sequences.push(make(`${idx}b`, `${s.name} Fill`, 'fill', s.to, s.to, fill));
  }
  if (!opts.chart) return { full, sequences, notes: report };

  // ---- Full chart: loops where they literally cover, chart pieces cut from the tab elsewhere.
  // The chart ends at the last bar anything sounds in (any part, muted ones too) or the last loop's
  // end: a tab's trailing empty bars are not played.
  const loops = sequences.filter((q) => q.kind === 'loop');
  const lastTick = all.flat().reduce((e, x) => Math.max(e, x.tick + x.durationTicks), 0);
  let N = Math.max(1, ...loops.map((q) => q.to));
  while (N < grid.length && tick(grid[N].start) < lastTick) N++;
  if (N < grid.length) report.push(`chart: bars ${N + 1}-${grid.length} are silent on every part: left out of the full chart`);
  type Step = { q?: SongMidiSequence; from: number; to: number };
  const walk: Step[] = [];
  for (let m = 1; m <= N;) {
    const at = loops.filter((q) => q.from === m).sort((x, y) => y.to - x.to)[0];   // the longest loop starting here
    if (at) { walk.push({ q: at, from: at.from, to: at.to }); m = at.to + 1; continue; }
    let e = m;
    while (e < N && !loops.some((q) => q.from === e + 1)) e++;
    walk.push({ from: m, to: e });
    m = e + 1;
  }
  // Cut an uncovered stretch at the tab's markers, the spec's section edges and barline tempo changes.
  const edges = new Set(sections.flatMap((s) => [s.from, s.to + 1]));
  const cutAt = (c: number): boolean => !!ref.measures[c - 1]?.marker || edges.has(c)
    || tempos.some((t) => Math.abs(t.beat - grid[c - 1].start) < 1e-9 && t.bpm !== bpmAt(grid[c - 2].start));
  const markerAt = (bar: number): string => {
    for (let j = bar - 1; j >= 0; j--) { const t = ref.measures[j]?.marker?.trim(); if (t) return t; }
    return '';
  };
  const byFrom = [...sections].sort((x, y) => x.from - y.from);
  const partsAt = (bar: number): string[] | undefined => ([...byFrom].reverse().find((s) => s.from <= bar) ?? byFrom[0])?.parts;
  const plain = (from: number, to: number, list: string[] | undefined): SmfNote[][] => parts.map((p, i) => (
    list && !list.includes(p.name) ? [] : window(all[i], tick(grid[from - 1].start), tick(grid[to - 1].end), p.melodic !== undefined)));
  const charts = new Map<string, SongMidiSequence>();
  const order: { index: string; from: number; to: number }[] = [];
  const used: { q: SongMidiSequence; from: number; to: number; list?: string[] }[] = [];
  let c = 0;
  for (const st of walk) {
    if (st.q) { order.push({ index: st.q.index, from: st.from, to: st.to }); used.push({ q: st.q, from: st.from, to: st.to }); continue; }
    let start = st.from;
    for (let bar = st.from; bar <= st.to; bar++) {
      if (bar < st.to && !cutAt(bar + 1)) continue;
      const list = partsAt(start);
      const raw = plain(start, bar, list);
      const k = `${shapeOf(start - 1, bar - 1, undefined)}|loop|${raw.map(key).join('/')}|`;
      const name = markerAt(start) || `Bars ${start}-${bar}`;   // a tab without markers
      let q = seen.get(k) ?? charts.get(k);
      if (!q) {
        c++;
        q = makeSeq(`c${String(c).padStart(2, '0')}`, name, 'chart', start, bar, raw, true, undefined);
        charts.set(k, q);
        sequences.push(q);
      } else if (q.kind === 'chart') q.plays.push(name);
      order.push({ index: q.index, from: start, to: bar });
      used.push({ q, from: start, to: bar, list });
      start = bar + 1;
    }
  }

  // Gate: the order tiles the tab, keeps its metre map, and loses no note of a chart piece.
  order.forEach((o, i) => {
    const want = i ? order[i - 1].to + 1 : 1;
    if (o.from !== want) throw new Error(`chart: step ${i + 1} (${o.index}) starts at bar ${o.from}, expected ${want}`);
  });
  if (order[order.length - 1]?.to !== N) throw new Error(`chart: the order ends at bar ${order[order.length - 1]?.to}, the chart at ${N}`);
  const beats = used.reduce((sum, u) => sum + u.q.beats, 0);
  if (Math.abs(beats - (grid[N - 1].end - grid[0].start)) > 1e-6) throw new Error(`chart: ${beats} beats against the tab's ${grid[N - 1].end - grid[0].start}`);
  const runs: { tick: number; numerator: number; denominator: number }[] = [];
  let off = 0;
  for (const u of used) {
    for (const r of meterRuns(u.q.from - 1, u.q.to - 1)) {
      const last = runs[runs.length - 1];
      if (!last || last.numerator !== r.numerator || last.denominator !== r.denominator) runs.push({ ...r, tick: r.tick + off });
    }
    off += tick(u.q.beats);
  }
  if (JSON.stringify(runs) !== JSON.stringify(meterRuns(0, N - 1))) throw new Error('chart: the order\'s metre map is not the tab\'s');
  const trackOf = (i: number, note: number): string | undefined => outTracks.find((t) => t.sources.some((src) => src.part === i
    && (!src.notes || GM_KIT_NOTES.has(note) === (src.notes === 'kit'))))?.name;
  // Every tab note starts inside exactly one step.
  const onsets = all.reduce((sum, ns) => sum + ns.length, 0);
  const placed = used.reduce((sum, u) => {
    const t0 = tick(grid[u.from - 1].start), t1 = tick(grid[u.to - 1].end);
    return sum + all.reduce((k, ns) => k + ns.filter((x) => x.tick >= t0 && x.tick < t1).length, 0);
  }, 0);
  if (placed !== onsets) throw new Error(`chart: ${placed} of the tab's ${onsets} notes fall inside a step (each must, once)`);
  const differ = new Map<string, number>();
  let silenced = 0;
  for (const u of used) {
    const t0 = tick(grid[u.from - 1].start), t1 = tick(grid[u.to - 1].end);
    const have = new Map(Object.entries(u.q.notes).map(([name, ns]) => [name, new Set(ns.map((x) => `${x.tick}:${x.note}`))]));
    parts.forEach((p, i) => {
      for (const x of all[i]) {
        if (x.tick < t0 || x.tick >= t1) continue;
        const tr = trackOf(i, x.note);
        if (tr === undefined) continue;
        if (have.get(tr)?.has(`${x.tick - t0}:${x.note}`)) continue;
        if (u.q.kind === 'chart' && u.list && !u.list.includes(p.name)) { silenced++; continue; }
        if (u.q.kind === 'chart') throw new Error(`chart: ${u.q.index} ${u.q.name} (bars ${u.from}-${u.to}) loses ${p.name} note ${x.note} at tick ${x.tick - t0}`);
        differ.set(u.q.index, (differ.get(u.q.index) ?? 0) + 1);
      }
    });
  }
  report.push(`chart: ${c} chart piece(s); the full chart is ${order.length} steps over bars 1-${N}`);
  if (differ.size) {
    report.push(`chart: the loops play ${[...differ.values()].reduce((x, y) => x + y, 0)} tab notes otherwise (their section's parts / borrow / fill groove): `
      + [...differ].map(([i, k]) => `${i} x${k}`).join(', '));
  }
  if (silenced) report.push(`chart: ${silenced} tab note(s) silent in chart pieces (parts of the section before them)`);
  return { full, sequences, notes: report, chart: { bars: N, order } };
}
