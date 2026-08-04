/**
 * Smooth (s17608 r7965244) probe 2: fold + window mechanics. READ-ONLY, offline.
 *
 *   1. POST-FOLD union collision census against the SPD-SX 9-role voice_map
 *      (timbale->tom, bongo->tom, conga->tom, guiro->perc per drumFold): the
 *      honest collision count the union rows will actually carry.
 *   2. Melodic edge-crossers on the FINAL 13-window set: notes crossing 32-step
 *      pattern seams (tied chains) and notes crossing PROJECT ends (truncation).
 *   3. Closing-bar content of every project's final pattern (tail assertions).
 *   4. Ghost/accent location census for kit + timbales (velocity story).
 *   5. m1 pickup content (Intro head assertion).
 *
 * Run: npx tsx samples/_scratch/smooth-fold-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s17608';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const kit = flattenSongsterrDrums(loadPart(10));
const guiro = flattenSongsterrDrums(loadPart(7));
const timbales = flattenSongsterrDrums(loadPart(8));
const congas = flattenSongsterrDrums(loadPart(9));
const organ = flattenSongsterrMelodic(loadPart(4));
const piano = flattenSongsterrMelodic(loadPart(5));
const horns = flattenSongsterrMelodic(loadPart(6));
const measures = kit.measures;
const barStart = (mi: number): number => measures[mi].startBeat;

// Final window set (1-based bars, inclusive)
const WINDOWS: Array<{ name: string; from: number; to: number }> = [
  { name: 'P1 Intro', from: 1, to: 9 },
  { name: 'P2 Verse1', from: 10, to: 25 },
  { name: 'P3 PreCh1', from: 26, to: 35 },
  { name: 'P4 ChoInt', from: 36, to: 47 },
  { name: 'P5 Verse2', from: 48, to: 63 },
  { name: 'P6 PreCh2', from: 64, to: 73 },
  { name: 'P7 Chorus2', from: 74, to: 82 },
  { name: 'P8 SoloA', from: 83, to: 98 },
  { name: 'P9 SoloCho3', from: 99, to: 108 },
  { name: 'P10 Outro1', from: 109, to: 120 },
  { name: 'P11 Outro2', from: 121, to: 132 },
  { name: 'P12 Outro3', from: 133, to: 144 },
];

// ── 1. post-fold collision census ────────────────────────────────────
console.log('── 1. POST-FOLD UNION COLLISIONS (SPD-SX 9-role fold) ──');
const FOLD: Readonly<Record<string, string>> = {
  timbale: 'tom', bongo: 'tom', conga: 'tom', guiro: 'perc',
  kick: 'kick', snare: 'snare', hat: 'hat', openhat: 'openhat',
  ride: 'ride', crash: 'crash', tom: 'tom', perc: 'perc', clap: 'clap',
};
interface Cell { vel: number; src: string }
const cells = new Map<string, Cell[]>();
const parts: Array<{ label: string; fl: ReturnType<typeof flattenSongsterrDrums> }> = [
  { label: 'KIT', fl: kit }, { label: 'GUIRO', fl: guiro },
  { label: 'TIMB', fl: timbales }, { label: 'CONGAS', fl: congas },
];
for (const { label, fl } of parts) {
  for (const e of fl.events) {
    const folded = FOLD[e.voice] ?? e.voice;
    const key = `${Math.round(e.beat * 4)}|${folded}`;
    const arr = cells.get(key) ?? [];
    arr.push({ vel: e.velocity ?? 100, src: label });
    cells.set(key, arr);
  }
}
let collisions = 0; let velDiff = 0; const byPair = new Map<string, number>();
const byFoldVoice = new Map<string, number>();
for (const [key, arr] of cells) {
  if (arr.length < 2) continue;
  collisions += arr.length - 1;
  const voice = key.split('|')[1];
  byFoldVoice.set(voice, (byFoldVoice.get(voice) ?? 0) + arr.length - 1);
  const vels = new Set(arr.map((c) => c.vel));
  if (vels.size > 1) velDiff += arr.length - 1;
  const srcs = [...new Set(arr.map((c) => c.src))].sort().join('+');
  byPair.set(srcs, (byPair.get(srcs) ?? 0) + arr.length - 1);
}
console.log(`  total events: ${parts.reduce((a, p) => a + p.fl.events.length, 0)}; distinct cells ${cells.size}; folded-away (collisions) ${collisions}, velocity-differing ${velDiff}`);
console.log(`  by folded voice: ${[...byFoldVoice.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
console.log(`  by source pair: ${[...byPair.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);

// ── 2. melodic edge-crossers on the final grid ───────────────────────
console.log('\n── 2. MELODIC EDGE-CROSSERS (32-step pattern seams; project ends) ──');
const MEL: Array<{ label: string; fl: ReturnType<typeof flattenSongsterrMelodic> }> = [
  { label: 'ORGAN', fl: organ }, { label: 'PIANO', fl: piano }, { label: 'HORNS', fl: horns },
];
for (const w of WINDOWS) {
  const wStart = barStart(w.from - 1);
  const wEnd = w.to < measures.length ? barStart(w.to) : barStart(measures.length - 1) + 4;
  // pattern seams every 8 beats from wStart, except P1 whose first pattern is 4 beats (m1 16 steps)
  const seams: number[] = [];
  let cursor = wStart + (w.name === 'P1 Intro' ? 4 : 8);
  while (cursor < wEnd - 1e-9) { seams.push(cursor); cursor += 8; }
  for (const { label, fl } of MEL) {
    let seamCross = 0; let endCross = 0; const examples: string[] = [];
    for (const n of fl.notes) {
      if (n.beat < wStart - 1e-9 || n.beat >= wEnd - 1e-9) continue;
      const off = n.beat + n.durationBeats;
      for (const s of seams) {
        if (n.beat < s - 1e-9 && off > s + 1e-9) {
          seamCross++;
          if (examples.length < 3) {
            const mi = measures.findIndex((_, i) => n.beat >= barStart(i) - 1e-9 && (i === measures.length - 1 || n.beat < barStart(i + 1) - 1e-9));
            examples.push(`m${mi + 1}+${(n.beat - barStart(mi)).toFixed(2)} ${pitchToken(n.pitch)}:${n.durationBeats}`);
          }
          break;
        }
      }
      if (off > wEnd + 1e-9) endCross++;
    }
    if (seamCross > 0 || endCross > 0) {
      console.log(`  ${w.name} [${label}]: seam-crossers ${seamCross}${examples.length > 0 ? ` (e.g. ${examples.join('; ')})` : ''}; project-end crossers ${endCross}`);
    }
  }
}

// ── 3. closing-bar content per project ───────────────────────────────
console.log('\n── 3. CLOSING-BAR CONTENT (final bar of each project, per sounding track) ──');
interface Ev { beat: number; key: string }
const drumEvs = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] => fl.events.map((e) => ({
  beat: e.beat, key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}`,
}));
const melEvsF = (fl: ReturnType<typeof flattenSongsterrMelodic>): Ev[] => fl.notes.map((n) => ({
  beat: n.beat, key: `${pitchToken(n.pitch)}:${n.durationBeats}${n.velocity !== undefined ? `@${n.velocity}` : ''}`,
}));
const ALL: Array<{ label: string; evs: Ev[] }> = [
  { label: 'ORGAN', evs: melEvsF(organ) }, { label: 'PIANO', evs: melEvsF(piano) },
  { label: 'HORNS', evs: melEvsF(horns) }, { label: 'KIT', evs: drumEvs(kit) },
  { label: 'GUIRO', evs: drumEvs(guiro) }, { label: 'TIMB', evs: drumEvs(timbales) },
  { label: 'CONGAS', evs: drumEvs(congas) },
];
function barContent(evs: Ev[], mi: number): string {
  const b0 = barStart(mi); const b1 = b0 + 4;
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${((e.beat - b0) * 4).toFixed(2).replace(/\.00$/, '').replace(/0$/, '')}:${e.key}`)
    .sort((a, b) => parseFloat(a) - parseFloat(b)).join(' ');
}
for (const w of WINDOWS) {
  console.log(`\n  ${w.name} final bar m${w.to}${w.name === 'P7 Chorus2' || w.name === 'P1 Intro' ? ' (16-step final pattern)' : ''}:`);
  for (const t of ALL) {
    const c = barContent(t.evs, w.to - 1);
    if (c !== '') console.log(`    ${t.label}: ${c.length > 150 ? `${c.slice(0, 150)}…` : c}`);
  }
}

// ── 4. ghost/accent locations ────────────────────────────────────────
console.log('\n── 4. GHOSTS + NON-DEFAULT VELOCITIES ──');
for (const { label, fl } of parts) {
  const spots = new Map<number, number>();
  for (const e of fl.events) {
    if (e.ghost === true || (e.velocity !== undefined && e.velocity !== 90 && e.velocity !== 100)) {
      const mi = measures.findIndex((_, i) => e.beat >= barStart(i) - 1e-9 && (i === measures.length - 1 || e.beat < barStart(i + 1) - 1e-9));
      spots.set(mi + 1, (spots.get(mi + 1) ?? 0) + 1);
    }
  }
  if (spots.size > 0) console.log(`  ${label}: ${[...spots.entries()].sort((a, b) => a[0] - b[0]).map(([m, n]) => `m${m} x${n}`).join(', ')}`);
}

// ── 5. m1 pickup ─────────────────────────────────────────────────────
console.log('\n── 5. m1 PICKUP CONTENT ──');
for (const t of ALL) {
  const c = barContent(t.evs, 0);
  if (c !== '') console.log(`  ${t.label}: ${c}`);
}
console.log('\nDone.');
