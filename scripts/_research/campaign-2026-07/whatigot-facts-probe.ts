/**
 * What I Got (s211 r6610547) plan-time facts probe. READ-ONLY, offline from
 * the cache saved by the 2026-07-29 interview-brief run. Re-runnable.
 *
 * Answers, for the build plan:
 *   1. t15 Drum Programming: GM voice census + the 27/28 non-GM profile
 *      (in-bar step histogram) so a drum_map has a per-number MUSICAL case.
 *   2. t15 vs t14 vs t16: the drums-part choice, measured.
 *   3. Per-bar letters (velocity-keyed) for every candidate sequenced part.
 *   4. Window identity across the 9 marker sections on SELECTED parts:
 *      does Verse2 revisit Verse1? Chorus2 revisit Chorus? Verse3 prefix?
 *   5. Fill-candidate censuses: t5, t6, t13, t11 (notes, poly, velocities,
 *      durations, off-grid deltas, edge-crossers on project-anchored grids).
 *   6. Elision check (the Schism lesson) at every boundary + song end.
 *   7. Song tail m60-71 per part (closing-bar assertions feedstock).
 *
 * Run: npx tsx samples/_scratch/whatigot-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s211';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

// Sections (from the briefing): m1 Intro | m6 V1 | m18 Solo | m22 V2 | m34 Cho |
// m42 V3 | m50 Interlude | m56 Cho2 | m64 Outro. 71 bars, m1 is the lone 2/4.
const SECTIONS = [
  { name: 'P1 Intro', from: 1, to: 5 },
  { name: 'P2 Verse1', from: 6, to: 17 },
  { name: 'P3 Solo', from: 18, to: 21 },
  { name: 'P4 Verse2', from: 22, to: 33 },
  { name: 'P5 Chorus', from: 34, to: 41 },
  { name: 'P6 Verse3', from: 42, to: 49 },
  { name: 'P7 Interlude', from: 50, to: 55 },
  { name: 'P8 Chorus2', from: 56, to: 63 },
  { name: 'P9 Outro', from: 64, to: 71 },
];

// ── 1. t15: raw non-GM profile + census under the candidate drum_map ──
const t15default = flattenSongsterrDrums(loadPart(15));
console.log('t15 Drum Programming, DEFAULT map:');
console.log(`  events(sounding): ${t15default.events.length}, unmapped: ${t15default.unmapped}, ghosts: ${t15default.ghosts}, accents: ${t15default.accents}`);
console.log(`  unmapped numbers: ${JSON.stringify(t15default.unmapped_numbers ?? {})}`);
const vGM = new Map<string, number>();
for (const e of t15default.events) vGM.set(e.voice, (vGM.get(e.voice) ?? 0) + 1);
console.log(`  GM voice census: ${[...vGM.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);

// Profile 27 and 28 via marker voices that cannot collide with the GM hits.
const t15probe = flattenSongsterrDrums(loadPart(15), { drumMap: { 27: 'claves', 28: 'maracas' } });
function profile(voice: string, label: string): void {
  const evs = t15probe.events.filter((e) => e.voice === voice);
  const hist = new Map<number, number>();
  const bars = new Set<number>();
  for (const e of evs) {
    const mi = t15probe.measures.findIndex((m, i) => e.beat >= m.startBeat - 1e-9
      && (i + 1 >= t15probe.measures.length || e.beat < t15probe.measures[i + 1].startBeat - 1e-9));
    bars.add(mi + 1);
    const inBar = (e.beat - t15probe.measures[mi].startBeat) * 4; // 16th steps into the bar
    hist.set(Math.round(inBar * 2) / 2, (hist.get(Math.round(inBar * 2) / 2) ?? 0) + 1);
  }
  const vels = new Map<string, number>();
  for (const e of evs) vels.set(String(e.velocity ?? 'def'), (vels.set ? (vels.get(String(e.velocity ?? 'def')) ?? 0) + 1 : 1));
  console.log(`  ${label}: ${evs.length} hits over ${bars.size} bars (m${Math.min(...bars)}-m${Math.max(...bars)})`);
  console.log(`    in-bar step histogram: ${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join(' ')}`);
  console.log(`    velocities: ${[...vels.entries()].map(([k, n]) => `${k} x${n}`).join(', ')}`);
}
profile('claves', 'number 27 (GM2 "High Q")');
profile('maracas', 'number 28 (GM2 "Slap")');

// The build's candidate map, decided from the histograms printed above; the
// letters/identity checks below run WITH it so the stored image is what we key.
const T15_MAP = { 27: 'hat', 28: 'snare' } as const;
const t15 = flattenSongsterrDrums(loadPart(15), { drumMap: T15_MAP });
console.log(`\nt15 WITH drum_map {27:hat, 28:snare}: events ${t15.events.length}, unmapped ${t15.unmapped}`);
const vAll = new Map<string, number>();
for (const e of t15.events) vAll.set(e.voice, (vAll.get(e.voice) ?? 0) + 1);
console.log(`  voice census: ${[...vAll.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
const vVel = new Map<string, number>();
for (const e of t15.events) vVel.set(String(e.velocity ?? 'default'), (vVel.get(String(e.velocity ?? 'default')) ?? 0) + 1);
console.log(`  velocity census: ${[...vVel.entries()].map(([k, n]) => `${k} x${n}`).join(', ')}`);

// ── 2. t14 / t16 comparison ──────────────────────────────────────────
const t14 = flattenSongsterrDrums(loadPart(14));
console.log(`\nt14 Drums (acoustic kit): events ${t14.events.length}, unmapped ${t14.unmapped}, ghosts ${t14.ghosts}`);
let og14 = 0;
for (const e of t14.events) { const s = e.beat * 4; if (Math.abs(s - Math.round(s)) > 1e-6) og14++; }
console.log(`  off-grid (16th): ${og14} of ${t14.events.length}`);
const t16 = flattenSongsterrDrums(loadPart(16));
console.log(`t16 Turntables: events ${t16.events.length}, unmapped ${t16.unmapped}, unmapped numbers ${JSON.stringify(t16.unmapped_numbers ?? {})}`);

// ── helpers ──────────────────────────────────────────────────────────
interface Ev { beat: number; key: string }
const measures = t15.measures;
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];
function barSig(evs: Ev[], mi: number): string {
  const b0 = barStart(mi); const b1 = b0 + barLen(mi);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${(Math.round((e.beat - b0) * 16) / 16)}:${e.key}`).sort().join(',');
}
const drEv = (f: ReturnType<typeof flattenSongsterrDrums>): Ev[] =>
  f.events.map((e) => ({ beat: e.beat, key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.ghost === true ? '~' : ''}` }));
const melEv = (f: ReturnType<typeof flattenSongsterrMelodic>): Ev[] =>
  f.notes.map((n) => ({ beat: n.beat, key: `p${n.pitch}:d${n.durationBeats}:v${n.velocity ?? 'def'}` }));

const t5 = flattenSongsterrMelodic(loadPart(5));
const t6 = flattenSongsterrMelodic(loadPart(6));
const t13 = flattenSongsterrMelodic(loadPart(13));
const t11 = flattenSongsterrMelodic(loadPart(11));

const TRACKS: Array<{ label: string; evs: Ev[] }> = [
  { label: 'DR15', evs: drEv(t15) },
  { label: 'SB5', evs: melEv(t5) },
  { label: 'WH6', evs: melEv(t6) },
  { label: 'SH13', evs: melEv(t13) },
];

// ── 3. per-bar letters ───────────────────────────────────────────────
function letters(evs: Ev[], from: number, to: number, label: string): void {
  const seen = new Map<string, string>();
  const out: string[] = [];
  let next = 0;
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let mi = from - 1; mi <= to - 1; mi++) {
    const sig = barSig(evs, mi);
    if (sig === '') { out.push('.'); continue; }
    if (!seen.has(sig)) { seen.set(sig, alpha[next] ?? `#${next}`); next++; }
    out.push(seen.get(sig)!);
  }
  console.log(`\n${label} per-bar letters m${from}-m${to} ('.'=rest):`);
  for (let i = 0; i < out.length; i += 8) {
    console.log(`  m${String(from + i).padStart(2)}: ${out.slice(i, i + 8).join(' ')}`);
  }
  console.log(`  distinct content bars: ${seen.size}`);
}
letters(drEv(t15), 1, 71, 'DRUM PROG (t15, mapped)');
letters(melEv(t5), 1, 71, 'SYNTH BASS (t5)');
letters(melEv(t6), 18, 21, 'WHISTLING (t6)');
letters(melEv(t13), 50, 55, 'SHANAI (t13)');

// ── 4. window identity on selected parts ────────────────────────────
console.log('\nWINDOW IDENTITY (per part, bar-by-bar):');
function windowSigs(evs: Ev[], from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => barSig(evs, from - 1 + i));
}
function compareWindows(aName: string, a: [number, number], bName: string, b: [number, number]): void {
  for (const { label, evs } of TRACKS) {
    const sa = windowSigs(evs, a[0], a[1]);
    const sb = windowSigs(evs, b[0], b[1]);
    const n = Math.min(sa.length, sb.length);
    let same = true; let firstDiff = -1;
    for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) { same = false; firstDiff = i; break; }
    const note = sa.length === sb.length ? '' : ` (lengths ${sa.length} vs ${sb.length}, prefix-compared)`;
    console.log(`  ${aName} vs ${bName} [${label}]: ${same ? `IDENTICAL over ${n} bars` : `differ first at bar ${firstDiff + 1} of the window`}${note}`);
  }
}
compareWindows('Verse1 m6-17', [6, 17], 'Verse2 m22-33', [22, 33]);
compareWindows('Verse1 m6-13', [6, 13], 'Verse3 m42-49', [42, 49]);
compareWindows('Chorus m34-41', [34, 41], 'Chorus2 m56-63', [56, 63]);
compareWindows('Verse1 m6-17', [6, 17], 'Solo m18-21', [18, 21]);

// 1-bar-cell checks inside each window, per part
console.log('\nPER-PART CELLS inside each section (period of the smallest repeating cell, bars):');
for (const s of SECTIONS) {
  const L = s.to - s.from + 1;
  const per: string[] = [];
  for (const { label, evs } of TRACKS) {
    const sigs = windowSigs(evs, s.from, s.to);
    if (sigs.every((x) => x === '')) continue;
    let period = 0;
    for (let P = 1; P <= L; P++) {
      let ok = true;
      for (let i = P; i < L; i++) if (sigs[i] !== sigs[i - P]) { ok = false; break; }
      if (ok) { period = P; break; }
    }
    per.push(`${label}=${period}${period === L ? ' (no repeat)' : ''}`);
  }
  console.log(`  ${s.name} (${L} bars): ${per.join(', ')}`);
}

// ── 5. fill-candidate censuses ───────────────────────────────────────
function melCensus(f: ReturnType<typeof flattenSongsterrMelodic>, label: string): void {
  const notes = [...f.notes].sort((a, b) => a.beat - b.beat);
  let poly = 0;
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].beat < notes[i - 1].beat + notes[i - 1].durationBeats - 1e-9) poly++;
  }
  let maxChord = 1;
  const byBeat = new Map<number, number>();
  for (const n of notes) { const k = Math.round(n.beat * 1e6) / 1e6; byBeat.set(k, (byBeat.get(k) ?? 0) + 1); }
  for (const c of byBeat.values()) maxChord = Math.max(maxChord, c);
  const vels = new Map<string, number>();
  for (const n of notes) vels.set(String(n.velocity ?? 'def'), (vels.get(String(n.velocity ?? 'def')) ?? 0) + 1);
  const offs: number[] = [];
  for (const n of notes) { const s = n.beat * 4; if (Math.abs(s - Math.round(s)) > 1e-6) offs.push(Math.abs(s - Math.round(s))); }
  console.log(`\n${label}: ${notes.length} notes, overlap-onsets ${poly}, max simultaneous ${maxChord}`);
  if (notes.length > 0) {
    console.log(`  range ${pitchToken(Math.min(...notes.map((n) => n.pitch)))}..${pitchToken(Math.max(...notes.map((n) => n.pitch)))}, first m${Math.floor(notes[0].beat / 4) + 1}, last-end beat ${Math.max(...notes.map((n) => n.beat + n.durationBeats))}`);
    console.log(`  velocities: ${[...vels.entries()].map(([k, n]) => `${k} x${n}`).join(', ')}`);
    console.log(`  off-grid: ${offs.length} (deltas in 16ths: ${offs.slice(0, 12).map((d) => d.toFixed(2)).join(',')}${offs.length > 12 ? ',…' : ''})`);
    console.log(`  ties folded: ${notes.filter((n) => n.tie === true).length}`);
  }
}
melCensus(t5, 'SYNTH BASS t5');
melCensus(t6, 'WHISTLING t6');
melCensus(t13, 'SHANAI t13');
melCensus(t11, 'ECHOES t11 (fork alternative)');

// whistle + shanai + echoes note-by-note (they are tiny; print all)
function dumpNotes(f: ReturnType<typeof flattenSongsterrMelodic>, label: string): void {
  console.log(`  ${label} notes:`);
  for (const n of [...f.notes].sort((a, b) => a.beat - b.beat)) {
    const mi = Math.floor(n.beat / 4); // uniform 4/4 beyond m1 (2/4); close enough for display: use measures index
    const m = measures.findIndex((mm, i) => n.beat >= mm.startBeat - 1e-9 && (i + 1 >= measures.length || n.beat < measures[i + 1].startBeat - 1e-9));
    console.log(`    m${m + 1} +${(n.beat - measures[m].startBeat).toFixed(3)}b ${pitchToken(n.pitch)} len ${n.durationBeats}b v${n.velocity ?? 'def'}${n.tie === true ? ' tie' : ''}`);
  }
}
dumpNotes(t6, 'WHISTLE');
dumpNotes(t13, 'SHANAI');
dumpNotes(t11, 'ECHOES');

// edge-crossers per project-anchored 2-bar grids, selected melodic fills
console.log('\nEDGE-CROSSERS (project-anchored 32-step pattern grids):');
for (const s of SECTIONS) {
  const anchor = barStart(s.from - 1);
  for (const [label, f] of [['SB5', t5], ['WH6', t6], ['SH13', t13]] as const) {
    let c = 0;
    for (const n of f.notes) {
      if (n.beat < anchor - 1e-9 || n.beat >= barStart(s.to - 1) + barLen(s.to - 1) - 1e-9) continue;
      const st = Math.round((n.beat - anchor) * 4); const en = st + Math.max(1, Math.round(n.durationBeats * 4));
      if (Math.floor(st / 32) !== Math.floor((en - 1) / 32)) c++;
    }
    if (c > 0) console.log(`  ${s.name} [${label}]: ${c} note(s) ring past a pattern edge`);
  }
}

// ── 6. elision check at every boundary ───────────────────────────────
console.log('\nELISION CHECK (period in window; does the next bar continue the cycle?):');
for (const w of SECTIONS) {
  const L = w.to - w.from + 1;
  for (const { label, evs } of TRACKS) {
    const sigs = windowSigs(evs, w.from, w.to);
    if (sigs.every((x) => x === '')) continue;
    let bestP = 0; let bestRatio = 0;
    for (let P = 1; P <= Math.floor(L / 2); P++) {
      let hit = 0;
      for (let i = P; i < L; i++) if (sigs[i] === sigs[i - P]) hit++;
      const ratio = hit / (L - P);
      if (ratio > bestRatio + 1e-9) { bestRatio = ratio; bestP = P; }
    }
    const period = bestRatio >= 0.999 ? bestP : undefined;
    const nextBar = w.to < 71 ? barSig(evs, w.to) : undefined;
    let verdict = 'clean (no whole-window period)';
    if (period !== undefined) {
      verdict = `period ${period} bars`;
      if (nextBar !== undefined && nextBar !== '') {
        const contIdx = L % period;
        const cont = sigs[contIdx];
        verdict += nextBar === cont
          ? ` — NEXT BAR CONTINUES THE CYCLE: ELISION${L % period === 0 ? ' — but window = whole cycles, wrap clean' : ' — WINDOW CUT MID-CYCLE'}`
          : ` — next bar departs: clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period} bar(s) at wrap`}`;
      } else if (nextBar === undefined) {
        verdict += ` — song ends; residual ${L % period} bar(s)${L % period === 0 ? ' (whole cycles)' : ' MID-CYCLE'}`;
      } else {
        verdict += ` — next bar silent: clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period} bar(s)`}`;
      }
    }
    console.log(`  ${w.name} [${label}]: ${verdict}`);
  }
}

// ── 7. song tail ─────────────────────────────────────────────────────
console.log('\nSONG TAIL m60-71 per part:');
for (const { label, evs } of TRACKS) {
  for (let mi = 59; mi < 71; mi++) {
    const s = barSig(evs, mi);
    if (s !== '') console.log(`  m${mi + 1} [${label}]: ${s}`);
  }
}
console.log('\nMetre check: m1 signature =', JSON.stringify(measures[0].signature), ', total bars =', measures.length);
console.log('Tempo map:', JSON.stringify(t15.measures.filter((m, i, a) => i === 0 || m.bpm !== a[i - 1].bpm).map((m) => ({ m: m.index + 1, bpm: m.bpm }))));
