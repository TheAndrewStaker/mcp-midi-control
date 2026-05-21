/**
 * Verify whether Drive 1 actually has separate X and Y param storage.
 * Force channel X, write 0x1111. Force channel Y, write 0x9999. Dump
 * each step.
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

function diff(a: Uint8Array, b: Uint8Array, label: string): void {
  const pA = parsePresetDump(a);
  const pB = parsePresetDump(b);
  console.log(`\n${label}:`);
  let count = 0;
  for (let c = 0; c < 64; c++) {
    const x = decodeChunk(pA.chunkPayloads[c]);
    const y = decodeChunk(pB.chunkPayloads[c]);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) {
        console.log(`  c${c}:u${i}  0x${x[i].toString(16).padStart(4,'0')} → 0x${y[i].toString(16).padStart(4,'0')}`);
        count++;
      }
    }
  }
  console.log(`  (${count} diffs)`);
}

async function main(): Promise<void> {
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 300));
  const conn = connectAxeFxII();
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));

  // Force drive scene 1 to channel X.
  console.log('Step A: force drive scene 1 to channel X');
  await setChannel(conn, 133, false);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dA = await dump(conn);

  // Write drive paramId 1 to 0x1111 (going to X).
  console.log('Step B: write drive paramId 1 = 0x1111');
  await setParamRaw(conn, 133, 1, 0x1111);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dB = await dump(conn);
  diff(dA, dB, 'A → B (X write)');

  // Force drive scene 1 to channel Y.
  console.log('Step C: switch drive to channel Y');
  await setChannel(conn, 133, true);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dC = await dump(conn);
  diff(dB, dC, 'B → C (channel switch — should be just per-scene state)');

  // Write drive paramId 1 to 0x9999 (going to Y).
  console.log('Step D: write drive paramId 1 = 0x9999');
  await setParamRaw(conn, 133, 1, 0x9999);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dD = await dump(conn);
  diff(dC, dD, 'C → D (Y write)');

  // Final diff A → D should show 3 ushorts: X loc=0x1111, Y loc=0x9999, scene-state.
  diff(dA, dD, 'A → D (full journey)');

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
