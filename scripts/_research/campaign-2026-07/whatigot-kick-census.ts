/**
 * What I Got p15 COMPLETE drum-number census, with staff positions (string)
 * and rhythmic placement, to arbitrate the kick question. READ-ONLY.
 * Also dumps t14's per-number census for cross-part corroboration.
 * Run: npx tsx samples/_scratch/whatigot-kick-census.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s211';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

interface RawNote { fret?: number; string?: number; rest?: boolean; ghost?: boolean }
interface RawPart { measures: Array<{ voices: Array<{ beats: Array<{ notes?: RawNote[]; duration: [number, number] }> }> }> }

function census(id: number, label: string): void {
  const raw = loadPart(id) as unknown as RawPart;
  // fret -> { count, strings, ghosts }
  const byFret = new Map<number, { count: number; strings: Map<number, number>; ghosts: number }>();
  for (const m of raw.measures) for (const v of m.voices) for (const b of v.beats) for (const n of b.notes ?? []) {
    if (n.rest === true || typeof n.fret !== 'number') continue;
    const e = byFret.get(n.fret) ?? { count: 0, strings: new Map(), ghosts: 0 };
    e.count++;
    if (typeof n.string === 'number') e.strings.set(n.string, (e.strings.get(n.string) ?? 0) + 1);
    if (n.ghost === true) e.ghosts++;
    byFret.set(n.fret, e);
  }
  console.log(`\n${label} COMPLETE number census (number: hits, staff position(s), ghosts):`);
  for (const [f, e] of [...byFret.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const strings = [...e.strings.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} x${n}`).join(', ');
    console.log(`  ${f}: ${e.count} hits, staff pos ${strings}, ghosts ${e.ghosts}`);
  }
}
census(15, 't15 Drum Programming');
census(14, 't14 Drums (kit)');

// Rhythmic placement per number in t15, via marker-voice flatten
const t15 = flattenSongsterrDrums(loadPart(15), { drumMap: { 27: 'claves', 28: 'maracas' } });
const measures = t15.measures;
function placement(voice: string, label: string): void {
  const hist = new Map<number, { n: number; v90: number; ghost: number }>();
  for (const e of t15.events.filter((x) => x.voice === voice)) {
    const mi = measures.findIndex((m, i) => e.beat >= m.startBeat - 1e-9
      && (i + 1 >= measures.length || e.beat < measures[i + 1].startBeat - 1e-9));
    const step = Math.round(((e.beat - measures[mi].startBeat) * 4) * 4) / 4; // quarter-step resolution
    const h = hist.get(step) ?? { n: 0, v90: 0, ghost: 0 };
    h.n++; if (e.velocity === 90) h.v90++; if (e.ghost === true) h.ghost++;
    hist.set(step, h);
  }
  console.log(`\n${label} in-bar 16th-step placement (step: total/v90/ghost):`);
  console.log('  ' + [...hist.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, h]) => `${s}: ${h.n}/${h.v90}/${h.ghost}`).join('   '));
}
placement('claves', 't15 number 27');
placement('maracas', 't15 number 28');

// t14 kick lane placement for the side-by-side
const t14 = flattenSongsterrDrums(loadPart(14));
const hist14 = new Map<number, number>();
for (const e of t14.events.filter((x) => x.voice === 'kick')) {
  const mi = t14.measures.findIndex((m, i) => e.beat >= m.startBeat - 1e-9
    && (i + 1 >= t14.measures.length || e.beat < t14.measures[i + 1].startBeat - 1e-9));
  const step = Math.round(((e.beat - t14.measures[mi].startBeat) * 4) * 4) / 4;
  hist14.set(step, (hist14.get(step) ?? 0) + 1);
}
console.log('\nt14 KICK lane in-bar 16th-step placement (step: hits):');
console.log('  ' + [...hist14.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}: ${n}`).join('   '));

// GM 42 hat placement in t15 (to show 27 is NOT just more hat)
const t15gm = flattenSongsterrDrums(loadPart(15));
const hist42 = new Map<number, number>();
for (const e of t15gm.events.filter((x) => x.voice === 'hat')) {
  const mi = measures.findIndex((m, i) => e.beat >= m.startBeat - 1e-9
    && (i + 1 >= measures.length || e.beat < measures[i + 1].startBeat - 1e-9));
  const step = Math.round(((e.beat - measures[mi].startBeat) * 4) * 4) / 4;
  hist42.set(step, (hist42.get(step) ?? 0) + 1);
}
console.log('\nt15 GM-42 hat placement (step: hits):');
console.log('  ' + [...hist42.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}: ${n}`).join('   '));
