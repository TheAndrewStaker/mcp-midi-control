/** Decode representative drum bars + section boundaries for No Diggity s287014. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  flattenSongsterrDrums, type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const dir = 'samples/songsterr-cache/s287014';
const drums = flattenSongsterrDrums(
  JSON.parse(readFileSync(join(dir, 'part-2.json'), 'utf8')) as SongsterrPart);

const measures = drums.measures;
const barOf = (beat: number): number => {
  let lo = 0;
  for (let i = 0; i < measures.length; i++) if (beat >= measures[i].startBeat - 1e-6) lo = i;
  return lo;
};

// per-bar step grids
const grids: Map<number, string[]>[] = Array.from({ length: measures.length }, () => new Map());
for (const e of drums.events) {
  const m = barOf(e.beat);
  const step = Math.round((e.beat - measures[m].startBeat) * 4);
  const g = grids[m];
  if (!g.has(step)) g.set(step, []);
  g.get(step)!.push(e.voice ?? '?');
}
const render = (m: number): string => {
  const g = grids[m];
  const cells: string[] = [];
  for (let s = 0; s < 16; s++) cells.push(g.has(s) ? g.get(s)!.map((v) => v[0] === 'o' ? 'O' : v[0]).sort().join('') : '.');
  return cells.join(' ');
};
const sig = (m: number): string => render(m);
const seen = new Map<string, { letter: string; bars: number[] }>();
for (let m = 0; m < measures.length; m++) {
  const s = sig(m);
  if (!seen.has(s)) seen.set(s, { letter: s.replace(/[^a-zA-Z]/g, '') === '' ? '.' : String.fromCharCode(65 + [...seen.values()].filter((x) => x.letter !== '.').length), bars: [] });
  seen.get(s)!.bars.push(m + 1);
}
console.log('=== DISTINCT DRUM BARS (k=kick s=snare h=hat; step grid 0-15) ===');
for (const [s, info] of seen.entries()) {
  const b = info.bars;
  const rangeStr = b.length > 8 ? `${b.length} bars incl m${b[0]},m${b[1]}...` : `m${b.join(',m')}`;
  console.log(`  [${info.letter}] ${s}   (${rangeStr})`);
}
