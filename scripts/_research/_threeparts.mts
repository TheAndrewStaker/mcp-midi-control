/** Are synth1 / synth2 / midi1 really THREE distinct parts, or duplicates? Measure, don't assume. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getProjectName } from '../../packages/circuit-tracks/src/ncs/format.js';
import { createHash } from 'node:crypto';
type T = 'synth1' | 'synth2' | 'midi1';
const prof = (b: Uint8Array, t: T) => {
  const notes: number[] = []; let poly = 0; const sig: string[] = [];
  for (let p = 0; p < 8; p++) for (const [i, s] of decodeNotePattern(b, t, p).entries()) {
    if (!s.active) continue;
    poly = Math.max(poly, s.notes.length);
    for (const n of s.notes) notes.push(n.note - 12);
    sig.push(`${p}:${i}:${s.notes.map((n) => n.note).sort().join(',')}`);
  }
  if (!notes.length) return undefined;
  return { n: notes.length, lo: Math.min(...notes), hi: Math.max(...notes), poly,
           hash: createHash('sha256').update(sig.join('|')).digest('hex').slice(0, 10) };
};
const NAMES = process.argv.slice(3);
for (const pack of readdirSync(process.argv[2]).filter((p) => p.startsWith('pack'))) {
  for (const f of readdirSync(join(process.argv[2], pack)).filter((x) => x.endsWith('.ncs')).sort()) {
    const b = new Uint8Array(readFileSync(join(process.argv[2], pack, f)));
    if (b.length !== 160780) continue;
    const nm = getProjectName(b);
    if (NAMES.length && !NAMES.some((x) => nm.includes(x))) continue;
    const s1 = prof(b, 'synth1'), s2 = prof(b, 'synth2'), m1 = prof(b, 'midi1');
    if (!m1 || !s2) continue;
    const fmt = (x: typeof s1) => (x ? `${String(x.n).padStart(3)}n ${String(x.lo).padStart(3)}-${String(x.hi).padStart(3)} poly${x.poly} ${x.hash}` : '        -            ');
    const dup = s1 && s2 && s1.hash === s2.hash ? ' s1==s2'
      : s2.hash === m1.hash ? ' **s2==midi1 DUPLICATE**' : '';
    console.log(`${(pack + ' ' + nm).padEnd(30)} synth1 ${fmt(s1)} | synth2 ${fmt(s2)} | midi1 ${fmt(m1)}${dup}`);
  }
}
