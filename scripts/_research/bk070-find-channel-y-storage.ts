/**
 * BK-070 — definitively locate channel-Y param storage.
 *
 * Sequence:
 *   1. Switch scene 1, set amp channel to X. Save. Dump 0 = baseline.
 *   2. SET amp.input_drive to 0x1111 (lands on channel X). Save. Dump 1.
 *      Diff(0→1) reveals where X's input_drive value lives.
 *   3. Switch amp channel to Y on scene 1. Save. Dump 2.
 *      Diff(1→2) reveals only the per-scene-state ushort change.
 *   4. SET amp.input_drive to 0x9999 (lands on channel Y now). Save. Dump 3.
 *      Diff(2→3) reveals where Y's input_drive value lives.
 *   5. Diff(0→3): if X and Y are SEPARATE storage, we see 2 ushorts
 *      changed (plus per-scene-state + footer). If they SHARE storage,
 *      only 1 ushort changed.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  executeSwitchPreset,
  executeSavePreset,
  executeSwitchScene,
} from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
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

async function dump(conn: Conn, label: string): Promise<Uint8Array> {
  const frames: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0]===0xf0 && b[4]===0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
  conn.send(build(0x03, [(665 >> 7) & 0x7f, 665 & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  if (frames.length !== 66) throw new Error(`dump ${label} got ${frames.length} frames`);
  const bytes = new Uint8Array(frames.flat());
  writeFileSync(`samples/captured/bk070-xy-${label}.syx`, Buffer.from(bytes));
  return bytes;
}

async function setBlockChannelRaw(conn: Conn, effectId: number, channelY: boolean): Promise<void> {
  const [lo, hi] = septet14(effectId);
  // Wire format per fractal-midi/buildSetBlockChannel:
  //   [effectId_lo, effectId_hi, channel (0=X, 1=Y), 0x01 (ACTION_SET)]
  conn.send(build(0x11, [lo, hi, channelY ? 1 : 0, 0x01]));
  await new Promise(r => setTimeout(r, 300));
}

async function setParamRaw(conn: Conn, effectId: number, paramId: number, wireValue: number): Promise<void> {
  const [effLo, effHi] = septet14(effectId);
  const [pLo, pHi] = septet14(paramId);
  const valLo = wireValue & 0x7f;
  const valMid = (wireValue >> 7) & 0x7f;
  const valHi = (wireValue >> 14) & 0x03;
  conn.send(build(0x02, [effLo, effHi, pLo, pHi, valLo, valMid, valHi, 0x01]));
  await new Promise(r => setTimeout(r, 250));
}

function diffDumps(a: Uint8Array, b: Uint8Array, label: string, skipFooter = false): Array<{ chunk: number; ushort: number; a: number; b: number }> {
  const pA = parsePresetDump(a);
  const pB = parsePresetDump(b);
  const diffs: Array<{ chunk: number; ushort: number; a: number; b: number }> = [];
  for (let c = 0; c < 64; c++) {
    const x = decodeChunk(pA.chunkPayloads[c]);
    const y = decodeChunk(pB.chunkPayloads[c]);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) diffs.push({ chunk: c, ushort: i, a: x[i], b: y[i] });
    }
  }
  console.log(`\n  Diff ${label} (${diffs.length} native-ushort changes):`);
  for (const d of diffs) {
    console.log(`    c${d.chunk}:u${d.ushort}  0x${d.a.toString(16).padStart(4,'0')} → 0x${d.b.toString(16).padStart(4,'0')}`);
  }
  return diffs;
}

async function main(): Promise<void> {
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 300));
  const conn = connectAxeFxII();

  // Force scene 1 and channel X on amp.
  console.log('Setup: scene 1 + amp channel X');
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));
  await setBlockChannelRaw(conn, 106, false);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  const dump0 = await dump(conn, 'dump0-baseline-X');
  console.log('Dumped baseline (channel X active)');

  console.log('\n--- Step 1: write amp.input_drive = 0x1111 (currently on channel X) ---');
  await setParamRaw(conn, 106, 1, 0x1111);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dump1 = await dump(conn, 'dump1-X-set-to-1111');
  diffDumps(dump0, dump1, '0 → 1 (X write)');

  console.log('\n--- Step 2: switch amp to channel Y (scene 1 still active) ---');
  await setBlockChannelRaw(conn, 106, true);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dump2 = await dump(conn, 'dump2-after-Y-switch');
  diffDumps(dump1, dump2, '1 → 2 (channel switch)');

  console.log('\n--- Step 3: write amp.input_drive = 0x9999 (currently on channel Y) ---');
  await setParamRaw(conn, 106, 1, 0x9999);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dump3 = await dump(conn, 'dump3-Y-set-to-9999');
  diffDumps(dump2, dump3, '2 → 3 (Y write)');

  console.log('\n--- Aggregate: diff 0 → 3 (full X→Y journey) ---');
  const allDiffs = diffDumps(dump0, dump3, '0 → 3 (X=0x1111 then Y=0x9999)');

  console.log('\n=== INTERPRETATION ===');
  // Count non-footer diffs (footer always changes due to hash).
  const valueDiffs = allDiffs.filter(d => !(d.chunk === 0 && d.ushort < 4));
  // Look for diffs where target value is 0x1111 (X) or 0x9999 (Y)
  const xLocations = allDiffs.filter(d => d.b === 0x1111);
  const yLocations = allDiffs.filter(d => d.b === 0x9999);
  console.log(`Locations holding 0x1111 (X value): ${xLocations.map(d => `c${d.chunk}:u${d.ushort}`).join(', ') || 'NONE'}`);
  console.log(`Locations holding 0x9999 (Y value): ${yLocations.map(d => `c${d.chunk}:u${d.ushort}`).join(', ') || 'NONE'}`);

  if (xLocations.length > 0 && yLocations.length > 0) {
    console.log('\n✅ X and Y stored at SEPARATE ushorts — atomic dual-channel write is possible.');
  } else if (xLocations.length === 0 && yLocations.length > 0) {
    console.log('\n⚠ Only Y location found. X may have been overwritten or X share storage with Y.');
    console.log('  (X\'s value 0x1111 may not appear in dump3 because step 3 overwrote it.)');
  } else if (xLocations.length > 0 && yLocations.length === 0) {
    console.log('\n⚠ Only X location found. Unexpected — Y write didn\'t land.');
  } else {
    console.log('\n⚠ Neither value found at expected positions — investigate diff output above.');
  }

  setTimeout(() => process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
