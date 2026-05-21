/**
 * BK-070 task #15 — discover per-scene state ushort for remaining II blocks.
 *
 * Strategy: use apply_preset to load a 12-slot preset containing the
 * un-mapped block types. For each block, toggle bypass on scene 1
 * (via SET_BLOCK_PARAMETER paramId 255) and diff the dump.
 *
 * Targets (block_type → effectId):
 *   chorus     → 116
 *   flanger    → 118
 *   phaser     → 122
 *   wah        → 124
 *   pitch      → 130
 *   filter     → 131
 *   vol_pan    → 127  (Volume/Pan)
 *   tremolo    → 128
 *   formant    → 126
 *   enhancer   → 135
 *   fx_loop    → 136
 *   rotary     → 120
 *
 * Plus second instances if we have slots: amp (107=Amp 2), drive (134=Drive 2).
 *
 * Each toggle reveals one (chunk, ushort) location.
 */

import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  executeSwitchPreset,
  executeSavePreset,
} from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;
const FUNC_PATCH_DUMP = 0x03;
const FUNC_SET_PARAM = 0x02;

const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };
const build = (fn: number, payload: number[]): number[] => { const h = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...payload]; return [...h, csum(h), 0xf7]; };
const septet14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function decodeChunk(p: Uint8Array): Uint16Array {
  const c = (p[0]&0x7f)|((p[1]&0x7f)<<7);
  const o = new Uint16Array(c);
  for (let i=0;i<c;i++) {
    const off=2+i*3;
    o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff;
  }
  return o;
}

type Conn = ReturnType<typeof connectAxeFxII>;

async function dump(conn: Conn): Promise<Uint8Array> {
  const frames: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0]===0xf0 && b[4]===0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
  conn.send(build(FUNC_PATCH_DUMP, [(SCRATCH_WIRE >> 7) & 0x7f, SCRATCH_WIRE & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  if (frames.length !== 66) throw new Error(`dump got ${frames.length} frames`);
  return new Uint8Array(frames.flat());
}

interface Target {
  blockType: string;
  effectId: number;
}

const BATCH_1: Target[] = [
  { blockType: 'chorus', effectId: 116 },
  { blockType: 'flanger', effectId: 118 },
  { blockType: 'phaser', effectId: 122 },
  { blockType: 'wah', effectId: 124 },
  { blockType: 'pitch', effectId: 130 },
  { blockType: 'filter', effectId: 131 },
  { blockType: 'rotary', effectId: 120 },
];

const BATCH_2: Target[] = [
  { blockType: 'volpan', effectId: 127 },        // Volume/Pan 1
  { blockType: 'pantrem', effectId: 128 },       // Tremolo/Panner 1
  { blockType: 'formant', effectId: 126 },
  { blockType: 'enhancer', effectId: 135 },
  { blockType: 'effectsloop', effectId: 136 },   // FX Loop
  { blockType: 'parametriceq', effectId: 104 },  // Parametric EQ 1
  { blockType: 'graphiceq', effectId: 102 },     // Graphic EQ 1
];

async function runBatch(conn: Conn, batch: Target[], batchName: string): Promise<Map<number, { chunk: number; ushort: number }>> {
  console.log(`\n========== Batch ${batchName} ==========`);

  // Build apply_preset spec with these blocks in row 2 cols 1..N.
  const slots = batch.map((t, idx) => ({
    slot: { row: 2, col: idx + 1 } as { row: number; col: number },
    block_type: t.blockType,
  }));
  console.log(`Applying preset with ${slots.length} block(s): ${batch.map(t => t.blockType).join(', ')}`);

  try {
    const result = await executeApplyPreset({
      port: 'axe-fx-ii',
      spec: { name: `BK070 ${batchName}`, slots },
      target_location: SCRATCH_DISPLAY,
      save_authorized: true,
      on_active_preset_edited: 'discard',
    } as Parameters<typeof executeApplyPreset>[0]);
    console.log(`  apply ok: ${(result as { ok?: boolean }).ok}`);
  } catch (e) {
    console.error(`  apply_preset failed: ${e instanceof Error ? e.message : e}`);
    return new Map();
  }
  await new Promise(r => setTimeout(r, 500));

  const results = new Map<number, { chunk: number; ushort: number }>();

  for (const t of batch) {
    // Re-dump baseline (state changes between iterations).
    const baseline = await dump(conn);
    const baselineParsed = parsePresetDump(baseline);

    // Toggle bypass for this block on scene 1 (paramId 255, value 1).
    const [effLo, effHi] = septet14(t.effectId);
    const [pLo, pHi] = septet14(255);
    const msg = build(FUNC_SET_PARAM, [effLo, effHi, pLo, pHi, 1, 0, 0, 0x01]);
    const conn2 = conn;
    conn2.send(msg);
    await new Promise(r => setTimeout(r, 300));
    await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
    await new Promise(r => setTimeout(r, 300));

    const after = await dump(conn);
    const afterParsed = parsePresetDump(after);

    // Diff to find the changed ushort.
    let found: { chunk: number; ushort: number; before: number; after: number } | undefined;
    for (let c = 0; c < 64; c++) {
      const a = decodeChunk(baselineParsed.chunkPayloads[c]);
      const b = decodeChunk(afterParsed.chunkPayloads[c]);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          // Skip the footer-hash-related differences (those will always
          // appear with any modification). Find the FIRST diff that's
          // not at a known param-table position.
          // Actually any diff is fine — the bypass should affect just
          // one ushort (the per-scene state ushort).
          if (!found) {
            found = { chunk: c, ushort: i, before: a[i], after: b[i] };
          }
        }
      }
    }

    if (found) {
      results.set(t.effectId, { chunk: found.chunk, ushort: found.ushort });
      console.log(`  ${t.blockType} (id ${t.effectId}): c${found.chunk}:u${found.ushort}  0x${found.before.toString(16).padStart(4,'0')} → 0x${found.after.toString(16).padStart(4,'0')}`);
    } else {
      console.log(`  ${t.blockType} (id ${t.effectId}): no diff (block may not be placed or paramId 255 ignored)`);
    }
  }

  return results;
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();

  const all = new Map<number, { chunk: number; ushort: number; blockName: string }>();

  // Skip batch 1 if already mapped via earlier run; just do batch 2 now.
  const SKIP_BATCH_1 = process.env.SKIP_BATCH_1 === '1';
  if (!SKIP_BATCH_1) {
    const r1 = await runBatch(conn, BATCH_1, 'Modulation/Pitch/Filter');
    for (const [id, loc] of r1.entries()) {
      const target = BATCH_1.find(t => t.effectId === id)!;
      all.set(id, { ...loc, blockName: target.blockType });
    }
  }

  const r2 = await runBatch(conn, BATCH_2, 'Utility/Tremolo/EQ');
  for (const [id, loc] of r2.entries()) {
    const target = BATCH_2.find(t => t.effectId === id)!;
    all.set(id, { ...loc, blockName: target.blockType });
  }

  console.log('\n========== FINAL TABLE ==========');
  console.log('effectId | block       | chunk:ushort');
  console.log('---------|-------------|---------------');
  for (const [id, loc] of all.entries()) {
    console.log(`   ${id.toString().padStart(3)}   | ${loc.blockName.padEnd(11)} | c${loc.chunk}:u${loc.ushort}`);
  }

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
