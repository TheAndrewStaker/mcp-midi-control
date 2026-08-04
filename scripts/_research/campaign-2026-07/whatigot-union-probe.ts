/**
 * What I Got p14+p15 DRUM UNION probe (the maintainer's superseding directive).
 * READ-ONLY, offline from the pinned cache. Re-runnable.
 *
 * Verifies his three claims with data:
 *   (1) complementary spans; (2) near-identical where they overlap; (3) both carry kicks.
 * Then rebuilds the drum-lane facts for the plan: union letters, section identity
 * (does V1==V2 or chorus==verse survive the union?), collision census
 * (same voice + same snapped step from both parts -> loudest wins), velocity
 * census, elision checks, tails.
 *
 * drum_map for p15: {27:'kick', 28:'snare'} (kick proven by whatigot-kick-census.ts:
 * staff pos 3 = the low lane, skeleton == t14's GM-36 kick figure; 28 = backbeat,
 * paired 1:1 with the 37 side stick, corroborated by t14 having no kick at beats 2/4).
 *
 * Run: npx tsx samples/_scratch/whatigot-union-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s211';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const t15 = flattenSongsterrDrums(loadPart(15), { drumMap: { 27: 'kick', 28: 'snare' } });
const t14 = flattenSongsterrDrums(loadPart(14));
const measures = t15.measures;
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];

console.log(`t15 mapped {27:kick, 28:snare}: ${t15.events.length} events, unmapped ${t15.unmapped}`);
console.log(`t14 default map: ${t14.events.length} events, unmapped ${t14.unmapped}, flams ${t14.flams_collapsed}, graces ${t14.graces_folded}`);
const cen = (evs: typeof t14.events): string => {
  const m = new Map<string, number>();
  for (const e of evs) m.set(e.voice, (m.get(e.voice) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ');
};
console.log(`t15 voices: ${cen(t15.events)}`);
console.log(`t14 voices: ${cen(t14.events)}`);
const velCen = (evs: typeof t14.events, label: string): void => {
  const m = new Map<string, number>();
  for (const e of evs) {
    const eff = e.ghost === true ? 40 : (e.velocity ?? 100);
    m.set(String(eff), (m.get(String(eff)) ?? 0) + 1);
  }
  console.log(`${label} EFFECTIVE velocity census: ${[...m.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).map(([v, n]) => `${v} x${n}`).join(', ')}`);
};
velCen(t15.events, 't15');
velCen(t14.events, 't14');

// ── snapped union with collision policy ──────────────────────────────
interface Cell { mi: number; step: number; voice: string; vel: number; from: 'p14' | 'p15' | 'both' }
function snapEvents(evs: typeof t14.events, from: 'p14' | 'p15'): Cell[] {
  const out: Cell[] = [];
  for (const e of evs) {
    const mi = measures.findIndex((m, i) => e.beat >= m.startBeat - 1e-9
      && (i + 1 >= measures.length || e.beat < measures[i + 1].startBeat - 1e-9));
    const step = Math.round((e.beat - measures[mi].startBeat) * 4);
    const vel = e.ghost === true ? 40 : (e.velocity ?? 100);
    out.push({ mi, step, voice: e.voice, vel, from });
  }
  return out;
}
// per-part intra-part unison fold first (loudest wins), then cross-part merge
function foldCells(cells: Cell[]): Map<string, Cell> {
  const m = new Map<string, Cell>();
  for (const c of cells) {
    const k = `${c.mi}|${c.step}|${c.voice}`;
    const prev = m.get(k);
    if (!prev) { m.set(k, { ...c }); continue; }
    prev.vel = Math.max(prev.vel, c.vel);
  }
  return m;
}
const c15 = foldCells(snapEvents(t15.events, 'p15'));
const c14 = foldCells(snapEvents(t14.events, 'p14'));
const union = new Map<string, Cell>();
let collisions = 0;
const collByVoice = new Map<string, number>();
const collDiffVel = new Map<string, number>();
for (const [k, c] of c15) union.set(k, { ...c });
for (const [k, c] of c14) {
  const prev = union.get(k);
  if (!prev) { union.set(k, { ...c }); continue; }
  collisions++;
  collByVoice.set(c.voice, (collByVoice.get(c.voice) ?? 0) + 1);
  if (prev.vel !== c.vel) collDiffVel.set(c.voice, (collDiffVel.get(c.voice) ?? 0) + 1);
  prev.vel = Math.max(prev.vel, c.vel);
  prev.from = 'both';
}
console.log(`\nUNION: p15 cells ${c15.size} (intra-fold ${t15.events.length - c15.size}), p14 cells ${c14.size} (intra-fold ${t14.events.length - c14.size})`);
console.log(`cross-part SAME-VOICE collisions: ${collisions} -> loudest wins`);
console.log(`  by voice: ${[...collByVoice.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
console.log(`  of which velocities DIFFERED: ${[...collDiffVel.entries()].map(([v, n]) => `${v} ${n}`).join(', ') || 'none'}`);
console.log(`union cells total: ${union.size}`);
const uv = new Map<string, number>();
for (const c of union.values()) uv.set(c.voice, (uv.get(c.voice) ?? 0) + 1);
console.log(`union voice census: ${[...uv.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);

// ── claim 1: per-bar occupancy ───────────────────────────────────────
const has = (cells: Map<string, Cell>, mi: number): boolean => [...cells.values()].some((c) => c.mi === mi);
let s15only = 0; let s14only = 0; let both = 0;
const occ: string[] = [];
for (let mi = 0; mi < 71; mi++) {
  const a = has(c15, mi); const b = has(c14, mi);
  occ.push(a && b ? 'B' : a ? '5' : b ? '4' : '.');
  if (a && b) both++; else if (a) s15only++; else if (b) s14only++;
}
console.log(`\nOCCUPANCY m1-71 ('5'=p15 only, '4'=p14 only, 'B'=both, '.'=rest):`);
for (let i = 0; i < 71; i += 8) console.log(`  m${String(i + 1).padStart(2)}: ${occ.slice(i, i + 8).join(' ')}`);
console.log(`  p15-only bars ${s15only}, p14-only bars ${s14only}, both ${both}`);

// ── claim 2: overlap comparison, bar for bar ─────────────────────────
function barSigOf(cells: Map<string, Cell>, mi: number): string {
  return [...cells.values()].filter((c) => c.mi === mi)
    .map((c) => `${c.step}:${c.voice}@${c.vel}`).sort().join(',');
}
let identical = 0; const differing: number[] = [];
for (let mi = 0; mi < 71; mi++) {
  const a = barSigOf(c15, mi); const b = barSigOf(c14, mi);
  if (a === '' || b === '') continue;
  if (a === b) identical++; else differing.push(mi + 1);
}
console.log(`\nOVERLAP bars where both sound: ${both}; EXACTLY identical: ${identical}; differing: ${differing.length}`);
// how they differ: is p15 a subset (skeleton) of the union? classify
let p14addsOnly = 0; let bothDiverge = 0;
for (const m of differing) {
  const mi = m - 1;
  const a = new Set([...c15.values()].filter((c) => c.mi === mi).map((c) => `${c.step}|${c.voice}`));
  const b = new Set([...c14.values()].filter((c) => c.mi === mi).map((c) => `${c.step}|${c.voice}`));
  const aNotB = [...a].filter((x) => !b.has(x)).length;
  const bNotA = [...b].filter((x) => !a.has(x)).length;
  if (aNotB > 0 && bNotA > 0) bothDiverge++; else p14addsOnly++;
}
console.log(`  of differing: both-diverge ${bothDiverge}, one-adds-to-other ${p14addsOnly}`);
// kick-lane agreement in overlap
let kickAgree = 0; let kickDiffer = 0;
for (let mi = 21; mi <= 64; mi++) {
  const a = [...c15.values()].filter((c) => c.mi === mi && c.voice === 'kick').map((c) => c.step).sort((x, y) => x - y).join(',');
  const b = [...c14.values()].filter((c) => c.mi === mi && c.voice === 'kick').map((c) => c.step).sort((x, y) => x - y).join(',');
  if (a === '' && b === '') continue;
  if (a === b) kickAgree++; else kickDiffer++;
}
console.log(`  KICK lanes in overlap m22-65: agree ${kickAgree} bars, differ ${kickDiffer} bars`);

// ── union letters + section identity ─────────────────────────────────
const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const useen = new Map<string, string>();
const uLetters: string[] = [];
for (let mi = 0; mi < 71; mi++) {
  const sig = barSigOf(union as Map<string, Cell>, mi);
  if (sig === '') { uLetters.push('.'); continue; }
  if (!useen.has(sig)) useen.set(sig, alpha[useen.size] ?? `#${useen.size}`);
  uLetters.push(useen.get(sig)!);
}
console.log(`\nUNION per-bar letters m1-71 ('.'=rest), distinct ${useen.size}:`);
for (let i = 0; i < 71; i += 8) console.log(`  m${String(i + 1).padStart(2)}: ${uLetters.slice(i, i + 8).join(' ')}`);

function cmpWin(aName: string, a0: number, a1: number, bName: string, b0: number, b1: number): void {
  const n = Math.min(a1 - a0, b1 - b0) + 1;
  let same = true; let firstDiff = -1;
  for (let i = 0; i < n; i++) {
    if (barSigOf(union as Map<string, Cell>, a0 - 1 + i) !== barSigOf(union as Map<string, Cell>, b0 - 1 + i)) { same = false; firstDiff = i + 1; break; }
  }
  console.log(`  UNION ${aName} vs ${bName}: ${same ? `IDENTICAL over ${n} bars` : `differ first at window bar ${firstDiff}`}`);
}
console.log('\nSECTION IDENTITY on the union drum lane:');
cmpWin('Verse1 m6-17', 6, 17, 'Verse2 m22-33', 22, 33);
cmpWin('Chorus m34-41', 34, 41, 'Chorus2 m56-63', 56, 63);
cmpWin('Verse1 m6-13', 6, 13, 'Verse3 m42-49', 42, 49);
cmpWin('Verse1 m6-9', 6, 9, 'Solo m18-21', 18, 21);
cmpWin('Verse2 m22-29', 22, 29, 'Chorus m34-41', 34, 41);

// per-section period on the union
const SECTIONS = [
  ['P1 Intro', 1, 5], ['P2 Verse1', 6, 17], ['P3 Solo', 18, 21], ['P4 Verse2', 22, 33],
  ['P5 Chorus', 34, 41], ['P6 Verse3', 42, 49], ['P7 Interlude', 50, 55], ['P8 Chorus2', 56, 63],
  ['P9 Outro', 64, 71],
] as const;
console.log('\nUNION per-section smallest cell (bars) + next-bar elision verdict:');
for (const [name, from, to] of SECTIONS) {
  const L = to - from + 1;
  const sigs = Array.from({ length: L }, (_, i) => barSigOf(union as Map<string, Cell>, from - 1 + i));
  if (sigs.every((s) => s === '')) { console.log(`  ${name}: silent`); continue; }
  let period = L;
  for (let P = 1; P <= L; P++) {
    let ok = true;
    for (let i = P; i < L; i++) if (sigs[i] !== sigs[i - P]) { ok = false; break; }
    if (ok) { period = P; break; }
  }
  let verdict = '';
  if (period <= Math.floor(L / 2)) {
    const nextBar = to < 71 ? barSigOf(union as Map<string, Cell>, to) : undefined;
    if (nextBar !== undefined && nextBar !== '' && nextBar === sigs[L % period]) {
      verdict = L % period === 0 ? ' ELISION but whole cycles: wrap clean' : ' ELISION MID-CYCLE: SHIFT BOUNDARY';
    } else verdict = L % period === 0 ? ' (whole cycles, wrap clean)' : ` (residual ${L % period})`;
  }
  console.log(`  ${name} (${L} bars): cell ${period}${period === L ? ' (through-composed)' : ''}${verdict}`);
}

// tails
console.log('\nUNION tail m60-71:');
for (let mi = 59; mi < 71; mi++) {
  const s = barSigOf(union as Map<string, Cell>, mi);
  if (s !== '') console.log(`  m${mi + 1}: ${s}`);
}
