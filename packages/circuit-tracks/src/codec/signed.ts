/**
 * Centralized signed-value handling (handoff §4).
 *
 * Many Circuit Tracks params are bipolar: a display range like -64..+63
 * encoded as a 0..127 wire value with center 64. Some have non-standard
 * windows (octave 58..69 = -6..+5; pre-glide / pitchbend 52..76 = -12..+12;
 * pre/post FX level 52..82 = -12..+18 dB). One helper drives them all from
 * the param's declared window, no scattered `+ 64` offsets.
 */

export interface SignedWindow {
  /** Wire value that maps to display 0. */
  center: number;
  /** Lowest legal wire value. */
  lo: number;
  /** Highest legal wire value. */
  hi: number;
}

/** display → wire: `display + center`, clamped to the wire window. */
export function encodeSigned(display: number, w: SignedWindow): number {
  const wire = Math.round(display) + w.center;
  if (wire < w.lo || wire > w.hi) {
    throw new RangeError(
      `value out of range [${w.lo - w.center}..${w.hi - w.center}]: ${display}`,
    );
  }
  return wire;
}

/** wire → display: `wire - center`. */
export function decodeSigned(wire: number, w: SignedWindow): number {
  return wire - w.center;
}
