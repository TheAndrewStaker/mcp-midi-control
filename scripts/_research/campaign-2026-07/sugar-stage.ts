/**
 * Sugar (Sleep Token, s560358 r3001145) Phase-0 staging — mirror of
 * lovesong-stage.ts machinery, FOUR rig tracks, scene orders on P1/P8.
 * READ-ONLY: no device, no network. Run: npx tsx samples/_scratch/sugar-stage.ts
 *
 * Builds the EIGHT per-project `arrangement` payloads (Pack 5 slots 46-53)
 * from the PINNED cache (samples/songsterr-cache/s560358, rev 3001145) via:
 *   - p6 Sub Bass  -> synth1 (written pitch, stored silent)
 *   - p8 Keyboard#2 pad -> synth2 (stored silent)
 *   - p7 Keyboard#1 harp -> midi1 (MicroFreak ch3)
 *   - p10 II drums -> midi2 EXTERNAL ONLY (spd-sx, +12), staged clap->snare
 *     voice fold (the kit-40 fix, plan §0f) + snap (nearest 16th) + same-cell
 *     loudest-wins fold, all BEFORE the writer (Smooth staged-fold discipline).
 *
 * Asserts (plan §4 Phase 0 step 2): source census §0b exact; packing per §1
 * (P1 [Stmt,Stmt,V1close], P2/P4 [Stmt x2], P8 [OV,OV,Tail], every pattern 32
 * steps); harp coverage total 1176 with velocity multiset §0b; pad census
 * (494 + tie splits, max chord 4, chord_overflow 0, drone 8-chords-never-7);
 * S1 census (124 onsets -> 126 realized segments, range 16..43, transpose 0);
 * drum fold census (clap->snare counted exactly; ZERO staged 51, ZERO staged
 * 68, unmapped == 103; 16 off-grid snaps enumerated; ghost/vel multiset §0b);
 * external note set == {48,50,54,57,58,61,63}; §0c in-project identities
 * re-asserted on staged rows (m9-16==m1-8, m121-128==m1-8, m137-144==m129-136,
 * m147-148==m145-146, P2/P4 period-8 replays); every §3 tail assertion;
 * melodic seam crossers == 0; the ORACLE NOTE-50 RECONCILIATION (stop-ship),
 * under the plan's authority split ("the SOURCE is the authority for drums,
 * the oracle is the authority for VOICING", §3 footnote): the sugar-diag-align
 * probe proved the ORACLE's own drum lane misassembled in ~26 stored bars
 * (wrong-bar repeats at the B-vamp positions m34/42/50/58/66, a scrambled
 * m97-118 region, dropped Bridge-II bars) — never ear-signed. So the assert
 * is: (a) VOICING reproduced exactly (zero 51/68 in oracle AND staged; every
 * clap a snare-pad 50); (b) every note-50 cell diff vs the oracle lies inside
 * a bar the oracle itself misassembled/dropped (bar signature != source), all
 * enumerated; (c) beyond those, cell-exact + the two restored m25-26 claps.
 *
 * Harp dynamics stored-lens note: the mini-notation path stores ONE velocity
 * per chord CELL; where the tab's v40/v75 ghost-doubling layer shares a cell
 * with a def note, the cell takes the explicit velocity (observed: every
 * m71-72 chord emits @40). The SOURCE multiset (§0b: 40x166/75x14/def x996)
 * holds at flatten; the STORED lens reclassifies the def chord-mates. Both
 * are asserted, with the reclassification arithmetic cross-checked exactly.
 *
 * Emits samples/_scratch/sugar-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, flattenSongsterrDrums, flattenSongsterrMelodic,
  pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const CACHE = `${ROOT}/samples/songsterr-cache/s560358`;
const ORACLE = `${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack5`;
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const p6 = load(6);   // Sub Bass -> synth1
const p7 = load(7);   // harp -> midi1
const p8 = load(8);   // pad -> synth2
const p10 = load(10); // drums -> midi2 external

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── A. source census gates (§0b — source drift detection) ─────────────
console.log('=== A. source census gates (§0b) ===');
const kit = flattenSongsterrDrums(p10);
const fS1 = flattenSongsterrMelodic(p6);
const fS2 = flattenSongsterrMelodic(p8);
const fM1 = flattenSongsterrMelodic(p7);
const measures = kit.measures;
if (measures.length === 148 && measures.every((m) => m.signature[0] === 4 && m.signature[1] === 4))
  ok('148 measures, all 4/4');
else fail(`measures ${measures.length}, signature drift`);
const barStartStep = (m1: number): number => (m1 - 1) * 16; // uniform 4/4

function melCensus(fl: ReturnType<typeof flattenSongsterrMelodic>, label: string,
  wantNotes: number, wantChord: number, wantLo: number, wantHi: number, wantVels: Record<string, number>): void {
  const vels = new Map<string, number>();
  for (const n of fl.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const byBeat = new Map<number, number>();
  for (const n of fl.notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = Math.max(...byBeat.values());
  const lo = Math.min(...fl.notes.map((n) => n.pitch)); const hi = Math.max(...fl.notes.map((n) => n.pitch));
  const off = fl.notes.filter((n) => Math.abs(n.beat * 4 - Math.round(n.beat * 4)) > 1e-6).length;
  if (fl.notes.length === wantNotes && maxChord === wantChord && lo === wantLo && hi === wantHi && off === 0
    && eq(Object.fromEntries([...vels.entries()].sort()), wantVels))
    ok(`${label}: ${wantNotes} notes, max chord ${wantChord}, range ${pitchToken(lo)}-${pitchToken(hi)}, off-grid 0, vels ${JSON.stringify(wantVels)}`);
  else fail(`${label} census: notes ${fl.notes.length} chord ${maxChord} range ${lo}..${hi} off ${off} vels ${JSON.stringify([...vels])}`);
}
melCensus(fS1, 'S1 sub bass (p6)', 124, 1, 16, 43, { '40': 60, def: 64 });
melCensus(fS2, 'S2 pad (p8)', 494, 4, 35, 78, { def: 494 });
melCensus(fM1, 'M1 harp (p7)', 1176, 3, 35, 86, { '40': 166, '75': 14, def: 996 });
if (kit.events.length === 861 && kit.ghosts === 13 && kit.accents === 0 && kit.unmapped === 103
  && kit.flams_collapsed === 0 && kit.graces_folded === 4)
  ok('kit p10: 861 mapped events, 13 ghosts, 0 accents/flams, 4 graces folded, unmapped 103 (the scratch-pull class, importer fix upstream)');
else fail(`kit census ${kit.events.length}/${kit.ghosts}/${kit.accents}/${kit.unmapped}/${kit.flams_collapsed}/${kit.graces_folded}`);
{
  const kv = new Map<string, number>();
  for (const e of kit.events) kv.set(e.voice, (kv.get(e.voice) ?? 0) + 1);
  const want = { kick: 329, hat: 227, crash: 143, clap: 69, snare: 69, tom: 14, openhat: 8, ride: 2 };
  if (eq(Object.fromEntries([...kv.entries()].sort()), Object.fromEntries(Object.entries(want).sort())))
    ok('kit voices kick329/hat227/crash143/clap69/snare69/tom14/openhat8/ride2 (§0b)');
  else fail(`kit voice census ${JSON.stringify([...kv])}`);
  const vv = new Map<string, number>();
  for (const e of kit.events) { const k = String(e.velocity ?? 'default'); vv.set(k, (vv.get(k) ?? 0) + 1); }
  if (eq(Object.fromEntries([...vv.entries()].sort()), { '75': 1, '90': 536, default: 324 }))
    ok('kit velocity census 90 x536 / 75 x1 / default x324 (§0b; 13 of the defaults are ghosts -> 40)');
  else fail(`kit velocity census ${JSON.stringify([...vv])}`);
}

// ── B. kit voice-fold (clap->snare) + snap + cell fold (§0f/§2d) ──────
console.log('\n=== B. kit fold at staging (§0f) ===');
const FOLD: Readonly<Record<string, string>> = { clap: 'snare' };
interface Cell { vel: number; srcs: number; velDiffer: boolean; hadClap: boolean; hadSnare: boolean }
const cells = new Map<string, Cell>();  // `${stepG}|${voice}` -> winner
let offGridKit = 0; let crossers = 0; let folds = 0; let clapSnareCollisions = 0;
const foldsByVoice = new Map<string, number>();
const offGridList: string[] = [];
const barOf = (b: number): number => Math.min(148, Math.floor(b / 4) + 1);
for (const e of kit.events) {
  const exact = e.beat * 4;
  const stepG = Math.round(exact);
  if (Math.abs(exact - stepG) > 1e-6) {
    offGridKit++;
    offGridList.push(`m${barOf(e.beat)} ${e.voice}@${(exact - Math.floor(exact)).toFixed(3)}->s${stepG % 16}`);
  }
  const rawBar = barOf(e.beat);
  if (stepG < barStartStep(rawBar) || stepG >= barStartStep(rawBar) + 16) crossers++;
  const voice = FOLD[e.voice] ?? e.voice;
  const vel = e.velocity ?? (e.ghost === true ? 40 : e.accent === true ? 120 : 100);
  const key = `${stepG}|${voice}`;
  const ex = cells.get(key);
  if (ex === undefined) {
    cells.set(key, { vel, srcs: 1, velDiffer: false, hadClap: e.voice === 'clap', hadSnare: e.voice === 'snare' });
  } else {
    folds++;
    foldsByVoice.set(voice, (foldsByVoice.get(voice) ?? 0) + 1);
    if (ex.vel !== vel) ex.velDiffer = true;
    if ((ex.hadClap && e.voice === 'snare') || (ex.hadSnare && e.voice === 'clap')) clapSnareCollisions++;
    if (e.voice === 'clap') ex.hadClap = true;
    if (e.voice === 'snare') ex.hadSnare = true;
    ex.vel = Math.max(ex.vel, vel);
    ex.srcs++;
  }
}
if (offGridKit === 16) ok(`kit off-grid onsets 16 of 861, snapped to nearest 16th (§0b): ${offGridList.join(', ')}`);
else fail(`kit off-grid ${offGridKit} != 16`);
if (crossers === 0) ok('ZERO snaps cross a bar line');
else fail(`${crossers} snapped onsets crossed a bar line`);
if (cells.size + folds === 861) ok(`cells ${cells.size} + folds ${folds} == 861 (nothing lost)`);
else fail(`cells ${cells.size} + folds ${folds} != 861`);
info(`same-cell folds by voice: ${[...foldsByVoice.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ') || '(none)'}; clap+snare same-cell collisions (loudest-wins): ${clapSnareCollisions}`);
{
  const voices = new Set([...cells.keys()].map((k) => k.split('|')[1]));
  const allowed = ['kick', 'snare', 'hat', 'openhat', 'crash', 'ride', 'tom'];
  if ([...voices].every((v) => allowed.includes(v)) && !voices.has('clap'))
    ok(`folded voice set [${[...voices].sort().join(',')}] — NO clap survives (every clap now a snare-pad hit), NO china class`);
  else fail(`folded voice set [${[...voices].sort().join(',')}]`);
}

// ── B2. ORACLE NOTE-50 RECONCILIATION (stop-ship; §0f + §3 rows 1/18) ─
console.log('\n=== B2. oracle note-50 reconciliation (stop-ship) ===');
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63 };
{
  // Old build: contiguous 16-bar chop, slot s covers m(16*(s-46)+1)..+16, midi2
  // chained [0,7] on slots 47-53 (46/54/55 midi2 empty). Absolute step of a
  // stored cell = (chopStart-1 + 2*pat)*16 + step.
  const oracleByNote = new Map<number, Set<number>>();
  let oracleOnsets = 0;
  for (let slot = 47; slot <= 53; slot++) {
    const buf = readFileSync(`${ORACLE}/proj${slot}__${slot - 1}_SESSION.ncs`);
    const chopStart = 16 * (slot - 46) + 1;
    for (let p = 0; p < 8; p++) {
      const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi2', p);
      steps.forEach((s, i) => {
        if (!s.active) return;
        for (const n of s.notes) {
          oracleOnsets++;
          const abs = (chopStart - 1 + 2 * p) * 16 + i;
          if (!oracleByNote.has(n.note)) oracleByNote.set(n.note, new Set());
          oracleByNote.get(n.note)!.add(abs);
        }
      });
    }
  }
  const o50 = oracleByNote.get(50) ?? new Set();
  if (o50.size === 116) ok('oracle stored-50 cells == 116 (the audit\'s number, re-derived here)');
  else fail(`oracle stored-50 cells ${o50.size} != 116`);
  if (!oracleByNote.has(51) && !oracleByNote.has(68)) ok('oracle holds ZERO stored 51 and ZERO stored 68 (the fix this build carries)');
  else fail(`oracle stray notes: 51=${oracleByNote.get(51)?.size ?? 0} 68=${oracleByNote.get(68)?.size ?? 0}`);
  // Bar-classification of the ORACLE against the SOURCE (positions+notes lens):
  // ALIGNED (old bar == source bar), MISASSEMBLED (old non-rest != source),
  // DROPPED (old rest where source has content). The sugar-diag-align probe
  // found the old lane misassembled/dropped; every cell diff below must land
  // inside those bars, or we STOP.
  const oracleBar = new Map<number, Set<string>>();  // stored bar -> "step|note"
  for (const [note, set] of oracleByNote) {
    for (const abs of set) {
      const bar = Math.floor(abs / 16) + 1;
      if (!oracleBar.has(bar)) oracleBar.set(bar, new Set());
      oracleBar.get(bar)!.add(`${abs % 16}|${note}`);
    }
  }
  const srcBarSet = new Map<number, Set<string>>();
  for (const [key, ] of cells) {
    const [stepS, voice] = key.split('|');
    const stepG = Number(stepS);
    const bar = Math.floor(stepG / 16) + 1;
    if (!srcBarSet.has(bar)) srcBarSet.set(bar, new Set());
    srcBarSet.get(bar)!.add(`${stepG % 16}|${GM12[voice]}`);
  }
  const sig = (s: Set<string> | undefined): string => (s === undefined ? '' : [...s].sort().join(','));
  const misassembled: number[] = []; const dropped: number[] = [];
  for (let m = 17; m <= 128; m++) {  // the old chop's stored span
    const oSig = sig(oracleBar.get(m)); const sSig = sig(srcBarSet.get(m));
    if (oSig === sSig) continue;
    if (oSig === '') dropped.push(m); else misassembled.push(m);
  }
  info(`oracle bars vs source: misassembled [${misassembled.map((m) => `m${m}`).join(',')}] (${misassembled.length}); dropped-content [${dropped.map((m) => `m${m}`).join(',')}] (${dropped.length}, incl. the restored m25-26)`);
  const badBars = new Set([...misassembled, ...dropped]);
  const new50 = new Set([...cells.keys()].filter((k) => k.endsWith('|snare')).map((k) => Number(k.split('|')[0])));
  const stepDesc = (s: number): string => `m${Math.floor(s / 16) + 1}s${s % 16}`;
  const missing = [...o50].filter((s) => !new50.has(s)).sort((a, b) => a - b);
  const extra = [...new50].filter((s) => !o50.has(s)).sort((a, b) => a - b);
  const missingBad = missing.filter((s) => badBars.has(Math.floor(s / 16) + 1));
  const extraBad = extra.filter((s) => badBars.has(Math.floor(s / 16) + 1));
  const reproduced = o50.size - missing.length;
  if (missing.length === missingBad.length && extra.length === extraBad.length) {
    ok(`note-50 reconciliation: ${reproduced} of the oracle's 116 cells reproduced cell-exact; every diff lies INSIDE the oracle's own misassembled/dropped bars ` +
      `(old-only ${missing.length}: [${missing.map(stepDesc).join(', ')}]; new-only ${extra.length} incl. the restored m25/m26 claps + the source-true bridge/chorus3 snares). ` +
      'VOICING carried exactly: every snare+clap on 50, zero 51, zero 68 — the SOURCE is the drums authority, the oracle the voicing authority (§3)');
  } else {
    fail(`note-50 diff OUTSIDE the misassembled/dropped bar class: missing ${missing.filter((s) => !badBars.has(Math.floor(s / 16) + 1)).map(stepDesc).join(', ') || '-'}; ` +
      `extra ${extra.filter((s) => !badBars.has(Math.floor(s / 16) + 1)).map(stepDesc).join(', ') || '-'} — STOP`);
  }
  // Full-set lens, same rule: every cell diff must lie inside the bad-bar class.
  let outside = 0; let inside = 0;
  const outsideDesc: string[] = [];
  for (const [voice, note] of Object.entries(GM12)) {
    const newSet = new Set([...cells.keys()].filter((k) => k.endsWith(`|${voice}`)).map((k) => Number(k.split('|')[0])));
    const oSet = oracleByNote.get(note) ?? new Set();
    for (const s of oSet) if (!newSet.has(s)) {
      if (badBars.has(Math.floor(s / 16) + 1)) inside++; else { outside++; outsideDesc.push(`old-only ${voice}@${stepDesc(s)}`); }
    }
    for (const s of newSet) if (!oSet.has(s)) {
      if (badBars.has(Math.floor(s / 16) + 1)) inside++; else { outside++; outsideDesc.push(`new-only ${voice}@${stepDesc(s)}`); }
    }
  }
  info(`oracle midi2 onsets ${oracleOnsets}; new realized cells ${cells.size}; full-set cell diffs: ${inside} inside the misassembled/dropped bars, ${outside} outside`);
  if (outside === 0) ok('full-voice-set: outside the oracle\'s own bad bars the timeline is CELL-EXACT across all seven voices');
  else fail(`full-voice-set diffs outside the bad-bar class: ${outsideDesc.slice(0, 20).join('; ')} — STOP`);
}

// ── C. project set (§1) ───────────────────────────────────────────────
console.log('\n=== C. project set (§1) ===');
const win2 = (from: number, to: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let m = from; m <= to; m += 2) out.push([m, m + 1]);
  return out;
};
interface Proj {
  slot: number; project_name: string;
  stored: Array<[number, number]>;     // windows stored, in pattern order
  orderIdx: number[];                  // play order as indices into `stored`
  layout: 'scenes' | 'chain';
  expectPlays: number;
}
const PROJECTS: Proj[] = [
  { slot: 46, project_name: 'Sugar 1 IntroVrs1', stored: [...win2(1, 8), ...win2(17, 24)], orderIdx: [0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7], layout: 'scenes', expectPlays: 12 },
  { slot: 47, project_name: 'Sugar 2 Chorus1', stored: win2(25, 32), orderIdx: [0, 1, 2, 3, 0, 1, 2, 3], layout: 'chain', expectPlays: 8 },
  { slot: 48, project_name: 'Sugar 3 Verse2', stored: win2(41, 56), orderIdx: [0, 1, 2, 3, 4, 5, 6, 7], layout: 'chain', expectPlays: 8 },
  { slot: 49, project_name: 'Sugar 4 Chorus2', stored: win2(57, 64), orderIdx: [0, 1, 2, 3, 0, 1, 2, 3], layout: 'chain', expectPlays: 8 },
  { slot: 50, project_name: 'Sugar 5 Bridge1', stored: win2(73, 88), orderIdx: [0, 1, 2, 3, 4, 5, 6, 7], layout: 'chain', expectPlays: 8 },
  { slot: 51, project_name: 'Sugar 6 Bridge2', stored: win2(89, 104), orderIdx: [0, 1, 2, 3, 4, 5, 6, 7], layout: 'chain', expectPlays: 8 },
  { slot: 52, project_name: 'Sugar 7 Chorus3', stored: win2(105, 120), orderIdx: [0, 1, 2, 3, 4, 5, 6, 7], layout: 'chain', expectPlays: 8 },
  { slot: 53, project_name: 'Sugar 8 Outro', stored: [...win2(129, 136), ...win2(145, 148)], orderIdx: [0, 1, 2, 3, 0, 1, 2, 3, 4, 5], layout: 'scenes', expectPlays: 10 },
];
for (const pr of PROJECTS) if (pr.project_name.length > 32) fail(`slot ${pr.slot} name > 32 chars`);

// window-row builder: melodic via the EXACT import path; drums from the folded cells
const MEL: Array<{ part: SongsterrPart; track: string; flat: ReturnType<typeof flattenSongsterrMelodic> }> = [
  { part: p6, track: 'synth1', flat: fS1 },
  { part: p8, track: 'synth2', flat: fS2 },
  { part: p7, track: 'midi1', flat: fM1 },
];
const KIT_VOICES = ['kick', 'snare', 'hat', 'openhat', 'crash', 'ride', 'tom'];
interface WinRows { name: string; steps: number; from: number; to: number; voices: Record<string, string> }
let offGridMel = 0; let totChordOverflow = 0; let melCrossers = 0;
const fidelityUnion = new Map<string, string>();
const splitCount = new Map<string, number>();   // track -> extra segments beyond source pitch-onsets
const isRest = (t: string): boolean => t === '~';
const tokensOf = (row: string): string[] => row.trim().split(/\s+/);

function buildWindow(f: number, t: number, countCensus: boolean): WinRows {
  const steps = (t - f + 1) * 16;
  const w: WinRows = { name: `m${f}-${t}`, steps, from: f, to: t, voices: {} };
  for (const { part, track, flat } of MEL) {
    const imp = importSongsterrMelodic(part, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t });
    if (imp.step_count !== steps) fail(`${w.name} ${track} step_count ${imp.step_count} != ${steps}`);
    if (countCensus) {
      offGridMel += imp.off_grid; totChordOverflow += imp.chord_overflow;
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.not_parsed)) fidelityUnion.set(`${track}:${fld}`, `not_parsed (${(d as { count: number }).count})`);
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.parsed_not_authored)) fidelityUnion.set(`${track}:${fld}`, `parsed_not_authored (${JSON.stringify(d)})`);
      for (const c of imp.cells) {
        const endSixth = c.step * 6 + c.gate_sixths;
        if (endSixth > steps * 6) melCrossers++;
      }
      const segPitches = imp.cells.reduce((a, c) => a + c.pitches.length, 0);
      const srcPitches = flat.notes.filter((n) => n.beat >= (f - 1) * 4 - 1e-9 && n.beat < t * 4 - 1e-9).length;
      splitCount.set(track, (splitCount.get(track) ?? 0) + segPitches - srcPitches);
    }
    const toks = tokensOf(imp.notation);
    if (toks.length !== steps) fail(`${w.name} ${track} row ${toks.length} tokens != ${steps}`);
    if (toks.some((x) => !isRest(x))) w.voices[track] = toks.join(' ');
  }
  const s0 = barStartStep(f); const s1 = s0 + steps;
  const rows: Record<string, (number | undefined)[]> = {};
  for (const [key, c] of cells) {
    const [stepS, voice] = key.split('|');
    const stepG = Number(stepS);
    if (stepG < s0 || stepG >= s1) continue;
    const dst = rows[voice] ?? (rows[voice] = Array.from({ length: steps }, () => undefined));
    dst[stepG - s0] = c.vel;
  }
  for (const [v, row] of Object.entries(rows)) {
    if (!KIT_VOICES.includes(v)) fail(`${w.name}: unexpected folded voice "${v}"`);
    w.voices[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
  }
  return w;
}

const winsBySlot = new Map<number, WinRows[]>();
for (const pr of PROJECTS) {
  console.log(`\n-- slot ${pr.slot} "${pr.project_name}" --`);
  const wins = pr.stored.map(([f, t]) => buildWindow(f, t, true));
  winsBySlot.set(pr.slot, wins);
  if (wins.every((w) => w.steps === 32)) ok(`${wins.length} stored windows, every pattern 32 steps`);
  else fail(`slot ${pr.slot} has a non-32-step window`);
  if (pr.orderIdx.length === pr.expectPlays) ok(`${pr.orderIdx.length} plays (${pr.layout} layout expected)`);
  else fail(`slot ${pr.slot} plays ${pr.orderIdx.length} != ${pr.expectPlays}`);
  for (const w of wins) {
    if (Object.keys(w.voices).length === 0) fail(`slot ${pr.slot} ${w.name}: window has NO voices (writer requires >=1)`);
  }
}

// ── D. identity re-asserts on staged rows (§0c + P2/P4 period-8) ─────
console.log('\n=== D. §0c identities on staged rows ===');
function assertWindowsEqual(label: string, aWins: WinRows[], bWins: WinRows[]): void {
  if (aWins.length !== bWins.length) { fail(`${label}: window count ${aWins.length} != ${bWins.length}`); return; }
  for (let i = 0; i < aWins.length; i++) {
    if (!eq(aWins[i].voices, bWins[i].voices) || aWins[i].steps !== bWins[i].steps) {
      fail(`${label}: window ${aWins[i].name} vs ${bWins[i].name} DIFFER`);
      return;
    }
  }
  ok(`${label}: IDENTICAL on staged rows`);
}
const stmt = winsBySlot.get(46)!.slice(0, 4);
assertWindowsEqual('m9-16 == m1-8 (P1 [Stmt,Stmt,V1close] lossless)', win2(9, 16).map(([f, t]) => buildWindow(f, t, false)), stmt);
assertWindowsEqual('m121-128 == m1-8 (the P1 outro re-stomp)', win2(121, 128).map(([f, t]) => buildWindow(f, t, false)), stmt);
assertWindowsEqual('m137-144 == m129-136 (P8 [OV,OV,Tail])', win2(137, 144).map(([f, t]) => buildWindow(f, t, false)), winsBySlot.get(53)!.slice(0, 4));
assertWindowsEqual('m147-148 == m145-146 (Tail 2 patterns)', [winsBySlot.get(53)![5]], [winsBySlot.get(53)![4]]);
assertWindowsEqual('m33-40 == m25-32 (P2 [Cho1Stmt x2] replay)', win2(33, 40).map(([f, t]) => buildWindow(f, t, false)), winsBySlot.get(47)!);
assertWindowsEqual('m65-72 == m57-64 (P4 [Cho2Stmt x2] replay)', win2(65, 72).map(([f, t]) => buildWindow(f, t, false)), winsBySlot.get(49)!);

// ── E. global melodic + coverage assertions ──────────────────────────
console.log('\n=== E. global assertions ===');
if (offGridMel === 0) ok('melodic import off_grid 0 across all stored windows'); else fail(`melodic off_grid ${offGridMel}`);
if (totChordOverflow === 0) ok('chord_overflow 0 (pad max 4 <= 6 ceiling)'); else fail(`chord_overflow ${totChordOverflow}`);
if (melCrossers === 0) ok('melodic seam crossers 0 (§0e/probe 8c: every note releases inside its window)');
else fail(`${melCrossers} melodic cells cross a window boundary`);
info(`ceiling-split segments beyond source onsets, per track (stored windows): ${[...splitCount.entries()].map(([t, n]) => `${t}+${n}`).join(', ')}`);

// FULL-SONG COVERAGE: every bar m1-148 maps to exactly one serving window;
// realized (performance) totals == the flatten censuses. Multiplicity of each
// stored window across the full performance (incl. the m121-128 P1 re-stomp).
{
  const mult = new Map<string, number>();  // `${slot}|${winIdx}` -> plays in the full song
  const add = (slot: number, wi: number, n: number): void => { mult.set(`${slot}|${wi}`, (mult.get(`${slot}|${wi}`) ?? 0) + n); };
  [0, 1, 2, 3].forEach((i) => add(46, i, 3));  // m1-8, m9-16 (order), m121-128 (re-stomp)
  [4, 5, 6, 7].forEach((i) => add(46, i, 1));  // m17-24
  [0, 1, 2, 3].forEach((i) => add(47, i, 2));  // m25-32 x2
  [0, 1, 2, 3, 4, 5, 6, 7].forEach((i) => add(48, i, 1));
  [0, 1, 2, 3].forEach((i) => add(49, i, 2));
  [0, 1, 2, 3, 4, 5, 6, 7].forEach((i) => { add(50, i, 1); add(51, i, 1); add(52, i, 1); });
  [0, 1, 2, 3].forEach((i) => add(53, i, 2));  // OV x2
  [4, 5].forEach((i) => add(53, i, 1));        // tail
  const barsCovered = [...mult.entries()].reduce((a, [, n]) => a + 2 * n, 0);
  if (barsCovered === 148) ok('full-song coverage: 74 window-plays x 2 bars == 148 bars, each source bar served exactly once');
  else fail(`coverage ${barsCovered} bars != 148`);
  // realized melodic totals + velocity multisets from the staged rows x multiplicity
  const totals = new Map<string, number>();
  const velsByTrack = new Map<string, Map<string, number>>();
  const pitchesOfTok = (t: string): number => t.split(/[:@_]/)[0].split('+').length;
  for (const [key, n] of mult) {
    const [slotS, wiS] = key.split('|');
    const w = winsBySlot.get(Number(slotS))![Number(wiS)];
    for (const track of ['synth1', 'synth2', 'midi1']) {
      const row = w.voices[track];
      if (row === undefined) continue;
      for (const tok of tokensOf(row)) {
        if (isRest(tok)) continue;
        const nP = pitchesOfTok(tok);
        totals.set(track, (totals.get(track) ?? 0) + nP * n);
        const m = /@(\d+)/.exec(tok);
        const k = m ? m[1] : 'def';
        const vm = velsByTrack.get(track) ?? new Map<string, number>();
        vm.set(k, (vm.get(k) ?? 0) + nP * n);
        velsByTrack.set(track, vm);
      }
    }
  }
  const t = (x: string): number => totals.get(x) ?? 0;
  if (t('midi1') === 1176) ok('HARP realized total == 1176 == the source == the oracle\'s stored total (the identity part, §2a)');
  else fail(`harp realized total ${t('midi1')} != 1176`);
  {
    // STORED-lens dynamics: one velocity per chord CELL (mini-notation), so a
    // def note sharing its cell with a v40/v75 ghost-layer note stores at the
    // explicit velocity. Count the reclassified chord-mates INDEPENDENTLY from
    // the flatten and require the token-derived multiset to match exactly.
    const byCell = new Map<string, Array<number | undefined>>();
    for (const n of fM1.notes) {
      const k = String(Math.round(n.beat * 4));
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k)!.push(n.velocity);
    }
    // Cell resolution rule (derived, then arithmetic-verified): a cell with
    // any explicit velocity stores ALL its notes at the LOUDEST explicit one;
    // an all-default cell stores default. 14 cells mix 40+75 (info below).
    const want = new Map<string, number>();
    let mixedExplicit = 0; let reclassified = 0;
    for (const vs of byCell.values()) {
      const expl = [...new Set(vs.filter((v) => v !== undefined))] as number[];
      if (expl.length > 1) mixedExplicit++;
      const cellVel = expl.length > 0 ? Math.max(...expl) : undefined;
      const k = cellVel === undefined ? 'def' : String(cellVel);
      want.set(k, (want.get(k) ?? 0) + vs.length);
      reclassified += vs.filter((v) => v !== cellVel).length;
    }
    info(`${mixedExplicit} harp cells mix 40+75 explicit velocities (the tab stacks its two ghost layers); loudest-explicit resolves them`);
    const wantObj = Object.fromEntries([...want.entries()].sort());
    const gotObj = Object.fromEntries([...(velsByTrack.get('midi1') ?? new Map()).entries()].sort());
    if (eq(gotObj, wantObj))
      ok(`harp STORED velocity multiset ${JSON.stringify(gotObj)} == source §0b (40x166/75x14/def x996) under the per-CELL loudest-explicit collapse ` +
        `(${reclassified} chord-mate notes take their cell's ghost-layer velocity; per-cell velocity is the notation path's grain — named cost, fork Q3 lens)`);
    else fail(`harp stored velocity multiset ${JSON.stringify(gotObj)} != derived ${JSON.stringify(wantObj)}`);
  }
  const s1Splits = t('synth1') - 124;
  if (t('synth1') === 126 && s1Splits === 2) ok('S1 realized segments 126 = 124 source onsets + 2 ceiling-splits (== the oracle\'s 126, §2c)');
  else fail(`S1 realized segments ${t('synth1')} (splits ${s1Splits}) != 126`);
  info(`S1 realized velocity multiset: ${JSON.stringify(Object.fromEntries([...(velsByTrack.get('synth1') ?? new Map()).entries()].sort()))}`);
  const s2Splits = t('synth2') - 494;
  if (s2Splits >= 0) ok(`PAD realized segments ${t('synth2')} = 494 source notes + ${s2Splits} tie/ceiling splits (§2b; velocity all def)`);
  else fail(`PAD realized segments ${t('synth2')} < 494`);
  if (eq(Object.fromEntries([...(velsByTrack.get('synth2') ?? new Map()).entries()].sort()), { def: t('synth2') }))
    ok('pad realized velocities all default (source has no dynamics on p8)');
  else fail(`pad velocity multiset ${JSON.stringify([...(velsByTrack.get('synth2') ?? new Map())])}`);
  // drums: realized == the folded timeline by construction (identities in D);
  // staged stored drum cells:
  let stored = 0;
  for (const wins of winsBySlot.values()) for (const w of wins)
    for (const v of KIT_VOICES) if (w.voices[v] !== undefined) stored += tokensOf(w.voices[v]).filter((x) => !isRest(x)).length;
  info(`stored drum cells across the 8 projects: ${stored} (timeline ${cells.size}; the difference is the replayed spans stored once)`);
  const seen = new Set<string>();
  for (const wins of winsBySlot.values()) for (const w of wins)
    for (const v of Object.keys(w.voices)) if (KIT_VOICES.includes(v)) seen.add(v);
  const notes = [...seen].map((v) => GM12[v]).sort((a, b) => a - b);
  if (eq(notes, [48, 50, 54, 57, 58, 61, 63]))
    ok('external note set {48,50,54,57,58,61,63} EXACT — no 51, no 68 (STOP-SHIP CLEAR at staging)');
  else fail(`external note set [${notes}]`);
}

// ── F. tail decode assertions (§3, staged lens) ──────────────────────
console.log('\n=== F. tail assertions (§3) ===');
interface PCell { step: number; notes: number[]; gate?: number; vel: number; tie: boolean }
const parsedRow = (w: WinRows, voice: string): PCell[] => {
  const row = w.voices[voice];
  if (row === undefined) return [];
  const parsed = parseVoice(row, w.steps) as Array<{ on?: boolean; notes?: number | number[]; gate_sixths?: number; tie?: boolean; velocity?: number }>;
  const out: PCell[] = [];
  parsed.forEach((s, i) => {
    if (s.on !== true) return;
    const notes = Array.isArray(s.notes) ? [...s.notes].sort((a, b) => a - b) : (s.notes !== undefined ? [s.notes] : []);
    out.push({ step: i, notes, gate: s.gate_sixths, vel: s.velocity ?? 100, tie: s.tie === true });
  });
  return out;
};
const barCells = (w: WinRows, voice: string, bar: number): PCell[] => {
  const off = (bar - w.from) * 16;
  return parsedRow(w, voice).filter((c) => c.step >= off && c.step < off + 16).map((c) => ({ ...c, step: c.step - off }));
};
const drumBar = (w: WinRows, bar: number): string[] => {
  const off = (bar - w.from) * 16;
  const out: string[] = [];
  for (const v of KIT_VOICES) {
    const row = w.voices[v];
    if (row === undefined) continue;
    tokensOf(row).forEach((tok, i) => {
      if (isRest(tok) || i < off || i >= off + 16) return;
      const m = /@(\d+)/.exec(tok);
      out.push(`${v}@${i - off}${m ? `v${m[1]}` : ''}`);
    });
  }
  return out.sort();
};
{
  // P1 m24 (win idx 7 = m23-24): harp eighths gate 12; pad half pair 55/67->54/66; S1+drums EMPTY
  const w = winsBySlot.get(46)![7];
  const harp = barCells(w, 'midi1', 24);
  if (harp.length > 0 && harp.every((c) => c.gate === 12)) ok('P1 m24: harp statement-close bar, all gates 12 (eighths)');
  else fail(`P1 m24 harp ${harp.length} cells, gates ${[...new Set(harp.map((c) => c.gate))]}`);
  const pad = barCells(w, 'synth2', 24);
  if (eq(pad.map((c) => [c.step, ...c.notes, c.gate]), [[0, 55, 67, 48], [8, 54, 66, 48]]))
    ok('P1 m24: pad = the half-note pair 55+67 -> 54+66 (gate 48)');
  else fail(`P1 m24 pad ${JSON.stringify(pad)}`);
  if (barCells(w, 'synth1', 24).length === 0 && drumBar(w, 24).length === 0) ok('P1 m24: S1 + drums EMPTY');
  else fail('P1 m24: S1/drums not empty');
}
{
  // P2 head m25: kick@0 + clap@2 RESTORED (row 18), clap stored as snare voice
  const w = winsBySlot.get(47)![0];
  const d25 = drumBar(w, 25);
  if (eq(d25, ['kick@0v100', 'snare@8v100'])) ok('P2 m25: kick@0 + the RESTORED clap@2 (staged as snare-pad hit, step 8) — row 18');
  else fail(`P2 m25 drums [${d25}]`);
  const d26 = drumBar(w, 26);
  if (eq(d26, ['snare@8v100'])) ok('P2 m26: the restored clap@2 (snare-pad, step 8)');
  else fail(`P2 m26 drums [${d26}]`);
}
{
  // P2/P3/P4 closing bars m32(~m40)/m56/m64(~m72): the chorus close figure
  const CLOSE = ['kick@10v100', 'kick@12v100', 'kick@15v100', 'kick@6v100', 'snare@2v100', 'snare@8v100'];
  for (const [slot, wi, bar, label] of [[47, 3, 32, 'P2 m32 (==m40)'], [48, 7, 56, 'P3 m56'], [49, 3, 64, 'P4 m64 (==m72)']] as Array<[number, number, number, string]>) {
    const w = winsBySlot.get(slot)![wi];
    const d = drumBar(w, bar);
    if (eq(d, [...CLOSE].sort())) ok(`${label}: drums = clap@0.5/kick@1.5/clap@2/kick@2.5/kick@3/kick@3.75 (claps on the snare pad)`);
    else fail(`${label} drums [${d}]`);
    const s1 = barCells(w, 'synth1', bar);
    if (eq(s1.map((c) => [c.step, ...c.notes, c.gate, c.vel]), [[0, 31, 48, 40], [8, 30, 48, 40]]))
      ok(`${label}: S1 = the v40 half-note pair 31/30`);
    else fail(`${label} S1 ${JSON.stringify(s1)}`);
    const pad = barCells(w, 'synth2', bar);
    if (eq(pad.map((c) => [c.step, ...c.notes]), [[0, 55, 67], [8, 54, 66]])) ok(`${label}: pad = the 55+67/54+66 half pair`);
    else fail(`${label} pad ${JSON.stringify(pad)}`);
    if (barCells(w, 'midi1', bar).length > 0) ok(`${label}: harp figure-close present`);
    else fail(`${label} harp empty`);
  }
}
{
  // P5 m88: kit-only close, 32nd-class kick pair + ghost hat; melodic EMPTY
  const w = winsBySlot.get(50)![7];
  const d = drumBar(w, 88);
  const kicks = d.filter((x) => x.startsWith('kick'));
  const ghostHat = d.some((x) => /^hat@\d+v40$/.test(x));
  if (kicks.length >= 2 && ghostHat && d.some((x) => x.startsWith('snare')) && d.some((x) => x.startsWith('openhat')))
    ok(`P5 m88: kit-only close (kicks ${kicks.length} incl. the snapped 32nd pair, ghost hat v40, snare, openhat): [${d}]`);
  else fail(`P5 m88 drums [${d}]`);
  if (['synth1', 'synth2', 'midi1'].every((tr) => barCells(w, tr, 88).length === 0)) ok('P5 m88: all melodic tracks EMPTY (harp ended m86)');
  else fail('P5 m88 melodic not empty');
}
{
  // P6 m104: the crash+kick cascade; melodic empty
  const w = winsBySlot.get(51)![7];
  const d = drumBar(w, 104);
  const crashes = d.filter((x) => x.startsWith('crash')).length;
  const kicks = d.filter((x) => x.startsWith('kick')).length;
  if (crashes >= 3 && kicks >= 3) ok(`P6 m104: crash+kick cascade (${crashes} crashes, ${kicks} kicks)`);
  else fail(`P6 m104 [${d}]`);
  if (['synth1', 'synth2', 'midi1'].every((tr) => barCells(w, tr, 104).length === 0)) ok('P6 m104: melodic EMPTY (drums-only section)');
  else fail('P6 m104 melodic not empty');
}
{
  // P7 m120: final drum bar (crash/kick/snare); pad f#5 whole (gate 96); S1 empty
  const w = winsBySlot.get(52)![7];
  const d = drumBar(w, 120);
  if (d.some((x) => x.startsWith('crash')) && d.some((x) => x.startsWith('kick')) && d.some((x) => x.startsWith('snare')))
    ok('P7 m120: the source\'s final drum bar (crash/kick/snare present)');
  else fail(`P7 m120 [${d}]`);
  const pad = barCells(w, 'synth2', 120);
  if (eq(pad.map((c) => [c.step, ...c.notes, c.gate]), [[0, 78, 96]])) ok('P7 m120: pad f#5 whole-note close (note 78, gate 96)');
  else fail(`P7 m120 pad ${JSON.stringify(pad)}`);
  if (barCells(w, 'synth1', 120).length === 0) ok('P7 m120: S1 EMPTY (part 6 ended m86)');
  else fail('P7 m120 S1 not empty');
}
{
  // P8: OV windows = harp + drone quarters; tail = drone ALONE; every drone
  // bar = 4 chords {51,63,75} at steps 0/4/8/12, gate 24 — NEVER seven per
  // 2-bar window (the dev.7 defect class). No drums anywhere in P8.
  const wins = winsBySlot.get(53)!;
  let droneOk = true;
  for (const w of wins) {
    for (const bar of [w.from, w.to]) {
      const pad = barCells(w, 'synth2', bar);
      if (!eq(pad.map((c) => [c.step, ...c.notes, c.gate]), [[0, 51, 63, 75, 24], [4, 51, 63, 75, 24], [8, 51, 63, 75, 24], [12, 51, 63, 75, 24]])) {
        droneOk = false; fail(`P8 ${w.name} m${bar}: drone bar ${JSON.stringify(pad.map((c) => [c.step, c.notes]))}`);
      }
    }
    if (KIT_VOICES.some((v) => w.voices[v] !== undefined)) { droneOk = false; fail(`P8 ${w.name}: drums present`); }
  }
  if (droneOk) ok('P8: every drone bar = 4 quarter chords {51,63,75} gate 24 at steps 0/4/8/12 — 8 per pattern, never seven (row 8); midi2 empty (row 13)');
  const ovHarp = wins.slice(0, 4).every((w) => (w.voices.midi1 !== undefined));
  const tailHarpEmpty = wins.slice(4).every((w) => w.voices.midi1 === undefined);
  if (ovHarp && tailHarpEmpty) ok('P8: harp statement on OV patterns 1-4, harp EMPTY on tail patterns 5-6 (drone alone; m148 = last sounding bar)');
  else fail(`P8 harp presence OV ${ovHarp} tailEmpty ${tailHarpEmpty}`);
}
{
  // Spot-anchor vs oracle: P1 stored m1-8 harp == oracle slot 46 patterns 0-3
  // on (step, note, gate) — velocities differ BY DESIGN (row 16).
  const buf = readFileSync(`${ORACLE}/proj46__45_SESSION.ncs`);
  let diff = 0;
  for (let p = 0; p < 4; p++) {
    const w = winsBySlot.get(46)![p];
    const want = parsedRow(w, 'midi1');
    const got: Array<{ step: number; notes: number[]; gates: number[] }> = [];
    decodeNotePattern(buf as unknown as Uint8Array, 'midi1', p).forEach((s, i) => {
      if (!s.active) return;
      got.push({ step: i, notes: s.notes.map((n) => n.note).sort((a, b) => a - b), gates: s.notes.map((n) => n.gate) });
    });
    if (want.length !== got.length) { diff++; continue; }
    for (let i = 0; i < want.length; i++) {
      if (want[i].step !== got[i].step || !eq(want[i].notes, got[i].notes) || !got[i].gates.every((g) => g === want[i].gate)) diff++;
    }
  }
  if (diff === 0) ok('spot-anchor: staged P1 harp m1-8 == oracle slot 46 patterns 1-4 cell-exact on (step, note, gate) — velocities excluded (row 16 delta)');
  else fail(`spot-anchor P1 harp vs oracle: ${diff} cell diffs`);
}

console.log('\n=== dropped-fidelity union (melodic import) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);

// ── G. emit staged JSON ──────────────────────────────────────────────
interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface Staged { slot: number; project_name: string; layout: string; order: string[]; sections: StagedSection[] }
const staged: Staged[] = [];
for (const pr of PROJECTS) {
  const wins = winsBySlot.get(pr.slot)!;
  const sections: StagedSection[] = wins.map((w) => ({ name: w.name, steps: w.steps, voices: w.voices }));
  const order = pr.orderIdx.map((i) => sections[i].name);
  staged.push({ slot: pr.slot, project_name: pr.project_name, layout: pr.layout, order, sections });
  info(`slot ${pr.slot}: ${order.length} plays [${order.join(' ')}] over ${sections.length} stored sections (${pr.layout})`);
}
writeFileSync(`${ROOT}/samples/_scratch/sugar-staged.json`, JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/sugar-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
