/**
 * ii-label-sweep.ts: READ-ONLY corpus of (wire value, device label) pairs from
 * an Axe-Fx II, used to fit and verify the II display calibration.
 *
 * The II puts its own rendered display text in every fn 0x02 GET response, so
 * the device itself is the oracle: for every placed block of every stored
 * preset in the chosen range, read every catalog param and record
 * {preset, effectId, key, wire, label}. Different presets hold different
 * values, which is what makes a range/taper fit possible without any write.
 *
 * Nothing is written to a parameter, nothing is saved. The only state change is
 * preset recall (fn 0x14), which reloads a stored preset into the working
 * buffer; the starting preset is recalled again at the end (also on Ctrl-C).
 * Do not run while someone is editing the II: recall discards an unsaved edit.
 *
 *   npx tsx scripts/_research/ii-label-sweep.ts [--from 0] [--to 767] [--stride 1] [--out file.jsonl]
 *
 * Resumable: presets already present in --out are skipped.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { connectAxeFxII } from '../../packages/fractal-gen2/src/midi.js';
import {
  AXE_FX_II_BLOCKS, KNOWN_PARAMS, type AxeFxIIParam,
  buildGetBlockParameterValue, isGetBlockParameterResponse, parseGetBlockParameterResponse,
  buildGetGridLayout, isGetGridLayoutResponse, parseGetGridLayoutResponse,
  buildSwitchPreset, buildGetPresetNumber, isGetPresetNumberResponse, parseGetPresetNumberResponse,
  buildGetPresetName,
} from '../../packages/fractal-midi/src/gen2/axe-fx-ii/index.js';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg('from', '0'));
const TO = Number(arg('to', '767'));
const STRIDE = Number(arg('stride', '1'));
const OUT = arg('out', 'samples/captured/ii-label-sweep.jsonl');

const conn = connectAxeFxII();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(req: number[], pred: (b: number[]) => boolean, ms = 600): Promise<number[] | undefined> {
  const p = conn.receiveSysExMatching(pred, ms);
  conn.send(req);
  try { return await p; } catch { return undefined; }
}

const byGroup = new Map<string, AxeFxIIParam[]>();
for (const [key, p] of Object.entries(KNOWN_PARAMS as Record<string, AxeFxIIParam>)) {
  void key;
  const list = byGroup.get(p.groupCode) ?? [];
  list.push(p);
  byGroup.set(p.groupCode, list);
}

const done = new Set<number>();
if (existsSync(OUT)) for (const ln of readFileSync(OUT, 'utf8').split('\n')) { if (ln) done.add(JSON.parse(ln).preset); }

const numResp = await ask(buildGetPresetNumber(), (b) => isGetPresetNumberResponse(b), 1500);
if (!numResp) throw new Error('no GET_PRESET_NUMBER reply: is the II connected?');
const start = parseGetPresetNumberResponse(numResp).presetNumber;
console.log(`starting preset ${start}; sweeping ${FROM}..${TO} stride ${STRIDE} -> ${OUT}`);

let stop = false;
process.on('SIGINT', () => { stop = true; });

async function restore() {
  conn.send(buildSwitchPreset(start));
  await sleep(800);
  const r = await ask(buildGetPresetNumber(), (b) => isGetPresetNumberResponse(b), 1500);
  console.log(`restored preset ${r ? parseGetPresetNumberResponse(r).presetNumber : '?'} (wanted ${start})`);
  conn.close();
}

try {
  for (let preset = FROM; preset <= TO && !stop; preset += STRIDE) {
    if (done.has(preset)) continue;
    const t0 = Date.now();
    conn.send(buildSwitchPreset(preset));
    await sleep(500);
    const nameResp = await ask(buildGetPresetName(), (b) => b[5] === 0x0f && b.length > 10, 1000);
    const name = nameResp ? String.fromCharCode(...nameResp.slice(6, -2).filter((c) => c >= 0x20 && c < 0x7f)).trim() : '?';
    const grid = await ask(buildGetGridLayout(), (b) => isGetGridLayoutResponse(b), 1500);
    if (!grid) { console.log(`preset ${preset}: no grid reply, skipped`); continue; }
    const placed = [...new Set(parseGetGridLayoutResponse(grid).map((c) => c.blockId).filter((id) => id >= 100 && id < 200))];
    let n = 0;
    for (const effectId of placed) {
      const block = AXE_FX_II_BLOCKS.find((b) => b.id === effectId);
      if (!block) continue;
      for (const p of byGroup.get(block.groupCode) ?? []) {
        const target = { effectId, paramId: p.paramId };
        const r = await ask(buildGetBlockParameterValue(target), (b) => isGetBlockParameterResponse(b, target), 400);
        if (!r) continue;
        const { value, label } = parseGetBlockParameterResponse(r);
        appendFileSync(OUT, JSON.stringify({ preset, name, effectId, key: `${p.block}.${p.name}`, wire: value, label }) + '\n');
        n++;
      }
    }
    if (n === 0) appendFileSync(OUT, JSON.stringify({ preset, name, empty: true }) + '\n');
    console.log(`preset ${preset} "${name}": ${placed.length} blocks, ${n} reads, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
} finally {
  await restore();
}
