import { ROSTER } from '../../scripts/_lib/circuit-card-roster.js';
import { readFileSync, readdirSync } from 'node:fs';
import { getProjectName } from '../../packages/circuit-tracks/src/ncs/format.js';
const dir = 'samples/circuit-ncs/surgical-pass-verify-2026-07-30/final-1';
const slots = [19,20,21,22,23,24,25,35,36,37,38,39,57,58,59,60,61,62,63];
let bad = 0;
for (const s of slots) {
  const h = readdirSync(dir).filter((f) => new RegExp(`-project${s}-`).test(f)).sort();
  const dev = getProjectName(readFileSync(`${dir}/${h[h.length - 1]}`));
  const r = (ROSTER as Record<string, { name: string } | undefined>)[`5:${s}`];
  if (r === undefined || r.name !== dev) { bad++; console.log(`slot ${s}: roster "${r?.name ?? 'MISSING'}" vs device "${dev}"  MISMATCH`); }
}
console.log(bad === 0 ? 'roster names match the device on all 19/19' : `${bad} mismatch(es)`);
