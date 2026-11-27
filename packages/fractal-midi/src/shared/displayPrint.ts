/**
 * How a Fractal device prints a display value: the precision rule its front
 * panel (and editor) applies before showing a number.
 *
 * Measured on the Axe-Fx II, whose parameter reads carry the device's own
 * display text: most params print a fixed number of decimals ("0.707",
 * "50.0 %"), some print a fixed number of SIGNIFICANT figures ("103.6 Hz",
 * "1920 Hz", "25.18 Hz"), and a param either rounds to nearest or truncates
 * toward zero ("249.9" for 249.95). Reproducing the rule exactly is what makes
 * a read print what the panel shows, and lets a reading typed off the panel
 * round-trip through a write.
 */

export interface DisplayPrintRule {
  /** digits after the point (fixed-decimals rule), or the cap on them under `sigFigs` */
  readonly decimals: number;
  /** print this many significant figures instead of fixed decimals */
  readonly sigFigs?: number;
  /** 'truncate': cut toward zero instead of rounding to nearest */
  readonly rounding?: 'truncate';
}

/**
 * Round a decoded display value to `decimals` places, nearest, never -0. Strips
 * the float noise a wire->display inverse leaves behind (7.0000305 -> 7). The
 * one rounding every Fractal decode boundary uses when it has no measured
 * print rule: gen-3 and the II fallback at 2 places, the AM4 at its per-unit
 * precision.
 */
export function roundDisplay(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** The printed step at `value` under `rule` (0.1 for "103.6", 1 for "1920"). */
export function displayPrintStep(value: number, rule: DisplayPrintRule): number {
  let dec = rule.decimals;
  if (rule.sigFigs !== undefined && value !== 0) {
    const mag = Math.floor(Math.log10(Math.abs(value)) + 1e-9);
    dec = Math.min(rule.decimals, Math.max(0, rule.sigFigs - 1 - mag));
  }
  return Math.pow(10, -dec);
}

/** `value` as the device prints it, as a number (no -0). */
export function printDisplayValue(value: number, rule: DisplayPrintRule): number {
  const step = displayPrintStep(value, rule);
  const x = value / step;
  // the epsilon keeps a value that is exactly on a step (2.9999999997) on it
  const n = rule.rounding === 'truncate' ? Math.trunc(x + Math.sign(x) * 1e-6) : Math.round(x);
  const v = Number((n * step).toFixed(Math.max(0, -Math.round(Math.log10(step)))));
  return Object.is(v, -0) ? 0 : v;
}

/**
 * The display value to aim a write at so it reads back as `reading`: the
 * reading itself under rounding, the middle of its printed step under
 * truncation (149.9 covers 149.90..149.99).
 */
export function displayWriteTarget(reading: number, rule: DisplayPrintRule): number {
  if (rule.rounding !== 'truncate' || reading === 0) return reading;
  return reading + Math.sign(reading) * 0.5 * displayPrintStep(reading, rule);
}
