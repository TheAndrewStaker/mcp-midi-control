// verify-paramsbychannel-emission.ts
//
// Gated test: P3a-paramsbychannel-emission.
//
// Catches the "Y-channel effect_type does not land" regression class
// (BK-058) at the OP-EMISSION level, fully offline. The timing barrier
// (channel switch must commit before the param write) needs hardware to
// verify audibly, but the SHAPE of the emitted op stream is checkable
// here: a multi-channel block authored via channel-nested params MUST
// emit a SET_CHANNEL op for X then X's param ops, a SET_CHANNEL op for Y
// then Y's param ops, AND a DISTINCT effect_type op per channel.
//
// The exact pre-fix failure (Session 98 / Session 99): II's executor
// honored only the FIRST channel of paramsByChannel and silently dropped
// the rest. A build with {X:{effect_type:A}, Y:{effect_type:B}} would
// emit only the X effect_type op; Y's never reached the wire, so the Y
// channel kept A. AM4's same-shape executor walked all channels; the fix
// made II match. This test fails if II ever regresses to dropping the
// non-first channel, or if the two effect_type ops collapse to the same
// target.
//
// Pipeline exercised (the real unified-surface path, no hardware):
//   PresetSpec.slots[].params = {X:{...}, Y:{...}}  (channel-nested)
//     -> translateSpec()  resolves enum strings -> indices, builds
//        ApplyPresetInput.blocks[].paramsByChannel
//     -> buildApplyPresetAtOps()  emits the channel + param op stream
//     -> inspect ops[]: channel ordering + distinct fn=0x02 effect_type
//
// Run:
//   npx tsx scripts/verify-paramsbychannel-emission.ts
//
// Status: offline, no hardware required. Exits 0 on pass, non-zero on
// any failed assertion.

import { registerParamKindResolver } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { resolveAxeFxIIParamKind } from '@mcp-midi-control/fractal-gen2/calibration.js';

// Register the Axe-Fx II param-kind resolver before any encode/decode
// calls. In production the descriptor module does this at import time;
// in this standalone script we do it explicitly (same pattern as
// verify-apply-pipeline.ts).
registerParamKindResolver('axe-fx-ii', resolveAxeFxIIParamKind);

import {
  buildApplyPresetAtOps,
  type ApplyPresetAtOp,
} from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';
import { translateSpec } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { DRIVE_EFFECT_TYPE_VALUES } from 'fractal-midi/gen2/axe-fx-ii';

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

// ── fn=0x02 SET_BLOCK_PARAMETER (integer) envelope ───────────────────
//
// Enum / select params (effect_type, bypass_mode, ...) route through
// buildSetBlockParameterValueInteger which emits fn=0x02 with a
// 16-bit packed wire value:
//
//   F0 00 01 74 03 02 [eff_lo eff_hi] [param_lo param_hi]
//   [v0 v1 v2] [action] [cksum] F7
//
// fn byte at index 5 = 0x02. The enum wire index sits in the 3 value
// septets at bytes[10..12], LSB-first (matching verify-apply-pipeline's
// enum-routing decode).

const FN_BLOCK_PARAM = 0x02;

function decodeEnumWireFromFn02(bytes: number[]): number {
  return (bytes[10] & 0x7f) | ((bytes[11] & 0x7f) << 7) | ((bytes[12] & 0x03) << 14);
}

// ── Build the multi-channel spec ─────────────────────────────────────
//
// Drive is a channel-bearing block on Axe-Fx II (X/Y). We author two
// DISTINCT drive models per channel plus a per-channel knob, so the
// emission must keep the two channels' effect_type ops separate.
//
//   X: effect_type = "RAT DIST" (wire index 0), gain = 4
//   Y: effect_type = "T808 OD"  (wire index 6), gain = 7
//
// A != B is the heart of the regression: if Y's effect_type op is
// dropped or defaults to X's value, the assertion below catches it.

const TYPE_A = DRIVE_EFFECT_TYPE_VALUES[0]; // "RAT DIST"
const TYPE_B = DRIVE_EFFECT_TYPE_VALUES[6]; // "T808 OD"
const WIRE_A = 0;
const WIRE_B = 6;

check(
  'fixture: TYPE_A and TYPE_B are distinct enum labels',
  TYPE_A !== undefined && TYPE_B !== undefined && TYPE_A !== TYPE_B,
  `TYPE_A=${TYPE_A}, TYPE_B=${TYPE_B}`,
);

const spec: PresetSpec = {
  slots: [
    {
      slot: 2,
      block_type: 'drive',
      params: {
        X: { effect_type: TYPE_A, gain: 4 },
        Y: { effect_type: TYPE_B, gain: 7 },
      },
    },
  ],
};

// translateSpec turns channel-nested params into paramsByChannel and
// resolves enum strings to numeric indices.
let translated: ReturnType<typeof translateSpec>;
try {
  translated = translateSpec(spec);
} catch (err) {
  check('translateSpec(channel-nested drive)', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
  // Cannot proceed without a translation.
  finish();
  throw err;
}

const driveBlock = translated.blocks[0];
check(
  'translate: drive block carries paramsByChannel (not flat params)',
  driveBlock !== undefined
    && driveBlock.paramsByChannel !== undefined
    && driveBlock.params === undefined,
  `block=${JSON.stringify(driveBlock)}`,
);
check(
  'translate: paramsByChannel has BOTH X and Y (Y not dropped at translate)',
  driveBlock?.paramsByChannel?.X !== undefined && driveBlock?.paramsByChannel?.Y !== undefined,
  `paramsByChannel=${JSON.stringify(driveBlock?.paramsByChannel)}`,
);

// Build the op stream (working-buffer-only-style full build; we use the
// _at builder with a stub preset_number so we get the complete sequence).
let ops: ApplyPresetAtOp[] = [];
try {
  ops = buildApplyPresetAtOps({ preset_number: 0, ...translated });
} catch (err) {
  check('buildApplyPresetAtOps', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
}

// ── Extract the drive block's channel + param ops in emission order ──
//
// The clear/place/cable ops for the grid come first; the per-block
// channel + param ops come after. We filter to just channel + param ops
// and assert on their relative ordering. The per-scene walk's channel
// resets (H3: every scene is authored on a fresh build, flagged
// `unlistedSceneDefault`) come after and are out of scope here.

const chanAndParamOps = ops.filter((op) => (op.kind === 'channel' || op.kind === 'param') && op.unlistedSceneDefault !== true);

// Identify the two channel ops (carry expectedChannel) and the param ops.
const channelOps = chanAndParamOps.filter((op) => op.kind === 'channel');
const paramOps = chanAndParamOps.filter((op) => op.kind === 'param');

check(
  'emission: exactly two SET_CHANNEL ops (one per channel)',
  channelOps.length === 2,
  `got ${channelOps.length}: [${channelOps.map((o) => o.expectedChannel).join(', ')}]`,
);

check(
  'emission: SET_CHANNEL ops target X then Y in order',
  channelOps.length === 2
    && channelOps[0].expectedChannel === 'X'
    && channelOps[1].expectedChannel === 'Y',
  `order=[${channelOps.map((o) => o.expectedChannel).join(', ')}]`,
);

// effect_type ops, tagged with their owning channel via the summary
// (the executor formats channel-bearing param summaries as
// "<block>.<param> [<ch>] = ...").
const effectTypeOps = paramOps.filter((op) => op.summary.includes('effect_type'));

check(
  'emission: exactly two effect_type param ops (one per channel, Y NOT dropped)',
  effectTypeOps.length === 2,
  `got ${effectTypeOps.length}: [${effectTypeOps.map((o) => o.summary).join(' | ')}]`,
);

// Each effect_type op must route via fn=0x02 (enum/select path), NOT
// fn=0x2e (which silently no-ops for select params on hardware).
for (const op of effectTypeOps) {
  check(
    `emission: effect_type op uses fn=0x02 (${op.summary})`,
    op.bytes[5] === FN_BLOCK_PARAM,
    `fn=0x${op.bytes[5]?.toString(16)}`,
  );
}

// ── Ordering invariant: SET_CHANNEL X precedes X's param ops; SET_CHANNEL
// Y precedes Y's param ops. We assert against the flattened
// chanAndParamOps array using emission indices.

function emissionIndexOfChannel(ch: 'X' | 'Y'): number {
  return chanAndParamOps.findIndex((op) => op.kind === 'channel' && op.expectedChannel === ch);
}
function emissionIndexOfEffectType(ch: 'X' | 'Y'): number {
  return chanAndParamOps.findIndex(
    (op) => op.kind === 'param' && op.summary.includes('effect_type') && op.summary.includes(`[${ch}]`),
  );
}

const idxChanX = emissionIndexOfChannel('X');
const idxChanY = emissionIndexOfChannel('Y');
const idxEffX = emissionIndexOfEffectType('X');
const idxEffY = emissionIndexOfEffectType('Y');

check(
  'ordering: SET_CHANNEL X is emitted before X effect_type op',
  idxChanX >= 0 && idxEffX >= 0 && idxChanX < idxEffX,
  `idxChanX=${idxChanX}, idxEffX=${idxEffX}`,
);
check(
  'ordering: SET_CHANNEL Y is emitted before Y effect_type op',
  idxChanY >= 0 && idxEffY >= 0 && idxChanY < idxEffY,
  `idxChanY=${idxChanY}, idxEffY=${idxEffY}`,
);
check(
  'ordering: the entire X channel group precedes the Y channel group',
  idxChanX >= 0 && idxChanY >= 0 && idxEffX >= 0 && idxChanX < idxChanY && idxEffX < idxChanY,
  `idxChanX=${idxChanX}, idxEffX=${idxEffX}, idxChanY=${idxChanY}`,
);

// ── The load-bearing assertion: the two effect_type ops target DISTINCT
// enum values (X -> A, Y -> B). This is what BK-058 broke: Y silently
// inheriting X's value, or Y's op never emitted.

const opX = chanAndParamOps.find(
  (op) => op.kind === 'param' && op.summary.includes('effect_type') && op.summary.includes('[X]'),
);
const opY = chanAndParamOps.find(
  (op) => op.kind === 'param' && op.summary.includes('effect_type') && op.summary.includes('[Y]'),
);

check(
  'distinct: an X effect_type op and a Y effect_type op both exist',
  opX !== undefined && opY !== undefined,
  `opX=${opX?.summary}, opY=${opY?.summary}`,
);

if (opX !== undefined && opY !== undefined) {
  const wireX = decodeEnumWireFromFn02(opX.bytes);
  const wireY = decodeEnumWireFromFn02(opY.bytes);

  check(
    'distinct: X effect_type op targets TYPE_A wire index',
    wireX === WIRE_A,
    `decoded wireX=${wireX}, expected ${WIRE_A} (${TYPE_A})`,
  );
  check(
    'distinct: Y effect_type op targets TYPE_B wire index (NOT defaulted to X/A)',
    wireY === WIRE_B,
    `decoded wireY=${wireY}, expected ${WIRE_B} (${TYPE_B})`,
  );
  check(
    'distinct: X and Y effect_type ops carry DIFFERENT wire values',
    wireX !== wireY,
    `wireX=${wireX}, wireY=${wireY} (must differ; A != B)`,
  );
}

// Also confirm each channel got its per-channel knob op (gain), so the
// channel group is genuinely populated, not just the effect_type.
const gainOpX = chanAndParamOps.find(
  (op) => op.kind === 'param' && op.summary.includes('gain') && op.summary.includes('[X]'),
);
const gainOpY = chanAndParamOps.find(
  (op) => op.kind === 'param' && op.summary.includes('gain') && op.summary.includes('[Y]'),
);
check(
  'completeness: each channel emits its per-channel knob op (gain on X and Y)',
  gainOpX !== undefined && gainOpY !== undefined,
  `gainOpX=${gainOpX?.summary}, gainOpY=${gainOpY?.summary}`,
);

// ── Report ───────────────────────────────────────────────────────────

function finish(): void {
  if (failures === 0) {
    console.log('\nverify-paramsbychannel-emission: all assertions passed.');
    process.exit(0);
  }
  console.error(`\nverify-paramsbychannel-emission: ${failures} failure(s).`);
  process.exit(1);
}

finish();
