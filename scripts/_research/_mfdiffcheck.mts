/** Every byte the migration changed must fall in an INTENDED region. Anything else is collateral. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { META_OFFSETS, NOTE_STEP_REGION, noteBlockIndex, noteStepBase } from '../../packages/circuit-tracks/src/ncs/format.js';
const allowed: [number, number, string][] = [];
for (const t of ['synth2', 'midi1'] as const) {
  for (let p = 0; p < 8; p++) {
    const b = noteStepBase(t, p);
    allowed.push([b, b + NOTE_STEP_REGION - 1, `${t} p${p + 1} steps`]);
    const m = META_OFFSETS[noteBlockIndex(t, p)];
    allowed.push([m, m, `${t} p${p + 1} length`]);
  }
}
allowed.push([0x2c8, 0x2cf, 'chain slots synth2 + midi1']);
allowed.push([0x50, 0x2c0, 'scene stack (note tables)']);
const ok = (i: number) => allowed.find(([a, b]) => i >= a && i <= b);
let files = 0, bad = 0;
const outside = new Map<string, number>();
for (const pack of readdirSync('samples/circuit-ncs/mf-migrated-2026-09-20')) {
  const dir = join('samples/circuit-ncs/mf-migrated-2026-09-20', pack);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const pre = join('samples/circuit-ncs/pre-mf-migration-2026-09-20', pack, basename(f));
    if (!existsSync(pre)) continue;
    const x = new Uint8Array(readFileSync(pre)), y = new Uint8Array(readFileSync(join(dir, f)));
    files++;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      if (!ok(i)) { bad++; outside.set(`0x${i.toString(16)}`, (outside.get(`0x${i.toString(16)}`) ?? 0) + 1); }
    }
  }
}
console.log(`${files} migrated files checked against their pre-state`);
console.log(`bytes changed OUTSIDE the intended regions: ${bad}`);
if (bad) { console.log('offsets:'); for (const [k, v] of [...outside].slice(0, 20)) console.log(`  ${k} in ${v} file(s)`); }
else console.log('=> every changed byte is a synth2/midi1 note block, its length byte, their chain slots, or the scene stack.');
