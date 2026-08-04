/**
 * Brain Stew (s8644 r7493187) plan-time facts probe. READ-ONLY, offline from
 * the cache saved by the 2026-07-29 interview-brief run. Re-runnable.
 *
 * Answers, for the build plan:
 *   1. Per-bar drum letters m13-63 + fuzz letters m49-63 (velocity-keyed sigs).
 *   2. The 2 off-grid drum hits: where, what, how far.
 *   3. Fuzz-bass note census: mono?, gates, dynamics values, window-edge crossers.
 *   4. Drum velocity/ghost/accent census (roster said dynamics 0 - verify).
 *   5. Drum voice census (SPD-SX map + condense fold expectations).
 *   6. Elision check (the Schism lesson) at every candidate boundary:
 *      m13, m17, m25, m29, m37, m41, m49, and the song end m63.
 *
 * Run: npx tsx samples/_scratch/brainstew-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s8644';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const fuzz = flattenSongsterrMelodic(loadPart(4));
const dr = flattenSongsterrDrums(loadPart(6));
const measures = dr.measures; // uniform 4/4 x63 per the briefing

interface Ev { beat: number; key: string }
const evFZ: Ev[] = fuzz.notes.map((n) => ({
  beat: n.beat,
  key: `p${n.pitch}:d${n.durationBeats}:v${n.velocity ?? 'def'}`,
}));
const evDR: Ev[] = dr.events.map((e) => ({
  beat: e.beat,
  key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.accent === true ? '!' : ''}${e.ghost === true ? '~' : ''}`,
}));

const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];
function barSig(evs: Ev[], mi: number): string {
  const b0 = barStart(mi); const b1 = b0 + barLen(mi);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${(Math.round((e.beat - b0) * 16) / 16)}:${e.key}`).sort().join(',');
}

// ── 1. per-bar letters ───────────────────────────────────────────────
function letters(evs: Ev[], from: number, to: number, label: string): Map<string, string> {
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
    const bar0 = from + i;
    console.log(`  m${String(bar0).padStart(2)}: ${out.slice(i, i + 8).join(' ')}`);
  }
  console.log(`  distinct content bars: ${seen.size}`);
  return seen;
}
const drLetters = letters(evDR, 13, 63, 'DRUMS (p6)');
letters(evFZ, 49, 63, 'FUZZ (p4)');

// ── 2. off-grid drum hits ────────────────────────────────────────────
console.log('\nOFF-GRID drum hits (16th grid):');
for (const e of dr.events) {
  const step = e.beat * 4;
  if (Math.abs(step - Math.round(step)) > 1e-6) {
    const mi = measures.findIndex((m, i) => e.beat >= m.startBeat - 1e-9
      && (i + 1 >= measures.length || e.beat < measures[i + 1].startBeat - 1e-9));
    console.log(`  m${mi + 1} beat ${e.beat} (${e.voice}): ${step.toFixed(3)} -> snaps to step ${Math.round(step)} (delta ${(step - Math.round(step)).toFixed(3)})`);
  }
}

// ── 3. fuzz census ───────────────────────────────────────────────────
console.log('\nFUZZ (p4) census:');
console.log(`  notes: ${fuzz.notes.length}`);
const sorted = [...fuzz.notes].sort((a, b) => a.beat - b.beat);
let poly = 0;
for (let i = 1; i < sorted.length; i++) {
  if (sorted[i].beat < sorted[i - 1].beat + sorted[i - 1].durationBeats - 1e-9) poly++;
}
console.log(`  overlapping (poly) onsets: ${poly}`);
const vels = new Map<string, number>();
for (const n of fuzz.notes) { const k = String(n.velocity ?? 'default'); vels.set(k, (vels.get(k) ?? 0) + 1); }
console.log(`  velocity census: ${[...vels.entries()].map(([k, n]) => `${k} x${n}`).join(', ')}`);
const durs = new Map<number, number>();
for (const n of fuzz.notes) durs.set(n.durationBeats, (durs.get(n.durationBeats) ?? 0) + 1);
console.log(`  duration census (beats): ${[...durs.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d} x${n}`).join(', ')}`);
console.log(`  ties folded: ${fuzz.notes.filter((n) => n.tie === true).length}; letRing: ${fuzz.notes.filter((n) => n.letRing === true).length}; ghosts: ${fuzz.notes.filter((n) => n.ghost === true).length}`);
// window-edge crossers on the OUTRO-anchored grid (project starts m49 => step 0 at m49)
const anchor = barStart(48); // m49, 0-based idx 48
let crossers = 0;
for (const n of fuzz.notes) {
  const s = Math.round((n.beat - anchor) * 4); const e = s + Math.round(n.durationBeats * 4);
  if (s >= 0 && Math.floor(s / 32) !== Math.floor((e - 1) / 32)) {
    crossers++;
    console.log(`  edge-crosser: m${Math.floor((n.beat) / 4) + 1} ${pitchToken(n.pitch)} start step ${s} len ${e - s} steps (pattern ${Math.floor(s / 32) + 1} -> ${Math.floor((e - 1) / 32) + 1})`);
  }
}
console.log(`  outro-grid window-edge crossers: ${crossers}`);
console.log(`  first fuzz note: m${Math.floor(sorted[0].beat / 4) + 1} beat ${sorted[0].beat} ${pitchToken(sorted[0].pitch)}`);
console.log(`  last fuzz note end: beat ${Math.max(...fuzz.notes.map((n) => n.beat + n.durationBeats))} (m${Math.floor((Math.max(...fuzz.notes.map((n) => n.beat + n.durationBeats)) - 0.001) / 4) + 1})`);

// ── 4. drum dynamics census ──────────────────────────────────────────
console.log('\nDRUMS (p6) dynamics census:');
console.log(`  events: ${dr.events.length}, ghosts: ${dr.ghosts}, accents: ${dr.accents}, flams collapsed: ${dr.flams_collapsed}, graces folded: ${dr.graces_folded}, unmapped: ${dr.unmapped}`);
const dvels = new Map<string, number>();
for (const e of dr.events) { const k = String(e.velocity ?? 'default'); dvels.set(k, (dvels.get(k) ?? 0) + 1); }
console.log(`  velocity census: ${[...dvels.entries()].map(([k, n]) => `${k} x${n}`).join(', ')}`);

// ── 5. drum voice census ─────────────────────────────────────────────
const voices = new Map<string, number>();
for (const e of dr.events) voices.set(e.voice, (voices.get(e.voice) ?? 0) + 1);
console.log(`  voice census: ${[...voices.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);

// ── 6. elision check at every boundary ───────────────────────────────
// Candidate projects: G m13-24 (groove), C1 m25-28, V3 m29-36, C2 m37-40,
// V4 m41-48, OUT m49-63. Boundaries + song end.
console.log('\nELISION CHECK (period in window; does the next bar continue the cycle?):');
const windows: Array<{ name: string; from: number; to: number }> = [
  { name: 'Groove m13-24', from: 13, to: 24 },
  { name: 'Chorus1 m25-28', from: 25, to: 28 },
  { name: 'Verse3 m29-36', from: 29, to: 36 },
  { name: 'Chorus2 m37-40', from: 37, to: 40 },
  { name: 'Verse4 m41-48', from: 41, to: 48 },
  { name: 'Outro m49-63', from: 49, to: 63 },
];
const tracks: Array<{ label: string; evs: Ev[] }> = [{ label: 'DR', evs: evDR }, { label: 'FZ', evs: evFZ }];
for (const w of windows) {
  const L = w.to - w.from + 1;
  for (const { label, evs } of tracks) {
    const sigs = Array.from({ length: L }, (_, i) => barSig(evs, w.from - 1 + i));
    if (sigs.every((s) => s === '')) continue;
    let bestP = 0; let bestRatio = 0;
    for (let P = 1; P <= Math.floor(L / 2); P++) {
      let hit = 0;
      for (let i = P; i < L; i++) if (sigs[i] === sigs[i - P]) hit++;
      const ratio = hit / (L - P);
      if (ratio > bestRatio + 1e-9) { bestRatio = ratio; bestP = P; }
    }
    const period = bestRatio >= 0.999 ? bestP : undefined;
    const nextBar = w.to < 63 ? barSig(evs, w.to) : undefined; // bar AFTER the window (0-based w.to)
    let verdict = 'clean (no whole-window period)';
    if (period !== undefined) {
      verdict = `period ${period} bars`;
      if (nextBar !== undefined && nextBar !== '') {
        // does the next bar equal the cycle position it would continue?
        const contIdx = L % period; // cycle position of the next bar
        const cont = sigs[contIdx];
        verdict += nextBar === cont
          ? ` — NEXT BAR CONTINUES THE CYCLE (m${w.to + 1} == cycle pos ${contIdx}): ELISION${L % period === 0 ? ' — but window = whole cycles, wrap clean' : ' — WINDOW CUT MID-CYCLE'}`
          : ` — next bar departs (new content): clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period} bar(s) MID-CYCLE at wrap`}`;
      } else if (nextBar === undefined) {
        verdict += ` — song ends; residual ${L % period} bar(s)${L % period === 0 ? ' (whole cycles)' : ' MID-CYCLE'}`;
      } else {
        verdict += ` — next bar silent: clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period} bar(s)`}`;
      }
    }
    console.log(`  ${w.name} [${label}]: ${verdict}`);
  }
}

// last drum content
console.log('\nSong tail:');
for (let mi = 58; mi < 63; mi++) {
  console.log(`  m${mi + 1} DR: ${barSig(evDR, mi) || '(rest)'}`);
}
for (let mi = 58; mi < 63; mi++) {
  console.log(`  m${mi + 1} FZ: ${barSig(evFZ, mi) || '(rest)'}`);
}
