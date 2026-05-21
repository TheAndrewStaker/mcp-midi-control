/**
 * BK-070 — generic decode-loop helper.
 *
 * Usage:
 *   npx tsx scripts/_research/bk070-decode-loop.ts <experiment-label> <mutation-json>
 *
 * Mutation JSON example:
 *   '{"type":"set_param","block":"amp","name":"master_volume","value":3.0}'
 *   '{"type":"set_bypass","block":"delay","bypassed":true}'
 *   '{"type":"set_param","block":"amp","name":"input_drive","value":7.5}'
 *
 * Sequence (avoids the fn 0x03 cache pitfall by ALWAYS using explicit
 * [bank, preset] payload + dispatching display numbers to executors):
 *
 *   1. switch_preset display=666 (= wire 665) — known scratch slot.
 *   2. Dump WIRE 665 via fn 0x03 [hi, lo] MSB-first → baseline.syx.
 *   3. Apply the mutation via the dispatcher executor.
 *   4. save_preset display=666 — commit working buffer to flash.
 *   5. Dump WIRE 665 again → after.syx.
 *   6. Diff baseline vs after, print runs.
 *
 * Writes captures to samples/captured/bk070-loop-<label>-{baseline,after}.syx.
 * Prints diff inline. Exit code 0 on success, 1 on any failure.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset, executeSavePreset, executeSwitchScene } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeSetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { executeSetBypass } from '@mcp-midi-control/core/protocol-generic/dispatcher/layout.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import {
  CHUNK_PAYLOAD_LEN,
  CHUNKS_PER_PRESET,
  parsePresetDump,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;  // dispatcher uses display, raw uses wire

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_PATCH_DUMP = 0x03;
const FUNC_HEADER = 0x77;
const FUNC_CHUNK = 0x78;
const FUNC_FOOTER = 0x79;

interface Mutation {
  type: 'set_param' | 'set_bypass';
  block: string;
  name?: string;
  value?: number | string;
  bypassed?: boolean;
  channel?: string;
  /** Optional scene to switch to BEFORE applying the mutation. 1-indexed. */
  scene?: number;
}

function checksum(b: number[]): number {
  let a = 0;
  for (const x of b) a ^= x;
  return a & 0x7f;
}

function build(func: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
  return [...head, checksum(head), SYSEX_END];
}

function msbFirstPreset(wire: number): [number, number] {
  return [(wire >> 7) & 0x7f, wire & 0x7f];
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

async function dumpPresetByWire(conn: Conn, wire: number, outPath: string): Promise<string> {
  const [hi, lo] = msbFirstPreset(wire);
  conn.send(build(FUNC_PATCH_DUMP, [hi, lo]));
  const msgs = await capture(conn, 3000, (m) => m.some((x) => x[5] === FUNC_FOOTER));
  const dump = msgs.filter((m) => m[5] === FUNC_HEADER || m[5] === FUNC_CHUNK || m[5] === FUNC_FOOTER);
  if (dump.length !== 66) throw new Error(`dump wire ${wire} failed: ${dump.length} dump frames`);
  const flat: number[] = [];
  for (const m of dump) flat.push(...m);
  writeFileSync(outPath, Buffer.from(flat));
  const chunk0 = dump.find((m) => m[5] === FUNC_CHUNK)!;
  let name = '';
  for (let i = 8; i < 8 + 32 * 3; i += 3) {
    const ch = chunk0[6 + i];
    if (ch === 0) break;
    name += String.fromCharCode(ch);
  }
  return name.trim();
}

function flatten(p: ReturnType<typeof parsePresetDump>): Uint8Array {
  const total = 4 + 64 * CHUNK_PAYLOAD_LEN + 3;
  const out = new Uint8Array(total);
  let cur = 0;
  out.set(p.headerPayload, cur); cur += 4;
  for (const c of p.chunkPayloads) { out.set(c, cur); cur += CHUNK_PAYLOAD_LEN; }
  out.set(p.footerPayload, cur);
  return out;
}

function regionOf(o: number): string {
  if (o < 4) return `HEADER:${o}`;
  const c = o - 4;
  if (c < CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN) {
    const idx = Math.floor(c / CHUNK_PAYLOAD_LEN);
    const off = c % CHUNK_PAYLOAD_LEN;
    return `CHUNK${idx.toString().padStart(2, '0')}:${off.toString().padStart(3, '0')}`;
  }
  return `FOOTER:${c - CHUNKS_PER_PRESET * CHUNK_PAYLOAD_LEN}`;
}

function diff(beforePath: string, afterPath: string): void {
  const a = parsePresetDump(new Uint8Array(readFileSync(beforePath)));
  const b = parsePresetDump(new Uint8Array(readFileSync(afterPath)));
  const fa = flatten(a);
  const fb = flatten(b);
  const diffs: number[] = [];
  for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) diffs.push(i);
  console.log(`\n=== DIFF: ${diffs.length} bytes differ of ${fa.length} ===`);
  if (diffs.length === 0) return;
  const runs: { start: number; end: number }[] = [];
  for (const d of diffs) {
    const last = runs[runs.length - 1];
    if (last !== undefined && d <= last.end + 8) last.end = d;
    else runs.push({ start: d, end: d });
  }
  for (const r of runs) {
    const len = r.end - r.start + 1;
    const bb = Array.from(fa.slice(r.start, r.end + 1)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const aa = Array.from(fb.slice(r.start, r.end + 1)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    console.log(`  ${regionOf(r.start)} [${r.start}..${r.end}] (${len}B):`);
    console.log(`    before=[${bb}]`);
    console.log(`    after =[${aa}]`);
  }
}

async function applyMutation(m: Mutation): Promise<unknown> {
  if (m.type === 'set_param') {
    if (m.name === undefined || m.value === undefined) throw new Error('set_param needs name + value');
    return executeSetParam({ port: 'axe-fx-ii', block: m.block, name: m.name, value: m.value, channel: m.channel });
  }
  if (m.type === 'set_bypass') {
    if (m.bypassed === undefined) throw new Error('set_bypass needs bypassed');
    return executeSetBypass({ port: 'axe-fx-ii', block: m.block, bypassed: m.bypassed });
  }
  throw new Error(`unknown mutation type: ${m.type}`);
}

async function main(): Promise<void> {
  const [label, mutationJson] = process.argv.slice(2);
  if (!label || !mutationJson) {
    console.error('Usage: bk070-decode-loop.ts <label> <mutation-json>');
    process.exit(1);
  }
  const mutation: Mutation = JSON.parse(mutationJson);
  console.log(`Experiment: ${label}`);
  console.log(`Mutation: ${JSON.stringify(mutation)}`);
  console.log(`Scratch: display ${SCRATCH_DISPLAY} (wire ${SCRATCH_WIRE})\n`);

  console.log(`Step 1: switch_preset display=${SCRATCH_DISPLAY}`);
  const sw = await executeSwitchPreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY, on_active_preset_edited: 'discard' });
  console.log(`  ${(sw as { info?: string }).info ?? 'ok'}`);
  await new Promise((r) => setTimeout(r, 200));

  const conn = connectAxeFxII();

  const baselinePath = `samples/captured/bk070-loop-${label}-baseline.syx`;
  const afterPath = `samples/captured/bk070-loop-${label}-after.syx`;

  console.log(`Step 2: dump wire ${SCRATCH_WIRE} → baseline`);
  const baselineName = await dumpPresetByWire(conn, SCRATCH_WIRE, baselinePath);
  console.log(`  "${baselineName}" → ${baselinePath}`);

  if (mutation.scene !== undefined) {
    console.log(`Step 3a: switch_scene ${mutation.scene}`);
    const sceneResult = await executeSwitchScene({ port: 'axe-fx-ii', scene: mutation.scene });
    console.log(`  ${(sceneResult as { info?: string }).info ?? 'ok'}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`Step 3: apply mutation`);
  const muteResult = await applyMutation(mutation);
  console.log(`  ${JSON.stringify(muteResult).slice(0, 220)}`);

  console.log(`Step 4: save_preset display=${SCRATCH_DISPLAY}`);
  const sv = await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  console.log(`  ${(sv as { info?: string }).info ?? 'ok'}`);
  await new Promise((r) => setTimeout(r, 200));

  console.log(`Step 5: dump wire ${SCRATCH_WIRE} → after`);
  const afterName = await dumpPresetByWire(conn, SCRATCH_WIRE, afterPath);
  console.log(`  "${afterName}" → ${afterPath}`);

  diff(baselinePath, afterPath);
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
