/** Phase 5: verify fix-option window packings fit 8 slots. Read-only. */
import { readFileSync } from 'node:fs';
import { flattenSongsterrMelodic, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { packPatternsOnBarLines } from '../../packages/core/src/protocol-generic/patterns/songChop.js';

const part2 = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/songsterr-cache/s6700/part-2.json', 'utf8')) as SongsterrPart;
const measures = flattenSongsterrMelodic(part2).measures;
const show = (label: string, from: number, to: number): void => {
  const w = packPatternsOnBarLines(measures, from - 1, to - 1, 4, 32);
  console.log(`${label} m${from}-${to}: ${w.length} windows [${w.map((x) => x.steps).join(',')}] ` +
    `(${w.map((x) => `m${x.from_measure}${x.to_measure !== x.from_measure ? '-' + x.to_measure : ''}`).join(' ')})${w.length > 8 ? '  <<< OVER 8' : ''}`);
};
// Option C boundary-shifted interludes
show('Int1  C', 118, 137);
show('Int2  C', 138, 157);
show('Int3  C', 158, 174);
show('Int4  C', 175, 191);
// Option A tail-extension shapes (what the final pattern becomes)
show('17 A last', 135, 137);
show('18 A last', 154, 156);
// Out1/Out2 re-author
show('Out1  C', 214, 227);
show('Out2  C', 228, 238);
