/**
 * Standard MIDI File (.mid) → drum step-grid importer.
 *
 * The FREE, ubiquitous, agent-friendly source for "play any song": a `.mid` file
 * the user downloads (free MIDI sites serve real files, not JS-rendered tabs).
 * Its drum track is MIDI channel 10 (0-indexed 9) carrying General-MIDI
 * percussion notes + tick timing, which is exactly what `drumScore` consumes.
 *
 * SMF is a simple, open, well-documented binary format, so this parser is
 * DEPENDENCY-FREE (no zip/xml libs, unlike Guitar Pro). We read only what we
 * need: the division (ticks/beat), every note-on with its channel + absolute
 * tick, and the note-OFF that closes it (a `.mid` is the only import source that
 * states an exact note length, so the pairing is worth doing). Meta/SysEx events
 * are length-skipped; running status is honored.
 */

import type { Step } from './types.js';
import {
  GATE_SIXTHS_PER_STEP,
  MAX_GATE_SIXTHS,
  gateSixthsFromSteps,
} from './types.js';
import { gmDrumToVoice, quantizeDrumEvents, type DrumEvent, type QuantizedDrums } from './drumScore.js';

const DRUM_CHANNEL = 9; // 0-indexed; MIDI channel 10

export interface MidiNote {
  tick: number;     // absolute tick from song start
  channel: number;  // 0..15
  note: number;     // 0..127
  velocity: number; // 1..127 (note-on; velocity 0 is treated as note-off and dropped)
  /**
   * Ticks from this note-on to the note-off that closed it. Undefined = the
   * file never closed it (a truncated or malformed track), which is NOT the
   * same as zero: a caller must fall back to its own default length rather
   * than reading an unclosed note as a staccato.
   */
  durationTicks?: number;
}

export interface ParsedMidi {
  ticksPerBeat: number;
  notes: MidiNote[];
}

/** Read a variable-length quantity; returns [value, nextPos]. */
function readVlq(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let p = pos;
  for (let i = 0; i < 4; i++) {
    const b = buf[p++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return [value, p];
}

/**
 * Close the earliest still-open note-on for this (channel, note) at `tick`.
 *
 * FIFO, so a `.mid` that re-strikes a pitch before releasing the first one
 * (legal, and common in guitar-tab exports) pairs each off with the oldest
 * open on. That is the only pairing order that keeps every duration positive.
 * An off with nothing open is ignored: real files emit those.
 */
function closeNote(open: Map<number, MidiNote[]>, channel: number, note: number, tick: number): void {
  const first = open.get((channel << 8) | note)?.shift();
  if (first === undefined) return;
  first.durationTicks = Math.max(0, tick - first.tick);
}

const u16 = (b: Uint8Array, p: number): number => (b[p] << 8) | b[p + 1];
const u32 = (b: Uint8Array, p: number): number => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const tag = (b: Uint8Array, p: number): string => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/**
 * Parse a Standard MIDI File into its division + a flat, time-ordered note list.
 * Throws on a malformed header. SMPTE-division files (negative division) are
 * rejected: drum import assumes ticks-per-beat timing.
 */
export function parseMidiFile(bytes: Uint8Array): ParsedMidi {
  if (bytes.length < 14 || tag(bytes, 0) !== 'MThd') {
    throw new Error('Not a Standard MIDI File (missing MThd header).');
  }
  const division = u16(bytes, 12);
  if (division & 0x8000) {
    throw new Error('SMPTE-timed MIDI file is not supported (need ticks-per-beat division).');
  }
  const ticksPerBeat = division;
  const ntrks = u16(bytes, 10);
  const notes: MidiNote[] = [];

  let pos = 14;
  for (let t = 0; t < ntrks && pos + 8 <= bytes.length; t++) {
    if (tag(bytes, pos) !== 'MTrk') break;
    const len = u32(bytes, pos + 4);
    const end = pos + 8 + len;
    let p = pos + 8;
    let tick = 0;
    let runningStatus = 0;
    // Open note-ons awaiting their off, keyed (channel << 8 | note). Per TRACK:
    // a multi-track file can carry the same channel + pitch on two tracks, and
    // pairing across them would cross the wires.
    const open = new Map<number, MidiNote[]>();
    while (p < end && p < bytes.length) {
      const [delta, np] = readVlq(bytes, p);
      p = np;
      tick += delta;
      let status = bytes[p];
      if (status & 0x80) { p++; runningStatus = status; } else { status = runningStatus; } // running status
      const type = status & 0xf0;
      const channel = status & 0x0f;
      if (status === 0xff) {            // meta event: FF type len data
        p++; // type
        const [mlen, mp] = readVlq(bytes, p);
        p = mp + mlen;
      } else if (status === 0xf0 || status === 0xf7) { // SysEx: len data
        const [slen, sp] = readVlq(bytes, p);
        p = sp + slen;
      } else if (type === 0x90) {        // note on (velocity 0 IS a note off)
        const note = bytes[p++]; const vel = bytes[p++];
        if (vel > 0) {
          const ev: MidiNote = { tick, channel, note, velocity: vel };
          notes.push(ev);
          const key = (channel << 8) | note;
          const q = open.get(key);
          if (q === undefined) open.set(key, [ev]); else q.push(ev);
        } else {
          closeNote(open, channel, note, tick);
        }
      } else if (type === 0x80) {        // note off: note, release velocity
        const note = bytes[p++]; p++;
        closeNote(open, channel, note, tick);
      } else if (type === 0xc0 || type === 0xd0) {
        p += 1;                          // program change / channel pressure: 1 data byte
      } else {                           // 0xA0/0xB0/0xE0: 2 data bytes
        p += 2;
      }
    }
    pos = end;
  }
  notes.sort((a, b) => a.tick - b.tick);
  return { ticksPerBeat, notes };
}

export interface MidiDrumImportOptions {
  /** First beat of the window to extract (0-based). Default 0. */
  fromBeat?: number;
  /** Window length in beats. Default: the whole drum track. */
  beats?: number;
  /** Grid resolution (steps per beat). 4 = 16ths (default), 8 = 32nds. */
  stepsPerBeat?: number;
  /**
   * 1-based MIDI channel holding the drums. Default 10 (the GM convention).
   * Drum-library groove packs often sequence their kit on another channel
   * entirely (the Mixwave Sleep Token II pack uses 16).
   */
  channel?: number;
  /**
   * Per-source percussion remap: note number → neutral voice name ("clap") or
   * GM number (39), applied before the GM lookup. Required for non-GM key maps
   * (drum-library groove packs); unmapped numbers are reported by number.
   */
  drumMap?: Readonly<Record<number, string | number>>;
}

export interface MidiDrumImport extends QuantizedDrums {
  /** Total beats of drum content found in the file (so a caller can window it). */
  total_beats: number;
  /** WHICH note numbers went unmapped, with hit counts: what a drumMap needs to cover. */
  unmapped_numbers: Record<number, number>;
}

/**
 * Extract the drum track (channel 10, or `channel`) from a parsed MIDI file and
 * quantize a window of it onto a step grid. Velocity ≥ 100 → accent, ≤ 40 →
 * ghost. Note numbers no map covers are counted BY NUMBER in
 * `unmapped_numbers` + a warning, never dropped silently.
 */
export function importMidiDrums(bytes: Uint8Array, opts: MidiDrumImportOptions = {}): MidiDrumImport {
  const parsed = parseMidiFile(bytes);
  const tpb = parsed.ticksPerBeat || 480;
  const wireCh = opts.channel !== undefined ? opts.channel - 1 : DRUM_CHANNEL;
  const drumNotes = parsed.notes.filter((n) => n.channel === wireCh);
  const lastBeat = drumNotes.length > 0 ? drumNotes[drumNotes.length - 1].tick / tpb : 0;
  const total_beats = Math.ceil(lastBeat + 0.001);

  const fromBeat = opts.fromBeat ?? 0;
  const beats = opts.beats ?? Math.max(1, total_beats - fromBeat);
  const stepsPerBeat = opts.stepsPerBeat ?? 4;

  const events: DrumEvent[] = [];
  let unmapped = 0;
  const unmappedNumbers: Record<number, number> = {};
  for (const n of drumNotes) {
    const beat = n.tick / tpb - fromBeat;
    if (beat < 0 || beat >= beats) continue;
    const remap = opts.drumMap?.[n.note];
    const voice = typeof remap === 'string' ? remap : gmDrumToVoice(typeof remap === 'number' ? remap : n.note);
    if (voice === undefined) {
      unmapped++;
      unmappedNumbers[n.note] = (unmappedNumbers[n.note] ?? 0) + 1;
      continue;
    }
    events.push({
      voice, beat,
      ...(n.velocity >= 100 ? { accent: true } : {}),
      ...(n.velocity <= 40 ? { ghost: true } : {}),
    });
  }

  const q = quantizeDrumEvents(events, { beats, stepsPerBeat });
  if (drumNotes.length === 0) {
    const have = midiChannelSummary(bytes).map((c) => `ch${c.channel}: ${c.notes} notes`).join('; ');
    q.warnings.push(`No notes on MIDI channel ${wireCh + 1}. Channels in this file: ${have || '(none)'}. Pass \`channel\` to pick the drum channel.`);
  }
  if (unmapped > 0) {
    const list = Object.entries(unmappedNumbers).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(', ');
    q.warnings.push(`${unmapped} drum note(s) on unmapped number(s) [${list}] were skipped. Pass drumMap (number → voice name or GM number) to place them; a non-GM key map needs one.`);
  }
  return { ...q, total_beats, unmapped_numbers: unmappedNumbers };
}

// ── Melodic (non-drum) import ─────────────────────────────────────────

/** One channel's inventory, for picking bass/chords/lead conversationally. */
export interface MidiChannelInfo {
  /** 1-based MIDI channel (musician-facing). */
  channel: number;
  notes: number;
  /** Lowest / highest pitch, scientific (middle C = C4). */
  low: string;
  high: string;
  /** Max simultaneous notes (same tick): 1 = monophonic line, 3+ = chords. */
  poly: number;
  drum: boolean;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const pitchName = (n: number): string => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/**
 * Per-channel inventory of a MIDI file, so the agent (or user) can pick which
 * channel is the bassline / chords / lead before importing it. Heuristics the
 * caller can lean on: the lowest average-pitch melodic channel is usually the
 * bass; poly >= 3 suggests chords.
 */
export function midiChannelSummary(bytes: Uint8Array): MidiChannelInfo[] {
  const parsed = parseMidiFile(bytes);
  const byCh = new Map<number, MidiNote[]>();
  for (const n of parsed.notes) {
    let arr = byCh.get(n.channel);
    if (!arr) { arr = []; byCh.set(n.channel, arr); }
    arr.push(n);
  }
  const out: MidiChannelInfo[] = [];
  for (const [ch, notes] of [...byCh.entries()].sort((a, b) => a[0] - b[0])) {
    let low = 127, high = 0, poly = 1;
    let runTick = -1, runCount = 0;
    for (const n of notes) {
      if (n.note < low) low = n.note;
      if (n.note > high) high = n.note;
      if (n.tick === runTick) { runCount++; if (runCount > poly) poly = runCount; }
      else { runTick = n.tick; runCount = 1; }
    }
    out.push({ channel: ch + 1, notes: notes.length, low: pitchName(low), high: pitchName(high), poly, drum: ch === DRUM_CHANNEL });
  }
  return out;
}

export interface MidiMelodicImportOptions {
  /** 1-based MIDI channel to import (as shown by midiChannelSummary). */
  channel: number;
  /** First beat of the window (0-based). Default 0. */
  fromBeat?: number;
  /** Window length in beats. Default: to the channel's last note. */
  beats?: number;
  /** Grid resolution (steps per beat). 4 = 16ths (default), 8 = 32nds. */
  stepsPerBeat?: number;
  /**
   * Import each note's LENGTH from its note-off, onto `Step.gate_sixths`, plus
   * a `Step.tie` where the source sustains through the next onset. Default
   * TRUE: a `.mid` states an exact note length, which is the best duration
   * evidence any import path here has, and discarding it is what turns an
   * imported pad into a one-step blip on whatever synth receives it.
   *
   * Pass `false` for the pre-duration behaviour (every step takes the target's
   * one-step default). Two callers want that: one whose source lengths are
   * unusable (every note a full bar), and one re-authoring over a template
   * whose hand-dialled gates should survive, since a length the PATTERN states
   * outranks the template's at the device boundary.
   */
  noteLengths?: boolean;
}

/**
 * What the step grid could not hold exactly about the source's note lengths.
 * Counted and named rather than snapped silently, the same contract the
 * Songsterr importer keeps for the things IT cannot represent.
 */
export interface MidiDurationReport {
  /** Steps whose length came from the source's note-off rather than the default. */
  imported: number;
  /** Lengths that did not land on a whole sixth of a step and went to the nearest one. */
  rounded: number;
  /** Lengths past the 16-step ceiling the gate field holds, capped there. */
  capped_long: number;
  /** Lengths under one sixth of a step, raised to it (the shortest the grid holds). */
  capped_short: number;
  /** Note-ons the file never closed; those steps took the default length. */
  unclosed: number;
  /** Steps given a tie-forward: the source holds the same pitch through the next onset. */
  tied: number;
  /** Notes still sounding when this voice's next onset fires, and NOT tied (source overlap). */
  overlapping: number;
  /** Chord steps whose notes had different lengths; the step took the longest. */
  uneven_chords: number;
}

export interface MidiMelodicImport {
  /** The voice's step row: pitched steps (chords grouped, capped at 6 notes). */
  steps: Step[];
  step_count: number;
  warnings: string[];
  total_beats: number;
  /** What the note-length import had to round, cap or leave behind. */
  duration_report: MidiDurationReport;
}

/** One source note-on placed on the grid, with its real (unquantized) extent in STEPS. */
interface PlacedNote {
  note: number;
  velocity: number;
  /** Real onset, in steps from the window start (fractional: this is pre-quantization). */
  onset: number;
  /** Real release, same unit. Undefined = the file never closed this note. */
  end?: number;
}

/** One sixth of a step, expressed in steps: the finest note length the grid holds. */
const SIXTH_OF_A_STEP = 1 / GATE_SIXTHS_PER_STEP;

/**
 * How far past the voice's next onset a note must still be sounding before the
 * import reads it as a TIE rather than as legato: one full step.
 *
 * A tie tells the device NOT to re-strike at the next onset, so inferring one
 * DELETES an attack the source has. The two errors are not symmetric: a missed
 * tie leaves an extra attack the user can hear and fix (author `_`, or set it
 * on the device), while a false tie melts a repeated-root bassline into one
 * drone. So the bar is a whole grid step of overlap, which is past anything a
 * player produces by holding a note a shade long, and the same pitch has to be
 * struck again at that onset (the device drops any other tie anyway: its rule
 * is gate lands exactly on the next onset AND that onset carries the note).
 */
const TIE_OVERLAP_STEPS = 1;

/**
 * Derive ONE step's note length (and tie) from the source note-offs behind it.
 *
 * Magnitude is the note's OWN sounding length (release minus its own onset),
 * not the distance from the quantized step to the release: onset quantization
 * has already moved the attack, and folding that error into the length too can
 * hand back a zero or negative duration that is pure artifact. Chord steps hold
 * ONE length, so a step whose notes differ takes the LONGEST, since stretching
 * a short note is a smaller lie than truncating a held one, and that truncation
 * is the exact failure ("the pad became a blip") this path exists to stop.
 */
function lengthOfCell(
  cell: readonly PlacedNote[],
  next: readonly PlacedNote[] | undefined,
  distance: number,
  report: MidiDurationReport,
): { gate_sixths?: number; tie?: boolean } {
  const lengths = cell.flatMap((p) => (p.end === undefined ? [] : [p.end - p.onset]));
  report.unclosed += cell.length - lengths.length;
  if (lengths.length === 0) return {};
  const longest = Math.max(...lengths);
  if (longest - Math.min(...lengths) > SIXTH_OF_A_STEP) report.uneven_chords++;

  if (next !== undefined) {
    const nextOnset = Math.min(...next.map((p) => p.onset));
    // -Infinity for an unclosed note, so a chord holding one blocks the tie.
    const ends = cell.map((p) => p.end ?? -Infinity);
    const reach = distance * GATE_SIXTHS_PER_STEP;
    const heldThrough = Math.min(...ends) >= nextOnset + TIE_OVERLAP_STEPS;
    const sameNotes = cell.every((p) => next.some((q) => q.note === p.note));
    if (heldThrough && sameNotes && reach <= MAX_GATE_SIXTHS) {
      // A tie's gate has to END on the onset it ties into (device rule), so the
      // reaching distance replaces the measured length. Exact by construction:
      // a whole number of steps is a whole number of sixths, nothing to round.
      report.tied++;
      report.imported++;
      return { gate_sixths: reach, tie: true };
    }
    if (Math.max(...ends) > nextOnset + SIXTH_OF_A_STEP) report.overlapping++;
  }

  const fitted = gateSixthsFromSteps(longest);
  report.imported++;
  if (fitted.rounded) report.rounded++;
  if (fitted.clamped) {
    if (longest * GATE_SIXTHS_PER_STEP > MAX_GATE_SIXTHS) report.capped_long++;
    else report.capped_short++;
  }
  return { gate_sixths: fitted.gate_sixths };
}

/**
 * Import ONE melodic channel of a MIDI file as a pitched step row: note-ons
 * quantize onto the grid; same-step notes group into a chord (capped at 6, the
 * Circuit note-slot limit); velocity is carried (loudest of the chord). Off-grid
 * onsets round + warn, mirroring the drum importer.
 *
 * NOTE LENGTHS come across too (`noteLengths`, default on). Each note's own
 * note-off gives its real duration; that goes onto `Step.gate_sixths` through
 * `gateSixthsFromSteps`, which rounds to the nearest sixth of a step and caps at
 * the 16-step ceiling. Both are lossy in a way onset quantization is not, so
 * every rounding, cap, unclosed note, uneven chord and un-representable overlap
 * is COUNTED in `duration_report` and named in `warnings` rather than snapped
 * out of sight. A step whose pitches are still sounding a full step after the
 * voice's next onset re-strikes them gets `Step.tie` and a gate that lands
 * exactly on that onset (see TIE_OVERLAP_STEPS for why the bar is that high).
 */
export function importMidiMelodic(bytes: Uint8Array, opts: MidiMelodicImportOptions): MidiMelodicImport {
  const parsed = parseMidiFile(bytes);
  const tpb = parsed.ticksPerBeat || 480;
  const ch = opts.channel - 1;
  if (!Number.isInteger(opts.channel) || opts.channel < 1 || opts.channel > 16) {
    throw new Error(`channel must be 1..16, got ${opts.channel}`);
  }
  const chNotes = parsed.notes.filter((n) => n.channel === ch);
  if (chNotes.length === 0) {
    const have = midiChannelSummary(bytes).map((c) => `ch${c.channel}${c.drum ? ' (drums)' : ''}: ${c.notes} notes ${c.low}-${c.high}${c.poly > 2 ? ' (chords)' : ''}`);
    throw new Error(`No notes on MIDI channel ${opts.channel}. Channels in this file: ${have.join('; ') || '(none)'}.`);
  }
  const lastBeat = chNotes[chNotes.length - 1].tick / tpb;
  const total_beats = Math.ceil(lastBeat + 0.001);
  const fromBeat = opts.fromBeat ?? 0;
  const beats = opts.beats ?? Math.max(1, total_beats - fromBeat);
  const spb = opts.stepsPerBeat ?? 4;
  const stepCount = Math.max(1, Math.round(beats * spb));

  const withLengths = opts.noteLengths ?? true;

  // Pass 1: place every note-on in its grid cell, keeping the REAL onset and
  // release alongside, since the length + tie decisions need pre-quantization
  // time and the cell index alone has thrown that away.
  const cells: PlacedNote[][] = Array.from({ length: stepCount }, () => []);
  const warnings: string[] = [];
  const offGrid = new Set<string>();
  let chordOverflow = 0;
  let dropped = 0;
  for (const n of chNotes) {
    const beat = n.tick / tpb - fromBeat;
    const exact = beat * spb;
    const step = Math.round(exact);
    if (Math.abs(exact - step) > 0.02 * spb) offGrid.add(beat.toFixed(3));
    if (step < 0 || step >= stepCount) { dropped++; continue; }
    const cell = cells[step];
    const end = n.durationTicks === undefined ? undefined : exact + (n.durationTicks / tpb) * spb;
    const already = cell.find((p) => p.note === n.note);
    if (already !== undefined) {
      // One pitch struck twice inside one step: the cell holds it once, so keep
      // the LONGER of the two rather than losing the second note's length too.
      if (end !== undefined && (already.end === undefined || end > already.end)) already.end = end;
      continue;
    }
    if (cell.length >= 6) { chordOverflow++; continue; }
    cell.push({ note: n.note, velocity: n.velocity, onset: exact, end });
  }

  // Pass 2: the onset list, so a step's length + tie can see the NEXT onset.
  const onsets: number[] = [];
  for (let i = 0; i < stepCount; i++) if (cells[i].length > 0) onsets.push(i);

  const duration_report: MidiDurationReport = {
    imported: 0, rounded: 0, capped_long: 0, capped_short: 0,
    unclosed: 0, tied: 0, overlapping: 0, uneven_chords: 0,
  };
  const steps: Step[] = Array.from({ length: stepCount }, () => ({ on: false } as Step));
  for (let k = 0; k < onsets.length; k++) {
    const at = onsets[k];
    const cell = cells[at];
    const pitches = cell.map((p) => p.note).sort((a, b) => a - b);
    const step: Step = {
      on: true,
      notes: pitches.length === 1 ? pitches[0] : pitches,
      velocity: cell.reduce((hi, p) => Math.max(hi, p.velocity), 0),
    };
    if (withLengths) {
      const nextAt = onsets[k + 1];
      const { gate_sixths, tie } = lengthOfCell(
        cell,
        nextAt === undefined ? undefined : cells[nextAt],
        nextAt === undefined ? 0 : nextAt - at,
        duration_report,
      );
      if (gate_sixths !== undefined) step.gate_sixths = gate_sixths;
      if (tie) step.tie = true;
    }
    steps[at] = step;
  }

  if (offGrid.size > 0) warnings.push(`${offGrid.size} off-grid onset(s) rounded to the grid (triplets / 32nds are approximate).`);
  if (chordOverflow > 0) warnings.push(`${chordOverflow} note(s) dropped from chords past the 6-note step limit.`);
  if (dropped > 0) warnings.push(`${dropped} note(s) fell outside the ${stepCount}-step window.`);
  warnings.push(...describeDurationReport(duration_report));
  return { steps, step_count: stepCount, warnings, total_beats, duration_report };
}

/**
 * Turn the note-length report into the warnings a caller reads. One line per
 * KIND of loss, each naming what was changed and why, so a user can contest the
 * policy instead of discovering a shortened pad by ear three songs later.
 */
function describeDurationReport(r: MidiDurationReport): string[] {
  const out: string[] = [];
  const maxSteps = MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP;
  if (r.rounded > 0) {
    out.push(`${r.rounded} note length(s) did not land on a whole sixth of a step and were rounded to the nearest one (triplet and swung releases are approximate).`);
  }
  if (r.capped_long > 0) {
    out.push(`${r.capped_long} note(s) were longer than the ${maxSteps}-step maximum a note length can state and were capped there.`);
  }
  if (r.capped_short > 0) {
    out.push(`${r.capped_short} note(s) were shorter than one sixth of a step and were lengthened to it (the shortest the grid holds).`);
  }
  if (r.unclosed > 0) {
    out.push(`${r.unclosed} note(s) had no note-off in the file; those steps took the default one-step length.`);
  }
  if (r.uneven_chords > 0) {
    out.push(`${r.uneven_chords} chord step(s) held notes of different lengths; each took its longest note's length, since one step states one length.`);
  }
  if (r.overlapping > 0) {
    out.push(`${r.overlapping} note(s) are still sounding when this voice's next note starts. Their full length was kept, so a monophonic target will cut them short.`);
  }
  if (r.tied > 0) {
    out.push(`${r.tied} step(s) were tied forward: the source holds the same pitch a full step past the next onset, so the note is held instead of re-struck there.`);
  }
  return out;
}

/** Render a QuantizedDrums to the per-voice char grid (for display / re-feeding the tab path). */
export function quantizedToGrids(q: QuantizedDrums): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [voice, steps] of Object.entries(q.voices)) {
    out[voice] = steps.map((s: Step) => (s.on ? (s.accent ? 'X' : s.roll === 6 ? '6' : 'x') : '.')).join('');
  }
  return out;
}
