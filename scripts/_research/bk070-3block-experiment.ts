/**
 * Test 1: modify 3 ushorts in chunk 3 (amp params region)
 * Test 2: modify 1 ushort in each of chunks 2, 10, 8 (the failing positions)
 * Test 3: modify 1 ushort in each of chunks 2, 5, 7 (different positions)
 *
 * Determine whether 3-block scene-channel modification is rejected
 * because of MULTI-CHUNK count or SPECIFIC positions.
 */

import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump, serializePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };
const build = (fn: number, payload: number[]): number[] => { const h = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...payload]; return [...h, csum(h), 0xf7]; };

function decodeChunk(p: Uint8Array): Uint16Array { const c = (p[0]&0x7f)|((p[1]&0x7f)<<7); const o = new Uint16Array(c); for (let i=0;i<c;i++) { const off=2+i*3; o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff; } return o; }
// PRESERVES byte-2 high 5 bits (= bits 16-20 of the 21-bit septet wire
// value). Overwriting them with zeros causes the device to NACK with
// 0x13 on fn 0x79 for chunks where those bits carry device-private state.
function writeU(p: Uint8Array, idx: number, v: number): void { const off=2+idx*3; p[off]=v&0x7f; p[off+1]=(v>>7)&0x7f; p[off+2]=(p[off+2]&0x7c)|((v>>14)&0x03); }
function hash(chunks: readonly Uint8Array[]): number { let x=0; for (const c of chunks) for (const u of decodeChunk(c)) x^=u; return x&0xffff; }

let conn: ReturnType<typeof connectAxeFxII>;

async function dump(): Promise<Uint8Array> {
  let frames: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0] === 0xf0 && b[4] === 0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
  conn.send(build(0x03, [665 >> 7, 665 & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  if (frames.length !== 66) throw new Error(`dump got ${frames.length} frames`);
  return new Uint8Array(frames.flat());
}

async function push(bytes: Uint8Array): Promise<number> {
  const responses: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0] === 0xf0) responses.push([...b]); });
  const messages: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xf0) { i++; continue; }
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== 0xf7) j++;
    messages.push(Array.from(bytes.slice(i, j + 1)));
    i = j + 1;
  }
  for (const m of messages) {
    conn.send(m);
    await new Promise(r => setTimeout(r, 12));
  }
  await new Promise(r => setTimeout(r, 1000));
  unsub();
  let nacks = 0;
  for (const r of responses) {
    if (r[5] === 0x64 && r[7] !== 0x00) {
      nacks++;
      console.log(`  NACK: fn=0x${r[6].toString(16)} result=0x${r[7].toString(16)}`);
    }
  }
  return nacks;
}

interface Mutation {
  chunk: number;
  ushort: number;
  newVal: number;
}

async function tryMutations(label: string, mutations: Mutation[]): Promise<void> {
  console.log(`\n=== ${label} ===`);
  // Switch + dump to reset baseline
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 250));
  const bytes = await dump();
  const parsed = parsePresetDump(bytes);
  const chunks = parsed.chunkPayloads.map((c: Uint8Array) => new Uint8Array(c));
  for (const m of mutations) {
    const old = decodeChunk(chunks[m.chunk])[m.ushort];
    writeU(chunks[m.chunk], m.ushort, m.newVal);
    console.log(`  mod chunk ${m.chunk} ushort ${m.ushort}: 0x${old.toString(16).padStart(4,'0')} → 0x${m.newVal.toString(16).padStart(4,'0')}`);
  }
  const newHash = hash(chunks);
  const newFooter = new Uint8Array([newHash & 0x7f, (newHash >> 7) & 0x7f, (parsed.footerPayload[2] & 0x7c) | ((newHash >> 14) & 0x03)]);
  const modified = serializePresetDump({ raw: parsed.raw, headerPayload: parsed.headerPayload, chunkPayloads: chunks, footerPayload: newFooter });
  const nacks = await push(modified);
  console.log(`  result: ${nacks === 0 ? '✅ accepted' : `❌ ${nacks} NACK(s)`}`);
}

async function main(): Promise<void> {
  conn = connectAxeFxII();

  // Get a fresh baseline first
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 250));
  const b0 = await dump();
  const p0 = parsePresetDump(b0);
  function read(c: number, u: number): number { return decodeChunk(p0.chunkPayloads[c])[u]; }
  console.log(`Baseline: c2u32=0x${read(2,32).toString(16).padStart(4,'0')} c10u1=0x${read(10,1).toString(16).padStart(4,'0')} c8u2=0x${read(8,2).toString(16).padStart(4,'0')}`);

  // Test A: Modify only chunk 3 in 3 places (param region)
  await tryMutations('Test A: 3 ushorts in chunk 3 (param region)', [
    { chunk: 3, ushort: 10, newVal: 0x1234 },
    { chunk: 3, ushort: 11, newVal: 0x5678 },
    { chunk: 3, ushort: 12, newVal: 0x9abc },
  ]);

  // Test B: Modify chunk 2 + 10 + 8 with NON-channel-bitmap values
  await tryMutations('Test B: chunks 2/10/8 with bytes far from scene-Y region', [
    { chunk: 2, ushort: 32, newVal: read(2,32) },  // no change
    { chunk: 10, ushort: 1, newVal: read(10,1) },  // no change
    { chunk: 8, ushort: 2, newVal: read(8,2) },    // no change
  ]);

  // Test C: Modify chunk 2 ONLY (scene-Y bitmap)
  await tryMutations('Test C: chunk 2 only (amp scene-Y)', [
    { chunk: 2, ushort: 32, newVal: (read(2,32) & 0xff) | 0xaa00 },
  ]);

  // Test D: Modify chunk 8 only (delay scene-Y)
  await tryMutations('Test D: chunk 8 only (delay scene-Y)', [
    { chunk: 8, ushort: 2, newVal: (read(8,2) & 0xff) | 0x7800 },
  ]);

  // Test E: Modify chunk 2 + chunk 8 (2 blocks)
  await tryMutations('Test E: chunk 2 + chunk 8 (amp + delay)', [
    { chunk: 2, ushort: 32, newVal: (read(2,32) & 0xff) | 0xaa00 },
    { chunk: 8, ushort: 2, newVal: (read(8,2) & 0xff) | 0x7800 },
  ]);

  // Test F: Modify chunk 2 + chunk 10 (2 blocks: amp + drive)
  await tryMutations('Test F: chunk 2 + chunk 10 (amp + drive)', [
    { chunk: 2, ushort: 32, newVal: (read(2,32) & 0xff) | 0xaa00 },
    { chunk: 10, ushort: 1, newVal: (read(10,1) & 0xff) | 0x5500 },
  ]);

  setTimeout(() => process.exit(0), 200);
}

main().catch(e => { console.error(e); process.exit(1); });
