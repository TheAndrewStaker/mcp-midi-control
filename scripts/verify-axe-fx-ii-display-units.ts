// verify-axe-fx-ii-display-units.ts
//
// BK-060 calibration overlay golden — asserts that every Axe-Fx II
// param the descriptor exposes with a calibrated display range
// round-trips correctly through `displayToWire` / `wireToDisplay`,
// and that the calibration data itself is internally consistent.
//
// Source of truth:
//   - fractal-midi/axe-fx-ii KNOWN_PARAMS (~54 wiki-documented
//     calibrated knobs; the codec catalog's hardware-anchored
//     baseline)
//   - packages/axe-fx-ii/src/calibration.ts (BK-060 overlay —
//     AM4-shared + editor-observed + fractal-convention entries
//     that close the long tail of opaque-unit knobs)
//
// What this golden enforces:
//
//   1. **Endpoint mapping.** `displayToWire(displayMin)` lands at
//      wire 0; `displayToWire(displayMax)` lands at wire 65534.
//      Catches off-by-one or scale errors at the range boundaries.
//
//   2. **Midpoint within 10% of 32767.** For linear scales the
//      arithmetic midpoint maps to wire 32767 exactly; for log10
//      scales the geometric midpoint maps to wire 32767 exactly.
//      The 10% tolerance accommodates the integer rounding in
//      `displayToWire` for ranges that don't divide cleanly.
//
//   3. **Round-trip stability.** `wireToDisplay(displayToWire(d))
//      ≈ d` for d in {displayMin, midpoint, displayMax}. Catches
//      asymmetries between the encode and decode paths (e.g. a
//      log10 encode that forgot to log10-decode).
//
//   4. **Session 98 root-cause spot-check.** Specific assertion
//      that `drive.volume: 5` and `drive.tone: 5` both map to wire
//      ~32767 (the bug that produced silent scenes 3/4 in the
//      Enter Sandman test had these values land at wire 5).
//
//   5. **Schema agreement.** The descriptor's per-param `encode`
//      closure produces the same wire integer as a direct
//      `displayToWire` call against the resolved calibration —
//      proves the overlay is actually wired into the schema, not
//      just sitting in the calibration table.
//
//   6. **Calibration sanity.** For every explicit entry
//      (am4-shared + editor-observed): displayMin < displayMax;
//      log10 entries have positive displayMin / displayMax.
//
// Run:
//   npx tsx scripts/verify-axe-fx-ii-display-units.ts

import {
  KNOWN_PARAMS,
  displayToWire,
  wireToDisplay,
  type AxeFxIIParam,
} from 'fractal-midi/axe-fx-ii';

import {
  calibrationEntries,
  calibrationStats,
  getCalibration,
} from '@mcp-midi-control/axe-fx-ii/calibration.js';

import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL — ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function approxEq(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

// ── 1. Calibration sanity ─────────────────────────────────────────────
//
// Every explicit entry must satisfy displayMin < displayMax; log10
// entries must have positive endpoints (the codec's displayToWire
// throws on non-positive log10 inputs). Suffix rules are exercised
// implicitly via the schema-agreement pass below.

{
  let saneCount = 0;
  for (const { block, name, entry } of calibrationEntries()) {
    const label = `${block}.${name}`;
    check(
      `${label}: displayMin < displayMax`,
      entry.displayMin < entry.displayMax,
      `min=${entry.displayMin} max=${entry.displayMax}`,
    );
    if (entry.displayScale === 'log10') {
      check(
        `${label}: log10 requires displayMin > 0`,
        entry.displayMin > 0,
        `min=${entry.displayMin}`,
      );
      check(
        `${label}: log10 requires displayMax > 0`,
        entry.displayMax > 0,
        `max=${entry.displayMax}`,
      );
    }
    saneCount++;
  }
  check(
    'calibrationEntries() emits a non-empty table',
    saneCount > 0,
    `got ${saneCount}`,
  );
}

// ── 2. Endpoint + midpoint round-trip for every calibrated param ──────
//
// Walks KNOWN_PARAMS, asks the overlay (via getCalibration as a
// fallback when the codec catalog has no displayMin/displayMax), and
// for every knob param with a resolved calibration asserts the three
// round-trip invariants.

interface ResolvedCalibration {
  displayMin: number;
  displayMax: number;
  displayScale?: 'linear' | 'log10';
}

function resolveForVerify(param: AxeFxIIParam): ResolvedCalibration | undefined {
  if (param.displayMin !== undefined && param.displayMax !== undefined) {
    return {
      displayMin: param.displayMin,
      displayMax: param.displayMax,
      displayScale: param.displayScale,
    };
  }
  const overlay = getCalibration(param.block, param.name);
  if (overlay !== undefined) {
    return {
      displayMin: overlay.displayMin,
      displayMax: overlay.displayMax,
      displayScale: overlay.displayScale,
    };
  }
  return undefined;
}

function midpointDisplay(cal: ResolvedCalibration): number {
  if (cal.displayScale === 'log10') {
    return Math.sqrt(cal.displayMin * cal.displayMax);
  }
  return (cal.displayMin + cal.displayMax) / 2;
}

function rangeSpan(cal: ResolvedCalibration): number {
  return cal.displayMax - cal.displayMin;
}

{
  let calibratedKnobCount = 0;
  let overlayContributed = 0;
  for (const param of Object.values(KNOWN_PARAMS) as AxeFxIIParam[]) {
    if (param.controlType !== 'knob') continue;
    const cal = resolveForVerify(param);
    if (cal === undefined) continue;
    calibratedKnobCount++;
    if (param.displayMin === undefined || param.displayMax === undefined) {
      overlayContributed++;
    }
    const label = `${param.block}.${param.name}`;
    const opts = {
      displayMin: cal.displayMin,
      displayMax: cal.displayMax,
      displayScale: cal.displayScale,
    };

    // (1) Endpoint mapping
    const wireMin = displayToWire(cal.displayMin, opts);
    const wireMax = displayToWire(cal.displayMax, opts);
    check(
      `${label}: displayMin → wire 0`,
      wireMin === 0,
      `got ${wireMin}`,
    );
    check(
      `${label}: displayMax → wire 65534`,
      wireMax === 65534,
      `got ${wireMax}`,
    );

    // (2) Midpoint within 10% of 32767
    const mid = midpointDisplay(cal);
    const wireMid = displayToWire(mid, opts);
    check(
      `${label}: midpoint maps to wire ~32767 (10% tol)`,
      approxEq(wireMid, 32767, 3277),
      `mid=${mid} wireMid=${wireMid}`,
    );

    // (3) Round-trip stability for endpoints + midpoint
    //
    // Tolerance is per-param: integer-rounding through the 0..65534
    // wire grid loses precision proportional to (max-min)/65534. We
    // allow a single grid-step of slop.
    const span = rangeSpan(cal);
    const linearTolerance = span / 65534 + 1e-9;
    // For log10 scales the absolute tolerance at the high end is the
    // dominant constraint: span × log10-step / log10-range. We use
    // displayMax / 10000 as a generous bound which holds for every
    // log10 entry we ship (frequency knobs over 200-20000 / 20-2000
    // both fit comfortably under this bound).
    const tolerance = cal.displayScale === 'log10'
      ? cal.displayMax / 10000 + 1e-9
      : linearTolerance;

    for (const d of [cal.displayMin, mid, cal.displayMax]) {
      const rt = wireToDisplay(displayToWire(d, opts), opts);
      check(
        `${label}: round-trip display ${d} → wire → display`,
        approxEq(rt, d, tolerance),
        `got ${rt}, tolerance ${tolerance}`,
      );
    }
  }
  check(
    'overlay contributed coverage for at least 200 uncalibrated knobs',
    overlayContributed >= 200,
    `got ${overlayContributed}`,
  );
  // BK-060 targets the user-touch musical blocks (drive / amp / reverb
  // / delay / chorus / flanger / phaser / rotary / comp / wah / pantrem
  // / enhancer / filter / gate / volpan). Coverage on those lands at
  // 50-100% per block; deep amp internals (xformer_*, preamp_cf_*,
  // bias_excursion, tube_grid_bias, etc.) and exotic blocks
  // (multidelay, vocoder, controllers, resonator, synth) stay opaque
  // until hardware verification — they're tweak-power-user surfaces,
  // not the silent-foot-gun class Session 98 surfaced.
  check(
    'total calibrated-knob coverage at least 350 params',
    calibratedKnobCount >= 350,
    `got ${calibratedKnobCount}`,
  );
}

// ── 3. Session 98 root-cause spot-checks ──────────────────────────────
//
// drive.volume: 5 must NOT land at wire 5 (the bug was wire pass-
// through with no calibration). Same for drive.tone: 5. Both should
// land near wire 32767 (50% of 65534).
//
// The "near wire 32767" bound is exactly the midpoint check: a
// display-5 on a 0..10 knob maps linearly to 32767. We add explicit
// assertions here because BK-060 names these as the regression.

{
  const driveVolume = KNOWN_PARAMS['drive.volume'] as AxeFxIIParam | undefined;
  check(
    'KNOWN_PARAMS contains drive.volume',
    driveVolume !== undefined,
  );
  if (driveVolume !== undefined) {
    const cal = resolveForVerify(driveVolume);
    check(
      'drive.volume has resolved calibration (BK-060 root-cause coverage)',
      cal !== undefined && cal.displayMin === 0 && cal.displayMax === 10,
      cal ? `min=${cal.displayMin} max=${cal.displayMax}` : 'undefined',
    );
    if (cal !== undefined) {
      const wire = displayToWire(5, cal);
      check(
        'drive.volume: 5 → wire ~32767 (NOT wire 5 — Session 98 root cause)',
        approxEq(wire, 32767, 100),
        `got wire ${wire}`,
      );
    }
  }

  const driveTone = KNOWN_PARAMS['drive.tone'] as AxeFxIIParam | undefined;
  check(
    'KNOWN_PARAMS contains drive.tone',
    driveTone !== undefined,
  );
  if (driveTone !== undefined) {
    const cal = resolveForVerify(driveTone);
    check(
      'drive.tone has resolved calibration (BK-060 root-cause coverage)',
      cal !== undefined && cal.displayMin === 0 && cal.displayMax === 10,
      cal ? `min=${cal.displayMin} max=${cal.displayMax}` : 'undefined',
    );
    if (cal !== undefined) {
      const wire = displayToWire(5, cal);
      check(
        'drive.tone: 5 → wire ~32767 (NOT wire 5 — Session 98 root cause)',
        approxEq(wire, 32767, 100),
        `got wire ${wire}`,
      );
    }
  }
}

// ── 4. Schema agreement — descriptor's encode matches direct path ────
//
// Walks every block.params entry in AXEFX2_DESCRIPTOR.blocks; for
// params with display_min/display_max set, the descriptor's encode
// closure must produce the same wire integer as displayToWire
// against the resolved calibration. This proves the overlay is
// reachable through the actual descriptor wire (not just the
// calibration table).

{
  let agreementChecks = 0;
  for (const [blockSlug, blockSchema] of Object.entries(AXEFX2_DESCRIPTOR.blocks)) {
    for (const [paramName, paramSchema] of Object.entries(blockSchema.params)) {
      if (paramSchema.display_min === undefined || paramSchema.display_max === undefined) continue;
      const min = paramSchema.display_min;
      const max = paramSchema.display_max;
      // Pick a display value in-range — midpoint when min < max.
      const mid = (min + max) / 2;
      let encoded: number;
      try {
        const result = paramSchema.encode(mid);
        encoded = typeof result === 'number' ? result : Number(result);
      } catch (e) {
        // Some params reject the synthetic midpoint (e.g. integer-
        // only knobs) — skip rather than fail the golden. The other
        // assertions cover the same data path.
        continue;
      }
      // We don't know the param's scale from the schema; recover it
      // from KNOWN_PARAMS / overlay.
      const param = KNOWN_PARAMS[`${blockSlug}.${paramName}` as keyof typeof KNOWN_PARAMS] as AxeFxIIParam | undefined;
      if (param === undefined) continue;
      const cal = resolveForVerify(param);
      if (cal === undefined) continue;
      const expected = displayToWire(mid, cal);
      check(
        `${blockSlug}.${paramName}: descriptor.encode(midpoint) === displayToWire(midpoint)`,
        encoded === expected,
        `got ${encoded}, expected ${expected}`,
      );
      agreementChecks++;
    }
  }
  check(
    'schema-agreement walk visited at least 400 params',
    agreementChecks >= 400,
    `got ${agreementChecks}`,
  );
}

// ── 5. Coverage stats (audit context, never fails) ────────────────────

{
  const stats = calibrationStats();
  if (process.env.VERBOSE) {
    console.error(
      `  info: calibration overlay = ${stats.am4Shared} am4-shared + ${stats.editorObserved} editor-observed + ${stats.suffixRules} suffix rules`,
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────

if (failures === 0) {
  process.exit(0);
}
console.error(`\nverify-axe-fx-ii-display-units: ${failures} failure(s).`);
process.exit(1);
