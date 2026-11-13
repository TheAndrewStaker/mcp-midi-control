/**
 * BK-084 bench probe FOLLOW-UP: re-test the two legs the first run left
 * uncertain (founder run 2026-07-17 02:28, P0-P3 + P1 listen all PASSED).
 *
 * Phase L — P4 store-location forensics. The first run STOREd to "666"
 * through the shipped location contract (1-indexed display → wire 665),
 * then the founder dialed 666 on the FRONT PANEL and saw the OLD content.
 * Hypothesis: the II front panel numbers presets 0-based, so wire 665
 * shows as panel "665" and the store landed one below where the founder
 * looked. Test WITHOUT navigation guesswork: slot-addressed fn 0x03 dumps
 * of wire 664/665/666, looking for the retuned signature (Compressor
 * threshold -25, output.scene_3_main +2.5). NOTE the slot-addressed dump
 * RELOADS the working buffer (HW-132), so the current buffer is dumped
 * first and restored after. Then ONE founder observation pins the
 * panel↔wire mapping for good.
 *
 * Phase P5 — perceptual A/B retest. The first run's P5 was refused by the
 * retune preflight (all-or-nothing, zero wire ops — CORRECT server
 * behavior) because a nudge target left a knob's display range; the probe
 * then hard-failed by design. Fixed here: nudges CLAMP to each knob's
 * calibrated display range and no-op nudges are dropped.
 *
 * Working-buffer only; zero STOREs; buffer restored at the end.
 *
 * Run:  npx tsx scripts/_research/probe-ii-bench-p4p5-retest.ts
 */

import readline from 'node:readline';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import type { DispatchCtx, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { writer } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import { collectPatchDump, dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import { parsePresetDump, extractPresetName } from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  parsePresetImage,
  paramWordIndex,
  type AxeFxIIPresetImage,
} from '@mcp-midi-control/fractal-gen2/presetImageTlv.js';
import { verifyRoundTripIdentity } from '@mcp-midi-control/fractal-gen2/presetImageRoundTrip.js';
import {
  buildPatchDumpRequest,
  findParamFuzzy,
  resolveBlock,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

let failures = 0;
function report(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

interface Img { image: AxeFxIIPresetImage; words: Uint16Array }
function imageOf(bytes: Uint8Array): Img {
  const rt = verifyRoundTripIdentity(parsePresetDump(bytes));
  if (!rt.ok) throw new Error(`round-trip identity failed: ${rt.reason}`);
  return { image: parsePresetImage(rt.words), words: rt.words };
}
function readDisplay(img: Img, blockName: string, paramName: string): number | string | undefined {
  const block = resolveBlock(blockName);
  if (block === undefined) return undefined;
  const tlv = [...img.image.blocks, ...img.image.systemTail].find((b) => b.wireId === block.id);
  const param = findParamFuzzy(block, paramName);
  if (tlv === undefined || param === undefined) return undefined;
  const w = img.words[paramWordIndex(tlv, param.paramId, 'X')];
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  return kind.decodeWire !== undefined ? kind.decodeWire(w) : w;
}

async function dumpStoredSlot(ctx: DispatchCtx, wire: number): Promise<Uint8Array> {
  const framesPromise = collectPatchDump(ctx);
  ctx.conn.send(buildPatchDumpRequest(wire, { modelId: 0x07 }));
  const frames = await framesPromise;
  const flat: number[] = [];
  for (const f of frames) for (const b of f) flat.push(b);
  return Uint8Array.from(flat);
}

const retune = writer.applyPresetRetune!;

async function main(): Promise<void> {
  console.log('── BK-084 bench follow-up: P4 store-location forensics + P5 A/B retest ──');
  const go = await ask('II connected, safe volume. Ready? [Enter=go, q=quit]: ');
  if (go.trim().toLowerCase() === 'q') { rl.close(); return; }

  const conn = connectAxeFxII();
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => conn } as unknown as DispatchCtx;

  // Safety baseline of whatever is in the buffer right now (the stored-slot
  // reads below RELOAD the buffer; we restore this at the end of Phase L).
  const safety = await dumpWorkingBufferBytes(ctx);
  const safetyName = extractPresetName(parsePresetDump(safety));
  console.log(`current buffer: "${safetyName}" (saved as the in-memory safety baseline)`);

  // ── Phase L: where did the "666" store land? ──
  console.log('\nPhase L: reading stored slots wire 664 / 665 / 666 (each read reloads the buffer; restored after).');
  console.log('Looking for the retuned signature: Compressor threshold=-25, Output scene_3_main=+2.5.');
  const found: { wire: number; name: string; thr: string; s3: string; match: boolean }[] = [];
  for (const wire of [664, 665, 666]) {
    try {
      const bytes = await dumpStoredSlot(ctx, wire);
      const img = imageOf(bytes);
      const name = extractPresetName(parsePresetDump(bytes));
      const thr = readDisplay(img, 'Compressor 1', 'threshold');
      const s3 = readDisplay(img, 'Output', 'scene_3_main');
      const match = typeof thr === 'number' && Math.abs(thr - -25) < 0.05
        && typeof s3 === 'number' && Math.abs(s3 - 2.5) < 0.05;
      found.push({ wire, name, thr: String(thr), s3: String(s3), match });
      console.log(`  wire ${wire}: "${name}"  threshold=${String(thr)}  scene_3_main=${String(s3)}${match ? '   <-- RETUNED SIGNATURE' : ''}`);
    } catch (err) {
      console.log(`  wire ${wire}: read failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const hit = found.find((f) => f.match);
  report('L: the P4 store landed at exactly one of the read slots', hit !== undefined, JSON.stringify(found));
  if (hit !== undefined) {
    report('L: store landed at WIRE 665 (the shipped 1-indexed-display contract: "666" -> wire 665)', hit.wire === 665, `landed at wire ${hit.wire}`);
    const panel = await ask(`  On the FRONT PANEL, dial until you see "${hit.name}" with the -25 threshold (it should be right around ${hit.wire}). What preset NUMBER does the PANEL show for it? `);
    const panelNum = Number(panel.trim().replace(/\D+/g, ''));
    console.log(`  panel says ${panelNum} for wire ${hit.wire} -> the device panel is ${panelNum === hit.wire ? '0-BASED (panel == wire): our "display slot" convention is OFF BY ONE vs the device UI' : panelNum === hit.wire + 1 ? '1-BASED (panel == wire+1): the shipped convention matches the device UI' : `UNEXPECTED (panel=${panelNum}, wire=${hit.wire})`}`);
    report('L: panel↔wire mapping pinned', Number.isFinite(panelNum) && (panelNum === hit.wire || panelNum === hit.wire + 1), `panel=${panel.trim()}`);
  }
  console.log('  restoring your working buffer...');
  const rest1 = await restorePresetBinaryAxeFxII(ctx, safety);
  report('L: buffer restored after stored-slot reads', rest1.ok, `${rest1.nacks.length} NACK(s)`);

  // ── Phase P5 retest: clamped nudges ──
  console.log('\nPhase P5 retest: same A/B, nudges now CLAMPED to each knob\'s calibrated display range.');
  const CANDIDATES: [string, string, number][] = [
    ['Amp 1', 'input_drive', 0.7], ['Amp 1', 'bass', 0.8], ['Amp 1', 'mid', -0.6], ['Amp 1', 'treble', -0.5],
    ['Amp 1', 'master_volume', 0.5], ['Amp 1', 'level', -0.5], ['Cab 1', 'level', -1.0], ['Cab 1', 'low_cut', 20],
    ['Delay 1', 'mix', 4], ['Reverb 1', 'mix', 3], ['Drive 1', 'drive', 0.8], ['Compressor 1', 'threshold', -4],
  ];
  const img = imageOf(await dumpWorkingBufferBytes(ctx));
  const nudges: { block: string; param: string; target: number }[] = [];
  for (const [b, p, d] of CANDIDATES) {
    const cur = readDisplay(img, b, p);
    if (typeof cur !== 'number') continue;
    const block = resolveBlock(b)!;
    const param = findParamFuzzy(block, p)!;
    const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
    let target = cur + d;
    if (kind.displayMin !== undefined) target = Math.max(kind.displayMin, target);
    if (kind.displayMax !== undefined) target = Math.min(kind.displayMax, target);
    target = Math.round(target * 100) / 100;
    if (Math.abs(target - cur) < 0.01) continue; // clamped into a no-op: drop
    nudges.push({ block: b, param: p, target });
    if (nudges.length >= 12) break;
  }
  console.log(`  ${nudges.length} knobs in the re-voice: ${nudges.map((n) => `${n.block}.${n.param}->${n.target}`).join(', ')}`);
  if (nudges.length < 4) {
    console.log('  fewer than 4 nudgeable knobs; pick a fuller preset and re-run.');
  } else {
    const baseline = await dumpWorkingBufferBytes(ctx);
    await ask('  Pass 1 = STREAMED. Strum continuously; Enter to fire: ');
    const t1 = Date.now();
    await writer.setParams!(ctx, nudges.map((n) => {
      const block = resolveBlock(n.block)!;
      const param = findParamFuzzy(block, n.param)!;
      const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
      return { block: n.block, name: n.param, value: Math.round(kind.encodeDisplay!(n.target)) };
    }));
    console.log(`  streamed in ${Date.now() - t1} ms`);
    const heard1 = await ask('  Pass 1 sounded: (a) seamless (b) stepped/zipper (c) dropout (d) other: ');
    await restorePresetBinaryAxeFxII(ctx, baseline);
    await ask('  Pass 2 = RETUNED (atomic image). Strum continuously; Enter to fire: ');
    const byBlock = new Map<string, Record<string, number>>();
    for (const n of nudges) {
      const m = byBlock.get(n.block) ?? {};
      m[n.param] = n.target;
      byBlock.set(n.block, m);
    }
    const spec: PresetSpec = {
      slots: [...byBlock.entries()].map(([b, params], i) => ({ slot: { row: 1, col: i + 1 }, block_type: b, params })),
    };
    const r5 = await retune(ctx, spec);
    if (r5.apply_path !== 'preset-image') {
      console.error(`\nHARD-FAIL (graft 9): P5 apply_path=${String(r5.apply_path)}`);
      console.error(JSON.stringify(r5.validation_errors ?? r5.failed_step ?? r5.warning, null, 1));
      await restorePresetBinaryAxeFxII(ctx, baseline);
      process.exit(1);
    }
    report('P5 retune ok on the image path', r5.ok === true, `duration_ms=${r5.duration_ms} params=${r5.params_patched}`);
    const heard2 = await ask('  Pass 2 sounded: (a) seamless (b) stepped/zipper (c) dropout (d) other: ');
    const verdict = await ask('  Which read as "a preset switch"? [1/2/same/neither]: ');
    console.log(`  P5: pass1=${heard1.trim()} pass2=${heard2.trim()} verdict=${verdict.trim()}`);
    await restorePresetBinaryAxeFxII(ctx, baseline);
    console.log('  buffer restored.');
  }

  console.log(`\n${failures === 0 ? 'ALL MECHANICAL CHECKS PASSED' : `${failures} check(s) FAILED`}. Paste this transcript back.`);
  rl.close();
  conn.close();
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
