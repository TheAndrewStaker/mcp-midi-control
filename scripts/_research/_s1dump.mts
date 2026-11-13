/** Where exactly does synth1 (the Hydrasynth) enter, per pattern, in a stored project? */
import { readFileSync } from 'node:fs';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getSynthLevel, getProjectName } from '../../packages/circuit-tracks/src/ncs/format.js';
const b = new Uint8Array(readFileSync(process.argv[2]));
console.log(`"${getProjectName(b)}"  synth1 stored level=${getSynthLevel(b, 1)}  synth2=${getSynthLevel(b, 2)}`);
const CH = 0x2c4;
console.log(`chain: synth1 [${b[CH]},${b[CH + 1]}]  synth2 [${b[CH + 4]},${b[CH + 5]}]  midi1 [${b[CH + 8]},${b[CH + 9]}]  midi2 [${b[CH + 12]},${b[CH + 13]}]`);
for (let p = 0; p < 8; p++) {
  const s1 = decodeNotePattern(b, 'synth1', p);
  const on = s1.map((s, i) => (s.active ? `${i}:${s.notes.map((n) => `${n.note}(snd ${n.note - 12}) g${n.gate}`).join(',')}` : '')).filter(Boolean);
  const bars = `bars ${p * 2 + 1}-${p * 2 + 2}`;
  console.log(`  pattern ${p + 1} (${bars}): ${on.length ? `${on.length} steps | ${on.slice(0, 3).join('  ')}${on.length > 3 ? ' ...' : ''}` : '(silent)'}`);
}
