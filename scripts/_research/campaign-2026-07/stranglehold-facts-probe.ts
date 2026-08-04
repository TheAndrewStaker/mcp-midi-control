/**
 * Stranglehold (Ted Nugent, s403 r8042866) re-author plan-time facts probe.
 * READ-ONLY, offline from samples/songsterr-cache/s403/ (fetched 2026-07-30,
 * revision 8042866 == THE PIN, taken at first fetch). Re-runnable. No device.
 *
 * NOTE the roster SHIFTED vs the stale song doc (which cited "part 7 = kit,
 * part 5 = Reverse Cymbal"): at r8042866 the kit is part 8, part 7 is a
 * Drawbar Organ "Layered Guitar Feedback", part 5 is Drums "Reverse Cymbal".
 *
 * Answers, for the rebuild plan:
 *   1. Tempo map (verify the card's 72), markers, signatures, measure count.
 *   2. Part censuses: p8 kit -> midi2; p7 feedback organ (the candidate source
 *      of the card's undocumented midi1 drone layer: stored 52/58/59 dyads);
 *      p5 reverse cymbal (excluded by the old build); p4+p6 bass (his hands;
 *      locate the bass solo bars for the fold fork).
 *   3. Per-bar letters (kit; feedback organ) m1-153.
 *   4. UNION-KEYED distinct 2-bar windows: drums-only AND drums+feedback.
 *   5. Section merge checks per the old plan's map (Main regions, Bridge
 *      revisits, Solo3 vs Main groove, Outro).
 *   6. Source grids for the pattern-defining 2-bar windows in the card-audit's
 *      "step:note" shape (fill m7-8, groove m9-10, fills, F, G/H/I/J, K, L, M,
 *      N) so plan + audit can be diffed line by line.
 *   7. Elision / closing-bar / sustain-crosser checks on the candidate window
 *      sets (6-project carry shape and the 5-project BassSolo-fold shape).
 *
 * Run: npx tsx samples/_scratch/stranglehold-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s403';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const NBARS = 153;

// ── 1. tempo + markers, from the tab itself ──────────────────────────
console.log('── 1. TEMPO + MARKERS ──');
for (const id of [0, 4, 5, 6, 7, 8]) {
  const p = loadPart(id) as unknown as { automations?: { tempo?: unknown } };
  console.log(`  part-${id} automations.tempo: ${JSON.stringify(p.automations?.tempo ?? '(absent)')}`);
}
{
  const raw = loadPart(8) as unknown as { measures: Array<{ marker?: { text: string } }> };
  console.log(`  markers: ${raw.measures.map((m, i) => (m.marker ? `m${i + 1}=${m.marker.text}` : '')).filter(Boolean).join(', ')}`);
}

const kit = flattenSongsterrDrums(loadPart(8));
const measures = kit.measures;
{
  const h = new Map<string, number>();
  for (const m of measures) h.set(m.signature.join('/'), (h.get(m.signature.join('/')) ?? 0) + 1);
  console.log(`  measures: ${measures.length}; signatures: ${[...h.entries()].map(([s, n]) => `${s} x${n}`).join(', ')}`);
}
interface Ev { beat: number; key: string }
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];
const barOf = (b: number): number => { let mi = 0; while (mi < NBARS - 1 && barStart(mi + 1) <= b + 1e-9) mi++; return mi + 1; };
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

// ── 2. part censuses ─────────────────────────────────────────────────
console.log('\n── 2. PARTS ──');
function melCensus(id: number, label: string): ReturnType<typeof flattenSongsterrMelodic> {
  const fl = flattenSongsterrMelodic(loadPart(id));
  const notes = [...fl.notes].sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
  if (notes.length === 0) { console.log(`  ${label} (part ${id}): EMPTY`); return fl; }
  const byBeat = new Map<number, number>();
  for (const n of notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = Math.max(...byBeat.values());
  const vels = new Map<string, number>();
  for (const n of fl.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const durs = new Map<number, number>();
  for (const n of fl.notes) durs.set(n.durationBeats, (durs.get(n.durationBeats) ?? 0) + 1);
  const pitches = new Map<number, number>();
  for (const n of fl.notes) pitches.set(n.pitch, (pitches.get(n.pitch) ?? 0) + 1);
  const lo = Math.min(...notes.map((n) => n.pitch)); const hi = Math.max(...notes.map((n) => n.pitch));
  console.log(`  ${label} (part ${id}): notes ${notes.length}, max chord ${maxChord}, range ${pitchToken(lo)}(${lo})-${pitchToken(hi)}(${hi}), ties folded ${fl.notes.filter((n) => n.tie === true).length}`);
  console.log(`    pitches: ${[...pitches.entries()].sort((a, b) => a[0] - b[0]).map(([p, n]) => `${pitchToken(p)}(${p})x${n}`).join(' ')}`);
  console.log(`    durations(beats): ${[...durs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d, n]) => `${d}x${n}`).join(' ')}`);
  console.log(`    velocities: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  offGridStats(fl, label);
  console.log(`    sounds m${barOf(notes[0].beat)} .. m${barOf(notes[notes.length - 1].beat)}`);
  return fl;
}
console.log(`  KIT -> midi2 (part 8): events ${kit.events.length}, ghosts ${kit.ghosts}, accents ${kit.accents}, flams ${kit.flams_collapsed}, graces ${kit.graces_folded}, unmapped ${kit.unmapped}`);
{
  const vels = new Map<string, number>();
  for (const e of kit.events) { const k = String(e.velocity ?? 'default'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  console.log(`    velocity census: ${[...vels.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  const voices = new Map<string, number>();
  for (const e of kit.events) voices.set(e.voice, (voices.get(e.voice) ?? 0) + 1);
  console.log(`    voice census: ${[...voices.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
  offGridStats(kit, 'KIT');
  const beats = kit.events.map((e) => e.beat).sort((a, b) => a - b);
  console.log(`    sounds m${barOf(beats[0])} .. m${barOf(beats[beats.length - 1])}`);
}
const p7 = melCensus(7, 'FEEDBACK ORGAN (midi1-drone candidate)');
// reverse cymbal is a Drums-typed part: census it as drums
{
  const rc = flattenSongsterrDrums(loadPart(5));
  const voices = new Map<string, number>();
  for (const e of rc.events) voices.set(e.voice, (voices.get(e.voice) ?? 0) + 1);
  const bars = [...new Set(rc.events.map((e) => barOf(e.beat)))].sort((a, b) => a - b);
  console.log(`  REVERSE CYMBAL (part 5, drums): events ${rc.events.length}, unmapped ${rc.unmapped}, voices: ${[...voices.entries()].map(([v, n]) => `${v} ${n}`).join(', ') || '(none mapped)'}`);
  console.log(`    bars with events: ${bars.map((b) => `m${b}`).join(' ')}`);
}
// bass parts: where does the bass play / solo (his hands; fork context only)
for (const id of [4, 6]) {
  const fl = flattenSongsterrMelodic(loadPart(id));
  const byBar = new Map<number, number>();
  for (const n of fl.notes) { const b = barOf(n.beat); byBar.set(b, (byBar.get(b) ?? 0) + 1); }
  const dense = [...byBar.entries()].filter(([, n]) => n >= 8).map(([b]) => b).sort((a, b) => a - b);
  console.log(`  BASS part ${id}: notes ${fl.notes.length}; bars with >=8 onsets (solo-density): ${dense.map((b) => `m${b}`).join(' ') || 'none'}`);
}

// ── 3. letters ───────────────────────────────────────────────────────
function letters(evs: Ev[], from: number, to: number, label: string): string[] {
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
  console.log(`\n${label} per-bar letters m${from}-m${to} ('.'=rest):`);
  for (let i = 0; i < out.length; i += 16) {
    console.log(`  m${String(from + i).padStart(3)}: ${out.slice(i, i + 16).join(' ')}`);
  }
  console.log(`  distinct content bars: ${seen.size}`);
  return out;
}
const evDR = drumEvs(kit);
const evFB = melEvs(p7);
letters(evDR, 1, NBARS, 'KIT');
letters(evFB, 1, NBARS, 'FEEDBACK');

// ── 4. union-keyed windows ───────────────────────────────────────────
console.log('\n── 4. UNION-KEYED CONTENT FLOOR ──');
function windowCensus(trks: Array<{ label: string; evs: Ev[] }>, tag: string): void {
  for (const t of trks) {
    const cells = new Set<string>();
    for (let m = 1; m <= NBARS - 1; m += 2) cells.add(`${barSig(t.evs, m - 1)}|${barSig(t.evs, m)}`);
    const nonEmpty = [...cells].filter((c) => c !== '|').length;
    console.log(`  [${tag}] ${t.label}: distinct 2-bar cells ${nonEmpty} -> per-track floor ${Math.ceil(nonEmpty / 8)}`);
  }
  const uni = new Map<string, number[]>();
  for (let m = 1; m <= NBARS - 1; m += 2) {
    const key = trks.map((t) => `${barSig(t.evs, m - 1)}|${barSig(t.evs, m)}`).join('##');
    if (!uni.has(key)) uni.set(key, []);
    uni.get(key)!.push(m);
  }
  const rest = trks.map(() => '|').join('##');
  const nonRest = [...uni.entries()].filter(([k]) => k !== rest);
  console.log(`  [${tag}] UNION distinct 2-bar windows: ${nonRest.length} of ${Math.ceil((NBARS - 1) / 2)} -> floor ${Math.ceil(nonRest.length / 8)} by slots alone`);
}
windowCensus([{ label: 'KIT', evs: evDR }], 'drums-only');
windowCensus([{ label: 'KIT', evs: evDR }, { label: 'FEEDBACK', evs: evFB }], 'drums+feedback');

// ── 5. section merge checks ──────────────────────────────────────────
console.log('\n── 5. SECTION MERGE CHECKS (kit, then kit+feedback) ──');
const tracksBoth = [{ label: 'KIT', evs: evDR }, { label: 'FEEDBACK', evs: evFB }];
function compareSpans(aFrom: number, aTo: number, bFrom: number, bTo: number, label: string): void {
  const L = aTo - aFrom + 1;
  if (bTo - bFrom + 1 !== L) { console.log(`  ${label}: LENGTH MISMATCH`); return; }
  const diffs: string[] = [];
  for (const t of tracksBoth) {
    let d = 0; const bars: number[] = [];
    for (let i = 0; i < L; i++) {
      if (barSig(t.evs, aFrom - 1 + i) !== barSig(t.evs, bFrom - 1 + i)) { d++; bars.push(aFrom + i); }
    }
    if (d > 0) diffs.push(`${t.label} ${d}/${L}${d <= 6 ? ` (@m${bars.join(',m')})` : ''}`);
  }
  console.log(`  ${label}: ${diffs.length === 0 ? 'IDENTICAL (kit + feedback)' : `differs: ${diffs.join('; ')}`}`);
}
compareSpans(9, 24, 37, 52, 'Main A (m9-24) vs Main B (m37-52)');
compareSpans(9, 16, 25, 32, 'Main loop pass 1 (m9-16) vs m25-32');
compareSpans(9, 12, 117, 120, 'Main head (m9-12) vs Verse 3 (m117-120)');
compareSpans(9, 24, 129, 144, 'Main (m9-24) vs Pre-Verse/Verse 4 (m129-144)');
compareSpans(111, 116, 121, 126, 'Bridge (m111-116) vs Bridge 2 head (m121-126)');
compareSpans(33, 36, 9, 12, 'BassSolo (m33-36) vs Main head (m9-12)');
compareSpans(53, 60, 9, 16, 'Solo3 head (m53-60) vs Main head (m9-16)');
console.log('  Outro span m145-153 per track:');
for (const t of tracksBoth) {
  const sigs: string[] = [];
  for (let m = 145; m <= NBARS; m++) sigs.push(`m${m}=${barSig(t.evs, m - 1) === '' ? '(rest)' : barSig(t.evs, m - 1).length > 50 ? `${barSig(t.evs, m - 1).slice(0, 50)}…` : barSig(t.evs, m - 1)}`);
  console.log(`    ${t.label}: ${sigs.join('  ')}`);
}

// ── 6. source grids for pattern-defining windows (audit-comparable) ──
console.log('\n── 6. SOURCE 2-BAR GRIDS (steps at 16ths, GM+12 stored-note view) ──');
const GM_STORED: Record<string, number> = {
  kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63, clap: 50, perc: 68,
};
function grid2(mFrom: number, label: string): void {
  const b0 = barStart(mFrom - 1);
  const cells: string[] = [];
  for (const e of kit.events) {
    const rel = (e.beat - b0) * 4;
    if (rel < -1e-6 || rel >= 32 - 1e-6) continue;
    const stored = GM_STORED[e.voice] ?? -1;
    cells.push(`${Math.round(rel * 2) / 2}:${stored}${e.velocity !== undefined ? `v${e.velocity}` : ''}${e.accent === true ? '!' : ''}${e.ghost === true ? '~' : ''}`);
  }
  cells.sort((a, b) => parseFloat(a) - parseFloat(b));
  console.log(`  ${label} (m${mFrom}-${mFrom + 1}): ${cells.join(' ') || '(rest)'}`);
}
grid2(7, 'FILL   B');
grid2(9, 'GROOVE C');
grid2(19, 'window m19');
grid2(31, 'window m31');
grid2(33, 'BASSSOLO F');
grid2(35, 'window m35');
for (let m = 53; m <= 109; m += 2) grid2(m, `solo3 m${m}`);
grid2(111, 'BRIDGE L');
grid2(113, 'window m113');
grid2(115, 'window m115');
grid2(121, 'window m121');
grid2(127, 'window m127');
grid2(145, 'OUTRO N');
grid2(147, 'window m147');

// ── 7. window-set checks ─────────────────────────────────────────────
const WINDOWS: Array<{ name: string; from: number; to: number }> = [
  { name: 'P1 Intro', from: 1, to: 8 },
  { name: 'P2 Main', from: 9, to: 24 },
  { name: 'P3 BassSolo', from: 33, to: 36 },
  { name: 'P4 Solo3', from: 53, to: 110 },
  { name: 'P5 Bridge', from: 111, to: 116 },
  { name: 'P6 Outro', from: 145, to: NBARS },
];
console.log('\n── 7a. ELISION CHECK on candidate windows ──');
for (const w of WINDOWS) {
  const L = w.to - w.from + 1;
  for (const t of tracksBoth) {
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
    if (period === undefined) { console.log(`  ${w.name} [${t.label}]: through-composed (best period ${bestP} at ${(bestRatio * 100).toFixed(0)}%)`); continue; }
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
console.log('\n── 7b. CLOSING BAR per candidate window ──');
for (const w of WINDOWS) {
  for (const t of tracksBoth) {
    const sig = barSig(t.evs, w.to - 1);
    console.log(`  ${w.name} m${w.to} [${t.label}]: ${sig === '' ? '(rest)' : sig.length > 90 ? `${sig.slice(0, 90)}…` : sig}`);
  }
}
console.log('\n── 7c. FEEDBACK sustains crossing candidate boundaries ──');
{
  let crossers = 0;
  for (const w of WINDOWS) {
    if (w.to >= NBARS) continue;
    const bEnd = barStart(w.to - 1) + barLen(w.to - 1);
    for (const n of p7.notes) {
      if (n.beat < bEnd - 1e-9 && n.beat + n.durationBeats > bEnd + 1e-9) {
        crossers++;
        console.log(`  ${w.name} end (m${w.to}|m${w.to + 1}): ${pitchToken(n.pitch)} dur ${n.durationBeats}b crosses by ${(n.beat + n.durationBeats - bEnd).toFixed(2)}b`);
      }
    }
  }
  if (crossers === 0) console.log('  NONE — every feedback note releases inside its window.');
}
console.log('\nDone.');
