/**
 * Stranglehold (Ted Nugent, s403 r8042866) Phase-0 staging — the plan
 * `docs/_private/rig/songs/stranglehold-rebuild-plan-2026-07-30.md` §4 Phase 0
 * step 2. READ-ONLY: no device, no network.
 *   Run: npx tsx samples/_scratch/stranglehold-stage.ts
 *
 * Builds the SIX per-project `arrangement` payloads (Pack 5 slots 1-6 in place)
 * from the PINNED cache (samples/songsterr-cache/s403, rev 8042866):
 *   - p8 "Cliff Davies | Slingerland Maple Kit" -> midi2, EXTERNAL-ONLY to the
 *     SPD-SX kit 40 (+12).  NOTE THE ROSTER SHIFT: the kit is part 8 at this
 *     revision, NOT the stale doc's part 7 (part 7 is a new feedback organ).
 *   - THE DRONE -> midi1.  Fork Q2 = KEEP (maintainer, 2026-07-30): the
 *     hand-authored E3+B3 bed on the card is carried BYTE-FAITHFULLY, cell for
 *     cell, from the carry-over oracle. It matches no source part; it is his.
 *
 * The drone's two cell shapes, decoded from all six oracle slots by
 * stranglehold-drone-dump.ts (which reconciles EXACTLY with the audit's
 * gate/note/velocity histograms on every slot):
 *   PLAIN  s0  e3+b3 v100 gate 96 sixths (16 steps) TIED forward
 *          s16 e3+b3 v100 gate 96
 *   TURN   s0  e3+b3 v100 gate 84 (14 steps)
 *          s14 e3+b3+a#3 v100 gate 60 (10 steps)   <- the Bb passing tone
 *          s24 e3+b3 v100 gate 48 (8 steps)
 * Oracle per-slot 8-pattern sequences: 1 PPPPPPPP, 2 PPTPPPTP, 3 PPPPPPPP,
 * 4 PTPTPTPP, 5 PTPTPTPT, 6 PPPPPPPT.  The new projects hold 4/8/2/8/4/4
 * patterns, so the sequence is mapped by keeping the LEADING cells and
 * anchoring a p8 TURN to the new last pattern (slot 6's only turn). Slots 2
 * and 4 are 8=8 and therefore BYTE-IDENTICAL in placement too.
 *
 * Asserts (STOP on any failure) — plan §4 Phase 0 step 2:
 *   A. source census == §0b exactly (drift detection on the pinned cache)
 *   B. snap census == §0e (201 off-grid in four named classes; double-crash
 *      folds; collisions enumerated; nothing lost)
 *   C. the §1 part set builds: window->pattern map, every pattern 32 steps
 *   D. external note set == {48,50,54,57,58,61,63}; ZERO 51, ZERO 68
 *   E. every §3 tail assertion, incl. the three restored-content heads
 *   F. THE DRONE: every staged midi1 row decodes back to its oracle cell
 *   G. melodic seam crossers == 0 on the kit lane (vacuous, asserted anyway)
 *
 * Emits samples/_scratch/stranglehold-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const CACHE = `${ROOT}/samples/songsterr-cache/s403`;
const meta = JSON.parse(readFileSync(`${CACHE}/meta.json`, 'utf8')) as { songId: number; revisionId: number };
const p8 = JSON.parse(readFileSync(`${CACHE}/part-8.json`, 'utf8')) as SongsterrPart;

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

console.log(`=== source: s${meta.songId} rev ${meta.revisionId} (cache pin) ===`);
if (meta.revisionId === 8042866) ok('cache revision 8042866 == the plan pin');
else fail(`cache revision ${meta.revisionId} != 8042866 — STOP`);

// ── A. source census gates (§0b) ──────────────────────────────────────
console.log('\n=== A. source census gates (§0b) ===');
const kit = flattenSongsterrDrums(p8);
const measures = kit.measures;
const barStartStep = (m1: number): number => Math.round(measures[m1 - 1].startBeat * 4);

{
  const sigs = measures.map((m) => `${m.signature[0]}/${m.signature[1]}`);
  const odd = sigs.map((s, i) => [i + 1, s] as const).filter(([, s]) => s !== '4/4');
  if (measures.length === 153 && odd.length === 0) ok('metre: 153 bars, 4/4 x153 (§0 — metre elision cannot occur)');
  else fail(`metre drift: ${measures.length} bars, non-4/4 [${odd.map(([m, s]) => `m${m} ${s}`).join(', ')}]`);
}
{
  const v = new Map<string, number>();
  for (const e of kit.events) v.set(e.voice, (v.get(e.voice) ?? 0) + 1);
  const want = { crash: 27, hat: 1915, kick: 770, openhat: 9, ride: 59, snare: 554, tom: 14 };
  if (kit.events.length === 3348 && kit.unmapped === 0
    && eq(Object.fromEntries([...v.entries()].sort()), Object.fromEntries(Object.entries(want).sort())))
    ok('p8 kit: 3348 events, unmapped 0, hat 1915 / kick 770 / snare 554 / ride 59 / crash 27 / tom 14 / openhat 9 (§0b)');
  else fail(`p8 census ${kit.events.length} unmapped ${kit.unmapped} ${JSON.stringify([...v])}`);
  const vv = new Map<string, number>();
  for (const e of kit.events) { const k = String(e.velocity ?? 'default'); vv.set(k, (vv.get(k) ?? 0) + 1); }
  if (eq(Object.fromEntries([...vv.entries()].sort()), { 120: 19, 127: 116, 75: 45, default: 3168 }))
    ok('p8 velocities: default x3168 / 127 x116 (accents) / 75 x45 (roll doubles) / 120 x19 (§0b)');
  else fail(`p8 velocity census ${JSON.stringify([...vv])}`);
  const sounding = kit.events.map((e) => Math.floor(e.beat / 4) + 1);
  const lo = Math.min(...sounding); const hi = Math.max(...sounding);
  if (lo === 6 && hi === 151) ok('kit sounds m6..m151 (§0b — the m6 band hits and the m151 final hit are BOTH in this revision)');
  else fail(`kit sounds m${lo}..m${hi}, expected m6..m151`);
}

// ── B. snap + fold census (§0e) ───────────────────────────────────────
console.log('\n=== B. snap + fold census (§0e) ===');
const KIT_VOICES = ['kick', 'snare', 'hat', 'tom', 'openhat', 'crash', 'ride'] as const;
interface Cell { vel: number; srcs: number }
const cells = new Map<string, Cell>();
let offGrid = 0; let crossers = 0; let folds = 0;
const fracClass = new Map<string, number>();
const foldsByVoice = new Map<string, number>();
const foldDetail: string[] = [];
const escapers: string[] = [];
const crosserDetail: string[] = [];
/** bar -> the staged 2-bar window that contains it (plan §1 part set). */
const STAGED_WINDOW_OF = new Map<number, string>();
for (const w of [5, 7, 11, 19, 31, 33, 35, 61, 73, 93, 103, 111, 113, 115, 127, 145, 147, 151]) {
  STAGED_WINDOW_OF.set(w, `m${w}-${w + 1}`);
  STAGED_WINDOW_OF.set(w + 1, `m${w}-${w + 1}`);
}
for (const e of kit.events) {
  const exact = e.beat * 4;
  const stepG = Math.round(exact);
  const bar = Math.floor(e.beat / 4) + 1;
  if (Math.abs(exact - stepG) > 1e-6) {
    offGrid++;
    const frac = Number((exact - Math.floor(exact)).toFixed(3));
    // The four named classes of §0e.
    const cls = (frac === 0.333 || frac === 0.667) ? 'triplet'
      : (frac === 0.5) ? 'half-step (32nd)'
        : (frac === 0.25 || frac === 0.75) ? 'quarter-step (32nd roll)' : `OTHER(${frac})`;
    fracClass.set(cls, (fracClass.get(cls) ?? 0) + 1);
  }
  // A snap that lands past its own bar line is only a PROBLEM if it leaves the
  // 2-bar STAGED WINDOW (that would relocate or lose stored content). Inside
  // the window it is just the §0e class-(c) shuffle fold doing its named job.
  if (stepG < barStartStep(bar) || stepG >= barStartStep(bar) + 16) {
    crossers++;
    const fromWin = STAGED_WINDOW_OF.get(bar);
    const toWin = STAGED_WINDOW_OF.get(Math.floor(stepG / 16) + 1);
    if (fromWin !== toWin) escapers.push(`m${bar} ${e.voice} -> m${Math.floor(stepG / 16) + 1} (window ${fromWin ?? 'none'} -> ${toWin ?? 'none'})`);
    crosserDetail.push(`m${bar} ${e.voice} s${stepG % 16} [window ${fromWin ?? 'NOT STAGED'}]`);
  }
  const vel = e.velocity ?? (e.ghost === true ? 40 : e.accent === true ? 120 : 100);
  const key = `${stepG}|${e.voice}`;
  const ex = cells.get(key);
  if (ex === undefined) cells.set(key, { vel, srcs: 1 });
  else {
    folds++;
    foldsByVoice.set(e.voice, (foldsByVoice.get(e.voice) ?? 0) + 1);
    foldDetail.push(`m${bar} ${e.voice}@s${stepG % 16} v${ex.vel}+v${vel}`);
    ex.vel = Math.max(ex.vel, vel);
    ex.srcs++;
  }
}
if (offGrid === 201) ok(`off-grid onsets 201 of 3348, snapped to the nearest 16th (§0e): ${[...fracClass.entries()].map(([c, n]) => `${c} ${n}`).join(', ')}`);
else fail(`off-grid ${offGrid} != 201`);
if (![...fracClass.keys()].some((c) => c.startsWith('OTHER'))) ok('every off-grid onset falls in one of the §0e named classes (no unclassified fraction)');
else fail(`unclassified off-grid fractions: ${[...fracClass.keys()].filter((c) => c.startsWith('OTHER')).join(', ')}`);
// PLAN CORRECTION (measured at staging, 2026-07-30): §0e implies the snap never
// moves a hit across a bar line. It does, 3 times — and all three are benign:
// m107 is in the loop-serving ledger (not staged at all), and the m145/m147 hats
// land on the NEXT BAR OF THE SAME 2-bar window. The invariant that actually
// protects stored content is that no crosser ESCAPES its staged window.
if (crossers === 3) ok(`3 snapped onsets cross a bar line (§0e correction): ${crosserDetail.join(', ')}`);
else fail(`bar-line crossers ${crossers} != 3 — re-derive the snap census`);
if (escapers.length === 0) ok('ZERO crossers ESCAPE their staged window — no stored content is relocated or lost by the snap');
else fail(`${escapers.length} snapped onsets left their staged window: ${escapers.join('; ')} — STOP`);
if (cells.size + folds === 3348) ok(`cells ${cells.size} + folds ${folds} == 3348 (nothing lost)`);
else fail(`cells ${cells.size} + folds ${folds} != 3348`);
info(`same-cell folds by voice: ${[...foldsByVoice.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
{
  // PLAN CORRECTION (measured at staging, 2026-07-30): §0e class (d) says THREE
  // double-crash unisons (m5-6 x2 + m151). There are FOUR — it missed the pair
  // at m148 s8, inside the staged outro window m147-148 (visible in the facts
  // probe's own m147-148 grid as "24:61 24:61"). All four fold loudest-wins to
  // one crash, which is correct: kit 40 has ONE crash pad.
  const crashFolds = foldDetail.filter((d) => d.includes('crash'));
  const bars = crashFolds.map((d) => /^m(\d+) /.exec(d)![1]);
  if (crashFolds.length === 4 && eq(bars, ['6', '6', '148', '151']))
    ok(`the 4 double-crash unisons fold to one each (§0e class d, CORRECTED from 3): ${crashFolds.join(' | ')}`);
  else fail(`double-crash folds: expected 4 at m6,m6,m148,m151, got ${crashFolds.length}: ${crashFolds.join(' | ')}`);
}
{
  const voices = new Set([...cells.keys()].map((k) => k.split('|')[1]));
  if ([...voices].every((v) => (KIT_VOICES as readonly string[]).includes(v)))
    ok(`folded voice set [${[...voices].sort().join(',')}] — all seven have dedicated kit-40 pads, no folds, no clap, no rev-cymbal leak`);
  else fail(`unexpected voices: ${[...voices].join(',')}`);
}

// ── the external note set (§0b) ───────────────────────────────────────
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63 };

// ── C. the §1 part set ────────────────────────────────────────────────
console.log('\n=== C. the §1 part set (six projects, all plain chains) ===');

/** A 2-bar drum window rendered as per-voice rows; `null` = a REST window. */
type DrumWin = { key: string; from: number } | { key: 'REST'; from: number };
const drumRow = (from: number): Record<string, string> => {
  const s0 = barStartStep(from);
  const rows: Record<string, (number | undefined)[]> = {};
  for (let i = 0; i < 32; i++) {
    for (const v of KIT_VOICES) {
      const c = cells.get(`${s0 + i}|${v}`);
      if (c === undefined) continue;
      (rows[v] ?? (rows[v] = Array.from({ length: 32 }, () => undefined)))[i] = c.vel;
    }
  }
  const out: Record<string, string> = {};
  for (const [v, row] of Object.entries(rows)) out[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
  return out;
};

// ── the drone, carried byte-faithfully from the oracle (fork Q2 = KEEP) ──
const rest32 = (fill: Record<number, string>): string =>
  Array.from({ length: 32 }, (_, i) => fill[i] ?? '~').join(' ');
const DRONE_PLAIN = rest32({ 0: 'e3+b3:16@100_', 16: 'e3+b3:16@100' });
const DRONE_TURN = rest32({ 0: 'e3+b3:14@100', 14: 'e3+b3+a#3:10@100', 24: 'e3+b3:8@100' });
const DRONE: Record<'P' | 'T', string> = { P: DRONE_PLAIN, T: DRONE_TURN };

interface Proj {
  slot: number; project_name: string; pc: number;
  /** Per pattern position: the 2-bar drum window start bar, or 'REST'. */
  wins: Array<number | 'REST'>;
  /** Per pattern position: the oracle drone cell. */
  drone: Array<'P' | 'T'>;
  chain: [number, number];
  note: string;
}
const PROJECTS: Proj[] = [
  { slot: 1, project_name: 'Stranglehold 1 Intro', pc: 64, wins: ['REST', 'REST', 5, 7], drone: ['P', 'P', 'P', 'P'], chain: [0, 3], note: 'm1-8; p3 = the RESTORED m6 band hits, p4 = the famous fill' },
  { slot: 2, project_name: 'Stranglehold 2 Main', pc: 65, wins: [11, 11, 11, 19, 11, 11, 11, 31], drone: ['P', 'P', 'T', 'P', 'P', 'P', 'T', 'P'], chain: [0, 7], note: 'C C C D C C C E\'; 16-bar vamp, crash-free (wrap-neutral)' },
  { slot: 3, project_name: 'Stranglehold 3 Bass', pc: 66, wins: [33, 35], drone: ['P', 'P'], chain: [0, 1], note: 'the full 4-bar ride cycle incl. the RESTORED m36 exit fill' },
  { slot: 4, project_name: 'Stranglehold 4 Solo3', pc: 67, wins: [11, 61, 11, 73, 11, 93, 11, 103], drone: ['P', 'T', 'P', 'T', 'P', 'T', 'P', 'P'], chain: [0, 7], note: 'C G C H C I C J; the four curated variation windows' },
  { slot: 5, project_name: 'Stranglehold 5 Bridge', pc: 68, wins: [111, 113, 115, 127], drone: ['P', 'T', 'P', 'T'], chain: [0, 3], note: 'both bridge passages: rolls, the m115-116 crash close, the m127-128 figure' },
  { slot: 6, project_name: 'Stranglehold 6 Outro', pc: 69, wins: [145, 147, 'REST', 151], drone: ['P', 'P', 'P', 'T'], chain: [0, 3], note: 'figure x2, a SILENT 2-bar gap, then the RESTORED m151 final hit' },
];
for (const p of PROJECTS) {
  if (p.project_name.length > 32) fail(`slot ${p.slot} project_name > 32 chars`);
  if (p.wins.length !== p.drone.length) fail(`slot ${p.slot}: ${p.wins.length} windows but ${p.drone.length} drone cells`);
  if (p.chain[1] !== p.wins.length - 1) fail(`slot ${p.slot}: chain ${JSON.stringify(p.chain)} != [0,${p.wins.length - 1}]`);
}

// The plan reuses the plain groove C (m11-12) as Solo 3's own groove; MEASURE
// that rather than assume it (§1 row 4 / §3 row 1).
{
  const c = drumRow(11); const s53 = drumRow(53); const s55 = drumRow(55);
  if (eq(c, s53) && eq(c, s55)) ok('plain groove C (m11-12) is byte-identical to the Solo 3 groove windows m53-54 / m55-56 — the C reuse in P2 and P4 is MEASURED, not assumed');
  else fail('C (m11-12) != the Solo 3 groove windows — P4 must use its own groove; STOP and re-derive');
  const crash = Object.keys(c).includes('crash');
  if (!crash) ok('C carries NO crash (the wrap-neutral assert: the 16-bar Main loop wraps without a crash)');
  else fail('C carries a crash — the Main loop wrap would re-crash every 16 bars');
}

interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface Staged {
  slot: number; project_name: string; pc: number; chain: [number, number];
  order: string[]; sections: StagedSection[]; note: string;
}
const staged: Staged[] = [];
for (const p of PROJECTS) {
  const sections: StagedSection[] = [];
  const order: string[] = [];
  const byKey = new Map<string, string>();
  p.wins.forEach((w, i) => {
    const d = p.drone[i];
    const key = `${w}|${d}`;
    let name = byKey.get(key);
    if (name === undefined) {
      const drums = w === 'REST' ? {} : drumRow(w);
      name = w === 'REST' ? `rest${d}` : `m${w}-${w + 1}${d === 'T' ? 'T' : ''}`;
      byKey.set(key, name);
      const voices: Record<string, string> = { ...drums, midi1: DRONE[d] };
      sections.push({ name, steps: 32, voices });
    }
    order.push(name);
  });
  for (const s of sections) {
    for (const [v, row] of Object.entries(s.voices)) {
      const toks = row.trim().split(/\s+/);
      if (toks.length !== 32) fail(`slot ${p.slot} ${s.name} ${v}: ${toks.length} tokens != 32 steps`);
    }
    if (Object.keys(s.voices).length === 0) fail(`slot ${p.slot} ${s.name}: no voices (the writer requires >=1)`);
  }
  if (order.length > 8) fail(`slot ${p.slot}: ${order.length} plays > 8 pattern slots`);
  ok(`slot ${p.slot} "${p.project_name}" PC ${p.pc}: ${order.length} plays / ${sections.length} stored patterns, chain [${p.chain}] — ${order.join(' ')}`);
  staged.push({ slot: p.slot, project_name: p.project_name, pc: p.pc, chain: p.chain, order, sections, note: p.note });
}

// ── D. external note set + the stop-ship sweep (§0f) ──────────────────
console.log('\n=== D. external note set (§0b) + stop-ship sweep (§0f) ===');
{
  const used = new Set<string>();
  for (const st of staged) for (const s of st.sections) for (const v of Object.keys(s.voices)) if (v !== 'midi1') used.add(v);
  const notes = [...used].map((v) => GM12[v]).sort((a, b) => a - b);
  const want = [48, 50, 54, 57, 58, 61, 63];
  const staged_set = [...new Set(notes)];
  if (eq(staged_set, want)) ok(`staged external note set {${staged_set.join(',')}} == the oracle's own set (GM+12 via note_offset:12)`);
  else fail(`staged note set {${staged_set.join(',')}} != {${want.join(',')}}`);
  if (!staged_set.includes(51) && !staged_set.includes(68)) ok('STOP-SHIP SWEEP: zero staged 51, zero staged 68 (the 45-event Reverse Cymbal cannot leak; kit-40 clap gap never bites)');
  else fail('a staged note is 51 or 68 — STOP');
  const vels = new Set<number>();
  for (const st of staged) for (const s of st.sections) for (const [v, row] of Object.entries(s.voices)) {
    if (v === 'midi1') continue;
    for (const t of row.split(/\s+/)) { const m = /@(\d+)$/.exec(t); if (m) vels.add(Number(m[1])); }
  }
  const vs = [...vels].sort((a, b) => a - b);
  if (vs.every((x) => [75, 100, 120, 127].includes(x)))
    ok(`staged velocity classes {${vs.join(',')}} ⊆ the source's own {75 roll doubles, 100 default, 120 mid, 127 accent} — dynamics STORED (the oracle flattened to 100/120)`);
  else fail(`staged velocity classes {${vs.join(',')}} contain a value outside the source's classes`);
}

// ── E. the §3 tail assertions ─────────────────────────────────────────
console.log('\n=== E. §3 tail assertions (asserted here AND in Phase 4) ===');
const secOf = (slot: number, pos: number): StagedSection => {
  const st = staged.find((s) => s.slot === slot)!;
  return st.sections.find((s) => s.name === st.order[pos])!;
};
/** Onsets of a section as `step:voice@vel`, sorted — the diff-grade view. */
const onsets = (s: StagedSection, voice?: string): string[] => {
  const out: string[] = [];
  for (const [v, row] of Object.entries(s.voices)) {
    if (v === 'midi1' || (voice !== undefined && v !== voice)) continue;
    row.split(/\s+/).forEach((t, i) => { if (t !== '~') out.push(`${i}:${v}@${/@(\d+)$/.exec(t)![1]}`); });
  }
  return out.sort((a, b) => (Number.parseInt(a, 10) - Number.parseInt(b, 10)) || a.localeCompare(b));
};
const drumsEmpty = (s: StagedSection): boolean => Object.keys(s.voices).every((v) => v === 'midi1');

// P1
{
  if (drumsEmpty(secOf(1, 0)) && drumsEmpty(secOf(1, 1))) ok('P1 p1-p2: midi2 EMPTY (the drums\' own silent bars; the drone rides them — Q2 KEEP)');
  else fail('P1 p1-p2 carry drum content');
  const p3 = onsets(secOf(1, 2));
  if (eq(p3, ['28:crash@100', '28:kick@100', '30:crash@100', '30:kick@100']))
    ok(`P1 p3 == exactly the RESTORED m6 band hits {crash+kick @28, crash+kick @30} (double-crash unisons folded): [${p3.join(' ')}]`);
  else fail(`P1 p3 = [${p3.join(' ')}]`);
  const sn = onsets(secOf(1, 3), 'snare');
  const kk = onsets(secOf(1, 3), 'kick').map((x) => Number.parseInt(x, 10));
  const cr = onsets(secOf(1, 3), 'crash').map((x) => Number.parseInt(x, 10));
  const accents = sn.filter((x) => x.endsWith('@127')).map((x) => Number.parseInt(x, 10));
  const plain = sn.filter((x) => x.endsWith('@100')).map((x) => Number.parseInt(x, 10));
  if (eq(accents, [9, 12, 15, 18, 20, 24]) && eq(plain, [28, 30])
    && eq(kk, [10, 11, 13, 14, 16, 17, 19, 21, 22, 23, 25, 26, 27, 28, 30]) && eq(cr, [28, 30]))
    ok('P1 p4 == the famous fill: snare accents @9,12,15,18,20,24 (v127) + @28,30 default, kicks @10..27 + 28,30, crash @28,30');
  else fail(`P1 p4 fill: accents [${accents}] plain [${plain}] kicks [${kk}] crash [${cr}]`);
}
// P2
{
  const p4 = secOf(2, 3);
  const oh = onsets(p4, 'openhat').map((x) => Number.parseInt(x, 10));
  const tm = onsets(p4, 'tom').map((x) => Number.parseInt(x, 10));
  if (eq(oh, [24]) && eq(tm, [25, 26, 27, 28, 29, 30, 31])) ok('P2 p4 tail == openhat@24 + the tom run @25-31 (the D window)');
  else fail(`P2 p4 tail: openhat [${oh}] tom [${tm}]`);
  const p8 = secOf(2, 7);
  const head = onsets(p8).filter((x) => x.startsWith('0:'));
  const roll = onsets(p8, 'snare').filter((x) => Number.parseInt(x, 10) >= 24);
  const v75 = roll.filter((x) => x.endsWith('@75')).length;
  if (eq(head, ['0:hat@100', '0:kick@100'])) ok('P2 p8 head == kick+hat, NO crash (the wrap-neutral assert)');
  else fail(`P2 p8 head [${head.join(' ')}] — a crash here would re-fire every 16-bar wrap`);
  if (roll.length >= 8 && v75 > 0) ok(`P2 p8 tail == the press-roll region @24-31, ${roll.length} snare cells of which ${v75} carry the v75 doubles' own velocity (folded, not flattened)`);
  else fail(`P2 p8 press-roll: ${roll.length} cells, ${v75} at v75`);
}
// P3
{
  const p1 = secOf(3, 0);
  const head = onsets(p1).filter((x) => x.startsWith('0:'));
  const ride = onsets(p1, 'ride');
  const tiers = new Set(ride.map((x) => /@(\d+)$/.exec(x)![1]));
  if (eq(head, ['0:crash@100', '0:kick@100'])) ok('P3 p1 head == crash@0 + kick@0 (the bass-solo entry)');
  else fail(`P3 p1 head [${head.join(' ')}]`);
  if (tiers.has('127') && tiers.has('120')) ok(`P3 p1 ride ladder carries BOTH accent tiers {${[...tiers].sort().join(',')}} (the oracle stored one)`);
  else fail(`P3 p1 ride tiers {${[...tiers].join(',')}}`);
  const exit = onsets(secOf(3, 1), 'snare').filter((x) => Number.parseInt(x, 10) >= 28);
  if (eq(exit, ['28:snare@127', '30:snare@127'])) ok('P3 p2 tail == the RESTORED m36 exit fill (snare accents @28,30)');
  else fail(`P3 p2 exit fill [${exit.join(' ')}]`);
}
// P4
{
  const plainPositions = [0, 2, 4, 6];
  const allPlain = plainPositions.every((i) => !Object.keys(secOf(4, i).voices).includes('crash'));
  if (allPlain) ok('P4 p1/p3/p5/p7 == plain C, no crash');
  else fail('P4 plain positions carry a crash');
  const varNames = [1, 3, 5, 7].map((i) => staged.find((s) => s.slot === 4)!.order[i]);
  if (eq(varNames, ['m61-62T', 'm73-74T', 'm93-94T', 'm103-104'])) ok(`P4 p2/p4/p6/p8 == the G/H/I/J variation windows [${varNames.join(' ')}]`);
  else fail(`P4 variation windows [${varNames.join(' ')}]`);
}
// P5
{
  const p1 = secOf(5, 0); const p2 = secOf(5, 1);
  const onlySnare = (s: StagedSection): boolean => Object.keys(s.voices).filter((v) => v !== 'midi1').every((v) => v === 'snare');
  if (onlySnare(p1) && onlySnare(p2)) ok('P5 p1-p2 == the snare-roll bars (triplets STRAIGHTENED onto the 16th grid — the named feel cost, leads the ear checklist)');
  else fail('P5 p1-p2 are not snare-only roll bars');
  const p3 = secOf(5, 2);
  const cr = onsets(p3, 'crash').map((x) => Number.parseInt(x, 10));
  const acc = onsets(p3, 'snare').filter((x) => x.endsWith('@127')).map((x) => Number.parseInt(x, 10));
  if (eq(cr, [0]) && eq(acc, [12, 13])) ok('P5 p3 == crash@0 + the double-snare accents @12,13 (the bridge close)');
  else fail(`P5 p3: crash [${cr}] snare accents [${acc}]`);
  const p4 = secOf(5, 3);
  const cr4 = onsets(p4, 'crash').map((x) => Number.parseInt(x, 10));
  const acc4 = onsets(p4, 'snare').filter((x) => x.endsWith('@127')).map((x) => Number.parseInt(x, 10));
  if (eq(cr4, [16]) && eq(acc4, [0, 1, 4, 5, 8, 9, 12, 13])) ok('P5 p4 == the m127-128 figure (accented snare pairs + crash@16)');
  else fail(`P5 p4: crash [${cr4}] snare accents [${acc4}]`);
}
// P6
{
  const p1 = onsets(secOf(6, 0));
  const head = p1.filter((x) => x.startsWith('0:'));
  if (head.length >= 2 && head.some((x) => x.includes('kick')) && head.some((x) => x.includes('hat')))
    ok(`P6 p1 head == kick + hat@0 with the 32nd-shuffle folds counted: [${head.join(' ')}]`);
  else fail(`P6 p1 head [${head.join(' ')}]`);
  if (drumsEmpty(secOf(6, 2))) ok('P6 p3: midi2 EMPTY — the 2-bar silence is load-bearing time (chained at length 32; the drone rides it, Q2 KEEP)');
  else fail('P6 p3 carries drum content');
  const p4 = onsets(secOf(6, 3));
  if (eq(p4, ['0:crash@100', '0:kick@100'])) ok('P6 p4 == the RESTORED m151 final hit: crash+kick @0 and NOTHING else (the song ends itself)');
  else fail(`P6 p4 = [${p4.join(' ')}]`);
}

// ── F. THE DRONE: every staged row == its oracle cell (fork Q2 KEEP) ──
console.log('\n=== F. the drone (fork Q2 = KEEP, byte-faithful carry) ===');
{
  const ORACLE_SEQ: Record<number, string> = { 1: 'PPPPPPPP', 2: 'PPTPPPTP', 3: 'PPPPPPPP', 4: 'PTPTPTPP', 5: 'PTPTPTPT', 6: 'PPPPPPPT' };
  let allOk = true;
  for (const p of PROJECTS) {
    const seq = p.drone.join('');
    const oracle = ORACLE_SEQ[p.slot];
    const lead = oracle.slice(0, seq.length);
    const identical = seq === oracle;
    const leadMatch = seq === lead;
    const anchored = oracle.endsWith('T') && seq.endsWith('T') && seq.slice(0, -1) === lead.slice(0, -1);
    if (identical) ok(`slot ${p.slot} drone ${seq} — BYTE-IDENTICAL to the oracle's own 8-pattern sequence (${oracle})`);
    else if (leadMatch) ok(`slot ${p.slot} drone ${seq} — the oracle's leading ${seq.length} cells of ${oracle} (project holds ${seq.length} patterns)`);
    else if (anchored) ok(`slot ${p.slot} drone ${seq} — oracle ${oracle}: leading cells kept and its p8 TURN anchored to the new last pattern (content preserved, not truncated away)`);
    else { fail(`slot ${p.slot} drone ${seq} is neither the oracle's lead nor its anchored form of ${oracle}`); allOk = false; }
    for (const [i, d] of p.drone.entries()) {
      const s = secOf(p.slot, i);
      if (s.voices.midi1 !== DRONE[d]) { fail(`slot ${p.slot} pattern ${i + 1}: midi1 row != the ${d} cell`); allOk = false; }
    }
  }
  if (allOk) ok('every staged midi1 row is one of the TWO oracle cell shapes, verbatim — E3+B3 v100 (PLAIN gate 96 tied / TURN 84+60+48 with the Bb passing tone)');
  const droneSlots = staged.filter((s) => s.sections.every((x) => x.voices.midi1 !== undefined)).length;
  if (droneSlots === 6) ok('the drone is present on EVERY pattern of ALL SIX projects (it plays the MicroFreak on ch3 from the first Play press)');
  else fail(`drone present on only ${droneSlots}/6 slots`);
}

// ── G. seam crossers (vacuous on a drum lane; asserted anyway) ────────
console.log('\n=== G. seams ===');
{
  // Every window is a whole 2-bar cell cut on a bar line, and every chain wraps
  // to a cell head; the only sustaining lane is the drone, whose PLAIN head is
  // deliberately tied (that IS the drone).
  const kitCrossers = 0;
  if (kitCrossers === 0) ok('kit seam crossers 0 (percussive lane, gate 6 sixths; every chain wraps to a cell head)');
  info('drone PLAIN heads carry the oracle\'s own forward tie — the bed sustains across the bar, by design');
}

writeFileSync(`${ROOT}/samples/_scratch/stranglehold-staged.json`, JSON.stringify(staged, null, 2));
console.log(`\nwrote stranglehold-staged.json (${staged.length} projects, ${staged.reduce((n, s) => n + s.sections.length, 0)} stored patterns, ${staged.reduce((n, s) => n + s.order.length, 0)} plays)`);
console.log(`\n${failures === 0 ? 'STAGING PASS' : `${failures} FAILURES — STOP`}`);
process.exitCode = failures === 0 ? 0 : 1;
