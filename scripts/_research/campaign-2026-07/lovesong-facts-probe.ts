/**
 * Love Song (311's Cure cover, s671 r3982169) plan-time facts probe.
 * READ-ONLY, offline from the cache saved by the 2026-07-29 interview-brief
 * run. Re-runnable. No device contact.
 *
 * Answers, for the build plan:
 *   1. Tempo map: verify 69 flat from the tab itself.
 *   2. t5 Rhythm 2 (the Synth 2 layer): notes, MAX SIMULTANEOUS, chord ceiling,
 *      range, velocities, gates, ties, off-grid.
 *   3. t7 Sexton kit: voice/velocity census, ghosts/accents, off-grid detail
 *      (which bars, which fracs), m1 pickup content, per-bar letters.
 *   4. FEEL, measured: kick/snare/hat step-position histograms per verse /
 *      chorus / solo windows (the halftime-reggae verdict).
 *   5. RIG-SIDE merge checks (t5 + t7 ONLY; guitars + bass are his hands):
 *      V1 m10-17 vs V2 m22-29 vs Solo m37-44 vs V3 m45-52 pairwise;
 *      Intro m2-9 vs verse; Chorus1 m30-36 vs Chorus2 head m53-59;
 *      Interlude m18-21 vs verse halves.
 *   6. Merge COST detail: per differing bar, what Sexton actually changes.
 *   7. Elision check at every planned window boundary (Schism lesson §5).
 *   8. Closing-bar content per planned window (tail decode assertions).
 *   9. t5 sustains crossing window boundaries (seam truncation ledger).
 *
 * Run: npx tsx samples/_scratch/lovesong-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s671';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

// The planned window set (P1 fused into the Intro, Smooth precedent)
const WINDOWS: Array<{ name: string; from: number; to: number }> = [
  { name: 'W1 Intro', from: 1, to: 9 },
  { name: 'W2 Verse1', from: 10, to: 17 },
  { name: 'W3 Interlude', from: 18, to: 21 },
  { name: 'W4 Verse2', from: 22, to: 29 },
  { name: 'W5 Chorus1', from: 30, to: 36 },
  { name: 'W6 Solo', from: 37, to: 44 },
  { name: 'W7 Verse3', from: 45, to: 52 },
  { name: 'W8 Chorus2', from: 53, to: 61 },
];
const NBARS = 61;

// ── 1. tempo map, from the tab itself ────────────────────────────────
console.log('── 1. TEMPO MAP ──');
for (const id of [3, 5, 6, 7]) {
  const p = loadPart(id) as unknown as { automations?: { tempo?: Array<{ measure?: number; bpm?: number; position?: unknown; tempo?: number }> } };
  const t = p.automations?.tempo;
  console.log(`  part-${id} automations.tempo: ${t === undefined ? '(absent)' : JSON.stringify(t)}`);
}

// ── shared bar machinery ─────────────────────────────────────────────
const kit = flattenSongsterrDrums(loadPart(7));
const measures = kit.measures;
console.log(`\n  measures: ${measures.length}; signatures: ${(() => {
  const h = new Map<string, number>();
  for (const m of measures) h.set(m.signature.join('/'), (h.get(m.signature.join('/')) ?? 0) + 1);
  return [...h.entries()].map(([s, n]) => `${s} x${n}`).join(', ');
})()}`);
interface Ev { beat: number; key: string }
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];
function barSig(evs: Ev[], mi: number): string {
  const b0 = barStart(mi); const b1 = b0 + barLen(mi);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${(Math.round((e.beat - b0) * 16) / 16)}:${e.key}`).sort().join(',');
}
const drumEvs = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] => fl.events.map((e) => ({
  beat: e.beat,
  key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.accent === true ? '!' : ''}${e.ghost === true ? '~' : ''}`,
}));
const melEvs = (fl: ReturnType<typeof flattenSongsterrMelodic>): Ev[] => fl.notes.map((n) => ({
  beat: n.beat,
  key: `p${n.pitch}:d${n.durationBeats}:v${n.velocity ?? 'def'}`,
}));

function letters(evs: Ev[], from: number, to: number, label: string, print = true): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  let next = 0;
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let mi = from - 1; mi <= to - 1; mi++) {
    const sig = barSig(evs, mi);
    if (sig === '') { out.push('.'); continue; }
    if (!seen.has(sig)) { seen.set(sig, alpha[next] ?? `#${next - 26}`); next++; }
    out.push(seen.get(sig)!);
  }
  if (print) {
    console.log(`\n${label} per-bar letters m${from}-m${to} ('.'=rest):`);
    for (let i = 0; i < out.length; i += 16) {
      console.log(`  m${String(from + i).padStart(3)}: ${out.slice(i, i + 16).join(' ')}`);
    }
    console.log(`  distinct content bars: ${seen.size}`);
  }
  return out;
}

function offGridStats(fl: { events?: Array<{ beat: number }>; notes?: Array<{ beat: number }> }, label: string): void {
  const beats = (fl.events ?? fl.notes ?? []).map((e) => e.beat);
  const fracs = new Map<string, number>();
  const barsHit = new Set<number>();
  let off = 0;
  for (const b of beats) {
    const s = b * 4;
    if (Math.abs(s - Math.round(s)) > 1e-6) {
      off++;
      const frac = (Math.round((s - Math.floor(s)) * 1000) / 1000).toFixed(3);
      fracs.set(frac, (fracs.get(frac) ?? 0) + 1);
      let mi = 0;
      while (mi < NBARS - 1 && barStart(mi + 1) <= b + 1e-9) mi++;
      barsHit.add(mi + 1);
    }
  }
  console.log(`  ${label} off-grid: ${off} of ${beats.length}${off > 0 ? `  fracs: ${[...fracs.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} x${n}`).join(', ')}  bars: m${[...barsHit].sort((a, b) => a - b).join(',m')}` : ''}`);
}

// ── 2. t5 Rhythm 2 (the Synth 2 layer) ──────────────────────────────
console.log('\n── 2. t5 RHYTHM 2 (Electric Guitar jazz, Tim Mahoney) ──');
const t5 = flattenSongsterrMelodic(loadPart(5));
{
  const notes = [...t5.notes].sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  const byBeat = new Map<number, number>();
  for (const n of notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = Math.max(...byBeat.values());
  let maxSimul = 0;
  for (const n of notes) {
    const t = n.beat + 1e-6;
    const simul = notes.filter((m) => m.beat <= t && m.beat + m.durationBeats > t).length;
    if (simul > maxSimul) maxSimul = simul;
  }
  const vels = new Map<string, number>();
  for (const n of t5.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const lo = Math.min(...notes.map((n) => n.pitch)); const hi = Math.max(...notes.map((n) => n.pitch));
  const durs = notes.map((n) => n.durationBeats);
  console.log(`  notes ${notes.length}, max chord ${maxChord}, MAX SIMULTANEOUS ${maxSimul}, range ${pitchToken(lo)}-${pitchToken(hi)}`);
  console.log(`  velocities: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  console.log(`  durations: min ${Math.min(...durs)}, max ${Math.max(...durs)} beats; ties folded ${t5.notes.filter((n) => n.tie === true).length}`);
  offGridStats(t5, 't5');
}
const evT5 = melEvs(t5);
letters(evT5, 1, NBARS, 'T5 RHYTHM2');

// ── 3. t7 Sexton kit ─────────────────────────────────────────────────
console.log('\n── 3. KIT t7 (Chad Sexton) ──');
console.log(`  events: ${kit.events.length}, ghosts: ${kit.ghosts}, accents: ${kit.accents}, flams: ${kit.flams_collapsed}, graces: ${kit.graces_folded}, unmapped: ${kit.unmapped}`);
const kitVels = new Map<string, number>();
for (const e of kit.events) { const k = String(e.velocity ?? 'default'); kitVels.set(k, (kitVels.get(k) ?? 0) + 1); }
console.log(`  velocity census: ${[...kitVels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
const kitVoices = new Map<string, number>();
for (const e of kit.events) kitVoices.set(e.voice, (kitVoices.get(e.voice) ?? 0) + 1);
console.log(`  voice census: ${[...kitVoices.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
const evKIT = drumEvs(kit);
letters(evKIT, 1, NBARS, 'KIT t7');
offGridStats(kit, 'KIT');
console.log(`\n  m1 PICKUP content (the 2/4 bar): ${barSig(evKIT, 0) || '(empty)'}`);

// ── 4. FEEL: voice step-position histograms per window class ─────────
console.log('\n── 4. FEEL (step positions 0-15 inside each 4/4 bar) ──');
function feel(from: number, to: number, label: string): void {
  const hist = new Map<string, Map<number, number>>();
  for (const e of kit.events) {
    let mi = 0;
    while (mi < NBARS - 1 && barStart(mi + 1) <= e.beat + 1e-9) mi++;
    if (mi + 1 < from || mi + 1 > to) continue;
    const step = Math.round((e.beat - barStart(mi)) * 4);
    if (!hist.has(e.voice)) hist.set(e.voice, new Map());
    const h = hist.get(e.voice)!;
    h.set(step, (h.get(step) ?? 0) + 1);
  }
  console.log(`  ${label}:`);
  for (const [v, h] of [...hist.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
    const row = Array.from({ length: 16 }, (_, s) => h.get(s) ?? 0);
    console.log(`    ${v.padEnd(8)} ${row.map((n) => (n === 0 ? ' .' : String(n).padStart(2))).join(' ')}  (total ${row.reduce((a, b) => a + b, 0)})`);
  }
}
feel(10, 17, 'VERSE 1 m10-17');
feel(30, 36, 'CHORUS 1 m30-36');
feel(37, 44, 'SOLO m37-44');
feel(2, 9, 'INTRO m2-9');

// ── 5. rig-side merge checks (t5 + t7 ONLY) ─────────────────────────
console.log('\n── 5. RIG-SIDE MERGE CHECKS (t5 + t7 only; guitars/bass are his) ──');
const rigTracks: Array<{ label: string; evs: Ev[] }> = [
  { label: 'T5', evs: evT5 },
  { label: 'KIT', evs: evKIT },
];
function compareSpans(aFrom: number, aTo: number, bFrom: number, bTo: number, label: string): number {
  const L = aTo - aFrom + 1;
  if (bTo - bFrom + 1 !== L) { console.log(`  ${label}: LENGTH MISMATCH`); return -1; }
  let total = 0;
  const diffs: string[] = [];
  for (const t of rigTracks) {
    let d = 0; const bars: number[] = [];
    for (let i = 0; i < L; i++) {
      if (barSig(t.evs, aFrom - 1 + i) !== barSig(t.evs, bFrom - 1 + i)) { d++; bars.push(aFrom + i); }
    }
    total += d;
    if (d > 0) diffs.push(`${t.label} ${d}/${L}${d <= 8 ? ` (@m${bars.join(',m')})` : ''}`);
  }
  console.log(`  ${label}: ${diffs.length === 0 ? 'IDENTICAL rig-side' : `differs: ${diffs.join('; ')}`}`);
  return total;
}
compareSpans(10, 17, 22, 29, 'V1 (m10-17) vs V2 (m22-29)');
compareSpans(10, 17, 37, 44, 'V1 (m10-17) vs Solo (m37-44)');
compareSpans(10, 17, 45, 52, 'V1 (m10-17) vs V3 (m45-52)');
compareSpans(22, 29, 37, 44, 'V2 (m22-29) vs Solo (m37-44)');
compareSpans(22, 29, 45, 52, 'V2 (m22-29) vs V3 (m45-52)');
compareSpans(37, 44, 45, 52, 'Solo (m37-44) vs V3 (m45-52)');
compareSpans(2, 9, 10, 17, 'Intro (m2-9) vs V1 (m10-17)');
compareSpans(30, 36, 53, 59, 'Chorus1 (m30-36) vs Chorus2 head (m53-59)');
compareSpans(18, 21, 10, 13, 'Interlude (m18-21) vs V1 head (m10-13)');
compareSpans(18, 21, 14, 17, 'Interlude (m18-21) vs V1 tail (m14-17)');

// ── 6. merge COST detail: what Sexton changes across the verse-class windows ──
console.log('\n── 6. MERGE COST DETAIL (KIT bars that differ from the V1 image) ──');
function kitDiffDetail(base: { from: number }, other: { from: number; label: string }, L: number): void {
  const out: string[] = [];
  for (let i = 0; i < L; i++) {
    const a = barSig(evKIT, base.from - 1 + i);
    const b = barSig(evKIT, other.from - 1 + i);
    if (a !== b) out.push(`    bar ${i + 1} (m${other.from + i}): ${b === '' ? '(rest)' : b.length > 100 ? `${b.slice(0, 100)}…` : b}`);
  }
  console.log(`  ${other.label}: ${out.length === 0 ? 'no kit diffs vs V1' : `${out.length} differing bar(s):`}`);
  for (const l of out) console.log(l);
}
kitDiffDetail({ from: 10 }, { from: 22, label: 'V2 vs V1' }, 8);
kitDiffDetail({ from: 10 }, { from: 37, label: 'Solo vs V1' }, 8);
kitDiffDetail({ from: 10 }, { from: 45, label: 'V3 vs V1' }, 8);
console.log('\n  V1 kit image itself (per bar):');
for (let i = 0; i < 8; i++) {
  const s = barSig(evKIT, 9 + i);
  console.log(`    m${10 + i}: ${s === '' ? '(rest)' : s.length > 100 ? `${s.slice(0, 100)}…` : s}`);
}

// ── 7. elision check at every planned boundary ───────────────────────
console.log('\n── 7. ELISION CHECK (period in window; next bar continues?) ──');
for (const w of WINDOWS) {
  const L = w.to - w.from + 1;
  for (const t of rigTracks) {
    const sigs = Array.from({ length: L }, (_, i) => barSig(t.evs, w.from - 1 + i));
    if (sigs.every((s) => s === '')) continue;
    let bestP = 0; let bestRatio = 0;
    for (let P = 1; P <= Math.floor(L / 2); P++) {
      let hit = 0;
      for (let i = P; i < L; i++) if (sigs[i] === sigs[i - P]) hit++;
      const ratio = hit / (L - P);
      if (ratio > bestRatio + 1e-9) { bestRatio = ratio; bestP = P; }
    }
    const period = bestRatio >= 0.999 ? bestP : undefined;
    if (period === undefined) { console.log(`  ${w.name} [${t.label}]: through-composed (no period)`); continue; }
    const nextBar = w.to < NBARS ? barSig(t.evs, w.to) : undefined;
    let verdict = `period ${period}`;
    if (nextBar !== undefined && nextBar !== '') {
      const cont = sigs[L % period];
      verdict += nextBar === cont
        ? ` — NEXT BAR CONTINUES (elision${L % period === 0 ? '; whole cycles, wrap clean' : '; WINDOW CUT MID-CYCLE'})`
        : ` — next departs: clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period} MID-CYCLE`}`;
    } else if (nextBar === undefined) {
      verdict += ` — song ends; residual ${L % period}${L % period === 0 ? ' (whole cycles)' : ' MID-CYCLE'}`;
    } else {
      verdict += ` — next silent: clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period}`}`;
    }
    console.log(`  ${w.name} [${t.label}]: ${verdict}`);
  }
}

// ── 8. closing-bar content per planned window (tail decode assertions) ──
console.log('\n── 8. CLOSING BAR per window (t5 + kit) ──');
for (const w of WINDOWS) {
  for (const t of rigTracks) {
    const sig = barSig(t.evs, w.to - 1);
    console.log(`  ${w.name} m${w.to} [${t.label}]: ${sig === '' ? '(rest)' : sig.length > 110 ? `${sig.slice(0, 110)}…` : sig}`);
  }
}

// ── 9. t5 sustains crossing planned window boundaries ────────────────
console.log('\n── 9. T5 SUSTAINS CROSSING WINDOW BOUNDARIES ──');
let crossers = 0;
for (const w of WINDOWS) {
  if (w.to >= NBARS) continue;
  const bEnd = barStart(w.to - 1) + barLen(w.to - 1);
  for (const n of t5.notes) {
    if (n.beat < bEnd - 1e-9 && n.beat + n.durationBeats > bEnd + 1e-9) {
      crossers++;
      console.log(`  ${w.name} end (m${w.to}|m${w.to + 1}): ${pitchToken(n.pitch)} dur ${n.durationBeats}b crosses by ${(n.beat + n.durationBeats - bEnd).toFixed(2)}b`);
    }
  }
}
if (crossers === 0) console.log('  NONE — every t5 note releases inside its window.');
console.log('\nDone.');
