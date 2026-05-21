/**
 * Map X+Y paramBase for blocks using configurable test paramIds.
 *
 * Each block needs a probe paramId that's:
 *   - Writable (not select-only with limited range)
 *   - Accepts arbitrary 16-bit wire values
 *   - Distinct between current device value and our probe value
 *
 * Usage:
 *   Edit BLOCKS_TO_TEST below, then npx tsx <this>.
 *
 * For Tier-2 blocks we'll place them via apply_preset first.
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

/** Force scene 1 on specified channel, save, dump, write multiple paramIds, dump, find the first paramId whose write produced a clean diff. */
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
    // Distinctive per paramId so we can identify which write landed.
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
  probeParamIds: number[];
}

const BLOCKS_TO_TEST: BlockTest[] = [
  // Retry Comp + Delay with known-good paramIds from earlier sweeps.
  { blockName: 'Compressor 1', effectId: 100, probeParamIds: [0, 2, 3, 4, 5, 8, 9] },
  { blockName: 'Delay 1', effectId: 112, probeParamIds: [0, 2, 4, 5, 7, 10, 25, 30] },
];

async function main(): Promise<void> {
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

  for (const t of BLOCKS_TO_TEST) {
    console.log(`\n=== ${t.blockName} (id ${t.effectId}) ===`);
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

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
