// verify-axefx2-scene-levels.ts
//
// Golden for the gen-2 scene-level initialization (sibling of the AM4's
// 2026-07-16 fix, mirrored onto the Axe-Fx II family): every fresh
// display-mode apply_preset build writes ALL EIGHT output.scene_N_main
// params (Output block effectId 140, paramIds 8..15) so stale per-scene
// trims left by the previous buffer occupant cannot shape the new build.
//
//   - Default: 0.0 dB reset on all eight.
//   - When the spec defines scenes AND every DEFINED scene's amp channel
//     has an in-spec amp type that translates to a corpus loudness
//     offset (alias table, then case-tolerant corpus match, the same
//     path discovery's loudnessOffsetsForEnum uses): defined scenes get
//     positive-only STARTING trims toward the loudest defined scene
//     (+12 dB clamp, 0.1 dB rounding); undefined scenes stay 0.0.
//   - Suppression: the spec expressing any output scene main itself
//     (any spelling canonicalizing through findParam) injects nothing.
//   - wireMode is carved out (legacy raw-wire scripts).
//   - Model-byte threading: AX8 builds emit injected frames with 0x08.
//
// Offline op-emission check: built op list only, no MIDI I/O.
//
// Run: npx tsx scripts/verify-axefx2-scene-levels.ts

import {
  buildApplyPresetAtOps,
  mergeAutoApplied,
  type ApplyPresetAtOp,
  type ApplyPresetSceneLevels,
} from '../packages/fractal-gen2/src/tools/applyExecutor.js';
import {
  KNOWN_PARAMS,
  buildSetBlockParameterValue,
  type AxeFxIIParam,
} from 'fractal-midi/gen2/axe-fx-ii';
import { resolveEnumAlias } from '@mcp-midi-control/core/protocol-generic/cross-device-enums.js';
import { lookupAmpLoudness } from '@mcp-midi-control/core/fractal-shared/loudness.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const OUTPUT_EFFECT_ID = 140;

const sceneLevelOps = (ops: ApplyPresetAtOp[]): ApplyPresetAtOp[] =>
  ops.filter((op) => op.kind === 'scene_level');

function buildWithReport(
  input: Parameters<typeof buildApplyPresetAtOps>[0],
  extraOpts: Record<string, unknown> = {},
): { ops: ApplyPresetAtOp[]; report: ApplyPresetSceneLevels | undefined } {
  let report: ApplyPresetSceneLevels | undefined;
  const ops = buildApplyPresetAtOps(input, {
    ...extraOpts,
    onSceneLevels: (r: ApplyPresetSceneLevels) => { report = r; },
  });
  return { ops, report };
}

/** paramId for output.scene_N_main from the registry (8..15). */
function sceneMainParamId(sceneNum: number): number {
  const p = KNOWN_PARAMS[`output.scene_${sceneNum}_main` as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
  return p.paramId;
}

// ── Alias-table probe: pin the translation legs this golden relies on ──
//
// Two distinct translation legs feed lookupAmpLoudness:
//   (a) alias-TABLE row: the II label differs from the AM4 canonical
//       ("PLEXI 50W NRML" -> "Plexi 50W Normal", concept row).
//   (b) case-tolerant fall-through: no table row, but the II label IS
//       the AM4 corpus key modulo case ("BRIT SILVER" -> corpus key
//       "Brit Silver"; "PLEXI 100W HIGH" -> "Plexi 100W High").
// AM4-native labels "Brit Silver" / "Plexi 100W High" therefore have NO
// alias-table row; their II spellings translate via leg (b). Probed
// here, not assumed.
console.log('Case 0: alias-table + corpus probe (translation legs pinned)');
{
  const viaTable = resolveEnumAlias('am4', 'amp', 'effect_type', 'PLEXI 50W NRML');
  check(
    'PLEXI 50W NRML translates via the alias TABLE',
    viaTable.aliasUsed !== undefined && viaTable.canonical === 'Plexi 50W Normal',
    JSON.stringify(viaTable),
  );
  check(
    'Plexi 50W Normal has a corpus offset (+2 dB)',
    lookupAmpLoudness(viaTable.canonical)?.relative_loudness_dB === 2,
  );
  const britSilver = resolveEnumAlias('am4', 'amp', 'effect_type', 'BRIT SILVER');
  check(
    'BRIT SILVER has no table row (falls through unchanged)',
    britSilver.aliasUsed === undefined && britSilver.canonical === 'BRIT SILVER',
    JSON.stringify(britSilver),
  );
  check(
    'BRIT SILVER hits the corpus case-tolerantly (+1 dB)',
    lookupAmpLoudness(britSilver.canonical)?.relative_loudness_dB === 1,
  );
  check(
    'PLEXI 100W HIGH hits the corpus case-tolerantly (+4 dB)',
    lookupAmpLoudness(resolveEnumAlias('am4', 'amp', 'effect_type', 'PLEXI 100W HIGH').canonical)?.relative_loudness_dB === 4,
  );
}

// Enum ordinals for the amp types used below, probed from the registry
// (never hardcoded).
const ampEnumValues = (KNOWN_PARAMS['amp.effect_type'] as AxeFxIIParam & {
  enumValues?: Record<number, string>;
}).enumValues!;
function ampOrdinal(label: string): number {
  const hit = Object.entries(ampEnumValues).find(([, l]) => l === label);
  if (hit === undefined) throw new Error(`amp.effect_type label not found: ${label}`);
  return Number(hit[0]);
}
const BRIT_SILVER = ampOrdinal('BRIT SILVER');           // corpus +1 dB
const PLEXI_100W_HIGH = ampOrdinal('PLEXI 100W HIGH');   // corpus +4 dB (loudest below)
const PLEXI_50W_NRML = ampOrdinal('PLEXI 50W NRML');     // corpus +2 dB via alias TABLE
const BASSGUY_59 = ampOrdinal('59 BASSGUY');             // corpus MISS

// ── Case 1: all-8 reset on a fresh build (corpus-missing amp type, no scenes) ──
console.log('Case 1: fresh build always writes all 8 output.scene_N_main at 0.0 dB');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [{ block: 'Amp 1', params: { effect_type: BASSGUY_59, input_drive: 5 } }],
  });
  const lvl = sceneLevelOps(ops);
  check('exactly 8 scene_level ops emitted', lvl.length === 8, `got ${lvl.length}`);
  check(
    'byte-exact vs buildSetBlockParameterValue(140, paramId 8..15, 0.0)',
    lvl.every((op, i) => {
      const expected = buildSetBlockParameterValue(
        { effectId: OUTPUT_EFFECT_ID, paramId: sceneMainParamId(i + 1) },
        0,
        {},
      );
      return op.bytes.length === expected.length && op.bytes.every((b, j) => b === expected[j]);
    }),
  );
  const saveIdx = ops.findIndex((op) => op.kind === 'save');
  const lastLvlIdx = ops.map((op) => op.kind === 'scene_level').lastIndexOf(true);
  check('scene_level ops precede the STORE_PRESET tail (baked into the save)', saveIdx !== -1 && lastLvlIdx < saveIdx);
  check('report source is reset', report?.source === 'reset', report?.source);
  check('report values all 0.0 dB', report !== undefined && Object.values(report.values).every((v) => v === '0.0 dB'));
  check('report keys are scene_1_main..scene_8_main', report !== undefined && Object.keys(report.values).length === 8 && report.values['scene_8_main'] === '0.0 dB');
  check('note STARTS with server attribution', report !== undefined && report.note.startsWith('THE SERVER'));
  check(
    'note points at the Internal Levels Meter + measure_loudness and carries the undo',
    report !== undefined
      && /Internal Levels Meter/.test(report.note)
      && /measure_loudness/.test(report.note)
      && /set output\.scene_N_main to 0/.test(report.note),
  );
}

// ── Case 2: defined-scenes offset trims (case-tolerant fall-through labels) ──
console.log('Case 2: BRIT SILVER (+1) vs PLEXI 100W HIGH (+4) across scenes 1/2');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [{
      block: 'Amp 1',
      paramsByChannel: {
        X: { effect_type: BRIT_SILVER },
        Y: { effect_type: PLEXI_100W_HIGH },
      },
    }],
    scenes: [
      { index: 1, channels: { 'Amp 1': 'X' } },
      { index: 2, channels: { 'Amp 1': 'Y' } },
      // scenes 3-8 undefined -> stay 0.0
    ],
  });
  check('source is amp_offsets', report?.source === 'amp_offsets', report?.source);
  check('scene 1 (Brit Silver) lifted +3.0 dB toward the Plexi', report?.values['scene_1_main'] === '3.0 dB', report?.values['scene_1_main']);
  check('scene 2 (Plexi, loudest) stays 0.0 dB reference', report?.values['scene_2_main'] === '0.0 dB', report?.values['scene_2_main']);
  check(
    'undefined scenes 3-8 stay 0.0 dB',
    report !== undefined && [3, 4, 5, 6, 7, 8].every((n) => report!.values[`scene_${n}_main`] === '0.0 dB'),
  );
  check('note labels trims UNVERIFIED + points at measure_loudness', report !== undefined && /UNVERIFIED/.test(report.note) && /measure_loudness/.test(report.note));
  check('note starts with server attribution', report !== undefined && report.note.startsWith('THE SERVER'));
  const lvl = sceneLevelOps(ops);
  const expected = buildSetBlockParameterValue(
    { effectId: OUTPUT_EFFECT_ID, paramId: sceneMainParamId(1) },
    3.0,
    {},
  );
  check(
    'scene_1_main frame byte-exact for the 3.0 dB trim',
    lvl[0] !== undefined && lvl[0].bytes.length === expected.length && lvl[0].bytes.every((b, j) => b === expected[j]),
  );
}

// ── Case 3: alias-TABLE-translated label drives a trim ──
console.log('Case 3: PLEXI 50W NRML (+2 via alias table) vs PLEXI 100W HIGH (+4)');
{
  const { report } = buildWithReport({
    preset_number: 0,
    blocks: [{
      block: 'Amp 1',
      paramsByChannel: {
        X: { effect_type: PLEXI_50W_NRML },
        Y: { effect_type: PLEXI_100W_HIGH },
      },
    }],
    scenes: [
      { index: 1, channels: { 'Amp 1': 'X' } },
      { index: 2, channels: { 'Amp 1': 'Y' } },
    ],
  });
  check('source is amp_offsets', report?.source === 'amp_offsets', report?.source);
  check('scene 1 (Plexi 50W Normal) lifted +2.0 dB', report?.values['scene_1_main'] === '2.0 dB', report?.values['scene_1_main']);
  check('scene 2 stays 0.0 dB reference', report?.values['scene_2_main'] === '0.0 dB');
}

// ── Case 4: unresolvable defined scene -> all zeros (never a guess) ──
console.log('Case 4: a defined scene without an in-spec amp type falls back to reset');
{
  // Scene 2 points the amp at Y, but the spec never writes Y's type:
  // the channel's type is device state, not in-spec. All eight reset.
  const { report } = buildWithReport({
    preset_number: 0,
    blocks: [{
      block: 'Amp 1',
      paramsByChannel: { X: { effect_type: BRIT_SILVER } },
    }],
    scenes: [
      { index: 1, channels: { 'Amp 1': 'X' } },
      { index: 2, channels: { 'Amp 1': 'Y' } },
    ],
  });
  check('source is reset', report?.source === 'reset', report?.source);
  check('all values 0.0 dB', report !== undefined && Object.values(report.values).every((v) => v === '0.0 dB'));
}
{
  // Corpus-missing label on a defined scene: same fall-back.
  const { report } = buildWithReport({
    preset_number: 0,
    blocks: [{ block: 'Amp 1', params: { effect_type: BASSGUY_59 } }],
    scenes: [{ index: 1, channels: { 'Amp 1': 'X' } }],
  });
  check('corpus-missing amp type -> reset', report?.source === 'reset', report?.source);
  check('corpus-missing amp type -> all 0.0 dB', report !== undefined && Object.values(report.values).every((v) => v === '0.0 dB'));
}

// ── Case 5: spec-expressed output scene main suppresses ALL injection ──
console.log('Case 5: an explicit output.scene_N_main in the spec suppresses injection');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [
      { block: 'Amp 1', params: { input_drive: 5 } },
      { block: 'Output', params: { scene_1_main: 2 } },
    ],
  });
  check('no scene_level ops emitted', sceneLevelOps(ops).length === 0);
  check('sceneLevels report is undefined', report === undefined);
  check(
    'the explicit spec write is still emitted (as a normal param op)',
    ops.some((op) => op.kind === 'param' && op.summary.startsWith('Output.scene_1_main')),
  );
}
{
  // Alias spelling canonicalizes through findParam and still suppresses.
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [{ block: 'Output', params: { 'Scene 3 Main': 1 } }],
  });
  check('alias spelling ("Scene 3 Main") suppresses too', sceneLevelOps(ops).length === 0 && report === undefined);
}

// ── Case 6: wireMode carve-out (legacy raw-wire callers) ──
console.log('Case 6: wire:true builds skip injection');
{
  const { ops, report } = buildWithReport(
    { preset_number: 0, blocks: [{ block: 'Amp 1' }] },
    { wire: true },
  );
  check('no scene_level ops in wire mode', sceneLevelOps(ops).length === 0);
  check('sceneLevels report is undefined', report === undefined);
}

// ── Case 7: no scenes defined -> reset even with a corpus-known amp type ──
console.log('Case 7: corpus-known amp type WITHOUT defined scenes stays 0.0 dB');
{
  const { report } = buildWithReport({
    preset_number: 0,
    blocks: [{ block: 'Amp 1', params: { effect_type: BRIT_SILVER } }],
  });
  check('source is reset (offsets require defined scenes)', report?.source === 'reset', report?.source);
  check('all values 0.0 dB', report !== undefined && Object.values(report.values).every((v) => v === '0.0 dB'));
}

// ── Case 8: model-byte threading (AX8 = 0x08), golden-locked ──
console.log('Case 8: injected frames carry the config model byte (AX8 0x08)');
{
  const { ops } = buildWithReport(
    { preset_number: 0, blocks: [{ block: 'Amp 1' }] },
    { modelId: 0x08 },
  );
  const lvl = sceneLevelOps(ops);
  check('8 scene_level ops on the AX8 build', lvl.length === 8, `got ${lvl.length}`);
  check(
    'every injected frame carries model byte 0x08 at index 4',
    lvl.every((op) => op.bytes[0] === 0xf0 && op.bytes[4] === 0x08),
    lvl.map((op) => `0x${op.bytes[4]?.toString(16)}`).join(','),
  );
  const { ops: xlOps } = buildWithReport({ preset_number: 0, blocks: [{ block: 'Amp 1' }] });
  const xlLvl = sceneLevelOps(xlOps);
  check(
    'default (XL+) injected frames carry model byte 0x07',
    xlLvl.length === 8 && xlLvl.every((op) => op.bytes[4] === 0x07),
    xlLvl.map((op) => `0x${op.bytes[4]?.toString(16)}`).join(','),
  );
}

// ── Case 9: mergeAutoApplied combines cab-polish + scene-level reports ──
console.log('Case 9: merged auto_applied shape (params union + note concatenation)');
{
  let cabReport: { channels: string[]; params: Record<string, string>; note: string } | undefined;
  let lvlReport: ApplyPresetSceneLevels | undefined;
  buildApplyPresetAtOps(
    {
      preset_number: 0,
      blocks: [
        { block: 'Amp 1', params: { effect_type: BRIT_SILVER } },
        { block: 'Cab 1' },
      ],
    },
    {
      onCabPolish: (r) => { cabReport = r; },
      onSceneLevels: (r) => { lvlReport = r; },
    },
  );
  check('both reports fire on one cab-bearing build', cabReport !== undefined && lvlReport !== undefined);
  const merged = mergeAutoApplied(cabReport, lvlReport);
  check(
    'merged params carry cab defaults AND all 8 scene mains',
    merged !== undefined
      && merged.params['low_cut'] === '80 Hz'
      && merged.params['scene_1_main'] === '0.0 dB'
      && merged.params['scene_8_main'] === '0.0 dB',
  );
  check(
    'merged note concatenates cab note then scene-levels note',
    merged !== undefined && /wide open/i.test(merged.note) && /THE SERVER initialized scene levels/.test(merged.note),
  );
  check('merged channels come from the cab report', merged !== undefined && merged.channels?.join(',') === 'X');
  check('mergeAutoApplied(undefined, undefined) is undefined', mergeAutoApplied(undefined, undefined) === undefined);
}

console.log('');
if (failures > 0) {
  console.error(`verify-axefx2-scene-levels: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-axefx2-scene-levels: all checks passed');
