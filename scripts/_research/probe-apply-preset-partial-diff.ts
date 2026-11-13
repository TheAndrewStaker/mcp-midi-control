/**
 * HW-133 leg 2: BK-084 mode-collapse multi-block partial-diff `apply_preset`
 * hardware confirmation (Axe-Fx II XL+), non-interactive.
 *
 * The central claim of the whole mode-collapse: `apply_preset` describes
 * the complete desired chain (unlisted blocks still clear), but a block
 * already correctly placed at its target cell is left COMPLETELY untouched
 * at the wire level, so hand-tuned params the caller's spec doesn't list
 * survive automatically. `probe-ii-compose-live-ops.ts` (2026-07-18)
 * hardware-confirmed this for the NARROW same-cell-replace shape via the
 * live compose engine directly; this probe drives the REAL, PRODUCTION
 * `apply_preset` entry point (the dispatcher, not an internal function)
 * with a MULTI-BLOCK spec mixing unchanged / replaced / removed blocks in
 * ONE call, which is what an actual agent conversation looks like.
 *
 * Sequence:
 *   1. Build a 5-block preset via apply_preset (drive, amp, cab, delay,
 *      reverb at row 2 cols 1-5) with specific params.
 *   2. Hand-tune ONE param on the amp block via set_param that is NOT in
 *      the original apply_preset spec (simulates a user's follow-up tweak
 *      apply_preset never touched).
 *   3. Call apply_preset AGAIN: drive + amp + cab unchanged (same block
 *      types at the same cells, but the spec does NOT re-list the
 *      hand-tuned param), delay REPLACED with a different block type,
 *      reverb REMOVED (absent from the new spec).
 *   4. Device read-back confirms: the hand-tuned amp param survived
 *      EXACTLY (proving the unchanged block was never cleared/re-placed);
 *      delay reflects the new block; reverb's cell is empty.
 *
 * Working-buffer only, self-restoring (baseline pushed back + verified at
 * the end, on every path including the catch handler). No save_authorized
 * anywhere in this script.
 *
 * Preconditions: Axe-Fx II XL+ connected. Any starting preset works; row 2
 * cols 1-5 will be overwritten by this probe and restored at the end.
 *
 * Run:  npx tsx scripts/_research/probe-apply-preset-partial-diff.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import { executeGetParam, executeSetParams } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { ensureConnection } from '@mcp-midi-control/core/server-shared/connections.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import {
  buildGetGridLayout,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  resolveBlock,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

const PORT = 'axe-fx-ii';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function readGrid(conn: ReturnType<typeof ensureConnection>) {
  const gridPromise = conn.receiveSysExMatching((b: number[]) => isGetGridLayoutResponse(b, 0x07), 1500);
  conn.send(buildGetGridLayout({ modelId: 0x07 }));
  return parseGetGridLayoutResponse(await gridPromise, 0x07);
}

async function main(): Promise<void> {
  console.log('── HW-133: multi-block partial-diff apply_preset (Axe-Fx II XL+) ──');
  const conn = ensureConnection('axe-fx-ii');

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
  const outDir = path.join('samples', 'captured', `bk084-partial-diff-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const restoreBaseline = async (baseline: Uint8Array): Promise<boolean> => {
    const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => ensureConnection('axe-fx-ii', true) } as unknown as DispatchCtx;
    const r = await restorePresetBinaryAxeFxII(ctx, baseline);
    if (!r.ok) return false;
    return bytesEqual(await dumpWorkingBufferBytes(ctx), baseline);
  };

  console.log('\nPhase A: baseline dump + backup...');
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => ensureConnection('axe-fx-ii', true) } as unknown as DispatchCtx;
  const baseline = await dumpWorkingBufferBytes(ctx);
  writeFileSync(path.join(outDir, 'baseline.syx'), Buffer.from(baseline));
  console.log(`  baseline dumped (${baseline.length} B) -> ${outDir}`);

  try {
    console.log('\nPhase B: build a 5-block preset via apply_preset (drive, amp, cab, delay, reverb)...');
    const buildResult = await executeApplyPreset({
      port: PORT,
      spec: {
        slots: [
          { slot: { row: 2, col: 1 }, block_type: 'drive', params: { drive: 4 } },
          { slot: { row: 2, col: 2 }, block_type: 'amp', params: { bass: 7, treble: 3 } },
          { slot: { row: 2, col: 3 }, block_type: 'cab' },
          { slot: { row: 2, col: 4 }, block_type: 'delay', params: { mix: 25 } },
          { slot: { row: 2, col: 5 }, block_type: 'reverb', params: { mix: 20 } },
        ],
      },
    });
    check('B: initial 5-block build ok', buildResult.ok === true, JSON.stringify(buildResult).slice(0, 300));

    console.log('\nPhase C: hand-tune amp.middle via set_param -- NOT in either apply_preset spec...');
    const HAND_TUNED_MIDDLE = 8.5;
    const tuneResult = await executeSetParams({ port: PORT, ops: [{ block: 'amp', name: 'middle', value: HAND_TUNED_MIDDLE }] });
    check('C: hand-tune acked', tuneResult.acked_count === 1, JSON.stringify(tuneResult).slice(0, 200));
    const preSecondApply = await executeGetParam({ port: PORT, block: 'amp', name: 'middle' });
    check('C: amp.middle reads back the hand-tuned value before the second apply', Math.abs(Number(preSecondApply.display_value) - HAND_TUNED_MIDDLE) < 0.05, `got ${preSecondApply.display_value}`);

    console.log('\nPhase D: second apply_preset -- drive/amp/cab UNCHANGED (not re-opinioned on middle), delay REPLACED, reverb REMOVED...');
    const secondResult = await executeApplyPreset({
      port: PORT,
      spec: {
        slots: [
          { slot: { row: 2, col: 1 }, block_type: 'drive', params: { drive: 4 } },  // same block, same params -> unchanged
          { slot: { row: 2, col: 2 }, block_type: 'amp', params: { bass: 7, treble: 3 } }, // same block; middle NOT listed
          { slot: { row: 2, col: 3 }, block_type: 'cab' }, // same block, unchanged
          { slot: { row: 2, col: 4 }, block_type: 'chorus', params: { mix: 40 } }, // GENUINE REPLACE (was delay)
          // reverb at (2,5) is ABSENT -> removed
        ],
      },
    });
    check('D: second (partial-diff) apply ok', secondResult.ok === true, JSON.stringify(secondResult).slice(0, 400));
    // Regression check for the auto_applied staleness fix (2026-07-18,
    // same session): cab is UNCHANGED in this second apply (same block,
    // same cell, no re-opinion), so its cab-polish defaults were never
    // actually written (skipped at runtime) -- auto_applied must NOT
    // claim they were, now that filterCabPolishForSkippedBlocks runs
    // before mergeAutoApplied.
    const autoApplied = (secondResult as { auto_applied?: { channels?: readonly string[]; note?: string } }).auto_applied;
    const claimsCabPolish = autoApplied !== undefined && (autoApplied.note ?? '').toLowerCase().includes('cab');
    check('D: auto_applied does NOT claim cab-polish for the unchanged cab block (no stale claim)', !claimsCabPolish, JSON.stringify(autoApplied));

    console.log("\nPhase E: device read-back -- the hand-tuned amp.middle must have SURVIVED (amp's placement was unchanged)...");
    const postMiddle = await executeGetParam({ port: PORT, block: 'amp', name: 'middle' });
    const middleSurvived = Math.abs(Number(postMiddle.display_value) - HAND_TUNED_MIDDLE) < 0.05;
    check(
      `E: amp.middle STILL reads ${HAND_TUNED_MIDDLE} after the second apply (proves unchanged block kept its unlisted param)`,
      middleSurvived,
      `got ${postMiddle.display_value}`,
    );

    console.log('\nPhase F: device read-back -- drive/cab params also survived untouched...');
    const postDrive = await executeGetParam({ port: PORT, block: 'drive', name: 'drive' });
    check('F: drive.drive unaffected by the second apply', Math.abs(Number(postDrive.display_value) - 4) < 0.05, `got ${postDrive.display_value}`);

    console.log('\nPhase G: live grid confirms delay->chorus REPLACE and reverb REMOVAL landed...');
    const afterCells = await readGrid(conn);
    const chorusBlock = resolveBlock('Chorus 1');
    const cellFour = afterCells.find((c) => c.col === 4 && c.row === 2);
    check('G: (row2,col4) now holds Chorus (genuine replace landed)', cellFour?.blockId === chorusBlock?.id, `got blockId ${cellFour?.blockId}, expected ${chorusBlock?.id}`);
    const cellFive = afterCells.find((c) => c.col === 5 && c.row === 2);
    check('G: (row2,col5) is now empty or a shunt (reverb removed, not in the new spec)', cellFive !== undefined && cellFive.blockId !== resolveBlock('Reverb 1')?.id, `got blockId ${cellFive?.blockId}`);

    console.log('\nPhase H: restore pristine baseline...');
    const restored = await restoreBaseline(baseline);
    check('H: baseline restored, working buffer byte-identical to the original dump', restored);
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
