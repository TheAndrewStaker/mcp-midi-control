/**
 * review-ii-final-rule.ts (review scratch, read-only): the FINAL gen-3
 * devicePrintDecimals rule applied in-device to the Axe-Fx II's own cache rows,
 * scored against the II's own printed decimals; lists every under-print.
 * Also scores the ablations: nibble-only, no guard, step-only.
 */
import { readFileSync } from 'node:fs';
import { DEVICE_LABEL_CALIBRATION, KNOWN_PARAMS } from 'fractal-midi/gen2/axe-fx-ii';
import { devicePrintDecimals } from '@mcp-midi-control/fractal-gen3/catalog.js';

const walk = JSON.parse(readFileSync('samples/captured/local-caches-2026-06-09/effectDefinitions_07.walk.json', 'utf8')) as { records: Array<{ kind: string; section: number; id: number; tc: number; min: number; max: number; def: number; step: number }> };
const rec = new Map(walk.records.map((r) => [`${r.section}:${r.id}`, r]));
const P = new Map(Object.values(KNOWN_PARAMS as Record<string, { block: string; name: string; paramId: number }>).map((p) => [`${p.block}.${p.name}`, p]));
const votes = new Map<string, Map<number, number>>();
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) { const m = /^cache\/s(\d+)$/.exec(c.from); if (!m) continue; const b = k.split('.')[0]; const v = votes.get(b) ?? new Map(); v.set(+m[1], (v.get(+m[1]) ?? 0) + 1); votes.set(b, v); }
const secOf = new Map([...votes].map(([b, v]) => [b, [...v].sort((a, z) => z[1] - a[1])[0][0]]));
const snap = (x: number) => +x.toPrecision(6);
const pow10 = (inc: number) => { if (!(inc > 0)) return undefined; const e = Math.log10(inc); const s = -Math.round(e); return Math.abs(e + s) < 1e-9 && s >= 0 && s <= 3 ? s : undefined; };
const variants: Record<string, (r: any) => number> = {
  final: (r) => devicePrintDecimals(r),
  nibbleOnly: (r) => ((r.typecode & 0xff) === 0x52 ? 2 : Math.min(3, r.typecode & 0xf)),
  noGuard: (r) => { if ((r.typecode & 0xff) === 0x52) return 2; let d = Math.min(3, r.typecode & 0xf); const s = pow10(r.step * r.scale); if (s !== undefined && s > d) d = s; return d; },
  stepOnly: (r) => ((r.typecode & 0xff) === 0x52 ? 2 : pow10(r.step * r.scale) ?? 2),
  fixed2: () => 2,
};
const score: Record<string, { ok: number; under: number }> = {}; let n = 0; const under: string[] = []; const over: string[] = [];
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) {
  if (c.sigFigs || c.factor !== undefined || c.scale === 'ordinal') continue;
  const p = P.get(k); const s = secOf.get(k.split('.')[0]); if (!p || s === undefined) continue;
  const r0 = rec.get(`${s}:${p.paramId}`); if (!r0 || r0.kind !== 'float') continue;
  const r = { kind: 'float' as const, displayMin: snap(r0.min * r0.def), displayMax: snap(r0.max * r0.def), scale: r0.def, step: snap(r0.step), typecode: r0.tc };
  n++;
  for (const [v, f] of Object.entries(variants)) { const d = f(r); const sc = (score[v] ??= { ok: 0, under: 0 }); if (d === c.decimals) sc.ok++; if (d < c.decimals) sc.under++; }
  const d = devicePrintDecimals(r);
  const line = `${k} rule ${d} II ${c.decimals} (tc 0x${r0.tc.toString(16)}, inc ${snap(r0.step * r0.def)}, ${r.displayMin}..${r.displayMax} ${c.unit ?? ''})`;
  if (d < c.decimals) under.push(line); else if (d > c.decimals) over.push(line);
}
console.log(`II in-device, ${n} params:`);
for (const [v, s] of Object.entries(score)) console.log(`  ${v.padEnd(10)} exact ${s.ok}/${n}, under-prints ${s.under}`);
console.log(`final rule under-prints (${under.length}):`); for (const u of under) console.log('   ' + u);
console.log(`final rule over-prints (${over.length}):`); for (const u of over) console.log('   ' + u);
