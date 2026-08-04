import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { decomposeToPatterns, coalescePatterns } from '../../packages/core/src/protocol-generic/patterns/songStructure.js';
const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s23527';
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const drums = flattenSongsterrDrums(load(6));
const decomp = decomposeToPatterns(drums.events, { stepsPerPattern: 32, stepsPerBeat: 4, totalBeats: 77 * 4 });
const render = (q: any) => Object.entries(q.voices).map(([v, st]: any) => `${v}:${st.map((s: any) => s.on ? 'x' : '.').join('')}`).filter((r) => /x/.test(r)).sort().join('  ');
for (const md of [0.05, 0.10]) {
  const co = coalescePatterns(decomp, { maxDistance: md });
  console.log(`\n### maxDistance ${md}: ${co.clusters.length} clusters, variantCounts [${co.clusters.map(c=>c.variantCount).join(',')}]`);
  for (const w of [3, 10, 11]) {
    const ci = co.order[w]; const cl = co.clusters[ci];
    console.log(` window ${w} (bars ${w*2+1}-${w*2+2}) -> cluster ${ci} (members ${cl.members.length}, exact variants ${cl.variantCount})`);
    console.log(`   ORIGINAL: ${render(decomp.windows[w])}`);
    console.log(`   MEDOID  : ${render(cl.pattern)}`);
    console.log(`   ${render(decomp.windows[w]) === render(cl.pattern) ? 'PRESERVED' : '>>> FLATTENED: this window is not what plays <<<'}`);
  }
}
