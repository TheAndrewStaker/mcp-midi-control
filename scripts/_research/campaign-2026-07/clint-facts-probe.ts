/**
 * Clint Eastwood (Gorillaz, s8562 rev 6899599) plan-time facts probe.
 * READ-ONLY, offline from the cache saved by the 2026-07-29 interview-brief
 * run (samples/songsterr-cache/s8562/). No device contact. Re-runnable.
 *
 * The NEW mapping (settled 2026-07-29): synth1=t6 Synth Bass 2, synth2=t11
 * El. Grand Piano (Sample), midi1=t12 String Ensemble, midi2=t14+t15 drum
 * UNION (+ condensed internal). t16 scratch board excluded (GM 29/30 scratch,
 * outside the SPD-SX role map).
 *
 * Answers, for the re-author plan:
 *  1. Tempo map + metre map verify (85 flat; the 2/4 bar location).
 *  2. Per-lane facts: note counts, ranges, max-simultaneous (MicroFreak
 *     paraphony check on t12; 6-note step cap on t11), velocity spread.
 *  3. Drum union census: voices per part, timbale/openhat/crash, fold
 *     collisions (loudest-wins), per-bar letters, velocity levels.
 *  4. KEY REGIONS from the source itself: per-section pitch-class profile of
 *     t6/t11/t12 (E-major pcs E+A vs Eb-minor pcs F+Bb distinctive), crash
 *     bars from t14, correlation. (The old pad's Emaj/Ebm rule was a hand
 *     guess; does the SOURCE carry a key change?)
 *  5. Union-keyed 2-bar window letters per section (interview packing) +
 *     cross-section window identity (V1 vs V2, C1 vs C2, S2/S3...).
 *  6. Boundary elision checks (Schism lesson): does any window set cut a
 *     repeating cycle one bar early at each section boundary?
 *  7. t16 confirm-zero + off-grid detail for t14 (128 moved onsets).
 *
 * Run: npx tsx samples/_scratch/clint-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s8562';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const meta = JSON.parse(readFileSync(`${CACHE}/meta.json`, 'utf8')) as { songId: number; revisionId: number };
console.log(`source: s${meta.songId} rev ${meta.revisionId}`);

// ── 1. tempo + metre ────────────────────────────────────────────────
const t6f = flattenSongsterrMelodic(loadPart(6));
const t11f = flattenSongsterrMelodic(loadPart(11));
const t12f = flattenSongsterrMelodic(loadPart(12));
const t14f = flattenSongsterrDrums(loadPart(14));
const t15f = flattenSongsterrDrums(loadPart(15));
const measures = t14f.measures;
console.log(`\n-- 1. tempo marks: ${JSON.stringify(t14f.tempos)}`);
const sigH = new Map<string, number>();
measures.forEach((m, i) => {
  const k = m.signature.join('/');
  sigH.set(k, (sigH.get(k) ?? 0) + 1);
  if (k !== '4/4') console.log(`   non-4/4 bar: m${i + 1} = ${k}`);
});
console.log(`   metre: ${[...sigH.entries()].map(([k, n]) => `${k} x${n}`).join(', ')}; bars=${measures.length}`);
console.log(`   sections: ${JSON.stringify(t14f.sections?.map((s) => `m${s.measure} ${s.name}`) ?? [])}`);

const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];

// ── 2. melodic lane facts ───────────────────────────────────────────
interface MelTok { beat: number; token: string }
function melFacts(label: string, fl: ReturnType<typeof flattenSongsterrMelodic>): MelTok[] {
  const notes = fl.notes;
  const byBeat = new Map<number, number>();
  for (const n of notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxSim = Math.max(0, ...byBeat.values());
  const vels = new Map<number | string, number>();
  for (const n of notes) vels.set(n.velocity ?? 'def', (vels.get(n.velocity ?? 'def') ?? 0) + 1);
  const lo = Math.min(...notes.map((n) => n.pitch));
  const hi = Math.max(...notes.map((n) => n.pitch));
  const offgrid = notes.filter((n) => Math.abs(n.beat * 4 - Math.round(n.beat * 4)) > 1e-6).length;
  console.log(`   ${label}: ${notes.length} notes, range ${lo}..${hi}, maxSimultaneous=${maxSim}, ` +
    `offgrid16=${offgrid}, velocities=${JSON.stringify([...vels.entries()].sort())}`);
  return notes.map((n) => ({ beat: n.beat, token: `${n.pitch}:${n.durationBeats}:${n.velocity ?? 'd'}` }));
}
console.log('\n-- 2. melodic lanes');
const t6toks = melFacts('t6 SynthBass->synth1', t6f);
const t11toks = melFacts('t11 ElGrand->synth2', t11f);
const t12toks = melFacts('t12 Strings->midi1', t12f);

// ── 3. drum union facts ─────────────────────────────────────────────
console.log('\n-- 3. drums');
for (const [label, fl] of [['t14 Drums(Sample)', t14f], ['t15 Percution', t15f]] as const) {
  const vh = new Map<string, number>();
  for (const e of fl.events) vh.set(e.voice, (vh.get(e.voice) ?? 0) + 1);
  const velH = new Map<number | string, number>();
  for (const e of fl.events) velH.set(e.velocity ?? 'def', (velH.get(e.velocity ?? 'def') ?? 0) + 1);
  const offgrid = fl.events.filter((e) => Math.abs(e.beat * 4 - Math.round(e.beat * 4)) > 1e-6).length;
  console.log(`   ${label}: ${fl.events.length} events, voices=${JSON.stringify([...vh.entries()].sort())}`);
  console.log(`     velocities=${JSON.stringify([...velH.entries()].sort())}, offgrid16=${offgrid}, ` +
    `unmapped=${JSON.stringify(fl.unmapped_numbers ?? {})}`);
}
const t16f = flattenSongsterrDrums(loadPart(16));
console.log(`   t16 Scratch: ${t16f.events.length} mapped events, unmapped=${JSON.stringify(t16f.unmapped_numbers ?? {})} (EXCLUDED from the build)`);

// union events (loudest wins is realized at fold time; here token = voice@vel)
interface Ev { beat: number; key: string }
const dEv = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] =>
  fl.events.map((e) => ({ beat: e.beat, key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}` }));
const unionEv: Ev[] = [...dEv(t14f), ...dEv(t15f)];
// collision census: same 16th step, same voice, both parts
{
  const seen = new Map<string, number>();
  for (const e of unionEv) {
    const k = `${Math.round(e.beat * 4)}|${e.key.split('@')[0]}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const collisions = [...seen.values()].filter((n) => n > 1).length;
  console.log(`   union: ${unionEv.length} events; same-step same-voice collisions (loudest-wins folds): ${collisions}`);
}
// crash + timbale/tom bars
const barOf = (beat: number): number => {
  for (let i = measures.length - 1; i >= 0; i--) if (beat >= barStart(i) - 1e-9) return i + 1;
  return 1;
};
const crashBars = [...new Set(t14f.events.filter((e) => e.voice === 'crash').map((e) => barOf(e.beat)))].sort((a, b) => a - b);
const crashBars15 = [...new Set(t15f.events.filter((e) => e.voice === 'crash').map((e) => barOf(e.beat)))].sort((a, b) => a - b);
console.log(`   crash bars t14: ${crashBars.join(',')}`);
console.log(`   crash bars t15: ${crashBars15.join(',') || '(none)'}`);
for (const v of ['tom', 'timbale', 'openhat', 'ride', 'perc', 'clap']) {
  const bars14 = [...new Set(t14f.events.filter((e) => e.voice === v).map((e) => barOf(e.beat)))];
  const bars15 = [...new Set(t15f.events.filter((e) => e.voice === v).map((e) => barOf(e.beat)))];
  if (bars14.length + bars15.length > 0) {
    console.log(`   voice '${v}': t14 ${bars14.length} bars [${bars14.slice(0, 12).join(',')}${bars14.length > 12 ? '…' : ''}]  t15 ${bars15.length} bars [${bars15.slice(0, 12).join(',')}${bars15.length > 12 ? '…' : ''}]`);
  }
}

// ── 4. key regions from the source ──────────────────────────────────
console.log('\n-- 4. key regions (pitch classes per section, t6+t11+t12)');
const SECTIONS: Array<{ name: string; from: number; to: number }> = [
  { name: 'Intro', from: 1, to: 15 }, { name: 'Verse 1', from: 16, to: 31 },
  { name: 'Chorus 1', from: 32, to: 41 }, { name: 'Verse 2', from: 42, to: 57 },
  { name: 'Chorus 2', from: 58, to: 67 }, { name: 'Solo 1', from: 68, to: 88 },
  { name: 'Solo 2', from: 89, to: 103 }, { name: 'Solo 3', from: 104, to: 117 },
  { name: 'Outro', from: 118, to: 123 },
];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
for (const s of SECTIONS) {
  const b0 = barStart(s.from - 1); const b1 = barStart(s.to - 1) + barLen(s.to - 1);
  const pcs = new Map<number, number>();
  for (const [, toks] of [['t6', t6toks], ['t11', t11toks], ['t12', t12toks]] as const) {
    for (const t of toks) {
      if (t.beat >= b0 - 1e-9 && t.beat < b1 - 1e-9) {
        const pc = Number(t.token.split(':')[0]) % 12;
        pcs.set(pc, (pcs.get(pc) ?? 0) + 1);
      }
    }
  }
  const prof = [...pcs.entries()].sort((a, b) => b[1] - a[1]).map(([pc, n]) => `${NAMES[pc]}×${n}`).join(' ');
  const eMajor = (pcs.get(4) ?? 0) + (pcs.get(9) ?? 0);   // E + A
  const ebMinor = (pcs.get(5) ?? 0) + (pcs.get(10) ?? 0); // F + Bb
  const crashN = crashBars.filter((b) => b >= s.from && b <= s.to).length;
  console.log(`   ${s.name} (m${s.from}-${s.to}): ${prof}`);
  console.log(`     E-major evidence (E,A): ${eMajor}  Eb-minor evidence (F,Bb): ${ebMinor}  crash bars: ${crashN}`);
}

// ── 5. union-keyed window letters per the interview packing ─────────
console.log('\n-- 5. union-keyed 2-bar windows (letters global across the song)');
// windows per section: pairs of bars from the section start; odd tail = 1-bar window
interface Win { label: string; bars: number[] }
const wins: Win[] = [];
for (const s of SECTIONS) {
  // interview split: Solo 1 m68-78 + m79-88
  const spans = s.name === 'Solo 1' ? [[68, 78], [79, 88]] : [[s.from, s.to]];
  for (const [f, t] of spans) {
    for (let m = f; m <= t; m += 2) {
      const bars = m + 1 <= t ? [m, m + 1] : [m];
      wins.push({ label: `${s.name}${spans.length > 1 ? (f === 68 ? 'a' : 'b') : ''}`, bars });
    }
  }
}
const barSigOf = (evs: Ev[], mi1: number): string => {
  const b0 = barStart(mi1 - 1); const b1 = b0 + barLen(mi1 - 1);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${Math.round((e.beat - b0) * 4 * 100) / 100}:${e.key}`).sort().join(',');
};
const melEv = (toks: MelTok[]): Ev[] => toks.map((t) => ({ beat: t.beat, key: t.token }));
const LANES: Array<[string, Ev[]]> = [
  ['s1', melEv(t6toks)], ['s2', melEv(t11toks)], ['m1', melEv(t12toks)], ['m2', unionEv],
];
const reg = new Map<string, string>();
const laneRegs = new Map<string, Map<string, string>>();
const winSigs: string[] = [];
const winLaneLetters = new Map<string, string[]>();
for (const [lane] of LANES) winLaneLetters.set(lane, []);
for (const w of wins) {
  const laneParts: string[] = [];
  for (const [lane, evs] of LANES) {
    const sig = `${w.bars.length}|${w.bars.map((b) => barSigOf(evs, b)).join(';')}`;
    laneParts.push(sig);
    let lreg = laneRegs.get(lane);
    if (!lreg) { lreg = new Map(); laneRegs.set(lane, lreg); }
    const empty = w.bars.every((b) => barSigOf(evs, b) === '');
    let letter = '.';
    if (!empty) {
      letter = lreg.get(sig) ?? String.fromCharCode(65 + lreg.size);
      lreg.set(sig, letter);
    }
    winLaneLetters.get(lane)!.push(letter);
  }
  const uSig = laneParts.join('||');
  let letter = reg.get(uSig);
  if (!letter) {
    const n = reg.size;
    letter = n < 26 ? String.fromCharCode(65 + n) : `a${n - 26}`;
    reg.set(uSig, letter);
  }
  winSigs.push(letter);
}
let wi = 0;
for (const s of SECTIONS) {
  const spans = s.name === 'Solo 1' ? [[68, 78], [79, 88]] : [[s.from, s.to]];
  for (const [f, t] of spans) {
    const n = Math.ceil((t - f + 1) / 2);
    const letters = winSigs.slice(wi, wi + n);
    const lanes = LANES.map(([lane]) => `${lane}:${winLaneLetters.get(lane)!.slice(wi, wi + n).join('')}`).join(' ');
    console.log(`   ${s.name}${spans.length > 1 ? (f === 68 ? ' (1/2)' : ' (2/2)') : ''} m${f}-${t}: UNION ${letters.join(' ')}`);
    console.log(`      ${lanes}`);
    wi += n;
  }
}
console.log(`   TOTAL windows ${wins.length}; distinct UNION cells ${reg.size}`);
for (const [lane, lreg] of laneRegs) console.log(`   lane ${lane}: ${lreg.size} distinct non-empty cells`);

// ── 6. cross-section window identity ────────────────────────────────
console.log('\n-- 6. cross-section identity (per union window)');
const secWins = (name: string): number[] => wins.map((w, i) => ({ w, i })).filter((x) => x.w.label.startsWith(name)).map((x) => x.i);
const cmp = (a: string, b: string): void => {
  const A = secWins(a); const B = secWins(b);
  const n = Math.min(A.length, B.length);
  let same = 0;
  const diffs: string[] = [];
  for (let i = 0; i < n; i++) {
    if (winSigs[A[i]] === winSigs[B[i]]) same++;
    else diffs.push(`w${i + 1}(m${wins[A[i]].bars[0]} vs m${wins[B[i]].bars[0]})`);
  }
  console.log(`   ${a} vs ${b}: ${same}/${n} windows identical${A.length !== B.length ? ` (lengths differ ${A.length}/${B.length})` : ''}${diffs.length > 0 ? `; differ: ${diffs.join(' ')}` : ''}`);
};
cmp('Verse 1', 'Verse 2'); cmp('Chorus 1', 'Chorus 2');
cmp('Solo 2', 'Solo 3'); cmp('Solo 1a', 'Solo 1b'); cmp('Solo 1b', 'Solo 2');

// ── 7. boundary elision checks ──────────────────────────────────────
console.log('\n-- 7. elision at section boundaries (last-window bar vs next section head, per lane)');
for (let si = 0; si < SECTIONS.length - 1; si++) {
  const s = SECTIONS[si]; const next = SECTIONS[si + 1];
  for (const [lane, evs] of LANES) {
    const lastBar = barSigOf(evs, s.to);
    const headBar = barSigOf(evs, next.from);
    // does the section's closing phrase content match a bar INSIDE the section (loop-clean),
    // or does the phrase's closer sit at next.from (elided)?
    const insideMatch = Array.from({ length: s.to - s.from }, (_, k) => s.from + k).some((b) => barSigOf(evs, b) === headBar);
    if (headBar !== '' && !insideMatch) {
      console.log(`   ${s.name}->${next.name} lane ${lane}: next-head bar m${next.from} content is NEW (not in ${s.name}); wrap plays ${s.name}'s own head - check by ear whether the phrase closes in-window (lastBar ${lastBar === '' ? 'EMPTY' : 'content'})`);
    }
  }
}
console.log('\n(done)');
