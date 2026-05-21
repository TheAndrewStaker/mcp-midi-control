/**
 * BK-070 task #3 — per-scene BYPASS ushort mapper.
 *
 * Mirrors bk070-channel-experiment-v2 but uses SET_BLOCK_BYPASS (fn 0x10
 * or fn 0x11 with bypass flag) instead of SET_BLOCK_CHANNEL. Toggles
 * bypass on scene 4 for the named block, dumps before+after, native-
 * diffs to find which (chunk, ushort, bit) encodes per-scene bypass.
 *
 * Strategy: instead of trying both directions, we ensure scene 4 starts
 * NOT-bypassed by reading current state first (via get_block_layout-ish
 * dump), then toggle to bypassed. The diff reveals exactly one bit.
 *
 * Usage:
 *   npx tsx scripts/_research/bk070-bypass-mapper.ts <block-name> <effectId>
 *
 * Runs the test for all 8 scenes sequentially to confirm the bit pattern.
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
import { parsePresetDump, CHUNKS_PER_PRESET } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_SET_PARAM = 0x02;  // SET_BLOCK_PARAMETER_VALUE; bypass uses paramId=255
const FUNC_PATCH_DUMP = 0x03;

function csum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
function build(func: number, payload: number[]): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
  return [...head, csum(head), SYSEX_END];
}
function septet14(v: number): [number, number] { return [v & 0x7f, (v >> 7) & 0x7f]; }
function msbPreset(w: number): [number, number] { return [(w >> 7) & 0x7f, w & 0x7f]; }

function decodeChunkNative(payload: Uint8Array): Uint16Array {
  const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    out[i] = ((payload[off] & 0x7f) |
      ((payload[off + 1] & 0x7f) << 7) |
      ((payload[off + 2] & 0x7f) << 14)) & 0xffff;
  }
  return out;
}

type Conn = ReturnType<typeof connectAxeFxII>;

async function capture(conn: Conn, ms: number, until?: (m: number[][]) => boolean): Promise<number[][]> {
  const msgs: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === SYSEX_START) msgs.push([...b]); });
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    if (until && until(msgs)) break;
  }
  unsub();
  return msgs;
}

async function dumpWire(conn: Conn, wire: number, outPath: string): Promise<void> {
  const [hi, lo] = msbPreset(wire);
  conn.send(build(FUNC_PATCH_DUMP, [hi, lo]));
  const msgs = await capture(conn, 3000, (m) => m.some((x) => x[5] === 0x79));
  const dump = msgs.filter((m) => m[5] === 0x77 || m[5] === 0x78 || m[5] === 0x79);
  if (dump.length !== 66) throw new Error(`dump failed: ${dump.length}`);
  const flat: number[] = [];
  for (const m of dump) flat.push(...m);
  writeFileSync(outPath, Buffer.from(flat));
}

function findDiffs(beforePath: string, afterPath: string): Array<{
  chunk: number; ushort: number; before: number; after: number; xor: number;
}> {
  const before = parsePresetDump(new Uint8Array(readFileSync(beforePath)));
  const after = parsePresetDump(new Uint8Array(readFileSync(afterPath)));
  const out: Array<{ chunk: number; ushort: number; before: number; after: number; xor: number }> = [];
  for (let c = 0; c < CHUNKS_PER_PRESET; c++) {
    const a = decodeChunkNative(before.chunkPayloads[c]);
    const b = decodeChunkNative(after.chunkPayloads[c]);
    const lim = Math.min(a.length, b.length);
    for (let i = 0; i < lim; i++) {
      if (a[i] !== b[i]) out.push({ chunk: c, ushort: i, before: a[i], after: b[i], xor: a[i] ^ b[i] });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [blockName, effectIdStr] = process.argv.slice(2);
  if (!blockName || !effectIdStr) {
    console.error('Usage: <block-name> <effectId>');
    process.exit(1);
  }
  const effectId = parseInt(effectIdStr, 10);

  console.log(`Per-scene bypass mapper for ${blockName} (effectId=${effectId})\n`);

  const conn = connectAxeFxII();

  // For each scene 1..8, toggle bypass and diff.
  // We assume the block starts not-bypassed in all scenes (default).
  const results: Array<{ scene: number; chunk: number; ushort: number; bits: number[]; deltaBytes: string }> = [];

  for (let scene = 1; scene <= 8; scene++) {
    console.log(`--- Scene ${scene}: toggle bypass to ON ---`);
    await executeSwitchPreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY, on_active_preset_edited: 'discard' });
    await new Promise((r) => setTimeout(r, 250));

    const baselinePath = `samples/captured/bk070-bp-${blockName.replace(/\s+/g, '_')}-s${scene}-baseline.syx`;
    const afterPath = `samples/captured/bk070-bp-${blockName.replace(/\s+/g, '_')}-s${scene}-after.syx`;

    await dumpWire(conn, SCRATCH_WIRE, baselinePath);
    await executeSwitchScene({ port: 'axe-fx-ii', scene });
    await new Promise((r) => setTimeout(r, 200));

    // SET_BLOCK_PARAMETER_VALUE (fn 0x02) with paramId=255: bypass.
    // Wire: [eff7-0, eff13-7, param7-0, param13-7, val7-0, val13-7, val15-14, qmark]
    const [effLo, effHi] = septet14(effectId);
    const [paramLo, paramHi] = septet14(255);
    const value = 1;  // 1 = bypassed, 0 = engaged
    const valLo = value & 0x7f;
    const valMid = (value >> 7) & 0x7f;
    const valHi = (value >> 14) & 0x03;
    // Last byte is ACTION_SET (0x01); 0x00 would be ACTION_QUERY (a GET).
    const msg = build(FUNC_SET_PARAM, [effLo, effHi, paramLo, paramHi, valLo, valMid, valHi, 0x01]);
    conn.send(msg);
    await new Promise((r) => setTimeout(r, 400));

    await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
    await new Promise((r) => setTimeout(r, 200));

    await dumpWire(conn, SCRATCH_WIRE, afterPath);

    const diffs = findDiffs(baselinePath, afterPath);
    if (diffs.length === 0) {
      console.log(`  no diff (already bypassed or NACK)`);
    } else {
      for (const d of diffs) {
        const bits: number[] = [];
        for (let bit = 0; bit < 16; bit++) if (d.xor & (1 << bit)) bits.push(bit);
        results.push({ scene, chunk: d.chunk, ushort: d.ushort, bits, deltaBytes: `0x${d.before.toString(16).padStart(4, '0')}→0x${d.after.toString(16).padStart(4, '0')}` });
        console.log(`  diff: chunk ${d.chunk} ushort ${d.ushort}: 0x${d.before.toString(16).padStart(4, '0')} → 0x${d.after.toString(16).padStart(4, '0')}  bits=[${bits.join(',')}]`);
      }
    }
  }

  // Reset everything back: toggle bypass off for all scenes.
  console.log('\n--- Cleanup: toggle bypass back OFF for all scenes ---');
  for (let scene = 1; scene <= 8; scene++) {
    await executeSwitchScene({ port: 'axe-fx-ii', scene });
    await new Promise((r) => setTimeout(r, 100));
    const [effLo, effHi] = septet14(effectId);
    const [paramLo, paramHi] = septet14(255);
    conn.send(build(FUNC_SET_PARAM, [effLo, effHi, paramLo, paramHi, 0, 0, 0, 0x01]));
    await new Promise((r) => setTimeout(r, 100));
  }
  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise((r) => setTimeout(r, 200));

  console.log('\n=== Summary ===');
  console.log(`Block: ${blockName} (effectId=${effectId})`);
  console.log('Scene | Chunk | Ushort | Bits flipped | Delta');
  console.log('------|-------|--------|--------------|------');
  for (const r of results) {
    console.log(`  ${r.scene}   |   ${r.chunk.toString().padStart(2)}  |   ${r.ushort.toString().padStart(2)}   | [${r.bits.join(',').padEnd(8)}] | ${r.deltaBytes}`);
  }

  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
