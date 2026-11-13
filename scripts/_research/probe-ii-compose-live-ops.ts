/**
 * BK-084 SURGICAL LIVE COMPOSE hardware confirmation, non-interactive.
 *
 * Tests `planIILiveComposeOps` / `buildComposeLiveApplyOps` — the
 * live-write successor to `composeImageChain`'s whole-image push,
 * built to match AxeEdit's own confirmed wire behavior byte-for-byte
 * (2026-07-17 mining of `ii-axe-edit-removed-chorus.pcapng` and
 * `ii-axe-edit-filter-replaced-with-amp2.pcapng`: both a mid-chain
 * REMOVE and a same-cell TYPE REPLACE are exactly ONE live fn 0x05
 * SET_GRID_CELL write, never paired with fn 0x06). This probe removes
 * one currently-placed block and, AT THE SAME CELL, inserts a
 * different currently-ABSENT always-tweaked-family block — the
 * same-cell-replace shape — via LIVE single-cell writes instead of a
 * whole-image splice-and-push, then confirms via the device's own
 * fn 0x1F read that the inserted block's bytes match
 * FRESH_DEFAULT_RECORDS exactly, and via a live fn 0x20 GET_GRID_LAYOUT
 * read that the grid itself now shows the new placement.
 *
 * This is the untested leg `planIILiveComposeOps` inherits: the
 * planner and the fn 0x05 write shape are each independently proven
 * (offline goldens in fractal-midi; fn 0x05 SET_GRID_CELL itself is
 * hardware-confirmed from unrelated prior sessions), but no prior
 * hardware test has driven THIS planner's output through a live
 * connection end-to-end.
 *
 * Working-buffer only. No save_authorized anywhere in this script;
 * flash is never touched. Self-restoring: the pristine baseline is
 * pushed back (via the existing whole-image restore path, independent
 * of what this probe is testing) and verified byte-identical before
 * exit, on every path including the catch handler.
 *
 * Preconditions: Axe-Fx II XL+ connected, a preset with at least one
 * removable (non-tail-resident) content block loaded — any preset
 * works as long as at least one FRESH_DEFAULT_RECORDS family (Amp 1/2,
 * Cab, Reverb, Delay, Multi Delay, Pitch, Drive) is currently ABSENT
 * from the chain (there's room to insert one fresh).
 *
 * Run:  npx tsx scripts/_research/probe-ii-compose-live-ops.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { ensureConnection } from '@mcp-midi-control/core/server-shared/connections.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import { parsePresetDump, extractPresetName } from '@mcp-midi-control/fractal-gen2/presetDump.js';
import { runApplyPresetAtOps, type ApplyConn } from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';
import { buildComposeLiveApplyOps } from '@mcp-midi-control/fractal-gen2/tools/composeLiveOps.js';
import {
  BLOCK_BY_ID,
  buildGetGridLayout,
  buildGetAllParams,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  FRESH_DEFAULT_RECORDS,
  II_TAIL_RESIDENT_WIRE_IDS,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const TAIL_RESIDENT = new Set<number>(II_TAIL_RESIDENT_WIRE_IDS);
const d14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
const d16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);

async function readFn1f(conn: ReturnType<typeof ensureConnection>, effectId: number, windowMs = 1200): Promise<number[] | undefined> {
  const frames: number[][] = [];
  const unsub = conn.onMessage((b: number[]) => {
    if (b[0] === 0xf0 && b[4] === 0x07 && (b[5] === 0x74 || b[5] === 0x75 || b[5] === 0x76)) frames.push([...b]);
  });
  conn.send(buildGetAllParams(effectId, { modelId: 0x07 }));
  await new Promise((r) => setTimeout(r, windowMs));
  unsub();
  const values: number[] = [];
  let seenHeader = false;
  for (const f of frames) {
    if (f[5] === 0x74) seenHeader = true;
    else if (f[5] === 0x75 && seenHeader) {
      const n = d14(f[6], f[7]);
      for (let i = 0; i < n; i++) {
        const off = 8 + i * 3;
        if (off + 2 >= f.length - 2) break;
        values.push(d16(f[off], f[off + 1], f[off + 2]));
      }
    }
  }
  return seenHeader ? values : undefined;
}

async function readGrid(conn: ApplyConn): Promise<ReturnType<typeof parseGetGridLayoutResponse>> {
  const gridPromise = conn.receiveSysExMatching((b: number[]) => isGetGridLayoutResponse(b, 0x07), 1500);
  conn.send(buildGetGridLayout({ modelId: 0x07 }));
  return parseGetGridLayoutResponse(await gridPromise, 0x07);
}

async function main(): Promise<void> {
  console.log('── BK-084 surgical LIVE compose: same-cell replace via live fn 0x05 writes (Axe-Fx II XL+) ──');
  const conn = ensureConnection('axe-fx-ii');
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => ensureConnection('axe-fx-ii', true) } as unknown as DispatchCtx;

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
  const outDir = path.join('samples', 'captured', `bk084-compose-live-ops-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const restoreBaseline = async (baseline: Uint8Array): Promise<boolean> => {
    const r = await restorePresetBinaryAxeFxII(ctx, baseline);
    if (!r.ok) return false;
    return bytesEqual(await dumpWorkingBufferBytes(ctx), baseline);
  };

  console.log('\nPhase A: baseline dump + backup...');
  const baseline = await dumpWorkingBufferBytes(ctx);
  writeFileSync(path.join(outDir, 'baseline.syx'), Buffer.from(baseline));
  const presetName = extractPresetName(parsePresetDump(baseline));
  console.log(`  baseline "${presetName}" dumped (${baseline.length} B) -> ${outDir}`);

  try {
    const beforeCells = await readGrid(conn);
    const placedCells = beforeCells.filter((c) => c.blockId !== 0 && c.blockId < 200 && !TAIL_RESIDENT.has(c.blockId));
    console.log(`  placed content blocks: ${placedCells.map((c) => `${BLOCK_BY_ID[c.blockId]?.name ?? c.blockId}@(${c.col},${c.row})`).join(', ')}`);
    check('A: at least 1 removable content block placed', placedCells.length >= 1, `got ${placedCells.length}`);
    if (placedCells.length < 1) throw new Error('no placed blocks to run this probe safely');

    const placedIds = new Set(placedCells.map((c) => c.blockId));
    const insertWireId = Object.keys(FRESH_DEFAULT_RECORDS).map(Number).find((id) => !placedIds.has(id));
    check('A: found a FRESH_DEFAULT_RECORDS family currently ABSENT from the chain', insertWireId !== undefined, insertWireId === undefined ? `all placed: ${[...placedIds].join(',')}` : `will replace with wireId ${insertWireId} (${FRESH_DEFAULT_RECORDS[insertWireId]?.blockName})`);
    if (insertWireId === undefined) throw new Error('every FRESH_DEFAULT_RECORDS family is already placed; nothing to insert as a fresh block');

    // Replace the LAST placed block (arbitrary but deterministic) at its
    // OWN cell — the same-cell-replace shape AxeEdit's own
    // filter-replaced-with-amp2 capture shows as ONE fn 0x05 write.
    const replaceCell = placedCells[placedCells.length - 1];
    const replaceWireId = replaceCell.blockId;
    console.log(`  replacing ${BLOCK_BY_ID[replaceWireId]?.name ?? replaceWireId}@(${replaceCell.col},${replaceCell.row}) with ${FRESH_DEFAULT_RECORDS[insertWireId].blockName}, everything else untouched`);

    console.log('\nPhase B: plan the live ops (offline, no wire traffic yet)...');
    const cellsForPlan = beforeCells.map((c) => ({ col: c.col, row: c.row, id: c.blockId }));
    const targets = placedCells
      .filter((c) => c.blockId !== replaceWireId)
      .map((c) => ({ wireId: c.blockId, gridCell: { col: c.col, row: c.row } }));
    targets.push({ wireId: insertWireId, gridCell: { col: replaceCell.col, row: replaceCell.row } });

    const plan = buildComposeLiveApplyOps(cellsForPlan, targets, { modelId: 0x07 });
    check('B: plan accepted offline', plan.ok, plan.ok ? '' : plan.reason);
    if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
    check(`B: removed=[${replaceWireId}], inserted=[${insertWireId}]`, plan.removed.length === 1 && plan.removed[0] === replaceWireId && plan.inserted.length === 1 && plan.inserted[0] === insertWireId);
    check(`B: ${plan.unchanged.length} blocks reported unchanged`, plan.unchanged.length === placedCells.length - 1);
    // The AxeEdit-fidelity assertion: same-cell replace must collapse to
    // ONE live write, never a clear-then-place pair.
    check('B: same-cell replace planned as exactly ONE live op (no separate clear)', plan.ops.length === 1, `got ${plan.ops.length} ops: ${plan.ops.map((o) => o.summary).join(' | ')}`);

    console.log('\nPhase C: SEND the live op(s) through the hardened executor (the untested leg)...');
    const runResult = await runApplyPresetAtOps(conn, [...plan.ops], { modelId: 0x07 });
    for (const s of runResult.summaries) console.log(s);
    check('C: live write acked (0 NACKs)', runResult.nackedSteps.length === 0, `${runResult.nackedSteps.length} NACK(s)`);

    console.log("\nPhase D: DEVICE'S OWN fn 0x1F read-back of the freshly-placed block...");
    const readback = await readFn1f(conn, insertWireId);
    check('D: fn 0x1F replied for the placed block', readback !== undefined, readback === undefined ? 'no reply' : `${readback.length} values`);
    if (readback !== undefined) {
      const fresh = FRESH_DEFAULT_RECORDS[insertWireId];
      const byteExact = readback.length === fresh.payload.length && readback.every((v, i) => v === fresh.payload[i]);
      check(`D: device's own fn 0x1F read matches FRESH_DEFAULT_RECORDS[${insertWireId}] byte-exact`, byteExact, byteExact ? '' : `len ${readback.length} vs ${fresh.payload.length}, first diff at ${readback.findIndex((v, i) => v !== fresh.payload[i])}`);
    }

    console.log('\nPhase E: live fn 0x20 GET_GRID_LAYOUT confirms the cell now shows the new block, everything else unchanged...');
    const afterCells = await readGrid(conn);
    const afterTarget = afterCells.find((c) => c.col === replaceCell.col && c.row === replaceCell.row);
    check(`E: cell (${replaceCell.col},${replaceCell.row}) now reads blockId ${insertWireId}`, afterTarget?.blockId === insertWireId, `got ${afterTarget?.blockId}`);
    let untouchedOk = true;
    for (const c of placedCells) {
      if (c.blockId === replaceWireId) continue;
      const after = afterCells.find((x) => x.col === c.col && x.row === c.row);
      if (after?.blockId !== c.blockId) untouchedOk = false;
    }
    check('E: every other placed block still reads its original blockId', untouchedOk);

    console.log('\nPhase F: restore pristine baseline (whole-image push, independent of what this probe tests)...');
    const restored = await restoreBaseline(baseline);
    check('F: baseline restored, working buffer byte-identical to the original dump', restored);
  } catch (err) {
    console.error('\nERROR during probe, attempting restore:', err instanceof Error ? err.message : String(err));
    const restored = await restoreBaseline(baseline).catch(() => false);
    check('restore after error: baseline byte-identical', restored);
  }

  console.log(`\n${pass} PASS, ${fail} FAIL. Artifacts: ${outDir}`);
  conn.close();
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
