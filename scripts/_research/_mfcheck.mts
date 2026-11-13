/** Before moving midi1 -> synth2 anywhere: does any project ALREADY use synth2? That would be a clobber. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getProjectName, getSynthLevel } from '../../packages/circuit-tracks/src/ncs/format.js';
const root = process.argv[2];
const count = (b: Uint8Array, t: 'synth1' | 'synth2' | 'midi1') => {
  let n = 0;
  for (let p = 0; p < 8; p++) for (const s of decodeNotePattern(b, t, p)) if (s.active) n += s.notes.length;
  return n;
};
let clobber = 0, movable = 0, s2lvl = new Map<number, number>();
const rows: string[] = [];
for (const pack of readdirSync(root).filter((p) => p.startsWith('pack'))) {
  for (const f of readdirSync(join(root, pack)).filter((x) => x.endsWith('.ncs')).sort()) {
    const b = new Uint8Array(readFileSync(join(root, pack, f)));
    if (b.length !== 160780) continue;
    const m1 = count(b, 'midi1'); if (!m1) continue;
    const s2 = count(b, 'synth2'), s1 = count(b, 'synth1');
    const lvl = getSynthLevel(b, 2);
    s2lvl.set(lvl, (s2lvl.get(lvl) ?? 0) + 1);
    if (s2 > 0) { clobber++; rows.push(`  ** CLOBBER ${pack} ${getProjectName(b)}: midi1=${m1} synth2=${s2} synth1=${s1} s2lvl=${lvl}`); }
    else movable++;
  }
}
console.log(`movable (synth2 empty): ${movable}`);
console.log(`WOULD CLOBBER (synth2 already carries notes): ${clobber}`);
rows.forEach((r) => console.log(r));
console.log(`\nstored synth2 level across the affected projects:`);
for (const [k, v] of [...s2lvl].sort((a, b2) => a[0] - b2[0])) console.log(`  level ${String(k).padStart(3)}: ${v} projects`);
