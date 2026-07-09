/**
 * Note-pattern decode + surgical edit for a Circuit Tracks `.ncs` project.
 *
 * The four note tracks (Synth1, Synth2, MIDI1, MIDI2) all use ONE identical
 * step format (the Synths play it; the MIDI tracks send it out to external gear
 * like a Hydrasynth). A pattern is 32 steps stored as an array of 28-byte step
 * records (NOT structure-of-arrays like the drums). Each step is:
 *
 *   [slotMask, probability, 0x00, 0x00]   <- header: slotMask is a BITMASK of
 *                                     which of the 6 note slots are active (bit
 *                                     n = slot n), so a 3-note chord in slots
 *                                     0..2 = 0x07, not 3. The mask is
 *                                     authoritative: a slot whose bit is 0 is
 *                                     silent even if it holds stale bytes.
 *                                     probability is the step's play chance 0..7
 *                                     (7 = 100%, the default).
 *   [note, gate, delay, velocity] x 6   <- up to a 6-note chord. byte order is
 *                                     note number, gate (length in micro-ticks,
 *                                     6 per step; >6 ties across steps), delay
 *                                     (micro-step nudge 0..5), velocity 0..127.
 *                                     An EMPTY slot is `00 00 00 60` (velocity
 *                                     0x60 = the device default, no note).
 *
 * Region = 32 x 28 = 896 bytes, ending at the block's metadata offset. Byte
 * layout cross-checked against the MIT `namirsab/circuit-tracks-tools` reference
 * decoder and round-trips byte-exact against all 16 of "Hello Tracks"' synth
 * blocks; format facts only (clean-room TypeScript implementation).
 *
 * Edits mutate the 160,780-byte project buffer in place and touch ONLY the
 * targeted step's 28 bytes, preserving every other byte (template-modify).
 */

import {
  NCS_FILE_SIZE,
  STEPS_PER_PATTERN,
  NOTE_SLOTS_PER_STEP,
  NOTE_STEP_BYTES,
  noteStepBase,
  type NoteTrack,
} from './format.js';

export interface NoteSlot {
  note: number;      // MIDI note number 0..127
  gate: number;      // gate length in micro-ticks (6 = one full step; >6 ties across steps)
  delay: number;     // micro-step nudge 0..5 (swing/late)
  velocity: number;  // 0..127
}
export interface NoteStep {
  active: boolean;
  slotMask: number;     // device's active-slot bitmask (bit n = note slot n plays)
  probability: number;  // step play chance 0..7 (7 = 100%)
  notes: NoteSlot[];
}

export const DEFAULT_NOTE_VELOCITY = 96;   // device-native default (0x60)
export const DEFAULT_GATE = 6;             // one full step
export const DEFAULT_PROBABILITY = 7;      // 7 = always play
const EMPTY_SLOT_VELOCITY = 0x60;          // empty note slot's velocity byte (device default)

function assertBuf(buf: Uint8Array): void {
  if (buf.length !== NCS_FILE_SIZE) {
    throw new RangeError(`.ncs buffer must be ${NCS_FILE_SIZE} bytes, got ${buf.length}`);
  }
}
function assertStep(step: number): void {
  if (!Number.isInteger(step) || step < 0 || step >= STEPS_PER_PATTERN) {
    throw new RangeError(`step must be 0..${STEPS_PER_PATTERN - 1}, got ${step}`);
  }
}

/** Decode all 32 steps of a note track (synth1/synth2/midi1/midi2, pattern 0..7). */
export function decodeNotePattern(buf: Uint8Array, track: NoteTrack, pattern: number): NoteStep[] {
  assertBuf(buf);
  const base = noteStepBase(track, pattern);
  const out: NoteStep[] = [];
  for (let s = 0; s < STEPS_PER_PATTERN; s++) {
    const stepBase = base + s * NOTE_STEP_BYTES;
    const slotMask = buf[stepBase];
    const probability = buf[stepBase + 1];
    const notes: NoteSlot[] = [];
    for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) {
      if ((slotMask >> n) & 1) {
        const slot = stepBase + 4 + n * 4;
        notes.push({ note: buf[slot], gate: buf[slot + 1], delay: buf[slot + 2], velocity: buf[slot + 3] });
      }
    }
    out.push({ active: slotMask !== 0, slotMask, probability, notes });
  }
  return out;
}

type NoteInput = number | { note: number; velocity?: number; gate?: number; delay?: number };

function normalizeNotes(notes: ReadonlyArray<NoteInput>): NoteSlot[] {
  if (notes.length > NOTE_SLOTS_PER_STEP) {
    throw new RangeError(`a step holds at most ${NOTE_SLOTS_PER_STEP} notes, got ${notes.length}`);
  }
  return notes.map((n) => {
    const slot: NoteSlot = typeof n === 'number'
      ? { note: n, gate: DEFAULT_GATE, delay: 0, velocity: DEFAULT_NOTE_VELOCITY }
      : {
        note: n.note,
        gate: n.gate ?? DEFAULT_GATE,
        delay: n.delay ?? 0,
        velocity: n.velocity ?? DEFAULT_NOTE_VELOCITY,
      };
    if (!Number.isInteger(slot.note) || slot.note < 0 || slot.note > 127) throw new RangeError(`note 0..127, got ${slot.note}`);
    if (!Number.isInteger(slot.velocity) || slot.velocity < 0 || slot.velocity > 127) throw new RangeError(`velocity 0..127, got ${slot.velocity}`);
    if (!Number.isInteger(slot.gate) || slot.gate < 0 || slot.gate > 127) throw new RangeError(`gate 0..127, got ${slot.gate}`);
    if (!Number.isInteger(slot.delay) || slot.delay < 0 || slot.delay > 5) throw new RangeError(`delay 0..5, got ${slot.delay}`);
    return slot;
  });
}

/**
 * Set one step in place. `notes` empty = clear the step; otherwise write up to 6
 * notes (a chord) into the leading slots and the header bitmask. `probability`
 * is the per-step play chance 0..7 (default 7). Returns the byte offset range
 * [start, end) touched (always the step's 28 bytes).
 */
export function setNoteStep(
  buf: Uint8Array, track: NoteTrack, pattern: number, step: number,
  notes: ReadonlyArray<NoteInput>, probability = DEFAULT_PROBABILITY,
): readonly [number, number] {
  assertBuf(buf);
  assertStep(step);
  if (!Number.isInteger(probability) || probability < 0 || probability > 7) {
    throw new RangeError(`probability 0..7, got ${probability}`);
  }
  const ns = normalizeNotes(notes);
  const base = noteStepBase(track, pattern) + step * NOTE_STEP_BYTES;
  // Header: [slotMask, probability, 0, 0]. Notes go in leading slots 0..k-1, so
  // the mask is (1<<k)-1; the device reads the mask, not a count.
  buf[base] = (1 << ns.length) - 1;
  // The device keeps the probability byte populated even on empty steps (an
  // empty step's header is `00 07 00 00`, not `00 00 00 00`).
  buf[base + 1] = probability;
  buf[base + 2] = 0;
  buf[base + 3] = 0;
  for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) {
    const slot = base + 4 + n * 4;
    if (n < ns.length) {
      buf[slot] = ns[n].note;
      buf[slot + 1] = ns[n].gate;
      buf[slot + 2] = ns[n].delay;
      buf[slot + 3] = ns[n].velocity;
    } else {
      buf[slot] = 0; buf[slot + 1] = 0; buf[slot + 2] = 0; buf[slot + 3] = EMPTY_SLOT_VELOCITY;
    }
  }
  return [base, base + NOTE_STEP_BYTES];
}

/** Clear one step (no notes). */
export function clearNoteStep(buf: Uint8Array, track: NoteTrack, pattern: number, step: number): void {
  setNoteStep(buf, track, pattern, step, []);
}

/** Clear an entire note pattern (all 32 steps emptied). */
export function clearNotePattern(buf: Uint8Array, track: NoteTrack, pattern: number): void {
  for (let s = 0; s < STEPS_PER_PATTERN; s++) clearNoteStep(buf, track, pattern, s);
}

/**
 * Overwrite a whole note pattern from a step grid. `grid[i]` is the notes on
 * step i: a single MIDI note number, an array of notes (chord), undefined/empty
 * (rest), or a `{note, velocity?, gate?, delay?}` object. Length up to 32;
 * unspecified trailing steps are cleared.
 */
export function setNotePattern(
  buf: Uint8Array, track: NoteTrack, pattern: number,
  grid: ReadonlyArray<undefined | NoteInput | ReadonlyArray<NoteInput>>,
): void {
  assertBuf(buf);
  if (grid.length > STEPS_PER_PATTERN) {
    throw new RangeError(`grid has ${grid.length} steps, max ${STEPS_PER_PATTERN}`);
  }
  for (let s = 0; s < STEPS_PER_PATTERN; s++) {
    const cell = grid[s];
    const notes: ReadonlyArray<NoteInput> = cell === undefined ? []
      : Array.isArray(cell) ? cell
        : [cell as NoteInput];
    setNoteStep(buf, track, pattern, s, notes);
  }
}

/** Render a decoded pattern to a per-step string (root note or `.` for a rest). */
export function notePatternToString(steps: readonly NoteStep[]): string {
  return steps.map((s) => (s.active ? String(s.notes[0].note).padStart(3, ' ') : '  .')).join(' ');
}
