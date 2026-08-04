/** Decode specific bar windows of s287014 for the plan: bass m41-44 (drop), m73-76 (bridge figure), gtr m65-72, drums m93-96 + m121-128. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const dir = 'samples/songsterr-cache/s287014';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(join(dir, `part-${id}.json`), 'utf8')) as SongsterrPart;
const bass = flattenSongsterrMelodic(load(1));
const gtr = flattenSongsterrMelodic(load(0));
const drums = flattenSongsterrDrums(load(2));
const measures = bass.measures;
const barOf = (beat: number): number => {
  let lo = 0;
  for (let i = 0; i < measures.length; i++) if (beat >= measures[i].startBeat - 1e-6) lo = i;
  return lo;
};
function show(tag: string, notes: { beat: number; pitch: number; durationBeats: number }[], from: number, to: number): void {
  console.log(`--- ${tag} m${from}-${to} ---`);
  for (const n of notes) {
    const m = barOf(n.beat) + 1;
    if (m < from || m > to) continue;
    const off = n.beat - measures[m - 1].startBeat;
    console.log(`  m${m} b${off.toFixed(2)}: ${pitchToken(n.pitch)}:${n.durationBeats.toFixed(2)}`);
  }
}
show('BASS drop', bass.notes, 41, 44);
show('BASS bridge OPQR', bass.notes, 73, 76);
show('GTR bridge', gtr.notes, 65, 76);
console.log('--- DRUMS m93-96, m117-128 (step:voices) ---');
for (const mm of [93, 94, 95, 96, 117, 121, 122, 125]) {
  const g: string[] = Array.from({ length: 16 }, () => '.');
  for (const e of drums.events) {
    const m = barOf(e.beat) + 1;
    if (m !== mm) continue;
    const step = Math.round((e.beat - measures[m - 1].startBeat) * 4);
    g[step] = g[step] === '.' ? (e.voice ?? '?')[0] : g[step] + (e.voice ?? '?')[0];
  }
  console.log(`  m${mm}: ${g.join(' ')}`);
}
// last bars: how does the song end?
show('BASS end', bass.notes, 129, 133);
