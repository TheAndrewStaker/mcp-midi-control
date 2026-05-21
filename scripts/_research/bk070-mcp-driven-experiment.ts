/**
 * BK-070 — fully MCP-driven per-scene bypass byte extraction.
 *
 * Uses the unified dispatcher (executeSwitchPreset / executeSetBypass /
 * executeSavePreset) to make the experiment 100% automated. No human
 * intervention on the device required.
 *
 * Sequence:
 *   1. Query current preset number from device (fn 0x14).
 *   2. Dump current preset bytes (fn 0x03 with that preset's encoding)
 *      → "before.syx".
 *   3. Use MCP set_bypass to toggle Delay 1's bypass state.
 *   4. Use MCP save_preset to commit working buffer to the SAME slot.
 *   5. Dump the slot again → "after.syx".
 *   6. Diff and print.
 *
 * Side-effect WARNING: this writes to the currently-loaded preset's
 * flash location. The user can restore from a factory bank backup
 * later (we shipped the parser+serializer for that today).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSavePreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeSetBypass } from '@mcp-midi-control/core/protocol-generic/dispatcher/layout.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import {
  CHUNK_PAYLOAD_LEN,
  CHUNKS_PER_PRESET,
  parsePresetDump,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_PATCH_DUMP = 0x03;
const FUNC_GET_PRESET_NUM = 0x14;
const FUNC_HEADER = 0x77;
const FUNC_CHUNK = 0x78;
const FUNC_FOOTER = 0x79;

function fractalChecksum(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

function buildMessage(func: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, func, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}

// Axe-Fx II preset addressing is MSB-FIRST [high, low] per
// fractal-midi/src/axe-fx-ii/setParam.ts:buildSwitchPreset
// (hardware-verified on Q8.02, HW-103). Sending [low, high] LSB-first
// silently fails for any preset >= 128.
function msbFirstPreset(value: number): [number, number] {
  return [(value >> 7) & 0x7f, value & 0x7f];
}

type Conn = ReturnType<typeof connectAxeFxII>;

async function capture(conn: Conn, ms: number, until?: (msgs: number[][]) => boolean): Promise<number[][]> {
  const msgs: number[][] = [];
  const unsub = conn.onMessage((b) => {
    if (b[0] === SYSEX_START) msgs.push([...b]);
  });
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    if (until && until(msgs)) break;
  }
  unsub();
  return msgs;
}

async function getCurrentPresetNumber(conn: Conn): Promise<number> {
  conn.send(buildMessage(FUNC_GET_PRESET_NUM));
  const msgs = await capture(conn, 800);
  const reply = msgs.find((m) => m[5] === FUNC_GET_PRESET_NUM);
  if (!reply) throw new Error('no fn 0x14 response');
  // MSB-first: byte 6 = high, byte 7 = low
  return (reply[6] << 7) | reply[7];
}

async function dumpPreset(conn: Conn, location: number, outPath: string): Promise<void> {
  const [hi, lo] = msbFirstPreset(location);
  conn.send(buildMessage(FUNC_PATCH_DUMP, [hi, lo]));
  const msgs = await capture(conn, 3000, (m) => m.some((x) => x[5] === FUNC_FOOTER));
  const dump = msgs.filter((m) => m[5] === FUNC_HEADER || m[5] === FUNC_CHUNK || m[5] === FUNC_FOOTER);
  const h = dump.filter((m) => m[5] === FUNC_HEADER).length;
  const c = dump.filter((m) => m[5] === FUNC_CHUNK).length;
  const f = dump.filter((m) => m[5] === FUNC_FOOTER).length;
  if (h !== 1 || c !== 64 || f !== 1) {
    throw new Error(`dump location ${location} failed: ${h}/${c}/${f} (expected 1/64/1)`);
  }
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
  console.log(`  dump location ${location} → "${name.trim()}" (saved to ${outPath})`);
}

function diffPresets(beforePath: string, afterPath: string): void {
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
  const fa = flat(before);
  const fb = flat(after);
  const diffs: number[] = [];
  for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) diffs.push(i);
  console.log(`\n=== DIFF ===`);
  console.log(`Total payload bytes: ${fa.length}`);
  console.log(`Bytes differing: ${diffs.length}`);
  if (diffs.length === 0) {
    console.log('  NO CHANGES — save_preset may not have committed, or bypass change was a no-op.');
    return;
  }
  // Coalesce adjacent diffs into runs.
  const runs: { start: number; end: number }[] = [];
  for (const d of diffs) {
    const last = runs[runs.length - 1];
    if (last !== undefined && d <= last.end + 8) last.end = d;
    else runs.push({ start: d, end: d });
  }
  console.log(`Coalesced runs: ${runs.length}`);
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
  for (const r of runs) {
    const len = r.end - r.start + 1;
    const beforeBytes = Array.from(fa.slice(r.start, r.end + 1)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const afterBytes = Array.from(fb.slice(r.start, r.end + 1)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  ${regionOf(r.start)} payload[${r.start}..${r.end}] (${len}B):`);
    console.log(`    before=[${beforeBytes}]`);
    console.log(`    after =[${afterBytes}]`);
  }
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();

  console.log('Step 1: query current preset');
  const currentPreset = await getCurrentPresetNumber(conn);
  console.log(`  device reports preset ${currentPreset}\n`);

  console.log('Step 2: dump current preset');
  const beforePath = `samples/captured/bk070-mcp-exp-${currentPreset}-before.syx`;
  await dumpPreset(conn, currentPreset, beforePath);
  console.log('');

  console.log('Step 3: toggle bypass on delay block via MCP set_bypass');
  // Read current bypass to know which way to toggle, then flip.
  // Simplest: just set to true (bypass on). If already bypassed it stays bypassed.
  try {
    const bypassResult = await executeSetBypass({ port: 'axe-fx-ii', block: 'delay', bypassed: true });
    console.log(`  set_bypass delay → bypassed=true: ${JSON.stringify(bypassResult).slice(0, 200)}`);
  } catch (e) {
    console.error('  set_bypass failed:', e instanceof Error ? e.message : String(e));
  }
  console.log('');

  console.log(`Step 4: save_preset to location ${currentPreset} (commits working buffer to flash)`);
  try {
    const saveResult = await executeSavePreset({ port: 'axe-fx-ii', location: currentPreset });
    console.log(`  save_preset: ${JSON.stringify(saveResult).slice(0, 200)}`);
  } catch (e) {
    console.error('  save_preset failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  console.log('');

  console.log('Step 5: re-dump current preset (now contains the saved bypass change)');
  const afterPath = `samples/captured/bk070-mcp-exp-${currentPreset}-after.syx`;
  await dumpPreset(conn, currentPreset, afterPath);
  console.log('');

  diffPresets(beforePath, afterPath);

  // Don't kill the process; let the executors clean up their handles.
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error('\nEXPERIMENT FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
