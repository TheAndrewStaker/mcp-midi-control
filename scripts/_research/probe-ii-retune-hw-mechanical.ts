/**
 * BK-084 MECHANICAL hardware verification (Axe-Fx II XL+), non-interactive.
 *
 * Runs every self-validating leg of the retune + fn 0x1F evidence chain
 * that needs NO human observation (the audible P1/P5 listen tests stay in
 * probe-ii-atomic-retune-bench.ts, readline-gated). Working-buffer only:
 * baseline dumped first, restored last, verified byte-identical; NOTHING
 * is ever STOREd; no preset navigation.
 *
 *  Phase A  read-only: baseline dump (saved to samples/captured/), grid read.
 *  Phase B  P0-mechanical identity push: push the SAME bytes back, re-dump,
 *           assert byte-identical (buffered push acceptance on hardware).
 *  Phase C  live fn 0x1F byte-identity: for every PLACED content block +
 *           the system tail, read fn 0x1F and compare against the baseline
 *           image TLV payload (read-only; extends the Section-2c golden's
 *           on-disk 836/836 to THIS live buffer).
 *  Phase D  retune mechanical: writer.applyPresetRetune with small deltas
 *           (amp.bass +0.5 when placed; output.scene_3_main -> +2.5 always,
 *           deliberately scene>=3: paramIds 10..15 had no hardware anchor
 *           before the 2026-07-16 systemTail decode). Asserts
 *           apply_path='preset-image' + receipt='word-exact', then
 *           CROSS-ORACLES scene_3_main via the live fn 0x02 read path
 *           (reader.getParam) — image word vs live read agreement is the
 *           hardware confirmation for the scene_N_main word family.
 *  Phase E  fresh-default capture: for each always-tweaked family NOT
 *           placed in this preset, place it (working buffer), read fn 0x1F,
 *           save the triple (the byte-exact fresh default record). Families
 *           already placed are captured with fresh:false (still useful as
 *           Phase-C-style identity evidence, never as defaults).
 *  Phase F  restore baseline, re-dump, assert byte-identical.
 *
 * Run:  npx tsx scripts/_research/probe-ii-retune-hw-mechanical.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import type { DispatchCtx, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { writer } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
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
  BLOCK_BY_ID,
  buildGetAllParams,
  buildGetGridLayout,
  findParamFuzzy,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  resolveBlock,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

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
  if (!rt.ok) throw new Error(`round-trip identity failed on live dump: ${rt.reason}`);
  return { image: parsePresetImage(rt.words), words: rt.words };
}
function payloadOf(img: Img, wireId: number): number[] | undefined {
  const tlv = [...img.image.blocks, ...img.image.systemTail].find((b) => b.wireId === wireId);
  if (tlv === undefined) return undefined;
  return Array.from(img.words.slice(tlv.baseWord, tlv.baseWord + tlv.payloadLen));
}
function readDisplay(img: Img, blockName: string, paramName: string): number | string | undefined {
  const block = resolveBlock(blockName);
  if (block === undefined) return undefined;
  const tlv = [...img.image.blocks, ...img.image.systemTail].find((b) => b.wireId === block.id);
  const param = block !== undefined ? findParamFuzzy(block, paramName) : undefined;
  if (tlv === undefined || param === undefined) return undefined;
  const w = img.words[paramWordIndex(tlv, param.paramId, 'X')];
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  return kind.decodeWire !== undefined ? kind.decodeWire(w) : w;
}

const d14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
const d16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);

interface Triple { targetId: number; itemCount: number; values: number[]; rawFrames: number[][] }
async function readFn1f(conn: ReturnType<typeof connectAxeFxII>, effectId: number, windowMs = 1200): Promise<Triple | undefined> {
  const frames: number[][] = [];
  const unsub = conn.onMessage((b) => {
    if (b[0] === 0xf0 && b[4] === 0x07 && (b[5] === 0x74 || b[5] === 0x75 || b[5] === 0x76)) frames.push([...b]);
  });
  conn.send(buildGetAllParams(effectId, { modelId: 0x07 }));
  await new Promise((r) => setTimeout(r, windowMs));
  unsub();
  let out: Triple | undefined;
  for (const f of frames) {
    if (f[5] === 0x74) out = { targetId: d14(f[6], f[7]), itemCount: d14(f[8], f[9]), values: [], rawFrames: frames };
    else if (f[5] === 0x75 && out !== undefined) {
      const n = d14(f[6], f[7]);
      for (let i = 0; i < n; i++) {
        const off = 8 + i * 3;
        if (off + 2 >= f.length - 2) break;
        out.values.push(d16(f[off], f[off + 1], f[off + 2]));
      }
    }
  }
  return out;
}

/** Amp live records carry one 32767 appended per half vs the image record parity rule does NOT apply here: fn 0x1F reads the LIVE layout, and the image dumped from the LIVE device is also live layout, so identity should be direct. */
const FRESH_FAMILIES = ['Amp 1', 'Amp 2', 'Cab 1', 'Reverb 1', 'Delay 1', 'Multi Delay 1', 'Pitch 1', 'Drive 1'];

async function main(): Promise<void> {
  console.log('── BK-084 mechanical hardware verification (self-validating, no ears needed) ──');
  const conn = connectAxeFxII();
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => conn } as unknown as DispatchCtx;
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
  const outDir = path.join('samples', 'captured', `bk084-hw-mech-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  // ── Phase A: read-only baseline ──
  const baseline = await dumpWorkingBufferBytes(ctx);
  writeFileSync(path.join(outDir, 'baseline.syx'), Buffer.from(baseline));
  const baseImg = imageOf(baseline);
  const presetName = extractPresetName(parsePresetDump(baseline));
  console.log(`Phase A: baseline "${presetName}" dumped (${baseline.length} B) -> ${outDir}`);
  check('A: live baseline passes round-trip identity (21-bit footer model holds on this buffer)', true);

  const gridPromise = conn.receiveSysExMatching((b) => isGetGridLayoutResponse(b, 0x07), 1500);
  conn.send(buildGetGridLayout({ modelId: 0x07 }));
  const cells = parseGetGridLayoutResponse(await gridPromise, 0x07);
  const placedIds = new Set(cells.map((c) => c.blockId).filter((id) => id !== 0 && id < 200));
  console.log(`  grid content blocks: ${[...placedIds].sort((a, b) => a - b).map((id) => BLOCK_BY_ID[id]?.name ?? id).join(', ')}`);

  // ── Phase B: P0-mechanical identity push ──
  console.log('Phase B: identity push (same bytes back to the working buffer)...');
  const p0 = await restorePresetBinaryAxeFxII(ctx, baseline);
  check('B: identity push accepted (0 NACKs)', p0.ok, `${p0.nacks.length} NACK(s)`);
  const afterIdentity = await dumpWorkingBufferBytes(ctx);
  check('B: post-identity-push re-dump byte-identical to baseline', bytesEqual(afterIdentity, baseline));

  // ── Phase C: live fn 0x1F byte-identity vs the baseline image ──
  console.log('Phase C: fn 0x1F vs image TLV payloads (live, read-only)...');
  {
    const targets = new Set<number>([...placedIds]);
    for (const b of baseImg.image.systemTail) targets.add(b.wireId);
    let compared = 0;
    let identical = 0;
    const misses: string[] = [];
    for (const id of targets) {
      const payload = payloadOf(baseImg, id);
      if (payload === undefined) continue;
      const t = await readFn1f(conn, id);
      if (t === undefined || t.values.length === 0) { misses.push(`${id}: no reply`); continue; }
      compared++;
      const same = t.values.length === payload.length && payload.every((v, i) => v === t.values[i]);
      if (same) identical++;
      else if (misses.length < 6) misses.push(`${id} (${BLOCK_BY_ID[id]?.name ?? '?'}): len ${t.values.length} vs ${payload.length}`);
    }
    check(`C: fn 0x1F byte-identity on the LIVE buffer: ${identical}/${compared} blocks`, compared > 0 && identical === compared, misses.join('; '));
  }

  // ── Phase D: retune mechanical + scene_3_main cross-oracle ──
  console.log('Phase D: mode-retune mechanical (small deltas, working buffer)...');
  {
    const slots: PresetSpec['slots'][number][] = [];
    const bassBefore = readDisplay(baseImg, 'Amp 1', 'bass');
    let bassTarget: number | undefined;
    if (typeof bassBefore === 'number' && placedIds.has(106)) {
      bassTarget = Math.min(10, Math.round((bassBefore + 0.5) * 100) / 100);
      slots.push({ slot: { row: 2, col: 1 }, block_type: 'amp', params: { bass: bassTarget } });
    }
    const SCENE3_TARGET = 2.5;
    slots.push({ slot: { row: 1, col: 1 }, block_type: 'Output', params: { scene_3_main: SCENE3_TARGET } });
    const r = await writer.applyPresetRetune!(ctx, { slots });
    check("D: retune served by the IMAGE path (apply_path='preset-image')", r.apply_path === 'preset-image', r.image_apply_fallback_reason ?? r.warning ?? '');
    check("D: word-exact read-back receipt", r.ok === true && r.receipt === 'word-exact', JSON.stringify(r.validation_errors ?? r.failed_step ?? '').slice(0, 200));
    check('D: single clean push', r.push_attempts === 1, String(r.push_attempts));

    const post = imageOf(await dumpWorkingBufferBytes(ctx));
    if (bassTarget !== undefined) {
      const got = readDisplay(post, 'Amp 1', 'bass');
      check(`D: amp.bass image word landed (${String(bassBefore)} -> ${bassTarget})`, typeof got === 'number' && Math.abs(got - bassTarget) < 0.05, `image says ${String(got)}`);
    }
    const s3img = readDisplay(post, 'Output', 'scene_3_main');
    check(`D: output.scene_3_main image word landed (${SCENE3_TARGET})`, typeof s3img === 'number' && Math.abs(s3img - SCENE3_TARGET) < 0.05, `image says ${String(s3img)}`);
    // Cross-oracle: the LIVE read path (fn 0x02 query) against the image word.
    // Agreement = hardware confirmation of the scene_N_main word family
    // (paramIds 10..15 had no anchor before the systemTail decode).
    try {
      const live = await AXEFX2_DESCRIPTOR.reader.getParam!(ctx, 'output', 'scene_3_main');
      const liveVal = typeof live.display_value === 'number' ? live.display_value : Number(live.display_value);
      check('D: CROSS-ORACLE live fn 0x02 read == image word for scene_3_main', Number.isFinite(liveVal) && Math.abs(liveVal - SCENE3_TARGET) < 0.05, `live read: ${String(live.display_value)}`);
    } catch (err) {
      check('D: CROSS-ORACLE live fn 0x02 read == image word for scene_3_main', false, err instanceof Error ? err.message : String(err));
    }
  }

  // ── Phase E: fresh-default captures for UNPLACED families ──
  console.log('Phase E: fresh-default fn 0x1F captures (unplaced families only are FRESH)...');
  {
    const manifest: Array<Record<string, unknown>> = [];
    let col = 1;
    for (const familyName of FRESH_FAMILIES) {
      const block = resolveBlock(familyName);
      if (block === undefined) continue;
      const fresh = !placedIds.has(block.id);
      if (fresh) {
        const place = await writer.setBlock!(ctx, { row: 2, col }, { block_type: familyName });
        col = (col % 12) + 1;
        if (!place.acked) {
          console.log(`  !! ${familyName}: placement not acked (${place.warning ?? ''}); skipped`);
          manifest.push({ family: familyName, effectId: block.id, placed: false });
          continue;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      const t = await readFn1f(conn, block.id);
      if (t === undefined || t.values.length === 0) {
        console.log(`  !! ${familyName}: no fn 0x1F reply; skipped`);
        manifest.push({ family: familyName, effectId: block.id, reply: false, fresh });
        continue;
      }
      const slug = familyName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const file = `fresh-${block.id}-${slug}.syx`;
      writeFileSync(path.join(outDir, file), Buffer.from(t.rawFrames.flat()));
      console.log(`  ${file}: ${t.values.length} values, fresh=${fresh}${fresh ? '  <-- DEFAULT RECORD' : ' (already placed: preset values, NOT defaults)'}`);
      manifest.push({ family: familyName, effectId: block.id, file, values: t.values.length, fresh });
    }
    writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
      device: 'Axe-Fx II XL+', preset: presetName, captured_at: new Date().toISOString(),
      note: 'fresh=true records are byte-exact FRESH DEFAULT records (fn 0x1F == image TLV payload, live layout). fresh=false records are the preset values (identity evidence only).',
      families: manifest,
    }, null, 2));
    const freshCount = manifest.filter((m) => m.fresh === true && m.file !== undefined).length;
    check(`E: captured ${freshCount} FRESH default record(s) (families not placed in "${presetName}")`, freshCount > 0, 'all families already placed; re-run on an emptier preset');
  }

  // ── Phase F: restore baseline ──
  console.log('Phase F: restoring baseline...');
  const rest = await restorePresetBinaryAxeFxII(ctx, baseline);
  check('F: baseline restore push accepted', rest.ok, `${rest.nacks.length} NACK(s)`);
  const finalDump = await dumpWorkingBufferBytes(ctx);
  check('F: final buffer byte-identical to baseline (nothing left behind, nothing saved)', bytesEqual(finalDump, baseline));

  console.log(`\n${pass} PASS, ${fail} FAIL. Artifacts: ${outDir}`);
  conn.close();
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
