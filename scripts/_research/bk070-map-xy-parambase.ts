/**
 * Map X and Y paramBase for all Tier-1 blocks (have known paramBase).
 *
 * For each block:
 *   1. Force scene 1 channel X. Write paramId 1 = 0x1111. Diff → X loc.
 *   2. Force scene 1 channel Y. Write paramId 1 = 0x9999. Diff → Y loc.
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset, executeSavePreset, executeSwitchScene } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
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

interface ParamBase {
  blockName: string;
  effectId: number;
  testParamId: number;
  xLocation?: { chunk: number; ushort: number };
  yLocation?: { chunk: number; ushort: number };
}

async function findChannelLoc(conn: Conn, effectId: number, paramId: number, channelY: boolean, targetWire: number): Promise<{ chunk: number; ushort: number } | undefined> {
  // Force channel + scene 1
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));
  await setChannel(conn, effectId, channelY);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  const before = await dump(conn);
  await setParamRaw(conn, effectId, paramId, targetWire);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const after = await dump(conn);

  const pA = parsePresetDump(before);
  const pB = parsePresetDump(after);
  for (let c = 0; c < 64; c++) {
    const x = decodeChunk(pA.chunkPayloads[c]);
    const y = decodeChunk(pB.chunkPayloads[c]);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i] && y[i] === targetWire) {
        return { chunk: c, ushort: i };
      }
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 300));
  const conn = connectAxeFxII();

  // Test paramId 1 (typically a settable knob) for each block.
  // Pick distinctive values that aren't used elsewhere.
  const X_VALUE = 0x2345;  // Distinctive bit pattern, no collision
  const Y_VALUE = 0x6789;  // Distinctive bit pattern, no collision

  const results: ParamBase[] = [
    { blockName: 'Compressor 1', effectId: 100, testParamId: 5 },  // Threshold
    { blockName: 'Amp 1',        effectId: 106, testParamId: 1 },  // Input Drive
    { blockName: 'Cab 1',        effectId: 108, testParamId: 9 },  // Level
    { blockName: 'Reverb 1',     effectId: 110, testParamId: 1 },  // Time
    { blockName: 'Delay 1',      effectId: 112, testParamId: 1 },  // Time
    { blockName: 'Drive 1',      effectId: 133, testParamId: 1 },  // Drive
  ];

  for (const r of results) {
    console.log(`\n=== ${r.blockName} (id ${r.effectId}) testParamId ${r.testParamId} ===`);
    r.xLocation = await findChannelLoc(conn, r.effectId, r.testParamId, false, X_VALUE);
    console.log(`  X: ${r.xLocation ? `c${r.xLocation.chunk}:u${r.xLocation.ushort}` : '(no diff)'}`);
    r.yLocation = await findChannelLoc(conn, r.effectId, r.testParamId, true, Y_VALUE);
    console.log(`  Y: ${r.yLocation ? `c${r.yLocation.chunk}:u${r.yLocation.ushort}` : '(no diff)'}`);
  }

  console.log('\n\n=== SUMMARY ===');
  console.log('Block         | X paramBase | Y paramBase');
  console.log('--------------|-------------|------------');
  for (const r of results) {
    const xBase = r.xLocation ? `c${r.xLocation.chunk}:u${r.xLocation.ushort - r.testParamId}` : '???';
    const yBase = r.yLocation ? `c${r.yLocation.chunk}:u${r.yLocation.ushort - r.testParamId}` : '???';
    console.log(`${r.blockName.padEnd(13)} | ${xBase.padEnd(11)} | ${yBase}`);
  }

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
