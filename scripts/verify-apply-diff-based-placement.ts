#!/usr/bin/env tsx
/**
 * BK-084 mode-collapse golden: applyExecutor.ts's diff-based block
 * placement. `apply_preset` describes the complete desired chain
 * (unlisted blocks still clear — same contract as today's fresh build),
 * but a block already correctly placed at its target cell (same wire_id,
 * same cell) is now left COMPLETELY untouched at the wire level: no
 * clear, no re-place, no anti-screech mute/re-engage toggle. Its params
 * the caller's spec does not list therefore keep whatever the device
 * already has, instead of resetting to FRESH_DEFAULT_RECORDS the way a
 * clear+re-place always did. See docs/_private/MODE-COLLAPSE-DESIGN-
 * 2026-07-18.md file #2 and applyExecutor.ts's `readGridIntoSkipSet`
 * docstring for the full rationale.
 *
 * Two layers, matching the existing golden style (verify-screech-
 * bypass-during-build.ts for pure offline build-shape checks,
 * verify-grid-routing.ts for the mock-ApplyConn wire-level checks):
 *
 *   OFFLINE (buildApplyPresetOps only, no connection):
 *     - place_block ops carry cellRef + targetWireId.
 *     - The paired anti-screech bypass op (immediately after each
 *       place_block) carries the SAME cellRef, so the runtime can
 *       correlate a skipped placement with its mute.
 *     - A spec's own param writes for a block are emitted regardless of
 *       whether that block turns out to be unchanged at runtime (params
 *       don't know at build time what the device currently holds).
 *
 *   WIRE-LEVEL (runApplyPresetAtOps against a mock ApplyConn that
 *   answers GET_GRID_LAYOUT with a specific, non-empty starting grid):
 *     - A: unchanged block (device already holds the exact target
 *       wire_id at the exact cell) -> zero SET_GRID_CELL frames and zero
 *       bypass frames sent for that cell.
 *     - B: same-cell REPLACE (device holds a different wire_id) -> the
 *       place_block AND its anti-screech bypass fire normally.
 *     - C: multi-block selective skip -> one unchanged block is skipped,
 *       a second changed block in the same apply is NOT.
 *     - D: fresh insert into a genuinely-blank cell (blockId=0) is not
 *       mistaken for "unchanged" -> place_block fires normally.
 *     - E: a cell outside the spec's placement set still clears
 *       (regression guard: the skip logic must not touch the pre-
 *       existing clear-cell path).
 *
 * Run:  npx tsx scripts/verify-apply-diff-based-placement.ts
 * Status: offline, no hardware required.
 */

import { registerParamKindResolver } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { resolveAxeFxIIParamKind } from '@mcp-midi-control/fractal-gen2/calibration.js';

registerParamKindResolver('axe-fx-ii', resolveAxeFxIIParamKind);

import {
  buildApplyPresetOps,
  filterCabPolishForSkippedBlocks,
  runApplyPresetAtOps,
  type ApplyConn,
  type ApplyPresetAtOp,
  type ApplyPresetCabPolish,
} from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';
import { translateSpec } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function buildOps(spec: PresetSpec): ApplyPresetAtOp[] {
  const translated = translateSpec(spec);
  return buildApplyPresetOps(translated as Parameters<typeof buildApplyPresetOps>[0]);
}

// Known single-instance wire ids (see verify-apply-pipeline.ts, the
// existing golden this table was lifted from).
const AMP_ID = 106;
const CAB_ID = 108;
const REVERB_ID = 110;

// ── OFFLINE: build-time tagging ─────────────────────────────────────
console.log('OFFLINE: place_block / paired-bypass cellRef + targetWireId tagging');
{
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'amp', params: { X: { input_drive: 7 } } },
      { slot: { row: 2, col: 2 }, block_type: 'cab' },
    ],
  };
  const ops = buildOps(spec);

  const places = ops.filter((o) => o.kind === 'place_block' && !o.summary.includes('SHUNT'));
  check('every content place_block carries a cellRef', places.every((o) => o.cellRef !== undefined));
  check('every content place_block carries a targetWireId', places.every((o) => o.targetWireId !== undefined));

  const ampPlace = places.find((o) => o.summary.includes('Amp 1'));
  check('Amp 1 place_block targetWireId === 106', ampPlace?.targetWireId === AMP_ID, `got ${ampPlace?.targetWireId}`);
  check('Amp 1 place_block cellRef === {row:2,col:1}', ampPlace?.cellRef?.row === 2 && ampPlace?.cellRef?.col === 1);

  // The anti-screech bypass immediately follows its place_block and must
  // carry the identical cellRef (the runtime correlates a skip via this).
  for (const p of places) {
    const idx = ops.indexOf(p);
    const next = ops[idx + 1];
    check(
      `${p.summary}: paired bypass carries the same cellRef`,
      next?.kind === 'bypass' && next.cellRef?.row === p.cellRef?.row && next.cellRef?.col === p.cellRef?.col,
      `next kind=${next?.kind} cellRef=${JSON.stringify(next?.cellRef)}`,
    );
  }

  // A spec's own param write for a block is emitted unconditionally —
  // build time has no device state to consult, so the runtime skip
  // decision (wire-level, below) cannot omit an explicit caller write.
  const ampParamOps = ops.filter((o) => o.kind === 'param' && o.summary.startsWith('Amp 1.'));
  check('Amp 1.input_drive param write is present in the built ops', ampParamOps.length === 1, `got ${ampParamOps.length}`);
}

// ── Mock ApplyConn: answers GET_GRID_LAYOUT with a specific grid ────

const FUNC_MULTIPURPOSE_RESPONSE = 0x64;
const FUNC_SET_GRID_CELL = 0x05;
const FUNC_SET_CELL_ROUTING = 0x06;
const FUNC_GET_GRID_LAYOUT = 0x20;

function fabricateGridResponse(cells: readonly { row: number; col: number; blockId: number }[]): number[] {
  const byKey = new Map(cells.map((c) => [`${c.row},${c.col}`, c.blockId]));
  const bytes: number[] = [0xf0, 0x00, 0x01, 0x74, 0x07, FUNC_GET_GRID_LAYOUT];
  for (let cellIdx = 0; cellIdx < 48; cellIdx++) {
    const col = Math.floor(cellIdx / 4) + 1;
    const row = (cellIdx % 4) + 1;
    const blockId = byKey.get(`${row},${col}`) ?? 0;
    bytes.push(blockId & 0x7f, (blockId >> 7) & 0x7f, 0x00, 0x00);
  }
  bytes.push(0x00, 0xf7);
  return bytes;
}

/** Same mock-conn shape as verify-grid-routing.ts, extended with a seeded starting grid. */
function createMockConn(startingGrid: readonly { row: number; col: number; blockId: number }[]): {
  conn: ApplyConn;
  sentFrames: number[][];
} {
  const sentFrames: number[][] = [];
  let pendingPredicate: ((bytes: number[]) => boolean) | null = null;
  let pendingResolve: ((bytes: number[]) => void) | null = null;

  function fabricateResponse(sentBytes: number[]): number[] | undefined {
    if (sentBytes[0] !== 0xf0 || sentBytes[5] === undefined) return undefined;
    const fn = sentBytes[5];
    if (fn === FUNC_GET_GRID_LAYOUT) return fabricateGridResponse(startingGrid);
    if (fn === FUNC_SET_GRID_CELL) {
      return [0xf0, 0x00, 0x01, 0x74, 0x07, FUNC_MULTIPURPOSE_RESPONSE, FUNC_SET_GRID_CELL, 0x00, 0x00, 0xf7];
    }
    if (fn === FUNC_SET_CELL_ROUTING) {
      return [0xf0, 0x00, 0x01, 0x74, 0x07, FUNC_MULTIPURPOSE_RESPONSE, FUNC_SET_CELL_ROUTING, 0x00, 0x00, 0xf7];
    }
    // The safety-mute's paired GET_BLOCK_PARAMETER_VALUE read (fn=0x02) for
    // the Output block's level_1 (effectId 140, paramId 0) — any spec with
    // 'param' ops triggers the mute/restore round trip. Answer with a
    // parseable "0.00" dB label; the exact value doesn't matter to these
    // goldens, only that the read resolves instead of timing out.
    if (fn === 0x02 && sentBytes[6] === 12 && sentBytes[7] === 1 && sentBytes[8] === 0 && sentBytes[9] === 0) {
      const label = [0x30, 0x2e, 0x30, 0x30, 0x00]; // "0.00\0"
      return [0xf0, 0x00, 0x01, 0x74, 0x07, 0x02, 12, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...label, 0x00, 0xf7];
    }
    // GET_BLOCK_CHANNEL (fn=0x11): the "default channel=X, no explicit
    // channel supplied" op verifies its own switch landed. Echo back
    // whatever effectId was asked, always channel X (0) -- matching the
    // op's own expectedChannel in every spec these goldens build.
    if (fn === 0x11) {
      return [0xf0, 0x00, 0x01, 0x74, 0x07, 0x11, sentBytes[6], sentBytes[7], 0x00, 0x00, 0xf7];
    }
    return undefined;
  }

  const conn: ApplyConn = {
    send(bytes: number[]): void {
      sentFrames.push([...bytes]);
      if (pendingPredicate && pendingResolve) {
        const fab = fabricateResponse(bytes);
        if (fab !== undefined && pendingPredicate(fab)) {
          const resolve = pendingResolve;
          pendingPredicate = null;
          pendingResolve = null;
          queueMicrotask(() => resolve(fab));
        }
      }
    },
    receiveSysExMatching(predicate: (bytes: number[]) => boolean, timeoutMs?: number): Promise<number[]> {
      return new Promise<number[]>((resolve, reject) => {
        pendingPredicate = predicate;
        pendingResolve = resolve;
        const timer = setTimeout(() => {
          pendingPredicate = null;
          pendingResolve = null;
          reject(new Error('mock conn: no matching response within timeout'));
        }, timeoutMs ?? 5000);
        timer.unref?.();
      });
    },
  };

  return { conn, sentFrames };
}

// buildSetGridCell's payload order is [FUNC, blockIdLo, blockIdHi, cellIdx,
// reserved] (see fractal-midi/gen2/axe-fx-ii/setParam.ts) -> after the 5-byte
// envelope header, blockId is at bytes[6..7] and the cell index at bytes[8].
function sentGridCellFrames(sentFrames: number[][]): { cell: number; blockId: number }[] {
  return sentFrames
    .filter((f) => f[5] === FUNC_SET_GRID_CELL)
    .map((f) => ({ cell: f[8], blockId: (f[6] & 0x7f) | ((f[7] & 0x7f) << 7) }));
}

function sentBypassFrames(sentFrames: number[][]): number[][] {
  // fn=0x02 PARAM_SET with paramId=255 is the bypass envelope (see
  // buildSetBlockBypass in fractal-midi). paramId septet pair is at
  // bytes[8..9] per encode14; 255 septet-encodes to lo=127(0x7f) hi=1.
  return sentFrames.filter((f) => f[5] === 0x02 && f[8] === 0x7f && f[9] === 0x01);
}

// Cell-index helper matching the codec: cell = (col-1)*4 + (row-1).
const cellIndex = (row: number, col: number): number => (col - 1) * 4 + (row - 1);

// ── A: unchanged block — zero wire ops for that cell ─────────────────
console.log('\nWire-level A: unchanged block (device already holds the exact target) stays untouched');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
  };
  const ops = buildOps(spec);
  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: AMP_ID }]);
  const result = await runApplyPresetAtOps(conn, ops);

  const gridCells = sentGridCellFrames(sentFrames);
  check('no SET_GRID_CELL frame sent for (2,1)', !gridCells.some((c) => c.cell === cellIndex(2, 1)), JSON.stringify(gridCells));
  // The anti-screech PRE-bypass (paired with placement) is skipped, but the
  // flat finalization's FINAL bypass still fires unconditionally for every
  // resolved block (design doc: "leave... final bypass state... unchanged").
  // So exactly 1 bypass frame (final engage), not 0 and not 2.
  check('exactly 1 bypass frame (final engage; anti-screech mute skipped)', sentBypassFrames(sentFrames).length === 1, `${sentBypassFrames(sentFrames).length} bypass frames`);
  check('summaries note the placement skip', result.summaries.some((s) => s.includes('already correctly placed')));
  check('summaries note the paired bypass skip', result.summaries.some((s) => s.includes('paired placement was unchanged')));
  check('result.ok === true', result.ok === true);
}

// ── B: same-cell REPLACE — place + anti-screech bypass fire normally ─
//
// Uses 'reverb' (not 'cab') as the replacement target: a bare cab
// placement triggers the unrelated BK-103c cab-polish auto-injection
// (appends low_cut/high_cut/filter_slope/room_level params), which would
// pull in the output-level safety-mute round trip this mock doesn't
// answer. Keeping this golden scoped to the placement-diff mechanism.
console.log('\nWire-level B: same-cell REPLACE (device holds a different wire_id) places normally');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'reverb' }],
  };
  const ops = buildOps(spec);
  // Device currently holds the AMP at (2,1); spec wants REVERB there.
  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: AMP_ID }]);
  const result = await runApplyPresetAtOps(conn, ops);

  const gridCells = sentGridCellFrames(sentFrames);
  const placedReverb = gridCells.find((c) => c.cell === cellIndex(2, 1));
  check('SET_GRID_CELL sent for (2,1) targeting the REVERB wire_id', placedReverb?.blockId === REVERB_ID, JSON.stringify(placedReverb));
  check('exactly 1 SET_GRID_CELL frame for the replace (no separate clear)', gridCells.filter((c) => c.cell === cellIndex(2, 1)).length === 1);
  // Anti-screech pre-bypass (1) + final engage (1) = 2 for the one replaced block.
  check('bypass fires twice (anti-screech + final) for the replaced block', sentBypassFrames(sentFrames).length === 2, `${sentBypassFrames(sentFrames).length} bypass frames`);
  check('result.ok === true', result.ok === true);
}

// ── C: multi-block selective skip ────────────────────────────────────
console.log('\nWire-level C: multi-block — one unchanged skipped, one changed placed');
{
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'amp' },   // unchanged (device already has amp here)
      { slot: { row: 2, col: 2 }, block_type: 'reverb' }, // changed (device has cab here)
    ],
  };
  const ops = buildOps(spec);
  const { conn, sentFrames } = createMockConn([
    { row: 2, col: 1, blockId: AMP_ID },
    { row: 2, col: 2, blockId: CAB_ID },
  ]);
  const result = await runApplyPresetAtOps(conn, ops);

  const gridCells = sentGridCellFrames(sentFrames);
  check('no SET_GRID_CELL for the unchanged amp at (2,1)', !gridCells.some((c) => c.cell === cellIndex(2, 1)));
  const placedReverb = gridCells.find((c) => c.cell === cellIndex(2, 2));
  check('SET_GRID_CELL sent for the changed reverb at (2,2)', placedReverb?.blockId === REVERB_ID, JSON.stringify(placedReverb));
  check(
    'exactly 1 SET_GRID_CELL frame at (2,2) (no separate clear for the replace)',
    gridCells.filter((c) => c.cell === cellIndex(2, 2)).length === 1,
    `got ${gridCells.filter((c) => c.cell === cellIndex(2, 2)).length}`,
  );
  // The changed reverb: anti-screech pre-bypass + final engage = 2.
  // The unchanged amp: anti-screech is skipped, but the flat finalization
  // still asserts its final bypass state unconditionally = 1. Total 3.
  check('bypass frames: 2 for the changed block + 1 final for the unchanged block = 3', sentBypassFrames(sentFrames).length === 3, `got ${sentBypassFrames(sentFrames).length}`);
  check('result.ok === true', result.ok === true);
}

// ── D: fresh insert into a genuinely-blank cell is not mistaken for unchanged ─
console.log('\nWire-level D: empty target cell (blockId=0) is never treated as "unchanged"');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
  };
  const ops = buildOps(spec);
  const { conn, sentFrames } = createMockConn([]); // fully empty grid
  const result = await runApplyPresetAtOps(conn, ops);

  const gridCells = sentGridCellFrames(sentFrames);
  const placedAmp = gridCells.find((c) => c.cell === cellIndex(2, 1));
  check('SET_GRID_CELL sent for the fresh insert', placedAmp?.blockId === AMP_ID, JSON.stringify(placedAmp));
  check('result.ok === true', result.ok === true);
}

// ── E: a non-placed cell holding content still clears (regression guard) ─
console.log('\nWire-level E: a cell outside the spec\'s placement set still clears');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
  };
  const ops = buildOps(spec);
  // A prior preset's Cab sits at (2,2), which this spec does not mention.
  const { conn, sentFrames } = createMockConn([
    { row: 2, col: 1, blockId: AMP_ID },
    { row: 2, col: 2, blockId: CAB_ID },
  ]);
  const result = await runApplyPresetAtOps(conn, ops);

  const gridCells = sentGridCellFrames(sentFrames);
  const clearedAt22 = gridCells.find((c) => c.cell === cellIndex(2, 2));
  check('(2,2) gets cleared (blockId 0) — not part of the new chain', clearedAt22?.blockId === 0, JSON.stringify(clearedAt22));
  check('(2,1), unchanged, still gets zero SET_GRID_CELL frames', !gridCells.some((c) => c.cell === cellIndex(2, 1)));
  check('result.ok === true', result.ok === true);
}

// ── F: an unchanged cab block skips its auto-injected cab-polish defaults ─
//
// Review finding (2026-07-18, post-mode-collapse Sonnet review): cab-polish
// injection decides what to inject at BUILD time (buildApplyPresetAtOps),
// before the RUNTIME placement-skip decision exists. Left unfixed, a spec
// that re-lists a cab block the caller has no opinion on would silently
// re-inject (and overwrite) the cab EQ every single apply_preset call, even
// when that block's placement was itself skipped as unchanged — directly
// contradicting "unlisted params keep the device's current value." Fixed by
// tagging injected-only param ops with `injectedOnly` + the block's
// `cellRef`, and skipping them at runtime alongside a skipped placement.
const septet = (v: number): readonly [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
const BYPASS_PARAM_ID = 255; // buildSetBlockBypass also rides fn=0x02 on the same effectId; exclude it explicitly.
function isEffectParamFrame(b: number[], effectId: number): boolean {
  if (b[0] !== 0xf0 || (b[5] !== 0x02 && b[5] !== 0x2e)) return false;
  const [effLo, effHi] = septet(effectId);
  if (b[6] !== effLo || b[7] !== effHi) return false;
  const [paramLo, paramHi] = septet(BYPASS_PARAM_ID);
  return !(b[8] === paramLo && b[9] === paramHi); // exclude the block's own bypass write
}

console.log('\nWire-level F: an unchanged cab block skips auto-injected cab-polish defaults');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'cab' }], // bare placement, no opinion -> triggers cab-polish
  };
  const ops = buildOps(spec);
  const cabPolishParamOps = ops.filter((o) => o.kind === 'param' && o.summary.startsWith('Cab 1.'));
  check('build time: cab-polish still queues its 4 injected param ops', cabPolishParamOps.length === 4, String(cabPolishParamOps.length));
  check('build time: every queued cab-polish op is tagged injectedOnly', cabPolishParamOps.every((o) => o.injectedOnly === true));

  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: CAB_ID }]); // already the cab -> skipped placement
  const result = await runApplyPresetAtOps(conn, ops);
  const cabFrames = sentFrames.filter((f) => isEffectParamFrame(f, CAB_ID));
  check('runtime: zero cab-polish frames sent for the unchanged block', cabFrames.length === 0, `${cabFrames.length} frames: ${JSON.stringify(cabFrames.map((f) => f.slice(5, 10)))}`);
  check('summaries note the injected-default skip', result.summaries.some((s) => s.includes('auto-injected default skipped')));
  check('runtime reports "Cab 1" in skippedInjectedParamBlocks (so the caller can drop the stale auto_applied claim)', result.skippedInjectedParamBlocks.has('Cab 1'), JSON.stringify([...result.skippedInjectedParamBlocks]));
  check('result.ok === true', result.ok === true);
}

console.log('\nOFFLINE: filterCabPolishForSkippedBlocks (pure) drops a stale auto_applied claim');
{
  // Regression guard for the review finding fixed 2026-07-18: onCabPolish's
  // report is built at BUILD time, before the runtime skip decision exists,
  // so ApplyResult.auto_applied could claim a default was "auto-applied" to
  // a block the runtime actually left completely untouched. writer.ts now
  // calls this BEFORE mergeAutoApplied to strip that stale claim.
  const singleCabReport: ApplyPresetCabPolish = {
    channels: ['X'],
    params: { low_cut: '80 Hz', high_cut: '6500 Hz', filter_slope: '12 dB/OCT', room_level: '8%' },
    note: 'Mix-ready cab defaults were auto-applied...',
  };
  check('single-cab report unchanged when nothing was skipped', filterCabPolishForSkippedBlocks(singleCabReport, new Set()) === singleCabReport);
  check('single-cab report DROPPED entirely when its one block was skipped', filterCabPolishForSkippedBlocks(singleCabReport, new Set(['Cab 1'])) === undefined);
  check('undefined report stays undefined regardless of skips', filterCabPolishForSkippedBlocks(undefined, new Set(['Cab 1'])) === undefined);

  const multiCabReport: ApplyPresetCabPolish = {
    channels: ['Cab 1 X', 'Cab 2 X'],
    params: { low_cut: '80 Hz', high_cut: '6500 Hz', filter_slope: '12 dB/OCT', room_level: '8%' },
    note: 'Mix-ready cab defaults were auto-applied...',
  };
  const filtered = filterCabPolishForSkippedBlocks(multiCabReport, new Set(['Cab 2']));
  check('multi-cab report: only the skipped block\'s channel is removed, the other survives', filtered !== undefined && filtered.channels.length === 1 && filtered.channels[0] === 'Cab 1 X', JSON.stringify(filtered));
  const filteredBoth = filterCabPolishForSkippedBlocks(multiCabReport, new Set(['Cab 1', 'Cab 2']));
  check('multi-cab report: BOTH blocks skipped -> report dropped entirely', filteredBoth === undefined);
}

console.log('\nWire-level F2: a genuinely fresh/changed cab block STILL gets its cab-polish defaults');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'cab' }],
  };
  const ops = buildOps(spec);
  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: AMP_ID }]); // different block there -> real replace
  const result = await runApplyPresetAtOps(conn, ops);
  const cabFrames = sentFrames.filter((f) => isEffectParamFrame(f, CAB_ID));
  check('runtime: all 4 cab-polish frames sent for the freshly-placed block', cabFrames.length === 4, String(cabFrames.length));
  check('runtime: skippedInjectedParamBlocks is empty (nothing was skipped)', result.skippedInjectedParamBlocks.size === 0, JSON.stringify([...result.skippedInjectedParamBlocks]));
  check('result.ok === true', result.ok === true);
}

console.log('\nWire-level F3: a caller-listed cab param on an unchanged block still fires (only the AUTO default skips)');
{
  // A REAL user-listed cab opinion suppresses injection entirely (existing,
  // unaffected behavior) while the write itself still lands on the
  // unchanged cab cell -- i.e. injectedOnly never masks a real write.
  const specWithOpinion: PresetSpec = {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'cab', params: { low_cut: 120 } }],
  };
  const ops = buildOps(specWithOpinion);
  const cabPolishParamOps = ops.filter((o) => o.kind === 'param' && o.summary.startsWith('Cab 1.'));
  check('an explicit cab opinion suppresses injection (1 op, not 4, none tagged injectedOnly)', cabPolishParamOps.length === 1 && cabPolishParamOps[0].injectedOnly !== true, JSON.stringify(cabPolishParamOps.map((o) => ({ summary: o.summary, injectedOnly: o.injectedOnly }))));

  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: CAB_ID }]); // unchanged placement
  const result = await runApplyPresetAtOps(conn, ops);
  const cabFrames = sentFrames.filter((f) => isEffectParamFrame(f, CAB_ID));
  check('the caller-listed low_cut write STILL fires on the unchanged block (not skipped)', cabFrames.length === 1, String(cabFrames.length));
  check('result.ok === true', result.ok === true);
}

// ── G: scene-level-init only fires when this apply structurally changed something ─
//
// Founder decision (2026-07-18, following the cab-polish review finding):
// output.scene_N_main resets to 0 dB have no single block/cell to key off
// (they address the Output block globally), so they're gated on the
// coarser `anyStructuralChange` signal instead of a per-block skip.
const OUTPUT_ID = 140;

console.log('\nWire-level G: nothing changed at all -> scene-level-init is skipped entirely');
{
  const spec: PresetSpec = { slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }] };
  const ops = buildOps(spec);
  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: AMP_ID }]); // unchanged
  const result = await runApplyPresetAtOps(conn, ops);
  const sceneLevelFrames = sentFrames.filter((f) => isEffectParamFrame(f, OUTPUT_ID));
  check('zero scene-level frames sent when nothing changed', sceneLevelFrames.length === 0, String(sceneLevelFrames.length));
  check('summaries note the scene-level-init skip', result.summaries.some((s) => s.includes('scene-level-init skipped')));
  check('result.ok === true', result.ok === true);
}

console.log('\nWire-level G2: a genuine change (replace) -> all 8 scene-level frames still fire');
{
  const spec: PresetSpec = { slots: [{ slot: { row: 2, col: 1 }, block_type: 'reverb' }] };
  const ops = buildOps(spec);
  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: AMP_ID }]); // real replace
  const result = await runApplyPresetAtOps(conn, ops);
  const sceneLevelFrames = sentFrames.filter((f) => isEffectParamFrame(f, OUTPUT_ID));
  check('all 8 scene-level frames sent when content genuinely changed', sceneLevelFrames.length === 8, String(sceneLevelFrames.length));
  check('result.ok === true', result.ok === true);
}

console.log('\nWire-level G3: shunt-id churn ALONE (unchanged content, stale shunts refreshed) does not count as a change');
{
  const spec: PresetSpec = { slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }] };
  const ops = buildOps(spec);
  // The amp is unchanged, but cols 2-12 already hold a PRIOR build's shunts
  // (arbitrary ids in the firmware-reserved 200..235 range) that will be
  // cleared and re-placed with THIS build's fresh sequential shunt ids —
  // pure numbering churn, sonically a no-op, must NOT trip anyStructuralChange.
  const staleShunts = Array.from({ length: 11 }, (_, i) => ({ row: 2, col: i + 2, blockId: 220 + i }));
  const { conn, sentFrames } = createMockConn([{ row: 2, col: 1, blockId: AMP_ID }, ...staleShunts]);
  const result = await runApplyPresetAtOps(conn, ops);
  const shuntClears = sentFrames.filter((f) => f[5] === 0x05).length; // some SET_GRID_CELL traffic for the shunt refresh is expected
  const sceneLevelFrames = sentFrames.filter((f) => isEffectParamFrame(f, OUTPUT_ID));
  check('shunt-id churn alone still produces SET_GRID_CELL traffic (sanity: the scenario is real)', shuntClears > 0, String(shuntClears));
  check('zero scene-level frames sent (shunt renumbering is not a structural change)', sceneLevelFrames.length === 0, String(sceneLevelFrames.length));
  check('result.ok === true', result.ok === true);
}

// ── Report ────────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.error(`x ${failed} diff-based-placement check(s) FAILED.`);
  process.exit(1);
}
console.log('All diff-based-placement checks pass.');
