/**
 * ii-label-score.ts: report how the Axe-Fx II display calibration scores
 * against the device's own labels (scoring rules: scripts/_lib/ii-label-score.ts).
 *
 *   npx tsx scripts/_research/ii-label-score.ts [a.jsonl,b.jsonl] [--json out.json] [--list]
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { samplesFromJsonl, scoreLabels } from '../_lib/ii-label-score.js';

const corpus = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'samples/captured/ii-label-sweep.jsonl';
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : undefined;
const LIST = process.argv.includes('--list');

const samples = samplesFromJsonl(corpus.split(',').map((f) => readFileSync(f, 'utf8')).join('\n'));
const s = scoreLabels(samples);
if (LIST) {
  for (const [k, st] of [...s.perKey.entries()].sort()) {
    if (st.ok === st.n && st.unitOk && st.writeBad === 0) continue;
    console.log(`${k} [${st.source}, unit ${st.unit} vs "${st.labelUnit}"] ${st.ok}/${st.n} ok, ${st.writeBad} write-bad${st.bad.length ? ': ' + st.bad.slice(0, 4).join('; ') : ''}`);
  }
}
console.log(`samples ${s.samples} | value ok ${s.valueOk} bad ${s.valueBad} | enum ok ${s.enumOk} bad ${s.enumBad} | opaque ${s.opaque} | write-bad ${s.writeBad}`);
console.log(`params ${s.params} | all-samples-ok ${s.paramsAllOk} | unit mismatch ${s.unitMismatch}`);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(Object.fromEntries([...s.perKey.entries()].map(([k, st]) => [k, { n: st.n, ok: st.ok, unitOk: st.unitOk, writeBad: st.writeBad, source: st.source }])), null, 1));
}
