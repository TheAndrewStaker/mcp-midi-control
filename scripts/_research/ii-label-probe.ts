/**
 * ii-label-probe.ts: WRITE-AND-RESTORE probe of Axe-Fx II display labels, for
 * the params the read-only preset sweep could not pin (ii-label-sweep.ts never
 * saw them at more than one value).
 *
 * For each target param: read the held value, write a few test wire values to
 * the WORKING BUFFER, read the device's label after each, write the original
 * value back and confirm it reads back identical. Nothing is ever stored: after
 * each preset's group the stored preset is recalled again (discarding the
 * buffer), and the starting preset is recalled at the end (also on Ctrl-C).
 * Global blocks (input, output, controllers, looper) are never touched.
 *
 *   npx tsx scripts/_research/ii-label-probe.ts [--proposals file] [--corpus file] [--out file]
 *
 * Output rows share the sweep's shape ({preset, effectId, key, wire, label}),
 * so the fitter reads both corpora together.
 */
import { appendFileSync, readFileSync } from 'node:fs';

import { connectAxeFxII } from '../../packages/fractal-gen2/src/midi.js';
import {
  AXE_FX_II_BLOCKS, KNOWN_PARAMS, type AxeFxIIParam,
  buildGetBlockParameterValue, isGetBlockParameterResponse, parseGetBlockParameterResponse,
  buildSetBlockParameterValueInteger, buildSwitchPreset, buildGetPresetNumber,
  isGetPresetNumberResponse, parseGetPresetNumberResponse,
} from '../../packages/fractal-midi/src/gen2/axe-fx-ii/index.js';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PROPOSALS = arg('proposals', 'samples/captured/ii-label-proposals.json');
const CORPUS = arg('corpus', 'samples/captured/ii-label-sweep.jsonl');
const OUT = arg('out', 'samples/captured/ii-label-probe.jsonl');
const NEVER = new Set(['input', 'output', 'controllers', 'looper', 'tonematch']);
const NUMERIC_WIRES = [13107, 26214, 45875];
const ORDINAL_WIRES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12];

const PARAM_BY_KEY = new Map(Object.values(KNOWN_PARAMS as Record<string, AxeFxIIParam>).map((p) => [`${p.block}.${p.name}`, p]));

// ---- targets ----
interface Target { key: string; wires: number[] }
const targets: Target[] = [];
const props = JSON.parse(readFileSync(PROPOSALS, 'utf8')) as { numeric: Array<{ key: string; verdict: string; reason: string }> };
for (const p of props.numeric) {
  if (p.verdict !== 'unresolved') continue;
  const param = PARAM_BY_KEY.get(p.key);
  if (!param || NEVER.has(param.block) || /bypass/.test(param.name)) continue;
  targets.push({ key: p.key, wires: NUMERIC_WIRES });
}
// integer params the fitter flagged as ordinal-shaped, plus the cab roster's factory/user boundary
const corpusRows = readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Ordinal-shaped only when the corpus saw a small NON-ZERO wire: a param seen
// only at wire 0 says nothing about its encoding, so it gets interior values.
const maxWire = new Map<string, number>();
for (const r of corpusRows) if (r.key) maxWire.set(r.key, Math.max(maxWire.get(r.key) ?? 0, r.wire));
for (const t of targets) { const m = maxWire.get(t.key) ?? 65534; if (m > 0 && m < 512) t.wires = ORDINAL_WIRES; }
const ONLY = arg('only', '');
if (ONLY) { const keep = new Set(ONLY.split(',')); targets.splice(0, targets.length, ...targets.filter((t) => keep.has(t.key))); }
const WIRES = arg('wires', '');
if (WIRES) for (const t of targets) t.wires = WIRES.split(',').map(Number);
const NO_CAB = process.argv.includes('--no-cab');
// Factory/user boundary (sweep: FACTORY n at wire n-1 up to 183, USER n at wire 188+n
// from 228) and the top of the user range (the device clamps or labels past it).
if (!NO_CAB) targets.push({ key: 'cab.cab', wires: [183, 184, 185, 186, 187, 188, 189, 190, 699, 700, 701, 702, 1211, 1212, 1213] });

// ---- pick a preset that holds each target's block (from the sweep) ----
const presetFor = new Map<string, { preset: number; effectId: number }>();
for (const r of corpusRows) {
  if (!r.key || presetFor.has(r.key)) continue;
  presetFor.set(r.key, { preset: r.preset, effectId: r.effectId });
}
const groups = new Map<number, Array<Target & { effectId: number }>>();
for (const t of targets) {
  const at = presetFor.get(t.key);
  if (!at) { console.log(`skip ${t.key}: no preset in the corpus holds its block`); continue; }
  groups.set(at.preset, [...(groups.get(at.preset) ?? []), { ...t, effectId: at.effectId }]);
}

const conn = connectAxeFxII();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ask(req: number[], pred: (b: number[]) => boolean, ms = 600): Promise<number[] | undefined> {
  const p = conn.receiveSysExMatching(pred, ms);
  conn.send(req);
  try { return await p; } catch { return undefined; }
}
async function get(effectId: number, paramId: number) {
  const target = { effectId, paramId };
  const r = await ask(buildGetBlockParameterValue(target), (b) => isGetBlockParameterResponse(b, target), 500);
  return r ? parseGetBlockParameterResponse(r) : undefined;
}

const numResp = await ask(buildGetPresetNumber(), (b) => isGetPresetNumberResponse(b), 1500);
if (!numResp) throw new Error('no GET_PRESET_NUMBER reply');
const start = parseGetPresetNumberResponse(numResp).presetNumber;
let stop = false;
process.on('SIGINT', () => { stop = true; });
console.log(`start preset ${start}; ${targets.length} targets in ${groups.size} presets -> ${OUT}`);

let restoreFailures = 0;
try {
  for (const [preset, list] of groups) {
    if (stop) break;
    conn.send(buildSwitchPreset(preset));
    await sleep(600);
    for (const t of list) {
      if (stop) break;
      const param = PARAM_BY_KEY.get(t.key)!;
      if (!AXE_FX_II_BLOCKS.some((b) => b.id === t.effectId)) continue;
      const orig = await get(t.effectId, param.paramId);
      if (!orig) { console.log(`${t.key}: no read on preset ${preset}`); continue; }
      const seen: string[] = [];
      for (const w of t.wires) {
        conn.send(buildSetBlockParameterValueInteger({ effectId: t.effectId, paramId: param.paramId }, w));
        await sleep(60);
        const r = await get(t.effectId, param.paramId);
        if (!r) continue;
        appendFileSync(OUT, JSON.stringify({ preset, effectId: t.effectId, key: t.key, wire: r.value, label: r.label, probe: w }) + '\n');
        seen.push(`${w}->${r.value}="${r.label}"`);
      }
      conn.send(buildSetBlockParameterValueInteger({ effectId: t.effectId, paramId: param.paramId }, orig.value));
      await sleep(60);
      const back = await get(t.effectId, param.paramId);
      const ok = back?.value === orig.value;
      if (!ok) restoreFailures++;
      console.log(`${t.key} @${preset}: orig ${orig.value}="${orig.label}" | ${seen.join(' ')} | restore ${ok ? 'ok' : `FAILED (${back?.value})`}`);
    }
    // discard the working buffer: recall the stored preset again
    conn.send(buildSwitchPreset(preset));
    await sleep(600);
  }
} finally {
  conn.send(buildSwitchPreset(start));
  await sleep(800);
  const r = await ask(buildGetPresetNumber(), (b) => isGetPresetNumberResponse(b), 1500);
  console.log(`recalled preset ${r ? parseGetPresetNumberResponse(r).presetNumber : '?'} (start ${start}); restore failures ${restoreFailures}`);
  conn.close();
}
