/**
 * BK-070 task #15 batch 3 — second-instance blocks + multi-delay.
 *
 * apply_preset doesn't take instance numbers directly in spec.slots —
 * each slot just gets a block_type. To place "Drive 2" we'd need 2 drive
 * slots in the same preset (the system assigns instance numbers in
 * placement order).
 *
 * Strategy: place 2 of each multi-instance block type in one apply_preset.
 * Then toggle bypass on EACH instance's effectId to find their state ushorts.
 */

import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSavePreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;

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
  conn.send(build(0x03, [(SCRATCH_WIRE >> 7) & 0x7f, SCRATCH_WIRE & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  return new Uint8Array(frames.flat());
}

async function toggleBypassAndDiff(conn: Conn, effectId: number, label: string): Promise<void> {
  const baseline = await dump(conn);
  const baselineParsed = parsePresetDump(baseline);

  const [effLo, effHi] = septet14(effectId);
  const [pLo, pHi] = septet14(255);
  conn.send(build(0x02, [effLo, effHi, pLo, pHi, 1, 0, 0, 0x01]));
  await new Promise(r => setTimeout(r, 300));
  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise(r => setTimeout(r, 300));

  const after = await dump(conn);
  const afterParsed = parsePresetDump(after);

  for (let c = 0; c < 64; c++) {
    const a = decodeChunk(baselineParsed.chunkPayloads[c]);
    const b = decodeChunk(afterParsed.chunkPayloads[c]);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`  ${label} (id ${effectId}): c${c}:u${i}  0x${a[i].toString(16).padStart(4,'0')} → 0x${b[i].toString(16).padStart(4,'0')}`);
        return;
      }
    }
  }
  console.log(`  ${label} (id ${effectId}): no diff`);
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();

  // Batch 3a: pair-up amp/drive/cab to get 2nd instances.
  console.log('=== Batch 3a: 2nd instances (amp, drive, cab, reverb) ===');
  try {
    await executeApplyPreset({
      port: 'axe-fx-ii',
      spec: {
        name: 'BK070 2nd inst',
        slots: [
          { slot: { row: 2, col: 1 }, block_type: 'amp', id: 'amp1' },
          { slot: { row: 2, col: 2 }, block_type: 'amp', id: 'amp2' },
          { slot: { row: 2, col: 3 }, block_type: 'drive', id: 'drv1' },
          { slot: { row: 2, col: 4 }, block_type: 'drive', id: 'drv2' },
          { slot: { row: 2, col: 5 }, block_type: 'cab', id: 'cab1' },
          { slot: { row: 2, col: 6 }, block_type: 'cab', id: 'cab2' },
          { slot: { row: 2, col: 7 }, block_type: 'reverb', id: 'rev1' },
          { slot: { row: 2, col: 8 }, block_type: 'reverb', id: 'rev2' },
        ],
      },
      target_location: SCRATCH_DISPLAY,
      save_authorized: true,
      on_active_preset_edited: 'discard',
    } as Parameters<typeof executeApplyPreset>[0]);
    console.log('  apply ok');
  } catch (e) {
    console.log(`  apply failed: ${e instanceof Error ? e.message : e}`);
  }
  await new Promise(r => setTimeout(r, 500));

  await toggleBypassAndDiff(conn, 107, 'Amp 2');
  await toggleBypassAndDiff(conn, 134, 'Drive 2');
  await toggleBypassAndDiff(conn, 109, 'Cab 2');
  await toggleBypassAndDiff(conn, 111, 'Reverb 2');

  // Batch 3b: delays + chorus + flanger 2nd instances
  console.log('\n=== Batch 3b: 2nd instances (delay, chorus, flanger, multi-delay) ===');
  try {
    await executeApplyPreset({
      port: 'axe-fx-ii',
      spec: {
        name: 'BK070 batch 3b',
        slots: [
          { slot: { row: 2, col: 1 }, block_type: 'delay', id: 'dly1' },
          { slot: { row: 2, col: 2 }, block_type: 'delay', id: 'dly2' },
          { slot: { row: 2, col: 3 }, block_type: 'chorus', id: 'cho1' },
          { slot: { row: 2, col: 4 }, block_type: 'chorus', id: 'cho2' },
          { slot: { row: 2, col: 5 }, block_type: 'flanger', id: 'flg1' },
          { slot: { row: 2, col: 6 }, block_type: 'flanger', id: 'flg2' },
          { slot: { row: 2, col: 7 }, block_type: 'multidelay', id: 'mdl1' },
          { slot: { row: 2, col: 8 }, block_type: 'multidelay', id: 'mdl2' },
        ],
      },
      target_location: SCRATCH_DISPLAY,
      save_authorized: true,
      on_active_preset_edited: 'discard',
    } as Parameters<typeof executeApplyPreset>[0]);
    console.log('  apply ok');
  } catch (e) {
    console.log(`  apply failed: ${e instanceof Error ? e.message : e}`);
  }
  await new Promise(r => setTimeout(r, 500));

  await toggleBypassAndDiff(conn, 113, 'Delay 2');
  await toggleBypassAndDiff(conn, 117, 'Chorus 2');
  await toggleBypassAndDiff(conn, 119, 'Flanger 2');
  await toggleBypassAndDiff(conn, 114, 'Multi Delay 1');
  await toggleBypassAndDiff(conn, 115, 'Multi Delay 2');

  // Batch 3c: filter 2, comp 2, phaser 2, wah 2, geq 2, peq 2, rotary 2, etc.
  console.log('\n=== Batch 3c: more 2nd instances ===');
  try {
    await executeApplyPreset({
      port: 'axe-fx-ii',
      spec: {
        name: 'BK070 batch 3c',
        slots: [
          { slot: { row: 2, col: 1 }, block_type: 'compressor', id: 'cmp1' },
          { slot: { row: 2, col: 2 }, block_type: 'compressor', id: 'cmp2' },
          { slot: { row: 2, col: 3 }, block_type: 'phaser', id: 'pha1' },
          { slot: { row: 2, col: 4 }, block_type: 'phaser', id: 'pha2' },
          { slot: { row: 2, col: 5 }, block_type: 'wah', id: 'wah1' },
          { slot: { row: 2, col: 6 }, block_type: 'wah', id: 'wah2' },
          { slot: { row: 2, col: 7 }, block_type: 'filter', id: 'fil1' },
          { slot: { row: 2, col: 8 }, block_type: 'filter', id: 'fil2' },
        ],
      },
      target_location: SCRATCH_DISPLAY,
      save_authorized: true,
      on_active_preset_edited: 'discard',
    } as Parameters<typeof executeApplyPreset>[0]);
    console.log('  apply ok');
  } catch (e) {
    console.log(`  apply failed: ${e instanceof Error ? e.message : e}`);
  }
  await new Promise(r => setTimeout(r, 500));

  await toggleBypassAndDiff(conn, 101, 'Compressor 2');
  await toggleBypassAndDiff(conn, 123, 'Phaser 2');
  await toggleBypassAndDiff(conn, 125, 'Wah 2');
  await toggleBypassAndDiff(conn, 132, 'Filter 2');

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
