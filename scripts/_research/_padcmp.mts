/** Does the DERIVED pad (part 8) reproduce the hand-written FIG the owner already signed off? */
import { readFileSync } from 'node:fs';
import { flattenSongsterrMelodic } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
const FIG = [[0, 82, 8], [4, 70, 4], [8, 78, 8], [12, 70, 8], [16, 77, 8], [20, 70, 4], [24, 73, 4], [28, 75, 4]];
const f = flattenSongsterrMelodic(JSON.parse(readFileSync('scripts/fixtures/offering/part-8.json', 'utf8')), {});
for (const [label, from] of [['m1-2 (Intro)', 1], ['m33-34 (Preverse, "low")', 33], ['m157-158 (Outro)', 157]] as [string, number][]) {
  const a = f.measures[from - 1].startBeat, b = f.measures[from + 1].startBeat;
  const win = f.notes.filter((n) => n.beat >= a && n.beat < b);
  console.log(`\n${label}: ${win.length} notes`);
  for (const n of win) console.log(`   step ${String(Math.round((n.beat - a) * 4)).padStart(2)}  pitch ${n.pitch}  gate ${Math.round(n.durationBeats * 4)}`);
}
console.log('\nhand-written FIG (step/pitch/gate):');
for (const [s, p, g] of FIG) console.log(`   step ${String(s).padStart(2)}  pitch ${p}  gate ${g}`);
