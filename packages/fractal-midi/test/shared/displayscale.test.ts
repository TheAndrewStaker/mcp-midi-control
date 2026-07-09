/**
 * Goldens for the display↔wire quantization helpers (BUG-3).
 *
 * The wire field is a fixed 65535-step ladder (0..65534). A param whose
 * display range is wide relative to that ladder cannot store every
 * display integer exactly, so a written↔read display value can differ by
 * up to one wire quantum. These vectors pin the quantum math and the
 * `withinDisplayQuantum` tolerance so the "write 400 ms, read 399 ms is
 * expected" contract is regression-guarded.
 */
import {
  displayToWire,
  wireToDisplay,
  displayQuantum,
  withinDisplayQuantum,
  type DisplayToWireOptions,
} from '../../src/shared/displayScale.js';

const EPS = 1e-6;

// delay.time: 1..8000 ms linear over 65534 steps → ~0.1221 ms / step.
const DELAY_TIME: DisplayToWireOptions = { displayMin: 1, displayMax: 8000 };
// A 0..10 amp knob → ~0.0001526 / step (quantum far below display precision).
const KNOB_0_10: DisplayToWireOptions = { displayMin: 0, displayMax: 10 };
// cab.high_cut: 200..20000 Hz log10 — quantum GROWS with the value.
const HIGH_CUT: DisplayToWireOptions = { displayMin: 200, displayMax: 20000, displayScale: 'log10' };

export function runDisplayScaleTests(): void {
  // ── Linear quantum is (range / 65534), roughly constant across wire ──
  const delayQ = displayQuantum(DELAY_TIME);
  const expectedDelayQ = (8000 - 1) / 65534; // ≈ 0.12206
  if (Math.abs(delayQ - expectedDelayQ) > 1e-4) {
    throw new Error(`delay.time quantum: expected ~${expectedDelayQ.toFixed(5)}, got ${delayQ.toFixed(5)}`);
  }

  const knobQ = displayQuantum(KNOB_0_10);
  if (knobQ > 0.001) {
    throw new Error(`0..10 knob quantum should be tiny, got ${knobQ}`);
  }

  // ── The headline case: write 400 ms, read back within one quantum ──
  // The nearest rung must NOT round-trip to exactly 400, but MUST be
  // within one quantum (this is the behavior BUG-3 documented as expected).
  const wire400 = displayToWire(400, DELAY_TIME);
  const readback = wireToDisplay(wire400, DELAY_TIME);
  if (Math.abs(readback - 400) > delayQ + EPS) {
    throw new Error(`delay.time 400 ms readback ${readback} drifted more than one quantum ${delayQ}`);
  }
  if (!withinDisplayQuantum(readback, 400, DELAY_TIME)) {
    throw new Error(`withinDisplayQuantum should accept the delay.time 400 ms readback ${readback}`);
  }

  // A difference of two quanta must be rejected (guards against an
  // over-loose tolerance masking a real write failure).
  const twoQuantaOff = 400 + 2 * delayQ + 1e-3;
  if (withinDisplayQuantum(twoQuantaOff, 400, DELAY_TIME)) {
    throw new Error(`withinDisplayQuantum wrongly accepted a two-quantum difference (${twoQuantaOff} vs 400)`);
  }

  // ── log10: the LOCAL quantum near 20 kHz is far larger than near 200 Hz ──
  const qLow = displayQuantum(HIGH_CUT, displayToWire(220, HIGH_CUT));
  const qHigh = displayQuantum(HIGH_CUT, displayToWire(18000, HIGH_CUT));
  if (!(qHigh > qLow)) {
    throw new Error(`log10 quantum should grow with value: low=${qLow}, high=${qHigh}`);
  }
  // withinDisplayQuantum sizes the tolerance at the expected value's wire
  // position, so an 18 kHz readback tolerance is the (large) local quantum.
  const wire18k = displayToWire(18000, HIGH_CUT);
  const readback18k = wireToDisplay(wire18k, HIGH_CUT);
  if (!withinDisplayQuantum(readback18k, 18000, HIGH_CUT)) {
    throw new Error(`withinDisplayQuantum should accept the high_cut 18 kHz readback ${readback18k}`);
  }
}

export const DISPLAYSCALE_CASE_COUNT = 6;
