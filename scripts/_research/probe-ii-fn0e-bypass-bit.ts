/**
 * Axe-Fx II fn 0x0E QUERY_STATES bypass-bit probe.
 *
 * Live re-confirmation (and byte/bit pinpointing) of the primitive
 * `ii-fn0e-query-states` tag-byte semantics:
 *
 *   1. Read fn 0x20 GET_GRID for the placed (non-shunt) blockIds.
 *   2. Read fn 0x0E and parse the 5-byte records; map records to blocks
 *      via the 28-bit address sort-zip rule.
 *   3. Pick one placed block, toggle its bypass via the shipped,
 *      hardware-verified fn 0x02 set_bypass builder (paramId 255).
 *   4. Re-read fn 0x0E, diff the two frames byte-for-byte, and report
 *      exactly which record / byte / bit moved (expected: tag bit 0x01
 *      of the record whose 28-bit address maps to the toggled block).
 *   5. Restore the original bypass, re-read fn 0x0E, verify the frame
 *      is byte-identical to the baseline.
 *
 * Safety: NO save/store frames, NO preset/scene/bank switches. The only
 * mutation is one block-bypass toggle, restored and verified by a third
 * fn 0x0E read. Abort path restores the bypass before exiting. One
 * audible blip (~0.5 s) on the chosen block.
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-ii-fn0e-bypass-bit.ts
 *   npx tsx scripts/_research/probe-ii-fn0e-bypass-bit.ts --port "xl+"     # port override
 *   npx tsx scripts/_research/probe-ii-fn0e-bypass-bit.ts --block 116      # target a specific effectId
 *
 * Prereqs: Axe-Fx II XL+ on + USB connected, AxeEdit CLOSED (its polling
 * pollutes the inbound stream; the II also broadcasts state continuously,
 * which the matching predicates filter out).
 *
 * # Output
 *
 *   samples/captured/probe-ii-fn0e-bypass-bit-findings.md
 *   samples/captured/probe-ii-fn0e-bypass-bit-results.json
 *   samples/captured/probe-ii-fn0e-bypass-bit-raw.syx
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import { connect, type MidiConnection } from '../../packages/core/src/midi/transport.js';
import {
  buildGetGridLayout,
  buildQueryStates,
  buildSetBlockBypass,
  isGetGridLayoutResponse,
  isQueryStatesResponse,
  mapQueryStatesToBlocks,
  parseGetGridLayoutResponse,
  parseQueryStatesResponse,
  type AxeFxIIBlockState,
  type QueryStateRecord,
} from '../../packages/fractal-midi/src/gen2/axe-fx-ii/setParam.js';
import { AXE_FX_II_BLOCKS } from '../../packages/fractal-midi/src/gen2/axe-fx-ii/blockTypes.js';

const READ_TIMEOUT_MS = 800;
const RATE_LIMIT_MS = 60;
const SETTLE_AFTER_WRITE_MS = 150;
const DEFAULT_NEEDLES = ['axe-fx ii', 'axefxii', 'xl+'] as const;
const OUT_DIR = 'samples/captured';
const OUT_BASE = 'probe-ii-fn0e-bypass-bit';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function blockName(effectId: number): string {
  return AXE_FX_II_BLOCKS.find((b) => b.id === effectId)?.name ?? `effectId ${effectId}`;
}

async function readGrid(conn: MidiConnection, raw: number[]): Promise<number[]> {
  const req = buildGetGridLayout();
  raw.push(...req);
  const respPromise = conn.receiveSysExMatching((b) => isGetGridLayoutResponse(b), READ_TIMEOUT_MS);
  conn.send(req);
  const resp = await respPromise;
  raw.push(...resp);
  await sleep(RATE_LIMIT_MS);
  const cells = parseGetGridLayoutResponse(resp);
  // Placed REAL blocks only: 100..199 are blocks, 200..235 shunts (no fn 0x0E
  // record), 0 empty.
  const ids = [...new Set(cells.map((c) => c.blockId).filter((id) => id >= 100 && id < 200))];
  return ids.sort((a, b) => a - b);
}

async function readQueryStates(conn: MidiConnection, raw: number[]): Promise<{ frame: number[]; records: QueryStateRecord[] }> {
  const req = buildQueryStates();
  raw.push(...req);
  const respPromise = conn.receiveSysExMatching((b) => isQueryStatesResponse(b), READ_TIMEOUT_MS);
  conn.send(req);
  const frame = await respPromise;
  raw.push(...frame);
  await sleep(RATE_LIMIT_MS);
  return { frame, records: parseQueryStatesResponse(frame) };
}

async function writeBypass(conn: MidiConnection, raw: number[], effectId: number, bypassed: boolean): Promise<void> {
  const msg = buildSetBlockBypass(effectId, bypassed);
  raw.push(...msg);
  conn.send(msg);
  await sleep(SETTLE_AFTER_WRITE_MS);
}

interface FrameDiff {
  sameLength: boolean;
  offsets: Array<{ offset: number; record: number; byteInRecord: number; b1: number; b2: number; xorBits: string }>;
}

function diffFrames(a: number[], b: number[]): FrameDiff {
  const offsets: FrameDiff['offsets'] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const payloadOff = i - 6; // payload starts after the 6-byte header
      offsets.push({
        offset: i,
        record: payloadOff >= 0 ? Math.floor(payloadOff / 5) : -1,
        byteInRecord: payloadOff >= 0 ? payloadOff % 5 : -1,
        b1: a[i],
        b2: b[i],
        xorBits: `0x${(a[i] ^ b[i]).toString(16).padStart(2, '0')}`,
      });
    }
  }
  return { sameLength: a.length === b.length, offsets };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  guardAgainstRunningEditors(args); // editor-held port + our traffic = WinMM wedge; --ignore-editors overrides
  const argOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };
  const portNeedle = argOf('--port');
  const blockArg = argOf('--block');

  console.log('Axe-Fx II fn 0x0E bypass-bit probe');
  console.log('==================================');
  console.log('WHAT THIS RUN WILL DO:');
  console.log('  1 grid read (fn 0x20) + 3 QUERY_STATES reads (fn 0x0E) + 2 bypass');
  console.log('  writes (toggle + restore) on ONE placed block. ~8 wire transactions,');
  console.log('  ~3-5 s. One audible blip on the chosen block. NO saves, NO preset or');
  console.log('  scene switches, NO bank changes. State restored and verified.');
  console.log('');

  const needles = portNeedle ? [portNeedle] : [...DEFAULT_NEEDLES];
  const conn = connect({
    needles,
    notFoundLeadIn: `Axe-Fx II not found (needles: ${needles.join(', ')}). Close AxeEdit; pass --port <substring> to override.`,
  });
  const raw: number[] = [];
  let restoreNeeded: { effectId: number; originalBypassed: boolean } | undefined;

  try {
    await sleep(300);

    // 1. Grid -> placed blockIds.
    const placedIds = await readGrid(conn, raw);
    console.log(`Placed non-shunt blocks (${placedIds.length}): ${placedIds.map((id) => `${id}=${blockName(id)}`).join(', ')}`);
    if (placedIds.length === 0) {
      throw new Error('No placed blocks on the active grid; load a preset with at least one block and re-run.');
    }

    // 2. Baseline fn 0x0E.
    const baseline = await readQueryStates(conn, raw);
    console.log(`fn 0x0E baseline: ${baseline.records.length} records, frame ${baseline.frame.length} bytes`);

    let mapping: AxeFxIIBlockState[] | undefined;
    if (baseline.records.length === placedIds.length) {
      mapping = mapQueryStatesToBlocks(baseline.records, placedIds);
      for (const m of mapping) {
        console.log(`  ${blockName(m.effectId).padEnd(16)} engaged=${m.engaged} channel=${m.channel}`);
      }
    } else {
      console.log(
        `  WARNING: record count ${baseline.records.length} != placed count ${placedIds.length}; ` +
        'proceeding in diff-only mode (no sort-zip mapping).',
      );
    }

    // 3. Pick the target block.
    let targetId: number;
    if (blockArg !== undefined) {
      targetId = Number(blockArg);
      if (!placedIds.includes(targetId)) {
        throw new Error(`--block ${blockArg} is not a placed block (placed: ${placedIds.join(', ')}).`);
      }
    } else {
      // Prefer a non-amp block (least intrusive audible change); fall back to
      // whatever is placed. Highest id tends to sit downstream in the chain.
      const nonAmp = placedIds.filter((id) => !blockName(id).toUpperCase().startsWith('AMP'));
      const pool = nonAmp.length > 0 ? nonAmp : placedIds;
      targetId = pool[pool.length - 1];
    }
    const originalEngaged = mapping?.find((m) => m.effectId === targetId)?.engaged;
    console.log(`\nTarget: ${blockName(targetId)} (effectId ${targetId})` +
      (originalEngaged !== undefined ? `, currently ${originalEngaged ? 'engaged' : 'bypassed'}` : ''));

    // 4. Toggle bypass. If we know the engaged state, flip it; otherwise
    //    assume engaged -> bypass (and restore engages again).
    const wasEngaged = originalEngaged ?? true;
    restoreNeeded = { effectId: targetId, originalBypassed: !wasEngaged };
    await writeBypass(conn, raw, targetId, wasEngaged /* bypass it if it was engaged */);

    const toggled = await readQueryStates(conn, raw);
    const diffAB = diffFrames(baseline.frame, toggled.frame);
    console.log(`\nDiff baseline -> toggled: ${diffAB.offsets.length} byte(s) moved${diffAB.sameLength ? '' : ' (LENGTH CHANGED)'}`);
    for (const o of diffAB.offsets) {
      console.log(
        `  offset ${o.offset} = record ${o.record} byte ${o.byteInRecord}: ` +
        `0x${o.b1.toString(16).padStart(2, '0')} -> 0x${o.b2.toString(16).padStart(2, '0')} (bits ${o.xorBits})`,
      );
    }

    // Cross-check against the expected record (address sort-zip).
    let expectationLine = 'No mapping available (record/placed count mismatch); diff reported raw.';
    if (mapping !== undefined && diffAB.offsets.length > 0) {
      const sortedRecords = [...baseline.records].sort((a, b) => a.state28 - b.state28);
      const expectedRecordIdxInDelivery = baseline.records.indexOf(
        sortedRecords[placedIds.indexOf(targetId)],
      );
      const hit = diffAB.offsets.every((o) => o.record === expectedRecordIdxInDelivery && o.byteInRecord === 0);
      const bitsOk = diffAB.offsets.length === 1 && diffAB.offsets[0].xorBits === '0x01';
      expectationLine = hit && bitsOk
        ? `CONFIRMED: exactly one byte moved, record ${expectedRecordIdxInDelivery} (the ${blockName(targetId)} record by address sort-zip), tag byte, bit 0x01 (engaged flag). Matches primitive ii-fn0e-query-states.`
        : `PARTIAL: diff did not land exclusively on the predicted record ${expectedRecordIdxInDelivery} tag bit 0x01; inspect the offsets above (record identification or tag semantics need a second look).`;
    }
    console.log(`\n${expectationLine}`);

    // 5. Restore + verify. Original bypassed state = !wasEngaged.
    await writeBypass(conn, raw, targetId, !wasEngaged);
    const restored = await readQueryStates(conn, raw);
    const diffAC = diffFrames(baseline.frame, restored.frame);
    const restoredClean = diffAC.sameLength && diffAC.offsets.length === 0;
    console.log(`Restore: frame ${restoredClean ? 'byte-identical to baseline, VERIFIED' : `differs at ${diffAC.offsets.length} offset(s), CHECK DEVICE`}`);
    restoreNeeded = restoredClean ? undefined : restoreNeeded;

    // ── Artifacts ────────────────────────────────────────────────────
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${OUT_BASE}-raw.syx`, Uint8Array.from(raw));
    writeFileSync(
      `${OUT_DIR}/${OUT_BASE}-results.json`,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        placedIds,
        target: { effectId: targetId, name: blockName(targetId), wasEngaged: originalEngaged },
        baselineFrameHex: hex(baseline.frame),
        toggledFrameHex: hex(toggled.frame),
        restoredFrameHex: hex(restored.frame),
        mapping,
        diffToggle: diffAB,
        diffRestore: diffAC,
        expectation: expectationLine,
        restoredClean,
      }, undefined, 2),
    );
    const md: string[] = [
      '# Axe-Fx II fn 0x0E bypass-bit probe findings',
      '',
      `> Generated by \`scripts/_research/probe-ii-fn0e-bypass-bit.ts\` at ${new Date().toISOString()}`,
      '',
      `Placed blocks: ${placedIds.map((id) => `${id}=${blockName(id)}`).join(', ')}`,
      '',
      `Target: **${blockName(targetId)}** (effectId ${targetId}), originally ${originalEngaged === undefined ? 'state unknown (assumed engaged)' : originalEngaged ? 'engaged' : 'bypassed'}.`,
      '',
      '## Which bit moved',
      '',
      '| Offset | Record | Byte in record | Before | After | XOR bits |',
      '|---|---|---|---|---|---|',
      ...diffAB.offsets.map((o) =>
        `| ${o.offset} | ${o.record} | ${o.byteInRecord} | 0x${o.b1.toString(16).padStart(2, '0')} | 0x${o.b2.toString(16).padStart(2, '0')} | ${o.xorBits} |`),
      '',
      expectationLine,
      '',
      `## Restore`,
      '',
      restoredClean
        ? 'Restored fn 0x0E frame is byte-identical to the baseline. State verified restored.'
        : `RESTORE NOT CLEAN: ${diffAC.offsets.length} offset(s) still differ. Check the ${blockName(targetId)} bypass state on the device.`,
      '',
      '## Frames',
      '',
      `Baseline: \`${hex(baseline.frame)}\``,
      '',
      `Toggled: \`${hex(toggled.frame)}\``,
      '',
      `Restored: \`${hex(restored.frame)}\``,
      '',
    ];
    writeFileSync(`${OUT_DIR}/${OUT_BASE}-findings.md`, md.join('\n'));
    console.log(`\nWrote ${OUT_DIR}/${OUT_BASE}-findings.md`);
    console.log(`Wrote ${OUT_DIR}/${OUT_BASE}-results.json`);
    console.log(`Wrote ${OUT_DIR}/${OUT_BASE}-raw.syx`);
  } catch (err) {
    console.error('\nFATAL:', err instanceof Error ? err.message : err);
    if (restoreNeeded !== undefined) {
      console.error(`Attempting emergency bypass restore on effectId ${restoreNeeded.effectId} ...`);
      try {
        await writeBypass(conn, raw, restoreNeeded.effectId, restoreNeeded.originalBypassed);
        console.error('  restore write sent; verify the block state on the device.');
      } catch (e2) {
        console.error(`  restore attempt threw: ${e2 instanceof Error ? e2.message : e2}. CHECK THE DEVICE.`);
      }
    }
    conn.close();
    process.exit(1);
  }

  conn.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
