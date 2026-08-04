/** Diagnostic: per-project-anchored window edge-crossers straight from the
 * flatten (independent of the staging script's cells-based detection). */
import { readFileSync } from 'node:fs';
import { flattenSongsterrMelodic, type SongsterrPart } from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s434040';
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const PROJECTS = [
  { name: 'Intro', from: 1, to: 10 }, { name: 'Verse', from: 11, to: 26 },
  { name: 'PreChor', from: 27, to: 40 }, { name: 'PreCh2', from: 49, to: 55 },
  { name: 'Chorus2', from: 56, to: 71 }, { name: 'BridgeA', from: 72, to: 83 },
  { name: 'BridgeB', from: 84, to: 95 }, { name: 'Outro', from: 96, to: 107 },
];
for (const id of [5, 7, 9]) {
  const m = flattenSongsterrMelodic(load(id));
  let m1grid = 0;
  for (const n of m.notes) {
    const s = Math.round(n.beat * 4); const e = s + Math.round(n.durationBeats * 4);
    if (Math.floor(s / 32) !== Math.floor((e - 1) / 32)) m1grid++;
  }
  console.log(`p${id}: m1-grid crossers=${m1grid} (facts-probe method)`);
  for (const pr of PROJECTS) {
    const startStep = (pr.from - 1) * 16;
    const endStepProj = pr.to * 16;
    const bounds: number[] = [];
    for (let st = startStep + 32; st < endStepProj; st += 32) bounds.push(st); // window edges
    const hits: string[] = [];
    for (const n of m.notes) {
      const s = Math.round(n.beat * 4); const e = s + Math.round(n.durationBeats * 4);
      if (s < startStep || s >= endStepProj) continue;
      for (const b of bounds) {
        if (s < b && e - 1 >= b) { hits.push(`m${Math.floor(s / 16) + 1} step${s} dur${e - s} crosses edge@${b}`); break; }
      }
    }
    if (hits.length > 0) console.log(`  ${pr.name}: ${hits.length} -> ${hits.join(' | ')}`);
  }
}
