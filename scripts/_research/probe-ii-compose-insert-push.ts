/**
 * BK-084 atomic COMPOSE hardware confirmation, non-interactive.
 *
 * Tests the ONE remaining hardware-confirmation gap `composeImageChain`
 * (presetImage/compose.ts) inherits from its underlying primitives:
 * REMOVE is hardware-confirmed (5/5 novel-composition pushes accepted,
 * 2026-07-16), but no prior hardware test has pushed an image
 * containing an INSERT built from a FRESH_DEFAULT_RECORDS-synthesized
 * span (only live `set_block` proved fresh-default placement, a
 * different code path than an image PUSH). This probe removes one
 * currently-placed block and inserts a different, currently-ABSENT
 * always-tweaked-family block into the vacated cell, all in ONE
 * composed image and ONE push, then confirms via the DEVICE'S OWN
 * fn 0x1F read (not just our own re-dump) that the inserted block's
 * bytes match FRESH_DEFAULT_RECORDS exactly.
 *
 * Working-buffer only. No save_authorized anywhere in this script;
 * flash is never touched. Self-restoring: the pristine baseline is
 * pushed back and verified byte-identical before exit, on every path
 * (including the catch handler).
 *
 * Preconditions: Axe-Fx II XL+ connected, a preset with at least one
 * removable (non-tail-resident) content block loaded — "Boston Tone"
 * (display 666) is checked for by name but not required; any preset
 * works as long as at least one FRESH_DEFAULT_RECORDS family (Amp 1/2,
 * Cab, Reverb, Delay, Multi Delay, Pitch, Drive) is currently ABSENT
 * from the chain (there's room to insert one fresh).
 *
 * Run:  npx tsx scripts/_research/probe-ii-compose-insert-push.ts
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
import {
  BLOCK_BY_ID,
  buildGetGridLayout,
  buildGetAllParams,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  parseIIPresetDumpFrames,
  imageFromFrames,
  framesFromImage,
  serializeIIPresetDumpFrames,
  parseIIImageTlv,
  findIIImageBlock,
  parseIIGrid,
  validateIIGridInvariants,
  composeImageChain,
  FRESH_DEFAULT_RECORDS,
  II_TAIL_RESIDENT_WIRE_IDS,
  type AxeFxIIImageBuffer,
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

async function main(): Promise<void> {
  console.log('── BK-084 atomic compose: INSERT-with-FRESH_DEFAULT_RECORDS push confirmation (Axe-Fx II XL+) ──');
  const conn = ensureConnection('axe-fx-ii');
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => ensureConnection('axe-fx-ii', true) } as unknown as DispatchCtx;

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
  const outDir = path.join('samples', 'captured', `bk084-compose-insert-push-${stamp}`);
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
  check('A: baseline preset is "Boston Tone" (expected sacrificial slot; informational only)', presetName === 'Boston Tone', `got "${presetName}"`);

  try {
    const gridPromise = conn.receiveSysExMatching((b: number[]) => isGetGridLayoutResponse(b, 0x07), 1500);
    conn.send(buildGetGridLayout({ modelId: 0x07 }));
    const cells = await gridPromise.then((b) => parseGetGridLayoutResponse(b, 0x07));
    const placedCells = cells.filter((c) => c.blockId !== 0 && c.blockId < 200 && !TAIL_RESIDENT.has(c.blockId));
    console.log(`  placed content blocks: ${placedCells.map((c) => `${BLOCK_BY_ID[c.blockId]?.name ?? c.blockId}@(${c.col},${c.row})`).join(', ')}`);
    check('A: at least 2 removable content blocks placed', placedCells.length >= 2, `got ${placedCells.length}`);
    if (placedCells.length < 2) throw new Error('not enough placed blocks to run this probe safely');

    const placedIds = new Set(placedCells.map((c) => c.blockId));
    const insertWireId = Object.keys(FRESH_DEFAULT_RECORDS).map(Number).find((id) => !placedIds.has(id));
    check('A: found a FRESH_DEFAULT_RECORDS family currently ABSENT from the chain', insertWireId !== undefined, insertWireId === undefined ? `all placed: ${[...placedIds].join(',')}` : `will insert wireId ${insertWireId} (${FRESH_DEFAULT_RECORDS[insertWireId]?.blockName})`);
    if (insertWireId === undefined) throw new Error('every FRESH_DEFAULT_RECORDS family is already placed; nothing to insert as a fresh block');

    // Remove the LAST placed block (arbitrary but deterministic) to free its cell.
    const removeCell = placedCells[placedCells.length - 1];
    const removeWireId = removeCell.blockId;
    console.log(`  removing ${BLOCK_BY_ID[removeWireId]?.name ?? removeWireId}@(${removeCell.col},${removeCell.row}), inserting ${FRESH_DEFAULT_RECORDS[insertWireId].blockName} in its place`);

    console.log('\nPhase B: compose (remove one, insert one fresh, everything else unchanged)...');
    const frames = parseIIPresetDumpFrames(baseline);
    const image: AxeFxIIImageBuffer = imageFromFrames(frames);
    const targets = placedCells
      .filter((c) => c.blockId !== removeWireId)
      .map((c) => ({ wireId: c.blockId, gridCell: { col: c.col, row: c.row } }));
    targets.push({ wireId: insertWireId, gridCell: { col: removeCell.col, row: removeCell.row } });

    const composed = composeImageChain(image, targets);
    check('B: compose accepted offline', composed.ok, composed.ok ? '' : composed.reason);
    if (!composed.ok) throw new Error(`compose refused: ${composed.reason}`);
    check(`B: removed=[${removeWireId}], inserted=[${insertWireId}]`, composed.removed.length === 1 && composed.removed[0] === removeWireId && composed.inserted.length === 1 && composed.inserted[0] === insertWireId);
    check(`B: ${composed.unchanged.length} blocks reported unchanged`, composed.unchanged.length === placedCells.length - 1);

    const composedTlv = parseIIImageTlv(composed.image.words);
    const composedGridCells = parseIIGrid(composed.image.words);
    const violations = validateIIGridInvariants(composedGridCells, composedTlv.blocks.map((b) => b.wireId));
    check('B: composed image is grid/chain invariant-clean', violations.length === 0, violations.join('; '));

    const composedBytes = serializeIIPresetDumpFrames(framesFromImage(composed.image, frames.headerPayload));
    writeFileSync(path.join(outDir, 'composed.syx'), Buffer.from(composedBytes));

    console.log('\nPhase C: PUSH the composed image (the untested leg: INSERT-with-FRESH_DEFAULT_RECORDS in a real push)...');
    const pushR = await restorePresetBinaryAxeFxII(ctx, composedBytes);
    check('C: push accepted (0 NACKs)', pushR.ok, `${pushR.nacks.length} NACK(s)`);
    if (!pushR.ok) {
      console.log('  push NACKed; restoring baseline and stopping.');
      const restored = await restoreBaseline(baseline);
      check('restore after NACK: baseline byte-identical', restored);
      console.log(`\n${pass} PASS, ${fail} FAIL. Artifacts: ${outDir}`);
      conn.close();
      setTimeout(() => process.exit(1), 200);
      return;
    }

    const afterPush = await dumpWorkingBufferBytes(ctx);
    check('C: working buffer byte-identical to the composed image we pushed', bytesEqual(afterPush, composedBytes));

    console.log("\nPhase D: DEVICE'S OWN fn 0x1F read-back of the freshly-inserted block (the actual confirmation)...");
    const readback = await readFn1f(conn, insertWireId);
    check('D: fn 0x1F replied for the inserted block', readback !== undefined, readback === undefined ? 'no reply' : `${readback.length} values`);
    if (readback !== undefined) {
      const fresh = FRESH_DEFAULT_RECORDS[insertWireId];
      const byteExact = readback.length === fresh.payload.length && readback.every((v, i) => v === fresh.payload[i]);
      check(`D: device's own fn 0x1F read matches FRESH_DEFAULT_RECORDS[${insertWireId}] byte-exact`, byteExact, byteExact ? '' : `len ${readback.length} vs ${fresh.payload.length}, first diff at ${readback.findIndex((v, i) => v !== fresh.payload[i])}`);
    }
    // Cross-check via our own post-push image too (independent of the device's live fn 0x1F path).
    const afterImg = imageFromFrames(parseIIPresetDumpFrames(afterPush));
    const afterTlv = parseIIImageTlv(afterImg.words);
    const insertedBlock = findIIImageBlock(afterTlv, insertWireId);
    check('D: inserted block present in the re-dumped image TLV chain', insertedBlock !== undefined);

    console.log('\nPhase E: restore pristine baseline...');
    const restored = await restoreBaseline(baseline);
    check('E: baseline restored, working buffer byte-identical to the original dump', restored);
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
