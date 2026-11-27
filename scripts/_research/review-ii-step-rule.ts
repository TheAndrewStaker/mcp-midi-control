/**
 * review-ii-step-rule.ts (review scratch, read-only): test the gen-3
 * devicePrintDecimals rule IN-DEVICE on the Axe-Fx II, the one Fractal unit
 * where both an editor-cache step and the device's own printed decimals exist.
 * Block -> cache section comes from II calibration entries fitted to a cache
 * record ("from: cache/sN"); records are (section, paramId) from the Axe-Edit
 * II effectDefinitions walk. display increment = step * def (def = scale).
 */
import { readFileSync } from 'node:fs';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
import { KNOWN_PARAMS } from 'fractal-midi/gen2/axe-fx-ii';
import { devicePrintDecimals } from '@mcp-midi-control/fractal-gen3/catalog.js';

const walk = JSON.parse(readFileSync('samples/captured/local-caches-2026-06-09/effectDefinitions_07.walk.json', 'utf8')) as { records: Array<{ kind: string; section: number; id: number; tc: number; min: number; max: number; def: number; step: number }> };
const rec = new Map<string, (typeof walk.records)[number]>();
for (const r of walk.records) rec.set(`${r.section}:${r.id}`, r);
const P = new Map(Object.values(KNOWN_PARAMS as Record<string, { block: string; name: string; paramId: number }>).map((p) => [`${p.block}.${p.name}`, p]));
const secVotes = new Map<string, Map<number, number>>();
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) {
  const m = /^cache\/s(\d+)$/.exec(c.from); if (!m) continue;
  const blk = k.split('.')[0]; const v = secVotes.get(blk) ?? new Map(); v.set(+m[1], (v.get(+m[1]) ?? 0) + 1); secVotes.set(blk, v);
}
const secOf = new Map([...secVotes].map(([b, v]) => [b, [...v].sort((a, z) => z[1] - a[1])[0][0]]));
const snap = (x: number) => +x.toPrecision(6);
let n = 0, ruleOk = 0, fixed2 = 0, everyOk = 0; const byInc: Record<string, { n: number; ok: number; ii: Record<number, number> }> = {};
for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) {
  if (c.sigFigs || c.factor !== undefined || c.scale === 'ordinal') continue;
  const p = P.get(k); const sec = secOf.get(k.split('.')[0]); if (!p || sec === undefined) continue;
  const r = rec.get(`${sec}:${p.paramId}`); if (!r || r.kind !== 'float') continue;
  n++;
  const row = { kind: 'float' as const, displayMin: r.min * r.def, displayMax: r.max * r.def, scale: r.def, step: snap(r.step), typecode: r.tc };
  const rule = devicePrintDecimals(row);
  if (rule === c.decimals) ruleOk++;
  if (c.decimals === 2) fixed2++;
  const inc = snap(r.step * r.def);
  const every = inc > 0 ? Math.min(3, Math.max(0, Math.round(-Math.log10(inc) + 0.49))) : 2;
  if (every === c.decimals) everyOk++;
  const key = `inc ${inc}${(r.tc & 0xff) === 0x52 ? ' (0x52)' : ''}`;
  const b = (byInc[key] ??= { n: 0, ok: 0, ii: {} }); b.n++; if (rule === c.decimals) b.ok++; b.ii[c.decimals] = (b.ii[c.decimals] ?? 0) + 1;
}
console.log(`II in-device test: ${n} params joined to their own cache record (${secOf.size} blocks)`);
console.log(`  exact decimals: shipped rule ${ruleOk}/${n}, fixed 2 dp ${fixed2}/${n}`);
for (const [k, v] of Object.entries(byInc).sort((a, b) => b[1].n - a[1].n).slice(0, 20)) console.log(`  ${k.padEnd(22)} n=${v.n} rule-exact ${v.ok}  II prints ${JSON.stringify(v.ii)}`);

// detail: step-1 rows (rule -> 0 dp)
if (process.argv.includes('--inc1')) {
  for (const [k, c] of Object.entries(DEVICE_LABEL_CALIBRATION)) {
    if (c.sigFigs || c.factor !== undefined || c.scale === 'ordinal') continue;
    const p = P.get(k); const sec = secOf.get(k.split('.')[0]); if (!p || sec === undefined) continue;
    const r = rec.get(`${sec}:${p.paramId}`); if (!r || r.kind !== 'float') continue;
    if (snap(r.step * r.def) !== 1) continue;
    console.log(`   ${k} II ${c.decimals} dp, ${c.scale} ${c.displayMin}..${c.displayMax} ${c.unit ?? ''} (cache ${snap(r.min * r.def)}..${snap(r.max * r.def)} tc 0x${r.tc.toString(16)})`);
  }
}
