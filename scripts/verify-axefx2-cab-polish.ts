// verify-axefx2-cab-polish.ts
//
// Golden for BK-103c: the Axe-Fx II (gen-2) apply executor ENFORCES the
// mix-ready cab-polish defaults (low cut 80 Hz, high cut 6500 Hz,
// filter slope 12 dB/OCT, room 8%) on every cab channel window a fresh
// build writes, unless the spec expresses any cab cut/room/slope opinion
// of its own or bypasses the cab block. Mirrors the AM4's BK-103b golden
// (scripts/verify-am4-cab-polish.ts) with the device differences:
//   - the cab is its OWN grid block (injection keys on placing a CAB
//     block, never the amp; blocks are never auto-placed),
//   - channels are X/Y (2), not A-D,
//   - the executor is model-byte parameterized (an AX8 build's injected
//     writes must carry 0x08).
//
// Offline op-emission check: built op list only, no MIDI I/O.
//
// Run: npx tsx scripts/verify-axefx2-cab-polish.ts

import {
  buildApplyPresetAtOps,
  type ApplyPresetAtOp,
  type ApplyPresetCabPolish,
} from '../packages/fractal-gen2/src/tools/applyExecutor.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const CAB_NAMES = ['low_cut', 'high_cut', 'filter_slope', 'room_level'];

/** Param ops on the Cab 1 block whose param is one of the cab-polish names. */
const injectedCabOps = (ops: ApplyPresetAtOp[]): ApplyPresetAtOp[] =>
  ops.filter(
    (op) => op.kind === 'param' && CAB_NAMES.some((n) => op.summary.startsWith(`Cab 1.${n} `)),
  );

/** Build with a report capture. */
function buildWithReport(
  input: Parameters<typeof buildApplyPresetAtOps>[0],
  extraOpts: Record<string, unknown> = {},
): { ops: ApplyPresetAtOp[]; report: ApplyPresetCabPolish | undefined } {
  let report: ApplyPresetCabPolish | undefined;
  const ops = buildApplyPresetAtOps(input, {
    ...extraOpts,
    onCabPolish: (r: ApplyPresetCabPolish) => { report = r; },
  });
  return { ops, report };
}

// ── Case 1: fresh chain with a bare cab → defaults injected on default channel X ──
console.log('Case 1: fresh amp+cab chain (bare cab) injects the defaults on channel X');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [
      { block: 'Amp 1', params: { input_drive: 5 } },
      { block: 'Cab 1' },
    ],
  });
  const cab = injectedCabOps(ops);
  check('all 4 cab-polish params injected', cab.length === 4, `got ${cab.map((c) => c.summary).join(' | ')}`);
  // Determinism: the injection makes the cab a params-bearing block, so the
  // executor pins the default channel X window before the injected writes.
  const chanIdx = ops.findIndex((op) => op.kind === 'channel' && op.summary.startsWith('Cab 1: channel=X'));
  const firstCabIdx = ops.findIndex((op) => cab.includes(op));
  check('default channel-X window opened before the injected writes', chanIdx !== -1 && chanIdx < firstCabIdx);
  check('cabPolish reported with channel X', report !== undefined && report.channels.join(',') === 'X');
  check('cabPolish note carries the undo phrase', report !== undefined && /wide open/i.test(report.note));
  check(
    'report params carry display values (80 Hz / 6500 Hz / 12 dB/OCT / 8%)',
    report !== undefined &&
      report.params['low_cut'] === '80 Hz' &&
      report.params['high_cut'] === '6500 Hz' &&
      report.params['filter_slope'] === '12 dB/OCT' &&
      report.params['room_level'] === '8%',
    JSON.stringify(report?.params),
  );
  // The slope is an enum: its op must ride the integer (fn=0x02) builder
  // with wire ordinal 1 = '12 dB/OCT' (CAB_FILTER_SLOPE_VALUES).
  const slope = cab.find((c) => c.summary.startsWith('Cab 1.filter_slope'));
  check('filter_slope injected as wire ordinal 1', slope !== undefined && / 1\)?$|wire 1|display 1/.test(slope.summary), slope?.summary);
}

// ── Case 2: injected writes land AFTER the spec's own cab params (IR selector first) ──
console.log('Case 2: injection appends after the spec cab params in the same window');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [
      { block: 'Amp 1', params: { input_drive: 5 } },
      { block: 'Cab 1', params: { cab: 5 } }, // IR selector: NOT a cut/room/slope opinion
    ],
  });
  const cab = injectedCabOps(ops);
  check('defaults still injected alongside a non-trigger cab param', cab.length === 4 && report !== undefined);
  const irIdx = ops.findIndex((op) => op.kind === 'param' && op.summary.startsWith('Cab 1.cab '));
  const firstCabIdx = ops.findIndex((op) => cab.includes(op));
  check('injected writes come AFTER the cab IR-selector write', irIdx !== -1 && firstCabIdx > irIdx);
}

// ── Case 3: explicit cut suppresses ALL injection ──
console.log('Case 3: any explicit cab cut/room/slope opinion suppresses injection');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [
      { block: 'Amp 1', params: { input_drive: 5 } },
      { block: 'Cab 1', params: { low_cut: 100 } },
    ],
  });
  const cab = injectedCabOps(ops);
  check('only the explicit cut write is present', cab.length === 1 && cab[0].summary.startsWith('Cab 1.low_cut'));
  check('cabPolish is undefined', report === undefined);
}

// ── Case 4: alias spelling still counts as a cab opinion ──
console.log('Case 4: alias spelling ("Low Cut") suppresses via the fuzzy resolver');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [{ block: 'Cab 1', params: { 'Low Cut': 100 } }],
  });
  // The spec write keeps its own spelling in the op summary ('Cab 1.Low Cut'),
  // so injectedCabOps (canonical names) counts only would-be injected writes.
  check('no defaults injected', injectedCabOps(ops).length === 0);
  check('the explicit write is still emitted', ops.some((op) => op.kind === 'param' && op.summary.startsWith('Cab 1.Low Cut')));
  check('cabPolish is undefined', report === undefined);
}

// ── Case 5: bypassed cab block suppresses (4CM / real-cab case) ──
console.log('Case 5: cab bypassed:true suppresses injection');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [{ block: 'Cab 1', bypass: true }],
  });
  check('no cut/room/slope writes injected', injectedCabOps(ops).length === 0);
  check('cabPolish is undefined', report === undefined);
}

// ── Case 6: per-channel build → injected inside EACH written channel window ──
console.log('Case 6: paramsByChannel X+Y injects per written channel, inside its window');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [{
      block: 'Cab 1',
      paramsByChannel: {
        X: { cab: 5 },
        Y: { cab: 9 },
      },
    }],
  });
  const cab = injectedCabOps(ops);
  check('8 injected writes total (4 per channel)', cab.length === 8, `got ${cab.length}`);
  check('cabPolish reports channels X and Y', report !== undefined && report.channels.join(',') === 'X,Y', report?.channels.join(','));
  const chanIdxs = ops
    .map((op, i) => ({ op, i }))
    .filter(({ op }) => op.kind === 'channel' && op.summary.startsWith('Cab 1: channel='));
  check('two cab channel switches emitted', chanIdxs.length === 2, `got ${chanIdxs.length}`);
  if (chanIdxs.length === 2) {
    const [xSwitch, ySwitch] = chanIdxs.map(({ i }) => i);
    const xWindow = ops.slice(xSwitch, ySwitch).filter((op) => cab.includes(op));
    const yWindow = ops.slice(ySwitch).filter((op) => cab.includes(op));
    check('4 injected writes inside channel X window', xWindow.length === 4, `got ${xWindow.length}`);
    check('4 injected writes inside channel Y window', yWindow.length === 4, `got ${yWindow.length}`);
    // Per-window ordering: the window's spec param (the IR selector) precedes its injected writes.
    const xIr = ops.slice(xSwitch, ySwitch).findIndex((op) => op.kind === 'param' && op.summary.startsWith('Cab 1.cab '));
    const xFirstInjected = ops.slice(xSwitch, ySwitch).findIndex((op) => cab.includes(op));
    check('X window: spec param precedes injected writes', xIr !== -1 && xFirstInjected > xIr);
  }
}

// ── Case 7: no cab block → nothing injected, non-cab blocks untouched ──
console.log('Case 7: no cab block placed injects NOTHING (never auto-place)');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [{ block: 'Amp 1', params: { input_drive: 5 } }, { block: 'Reverb 1', params: { mix: 30 } }],
  });
  check('no cab writes of any kind', injectedCabOps(ops).length === 0);
  check('cabPolish is undefined', report === undefined);
  const ampParams = ops.filter((op) => op.kind === 'param' && op.summary.startsWith('Amp 1.'));
  const revParams = ops.filter((op) => op.kind === 'param' && op.summary.startsWith('Reverb 1.'));
  check('non-cab blocks carry exactly their spec params', ampParams.length === 1 && revParams.length === 1);
}

// ── Case 8: wireMode carve-out (legacy raw-wire callers) ──
console.log('Case 8: wire:true builds skip injection (display defaults would be misread as raw wire)');
{
  const { ops, report } = buildWithReport(
    { preset_number: 0, blocks: [{ block: 'Cab 1' }] },
    { wire: true },
  );
  check('no writes injected in wire mode', injectedCabOps(ops).length === 0);
  check('cabPolish is undefined', report === undefined);
}

// ── Case 9: model-byte threading (AX8 = 0x08) ──
console.log('Case 9: injected writes carry the config model byte (AX8 0x08)');
{
  const { ops } = buildWithReport(
    { preset_number: 0, blocks: [{ block: 'Cab 1' }] },
    { modelId: 0x08 },
  );
  const cab = injectedCabOps(ops);
  check('4 writes injected on the AX8 build', cab.length === 4, `got ${cab.length}`);
  check(
    'every injected frame carries model byte 0x08 at index 4',
    cab.every((op) => op.bytes[0] === 0xf0 && op.bytes[4] === 0x08),
    cab.map((op) => `0x${op.bytes[4]?.toString(16)}`).join(','),
  );
  const { ops: xlOps } = buildWithReport({ preset_number: 0, blocks: [{ block: 'Cab 1' }] });
  const xlCab = injectedCabOps(xlOps);
  check(
    'default (XL+) injected frames carry model byte 0x07',
    xlCab.length === 4 && xlCab.every((op) => op.bytes[4] === 0x07),
    xlCab.map((op) => `0x${op.bytes[4]?.toString(16)}`).join(','),
  );
}

// ── Case 10: scene-referenced-but-unwritten cab channel gets its own window ──
//
// 2026-07-16 hardware bench gap: a 2-scene build (scene 1 amp X, scene 2
// amp Y) whose scenes also map the cab per scene (X and Y), with cab
// params only on the default X window. Pre-fix, channel Y read back wide
// open (20 Hz / 20 kHz / 0% room) on the device. Now every cab channel a
// scene references gets a default window: channel-select + cut writes,
// after the slot's own windows and BEFORE the scene walk.
console.log('Case 10: scene-referenced cab channel (bench shape) gets defaults too');
{
  const { ops, report } = buildWithReport({
    preset_number: 0,
    blocks: [
      { block: 'Amp 1', paramsByChannel: { X: { input_drive: 4 }, Y: { input_drive: 8 } } },
      { block: 'Cab 1', params: { cab: 5 } }, // flat: only the default X window written by the slot
    ],
    scenes: [
      { index: 1, channels: { 'Amp 1': 'X', 'Cab 1': 'X' } },
      { index: 2, channels: { 'Amp 1': 'Y', 'Cab 1': 'Y' } },
    ],
  });
  const cab = injectedCabOps(ops);
  check('8 injected writes total (4 per channel, X + scene-referenced Y)', cab.length === 8, `got ${cab.length}`);
  check('cabPolish reports channels X and Y', report !== undefined && report.channels.join(',') === 'X,Y', report?.channels.join(','));
  const xSelect = ops.findIndex((op) => op.kind === 'channel' && op.summary.startsWith('Cab 1: channel=X'));
  const ySelect = ops.findIndex((op) => op.kind === 'channel' && op.summary.startsWith('Cab 1: channel=Y'));
  check('cab channel selects emitted for X and Y', xSelect !== -1 && ySelect !== -1);
  check('base X window emits before the scene-referenced Y window', xSelect < ySelect);
  const yWrites = ops
    .map((op, i) => ({ op, i }))
    .filter(({ op }) => cab.includes(op) && op.summary.includes('[Y]'));
  check('4 cut writes in the Y window', yWrites.length === 4, `got ${yWrites.length}`);
  check('channel-select for Y precedes its cut writes', yWrites.every(({ i }) => i > ySelect));
  const irIdx = ops.findIndex((op) => op.kind === 'param' && op.summary.startsWith('Cab 1.cab '));
  const xWrites = ops
    .map((op, i) => ({ op, i }))
    .filter(({ op }) => cab.includes(op) && op.summary.includes('[X]'));
  check('X window keeps the spec cab param first, injected after', irIdx !== -1 && xWrites.every(({ i }) => i > irIdx));
  // Everything precedes the scene walk (its first op is the first
  // switch_scene in this spec; no single-scene shortcut passed).
  const sceneWalkIdx = ops.findIndex((op) => op.kind === 'switch_scene');
  check(
    'all injected windows precede the scene walk',
    sceneWalkIdx !== -1 && ySelect < sceneWalkIdx && yWrites.every(({ i }) => i < sceneWalkIdx),
  );
}

console.log('');
if (failures > 0) {
  console.error(`verify-axefx2-cab-polish: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-axefx2-cab-polish: all checks passed');
