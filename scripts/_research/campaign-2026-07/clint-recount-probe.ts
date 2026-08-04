/**
 * Clint Eastwood union-keying sensitivity recount (plan-time, READ-ONLY).
 * Re-runs the window census of clint-facts-probe.ts under three keyings to
 * make sure the 40-cell / 10-project verdict is not an artifact:
 *   K1 exact (beats at 1/100 step, velocities, durations)  [= facts probe]
 *   K2 grid  (onsets snapped to the 16th step, velocities, durations kept)
 *   K3 gridVelBlind (K2 minus velocities)  [lower bound sanity only]
 * Also enumerates every ADJACENT section-pair merge under K2: union cells,
 * plays, minimal contiguous-ascending scene runs (first-use slot order).
 *
 * Run: npx tsx samples/_scratch/clint-recount-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s8562';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const t6f = flattenSongsterrMelodic(loadPart(6));
const t11f = flattenSongsterrMelodic(loadPart(11));
const t12f = flattenSongsterrMelodic(loadPart(12));
const t14f = flattenSongsterrDrums(loadPart(14));
const t15f = flattenSongsterrDrums(loadPart(15));
const measures = t14f.measures;
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];

interface Ev { beat: number; voice: string; vel: string; dur: string }
const mel = (fl: ReturnType<typeof flattenSongsterrMelodic>): Ev[] =>
  fl.notes.map((n) => ({ beat: n.beat, voice: String(n.pitch), vel: String(n.velocity ?? 'd'), dur: String(n.durationBeats) }));
const drm = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] =>
  fl.events.map((e) => ({ beat: e.beat, voice: e.voice, vel: String(e.velocity ?? 'd'), dur: '' }));
const LANES: Array<[string, Ev[]]> = [
  ['s1', mel(t6f)], ['s2', mel(t11f)], ['m1', mel(t12f)], ['m2', [...drm(t14f), ...drm(t15f)]],
];

const SECTIONS: Array<{ name: string; from: number; to: number }> = [
  { name: 'Intro', from: 1, to: 15 }, { name: 'V1', from: 16, to: 31 },
  { name: 'C1', from: 32, to: 41 }, { name: 'V2', from: 42, to: 57 },
  { name: 'C2', from: 58, to: 67 }, { name: 'S1a', from: 68, to: 78 },
  { name: 'S1b', from: 79, to: 88 }, { name: 'S2', from: 89, to: 103 },
  { name: 'S3', from: 104, to: 117 }, { name: 'Outro', from: 118, to: 123 },
];
interface Win { sec: string; bars: number[] }
const wins: Win[] = [];
for (const s of SECTIONS) {
  for (let m = s.from; m <= s.to; m += 2) wins.push({ sec: s.name, bars: m + 1 <= s.to ? [m, m + 1] : [m] });
}

type Key = (e: Ev, b0: number) => string;
const K1: Key = (e, b0) => `${Math.round((e.beat - b0) * 400) / 400}:${e.voice}@${e.vel}:${e.dur}`;
const K2: Key = (e, b0) => `${Math.round((e.beat - b0) * 4)}:${e.voice}@${e.vel}:${e.dur}`;
const K3: Key = (e, b0) => `${Math.round((e.beat - b0) * 4)}:${e.voice}:${e.dur}`;

function census(key: Key, label: string, print: boolean): { letters: string[]; perSec: Map<string, string[]> } {
  const barSig = (evs: Ev[], mi1: number): string => {
    const b0 = barStart(mi1 - 1); const b1 = b0 + barLen(mi1 - 1);
    return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9).map((e) => key(e, b0)).sort().join(',');
  };
  const reg = new Map<string, string>();
  const letters: string[] = [];
  const perSec = new Map<string, string[]>();
  for (const w of wins) {
    const sig = `${w.bars.length}|` + LANES.map(([, evs]) => w.bars.map((b) => barSig(evs, b)).join(';')).join('||');
    let l = reg.get(sig);
    if (!l) { const n = reg.size; l = n < 26 ? String.fromCharCode(65 + n) : `a${n - 26}`; reg.set(sig, l); }
    letters.push(l);
    if (!perSec.has(w.sec)) perSec.set(w.sec, []);
    perSec.get(w.sec)!.push(l);
  }
  if (print) {
    console.log(`\n== ${label}: ${reg.size} distinct union cells over ${wins.length} windows`);
    for (const [sec, ls] of perSec) console.log(`   ${sec}: ${ls.join(' ')}  (${new Set(ls).size} cells, ${ls.length} plays)`);
  }
  return { letters, perSec };
}

const k1 = census(K1, 'K1 exact', true);
const k2 = census(K2, 'K2 grid-snapped', true);
census(K3, 'K3 grid + velocity-blind (sanity only)', true);

// adjacent-pair merge feasibility under K2
console.log('\n== adjacent-pair merges under K2 (need cells<=8 AND (plays<=8 OR runs<=4))');
function minRuns(order: string[]): number {
  const slot = new Map<string, number>();
  for (const l of order) if (!slot.has(l)) slot.set(l, slot.size + 1);
  const s = order.map((l) => slot.get(l)!);
  // greedy maximal ascending-contiguous runs (optimal for this decomposition problem)
  let runs = 0; let i = 0;
  while (i < s.length) { runs++; let j = i + 1; while (j < s.length && s[j] === s[j - 1] + 1) j++; i = j; }
  return runs;
}
const secNames = SECTIONS.map((s) => s.name);
for (let i = 0; i + 1 < secNames.length; i++) {
  const a = k2.perSec.get(secNames[i])!; const b = k2.perSec.get(secNames[i + 1])!;
  const order = [...a, ...b];
  const cells = new Set(order).size;
  const runs = minRuns(order);
  const fits = cells <= 8 && (order.length <= 8 || runs <= 4);
  console.log(`   ${secNames[i]}+${secNames[i + 1]}: cells=${cells} plays=${order.length} sceneRuns=${runs} -> ${fits ? 'FITS' : 'no'}`);
}
// single sections
console.log('\n== single sections under K2');
for (const s of secNames) {
  const o = k2.perSec.get(s)!;
  const cells = new Set(o).size; const runs = minRuns(o);
  console.log(`   ${s}: cells=${cells} plays=${o.length} sceneRuns=${runs} -> ${cells <= 8 && (o.length <= 8 || runs <= 4) ? 'fits ONE project' : 'NEEDS SPLIT'}`);
}
