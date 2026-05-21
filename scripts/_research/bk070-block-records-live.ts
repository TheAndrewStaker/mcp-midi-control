/**
 * Dump preset 666's block records from a fresh hardware dump.
 *
 * Calls fn 0x03 with explicit [hi, lo] = wire 665, parses the
 * 0x77/0x78/0x79 stream, then renders all 12 block records.
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump, extractPresetName, type ParsedPresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';
import { AXE_FX_II_BLOCKS } from '@mcp-midi-control/axe-fx-ii/blockTypes.js';

registerDevice(AXEFX2_DESCRIPTOR);

const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };
const build = (fn: number, payload: number[]): number[] => { const h = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...payload]; return [...h, csum(h), 0xf7]; };

function decodeChunk(p: Uint8Array): Uint16Array {
  const c = (p[0]&0x7f)|((p[1]&0x7f)<<7);
  const o = new Uint16Array(c);
  for (let i=0;i<c;i++) { const off=2+i*3; o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff; }
  return o;
}

const ID_TO_BLOCK = new Map(AXE_FX_II_BLOCKS.map(b => [b.id, b]));

function showBlockRecords(parsed: ParsedPresetDump): void {
  const c0 = decodeChunk(parsed.chunkPayloads[0]);
  const c1 = decodeChunk(parsed.chunkPayloads[1]);
  const stream: number[] = [...c0, ...c1];
  console.log(`Preset "${extractPresetName(parsed)}" — block records:`);
  console.log('rec | stream-idx | block_id | block               | ushort[1] | ushort[2..7]');
  for (let i = 0; i < 12; i++) {
    const base = 36 + i * 8;
    if (base + 8 > stream.length) break;
    const r = stream.slice(base, base + 8);
    const blockId = r[0];
    const block = ID_TO_BLOCK.get(blockId);
    if (blockId === 0 && r[1] === 0) continue;
    const blockCol = (block?.name ?? `<id ${blockId}>`).padEnd(20);
    const u1 = '0x' + r[1].toString(16).padStart(4, '0');
    const tail = r.slice(2).map(v => '0x' + v.toString(16).padStart(4, '0')).join(' ');
    console.log(`${(i+1).toString().padStart(3)} | ${base.toString().padStart(10)} |    ${blockId.toString().padStart(3)}   | ${blockCol}| ${u1}    | ${tail}`);
  }
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  const frames: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0]===0xf0 && b[4]===0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
  conn.send(build(0x03, [(665 >> 7) & 0x7f, 665 & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  if (frames.length !== 66) throw new Error(`dump got ${frames.length} frames`);
  const bytes = new Uint8Array(frames.flat());
  const parsed = parsePresetDump(bytes);
  showBlockRecords(parsed);
  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
