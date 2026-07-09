/**
 * Roll retrigger dynamics: each bounce of a real press/buzz roll is quieter
 * than the last, and bit-identical retriggers are what produce the robotic
 * "machine-gun" quality of synthesized rolls. Every roll fan (the .ncs
 * note-track author and the live_stream realizer) shapes its retriggers with
 * this one curve so a roll auditions the way it will be stored.
 *
 * Curve: multiplicative decay per retrigger (0.85^k), floored so late bounces
 * stay audible on velocity-sensitive pads (SPD-SX DYNAMICS ON). k=0 is always
 * the caller's velocity (identity for single hits).
 */

const ROLL_DECAY = 0.85;
const MIN_ROLL_VELOCITY = 20;

/** Velocity of retrigger k (0-based) of a roll that starts at `base`. */
export function rollVelocity(base: number, k: number): number {
  if (k <= 0) return base;
  return Math.max(MIN_ROLL_VELOCITY, Math.round(base * ROLL_DECAY ** k));
}
