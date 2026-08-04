/**
 * Sugar (Sleep Token, s560358 r3001145) re-author plan-time facts probe.
 * READ-ONLY, offline from samples/songsterr-cache/s560358/ (fetched 2026-07-30,
 * revision 3001145 == the pin). Re-runnable. No device contact.
 *
 * Answers, for the rebuild plan:
 *   1. Tempo map: verify 122 flat from the tab itself; markers.
 *   2. Selected-part censuses (the settled bindings, sugar.md):
 *        p6 Sub Bass -> synth1, p8 Keyboard #2 -> synth2,
 *        p7 Keyboard #1 harp -> midi1 (MicroFreak), p10 II drums -> midi2 (SPD-SX).
 *   3. Per-bar letters per track (m1-148).
 *   4. UNION-KEYED distinct 2-bar windows (the What-I-Got / Redbone lesson:
 *      a window is a repeat only when EVERY selected layer agrees) -> honest floor.
 *   5. Section merge checks (union + per-track): V1/V2, C1/C2/C3, B1/B2,
 *      Outro m121-128 vs Intro m1-8, Outro m129-144 vs m9-24 (the claimed elision).
 *   6. Drum detail: voice census (clap!), unmapped (the scratch-pull class after
 *      the importer fix), m25-26 content (the old build's missing bars), ghosts.
 *   7. p6 register census (the E0 question), p8 chord ceiling, p7 exactness base.
 *   8. FINAL WINDOW SET: elision periods, closing bars, sustain crossers.
 *
 * Run: npx tsx samples/_scratch/sugar-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s560358';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const NBARS = 148;

// ── 1. tempo + markers, from the tab itself ──────────────────────────
console.log('── 1. TEMPO + MARKERS ──');
for (const id of [6, 7, 8, 10]) {
  const p = loadPart(id) as unknown as { automations?: { tempo?: unknown } };
  console.log(`  part-${id} automations.tempo: ${JSON.stringify(p.automations?.tempo ?? '(absent)')}`);
}
{
  const raw = loadPart(10) as unknown as { measures: Array<{ marker?: { text: string } }> };
  console.log(`  markers: ${raw.measures.map((m, i) => (m.marker ? `m${i + 1}=${m.marker.text}` : '')).filter(Boolean).join(', ')}`);
}

// ── shared bar machinery (lovesong-facts-probe pattern) ──────────────
const kit = flattenSongsterrDrums(loadPart(10));
const measures = kit.measures;
{
  const h = new Map<string, number>();
  for (const m of measures) h.set(m.signature.join('/'), (h.get(m.signature.join('/')) ?? 0) + 1);
  console.log(`  measures: ${measures.length}; signatures: ${[...h.entries()].map(([s, n]) => `${s} x${n}`).join(', ')}`);
}
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
  let off = 0;
  const fracs = new Map<string, number>();
  for (const b of beats) {
    const s = b * 4;
    if (Math.abs(s - Math.round(s)) > 1e-6) {
      off++;
      const frac = (Math.round((s - Math.floor(s)) * 1000) / 1000).toFixed(3);
      fracs.set(frac, (fracs.get(frac) ?? 0) + 1);
    }
  }
  console.log(`  ${label} off-grid: ${off} of ${beats.length}${off > 0 ? `  fracs: ${[...fracs.entries()].map(([f, n]) => `${f} x${n}`).join(', ')}` : ''}`);
}

// ── 2. selected-part censuses ────────────────────────────────────────
console.log('\n── 2. SELECTED PARTS ──');
function melCensus(id: number, label: string): ReturnType<typeof flattenSongsterrMelodic> {
  const fl = flattenSongsterrMelodic(loadPart(id));
  const notes = [...fl.notes].sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  const byBeat = new Map<number, number>();
  for (const n of notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = notes.length > 0 ? Math.max(...byBeat.values()) : 0;
  let maxSimul = 0;
  for (const n of notes) {
    const t = n.beat + 1e-6;
    const simul = notes.filter((m) => m.beat <= t && m.beat + m.durationBeats > t).length;
    if (simul > maxSimul) maxSimul = simul;
  }
  const vels = new Map<string, number>();
  for (const n of fl.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const lo = Math.min(...notes.map((n) => n.pitch)); const hi = Math.max(...notes.map((n) => n.pitch));
  console.log(`  ${label} (part ${id}): notes ${notes.length}, max chord ${maxChord}, max simult ${maxSimul}, ` +
    `range ${pitchToken(lo)}(${lo})-${pitchToken(hi)}(${hi}), ties folded ${fl.notes.filter((n) => n.tie === true).length}`);
  console.log(`    velocities: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  offGridStats(fl, `  ${label}`);
  const below31 = notes.filter((n) => n.pitch < 31).length;
  if (below31 > 0) console.log(`    register: ${below31} of ${notes.length} below MIDI 31 (the corpus floor); E0(16) count ${notes.filter((n) => n.pitch === 16).length}`);
  const first = notes[0]; const last = notes[notes.length - 1];
  const barOf = (b: number): number => { let mi = 0; while (mi < NBARS - 1 && barStart(mi + 1) <= b + 1e-9) mi++; return mi + 1; };
  if (first) console.log(`    sounds m${barOf(first.beat)} .. m${barOf(last.beat)}`);
  return fl;
}
const p6 = melCensus(6, 'SUB BASS -> synth1');
const p8 = melCensus(8, 'KEYBOARD#2 pad -> synth2');
const p7 = melCensus(7, 'HARP -> midi1');
console.log(`  DRUMS -> midi2 (part 10): events ${kit.events.length}, ghosts ${kit.ghosts}, accents ${kit.accents}, ` +
  `flams ${kit.flams_collapsed}, graces ${kit.graces_folded}, unmapped ${kit.unmapped}`);
{
  const vels = new Map<string, number>();
  for (const e of kit.events) { const k = String(e.velocity ?? 'default'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  console.log(`    velocity census: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  const voices = new Map<string, number>();
  for (const e of kit.events) voices.set(e.voice, (voices.get(e.voice) ?? 0) + 1);
  console.log(`    voice census: ${[...voices.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
  offGridStats(kit, '  DRUMS');
  const barOf = (b: number): number => { let mi = 0; while (mi < NBARS - 1 && barStart(mi + 1) <= b + 1e-9) mi++; return mi + 1; };
  const beats = kit.events.map((e) => e.beat).sort((a, b) => a - b);
  if (beats.length > 0) console.log(`    sounds m${barOf(beats[0])} .. m${barOf(beats[beats.length - 1])}`);
}

// ── 3+4. letters + UNION-KEYED windows ───────────────────────────────
const evS1 = melEvs(p6); const evS2 = melEvs(p8); const evM1 = melEvs(p7); const evDR = drumEvs(kit);
const tracks: Array<{ label: string; evs: Ev[] }> = [
  { label: 'S1subbass', evs: evS1 }, { label: 'S2pad', evs: evS2 },
  { label: 'M1harp', evs: evM1 }, { label: 'DRUMS', evs: evDR },
];
for (const t of tracks) letters(t.evs, 1, NBARS, t.label);

console.log('\n── 4. UNION-KEYED CONTENT FLOOR ──');
{
  // per-track distinct 2-bar cells (the old condensation metric, for comparison)
  for (const t of tracks) {
    const cells = new Set<string>();
    for (let m = 1; m <= NBARS - 1; m += 2) cells.add(`${barSig(t.evs, m - 1)}|${barSig(t.evs, m)}`);
    const nonEmpty = [...cells].filter((c) => c !== '|').length;
    console.log(`  ${t.label}: distinct 2-bar cells ${nonEmpty} -> per-track floor ${Math.ceil(nonEmpty / 8)}`);
  }
  // UNION key: all four layers must agree for two windows to be "the same"
  const uni = new Map<string, number[]>();
  for (let m = 1; m <= NBARS - 1; m += 2) {
    const key = tracks.map((t) => `${barSig(t.evs, m - 1)}|${barSig(t.evs, m)}`).join('##');
    if (!uni.has(key)) uni.set(key, []);
    uni.get(key)!.push(m);
  }
  const nonRest = [...uni.entries()].filter(([k]) => k !== '|##|##|##|');
  console.log(`  UNION-keyed distinct 2-bar windows: ${nonRest.length} of ${Math.ceil((NBARS - 1) / 2)} -> HONEST FLOOR ${Math.ceil(nonRest.length / 8)} projects (by slots alone)`);
  const repeats = nonRest.filter(([, v]) => v.length > 1);
  console.log(`  union windows that repeat (bar-pairs starting at): ${repeats.map(([, v]) => v.map((m) => `m${m}`).join('=')).join('  ') || 'NONE'}`);
}

// ── 5. section merge checks (union + per-track) ──────────────────────
console.log('\n── 5. SECTION MERGE CHECKS ──');
function compareSpans(aFrom: number, aTo: number, bFrom: number, bTo: number, label: string): void {
  const L = aTo - aFrom + 1;
  if (bTo - bFrom + 1 !== L) { console.log(`  ${label}: LENGTH MISMATCH`); return; }
  const diffs: string[] = [];
  for (const t of tracks) {
    let d = 0; const bars: number[] = [];
    for (let i = 0; i < L; i++) {
      if (barSig(t.evs, aFrom - 1 + i) !== barSig(t.evs, bFrom - 1 + i)) { d++; bars.push(aFrom + i); }
    }
    if (d > 0) diffs.push(`${t.label} ${d}/${L}${d <= 6 ? ` (@m${bars.join(',m')})` : ''}`);
  }
  console.log(`  ${label}: ${diffs.length === 0 ? 'IDENTICAL on the union' : `differs: ${diffs.join('; ')}`}`);
}
compareSpans(9, 24, 41, 56, 'Verse I (m9-24) vs Verse II (m41-56)');
compareSpans(25, 40, 57, 72, 'Chorus I (m25-40) vs Chorus II (m57-72)');
compareSpans(25, 40, 105, 120, 'Chorus I (m25-40) vs Chorus III (m105-120)');
compareSpans(57, 72, 105, 120, 'Chorus II (m57-72) vs Chorus III (m105-120)');
compareSpans(73, 88, 89, 104, 'Bridge I (m73-88) vs Bridge II (m89-104)');
compareSpans(1, 8, 121, 128, 'Intro (m1-8) vs Outro head (m121-128)');
compareSpans(9, 24, 129, 144, 'Verse I (m9-24) vs Outro body (m129-144)');
console.log('  Outro tail m145-148 per track:');
for (const t of tracks) {
  const sigs = [145, 146, 147, 148].map((m) => barSig(t.evs, m - 1));
  console.log(`    ${t.label}: ${sigs.map((s, i) => `m${145 + i}=${s === '' ? '(rest)' : s.length > 60 ? `${s.slice(0, 60)}…` : s}`).join('  ')}`);
}

// ── 6. drum detail ───────────────────────────────────────────────────
console.log('\n── 6. DRUM DETAIL ──');
{
  const barOf = (b: number): number => { let mi = 0; while (mi < NBARS - 1 && barStart(mi + 1) <= b + 1e-9) mi++; return mi + 1; };
  const claps = kit.events.filter((e) => e.voice === 'clap');
  const clapBars = new Set(claps.map((e) => barOf(e.beat)));
  console.log(`  clap events: ${claps.length} across ${clapBars.size} bars (kit-40 leg must land on the SNARE pad, wire 38/stored 50)`);
  console.log(`  m25 content: ${barSig(evDR, 24) || '(rest)'}`);
  console.log(`  m26 content: ${barSig(evDR, 25) || '(rest)'}`);
  console.log(`  m27 content: ${barSig(evDR, 26) || '(rest)'}`);
  const byVoiceGhost = kit.events.filter((e) => e.ghost === true);
  console.log(`  ghost events: ${byVoiceGhost.length} (${[...new Set(byVoiceGhost.map((e) => e.voice))].join(', ')})`);
}

// ── 8. FINAL WINDOW SET checks ───────────────────────────────────────
// THE FINAL SET (plan §1): P1 scene-chained m1-24; P2-P7 plain 16-bar
// sections; P8 scene-chained m129-148. m121-128 is served by re-stomping P1
// (union-identical to m1-8, §5). Also assert the two in-project identities:
console.log('\n── 8-pre. IN-PROJECT IDENTITY ASSERTS ──');
{
  const spanEq = (aFrom: number, bFrom: number, L: number): boolean => {
    for (const t of tracks) for (let i = 0; i < L; i++) {
      if (barSig(t.evs, aFrom - 1 + i) !== barSig(t.evs, bFrom - 1 + i)) return false;
    }
    return true;
  };
  console.log(`  m9-16 == m1-8 (P1 order [Stmt,Stmt,V1close]): ${spanEq(1, 9, 8) ? 'IDENTICAL' : 'DIFFERS - STOP'}`);
  console.log(`  m137-144 == m129-136 (P8 order [OV,OV,Tail]): ${spanEq(129, 137, 8) ? 'IDENTICAL' : 'DIFFERS - STOP'}`);
  console.log(`  m147-148 == m145-146 (Tail 2 patterns): ${spanEq(145, 147, 2) ? 'IDENTICAL' : 'DIFFERS - STOP'}`);
  console.log(`  m121-128 == m1-8 (the P1 outro re-stomp): ${spanEq(1, 121, 8) ? 'IDENTICAL' : 'DIFFERS - STOP'}`);
}
const WINDOWS: Array<{ name: string; from: number; to: number }> = [
  { name: 'P1 IntroV1', from: 1, to: 24 },
  { name: 'P2 Chorus1', from: 25, to: 40 },
  { name: 'P3 Verse2', from: 41, to: 56 },
  { name: 'P4 Chorus2', from: 57, to: 72 },
  { name: 'P5 Bridge1', from: 73, to: 88 },
  { name: 'P6 Bridge2', from: 89, to: 104 },
  { name: 'P7 Chorus3', from: 105, to: 120 },
  { name: 'P8 Outro', from: 129, to: 148 },
];
console.log('\n── 8a. ELISION CHECK on the candidate window set ──');
for (const w of WINDOWS) {
  const L = w.to - w.from + 1;
  for (const t of tracks) {
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
    if (period === undefined) { console.log(`  ${w.name} [${t.label}]: through-composed`); continue; }
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
console.log('\n── 8b. CLOSING BAR per candidate window ──');
for (const w of WINDOWS) {
  for (const t of tracks) {
    const sig = barSig(t.evs, w.to - 1);
    console.log(`  ${w.name} m${w.to} [${t.label}]: ${sig === '' ? '(rest)' : sig.length > 100 ? `${sig.slice(0, 100)}…` : sig}`);
  }
}
console.log('\n── 8c. SUSTAINS CROSSING candidate boundaries ──');
{
  let crossers = 0;
  for (const w of WINDOWS) {
    if (w.to >= NBARS) continue;
    const bEnd = barStart(w.to - 1) + barLen(w.to - 1);
    for (const { fl, label } of [{ fl: p6, label: 'S1' }, { fl: p8, label: 'S2' }, { fl: p7, label: 'M1' }]) {
      for (const n of fl.notes) {
        if (n.beat < bEnd - 1e-9 && n.beat + n.durationBeats > bEnd + 1e-9) {
          crossers++;
          console.log(`  ${w.name} end (m${w.to}|m${w.to + 1}) [${label}]: ${pitchToken(n.pitch)} dur ${n.durationBeats}b crosses by ${(n.beat + n.durationBeats - bEnd).toFixed(2)}b`);
        }
      }
    }
  }
  if (crossers === 0) console.log('  NONE — every melodic note releases inside its window.');
}
console.log('\nDone.');
