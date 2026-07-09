/**
 * Standard MIDI File (.mid) → drum step-grid importer.
 *
 * The FREE, ubiquitous, agent-friendly source for "play any song": a `.mid` file
 * the user downloads (free MIDI sites serve real files, not JS-rendered tabs).
 * Its drum track is MIDI channel 10 (0-indexed 9) carrying General-MIDI
 * percussion notes + tick timing — which is exactly what `drumScore` consumes.
 *
 * SMF is a simple, open, well-documented binary format, so this parser is
 * DEPENDENCY-FREE (no zip/xml libs, unlike Guitar Pro). We read only what we
 * need: the division (ticks/beat), and every note-on with its channel + absolute
 * tick. Meta/SysEx events are length-skipped; running status is honored.
 */

import type { Step } from './types.js';
import { gmDrumToVoice, quantizeDrumEvents, type DrumEvent, type QuantizedDrums } from './drumScore.js';

const DRUM_CHANNEL = 9; // 0-indexed; MIDI channel 10

export interface MidiNote {
  tick: number;     // absolute tick from song start
  channel: number;  // 0..15
  note: number;     // 0..127
  velocity: number; // 1..127 (note-on; velocity 0 is treated as note-off and dropped)
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

const u16 = (b: Uint8Array, p: number): number => (b[p] << 8) | b[p + 1];
const u32 = (b: Uint8Array, p: number): number => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const tag = (b: Uint8Array, p: number): string => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/**
 * Parse a Standard MIDI File into its division + a flat, time-ordered note list.
 * Throws on a malformed header. SMPTE-division files (negative division) are
 * rejected — drum import assumes ticks-per-beat timing.
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
      } else if (type === 0x90) {        // note on
        const note = bytes[p++]; const vel = bytes[p++];
        if (vel > 0) notes.push({ tick, channel, note, velocity: vel });
      } else if (type === 0x80) {        // note off
        p += 2;
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
  /** WHICH note numbers went unmapped, with hit counts — what a drumMap needs to cover. */
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
    q.warnings.push(`No notes on MIDI channel ${wireCh + 1}. Channels in this file: ${have || '(none)'} — pass \`channel\` to pick the drum channel.`);
  }
  if (unmapped > 0) {
    const list = Object.entries(unmappedNumbers).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(', ');
    q.warnings.push(`${unmapped} drum note(s) on unmapped number(s) [${list}] were skipped — pass drumMap (number → voice or GM number) to place them (non-GM key maps need one).`);
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
  /** Max simultaneous notes (same tick) — 1 = monophonic line, 3+ = chords. */
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
}

export interface MidiMelodicImport {
  /** The voice's step row: pitched steps (chords grouped, capped at 6 notes). */
  steps: Step[];
  step_count: number;
  warnings: string[];
  total_beats: number;
}

/**
 * Import ONE melodic channel of a MIDI file as a pitched step row: note-ons
 * quantize onto the grid; same-step notes group into a chord (capped at 6, the
 * Circuit note-slot limit); velocity is carried (loudest of the chord). Off-grid
 * onsets round + warn, mirroring the drum importer. Durations are not imported —
 * authored notes take a one-step gate (the .ncs doesn't carry ms durations).
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

  const steps: Step[] = Array.from({ length: stepCount }, () => ({ on: false } as Step));
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
    const cell = steps[step];
    const notes: number[] = cell.notes === undefined ? [] : Array.isArray(cell.notes) ? [...cell.notes] : [cell.notes as number];
    if (notes.includes(n.note)) continue;
    if (notes.length >= 6) { chordOverflow++; continue; }
    notes.push(n.note);
    steps[step] = {
      on: true,
      notes: notes.length === 1 ? notes[0] : notes.sort((a, b) => a - b),
      velocity: Math.max(cell.velocity ?? 0, n.velocity),
    };
  }
  if (offGrid.size > 0) warnings.push(`${offGrid.size} off-grid onset(s) rounded to the grid (triplets / 32nds are approximate).`);
  if (chordOverflow > 0) warnings.push(`${chordOverflow} note(s) dropped from chords past the 6-note step limit.`);
  if (dropped > 0) warnings.push(`${dropped} note(s) fell outside the ${stepCount}-step window.`);
  return { steps, step_count: stepCount, warnings, total_beats };
}

/** Render a QuantizedDrums to the per-voice char grid (for display / re-feeding the tab path). */
export function quantizedToGrids(q: QuantizedDrums): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [voice, steps] of Object.entries(q.voices)) {
    out[voice] = steps.map((s: Step) => (s.on ? (s.accent ? 'X' : s.roll === 6 ? '6' : 'x') : '.')).join('');
  }
  return out;
}
