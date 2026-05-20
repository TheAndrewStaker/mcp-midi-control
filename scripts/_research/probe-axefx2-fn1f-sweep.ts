/**
 * Grid-driven fn 0x1F SYSEX_GET_ALL_PARAMS sweep.
 *
 * Strategy:
 *   1. Read the grid via fn 0x20 GET_GRID_LAYOUT to learn which
 *      blockIds are placed in the current preset.
 *   2. For each placed block, send fn 0x1F SYSEX_GET_ALL_PARAMS
 *      with the blockId and listen 1.5 s for responses.
 *   3. Save everything received per-block to a separate file so
 *      offline decode can compare across blocks.
 *
 * If fn 0x1F returns structured per-param data for placed blocks
 * AND nothing/garbage for unplaced blocks, that's the bulk-read
 * primitive BK-070 needs. The agent then makes 1 call per placed
 * block (~5-10 calls per typical preset) instead of ~100 per-param
 * calls.
 *
 * READ-ONLY. No state mutation. Run:
 *
 *   npx tsx scripts/_research/probe-axefx2-fn1f-sweep.ts
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function buildEnvelope(fn: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AXE_FX_II_MODEL, fn, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) {
        console.log(`  matched port [${i}] ${name}`);
        return i;
      }
    }
  }
  return -1;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Decode the fn 0x20 GET_GRID_LAYOUT response into a list of placed
 * blocks. Per docs/devices/axe-fx-ii/SYSEX-MAP.md §5c: 200-byte frame,
 * 192-byte payload, column-major (12 cols × 4 rows × 4 bytes/cell).
 * Each cell is [blockId_lo, blockId_hi, routing_mask, byte3]; blockId
 * 0 = empty slot.
 */
function decodeGridLayout(frame: number[]): Array<{ row: number; col: number; blockId: number }> {
  const placed: Array<{ row: number; col: number; blockId: number }> = [];
  // Payload starts at index 6 (after F0 00 01 74 [model] [fn]).
  // Skip leading bytes up to the cell array. The grid response has a
  // small prefix before the cell bytes; per SYSEX-MAP §5c the cells
  // start somewhere in the payload. We probe the common case: cells
  // tightly packed in a 12 × 4 × 4-byte layout starting near the end
  // of the envelope.
  // Find the payload window: skip 6 envelope bytes, drop last 2 (cs + F7).
  const payload = frame.slice(6, -2);
  // The first few bytes are likely metadata; the cell array is
  // 12 * 4 * 4 = 192 bytes. If payload >= 192 bytes, take the last 192.
  const cellStart = Math.max(0, payload.length - 192);
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 4; row++) {
      const off = cellStart + (col * 4 + row) * 4;
      if (off + 1 >= payload.length) continue;
      const blockId = decode14(payload[off] ?? 0, payload[off + 1] ?? 0);
      if (blockId !== 0) placed.push({ row: row + 1, col: col + 1, blockId });
    }
  }
  return placed;
}

interface ProbeResult {
  blockId: number;
  blockName?: string;
  inboundFrames: number[][];
}

async function main(): Promise<void> {
  console.log('Axe-Fx II fn 0x1F grid-driven sweep (read-only)');

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: Axe-Fx II output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: Axe-Fx II input port not found'); process.exit(1); }
  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);

  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => { if (bytes[0] === 0xf0) collected.push(bytes.slice()); });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  // ── Step 1: Read grid via fn 0x20 ──
  console.log('\n── Step 1: read grid via fn 0x20 GET_GRID_LAYOUT ──');
  const gridReq = buildEnvelope(0x20);
  console.log(`  SEND: ${toHex(gridReq)}`);
  output.sendMessage(gridReq);
  await sleep(1000);
  const gridFrames = collected.filter((f) => f.length >= 6 && f[5] === 0x20);
  if (gridFrames.length === 0) {
    console.error('  ERROR: no fn 0x20 response. Cannot continue without grid.');
    process.exit(1);
  }
  const grid = gridFrames[0];
  console.log(`  received fn 0x20 response, ${grid.length} bytes`);
  const placed = decodeGridLayout(grid);
  console.log(`  placed blocks: ${placed.length}`);
  for (const p of placed) {
    console.log(`    row ${p.row} col ${p.col}  blockId 0x${p.blockId.toString(16)} (${p.blockId})`);
  }
  if (placed.length === 0) {
    console.error('  ERROR: no placed blocks detected. Verify the preset has at least one effect.');
    process.exit(1);
  }
  collected.length = 0;

  // ── Step 2: fn 0x1F per placed block ──
  console.log('\n── Step 2: fn 0x1F SYSEX_GET_ALL_PARAMS sweep ──');
  const results: ProbeResult[] = [];
  for (const p of placed) {
    const before = collected.length;
    const req = buildEnvelope(0x1f, [...encode14(p.blockId)]);
    console.log(`\n  blockId 0x${p.blockId.toString(16)} (row ${p.row} col ${p.col})`);
    console.log(`    SEND: ${toHex(req)}`);
    output.sendMessage(req);
    await sleep(1500);
    const inbound = collected.slice(before);
    results.push({ blockId: p.blockId, inboundFrames: inbound });
    console.log(`    received ${inbound.length} inbound frames`);
    for (let i = 0; i < Math.min(inbound.length, 5); i++) {
      const f = inbound[i];
      const fnLabel = f.length >= 6 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74
        ? `fn=0x${f[5]?.toString(16).padStart(2, '0')}`
        : '(non-Fractal)';
      const preview = toHex(f.slice(0, 24));
      console.log(`      [${i}] ${fnLabel} len=${f.length}  ${preview}${f.length > 24 ? ' …' : ''}`);
    }
    if (inbound.length > 5) console.log(`      ... (${inbound.length - 5} more frames not shown)`);
  }

  // ── Save raw bytes per block ──
  mkdirSync('samples/captured/fn1f-sweep', { recursive: true });
  for (const r of results) {
    const fname = `block-${r.blockId.toString(16).padStart(2, '0')}.syx`;
    const out = path.resolve('samples/captured/fn1f-sweep', fname);
    const concat = r.inboundFrames.flat();
    writeFileSync(out, Uint8Array.from(concat));
  }
  console.log(`\nSaved per-block raw bytes to samples/captured/fn1f-sweep/`);

  // ── Summary ──
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('SUMMARY:');
  console.log(`  Probed ${results.length} placed blocks via fn 0x1F.`);
  let totalInbound = 0;
  let totalBytes = 0;
  let triplesSeen = 0;
  const fnCounts = new Map<number, number>();
  for (const r of results) {
    totalInbound += r.inboundFrames.length;
    for (const f of r.inboundFrames) {
      totalBytes += f.length;
      if (f.length >= 6 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74) {
        const fn = f[5];
        fnCounts.set(fn, (fnCounts.get(fn) ?? 0) + 1);
        if (fn === 0x74 || fn === 0x75 || fn === 0x76) triplesSeen++;
      }
    }
  }
  console.log(`  Total inbound: ${totalInbound} frames, ${totalBytes} bytes`);
  console.log(`  State-broadcast triples (0x74/0x75/0x76): ${triplesSeen}`);
  console.log(`  Per-fn distribution:`);
  for (const [fn, n] of Array.from(fnCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`    fn=0x${fn.toString(16).padStart(2, '0')}: ${n}`);
  }
  console.log('──────────────────────────────────────────────────────────────');

  if (triplesSeen > 0) {
    console.log('\n💡 INTERPRETATION: fn 0x1F triggers state-broadcast triples.');
    console.log('   This means BK-070 = send fn 0x1F per placed block + decode the');
    console.log('   resulting 0x74/0x75/0x76 triples using the existing decoder.');
    console.log('   ~10 calls per preset, ~50ms each = ~500ms total. Done.');
  } else if (fnCounts.size > 0) {
    console.log('\n💡 INTERPRETATION: fn 0x1F responds in a different envelope.');
    console.log('   Inspect the saved per-block .syx files to decode the shape.');
  } else {
    console.log('\n⚠️  INTERPRETATION: fn 0x1F appears fire-and-forget OR not supported.');
    console.log('   Next experiment: try fn 0x21 RESYNC instead (see probe-axefx2-bulk-read.ts).');
  }

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(99);
});
