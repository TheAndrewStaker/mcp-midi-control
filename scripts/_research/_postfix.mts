/** Post-fix verification: scenes cleared, no duplicate SPD notes, base samples sane. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getSceneNoteChain, getSceneDrumChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';
const d = process.argv[2];
let dupes = 0, scenes = 0, files = 0;
for (const f of readdirSync(d).filter((x) => x.endsWith('.ncs')).sort()) {
  files++;
  const b = new Uint8Array(readFileSync(join(d, f)));
  for (let s = 0; s < 16; s++) {
    if (getSceneNoteChain(b, s, 'synth1') !== undefined) scenes++;
    if (getSceneDrumChain(b, 0, s) !== undefined) scenes++;
  }
  for (let p = 0; p < 8; p++) for (const st of decodeNotePattern(b, 'midi2', p)) {
    if (!st.active) continue;
    const seen = new Set<number>();
    for (const n of st.notes) { if (seen.has(n.note)) dupes++; seen.add(n.note); }
  }
}
console.log(`${files} files | defined scenes remaining: ${scenes} | duplicate midi2 note-ons: ${dupes}`);
console.log(`0x2c1 (scene chain end) across files:`, readdirSync(d).filter((x) => x.endsWith('.ncs'))
  .map((f) => new Uint8Array(readFileSync(join(d, f)))[0x2c1]).join(','));
