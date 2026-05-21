/**
 * BK-070 — generalized per-scene channel byte mapper.
 *
 * Usage:
 *   npx tsx scripts/_research/bk070-channel-experiment-v2.ts <block-name> <effectId> <scene> <X|Y>
 *
 * Example:
 *   npx tsx scripts/_research/bk070-channel-experiment-v2.ts "Drive 1" 133 1 Y
 *
 * Expected outcome per hypothesis "slot N → chunk 2 native ushort (8 + 8N)":
 *   - Amp 1 at slot 3 → chunk 2 ushort 32 (confirmed)
 *   - Drive 1 at slot 2 → chunk 2 ushort 24
 *   - Delay 1 at slot 5 → chunk 2 ushort 48
 *   - Reverb 1 at slot 6 → chunk 2 ushort 56
 *
 * Each experiment switches to scratch (preset 666 = Test Crunch), dumps
 * baseline, switches to target scene, sends raw SET_BLOCK_CHANNEL
 * (fn 0x11) for the specified block, saves, dumps after, diffs the
 * decoded native stream.
 */

import { readFileSync, writeFileSync } from 'node:fs';
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
const FUNC_BLOCK_CHANNEL = 0x11;
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

function nativeDiff(beforePath: string, afterPath: string): void {
  const before = parsePresetDump(new Uint8Array(readFileSync(beforePath)));
  const after = parsePresetDump(new Uint8Array(readFileSync(afterPath)));
  let totalDiffs = 0;
  for (let c = 0; c < CHUNKS_PER_PRESET; c++) {
    const a = decodeChunkNative(before.chunkPayloads[c]);
    const b = decodeChunkNative(after.chunkPayloads[c]);
    const lim = Math.min(a.length, b.length);
    const diffs: Array<{ i: number; a: number; b: number }> = [];
    for (let i = 0; i < lim; i++) {
      if (a[i] !== b[i]) diffs.push({ i, a: a[i], b: b[i] });
    }
    if (diffs.length > 0) {
      console.log(`Chunk ${c}: ${diffs.length} ushort(s) differ`);
      for (const d of diffs) {
        const xor = d.a ^ d.b;
        const bits: number[] = [];
        for (let bit = 0; bit < 16; bit++) if (xor & (1 << bit)) bits.push(bit);
        console.log(
          `  ushort[${d.i.toString().padStart(2)}]: ` +
          `0x${d.a.toString(16).padStart(4, '0')} → 0x${d.b.toString(16).padStart(4, '0')}  ` +
          `xor 0x${xor.toString(16).padStart(4, '0')}  bits=[${bits.join(',')}]`,
        );
        totalDiffs++;
      }
    }
  }
  // Footer
  for (let i = 0; i < 3; i++) {
    if (before.footerPayload[i] !== after.footerPayload[i]) {
      console.log(`Footer[${i}]: 0x${before.footerPayload[i].toString(16)} → 0x${after.footerPayload[i].toString(16)}`);
    }
  }
  console.log(`\nTotal native-ushort diffs: ${totalDiffs}`);
}

async function main(): Promise<void> {
  const [blockName, effectIdStr, sceneStr, channelStr] = process.argv.slice(2);
  if (!blockName || !effectIdStr || !sceneStr || !channelStr) {
    console.error('Usage: <block-name> <effectId> <scene 1-8> <X|Y>');
    process.exit(1);
  }
  const effectId = parseInt(effectIdStr, 10);
  const scene = parseInt(sceneStr, 10);
  const channel = channelStr.toUpperCase() === 'Y' ? 1 : 0;
  const label = `${blockName.replace(/\s+/g, '_')}-s${scene}-${channel === 1 ? 'Y' : 'X'}`;

  console.log(`Experiment: ${label}`);
  console.log(`  Block: "${blockName}" (effectId=${effectId})`);
  console.log(`  Set scene ${scene} to channel ${channel === 1 ? 'Y' : 'X'}\n`);

  console.log('Step 1: switch_preset 666 (discard)');
  await executeSwitchPreset({
    port: 'axe-fx-ii',
    location: SCRATCH_DISPLAY,
    on_active_preset_edited: 'discard',
  });
  await new Promise((r) => setTimeout(r, 250));

  const conn = connectAxeFxII();
  const baselinePath = `samples/captured/bk070-ch-${label}-baseline.syx`;
  const afterPath = `samples/captured/bk070-ch-${label}-after.syx`;

  console.log(`Step 2: dump baseline (wire ${SCRATCH_WIRE})`);
  await dumpWire(conn, SCRATCH_WIRE, baselinePath);

  console.log(`Step 3: switch_scene ${scene}`);
  await executeSwitchScene({ port: 'axe-fx-ii', scene });
  await new Promise((r) => setTimeout(r, 200));

  console.log(`Step 4: SET_BLOCK_CHANNEL effectId=${effectId} channel=${channel === 1 ? 'Y' : 'X'}`);
  const [lo, hi] = septet14(effectId);
  const msg = build(FUNC_BLOCK_CHANNEL, [lo, hi, channel, 0x01]);
  console.log(`  wire: ${msg.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  conn.send(msg);
  await new Promise((r) => setTimeout(r, 400));

  console.log(`Step 5: save_preset ${SCRATCH_DISPLAY}`);
  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise((r) => setTimeout(r, 200));

  console.log(`Step 6: dump after`);
  await dumpWire(conn, SCRATCH_WIRE, afterPath);

  console.log(`\n=== Native-ushort diff ===`);
  nativeDiff(baselinePath, afterPath);

  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
