// verify-screech-bypass-during-build.ts
//
// Gated test: the Axe-Fx II apply_preset "screech on apply" fix
// (hardware-reproduced + root-caused 2026-06-07).
//
// Root cause: the incremental build wrote params to ENGAGED blocks, so a
// half-built high-gain amp at default extreme gain fed a delay/reverb
// feedback loop being cabled live → runaway self-oscillation → screech.
// The fix builds through a DRY path: every placeable block is bypassed the
// instant it is placed (before any cabling or param write), then re-engaged
// to its FINAL state after all params land.
//
// This test asserts that op-emission SHAPE, fully offline (the audible
// proof is hardware; the structure is checkable here):
//   1. Every placed canBypass block emits a build-safe BYPASS op right
//      after its placement.
//   2. ALL build-safe bypasses precede ALL param ops (no block is engaged
//      while params are written).
//   3. No block is ENGAGED during the param-write phase (no engage op
//      between the build-safe bypasses and the scene/finalization phase).
//   4. Re-engage happens after params: per-scene authoring sets the
//      COMPLETE bypass state for every placed block each scene (so a block
//      absent from a scene's sparse bypass map is explicitly engaged, never
//      left stuck in the build-safe bypass), and the flat (no-scenes) path
//      finalizes every block's bypass.
//
// Pipeline exercised (real unified path, no hardware):
//   PresetSpec -> translateSpec() -> buildApplyPresetAtOps() -> inspect ops[]
//
// Run:  npx tsx scripts/verify-screech-bypass-during-build.ts
// Status: offline, no hardware. Exits 0 on pass, non-zero on any failure.

import { registerParamKindResolver } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { resolveAxeFxIIParamKind } from '@mcp-midi-control/fractal-gen2/calibration.js';

registerParamKindResolver('axe-fx-ii', resolveAxeFxIIParamKind);

import {
  buildApplyPresetAtOps,
  buildApplyPresetOps,
  type ApplyPresetAtOp,
} from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';
import { translateSpec } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const isBuildSafeBypass = (op: ApplyPresetAtOp): boolean =>
  op.kind === 'bypass' && op.summary.startsWith('build-safe BYPASS');
const isSceneBypass = (op: ApplyPresetAtOp): boolean =>
  op.kind === 'bypass' && op.summary.startsWith('[scene ');
const isFlatFinalBypass = (op: ApplyPresetAtOp): boolean =>
  op.kind === 'bypass' && op.summary.includes('(final)');

function buildOps(spec: PresetSpec): ApplyPresetAtOp[] {
  const translated = translateSpec(spec);
  return buildApplyPresetAtOps({ preset_number: 0, ...translated });
}

// ── Case 1: multi-block, multi-scene (the screech repro shape) ───────────
//
// Two amps + drive + cab + delay + reverb, 2 scenes with SPARSE bypass maps.
// All six blocks are canBypass.

console.log('Case 1: multi-block, multi-scene build');
{
  const spec: PresetSpec = {
    name: 'ScreechRegr',
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'drive', params: { X: { effect_type: 'T808 OD', gain: 6 } } },
      { slot: { row: 2, col: 2 }, block_type: 'amp', params: { X: { effect_type: 'BRIT SUPER', input_drive: 8 }, Y: { effect_type: 'PLEXI 100W HIGH', input_drive: 9 } } },
      { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2, params: { X: { effect_type: 'PLEXI 50W HI 1', input_drive: 8 } } },
      { slot: { row: 2, col: 4 }, block_type: 'cab' },
      { slot: { row: 2, col: 5 }, block_type: 'delay', params: { X: { effect_type: 'DIGITAL STEREO', mix: 35, feedback: 50 } } },
      { slot: { row: 2, col: 6 }, block_type: 'reverb', params: { X: { effect_type: 'LARGE HALL', mix: 45 } } },
    ],
    scenes: [
      { scene: 1, channels: { amp: 'X', amp_2: 'X' }, bypassed: { drive: true, amp_2: true, delay: true } },
      { scene: 2, channels: { amp: 'Y', amp_2: 'Y' }, bypassed: { drive: false, amp_2: false, delay: false } },
    ],
  };

  const ops = buildOps(spec);
  const PLACED_CAN_BYPASS = 6; // drive, amp, amp_2, cab, delay, reverb

  // 1. Each place_block is immediately followed by a build-safe bypass.
  let everyPlaceBypassed = true;
  let placeCount = 0;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== 'place_block') continue;
    // Shunts are placed too (canBypass=false) — skip those; only content
    // blocks (PLACE <Name> at row 2 col <=6) must be followed by a bypass.
    if (ops[i].summary.includes('SHUNT')) continue;
    placeCount++;
    const next = ops[i + 1];
    if (!next || !isBuildSafeBypass(next)) {
      everyPlaceBypassed = false;
      console.error(`    place op not followed by build-safe bypass: "${ops[i].summary}" -> "${next?.summary}"`);
    }
  }
  check('1a: every content block placement is immediately followed by a build-safe BYPASS', everyPlaceBypassed);
  check('1b: all 6 content blocks were placed', placeCount === PLACED_CAN_BYPASS, `placeCount=${placeCount}`);

  const buildSafe = ops.filter(isBuildSafeBypass);
  check('1c: exactly 6 build-safe BYPASS ops (one per canBypass block)', buildSafe.length === PLACED_CAN_BYPASS, `got ${buildSafe.length}`);

  // 2. All build-safe bypasses precede all param ops.
  const lastBuildSafeIdx = ops.map(isBuildSafeBypass).lastIndexOf(true);
  const firstParamIdx = ops.findIndex((op) => op.kind === 'param');
  check('2: every build-safe BYPASS precedes the first param write', lastBuildSafeIdx >= 0 && firstParamIdx >= 0 && lastBuildSafeIdx < firstParamIdx, `lastBuildSafe=${lastBuildSafeIdx}, firstParam=${firstParamIdx}`);

  // 3. No block is ENGAGED (bypass=false) during the param phase. With
  // scenes present there is NO flat finalization; the only engage ops are
  // in the per-scene walk, which runs AFTER the last param op. So between
  // the first and last param op there must be zero engage ops.
  const lastParamIdx = ops.map((op) => op.kind === 'param').lastIndexOf(true);
  const engageDuringParams = ops
    .slice(firstParamIdx, lastParamIdx + 1)
    .some((op) => op.kind === 'bypass' && op.summary.includes('ENGAGED'));
  check('3: no block is ENGAGED during the param-write phase', !engageDuringParams);

  // 4. Per-scene COMPLETE bypass authoring: each scene emits a bypass op
  // for EVERY placed canBypass block (not just the sparse map), so no block
  // is left stuck in the build-safe bypass.
  for (const sceneNum of [1, 2]) {
    const sceneOps = ops.filter((op) => isSceneBypass(op) && op.summary.startsWith(`[scene ${sceneNum}]`));
    check(`4a: scene ${sceneNum} authors a bypass op for all 6 blocks (complete state)`, sceneOps.length === PLACED_CAN_BYPASS, `got ${sceneOps.length}`);
  }
  // Completeness spotcheck: Amp 1 is absent from BOTH scenes' bypass maps,
  // so it must be explicitly ENGAGED in each scene (the build-safe bypass
  // must NOT leak through).
  for (const sceneNum of [1, 2]) {
    const ampEngaged = ops.some((op) => isSceneBypass(op) && op.summary.startsWith(`[scene ${sceneNum}]`) && op.summary.includes('Amp 1') && op.summary.includes('ENGAGED'));
    check(`4b: scene ${sceneNum} explicitly ENGAGES Amp 1 (absent from sparse map, not left bypassed)`, ampEngaged);
  }
  // And a block the scene DOES bypass (delay in scene 1) is BYPASSED there.
  const delayBypassedScene1 = ops.some((op) => isSceneBypass(op) && op.summary.startsWith('[scene 1]') && op.summary.includes('Delay 1') && op.summary.includes('BYPASSED'));
  check('4c: scene 1 BYPASSES Delay 1 (sparse override honored)', delayBypassedScene1);

  // No flat finalization when scenes are present.
  check('4d: no flat "(final)" bypass ops when scenes are authored', ops.filter(isFlatFinalBypass).length === 0);
}

// ── Case 2: flat build, no scenes ────────────────────────────────────────
//
// No scenes[] → the flat finalization must re-engage every block after
// params (else the build-safe bypass would leave the preset silent).

console.log('\nCase 2: flat build, no scenes');
{
  const spec: PresetSpec = {
    name: 'FlatRegr',
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'amp', params: { X: { effect_type: 'BRIT SUPER', input_drive: 6 } } },
      { slot: { row: 2, col: 2 }, block_type: 'cab' },
      { slot: { row: 2, col: 3 }, block_type: 'reverb', params: { X: { effect_type: 'MEDIUM PLATE', mix: 25 } } },
    ],
  };
  const ops = buildOps(spec);
  const PLACED_CAN_BYPASS = 3;

  const buildSafe = ops.filter(isBuildSafeBypass);
  check('2a: build-safe BYPASS for all 3 blocks', buildSafe.length === PLACED_CAN_BYPASS, `got ${buildSafe.length}`);

  const flatFinal = ops.filter(isFlatFinalBypass);
  check('2b: flat finalization emits a "(final)" bypass for all 3 blocks', flatFinal.length === PLACED_CAN_BYPASS, `got ${flatFinal.length}`);

  // All three should be ENGAGED (none requested bypassed).
  const allEngaged = flatFinal.every((op) => op.summary.includes('ENGAGED'));
  check('2c: flat finalization ENGAGES every block (none requested bypassed)', allEngaged, flatFinal.map((o) => o.summary).join(' | '));

  // Finalization runs AFTER the last param op (re-engage with FINAL params).
  const lastParamIdx = ops.map((op) => op.kind === 'param').lastIndexOf(true);
  const firstFinalIdx = ops.findIndex(isFlatFinalBypass);
  check('2d: flat finalization runs after the last param write', lastParamIdx >= 0 && firstFinalIdx > lastParamIdx, `lastParam=${lastParamIdx}, firstFinal=${firstFinalIdx}`);
}

// ── Case 3: flat build with a block requested bypassed ───────────────────
//
// Exercises the `r.bypass ?? false` TRUE branch of flat finalization: a slot
// marked bypassed must end BYPASSED, the rest ENGAGED.

console.log('\nCase 3: flat build, one block bypassed:true');
{
  const spec: PresetSpec = {
    name: 'FlatBypassRegr',
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'amp', params: { X: { effect_type: 'BRIT SUPER', input_drive: 6 } } },
      { slot: { row: 2, col: 2 }, block_type: 'cab' },
      { slot: { row: 2, col: 3 }, block_type: 'drive', bypassed: true, params: { X: { effect_type: 'T808 OD', gain: 5 } } },
    ],
  };
  const ops = buildOps(spec);
  const flatFinal = ops.filter(isFlatFinalBypass);
  const driveBypassed = flatFinal.some((op) => op.summary.includes('Drive 1') && op.summary.includes('BYPASSED'));
  check('3a: flat finalization honors bypassed:true (Drive 1 → BYPASSED)', driveBypassed, flatFinal.map((o) => o.summary).join(' | '));
  const ampEngaged = flatFinal.some((op) => op.summary.includes('Amp 1') && op.summary.includes('ENGAGED'));
  check('3b: flat finalization ENGAGES the non-bypassed blocks (Amp 1)', ampEngaged);
}

// ── Case 4: scenes + slot-level bypassed omitted from a scene ────────────
//
// Guards the per-scene completeness fix: a block carrying slot-level
// bypassed:true that a scene's sparse map does NOT mention must inherit the
// flat bypass intent (BYPASSED), not be silently engaged. A scene that DOES
// name it (bypassed:false) overrides to ENGAGED.

console.log('\nCase 4: scenes + a slot-level bypassed block omitted from a scene');
{
  const spec: PresetSpec = {
    name: 'SceneFlatBypass',
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'amp', params: { X: { effect_type: 'BRIT SUPER', input_drive: 6 } } },
      { slot: { row: 2, col: 2 }, block_type: 'cab' },
      { slot: { row: 2, col: 3 }, block_type: 'reverb', bypassed: true, params: { X: { effect_type: 'LARGE HALL', mix: 40 } } },
    ],
    scenes: [
      { scene: 1, channels: { amp: 'X' } },                       // omits reverb → inherit flat bypassed:true
      { scene: 2, channels: { amp: 'X' }, bypassed: { reverb: false } }, // explicitly engages reverb
    ],
  };
  const ops = buildOps(spec);
  const revScene1Bypassed = ops.some((op) => isSceneBypass(op) && op.summary.startsWith('[scene 1]') && op.summary.includes('Reverb 1') && op.summary.includes('BYPASSED'));
  check('4a: scene 1 (omits reverb) inherits slot bypassed:true → Reverb 1 BYPASSED', revScene1Bypassed, ops.filter((o) => isSceneBypass(o) && o.summary.includes('Reverb 1')).map((o) => o.summary).join(' | '));
  const revScene2Engaged = ops.some((op) => isSceneBypass(op) && op.summary.startsWith('[scene 2]') && op.summary.includes('Reverb 1') && op.summary.includes('ENGAGED'));
  check('4b: scene 2 (explicit bypassed:false) overrides → Reverb 1 ENGAGED', revScene2Engaged);
}

// ── Case 5: fresh-build clears every non-content cell (BUG-8 guard) ───────
//
// The 2026-07-04 II hardware session reported ghost blocks surviving a
// recipe apply over a dense preset. Op-generation is NOT the cause:
// buildApplyPresetOps (the working-buffer path) emits a clear_cell for
// every grid cell it does not place a CONTENT block into, so the wire
// sequence always requests a fresh 4×12 canvas before placing the chain.
// This locks that invariant so a regression that drops the clear pre-pass
// is caught at build time. (The runtime skip-empty-cells optimization in
// runApplyPresetAtOps is a separate, hardware-only path — if ghosts recur
// on device, capture the apply summaries[] to inspect the skip decisions.)
console.log('\nCase 5: fresh-build clears every non-content cell (BUG-8 guard)');
{
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'amp' },
      { slot: { row: 2, col: 4 }, block_type: 'cab' },
      { slot: { row: 2, col: 6 }, block_type: 'reverb' },
    ],
  };
  const ops = buildApplyPresetOps(translateSpec(spec) as Parameters<typeof buildApplyPresetOps>[0]);
  const contentCells = new Set(['2,1', '2,4', '2,6']);
  const clearedCells = new Set(
    ops
      .filter((o): o is ApplyPresetAtOp & { cellRef: { row: number; col: number } } =>
        o.kind === 'clear_cell' && o.cellRef !== undefined)
      .map((o) => `${o.cellRef.row},${o.cellRef.col}`),
  );
  let allNonContentCleared = true;
  const missing: string[] = [];
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 12; col++) {
      const key = `${row},${col}`;
      if (contentCells.has(key)) continue;
      if (!clearedCells.has(key)) { allNonContentCleared = false; missing.push(key); }
    }
  }
  check('5a: every non-content cell (48 − 3) gets a clear_cell op', allNonContentCleared, `missing: ${missing.join(' ')}`);
  check('5b: content cells are NOT cleared (placement overwrites them)',
    ![...contentCells].some((c) => clearedCells.has(c)));
  check('5c: working-buffer ops carry no switch_preset / save',
    !ops.some((o) => o.kind === 'switch_preset' || o.kind === 'save'));
}

// ── Report ───────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log('\nverify-screech-bypass-during-build: all assertions passed.');
  process.exit(0);
}
console.error(`\nverify-screech-bypass-during-build: ${failures} failure(s).`);
process.exit(1);
