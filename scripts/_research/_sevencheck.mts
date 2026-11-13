/** The 7 "[0,0] on every track" projects: what content do they hold, and what do their scenes say? */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getProjectName } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneNoteChain, getSceneDrumChain, getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';
const T = ['synth1', 'synth2', 'midi1', 'midi2'] as const;
const CH = 0x2c4;
for (const [dir, pat] of [
  ['mf-migrated-2026-09-20/pack1', /project(10|11|63)-/],
  ['reverb-lane-2026-09-20/pack3', /project58-/],
  ['mf-migrated-2026-09-20/pack2', /project(04|16|18)-/],
] as [string, RegExp][]) {
  for (const f of readdirSync(`samples/circuit-ncs/${dir}`).filter((x) => pat.test(x)).sort()) {
    const b = new Uint8Array(readFileSync(join(`samples/circuit-ncs/${dir}`, f)));
    const content: Record<string, number[]> = {};
    for (const t of T) {
      const ps: number[] = [];
      for (let p = 0; p < 8; p++) if (decodeNotePattern(b, t, p).some((s) => s.active)) ps.push(p);
      if (ps.length) content[t] = ps;
    }
    const dps: number[] = [];
    for (let p = 0; p < 8; p++) if ([0, 1, 2, 3].some((dt) => decodeDrumPattern(b, dt, p).some((c) => c.active))) dps.push(p);
    if (dps.length) content.drums = dps;
    const scenes: string[] = [];
    for (let s = 0; s < 4; s++) {
      const n = getSceneNoteChain(b, s, 'synth2'); const d = getSceneDrumChain(b, s, 0);
      if (n || d) scenes.push(`S${s + 1}:${n ? `s2[${n.start},${n.end}]` : ''}${d ? `d[${d.start},${d.end}]` : ''}`);
    }
    console.log(`${getProjectName(b).padEnd(20)} chainEnd=${getSceneChainEnd(b) ?? '-'}  plainChain synth2[${b[CH + 4]},${b[CH + 5]}] drums[${b[CH + 16]},${b[CH + 17]}]`);
    console.log(`   content: ${Object.entries(content).map(([k, v]) => `${k} p${v.map((x) => x + 1).join(',')}`).join(' | ')}`);
    console.log(`   scenes : ${scenes.join('  ') || '(none defined)'}`);
  }
}
