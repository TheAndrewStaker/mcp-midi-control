/**
 * Verify whether channel X and channel Y store DIFFERENT param values
 * at DIFFERENT ushort positions in the preset binary.
 *
 * Sequence:
 *   1. Switch to Test Crunch preset 666.
 *   2. Switch scene to one that has Amp on channel X (scene 1).
 *   3. Set amp.input_drive to wire 0x1111.
 *   4. Save + dump.
 *   5. Switch scene to one that has Amp on channel Y. We need to first
 *      set scene 2 to Y (via atomic set_scene_channels), then switch.
 *   6. Set amp.input_drive to wire 0x9999 (very different).
 *   7. Save + dump.
 *   8. Diff dump A vs dump B. If X and Y values live separately, the
 *      diff will show TWO ushorts changed — one with 0x1111 and one
 *      with 0x9999. If they share storage, only one ushort with the
 *      latest value.
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset, executeSavePreset, executeSwitchScene } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeSetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';
import { writeFileSync } from 'node:fs';

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

async function setBlockChannelRaw(conn: Conn, effectId: number, channelY: boolean): Promise<void> {
  const [lo, hi] = septet14(effectId);
  conn.send(build(0x11, [lo, hi, channelY ? 1 : 0, 0]));
  await new Promise(r => setTimeout(r, 300));
}

async function main(): Promise<void> {
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 300));
  const conn = connectAxeFxII();

  // Force amp to channel X for scene 1 first.
  console.log('Step 0: ensure scene 1 with Amp on channel X');
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));
  await setBlockChannelRaw(conn, 106, false);  // amp channel X
  await new Promise(r => setTimeout(r, 200));
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  console.log('Step 1: set amp.input_drive on channel X to a distinctive value (wire 0x1111)');
  await executeSetParam({ port: 'axe-fx-ii', block: 'amp', name: 'input_drive', value: 0x1111 / 65534 * 10 });
  await new Promise(r => setTimeout(r, 200));
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dumpAfterX = await dump(conn);
  writeFileSync('samples/captured/bk070-xy-after-channel-X.syx', Buffer.from(dumpAfterX));

  console.log('Step 2: switch amp to channel Y (current scene)');
  await setBlockChannelRaw(conn, 106, true);  // amp channel Y
  await new Promise(r => setTimeout(r, 300));
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  console.log('Step 3: set amp.input_drive on channel Y to wire 0x9999');
  await executeSetParam({ port: 'axe-fx-ii', block: 'amp', name: 'input_drive', value: 0x9999 / 65534 * 10 });
  await new Promise(r => setTimeout(r, 200));
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));
  const dumpAfterY = await dump(conn);
  writeFileSync('samples/captured/bk070-xy-after-channel-Y.syx', Buffer.from(dumpAfterY));

  console.log('\n--- Diff: dump_X vs dump_Y (only amp.input_drive should differ) ---');
  const pX = parsePresetDump(dumpAfterX);
  const pY = parsePresetDump(dumpAfterY);
  let diffCount = 0;
  for (let c = 0; c < 64; c++) {
    const a = decodeChunk(pX.chunkPayloads[c]);
    const b = decodeChunk(pY.chunkPayloads[c]);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        diffCount++;
        console.log(`  c${c}:u${i}  0x${a[i].toString(16).padStart(4,'0')} (X-saved) → 0x${b[i].toString(16).padStart(4,'0')} (Y-saved)`);
      }
    }
  }
  console.log(`Total diffs: ${diffCount}\n`);

  console.log('Interpretation:');
  console.log('  If X and Y are at DIFFERENT ushorts: we should see two diff positions,');
  console.log('  one holding ~0x1111 (X value) and another holding ~0x9999 (Y value).');
  console.log('  Plus footer hash diff (always changes).');
  console.log('  If X and Y SHARE storage: only one position with the latest value,');
  console.log('  meaning channel switch wipes the other channel.\n');

  // Look at chunk 2 ushort 5 (known amp.input_drive paramBase for current channel).
  const c2_X = decodeChunk(pX.chunkPayloads[2]);
  const c2_Y = decodeChunk(pY.chunkPayloads[2]);
  console.log(`c2:u5 (known input_drive paramBase): X=0x${c2_X[5].toString(16).padStart(4,'0')}, Y=0x${c2_Y[5].toString(16).padStart(4,'0')}`);

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
