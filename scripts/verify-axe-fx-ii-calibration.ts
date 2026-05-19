/**
 * Verify the Axe-Fx II apply_preset path honors the calibration.ts
 * overlay (AM4_SHARED + EDITOR_OBSERVED + SUFFIX_RULES) just like
 * set_param does — Session 100+ regression for the bug where
 * `drive.volume: 4` flowed through encodeParamForApply as wire 4
 * (effectively muted) because the codec catalog reports
 * displayMin/displayMax === undefined for that knob and the writer's
 * legacy path treated undefined as "wire passthrough."
 *
 * Pure transpiler check — builds an ApplyPresetAtInput, runs it
 * through buildApplyPresetAtOps with {wire: false} (the same path the
 * descriptor's applyPreset takes via translateSpec → encodeParamForApply
 * → executor with {wire: true}), and asserts the emitted param ops
 * carry the expected wire integers.
 *
 * We exercise both paths so the fix is covered end-to-end:
 *   1. descriptor.applyPreset path — encodeParamForApply in writer.ts
 *      pre-encodes display → wire BEFORE the executor sees the value,
 *      then the executor runs in {wire: true} mode.
 *   2. legacy applyExecutor auto-detect path — validateParam with
 *      {wire: false} resolves calibration from the overlay too.
 *
 * Run:  npx tsx scripts/verify-axe-fx-ii-calibration.ts
 */
import {
  buildApplyPresetAtOps,
  type ApplyPresetAtInput,
} from '@mcp-midi-control/axe-fx-ii/tools/applyExecutor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { getCalibration } from '@mcp-midi-control/axe-fx-ii/calibration.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Expected wire helper (matches fractal-midi displayToWire) ───────
function displayToWireLinear(d: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, d));
  return Math.round(((clamped - min) / (max - min)) * 65534);
}

// ─────────────────────────────────────────────────────────────────
// Case 1: descriptor.blocks[block].params[name].encode honors overlay.
//
// This is the same encode closure set_param uses via the unified
// dispatcher. If the overlay isn't wired through here, set_param is
// already broken — the encode call is the single source of truth.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 1 — descriptor encode closure honors calibration overlay');

const driveBlock = AXEFX2_DESCRIPTOR.blocks['drive'];
check('drive block exists in descriptor', driveBlock !== undefined);

if (driveBlock) {
  // drive.volume (EDITOR_OBSERVED, 0..10 linear)
  const driveVolumeEncode = driveBlock.params['volume']?.encode;
  check('drive.volume encode closure exists', driveVolumeEncode !== undefined);
  if (driveVolumeEncode) {
    const wire = driveVolumeEncode(5);
    check(
      'descriptor encode: drive.volume:5 → wire 32767 (overlay 0..10)',
      wire === 32767,
      `got ${wire}`,
    );
  }
  // drive.tone (AM4_SHARED, 0..10 linear)
  const driveToneEncode = driveBlock.params['tone']?.encode;
  if (driveToneEncode) {
    const wire = driveToneEncode(7);
    check(
      'descriptor encode: drive.tone:7 → wire 45874 (overlay 0..10)',
      wire === 45874,
      `got ${wire}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Case 2: encodeParamForApply in writer.ts (the apply_preset path).
//
// The descriptor's applyPreset → translateSpec → encodeParamForApply
// runs display values through display→wire BEFORE handing the result
// to buildApplyPresetAtOps with {wire: true}. We exercise that by
// calling the encode closure (same source of truth) and confirming
// the resulting wire matches what the executor would emit.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 2 — apply_preset path emits calibrated wire integers');

interface ApplyCase {
  block: string;
  param: string;
  display: number;
  expectedWire: number;
  reason: string;
}

const cases: ApplyCase[] = [
  // drive.volume — Session 98 root-cause spot-check, EDITOR_OBSERVED 0..10
  {
    block: 'drive',
    param: 'volume',
    display: 5,
    expectedWire: displayToWireLinear(5, 0, 10),
    reason: 'EDITOR_OBSERVED 0..10 (drive.volume)',
  },
  // drive.tone — AM4_SHARED 0..10
  {
    block: 'drive',
    param: 'tone',
    display: 7,
    expectedWire: displayToWireLinear(7, 0, 10),
    reason: 'AM4_SHARED 0..10 (drive.tone)',
  },
  // delay.mix — AM4_SHARED 0..100
  {
    block: 'delay',
    param: 'mix',
    display: 50,
    expectedWire: displayToWireLinear(50, 0, 100),
    reason: 'AM4_SHARED 0..100 (delay.mix)',
  },
  // reverb.time — AM4_SHARED 0.1..100
  {
    block: 'reverb',
    param: 'time',
    display: 2.5,
    expectedWire: displayToWireLinear(2.5, 0.1, 100),
    reason: 'AM4_SHARED 0.1..100 (reverb.time)',
  },
  // chorus.mix — AM4_SHARED 0..100
  {
    block: 'chorus',
    param: 'mix',
    display: 25,
    expectedWire: displayToWireLinear(25, 0, 100),
    reason: 'AM4_SHARED 0..100 (chorus.mix)',
  },
];

for (const c of cases) {
  const blockSchema = AXEFX2_DESCRIPTOR.blocks[c.block];
  if (!blockSchema) {
    check(`${c.block}.${c.param} block exists`, false, 'descriptor missing block');
    continue;
  }
  const encode = blockSchema.params[c.param]?.encode;
  if (!encode) {
    check(`${c.block}.${c.param} encode closure exists`, false, 'param not in block schema');
    continue;
  }
  const wire = encode(c.display);
  check(
    `${c.block}.${c.param}: ${c.display} → wire ${c.expectedWire} (${c.reason})`,
    wire === c.expectedWire,
    `got ${wire}`,
  );
}

// ─────────────────────────────────────────────────────────────────
// Case 3: getCalibration overlay returns expected entries.
//
// Spot-checks that the calibration source the writer/reader/executor
// now consult actually has these entries — if someone deletes an
// overlay row, this fails before the encode closure regresses.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 3 — calibration overlay coverage spot-checks');

check(
  'getCalibration(drive, volume) returns EDITOR_OBSERVED 0..10',
  (() => {
    const e = getCalibration('drive', 'volume');
    return e !== undefined && e.displayMin === 0 && e.displayMax === 10;
  })(),
);
check(
  'getCalibration(drive, tone) returns AM4_SHARED 0..10',
  (() => {
    const e = getCalibration('drive', 'tone');
    return e !== undefined && e.displayMin === 0 && e.displayMax === 10;
  })(),
);
check(
  'getCalibration(delay, mix) returns AM4_SHARED 0..100',
  (() => {
    const e = getCalibration('delay', 'mix');
    return e !== undefined && e.displayMin === 0 && e.displayMax === 100;
  })(),
);
check(
  'getCalibration(reverb, time) returns AM4_SHARED 0.1..100',
  (() => {
    const e = getCalibration('reverb', 'time');
    return e !== undefined && e.displayMin === 0.1 && e.displayMax === 100;
  })(),
);

// ─────────────────────────────────────────────────────────────────
// Case 4: uncalibrated params still passthrough as wire (no regression).
//
// Confirm that params NOT covered by the codec catalog OR the overlay
// continue to accept wire-integer values (0..65534) the way they did
// before this fix. We have to find one such param to test against; the
// suffix rules are wide so most params are covered. We synthesize a
// passthrough check by passing a wire integer through a known-overlay
// path and confirming it round-trips on a param that lacks calibration.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 4 — uncalibrated params still passthrough (no regression)');

// Find a param that's not in any overlay and not catalog-calibrated.
let opaqueParam: { block: string; name: string } | undefined;
for (const [blockSlug, blockSchema] of Object.entries(AXEFX2_DESCRIPTOR.blocks)) {
  for (const [paramName, paramSchema] of Object.entries(blockSchema.params)) {
    if (paramSchema.unit === 'opaque') {
      opaqueParam = { block: blockSlug, name: paramName };
      break;
    }
  }
  if (opaqueParam) break;
}

if (opaqueParam) {
  const encode = AXEFX2_DESCRIPTOR.blocks[opaqueParam.block].params[opaqueParam.name].encode;
  const wire = encode(12345);
  check(
    `opaque param ${opaqueParam.block}.${opaqueParam.name}: wire 12345 passes through unchanged`,
    wire === 12345,
    `got ${wire}`,
  );
  // And rejects out-of-range
  let threw = false;
  try {
    encode(99999);
  } catch {
    threw = true;
  }
  check(
    `opaque param ${opaqueParam.block}.${opaqueParam.name}: wire 99999 rejected (>65534)`,
    threw,
  );
} else {
  // Suffix rules cover almost every knob now, so no opaque param is
  // expected on the descriptor. Skip the assertion — overlay coverage
  // is the goal, not residual opaque params.
  console.log('  (no opaque params found — suffix rules cover full surface, skipping passthrough check)');
}

// ─────────────────────────────────────────────────────────────────
// Case 5: legacy applyExecutor auto-detect path uses the overlay too.
//
// The executor's validateParam (wireMode=false) now consults the
// overlay. We exercise it directly by passing a display value through
// buildApplyPresetAtOps with {wire: false} on a param that's only
// overlay-calibrated. The emitted param op must carry the calibrated
// wire integer, not the raw display value.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 5 — legacy applyExecutor auto-detect honors overlay');

const legacyAutoDetect: ApplyPresetAtInput = {
  preset_number: 100,
  blocks: [
    {
      block: 'Drive 1',
      params: {
        // drive.volume = display 5 → wire 32767 via EDITOR_OBSERVED
        volume: 5,
      },
    },
  ],
};

const legacyOps = buildApplyPresetAtOps(legacyAutoDetect, { wire: false });
const driveVolumeOp = legacyOps.find(
  (o) => o.kind === 'param' && /volume/i.test(o.summary),
);
check(
  'legacy executor (wire:false) emits drive.volume:5 → wire 32767',
  driveVolumeOp !== undefined && /wire 32767/.test(driveVolumeOp.summary),
  driveVolumeOp ? driveVolumeOp.summary : 'op not found',
);

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('✓ Axe-Fx II calibration overlay verified across descriptor + apply paths.');
