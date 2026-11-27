/**
 * review-gen3-device-quantize.ts (review scratch, read-only): does a gen-3 unit
 * store a continuous value snapped to its cache step? Uses the 2026-06-18
 * SET->GET roundtrips (samples/captured/chihotta-roundtrip-2026-06-18): for each
 * continuous wire sent OFF the cache-step grid, did the read-back stay put
 * (device stores finer than its step) or snap to the grid?
 */
import { readFileSync } from 'node:fs';
import { FM9_RANGES } from 'fractal-midi/gen3/fm9';
import { III_RANGES } from 'fractal-midi/gen3/axe-fx-iii';
import { FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';

const dir = 'samples/captured/chihotta-roundtrip-2026-06-18/';
for (const [file, ranges, byFam] of [['fm9-roundtrip.json', FM9_RANGES, FM9_PARAMS_BY_FAMILY], ['axefx3-roundtrip.json', III_RANGES, PARAMS_BY_FAMILY]] as const) {
  const j = JSON.parse(readFileSync(dir + file, 'utf8'));
  const byName = new Map<string, any>();
  for (const [fam, ps] of Object.entries(byFam as any)) for (const p of ps as any[]) { const r = (ranges as any)[fam]?.[p.paramId]; if (r) byName.set(p.name, r); }
  let offGrid = 0, stayed = 0, snapped = 0, other = 0; const ex: string[] = [];
  for (const fa of j.families) for (const p of fa.params) {
    if (p.kind !== 'continuous') continue;
    const r = byName.get(p.name);
    if (!r || r.kind !== 'float' || !r.step || !r.scale || ((r.typecode ?? 0) & 0xff) === 0x52) continue;
    if (((r.typecode ?? 0) & 0xf0) === 0x40) continue; // log10: skip, grid not linear in wire
    const inc = r.step * r.scale; const span = r.displayMax - r.displayMin; if (!(span > 0)) continue;
    const wPerStep = 65534 * inc / span; if (wPerStep < 3) continue;
    for (const v of p.values) {
      if (v.gotWire === undefined) continue;
      const disp = r.displayMin + span * v.sentWire / 65534;
      const gridDisp = r.displayMin + Math.round((disp - r.displayMin) / inc) * inc;
      const gridWire = Math.round((gridDisp - r.displayMin) / span * 65534);
      if (Math.abs(gridWire - v.sentWire) < 2) continue;
      offGrid++;
      if (v.gotWire === v.sentWire) stayed++;
      else if (Math.abs(v.gotWire - gridWire) <= 2) { snapped++; if (ex.length < 12) ex.push(`${p.name} inc ${+inc.toPrecision(4)} sent ${v.sentWire} got ${v.gotWire} grid ${gridWire}`); }
      else other++;
    }
  }
  console.log(`${file}: off-grid sends ${offGrid}: stayed ${stayed}, snapped to step ${snapped}, other ${other}`);
  for (const e of ex) console.log('   ' + e);
}
