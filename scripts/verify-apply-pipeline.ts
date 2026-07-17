// verify-apply-pipeline.ts
//
// Integration test for the full apply_preset value pipeline on Axe-Fx II.
// Exercises: display value -> resolveDisplayValue (pass-through for
// numbers) -> buildApplyPresetAtOps() (no wire flag, display-direct
// path) -> buildSetBlockParameterValue(displayFloat) -> fn=0x2e SysEx
// with float32 septets -> decoded float32 matches original display value.
//
// Since fn=0x2e takes display floats directly, the pipeline no longer
// performs a display->wire->display round-trip. Display values flow
// straight from the PresetSpec through to the fn=0x2e builder.
//
// Run:
//   npx tsx scripts/verify-apply-pipeline.ts
//
// Status: offline, no hardware required.

import { registerParamKindResolver } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { resolveAxeFxIIParamKind } from '@mcp-midi-control/fractal-gen2/calibration.js';

// Register the Axe-Fx II param-kind resolver before any encode/decode
// calls. In production the descriptor module does this at import time;
// in this standalone script we must do it explicitly.
registerParamKindResolver('axe-fx-ii', resolveAxeFxIIParamKind);

import {
  buildApplyPresetAtOps,
  type ApplyPresetAtOp,
} from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';
import { translateSpec } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function hex(bs: number[]): string {
  return bs.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// ── Float32 decode from fn=0x2e SysEx bytes ──────────────────────────
//
// fn=0x2e SET_PARAM_DIRECT envelope:
//   F0 00 01 74 07 2e [eff_lo] [eff_hi] [param_lo] [param_hi]
//   [s0] [s1] [s2] [s3] [s4] [cs] F7
//
// The 5 septets at bytes[10..14] encode a float32 LE value as a 32-bit
// integer split into 7-bit groups from LSB:
//   n = s0 | (s1 << 7) | (s2 << 14) | (s3 << 21) | (s4 << 28)
// Then reinterpret n as a float32 LE.

function decodeFloat32FromSysEx(bytes: number[]): number {
  if (bytes.length < 17) {
    throw new Error(`SysEx too short for fn=0x2e: ${bytes.length} bytes`);
  }
  if (bytes[5] !== 0x2e) {
    throw new Error(`Expected fn=0x2e, got 0x${bytes[5].toString(16)}`);
  }
  const s0 = bytes[10];
  const s1 = bytes[11];
  const s2 = bytes[12];
  const s3 = bytes[13];
  const s4 = bytes[14];
  const n = (s0 & 0x7f)
    | ((s1 & 0x7f) << 7)
    | ((s2 & 0x7f) << 14)
    | ((s3 & 0x7f) << 21)
    | (((s4 & 0x0f) << 28) >>> 0);
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, n, true);
  return new DataView(buf).getFloat32(0, true);
}

// ── Test cases ───────────────────────────────────────────────────────
//
// Each case specifies a block, param, display value, and the expected
// decoded float32 from the SysEx bytes. The pipeline is:
//
//   1. Build a PresetSpec with the display value
//   2. translateSpec resolves display values (passes numbers through,
//      resolves enum strings to indices)
//   3. buildApplyPresetAtOps() (display-direct path, no wire flag)
//      stores display value in pp.displayValue, passes it to
//      buildSetBlockParameterValue which encodes as float32
//   4. Decode the float32 from the SysEx and compare to original display

interface TestCase {
  label: string;
  blockType: string;
  effectId: number;
  paramName: string;
  displayValue: number;
  tolerance: number;
}

const TEST_CASES: TestCase[] = [
  {
    label: 'Linear 0..10 knob (amp.input_drive = 5.5)',
    blockType: 'amp',
    effectId: 106,
    paramName: 'input_drive',
    displayValue: 5.5,
    tolerance: 0.01,
  },
  {
    label: 'Percent 0..100 knob (reverb.mix = 30)',
    blockType: 'reverb',
    effectId: 110,
    paramName: 'mix',
    displayValue: 30,
    tolerance: 0.01,
  },
  {
    label: 'Bipolar -100..+100 knob (amp.balance = -50)',
    blockType: 'amp',
    effectId: 106,
    paramName: 'balance',
    displayValue: -50,
    tolerance: 0.02,
  },
  {
    label: 'dB -80..+20 knob (cab.level = -3)',
    blockType: 'cab',
    effectId: 102,
    paramName: 'level',
    displayValue: -3,
    tolerance: 0.02,
  },
  {
    label: 'Log10 10..1000 Hz knob (amp.preamp_low_cut = 100)',
    blockType: 'amp',
    effectId: 106,
    paramName: 'preamp_low_cut',
    displayValue: 100,
    tolerance: 0.5,
  },
];

// ── Pipeline driver ──────────────────────────────────────────────────

for (const tc of TEST_CASES) {
  // Step 1: Build a PresetSpec with the display value.
  const spec: PresetSpec = {
    slots: [
      {
        slot: 2,
        block_type: tc.blockType,
        params: { [tc.paramName]: tc.displayValue },
      },
    ],
  };

  // Step 2: translateSpec resolves display values (pass-through for numbers).
  let translated: ReturnType<typeof translateSpec>;
  try {
    translated = translateSpec(spec);
  } catch (err) {
    check(tc.label + ' -- translateSpec', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  // Verify the translated block params are display values (not wire integers).
  // With the display-direct path, numeric display values pass through as-is.
  const translatedBlock = translated.blocks[0];
  const translatedValue = translatedBlock.params?.[tc.paramName];
  check(
    tc.label + ' -- translated value is display value',
    translatedValue !== undefined && translatedValue === tc.displayValue,
    `translatedValue=${translatedValue}, expected=${tc.displayValue}`,
  );

  // Step 3: buildApplyPresetAtOps (display-direct path, no wire flag).
  let ops: ApplyPresetAtOp[];
  try {
    ops = buildApplyPresetAtOps(
      { preset_number: 0, ...translated },
    );
  } catch (err) {
    check(tc.label + ' -- buildApplyPresetAtOps', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  // Step 4: Find the param op in the sequence.
  const paramOps = ops.filter((op) => op.kind === 'param');
  check(
    tc.label + ' -- has param op',
    paramOps.length >= 1,
    `found ${paramOps.length} param ops`,
  );
  if (paramOps.length === 0) continue;

  // Find the specific param op for this test case.
  const paramOp = paramOps.find((op) =>
    op.summary.includes(tc.paramName),
  );
  check(
    tc.label + ' -- found matching param op',
    paramOp !== undefined,
    `summaries: ${paramOps.map((op) => op.summary).join('; ')}`,
  );
  if (!paramOp) continue;

  // Step 5: Verify the SysEx uses fn=0x2e (SET_PARAM_DIRECT).
  check(
    tc.label + ' -- uses fn=0x2e',
    paramOp.bytes[5] === 0x2e,
    `fn=0x${paramOp.bytes[5]?.toString(16)}`,
  );

  // Step 6: Decode the float32 from the SysEx bytes.
  let decodedFloat: number;
  try {
    decodedFloat = decodeFloat32FromSysEx(paramOp.bytes);
  } catch (err) {
    check(tc.label + ' -- decodeFloat32', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  // Step 7: Assert the decoded float32 matches the original display value.
  const diff = Math.abs(decodedFloat - tc.displayValue);
  check(
    tc.label + ' -- float32 matches display',
    diff <= tc.tolerance,
    `display=${tc.displayValue}, decoded=${decodedFloat}, diff=${diff.toFixed(6)}, tolerance=${tc.tolerance}`,
  );
}

// ── Edge case: zero-value param ──────────────────────────────────────
//
// Display 0 on a 0..10 knob should encode to float32 0.0 in the SysEx.

{
  const spec: PresetSpec = {
    slots: [
      {
        slot: 2,
        block_type: 'amp',
        params: { bass: 0 },
      },
    ],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps(
    { preset_number: 0, ...translated },
  );
  const paramOps = ops.filter((op) => op.kind === 'param' && op.summary.includes('bass'));
  check('Zero-value (amp.bass=0) -- has param op', paramOps.length === 1);
  if (paramOps.length === 1) {
    const decoded = decodeFloat32FromSysEx(paramOps[0].bytes);
    check('Zero-value (amp.bass=0) -- float32 is 0.0', Math.abs(decoded) < 0.001, `decoded=${decoded}`);
  }
}

// ── Edge case: max-value param ───────────────────────────────────────
//
// Display 10.0 on a 0..10 knob should encode to float32 10.0 in the SysEx.

{
  const spec: PresetSpec = {
    slots: [
      {
        slot: 2,
        block_type: 'amp',
        params: { bass: 10 },
      },
    ],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps(
    { preset_number: 0, ...translated },
  );
  const paramOps = ops.filter((op) => op.kind === 'param' && op.summary.includes('bass'));
  check('Max-value (amp.bass=10) -- has param op', paramOps.length === 1);
  if (paramOps.length === 1) {
    const decoded = decodeFloat32FromSysEx(paramOps[0].bytes);
    check('Max-value (amp.bass=10) -- float32 is 10.0', Math.abs(decoded - 10) < 0.01, `decoded=${decoded}`);
  }
}

// ── Multi-block spec ─────────────────────────────────────────────────
//
// Verify that a multi-block preset spec encodes ALL params correctly,
// not just the first block's params.

{
  const spec: PresetSpec = {
    slots: [
      {
        slot: 2,
        block_type: 'amp',
        params: { input_drive: 7.0 },
      },
      {
        slot: 3,
        block_type: 'cab',
        params: { level: -10 },
      },
    ],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps(
    { preset_number: 0, ...translated },
  );

  const driveOps = ops.filter((op) => op.kind === 'param' && op.summary.includes('input_drive'));
  check('Multi-block -- amp.input_drive param op exists', driveOps.length === 1);
  if (driveOps.length === 1) {
    const decoded = decodeFloat32FromSysEx(driveOps[0].bytes);
    check('Multi-block -- amp.input_drive float32 matches 7.0', Math.abs(decoded - 7.0) < 0.01, `decoded=${decoded}`);
  }

  // Exact-name match: BK-103c injects cab-polish defaults (incl. room_level)
  // on a fresh cab-bearing build, so a loose includes('level') would also
  // catch the injected 'Cab 1.room_level' write.
  const levelOps = ops.filter((op) => op.kind === 'param' && op.summary.startsWith('Cab 1.level '));
  check('Multi-block -- cab.level param op exists', levelOps.length === 1);
  if (levelOps.length === 1) {
    const decoded = decodeFloat32FromSysEx(levelOps[0].bytes);
    check('Multi-block -- cab.level float32 matches -10', Math.abs(decoded - (-10)) < 0.02, `decoded=${decoded}`);
  }
}

// ── Regression guard: raw wire integer detection ─────────────────────
//
// If someone reverts the fn=0x2e fix and passes wire integers directly
// to buildSetBlockParameterValue (which expects display floats), the
// float32 in the SysEx would be the wire integer (e.g. 36044 instead
// of 5.5). This test builds a known-calibrated param, encodes display
// -> wire, then verifies the fn=0x2e SysEx does NOT contain the wire
// integer as its float32 value.

{
  const kind = resolveParamKind('axe-fx-ii', 'amp', 'input_drive');
  check('Regression guard -- resolver has encodeDisplay', kind.encodeDisplay !== undefined);
  if (kind.encodeDisplay) {
    const wireFor5_5 = kind.encodeDisplay(5.5);
    check('Regression guard -- wire(5.5) is integer', Number.isInteger(wireFor5_5), `wire=${wireFor5_5}`);
    check('Regression guard -- wire(5.5) != 5.5', wireFor5_5 !== 5.5, `wire should differ from display`);

    // Run the full translateSpec -> buildApplyPresetAtOps pipeline.
    const spec: PresetSpec = {
      slots: [{
        slot: 2,
        block_type: 'amp',
        params: { input_drive: 5.5 },
      }],
    };
    const translated = translateSpec(spec);
    const ops = buildApplyPresetAtOps({ preset_number: 0, ...translated });
    const paramOps = ops.filter((op) => op.kind === 'param' && op.summary.includes('input_drive'));
    check('Regression guard -- has param op', paramOps.length === 1);
    if (paramOps.length === 1) {
      const decoded = decodeFloat32FromSysEx(paramOps[0].bytes);
      // The decoded float32 should be the display value 5.5, NOT the
      // wire integer ~36044. If the fix is reverted, decoded would be
      // the wire integer and this check would fail.
      const diffFromWire = Math.abs(decoded - wireFor5_5);
      check(
        'Regression guard -- SysEx float32 is NOT the wire integer',
        diffFromWire > 1.0,
        `decoded=${decoded}, wire=${wireFor5_5}; if these are close, ` +
        `wire integers are leaking into the fn=0x2e float32 encoder`,
      );
    }
  }
}

// ── Enum param routing: enum/select params use fn=0x02 ──────────────
//
// Enum params (effect_type, bypass_mode, sidechain, etc.) must route
// through fn=0x02 (integer wire value), not fn=0x2e (float display).
// Hardware-confirmed 2026-05-26: fn=0x2e no-ops for compressor.effect_type.

{
  const spec: PresetSpec = {
    slots: [{
      slot: 2,
      block_type: 'compressor',
      params: { effect_type: 1 },
    }],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps({ preset_number: 0, ...translated });
  const paramOps = ops.filter((op) => op.kind === 'param' && op.summary.includes('effect_type'));
  check('Enum routing -- compressor.effect_type has param op', paramOps.length === 1);
  if (paramOps.length === 1) {
    check(
      'Enum routing -- compressor.effect_type uses fn=0x02 (not fn=0x2e)',
      paramOps[0].bytes[5] === 0x02,
      `fn=0x${paramOps[0].bytes[5]?.toString(16)}`,
    );
    const wireVal = (paramOps[0].bytes[10] & 0x7f)
      | ((paramOps[0].bytes[11] & 0x7f) << 7)
      | ((paramOps[0].bytes[12] & 0x03) << 14);
    check(
      'Enum routing -- wire value is integer 1',
      wireVal === 1,
      `wireVal=${wireVal}`,
    );
  }
}

{
  const spec: PresetSpec = {
    slots: [{
      slot: 2,
      block_type: 'amp',
      params: { effect_type: 31 },
    }],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps({ preset_number: 0, ...translated });
  const paramOps = ops.filter((op) => op.kind === 'param' && op.summary.includes('effect_type'));
  check('Enum routing -- amp.effect_type has param op', paramOps.length === 1);
  if (paramOps.length === 1) {
    check(
      'Enum routing -- amp.effect_type uses fn=0x02',
      paramOps[0].bytes[5] === 0x02,
      `fn=0x${paramOps[0].bytes[5]?.toString(16)}`,
    );
  }
}

{
  const spec: PresetSpec = {
    slots: [{
      slot: 2,
      block_type: 'compressor',
      params: { mix: 80 },
    }],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps({ preset_number: 0, ...translated });
  const paramOps = ops.filter((op) => op.kind === 'param' && op.summary.includes('mix'));
  check('Enum routing -- compressor.mix (knob) uses fn=0x2e', paramOps.length === 1);
  if (paramOps.length === 1) {
    check(
      'Enum routing -- compressor.mix fn byte is 0x2e',
      paramOps[0].bytes[5] === 0x2e,
      `fn=0x${paramOps[0].bytes[5]?.toString(16)}`,
    );
  }
}

// ── Bypass routing: bypass ops use fn=0x02 ──────────────────────────
{
  const spec: PresetSpec = {
    slots: [
      { slot: 2, block_type: 'amp', bypassed: true },
      { slot: 3, block_type: 'drive' },
    ],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps({ preset_number: 0, ...translated });
  const bypassOps = ops.filter((op) => op.kind === 'bypass');
  check('Bypass routing -- has bypass op', bypassOps.length >= 1);
  if (bypassOps.length >= 1) {
    check(
      'Bypass routing -- bypass uses fn=0x02',
      bypassOps[0].bytes[5] === 0x02,
      `fn=0x${bypassOps[0].bytes[5]?.toString(16)}`,
    );
    check(
      'Bypass routing -- paramId=255',
      bypassOps[0].bytes[8] === 0x7f && bypassOps[0].bytes[9] === 0x01,
      `paramId bytes: 0x${bypassOps[0].bytes[8]?.toString(16)} 0x${bypassOps[0].bytes[9]?.toString(16)}`,
    );
  }
}

{
  const spec: PresetSpec = {
    slots: [
      { slot: 2, block_type: 'amp', id: 'amp' },
      { slot: 3, block_type: 'drive', id: 'drive' },
    ],
    scenes: [
      { scene: 1, channels: {}, bypassed: { drive: true } },
      { scene: 2, channels: {}, bypassed: { amp: true } },
    ],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetAtOps({ preset_number: 0, ...translated });
  const sceneBypassOps = ops.filter((op) => op.kind === 'bypass' && op.summary.includes('scene'));
  check('Scene bypass -- has per-scene bypass ops', sceneBypassOps.length >= 2);
  for (const op of sceneBypassOps) {
    check(
      `Scene bypass -- "${op.summary}" uses fn=0x02`,
      op.bytes[5] === 0x02,
      `fn=0x${op.bytes[5]?.toString(16)}`,
    );
  }
}

// ── Report ───────────────────────────────────────────────────────────

if (failures === 0) {
  process.exit(0);
}
console.error(`\nverify-apply-pipeline: ${failures} failure(s).`);
process.exit(1);
