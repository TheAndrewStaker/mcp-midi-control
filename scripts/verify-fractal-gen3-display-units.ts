/**
 * Gen-3 (modern Fractal: Axe-Fx III / FM3 / FM9) display-first round-trip gate.
 *
 * Mirrors `verify-axe-fx-ii-display-units.ts` for the gen-3 catalog. After
 * A4/A5, a gen-3 param that carries a calibrated display range
 * (`display_min` + `display_max`, non-enum) encodes/decodes through the
 * proven Axe-Fx II resolver instead of passing the raw 16-bit wire integer
 * through unchanged. This gate proves that wiring:
 *
 *   1. Endpoint mapping: encode(display_min) === 0, encode(display_max) === 65534.
 *   2. Monotonic + invertible: decode(encode(d)) ≈ d across the range; encode
 *      is monotonic in the display value (scale-agnostic — works for linear
 *      and log10 without the gate needing to know which).
 *   3. Decoded endpoints: decode(0) ≈ display_min, decode(65534) ≈ display_max.
 *   4. Out-of-range rejection: encode throws below display_min / above display_max.
 *   5. Coverage: the III ships a non-zero number of calibrated params (proves
 *      the calibration is actually wired into the schema, not dormant). FM3/FM9
 *      surface counts are reported; they light up once the A7 overlay fills
 *      their ranges, and this gate covers them automatically when it does.
 *
 * A "calibrated" param is detected by behavior (encode maps the endpoints to
 * 0 / 65534), so the gate tests exactly the shipped schemas without needing
 * the source catalog's scaling flag.
 *
 * Run:  npx tsx scripts/verify-fractal-gen3-display-units.ts
 */

import {
  AXEFX3_DESCRIPTOR,
  FM3_DESCRIPTOR,
  FM9_DESCRIPTOR,
} from '@mcp-midi-control/fractal-gen3/device.js';
import { SIGNED_RAW_SEMITONE_PARAMS } from '@mcp-midi-control/fractal-gen3/catalog.js';
import type { DeviceDescriptor, ParamSchema } from '@mcp-midi-control/core/protocol-generic/types.js';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) return;
  failures++;
  console.error(`  FAIL — ${label}${detail ? `: ${detail}` : ''}`);
}

function approxEq(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/**
 * Probe whether a non-enum param schema with a display range is actually
 * display-first calibrated (endpoints map to 0 / 65534). Passthrough params
 * return the display value as the wire value, so they fail this probe
 * (a negative display_min throws; a positive one returns itself, not 0).
 */
function isCalibrated(schema: ParamSchema): boolean {
  if (schema.enum_values !== undefined) return false;
  if (schema.display_min === undefined || schema.display_max === undefined) return false;
  if (!(schema.display_min < schema.display_max)) return false;
  try {
    return schema.encode(schema.display_min) === 0 && schema.encode(schema.display_max) === 65534;
  } catch {
    return false;
  }
}

interface DeviceResult {
  label: string;
  calibratedCount: number;
}

function verifyDevice(descriptor: DeviceDescriptor): DeviceResult {
  const label = descriptor.display_name ?? descriptor.id;
  let calibratedCount = 0;

  for (const [slug, block] of Object.entries(descriptor.blocks)) {
    for (const [key, schema] of Object.entries(block.params)) {
      if (!isCalibrated(schema)) continue;
      calibratedCount++;
      const id = `${label} ${slug}.${key}`;
      const lo = schema.display_min as number;
      const hi = schema.display_max as number;

      // Signed-raw-semitone params (issue #6): decode is INTENTIONALLY not the
      // inverse of encode. encode stays the standard normalized-continuous SET
      // form (the device's own microcode rescales it onto its native register);
      // decode reads the register back as a raw signed int16, because that is
      // what the device's own bulk-read/broadcast actually returns (hardware
      // roundtrip evidence, 2026-06-18 — see catalog.ts). The generic endpoint/
      // round-trip invariants below do not apply to these; they get their own
      // dedicated check instead.
      if (schema.parameter_name !== undefined && SIGNED_RAW_SEMITONE_PARAMS.has(schema.parameter_name)) {
        // encode must still be the standard normalized-linear SET form.
        check(`${id}: signed-raw semitone encode(lo)=0`, schema.encode(lo) === 0, `got ${schema.encode(lo)}`);
        check(`${id}: signed-raw semitone encode(hi)=65534`, schema.encode(hi) === 65534, `got ${schema.encode(hi)}`);
        check(`${id}: signed-raw semitone encode(0)=32767 (midpoint)`, schema.encode(0) === 32767, `got ${schema.encode(0)}`);
        // decode reads the wire as a raw signed int16 (the captured hardware
        // pattern: wire 65512 -> -24, wire 24 -> +24, wire 0 -> 0).
        check(`${id}: signed-raw semitone decode(65512)=-24`, schema.decode(65512) === -24, `got ${schema.decode(65512)}`);
        check(`${id}: signed-raw semitone decode(24)=24`, schema.decode(24) === 24, `got ${schema.decode(24)}`);
        check(`${id}: signed-raw semitone decode(0)=0`, schema.decode(0) === 0, `got ${schema.decode(0)}`);
        continue;
      }

      // 1. Endpoints already confirmed by isCalibrated; assert decoded endpoints.
      const decLo = schema.decode(0);
      const decHi = schema.decode(65534);
      const span = hi - lo;
      check(`${id}: decode(0) ≈ display_min`, typeof decLo === 'number' && approxEq(decLo, lo, Math.abs(span) * 0.001 + 1e-6), `got ${decLo}`);
      check(`${id}: decode(65534) ≈ display_max`, typeof decHi === 'number' && approxEq(decHi, hi, Math.abs(span) * 0.001 + 1e-6), `got ${decHi}`);

      // 2. Round-trip + monotonicity across interior sample points.
      const samples = [lo, lo + span * 0.25, lo + span * 0.5, lo + span * 0.75, hi];
      let prevWire = -1;
      let monotonic = true;
      for (const d of samples) {
        let wire: number;
        try {
          wire = schema.encode(d);
        } catch (err) {
          check(`${id}: encode(${d}) does not throw`, false, err instanceof Error ? err.message : String(err));
          continue;
        }
        check(`${id}: encode(${d}) in [0,65534]`, Number.isInteger(wire) && wire >= 0 && wire <= 65534, `got ${wire}`);
        if (wire < prevWire) monotonic = false;
        prevWire = wire;
        const back = schema.decode(wire);
        // Tolerance scales with the span; log10 ranges over decades need a
        // proportional tolerance, so use 0.5% of span (min 0.01).
        const tol = Math.max(Math.abs(span) * 0.005, 0.01);
        check(`${id}: decode(encode(${d})) ≈ ${d}`, typeof back === 'number' && approxEq(back, d, tol), `got ${back}`);
      }
      check(`${id}: encode is monotonic across the range`, monotonic);

      // 3. Out-of-range rejection.
      let threwLow = false;
      try { schema.encode(lo - Math.max(Math.abs(span) * 0.5, 1)); } catch { threwLow = true; }
      check(`${id}: encode below display_min throws`, threwLow);
      let threwHigh = false;
      try { schema.encode(hi + Math.max(Math.abs(span) * 0.5, 1)); } catch { threwHigh = true; }
      check(`${id}: encode above display_max throws`, threwHigh);
    }
  }

  return { label, calibratedCount };
}

console.log('Gen-3 (modern Fractal) display-first round-trip gate:\n');

const results = [AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR].map(verifyDevice);

for (const r of results) {
  console.log(`  ${r.label}: ${r.calibratedCount} display-first calibrated params`);
}

// Coverage: the III catalog carries hardware-anchored AM4-joined ranges, so
// it must ship a meaningful number of calibrated params — this proves the
// A4/A5 wiring is live. FM3/FM9 are reported but not yet required (their
// ranges fill in with the A7 overlay; this gate then covers them too).
const iii = results.find((r) => r.label.toLowerCase().includes('iii'));
check(
  'Axe-Fx III ships a non-zero count of display-first calibrated params',
  (iii?.calibratedCount ?? 0) > 50,
  `got ${iii?.calibratedCount ?? 0}`,
);

if (failures === 0) {
  console.log('\n✓ PASS — gen-3 display-first round-trip holds for every calibrated param.');
} else {
  console.error(`\n✗ FAIL — ${failures} display-first check(s) failed.`);
  process.exit(1);
}
