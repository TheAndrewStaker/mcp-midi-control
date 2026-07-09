/**
 * FM9 device-true display-range sanity (ranges.generated.ts float rows).
 *
 * Owns: a few doc-cited rows of FM9_RANGES round-tripped through the display
 * formula (normalized/wire → front-panel units), pinned to the hardware- and
 * generator-asserted values:
 *   - REVERB_TIME 0.1..100 s, step 0.02 — generator anchor, and the linear
 *     norm→sec fit 99.9*n + 0.1 is HARDWARE-CONFIRMED (FM9 fw 11.0 sweep
 *     2026-06-09, residual 0.003 s; see the fm9/params.ts row comment).
 *   - REVERB_MIX 0..100 % — hw-confirmed wire 65534 = 100.00% (fn=0x1F→0x75
 *     bulk-read calibration samples; see the fm9/params.ts row comment).
 *   - REVERB_LEVEL -80..20 dB and CABINET_PAN1 -100..100 — cache rows the
 *     2026-06-18 roundtrip exercised as continuous.
 *
 * Why: FM9_RANGES is the editor-cache data the 2026-06-18 kind-classification
 * fix is gated on; the enum side is guarded by fm9/kind-classification.test.ts,
 * and this file guards the FLOAT side — a regen that scrambles scale/min/max
 * would silently mis-display (or mis-encode) every calibrated FM9 knob.
 */
import { FM9_RANGES } from '../../../src/gen3/fm9/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function close(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}
/** Display value at normalized position n over a float row's device-true range. */
function displayAt(row: { displayMin: number; displayMax: number }, n: number): number {
  return row.displayMin + (row.displayMax - row.displayMin) * n;
}

const cases: Array<() => void> = [];

// REVERB_TIME (REVERB paramId 11): 0.1..100 s, step 0.02 — generator anchor.
cases.push(() => {
  const row = FM9_RANGES['REVERB'][11];
  assert(row.kind === 'float', `REVERB_TIME kind ${row.kind}`);
  assert(row.displayMin === 0.1 && row.displayMax === 100 && row.step === 0.02, `REVERB_TIME row drift: ${JSON.stringify(row)}`);
  // Hardware-confirmed linear fit: sec = 99.9*n + 0.1.
  assert(close(displayAt(row, 0), 0.1, 1e-9), `REVERB_TIME n=0 → ${displayAt(row, 0)} (want 0.1)`);
  assert(close(displayAt(row, 0.5), 50.05, 1e-9), `REVERB_TIME n=0.5 → ${displayAt(row, 0.5)} (want 50.05)`);
  assert(close(displayAt(row, 1), 100, 1e-9), `REVERB_TIME n=1 → ${displayAt(row, 1)} (want 100)`);
});

// REVERB_MIX (REVERB paramId 0): 0..100% — hw-confirmed wire 65534 = 100.00%.
cases.push(() => {
  const row = FM9_RANGES['REVERB'][0];
  assert(row.kind === 'float', `REVERB_MIX kind ${row.kind}`);
  assert(row.displayMin === 0 && row.displayMax === 100, `REVERB_MIX row drift: ${JSON.stringify(row)}`);
  // display = wire * (max-min) / 65534 + min: the calibrated wire→% mapping.
  const at = (wire: number) => displayAt(row, wire / 65534);
  assert(close(at(65534), 100, 1e-9), `REVERB_MIX wire 65534 → ${at(65534)} (hw-confirmed 100.00%)`);
  assert(close(at(0), 0, 1e-9), `REVERB_MIX wire 0 → ${at(0)} (want 0%)`);
  assert(close(at(32767), 50, 0.01), `REVERB_MIX wire 32767 → ${at(32767)} (want ~50%)`);
});

// REVERB_LEVEL (REVERB paramId 1): -80..20 dB, step 0.1.
cases.push(() => {
  const row = FM9_RANGES['REVERB'][1];
  assert(row.kind === 'float' && row.displayMin === -80 && row.displayMax === 20 && row.step === 0.1, `REVERB_LEVEL row drift: ${JSON.stringify(row)}`);
  assert(close(displayAt(row, 0.8), 0, 1e-9), `REVERB_LEVEL n=0.8 → ${displayAt(row, 0.8)} (want 0 dB, unity)`);
});

// CABINET_PAN1 (CABINET paramId 12): -100..100, center at n=0.5.
cases.push(() => {
  const row = FM9_RANGES['CABINET'][12];
  assert(row.kind === 'float' && row.displayMin === -100 && row.displayMax === 100, `CABINET_PAN1 row drift: ${JSON.stringify(row)}`);
  assert(close(displayAt(row, 0.5), 0, 1e-9), `CABINET_PAN1 n=0.5 → ${displayAt(row, 0.5)} (want 0 = center)`);
});

export function runFm9RangesTests(): void {
  for (const c of cases) c();
}
export const FM9_RANGES_CASE_COUNT = cases.length;
