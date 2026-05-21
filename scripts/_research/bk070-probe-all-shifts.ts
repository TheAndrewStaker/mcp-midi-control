/**
 * Probe X paramBase for ALL 6 Tier-1 blocks under TWO layouts and
 * surface the deltas.
 *
 * Layout 1: pure Test Crunch (comp/drive/amp/cab/delay/reverb at row 2).
 * Layout 2: Test Crunch + Chorus 1 at (2,7).
 *
 * For each block + each layout, set channel X, probe paramId via raw
 * fn 0x02 SET_PARAM, diff against baseline dump to find the (chunk,
 * ushort). Report each block's X paramBase shift.
 *
 * Goal: characterize whether the binary's per-block packing follows
 * a predictable rule (groupCode order, block-id order, placement order,
 * or some opaque ordering) so we can derive paramBase from the live
 * preset binary instead of a hardcoded map.
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

async function setChannelX(conn: Conn, effectId: number): Promise<void> {
  const [lo, hi] = septet14(effectId);
  conn.send(build(0x11, [lo, hi, 0, 0x01]));
  await new Promise(r => setTimeout(r, 300));
}

async function setParamRaw(conn: Conn, effectId: number, paramId: number, wireValue: number): Promise<void> {
  const [effLo, effHi] = septet14(effectId);
  const [pLo, pHi] = septet14(paramId);
  conn.send(build(0x02, [effLo, effHi, pLo, pHi, wireValue & 0x7f, (wireValue >> 7) & 0x7f, (wireValue >> 14) & 0x03, 0x01]));
  await new Promise(r => setTimeout(r, 250));
}

interface ProbeTarget {
  name: string;
  effectId: number;
  groupCode: string;
  paramId: number;
}

const TARGETS: ProbeTarget[] = [
  { name: 'Compressor 1', effectId: 100, groupCode: 'CPR', paramId: 2 },
  { name: 'Amp 1',        effectId: 106, groupCode: 'AMP', paramId: 1 },
  { name: 'Cab 1',        effectId: 108, groupCode: 'CAB', paramId: 0 },
  { name: 'Reverb 1',     effectId: 110, groupCode: 'REV', paramId: 0 },
  { name: 'Delay 1',      effectId: 112, groupCode: 'DLY', paramId: 0 },
  { name: 'Drive 1',      effectId: 133, groupCode: 'DRV', paramId: 1 },
];

async function probeX(conn: Conn, t: ProbeTarget): Promise<{ chunk: number; ushort: number; xBase: number } | undefined> {
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));
  await setChannelX(conn, t.effectId);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  const before = await dump(conn);
  const targetWire = (0x2000 + t.paramId * 37) & 0xffff;
  await setParamRaw(conn, t.effectId, t.paramId, targetWire);
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
        return { chunk: c, ushort: i, xBase: i - t.paramId };
      }
    }
  }
  return undefined;
}

async function applyLayout(extraChorus: boolean): Promise<void> {
  const slots = [
    { slot: { row: 2, col: 1 }, block_type: 'compressor' },
    { slot: { row: 2, col: 2 }, block_type: 'drive' },
    { slot: { row: 2, col: 3 }, block_type: 'amp' },
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
    { slot: { row: 2, col: 5 }, block_type: 'delay' },
    { slot: { row: 2, col: 6 }, block_type: 'reverb' },
  ];
  if (extraChorus) slots.push({ slot: { row: 2, col: 7 }, block_type: 'chorus' });
  const r = await executeApplyPreset({
    port: 'axe-fx-ii',
    spec: { name: extraChorus ? 'TC+Cho' : 'Test Crunch', slots },
    target_location: 666,
    save_authorized: true,
    on_active_preset_edited: 'discard',
  });
  if (r.ok === false) throw new Error(`apply_preset failed: ${JSON.stringify(r).slice(0, 400)}`);
  await new Promise(r => setTimeout(r, 400));
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();

  console.log('--- Layout 1: Test Crunch (6 blocks) ---');
  await applyLayout(false);
  const layout1: Record<string, { chunk: number; ushort: number; xBase: number } | undefined> = {};
  for (const t of TARGETS) {
    const r = await probeX(conn, t);
    layout1[t.name] = r;
    if (r) console.log(`  ${t.name.padEnd(15)} (${t.groupCode}): paramId ${t.paramId} → c${r.chunk}:u${r.ushort}  → X paramBase c${r.chunk}:u${r.xBase}`);
    else console.log(`  ${t.name.padEnd(15)} (${t.groupCode}): (no diff)`);
  }

  console.log('\n--- Layout 2: Test Crunch + Chorus 1 at (2,7) ---');
  await applyLayout(true);
  const layout2: Record<string, { chunk: number; ushort: number; xBase: number } | undefined> = {};
  for (const t of TARGETS) {
    const r = await probeX(conn, t);
    layout2[t.name] = r;
    if (r) console.log(`  ${t.name.padEnd(15)} (${t.groupCode}): paramId ${t.paramId} → c${r.chunk}:u${r.ushort}  → X paramBase c${r.chunk}:u${r.xBase}`);
    else console.log(`  ${t.name.padEnd(15)} (${t.groupCode}): (no diff)`);
  }
  // Also probe Chorus in layout 2.
  const chorus = await probeX(conn, { name: 'Chorus 1', effectId: 116, groupCode: 'CHO', paramId: 2 });
  if (chorus) console.log(`  Chorus 1        (CHO): paramId 2 → c${chorus.chunk}:u${chorus.ushort}  → X paramBase c${chorus.chunk}:u${chorus.xBase}`);

  console.log('\n=== SHIFT TABLE ===');
  console.log('Block (groupCode) | L1 X paramBase | L2 X paramBase | Δ');
  for (const t of TARGETS) {
    const a = layout1[t.name];
    const b = layout2[t.name];
    const aStr = a ? `c${a.chunk}:u${a.xBase}` : '???';
    const bStr = b ? `c${b.chunk}:u${b.xBase}` : '???';
    let delta = 'n/a';
    if (a && b) {
      const aGlobal = a.chunk * 64 + a.xBase;
      const bGlobal = b.chunk * 64 + b.xBase;
      delta = (bGlobal - aGlobal).toString();
    }
    console.log(`  ${t.name.padEnd(15)} (${t.groupCode}) | ${aStr.padStart(8)} | ${bStr.padStart(8)} | ${delta}`);
  }
  if (chorus) console.log(`  Chorus 1        (CHO) |    (n/a) | c${chorus.chunk}:u${chorus.xBase} | n/a`);

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
