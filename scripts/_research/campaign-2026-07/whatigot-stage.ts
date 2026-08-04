/**
 * What I Got Phase-0 staging (mirror of brainstew-stage.ts + the p14+p15 UNION
 * merge). READ-ONLY: no device, no network. Run:
 *   npx tsx samples/_scratch/whatigot-stage.ts
 *
 * Builds the NINE per-project `arrangement` payloads (Pack 2 slots 41-49) from
 * the PINNED cache (samples/songsterr-cache/s211, rev 6610547) via the EXACT
 * import path (importSongsterrMelodic / importSongsterrDrums), plus:
 *   - the DRUM UNION: p15 (drum_map {27:'kick', 28:'snare'}) + p14, per-part
 *     intra-fold by the quantizer, cross-part merge with LOUDEST-WINS on
 *     same-voice-same-step; emitted as one set of mini-notation rows @vel
 *   - p5 Synth Bass -> synth1 (no transpose; Hydra is the voice, stored 0)
 *   - p6 Whistling -> midi1 TRANSPOSE +12 (the +12 store convention,
 *     DECISIONS.md 2026-07-28: the Circuit transmits 12 below stored)
 *   - p13 Shanai stabs -> synth2 (internal voice, stored 100)
 * Asserts: plan §4 Phase 0 step 2 list (packing, unmapped==0, union census,
 * velocity multisets, occupancy, V1/Solo identity, off_grid == 61/0/4,
 * chord_overflow==0, edge-crossers==0, whistle register, closing-bar tails).
 * Emits samples/_scratch/whatigot-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrDrums,
  type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s211';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const p5 = load(5);   // Synth Bass -> synth1 (Hydrasynth ch1, stored 0)
const p6 = load(6);   // Whistling  -> midi1 (MicroFreak ch3), transpose +12
const p13 = load(13); // Shanai DJ stab -> synth2 (internal, stored 100)
const p14 = load(14); // Bud Gaugh kit   -> union
const p15 = load(15); // Drum Programming -> union, drum_map below
const DRUM_MAP = { 27: 'kick', 28: 'snare' } as const;

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── A. probe-parity census (flatten + round-snap + ghost-masked vel) ──
// Reproduces whatigot-union-probe.ts EXACTLY so plan §0a/§0e numbers gate
// source drift. (Import-truth follows in B; base steps agree: every off-grid
// onset in both parts sits at x.333, floor == round.)
console.log('=== A. probe-parity census (plan §0a/§0e gates) ===');
const t15 = flattenSongsterrDrums(p15, { drumMap: DRUM_MAP });
const t14 = flattenSongsterrDrums(p14);
if (t15.unmapped === 0) ok('p15 unmapped == 0 (drum_map applied)'); else fail(`p15 unmapped ${t15.unmapped}`);
if (t14.unmapped === 0) ok('p14 unmapped == 0'); else fail(`p14 unmapped ${t14.unmapped}`);
const measures = t15.measures;
interface PCell { mi: number; step: number; voice: string; vel: number }
const effVel = (e: { ghost?: boolean; velocity?: number }): number => (e.ghost === true ? 40 : (e.velocity ?? 100));
function probeCells(evs: typeof t15.events): Map<string, PCell> {
  const m = new Map<string, PCell>();
  for (const e of evs) {
    const mi = measures.findIndex((mm, i) => e.beat >= mm.startBeat - 1e-9
      && (i + 1 >= measures.length || e.beat < measures[i + 1].startBeat - 1e-9));
    const step = Math.round((e.beat - measures[mi].startBeat) * 4);
    const k = `${mi}|${step}|${e.voice}`;
    const vel = effVel(e);
    const prev = m.get(k);
    if (!prev) m.set(k, { mi, step, voice: e.voice, vel });
    else prev.vel = Math.max(prev.vel, vel);
  }
  return m;
}
const c15 = probeCells(t15.events);
const c14 = probeCells(t14.events);
{
  const velCen = (evs: typeof t15.events): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const e of evs) { const v = String(effVel(e)); m[v] = (m[v] ?? 0) + 1; }
    return m;
  };
  const v15 = velCen(t15.events); const v14 = velCen(t14.events);
  if (eq(v15, { 90: 871, 40: 233, 60: 15 }) || eq(v15, { 40: 233, 60: 15, 90: 871 }))
    ok('p15 effective velocity census 90x871 / 60x15 / 40x233 (§0e)');
  else fail(`p15 velocity census ${JSON.stringify(v15)} != §0e`);
  if (v14['124'] === 85 && v14['110'] === 101 && v14['90'] === 436 && v14['40'] === 81 && Object.keys(v14).length === 4)
    ok('p14 effective velocity census 124x85 / 110x101 / 90x436 / 40x81 (§0e)');
  else fail(`p14 velocity census ${JSON.stringify(v14)} != §0e`);
}
const pUnion = new Map<string, PCell>();
let pColl = 0; const pByVoice = new Map<string, number>(); let pDiffVel = 0;
for (const [k, c] of c15) pUnion.set(k, { ...c });
for (const [k, c] of c14) {
  const prev = pUnion.get(k);
  if (!prev) { pUnion.set(k, { ...c }); continue; }
  pColl++;
  pByVoice.set(c.voice, (pByVoice.get(c.voice) ?? 0) + 1);
  if (prev.vel !== c.vel) pDiffVel++;
  prev.vel = Math.max(prev.vel, c.vel);
}
if (pUnion.size === 1262) ok('union cells 1262 (§0a)'); else fail(`union cells ${pUnion.size} != 1262`);
if (pColl === 555) ok('cross-part collisions 555 (§0a)'); else fail(`collisions ${pColl} != 555`);
if (pByVoice.get('hat') === 295 && pByVoice.get('kick') === 184 && pByVoice.get('snare') === 76 && pByVoice.size === 3)
  ok('collision split hat 295 / kick 184 / snare 76 (§0a)');
else fail(`collision split ${JSON.stringify([...pByVoice])} != hat295/kick184/snare76`);
if (pDiffVel === 243) ok('velocity-differing folds 243 (§0a, ghost-masked lens)'); else fail(`velocity folds ${pDiffVel} != 243`);
{
  const uv = new Map<string, number>();
  for (const c of pUnion.values()) uv.set(c.voice, (uv.get(c.voice) ?? 0) + 1);
  const want: Record<string, number> = { hat: 501, kick: 427, snare: 202, perc: 117, openhat: 12, tom: 3 };
  const got = Object.fromEntries([...uv.entries()]);
  if (eq(Object.fromEntries(Object.entries(got).sort()), Object.fromEntries(Object.entries(want).sort())))
    ok('union voice census hat501/kick427/snare202/perc117/openhat12/tom3 (§0a)');
  else fail(`union voice census ${JSON.stringify(got)} != §0a`);
}
// occupancy (claim 1)
{
  const has = (cells: Map<string, PCell>, mi: number): boolean => [...cells.values()].some((c) => c.mi === mi);
  let s15only = 0; let s14only = 0; let both = 0;
  const p15onlyBars: number[] = []; const p14onlyBars: number[] = [];
  for (let mi = 0; mi < 71; mi++) {
    const a = has(c15, mi); const b = has(c14, mi);
    if (a && b) both++;
    else if (a) { s15only++; p15onlyBars.push(mi + 1); }
    else if (b) { s14only++; p14onlyBars.push(mi + 1); }
  }
  if (s15only === 23 && s14only === 4 && both === 38) ok('occupancy counts p15-only 23 / p14-only 4 / both 38 (§0a claim 1)');
  else fail(`occupancy ${s15only}/${s14only}/${both} != 23/4/38`);
  if (eq(p14onlyBars, [54, 55, 66, 67])) ok('p14-only bars m54-55 + m66-67');
  else fail(`p14-only bars [${p14onlyBars}] != [54,55,66,67]`);
  const allowed = new Set([...Array.from({ length: 20 }, (_, i) => i + 2), 42, 43, 48, 65]);
  const stray = p15onlyBars.filter((b) => !allowed.has(b));
  if (stray.length === 0) ok(`p15-only bars within m2-21/m42-43/m48/m65 (actual: ${p15onlyBars.join(',')})`);
  else fail(`p15-only stray bars [${stray}]`);
  // coverage m2-67 with the single m49 gap; m1 + m68-71 empty
  const gaps: number[] = [];
  for (let mi = 1; mi < 67; mi++) if (!has(c15, mi) && !has(c14, mi)) gaps.push(mi + 1);
  if (eq(gaps, [49])) ok('union coverage m2-67, single gap m49 (the tab\'s own drum rest)');
  else fail(`coverage gaps [${gaps}] != [49]`);
  const tail = [0, 67, 68, 69, 70].filter((mi) => has(c15, mi) || has(c14, mi));
  if (tail.length === 0) ok('m1 and m68-71 carry no union drums'); else fail(`unexpected drum bars at mi [${tail}]`);
}

// ── B. import-truth union (the exact authored path) ──────────────────
console.log('\n=== B. import-truth union (importSongsterrDrums merge) ===');
interface UnionWin {
  steps: number;
  rows: Record<string, (number | undefined)[]>;
  cells: number; collisions: number; byVoice: Map<string, number>; diffVel: number;
  microCells: number;
  aOnBars: Set<number>; bOnBars: Set<number>; // 0-based bar-in-window occupancy per part
}
const velOfStep = (s: { velocity?: number; accent?: boolean }): number => s.velocity ?? (s.accent === true ? 120 : 100);
function importUnionWindow(from: number, to: number): UnionWin {
  const a = importSongsterrDrums(p15, { stepsPerBeat: 4, fromMeasure: from, toMeasure: to, drumMap: DRUM_MAP });
  const b = importSongsterrDrums(p14, { stepsPerBeat: 4, fromMeasure: from, toMeasure: to });
  if (a.steps !== b.steps) fail(`union window m${from}-${to}: p15 ${a.steps} steps != p14 ${b.steps}`);
  const steps = a.steps;
  // bar boundaries inside the window (m1 is 2/4 = 8 steps)
  const barStartSteps: number[] = [];
  {
    let acc = 0;
    for (let m = from; m <= to; m++) {
      barStartSteps.push(acc);
      const sig = measures[m - 1].signature;
      acc += Math.round(((sig[0] * 4) / sig[1]) * 4);
    }
  }
  const barOf = (st: number): number => {
    for (let i = barStartSteps.length - 1; i >= 0; i--) if (st >= barStartSteps[i]) return i;
    return 0;
  };
  const rows: Record<string, (number | undefined)[]> = {};
  let cells = 0; let collisions = 0; const byVoice = new Map<string, number>(); let diffVel = 0; let microCells = 0;
  const aOnBars = new Set<number>(); const bOnBars = new Set<number>();
  const voices = new Set([...Object.keys(a.voices), ...Object.keys(b.voices)]);
  for (const v of voices) {
    const row: (number | undefined)[] = Array.from({ length: steps }, () => undefined);
    for (let i = 0; i < steps; i++) {
      const sa = a.voices[v]?.[i]; const sb = b.voices[v]?.[i];
      const aOn = sa?.on === true; const bOn = sb?.on === true;
      if (!aOn && !bOn) continue;
      cells++;
      if (aOn) aOnBars.add(barOf(i));
      if (bOn) bOnBars.add(barOf(i));
      if (aOn && sa?.roll !== undefined) fail(`m${from}-${to} ${v}@${i}: unexpected roll (p15)`);
      if (bOn && sb?.roll !== undefined) fail(`m${from}-${to} ${v}@${i}: unexpected roll (p14)`);
      if ((aOn && sa?.micro !== undefined && !eq(sa.micro, [0])) || (bOn && sb?.micro !== undefined && !eq(sb.micro, [0]))) microCells++;
      if (aOn && bOn) {
        collisions++;
        byVoice.set(v, (byVoice.get(v) ?? 0) + 1);
        const va = velOfStep(sa!); const vb = velOfStep(sb!);
        if (va !== vb) diffVel++;
        row[i] = Math.max(va, vb);
      } else row[i] = velOfStep(aOn ? sa! : sb!);
    }
    if (row.some((x) => x !== undefined)) rows[v] = row;
  }
  return { steps, rows, cells, collisions, byVoice, diffVel, microCells, aOnBars, bOnBars };
}
// track-wide (m1-71) import-truth vs probe-parity
{
  const u = importUnionWindow(1, 71);
  if (u.cells === 1262) ok('import-truth union cells 1262 == probe'); else fail(`import-truth cells ${u.cells} != 1262`);
  if (u.collisions === 555) ok('import-truth collisions 555 == probe'); else fail(`import-truth collisions ${u.collisions} != 555`);
  if (u.byVoice.get('hat') === 295 && u.byVoice.get('kick') === 184 && u.byVoice.get('snare') === 76)
    ok('import-truth collision split == probe');
  else fail(`import-truth split ${JSON.stringify([...u.byVoice])}`);
  info(`import-truth velocity-differing folds: ${u.diffVel} (probe-parity lens said 243; any surplus = the vel-28 ghosts unmasked)`);
  const multiset = new Map<number, number>();
  for (const row of Object.values(u.rows)) for (const x of row) if (x !== undefined) multiset.set(x, (multiset.get(x) ?? 0) + 1);
  const levels = [...multiset.keys()].sort((a, b) => b - a);
  info(`import-truth union velocity multiset: ${levels.map((l) => `${l} x${multiset.get(l)}`).join(', ')}`);
  const allowedLv = new Set([124, 110, 90, 60, 40, 28]);
  const strayLv = levels.filter((l) => !allowedLv.has(l));
  if (strayLv.length === 0) ok('all union velocities in {124,110,90,60,40,28} (§0e five levels + the 4 explicit-28 p15 ghosts, NAMED DEVIATION)');
  else fail(`unexpected velocity level(s) [${strayLv}]`);
  const n28 = multiset.get(28) ?? 0;
  if (n28 <= 4) ok(`velocity-28 cells: ${n28} (<= 4, the p15 soft-dynamic ghosts the probe lens masked to 40)`);
  else fail(`velocity-28 cells ${n28} > 4`);
  info(`import-truth micro-bearing cells (off-grid x.333, snapped to base step, micro DROPPED in mini-notation): ${u.microCells}`);
}

// ── C. project set (plan §1) ─────────────────────────────────────────
interface Proj {
  slot: number; project_name: string;
  windows: Array<[number, number]>;
  expectSteps: number[]; expectPlays: number;
}
const PROJECTS: Proj[] = [
  { slot: 41, project_name: 'WhatIGot 1 Intro',   windows: [[1, 2], [3, 4], [5, 5]], expectSteps: [24, 32, 16], expectPlays: 3 },
  { slot: 42, project_name: 'WhatIGot 2 Verse1',  windows: [[6, 7]], expectSteps: [32], expectPlays: 1 },
  { slot: 43, project_name: 'WhatIGot 3 Solo',    windows: [[18, 19], [20, 21]], expectSteps: [32, 32], expectPlays: 2 },
  { slot: 44, project_name: 'WhatIGot 4 Verse2',  windows: [[22, 23], [24, 25], [26, 27], [28, 29], [30, 31], [32, 33]], expectSteps: [32, 32, 32, 32, 32, 32], expectPlays: 6 },
  { slot: 45, project_name: 'WhatIGot 5 Chorus',  windows: [[34, 35], [36, 37], [38, 39], [40, 41]], expectSteps: [32, 32, 32, 32], expectPlays: 4 },
  { slot: 46, project_name: 'WhatIGot 6 Verse3',  windows: [[42, 43], [44, 45], [46, 47], [48, 49]], expectSteps: [32, 32, 32, 32], expectPlays: 4 },
  { slot: 47, project_name: 'WhatIGot 7 Interl',  windows: [[50, 51], [52, 53], [54, 55]], expectSteps: [32, 32, 32], expectPlays: 3 },
  { slot: 48, project_name: 'WhatIGot 8 Chorus2', windows: [[56, 57], [58, 59], [60, 61], [62, 63]], expectSteps: [32, 32, 32, 32], expectPlays: 4 },
  { slot: 49, project_name: 'WhatIGot 9 Outro',   windows: [[64, 65], [66, 67]], expectSteps: [32, 32], expectPlays: 2 },
];
const MEL: Array<{ part: SongsterrPart; voice: 'synth1' | 'synth2' | 'midi1'; id: number; transpose?: number }> = [
  { part: p5, voice: 'synth1', id: 5 },
  { part: p6, voice: 'midi1', id: 6, transpose: 12 },
  { part: p13, voice: 'synth2', id: 13 },
];
const SIX = 6;
const tokensOf = (row: string): string[] => row.trim().split(/\s+/);
const isRest = (t: string): boolean => t === '~';

const fidelityUnion = new Map<string, string>();
const offGrid: Record<number, number> = { 5: 0, 6: 0, 13: 0 };
let totChordOverflow = 0; let totTies = 0; let totGateSplits = 0; let totGateClamps = 0;
let storedCells = 0; let storedCollisions = 0; let storedDiffVel = 0; let storedMicro = 0;
const storedMultiset = new Map<number, number>();

interface WinVoices { name: string; steps: number; from: number; to: number; voices: Record<string, string>; u: UnionWin }
const winsBySlot = new Map<number, WinVoices[]>();

for (const pr of PROJECTS) {
  console.log(`\n=== slot ${pr.slot} "${pr.project_name}" ===`);
  const wins: WinVoices[] = pr.windows.map(([f, t]) => {
    const u = importUnionWindow(f, t);
    const w: WinVoices = { name: `m${f}${t !== f ? '-' + t : ''}`, steps: u.steps, from: f, to: t, voices: {}, u };
    for (const [v, row] of Object.entries(u.rows)) {
      w.voices[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
    }
    storedCells += u.cells; storedCollisions += u.collisions; storedDiffVel += u.diffVel; storedMicro += u.microCells;
    for (const row of Object.values(u.rows)) for (const x of row) if (x !== undefined) storedMultiset.set(x, (storedMultiset.get(x) ?? 0) + 1);
    for (const { part, voice, id, transpose } of MEL) {
      const imp = importSongsterrMelodic(part, {
        stepsPerBeat: 4, fromMeasure: f, toMeasure: t, ...(transpose !== undefined ? { transpose } : {}),
      });
      if (imp.step_count !== u.steps) fail(`slot ${pr.slot} p${id} ${w.name} step_count ${imp.step_count} != ${u.steps}`);
      offGrid[id] += imp.off_grid; totChordOverflow += imp.chord_overflow;
      totTies += imp.ties_emitted; totGateSplits += imp.gate_splits; totGateClamps += imp.gate_clamps;
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.not_parsed)) fidelityUnion.set(`p${id}:${fld}`, `not_parsed (${(d as { count: number }).count})`);
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.parsed_not_authored)) fidelityUnion.set(`p${id}:${fld}`, `parsed_not_authored (${JSON.stringify(d)})`);
      for (const c of imp.cells) {
        const gs = (c as { gate_sixths?: number }).gate_sixths ?? (c as { duration_steps: number }).duration_steps * SIX;
        if ((c as { step: number }).step * SIX + gs > u.steps * SIX) {
          fail(`slot ${pr.slot} p${id} ${w.name}: EDGE-CROSSER at step ${(c as { step: number }).step} (gate ${gs} sixths) - plan said zero`);
        }
      }
      const toks = tokensOf(imp.notation);
      if (toks.length !== u.steps) fail(`slot ${pr.slot} p${id} ${w.name} row ${toks.length} tokens != ${u.steps}`);
      if (toks.some((t2) => !isRest(t2))) w.voices[voice] = imp.notation;
    }
    return w;
  });
  winsBySlot.set(pr.slot, wins);
  const steps = wins.map((w) => w.steps);
  if (eq(steps, pr.expectSteps)) ok(`packing [${steps}]`); else fail(`packing [${steps}] != [${pr.expectSteps}]`);
  // kick presence in every drum-bearing window
  for (const w of wins) {
    const drumVoices = Object.keys(w.voices).filter((v) => !['synth1', 'synth2', 'midi1'].includes(v));
    if (drumVoices.length === 0) continue;
    const kickRow = w.voices.kick;
    if (kickRow !== undefined && tokensOf(kickRow).some((t2) => !isRest(t2))) ok(`${w.name}: kick lane present`);
    else fail(`${w.name}: drum-bearing window has NO kick cell`);
  }
}

// ── D. melodic totals + whistle register ─────────────────────────────
console.log('\n=== D. melodic totals ===');
// track-wide off_grid gate (plan: 61/0/4, measured track-wide by the probes)
{
  const tw5 = importSongsterrMelodic(p5, { stepsPerBeat: 4, fromMeasure: 1, toMeasure: 71 });
  const tw6 = importSongsterrMelodic(p6, { stepsPerBeat: 4, fromMeasure: 1, toMeasure: 71, transpose: 12 });
  const tw13 = importSongsterrMelodic(p13, { stepsPerBeat: 4, fromMeasure: 1, toMeasure: 71 });
  if (tw5.off_grid === 61 && tw6.off_grid === 0 && tw13.off_grid === 4)
    ok('track-wide melodic off_grid == 61/0/4 (p5/p6/p13, plan gate)');
  else fail(`track-wide off_grid ${tw5.off_grid}/${tw6.off_grid}/${tw13.off_grid} != 61/0/4`);
}
info(`authored-window off_grid: p5 ${offGrid[5]}, p6 ${offGrid[6]}, p13 ${offGrid[13]} (loop-served bars carry the rest)`);
if (totChordOverflow === 0) ok('chord_overflow == 0'); else fail(`chord_overflow ${totChordOverflow}`);
if (totTies === 0 && totGateSplits === 0) ok('zero tied chains (ties_emitted 0, gate_splits 0)');
else fail(`ties_emitted ${totTies}, gate_splits ${totGateSplits} != 0`);
if (totGateClamps === 0) ok('gate_clamps == 0'); else fail(`gate_clamps ${totGateClamps}`);
// whistle register (stored +12): expect 11 notes d7..c8 (98..108), only in slot 43 win 1
{
  const NAMES: Record<string, number> = { c: 0, 'c#': 1, d: 2, 'd#': 3, e: 4, f: 5, 'f#': 6, g: 7, 'g#': 8, a: 9, 'a#': 10, b: 11 };
  const midiOf = (tok: string): number => {
    const m = /^([a-g]#?)(-?\d+)$/.exec(tok.split(/[:@_]/)[0]);
    if (!m) { fail(`whistle token "${tok}" unparsable`); return -1; }
    return NAMES[m[1]] + (Number(m[2]) + 1) * 12;
  };
  const w43 = winsBySlot.get(43)!;
  const row = w43[0].voices.midi1;
  if (row === undefined) fail('slot 43 win m18-19: whistle row MISSING');
  else {
    const notes = tokensOf(row).filter((t2) => !isRest(t2)).map(midiOf);
    const lo = Math.min(...notes); const hi = Math.max(...notes);
    info(`whistle stored: ${notes.length} notes, MIDI ${lo}..${hi} (written d6-c7 + 12)`);
    if (notes.length === 11) ok('whistle note count 11'); else fail(`whistle notes ${notes.length} != 11`);
    if (lo === 98 && hi === 108) ok('whistle stored register d7..c8 (98..108), within MIDI range - no fallback needed');
    else fail(`whistle register ${lo}..${hi} != 98..108`);
  }
  if (w43[1].voices.midi1 === undefined) ok('slot 43 win m20-21: whistle silent'); else fail('slot 43 win m20-21 has whistle content');
  for (const pr of PROJECTS) {
    if (pr.slot === 43) continue;
    for (const w of winsBySlot.get(pr.slot)!) if (w.voices.midi1 !== undefined) fail(`p6 content leaked into slot ${pr.slot} ${w.name}`);
  }
  ok('whistle content confined to slot 43 pattern 1');
}
// stabs: only slot 47 wins 1-2 (m51, m53)
{
  for (const pr of PROJECTS) {
    for (const w of winsBySlot.get(pr.slot)!) {
      const has = w.voices.synth2 !== undefined;
      const want = pr.slot === 47 && (w.name === 'm50-51' || w.name === 'm52-53');
      if (has !== want) fail(`synth2 (stab) content ${has ? 'unexpected' : 'MISSING'} at slot ${pr.slot} ${w.name}`);
    }
  }
  const w47 = winsBySlot.get(47)!;
  if (w47[0].voices.synth2 !== undefined && w47[0].voices.synth2 === w47[1].voices.synth2)
    ok('shanai stabs present m51 + m53, the two windows identical rows (identical 3-note figures)');
  else info('shanai stab rows differ between windows m50-51 and m52-53 (compare receipts)');
}
// bass present in every project
for (const pr of PROJECTS) {
  const anyBass = winsBySlot.get(pr.slot)!.some((w) => w.voices.synth1 !== undefined);
  if (!anyBass) fail(`slot ${pr.slot}: no synth1 (bass) content in any window`);
}
ok('synth1 (bass) present in every project');

// ── E. V1 cell identity + Solo prefix identity (per part) ────────────
console.log('\n=== E. served-window identity ===');
{
  const refD15 = JSON.stringify(importSongsterrDrums(p15, { stepsPerBeat: 4, fromMeasure: 6, toMeasure: 7, drumMap: DRUM_MAP }).voices);
  const refD14 = JSON.stringify(importSongsterrDrums(p14, { stepsPerBeat: 4, fromMeasure: 6, toMeasure: 7 }).voices);
  const refP5 = importSongsterrMelodic(p5, { stepsPerBeat: 4, fromMeasure: 6, toMeasure: 7 }).notation;
  const served: Array<[number, number]> = [[8, 9], [10, 11], [12, 13], [14, 15], [16, 17]];
  let all = true;
  for (const [f, t] of served) {
    const d15w = JSON.stringify(importSongsterrDrums(p15, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t, drumMap: DRUM_MAP }).voices);
    const d14w = JSON.stringify(importSongsterrDrums(p14, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t }).voices);
    const p5w = importSongsterrMelodic(p5, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t }).notation;
    if (d15w !== refD15) { all = false; fail(`m${f}-${t} p15 != cell m6-7`); }
    if (d14w !== refD14) { all = false; fail(`m${f}-${t} p14 != cell m6-7 (should both be silent)`); }
    if (p5w !== refP5) { all = false; fail(`m${f}-${t} bass != cell m6-7`); }
  }
  if (all) ok('slot 42: all 5 served windows (m8-17) import-identical to the authored cell m6-7, per part');
  // Solo prefix
  let solo = true;
  for (const [f, t] of [[18, 19], [20, 21]] as Array<[number, number]>) {
    const d15w = JSON.stringify(importSongsterrDrums(p15, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t, drumMap: DRUM_MAP }).voices);
    const d14w = JSON.stringify(importSongsterrDrums(p14, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t }).voices);
    const p5w = importSongsterrMelodic(p5, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t }).notation;
    if (d15w !== refD15) { solo = false; fail(`Solo m${f}-${t} p15 != cell`); }
    if (d14w !== refD14) { solo = false; fail(`Solo m${f}-${t} p14 != cell`); }
    if (p5w !== refP5) { solo = false; fail(`Solo m${f}-${t} bass != cell`); }
  }
  if (solo) ok('slot 43: Solo prefix (m18-21) == the V1 cell on p15/p14/bass (whistle rides on top)');
}

// ── F. closing-bar (tail) assertions (plan §4 step 2 list) ───────────
console.log('\n=== F. closing-bar assertions ===');
type Slice = Record<string, string>;
function barSlice(w: WinVoices, bar: number): Slice {
  // bar boundaries: m1 is 8 steps, all others 16
  const starts: number[] = [];
  let acc = 0;
  for (let m = w.from; m <= w.to; m++) {
    starts.push(acc);
    const sig = measures[m - 1].signature;
    acc += Math.round(((sig[0] * 4) / sig[1]) * 4);
  }
  const s0 = starts[bar]; const s1 = bar + 1 < starts.length ? starts[bar + 1] : w.steps;
  const out: Slice = {};
  for (const [v, row] of Object.entries(w.voices)) {
    const sl = tokensOf(row).slice(s0, s1);
    if (sl.some((t2) => !isRest(t2))) out[v] = sl.join(' ');
  }
  return out;
}
const sliceEq = (a: Slice, b: Slice): boolean => eq(Object.entries(a).sort(), Object.entries(b).sort());
const sliceEmpty = (s: Slice, only?: (v: string) => boolean): boolean =>
  Object.keys(s).filter((v) => (only ? only(v) : true)).length === 0;
const isDrumVoice = (v: string): boolean => !['synth1', 'synth2', 'midi1'].includes(v);
const w41 = winsBySlot.get(41)!; const w42 = winsBySlot.get(42)!; const w44 = winsBySlot.get(44)!;
const w45 = winsBySlot.get(45)!; const w46 = winsBySlot.get(46)!; const w47b = winsBySlot.get(47)!;
const w48 = winsBySlot.get(48)!; const w49 = winsBySlot.get(49)!;
const CREF = barSlice(w44[0], 0);  // bar m22 = union letter C
const DREF = barSlice(w44[1], 1);  // bar m25 = union letter D
// P1: m1 (the 2/4 half bar) silent on every selected part; pat3 = m5 @16 steps
{
  const m1 = barSlice(w41[0], 0);
  if (sliceEmpty(m1)) ok('P1 m1 (2/4 half bar) silent on all selected parts (press = bar 1)');
  else fail(`P1 m1 has content: ${Object.keys(m1)}`);
  if (w41[2].name === 'm5' && w41[2].steps === 16) ok('P1 pat3 = m5 @ 16 steps'); else fail(`P1 pat3 ${w41[2].name}@${w41[2].steps}`);
  const drumsIn2 = Object.keys(barSlice(w41[0], 1)).filter(isDrumVoice);
  if (drumsIn2.length > 0) ok(`P1 m2 drums enter (${drumsIn2.sort().join(',')})`); else fail('P1 m2 has no drums');
}
// P2: the two cell bars identical (one looping pattern serves m6-17)
{
  if (sliceEq(barSlice(w42[0], 0), barSlice(w42[0], 1))) ok('P2 cell = one bar x2 (m6 == m7)');
  else fail('P2 m6 != m7 (expected the 1-bar cell twice)');
}
// P4 pat6 = m32-33 = C D
{
  const t = w44[5];
  if (sliceEq(barSlice(t, 0), CREF)) ok('P4 pat6 bar1 (m32) == C'); else fail('P4 pat6 bar1 != C-ref');
  if (sliceEq(barSlice(t, 1), DREF)) ok('P4 pat6 bar2 (m33) == D'); else fail('P4 pat6 bar2 != D-ref');
}
// P5 pat4 = m40-41 = C H
{
  const t = w45[3];
  if (sliceEq(barSlice(t, 0), CREF)) ok('P5 pat4 bar1 (m40) == C'); else fail('P5 pat4 bar1 != C-ref');
  const h = barSlice(t, 1);
  if (!sliceEmpty(h, isDrumVoice) && !sliceEq(h, CREF)) ok('P5 pat4 bar2 (m41) = H, the fill into V3 (nonempty, != C)');
  else fail('P5 pat4 bar2 not a distinct fill bar');
}
// P6 pat4 = m48-49: drums L then rest; bass sounds through m49 (the pickup)
{
  const t = w46[3];
  if (!sliceEmpty(barSlice(t, 0), isDrumVoice)) ok('P6 pat4 bar1 (m48, L) has drums'); else fail('P6 pat4 bar1 drums missing');
  if (sliceEmpty(barSlice(t, 1), isDrumVoice)) ok('P6 pat4 bar2 (m49) drum rest (the tab\'s own)'); else fail('P6 pat4 bar2 has drums');
  if (barSlice(t, 1).synth1 !== undefined) ok('P6 pat4 bar2 bass pickup lands in-window'); else fail('P6 pat4 bar2 bass missing');
}
// P7 pat3 = m54-55: p14-only kit fills (p15 rests)
{
  const t = w47b[2];
  if (t.u.aOnBars.size === 0) ok('P7 pat3 (m54-55): p15 silent'); else fail(`P7 pat3 p15 sounds in bars ${[...t.u.aOnBars]}`);
  if (t.u.bOnBars.has(0) && t.u.bOnBars.has(1)) ok('P7 pat3: p14 kit fills BOTH bars (M/N - the reversed dropout)');
  else fail(`P7 pat3 p14 bars ${[...t.u.bOnBars]} != both`);
}
// P8: 4 distinct windows (through-composed last chorus)
{
  const keys = w48.map((w) => JSON.stringify({ steps: w.steps, voices: w.voices }));
  if (new Set(keys).size === 4) ok('P8: all 4 windows distinct (through-composed)'); else fail('P8 windows collapse');
}
// P9 pat2 = m66-67: p14-only close; m67 kick flourish 0/2/3 + openhat; bass ends m66
{
  const t = w49[1];
  if (t.u.aOnBars.size === 0) ok('P9 pat2 (m66-67): p15 silent (p14-only close)'); else fail(`P9 pat2 p15 sounds`);
  const m67 = barSlice(t, 1);
  const kickSteps = m67.kick !== undefined ? tokensOf(m67.kick).flatMap((tk, i) => (isRest(tk) ? [] : [i])) : [];
  if (eq(kickSteps, [0, 2, 3])) ok('P9 m67 kick flourish at steps 0/2/3'); else fail(`P9 m67 kick steps [${kickSteps}] != [0,2,3]`);
  if (m67.openhat !== undefined) ok('P9 m67 openhat ring present'); else fail('P9 m67 openhat missing');
  if (m67.synth1 === undefined) ok('P9 bass ends m66 (silent in m67)'); else fail('P9 bass sounds in m67');
}

// ── G. dedupe into sections/order + stored census ────────────────────
console.log('\n=== G. staged sections/order ===');
interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface Staged { slot: number; project_name: string; order: string[]; sections: StagedSection[] }
const staged: Staged[] = [];
for (const pr of PROJECTS) {
  const wins = winsBySlot.get(pr.slot)!;
  const sections: StagedSection[] = [];
  const secName = new Map<string, string>();
  const order: string[] = [];
  for (const w of wins) {
    const key = JSON.stringify({ steps: w.steps, voices: w.voices });
    if (!secName.has(key)) {
      secName.set(key, w.name);
      sections.push({ name: w.name, steps: w.steps, voices: w.voices });
    }
    order.push(secName.get(key)!);
  }
  if (order.length === pr.expectPlays) ok(`slot ${pr.slot}: ${order.length} plays [${order.join(' ')}], ${sections.length} stored section(s)`);
  else fail(`slot ${pr.slot}: ${order.length} plays != ${pr.expectPlays}`);
  staged.push({ slot: pr.slot, project_name: pr.project_name, order, sections });
}
console.log('\n=== stored (authored-window) census ===');
info(`stored union cells ${storedCells}, collisions ${storedCollisions} (velocity-differing ${storedDiffVel}), micro-dropped cells ${storedMicro}`);
info(`stored velocity multiset: ${[...storedMultiset.entries()].sort((a, b) => b[0] - a[0]).map(([l, n]) => `${l} x${n}`).join(', ')}`);
info('(track-wide minus stored = bars served by the slot-42 loop, identity-proven above)');

console.log('\n=== dropped-fidelity union (melodic imports) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);

writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/whatigot-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/whatigot-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
