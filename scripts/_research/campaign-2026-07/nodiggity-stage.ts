/**
 * No Diggity Phase-0 staging (plan §4 step 2; mirror of smooth-stage.ts /
 * lovesong-stage.ts machinery + the hand-authored §H hook compiled inline).
 * READ-ONLY: no device, no network. Run: npx tsx samples/_scratch/nodiggity-stage.ts
 *
 * Builds the FOUR per-project `arrangement` payloads (Pack 4 slots 33-36)
 * from the PINNED cache (samples/songsterr-cache/s287014, rev 3656036):
 *   - synth1 = the §H rows VERBATIM (main riff on P1/P2, drop variant on P3,
 *     ABSENT on P4). The rows are the source of record (Havana/Smooth-§H
 *     discipline); the voice is the Hydrasynth ch1 (stored level 0).
 *   - t2 drums -> midi2 external + condensed internal, via the EXACT import
 *     path (importSongsterrDrums) per 2-bar window.
 *   - synth2 / midi1: EMPTY (fork Q1/Q2 defaults taken).
 * Asserts (plan §4 Phase 0 step 2), all must pass:
 *   - §H rows reproduced TOKEN-EXACT in P1/P2/P3 payloads and ABSENT in P4;
 *   - §H CONTOUR CROSS-CHECK: every §H row == the tab's own bass (s287014 t1
 *     m1-4 main / m41-44 drop) transposed -1, cell-exact via the exact import
 *     path (pitch+gate+vel), and m29-32 == m1-4 so P2's identical rows stand;
 *     bass SILENT m89-96 (P4 carries no hook, matching the record);
 *   - drum content per the §0b letter grids for m1-4 [A] / m29-32 [B] /
 *     m41-44 [. . . D] (incl. the three all-rest bars + the step-11/12/13
 *     fill) / m89-92 [H];
 *   - velocity multiset all-100 (the source is dynamics-blank, §0a);
 *   - external note set {48,50,54} after +12 (the tab's whole kit);
 *   - packing 2 x 32 uniform x4;
 *   - the §0g wrap table (continuation-bar signature check, the Schism §5
 *     rule: P1 m5==m1; P2 m33 root-position==m29 + drums stay [B]; P3 m45
 *     drums==[A] re-entry + bass m45==m1; P4 m93 drums==[A] re-entry).
 * Emits samples/_scratch/nodiggity-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrDrums, flattenSongsterrMelodic,
  pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s287014';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const bass = load(1);  // t1 Electric Bass (finger) — the riff's contour source (§0c)
const drums = load(2); // t2 Drums — kick/hat/snare only (§0b)

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── A. source census gates (§0a/§0b — source drift detection) ─────────
console.log('=== A. source census gates ===');
const fDrums = flattenSongsterrDrums(drums);
const fBass = flattenSongsterrMelodic(bass);
const measures = fDrums.measures;
if (measures.length === 133 && measures.every((m) => m.signature[0] === 4 && m.signature[1] === 4))
  ok('133 measures, all 4/4');
else fail(`measures ${measures.length}, signature drift`);
if (fDrums.events.length === 1598 && fDrums.ghosts === 0 && fDrums.accents === 0 && fDrums.unmapped === 0)
  ok('drums t2: 1598 events, 0 ghosts / accents / unmapped');
else fail(`drum census ${fDrums.events.length}/${fDrums.ghosts}/${fDrums.accents}/${fDrums.unmapped}`);
{
  const kv = new Map<string, number>();
  for (const e of fDrums.events) kv.set(e.voice, (kv.get(e.voice) ?? 0) + 1);
  if (eq(Object.fromEntries([...kv.entries()].sort()), { hat: 998, kick: 492, snare: 108 }))
    ok('kit voices: kick 492 / hat 998 / snare 108 — three voices, nothing else (§0b)');
  else fail(`kit voice census ${JSON.stringify([...kv])}`);
  if (fDrums.events.every((e) => e.velocity === undefined && e.ghost !== true))
    ok('drums dynamics-blank: every event default-velocity (stores at 100, §0a)');
  else fail('drum events carry velocities/ghosts — source drifted');
}
if (fBass.notes.length === 1127) ok('bass t1: 1127 notes (§0a)');
else fail(`bass notes ${fBass.notes.length} != 1127`);

// ── B. the §H rows, VERBATIM from the plan (the source of record) ─────
const H_MAIN_BAR1 = 'f#2:2@100 ~ ~ c#2:1@100 a1:1@100 c#3:1@100 a2:1@100 ~ f#2:2@100 ~ ~ c#2:1@100 a1:1@100 c#3:1@100 a2:1@100 ~';
const H_MAIN_BAR2 = 'd2:2@100 ~ ~ c#2:1@100 a1:1@100 a2:1@100 f#2:1@100 ~ d2:2@100 ~ ~ c#2:1@100 a1:1@100 a2:1@100 f#2:1@100 ~';
const H_MAIN_BAR3 = 'e2:2@100 ~ ~ c#2:1@100 b1:1@100 b2:1@100 g#2:1@100 ~ e2:2@100 ~ ~ c#2:1@100 b1:1@100 b2:1@100 e2:1@100 ~';
// bar4 = bar1
const H_DROP_BAR1 = 'f#2:3@100 ~ ~ c#2:1@100 a1:1@100 c#2:1@100 a2:2@100 ~ f#2:3@100 ~ ~ c#2:1@100 a1:1@100 c#2:1@100 a2:2@100 ~';
const H_DROP_BAR2 = 'd2:3@100 ~ ~ c#2:1@100 a1:1@100 a2:1@100 f#2:2@100 ~ d2:3@100 ~ ~ c#2:1@100 a1:1@100 a2:1@100 f#2:2@100 ~';
const H_DROP_BAR3 = 'e2:3@100 ~ ~ b1:1@100 b1:1@100 b2:1@100 g#2:2@100 ~ e2:3@100 ~ ~ b1:1@100 b1:1@100 b2:1@100 e2:2@100 ~';
// bar4 = bar1
const H_MAIN_P1 = `${H_MAIN_BAR1} ${H_MAIN_BAR2}`;  // pattern 1 = bars 1-2
const H_MAIN_P2 = `${H_MAIN_BAR3} ${H_MAIN_BAR1}`;  // pattern 2 = bars 3-4 (bar4 = bar1)
const H_DROP_P1 = `${H_DROP_BAR1} ${H_DROP_BAR2}`;
const H_DROP_P2 = `${H_DROP_BAR3} ${H_DROP_BAR1}`;

console.log('\n=== B. §H rows: parse + shape ===');
const tokensOf = (row: string): string[] => row.trim().split(/\s+/);
for (const [nm, row] of [['main p1', H_MAIN_P1], ['main p2', H_MAIN_P2], ['drop p1', H_DROP_P1], ['drop p2', H_DROP_P2]] as const) {
  const toks = tokensOf(row);
  if (toks.length !== 32) fail(`§H ${nm}: ${toks.length} tokens != 32`);
  try {
    const parsed = parseVoice(row, 32);
    if (parsed.length !== 32) fail(`§H ${nm}: parseVoice length ${parsed.length}`);
  } catch (e) { fail(`§H ${nm}: parseVoice threw: ${(e as Error).message}`); }
}
ok('all 4 §H pattern rows: 32 tokens each, parseVoice-clean');
{
  const floor = tokensOf(H_MAIN_P1).some((t) => t.startsWith('a1:'));
  const peak = tokensOf(H_MAIN_P1).some((t) => t.startsWith('c#3:'));
  if (floor && peak) ok('§H register: floor a1, peak c#3 present (the LOW piano, no octave shift)');
  else fail('§H register drifted (a1 floor / c#3 peak missing)');
}

// ── C. §H contour cross-check vs the tab transposed -1 (§0c/§0e) ──────
console.log('\n=== C. §H rows == tab bass transposed -1 (cell-exact, exact import path) ===');
interface Cell { notes: number[]; gate: number; vel: number; tie: boolean }
const cellsOf = (row: string, steps: number): (Cell | undefined)[] =>
  (parseVoice(row, steps) as Array<{ on?: boolean; notes?: number | number[]; gate_sixths?: number; velocity?: number; tie?: boolean }>)
    .map((s) => s.on !== true ? undefined : {
      notes: (Array.isArray(s.notes) ? [...s.notes] : [s.notes!]).sort((a, b) => a - b),
      gate: s.gate_sixths ?? 6, vel: s.velocity ?? 100, tie: s.tie === true,
    });
const importCells = (from: number, to: number): (Cell | undefined)[] => {
  const imp = importSongsterrMelodic(bass, { stepsPerBeat: 4, fromMeasure: from, toMeasure: to, transpose: -1 });
  if (imp.step_count !== (to - from + 1) * 16) fail(`bass m${from}-${to}: step_count ${imp.step_count}`);
  if (imp.off_grid !== 0) fail(`bass m${from}-${to}: off_grid ${imp.off_grid} != 0`);
  if (imp.chord_overflow !== 0) fail(`bass m${from}-${to}: chord_overflow ${imp.chord_overflow}`);
  return cellsOf(imp.notation, imp.step_count);
};
const cellCmp = (label: string, want: (Cell | undefined)[], got: (Cell | undefined)[]): void => {
  let bad = 0;
  for (let s = 0; s < Math.max(want.length, got.length); s++) {
    if (!eq(want[s], got[s])) { bad++; if (bad <= 3) fail(`${label} step ${s}: §H ${JSON.stringify(want[s])} != tab ${JSON.stringify(got[s])}`); }
  }
  if (bad === 0) ok(`${label}: cell-exact (pitch+gate+vel, ${want.filter(Boolean).length} onsets)`);
  else fail(`${label}: ${bad} cell mismatches`);
};
cellCmp('§H main p1 vs tab m1-2 (-1)', cellsOf(H_MAIN_P1, 32), importCells(1, 2));
cellCmp('§H main p2 vs tab m3-4 (-1)', cellsOf(H_MAIN_P2, 32), importCells(3, 4));
cellCmp('§H drop p1 vs tab m41-42 (-1)', cellsOf(H_DROP_P1, 32), importCells(41, 42));
cellCmp('§H drop p2 vs tab m43-44 (-1)', cellsOf(H_DROP_P2, 32), importCells(43, 44));
cellCmp('tab m29-30 == m1-2 (P2 rides identical rows)', importCells(1, 2), importCells(29, 30));
cellCmp('tab m31-32 == m3-4 (P2 rides identical rows)', importCells(3, 4), importCells(31, 32));
{
  const p4win = importCells(89, 92).filter(Boolean).length + importCells(93, 96).filter(Boolean).length;
  if (importCells(89, 92).filter(Boolean).length === 0) ok('bass SILENT m89-92: P4 carries no hook (matches the record\'s piano-out chant)');
  else fail(`bass m89-92 has onsets`);
  if (p4win === 0) ok('bass silent through m89-96 (the whole chant section)');
  else info(`bass m93-96 carries ${p4win} onsets (outside P4\'s window)`);
}

// ── D. drum windows via the exact import path (§0b letter grids) ──────
console.log('\n=== D. drum windows (§0b letter grids) ===');
const velOfStep = (s: { velocity?: number; accent?: boolean }): number =>
  s.velocity ?? (s.accent === true ? 120 : 100);
interface DrumWin { steps: number; rows: Record<string, (number | undefined)[]> }
const velMultiset = new Map<number, number>();
function importDrumWindow(from: number, to: number): DrumWin {
  const imp = importSongsterrDrums(drums, { stepsPerBeat: 4, fromMeasure: from, toMeasure: to });
  const steps = imp.steps;
  const rows: Record<string, (number | undefined)[]> = {};
  for (const [voice, row] of Object.entries(imp.voices)) {
    const dst = Array.from({ length: steps }, () => undefined as number | undefined);
    row.forEach((s, i) => {
      if (s?.on !== true) return;
      if ((s as { roll?: number }).roll !== undefined) fail(`m${from}-${to} ${voice}@${i}: unexpected roll`);
      const micro = (s as { micro?: number[] }).micro;
      if (micro !== undefined && !eq(micro, [0])) fail(`m${from}-${to} ${voice}@${i}: unexpected micro ${JSON.stringify(micro)}`);
      dst[i] = velOfStep(s);
      velMultiset.set(dst[i]!, (velMultiset.get(dst[i]!) ?? 0) + 1);
    });
    if (dst.some((x) => x !== undefined)) rows[voice] = dst;
  }
  return { steps, rows };
}
// §0b bar cells (16-step onset sets per voice)
const BAR: Record<string, Record<string, number[]>> = {
  A: { kick: [0, 5, 8, 13], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  B: { kick: [0, 5, 8, 13], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  H: { kick: [0, 4, 5, 8, 12, 13] },
  D: { kick: [11, 13], snare: [12] },
  '.': {},
};
const barsExpected = (letters: string[]): Record<string, number[]> => {
  const out: Record<string, number[]> = {};
  letters.forEach((L, bi) => {
    for (const [v, ons] of Object.entries(BAR[L])) {
      (out[v] ?? (out[v] = [])).push(...ons.map((s) => s + bi * 16));
    }
  });
  for (const v of Object.keys(out)) out[v].sort((a, b) => a - b);
  return out;
};
const checkDrumWin = (label: string, w: DrumWin, letters: string[]): void => {
  const want = barsExpected(letters);
  const got: Record<string, number[]> = {};
  for (const [v, row] of Object.entries(w.rows)) got[v] = row.flatMap((x, i) => (x === undefined ? [] : [i]));
  if (eq(Object.fromEntries(Object.entries(got).sort()), Object.fromEntries(Object.entries(want).sort())))
    ok(`${label}: grid == [${letters.join(' ')}] (§0b exact)`);
  else fail(`${label}: got ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
};

// ── E. project set (plan §1: Pack 4 slots 33-36) ─────────────────────
interface Proj {
  slot: number; project_name: string;
  wins: Array<{ name: string; from: number; to: number; letters: string[]; hook?: string }>;
}
const PROJECTS: Proj[] = [
  {
    slot: 33, project_name: 'NoDiggity 1 Groove',
    wins: [
      { name: 'm1-2', from: 1, to: 2, letters: ['A', 'A'], hook: H_MAIN_P1 },
      { name: 'm3-4', from: 3, to: 4, letters: ['A', 'A'], hook: H_MAIN_P2 },
    ],
  },
  {
    slot: 34, project_name: 'NoDiggity 2 Hook',
    wins: [
      { name: 'm29-30', from: 29, to: 30, letters: ['B', 'B'], hook: H_MAIN_P1 },
      { name: 'm31-32', from: 31, to: 32, letters: ['B', 'B'], hook: H_MAIN_P2 },
    ],
  },
  {
    slot: 35, project_name: 'NoDiggity 3 Drop',
    wins: [
      { name: 'm41-42', from: 41, to: 42, letters: ['.', '.'], hook: H_DROP_P1 },
      { name: 'm43-44', from: 43, to: 44, letters: ['.', 'D'], hook: H_DROP_P2 },
    ],
  },
  {
    slot: 36, project_name: 'NoDiggity 4 HeyYo',
    wins: [
      { name: 'm89-90', from: 89, to: 90, letters: ['H', 'H'] },
      { name: 'm91-92', from: 91, to: 92, letters: ['H', 'H'] },
    ],
  },
];
for (const pr of PROJECTS) if (pr.project_name.length > 32) fail(`slot ${pr.slot} name > 32 chars`);

console.log('\n=== E. build + per-window asserts ===');
interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface Staged { slot: number; project_name: string; order: string[]; sections: StagedSection[] }
const staged: Staged[] = [];
for (const pr of PROJECTS) {
  console.log(`-- slot ${pr.slot} "${pr.project_name}" --`);
  const secs: StagedSection[] = [];
  for (const w of pr.wins) {
    const dw = importDrumWindow(w.from, w.to);
    if (dw.steps !== 32) fail(`slot ${pr.slot} ${w.name}: steps ${dw.steps} != 32`);
    checkDrumWin(`slot ${pr.slot} ${w.name}`, dw, w.letters);
    const voices: Record<string, string> = {};
    if (w.hook !== undefined) voices.synth1 = w.hook;
    for (const [v, row] of Object.entries(dw.rows)) {
      voices[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
    }
    secs.push({ name: w.name, steps: 32, voices });
  }
  // packing: 2 x 32 uniform
  if (secs.length === 2 && secs.every((s) => s.steps === 32)) ok('packing [32, 32]');
  else fail(`slot ${pr.slot} packing drifted`);
  // dedupe identical sections (smooth/lovesong shape: order repeats the name)
  const byContent = new Map<string, string>();
  const order: string[] = [];
  const kept: StagedSection[] = [];
  for (const s of secs) {
    const key = JSON.stringify({ steps: s.steps, voices: s.voices });
    if (!byContent.has(key)) { byContent.set(key, s.name); kept.push(s); }
    order.push(byContent.get(key)!);
  }
  info(`${order.length} plays [${order.join(' ')}], ${kept.length} stored section(s)`);
  staged.push({ slot: pr.slot, project_name: pr.project_name, order, sections: kept });
}

// ── F. global assertions ─────────────────────────────────────────────
console.log('\n=== F. global assertions ===');
{
  // §H rows token-exact in P1/P2/P3, ABSENT in P4
  const bySlot = new Map(staged.map((s) => [s.slot, s]));
  const hookRows = (slot: number): string[] => {
    const st = bySlot.get(slot)!;
    const secOf = new Map(st.sections.map((s) => [s.name, s]));
    return st.order.map((nm) => secOf.get(nm)!.voices.synth1).filter((x): x is string => x !== undefined);
  };
  if (eq(hookRows(33), [H_MAIN_P1, H_MAIN_P2]) && eq(hookRows(34), [H_MAIN_P1, H_MAIN_P2]))
    ok('§H MAIN rows TOKEN-EXACT in P1 (slot 33) and P2 (slot 34), patterns [1-2, 3-4]');
  else fail('§H main rows drifted in P1/P2 payloads');
  if (eq(hookRows(35), [H_DROP_P1, H_DROP_P2]))
    ok('§H DROP rows TOKEN-EXACT in P3 (slot 35)');
  else fail('§H drop rows drifted in P3 payload');
  if (hookRows(36).length === 0 && bySlot.get(36)!.sections.every((s) => s.voices.synth1 === undefined
    && s.voices.synth2 === undefined && s.voices.midi1 === undefined))
    ok('P4 (slot 36): NO hook, no synth2/midi1 — kick-only chant bed');
  else fail('P4 carries melodic voices');
  // synth2/midi1 empty everywhere (fork Q1/Q2 defaults)
  if (staged.every((st) => st.sections.every((s) => s.voices.synth2 === undefined && s.voices.midi1 === undefined)))
    ok('synth2 + midi1 EMPTY on all 4 (fork defaults taken)');
  else fail('unexpected synth2/midi1 content');
}
{
  // velocity multiset all-100
  const ms = [...velMultiset.entries()].sort((a, b) => b[1] - a[1]);
  if (ms.length === 1 && ms[0][0] === 100) ok(`drum velocity multiset: 100 x${ms[0][1]} (all-100, §0a)`);
  else fail(`velocity multiset ${ms.map(([v, n]) => `${v}x${n}`).join(' ')}`);
}
{
  // external note set after +12
  const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54 };
  const seen = new Set<string>();
  for (const st of staged) for (const s of st.sections)
    for (const v of Object.keys(s.voices)) if (v !== 'synth1') seen.add(v);
  const notes = [...seen].map((v) => GM12[v]).sort((a, b) => a - b);
  if (eq([...seen].sort(), ['hat', 'kick', 'snare']) && eq(notes, [48, 50, 54]))
    ok('external note set after +12: {48, 50, 54} = kick/snare/hat, nothing else (§2d)');
  else fail(`folded voice set [${[...seen].sort()}] -> notes [${notes}]`);
}
{
  // the m44 fill placement inside the staged P3 payload (steps 27/28/29 of pattern 2)
  const st = staged.find((s) => s.slot === 35)!;
  const sec2 = st.sections.find((s) => s.name === 'm43-44')!;
  const kickOns = (sec2.voices.kick ?? '').split(/\s+/).flatMap((t, i) => (t === '~' ? [] : [i]));
  const snareOns = (sec2.voices.snare ?? '').split(/\s+/).flatMap((t, i) => (t === '~' ? [] : [i]));
  if (eq(kickOns, [27, 29]) && eq(snareOns, [28]) && sec2.voices.hat === undefined)
    ok('P3 fill: k-s-k at pattern-2 steps 27/28/29 (m44 steps 11/12/13), no hat — the throw-back-in');
  else fail(`P3 fill drifted: kick [${kickOns}] snare [${snareOns}] hat ${sec2.voices.hat !== undefined}`);
  const sec1 = st.sections.find((s) => s.name === 'm41-42')!;
  if (eq(Object.keys(sec1.voices), ['synth1']))
    ok('P3 pattern 1 (m41-42): riff walks ALONE (drums all-rest, stored as rests)');
  else fail(`P3 pattern 1 voices [${Object.keys(sec1.voices)}]`);
}

// ── G. §0g wrap table (the Schism §5 rule) ───────────────────────────
console.log('\n=== G. §0g wrap / continuation audit ===');
{
  // P1: m5 == m1 (bass + drums identical) — wrap plays the song's own continuation
  cellCmp('P1 wrap: tab m5-6 == m1-2', importCells(1, 2), importCells(5, 6));
  const d1 = importDrumWindow(1, 1); const d5 = importDrumWindow(5, 5);
  if (eq(d1.rows, d5.rows)) ok('P1 wrap: drum m5 == m1 [A] (continuation identical)');
  else fail('P1 wrap: drum m5 != m1');
  // P2: m33 = cycle head variant — root position identical to m29 (g2 @ step 0), drums stay [B]
  const c29 = importCells(29, 29); const c33 = importCells(33, 33);
  const root29 = c29[0]; const root33 = c33[0];
  if (root29 !== undefined && root33 !== undefined && eq(root29.notes, root33.notes))
    ok(`P2 continuation: m33 root == m29 root at step 0 (${JSON.stringify(root33.notes)}) — cycle-aligned; inner motion is the named variant`);
  else fail(`P2 continuation: m33 root ${JSON.stringify(root33)} != m29 ${JSON.stringify(root29)}`);
  const d33 = importDrumWindow(33, 33);
  checkDrumWin('P2 continuation: drum m33', d33, ['B']);
  // P3: stomp path = the song exactly — m45 re-enters groove [A]; bass m45 == m1
  checkDrumWin('P3 continuation: drum m45 == [A] re-entry', importDrumWindow(45, 45), ['A']);
  cellCmp('P3 continuation: bass m45 == m1 (cycle head)', importCells(1, 1), importCells(45, 45));
  // P4: m93 re-enters groove [A]
  checkDrumWin('P4 continuation: drum m93 == [A] re-entry', importDrumWindow(93, 93), ['A']);
}

// ── emit ─────────────────────────────────────────────────────────────
writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/nodiggity-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/nodiggity-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
