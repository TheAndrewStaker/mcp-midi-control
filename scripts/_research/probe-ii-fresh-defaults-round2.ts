/**
 * Fresh-default capture, ROUND 2: harvest the families that were already
 * placed in the active preset (round 1 could only capture unplaced ones).
 *
 * Per family, single-variable, baseline-restored between EVERY family:
 *
 *   1. LIVE remove -> re-place (set_block 'none' then set_block family at
 *      the same cell, both awaited acks) -> fn 0x1F. If the re-placed
 *      record DIFFERS from the pre-removal record, the device
 *      re-instantiated -> candidate FRESH DEFAULT (still cross-validated
 *      later). If IDENTICAL, the device remembers within the buffer ->
 *      fall through to:
 *   2. SPLICE route: build an image WITHOUT the family via the shipped
 *      structural-splice codec (removeBlockFromImage), push it (this is
 *      ALSO the "push acceptance of a novel composition" evidence item the
 *      codec lane left untested), verify the re-dump, then set_block place
 *      -> fn 0x1F -> fresh default (nothing left to remember).
 *
 *   Cross-check: the re-placed/spliced Amp 1 record vs round 1's FRESH
 *   Amp 2 record (are family defaults instance-independent?).
 *
 * Working-buffer only; zero STOREs; baseline restored + verified
 * byte-identical at the end (and between families).
 *
 * Run:  npx tsx scripts/_research/probe-ii-fresh-defaults-round2.ts [round1-dir]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { writer } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import { dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import { parsePresetDump, extractPresetName } from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  buildGetAllParams,
  buildGetGridLayout,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  resolveBlock,
  parseIIPresetDumpFrames,
  imageFromFrames,
  framesFromImage,
  serializeIIPresetDumpFrames,
  removeBlockFromImage,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const valuesEqual = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const d14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
const d16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);

interface Triple { values: number[]; rawFrames: number[][] }
async function readFn1f(conn: ReturnType<typeof connectAxeFxII>, effectId: number, windowMs = 1200): Promise<Triple | undefined> {
  const frames: number[][] = [];
  const unsub = conn.onMessage((b) => {
    if (b[0] === 0xf0 && b[4] === 0x07 && (b[5] === 0x74 || b[5] === 0x75 || b[5] === 0x76)) frames.push([...b]);
  });
  conn.send(buildGetAllParams(effectId, { modelId: 0x07 }));
  await new Promise((r) => setTimeout(r, windowMs));
  unsub();
  const values: number[] = [];
  let seenHeader = false;
  for (const f of frames) {
    if (f[5] === 0x74) seenHeader = true;
    else if (f[5] === 0x75 && seenHeader) {
      const n = d14(f[6], f[7]);
      for (let i = 0; i < n; i++) {
        const off = 8 + i * 3;
        if (off + 2 >= f.length - 2) break;
        values.push(d16(f[off], f[off + 1], f[off + 2]));
      }
    }
  }
  return seenHeader ? { values, rawFrames: frames } : undefined;
}

const FAMILIES = ['Amp 1', 'Cab 1', 'Reverb 1', 'Delay 1', 'Multi Delay 1', 'Drive 1'];

async function main(): Promise<void> {
  console.log('── Fresh-default capture round 2: remove/re-place vs splice-push ──');
  const conn = connectAxeFxII();
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => conn } as unknown as DispatchCtx;
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
  const outDir = path.join('samples', 'captured', `fresh-defaults-r2-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const baseline = await dumpWorkingBufferBytes(ctx);
  writeFileSync(path.join(outDir, 'baseline.syx'), Buffer.from(baseline));
  const presetName = extractPresetName(parsePresetDump(baseline));
  console.log(`baseline "${presetName}" (${baseline.length} B) -> ${outDir}`);

  const restoreBaseline = async (): Promise<boolean> => {
    const r = await restorePresetBinaryAxeFxII(ctx, baseline);
    if (!r.ok) return false;
    return bytesEqual(await dumpWorkingBufferBytes(ctx), baseline);
  };

  const gridPromise = conn.receiveSysExMatching((b) => isGetGridLayoutResponse(b, 0x07), 1500);
  conn.send(buildGetGridLayout({ modelId: 0x07 }));
  const cells = parseGetGridLayoutResponse(await gridPromise, 0x07);

  // Round 1's fresh Amp 2 record for the instance-independence cross-check.
  const r1Dir = process.argv[2];
  let amp2Fresh: number[] | undefined;
  if (r1Dir !== undefined && existsSync(path.join(r1Dir, 'fresh-107-amp-2.syx'))) {
    const raw = new Uint8Array(readFileSync(path.join(r1Dir, 'fresh-107-amp-2.syx')));
    const frames: number[][] = [];
    let cur: number[] | undefined;
    for (const b of raw) {
      if (b === 0xf0) cur = [b];
      else if (cur !== undefined) { cur.push(b); if (b === 0xf7) { frames.push(cur); cur = undefined; } }
    }
    const values: number[] = [];
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
    if (values.length > 0) amp2Fresh = values;
  }

  const manifest: Array<Record<string, unknown>> = [];

  for (const familyName of FAMILIES) {
    const block = resolveBlock(familyName);
    if (block === undefined) continue;
    const cell = cells.find((c) => c.blockId === block.id);
    if (cell === undefined) {
      console.log(`  ${familyName}: not placed in this preset; round 1 already covers it. Skipping.`);
      continue;
    }
    console.log(`\n${familyName} (id ${block.id}) at r${cell.row}c${cell.col}:`);
    const pre = await readFn1f(conn, block.id);
    if (pre === undefined) { check(`${familyName}: pre-removal fn 0x1F read`, false, 'no reply'); continue; }

    // ── Route 1: live remove -> re-place ──
    const rm = await writer.setBlock!(ctx, { row: cell.row, col: cell.col }, { block_type: 'none' });
    check(`${familyName}: live remove acked`, rm.acked, rm.warning ?? '');
    await new Promise((r) => setTimeout(r, 150));
    const re = await writer.setBlock!(ctx, { row: cell.row, col: cell.col }, { block_type: familyName });
    check(`${familyName}: live re-place acked`, re.acked, re.warning ?? '');
    await new Promise((r) => setTimeout(r, 150));
    const post = await readFn1f(conn, block.id);
    if (post === undefined) { check(`${familyName}: post-re-place fn 0x1F read`, false, 'no reply'); await restoreBaseline(); continue; }

    const remembered = valuesEqual(pre.values, post.values);
    console.log(`  live remove->re-place: device ${remembered ? 'REMEMBERED the old record (buffer retains removed-block state)' : 'RE-INSTANTIATED (record differs from pre-removal)'}`);

    let freshValues: number[] | undefined;
    let freshFrames: number[][] | undefined;
    let route = '';
    if (!remembered) {
      freshValues = post.values;
      freshFrames = post.rawFrames;
      route = 'live-remove-replace';
    } else {
      // ── Route 2: splice-push (also the novel-composition push test) ──
      console.log('  trying the splice route: push an image WITHOUT the block, then place fresh...');
      await restoreBaseline();
      const frames = parseIIPresetDumpFrames(baseline);
      const image = imageFromFrames(frames);
      const removed = removeBlockFromImage(image, block.id);
      if (!('image' in removed)) {
        check(`${familyName}: splice removal built`, false, removed.reason);
        await restoreBaseline();
        manifest.push({ family: familyName, effectId: block.id, route: 'none', remembered, splice: removed.reason });
        continue;
      }
      const splicedBytes = serializeIIPresetDumpFrames(framesFromImage(removed.image, frames.headerPayload));
      const pushR = await restorePresetBinaryAxeFxII(ctx, splicedBytes);
      check(`${familyName}: NOVEL-COMPOSITION splice push accepted (0 NACKs)`, pushR.ok, `${pushR.nacks.length} NACK(s)`);
      if (!pushR.ok) { await restoreBaseline(); manifest.push({ family: familyName, effectId: block.id, route: 'splice-NACKed', remembered }); continue; }
      const verifyDump = await dumpWorkingBufferBytes(ctx);
      check(`${familyName}: spliced image round-trips byte-identical from the device`, bytesEqual(verifyDump, splicedBytes));
      const place = await writer.setBlock!(ctx, { row: removed.gridCell.row, col: removed.gridCell.col }, { block_type: familyName });
      check(`${familyName}: fresh place onto spliced image acked`, place.acked, place.warning ?? '');
      await new Promise((r) => setTimeout(r, 150));
      const fresh = await readFn1f(conn, block.id);
      if (fresh !== undefined) {
        freshValues = fresh.values;
        freshFrames = fresh.rawFrames;
        route = 'splice-then-place';
        const stillOld = valuesEqual(fresh.values, pre.values);
        console.log(`  splice-then-place record ${stillOld ? 'STILL equals the old record (defaults == this preset? unlikely — inspect!)' : 'DIFFERS from the old record: FRESH DEFAULT captured'}`);
      }
    }

    if (freshValues !== undefined && freshFrames !== undefined) {
      const slug = familyName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const file = `fresh-${block.id}-${slug}.syx`;
      writeFileSync(path.join(outDir, file), Buffer.from(freshFrames.flat()));
      console.log(`  saved ${file} (${freshValues.length} values, route=${route})`);
      manifest.push({ family: familyName, effectId: block.id, file, values: freshValues.length, route, remembered_on_live_readd: remembered });
      if (block.id === 106 && amp2Fresh !== undefined) {
        check(
          'Amp instance-independence: fresh Amp 1 record == round-1 fresh Amp 2 record',
          valuesEqual(freshValues, amp2Fresh),
          `lens ${freshValues.length}/${amp2Fresh.length}; first diffs: ${freshValues.map((v, i) => (v !== amp2Fresh![i] ? `[${i}] ${v}!=${amp2Fresh![i]}` : '')).filter(Boolean).slice(0, 5).join(', ')}`,
        );
      }
    }

    const restored = await restoreBaseline();
    check(`${familyName}: baseline restored byte-identical`, restored);
  }

  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    device: 'Axe-Fx II XL+', preset: presetName, captured_at: new Date().toISOString(),
    protocol: 'per family: live remove->re-place->fn 0x1F; if the device remembered, splice-push (removeBlockFromImage) -> place -> fn 0x1F; baseline restored between families',
    families: manifest,
  }, null, 2));

  const finalOk = await restoreBaseline();
  check('final: baseline restored byte-identical (nothing left behind, nothing saved)', finalOk);
  console.log(`\n${pass} PASS, ${fail} FAIL. Artifacts: ${outDir}`);
  conn.close();
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
