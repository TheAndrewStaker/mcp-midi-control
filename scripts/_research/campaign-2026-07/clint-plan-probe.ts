/**
 * Clint Eastwood project-count exploration (plan-time, READ-ONLY).
 * Uses the K2 grid-snapped union letters from clint-recount-probe.ts logic.
 *  1. Greedy content-driven chunking over the whole 63-window order
 *     (the planProjects default: cells<=8 AND (plays<=8 OR sceneRuns<=4)),
 *     boundaries wherever they fall.
 *  2. The two hand-tuned stomp-boundary candidates:
 *     A: sections with C2+S1a fused              -> expect 9
 *     B: sections with the Solo cut moved to m85 (S1a'=68-84, S2'=85-103) -> expect 9
 *  3. B's new windows measured (m78-79/80-81/82-83/84 cells).
 *
 * Run: npx tsx samples/_scratch/clint-plan-probe.ts
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

interface Ev { beat: number; key: string }
const mel = (fl: ReturnType<typeof flattenSongsterrMelodic>): Ev[] =>
  fl.notes.map((n) => ({ beat: n.beat, key: `${n.pitch}@${n.velocity ?? 'd'}:${n.durationBeats}` }));
const drm = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] =>
  fl.events.map((e) => ({ beat: e.beat, key: `${e.voice}@${e.velocity ?? 'd'}` }));
const LANES: Ev[][] = [mel(t6f), mel(t11f), mel(t12f), [...drm(t14f), ...drm(t15f)]];
const barSig = (evs: Ev[], mi1: number): string => {
  const b0 = barStart(mi1 - 1); const b1 = b0 + barLen(mi1 - 1);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${Math.round((e.beat - b0) * 4)}:${e.key}`).sort().join(',');
};
const reg = new Map<string, string>();
const winLetter = (bars: number[]): string => {
  const sig = `${bars.length}|` + LANES.map((evs) => bars.map((b) => barSig(evs, b)).join(';')).join('||');
  let l = reg.get(sig);
  if (!l) { const n = reg.size; l = n < 26 ? String.fromCharCode(65 + n) : `a${n - 26}`; reg.set(sig, l); }
  return l;
};

function minRuns(order: string[]): number {
  const slot = new Map<string, number>();
  for (const l of order) if (!slot.has(l)) slot.set(l, slot.size + 1);
  const s = order.map((l) => slot.get(l)!);
  let runs = 0; let i = 0;
  while (i < s.length) { runs++; let j = i + 1; while (j < s.length && s[j] === s[j - 1] + 1) j++; i = j; }
  return runs;
}
const fits = (order: string[]): boolean =>
  new Set(order).size <= 8 && (order.length <= 8 || minRuns(order) <= 4);

// window sets
const secSpans: Array<[string, number, number]> = [
  ['Intro', 1, 15], ['V1', 16, 31], ['C1', 32, 41], ['V2', 42, 57], ['C2', 58, 67],
  ['S1a', 68, 78], ['S1b', 79, 88], ['S2', 89, 103], ['S3', 104, 117], ['Outro', 118, 123],
];
const winsOf = (from: number, to: number): number[][] => {
  const out: number[][] = [];
  for (let m = from; m <= to; m += 2) out.push(m + 1 <= to ? [m, m + 1] : [m]);
  return out;
};

// 1. greedy over the full order (windows respect section re-anchoring, as the chop does)
const allWins: Array<{ sec: string; bars: number[]; letter: string }> = [];
for (const [name, f, t] of secSpans) for (const bars of winsOf(f, t)) allWins.push({ sec: name, bars, letter: winLetter(bars) });
console.log('== greedy content-driven chunking (planProjects default), boundaries free:');
{
  const projects: Array<{ order: string[]; from: string; to: string }> = [];
  let cur: string[] = []; let curFrom = '';
  for (const w of allWins) {
    const cand = [...cur, w.letter];
    if (cur.length === 0) { cur = cand; curFrom = `m${w.bars[0]}`; continue; }
    if (fits(cand)) { cur = cand; continue; }
    projects.push({ order: cur, from: curFrom, to: '' });
    cur = [w.letter]; curFrom = `m${w.bars[0]}`;
  }
  if (cur.length > 0) projects.push({ order: cur, from: curFrom, to: '' });
  console.log(`   ${projects.length} projects:`);
  for (const p of projects) console.log(`   from ${p.from}: ${p.order.join(' ')} (cells ${new Set(p.order).size}, plays ${p.order.length}, runs ${minRuns(p.order)})`);
}

// 2. candidate part sets
function evalSet(label: string, groups: Array<{ name: string; spans: Array<[number, number]> }>): void {
  console.log(`\n== ${label}`);
  let n = 0;
  for (const g of groups) {
    const order: string[] = [];
    for (const [f, t] of g.spans) for (const bars of winsOf(f, t)) order.push(winLetter(bars));
    const ok = fits(order);
    n++;
    console.log(`   ${g.name}: ${order.join(' ')} | cells=${new Set(order).size} plays=${order.length} runs=${minRuns(order)} -> ${ok ? 'OK' : 'DOES NOT FIT'}`);
  }
  console.log(`   total ${n} projects`);
}
evalSet('Candidate A: C2+S1a fused, planner solo cut kept (m79)', [
  { name: 'P1 Intro', spans: [[1, 15]] }, { name: 'P2 Verse 1', spans: [[16, 31]] },
  { name: 'P3 Chorus 1', spans: [[32, 41]] }, { name: 'P4 Verse 2', spans: [[42, 57]] },
  { name: 'P5 Chorus 2+Solo 1a', spans: [[58, 67], [68, 78]] },
  { name: 'P6 Solo 1b', spans: [[79, 88]] }, { name: 'P7 Solo 2', spans: [[89, 103]] },
  { name: 'P8 Solo 3', spans: [[104, 117]] }, { name: 'P9 Outro', spans: [[118, 123]] },
]);
evalSet('Candidate B: solo cut moved to m85 (S1a\'=m68-84, S2\'=m85-103)', [
  { name: 'P1 Intro', spans: [[1, 15]] }, { name: 'P2 Verse 1', spans: [[16, 31]] },
  { name: 'P3 Chorus 1', spans: [[32, 41]] }, { name: 'P4 Verse 2', spans: [[42, 57]] },
  { name: 'P5 Chorus 2', spans: [[58, 67]] }, { name: 'P6 Solo 1 (m68-84)', spans: [[68, 84]] },
  { name: 'P7 Solo 2 (m85-103)', spans: [[85, 103]] },
  { name: 'P8 Solo 3', spans: [[104, 117]] }, { name: 'P9 Outro', spans: [[118, 123]] },
]);
evalSet('Candidate C: BOTH (C2+S1a m58-78 fused AND m79-103 as one?)', [
  { name: 'P5 C2+S1a', spans: [[58, 67], [68, 78]] },
  { name: 'P6 m79-103', spans: [[79, 103]] },
]);
evalSet('Candidate D: S3+Outro re-cut at m112 (S3a=104-111, S3b+Outro=112-123)', [
  { name: 'S3a m104-111', spans: [[104, 111]] },
  { name: 'S3b+Outro m112-123', spans: [[112, 123]] },
]);
console.log(`\nglobal distinct cells so far: ${reg.size}`);
