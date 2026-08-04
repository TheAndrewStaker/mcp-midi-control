import { readFileSync } from 'node:fs';
import { flattenSongsterrMelodic, type SongsterrPart } from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const CACHE = 'samples/songsterr-cache/s434040';
const part = (n: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${n}.json`, 'utf8')) as SongsterrPart;
const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const name = (p: number): string => NAMES[p % 12] + (Math.floor(p / 12) - 1);

const m9 = flattenSongsterrMelodic(part(9));
console.log('p9 first notes (beat<44):');
for (const n of m9.notes.filter((n) => n.beat < 44)) {
  console.log(`  beat ${n.beat} m${Math.floor(n.beat / 4) + 1} ${name(n.pitch)} dur ${n.durationBeats} beats vel ${n.velocity ?? '(default)'}`);
}
const m7 = flattenSongsterrMelodic(part(7));
const lo7 = Math.min(...m7.notes.map((n) => n.pitch)); const hi7 = Math.max(...m7.notes.map((n) => n.pitch));
console.log(`p7 range ${name(lo7)}..${name(hi7)} (${lo7}..${hi7})`);
const m5 = flattenSongsterrMelodic(part(5));
const lo5 = Math.min(...m5.notes.map((n) => n.pitch)); const hi5 = Math.max(...m5.notes.map((n) => n.pitch));
console.log(`p5 range ${name(lo5)}..${name(hi5)} (${lo5}..${hi5})`);
const lo9 = Math.min(...m9.notes.map((n) => n.pitch)); const hi9 = Math.max(...m9.notes.map((n) => n.pitch));
console.log(`p9 range ${name(lo9)}..${name(hi9)} (${lo9}..${hi9}); notes crossing 2-bar edges (dur>8 steps or offbeat-held):`);
let crossers = 0;
for (const n of m9.notes) {
  const startStep = Math.round(n.beat * 4); const endStep = startStep + Math.round(n.durationBeats * 4);
  if (Math.floor(startStep / 32) !== Math.floor((endStep - 1) / 32)) { crossers++; }
}
console.log('p9 window-edge crossers:', crossers);
for (const [id, m] of [[5, m5], [7, m7]] as const) {
  let c = 0;
  for (const n of m.notes) {
    const s = Math.round(n.beat * 4); const e = s + Math.round(n.durationBeats * 4);
    if (Math.floor(s / 32) !== Math.floor((e - 1) / 32)) c++;
  }
  console.log(`p${id} window-edge crossers:`, c);
}
