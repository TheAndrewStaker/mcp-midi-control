/**
 * BK-070 — parse the chunk 0 + chunk 1 block-record list.
 *
 * Discovered Session 115: block records live at chunk 0 ushort 36+ with
 * stride 8 ushorts (24 wire bytes). Each record:
 *   ushort[0] = block_id (14-bit, matches AXE_FX_II_BLOCKS.id)
 *   ushort[1] = flag/state (0x0002 = "active in standard scene"? 0x0000 = "absent"?)
 *   ushort[2..7] = unknown, zero in factory presets
 *
 * 12 records per preset (Axe-Fx II has 12 grid slots). Chunk 0 holds the
 * first ~4 records (ushorts 36..63), records 5+ overflow into chunk 1.
 *
 * Hypothesis (Session 115): record index N → chunk index N. Test Crunch
 * has Amp 1 at record index 3 (the 3rd block placed), and the parallel
 * agent decoded amp.input_drive at CHUNK03:179 — exact match.
 */

import { readFileSync, existsSync } from 'node:fs';
import {
  parsePresetBank,
  parsePresetDump,
  PRESET_DUMP_LEN,
  extractPresetName,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';
import { AXE_FX_II_BLOCKS } from '@mcp-midi-control/axe-fx-ii/blockTypes.js';
import type { ParsedPresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

function decodeChunkNative(payload: Uint8Array): Uint16Array {
  const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    const v =
      ((payload[off] & 0x7f) |
        ((payload[off + 1] & 0x7f) << 7) |
        ((payload[off + 2] & 0x7f) << 14)) &
      0xffff;
    out[i] = v;
  }
  return out;
}

interface BlockRecord {
  recordIndex: number;   // 1..12
  chunk: number;         // chunk where the record lives
  ushortInChunk: number; // ushort offset within that chunk
  blockId: number;
  blockName: string;
  blockGroup: string;
  flag: number;          // second ushort of the record
  /** Raw 8 ushorts of the record. */
  raw: number[];
}

const ID_TO_BLOCK = new Map(AXE_FX_II_BLOCKS.map((b) => [b.id, b]));

function parseBlockRecords(parsed: ParsedPresetDump): BlockRecord[] {
  // Concatenate the chunk 0 + chunk 1 native streams; records live starting
  // at chunk 0 ushort 36 with stride 8, 12 records total.
  const chunk0 = decodeChunkNative(parsed.chunkPayloads[0]);
  const chunk1 = decodeChunkNative(parsed.chunkPayloads[1]);
  const stream: number[] = [...chunk0, ...chunk1];
  const records: BlockRecord[] = [];
  for (let i = 0; i < 12; i++) {
    const ushortInStream = 36 + i * 8;
    if (ushortInStream + 8 > stream.length) break;
    const raw = stream.slice(ushortInStream, ushortInStream + 8);
    const blockId = raw[0];
    const block = ID_TO_BLOCK.get(blockId);
    let chunkIdx = 0;
    let inChunk = ushortInStream;
    if (ushortInStream >= chunk0.length) {
      chunkIdx = 1;
      inChunk = ushortInStream - chunk0.length;
    }
    records.push({
      recordIndex: i + 1,
      chunk: chunkIdx,
      ushortInChunk: inChunk,
      blockId,
      blockName: block?.name ?? `<unknown id ${blockId}>`,
      blockGroup: block?.groupCode ?? '???',
      flag: raw[1],
      raw,
    });
  }
  return records;
}

function showPreset(parsed: ParsedPresetDump, label: string): void {
  const name = extractPresetName(parsed);
  const records = parseBlockRecords(parsed);
  console.log(`\n--- ${label}: "${name}" ---`);
  console.log('  rec  | chunk-loc  | block (id)            | flag    | raw[2..7]');
  console.log('  -----+------------+-----------------------+---------+----------');
  for (const r of records) {
    if (r.blockId === 0 && r.flag === 0) continue; // empty slot
    const loc = `C${r.chunk}:u${r.ushortInChunk.toString().padStart(2)}`;
    const blockCol = `${r.blockName.padEnd(20)} (${r.blockId})`;
    const flagCol = `0x${r.flag.toString(16).padStart(4, '0')}`;
    const tail = r.raw.slice(2).map((v) => '0x' + v.toString(16).padStart(4, '0')).join(' ');
    console.log(`   ${r.recordIndex.toString().padStart(2)}  | ${loc}     | ${blockCol} | ${flagCol}  | ${tail}`);
  }
}

function loadBank(path: string): ParsedPresetDump[] | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = new Uint8Array(readFileSync(path));
  return parsePresetBank(bytes);
}

function main(): void {
  console.log('BK-070 — block-record list parser\n');

  const bankA = loadBank('samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx');
  if (bankA !== undefined) {
    for (const idx of [0, 1, 64, 100, 127]) {
      if (idx < bankA.length) showPreset(bankA[idx], `Bank A preset ${idx}`);
    }
  }

  for (const captureName of [
    'bk070-loop-amp-master-vol-3-baseline.syx',
    'bk070-loop-amp-bass-2-baseline.syx',
    'bk070-pwh-baseline.syx',
    'bk070-pwh-redump.syx',
  ]) {
    const path = `samples/captured/${captureName}`;
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.length !== PRESET_DUMP_LEN) continue;
    showPreset(parsePresetDump(bytes), captureName);
  }
}

main();
