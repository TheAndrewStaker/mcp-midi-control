/** Does anything on the card depend on WHICH audio input is which? Reverb sends + levels per lane. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reverbSendOffset, getProjectName, MIXER_AUDIO1_LEVEL_INFERRED, MIXER_AUDIO2_LEVEL_INFERRED } from '../../packages/circuit-tracks/src/ncs/format.js';
let a1rev = 0, a2rev = 0, a1lvl = new Map<number, number>(), a2lvl = new Map<number, number>(), n = 0;
const hits: string[] = [];
for (const pack of readdirSync(process.argv[2]).filter((p) => p.startsWith('pack'))) {
  for (const f of readdirSync(join(process.argv[2], pack)).filter((x) => x.endsWith('.ncs'))) {
    const b = new Uint8Array(readFileSync(join(process.argv[2], pack, f)));
    if (b.length !== 160780) continue;
    n++;
    const r1 = b[reverbSendOffset('audio1')], r2 = b[reverbSendOffset('audio2')];
    if (r1) { a1rev++; hits.push(`  ${pack} ${getProjectName(b)}: audio1 reverb send = ${r1}`); }
    if (r2) { a2rev++; hits.push(`  ${pack} ${getProjectName(b)}: audio2 reverb send = ${r2}`); }
    const l1 = b[MIXER_AUDIO1_LEVEL_INFERRED], l2 = b[MIXER_AUDIO2_LEVEL_INFERRED];
    a1lvl.set(l1, (a1lvl.get(l1) ?? 0) + 1); a2lvl.set(l2, (a2lvl.get(l2) ?? 0) + 1);
  }
}
console.log(`${n} projects scanned`);
console.log(`audio1 lane with a non-zero reverb send: ${a1rev}`);
console.log(`audio2 lane with a non-zero reverb send: ${a2rev}`);
hits.slice(0, 15).forEach((h) => console.log(h));
console.log(`\nstored audio1 level distribution: ${[...a1lvl].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`stored audio2 level distribution: ${[...a2lvl].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
