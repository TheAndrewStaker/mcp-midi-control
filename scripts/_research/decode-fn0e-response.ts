/**
 * Decode the fn 0x0E PRESET_BLOCKS_DATA response from
 * session-58-direct-sync.syx. Hypothesis: each 5-byte chunk is
 * `[flag_byte, addr_lo, addr_hi, value_lo, value_hi]` where addr is a
 * 14-bit septet pair giving the block's offset in the preset binary,
 * and value is another 14-bit pair carrying state.
 *
 * Cross-checks:
 *   1. Are the addr values monotonically increasing? (Suggests offsets
 *      into a contiguous preset binary.)
 *   2. Do the addr increments match the preset binary's chunk size
 *      (the preset-dump 0x77/0x78/0x79 envelope is 64 chunks × 194-byte
 *      payloads = ~12 KB)?
 *   3. Does the flag-byte distribution (02/03) correlate with
 *      something obvious (count? size class? channel count?)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CAPTURE = path.resolve('samples/captured/session-58-direct-sync.syx');
const TARGET_OFFSET = 0x1462b;

const buf = new Uint8Array(readFileSync(CAPTURE));

// Find the fn 0x0E frame at the target offset.
if (buf[TARGET_OFFSET] !== 0xf0) {
  throw new Error(`Expected SysEx start at 0x${TARGET_OFFSET.toString(16)}, got 0x${buf[TARGET_OFFSET].toString(16)}`);
}
let end = TARGET_OFFSET + 1;
while (end < buf.length && buf[end] !== 0xf7) end++;
const frame = buf.subarray(TARGET_OFFSET, end + 1);
console.log(`Frame: ${frame.length} bytes`);
console.log(`Envelope: F0 ${[1, 2, 3, 4, 5].map((i) => frame[i].toString(16).padStart(2, '0')).join(' ')} ...`);
const payload = frame.subarray(6, -2); // strip envelope + cs + F7
console.log(`Payload: ${payload.length} bytes`);
console.log(`  hex: ${Array.from(payload).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

// Walk 5-byte chunks.
const chunkCount = Math.floor(payload.length / 5);
const remainder = payload.length % 5;
console.log(`\n${chunkCount} chunks × 5 bytes (+${remainder} byte remainder)`);
console.log(`Index | Flag | Addr(septet) Addr(raw)  | Val(septet) Val(raw)  | hex`);
console.log(`------|------|-------------------------|------------------------|----`);

interface Chunk {
  flag: number;
  addrSeptet: number;
  valSeptet: number;
  rawAddrPair: [number, number];
  rawValPair: [number, number];
}

const chunks: Chunk[] = [];
for (let i = 0; i < chunkCount; i++) {
  const c = payload.subarray(i * 5, i * 5 + 5);
  const flag = c[0];
  const addrLo = c[1], addrHi = c[2];
  const valLo = c[3],  valHi = c[4];
  const addrSeptet = addrLo | (addrHi << 7);
  const valSeptet  = valLo  | (valHi  << 7);
  chunks.push({
    flag,
    addrSeptet,
    valSeptet,
    rawAddrPair: [addrLo, addrHi],
    rawValPair: [valLo, valHi],
  });
  const hex = Array.from(c).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  ${String(i).padStart(2)}  | 0x${flag.toString(16).padStart(2, '0')} | ${String(addrSeptet).padStart(6)} 0x${addrSeptet.toString(16).padStart(4, '0')}  ${(c[1] + ' ' + c[2]).padStart(8)} | ${String(valSeptet).padStart(6)} 0x${valSeptet.toString(16).padStart(4, '0')}  ${(c[3] + ' ' + c[4]).padStart(8)} | ${hex}`);
}
if (remainder > 0) {
  const tail = payload.subarray(chunkCount * 5);
  console.log(`\nRemainder: ${Array.from(tail).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
}

// ── Analyze monotonicity + deltas ──
console.log(`\nAddress monotonicity check:`);
let monoIncreasing = true;
for (let i = 1; i < chunks.length; i++) {
  if (chunks[i].addrSeptet < chunks[i - 1].addrSeptet) {
    monoIncreasing = false;
    console.log(`  chunk ${i}: addr ${chunks[i].addrSeptet} < prev ${chunks[i - 1].addrSeptet}`);
  }
}
console.log(`  monotonically increasing: ${monoIncreasing}`);

console.log(`\nAddress deltas (chunk[i+1].addr - chunk[i].addr):`);
for (let i = 1; i < chunks.length; i++) {
  const delta = chunks[i].addrSeptet - chunks[i - 1].addrSeptet;
  console.log(`  ${i - 1}→${i}: delta=${delta}`);
}

// ── Flag distribution ──
console.log(`\nFlag byte distribution:`);
const flagCounts = new Map<number, number>();
for (const c of chunks) flagCounts.set(c.flag, (flagCounts.get(c.flag) ?? 0) + 1);
for (const [f, n] of Array.from(flagCounts.entries()).sort()) {
  console.log(`  0x${f.toString(16).padStart(2, '0')}: ${n} chunks`);
}

// ── Cross-reference with known block IDs ──
// Wiki effect IDs: 100..170 (placeable effect blocks).
// 100/101 Compressor 1/2, 102-104/etc GEQ, 104-105 PEQ, 106/107 AMP 1/2,
// 108/109 CAB 1/2, 110/111 Reverb, 112/113 Delay, etc.
//
// If the 5-byte chunks encode blockId, we should see values like
// 100..170 in one of the fields. Let me see.

const interestingValues = new Set<number>();
for (const c of chunks) {
  interestingValues.add(c.flag);
  interestingValues.add(c.rawAddrPair[0]);
  interestingValues.add(c.rawAddrPair[1]);
  interestingValues.add(c.rawValPair[0]);
  interestingValues.add(c.rawValPair[1]);
}
console.log(`\nAll distinct individual bytes seen across chunks:`);
console.log(`  ${Array.from(interestingValues).sort((a, b) => a - b).map((v) => v.toString(16).padStart(2, '0')).join(' ')}`);

console.log(`\nBlock-ID hypothesis: do any positions contain values in the 0x64..0xAA range (wiki block IDs)?`);
const positionNames = ['flag', 'addrLo', 'addrHi', 'valLo', 'valHi'];
for (let pos = 0; pos < 5; pos++) {
  const vals = chunks.map((c) => [c.flag, c.rawAddrPair[0], c.rawAddrPair[1], c.rawValPair[0], c.rawValPair[1]][pos]);
  const inBlockIdRange = vals.filter((v) => v >= 0x64 && v <= 0xaa);
  console.log(`  position ${pos} (${positionNames[pos]}): ${inBlockIdRange.length}/${chunks.length} in block-ID range, values=[${vals.map((v) => '0x' + v.toString(16)).join(', ')}]`);
}
