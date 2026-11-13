/**
 * FRESH-DEFAULT-RECORD capture session (Axe-Fx II XL+), ~2 minutes.
 *
 * WHY: building a preset FROM SCRATCH as one atomic image push needs each
 * block family's pristine default TLV record (what the device instantiates
 * on placement). The 2026-07-16 re-mine proved no on-disk oracle exists for
 * the always-tweaked families (Amp/Cab/Drive/Delay/Reverb/MultiDelay/Pitch)
 * BUT ALSO proved fn 0x1F's reply is byte-identical to the image TLV
 * payload (836/836 words vs factory A003, including Amp). So one placement
 * + one fn 0x1F read per family = the byte-exact default record.
 *
 * WHAT IT DOES (never STOREs anything; the working buffer is restored from
 * a baseline export at the end):
 *   0. Confirm the scratch preset (readline), export the edit buffer to
 *      samples/captured/fresh-defaults-<ts>/baseline.syx (the undo artifact).
 *   1. Grid read: families ALREADY placed in this preset are flagged
 *      (placing an already-placed block MOVES it — that would capture the
 *      preset's values, not defaults — so pick an emptier preset, or the
 *      capture is marked fresh:false and should not be trusted as a default).
 *   2. Per family (Enter to run, s to skip, q to finish): place the block
 *      on its own row-2 cell (awaited SET_GRID_CELL ack), send fn 0x1F
 *      GET_ALL_PARAMS, save the 0x74/0x75/0x76 reply frames verbatim to
 *      block-<id>-<slug>.syx + a manifest entry.
 *   3. Restore the baseline (66-frame working-buffer push, the verified
 *      import_preset path). Nothing was saved to flash at any point.
 *
 * Analysis (offline, later): each capture's triple IS the fresh default
 * record in live layout; the factory-234→live-236 amp conversion (append
 * 32767 per half) links it to the corpus layout.
 *
 * Run:  npx tsx scripts/_research/probe-ii-fresh-defaults.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { writer } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import { dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import {
  buildGetAllParams,
  buildGetGridLayout,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  resolveBlock,
} from 'fractal-midi/gen2/axe-fx-ii';

registerDevice(AXEFX2_DESCRIPTOR);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

// The always-tweaked families the re-mine could NOT recover from disk,
// in display-name form (resolved to wire ids at runtime).
const FAMILIES = [
  'Amp 1', 'Amp 2', 'Cab 1', 'Reverb 1', 'Delay 1', 'Multi Delay 1', 'Pitch 1', 'Drive 1',
];

function ts(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[T:]/g, '-');
}

async function collectFn1fReply(conn: ReturnType<typeof connectAxeFxII>, effectId: number, windowMs = 1500): Promise<number[][]> {
  const frames: number[][] = [];
  const unsub = conn.onMessage((b) => {
    if (b[0] === 0xf0 && b[4] === 0x07 && (b[5] === 0x74 || b[5] === 0x75 || b[5] === 0x76)) frames.push([...b]);
  });
  conn.send(buildGetAllParams(effectId, { modelId: 0x07 }));
  await new Promise((r) => setTimeout(r, windowMs));
  unsub();
  return frames;
}

async function main(): Promise<void> {
  console.log('── Axe-Fx II fresh-default-record capture ──');
  console.log('Preconditions: XL+ connected over USB; pick an EXPENDABLE preset');
  console.log('(ideally one with FEW blocks; nothing will be saved, the buffer is');
  console.log('restored at the end, but the front panel will show blocks appearing).');
  const go = await ask('Type the preset number currently on the front panel to confirm, or q to quit: ');
  if (go.trim().toLowerCase() === 'q') { rl.close(); return; }

  const conn = connectAxeFxII();
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => conn } as unknown as DispatchCtx;

  const outDir = path.join('samples', 'captured', `fresh-defaults-${ts()}`);
  mkdirSync(outDir, { recursive: true });

  // Step 0: baseline export (the undo artifact + restore source).
  console.log('Exporting the edit buffer as the baseline/undo artifact...');
  const baseline = await dumpWorkingBufferBytes(ctx);
  writeFileSync(path.join(outDir, 'baseline.syx'), Buffer.from(baseline));
  console.log(`  baseline.syx written (${baseline.length} bytes).`);

  // Step 1: grid read → already-placed families are NOT fresh captures.
  const gridPromise = conn.receiveSysExMatching((b) => isGetGridLayoutResponse(b, 0x07), 1500);
  conn.send(buildGetGridLayout({ modelId: 0x07 }));
  const placedIds = new Set(parseGetGridLayoutResponse(await gridPromise, 0x07).map((c) => c.blockId));

  const manifest: Array<Record<string, unknown>> = [];
  let col = 1;
  for (const familyName of FAMILIES) {
    const block = resolveBlock(familyName);
    if (block === undefined) { console.log(`  !! could not resolve "${familyName}" — skipping`); continue; }
    const alreadyPlaced = placedIds.has(block.id);
    const flag = alreadyPlaced
      ? '  ⚠ ALREADY PLACED in this preset — capture will hold the preset values, NOT defaults (pick an emptier preset for this family)'
      : '';
    const answer = await ask(`Place + capture ${familyName} (id ${block.id})${flag} [Enter=go, s=skip, q=finish]: `);
    const a = answer.trim().toLowerCase();
    if (a === 'q') break;
    if (a === 's') continue;

    const cell = { row: 2, col };
    col = (col % 12) + 1;
    const placeResult = await writer.setBlock!(ctx, cell, { block_type: familyName });
    if (!placeResult.acked) {
      console.log(`  !! placement not acked (${placeResult.warning ?? 'no detail'}); skipping capture`);
      manifest.push({ family: familyName, effectId: block.id, placed: false, warning: placeResult.warning });
      continue;
    }
    await new Promise((r) => setTimeout(r, 150));
    const frames = await collectFn1fReply(conn, block.id);
    const fns = new Set(frames.map((f) => f[5]));
    const complete = fns.has(0x74) && fns.has(0x75) && fns.has(0x76);
    const slug = familyName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const file = `block-${block.id}-${slug}.syx`;
    writeFileSync(path.join(outDir, file), Buffer.from(frames.flat()));
    console.log(`  ${file}: ${frames.length} frame(s), triple ${complete ? 'COMPLETE' : 'INCOMPLETE (re-run this family)'}${alreadyPlaced ? ', fresh:false (already placed!)' : ''}`);
    manifest.push({
      family: familyName,
      effectId: block.id,
      cell,
      file,
      frames: frames.length,
      triple_complete: complete,
      fresh: !alreadyPlaced,
    });
  }

  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    device: 'Axe-Fx II XL+', firmware: 'Q8.02 (confirm on front panel)', captured_at: new Date().toISOString(),
    protocol: 'place block (SET_GRID_CELL, awaited) -> fn 0x1F GET_ALL_PARAMS -> save 0x74/0x75/0x76 triple verbatim',
    families: manifest,
  }, null, 2));

  console.log('Restoring the baseline working buffer (no STORE; flash untouched)...');
  const restore = await restorePresetBinaryAxeFxII(ctx, baseline);
  console.log(restore.ok
    ? '  baseline restored to the working buffer. Front panel should show the original preset content (unsaved).'
    : `  !! baseline restore reported NACKs (${restore.nacks.length}); switch presets on the device to discard the buffer safely.`);
  console.log(`Done. Captures + manifest in ${outDir}`);
  rl.close();
  conn.close();
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
