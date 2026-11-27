/**
 * Gen-3 grid READ-BACK and judgement: owns how a build (or any preset) is
 * checked after the writes.
 *
 *  - readBackGrid: the live grid read (fn=0x01 sub=0x2E), and when the unit
 *    does not answer it, the edit-buffer dump read (fn=0x03 7F 7F) decoded to
 *    its grid. A build is never judged without one of the two.
 *  - compareGridWithPlan: cell-by-cell compare (ids, shunts, input masks).
 *  - chainFromLiveGrid: the audio-path walk (Input -> ... -> Output).
 *  - judgeBuild: both of the above on the SAME read, folded into one
 *    chain_integrity. No read at all is ok:false ("NOT VERIFIED"), so a build
 *    nobody could check is never reported ok and never saved.
 *  - verifyGen3Chain: verify_chain on an arbitrary preset.
 */
import type { ChainIntegrityResult, DispatchCtx, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { ModernFractalCodec } from 'fractal-midi/gen3/axe-fx-iii';
import { expectedInputMasks, OUTPUT_1_EFFECT_ID, type BuildPlan, type PlannedCell } from './buildPlan.js';
import { readLiveGrid, type LiveCell } from './liveGrid.js';
import { readEditBufferPresetDump } from './presetDumpRead.js';
import { decodeGen3PresetDump } from './presetBody.js';

export interface VerifyDeps {
  codec: ModernFractalCodec;
  deviceLabel: string;
  getResponseTimeoutMs: number;
  shape: { grid?: { rows: number; cols: number } };
}

export interface GridReadBack {
  cells: LiveCell[];
  source: 'live grid' | 'edit-buffer dump';
}

const cellKey = (r: number, c: number): string => `${r},${c}`;
const rowMask = (rows: number): number => (1 << rows) - 1;
export const describePlannedCell = (c: PlannedCell): string =>
  c.kind === 'shunt' ? `shunt at r${c.row}c${c.col}` : `${c.id ?? c.block} at r${c.row}c${c.col}`;

/** Live grid, else the edit-buffer dump's decoded grid, else undefined. */
export async function readBackGrid(deps: VerifyDeps, ctx: DispatchCtx): Promise<GridReadBack | undefined> {
  const model = deps.codec.modelByte;
  const live = await readLiveGrid(ctx, model, deps.getResponseTimeoutMs);
  if (live !== undefined) return { cells: live, source: 'live grid' };
  try {
    const dump = await readEditBufferPresetDump(ctx.conn, model, deps.deviceLabel, deps.getResponseTimeoutMs);
    const grid = decodeGen3PresetDump(dump.raw, model).grid;
    if (grid === undefined) return undefined;
    return {
      source: 'edit-buffer dump',
      cells: grid.map((c) => ({
        row: c.row + 1,
        col: c.col + 1,
        ...(c.is_shunt ? { isShunt: true, shuntIndex: c.effect_id } : { isShunt: false, effectId: c.effect_id }),
        inputMask: c.route_flag,
      })),
    };
  } catch {
    return undefined;
  }
}

/** Compare a read-back grid with the plan. Returns the differences (empty = match). */
export function compareGridWithPlan(plan: BuildPlan, live: readonly LiveCell[], rows = 8): Array<{ row: number; col: number; reason: string }> {
  const diffs: Array<{ row: number; col: number; reason: string }> = [];
  const masks = expectedInputMasks(plan);
  const liveAt = new Map(live.map((c) => [cellKey(c.row, c.col), c]));
  const planned = new Set<string>();
  for (const p of plan.cells) {
    const k = cellKey(p.row, p.col);
    planned.add(k);
    const l = liveAt.get(k);
    if (!l) { diffs.push({ row: p.row, col: p.col, reason: `${describePlannedCell(p)} is missing (the cell is empty)` }); continue; }
    if (p.kind === 'shunt' ? !l.isShunt : l.isShunt || l.effectId !== p.effectId) {
      diffs.push({ row: p.row, col: p.col, reason: `${describePlannedCell(p)} expected, the unit holds ${l.isShunt ? 'a shunt' : `effect ${l.effectId}`}` });
      continue;
    }
    const got = l.inputMask & rowMask(rows);
    const want = (masks.get(k) ?? 0) & rowMask(rows);
    if (got !== want) {
      diffs.push({ row: p.row, col: p.col, reason: `${describePlannedCell(p)}: cables in from rows ${maskRows(got)}, expected ${maskRows(want)}` });
    }
  }
  for (const l of live) {
    if (!planned.has(cellKey(l.row, l.col))) {
      diffs.push({ row: l.row, col: l.col, reason: `unexpected ${l.isShunt ? 'shunt' : `effect ${l.effectId}`} at r${l.row}c${l.col}` });
    }
  }
  return diffs;
}

function maskRows(m: number): string {
  const rows: number[] = [];
  for (let k = 0; k < 8; k++) if ((m >> k) & 1) rows.push(k + 1);
  return rows.length ? rows.join('+') : 'none';
}

/**
 * Judge a build: the plan compare AND the audio-path walk, on one read.
 * Unverified (no read) is ok:false. Audio-path breaks fail the build when the
 * plan ends at an Output (every inferred build does); otherwise they ride the
 * summary as warnings.
 */
export function judgeBuild(plan: BuildPlan, rb: GridReadBack | undefined, deviceLabel: string, rows: number): ChainIntegrityResult {
  if (rb === undefined) {
    return {
      ok: false,
      breaks: [],
      summary: `NOT VERIFIED: ${deviceLabel} answered neither the live grid read (fn=0x01 sub=0x2E) nor the edit-buffer dump read, so the build cannot be confirmed and is not saved. Check the grid on the device.`,
      extra_round_trips: 2,
    };
  }
  const trips = rb.source === 'live grid' ? 1 : 2;
  const diffs = compareGridWithPlan(plan, rb.cells, rows);
  const audio = chainFromLiveGrid(rb.cells, rows);
  const endsAtOutput = plan.cells.some((c) => c.effectId === OUTPUT_1_EFFECT_ID || c.kind === 'output');
  const audioBreaks = audio.ok ? [] : audio.breaks;
  const blocks = plan.cells.filter((c) => c.kind !== 'shunt').length;
  const shunts = plan.cells.length - blocks;
  const breaks = [
    ...diffs.map((d) => ({ slot_ref: { row: d.row, col: d.col }, reason: d.reason })),
    ...(endsAtOutput ? audioBreaks.map((b) => ({ ...b, reason: `audio path: ${b.reason}` })) : []),
  ];
  const audioNote = !endsAtOutput && audioBreaks.length
    ? ` Audio path (warning, the spec has no Output): ${audioBreaks.slice(0, 2).map((b) => b.reason).join('; ')}.`
    : '';
  if (breaks.length === 0) {
    return {
      ok: true,
      breaks: [],
      summary: `read back (${rb.source}): the grid matches the build, intact across ${blocks} blocks (+${shunts} shunts) and ${plan.cables.length} cables${audio.ok ? ', every block on an Input -> Output path' : ''}.${audioNote}`,
      extra_round_trips: trips,
    };
  }
  return {
    ok: false,
    breaks,
    summary: `read back (${rb.source}): ${breaks.length} difference(s) from the build (${breaks.slice(0, 3).map((b) => b.reason).join('; ')}${breaks.length > 3 ? '; ...' : ''}).${audioNote}`,
    extra_round_trips: trips,
  };
}

/**
 * verify_chain for gen-3 grids: read the grid back (live, else the dump) and
 * walk the signal. Without either read the result is NOT VERIFIED and ok:false.
 */
export async function verifyGen3Chain(deps: VerifyDeps, ctx: DispatchCtx, _spec: PresetSpec): Promise<ChainIntegrityResult> {
  const rb = await readBackGrid(deps, ctx);
  if (rb === undefined) {
    return { ok: false, breaks: [], summary: `verify_chain: NOT VERIFIED, ${deps.deviceLabel} answered neither the live grid read nor the edit-buffer dump read.`, extra_round_trips: 2 };
  }
  const r = chainFromLiveGrid(rb.cells, deps.shape.grid?.rows);
  return rb.source === 'live grid' ? r : { ...r, summary: `${r.summary} (read from the edit-buffer dump)`, extra_round_trips: 2 };
}

/** Pure signal walk over a grid (exported for tests). */
export function chainFromLiveGrid(live: readonly LiveCell[], rows = 8): ChainIntegrityResult {
  const mask = (c: LiveCell): number => c.inputMask & rowMask(rows);
  const at = new Map(live.map((c) => [cellKey(c.row, c.col), c]));
  const isInput = (c: LiveCell): boolean => !c.isShunt && c.effectId !== undefined && c.effectId >= 37 && c.effectId <= 41;
  const isOutput = (c: LiveCell): boolean => !c.isShunt && c.effectId !== undefined && c.effectId >= 42 && c.effectId <= 45;
  const feeds = (src: LiveCell, dst: LiveCell): boolean => dst.col === src.col + 1 && ((mask(dst) >> (src.row - 1)) & 1) === 1;
  const fwd = new Set<string>();
  const stack = live.filter(isInput);
  for (const c of stack) fwd.add(cellKey(c.row, c.col));
  while (stack.length) {
    const c = stack.pop()!;
    for (const d of live) if (feeds(c, d) && !fwd.has(cellKey(d.row, d.col))) { fwd.add(cellKey(d.row, d.col)); stack.push(d); }
  }
  const back = new Set<string>();
  const bstack = live.filter(isOutput);
  for (const c of bstack) back.add(cellKey(c.row, c.col));
  while (bstack.length) {
    const d = bstack.pop()!;
    for (let r = 1; r <= rows; r++) {
      if (((mask(d) >> (r - 1)) & 1) === 0) continue;
      const s = at.get(cellKey(r, d.col - 1));
      if (s && !back.has(cellKey(s.row, s.col))) { back.add(cellKey(s.row, s.col)); bstack.push(s); }
    }
  }
  const breaks: Array<{ slot_ref: { row: number; col: number }; reason: string }> = [];
  if (!live.some(isInput)) breaks.push({ slot_ref: { row: 1, col: 1 }, reason: 'no Input block on the grid: nothing reaches the chain' });
  if (!live.some(isOutput)) breaks.push({ slot_ref: { row: 1, col: 1 }, reason: 'no Output block on the grid: nothing leaves the chain' });
  for (const b of live.filter((c) => !c.isShunt && !isInput(c) && !isOutput(c))) {
    const k = cellKey(b.row, b.col);
    if (!fwd.has(k)) breaks.push({ slot_ref: { row: b.row, col: b.col }, reason: `effect ${b.effectId} at r${b.row}c${b.col} gets no signal from an Input` });
    else if (!back.has(k)) breaks.push({ slot_ref: { row: b.row, col: b.col }, reason: `effect ${b.effectId} at r${b.row}c${b.col} does not reach an Output` });
  }
  const shunts = live.filter((c) => c.isShunt).length;
  const content = live.length - shunts;
  return breaks.length === 0
    ? { ok: true, breaks: [], summary: `verify_chain: intact across ${content} blocks (+${shunts} shunts), every block on an Input -> Output path.`, extra_round_trips: 1 }
    : { ok: false, breaks, summary: `verify_chain: ${breaks.length} break(s): ${breaks.slice(0, 3).map((b) => b.reason).join('; ')}${breaks.length > 3 ? '; ...' : ''}.`, extra_round_trips: 1 };
}
