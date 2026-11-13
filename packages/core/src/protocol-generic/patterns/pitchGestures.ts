/**
 * pitchGestures — render a source's continuous PITCH GESTURES (bends, and the slides that go into or
 * out of an unwritten pitch) as note data a gliding mono synth plays back as a real pitch sweep.
 *
 * ## Why note data, and not a pitch-bend message
 *
 * A stored Circuit Tracks project cannot transmit pitch bend in any firmware (its MIDI templates are
 * plain 7-bit CCs, and the note step carries no bend lane), and the MicroFreak cannot turn a CC into
 * pitch (its Matrix sources are internal only). What BOTH ends do support is the oldest trick in
 * sequenced mono synths, the TB-303 slide: two notes that OVERLAP are played legato, the synth does
 * not re-trigger its envelope (MicroFreak: Utility > Preset > Envelope Legato = ON), and its glide
 * (portamento) sweeps the pitch from the first note to the second. So a bend becomes "the note, then
 * an overlapping note at the bent pitch", and the synth's glide supplies the sweep.
 * Research record: docs/_private/BEND-FEASIBILITY-2026-07-27.md, PITCH-BEND-RECEIVE-2026-07-27.md and
 * the 2026-09-11 follow-up in rig/TONE-sequenced-bends-microfreak.md.
 *
 * ## What each gesture becomes (all connections are `legato: 'glide'`, i.e. gate overlap)
 *
 *  - SCOOP (slide in from below / above): a one-step grace note `slideSemitones` below (above) the
 *    written pitch, on the step BEFORE the note, connected into it. The written note still lands on
 *    its own step; the grace steals the step before it from a preceding note or rest.
 *  - FALL (slide out downwards / upwards): the note's LAST step becomes a one-step note
 *    `slideSemitones` below (above) where the note ended, connected from it.
 *  - BEND: the envelope is sampled across the note and rounded to semitones (a quarter-tone point
 *    rounds TOWARD the unbent pitch, so a "1 1/4 tone" bend is +2 semitones, never an out-of-key +3);
 *    every place the rounded pitch changes becomes a new connected note on the nearest step. A fast
 *    bend collapses to one target note and the synth's glide time sets its speed; a slow bend becomes
 *    a semitone STAIRCASE spread across the note, so its timing survives a short, fixed glide.
 *
 * Where a fall and the next note's scoop land on the SAME step (a note that falls off and the next
 * one that scoops in), they are one note: the arrival (the scoop pitch) wins.
 *
 * ## What it deliberately does not do
 *
 *  - Chords. A glide is a monophonic idea; a gesture on a chord onset is left alone and counted, and
 *    `reduceToMonoVoice` exists to make a chord line monophonic first.
 *  - Glide TIME. That lives on the synth. On a MicroFreak the cleanest patch is Glide knob 0 and the
 *    Matrix ENV → Glide, so only overlapped (legato) notes glide and a detached note jumps; see the
 *    TONE doc for the whole recipe.
 *
 * Pure: notes in, new notes out. Runs on BEAT-time notes before quantization, so the step grid only
 * enters through `stepBeats`.
 */

import type { MelodicNote } from './songsterr.js';

export interface GlideGestureOptions {
  /** One grid step in quarter beats (`1 / stepsPerBeat`). Scoops and falls last exactly one step. */
  stepBeats: number;
  /** Semitones an unwritten slide starts from or goes to. Default 2 (a whole tone). */
  slideSemitones?: number;
}

export interface GlideGestureReport {
  scoops: number;
  falls: number;
  /** Notes carrying a bend envelope that were rendered. */
  bends: number;
  /** Connected notes the bend staircases ADDED beyond each bent note's own onset. */
  bend_steps: number;
  /** Bend envelopes with a point between semitones, rounded toward the unbent pitch. */
  bends_rounded: number;
  skipped: {
    /** Gestures on a chord onset (reduce the line with `monoVoice` first). */
    chord: number;
    /** A scoop with no step before its note, or a fall on a note too short to give one up. */
    no_room: number;
  };
}

/** One sampled change in a bend's rounded pitch. */
interface BendChange {
  /** Offset from the note's onset, in quarter beats, snapped to the grid. */
  at: number;
  /** Semitones from the written pitch. */
  semis: number;
}

const EPS = 1e-6;
/** Samples per note when reading a bend envelope. The envelope itself is 60 positions wide. */
const BEND_SAMPLES = 240;

/** Round to semitones with ties toward zero, so a half-step point stays on the unbent side. */
export function roundBendSemitones(v: number): number {
  const r = Math.sign(v) * Math.ceil(Math.abs(v) - 0.5 - EPS);
  return r === 0 ? 0 : r;
}

/** Semitones at `pos` (0..60) for a Songsterr bend: `tone` is hundredths of a WHOLE tone, 50 = 1 semitone. */
export function bendAt(points: readonly { position: number; tone: number }[], pos: number): number {
  const pts = [...points].sort((a, b) => a.position - b.position);
  if (pts.length === 0) return 0;
  if (pos <= pts[0].position) return pts[0].tone / 50;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (pos <= b.position) {
      const span = b.position - a.position;
      const f = span <= 0 ? 1 : (pos - a.position) / span;
      return (a.tone + (b.tone - a.tone) * f) / 50;
    }
  }
  return pts[pts.length - 1].tone / 50;
}

/**
 * Where the bend's rounded pitch changes, snapped to the grid. The first entry is always at 0.
 * `span` is what the envelope's 0..60 covers (the struck beat); `duration` is the whole held note,
 * which a tie can make longer. Past the span the final pitch simply holds.
 */
function bendChanges(points: readonly { position: number; tone: number }[], span: number, duration: number, stepBeats: number): BendChange[] {
  const changes: BendChange[] = [{ at: 0, semis: roundBendSemitones(bendAt(points, 0)) }];
  for (let i = 1; i <= BEND_SAMPLES; i++) {
    const pos = (60 * i) / BEND_SAMPLES;
    const semis = roundBendSemitones(bendAt(points, pos));
    const last = changes[changes.length - 1];
    if (semis === last.semis) continue;
    let at = Math.round(((pos / 60) * span) / stepBeats) * stepBeats;
    // The ATTACK keeps its own step: a fast bend whose rise snaps onto the onset moves to the next
    // step, or it would silently become a pre-bend. (A real pre-bend is the entry at 0 itself.)
    if (at < stepBeats - EPS) at = stepBeats;
    // A change past the last step (a release that finishes on the note's final instant) lands ON
    // the last step, so the note still comes back where the source says it ends.
    if (at > duration - stepBeats + EPS) at = duration - stepBeats;
    // A note one step long has no room for a second pitch at all.
    if (at < stepBeats - EPS) continue;
    // Two changes on the same step are one: the later value wins (a fast bend collapses to its target).
    if (Math.abs(at - last.at) < EPS || at < last.at) last.semis = semis;
    else changes.push({ at, semis });
  }
  // A collapse can leave two neighbours at the same pitch; they are one held note.
  return changes.filter((c, i) => i === 0 || c.semis !== changes[i - 1].semis);
}

/**
 * Keep ONE voice of every chord onset, for a line a mono synth will play. `voice` counts from the
 * bottom (0 = lowest); a negative value counts from the top (-1 = highest). A chord with fewer notes
 * clamps to its nearest end, so an octave pair and a triad both yield their middle-or-upper line with
 * `voice: 1`. Single notes pass through untouched.
 */
export function reduceToMonoVoice(notes: readonly MelodicNote[], voice: number): { notes: MelodicNote[]; dropped: number } {
  const byOnset = new Map<string, MelodicNote[]>();
  for (const n of notes) {
    const key = n.beat.toFixed(6);
    const g = byOnset.get(key);
    if (g === undefined) byOnset.set(key, [n]);
    else g.push(n);
  }
  const out: MelodicNote[] = [];
  let dropped = 0;
  for (const group of byOnset.values()) {
    const sorted = [...group].sort((a, b) => a.pitch - b.pitch);
    const idx = voice >= 0 ? Math.min(voice, sorted.length - 1) : Math.max(0, sorted.length + voice);
    out.push({ ...sorted[idx] });
    dropped += sorted.length - 1;
  }
  out.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  return { notes: out, dropped };
}

/**
 * Render every scoop, fall and bend as glide-connected notes. Returns the new note list, a report,
 * and the per-field APPLIED counts the caller folds into its dropped-fidelity accounting (so a bend
 * that was rendered stops reporting itself as lost).
 */
export function renderGlideGestures(
  notes: readonly MelodicNote[],
  opts: GlideGestureOptions,
): { notes: MelodicNote[]; report: GlideGestureReport; applied: Record<string, number> } {
  const step = opts.stepBeats;
  if (!(step > 0)) throw new RangeError(`stepBeats must be positive, got ${step}`);
  const semis = opts.slideSemitones ?? 2;
  const report: GlideGestureReport = { scoops: 0, falls: 0, bends: 0, bend_steps: 0, bends_rounded: 0, skipped: { chord: 0, no_room: 0 } };
  const applied: Record<string, number> = {};
  const apply = (key: string): void => { applied[key] = (applied[key] ?? 0) + 1; };

  const sorted = [...notes].sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  const perOnset = new Map<string, number>();
  for (const n of sorted) perOnset.set(n.beat.toFixed(6), (perOnset.get(n.beat.toFixed(6)) ?? 0) + 1);

  const out: MelodicNote[] = [];
  for (const n of sorted) {
    const bent = n.bend !== undefined && n.bend.some((p) => p.tone !== 0);
    if (n.slideIn === undefined && n.slideOut === undefined && !bent) { out.push({ ...n }); continue; }
    if ((perOnset.get(n.beat.toFixed(6)) ?? 0) > 1) { report.skipped.chord++; out.push({ ...n }); continue; }
    const slidesBefore = report.scoops + report.falls;

    // ── body: the written note, split into a staircase where it bends ──
    const { slideIn, slideOut, bend } = n;
    // The rendered notes carry the written note's dynamics and articulation, never the gesture fields
    // this pass has just consumed (a second pass must not render them again).
    const rest: MelodicNote = { ...n };
    delete rest.slideIn;
    delete rest.slideOut;
    delete rest.slideKind;
    delete rest.bend;
    delete rest.bendBeats;
    delete rest.gesture;
    let body: MelodicNote[] = [{ ...rest }];
    if (bent && bend !== undefined) {
      const changes = bendChanges(bend, Math.min(n.bendBeats ?? n.durationBeats, n.durationBeats), n.durationBeats, step);
      if (bend.some((p) => Math.abs(p.tone / 50 - Math.round(p.tone / 50)) > EPS)) report.bends_rounded++;
      body = changes.map((c, i) => {
        const end = i + 1 < changes.length ? changes[i + 1].at : n.durationBeats;
        return i === 0
          ? { ...rest, pitch: n.pitch + c.semis, durationBeats: end - c.at }
          : { beat: n.beat + c.at, pitch: n.pitch + c.semis, durationBeats: end - c.at, gesture: 'bend' as const, ...(n.velocity !== undefined ? { velocity: n.velocity } : {}) };
      });
      report.bends++;
      report.bend_steps += body.length - 1;
      apply('note.bend');
    }

    // ── fall: the last step slides off to an unwritten pitch ──
    if (slideOut !== undefined) {
      const last = body[body.length - 1];
      if (last.durationBeats >= 2 * step - EPS) {
        last.durationBeats -= step;
        body.push({
          beat: last.beat + last.durationBeats, pitch: last.pitch + (slideOut === 'down' ? -semis : semis),
          durationBeats: step, gesture: 'fall', ...(n.velocity !== undefined ? { velocity: n.velocity } : {}),
        });
        report.falls++;
      } else {
        report.skipped.no_room++;
      }
    }

    // ── scoop: a grace on the step before, gliding into the note ──
    let grace: MelodicNote | undefined;
    if (slideIn !== undefined) {
      const at = n.beat - step;
      const pitch = body[0].pitch + (slideIn === 'below' ? -semis : semis);
      const prev = out[out.length - 1];
      if (at < -EPS) {
        report.skipped.no_room++;
      } else if (prev !== undefined && Math.abs(prev.beat - at) < EPS) {
        // The previous note already owns that step. A fall there IS the scoop's launch: one note, and
        // the arrival pitch wins. Anything else there is a written note, which a scoop must not eat.
        if (prev.gesture === 'fall' || prev.gesture === 'scoop') {
          prev.pitch = pitch;
          prev.gesture = 'scoop';
          prev.legato = 'glide';
          report.scoops++;
        } else {
          report.skipped.no_room++;
        }
      } else if (prev !== undefined && prev.beat > at) {
        report.skipped.no_room++;
      } else {
        if (prev !== undefined && prev.beat + prev.durationBeats > at + EPS) prev.durationBeats = at - prev.beat;
        grace = {
          beat: at, pitch, durationBeats: step, legato: 'glide', gesture: 'scoop',
          ...(n.velocity !== undefined ? { velocity: n.velocity } : {}),
        };
        report.scoops++;
      }
    }

    // Every note of the gesture but the last glides into the next; the last keeps whatever the source
    // said about the following written note (a legato slide to it, or nothing).
    body.forEach((b, i) => {
      if (i < body.length - 1) b.legato = 'glide';
      else if (n.legato !== undefined) b.legato = n.legato;
      else delete b.legato;
    });
    if (grace !== undefined) out.push(grace);
    out.push(...body);
    if (n.slideKind !== undefined && report.scoops + report.falls > slidesBefore) apply(`note.slide=${n.slideKind}`);
  }
  out.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  return { notes: out, report, applied };
}

/** One line for the import receipt. */
export function describeGlideGestures(r: GlideGestureReport, semis: number): string {
  const skipped = r.skipped.chord + r.skipped.no_room;
  return `pitchGestures:"glide" rendered ${r.bends} bend(s) as ${r.bends + r.bend_steps} glide-connected note(s)`
    + `${r.bends_rounded > 0 ? ` (${r.bends_rounded} rounded toward the unbent pitch)` : ''}, ${r.scoops} scoop(s) and ${r.falls} fall(s) `
    + `at ${semis} semitone(s). Every inserted note OVERLAPS its neighbour, so a mono synth with Envelope Legato on and glide set `
    + 'plays each as one continuous sweep; on a synth that does not glide they are audible grace notes.'
    + (skipped > 0
      ? ` ${skipped} gesture(s) skipped (${r.skipped.chord} on a chord onset: pass monoVoice to pick one line; `
        + `${r.skipped.no_room} with no step to give up).`
      : '');
}
