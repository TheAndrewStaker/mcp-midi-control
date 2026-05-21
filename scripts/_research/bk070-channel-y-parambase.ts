/**
 * Discover Y-channel paramBase for amp + drive.
 *
 * For each block, switch to channel Y, write distinctive values to
 * paramId 0..10, dump, and find the diffs (= Y region locations).
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

async function mapBlock(conn: Conn, blockName: string, effectId: number, paramIds: number[]): Promise<void> {
  console.log(`\n=== ${blockName} (id ${effectId}) — Y-channel paramBase ===`);
  // Force to channel Y first
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));
  await setChannel(conn, effectId, true);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  for (const pid of paramIds) {
    const before = await dump(conn);
    // Write distinctive value: 0x5000 + pid * 23 (out of typical patterns)
    const targetWire = (0x5000 + pid * 23) & 0xffff;
    await setParamRaw(conn, effectId, pid, targetWire);
    await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
    await new Promise(r => setTimeout(r, 200));
    const after = await dump(conn);

    const pA = parsePresetDump(before);
    const pB = parsePresetDump(after);
    let found: { chunk: number; ushort: number; from: number; to: number } | undefined;
    for (let c = 0; c < 64; c++) {
      const a = decodeChunk(pA.chunkPayloads[c]);
      const b = decodeChunk(pB.chunkPayloads[c]);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i] && b[i] === targetWire) {
          if (!found) found = { chunk: c, ushort: i, from: a[i], to: b[i] };
        }
      }
    }
    if (found) {
      console.log(`  Y paramId ${pid.toString().padStart(3)}: c${found.chunk}:u${found.ushort}  0x${found.from.toString(16).padStart(4,'0')} → 0x${found.to.toString(16).padStart(4,'0')}`);
    } else {
      console.log(`  Y paramId ${pid.toString().padStart(3)}: no diff at target value 0x${targetWire.toString(16).padStart(4,'0')}`);
    }
  }
}

async function main(): Promise<void> {
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 300));
  const conn = connectAxeFxII();

  // Amp 1 (effectId 106): test paramIds 0,1,2,3,4,5,8,10,20,50,64,80
  await mapBlock(conn, 'Amp 1', 106, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 64, 80]);

  // Drive 1 (effectId 133): test paramIds 0,1,2,3,4,5,10,15
  await mapBlock(conn, 'Drive 1', 133, [0, 1, 2, 3, 4, 5, 10, 15]);

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
