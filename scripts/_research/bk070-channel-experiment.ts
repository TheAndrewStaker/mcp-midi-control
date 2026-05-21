/**
 * BK-070 — per-scene channel routing decode.
 *
 * Switches scene, sends raw SET_BLOCK_CHANNEL (fn 0x11), saves, dumps.
 * Bypasses the dispatcher's channel-switch safety guard since we're
 * EXPECTING corruption on non-active scenes (that's literally the
 * point of decoding the field — to write it safely later via atomic
 * binary apply).
 *
 * Usage:
 *   npx tsx scripts/_research/bk070-channel-experiment.ts <label> <scene> <X|Y>
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset, executeSavePreset, executeSwitchScene } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { CHUNK_PAYLOAD_LEN, CHUNKS_PER_PRESET, parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;
const AMP1_EFFECT_ID = 106;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_BLOCK_CHANNEL = 0x11;
const FUNC_PATCH_DUMP = 0x03;

function checksum(b: number[]): number {
  let a = 0; for (const x of b) a ^= x; return a & 0x7f;
}
function build(func: number, payload: number[]): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
  return [...head, checksum(head), SYSEX_END];
}
function septet14(v: number): [number, number] { return [v & 0x7f, (v >> 7) & 0x7f]; }
function msbPreset(w: number): [number, number] { return [(w >> 7) & 0x7f, w & 0x7f]; }

async function capture(conn: ReturnType<typeof connectAxeFxII>, ms: number, until?: (m: number[][]) => boolean): Promise<number[][]> {
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

async function dumpWire(conn: ReturnType<typeof connectAxeFxII>, wire: number, outPath: string): Promise<void> {
  const [hi, lo] = msbPreset(wire);
  conn.send(build(FUNC_PATCH_DUMP, [hi, lo]));
  const msgs = await capture(conn, 3000, (m) => m.some((x) => x[5] === 0x79));
  const dump = msgs.filter((m) => m[5] === 0x77 || m[5] === 0x78 || m[5] === 0x79);
  if (dump.length !== 66) throw new Error(`dump failed: ${dump.length}`);
  const flat: number[] = [];
  for (const m of dump) flat.push(...m);
  writeFileSync(outPath, Buffer.from(flat));
}

function diff(beforePath: string, afterPath: string): void {
  const before = parsePresetDump(new Uint8Array(readFileSync(beforePath)));
  const after = parsePresetDump(new Uint8Array(readFileSync(afterPath)));
  function flat(p: typeof before): Uint8Array {
    const total = 4 + 64 * CHUNK_PAYLOAD_LEN + 3;
    const out = new Uint8Array(total);
    let cur = 0;
    out.set(p.headerPayload, cur); cur += 4;
    for (const c of p.chunkPayloads) { out.set(c, cur); cur += CHUNK_PAYLOAD_LEN; }
    out.set(p.footerPayload, cur);
    return out;
  }
  const fa = flat(before); const fb = flat(after);
  const diffs: number[] = [];
  for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) diffs.push(i);
  console.log(`\n=== DIFF: ${diffs.length} bytes ===`);
  if (diffs.length === 0) return;
  const runs: { start: number; end: number }[] = [];
  for (const d of diffs) {
    const last = runs[runs.length - 1];
    if (last !== undefined && d <= last.end + 8) last.end = d;
    else runs.push({ start: d, end: d });
  }
  function regionOf(o: number): string {
    if (o < 4) return `HEADER:${o}`;
    const c = o - 4;
    if (c < CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN) {
      const idx = Math.floor(c / CHUNK_PAYLOAD_LEN);
      return `CHUNK${idx.toString().padStart(2, '0')}:${(c % CHUNK_PAYLOAD_LEN).toString().padStart(3, '0')}`;
    }
    return `FOOTER:${c - CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN}`;
  }
  for (const r of runs) {
    const len = r.end - r.start + 1;
    const bb = Array.from(fa.slice(r.start, r.end + 1)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const aa = Array.from(fb.slice(r.start, r.end + 1)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  ${regionOf(r.start)} [${r.start}..${r.end}] (${len}B):`);
    console.log(`    before=[${bb}]`);
    console.log(`    after =[${aa}]`);
  }
}

async function main(): Promise<void> {
  const [label, sceneStr, channelStr] = process.argv.slice(2);
  if (!label || !sceneStr || !channelStr) {
    console.error('Usage: <label> <scene 1-8> <X|Y>');
    process.exit(1);
  }
  const scene = parseInt(sceneStr, 10);
  const channel = channelStr.toUpperCase() === 'Y' ? 1 : 0;

  console.log(`Experiment: ${label} — set amp on scene ${scene} to channel ${channel === 1 ? 'Y' : 'X'}`);

  await executeSwitchPreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY, on_active_preset_edited: 'discard' });
  await new Promise((r) => setTimeout(r, 200));

  const conn = connectAxeFxII();
  const baselinePath = `samples/captured/bk070-loop-${label}-baseline.syx`;
  const afterPath = `samples/captured/bk070-loop-${label}-after.syx`;

  console.log(`Step 1: dump baseline (wire ${SCRATCH_WIRE})`);
  await dumpWire(conn, SCRATCH_WIRE, baselinePath);

  console.log(`Step 2: switch to scene ${scene}`);
  await executeSwitchScene({ port: 'axe-fx-ii', scene });
  await new Promise((r) => setTimeout(r, 200));

  console.log(`Step 3: raw SET_BLOCK_CHANNEL effectId=${AMP1_EFFECT_ID} channel=${channel}`);
  const [lo, hi] = septet14(AMP1_EFFECT_ID);
  const msg = build(FUNC_BLOCK_CHANNEL, [lo, hi, channel, 0x01]);
  console.log(`  wire: ${msg.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  conn.send(msg);
  await new Promise((r) => setTimeout(r, 400));

  console.log(`Step 4: save_preset display=${SCRATCH_DISPLAY}`);
  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise((r) => setTimeout(r, 200));

  console.log(`Step 5: dump after`);
  await dumpWire(conn, SCRATCH_WIRE, afterPath);

  diff(baselinePath, afterPath);
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
