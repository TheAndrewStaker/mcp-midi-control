/**
 * Smooth + Havana Phase-0 staging (mirror of billiejean-stage.ts machinery +
 * the FOUR-part drum union with the SPD-SX 9-role FOLD applied AT STAGING +
 * the hand-authored §H Havana section compiled inline). READ-ONLY: no device,
 * no network. Run: npx tsx samples/_scratch/smooth-stage.ts
 *
 * Builds the THIRTEEN per-project `arrangement` payloads (Pack 4 slots 9-21)
 * from the PINNED cache (samples/songsterr-cache/s17608, rev 7965244) via the
 * EXACT import path (importSongsterrMelodic / importSongsterrDrums):
 *   - p6 Horn Section -> synth1 (Hydrasynth ch1, stored 0)
 *   - p5 El. Grand piano -> synth2 (internal; STORED 0, the 2026-07-30
 *     universal stored-silent directive - supersedes the plan's synth2=100)
 *   - p4 Hammond organ -> midi1 TRANSPOSE +12 (the store convention)
 *   - p10 kit + p7 guiro + p8 timbales + p9 congas -> UNION rows, FOLDED at
 *     staging into the SPD-SX 9-role voice space (timbale/bongo/conga -> tom,
 *     guiro -> perc) with LOUDEST-WINS per cell. Fold-at-staging is deliberate:
 *     the writer's midi2 same-(note,tick) dedup is first-wins, so emitting
 *     source voices would make 185 velocity-differing collisions
 *     order-dependent instead of loudest-wins. Named deviation from plan §4
 *     step 4's "fold report names timbale->tom" wording; the fold census is
 *     asserted here instead (§0d exactly).
 *   - slot 18 = the §H Havana rows VERBATIM (the campaign's first fully
 *     hand-authored source of record).
 * Asserts (plan §4 Phase 0 step 2): source census (§0a/§0d); the post-fold
 * collision census at the fold-probe lens EXACTLY (673 folds / 185
 * velocity-differing / tom 498 / perc 166); packing per §1; melodic off_grid
 * {organ 0, piano 0, horns 22} + chord_overflow 0; the 10 horn tied chains
 * (P4 x7, P5 x3 notes) + the 11 project-end truncations (P1 3 / P5 2 / P9 4 /
 * P11 2); §0g elision (source lens); external note set {48,50,54,57,58,61,63,
 * 68}; §H rows token-exact incl. f#3@step30; closing-bar assertions per
 * fold-probe §3. Emits samples/_scratch/smooth-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrDrums, flattenSongsterrMelodic,
  pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s17608';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const p4 = load(4);   // Hammond B3 organ -> midi1 (+12 store convention)
const p5 = load(5);   // El. Grand piano  -> synth2
const p6 = load(6);   // Horn Section     -> synth1
const p7 = load(7);   // guiro            -> union (folds to perc)
const p8 = load(8);   // timbales         -> union (folds to tom)
const p9 = load(9);   // congas (bongo)   -> union (folds to tom)
const p10 = load(10); // kit              -> union

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── A. source census gates (plan §0a/§0d - source drift detection) ────
console.log('=== A. source census gates ===');
const fKit = flattenSongsterrDrums(p10);
const fGuiro = flattenSongsterrDrums(p7);
const fTimb = flattenSongsterrDrums(p8);
const fCongas = flattenSongsterrDrums(p9);
const fOrgan = flattenSongsterrMelodic(p4);
const fPiano = flattenSongsterrMelodic(p5);
const fHorns = flattenSongsterrMelodic(p6);
const measures = fKit.measures;
if (measures.length === 144 && measures.every((m) => m.signature[0] === 4 && m.signature[1] === 4))
  ok('144 measures, all 4/4');
else fail(`measures ${measures.length}, sig drift`);
const cen = (fl: ReturnType<typeof flattenSongsterrDrums>): number[] => [fl.events.length, fl.ghosts, fl.accents, fl.unmapped];
if (eq(cen(fKit), [2426, 55, 0, 0])) ok('kit p10: 2426 events, 55 ghosts, 0 accents, 0 unmapped');
else fail(`kit census ${cen(fKit)}`);
if (eq(cen(fGuiro), [810, 0, 0, 0])) ok('guiro p7: 810 events'); else fail(`guiro census ${cen(fGuiro)}`);
if (eq(cen(fTimb), [1441, 6, 3, 0])) ok('timbales p8: 1441 events, 6 ghosts, 3 accents');
else fail(`timbales census ${cen(fTimb)}`);
if (eq(cen(fCongas), [272, 68, 136, 0])) ok('congas p9: 272 events, 68 ghosts, 136 accents');
else fail(`congas census ${cen(fCongas)}`);
{
  const kv = new Map<string, number>();
  for (const e of fKit.events) kv.set(e.voice, (kv.get(e.voice) ?? 0) + 1);
  const want = { hat: 881, kick: 502, snare: 416, openhat: 172, ride: 171, perc: 167, crash: 63, tom: 51, conga: 3 };
  if (eq(Object.fromEntries([...kv.entries()].sort()), Object.fromEntries(Object.entries(want).sort())))
    ok('kit voices hat881/kick502/snare416/openhat172/ride171/perc167/crash63/tom51/conga3');
  else fail(`kit voice census ${JSON.stringify([...kv])}`);
  if ([...new Set(fGuiro.events.map((e) => e.voice))].join() === 'guiro'
    && [...new Set(fTimb.events.map((e) => e.voice))].join() === 'timbale'
    && [...new Set(fCongas.events.map((e) => e.voice))].join() === 'bongo')
    ok('latin voices: guiro / timbale / bongo (single-voice parts)');
  else fail('latin voice sets drifted');
}
if (fOrgan.notes.length === 29 && fPiano.notes.length === 2195 && fHorns.notes.length === 780)
  ok('melodic note counts organ 29 / piano 2195 / horns 780 (§0a)');
else fail(`melodic counts ${fOrgan.notes.length}/${fPiano.notes.length}/${fHorns.notes.length}`);

// ── B. probe-parity POST-FOLD census (fold-probe §1 verbatim; §0d gate) ─
console.log('\n=== B. post-fold union collision census (§0d) ===');
const FOLD: Readonly<Record<string, string>> = {
  timbale: 'tom', bongo: 'tom', conga: 'tom', guiro: 'perc',
  kick: 'kick', snare: 'snare', hat: 'hat', openhat: 'openhat',
  ride: 'ride', crash: 'crash', tom: 'tom', perc: 'perc', clap: 'clap',
};
{
  interface Cell { vel: number; src: string }
  const cells = new Map<string, Cell[]>();
  const parts: Array<{ label: string; fl: ReturnType<typeof flattenSongsterrDrums> }> = [
    { label: 'KIT', fl: fKit }, { label: 'GUIRO', fl: fGuiro },
    { label: 'TIMB', fl: fTimb }, { label: 'CONGAS', fl: fCongas },
  ];
  for (const { label, fl } of parts) {
    for (const e of fl.events) {
      const folded = FOLD[e.voice] ?? e.voice;
      const key = `${Math.round(e.beat * 4)}|${folded}`;
      const arr = cells.get(key) ?? [];
      arr.push({ vel: e.velocity ?? 100, src: label });
      cells.set(key, arr);
    }
  }
  let collisions = 0; let velDiff = 0;
  const byPair = new Map<string, number>(); const byFoldVoice = new Map<string, number>();
  for (const [key, arr] of cells) {
    if (arr.length < 2) continue;
    collisions += arr.length - 1;
    const voice = key.split('|')[1];
    byFoldVoice.set(voice, (byFoldVoice.get(voice) ?? 0) + arr.length - 1);
    if (new Set(arr.map((c) => c.vel)).size > 1) velDiff += arr.length - 1;
    const srcs = [...new Set(arr.map((c) => c.src))].sort().join('+');
    byPair.set(srcs, (byPair.get(srcs) ?? 0) + arr.length - 1);
  }
  const total = parts.reduce((a, p) => a + p.fl.events.length, 0);
  if (total === 4949) ok('total union events 4949'); else fail(`total events ${total} != 4949`);
  if (collisions === 673 && velDiff === 185) ok('post-fold folded-away 673, velocity-differing 185 (§0d EXACT)');
  else fail(`post-fold census ${collisions}/${velDiff} != 673/185`);
  const bfv = Object.fromEntries([...byFoldVoice.entries()].sort());
  if (eq(bfv, { crash: 3, hat: 3, perc: 166, snare: 3, tom: 498 }))
    ok('by folded voice: tom 498, perc 166, crash 3, hat 3, snare 3 (§0d EXACT)');
  else fail(`by-voice ${JSON.stringify(bfv)}`);
  const bp = Object.fromEntries([...byPair.entries()].sort());
  const wantPairs = { 'TIMB': 236, 'CONGAS+TIMB': 215, 'GUIRO+KIT': 166, 'KIT+TIMB': 42, 'KIT': 10, 'CONGAS+KIT+TIMB': 4 };
  if (eq(Object.fromEntries(Object.entries(bp).sort()), Object.fromEntries(Object.entries(wantPairs).sort())))
    ok('by source pair: TIMB 236 / CONGAS+TIMB 215 / GUIRO+KIT 166 / KIT+TIMB 42 / KIT 10 / CONGAS+KIT+TIMB 4');
  else fail(`by-pair ${JSON.stringify(bp)}`);
}

// ── C. §0g elision facts at the SOURCE lens ──────────────────────────
console.log('\n=== C. §0g elision (source lens) ===');
interface Ev { beat: number; key: string }
const barStart = (mi: number): number => measures[mi].startBeat;
const drumEvs = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] => fl.events.map((e) => ({
  beat: e.beat, key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.ghost === true ? '~' : ''}`,
}));
const melEvs = (fl: ReturnType<typeof flattenSongsterrMelodic>): Ev[] => fl.notes.map((n) => ({
  beat: n.beat, key: `${pitchToken(n.pitch)}:${n.durationBeats}${n.velocity !== undefined ? `@${n.velocity}` : ''}`,
}));
function barSig(evs: Ev[], m1based: number): string {
  const b0 = barStart(m1based - 1); const b1 = b0 + 4;
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${Math.round((e.beat - b0) * 48)}:${e.key}`).sort().join(',');
}
{
  const evG = drumEvs(fGuiro); const evC = drumEvs(fCongas); const evT = drumEvs(fTimb);
  const evPno = melEvs(fPiano);
  const gSigs = new Set<string>(); const gBars: number[] = [];
  for (let m = 1; m <= 144; m++) { const s = barSig(evG, m); if (s !== '') { gSigs.add(s); gBars.push(m); } }
  if (gSigs.size === 1) ok(`guiro: ONE signature across ${gBars.length} sounding bars (period 1 everywhere)`);
  else fail(`guiro ${gSigs.size} distinct signatures`);
  if (!gBars.includes(42) && !gBars.includes(43)) ok('guiro rests m42-43 (authored as rests inside P4)');
  else fail('guiro sounds in m42-43');
  const cSigs = new Set<string>(); const cBars: number[] = [];
  for (let m = 1; m <= 144; m++) { const s = barSig(evC, m); if (s !== '') { cSigs.add(s); cBars.push(m); } }
  if (cSigs.size === 1 && cBars[0] === 2 && cBars[cBars.length - 1] === 35)
    ok('congas: ONE signature, m2-35 only (exit authored as rests after m35)');
  else fail(`congas sigs ${cSigs.size}, bars ${cBars[0]}..${cBars[cBars.length - 1]}`);
  const tSigs = new Set<string>();
  for (let m = 11; m <= 144; m++) { if (m === 1 || m === 2 || m === 9 || m === 10) continue; const s = barSig(evT, m); if (s !== '') tSigs.add(s); }
  if (tSigs.size === 1) ok('timbales: ONE signature on all sounding bars m11+ (specials m1/m2/m9/m10 authored in stored windows)');
  else fail(`timbale steady-state signatures ${tSigs.size} != 1`);
  let v = true;
  for (const base of [10, 48]) for (let m = base; m < base + 8; m++) if (barSig(evPno, m) !== barSig(evPno, m + 8)) v = false;
  if (v) ok('piano verse cells: m10-17 == m18-25 and m48-55 == m56-63 (period 8, whole cycles in 16-bar windows)');
  else fail('piano verse 8-bar cycle broken');
  if (barSig(evPno, 44) === barSig(evPno, 46) && barSig(evPno, 45) === barSig(evPno, 47))
    ok('interlude piano period 2 (m44==m46, m45==m47)');
  else fail('interlude piano cycle broken');
  let o = true;
  for (let m = 109; m <= 138; m++) if (barSig(evPno, m) !== barSig(evPno, m + 2)) o = false;
  if (o) ok('outro piano vamp period 2 through m109-140');
  else info('outro piano vamp deviates inside m109-140 (through-composed edges; stored in full either way)');
}

// ── D. drum union per window (import-truth, FOLDED, loudest-wins) ─────
const velOfStep = (s: { velocity?: number; accent?: boolean }): number =>
  s.velocity ?? (s.accent === true ? 120 : 100);
interface UnionWin {
  steps: number;
  rows: Record<string, (number | undefined)[]>;
  cells: number; collisions: number; diffVel: number; microCells: number;
}
const DRUM_PARTS: SongsterrPart[] = [p10, p7, p8, p9];
let uCells = 0; let uColl = 0; let uDiff = 0; let uMicro = 0;
const uMultiset = new Map<number, number>();
function importUnionWindow(from: number, to: number): UnionWin {
  const imps = DRUM_PARTS.map((p) => importSongsterrDrums(p, { stepsPerBeat: 4, fromMeasure: from, toMeasure: to }));
  const steps = imps[0].steps;
  if (!imps.every((i) => i.steps === steps)) fail(`union m${from}-${to}: step-count mismatch across parts`);
  const rows: Record<string, (number | undefined)[]> = {};
  let cells = 0; let collisions = 0; let diffVel = 0; let microCells = 0;
  for (const imp of imps) {
    for (const [srcVoice, row] of Object.entries(imp.voices)) {
      const v = FOLD[srcVoice] ?? srcVoice;
      const dst = rows[v] ?? (rows[v] = Array.from({ length: steps }, () => undefined));
      for (let i = 0; i < steps; i++) {
        const s = row[i];
        if (s?.on !== true) continue;
        if ((s as { roll?: number }).roll !== undefined) fail(`m${from}-${to} ${srcVoice}@${i}: unexpected roll`);
        if ((s as { micro?: number[] }).micro !== undefined && !eq((s as { micro?: number[] }).micro, [0])) microCells++;
        const vel = velOfStep(s);
        if (dst[i] === undefined) { dst[i] = vel; cells++; }
        else { collisions++; if (dst[i] !== vel) diffVel++; dst[i] = Math.max(dst[i]!, vel); }
      }
    }
  }
  for (const v of Object.keys(rows)) if (!rows[v].some((x) => x !== undefined)) delete rows[v];
  for (const row of Object.values(rows)) for (const x of row) if (x !== undefined) uMultiset.set(x, (uMultiset.get(x) ?? 0) + 1);
  uCells += cells; uColl += collisions; uDiff += diffVel; uMicro += microCells;
  return { steps, rows, cells, collisions, diffVel, microCells };
}

// ── E. project set (plan §1: Pack 4 slots 9-21) ──────────────────────
const win2 = (from: number, to: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let m = from; m <= to; m += 2) out.push([m, m + 1]);
  return out;
};
interface Proj {
  slot: number; project_name: string;
  windows: Array<[number, number]>;
  expectSteps: number[];
}
const PROJECTS: Proj[] = [
  { slot: 9, project_name: 'Smooth 1 Intro', windows: [[1, 1], ...win2(2, 9)], expectSteps: [16, 32, 32, 32, 32] },
  { slot: 10, project_name: 'Smooth 2 Verse1', windows: win2(10, 25), expectSteps: Array(8).fill(32) },
  { slot: 11, project_name: 'Smooth 3 PreChor1', windows: win2(26, 35), expectSteps: Array(5).fill(32) },
  { slot: 12, project_name: 'Smooth 4 Cho1Intl', windows: win2(36, 47), expectSteps: Array(6).fill(32) },
  { slot: 13, project_name: 'Smooth 5 Verse2', windows: win2(48, 63), expectSteps: Array(8).fill(32) },
  { slot: 14, project_name: 'Smooth 6 PreChor2', windows: win2(64, 73), expectSteps: Array(5).fill(32) },
  { slot: 15, project_name: 'Smooth 7 Chorus2', windows: [...win2(74, 81), [82, 82]], expectSteps: [32, 32, 32, 32, 16] },
  { slot: 16, project_name: 'Smooth 8 SoloA', windows: win2(83, 98), expectSteps: Array(8).fill(32) },
  { slot: 17, project_name: 'Smooth 9 SoloCho3', windows: win2(99, 108), expectSteps: Array(5).fill(32) },
  // slot 18 = Havana, hand-authored (§H), appended after the loop
  { slot: 19, project_name: 'Smooth 11 Outro1', windows: win2(109, 120), expectSteps: Array(6).fill(32) },
  { slot: 20, project_name: 'Smooth 12 Outro2', windows: win2(121, 132), expectSteps: Array(6).fill(32) },
  { slot: 21, project_name: 'Smooth 13 Outro3', windows: win2(133, 144), expectSteps: Array(6).fill(32) },
];
for (const pr of PROJECTS) if (pr.project_name.length > 32) fail(`slot ${pr.slot} name > 32 chars`);
const MEL: Array<{ part: SongsterrPart; voice: 'synth1' | 'synth2' | 'midi1'; id: number; transpose?: number }> = [
  { part: p6, voice: 'synth1', id: 6 },
  { part: p5, voice: 'synth2', id: 5 },
  { part: p4, voice: 'midi1', id: 4, transpose: 12 },
];

// token helpers (verbatim brainstew/billiejean-stage)
const SIX = 6;
const tokensOf = (row: string): string[] => row.trim().split(/\s+/);
const isRest = (t: string): boolean => t === '~';
const pitchesOf = (t: string): string => t.split(/[:@_]/)[0];
const gateTok = (sixths: number): string => {
  if (sixths % SIX === 0) return String(sixths / SIX);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(sixths, SIX);
  return `${sixths / g}/${SIX / g}`;
};
const mkTok = (pitches: string, sixths: number, vel: number | undefined, tie: boolean): string =>
  `${pitches}:${gateTok(sixths)}${vel !== undefined ? `@${vel}` : ''}${tie ? '_' : ''}`;

interface Carry { pitches: string; sixths: number; vel?: number }
interface WinVoices { name: string; steps: number; from: number; to: number; voices: Record<string, string> }

const fidelityUnion = new Map<string, string>();
const edgeInstances: string[] = [];
const offGrid: Record<number, number> = { 4: 0, 5: 0, 6: 0 };
let totChordOverflow = 0;
const winsBySlot = new Map<number, WinVoices[]>();
// per-slot pitch counts of seam-tie clips and project-end clips
const seamTieNotes = new Map<number, number>();
const endClipNotes = new Map<number, number>();

for (const pr of PROJECTS) {
  console.log(`\n=== slot ${pr.slot} "${pr.project_name}" ===`);
  const wins: WinVoices[] = pr.windows.map(([f, t]) => ({
    name: `m${f}${t !== f ? '-' + t : ''}`, steps: (t - f + 1) * 16, from: f, to: t, voices: {},
  }));
  const steps = wins.map((w) => w.steps);
  if (eq(steps, pr.expectSteps)) ok(`packing [${steps}]`);
  else fail(`slot ${pr.slot} packing [${steps}] != [${pr.expectSteps}]`);

  // drums: folded union rows with per-hit @vel
  for (const w of wins) {
    const u = importUnionWindow(w.from, w.to);
    if (u.steps !== w.steps) fail(`slot ${pr.slot} drums ${w.name} steps ${u.steps} != ${w.steps}`);
    for (const [v, row] of Object.entries(u.rows)) {
      w.voices[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
    }
  }

  // melodic voices with the cross-window edge-tie rule (billiejean machinery)
  for (const { part, voice, id, transpose } of MEL) {
    let carry: Carry | undefined;
    const rows: string[][] = [];
    for (let wi = 0; wi < wins.length; wi++) {
      const w = wins[wi];
      const imp = importSongsterrMelodic(part, {
        stepsPerBeat: 4, fromMeasure: w.from, toMeasure: w.to,
        ...(transpose !== undefined ? { transpose } : {}),
      });
      if (imp.step_count !== w.steps) fail(`slot ${pr.slot} ${voice} ${w.name} step_count ${imp.step_count} != ${w.steps}`);
      offGrid[id] += imp.off_grid; totChordOverflow += imp.chord_overflow;
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.not_parsed)) fidelityUnion.set(`p${id}:${fld}`, `not_parsed (${(d as { count: number }).count})`);
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.parsed_not_authored)) fidelityUnion.set(`p${id}:${fld}`, `parsed_not_authored (${JSON.stringify(d)})`);
      const toks = tokensOf(imp.notation);
      if (toks.length !== w.steps) fail(`slot ${pr.slot} ${voice} ${w.name} row has ${toks.length} tokens != ${w.steps}`);

      if (carry !== undefined) {
        let remain = carry.sixths; let at = 0;
        while (remain > 0) {
          if (at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (!isRest(toks[at])) { fail(`slot ${pr.slot} ${voice} ${w.name} continuation collision at step ${at}: "${toks[at]}"`); remain = 0; break; }
          const toEdge = (w.steps - at) * SIX;
          const piece = Math.min(96, remain, toEdge);
          const cont = remain > piece;
          toks[at] = mkTok(carry.pitches, piece, carry.vel, cont);
          edgeInstances.push(`slot ${pr.slot} ${voice} ${w.name} step ${at}: continuation ${carry.pitches}:${gateTok(piece)}${cont ? '_' : ''}`);
          remain -= piece; at += 16;
          if (remain > 0 && at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (remain === 0) carry = undefined;
        }
        if (remain === 0 && carry !== undefined && carry.sixths <= 0) carry = undefined;
      }

      for (const c of imp.cells) {
        const gs = (c as { gate_sixths?: number }).gate_sixths ?? (c as { duration_steps: number }).duration_steps * SIX;
        const endSixth = (c as { step: number }).step * SIX + gs;
        if (endSixth <= w.steps * SIX) continue;
        const cellSteps = new Set(imp.cells.map((x) => (x as { step: number }).step));
        let remaining = gs; let at = (c as { step: number }).step;
        while (remaining > 96) {
          const next = at + 16;
          if (next >= w.steps || cellSteps.has(next)) break;
          remaining -= 96; at = next;
        }
        const finalTok = toks[at];
        const tokenStr = (c as { token: string }).token;
        if (isRest(finalTok) || pitchesOf(finalTok) !== tokenStr) {
          fail(`slot ${pr.slot} ${voice} ${w.name} crosser at step ${(c as { step: number }).step}: expected final piece of ${tokenStr} at ${at}, found "${finalTok}"`);
          continue;
        }
        const toEdge = (w.steps - at) * SIX;
        const carrySixths = endSixth - w.steps * SIX;
        const vel = (c as { velocity?: number }).velocity;
        const nPitches = tokenStr.split('+').length;
        if (wi === wins.length - 1) {
          toks[at] = mkTok(tokenStr, toEdge, vel, false);
          endClipNotes.set(pr.slot, (endClipNotes.get(pr.slot) ?? 0) + nPitches);
          edgeInstances.push(`slot ${pr.slot} ${voice} ${w.name} step ${(c as { step: number }).step}: clip @${at} to ${gateTok(toEdge)} UNTIED (project boundary, carry dropped)`);
        } else {
          toks[at] = mkTok(tokenStr, toEdge, vel, true);
          seamTieNotes.set(pr.slot, (seamTieNotes.get(pr.slot) ?? 0) + nPitches);
          edgeInstances.push(`slot ${pr.slot} ${voice} ${w.name} step ${(c as { step: number }).step} (${tokenStr}, ${gs / SIX} steps): clip final piece @${at} to ${gateTok(toEdge)}_ , carry ${carrySixths / SIX} step(s)`);
          if (carry !== undefined && carry.pitches !== tokenStr) fail(`slot ${pr.slot} ${voice} ${w.name}: two carries cross one edge`);
          else carry = { pitches: tokenStr, sixths: carrySixths, ...(vel !== undefined ? { vel } : {}) };
        }
      }
      rows.push(toks);
    }
    if (carry !== undefined) fail(`slot ${pr.slot} ${voice}: carry left past the last window`);
    for (let wi = 0; wi < wins.length; wi++) {
      if (rows[wi].some((t2) => !isRest(t2))) wins[wi].voices[voice] = rows[wi].join(' ');
    }
  }
  winsBySlot.set(pr.slot, wins);
}

// ── F. global melodic + union assertions ─────────────────────────────
console.log('\n=== F. global assertions ===');
if (offGrid[4] === 0 && offGrid[5] === 0 && offGrid[6] === 22)
  ok('melodic off_grid organ 0 / piano 0 / horns 22 (§0f)');
else fail(`melodic off_grid ${offGrid[4]}/${offGrid[5]}/${offGrid[6]} != 0/0/22`);
if (totChordOverflow === 0) ok('chord_overflow == 0 (piano max 6 == ceiling)'); else fail(`chord_overflow ${totChordOverflow}`);
{
  const st = Object.fromEntries([...seamTieNotes.entries()].sort((a, b) => a[0] - b[0]));
  const ec = Object.fromEntries([...endClipNotes.entries()].sort((a, b) => a[0] - b[0]));
  if (eq(st, { 12: 7, 13: 3 })) ok('seam-tie chains: P4 (slot 12) x7 notes + P5 (slot 13) x3 notes (§0g EXACT)');
  else fail(`seam-tie note counts ${JSON.stringify(st)} != {12:7, 13:3}`);
  if (eq(ec, { 9: 3, 13: 2, 17: 4, 20: 2 }))
    ok('project-end truncations: P1 x3 (slot 9), P5 x2 (slot 13), P9 x4 (slot 17), P11 x2 (slot 20) = 11 notes (§0g EXACT)');
  else fail(`end-clip note counts ${JSON.stringify(ec)} != {9:3, 13:2, 17:4, 20:2}`);
}
info(`import-lens union: cells ${uCells}, collisions ${uColl} (velocity-differing ${uDiff}), micro-dropped ${uMicro}`);
info(`union velocity multiset: ${[...uMultiset.entries()].sort((a, b) => b[0] - a[0]).map(([l, n]) => `${l} x${n}`).join(', ')}`);
{
  const allowed = new Set([127, 120, 110, 100, 90, 60, 40]);
  const stray = [...uMultiset.keys()].filter((l) => !allowed.has(l));
  if (stray.length === 0) ok('all union velocities within the source ladder {127,120,110,100,90,60,40}');
  else fail(`stray union velocity level(s) [${stray}]`);
}
// external note set: folded voices across all windows
{
  const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63, perc: 68 };
  const seen = new Set<string>();
  for (const wins of winsBySlot.values()) for (const w of wins)
    for (const v of Object.keys(w.voices)) if (!['synth1', 'synth2', 'midi1'].includes(v)) seen.add(v);
  const notes = [...seen].map((v) => GM12[v]).sort((a, b) => a - b);
  if (eq([...seen].sort(), ['crash', 'hat', 'kick', 'openhat', 'perc', 'ride', 'snare', 'tom'])
    && eq(notes, [48, 50, 54, 57, 58, 61, 63, 68]))
    ok('external-leg note set {48,50,54,57,58,61,63,68} = the 8 folded voices (fidelity item 4 EXACT)');
  else fail(`folded voice set [${[...seen].sort()}] -> notes [${notes}]`);
}
// midi1 (organ) confinement: only P2 win 8 (m24-25) and P3 wins 1-3 (m26-31)
{
  let bad = 0;
  for (const pr of PROJECTS) {
    const wins = winsBySlot.get(pr.slot)!;
    wins.forEach((w, i) => {
      const has = w.voices.midi1 !== undefined;
      const want = (pr.slot === 10 && i === 7) || (pr.slot === 11 && i <= 2);
      if (has !== want) { bad++; fail(`slot ${pr.slot} win ${i + 1} (${w.name}): organ presence ${has}, expected ${want}`); }
    });
  }
  if (bad === 0) ok('organ confined to P2 pattern 8 (m25 pickup) + P3 patterns 1-3 (m26-31)');
}

// ── G. closing-bar assertions (fold-probe §3 / plan §4 step 2) ───────
console.log('\n=== G. closing-bar assertions ===');
const lastBarToks = (w: WinVoices, voice: string): string[] => {
  const row = w.voices[voice];
  const start = w.steps - 16;
  if (row === undefined) return Array(16).fill('~');
  return tokensOf(row).slice(start, w.steps);
};
const onsetsIn = (toks: string[]): number[] => toks.flatMap((t, i) => (isRest(t) ? [] : [i]));
{
  // P1 (slot 9) final bar m9: piano E7 bar + horn b5 stack + full Latin layer
  const w = winsBySlot.get(9)![4];
  if (onsetsIn(lastBarToks(w, 'synth2')).length > 0) ok('P1 m9: piano E7 bar present');
  else fail('P1 m9 piano empty');
  if (lastBarToks(w, 'synth1').some((t) => t.includes('b5'))) ok('P1 m9: horn b5-stack present');
  else fail('P1 m9 horn b5 stack missing');
  for (const v of ['kick', 'snare', 'hat', 'perc', 'tom']) {
    if (onsetsIn(lastBarToks(w, v)).length === 0) fail(`P1 m9: ${v} lane empty (Latin layer)`);
  }
  ok('P1 m9: full Latin layer (kick/snare/hat/perc/tom lanes sound)');
  // P2 (slot 10) m25: organ pickup e5+a5 (stored +12) at in-bar step 12
  const w2 = winsBySlot.get(10)![7];
  const t28 = tokensOf(w2.voices.midi1 ?? '')[28] ?? '~';
  if (pitchesOf(t28) === 'e5+a5') ok(`P2 m25: organ pickup "${t28}" at window step 28 (in-bar 12, stored +12)`);
  else fail(`P2 m25 organ token "${t28}" != e5+a5`);
  // P4 (slot 12) m47: interlude piano + guiro (perc) back in at 0/4/6/8/12/14
  const w4 = winsBySlot.get(12)![5];
  if (onsetsIn(lastBarToks(w4, 'synth2')).length > 0) ok('P4 m47: interlude piano present');
  else fail('P4 m47 piano empty');
  const percSteps = onsetsIn(lastBarToks(w4, 'perc'));
  if (eq(percSteps, [0, 4, 6, 8, 12, 14])) ok('P4 m47: guiro (folded perc) at in-bar 0/4/6/8/12/14');
  else fail(`P4 m47 perc steps [${percSteps}]`);
  // P7 (slot 15) m82 (16-step final pattern): horn triplet fill snapped to 8/9/11
  const w7 = winsBySlot.get(15)![4];
  const hSteps = onsetsIn(tokensOf(w7.voices.synth1 ?? '').slice(0, 16));
  if ([8, 9, 11].every((s) => hSteps.includes(s)) && !hSteps.includes(10))
    ok(`P7 m82: horn triplet fill snapped 8/9.33/10.67 -> steps 8/9/11 (§0f; full onset list [${hSteps}])`);
  else fail(`P7 m82 horn steps [${hSteps}] missing the 8/9/11 snap shape`);
  if (onsetsIn(tokensOf(w7.voices.snare ?? '').slice(0, 16)).length > 0
    && onsetsIn(tokensOf(w7.voices.tom ?? '').slice(0, 16)).length > 0)
    ok('P7 m82: tom+snare turnaround fill present');
  else fail('P7 m82 tom/snare fill missing');
  // P9 (slot 17) m108: the 127-velocity horn stack
  const w9 = winsBySlot.get(17)![4];
  if (lastBarToks(w9, 'synth1').some((t) => t.includes('@127'))) ok('P9 m108: @127 horn stack present');
  else fail('P9 m108 @127 stack missing');
  // P13 (slot 21): m141 crash, m142-143 guiro+piano close, m144 all-rest
  const w13 = winsBySlot.get(21)!;
  const w141 = w13[4]; // m141-142
  const crashSteps = onsetsIn(tokensOf(w141.voices.crash ?? '').slice(0, 16));
  if (crashSteps.includes(0)) ok('P13 m141: final crash at step 0');
  else fail(`P13 m141 crash steps [${crashSteps}]`);
  const w143 = w13[5]; // m143-144
  if (onsetsIn(tokensOf(w143.voices.perc ?? '').slice(0, 16)).length > 0
    && onsetsIn(tokensOf(w143.voices.synth2 ?? '').slice(0, 16)).length > 0)
    ok('P13 m143: guiro + piano close present');
  else fail('P13 m143 guiro/piano close missing');
  let m144 = 0;
  for (const v of Object.keys(w143.voices)) m144 += onsetsIn(tokensOf(w143.voices[v]).slice(16, 32)).length;
  if (m144 === 0) ok('P13 m144: silent ring-out bar (all rests inside the last pattern)');
  else fail(`P13 m144 has ${m144} onsets`);
}

// ── H. the Havana section (§H rows VERBATIM) ─────────────────────────
console.log('\n=== H. Havana (§H rows) ===');
const HAVANA_ROWS: Record<string, string> = {
  midi1: 'g3:6@100 ~ ~ ~ ~ ~ d4:2@100 ~ eb3:6@100 ~ ~ ~ ~ ~ bb3:2@100 ~ d3:6@100 ~ ~ ~ ~ ~ a3:2@100 ~ d4:4@100 ~ ~ ~ c4:2@100 ~ f#3:2@100 ~',
  synth2: 'g1:6@100 ~ ~ ~ ~ ~ g1:2@100 ~ eb1:6@100 ~ ~ ~ ~ ~ eb1:2@100 ~ d1:6@100 ~ ~ ~ ~ ~ d1:2@100 ~ d1:4@100 ~ ~ ~ d1:4@100 ~ ~ ~',
  synth1: '~ ~ ~ ~ ~ ~ d4+g4+bb4:2@110 ~ ~ ~ ~ ~ ~ ~ eb4+g4+bb4:2@110 ~ ~ ~ ~ ~ ~ ~ d4+f#4+c5:2@120 ~ ~ ~ ~ ~ d4+f#4+a4+c5:4@120 ~ ~ ~',
  kick: 'kick@100 ~ ~ ~ ~ ~ kick@60 ~ ~ ~ ~ ~ ~ ~ ~ ~ kick@100 ~ ~ ~ ~ ~ kick@60 ~ ~ ~ ~ ~ ~ ~ ~ ~',
  snare: '~ ~ ~ ~ ~ ~ ~ ~ snare@100 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ snare@100 ~ ~ ~ ~ ~ ~ ~',
  hat: '~ ~ ~ ~ hat@60 ~ ~ ~ ~ ~ ~ ~ hat@60 ~ ~ ~ ~ ~ ~ ~ hat@60 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~',
  openhat: '~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ openhat@60 ~',
};
{
  for (const [v, row] of Object.entries(HAVANA_ROWS)) {
    const toks = tokensOf(row);
    if (toks.length !== 32) fail(`Havana ${v}: ${toks.length} tokens != 32`);
    try {
      const parsed = parseVoice(row, 32);
      if (parsed.length !== 32) fail(`Havana ${v}: parseVoice length ${parsed.length}`);
    } catch (e) {
      fail(`Havana ${v}: parseVoice threw: ${(e as Error).message}`);
    }
  }
  ok('all 7 Havana rows: 32 tokens each, parseVoice-clean (flats eb/bb accepted)');
  const m1 = tokensOf(HAVANA_ROWS.midi1);
  if (m1[30] === 'f#3:2@100' && m1.slice(31).every(isRest)) ok('Havana riff: last onset f#3:2@100 at step 30 (the leading tone resolving to the wrap\'s g3)');
  else fail(`Havana riff step 30 "${m1[30]}"`);
  const s1 = tokensOf(HAVANA_ROWS.synth1);
  if (eq(onsetsIn(s1), [6, 14, 22, 28])) ok('Havana stabs: offbeats 6/14/22/28 only (silence-first)');
  else fail(`Havana stab steps [${onsetsIn(s1)}]`);
  if (eq(onsetsIn(tokensOf(HAVANA_ROWS.kick)), [0, 6, 16, 22])
    && eq(onsetsIn(tokensOf(HAVANA_ROWS.snare)), [8, 24])
    && eq(onsetsIn(tokensOf(HAVANA_ROWS.hat)), [4, 12, 20])
    && eq(onsetsIn(tokensOf(HAVANA_ROWS.openhat)), [30]))
    ok('Havana drums: kick 0/6/16/22 (habanera), snare 8/24 (half-time backbeat), hat 4/12/20, openhat 30 (the breath)');
  else fail('Havana drum onsets drifted from §H');
}

// ── I. dedupe into sections/order + emit staged JSON ─────────────────
console.log('\n=== I. staged sections/order ===');
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
  info(`slot ${pr.slot}: ${order.length} plays [${order.join(' ')}], ${sections.length} stored section(s)`);
  staged.push({ slot: pr.slot, project_name: pr.project_name, order, sections });
}
staged.push({
  slot: 18, project_name: 'Smooth 10 Havana', order: ['Havana'],
  sections: [{ name: 'Havana', steps: 32, voices: HAVANA_ROWS }],
});
staged.sort((a, b) => a.slot - b.slot);
{
  const hv = staged.find((s) => s.slot === 18)!;
  if (eq(hv.sections[0].voices, HAVANA_ROWS)) ok('staged Havana payload voices == §H rows TOKEN-EXACT (by construction, asserted)');
  else fail('Havana staged payload drifted from §H');
  const plays = staged.map((s) => s.order.length);
  if (eq(plays, [5, 8, 5, 6, 8, 5, 5, 8, 5, 1, 6, 6, 6]))
    ok('plays per slot [5,8,5,6,8,5,5,8,5,1,6,6,6] == §1 (chains [0,4]/[0,7]/[0,4]/[0,5]/[0,7]/[0,4]/[0,4]/[0,7]/[0,4]/[0,0]/[0,5]/[0,5]/[0,5])');
  else fail(`plays [${plays}]`);
}

console.log('\n=== dropped-fidelity union (melodic imports) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);
console.log(`\n=== edge-tie instances (${edgeInstances.length}) ===`);
for (const e of edgeInstances) console.log(`  ${e}`);

writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/smooth-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/smooth-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
