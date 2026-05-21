/**
 * Validate the paramBase model: is it FIXED-per-block-type, or is it
 * dependent on what other blocks are co-resident in the preset?
 *
 * Tier-2 batch A placed each block alone and found X paramBase ≈ c2:u4
 * for every block — including blocks that the Tier-1 mapping says live
 * elsewhere. Either the per-block-type claim is wrong, or single-block
 * presets serialize differently than multi-block ones.
 *
 * This script:
 *   1. apply_preset = Test Crunch (6 Tier-1 blocks) + Chorus 1 at (3,1).
 *   2. Probe Chorus X paramBase (raw fn 0x02 set_param + diff).
 *   3. Compare the X paramBase to the chorus-alone result.
 *
 * If they DIFFER, the layout depends on co-resident blocks; Batch A
 * results are invalid and we need a co-resident probe path.
 * If they MATCH, single-block placement is fine.
 *
 * Also re-probes Compressor 1 X paramBase (Tier-1, expected c7:u2) to
 * verify the existing Tier-1 mapping under the Test Crunch layout.
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

async function probeXYParamBase(conn: Conn, effectId: number, blockName: string, paramId: number): Promise<void> {
  console.log(`\n=== ${blockName} (id ${effectId}) ===`);
  for (const channelY of [false, true]) {
    const channelLabel = channelY ? 'Y' : 'X';
    await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
    await new Promise(r => setTimeout(r, 200));
    await setChannel(conn, effectId, channelY);
    await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
    await new Promise(r => setTimeout(r, 300));

    const before = await dump(conn);
    const targetWire = ((channelY ? 0x6000 : 0x2000) + paramId * 37) & 0xffff;
    await setParamRaw(conn, effectId, paramId, targetWire);
    await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
    await new Promise(r => setTimeout(r, 250));
    const after = await dump(conn);

    const pA = parsePresetDump(before);
    const pB = parsePresetDump(after);
    let found = false;
    for (let c = 0; c < 64; c++) {
      const x = decodeChunk(pA.chunkPayloads[c]);
      const y = decodeChunk(pB.chunkPayloads[c]);
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i] && y[i] === targetWire) {
          console.log(`  ${channelLabel} paramId ${paramId}: c${c}:u${i}  → ${channelLabel} paramBase = c${c}:u${i - paramId}`);
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) console.log(`  ${channelLabel} paramId ${paramId}: no diff at target 0x${targetWire.toString(16).padStart(4,'0')}`);
  }
}

async function main(): Promise<void> {
  console.log('Step 1: apply Test Crunch + Chorus 1 at (3,1)...');
  const result = await executeApplyPreset({
    port: 'axe-fx-ii',
    spec: {
      name: 'Test Crunch+Cho',
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'compressor' },
        { slot: { row: 2, col: 2 }, block_type: 'drive' },
        { slot: { row: 2, col: 3 }, block_type: 'amp' },
        { slot: { row: 2, col: 4 }, block_type: 'cab' },
        { slot: { row: 2, col: 5 }, block_type: 'delay' },
        { slot: { row: 2, col: 6 }, block_type: 'reverb' },
        { slot: { row: 2, col: 7 }, block_type: 'chorus' },
      ],
    },
    target_location: 666,
    save_authorized: true,
    on_active_preset_edited: 'discard',
  });
  if (result.ok === false) {
    throw new Error(`apply_preset failed: ${JSON.stringify(result).slice(0, 400)}`);
  }
  await new Promise(r => setTimeout(r, 400));

  const conn = connectAxeFxII();

  // Sanity-check Compressor 1 (Tier-1 expected c7:u2 X, c7:u22 Y).
  await probeXYParamBase(conn, 100, 'Compressor 1 (Tier-1 expected c7:u2 X / c7:u22 Y)', 2);

  // Probe Chorus 1 with multi-block layout.
  await probeXYParamBase(conn, 116, 'Chorus 1 (chorus-alone gave c2:u4 X / c2:u28 Y)', 2);

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
