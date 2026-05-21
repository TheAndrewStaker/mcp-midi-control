/**
 * Tier-2 batch X/Y paramBase mapper.
 *
 * For each Tier-2 block listed below:
 *   1. apply_preset places the block alone at slot (2,1) on preset 666
 *      (overwrites Test Crunch — restore via restore-test-crunch.ts after).
 *   2. switch to scene 1, force channel X, save, dump baseline.
 *   3. set_param on a probe paramId via raw fn 0x02 with a distinctive
 *      wire value (channel-X targeting + paramId-encoded so collisions
 *      are obvious in the diff).
 *   4. save, dump after, diff against baseline native ushorts.
 *   5. The diff's (chunk, ushort) at the target wire value identifies
 *      X paramBase = (chunk, ushort - paramId).
 *   6. Repeat for channel Y.
 *
 * Each block is probed with a list of candidate paramIds — first one
 * whose set_param produces a clean diff wins. Resilient to the wiki's
 * occasional "paramId N is actually internal-only" cases.
 *
 * Run a batch at a time via TIER2_BATCH env var: 'A', 'B', or 'C'
 * (default 'A'). Hardware-tested.
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset, executeSavePreset, executeSwitchScene } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };
const build = (fn: number, payload: number[]): number[] => { const h = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...payload]; return [...h, csum(h), 0xf7]; };
const septet14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function decodeChunk(p: Uint8Array): Uint16Array {
  const c = (p[0]&0x7f)|((p[1]&0x7f)<<7);
  const o = new Uint16Array(c);
  for (let i=0;i<c;i++) { const off=2+i*3; o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff; }
  return o;
}

type Conn = ReturnType<typeof connectAxeFxII>;

async function dump(conn: Conn): Promise<Uint8Array> {
  const frames: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0]===0xf0 && b[4]===0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
  conn.send(build(0x03, [(665 >> 7) & 0x7f, 665 & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  if (frames.length !== 66) throw new Error(`dump got ${frames.length} frames`);
  return new Uint8Array(frames.flat());
}

async function setChannel(conn: Conn, effectId: number, y: boolean): Promise<void> {
  const [lo, hi] = septet14(effectId);
  conn.send(build(0x11, [lo, hi, y ? 1 : 0, 0x01]));
  await new Promise(r => setTimeout(r, 300));
}

async function setParamRaw(conn: Conn, effectId: number, paramId: number, wireValue: number): Promise<void> {
  const [effLo, effHi] = septet14(effectId);
  const [pLo, pHi] = septet14(paramId);
  conn.send(build(0x02, [effLo, effHi, pLo, pHi, wireValue & 0x7f, (wireValue >> 7) & 0x7f, (wireValue >> 14) & 0x03, 0x01]));
  await new Promise(r => setTimeout(r, 250));
}

async function findChannelParamBase(
  conn: Conn,
  effectId: number,
  channelY: boolean,
  probeParamIds: number[],
  channelLabel: string,
): Promise<{ paramId: number; chunk: number; ushort: number; targetWire: number } | undefined> {
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));
  await setChannel(conn, effectId, channelY);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  for (const paramId of probeParamIds) {
    const before = await dump(conn);
    // Distinctive per paramId + per channel; magnitudes well clear of common defaults.
    const targetWire = ((channelY ? 0x6000 : 0x2000) + paramId * 37) & 0xffff;
    await setParamRaw(conn, effectId, paramId, targetWire);
    await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
    await new Promise(r => setTimeout(r, 250));
    const after = await dump(conn);

    const pA = parsePresetDump(before);
    const pB = parsePresetDump(after);
    for (let c = 0; c < 64; c++) {
      const x = decodeChunk(pA.chunkPayloads[c]);
      const y = decodeChunk(pB.chunkPayloads[c]);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i] && y[i] === targetWire) {
          console.log(`  ${channelLabel} probe paramId ${paramId}: hit c${c}:u${i} (target 0x${targetWire.toString(16).padStart(4,'0')})`);
          return { paramId, chunk: c, ushort: i, targetWire };
        }
      }
    }
    console.log(`  ${channelLabel} probe paramId ${paramId}: no diff at target 0x${targetWire.toString(16).padStart(4,'0')}`);
  }
  return undefined;
}

interface BlockTest {
  blockName: string;
  effectId: number;
  blockTypeSlug: string;
  probeParamIds: number[];
}

const BATCH_A: BlockTest[] = [
  { blockName: 'Chorus 1',  effectId: 116, blockTypeSlug: 'chorus',  probeParamIds: [2, 4, 10, 11, 12] },
  { blockName: 'Flanger 1', effectId: 118, blockTypeSlug: 'flanger', probeParamIds: [1, 3, 4, 5, 11] },
  { blockName: 'Phaser 1',  effectId: 122, blockTypeSlug: 'phaser',  probeParamIds: [2, 5, 6, 10, 11] },
  { blockName: 'Pitch 1',   effectId: 130, blockTypeSlug: 'pitch',   probeParamIds: [9, 10, 13, 14, 15] },
  { blockName: 'Wah 1',     effectId: 124, blockTypeSlug: 'wah',     probeParamIds: [1, 2, 3, 6, 7] },
];

const BATCH_B: BlockTest[] = [
  { blockName: 'Volume/Pan 1',     effectId: 127, blockTypeSlug: 'volpan',  probeParamIds: [0, 1, 4, 5, 6] },
  { blockName: 'Tremolo/Panner 1', effectId: 128, blockTypeSlug: 'pantrem', probeParamIds: [2, 3, 4, 7, 12] },
  { blockName: 'Rotary Speaker 1', effectId: 120, blockTypeSlug: 'rotary',  probeParamIds: [0, 1, 2, 3, 6] },
  { blockName: 'Filter 1',         effectId: 131, blockTypeSlug: 'filter',  probeParamIds: [1, 2, 3, 4, 12] },
  { blockName: 'Formant',          effectId: 126, blockTypeSlug: 'formant', probeParamIds: [3, 4, 5, 6, 7] },
];

const BATCH_C: BlockTest[] = [
  { blockName: 'Graphic EQ 1',    effectId: 102, blockTypeSlug: 'graphiceq',    probeParamIds: [0, 1, 5, 11, 12] },
  { blockName: 'Parametric EQ 1', effectId: 104, blockTypeSlug: 'parametriceq', probeParamIds: [0, 1, 2, 5, 6] },
  { blockName: 'Multi Delay 1',   effectId: 114, blockTypeSlug: 'multidelay',   probeParamIds: [0, 1, 8, 9, 10] },
  { blockName: 'Enhancer',        effectId: 135, blockTypeSlug: 'enhancer',     probeParamIds: [0, 1, 2, 3, 4] },
  { blockName: 'FX Loop',         effectId: 136, blockTypeSlug: 'effectsloop',  probeParamIds: [0, 1, 4, 8, 9] },
];

function pickBatch(): BlockTest[] {
  const tag = (process.env.TIER2_BATCH ?? 'A').toUpperCase();
  if (tag === 'A') return BATCH_A;
  if (tag === 'B') return BATCH_B;
  if (tag === 'C') return BATCH_C;
  throw new Error(`Unknown TIER2_BATCH "${tag}" — pick A, B, or C`);
}

async function placeBlockAlone(slug: string): Promise<void> {
  // Single block in row 2 col 1 — simplest layout that gives the block
  // an input cable (input row 2 wires straight into col 1 by default).
  const result = await executeApplyPreset({
    port: 'axe-fx-ii',
    spec: {
      name: 'BK-070 probe',
      slots: [{ slot: { row: 2, col: 1 }, block_type: slug }],
    },
    target_location: 666,
    save_authorized: true,
    on_active_preset_edited: 'discard',
  });
  if (result.ok === false) {
    throw new Error(`apply_preset failed for ${slug}: ${JSON.stringify(result).slice(0, 400)}`);
  }
  await new Promise(r => setTimeout(r, 400));
}

async function main(): Promise<void> {
  const batch = pickBatch();
  console.log(`Tier-2 X/Y batch: ${batch.map(b => b.blockName).join(', ')}`);

  // Initial switch to scratch slot.
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 300));

  const conn = connectAxeFxII();

  const results: Array<{
    blockName: string; effectId: number;
    x?: { paramId: number; chunk: number; ushort: number };
    y?: { paramId: number; chunk: number; ushort: number };
    xBase?: { chunk: number; ushort: number };
    yBase?: { chunk: number; ushort: number };
  }> = [];

  for (const t of batch) {
    console.log(`\n=== ${t.blockName} (id ${t.effectId}, slug ${t.blockTypeSlug}) ===`);
    try {
      console.log(`  placing block via apply_preset...`);
      await placeBlockAlone(t.blockTypeSlug);
    } catch (err) {
      console.log(`  SKIP: place failed: ${err instanceof Error ? err.message : err}`);
      results.push({ blockName: t.blockName, effectId: t.effectId });
      continue;
    }

    const xR = await findChannelParamBase(conn, t.effectId, false, t.probeParamIds, 'X');
    const yR = await findChannelParamBase(conn, t.effectId, true, t.probeParamIds, 'Y');
    const r: typeof results[number] = { blockName: t.blockName, effectId: t.effectId };
    if (xR) { r.x = xR; r.xBase = { chunk: xR.chunk, ushort: xR.ushort - xR.paramId }; }
    if (yR) { r.y = yR; r.yBase = { chunk: yR.chunk, ushort: yR.ushort - yR.paramId }; }
    results.push(r);
  }

  console.log('\n\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.blockName} (id ${r.effectId}):`);
    if (r.x) console.log(`  X: paramId ${r.x.paramId} @ c${r.x.chunk}:u${r.x.ushort}  → X paramBase = c${r.xBase!.chunk}:u${r.xBase!.ushort}`);
    else console.log('  X: (no diff)');
    if (r.y) console.log(`  Y: paramId ${r.y.paramId} @ c${r.y.chunk}:u${r.y.ushort}  → Y paramBase = c${r.yBase!.chunk}:u${r.yBase!.ushort}`);
    else console.log('  Y: (no diff)');
  }

  console.log('\nReminder: run restore-test-crunch.ts after the full sweep to reset preset 666.');
  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
