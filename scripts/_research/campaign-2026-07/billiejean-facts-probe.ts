/**
 * Billie Jean (s10586 r8048414) plan-time facts probe. READ-ONLY, offline from
 * the cache saved by the 2026-07-29 interview-brief run. Re-runnable.
 *
 * Answers, for the build plan:
 *   1. Is t7 (CS-80 "Synthesizer") note-identical to t13 (his Synth Voice
 *      "Chords")? If yes, sequencing t7 doubles HIM -> disqualified.
 *   2. Kit t16: voice census, velocity census, per-bar letters m1-144, the
 *      groove bar's exact content (the iconic hat pattern), fill bars.
 *   3. Percussion t15: voice census, velocity census, letters -> fold or drop.
 *   4. Fill candidates t7,t8,t9,t10,t11,t12,t14: notes, poly/chords, range,
 *      dynamics, sounding-bar coverage, per-section presence.
 *   5. Strophic merge checks on RIG-side parts: V1 vs V2 windows, PreCh1 vs
 *      PreCh2, Chorus1 vs Chorus3 vs Chorus2 sub-windows, bar-by-bar.
 *   6. Elision check at every section boundary (the Schism lesson).
 *
 * Run: npx tsx samples/_scratch/billiejean-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s10586';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const SECTIONS: Array<{ name: string; from: number; to: number }> = [
  { name: 'Intro', from: 1, to: 14 },
  { name: 'Verse 1', from: 15, to: 34 },
  { name: 'Pre-Chorus 1', from: 35, to: 42 },
  { name: 'Chorus 1', from: 43, to: 54 },
  { name: 'Verse 2', from: 55, to: 74 },
  { name: 'Pre-Chorus 2', from: 75, to: 82 },
  { name: 'Chorus 2', from: 83, to: 102 },
  { name: 'Interlude', from: 103, to: 114 },
  { name: 'Chorus 3', from: 115, to: 126 },
  { name: 'Outro', from: 127, to: 140 },
  { name: 'Fade Out', from: 141, to: 144 },
];

// ── 1. t7 vs t13 identity ────────────────────────────────────────────
const t7 = flattenSongsterrMelodic(loadPart(7));
const t13 = flattenSongsterrMelodic(loadPart(13));
const noteKey = (n: { beat: number; pitch: number; durationBeats: number; velocity?: number }): string =>
  `${n.beat}|${n.pitch}|${n.durationBeats}|${n.velocity ?? 'def'}`;
const set7 = new Set(t7.notes.map(noteKey));
const set13 = new Set(t13.notes.map(noteKey));
const only7 = [...set7].filter((k) => !set13.has(k));
const only13 = [...set13].filter((k) => !set7.has(k));
console.log('── 1. t7 (CS-80) vs t13 (Synth Voice, HIS) ──');
console.log(`  t7 notes ${t7.notes.length}, t13 notes ${t13.notes.length}`);
console.log(`  identical (beat|pitch|dur|vel): ${only7.length === 0 && only13.length === 0 ? 'YES — t7 IS t13' : `NO — only-in-t7 ${only7.length}, only-in-t13 ${only13.length}`}`);
if (only7.length > 0) console.log(`    only-in-t7 sample: ${only7.slice(0, 5).join(' ; ')}`);
if (only13.length > 0) console.log(`    only-in-t13 sample: ${only13.slice(0, 5).join(' ; ')}`);

// ── shared bar machinery ─────────────────────────────────────────────
const kit = flattenSongsterrDrums(loadPart(16));
const perc = flattenSongsterrDrums(loadPart(15));
const measures = kit.measures; // uniform 4/4 x144 per the briefing
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
const evKIT = drumEvs(kit);
const evPERC = drumEvs(perc);

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

// ── 2. kit t16 ───────────────────────────────────────────────────────
console.log('\n── 2. KIT t16 (Ndugu, Yamaha Recording Custom) ──');
console.log(`  events: ${kit.events.length}, ghosts: ${kit.ghosts}, accents: ${kit.accents}, flams: ${kit.flams_collapsed}, graces: ${kit.graces_folded}, unmapped: ${kit.unmapped}`);
const kitVels = new Map<string, number>();
for (const e of kit.events) { const k = String(e.velocity ?? 'default'); kitVels.set(k, (kitVels.get(k) ?? 0) + 1); }
console.log(`  velocity census: ${[...kitVels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
const kitVoices = new Map<string, number>();
for (const e of kit.events) kitVoices.set(e.voice, (kitVoices.get(e.voice) ?? 0) + 1);
console.log(`  voice census: ${[...kitVoices.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
const kitLetters = letters(evKIT, 1, 144, 'KIT t16');
// dump each distinct kit bar's contents once
console.log('\n  distinct kit bars (first occurrence), full step content:');
const seenBars = new Set<string>();
for (let mi = 0; mi < 144; mi++) {
  const sig = barSig(evKIT, mi);
  if (sig === '' || seenBars.has(sig)) continue;
  seenBars.add(sig);
  console.log(`   ${kitLetters[mi]} (m${mi + 1}): ${sig}`);
}
// off-grid
let kitOff = 0;
for (const e of kit.events) { const s = e.beat * 4; if (Math.abs(s - Math.round(s)) > 1e-6) kitOff++; }
console.log(`  off-grid (16th) kit hits: ${kitOff}`);

// ── 3. percussion t15 ────────────────────────────────────────────────
console.log('\n── 3. PERCUSSION t15 ──');
console.log(`  events: ${perc.events.length}, ghosts: ${perc.ghosts}, accents: ${perc.accents}, unmapped: ${perc.unmapped}`);
const percVels = new Map<string, number>();
for (const e of perc.events) { const k = String(e.velocity ?? 'default'); percVels.set(k, (percVels.get(k) ?? 0) + 1); }
console.log(`  velocity census: ${[...percVels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
const percVoices = new Map<string, number>();
for (const e of perc.events) percVoices.set(e.voice, (percVoices.get(e.voice) ?? 0) + 1);
console.log(`  voice census: ${[...percVoices.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
const percLetters = letters(evPERC, 1, 144, 'PERC t15');
console.log('\n  distinct perc bars (first occurrence):');
const seenPerc = new Set<string>();
for (let mi = 0; mi < 144; mi++) {
  const sig = barSig(evPERC, mi);
  if (sig === '' || seenPerc.has(sig)) continue;
  seenPerc.add(sig);
  console.log(`   ${percLetters[mi]} (m${mi + 1}): ${sig}`);
}
// collision census: how often does perc land on a step the kit already fills (same voice)?
let sameVoiceCollisions = 0; let totalPerc = 0;
const kitCells = new Set(kit.events.map((e) => `${Math.round(e.beat * 4)}|${e.voice}`));
for (const e of perc.events) {
  totalPerc++;
  if (kitCells.has(`${Math.round(e.beat * 4)}|${e.voice}`)) sameVoiceCollisions++;
}
console.log(`  same-step same-voice collisions with kit if folded: ${sameVoiceCollisions} of ${totalPerc}`);

// ── 4. fill candidates ───────────────────────────────────────────────
console.log('\n── 4. FILL CANDIDATES ──');
const CAND: Array<{ id: number; name: string }> = [
  { id: 7, name: 'CS-80 strings (t7)' },
  { id: 8, name: 'Rhodes (t8)' },
  { id: 9, name: 'Synergy pad (t9)' },
  { id: 10, name: 'String Arr 1 (t10)' },
  { id: 11, name: 'String Arr 2 tremolo (t11)' },
  { id: 12, name: 'Emulator (t12)' },
  { id: 14, name: 'Synth Brass Lyricon (t14)' },
];
const candFlat = new Map<number, ReturnType<typeof flattenSongsterrMelodic>>();
for (const c of CAND) {
  const fl = flattenSongsterrMelodic(loadPart(c.id));
  candFlat.set(c.id, fl);
  const notes = [...fl.notes].sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  // chord size = max onsets sharing a beat; sustained-overlap = onset inside a prior note's ring
  const byBeat = new Map<number, number>();
  for (const n of notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = Math.max(...byBeat.values());
  let overlaps = 0;
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].beat !== notes[i - 1].beat && notes[i].beat < notes[i - 1].beat + notes[i - 1].durationBeats - 1e-9) overlaps++;
  }
  const vels = new Map<string, number>();
  for (const n of fl.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const lo = Math.min(...notes.map((n) => n.pitch)); const hi = Math.max(...notes.map((n) => n.pitch));
  // sounding bars + section presence
  const evs = melEvs(fl);
  const soundBars: number[] = [];
  for (let mi = 0; mi < 144; mi++) if (barSig(evs, mi) !== '') soundBars.push(mi + 1);
  const secs = SECTIONS
    .map((s) => {
      const inSec = soundBars.filter((m) => m >= s.from && m <= s.to).length;
      return inSec > 0 ? `${s.name} ${inSec}/${s.to - s.from + 1}` : undefined;
    })
    .filter((x) => x !== undefined);
  console.log(`\n  ${c.name}: ${notes.length} notes, max chord ${maxChord}, sustained-overlaps ${overlaps}, range ${pitchToken(lo)}-${pitchToken(hi)}`);
  console.log(`    velocities: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  console.log(`    sounding bars: ${soundBars.length}  sections: ${secs.join(' | ')}`);
  const durs = notes.map((n) => n.durationBeats);
  console.log(`    durations: min ${Math.min(...durs)}, max ${Math.max(...durs)} beats; ties folded ${fl.notes.filter((n) => n.tie === true).length}`);
}

// ── 5. strophic merge checks (rig-side parts only) ───────────────────
console.log('\n── 5. MERGE CHECKS (rig-side parts: kit, perc, candidates) ──');
const rigTracks: Array<{ label: string; evs: Ev[] }> = [
  { label: 'KIT', evs: evKIT },
  { label: 'PERC', evs: evPERC },
  ...CAND.map((c) => ({ label: c.name, evs: melEvs(candFlat.get(c.id)!) })),
];
function compareSpans(aFrom: number, aTo: number, bFrom: number, bTo: number, label: string): void {
  const L = aTo - aFrom + 1;
  if (bTo - bFrom + 1 !== L) { console.log(`  ${label}: LENGTH MISMATCH`); return; }
  const diffs: string[] = [];
  for (const t of rigTracks) {
    let d = 0;
    for (let i = 0; i < L; i++) {
      if (barSig(t.evs, aFrom - 1 + i) !== barSig(t.evs, bFrom - 1 + i)) d++;
    }
    if (d > 0) diffs.push(`${t.label} ${d}/${L} bars`);
  }
  console.log(`  ${label}: ${diffs.length === 0 ? 'IDENTICAL on all rig-side parts' : `differs: ${diffs.join(', ')}`}`);
}
compareSpans(15, 34, 55, 74, 'Verse 1 (m15-34) vs Verse 2 (m55-74)');
compareSpans(1, 14, 15, 28, 'Intro (m1-14) vs Verse1 head (m15-28)');
compareSpans(35, 42, 75, 82, 'PreCh 1 (m35-42) vs PreCh 2 (m75-82)');
compareSpans(43, 54, 115, 126, 'Chorus 1 (m43-54) vs Chorus 3 (m115-126)');
compareSpans(83, 94, 115, 126, 'Chorus 2 head (m83-94) vs Chorus 3 (m115-126)');
compareSpans(91, 102, 115, 126, 'Chorus 2 tail (m91-102) vs Chorus 3 (m115-126)');
compareSpans(127, 140, 115, 126, 'Outro (m127-140) head-compare vs Chorus 3 first 12', );

// ── 6. elision check at every section boundary ───────────────────────
console.log('\n── 6. ELISION CHECK (period in window; next bar continues?) ──');
for (const w of SECTIONS) {
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
    if (period === undefined) continue; // through-composed: nothing to elide
    const nextBar = w.to < 144 ? barSig(t.evs, w.to) : undefined;
    let verdict = `period ${period}`;
    if (nextBar !== undefined && nextBar !== '') {
      const cont = sigs[L % period];
      verdict += nextBar === cont
        ? ` — NEXT BAR CONTINUES (elision${L % period === 0 ? '; window = whole cycles, wrap clean' : '; WINDOW CUT MID-CYCLE'})`
        : ` — next departs: clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period} MID-CYCLE`}`;
    } else if (nextBar === undefined) {
      verdict += ` — song ends; residual ${L % period}${L % period === 0 ? ' (whole cycles)' : ' MID-CYCLE'}`;
    } else {
      verdict += ` — next silent: clean${L % period === 0 ? ', whole cycles' : `, residual ${L % period}`}`;
    }
    console.log(`  ${w.name} [${t.label}]: ${verdict}`);
  }
}

// song tail
console.log('\nSong tail m141-144 (KIT / PERC):');
for (let mi = 140; mi < 144; mi++) console.log(`  m${mi + 1} KIT: ${barSig(evKIT, mi) || '(rest)'}`);
for (let mi = 140; mi < 144; mi++) console.log(`  m${mi + 1} PERC: ${barSig(evPERC, mi) || '(rest)'}`);
