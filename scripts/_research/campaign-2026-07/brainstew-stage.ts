/**
 * Brain Stew Phase-0 staging (mirror of redbone-stage.ts). READ-ONLY: no
 * device, no network. Run: npx tsx samples/_scratch/brainstew-stage.ts
 *
 * Builds the SIX per-project `arrangement` payloads (Pack 2 slots 33-38) from
 * the PINNED cache (samples/songsterr-cache/s8644, rev 7493187, fetched with
 * the pin enforced this session) via the EXACT import path
 * (importSongsterrMelodic / importSongsterrDrums, codec defaults), plus:
 *   - fuzz (p4 -> synth1) rows incl. the EDGE-TIE RULE for the m61 ring-out
 *   - drum (p6) rows as mini-notation with per-hit @vel (112 content / 40 ghost)
 *   - slot 33 = the silent count-in project (one all-rest 32-step pattern)
 * Asserts (all must pass): packing per plan SS1; SERVED-WINDOW IDENTITY
 * (m15-24 windows == m13-14; m27-28/m37-38/m39-40 == m25-26, per part);
 * melodic off_grid == 0 and chord_overflow == 0; every drum cell velocity in
 * {112, 40}; the two off-grid pickups placed (micro dropped, counted); tail
 * assertions per plan SS4 step 1. Emits samples/_scratch/brainstew-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrDrums,
  type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s8644';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const p4 = load(4);  // Fuzz Effect Bass -> synth1 (Hydrasynth ch1, stored 0)
const p6 = load(6);  // Tre Cool drums   -> midi2 external + condensed internal

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);

// ── project set (plan SS1) ───────────────────────────────────────────
interface Proj {
  slot: number; project_name: string;
  /** authored windows [from,to] inclusive-measure pairs */
  windows: Array<[number, number]>;
  expectSteps: number[];
  /** windows that must be import-identical to authored window 0 (served spans) */
  servedBy0: Array<[number, number]>;
}
const PROJECTS: Proj[] = [
  { slot: 34, project_name: 'BrainStew 2 Band',   windows: [[13, 14]], expectSteps: [32],
    servedBy0: [[15, 16], [17, 18], [19, 20], [21, 22], [23, 24]] },
  { slot: 35, project_name: 'BrainStew 3 Chorus', windows: [[25, 26]], expectSteps: [32],
    servedBy0: [[27, 28], [37, 38], [39, 40]] },
  { slot: 36, project_name: 'BrainStew 4 Verse3', windows: [[29, 30], [31, 32], [33, 34], [35, 36]],
    expectSteps: [32, 32, 32, 32], servedBy0: [] },
  { slot: 37, project_name: 'BrainStew 5 Verse4', windows: [[41, 42], [43, 44], [45, 46], [47, 48]],
    expectSteps: [32, 32, 32, 32], servedBy0: [] },
  { slot: 38, project_name: 'BrainStew 6 Outro',  windows: [[49, 50], [51, 52], [53, 54], [55, 56], [57, 58], [59, 60], [61, 62], [63, 63]],
    expectSteps: [32, 32, 32, 32, 32, 32, 32, 16], servedBy0: [] },
];

// ── token helpers (verbatim redbone-stage) ───────────────────────────
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
interface WinVoices { name: string; steps: number; voices: Record<string, string> }

const fidelityUnion = new Map<string, string>();
const edgeInstances: string[] = [];
let totOffGrid = 0; let totChordOverflow = 0;
let drumTok112 = 0; let drumTok40 = 0; let drumMicroDropped = 0; let drumTokTotal = 0;

function stageProject(pr: Proj): WinVoices[] {
  const steps = pr.windows.map(([f, t]) => (t - f + 1) * 16);
  if (JSON.stringify(steps) !== JSON.stringify(pr.expectSteps)) {
    fail(`slot ${pr.slot} packing [${steps}] != expected [${pr.expectSteps}]`);
  } else ok(`slot ${pr.slot} packing [${steps}]`);

  const wins: WinVoices[] = pr.windows.map(([f, t]) => ({
    name: `m${f}${t !== f ? '-' + t : ''}`, steps: (t - f + 1) * 16, voices: {},
  }));

  // fuzz -> synth1, edge-tie rule chronologically
  {
    let carry: Carry | undefined;
    const rows: string[][] = [];
    for (let wi = 0; wi < wins.length; wi++) {
      const [f, t] = pr.windows[wi]; const w = wins[wi];
      const imp = importSongsterrMelodic(p4, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t });
      if (imp.step_count !== w.steps) fail(`slot ${pr.slot} synth1 ${w.name} step_count ${imp.step_count} != ${w.steps}`);
      totOffGrid += imp.off_grid; totChordOverflow += imp.chord_overflow;
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.not_parsed)) fidelityUnion.set(`p4:${fld}`, `not_parsed (${(d as { count: number }).count})`);
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.parsed_not_authored)) fidelityUnion.set(`p4:${fld}`, `parsed_not_authored (${JSON.stringify(d)})`);
      const toks = tokensOf(imp.notation);
      if (toks.length !== w.steps) fail(`slot ${pr.slot} synth1 ${w.name} row has ${toks.length} tokens != ${w.steps}`);

      if (carry !== undefined) {
        let remain = carry.sixths; let at = 0;
        while (remain > 0) {
          if (at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (!isRest(toks[at])) { fail(`slot ${pr.slot} synth1 ${w.name} continuation collision at step ${at}: "${toks[at]}"`); remain = 0; break; }
          const toEdge = (w.steps - at) * SIX;
          const piece = Math.min(96, remain, toEdge);
          const cont = remain > piece;
          toks[at] = mkTok(carry.pitches, piece, carry.vel, cont);
          edgeInstances.push(`slot ${pr.slot} synth1 ${w.name} step ${at}: continuation ${carry.pitches}:${gateTok(piece)}${cont ? '_' : ''}`);
          remain -= piece; at += 16;
          if (remain > 0 && at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (remain === 0) carry = undefined;
        }
        if (remain === 0) carry = undefined;
      }

      for (const c of imp.cells) {
        const gs = c.gate_sixths ?? c.duration_steps * SIX;
        const endSixth = c.step * SIX + gs;
        if (endSixth <= w.steps * SIX) continue;
        const cellSteps = new Set(imp.cells.map((x) => x.step));
        let remaining = gs; let at = c.step;
        while (remaining > 96) {
          const next = at + 16;
          if (next >= w.steps || cellSteps.has(next)) break;
          remaining -= 96; at = next;
        }
        const finalTok = toks[at];
        if (isRest(finalTok) || pitchesOf(finalTok) !== c.token) {
          fail(`slot ${pr.slot} synth1 ${w.name} crosser at step ${c.step}: expected final piece of ${c.token} at ${at}, found "${finalTok}"`);
          continue;
        }
        const toEdge = (w.steps - at) * SIX;
        const carrySixths = endSixth - w.steps * SIX;
        if (wi === wins.length - 1) {
          toks[at] = mkTok(c.token, toEdge, c.velocity, false);
          edgeInstances.push(`slot ${pr.slot} synth1 ${w.name} step ${c.step}: clip @${at} to ${gateTok(toEdge)} UNTIED (project boundary, carry dropped)`);
        } else {
          toks[at] = mkTok(c.token, toEdge, c.velocity, true);
          edgeInstances.push(`slot ${pr.slot} synth1 ${w.name} step ${c.step} (${c.token}, ${gs / SIX} steps): clip final piece @${at} to ${gateTok(toEdge)}_ , carry ${carrySixths / SIX} step(s)`);
          if (carry !== undefined && carry.pitches !== c.token) fail(`slot ${pr.slot} synth1 ${w.name}: two carries cross one edge`);
          else carry = { pitches: c.token, sixths: carrySixths, ...(c.velocity !== undefined ? { vel: c.velocity } : {}) };
        }
      }
      rows.push(toks);
    }
    if (carry !== undefined) fail(`slot ${pr.slot} synth1: carry left past the last window`);
    for (let wi = 0; wi < wins.length; wi++) {
      if (rows[wi].some((t) => !isRest(t))) wins[wi].voices.synth1 = rows[wi].join(' ');
    }
  }

  // drums: mini-notation with per-hit @vel; velocities MUST be 112 or 40
  for (let wi = 0; wi < wins.length; wi++) {
    const [f, t] = pr.windows[wi]; const w = wins[wi];
    const dr = importSongsterrDrums(p6, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t });
    if (dr.steps !== w.steps) fail(`slot ${pr.slot} drums ${w.name} steps ${dr.steps} != ${w.steps}`);
    for (const [dvoice, dsteps] of Object.entries(dr.voices)) {
      const toks: string[] = [];
      let any = false;
      dsteps.forEach((s, i) => {
        if (!s.on) { toks.push('~'); return; }
        any = true; drumTokTotal++;
        if (s.roll !== undefined) fail(`slot ${pr.slot} drums ${w.name} ${dvoice} step ${i}: unexpected roll`);
        if (s.micro !== undefined && JSON.stringify(s.micro) !== '[0]') {
          drumMicroDropped++;
          info(`slot ${pr.slot} drums ${w.name} ${dvoice} step ${i}: off-grid micro [${s.micro}] DROPPED (mini-notation has no micro syntax; named plan loss)`);
        }
        if (s.velocity === 112) { toks.push(`${dvoice}@112`); drumTok112++; }
        else if (s.velocity === 40) { toks.push(`${dvoice}@40`); drumTok40++; }
        else fail(`slot ${pr.slot} drums ${w.name} ${dvoice} step ${i}: velocity ${s.velocity} not in {112, 40}`);
      });
      if (any) wins[wi].voices[dvoice] = toks.join(' ');
    }
  }
  return wins;
}

// ── served-window identity (the merge proof, per part) ───────────────
function assertServed(pr: Proj): void {
  if (pr.servedBy0.length === 0) return;
  const [f0, t0] = pr.windows[0];
  const ref = {
    drums: JSON.stringify(importSongsterrDrums(p6, { stepsPerBeat: 4, fromMeasure: f0, toMeasure: t0 }).voices),
    fuzz: importSongsterrMelodic(p4, { stepsPerBeat: 4, fromMeasure: f0, toMeasure: t0 }).notation,
  };
  let all = true;
  for (const [f, t] of pr.servedBy0) {
    const d = JSON.stringify(importSongsterrDrums(p6, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t }).voices);
    const m = importSongsterrMelodic(p4, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t }).notation;
    if (d !== ref.drums) { all = false; fail(`slot ${pr.slot}: m${f}-${t} drums != authored cell m${f0}-${t0}`); }
    if (m !== ref.fuzz) { all = false; fail(`slot ${pr.slot}: m${f}-${t} fuzz != authored cell`); }
  }
  if (all) ok(`slot ${pr.slot}: all ${pr.servedBy0.length} served window(s) import-identical to the authored cell (per part)`);
}

// ── stage all + dedupe into sections/order ───────────────────────────
interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface Staged { slot: number; project_name: string; order: string[]; sections: StagedSection[] }
const staged: Staged[] = [];

// slot 33: the silent count-in project (plan SS2d) — one all-rest 32-step pattern
staged.push({
  slot: 33, project_name: 'BrainStew 1 Solo',
  order: ['silent'],
  sections: [{ name: 'silent', steps: 32, voices: { kick: Array(32).fill('~').join(' ') } }],
});
console.log('=== slot 33 "BrainStew 1 Solo" (silent count-in, Deviation A) ===');
ok('slot 33 staged: 1 all-rest 32-step pattern, loops (no route, no binding)');

for (const pr of PROJECTS) {
  console.log(`\n=== slot ${pr.slot} "${pr.project_name}" ===`);
  const wins = stageProject(pr);
  assertServed(pr);
  const sections: StagedSection[] = [];
  const secName = new Map<string, string>();
  const order: string[] = [];
  for (const w of wins) {
    const key = JSON.stringify({ steps: w.steps, voices: w.voices });
    if (!secName.has(key)) {
      secName.set(key, w.name);
      const voices = Object.keys(w.voices).length > 0 ? w.voices
        : { kick: Array(w.steps).fill('~').join(' ') };
      sections.push({ name: w.name, steps: w.steps, voices });
    }
    order.push(secName.get(key)!);
  }
  info(`sections=${sections.length} order=[${order.join(' ')}]`);
  staged.push({ slot: pr.slot, project_name: pr.project_name, order, sections });
}

// ── global assertions ────────────────────────────────────────────────
console.log('\n=== global assertions ===');
if (totOffGrid === 0) ok('melodic off_grid == 0'); else fail(`melodic off_grid == ${totOffGrid}`);
if (totChordOverflow === 0) ok('chord_overflow == 0 (fuzz is mono)'); else fail(`chord_overflow == ${totChordOverflow}`);

// fuzz appears ONLY in the outro
{
  const bandFuzz = importSongsterrMelodic(p4, { stepsPerBeat: 4, fromMeasure: 13, toMeasure: 14 }).notation;
  if (tokensOf(bandFuzz).every(isRest)) ok('fuzz silent outside the outro (m13-14 spot check all-rest)');
  else fail('fuzz has content at m13-14?!');
  const outroStaged = staged.find((s) => s.slot === 38)!;
  const withFuzz = outroStaged.sections.filter((s) => s.voices.synth1 !== undefined).length;
  info(`outro sections carrying synth1: ${withFuzz} of ${outroStaged.sections.length}`);
}

// drum census reconciliation vs track-wide flatten (plan SS0d: 783 x v112, 17 ghosts)
{
  const f = flattenSongsterrDrums(p6);
  const v112 = f.events.filter((e) => e.velocity === 112).length;
  const gh = f.events.filter((e) => e.velocity === undefined && e.ghost === true).length;
  info(`flatten: ${f.events.length} events, ${v112} @112, ${gh} ghosts`);
  info(`staged tokens: ${drumTokTotal} total, ${drumTok112} @112, ${drumTok40} @40, micro dropped ${drumMicroDropped}`);
  if (v112 !== 783 || gh !== 17) fail(`flatten census moved: ${v112}/783 @112, ${gh}/17 ghosts`);
  else ok('flatten census == plan SS0d (783 @112, 17 ghosts)');
  const folded = f.events.length - drumTokTotal;
  info(`same-step folds (unison doubles + ghost/pickup unions): ${folded} events folded into cells`);
  if (drumTok112 + drumTok40 !== drumTokTotal) fail('token velocity census does not sum');
}

// ── tail assertions (plan SS4 step 1) ────────────────────────────────
console.log('\n=== tail assertions ===');
const bySlot = new Map(staged.map((s) => [s.slot, s]));
const secOf = (slot: number, name: string): StagedSection => bySlot.get(slot)!.sections.find((x) => x.name === name)!;
const lastSec = (slot: number): StagedSection => { const s = bySlot.get(slot)!; return secOf(slot, s.order[s.order.length - 1]); };
const tokAt = (sec: StagedSection, voice: string, step: number): string =>
  sec.voices[voice] === undefined ? '~' : tokensOf(sec.voices[voice])[step] ?? '~';

// slot 36 tail = m35-36, distinct from every other Verse3 window (the G closer)
{
  const s = bySlot.get(36)!;
  if (s.order.length === 4 && s.order[3] === 'm35-36' && new Set(s.order).size === 4)
    ok('slot 36: 4 distinct patterns, tail = m35-36 (fill F + closer G stored)');
  else fail(`slot 36 order [${s.order.join(' ')}] != 4 distinct ending m35-36`);
}
// slot 37: pattern 2 == pattern 3 (A B cell twice), tail = m47-48 (closer H)
{
  const s = bySlot.get(37)!;
  if (s.order.length === 4 && s.order[1] === s.order[2] && s.order[3] === 'm47-48' && s.order[0] === 'm41-42')
    ok(`slot 37: order [${s.order.join(' ')}] (middle windows identical), tail = m47-48 (closer H)`);
  else fail(`slot 37 order [${s.order.join(' ')}] unexpected`);
}
// slot 38 pattern 8 = m63, 16 steps: crash+kick at step 0 (double-crash folded), fuzz g#2:16 continuation
{
  const t = lastSec(38);
  if (t.name === 'm63' && t.steps === 16) ok('slot 38 tail = m63 @ 16 steps'); else fail(`slot 38 tail = ${t.name} @ ${t.steps}`);
  const ck = tokAt(t, 'crash', 0); const kk = tokAt(t, 'kick', 0);
  if (ck === 'crash@112' && kk === 'kick@112') ok('slot 38 m63: crash@112 + kick@112 at step 0 (ring-out bar)');
  else fail(`slot 38 m63 step 0: crash "${ck}", kick "${kk}"`);
  const fz = tokAt(t, 'synth1', 0);
  if (fz === 'g#2:16@90') ok('slot 38 m63: fuzz continuation g#2:16@90 at step 0 (ring-out ends at song end)');
  else fail(`slot 38 m63 synth1 step 0 = "${fz}" != "g#2:16@90"`);
}
// slot 38 pattern 7 (m61-62): the ring-out tied chain start
{
  const s = bySlot.get(38)!;
  const p7 = secOf(38, s.order[6]);
  if (s.order[6] !== 'm61-62') fail(`slot 38 pattern 7 = ${s.order[6]} != m61-62`);
  const t1 = tokAt(p7, 'synth1', 1); const t17 = tokAt(p7, 'synth1', 17);
  const tiedChain = t1.startsWith('g#2:') && t1.endsWith('_') && t17.startsWith('g#2:') && t17.endsWith('_');
  if (tiedChain) ok(`slot 38 m61-62: ring-out tied chain (${t1} @1, ${t17} @17, continues into m63)`);
  else fail(`slot 38 m61-62 synth1: "${t1}" @1, "${t17}" @17 - not the expected tied chain`);
}
// slots 34/35: single 32-step pattern with both bars of the cell present
for (const [slot, label] of [[34, 'groove (A B)'], [35, 'chorus (C D)']] as const) {
  const s = bySlot.get(slot)!;
  if (s.order.length !== 1 || s.sections.length !== 1 || s.sections[0].steps !== 32) { fail(`slot ${slot} not a single 32-step cell`); continue; }
  const sec = s.sections[0];
  const drumVoices = Object.keys(sec.voices).filter((v) => v !== 'synth1');
  const firstHalf = drumVoices.some((v) => tokensOf(sec.voices[v]).slice(0, 16).some((t) => !isRest(t)));
  const secondHalf = drumVoices.some((v) => tokensOf(sec.voices[v]).slice(16).some((t) => !isRest(t)));
  if (firstHalf && secondHalf) ok(`slot ${slot}: ${label} cell has content in BOTH bars`);
  else fail(`slot ${slot}: cell missing a bar (first ${firstHalf}, second ${secondHalf})`);
}

// ── edge-tie instances + fidelity union ──────────────────────────────
console.log(`\n=== edge-tie rule instances (${edgeInstances.length}) ===`);
for (const e of edgeInstances) console.log(`  ${e}`);
console.log('\n=== dropped-fidelity union (melodic imports) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);

writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/brainstew-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/brainstew-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
