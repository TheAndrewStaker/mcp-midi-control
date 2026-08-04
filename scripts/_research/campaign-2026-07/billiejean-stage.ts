/**
 * Billie Jean Phase-0 staging (mirror of whatigot-stage.ts union machinery +
 * brainstew-stage.ts cross-window edge-tie machinery). READ-ONLY: no device,
 * no network. Run: npx tsx samples/_scratch/billiejean-stage.ts
 *
 * Builds the EIGHT per-project `arrangement` payloads (Pack 2 slots 57-64,
 * row 8 — the orchestrator-bound branch-P2 variant: What I Got took 41-49)
 * from the PINNED cache (samples/songsterr-cache/s10586, rev 8048414) via the
 * EXACT import path (importSongsterrMelodic / importSongsterrDrums):
 *   - t10 String Arr 1 -> synth1 (Hydrasynth ch1, stored 0)
 *   - t8  Rhodes       -> synth2 (internal, stored 100; the Redbone patch role)
 *   - t14 Synth Brass  -> midi1  TRANSPOSE +12 (the +12 store convention,
 *     DECISIONS.md 2026-07-28: the Circuit transmits MIDI-track notes 12 below
 *     stored — the What I Got whistle precedent)
 *   - t16 kit + t15 percussion -> UNION rows (voice sets disjoint, 0
 *     collisions measured §0d) with per-hit @vel for midi2 external + condense
 *   - fork defaults TAKEN: fade m141-144 DROPPED (Q1), Emulator DROPPED (Q2),
 *     brass on MIDI 1 (Q3)
 * Asserts (plan §4 Phase 0 step 1, all must pass): packing per §1 (uniform
 * 32-step; slot 57 single pattern; slot 60 = 8 patterns, pattern 5 head =
 * m83's crash bar); the §0f loss ledger EXACTLY (raw-event lens) + the
 * import-level serve identity (C-bar unison hats fold away on the 16th grid);
 * melodic off_grid == 0 and chord_overflow == 0; per-slot drum velocity
 * multiset (13 @120 total at their staged steps, ghosts 0 stored); union
 * collision count 0; §0g elision facts (outro strings identical x7, cell
 * bar1 == bar2); the m94 brass tied chain staged (the build's ONE
 * cross-pattern crosser); closing-bar assertions for every project tail.
 * Emits samples/_scratch/billiejean-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrDrums,
  type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s10586';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const p8 = load(8);   // Rhodes            -> synth2
const p10 = load(10); // String Arr 1      -> synth1
const p14 = load(14); // Synth Brass       -> midi1 (+12 store convention)
const p15 = load(15); // percussion        -> union
const p16 = load(16); // kit               -> union

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── A. source-census gates (plan §0c/§0d — source drift detection) ───
console.log('=== A. source census gates (§0c/§0d) ===');
const fKit = flattenSongsterrDrums(p16);
const fPerc = flattenSongsterrDrums(p15);
if (fKit.events.length === 1773 && fKit.ghosts === 2 && fKit.accents === 14 && fKit.unmapped === 0)
  ok('kit t16: 1773 events, 2 ghosts, 14 accents, 0 unmapped (§0c)');
else fail(`kit census ${fKit.events.length}/${fKit.ghosts}/${fKit.accents}/${fKit.unmapped} != 1773/2/14/0`);
if (fPerc.events.length === 1246 && fPerc.ghosts === 16 && fPerc.unmapped === 0)
  ok('perc t15: 1246 events, 16 ghosts, 0 unmapped (§0d)');
else fail(`perc census ${fPerc.events.length}/${fPerc.ghosts}/${fPerc.unmapped} != 1246/16/0`);
{
  const kv = new Map<string, number>();
  for (const e of fKit.events) kv.set(e.voice, (kv.get(e.voice) ?? 0) + 1);
  if (kv.get('hat') === 1180 && kv.get('snare') === 291 && kv.get('kick') === 288 && kv.get('tom') === 12 && kv.get('crash') === 2)
    ok('kit voices hat1180/snare291/kick288/tom12/crash2');
  else fail(`kit voice census ${JSON.stringify([...kv])}`);
  const pv = new Map<string, number>();
  for (const e of fPerc.events) pv.set(e.voice, (pv.get(e.voice) ?? 0) + 1);
  if (pv.get('maracas') === 1139 && pv.get('clap') === 104 && pv.get('cabasa') === 3)
    ok('perc voices maracas1139/clap104/cabasa3');
  else fail(`perc voice census ${JSON.stringify([...pv])}`);
  // voice-set disjointness = the union is collision-free by construction
  const shared = [...pv.keys()].filter((v) => kv.has(v));
  if (shared.length === 0) ok('kit/perc voice sets DISJOINT (union collision-free by construction, §0d)');
  else fail(`kit/perc share voices [${shared}]`);
}

// ── raw-event bar machinery (probe-parity, for the §0f ledger) ───────
const measures = fKit.measures;
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
  key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.ghost === true ? '~' : ''}`,
}));
const evKIT = drumEvs(fKit);
const evPERC = drumEvs(fPerc);

// ── B. drum union per window (import-truth, the authored path) ───────
interface UnionWin {
  steps: number;
  rows: Record<string, (number | undefined)[]>;
  cells: number; collisions: number; microCells: number; ghostCells: number;
}
const velOfStep = (s: { velocity?: number; accent?: boolean }): number =>
  s.velocity ?? (s.accent === true ? 120 : 100);
function importUnionWindow(from: number, to: number): UnionWin {
  const a = importSongsterrDrums(p16, { stepsPerBeat: 4, fromMeasure: from, toMeasure: to });
  const b = importSongsterrDrums(p15, { stepsPerBeat: 4, fromMeasure: from, toMeasure: to });
  if (a.steps !== b.steps) fail(`union m${from}-${to}: kit ${a.steps} steps != perc ${b.steps}`);
  const steps = a.steps;
  const rows: Record<string, (number | undefined)[]> = {};
  let cells = 0; let collisions = 0; let microCells = 0; let ghostCells = 0;
  const voices = new Set([...Object.keys(a.voices), ...Object.keys(b.voices)]);
  for (const v of voices) {
    const row: (number | undefined)[] = Array.from({ length: steps }, () => undefined);
    for (let i = 0; i < steps; i++) {
      const sa = a.voices[v]?.[i]; const sb = b.voices[v]?.[i];
      const aOn = sa?.on === true; const bOn = sb?.on === true;
      if (!aOn && !bOn) continue;
      cells++;
      const s = aOn ? sa! : sb!;
      if (aOn && bOn) collisions++;
      if ((s as { roll?: number }).roll !== undefined) fail(`m${from}-${to} ${v}@${i}: unexpected roll`);
      if ((s as { micro?: number[] }).micro !== undefined && !eq((s as { micro?: number[] }).micro, [0])) microCells++;
      const vel = aOn && bOn ? Math.max(velOfStep(sa!), velOfStep(sb!)) : velOfStep(s);
      if (vel === 40) ghostCells++;
      row[i] = vel;
    }
    if (row.some((x) => x !== undefined)) rows[v] = row;
  }
  return { steps, rows, cells, collisions, microCells, ghostCells };
}

// ── C. project set (plan §1; base 57, branch P2 row 8) ───────────────
const win2 = (from: number, to: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let m = from; m <= to; m += 2) out.push([m, m + 1]);
  return out;
};
interface Proj {
  slot: number; project_name: string;
  windows: Array<[number, number]>;
  /** expected count of @120 union cells across PLAYS (stored patterns) */
  expect120: number;
}
const PROJECTS: Proj[] = [
  { slot: 57, project_name: 'BillieJean 1 Groove',   windows: [[3, 4]], expect120: 0 },
  { slot: 58, project_name: 'BillieJean 2 PreChor1', windows: win2(35, 42), expect120: 0 },
  { slot: 59, project_name: 'BillieJean 3 Chorus1',  windows: win2(43, 54), expect120: 1 },
  { slot: 60, project_name: 'BillieJean 4 PreCh2Cho', windows: win2(75, 90), expect120: 2 },
  { slot: 61, project_name: 'BillieJean 5 Chorus2b', windows: win2(91, 102), expect120: 2 },
  { slot: 62, project_name: 'BillieJean 6 Interlude', windows: win2(103, 114), expect120: 3 },
  { slot: 63, project_name: 'BillieJean 7 Chorus3',  windows: win2(115, 126), expect120: 2 },
  { slot: 64, project_name: 'BillieJean 8 Outro',    windows: win2(127, 140), expect120: 3 },
];
for (const pr of PROJECTS) {
  if (pr.project_name.length > 32) fail(`slot ${pr.slot} name "${pr.project_name}" > 32 chars`);
}
const MEL: Array<{ part: SongsterrPart; voice: 'synth1' | 'synth2' | 'midi1'; id: number; transpose?: number }> = [
  { part: p10, voice: 'synth1', id: 10 },
  { part: p8, voice: 'synth2', id: 8 },
  { part: p14, voice: 'midi1', id: 14, transpose: 12 },
];

// ── token helpers (verbatim brainstew-stage) ─────────────────────────
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
const offGrid: Record<number, number> = { 8: 0, 10: 0, 14: 0 };
let totChordOverflow = 0;
const winsBySlot = new Map<number, WinVoices[]>();

for (const pr of PROJECTS) {
  console.log(`\n=== slot ${pr.slot} "${pr.project_name}" ===`);
  const wins: WinVoices[] = pr.windows.map(([f, t]) => ({
    name: `m${f}${t !== f ? '-' + t : ''}`, steps: (t - f + 1) * 16, from: f, to: t, voices: {},
  }));
  const steps = wins.map((w) => w.steps);
  if (steps.every((s) => s === 32)) ok(`packing [${steps.length} x 32]`);
  else fail(`slot ${pr.slot} packing [${steps}] not uniform 32`);

  // drums: union rows with per-hit @vel
  let n120 = 0;
  for (const w of wins) {
    const u = importUnionWindow(w.from, w.to);
    if (u.steps !== w.steps) fail(`slot ${pr.slot} drums ${w.name} steps ${u.steps} != ${w.steps}`);
    if (u.collisions !== 0) fail(`slot ${pr.slot} drums ${w.name}: ${u.collisions} collisions != 0`);
    if (u.microCells !== 0) fail(`slot ${pr.slot} drums ${w.name}: ${u.microCells} micro cells != 0 (all hits on-grid per probe)`);
    if (u.ghostCells !== 0) fail(`slot ${pr.slot} drums ${w.name}: ${u.ghostCells} STORED ghost cells != 0 (§3: stored ghosts zero)`);
    for (const [v, row] of Object.entries(u.rows)) {
      for (const x of row) {
        if (x === undefined) continue;
        if (x === 120) n120++;
        else if (x !== 100) fail(`slot ${pr.slot} ${w.name} ${v}: velocity ${x} not in {100,120}`);
      }
      w.voices[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
    }
  }
  if (n120 === pr.expect120) ok(`@120 accents across plays: ${n120} == expected ${pr.expect120}`);
  else fail(`slot ${pr.slot} @120 count ${n120} != ${pr.expect120}`);

  // melodic voices with the cross-window edge-tie rule (brainstew machinery)
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
        if (wi === wins.length - 1) {
          toks[at] = mkTok(tokenStr, toEdge, vel, false);
          edgeInstances.push(`slot ${pr.slot} ${voice} ${w.name} step ${(c as { step: number }).step}: clip @${at} to ${gateTok(toEdge)} UNTIED (project boundary, carry dropped)`);
        } else {
          toks[at] = mkTok(tokenStr, toEdge, vel, true);
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

// ── D. global melodic assertions ─────────────────────────────────────
console.log('\n=== D. global melodic assertions ===');
if (offGrid[10] === 0 && offGrid[8] === 0 && offGrid[14] === 0) ok('melodic off_grid == 0 (t10/t8/t14, all authored windows)');
else fail(`melodic off_grid ${offGrid[10]}/${offGrid[8]}/${offGrid[14]} != 0/0/0`);
if (totChordOverflow === 0) ok('chord_overflow == 0 (max chord 4 <= 6)'); else fail(`chord_overflow ${totChordOverflow}`);
{
  const crossers = edgeInstances.filter((e) => e.includes('clip final piece'));
  const conts = edgeInstances.filter((e) => e.includes('continuation'));
  if (crossers.length === 1 && crossers[0].includes('slot 61 midi1 m93-94 step 31')
    && conts.length === 1 && conts[0].includes('slot 61 midi1 m95-96 step 0'))
    ok('EXACTLY ONE cross-pattern crosser: the m94 brass tie (slot 61, m93-94 step 31 -> m95-96 step 0), per §0g');
  else fail(`edge instances unexpected: ${JSON.stringify(edgeInstances)}`);
}
// brass stored register (+12): f#5..c#7 (78..97)
{
  const NAMES: Record<string, number> = { c: 0, 'c#': 1, d: 2, 'd#': 3, e: 4, f: 5, 'f#': 6, g: 7, 'g#': 8, a: 9, 'a#': 10, b: 11 };
  const midiOf = (tok: string): number => {
    const m = /^([a-g]#?)(-?\d+)$/.exec(pitchesOf(tok));
    if (!m) { fail(`brass token "${tok}" unparsable`); return -1; }
    return NAMES[m[1]] + (Number(m[2]) + 1) * 12;
  };
  const notes: number[] = [];
  for (const wins of winsBySlot.values()) for (const w of wins) {
    if (w.voices.midi1 === undefined) continue;
    for (const t2 of tokensOf(w.voices.midi1)) if (!isRest(t2)) notes.push(midiOf(t2));
  }
  const lo = Math.min(...notes); const hi = Math.max(...notes);
  if (lo === 78 && hi === 97) ok(`brass stored register f#5..c#7 (${lo}..${hi}; sounds f#4..c#6 through the -12 transmit)`);
  else fail(`brass stored register ${lo}..${hi} != 78..97`);
}
// content confinement: brass only slots 58+61; rhodes only 58+60; strings never in 57
{
  for (const pr of PROJECTS) {
    const wins = winsBySlot.get(pr.slot)!;
    const hasBrass = wins.some((w) => w.voices.midi1 !== undefined);
    const hasRhodes = wins.some((w) => w.voices.synth2 !== undefined);
    const hasStrings = wins.some((w) => w.voices.synth1 !== undefined);
    if (hasBrass !== (pr.slot === 58 || pr.slot === 61)) fail(`slot ${pr.slot}: brass presence ${hasBrass} unexpected`);
    if (hasRhodes !== (pr.slot === 58 || pr.slot === 60)) fail(`slot ${pr.slot}: rhodes presence ${hasRhodes} unexpected`);
    if (pr.slot === 57 && hasStrings) fail('slot 57: strings content in the Groove cell?!');
    if ((pr.slot >= 59 || pr.slot === 58) && pr.slot !== 59 && pr.slot !== 57) {
      // strings expected in 58 (m41-42), 60, 61, 62, 63, 64
      if (!hasStrings && pr.slot !== 59) fail(`slot ${pr.slot}: strings MISSING`);
    }
    if (pr.slot === 59 && !hasStrings) fail('slot 59: strings (c-swells m47/m51) MISSING');
  }
  ok('content confinement: brass 58+61 only, rhodes 58+60 only, strings 58-64, slot 57 drums-only');
}

// ── E. the §0f loss ledger (BOTH lenses) + serve identity ────────────
console.log('\n=== E. slot 57 Groove: §0f loss ledger + serve identity ===');
{
  // raw-event lens (probe parity): served bars vs the cell bar, §0f EXACTLY
  const cellKit = barSig(evKIT, 2); // m3 (0-based mi=2)
  const cellPerc = barSig(evPERC, 2);
  const served: number[] = [];
  for (let m = 1; m <= 34; m++) served.push(m);
  for (let m = 55; m <= 74; m++) served.push(m);
  const rawDiffs: string[] = [];
  for (const m of served) {
    const k = barSig(evKIT, m - 1); const p = barSig(evPERC, m - 1);
    if (k !== cellKit) rawDiffs.push(`m${m}:KIT`);
    if (p !== cellPerc) rawDiffs.push(`m${m}:PERC`);
  }
  const expect = ['m1:PERC', 'm2:PERC', 'm6:PERC', 'm7:PERC', 'm34:KIT', 'm55:KIT', 'm67:KIT', 'm74:KIT'];
  if (eq(rawDiffs, expect))
    ok('raw-event ledger EXACT (§0f): m1-2 early maracas, m6-7 cabasa x3, m34 ghost pickup, m55/m67 C-bar hats, m74 drag (ghost + snare@120)');
  else fail(`raw ledger [${rawDiffs}] != [${expect}]`);

  // import lens (stored truth): serve identity per 2-bar window
  const cell = importUnionWindow(3, 4);
  const cellKey = JSON.stringify(cell.rows);
  const windows: Array<[number, number]> = [...win2(1, 34), ...win2(55, 74)];
  const importDiffs: string[] = [];
  for (const [f, t] of windows) {
    if (f === 3) continue; // the authored cell itself
    const u = importUnionWindow(f, t);
    if (JSON.stringify(u.rows) !== cellKey) importDiffs.push(`m${f}-${t}`);
  }
  const expImp = ['m1-2', 'm5-6', 'm7-8', 'm33-34', 'm73-74'];
  if (eq(importDiffs, expImp))
    ok(`import-lens serve identity: deviating windows exactly [${expImp}] — m55-56/m67-68 import-IDENTICAL (the C-bar unison hat folds away on the 16th grid; that loss is the grid's, not the loop's)`);
  else fail(`import-lens deviations [${importDiffs}] != [${expImp}]`);

  // the deviation CONTENT, cell-level (what the loop drops/adds)
  const diffCells = (a: UnionWin, b: UnionWin): string[] => {
    const out: string[] = [];
    const voices = new Set([...Object.keys(a.rows), ...Object.keys(b.rows)]);
    for (const v of voices) {
      for (let i = 0; i < 32; i++) {
        const av = a.rows[v]?.[i]; const bv = b.rows[v]?.[i];
        if (av !== bv) out.push(`${v}@${i}:${av ?? '-'}vs${bv ?? '-'}`);
      }
    }
    return out.sort();
  };
  const d12 = diffCells(cell, importUnionWindow(1, 2));
  if (d12.length === 16 && d12.every((d) => d.startsWith('maracas'))) ok('m1-2: cell adds 16 early maracas (source silent; §0f named)');
  else fail(`m1-2 diff ${JSON.stringify(d12)}`);
  const d56 = diffCells(cell, importUnionWindow(5, 6));
  if (eq(d56, ['cabasa@30:-vs100', 'cabasa@31:-vs100'])) ok('m5-6: loop drops 2 cabasa (m6 colour)');
  else fail(`m5-6 diff ${JSON.stringify(d56)}`);
  const d78 = diffCells(cell, importUnionWindow(7, 8));
  if (eq(d78, ['cabasa@0:-vs100'])) ok('m7-8: loop drops 1 cabasa (m7 colour)');
  else fail(`m7-8 diff ${JSON.stringify(d78)}`);
  const d34 = diffCells(cell, importUnionWindow(33, 34));
  if (eq(d34, ['snare@31:-vs40'])) ok('m33-34: loop drops the m34 ghost-snare pickup (vel 40)');
  else fail(`m33-34 diff ${JSON.stringify(d34)}`);
  const d74 = diffCells(cell, importUnionWindow(73, 74));
  if (eq(d74, ['snare@30:-vs40', 'snare@31:-vs120'])) ok('m73-74: loop drops the m74 double drag (ghost 40 + snare@120 — the 14th accent)');
  else fail(`m73-74 diff ${JSON.stringify(d74)}`);
}

// ── F. §0g elision facts + closing-bar assertions ────────────────────
console.log('\n=== F. closing-bar + elision assertions ===');
const barTok = (w: WinVoices, voice: string, barIdx: number): string[] => {
  const row = w.voices[voice];
  if (row === undefined) return Array(16).fill('~');
  return tokensOf(row).slice(barIdx * 16, barIdx * 16 + 16);
};
const barHas = (w: WinVoices, voice: string, barIdx: number): boolean =>
  barTok(w, voice, barIdx).some((t2) => !isRest(t2));
const stepsOf = (w: WinVoices, voice: string): number[] => {
  const row = w.voices[voice];
  if (row === undefined) return [];
  return tokensOf(row).flatMap((t2, i) => (isRest(t2) ? [] : [i]));
};
const velAt = (w: WinVoices, voice: string, step: number): number | undefined => {
  const row = w.voices[voice];
  if (row === undefined) return undefined;
  const t2 = tokensOf(row)[step];
  if (t2 === undefined || isRest(t2)) return undefined;
  const m = /@(\d+)/.exec(t2);
  return m ? Number(m[1]) : 100;
};

// slot 57: the cell — kick 1&3, snare 2&4, 8th hats + maracas, bar1 == bar2
{
  const w = winsBySlot.get(57)![0];
  if (eq(stepsOf(w, 'kick'), [0, 8, 16, 24])) ok('slot 57: kick on 1 & 3 (steps 0/8/16/24)'); else fail(`slot 57 kick [${stepsOf(w, 'kick')}]`);
  if (eq(stepsOf(w, 'snare'), [4, 12, 20, 28])) ok('slot 57: snare on 2 & 4'); else fail(`slot 57 snare [${stepsOf(w, 'snare')}]`);
  const evens = Array.from({ length: 16 }, (_, i) => i * 2);
  if (eq(stepsOf(w, 'hat'), evens)) ok('slot 57: straight-8th hats'); else fail(`slot 57 hat [${stepsOf(w, 'hat')}]`);
  if (eq(stepsOf(w, 'maracas'), evens)) ok('slot 57: maracas riding 8ths'); else fail(`slot 57 maracas [${stepsOf(w, 'maracas')}]`);
  const b1 = ['kick', 'snare', 'hat', 'maracas'].map((v) => barTok(w, v, 0).join(' '));
  const b2 = ['kick', 'snare', 'hat', 'maracas'].map((v) => barTok(w, v, 1).join(' '));
  if (eq(b1, b2)) ok('slot 57: cell bar1 == bar2 (period 1, wrap trivially clean §0g)');
  else fail('slot 57 cell bars differ');
}
// slot 58: pat4 = m41-42 strings a b (content both bars) + rhodes all wins; brass wins 1+3 identical
{
  const wins = winsBySlot.get(58)!;
  if (barHas(wins[3], 'synth1', 0) && barHas(wins[3], 'synth1', 1)) ok('slot 58 pat4 (m41-42): strings first entry, content BOTH bars (a b)');
  else fail('slot 58 pat4 strings missing a bar');
  if (wins.every((w) => w.voices.synth2 !== undefined)) ok('slot 58: rhodes comping in all 4 windows');
  else fail('slot 58: rhodes missing in a window');
  const b1 = wins[0].voices.midi1; const b3 = wins[2].voices.midi1;
  if (b1 !== undefined && b1 === b3 && wins[1].voices.midi1 === undefined && wins[3].voices.midi1 === undefined)
    ok('slot 58: brass licks in wins 1+3 only (m36 == m40, identical figures)');
  else fail('slot 58 brass placement unexpected');
}
// slot 59: crash head m43, tom@120 m44 step 27, strings c-swells wins 3+5 only, pat6 = m53-54 plain
{
  const wins = winsBySlot.get(59)!;
  if (eq(stepsOf(wins[0], 'crash'), [0])) ok('slot 59 pat1: crash head at m43 step 0'); else fail(`slot 59 crash [${stepsOf(wins[0], 'crash')}]`);
  if (velAt(wins[0], 'tom', 27) === 120) ok('slot 59 pat1: tom fill m44 @120 (step 27)'); else fail('slot 59 tom@120 m44 missing');
  const sw = wins.map((w) => w.voices.synth1 !== undefined);
  if (eq(sw, [false, false, true, false, true, false])) ok('slot 59: strings c-swells in wins 3+5 only (m47/m51)');
  else fail(`slot 59 strings presence [${sw}]`);
  if (wins[2].voices.synth1 === wins[4].voices.synth1) ok('slot 59: the two c-swell windows identical (dedupe candidate)');
  else info('slot 59: c-swell windows differ (stored separately)');
  const t6 = wins[5];
  if (!barHas(t6, 'synth1', 0) && !barHas(t6, 'synth1', 1) && stepsOf(t6, 'clap').length > 0)
    ok('slot 59 pat6 (m53-54): plain groove + chorus claps, no strings');
  else fail('slot 59 pat6 unexpected content');
}
// slot 60: pattern 5 head = m83 crash; rhodes wins 1-4 only; pat8 = m89-90 strings l pickup bar2 + tom m90
{
  const wins = winsBySlot.get(60)!;
  if (eq(stepsOf(wins[4], 'crash'), [0])) ok('slot 60 pat5 (m83): crash head — PreCh2 auto-advances into Chorus 2a');
  else fail(`slot 60 pat5 crash [${stepsOf(wins[4], 'crash')}]`);
  const rh = wins.map((w) => w.voices.synth2 !== undefined);
  if (eq(rh, [true, true, true, true, false, false, false, false])) ok('slot 60: rhodes in wins 1-4 (PreCh2) only');
  else fail(`slot 60 rhodes presence [${rh}]`);
  if (wins.every((w) => w.voices.synth1 !== undefined)) ok('slot 60: strings in all 8 windows (the full d-i bed + j k vamp)');
  else fail('slot 60: strings missing in a window');
  const t8w = wins[7];
  if (!barHas(t8w, 'synth1', 0) && barHas(t8w, 'synth1', 1)) ok('slot 60 pat8 (m89-90): strings l pickup in bar 2 only');
  else fail('slot 60 pat8 strings shape unexpected');
  if (velAt(t8w, 'tom', 27) === 120) ok('slot 60 pat8: tom fill m90 @120'); else fail('slot 60 pat8 tom missing');
  if (velAt(wins[4], 'tom', 27) === 120) ok('slot 60 pat5: tom fill m84 @120'); else fail('slot 60 pat5 tom missing');
}
// slot 61: the m94 tie chain; octave stabs wins 4+6 (steps 2/4/6 + 18/20/22); toms m92/m102
{
  const wins = winsBySlot.get(61)!;
  const w2t = tokensOf(wins[1].voices.midi1 ?? '');
  const w3t = tokensOf(wins[2].voices.midi1 ?? '');
  if (w2t[31] === 'f#5:1_' && w3t[0] === 'f#5:2')
    ok('slot 61: m94 brass tied chain staged (m93-94 step 31 "f#5:1_" -> m95-96 step 0 "f#5:2")');
  else fail(`slot 61 tie tokens "${w2t[31]}" / "${w3t[0]}"`);
  for (const wi of [3, 5]) {
    const st = stepsOf(wins[wi], 'midi1');
    if (eq(st, [2, 4, 6, 18, 20, 22])) ok(`slot 61 pat${wi + 1}: octave stabs at steps 2/4/6 + 18/20/22`);
    else fail(`slot 61 pat${wi + 1} midi1 steps [${st}]`);
    const pitches = st.map((s) => pitchesOf(tokensOf(wins[wi].voices.midi1!)[s]));
    if (eq(pitches, ['c#6', 'c#7', 'c#6', 'c#6', 'c#7', 'c#6'])) ok(`slot 61 pat${wi + 1}: stab pitches c#6/c#7/c#6 x2 (octave figure)`);
    else fail(`slot 61 pat${wi + 1} stab pitches [${pitches}]`);
  }
  if (velAt(wins[0], 'tom', 27) === 120 && velAt(wins[5], 'tom', 27) === 120) ok('slot 61: tom fills m92 + m102 @120');
  else fail('slot 61 toms missing');
}
// slot 62: claps drop m103-110, return m111; hat@120 m110; toms m108/m114; strings j k x4 + c + l
{
  const wins = winsBySlot.get(62)!;
  const cl = wins.map((w) => stepsOf(w, 'clap').length > 0);
  if (eq(cl, [false, false, false, false, true, true])) ok('slot 62: claps DROP for wins 1-4 (m103-110), return win5 (m111) — the breakdown');
  else fail(`slot 62 clap presence [${cl}]`);
  if (wins.every((w) => stepsOf(w, 'maracas').length === 16)) ok('slot 62: maracas keep straight 8ths throughout');
  else fail('slot 62 maracas gap');
  if (velAt(wins[3], 'hat', 30) === 120) ok('slot 62 pat4: the m110 hat accent @120 (step 30)');
  else fail('slot 62 m110 hat accent missing');
  if (velAt(wins[2], 'tom', 27) === 120 && velAt(wins[5], 'tom', 27) === 120) ok('slot 62: tom fills m108 + m114 @120');
  else fail('slot 62 toms missing');
  const t6 = wins[5];
  if (stepsOf(t6, 'clap').length === 4 && barHas(t6, 'synth1', 1) && !barHas(t6, 'synth1', 0))
    ok('slot 62 pat6 (m113-114): perc claps back + strings l pickup bar 2');
  else fail('slot 62 pat6 unexpected');
}
// slot 63: strings variant bars; toms m116/m126; pat6 = m125-126 n l + tom
{
  const wins = winsBySlot.get(63)!;
  if (velAt(wins[0], 'tom', 27) === 120 && velAt(wins[5], 'tom', 27) === 120) ok('slot 63: tom fills m116 + m126 @120');
  else fail('slot 63 toms missing');
  const t6 = wins[5];
  if (barHas(t6, 'synth1', 0) && barHas(t6, 'synth1', 1)) ok('slot 63 pat6 (m125-126): strings n + l, content both bars');
  else fail('slot 63 pat6 strings shape unexpected');
  if (wins.every((w) => w.voices.synth1 !== undefined)) ok('slot 63: strings in all 6 windows (the saturated chorus)');
  else fail('slot 63 strings missing in a window');
}
// slot 64: 7 windows, strings identical x7 (the j k vamp, §0g wrap-clean); toms m128/m130/m136
{
  const wins = winsBySlot.get(64)!;
  const s0 = wins[0].voices.synth1;
  if (s0 !== undefined && wins.every((w) => w.voices.synth1 === s0))
    ok('slot 64: the (j k) string vamp IDENTICAL across all 7 windows (whole-cycle wrap, elision-clean §0g)');
  else fail('slot 64 strings rows differ across windows');
  const tomWins = wins.map((w, i) => (velAt(w, 'tom', 27) === 120 ? i + 1 : 0)).filter((x) => x > 0);
  if (eq(tomWins, [1, 2, 5])) ok('slot 64: tom fills in wins 1/2/5 (m128/m130/m136) @120');
  else fail(`slot 64 tom wins [${tomWins}]`);
  if (wins.every((w) => w.voices.midi1 === undefined && w.voices.synth2 === undefined))
    ok('slot 64: pure strings + groove (no brass, no rhodes)');
  else fail('slot 64 unexpected melodic content');
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
  info(`slot ${pr.slot}: ${order.length} plays [${order.join(' ')}], ${sections.length} stored section(s)`);
  staged.push({ slot: pr.slot, project_name: pr.project_name, order, sections });
}
{
  const plays = staged.map((s) => s.order.length);
  if (eq(plays, [1, 4, 6, 8, 6, 6, 6, 7])) ok('plays per slot [1,4,6,8,6,6,6,7] == plan §1 (chains [0,0]/[0,3]/[0,5]/[0,7]/[0,5]/[0,5]/[0,5]/[0,6])');
  else fail(`plays [${plays}] != [1,4,6,8,6,6,6,7]`);
}

console.log('\n=== dropped-fidelity union (melodic imports) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);
console.log(`\n=== edge-tie instances (${edgeInstances.length}) ===`);
for (const e of edgeInstances) console.log(`  ${e}`);

writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/billiejean-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/billiejean-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
