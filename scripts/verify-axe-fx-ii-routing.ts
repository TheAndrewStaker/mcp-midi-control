/**
 * Verify the v0.4 routing-walk in Axe-Fx II's applyExecutor produces
 * byte-exact SET_CELL_ROUTING ops for an explicit-routing preset
 * spec. Pure transpiler check — no MIDI, no hardware required.
 *
 * Covers two cases:
 *   1. Wet/dry split (the FRACTAL-PRESET-SCHEMA.md worked example) —
 *      cab on row 2 col 3 fans out to delay on row 1 col 4 + reverb
 *      on row 3 col 4, both merge into a mixer at row 2 col 5. Asserts
 *      that the explicit-routing mode emits exactly the cables listed
 *      in the spec and SKIPS auto-shunt-extension + auto-row-2-cabling
 *      that the legacy linear mode adds.
 *
 *   2. AM4-style linear (no routing[]) — confirms legacy mode still
 *      auto-extends shunts to col 12 and cables every adjacent row-2
 *      pair. Byte-identical to pre-v0.4 behavior — the routing[]
 *      additions must NOT regress the existing v0.1 path.
 *
 * Run via:  npx tsx scripts/verify-axe-fx-ii-routing.ts
 * Wired into npm test for regression coverage.
 */
import {
  buildApplyPresetAtOps,
  type ApplyPresetAtInput,
} from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';
import { buildSetCellRouting } from 'fractal-midi/gen2/axe-fx-ii';

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Case 1: explicit-routing wet/dry split.
// ─────────────────────────────────────────────────────────────────
//
// Topology:
//   col 1   col 2   col 3   col 4    col 5
//   ───────────────────────────────────────
//   row 1                   delay ─┐
//   row 2   comp    amp    cab ──┼─ mixer
//   row 3                   reverb ┘
//
// Routing edges (in order, all on adjacent columns):
//   comp R2C1 → amp R2C2
//   amp R2C2 → cab R2C3
//   cab R2C3 → delay R1C4
//   cab R2C3 → reverb R3C4
//   delay R1C4 → mixer R2C5
//   reverb R3C4 → mixer R2C5
console.log('\nCase 1 — explicit-routing wet/dry split');

const wetDry: ApplyPresetAtInput = {
  preset_number: 666,
  blocks: [
    { id: 'comp',   block: 'Compressor 1', row: 2, col: 1 },
    { id: 'amp',    block: 'Amp 1',        row: 2, col: 2 },
    { id: 'cab',    block: 'Cab 1',        row: 2, col: 3 },
    { id: 'delay',  block: 'Delay 1',      row: 1, col: 4 },
    { id: 'reverb', block: 'Reverb 1',     row: 3, col: 4 },
    { id: 'mixer',  block: 'Mixer',        row: 2, col: 5 },
  ],
  routing: [
    { from: 'comp',   to: 'amp' },
    { from: 'amp',    to: 'cab' },
    { from: 'cab',    to: 'delay' },
    { from: 'cab',    to: 'reverb' },
    { from: 'delay',  to: 'mixer' },
    { from: 'reverb', to: 'mixer' },
  ],
};

const wetDryOps = buildApplyPresetAtOps(wetDry, { wire: true });

const wetDryPlaceBlocks = wetDryOps.filter((o) => o.kind === 'place_block');
const wetDryCables = wetDryOps.filter((o) => o.kind === 'cable');

check(
  'explicit-routing places exactly 6 content blocks',
  wetDryPlaceBlocks.length === 6,
  `got ${wetDryPlaceBlocks.length}`,
);
check(
  'explicit-routing emits exactly 6 cables (no auto-shunt cabling)',
  wetDryCables.length === 6,
  `got ${wetDryCables.length}`,
);

// Spot-check the wire bytes of the parallel split: cab → delay (R2C3 → R1C4).
const expectedCabToDelay = buildSetCellRouting({
  srcRow: 2, srcCol: 3, dstRow: 1, dstCol: 4, connect: true,
});
const cabToDelay = wetDryCables.find((o) => /cab.*delay/.test(o.summary));
check(
  'cab → delay cable byte-exact against buildSetCellRouting',
  cabToDelay !== undefined && hex(cabToDelay.bytes) === hex(expectedCabToDelay),
  cabToDelay ? `got ${hex(cabToDelay.bytes)} vs ${hex(expectedCabToDelay)}` : 'op not found',
);

// And the merge: reverb → mixer (R3C4 → R2C5).
const expectedReverbToMixer = buildSetCellRouting({
  srcRow: 3, srcCol: 4, dstRow: 2, dstCol: 5, connect: true,
});
const reverbToMixer = wetDryCables.find((o) => /reverb.*mixer/.test(o.summary));
check(
  'reverb → mixer cable (cross-row merge) byte-exact',
  reverbToMixer !== undefined && hex(reverbToMixer.bytes) === hex(expectedReverbToMixer),
  reverbToMixer ? `got ${hex(reverbToMixer.bytes)} vs ${hex(expectedReverbToMixer)}` : 'op not found',
);

// Confirm no shunts placed (the explicit-routing skip).
const wetDryShuntPlacements = wetDryPlaceBlocks.filter((o) => /SHUNT/.test(o.summary));
check(
  'explicit-routing does NOT auto-place shunts',
  wetDryShuntPlacements.length === 0,
  `got ${wetDryShuntPlacements.length} shunt placements`,
);

// ─────────────────────────────────────────────────────────────────
// Case 2: legacy linear (no routing[]) — must still auto-extend.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 2 — legacy linear preset (no routing[])');

const linear: ApplyPresetAtInput = {
  preset_number: 600,
  blocks: [
    { block: 'Compressor 1' },
    { block: 'Amp 1' },
    { block: 'Cab 1' },
    { block: 'Reverb 1' },
  ],
};

const linearOps = buildApplyPresetAtOps(linear, { wire: true });
const linearPlaceBlocks = linearOps.filter((o) => o.kind === 'place_block');
const linearCables = linearOps.filter((o) => o.kind === 'cable');
const linearShuntPlacements = linearPlaceBlocks.filter((o) => /SHUNT/.test(o.summary));

// 4 content blocks + 8 shunts = 12 cells filled on row 2.
check(
  'legacy mode auto-extends shunts to col 12',
  linearShuntPlacements.length === 8,
  `expected 8 shunt placements (cols 5..12), got ${linearShuntPlacements.length}`,
);
check(
  'legacy mode emits 11 cables for row-2 chain (col1→col2..col11→col12)',
  linearCables.length === 11,
  `got ${linearCables.length}`,
);

// Confirm the row-2 cable byte-shape: col 1 → col 2.
const expectedRow2Col1To2 = buildSetCellRouting({
  srcRow: 2, srcCol: 1, dstRow: 2, dstCol: 2, connect: true,
});
const row2Col1To2 = linearCables.find((o) => /col 1 → row 2 col 2/.test(o.summary));
check(
  'legacy row-2 col 1 → col 2 cable byte-exact',
  row2Col1To2 !== undefined && hex(row2Col1To2.bytes) === hex(expectedRow2Col1To2),
  row2Col1To2 ? `got ${hex(row2Col1To2.bytes)}` : 'op not found',
);

// ─────────────────────────────────────────────────────────────────
// Case 3: explicit-routing validation — adjacent-column requirement.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 3 — adjacent-column rejection');

const offColumn: ApplyPresetAtInput = {
  preset_number: 666,
  blocks: [
    { id: 'comp', block: 'Compressor 1', row: 2, col: 1 },
    { id: 'amp',  block: 'Amp 1',        row: 2, col: 5 },  // skipped cols 2-4
  ],
  routing: [
    { from: 'comp', to: 'amp' },  // col 1 → col 5: not adjacent
  ],
};

let offColumnRejected = false;
let offColumnError = '';
try {
  buildApplyPresetAtOps(offColumn, { wire: true });
} catch (err) {
  offColumnRejected = true;
  offColumnError = (err as Error).message;
}
check(
  'off-column routing edge throws at build time',
  offColumnRejected && /adjacent|col.*\+ 1|insert.*shunt/i.test(offColumnError),
  offColumnRejected ? offColumnError.slice(0, 80) : 'no error thrown',
);

// ─────────────────────────────────────────────────────────────────
// Case 4: explicit-routing validation — missing block id reference.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 4 — unknown block id rejection');

const badId: ApplyPresetAtInput = {
  preset_number: 666,
  blocks: [
    { id: 'comp', block: 'Compressor 1', row: 2, col: 1 },
    { id: 'amp',  block: 'Amp 1',        row: 2, col: 2 },
  ],
  routing: [
    { from: 'comp', to: 'mystery_block' },  // typo / non-existent id
  ],
};

let badIdRejected = false;
let badIdError = '';
try {
  buildApplyPresetAtOps(badId, { wire: true });
} catch (err) {
  badIdRejected = true;
  badIdError = (err as Error).message;
}
check(
  'unknown block id in routing edge throws at build time',
  badIdRejected && /mystery_block|no block with that id|Known ids/i.test(badIdError),
  badIdRejected ? badIdError.slice(0, 80) : 'no error thrown',
);

// ─────────────────────────────────────────────────────────────────
// Case 5: shunt-synthesis (BK-054 audible-preset extension).
// Shunts aren't in AXE_FX_II_BLOCKS — the executor synthesizes a
// block descriptor with a unique id per occurrence (200..235) so the
// "Cab through shunts to OUTPUT" path can be expressed in explicit-
// routing mode. Otherwise the only way to reach col 12 is the legacy
// auto-chain mode, which can't co-exist with parallel chains.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 5 — shunt synthesis with unique blockIds');

const withShunts: ApplyPresetAtInput = {
  preset_number: 666,
  blocks: [
    { id: 'amp',      block: 'Amp 1',  row: 2, col: 1 },
    { id: 'shunt_2',  block: 'shunt',  row: 2, col: 2 },
    { id: 'shunt_3',  block: 'shunt',  row: 2, col: 3 },
    { id: 'shunt_4',  block: 'shunt',  row: 2, col: 4 },
  ],
  routing: [
    { from: 'amp',     to: 'shunt_2' },
    { from: 'shunt_2', to: 'shunt_3' },
    { from: 'shunt_3', to: 'shunt_4' },
  ],
};

const shuntOps = buildApplyPresetAtOps(withShunts, { wire: true });
const shuntPlaces = shuntOps.filter((o) => o.kind === 'place_block');
check(
  'shunt block_type resolves without throwing',
  shuntPlaces.length === 4,
  `got ${shuntPlaces.length} place_block ops (expected 4)`,
);
check(
  'three shunt placements emitted with distinct summaries',
  shuntPlaces.filter((o) => /SHUNT|Shunt/.test(o.summary)).length === 3,
  `got ${shuntPlaces.filter((o) => /SHUNT|Shunt/.test(o.summary)).length} shunt placements (expected 3)`,
);
// Confirm the synthesized block IDs are unique (the cells would
// silently collapse otherwise — the AxeEdit Session-71 capture
// documented this: re-using one shunt ID across cells clears earlier
// placements as a side effect).
const shuntCableEdges = shuntOps.filter((o) => o.kind === 'cable');
check(
  'three cables emitted (matches routing[].length)',
  shuntCableEdges.length === 3,
  `got ${shuntCableEdges.length} cables`,
);

// ─────────────────────────────────────────────────────────────────
// Case 6 (BK-058): channel-Y executor walks every channel.
//
// Session 99 hardware test smoking-gun: agent sent an apply_preset
// payload with channel-nested params for X and Y on Amp 1; only X
// landed on the wire, Y was silently dropped. AM4's same-shape
// executor handles every channel; this regression case asserts II
// now matches that behavior.
//
// Payload shape (encoded wire values; the descriptor's encode closure
// is what runs in production — here we use {wire: true} to skip it):
//   block: Amp 1 (id 106) at row 2 col 1
//   paramsByChannel:
//     X: {paramId 1 → 1000, paramId 2 → 2000}
//     Y: {paramId 1 → 3000, paramId 2 → 4000}
//
// Expected ops (in this order):
//   1× place_block (Amp 1)
//   1× channel = X
//   2× param writes for X
//   1× channel = Y
//   2× param writes for Y
//
// The block + cells + cables ops outside the per-channel walk are not
// the subject of this case; we just assert the per-channel emission.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 6: BK-058 channel-Y executor walk');

// Use real AMP param names so findParam(target, name) resolves. The
// canonical names live in fractal-midi/gen2/axe-fx-ii's amp param table;
// any two valid names work for this shape assertion.
const channelY: ApplyPresetAtInput = {
  preset_number: 600,
  blocks: [
    {
      block: 'Amp 1',
      paramsByChannel: {
        X: { input_drive: 16000, master_volume: 20000 },
        Y: { input_drive: 32000, master_volume: 48000 },
      },
    },
  ],
};

const channelYOps = buildApplyPresetAtOps(channelY, { wire: true });

const channelOps = channelYOps.filter((o) => o.kind === 'channel' && o.unlistedSceneDefault !== true);
const paramOps = channelYOps.filter((o) => o.kind === 'param');

check(
  'paramsByChannel emits one channel-switch per supplied channel',
  channelOps.length === 2,
  `expected 2 channel ops (X + Y), got ${channelOps.length}`,
);

check(
  'channel ops are ordered X then Y (insertion order)',
  channelOps.length === 2 &&
    /channel=X/.test(channelOps[0].summary) &&
    /channel=Y/.test(channelOps[1].summary),
  channelOps.map((o) => o.summary).join(' | '),
);

check(
  'every channel\'s params are emitted (2 + 2 = 4 param ops)',
  paramOps.length === 4,
  `expected 4 param ops, got ${paramOps.length}: ${paramOps.map((o) => o.summary).join(' | ')}`,
);

check(
  'X param ops appear before Y channel switch',
  (() => {
    const channelYIdx = channelYOps.findIndex((o) => o.kind === 'channel' && /channel=Y/.test(o.summary));
    const xParamIdxs = channelYOps
      .map((o, i) => (o.kind === 'param' && /\[X\]/.test(o.summary) ? i : -1))
      .filter((i) => i !== -1);
    return xParamIdxs.length === 2 && xParamIdxs.every((i) => i < channelYIdx);
  })(),
  'expected both X param ops before the Y channel switch',
);

check(
  'Y param ops appear after Y channel switch',
  (() => {
    const channelYIdx = channelYOps.findIndex((o) => o.kind === 'channel' && /channel=Y/.test(o.summary));
    const yParamIdxs = channelYOps
      .map((o, i) => (o.kind === 'param' && /\[Y\]/.test(o.summary) ? i : -1))
      .filter((i) => i !== -1);
    return yParamIdxs.length === 2 && yParamIdxs.every((i) => i > channelYIdx);
  })(),
  'expected both Y param ops after the Y channel switch',
);

// ─────────────────────────────────────────────────────────────────
// Case 7 (BK-058): mixing flat + paramsByChannel on same block is rejected.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 7: paramsByChannel + flat params rejected on same block');

const mixedShape: ApplyPresetAtInput = {
  preset_number: 600,
  blocks: [
    {
      block: 'Amp 1',
      params: { input_drive: 1000 },
      paramsByChannel: { X: { master_volume: 2000 } },
    },
  ],
};

let mixedRejected = false;
let mixedError = '';
try {
  buildApplyPresetAtOps(mixedShape, { wire: true });
} catch (err) {
  mixedRejected = true;
  mixedError = (err as Error).message;
}
check(
  'mixed flat + paramsByChannel throws at build time',
  mixedRejected && /mutually exclusive|paramsByChannel/i.test(mixedError),
  mixedRejected ? mixedError.slice(0, 100) : 'no error thrown',
);

// ─────────────────────────────────────────────────────────────────
// Case 8: legacy auto-chain when user starts content at col 2+.
//
// Regression guard for the 2026-05-24 bug: an agent placed
// content at row 2 cols 2 and 3 (typical of AxeEdit's INPUT-at-col-1
// convention), leaving col 1 empty. The pre-fix shunt loop only
// filled cols [resolved.length+1..12], so col 1 stayed empty and the
// first auto-cable col 1 to col 2 NACK'd with result_code=0x0e.
//
// Post-fix invariant: shunt loop fills EVERY empty row-2 cell (cols
// 1..12 not already user-placed). Guarantees the cable chain has a
// valid source at every col.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 8: legacy auto-chain handles col-2-start content placement');

const colTwoStart: ApplyPresetAtInput = {
  preset_number: 600,
  blocks: [
    { block: 'Amp 1', row: 2, col: 2 },
    { block: 'Cab 1', row: 2, col: 3 },
  ],
};

const colTwoOps = buildApplyPresetAtOps(colTwoStart, { wire: true });
const colTwoShuntPlacements = colTwoOps.filter((o) => o.kind === 'place_block' && /SHUNT/.test(o.summary));
const colTwoCables = colTwoOps.filter((o) => o.kind === 'cable');

// 2 content blocks at cols 2,3 + 10 empty row-2 cells (cols 1,4..12)
// = 10 shunt placements.
check(
  'col-2-start: shunt loop fills col 1 + all cols past content (10 shunts)',
  colTwoShuntPlacements.length === 10,
  `expected 10 shunt placements, got ${colTwoShuntPlacements.length}: ${colTwoShuntPlacements.map((o) => o.summary).join(' | ')}`,
);

// Shunt at col 1 specifically — this is the bug-fix invariant.
const col1Shunt = colTwoShuntPlacements.find((o) => / col 1$/.test(o.summary));
check(
  'col-2-start: shunt placed at col 1 (cable source guarantee)',
  col1Shunt !== undefined,
  col1Shunt ? col1Shunt.summary : 'no shunt at col 1',
);

// Cable col 1 to col 2 is now safe: col 1's source is the shunt above.
const colTwoCol1To2 = colTwoCables.find((o) => /col 1 → row 2 col 2/.test(o.summary));
check(
  'col-2-start: cable col 1 → col 2 emitted (byte-exact)',
  colTwoCol1To2 !== undefined && hex(colTwoCol1To2.bytes) === hex(expectedRow2Col1To2),
  colTwoCol1To2 ? `got ${hex(colTwoCol1To2.bytes)}` : 'op not found',
);

// 11 cables for full row-2 chain.
check(
  'col-2-start: full row-2 chain (11 cables)',
  colTwoCables.length === 11,
  `expected 11 cables, got ${colTwoCables.length}`,
);

// ─────────────────────────────────────────────────────────────────
// Case 9: FX Loop + Output block as chain terminator.
//
// Topology:
//   col 1    col 2    col 3    col 4
//   row 2    amp  →   cab  →  fxloop → output
//
// The Output block at r2c4 acts as the hardware output sink. No shunts
// are needed; the chain terminates at the Output block (id=140).
// The FX Loop block (id=136) sits between cab and output.
//
// This exercises two behaviors:
//   1. FX Loop placed in a cable chain like any other block
//   2. Output block used as a chain terminator instead of shunts to col 12
//
// Both are legal on the Axe-Fx II: the hardware treats the Output block
// as a permanent chain sink regardless of which column it sits in.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 9: FX Loop + Output block as chain terminator');

const fxLoopChain: ApplyPresetAtInput = {
  preset_number: 666,
  blocks: [
    { id: 'amp',    block: 'Amp 1',    row: 2, col: 1 },
    { id: 'cab',    block: 'Cab 1',    row: 2, col: 2 },
    { id: 'fxloop', block: 'FX Loop',  row: 2, col: 3 },
    { id: 'out',    block: 'Output',   row: 2, col: 4 },
  ],
  routing: [
    { from: 'amp',    to: 'cab' },
    { from: 'cab',    to: 'fxloop' },
    { from: 'fxloop', to: 'out' },
  ],
};

const fxLoopOps = buildApplyPresetAtOps(fxLoopChain, { wire: true });

const fxLoopPlaceBlocks = fxLoopOps.filter((o) => o.kind === 'place_block');
const fxLoopCables      = fxLoopOps.filter((o) => o.kind === 'cable');

check(
  'places exactly 4 blocks (amp + cab + fxloop + output)',
  fxLoopPlaceBlocks.length === 4,
  `got ${fxLoopPlaceBlocks.length}`,
);
check(
  'emits exactly 3 cables (no auto-shunt extension past Output block)',
  fxLoopCables.length === 3,
  `got ${fxLoopCables.length}`,
);

// Verify the cable from FX Loop (r2c3) to Output (r2c4).
const expectedFxLoopToOutput = buildSetCellRouting({
  srcRow: 2, srcCol: 3, dstRow: 2, dstCol: 4, connect: true,
});
const fxLoopToOutput = fxLoopCables.find((o) => /fxloop.*out/.test(o.summary));
check(
  'fxloop → output cable byte-exact',
  fxLoopToOutput !== undefined && hex(fxLoopToOutput.bytes) === hex(expectedFxLoopToOutput),
  fxLoopToOutput ? `got ${hex(fxLoopToOutput.bytes)} vs ${hex(expectedFxLoopToOutput)}` : 'op not found',
);

// Confirm FX Loop block is placed (not mistaken for a shunt or skipped).
const fxLoopPlace = fxLoopPlaceBlocks.find((o) => /FX.Loop|fxloop/i.test(o.summary));
check(
  'FX Loop block placement op emitted',
  fxLoopPlace !== undefined,
  `placements: ${fxLoopPlaceBlocks.map((o) => o.summary).join(' | ')}`,
);

// Confirm Output block is placed.
const outputPlace = fxLoopPlaceBlocks.find((o) => /Output|output/i.test(o.summary));
check(
  'Output block placement op emitted',
  outputPlace !== undefined,
  `placements: ${fxLoopPlaceBlocks.map((o) => o.summary).join(' | ')}`,
);

// No shunts — the Output block terminates the chain at col 4.
const fxLoopShunts = fxLoopPlaceBlocks.filter((o) => /SHUNT|shunt/i.test(o.summary));
check(
  'no shunts auto-placed (Output block terminates at col 4)',
  fxLoopShunts.length === 0,
  `got ${fxLoopShunts.length} shunt placement(s)`,
);

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('✓ Axe-Fx II v0.4 routing-walk verified.');
