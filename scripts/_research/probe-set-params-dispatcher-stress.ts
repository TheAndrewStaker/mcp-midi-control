/**
 * BK-084 mode-collapse exhaustive dispatcher-level hardware stress test
 * (Axe-Fx II XL+), non-interactive. Successor to
 * `probe-ii-retune-dispatcher-stress.ts` (43/43 PASS, 2026-07-17), adapted
 * for the mode-collapse rather than re-run verbatim: that script drove
 * `executeApplyPreset({mode:'retune', ...})`, a shape that no longer
 * exists. Its actual SEMANTICS ("patch ONLY the listed params onto blocks
 * already in the preset, preserving everything else, atomic when the
 * batch is large") now live in `executeSetParams` (flat `ops[]`), NOT
 * `executeApplyPreset` (which requires describing the COMPLETE chain —
 * listing only 9 of 12 placed blocks would CLEAR the other 3, the exact
 * opposite of what retune's callers relied on). This script re-derives
 * the same phases against the correct new entry point.
 *
 * Dropped relative to the original (no longer apply):
 *   - Phase I (target-location navigation) and Phase J (STORE leg):
 *     set_params has no target_location and never saves. Nothing to
 *     adapt; these capabilities simply don't exist on this entry point.
 *   - Phase H's scenes[]/routing[]/bypassed structural refusal cases:
 *     set_params' schema has no fields to express any of the three, so
 *     there is nothing for a runtime check to refuse — the TYPE SYSTEM
 *     is the refusal now, not a hardware-observable behavior.
 *
 * Kept, adapted to executeSetParams' flat ops[] shape: the big multi-
 * block/multi-param batch (now large enough to force the REAL atomic
 * path, no synthetic threshold override), boundary MIN/MAX values, 8
 * back-to-back calls (degradation/drift check), dual-channel (X+Y) in
 * one call, enum channel-mismatch refusal (unchanged mechanism,
 * inherited from writer.setParam), and a block-not-placed refusal (was
 * part of Phase H, now its own phase since set_params handles it
 * per-entry rather than as a whole-batch structural gate).
 *
 * Location 666 is explicitly authorized as disposable for this run (the
 * founder's own words: "666 is safe to test with and destroy") — unlike
 * the original script, which had to preserve a real "Boston Tone" preset
 * byte-exact, this one BUILDS its own known test preset there via
 * apply_preset, runs the set_params stress phases against it, and does
 * NOT attempt flash-persistence restoration (nothing here ever saves —
 * set_params is working-buffer only). Working-buffer restore to the
 * pre-run state still happens for hygiene, but a mismatch there is not
 * treated as unsafe, only noted.
 *
 * Run:  npx tsx scripts/_research/probe-set-params-dispatcher-stress.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { ensureConnection } from '@mcp-midi-control/core/server-shared/connections.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import { executeSetParams } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import { parsePresetDump, extractPresetName } from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  parsePresetImage,
  paramWordIndex,
  type AxeFxIIPresetImage,
} from '@mcp-midi-control/fractal-gen2/presetImageTlv.js';
import { verifyRoundTripIdentity } from '@mcp-midi-control/fractal-gen2/presetImageRoundTrip.js';
import {
  buildGetGridLayout,
  buildSwitchPreset,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  findParamFuzzy,
  resolveBlock,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

const PORT = 'axe-fx-ii';
const TARGET_LOCATION = 666;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface Img { image: AxeFxIIPresetImage; words: Uint16Array }
function imageOf(bytes: Uint8Array): Img {
  const rt = verifyRoundTripIdentity(parsePresetDump(bytes));
  if (!rt.ok) throw new Error(`round-trip identity failed on a live dump: ${rt.reason}`);
  return { image: parsePresetImage(rt.words), words: rt.words };
}
function wordOf(img: Img, blockName: string, paramName: string, channel: 'X' | 'Y' = 'X'): number | undefined {
  const block = resolveBlock(blockName);
  if (block === undefined) return undefined;
  const tlv = [...img.image.blocks, ...img.image.systemTail].find((b) => b.wireId === block.id);
  const param = findParamFuzzy(block, paramName);
  if (tlv === undefined || param === undefined) return undefined;
  try {
    return img.words[paramWordIndex(tlv, param.paramId, channel)];
  } catch {
    return undefined;
  }
}
function readDisplay(img: Img, blockName: string, paramName: string, channel: 'X' | 'Y' = 'X'): number | string | undefined {
  const w = wordOf(img, blockName, paramName, channel);
  if (w === undefined) return undefined;
  const block = resolveBlock(blockName)!;
  const param = findParamFuzzy(block, paramName)!;
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  return kind.decodeWire !== undefined ? kind.decodeWire(w) : w;
}
function close(a: number | string | undefined, b: number, tol = 0.06): boolean {
  return typeof a === 'number' && Math.abs(a - b) < tol;
}

async function main(): Promise<void> {
  console.log('── BK-084 mode-collapse: exhaustive set_params dispatcher-level hardware stress test (Axe-Fx II XL+) ──');
  const conn = ensureConnection('axe-fx-ii');
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => ensureConnection('axe-fx-ii', true) } as unknown as DispatchCtx;

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
  const outDir = path.join('samples', 'captured', `bk084-set-params-dispatcher-stress-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  console.log(`\nPhase A: navigate to location ${TARGET_LOCATION} (founder-authorized disposable test slot)...`);
  conn.send(buildSwitchPreset(TARGET_LOCATION - 1, { modelId: 0x07 })); // wire is 0-indexed
  await new Promise((r) => setTimeout(r, 250));
  const preNameCheck = extractPresetName(parsePresetDump(await dumpWorkingBufferBytes(ctx)));
  console.log(`  now on location ${TARGET_LOCATION}, currently named "${preNameCheck}"`);

  console.log('\nPhase A2: build a known dense 9-block test preset there via apply_preset (working buffer only, not saved)...');
  const buildResult = await executeApplyPreset({
    port: PORT,
    spec: {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', params: { input_drive: 5, bass: 5, middle: 5, treble: 5, master_volume: 5, presence: 5, level: 0 } },
        { slot: { row: 2, col: 2 }, block_type: 'cab', instance: 2, params: { level: 0, room_level: 8, low_cut: 80, high_cut: 6500 } },
        { slot: { row: 2, col: 3 }, block_type: 'compressor', params: { threshold: -20, ratio: 3, attack: 2, release: 20, level: 0, mix: 100 } },
        { slot: { row: 2, col: 4 }, block_type: 'chorus', params: { rate: 1, mix: 30, level: 0 } },
        { slot: { row: 2, col: 5 }, block_type: 'delay', params: { feedback: 20, mix: 15, level: 0 } },
        { slot: { row: 2, col: 6 }, block_type: 'reverb', params: { mix: 25, size: 50, level: 0, time: 2.5 } },
        { slot: { row: 2, col: 7 }, block_type: 'filter', params: { gain: 0, q: 1 } },
        { slot: { row: 2, col: 8 }, block_type: 'gateexpander', params: { threshold: -40, release: 5, ratio: 4, mix: 0 } },
      ],
    },
  });
  check('A2: test preset built ok', buildResult.ok === true, JSON.stringify(buildResult).slice(0, 300));

  const baseline = await dumpWorkingBufferBytes(ctx);
  writeFileSync(path.join(outDir, 'baseline.syx'), Buffer.from(baseline));
  const baseImg = imageOf(baseline);
  console.log(`  baseline dumped (${baseline.length} B) -> ${outDir}`);

  const gridPromise = conn.receiveSysExMatching((b: number[]) => isGetGridLayoutResponse(b, 0x07), 1500);
  conn.send(buildGetGridLayout({ modelId: 0x07 }));
  const cells = parseGetGridLayoutResponse(await gridPromise, 0x07);
  const placedIds = new Set(cells.map((c) => c.blockId).filter((id) => id !== 0 && id < 200));
  console.log(`  placed blocks: ${placedIds.size}`);

  try {
    // ── Phase B: BIG multi-block batch through executeSetParams (8 blocks, 32 params) ──
    console.log('\nPhase B: BIG multi-block set_params batch (8 block families, 32 params, atomic path forced by size)...');
    {
      const ops = [
        { block: 'amp', name: 'input_drive', value: 8.3 }, { block: 'amp', name: 'bass', value: 7.4 },
        { block: 'amp', name: 'middle', value: 6.6 }, { block: 'amp', name: 'treble', value: 7.3 },
        { block: 'amp', name: 'master_volume', value: 6.8 }, { block: 'amp', name: 'presence', value: 7.2 },
        { block: 'amp', name: 'level', value: -7.0 },
        { block: 'cab', instance: 2, name: 'level', value: -2.0 }, { block: 'cab', instance: 2, name: 'room_level', value: 12 },
        { block: 'cab', instance: 2, name: 'low_cut', value: 35 }, { block: 'cab', instance: 2, name: 'high_cut', value: 16000 },
        { block: 'compressor', name: 'threshold', value: -22 }, { block: 'compressor', name: 'ratio', value: 2.5 },
        { block: 'compressor', name: 'attack', value: 1.5 }, { block: 'compressor', name: 'release', value: 25 },
        { block: 'compressor', name: 'level', value: 1.0 }, { block: 'compressor', name: 'mix', value: 95 },
        { block: 'chorus', name: 'rate', value: 1.3 }, { block: 'chorus', name: 'mix', value: 45 }, { block: 'chorus', name: 'level', value: -1 },
        { block: 'delay', name: 'feedback', value: 24 }, { block: 'delay', name: 'mix', value: 13 }, { block: 'delay', name: 'level', value: -1 },
        { block: 'reverb', name: 'mix', value: 20 }, { block: 'reverb', name: 'size', value: 65 }, { block: 'reverb', name: 'level', value: -1 }, { block: 'reverb', name: 'time', value: 3.5 },
        { block: 'filter', name: 'gain', value: 18 }, { block: 'filter', name: 'q', value: 4.0 },
        { block: 'gateexpander', name: 'threshold', value: -50 }, { block: 'gateexpander', name: 'release', value: 3 }, { block: 'gateexpander', name: 'ratio', value: 5.0 },
      ];
      check(`B: batch constructed with ${ops.length} params across 8 blocks`, ops.length >= 30, String(ops.length));

      const t0 = Date.now();
      const r = await executeSetParams({ port: PORT, ops });
      const elapsed = Date.now() - t0;
      const applyPath = (r as { apply_path?: string }).apply_path;
      const receipt = (r as { receipt?: string }).receipt;
      const pushAttempts = (r as { push_attempts?: number }).push_attempts;
      check('B: acked_count === ops.length', r.acked_count === ops.length, `acked=${r.acked_count} unacked=${r.unacked_count}`);
      check("B: apply_path='preset-image' (batch large enough to force the atomic path)", applyPath === 'preset-image', String(applyPath));
      check("B: receipt='word-exact'", receipt === 'word-exact', String(receipt));
      check('B: push_attempts===1 (single clean push, no recovery)', pushAttempts === 1, String(pushAttempts));
      console.log(`  wall time: ${elapsed} ms`);

      const post = imageOf(await dumpWorkingBufferBytes(ctx));
      const expected: [string, string, number][] = [
        ['Amp 1', 'input_drive', 8.3], ['Amp 1', 'bass', 7.4], ['Amp 1', 'middle', 6.6], ['Amp 1', 'treble', 7.3],
        ['Amp 1', 'master_volume', 6.8], ['Amp 1', 'presence', 7.2], ['Amp 1', 'level', -7.0],
        ['Compressor 1', 'threshold', -22], ['Compressor 1', 'ratio', 2.5], ['Compressor 1', 'attack', 1.5],
        ['Compressor 1', 'release', 25], ['Compressor 1', 'level', 1.0], ['Compressor 1', 'mix', 95],
        ['Chorus 1', 'rate', 1.3], ['Chorus 1', 'mix', 45], ['Chorus 1', 'level', -1],
        ['Delay 1', 'feedback', 24], ['Delay 1', 'mix', 13], ['Delay 1', 'level', -1],
        ['Reverb 1', 'mix', 20], ['Reverb 1', 'size', 65], ['Reverb 1', 'level', -1], ['Reverb 1', 'time', 3.5],
        ['Filter 1', 'gain', 18], ['Filter 1', 'q', 4.0],
        ['Gate Expander', 'threshold', -50], ['Gate Expander', 'release', 3], ['Gate Expander', 'ratio', 5.0],
      ];
      let matched = 0;
      const misses: string[] = [];
      for (const [b, p, v] of expected) {
        const got = readDisplay(post, b, p);
        if (close(got, v)) matched++;
        else misses.push(`${b}.${p}: expected ${v}, image says ${String(got)}`);
      }
      check(`B: image read-back ${matched}/${expected.length} continuous params landed exactly`, matched === expected.length, misses.slice(0, 5).join(' | '));

      // Untouched-preservation spot check: filter block's params NOT
      // listed in this batch (e.g. a hypothetical unlisted knob) --
      // simplest available check here is that gateexpander.mix (never
      // listed) stayed at its Phase A2 build value.
      const mixAfter = readDisplay(post, 'Gate Expander', 'mix');
      const mixBefore = readDisplay(baseImg, 'Gate Expander', 'mix');
      check('B: unlisted param on a TOUCHED block preserved (gateexpander.mix untouched by this batch)', String(mixAfter) === String(mixBefore), `before=${String(mixBefore)} after=${String(mixAfter)}`);
    }

    // ── Phase C/D: boundary MIN / MAX batch ──
    console.log('\nPhase C: boundary MIN batch...');
    {
      const ops = [
        { block: 'amp', name: 'bass', value: 0 }, { block: 'amp', name: 'treble', value: 0 }, { block: 'amp', name: 'presence', value: 0 },
        { block: 'amp', name: 'master_volume', value: 0 }, { block: 'amp', name: 'level', value: -80 },
        { block: 'cab', instance: 2, name: 'low_cut', value: 20 }, { block: 'cab', instance: 2, name: 'high_cut', value: 200 },
        { block: 'compressor', name: 'threshold', value: -80 }, { block: 'compressor', name: 'ratio', value: 1 },
        { block: 'delay', name: 'feedback', value: -100 }, { block: 'reverb', name: 'size', value: 0 },
        { block: 'filter', name: 'gain', value: -20 }, { block: 'gateexpander', name: 'threshold', value: -80 },
      ];
      const r = await executeSetParams({ port: PORT, ops });
      const applyPath = (r as { apply_path?: string }).apply_path;
      const receipt = (r as { receipt?: string }).receipt;
      check('C: MIN boundary batch acked, image path, word-exact', r.acked_count === ops.length && applyPath === 'preset-image' && receipt === 'word-exact', `acked=${r.acked_count} path=${applyPath} receipt=${receipt}`);
      const post = imageOf(await dumpWorkingBufferBytes(ctx));
      const checks: [string, string, number][] = [
        ['Amp 1', 'bass', 0], ['Amp 1', 'treble', 0], ['Amp 1', 'presence', 0], ['Amp 1', 'master_volume', 0], ['Amp 1', 'level', -80],
        ['Cab 2', 'low_cut', 20], ['Cab 2', 'high_cut', 200],
        ['Compressor 1', 'threshold', -80], ['Compressor 1', 'ratio', 1],
        ['Delay 1', 'feedback', -100], ['Reverb 1', 'size', 0], ['Filter 1', 'gain', -20], ['Gate Expander', 'threshold', -80],
      ];
      let matched = 0;
      const misses: string[] = [];
      for (const [b, p, v] of checks) {
        const got = readDisplay(post, b, p);
        if (close(got, v, 0.5)) matched++;
        else misses.push(`${b}.${p}: expected ${v}, got ${String(got)}`);
      }
      check(`C: MIN boundary values landed ${matched}/${checks.length}`, matched === checks.length, misses.join(' | '));
    }

    console.log('\nPhase D: boundary MAX batch...');
    {
      const ops = [
        { block: 'amp', name: 'bass', value: 10 }, { block: 'amp', name: 'treble', value: 10 }, { block: 'amp', name: 'presence', value: 10 },
        { block: 'amp', name: 'master_volume', value: 10 }, { block: 'amp', name: 'level', value: 20 },
        { block: 'cab', instance: 2, name: 'low_cut', value: 2000 }, { block: 'cab', instance: 2, name: 'high_cut', value: 20000 },
        { block: 'compressor', name: 'threshold', value: 0 }, { block: 'compressor', name: 'ratio', value: 20 },
        { block: 'delay', name: 'feedback', value: 100 }, { block: 'reverb', name: 'size', value: 100 },
        { block: 'filter', name: 'gain', value: 20 }, { block: 'gateexpander', name: 'threshold', value: 20 },
      ];
      const r = await executeSetParams({ port: PORT, ops });
      const applyPath = (r as { apply_path?: string }).apply_path;
      const receipt = (r as { receipt?: string }).receipt;
      check('D: MAX boundary batch acked, image path, word-exact', r.acked_count === ops.length && applyPath === 'preset-image' && receipt === 'word-exact', `acked=${r.acked_count} path=${applyPath} receipt=${receipt}`);
      const post = imageOf(await dumpWorkingBufferBytes(ctx));
      const checks: [string, string, number][] = [
        ['Amp 1', 'bass', 10], ['Amp 1', 'treble', 10], ['Amp 1', 'presence', 10], ['Amp 1', 'master_volume', 10], ['Amp 1', 'level', 20],
        ['Cab 2', 'low_cut', 2000], ['Cab 2', 'high_cut', 20000],
        ['Compressor 1', 'threshold', 0], ['Compressor 1', 'ratio', 20],
        ['Delay 1', 'feedback', 100], ['Reverb 1', 'size', 100], ['Filter 1', 'gain', 20], ['Gate Expander', 'threshold', 20],
      ];
      let matched = 0;
      const misses: string[] = [];
      for (const [b, p, v] of checks) {
        const got = readDisplay(post, b, p);
        if (close(got, v, 1.0)) matched++;
        else misses.push(`${b}.${p}: expected ${v}, got ${String(got)}`);
      }
      check(`D: MAX boundary values landed ${matched}/${checks.length}`, matched === checks.length, misses.join(' | '));
    }

    // ── Phase E: repeated back-to-back small calls (degradation check, individual path) ──
    console.log('\nPhase E: 8 back-to-back set_params calls on amp.presence (below threshold, individual path, degradation/drift check)...');
    {
      const originalPresence = readDisplay(imageOf(await dumpWorkingBufferBytes(ctx)), 'Amp 1', 'presence');
      const sequence = [3.0, 7.0, 2.5, 8.5, 1.0, 9.5, 4.0, typeof originalPresence === 'number' ? originalPresence : 7];
      const durations: number[] = [];
      let allLanded = true;
      for (let i = 0; i < sequence.length; i++) {
        const target = Math.round(sequence[i] * 100) / 100;
        const t0 = Date.now();
        const r = await executeSetParams({ port: PORT, ops: [{ block: 'amp', name: 'presence', value: target }] });
        const dt = Date.now() - t0;
        durations.push(dt);
        const post = imageOf(await dumpWorkingBufferBytes(ctx));
        const got = readDisplay(post, 'Amp 1', 'presence');
        const landed = r.acked_count === 1 && close(got, target);
        console.log(`  call ${i + 1}/${sequence.length}: target=${target} landed=${String(got)} acked=${r.acked_count} dt=${dt}ms`);
        if (!landed) allLanded = false;
      }
      check('E: all 8 single-knob calls landed', allLanded);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const maxDt = Math.max(...durations);
      const minDt = Math.min(...durations);
      check(`E: no gross timing degradation (min=${minDt}ms avg=${avg.toFixed(0)}ms max=${maxDt}ms, all individual-path, expect near-instant)`, maxDt < 500, `spread=${maxDt - minDt}ms`);
    }

    // ── Phase F: dual-channel (X + Y) single-call batch ──
    console.log('\nPhase F: dual-channel (X+Y) set_params in ONE call on Amp 1...');
    {
      const before = imageOf(await dumpWorkingBufferBytes(ctx));
      const yBassBefore = readDisplay(before, 'Amp 1', 'bass', 'Y');
      const r = await executeSetParams({
        port: PORT,
        ops: [
          { block: 'amp', name: 'bass', value: 6.0, channel: 'X' },
          { block: 'amp', name: 'bass', value: 9.0, channel: 'Y' },
        ],
      });
      check('F: dual-channel batch acked (2/2)', r.acked_count === 2, `acked=${r.acked_count} unacked=${r.unacked_count}`);
      const post = imageOf(await dumpWorkingBufferBytes(ctx));
      const xGot = readDisplay(post, 'Amp 1', 'bass', 'X');
      const yGot = readDisplay(post, 'Amp 1', 'bass', 'Y');
      check('F: X channel landed at 6.0', close(xGot, 6.0), String(xGot));
      check('F: Y channel landed at 9.0 (inactive channel, written independently)', close(yGot, 9.0), String(yGot));
      check('F: Y channel actually CHANGED from its pre-call value (not a no-op)', String(yGot) !== String(yBassBefore), `before=${String(yBassBefore)} after=${String(yGot)}`);
    }

    // ── Phase G: enum channel-mismatch refusal (hardware, unchanged mechanism) ──
    console.log('\nPhase G: enum channel-mismatch refusal (compressor.knee on Y while active channel is X)...');
    {
      const before = await dumpWorkingBufferBytes(ctx);
      const r = await executeSetParams({ port: PORT, ops: [{ block: 'compressor', name: 'knee', value: 'SOFTER', channel: 'Y' }] });
      check('G: refused (unacked_count===1, acked_count===0)', r.acked_count === 0 && r.unacked_count === 1, `acked=${r.acked_count} unacked=${r.unacked_count}`);
      const refusalMsg = r.writes[0]?.warning ?? '';
      check('G: refusal names the channel mismatch', /channel/i.test(refusalMsg), refusalMsg.slice(0, 200));
      const after = await dumpWorkingBufferBytes(ctx);
      check('G: zero wire-state-change (buffer byte-identical before/after the refusal)', bytesEqual(before, after));
    }

    // ── Phase H: block-not-placed refusal (per-entry, not a whole-batch gate) ──
    console.log('\nPhase H: block-not-placed refusal (pitch block, absent from this preset)...');
    {
      const before = await dumpWorkingBufferBytes(ctx);
      const r = await executeSetParams({
        port: PORT,
        ops: [
          { block: 'amp', name: 'bass', value: 6.5 }, // placed, should still land
          { block: 'pitch', name: 'mix', value: 50 }, // NOT placed in this preset
        ],
      });
      check('H: the placed amp write lands (acked_count===1)', r.acked_count === 1, `acked=${r.acked_count} unacked=${r.unacked_count}`);
      check('H: the unplaced pitch write refuses (unacked_count===1), NOT a whole-batch gate', r.unacked_count === 1, `unacked=${r.unacked_count}`);
      const post = imageOf(await dumpWorkingBufferBytes(ctx));
      const gotBass = readDisplay(post, 'Amp 1', 'bass');
      check('H: amp.bass actually landed at 6.5 despite the sibling refusal', close(gotBass, 6.5), String(gotBass));
      void before;
    }

    // ── Phase L: fn 0x1F byte-identity re-confirmation ──
    console.log('\nPhase L: fn 0x1F byte-identity re-confirmation (corpus data point)...');
    {
      const { buildGetAllParams, BLOCK_BY_ID } = await import('fractal-midi/gen2/axe-fx-ii');
      const finalBytes = await dumpWorkingBufferBytes(ctx);
      const finalImg = imageOf(finalBytes);
      const targets = new Set<number>([...placedIds]);
      for (const b of finalImg.image.systemTail) targets.add(b.wireId);
      let compared = 0;
      let identical = 0;
      const misses: string[] = [];
      const d14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
      const d16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
      for (const id of targets) {
        const tlv = [...finalImg.image.blocks, ...finalImg.image.systemTail].find((b) => b.wireId === id);
        if (tlv === undefined) continue;
        const payload = Array.from(finalImg.words.slice(tlv.baseWord, tlv.baseWord + tlv.payloadLen));
        const frames: number[][] = [];
        const unsub = conn.onMessage((b: number[]) => {
          if (b[0] === 0xf0 && b[4] === 0x07 && (b[5] === 0x74 || b[5] === 0x75 || b[5] === 0x76)) frames.push([...b]);
        });
        conn.send(buildGetAllParams(id, { modelId: 0x07 }));
        await new Promise((r) => setTimeout(r, 1200));
        unsub();
        let values: number[] = [];
        for (const f of frames) {
          if (f[5] === 0x75) {
            const n = d14(f[6], f[7]);
            for (let i = 0; i < n; i++) {
              const off = 8 + i * 3;
              if (off + 2 >= f.length - 2) break;
              values.push(d16(f[off], f[off + 1], f[off + 2]));
            }
          }
        }
        if (values.length === 0) { misses.push(`${id}: no reply`); continue; }
        compared++;
        const same = values.length === payload.length && payload.every((v, i) => v === values[i]);
        if (same) identical++;
        else if (misses.length < 6) misses.push(`${id} (${BLOCK_BY_ID[id]?.name ?? '?'}): len ${values.length} vs ${payload.length}`);
      }
      check(`L: fn 0x1F byte-identity: ${identical}/${compared} blocks`, compared > 0 && identical === compared, misses.join('; '));
    }
  } finally {
    console.log('\nPhase K: restoring the pre-stress-test working buffer (hygiene only; location 666 is disposable, nothing was ever saved)...');
    const pushBack = await restorePresetBinaryAxeFxII(ctx, baseline).catch((err) => ({ ok: false, nacks: [{ detail: String(err) }] }));
    check('K: baseline push accepted (0 NACKs)', pushBack.ok, 'nacks' in pushBack ? `${pushBack.nacks.length} NACK(s)` : '');
    const afterPush = await dumpWorkingBufferBytes(ctx).catch(() => undefined);
    if (afterPush !== undefined) {
      check('K: working buffer byte-identical to the Phase A2 baseline after restore', bytesEqual(afterPush, baseline));
    }
  }

  console.log(`\n${pass} PASS, ${fail} FAIL. Artifacts: ${outDir}`);
  console.log(`Nothing was ever saved to flash this run (set_params has no STORE leg); location ${TARGET_LOCATION}'s stored content, if any, is untouched.`);
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
