/**
 * BK-084 founder bench probe: apply_preset mode:'retune' on the Axe-Fx II
 * XL+ (design §8, ATOMIC-APPLY-WIRING-DESIGN-2026-07-16.md). Interactive,
 * readline-gated at EVERY observation step (no timers gate a human
 * observation, per the CLAUDE.md probe rule); self-restoring (baseline
 * export up front, working-buffer restore at the end); nothing is STOREd
 * except the explicitly-confirmed P4 sacrificial-location leg.
 *
 * PRECONDITIONS (the screech-sensitive shape): XL+ connected; a HIGH-GAIN
 * preset active with delay and/or reverb downstream of the amp; monitoring
 * at a safe volume.
 *
 * Phases:
 *   P0 identity push (graft 6): dump the buffer, push the SAME bytes
 *      unmodified, verify word-exact; the cleanest single-variable test of
 *      the buffered-then-atomic assumption (safety review §2.3).
 *   P1 THE listen test (the single label-flipping item): strum
 *      CONTINUOUSLY; Enter fires a working-buffer retune (amp input_drive
 *      +1.0). HARD-FAILS (graft 9) if the response's apply_path is not
 *      'preset-image' — a silent fallback must never masquerade as an
 *      image-path listen result.
 *   P2 value landing: patched knobs read back from a fresh dump AND typed
 *      from the FRONT PANEL (never AxeEdit; stale-editor rule). Includes
 *      one CPR knob and output.scene_3_main — scene_3..8_main words
 *      (paramIds 10..15) have no single-variable hardware anchor yet (the
 *      2026-07-16 systemTail single-channel decode is corpus-backed), so a
 *      trim at scene 3+ pins the evidence-thinnest word family.
 *   P3 state preservation: active scene, one block's X/Y channel, and
 *      output level typed back unchanged (no-mute invariant on hardware).
 *   P4 STORE leg (optional, explicitly confirmed): save to a founder-chosen
 *      sacrificial location, switch away/back, front-panel persistence.
 *   P5 perceptual A/B: the same multi-knob re-voice once STREAMED
 *      (set_params live path) and once RETUNED (image path),
 *      baseline-restored between; founder types which read as "a preset
 *      switch". Hard-fails on a silent fallback, same as P1.
 *
 * NACK-recovery is NOT hardware-drillable on demand; it stays covered by
 * the fake-conn goldens (scripts/verify-ii-retune-apply.ts case d).
 *
 * Run:  npx tsx scripts/_research/probe-ii-atomic-retune-bench.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import type { DispatchCtx, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { writer } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import { dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import { parsePresetDump } from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  parsePresetImage,
  paramWordIndex,
  type AxeFxIIPresetImage,
} from '@mcp-midi-control/fractal-gen2/presetImageTlv.js';
import { verifyRoundTripIdentity } from '@mcp-midi-control/fractal-gen2/presetImageRoundTrip.js';
import {
  buildGetBlockChannel,
  buildGetSceneNumber,
  findParamFuzzy,
  isGetBlockChannelResponse,
  isSceneNumberResponse,
  parseGetBlockChannelResponse,
  parseSceneNumberResponse,
  resolveBlock,
  type AxeFxIIParam,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

let failures = 0;
function report(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}
function hardFail(msg: string): never {
  console.error(`\nHARD-FAIL (graft 9): ${msg}`);
  console.error('A silent fallback must never masquerade as an image-path listen/timing result.');
  process.exit(1);
}

function imageOf(bytes: Uint8Array): { image: AxeFxIIPresetImage; words: Uint16Array } {
  const rt = verifyRoundTripIdentity(parsePresetDump(bytes));
  if (!rt.ok) throw new Error(`round-trip identity failed on a live dump: ${rt.reason}`);
  return { image: parsePresetImage(rt.words), words: rt.words };
}

/** Decode a placed block's param word to display units from a dump image. */
function readDisplay(img: { image: AxeFxIIPresetImage; words: Uint16Array }, blockName: string, paramName: string): number | string | undefined {
  const block = resolveBlock(blockName);
  if (block === undefined) return undefined;
  const tlv = [...img.image.blocks, ...img.image.systemTail].find((b) => b.wireId === block.id);
  if (tlv === undefined) return undefined;
  const param: AxeFxIIParam | undefined = findParamFuzzy(block, paramName);
  if (param === undefined) return undefined;
  const w = img.words[paramWordIndex(tlv, param.paramId, 'X')];
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  return kind.decodeWire !== undefined ? kind.decodeWire(w) : w;
}

const retune = writer.applyPresetRetune;

async function main(): Promise<void> {
  console.log('── BK-084 bench probe: atomic image retune (Axe-Fx II XL+) ──');
  console.log('Preconditions: HIGH-GAIN preset active, delay/reverb downstream, SAFE volume.');
  if (retune === undefined) { console.error('writer.applyPresetRetune is not registered; build first.'); process.exit(1); }
  const go = await ask('Ready? [Enter=go, q=quit]: ');
  if (go.trim().toLowerCase() === 'q') { rl.close(); return; }

  const conn = connectAxeFxII();
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => conn } as unknown as DispatchCtx;

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
  mkdirSync(path.join('samples', 'captured'), { recursive: true });
  const baselinePath = path.join('samples', 'captured', `bk084-bench-${stamp}.syx`);

  // ── Step 0: baseline export (undo artifact; restored at the end) ──
  console.log('\nStep 0: exporting the working buffer as the baseline/undo artifact...');
  const baseline = await dumpWorkingBufferBytes(ctx);
  writeFileSync(baselinePath, Buffer.from(baseline));
  console.log(`  ${baselinePath} written (${baseline.length} bytes).`);
  const baseImg = imageOf(baseline);

  const restoreBaseline = async (): Promise<void> => {
    const r = await restorePresetBinaryAxeFxII(ctx, baseline);
    if (!r.ok) console.log(`  !! baseline restore NACKed (${r.nacks.length}); switch presets to discard safely.`);
  };

  // ── P0: identity push (graft 6) ──
  console.log('\nP0: identity push — the SAME bytes pushed back unmodified.');
  await ask('  Strum/let ring if you like; press Enter to push: ');
  const p0 = await restorePresetBinaryAxeFxII(ctx, baseline);
  report('P0 identity push acked (no NACK)', p0.ok, `${p0.nacks.length} NACK(s)`);
  const p0Verify = await dumpWorkingBufferBytes(ctx);
  report('P0 read-back byte-identical', p0Verify.length === baseline.length && p0Verify.every((b, i) => b === baseline[i]));
  const p0Heard = await ask('  What did you hear during the push? (a) nothing/seamless (b) dropout/mute — how long? (c) zipper/artifacts/screech (d) other: ');
  console.log(`  P0 listen: ${p0Heard}`);

  // ── P1: THE listen test ──
  console.log('\nP1: the §2.3 listen test — one working-buffer retune (amp input_drive +1.0).');
  const gainBefore = readDisplay(baseImg, 'Amp 1', 'input_drive');
  if (typeof gainBefore !== 'number') {
    console.log('  !! Amp 1 / input_drive not readable in this preset; pick a preset with Amp 1 placed. Skipping P1/P2 amp legs.');
  } else {
    const gainTarget = Math.min(10, gainBefore + 1.0);
    console.log(`  amp input_drive: ${gainBefore.toFixed(2)} → ${gainTarget.toFixed(2)}`);
    await ask('  STRUM CONTINUOUSLY and keep strumming; press Enter to fire the retune: ');
    const spec: PresetSpec = { slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp', params: { input_drive: gainTarget } }] };
    const r1 = await retune(ctx, spec);
    if (r1.apply_path !== 'preset-image') hardFail(`P1 apply_path=${String(r1.apply_path)} (${r1.image_apply_fallback_reason ?? r1.warning ?? 'no reason'})`);
    report('P1 retune ok on the image path', r1.ok === true, JSON.stringify({ receipt: r1.receipt, push_attempts: r1.push_attempts, duration_ms: r1.duration_ms }));
    const p1Heard = await ask('  While strumming, the transition was: (a) seamless like a preset switch (b) dropout/mute — how long? (c) zipper/artifacts/screech (d) other: ');
    console.log(`  P1 listen: ${p1Heard}  (duration_ms=${r1.duration_ms})`);
  }

  // ── P2: value landing (front panel is ground truth) ──
  console.log('\nP2: value landing — one CPR knob + output.scene_3_main (the two evidence-thinnest word families).');
  const p2Patches: { block: string; param: string; value: number }[] = [];
  if (readDisplay(imageOf(await dumpWorkingBufferBytes(ctx)), 'Compressor 1', 'threshold') !== undefined) {
    p2Patches.push({ block: 'Compressor 1', param: 'threshold', value: -25 });
  } else {
    console.log('  (Compressor 1 not placed; CPR leg skipped — place one and re-run P2 later if possible)');
  }
  p2Patches.push({ block: 'Output', param: 'scene_3_main', value: 2.5 });
  {
    const spec: PresetSpec = {
      slots: p2Patches.map((p, i) => ({
        slot: { row: 1, col: i + 1 },
        block_type: p.block,
        params: { [p.param]: p.value },
      })),
    };
    const r2 = await retune(ctx, spec);
    if (r2.apply_path !== 'preset-image') hardFail(`P2 apply_path=${String(r2.apply_path)} (${r2.image_apply_fallback_reason ?? 'no reason'})`);
    report('P2 retune ok (word-exact receipt)', r2.ok === true && r2.receipt === 'word-exact', JSON.stringify(r2.validation_errors ?? r2.warning ?? '').slice(0, 200));
    const post = imageOf(await dumpWorkingBufferBytes(ctx));
    for (const p of p2Patches) {
      const got = readDisplay(post, p.block, p.param);
      report(`P2 dump read-back ${p.block}.${p.param} == ${p.value}`, typeof got === 'number' && Math.abs(got - p.value) < 0.05, `dump says ${String(got)}`);
      const panel = await ask(`  FRONT PANEL reading for ${p.block} ${p.param} (navigate on the device; scene_3_main = Output block, Scene 3 row; type the value): `);
      console.log(`    panel: ${panel} (expected ${p.value})`);
    }
  }

  // ── P3: state preservation (no-mute invariant observed on hardware) ──
  console.log('\nP3: state preservation.');
  {
    const scenePromise = conn.receiveSysExMatching((b) => isSceneNumberResponse(b, 0x07), 1500);
    conn.send(buildGetSceneNumber({ modelId: 0x07 }));
    const sceneWire = parseSceneNumberResponse(await scenePromise, 0x07);
    const panelScene = await ask(`  Active scene on the FRONT PANEL (device reports ${sceneWire + 1}): `);
    report('P3 active scene preserved (device report vs panel)', panelScene.trim() === String(sceneWire + 1), `panel=${panelScene.trim()} device=${sceneWire + 1}`);
    const amp = resolveBlock('Amp 1');
    if (amp !== undefined) {
      try {
        const chPromise = conn.receiveSysExMatching((b) => isGetBlockChannelResponse(b, amp.id, 0x07), 1500);
        conn.send(buildGetBlockChannel(amp.id, { modelId: 0x07 }));
        const ch = parseGetBlockChannelResponse(await chPromise);
        const panelCh = await ask(`  Amp 1 X/Y on the FRONT PANEL (device reports ${ch}): `);
        report('P3 amp channel preserved', panelCh.trim().toUpperCase() === ch, `panel=${panelCh.trim()} device=${ch}`);
      } catch { console.log('  (amp channel read failed; skip)'); }
    }
    const lvl = readDisplay(imageOf(await dumpWorkingBufferBytes(ctx)), 'Output', 'level_1');
    const baseLvl = readDisplay(baseImg, 'Output', 'level_1');
    report('P3 output level UNCHANGED (no -80 dB mute ever touched the image)', String(lvl) === String(baseLvl), `before=${String(baseLvl)} after=${String(lvl)}`);
  }

  // ── P4: STORE leg (optional, explicitly confirmed, sacrificial location) ──
  console.log('\nP4: STORE leg — saves the CURRENT buffer to a sacrificial location (destructive to that location).');
  const loc = (await ask('  Sacrificial preset number to STORE to (Enter = skip P4): ')).trim();
  if (loc.length > 0) {
    const before = await dumpWorkingBufferBytes(ctx);
    const save = await writer.savePreset!(ctx, Number(loc));
    report('P4 STORE acked', save.acked, save.warning ?? '');
    await ask(`  On the device: switch AWAY from ${loc}, then BACK to ${loc}. Press Enter when you are on ${loc}: `);
    const after = await dumpWorkingBufferBytes(ctx);
    report('P4 persisted image round-trips byte-identical', after.length === before.length && after.every((b, i) => b === before[i]));
    const persisted = await ask('  Front panel: do the P2 values (and the retuned gain) show on the recalled preset? [y/n]: ');
    report('P4 front-panel persistence confirmed', persisted.trim().toLowerCase().startsWith('y'));
  } else {
    console.log('  P4 skipped.');
  }

  // ── P5: perceptual A/B — streamed vs retuned, baseline-restored between ──
  console.log('\nP5: perceptual A/B. The same re-voice once STREAMED (live per-param) and once RETUNED (image).');
  {
    // Build up to 12 continuous nudges from blocks actually placed.
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
      // Clamp into the knob's calibrated display range (first bench run:
      // an out-of-range nudge target made the retune preflight refuse the
      // WHOLE spec all-or-nothing — correct server behavior — and the
      // probe hard-failed). Drop nudges the clamp turns into no-ops.
      const blk = resolveBlock(b);
      const prm = blk !== undefined ? findParamFuzzy(blk, p) : undefined;
      if (prm === undefined) continue;
      const kind = resolveParamKind('axe-fx-ii', prm.block, prm.name);
      let target = cur + d;
      if (kind.displayMin !== undefined) target = Math.max(kind.displayMin, target);
      if (kind.displayMax !== undefined) target = Math.min(kind.displayMax, target);
      target = Math.round(target * 100) / 100;
      if (Math.abs(target - cur) < 0.01) continue;
      nudges.push({ block: b, param: p, target });
      if (nudges.length >= 12) break;
    }
    console.log(`  ${nudges.length} knobs in the re-voice: ${nudges.map((n) => `${n.block}.${n.param}`).join(', ')}`);
    if (nudges.length >= 4) {
      await restoreBaseline();
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
      await restoreBaseline();
      await ask('  Pass 2 = RETUNED (atomic image). Strum continuously; Enter to fire: ');
      const spec: PresetSpec = { slots: [] };
      const byBlock = new Map<string, Record<string, number>>();
      for (const n of nudges) {
        const m = byBlock.get(n.block) ?? {};
        m[n.param] = n.target;
        byBlock.set(n.block, m);
      }
      (spec as { slots: unknown[] }).slots = [...byBlock.entries()].map(([b, params], i) => ({ slot: { row: 1, col: i + 1 }, block_type: b, params }));
      const r5 = await retune(ctx, spec);
      if (r5.apply_path !== 'preset-image') hardFail(`P5 apply_path=${String(r5.apply_path)} (${r5.image_apply_fallback_reason ?? 'no reason'})`);
      report('P5 retune ok on the image path', r5.ok === true, `duration_ms=${r5.duration_ms}`);
      const heard2 = await ask('  Pass 2 sounded: (a) seamless (b) stepped/zipper (c) dropout (d) other: ');
      const verdict = await ask('  Which read as "a preset switch"? [1/2/same/neither]: ');
      console.log(`  P5: pass1=${heard1} pass2=${heard2} verdict=${verdict}`);
    } else {
      console.log('  Fewer than 4 nudgeable knobs found; P5 skipped (pick a fuller preset).');
    }
  }

  // ── Restore + wrap ──
  console.log('\nRestoring the baseline working buffer (nothing saved except any explicit P4 STORE)...');
  await restoreBaseline();
  console.log(`\n${failures === 0 ? 'ALL MECHANICAL CHECKS PASSED' : `${failures} mechanical check(s) FAILED`}. Listen answers above are the label-flipping evidence — paste this transcript into the session notes.`);
  rl.close();
  conn.close();
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
