/**
 * Drum-pattern decode + surgical edit for a Circuit Tracks `.ncs` project.
 *
 * A drum pattern is 32 steps stored as 4 parallel 32-byte rows (structure of
 * arrays): velocity (+0), probability (+32), drum_choice (+64), rhythm (+96).
 * A step is ACTIVE iff its rhythm byte != 0; the low 6 bits of the rhythm byte
 * are the micro-hit mask, POSITIONAL: bit k = a hit on micro-tick k of the
 * step's six, and combinations are additive (0x01 = plain on-beat hit, 0x08 =
 * a lone 32nd "and", 0x09 = both, 0x3F = the full six-tick buzz).
 * HW-CONFIRMED 2026-07-03 by the single-state on-device diff capture
 * (scripts/circuit-microstep-capture.ts → scripts/groove-analysis/
 * _microstep-capture.json: pos1..pos5 → 0x02/0x04/0x08/0x10/0x20 and buzz →
 * 0x3F — every single-bit state matched the positional prediction).
 *
 * All edits mutate the 160,780-byte project buffer in place and touch ONLY the
 * targeted velocity + rhythm bytes, so every other byte of the project is
 * preserved verbatim (the template-modify safety guarantee).
 */

import {
  NCS_FILE_SIZE,
  STEPS_PER_PATTERN,
  drumRowBase,
} from './format.js';

export interface DrumStep {
  active: boolean;
  velocity: number;     // 0..127
  probability: number;  // 0..7 (7 = 100%)
  drumChoice: number;   // sample-flip selector = ABSOLUTE sample slot 0..63; 0xFF = no flip (play the track's default sample). HW-confirmed 2026-06-22: a snare flipped to slot 2 read back drum_choice=2.
  microHits: number;    // positional 6-bit mask, bit k = micro-tick k (1 = plain hit; HW-confirmed 2026-07-03)
}

export const DEFAULT_HIT_VELOCITY = 100;
export const DEFAULT_PROBABILITY = 7;     // 0..7; 7 = always play
export const DEFAULT_DRUM_CHOICE = 0xff;  // no per-step sample flip

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

/** Decode all 32 steps of a drum (track 0..3, pattern 0..7) from a project buffer. */
export function decodeDrumPattern(buf: Uint8Array, track: number, pattern: number): DrumStep[] {
  assertBuf(buf);
  const rb = drumRowBase(track, pattern);
  const out: DrumStep[] = [];
  for (let i = 0; i < STEPS_PER_PATTERN; i++) {
    const rhythm = buf[rb + 96 + i];
    out.push({
      active: rhythm !== 0,
      velocity: buf[rb + i],
      probability: buf[rb + 32 + i],
      drumChoice: buf[rb + 64 + i],
      microHits: (rhythm & 0x3f) || 1,
    });
  }
  return out;
}

/**
 * Set one drum step in place. Active = write velocity + rhythm(micro-hit mask);
 * inactive = clear both. Returns the byte offsets changed (for verification).
 */
export function setDrumStep(
  buf: Uint8Array, track: number, pattern: number, step: number,
  opts: { active: boolean; velocity?: number; probability?: number; microHits?: number; sampleSlot?: number } = { active: true },
): readonly number[] {
  assertBuf(buf);
  assertStep(step);
  const rb = drumRowBase(track, pattern);
  const vOff = rb + step;        // velocity row
  const pOff = rb + 32 + step;   // probability row
  const cOff = rb + 64 + step;   // drum_choice row
  const rOff = rb + 96 + step;   // rhythm row
  if (opts.active) {
    const v = opts.velocity ?? DEFAULT_HIT_VELOCITY;
    if (!Number.isInteger(v) || v < 0 || v > 127) throw new RangeError(`velocity 0..127, got ${v}`);
    const m = (opts.microHits ?? 1) & 0x3f || 1;
    // Per-step SAMPLE FLIP: drum_choice = an absolute sample slot 0..63 makes this
    // step play that sample instead of the track's default; undefined ⇒ 0xFF (no
    // flip). HW-confirmed encoding (2026-06-22).
    const slot = opts.sampleSlot;
    if (slot !== undefined && (!Number.isInteger(slot) || slot < 0 || slot > 63)) {
      throw new RangeError(`sampleSlot (sample-flip) must be 0..63, got ${slot}`);
    }
    // ALL FOUR rows must be written, or a step inherits the template's
    // probability/drum_choice, e.g. a leftover sample-flip plays the wrong
    // sample (the "white step" symptom on the device).
    buf[vOff] = v;
    buf[pOff] = opts.probability ?? DEFAULT_PROBABILITY;
    buf[cOff] = slot ?? DEFAULT_DRUM_CHOICE;
    buf[rOff] = m;
    return [vOff, pOff, cOff, rOff];
  }
  buf[vOff] = 0;
  buf[rOff] = 0;
  return [vOff, rOff];
}

/**
 * Overwrite a whole drum pattern from a step grid. `grid` is a boolean[] (hit
 * per step) or a per-step `{active, velocity?}`. Length up to 32; unspecified
 * trailing steps are cleared. Touches only that pattern's velocity + rhythm rows.
 */
export function setDrumPattern(
  buf: Uint8Array, track: number, pattern: number,
  grid: ReadonlyArray<boolean | { active: boolean; velocity?: number; microHits?: number; sampleSlot?: number }>,
): void {
  assertBuf(buf);
  if (grid.length > STEPS_PER_PATTERN) {
    throw new RangeError(`grid has ${grid.length} steps, max ${STEPS_PER_PATTERN}`);
  }
  for (let i = 0; i < STEPS_PER_PATTERN; i++) {
    const cell = grid[i];
    const opts = cell === undefined ? { active: false }
      : typeof cell === 'boolean' ? { active: cell }
        : cell;
    setDrumStep(buf, track, pattern, i, opts);
  }
}

/** Render a decoded pattern to an `x`/`.` string (display + goldens). */
export function drumPatternToString(steps: readonly DrumStep[]): string {
  return steps.map((s) => (s.active ? 'x' : '.')).join('');
}
