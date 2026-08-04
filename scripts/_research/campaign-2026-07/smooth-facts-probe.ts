/**
 * Smooth (s17608 r7965244) plan-time facts probe. READ-ONLY, offline from the
 * cache saved by the 2026-07-29 interview-brief run. Re-runnable.
 *
 * Answers, for the build plan:
 *   1. Tempo map: verify 116 flat from the tab itself.
 *   2. Rich parts t4 organ / t5 piano / t6 horns: notes, MAX SIMULTANEOUS
 *      voices (chords + sustained overlaps), range, velocities, per-section
 *      coverage -> which lands on the mono-ish MicroFreak (Billie Jean method).
 *   3. Kit t10: voice/velocity census, per-bar letters, distinct bars, off-grid.
 *   4. Latin perc t7 guiro / t8 timbales / t9 congas: censuses, unmapped,
 *      off-grid frac histograms, same-voice collision census vs kit (fold call).
 *   5. Strophic merge checks on RIG-SIDE parts only (V1vV2, PreCh1vPreCh2,
 *      choruses) — the all-parts merge list was empty; his parts are out now.
 *   6. Elision check at every section boundary (the Schism lesson).
 *   7. Outro (36 bars) and Guitar Solo (18 bars) period hunting: loop economics.
 *   8. Organ full content dump (29 notes) — settles placement + the m25 trim.
 *   9. Song-tail content m141-144 per rig track (tail decode assertions).
 *
 * Run: npx tsx samples/_scratch/smooth-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s17608';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const SECTIONS: Array<{ name: string; from: number; to: number }> = [
  { name: 'P1 unmarked', from: 1, to: 1 },
  { name: 'Intro', from: 2, to: 9 },
  { name: 'Verse 1', from: 10, to: 25 },
  { name: 'PreCh 1', from: 26, to: 35 },
  { name: 'Chorus 1', from: 36, to: 43 },
  { name: 'Interlude', from: 44, to: 47 },
  { name: 'Verse 2', from: 48, to: 63 },
  { name: 'PreCh 2', from: 64, to: 73 },
  { name: 'Chorus 2', from: 74, to: 82 },
  { name: 'Guitar Solo', from: 83, to: 100 },
  { name: 'Chorus 3', from: 101, to: 108 },
  { name: 'Outro', from: 109, to: 144 },
];
const NBARS = 144;

// ── 1. tempo map, from the tab itself ────────────────────────────────
console.log('── 1. TEMPO MAP ──');
for (const id of [3, 5, 10]) {
  const p = loadPart(id) as unknown as { automations?: { tempo?: Array<{ measure?: number; bpm?: number; position?: unknown; tempo?: number }> } };
  const t = p.automations?.tempo;
  console.log(`  part-${id} automations.tempo: ${t === undefined ? '(absent)' : JSON.stringify(t)}`);
}

// ── shared bar machinery ─────────────────────────────────────────────
const kit = flattenSongsterrDrums(loadPart(10));
const guiro = flattenSongsterrDrums(loadPart(7));
const timbales = flattenSongsterrDrums(loadPart(8));
const congas = flattenSongsterrDrums(loadPart(9));
const measures = kit.measures;
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
  let off = 0;
  for (const b of beats) {
    const s = b * 4;
    if (Math.abs(s - Math.round(s)) > 1e-6) {
      off++;
      const frac = (Math.round((s - Math.floor(s)) * 1000) / 1000).toFixed(3);
      fracs.set(frac, (fracs.get(frac) ?? 0) + 1);
    }
  }
  console.log(`  ${label} off-grid: ${off} of ${beats.length}${off > 0 ? `  fracs: ${[...fracs.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} x${n}`).join(', ')}` : ''}`);
}

// ── 2. the three rich parts ──────────────────────────────────────────
console.log('\n── 2. RICH PARTS t4 organ / t5 piano / t6 horns ──');
const CAND: Array<{ id: number; name: string }> = [
  { id: 4, name: 'Hammond B3 organ (t4)' },
  { id: 5, name: 'El. Grand piano (t5)' },
  { id: 6, name: 'Horn Section (t6)' },
];
const candFlat = new Map<number, ReturnType<typeof flattenSongsterrMelodic>>();
for (const c of CAND) {
  const fl = flattenSongsterrMelodic(loadPart(c.id));
  candFlat.set(c.id, fl);
  const notes = [...fl.notes].sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  const byBeat = new Map<number, number>();
  for (const n of notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = Math.max(...byBeat.values());
  // true max simultaneous: sweep onsets against sustained rings
  let maxSimul = 0;
  for (const n of notes) {
    const t = n.beat + 1e-6;
    const simul = notes.filter((m) => m.beat <= t && m.beat + m.durationBeats > t).length;
    if (simul > maxSimul) maxSimul = simul;
  }
  const vels = new Map<string, number>();
  for (const n of fl.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const lo = Math.min(...notes.map((n) => n.pitch)); const hi = Math.max(...notes.map((n) => n.pitch));
  const evs = melEvs(fl);
  const soundBars: number[] = [];
  for (let mi = 0; mi < NBARS; mi++) if (barSig(evs, mi) !== '') soundBars.push(mi + 1);
  const secs = SECTIONS
    .map((s) => {
      const inSec = soundBars.filter((m) => m >= s.from && m <= s.to).length;
      return inSec > 0 ? `${s.name} ${inSec}/${s.to - s.from + 1}` : undefined;
    })
    .filter((x) => x !== undefined);
  // per-section max chord (placement needs to know where the poly peaks live)
  const secChord = SECTIONS.map((s) => {
    let mx = 0;
    for (const [beat, cnt] of byBeat) {
      const mi = measures.findIndex((mm, i) => beat >= barStart(i) - 1e-9 && beat < barStart(i) + barLen(i) - 1e-9);
      if (mi >= s.from - 1 && mi <= s.to - 1 && cnt > mx) mx = cnt;
    }
    return mx > 0 ? `${s.name}:${mx}` : undefined;
  }).filter((x) => x !== undefined);
  const durs = notes.map((n) => n.durationBeats);
  console.log(`\n  ${c.name}: ${notes.length} notes, max chord ${maxChord}, MAX SIMULTANEOUS ${maxSimul}, range ${pitchToken(lo)}-${pitchToken(hi)}`);
  console.log(`    velocities: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  console.log(`    sounding bars: ${soundBars.length}  sections: ${secs.join(' | ')}`);
  console.log(`    per-section max chord: ${secChord.join('  ')}`);
  console.log(`    durations: min ${Math.min(...durs)}, max ${Math.max(...durs)} beats; ties folded ${fl.notes.filter((n) => n.tie === true).length}`);
  offGridStats(fl, c.name);
}

// ── organ full dump (29 notes: settles placement + the m25 trim) ─────
console.log('\n  ORGAN FULL CONTENT (bar: pitch:dur@vel):');
const org = candFlat.get(4)!;
for (const n of [...org.notes].sort((a, b) => a.beat - b.beat || a.pitch - b.pitch)) {
  let mi = 0;
  while (mi < NBARS - 1 && barStart(mi + 1) <= n.beat + 1e-9) mi++;
  console.log(`    m${mi + 1} beat+${(n.beat - barStart(mi)).toFixed(2)}: ${pitchToken(n.pitch)}:${n.durationBeats}${n.velocity !== undefined ? `@${n.velocity}` : ''}`);
}

// ── 3. kit t10 ───────────────────────────────────────────────────────
console.log('\n── 3. KIT t10 (Rodney Holmes) ──');
console.log(`  events: ${kit.events.length}, ghosts: ${kit.ghosts}, accents: ${kit.accents}, flams: ${kit.flams_collapsed}, graces: ${kit.graces_folded}, unmapped: ${kit.unmapped}`);
const kitVels = new Map<string, number>();
for (const e of kit.events) { const k = String(e.velocity ?? 'default'); kitVels.set(k, (kitVels.get(k) ?? 0) + 1); }
console.log(`  velocity census: ${[...kitVels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
const kitVoices = new Map<string, number>();
for (const e of kit.events) kitVoices.set(e.voice, (kitVoices.get(e.voice) ?? 0) + 1);
console.log(`  voice census: ${[...kitVoices.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
const evKIT = drumEvs(kit);
const kitLetters = letters(evKIT, 1, NBARS, 'KIT t10');
offGridStats(kit, 'KIT');
// dominant bar
const kitBarCount = new Map<string, number>();
for (let mi = 0; mi < NBARS; mi++) {
  const sig = barSig(evKIT, mi);
  if (sig !== '') kitBarCount.set(sig, (kitBarCount.get(sig) ?? 0) + 1);
}
const domKit = [...kitBarCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
console.log(`  top kit bars by service count: ${domKit.map(([sig, n], i) => `#${i + 1} x${n}`).join(', ')}`);
console.log(`  dominant kit bar content: ${domKit[0][0]}`);

// ── 4. Latin percussion ──────────────────────────────────────────────
console.log('\n── 4. LATIN PERCUSSION ──');
const percs: Array<{ label: string; fl: ReturnType<typeof flattenSongsterrDrums> }> = [
  { label: 'GUIRO t7', fl: guiro }, { label: 'TIMBALES t8', fl: timbales }, { label: 'CONGAS t9', fl: congas },
];
for (const { label, fl } of percs) {
  const vc = new Map<string, number>();
  for (const e of fl.events) vc.set(e.voice, (vc.get(e.voice) ?? 0) + 1);
  const vels = new Map<string, number>();
  for (const e of fl.events) { const k = String(e.velocity ?? 'default'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  console.log(`\n  ${label}: events ${fl.events.length}, ghosts ${fl.ghosts}, accents ${fl.accents}, unmapped ${fl.unmapped}`);
  console.log(`    voices: ${[...vc.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
  console.log(`    velocities: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  offGridStats(fl, label);
  letters(drumEvs(fl), 1, NBARS, label);
}
// collision census: 4-way union same-voice same-step (16th snap)
const cellOwner = new Map<string, string>();
const collide = new Map<string, number>();
for (const { label, fl } of [{ label: 'KIT', fl: kit }, ...percs]) {
  for (const e of fl.events) {
    const cell = `${Math.round(e.beat * 4)}|${e.voice}`;
    const prev = cellOwner.get(cell);
    if (prev !== undefined && prev !== label) collide.set(`${prev}+${label}`, (collide.get(`${prev}+${label}`) ?? 0) + 1);
    else cellOwner.set(cell, label);
  }
}
console.log(`\n  UNION same-voice same-step collisions (kit+guiro+timbales+congas): ${[...collide.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'ZERO'}`);

// ── 5. merge checks (rig-side parts only) ────────────────────────────
console.log('\n── 5. MERGE CHECKS (rig-side: organ, piano, horns, kit, guiro, timbales, congas) ──');
const rigTracks: Array<{ label: string; evs: Ev[] }> = [
  { label: 'ORGAN', evs: melEvs(candFlat.get(4)!) },
  { label: 'PIANO', evs: melEvs(candFlat.get(5)!) },
  { label: 'HORNS', evs: melEvs(candFlat.get(6)!) },
  { label: 'KIT', evs: evKIT },
  { label: 'GUIRO', evs: drumEvs(guiro) },
  { label: 'TIMBALES', evs: drumEvs(timbales) },
  { label: 'CONGAS', evs: drumEvs(congas) },
];
function compareSpans(aFrom: number, aTo: number, bFrom: number, bTo: number, label: string): void {
  const L = aTo - aFrom + 1;
  if (bTo - bFrom + 1 !== L) { console.log(`  ${label}: LENGTH MISMATCH`); return; }
  const diffs: string[] = [];
  for (const t of rigTracks) {
    let d = 0; const bars: number[] = [];
    for (let i = 0; i < L; i++) {
      if (barSig(t.evs, aFrom - 1 + i) !== barSig(t.evs, bFrom - 1 + i)) { d++; bars.push(aFrom + i); }
    }
    if (d > 0) diffs.push(`${t.label} ${d}/${L}${d <= 4 ? ` (@m${bars.join(',m')})` : ''}`);
  }
  console.log(`  ${label}: ${diffs.length === 0 ? 'IDENTICAL on all rig-side parts' : `differs: ${diffs.join('; ')}`}`);
}
compareSpans(10, 25, 48, 63, 'Verse 1 (m10-25) vs Verse 2 (m48-63)');
compareSpans(26, 35, 64, 73, 'PreCh 1 (m26-35) vs PreCh 2 (m64-73)');
compareSpans(36, 43, 74, 81, 'Chorus 1 (m36-43) vs Chorus 2 head (m74-81)');
compareSpans(36, 43, 101, 108, 'Chorus 1 (m36-43) vs Chorus 3 (m101-108)');
compareSpans(74, 81, 101, 108, 'Chorus 2 head (m74-81) vs Chorus 3 (m101-108)');
compareSpans(2, 9, 44, 47, 'Intro (m2-9) vs Interlude (m44-47) [expect mismatch len]');
compareSpans(2, 5, 44, 47, 'Intro head (m2-5) vs Interlude (m44-47)');
compareSpans(6, 9, 44, 47, 'Intro tail (m6-9) vs Interlude (m44-47)');

// ── 6. elision check at every boundary ───────────────────────────────
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
    if (period === undefined) continue;
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

// ── 7. Outro + Guitar Solo loop economics ────────────────────────────
console.log('\n── 7. OUTRO m109-144 per-track letters ──');
for (const t of rigTracks) letters(t.evs, 109, 144, `OUTRO ${t.label}`);
console.log('\n── 7b. GUITAR SOLO m83-100 per-track letters ──');
for (const t of rigTracks) letters(t.evs, 83, 100, `SOLO ${t.label}`);
console.log('\n── 7c. VERSE 1 m10-25 per-track letters (piano cell shape) ──');
for (const t of rigTracks) letters(t.evs, 10, 25, `V1 ${t.label}`);
console.log('\n── 7d. INTRO m2-9 + PreCh1 m26-35 + Chorus1 m36-43 letters ──');
for (const t of rigTracks) { letters(t.evs, 2, 9, `INTRO ${t.label}`); }
for (const t of rigTracks) { letters(t.evs, 26, 35, `PRECH1 ${t.label}`); }
for (const t of rigTracks) { letters(t.evs, 36, 43, `CHO1 ${t.label}`); }

// ── 8. song tail ─────────────────────────────────────────────────────
console.log('\n── 8. SONG TAIL m140-144 per rig track ──');
for (const t of rigTracks) {
  for (let mi = 139; mi < NBARS; mi++) {
    const sig = barSig(t.evs, mi);
    if (sig !== '') console.log(`  m${mi + 1} ${t.label}: ${sig.length > 120 ? `${sig.slice(0, 120)}…` : sig}`);
  }
}
console.log('\nDone.');
