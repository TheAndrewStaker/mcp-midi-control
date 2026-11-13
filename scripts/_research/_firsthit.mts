import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { getProjectName } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneDrumChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';
const POOL: Record<number, string> = { 6: '06_open_hat.wav', 7: '07_open_hat2.wav', 9: '09_crash.wav  <- KIT 40 CRASH', 8: '08_ride.wav', 48: '48_80s_2_01_kick.wav', 50: '50_80s_2_02_snare.wav', 52: '52_80s_1_03_hatC.wav', 56: '56_80s_2_05_ride.wav', 57: '57_80s_2_03_crash.wav', 58: '58_80s_2_04_tom.wav' };
const dir = 'samples/circuit-ncs/drums-up-2026-09-16/staged/pack1';
const f = readdirSync(dir).find((x) => /project0*5-/.test(x))!;
const buf = new Uint8Array(readFileSync(join(dir, f)));
const b = getDrumSampleBinding(buf);
console.log(`${getProjectName(buf)}  binding = [${b.map((s) => POOL[s] ?? `slot${s}`).join(', ')}]`);
const first = getSceneDrumChain(buf, 0);
console.log('scene 1 drum chain:', JSON.stringify(first));
const p0 = first?.start ?? 0;
console.log(`\npattern ${p0 + 1}, first 4 steps of every lane:`);
for (let t = 0; t < 4; t++) {
  const rows = decodeDrumPattern(buf, t, p0);
  const hits = rows.map((r, i) => ({ i, r })).filter((x) => x.r.active).slice(0, 4);
  for (const h of hits) {
    const slot = h.r.drumChoice !== 0xff ? h.r.drumChoice : b[t];
    console.log(`  D${t + 1} step ${h.i + 1}: ${POOL[slot] ?? `slot${slot}`}  vel ${h.r.velocity}`);
  }
}
