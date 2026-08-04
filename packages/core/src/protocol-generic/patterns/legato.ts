/**
 * Legato welding for MIDI-note streams that act as a PITCH TARGET rather than
 * as something to be heard.
 *
 * ## Why this exists
 *
 * A MIDI-driven pitch corrector (the Boss VE-500's `M>PCR`, Antares Auto-Tune's
 * Target Notes, Waves Tune's Target Pitch) uses an incoming note to say "make
 * the singer's voice THIS pitch". They share a documented behaviour that is a
 * trap here: **when no note is held, correction falls back to none**, so the
 * singer's raw, uncorrected voice passes through in every gap.
 *
 * The pattern compiler gives every step a 90 percent gate (`compile.ts`: long
 * enough to sound, short enough not to overhang the next hit). That is right for
 * something you LISTEN to and wrong for something you AIM with: it opens a
 * ten-percent hole under every step, and across a chorus that is a continuous
 * flutter of in-tune, out-of-tune, in-tune. It does not read as a bug, it reads
 * as "the pitch correction is broken", which is the single most likely reason a
 * first attempt at this feature gets abandoned.
 *
 * Antares documented the fix in 1998 and it has not changed: author the target
 * melody FULLY LEGATO so a note is always held.
 *
 * ## What "legato" means here, precisely
 *
 * Each onset is extended so it ends exactly when the next onset on the same
 * channel begins. Not overlapped, ABUTTED. Zero elapsed time between note-off
 * and the next note-on leaves no window for the fallback, and
 * `buildSequenceTimeline` already emits note-off before note-on at an equal
 * timestamp, so the handover is clean and the corrector never sees an idle
 * moment.
 *
 * Overlapping instead (`overlap_ms > 0`) is offered but NOT the default,
 * deliberately. Whether a device treats an overlap as "new target wins" or lets
 * the older note's note-off cut the newer one is note-priority behaviour that no
 * manual on hand documents, so it is a knob to test with, not a default to
 * assume. Abutment needs no such assumption.
 *
 * ## What it deliberately does NOT do
 *
 * It never merges REPEATED notes of the same pitch into one long note. Two
 * quarter notes on the same pitch must stay two note-ons: welding them would
 * silently rewrite the rhythm, and for a target melody the re-articulation is
 * what tells the corrector a new syllable started.
 *
 * It is also per-channel. A vocal-target melody sharing a stream with drums and
 * bass must not have the drum lane welded into a drone.
 */

import type { RealizeNoteEvent } from '../types.js';

export interface LegatoOptions {
  /**
   * Only weld events on these MIDI channels (1..16). Omit to weld every
   * channel present, which is almost never what you want on a mixed stream:
   * pass the vocal-target channel explicitly.
   */
  channels?: readonly number[];
  /**
   * Extra milliseconds each note is held PAST the next onset. Default 0, which
   * is exact abutment. See the module docstring for why overlapping is not the
   * default.
   */
  overlap_ms?: number;
  /**
   * How long the FINAL note of each channel is held, in ms. Omit to leave its
   * compiled duration untouched, which is usually right: the melody should stop
   * when it stops, and holding the last note pins the singer to a pitch after
   * the phrase is over.
   */
  tail_ms?: number;
}

/** One channel's notes, and what the weld did to them. */
export interface LegatoReport {
  channel: number;
  /** Distinct onsets welded on this channel. */
  onsets: number;
  /** Onsets whose duration GREW (the gaps that would have leaked raw voice). */
  extended: number;
  /** Onsets whose duration SHRANK because they overhung the next onset. */
  shortened: number;
  /** Total milliseconds of gap removed. This is the leak that would have been audible. */
  gap_removed_ms: number;
}

export interface LegatoResult {
  events: readonly RealizeNoteEvent[];
  reports: readonly LegatoReport[];
}

/**
 * Weld a pattern's note events into a continuous pitch-target line.
 *
 * Pure: returns new event objects, never mutates the input. Events on channels
 * outside `channels` pass through byte-identical.
 */
export function applyLegato(
  events: readonly RealizeNoteEvent[],
  opts: LegatoOptions = {},
): LegatoResult {
  const overlap = Math.max(0, Math.round(opts.overlap_ms ?? 0));
  const wanted = opts.channels === undefined ? undefined : new Set(opts.channels);

  const byChannel = new Map<number, RealizeNoteEvent[]>();
  const untouched: RealizeNoteEvent[] = [];
  for (const e of events) {
    if (wanted !== undefined && !wanted.has(e.channel)) {
      untouched.push(e);
      continue;
    }
    const bucket = byChannel.get(e.channel);
    if (bucket === undefined) byChannel.set(e.channel, [e]);
    else bucket.push(e);
  }

  const out: RealizeNoteEvent[] = [...untouched];
  const reports: LegatoReport[] = [];

  for (const [channel, chanEvents] of byChannel) {
    // Group by ONSET, not by note. Simultaneous notes are a chord and must all
    // extend to the same next onset, or a chord's inner voices develop gaps the
    // outer one does not have.
    const onsets = [...new Set(chanEvents.map((e) => e.time_ms))].sort((a, b) => a - b);
    const atOnset = new Map<number, RealizeNoteEvent[]>();
    for (const e of chanEvents) {
      const bucket = atOnset.get(e.time_ms);
      if (bucket === undefined) atOnset.set(e.time_ms, [e]);
      else bucket.push(e);
    }

    let extended = 0;
    let shortened = 0;
    let gapRemoved = 0;

    for (let i = 0; i < onsets.length; i++) {
      const t = onsets[i];
      const group = atOnset.get(t)!;
      const isLast = i === onsets.length - 1;

      if (isLast) {
        for (const e of group) {
          out.push(opts.tail_ms === undefined ? { ...e } : { ...e, duration_ms: Math.max(1, Math.round(opts.tail_ms)) });
        }
        continue;
      }

      const span = onsets[i + 1] - t;
      const target = Math.max(1, span + overlap);
      for (const e of group) {
        const before = e.duration_ms ?? 0;
        // Measure the leak against the SPAN, not against the new duration: with
        // an overlap the note ends past the next onset, and counting that as
        // extra gap-removed would overstate what was actually leaking.
        const gap = Math.max(0, span - before);
        if (gap > 0) gapRemoved += gap;
        if (target > before) extended++;
        else if (target < before) shortened++;
        out.push({ ...e, duration_ms: target });
      }
    }

    reports.push({ channel, onsets: onsets.length, extended, shortened, gap_removed_ms: gapRemoved });
  }

  // Restore a deterministic order: by time, then channel, then note. Callers
  // and goldens both depend on a stable sequence.
  out.sort((a, b) => a.time_ms - b.time_ms || a.channel - b.channel || a.note - b.note);
  reports.sort((a, b) => a.channel - b.channel);
  return { events: out, reports };
}

/**
 * Does this event stream still contain a gap on `channel`, i.e. a moment with
 * no note held between the first and last onset?
 *
 * The verification counterpart to `applyLegato`, and the thing worth asserting
 * in a test: a melody that passes this cannot leak an uncorrected voice mid
 * phrase, whatever route it took to get here.
 */
export function findPitchTargetGaps(
  events: readonly RealizeNoteEvent[],
  channel: number,
): ReadonlyArray<{ from_ms: number; to_ms: number }> {
  const chan = events.filter((e) => e.channel === channel).sort((a, b) => a.time_ms - b.time_ms);
  if (chan.length === 0) return [];
  const gaps: Array<{ from_ms: number; to_ms: number }> = [];
  // Sweep by onset: the phrase is covered while SOME note is still sounding.
  let heldUntil = chan[0].time_ms + (chan[0].duration_ms ?? 0);
  for (const e of chan.slice(1)) {
    if (e.time_ms > heldUntil) gaps.push({ from_ms: heldUntil, to_ms: e.time_ms });
    heldUntil = Math.max(heldUntil, e.time_ms + (e.duration_ms ?? 0));
  }
  return gaps;
}
