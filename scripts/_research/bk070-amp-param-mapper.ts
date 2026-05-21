/**
 * BK-070 task #8 — per-param offset map for amp block.
 *
 * For each amp param (paramId 0..50 sampled at intervals):
 *   1. Switch to scratch (Test Crunch, preset 666)
 *   2. Dump baseline
 *   3. set_param to a value DIFFERENT from current (so we get a diff)
 *   4. save_preset
 *   5. Dump after
 *   6. native-diff: find which (chunk, ushort) changed
 *
 * Tests hypothesis: amp param values live in chunk 3, with paramId N
 * at native ushort (58 + N). Parallel agent verified for paramIds 1, 2, 5.
 *
 * Runs in a single pass so we don't switch presets between each test.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  executeSwitchPreset,
  executeSavePreset,
} from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump, CHUNKS_PER_PRESET } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SCRATCH_DISPLAY = 666;
const SCRATCH_WIRE = SCRATCH_DISPLAY - 1;
const EFFECT_ID = parseInt(process.env.EFFECT_ID ?? '106', 10);
const AMP1_EFFECT_ID = EFFECT_ID; // backward compat

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_SET_PARAM = 0x02;
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

async function dumpWire(conn: Conn, wire: number): Promise<Uint8Array> {
  const [hi, lo] = msbPreset(wire);
  conn.send(build(FUNC_PATCH_DUMP, [hi, lo]));
  const msgs = await capture(conn, 3000, (m) => m.some((x) => x[5] === 0x79));
  const dump = msgs.filter((m) => m[5] === 0x77 || m[5] === 0x78 || m[5] === 0x79);
  if (dump.length !== 66) throw new Error(`dump failed: ${dump.length} frames`);
  return new Uint8Array(dump.flat());
}

interface ParamResult {
  paramId: number;
  baselineWire: number;
  targetWire: number;
  diffs: Array<{ chunk: number; ushort: number; before: number; after: number }>;
}

async function setParamAndCapture(conn: Conn, effectId: number, paramId: number, newWire: number, baselineBytes: Uint8Array): Promise<ParamResult> {
  const [effLo, effHi] = septet14(effectId);
  const [pLo, pHi] = septet14(paramId);
  const valLo = newWire & 0x7f;
  const valMid = (newWire >> 7) & 0x7f;
  const valHi = (newWire >> 14) & 0x03;
  conn.send(build(FUNC_SET_PARAM, [effLo, effHi, pLo, pHi, valLo, valMid, valHi, 0x01]));
  await new Promise((r) => setTimeout(r, 200));

  await executeSavePreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY });
  await new Promise((r) => setTimeout(r, 200));

  const afterBytes = await dumpWire(conn, SCRATCH_WIRE);

  const before = parsePresetDump(baselineBytes);
  const after = parsePresetDump(afterBytes);
  const diffs: Array<{ chunk: number; ushort: number; before: number; after: number }> = [];
  for (let c = 0; c < CHUNKS_PER_PRESET; c++) {
    const a = decodeChunkNative(before.chunkPayloads[c]);
    const b = decodeChunkNative(after.chunkPayloads[c]);
    const lim = Math.min(a.length, b.length);
    for (let i = 0; i < lim; i++) {
      if (a[i] !== b[i]) diffs.push({ chunk: c, ushort: i, before: a[i], after: b[i] });
    }
  }
  return { paramId, baselineWire: 0, targetWire: newWire, diffs };
}

async function main(): Promise<void> {
  // Switch + dump baseline ONCE.
  await executeSwitchPreset({ port: 'axe-fx-ii', location: SCRATCH_DISPLAY, on_active_preset_edited: 'discard' });
  await new Promise((r) => setTimeout(r, 250));
  const conn = connectAxeFxII();

  // Probe a sequence of amp paramIds to verify the (paramId → ushort) pattern.
  const paramIds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24, 25, 26, 30, 40, 50, 64, 80, 100, 120];
  const results: ParamResult[] = [];

  for (const pid of paramIds) {
    // Re-dump as new baseline each time (since we save after each mod).
    const baseline = await dumpWire(conn, SCRATCH_WIRE);
    // Set this param to a unique value (avoid colliding with existing).
    // Mid-range to be valid across most param types (knobs, selects with
    // <0x4000 enum values, etc.). Each paramId gets a slightly different
    // value so we can disambiguate which ushort changes.
    const targetWire = (0x2000 + pid * 7) & 0xffff;
    console.log(`paramId ${pid}: set to wire 0x${targetWire.toString(16).padStart(4, '0')}`);
    try {
      const r = await setParamAndCapture(conn, AMP1_EFFECT_ID, pid, targetWire, baseline);
      results.push(r);
      if (r.diffs.length === 0) {
        console.log(`  (no diff — param read-only or invalid)`);
      } else {
        for (const d of r.diffs) {
          console.log(`  chunk ${d.chunk} ushort ${d.ushort}: 0x${d.before.toString(16).padStart(4, '0')} → 0x${d.after.toString(16).padStart(4, '0')}`);
        }
      }
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Build the table.
  console.log('\n\n=== Amp Param Offset Table ===');
  console.log('paramId | chunk | ushort | hypothesis (chunk 3, ushort 58+pid)');
  console.log('--------|-------|--------|--------------------------------------');
  for (const r of results) {
    if (r.diffs.length === 0) {
      console.log(`  ${r.paramId.toString().padStart(3)}   | (no diff)`);
      continue;
    }
    // Find the diff most likely to be the param value (typically just 1 native ushort outside the footer hash region)
    // We expect ONE chunk + ONE ushort. Filter out hash-related diffs in chunk header.
    const primary = r.diffs[0];
    const predictedUshort = 58 + r.paramId;
    const matchesPattern = primary.chunk === 3 && primary.ushort === predictedUshort;
    const match = matchesPattern ? '✓' : '?';
    console.log(`  ${r.paramId.toString().padStart(3)}   |  ${primary.chunk.toString().padStart(2)}   |  ${primary.ushort.toString().padStart(2)}   | ${match} predicted ushort ${predictedUshort}`);
  }

  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
