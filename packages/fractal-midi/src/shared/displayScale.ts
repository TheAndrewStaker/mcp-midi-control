/**
 * Display↔wire resolver shared across Fractal codecs.
 *
 * Maps a panel display value (0..10 knob, dB, ms, Hz) onto the 16-bit
 * 0..65534 wire field, linearly or log-base-10. Originally calibrated
 * and hardware-verified on the Axe-Fx II (HW-079 goldens in
 * `scripts/verify-axe-fx-ii-encoding.ts`); the gen-3 catalog
 * (`fractal-gen3/src/catalog.ts`) uses the same resolver for params
 * with a calibrated display range. Housed in `shared/` so neither
 * generation's codec depends on the other's module at runtime.
 *
 * Moved verbatim from `gen2/axe-fx-ii/setParam.ts` (which re-exports
 * it for compatibility).
 */

/**
 * Convert a display value to its corresponding 16-bit wire value, given
 * a param's calibrated `displayMin` / `displayMax` / `displayScale`.
 *
 * Two scale shapes supported:
 *
 * **`'linear'`** (default) — wire 0..65534 maps linearly onto
 * displayMin..displayMax. Confirmed by  /  /  across
 * 0..10 (AMP knobs), 0..100% (mix), -100..+100% (feedback / balance /
 * pan), -80..+20 dB (cab level).
 *
 * **`'log10'`** — wire 0..65534 maps log-base-10 onto
 * displayMin..displayMax. Used for frequency knobs ( confirmed
 * cab.low_cut 20..2000 Hz and cab.high_cut 200..20000 Hz both fit
 * `displayHz = displayMin × (displayMax/displayMin)^(wire/65534)`
 * exactly at every measured anchor). Requires displayMin > 0.
 *
 * Callers should only invoke this on params with populated displayMin
 * AND displayMax. For uncalibrated params, the tool layer falls back
 * to the wire-value path.
 *
 * Clamps to [displayMin, displayMax] silently — the wire value pins to
 * [0, 65534] either way, so an out-of-range display value rounds to
 * the same endpoint. The tool layer surfaces a clamp note when needed.
 */
export type DisplayScale = 'linear' | 'log10';

export interface DisplayToWireOptions {
    readonly displayMin: number;
    readonly displayMax: number;
    readonly displayScale?: DisplayScale; // defaults to 'linear'
}

export function displayToWire(display: number, opts: DisplayToWireOptions): number {
    if (!Number.isFinite(display)) {
        throw new Error(`displayToWire: display value must be finite, got ${display}`);
    }
    const { displayMin, displayMax, displayScale = 'linear' } = opts;
    if (displayMin >= displayMax) {
        throw new Error(`displayToWire: displayMin (${displayMin}) must be < displayMax (${displayMax})`);
    }

    if (displayScale === 'log10') {
        if (displayMin <= 0 || displayMax <= 0) {
            throw new Error(`displayToWire: log10 scale requires positive displayMin/displayMax, got ${displayMin}/${displayMax}`);
        }
        const clamped = Math.min(displayMax, Math.max(displayMin, display));
        const ratio = Math.log10(clamped / displayMin) / Math.log10(displayMax / displayMin);
        return Math.round(ratio * 65534);
    }

    // linear (default)
    const clamped = Math.min(displayMax, Math.max(displayMin, display));
    const ratio = (clamped - displayMin) / (displayMax - displayMin);
    return Math.round(ratio * 65534);
}

/**
 * Inverse of `displayToWire`. Wire 0..65534 → display value via the
 * param's linear or log10 scale.
 */
export function wireToDisplay(wire: number, opts: DisplayToWireOptions): number {
    if (!Number.isInteger(wire) || wire < 0 || wire > 65534) {
        throw new Error(`wireToDisplay: wire value out of range: ${wire}`);
    }
    const { displayMin, displayMax, displayScale = 'linear' } = opts;
    if (displayMin >= displayMax) {
        throw new Error(`wireToDisplay: displayMin (${displayMin}) must be < displayMax (${displayMax})`);
    }

    if (displayScale === 'log10') {
        if (displayMin <= 0 || displayMax <= 0) {
            throw new Error(`wireToDisplay: log10 scale requires positive displayMin/displayMax, got ${displayMin}/${displayMax}`);
        }
        return displayMin * Math.pow(displayMax / displayMin, wire / 65534);
    }

    return displayMin + (wire / 65534) * (displayMax - displayMin);
}

/**
 * Size of one wire step in display units, near a given wire position
 * (BUG-3 quantization tolerance).
 *
 * The wire field is a fixed 65535-step ladder (0..65534). A param whose
 * display range is wide relative to that ladder therefore cannot store
 * every display integer exactly: writing `delay.time = 400` ms (range
 * 1..8000) lands on the nearest rung and reads back ~399-400, because one
 * rung is `(8000 - 1) / 65534 ≈ 0.12` ms. This is inherent quantization,
 * NOT a write failure and NOT a reader bug — `get_param` correctly echoes
 * the value the device actually stores. A ±1-ms readback delta on a
 * fine-unit knob is expected.
 *
 * Verify/readback loops should treat a written↔read display difference of
 * up to (roughly) one quantum as a match rather than asserting exact
 * equality. Use this to size that tolerance so it scales with the param's
 * range instead of a hardcoded absolute (a fixed 0.1 is too tight for
 * `delay.time` yet needlessly loose for a 0..10 knob).
 *
 * For `linear` the quantum is constant; for `log10` it grows with the
 * value, so this returns the LOCAL quantum at `wire` (the wider of the
 * step below and above), which is the conservative bound to tolerate.
 */
export function displayQuantum(opts: DisplayToWireOptions, wire = 32767): number {
    const clampedWire = Math.min(65534, Math.max(0, Math.round(wire)));
    const here = wireToDisplay(clampedWire, opts);
    const below = clampedWire > 0 ? Math.abs(here - wireToDisplay(clampedWire - 1, opts)) : 0;
    const above = clampedWire < 65534 ? Math.abs(wireToDisplay(clampedWire + 1, opts) - here) : 0;
    return Math.max(below, above);
}

/**
 * True when two display values differ by no more than one wire quantum
 * (plus a tiny float-rounding epsilon). The tolerance for a readback
 * comparison — see {@link displayQuantum}. Sizes the quantum at the wire
 * position of `expected` so log10 params get the right local step.
 */
export function withinDisplayQuantum(actual: number, expected: number, opts: DisplayToWireOptions): boolean {
    const quantum = displayQuantum(opts, displayToWire(expected, opts));
    return Math.abs(actual - expected) <= quantum + 1e-6;
}
