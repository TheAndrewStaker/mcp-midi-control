/**
 * Amber (311, s24430 r3852308) POPULATE-pass staging — the payload the
 * 2026-07-29 re-author used, reconstructed from the PINNED cache + the plan's
 * own byte-decoded hand layer, so the 2026-07-30 populate pass can re-author
 * the SAME four projects with `condense_drums` added and nothing else changed.
 * READ-ONLY: no device, no network. Run: npx tsx samples/_scratch/amber-stage.ts
 *
 * Why this file exists at all. Amber was built on 2026-07-29 by direct MCP
 * calls, BEFORE the `<song>-stage.ts` / `<song>-exec.ts` convention landed, so
 * unlike Stranglehold and Sugar it left no `*-staged.json` behind. Rebuilding
 * the payload is therefore mandatory — and it is only trustworthy if it is
 * PROVED against the bytes the old build actually produced. So this script does
 * not merely assemble; it re-derives from source and then asserts the assembly
 * reproduces the CANONICAL card bytes exactly:
 *
 *   1. SOURCE  — 35 two-bar windows from samples/songsterr-cache/s24430
 *      (part 10, the tab's only drum track), by the same import path the MCP
 *      tool uses (importSongsterrDrums + quantizedToGrids, stepsPerBeat 4),
 *      cross-checked against the whole-song bank route (decomposeToPatterns +
 *      coalescePatterns, fuzz 0) so the two agree cell-for-cell.
 *   2. LETTERS — the 9-cell / 35-window order string must equal plan §0b.
 *   3. PAD     — the 3 hand-authored midi1 cells from plan §0d (NOT source
 *      derivable; the plan settled the provenance by probe).
 *   4. PAIRS   — sections keyed by the (drum, midi1) PAIR per plan §2c, orders
 *      per §1; distinct counts and scene-run shapes must equal §1.
 *   5. ORACLE  — every staged row is decoded against the newest canonical
 *      capture (samples/circuit-ncs/bindings-2026-07-30/verify, the 2026-07-30
 *      binding pass) slot by slot, pattern by pattern: midi1 pitch/step/
 *      velocity/gate identity, and midi2 note-set identity through a role→note
 *      map DERIVED from the bytes and then checked against the expected
 *      GM+12 map. If the reconstruction were wrong anywhere, step 5 fails.
 *
 * Emits samples/_scratch/amber-staged.json in the same shape the Stranglehold
 * and Sugar staged files use, so one exec driver reads all three.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import {
  importSongsterrDrums, flattenSongsterrDrums, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { quantizedToGrids } from '../../packages/core/src/protocol-generic/patterns/midiFile.js';
import { decomposeToPatterns, coalescePatterns } from '../../packages/core/src/protocol-generic/patterns/songStructure.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getNoteChain } from '../../packages/circuit-tracks/src/ncs/chain.js';
import { getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const CACHE = `${ROOT}/samples/songsterr-cache/s24430`;
const CANON = `${ROOT}/samples/circuit-ncs/bindings-2026-07-30/verify`;
const WINDOWS = 35;

let failures = 0;
const fail = (m: string): void => { failures++; console.log(`  FAIL: ${m}`); };
const ok = (m: string): void => console.log(`  ok: ${m}`);
const info = (m: string): void => console.log(`  info: ${m}`);

const p10 = JSON.parse(readFileSync(`${CACHE}/part-10.json`, 'utf8')) as SongsterrPart;
const meta = JSON.parse(readFileSync(`${CACHE}/meta.json`, 'utf8')) as { revisionId: number; songId: number };

// ── 0. revision pin ──────────────────────────────────────────────────────────
console.log('=== 0. revision pin ===');
if (meta.revisionId === 3852308 && meta.songId === 24430) ok('cache is s24430 r3852308 (the plan pin)');
else fail(`cache is s${meta.songId} r${meta.revisionId}, NOT s24430 r3852308 — STOP`);

// ── 1. the 35 windows, by the tool's own windowed import path ────────────────
console.log('\n=== 1. windows (importSongsterrDrums, stepsPerBeat 4, 2 bars per window) ===');
const flat = flattenSongsterrDrums(p10);
if (flat.measures.length === 70 && flat.measures.every((m) => m.signature[0] === 4 && m.signature[1] === 4))
  ok('70 measures, all 4/4 (35 two-bar windows)');
else fail(`measures ${flat.measures.length} / signature drift`);

/** Per-window char grids, exactly as `import_songsterr from_measure/to_measure` returns them. */
const windowGrids: Record<string, string>[] = [];
for (let w = 1; w <= WINDOWS; w++) {
  const q = importSongsterrDrums(p10, { stepsPerBeat: 4, fromMeasure: 2 * w - 1, toMeasure: 2 * w });
  if (q.steps !== 32) fail(`window ${w} is ${q.steps} steps, expected 32`);
  const g = quantizedToGrids(q);
  // A silent window quantizes to no voices; the dispatcher emits an explicit
  // all-rest kick row so the pattern still exists and carries its length.
  windowGrids.push(Object.keys(g).length > 0 ? g : { kick: '.'.repeat(q.steps) });
}
const gridKey = (g: Record<string, string>): string =>
  Object.keys(g).sort().map((v) => `${v}=${g[v]}`).join('|');

const letterOf: string[] = [];
const cellByLetter = new Map<string, Record<string, string>>();
{
  const seen = new Map<string, string>();
  for (const g of windowGrids) {
    const k = gridKey(g);
    let L = seen.get(k);
    if (L === undefined) {
      L = String.fromCharCode(65 + seen.size);
      seen.set(k, L);
      cellByLetter.set(L, g);
    }
    letterOf.push(L);
  }
}
const ORDER_STRING = letterOf.join(' ');
const EXPECT_ORDER = 'A A A A B C C C B C D E B C F G F G D E B C C D H D E B C D E B C B I';
if (ORDER_STRING === EXPECT_ORDER) ok(`35-window order == plan §0b letter-for-letter: ${ORDER_STRING}`);
else fail(`order string MISMATCH\n    got:  ${ORDER_STRING}\n    want: ${EXPECT_ORDER}`);
if (cellByLetter.size === 9) ok('9 distinct cells (1 all-rest + 8 content), per §0b');
else fail(`${cellByLetter.size} distinct cells, expected 9`);
{
  const a = cellByLetter.get('A')!;
  const rest = Object.keys(a).length === 1 && a.kick === '.'.repeat(32);
  if (rest) ok('cell A is the all-rest intro window (authored as an explicit 32-dot kick row)');
  else fail(`cell A is not all-rest: ${JSON.stringify(a)}`);
}

// ── 2. cross-check: the whole-song bank route agrees cell-for-cell ───────────
console.log('\n=== 2. cross-check vs the whole-song bank (decompose + coalesce, fuzz 0) ===');
{
  const decomp = decomposeToPatterns(flat.events, {
    totalBeats: flat.totalBeats, stepsPerPattern: 32, stepsPerBeat: 4,
  });
  const co = coalescePatterns(decomp, { maxDistance: 0 });
  if (co.windowCount === WINDOWS) ok(`whole-song bank has ${WINDOWS} windows`);
  else fail(`whole-song bank windowCount ${co.windowCount}`);
  const bankLetters = co.order.map((i) => String.fromCharCode(65 + i)).join(' ');
  if (bankLetters === ORDER_STRING) ok('whole-song bank order == the windowed order (the two import routes agree)');
  else fail(`bank order differs\n    bank:   ${bankLetters}\n    window: ${ORDER_STRING}`);
  let same = 0;
  for (let i = 0; i < co.patterns.length; i++) {
    const g = quantizedToGrids(co.patterns[i]);
    const L = String.fromCharCode(65 + i);
    const mine = cellByLetter.get(L)!;
    const bankG = Object.keys(g).length > 0 ? g : { kick: '.'.repeat(co.patterns[i].steps) };
    if (gridKey(bankG) === gridKey(mine)) same++;
    else fail(`cell ${L} differs between routes\n    bank:   ${gridKey(bankG)}\n    window: ${gridKey(mine)}`);
  }
  if (same === co.patterns.length) ok(`all ${same} bank cells byte-identical to the windowed grids`);
}

// ── 3. the hand-authored midi1 pad (plan §0d; NOT source derivable) ──────────
console.log('\n=== 3. midi1 chord-pad cells (plan §0d) ===');
/** Build a 32-step mini-notation row from (1-based step → token) entries. */
const padRow = (entries: Array<[number, string]>): string => {
  const cells = Array.from({ length: 32 }, () => '~');
  for (const [st, tok] of entries) cells[st - 1] = tok;
  return cells.join(' ');
};
const PAD: Record<string, string> = {
  // cell A: two full-bar holds. The card's st1 stored gate 224 (tie+96); the
  // 2026-07-29 re-author wrote plain 96 (same audible 16-step hold) and that is
  // what the canonical now holds, so stage 96 — no tie flag.
  A: padRow([[1, 'e3+g3+b3:16@100'], [17, 'e3+g3+b3:16@100']]),
  B: padRow([[1, 'e3+g3+b3:14@100'], [15, 'e3+g3+b3+c#4:10@100'], [25, 'e3+g3+b3:8@100']]),
  C: padRow([[1, 'e3+g3+b3:8@100'], [9, 'e3+f#3+g3+b3:8@100'], [17, 'e3+g3+b3:8@100'], [25, 'e3+g3+b3+c#4:8@100']]),
};
for (const [L, row] of Object.entries(PAD)) info(`pad ${L}: ${row.replace(/(~ ){3,}/g, (m) => `~×${m.trim().split(/\s+/).length} `)}`);

// ── 4. the four projects: pair-keyed sections + orders (plan §1 / §2c) ───────
console.log('\n=== 4. projects, sections keyed by the (drum, midi1) PAIR (§2c) ===');
interface ProjSpec {
  slot: number; project_name: string; from: number; to: number;
  /** midi1 letters per window, carried from the 5-project card decode (§0a). */
  pad: string;
  /** §1's stated distinct-section count and chain shape, asserted below. */
  wantDistinct: number; wantLayout: 'chain' | 'scenes'; wantRuns: number;
}
const PROJECTS: ProjSpec[] = [
  { slot: 9, project_name: 'Amber 01 Intro', from: 1, to: 8, pad: 'AABAAABA', wantDistinct: 5, wantLayout: 'chain', wantRuns: 0 },
  { slot: 10, project_name: 'Amber 02', from: 9, to: 18, pad: 'ABABABABAB', wantDistinct: 6, wantLayout: 'scenes', wantRuns: 4 },
  { slot: 11, project_name: 'Amber 03', from: 19, to: 26, pad: 'CABCABBC', wantDistinct: 7, wantLayout: 'chain', wantRuns: 0 },
  { slot: 12, project_name: 'Amber 04 Outro', from: 27, to: 35, pad: 'BCBCBCAAA', wantDistinct: 7, wantLayout: 'scenes', wantRuns: 3 },
];

interface Section { name: string; steps: number; voices: Record<string, string> }
interface Staged {
  slot: number; project_name: string; layout: 'chain' | 'scenes';
  order: string[]; sections: Section[];
  /** Which pattern SLOT each play lands in, for the oracle check + verify. */
  play_slots: number[];
  drums: string; pad: string;
}
const staged: Staged[] = [];

for (const P of PROJECTS) {
  const n = P.to - P.from + 1;
  if (P.pad.length !== n) { fail(`${P.project_name}: pad string ${P.pad.length} letters for ${n} windows`); continue; }
  const drums = letterOf.slice(P.from - 1, P.to).join('');
  const pairs = Array.from({ length: n }, (_, i) => `${drums[i]}${P.pad[i]}`);
  const distinct: string[] = [];
  for (const p of pairs) if (!distinct.includes(p)) distinct.push(p);
  const idx = pairs.map((p) => distinct.indexOf(p));
  // The writer chains one pattern slot per PLAY while plays <= 8, and switches
  // to scene runs above that (writer.ts authorArrangementIntoProject).
  const layout: 'chain' | 'scenes' = n <= 8 ? 'chain' : 'scenes';
  const runs: Array<{ start: number; end: number }> = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && i === last.end + 1) last.end = i; else runs.push({ start: i, end: i });
  }
  const playSlots = layout === 'chain' ? pairs.map((_, i) => i) : idx;

  const sections: Section[] = (layout === 'chain' ? pairs : distinct).map((pair, i) => {
    const dl = pair[0]; const pl = pair[1];
    return {
      name: layout === 'chain' ? `w${P.from + i}-${pair}` : `s${i + 1}-${pair}`,
      steps: 32,
      voices: { ...cellByLetter.get(dl)!, midi1: PAD[pl] },
    };
  });
  const order = sections.map((s) => s.name);
  // A plain chain lists every play as its own section; a scene layout lists the
  // distinct sections once and repeats them through the order.
  const orderNames = layout === 'chain' ? order : idx.map((i) => sections[i].name);

  console.log(`\n  ${P.project_name} (slot ${P.slot}) W${P.from}-${P.to}`);
  info(`drums ${drums.split('').join(' ')}   pad ${P.pad.split('').join(' ')}`);
  info(`pairs ${pairs.join(' ')} → distinct ${distinct.length} [${distinct.join(' ')}]`);
  if (distinct.length === P.wantDistinct) ok(`${n} plays / ${distinct.length} distinct sections == §1`);
  else fail(`${n} plays / ${distinct.length} distinct, §1 says ${P.wantDistinct}`);
  if (layout === P.wantLayout) ok(`layout ${layout} == §1`);
  else fail(`layout ${layout}, §1 says ${P.wantLayout}`);
  if (layout === 'scenes') {
    const shape = runs.map((r) => `[${r.start + 1}-${r.end + 1}]`).join('');
    if (runs.length === P.wantRuns) ok(`${runs.length} scene steps ${shape} == §1`);
    else fail(`${runs.length} scene steps ${shape}, §1 says ${P.wantRuns}`);
  }
  staged.push({
    slot: P.slot, project_name: P.project_name, layout,
    order: orderNames, sections, play_slots: playSlots, drums, pad: P.pad,
  });
}

// ── 5. ORACLE: the staged rows must reproduce the CANONICAL card bytes ───────
console.log('\n=== 5. oracle — staged rows vs the newest canonical capture (bindings-2026-07-30/verify) ===');
const canonFile = (slot: number): string => {
  const f = readdirSync(CANON).find((x) => new RegExp(`pack5-project${String(slot).padStart(2, '0')}-`).test(x));
  if (f === undefined) throw new Error(`no canonical capture for pack5 slot ${slot}`);
  return `${CANON}/${f}`;
};
/** MIDI note for a pitch token, C3 = 48 (the Circuit/plan convention). */
const PITCH: Record<string, number> = { e3: 52, 'f#3': 54, g3: 55, b3: 59, 'c#4': 61 };
/**
 * Expected external map: the GM drum number each role carries, plus the +12
 * `note_offset` the route is authored with (§0a measured the card's stored
 * midi2 at 48-61, "kick 48 / snare 50 / hats 54 / crash 61").
 */
const EXPECT_NOTE: Record<string, number> = {
  kick: 48,      // GM 36 bass drum
  snare: 50,     // GM 38 acoustic snare
  hat: 54,       // GM 42 closed hi-hat
  openhat: 58,   // GM 46 open hi-hat
  crash: 61,     // GM 49 crash 1
};

const roleNote = new Map<string, Set<number>>();
for (const st of staged) {
  const buf = new Uint8Array(readFileSync(canonFile(st.slot)));
  const chainM1 = getNoteChain(buf, 'midi1');
  const sceneEnd = getSceneChainEnd(buf);
  const layoutOk = st.layout === 'chain' ? chainM1 !== undefined : sceneEnd !== undefined;
  if (layoutOk) ok(`slot ${st.slot} canonical layout is ${st.layout} as staged`);
  else fail(`slot ${st.slot} canonical layout disagrees (chain=${JSON.stringify(chainM1)} sceneEnd=${sceneEnd})`);

  let padOk = 0; let drumOk = 0;
  for (let play = 0; play < st.order.length; play++) {
    const slotIdx = st.play_slots[play];
    const sec = st.sections[st.layout === 'chain' ? play : slotIdx];
    // ---- midi1: decoded-event identity (pitch / step / velocity / gate) ----
    const want = sec.voices.midi1.split(' ').flatMap((tok, i) => {
      if (tok === '~') return [];
      const [pitches, rest] = tok.split(':');
      const gate = Number(rest.split('@')[0]) * 6;
      const vel = Number(rest.split('@')[1]);
      return [{ step: i + 1, notes: pitches.split('+').map((p) => PITCH[p]).sort((a, b) => a - b), gate, vel }];
    });
    const got = decodeNotePattern(buf, 'midi1', slotIdx)
      .map((s, i) => ({ step: i + 1, notes: s.notes.map((x) => x.note).sort((a, b) => a - b), gate: s.notes[0]?.gate ?? 0, vel: s.notes[0]?.velocity ?? 0 }))
      .filter((s) => s.notes.length > 0);
    if (JSON.stringify(want) === JSON.stringify(got)) padOk++;
    else fail(`slot ${st.slot} play ${play + 1} (pattern ${slotIdx}) midi1 MISMATCH\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);

    // ---- midi2: per-step ROLE set vs per-step NOTE set (derives the map) ----
    const grid = Object.fromEntries(Object.entries(sec.voices).filter(([v]) => v !== 'midi1'));
    const gotSteps = decodeNotePattern(buf, 'midi2', slotIdx).map((s) => s.notes.map((x) => x.note).sort((a, b) => a - b));
    let stepBad = 0;
    for (let s = 0; s < 32; s++) {
      const roles = Object.entries(grid).filter(([, row]) => row[s] !== '.' && row[s] !== undefined).map(([v]) => v);
      const notes = gotSteps[s] ?? [];
      // FULL identity, not just the count: the staged roles, mapped through the
      // expected GM+12 map, must equal the notes the card actually holds on
      // that step. A single misplaced hit anywhere in the reconstruction fails.
      const wantNotes = roles.map((r) => EXPECT_NOTE[r]).sort((a, b) => a - b);
      if (JSON.stringify(wantNotes) !== JSON.stringify(notes)) {
        if (stepBad === 0) {
          fail(`slot ${st.slot} play ${play + 1} (pattern ${slotIdx}) midi2 step ${s + 1}: staged [${roles}] → [${wantNotes}], card holds [${notes}]`);
        }
        stepBad++;
        continue;
      }
      // Cross-check the map itself from the bytes, where a step pins it.
      if (roles.length === 1) {
        const set = roleNote.get(roles[0]) ?? new Set<number>();
        set.add(notes[0]); roleNote.set(roles[0], set);
      }
    }
    if (stepBad === 0) drumOk++;
    else fail(`slot ${st.slot} play ${play + 1} (pattern ${slotIdx}) midi2: ${stepBad} step(s) differ from the staged grid`);
  }
  if (padOk === st.order.length) ok(`slot ${st.slot}: midi1 decoded-event identity on all ${padOk} plays`);
  if (drumOk === st.order.length) ok(`slot ${st.slot}: midi2 per-step hit count matches the staged grid on all ${drumOk} plays`);
}
console.log('\n  derived role→note map from the canonical bytes:');
for (const [role, set] of [...roleNote].sort()) {
  const notes = [...set].sort((a, b) => a - b);
  const want = EXPECT_NOTE[role];
  if (notes.length === 1 && notes[0] === want) ok(`  ${role} → ${notes[0]} (GM+12 as §0a states)`);
  else fail(`  ${role} → ${JSON.stringify(notes)}, expected the single note ${want}`);
}

// ── 6. emit ──────────────────────────────────────────────────────────────────
const out = staged.map((s) => ({
  slot: s.slot, project_name: s.project_name, layout: s.layout,
  order: s.order, sections: s.sections, play_slots: s.play_slots,
  drums: s.drums, pad: s.pad,
}));
writeFileSync(`${ROOT}/samples/_scratch/amber-staged.json`, JSON.stringify(out, null, 1));
console.log(`\n${failures === 0 ? 'STAGING PASS' : `${failures} FAILURES`} — wrote amber-staged.json (${out.length} projects)`);
process.exitCode = failures === 0 ? 0 : 1;
