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
 *                                     silent even if it holds stale bytes, and
 *                                     the device does NOT always leading-pack it
 *                                     (a real factory step reads mask 0x05, i.e.
 *                                     slots 0 and 2 with a live-looking record
 *                                     sitting muted in slot 1).
 *                                     probability is the step's play chance 0..7
 *                                     (7 = 100%, the default).
 *   [note, gate, delay, velocity] x 6   <- up to a 6-note chord. byte order is
 *                                     note number, GATE LANE (see below), delay
 *                                     (micro-step nudge 0..5), velocity 0..127.
 *                                     An EMPTY slot is `00 00 00 60` (velocity
 *                                     0x60 = the device default, no note).
 *
 * ## The gate lane is TWO fields: `tie << 7 | gate_sixths`
 *
 * Decoded 2026-07-26 from a 274-file / 44,898-note corpus census
 * (`scripts/circuit-gate-census.ts`) plus the Circuit Tracks user guide.
 *
 *  - **bits 6..0, the gate MAGNITUDE**, in SIXTHS of a step, 1..96. 6 = one
 *    step, 96 = sixteen steps. The manual (":1632-1640") is explicit that gate
 *    is fractional: "any value between one-sixth and 16, in increments of
 *    one-sixth of a Step, giving a total of 96 possible values". The corpus
 *    agrees exactly: with bit 7 masked off there is no value in 97..127 and no
 *    value at 0 anywhere, and 1,033 notes sit BELOW one step (real staccato).
 *    It is NOT an integer step count and NOT a "0..6 micro-tick" field.
 *  - **bit 7, TIE-FORWARD**: the device's documented "Tied / Drone Notes"
 *    control (manual ":1879-1949"), a per-STEP flag that holds the note into the
 *    next onset. 1,048 corpus notes carry it, all as byte 224 (`0x80 | 96`); in
 *    the maintainer's Pack 5, 524 of 524 tied notes end exactly where the next
 *    onset begins AND that onset holds the identical chord, which is the
 *    manual's recipe verbatim. On 380 of 380 chord steps every slot carries the
 *    flag, none mixed.
 *
 * ORTHOGONALITY: HARDWARE-CONFIRMED 2026-07-27 on the maintainer's device. Every
 * tie in the corpus sat at magnitude 96, so "the flag is independent of the
 * length" had rested on the manual rather than on a second observed value. Byte
 * 176 (`0x80 | 48`, tied at 8 steps) was written into pack 5 project 42
 * ("GateTest16") at `0x1a281`, uploaded, then LOADED and SAVED on the device.
 * It read back as 176. The tell-tale that makes this device evidence rather
 * than a file round-trip is the second changed byte: the synth 1 mixer level at
 * `0x2701c` moved 0 -> 57 on its own, and mixer levels are composed from the
 * physical fader positions at save time and were never sent over the wire, so
 * the device re-serialised the project from its OWN state and kept the tie at a
 * magnitude of 48. The all-96 corpus was a habit of how ties get dialled in by
 * hand, not a constraint the format imposes. This codec handles ANY magnitude
 * with the tie bit set, and that is now the confirmed behaviour, not a hedge.
 *
 * ## Why the byte must be SPLIT and never clamped or masked
 *
 * The previous validator bounded the raw byte to 0..127. That was wrong in both
 * directions: it REJECTED the 1,048 real notes that read 224 (so a
 * read-modify-write of Stranglehold / Clint Eastwood / CaughtGlim / Amber threw
 * a RangeError), and it ACCEPTED 97..127, which the device never produces.
 * Masking bit 7 away instead would silently un-tie a hand-made drone. So: split
 * the flag off, bound the MAGNITUDE 1..96, carry both through an edit, re-emit
 * both.
 *
 * Region = 32 x 28 = 896 bytes, ending at the block's metadata offset. Byte
 * layout cross-checked against the MIT `namirsab/circuit-tracks-tools` reference
 * decoder and round-trips byte-exact against the factory "Hello Tracks" pack;
 * format facts only (clean-room TypeScript implementation).
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

/** Gate micro-ticks in one step. The gate magnitude counts these sixths. */
export const MICROTICKS_PER_STEP = 6;
/** Shortest gate the device can hold: one sixth of a step. */
export const MIN_GATE_SIXTHS = 1;
/** Longest gate the device can hold: 96 sixths = 16 steps (manual + corpus). */
export const MAX_GATE_SIXTHS = MICROTICKS_PER_STEP * 16;
/** Bit 7 of the gate lane: the device's per-step TIE-FORWARD flag. */
export const GATE_TIE_FLAG = 0x80;
/** Bits 6..0 of the gate lane: the gate magnitude in sixths of a step. */
export const GATE_MAGNITUDE_MASK = 0x7f;
/** Highest note number a MIDI note-on can carry. See `setNoteStepVerbatim`. */
export const MAX_MIDI_NOTE = 127;
/** Widest value any single lane byte can hold. Used only by the verbatim path. */
const MAX_LANE_BYTE = 0xff;

export interface NoteSlot {
  note: number;      // MIDI note number 0..127
  /**
   * Gate MAGNITUDE in sixths of a step, 1..96 (6 = one full step, 96 = sixteen
   * steps). This is NOT the raw lane byte: the tie flag has been split off into
   * `tie`. Re-join with `gateByte(gate, tie)`.
   */
  gate: number;
  /**
   * Tie-forward: hold this note into the next onset (gate-lane bit 7).
   *
   * The DEVICE treats this as a per-STEP control and applies it to every note on
   * the step (manual ":1948"; 380/380 corpus chord steps agree, 0 mixed). It is
   * stored per slot, so this type carries it per slot and the decode reports
   * exactly what is on disk; an authoring layer that sets it should set it
   * identically across the step (`noteStepTie` reports whether a step is mixed).
   */
  tie: boolean;
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
export const DEFAULT_GATE = MICROTICKS_PER_STEP;  // one full step
export const DEFAULT_PROBABILITY = 7;      // 7 = always play
const EMPTY_SLOT_VELOCITY = 0x60;          // empty note slot's velocity byte (device default)

/** Split a raw gate-lane byte into its tie flag and its magnitude in sixths. */
export function splitGateByte(byte: number): { gate: number; tie: boolean } {
  return { gate: byte & GATE_MAGNITUDE_MASK, tie: (byte & GATE_TIE_FLAG) !== 0 };
}

/**
 * Join a gate magnitude + tie flag back into the raw gate-lane byte. Exact
 * inverse of `splitGateByte` for every byte the device produces.
 */
export function gateByte(gate: number, tie = false): number {
  return (tie ? GATE_TIE_FLAG : 0) | (gate & GATE_MAGNITUDE_MASK);
}

/**
 * Render a gate magnitude + tie flag the way the DEVICE shows them: a length in
 * STEPS (what Gate View displays), plus the tie called out in words.
 *
 * Display-first, and the tie is never silent. The gate lane's magnitude is in
 * sixths, so a raw "96" is meaningless to a musician and, worse, a tied note
 * printed as its bare magnitude looks IDENTICAL to an untied one of the same
 * length, and that is how a hand-made drone becomes invisible in `get_preset` and
 * `describe_device`. Sixths are rendered as an exact fraction ("1/6 step",
 * "1 1/2 steps"), never a decimal, because the field's real resolution is
 * thirds and halves of a step and 0.166666 reads as a rounding error.
 */
export function describeGate(gate: number, tie: boolean): string {
  const whole = Math.floor(gate / MICROTICKS_PER_STEP);
  const rem = gate % MICROTICKS_PER_STEP;
  let length: string;
  if (rem === 0) {
    length = `${whole} step${whole === 1 ? '' : 's'}`;
  } else {
    const g = rem % 3 === 0 ? 3 : rem % 2 === 0 ? 2 : 1;
    const frac = `${rem / g}/${MICROTICKS_PER_STEP / g}`;
    length = whole === 0 ? `${frac} step` : `${whole} ${frac} steps`;
  }
  return `gate ${length}${tie ? ', TIED forward' : ''}`;
}

/**
 * A step's tie state as the DEVICE understands it (one flag for the whole step),
 * or `'mixed'` if the slots disagree. An empty step is untied.
 *
 * `'mixed'` has never been observed (0 of 380 corpus chord steps that carry a
 * tie), so a `'mixed'` result means either hand-crafted data or a bug in an
 * authoring layer that set the flag on part of a chord.
 */
export function noteStepTie(step: NoteStep): boolean | 'mixed' {
  if (step.notes.length === 0) return false;
  const first = step.notes[0].tie;
  return step.notes.every((n) => n.tie === first) ? first : 'mixed';
}

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
function assertLaneByte(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LANE_BYTE) {
    throw new RangeError(`${label} must be a byte 0..${MAX_LANE_BYTE}, got ${value}`);
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
        const { gate, tie } = splitGateByte(buf[slot + 1]);
        notes.push({ note: buf[slot], gate, tie, delay: buf[slot + 2], velocity: buf[slot + 3] });
      }
    }
    out.push({ active: slotMask !== 0, slotMask, probability, notes });
  }
  return out;
}

type NoteInput = number | { note: number; velocity?: number; gate?: number; tie?: boolean; delay?: number };

function normalizeNotes(notes: ReadonlyArray<NoteInput>): NoteSlot[] {
  if (notes.length > NOTE_SLOTS_PER_STEP) {
    throw new RangeError(`a step holds at most ${NOTE_SLOTS_PER_STEP} notes, got ${notes.length}`);
  }
  return notes.map((n) => {
    const slot: NoteSlot = typeof n === 'number'
      ? { note: n, gate: DEFAULT_GATE, tie: false, delay: 0, velocity: DEFAULT_NOTE_VELOCITY }
      : {
        note: n.note,
        gate: n.gate ?? DEFAULT_GATE,
        tie: n.tie ?? false,
        delay: n.delay ?? 0,
        velocity: n.velocity ?? DEFAULT_NOTE_VELOCITY,
      };
    if (!Number.isInteger(slot.note) || slot.note < 0 || slot.note > MAX_MIDI_NOTE) throw new RangeError(`note 0..${MAX_MIDI_NOTE}, got ${slot.note}`);
    if (!Number.isInteger(slot.velocity) || slot.velocity < 0 || slot.velocity > 127) throw new RangeError(`velocity 0..127, got ${slot.velocity}`);
    // The MAGNITUDE, not the byte: `tie` is a separate argument and is re-joined
    // into bit 7 on the way out. 1..96 is what the device produces and accepts
    // (see the header); 0 and 97..127 appear nowhere in a 44,898-note corpus.
    if (!Number.isInteger(slot.gate) || slot.gate < MIN_GATE_SIXTHS || slot.gate > MAX_GATE_SIXTHS) {
      throw new RangeError(`gate ${MIN_GATE_SIXTHS}..${MAX_GATE_SIXTHS} sixths of a step (${MICROTICKS_PER_STEP} = one step), got ${slot.gate}`);
    }
    if (typeof slot.tie !== 'boolean') throw new TypeError(`tie must be a boolean, got ${String(slot.tie)}`);
    if (!Number.isInteger(slot.delay) || slot.delay < 0 || slot.delay > 5) throw new RangeError(`delay 0..5, got ${slot.delay}`);
    return slot;
  });
}

/**
 * Set one step in place. `notes` empty = clear the step; otherwise write up to 6
 * notes (a chord) into the leading slots and the header bitmask. `probability`
 * is the per-step play chance 0..7 (default 7). Returns the byte offset range
 * [start, end) touched (always the step's 28 bytes).
 *
 * This is the AUTHORING primitive: it normalizes a step to the leading-packed
 * shape and holds every lane to what a musician can play (note 0..127, gate
 * magnitude 1..96). To re-emit a step that came off a real device VERBATIM,
 * including values outside those ranges, use `setNoteStepVerbatim`.
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
      buf[slot + 1] = gateByte(ns[n].gate, ns[n].tie);
      buf[slot + 2] = ns[n].delay;
      buf[slot + 3] = ns[n].velocity;
    } else {
      buf[slot] = 0; buf[slot + 1] = 0; buf[slot + 2] = 0; buf[slot + 3] = EMPTY_SLOT_VELOCITY;
    }
  }
  return [base, base + NOTE_STEP_BYTES];
}

/**
 * Byte-faithful inverse of `decodeNotePattern` for ONE step: re-emit a decoded
 * step's lane bytes exactly as they were read, so decode -> encode over the same
 * buffer is a no-op. Use this for a read-modify-write of real device data; use
 * `setNoteStep` to author new content.
 *
 * Three deliberate differences from `setNoteStep`, each one a byte the authoring
 * path would otherwise rewrite:
 *
 *  1. **The slot mask is preserved, not re-packed.** The device does not always
 *     leading-pack it (`pack0/projects/project_11.ncs` synth1 pattern 4 step 12
 *     reads mask 0x05), and notes are written back at THEIR mask positions.
 *  2. **Slots the mask does not select are left alone**, muted stale records
 *     included. `setNoteStep` overwrites them with the device's empty record.
 *  3. **Lane values are bounded only by the byte**, not by MIDI. Exactly one slot
 *     in a 44,898-note corpus holds note number 128, which is out of MIDI range
 *     yet sits in an otherwise perfectly well-formed record (see below). This
 *     path carries it through unchanged rather than rejecting the file or
 *     rewriting the maintainer's data; `setNoteStep` still refuses to AUTHOR it.
 *
 * Header bytes 2 and 3 are NOT written: the decode does not carry them (they are
 * `00 00` on all 29,757 active corpus steps), so leaving them is the preserving
 * choice.
 *
 * ### The note-128 slot, in full
 *
 * `samples/circuit-tracks/pack0/projects/project_11.ncs` ("Woke Code"), synth1
 * pattern 4, step 13, slot 1, file offset `0x36f8`, holds note number 128
 * (`0x80`). Verdict: an out-of-MIDI-range note the DEVICE wrote at the very top
 * of that track's range, not a flag and not a torn record.
 *
 *  - **Not a flag.** 1 occurrence in 44,898 mask-active slots, and 0 in
 *    1,638,558 masked-off ones. Contrast the gate-lane tie flag: 1,048
 *    occurrences plus a 100%/100% behavioural correlation. A flag with a
 *    population of one and no correlate is not a flag. Reading it as
 *    "note 0 + a flag" also fails musically: note 0 is C-2, five octaves below
 *    anything else on that track.
 *  - **Not corruption of the record.** Every other field is valid and typical:
 *    mask `0x03`, probability 7, header `00 00`, gate 3, delay 4, velocity 31.
 *  - **It is the top of a range that already reaches the ceiling.** That track
 *    runs 63..128 and includes 125 and 127, and the NEXT pattern (5) holds
 *    `7f 03 ...` = note 127 with the same gate 3 in the identical (step, slot)
 *    position. 128 is exactly one semitone past the MIDI ceiling, which is what
 *    an unclamped transposition of a played-in note looks like.
 *
 * Evidence strength: strong for "preserve it" (a well-formed record, reproduced
 * from disk), weaker for the exact provenance (one instance, no capture of the
 * device making it). Where the two disagree, this preserves the byte.
 */
export function setNoteStepVerbatim(
  buf: Uint8Array, track: NoteTrack, pattern: number, step: number, decoded: NoteStep,
): readonly [number, number] {
  assertBuf(buf);
  assertStep(step);
  assertLaneByte('slotMask', decoded.slotMask);
  if (decoded.slotMask > 0x3f) throw new RangeError(`slotMask must select from ${NOTE_SLOTS_PER_STEP} slots (0..0x3f), got 0x${decoded.slotMask.toString(16)}`);
  assertLaneByte('probability', decoded.probability);
  let popcount = 0;
  for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) if ((decoded.slotMask >> n) & 1) popcount++;
  if (popcount !== decoded.notes.length) {
    throw new RangeError(`slotMask 0x${decoded.slotMask.toString(16)} selects ${popcount} slot(s) but ${decoded.notes.length} note(s) were given`);
  }
  const base = noteStepBase(track, pattern) + step * NOTE_STEP_BYTES;
  buf[base] = decoded.slotMask;
  buf[base + 1] = decoded.probability;
  let i = 0;
  for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) {
    if (!((decoded.slotMask >> n) & 1)) continue;
    const src = decoded.notes[i++];
    assertLaneByte('note', src.note);
    assertLaneByte('delay', src.delay);
    assertLaneByte('velocity', src.velocity);
    if (!Number.isInteger(src.gate) || src.gate < 0 || src.gate > GATE_MAGNITUDE_MASK) {
      throw new RangeError(`gate magnitude must be 0..${GATE_MAGNITUDE_MASK} (the tie flag rides in \`tie\`), got ${src.gate}`);
    }
    if (typeof src.tie !== 'boolean') throw new TypeError(`tie must be a boolean, got ${String(src.tie)}`);
    const slot = base + 4 + n * 4;
    buf[slot] = src.note;
    buf[slot + 1] = gateByte(src.gate, src.tie);
    buf[slot + 2] = src.delay;
    buf[slot + 3] = src.velocity;
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
 * (rest), or a `{note, velocity?, gate?, tie?, delay?}` object. Length up to 32;
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
