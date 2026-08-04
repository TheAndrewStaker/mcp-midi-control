/**
 * Clint Eastwood (Gorillaz, s8562 r6899599) Phase-0 staging — the plan
 * `docs/_private/rig/songs/clint-eastwood-rebuild-plan-2026-07-30.md` §4 Phase 0
 * step 3. READ-ONLY: no device, no network.
 *   Run: npx tsx samples/_scratch/clint-stage.ts
 *
 * Builds the EIGHT per-project `arrangement` payloads (Pack 5 slots 27-34) from
 * the PINNED cache (samples/songsterr-cache/s8562, rev 6899599) on the SETTLED
 * mapping (songs/clint-eastwood.md, 2026-07-29):
 *   - t6  Synth Bass 2      -> synth1 (written pitch; tool arg transpose:12)
 *   - t11 Electric Grand    -> synth2 (the Automator piano hook)
 *   - t12 String Ensemble   -> midi1  (MicroFreak ch3; replaces the dropped pad)
 *   - t14 Drums + t15 Perc  -> midi2  UNION, external SPD-SX (+12), and the
 *     internal condensed blend layer (condense_drums at the tool boundary)
 *
 * Staged folds (all BEFORE the writer, the Love Song / What I Got discipline):
 *   - drum_map timbale->tom (2 hits, m49; the kit's tom pad also carries the
 *     196 real toms, so the pad is SHARED — no dedicated pad here)
 *   - 128 off-grid t14 onsets snapped to the nearest 16th (asserted never to
 *     cross a bar line)
 *   - same-cell same-voice loudest-wins fold (§0b measures 6 collision cells
 *     on the raw union, before the timbale fold)
 *
 * Asserts (STOP on any failure):
 *   A. source census == plan §0b exactly (drift detection on the pinned cache)
 *   B. drum fold census: off-grid 128, zero bar-line crossers, nothing lost,
 *      no timbale survives, external note set == {48,50,54,57,58,61,68}
 *   C. the §1 part set builds: 63 windows, per-window step counts == §1
 *   D. THE CENSUS GATE: union letters derived from the STAGED ROWS (not from
 *      the source-event probe key) reproduce §1's letter strings EXACTLY —
 *      this is what makes the slot-31 fusion legal (8 cells / 4 scene runs)
 *   E. full-song coverage: every bar m1..m123 served exactly once
 *   F. tails (§4 step 13) + the crash-61 cell placement map + the m49 flourish
 *
 * Emits samples/_scratch/clint-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, flattenSongsterrDrums, flattenSongsterrMelodic,
  type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const CACHE = `${ROOT}/samples/songsterr-cache/s8562`;
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const meta = JSON.parse(readFileSync(`${CACHE}/meta.json`, 'utf8')) as { songId: number; revisionId: number };

const p6 = load(6);    // Synth Bass 2 -> synth1
const p11 = load(11);  // Electric Grand Piano -> synth2
const p12 = load(12);  // String Ensemble -> midi1
const p14 = load(14);  // Drums (Sample) -> midi2
const p15 = load(15);  // Percution -> midi2

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

console.log(`=== source: s${meta.songId} rev ${meta.revisionId} (cache pin) ===`);
if (meta.revisionId === 6899599) ok('cache revision 6899599 == the plan pin');
else fail(`cache revision ${meta.revisionId} != 6899599 — STOP`);

// ── A. source census gates (§0b) ──────────────────────────────────────
console.log('\n=== A. source census gates (§0b) ===');
const f14 = flattenSongsterrDrums(p14);
const f15 = flattenSongsterrDrums(p15);
const fS1 = flattenSongsterrMelodic(p6);
const fS2 = flattenSongsterrMelodic(p11);
const fM1 = flattenSongsterrMelodic(p12);
const measures = f14.measures;
const barLen = (m1: number): number => (measures[m1 - 1].signature[0] * 4) / measures[m1 - 1].signature[1];
const barStartBeat = (m1: number): number => measures[m1 - 1].startBeat;
const barStartStep = (m1: number): number => Math.round(barStartBeat(m1) * 4);
const barSteps = (m1: number): number => Math.round(barLen(m1) * 4);

{
  const sigs = measures.map((m) => `${m.signature[0]}/${m.signature[1]}`);
  const nonCommon = sigs.map((s, i) => [i + 1, s] as const).filter(([, s]) => s !== '4/4');
  if (measures.length === 123 && nonCommon.length === 1 && nonCommon[0][0] === 1 && nonCommon[0][1] === '2/4')
    ok('metre: 123 bars, m1 = 2/4 pickup, m2..m123 all 4/4 (§0b)');
  else fail(`metre drift: ${measures.length} bars, non-4/4 [${nonCommon.map(([m, s]) => `m${m} ${s}`).join(', ')}]`);
}
function melCensus(fl: ReturnType<typeof flattenSongsterrMelodic>, label: string,
  wantNotes: number, wantChord: number, wantLo: number, wantHi: number, wantVels: Record<string, number>): void {
  const vels = new Map<string, number>();
  for (const n of fl.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const byBeat = new Map<number, number>();
  for (const n of fl.notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = Math.max(...byBeat.values());
  const lo = Math.min(...fl.notes.map((n) => n.pitch));
  const hi = Math.max(...fl.notes.map((n) => n.pitch));
  const off = fl.notes.filter((n) => Math.abs(n.beat * 4 - Math.round(n.beat * 4)) > 1e-6).length;
  if (fl.notes.length === wantNotes && maxChord === wantChord && lo === wantLo && hi === wantHi && off === 0
    && eq(Object.fromEntries([...vels.entries()].sort()), wantVels))
    ok(`${label}: ${wantNotes} notes, max simultaneous ${wantChord}, range ${lo}..${hi} (stored +12 = ${lo + 12}..${hi + 12}), off-grid 0, vels ${JSON.stringify(wantVels)}`);
  else fail(`${label} census: notes ${fl.notes.length} chord ${maxChord} range ${lo}..${hi} off ${off} vels ${JSON.stringify([...vels])}`);
}
melCensus(fS1, 'synth1 t6 Synth Bass 2', 343, 1, 27, 41, { 120: 343 });
melCensus(fS2, 'synth2 t11 Electric Grand', 984, 3, 54, 64, { def: 984 });
melCensus(fM1, 'midi1 t12 String Ensemble', 364, 2, 63, 87, { def: 364 });
{
  const v14 = new Map<string, number>();
  for (const e of f14.events) v14.set(e.voice, (v14.get(e.voice) ?? 0) + 1);
  const want14 = { crash: 51, hat: 912, kick: 510, openhat: 2, snare: 304, timbale: 2, tom: 196 };
  if (f14.events.length === 1977 && eq(Object.fromEntries([...v14.entries()].sort()), Object.fromEntries(Object.entries(want14).sort())))
    ok('t14 Drums(Sample): 1977 events, kick 510 / hat 912 / snare 304 / tom 196 / crash 51 / openhat 2 / timbale 2 (§0b)');
  else fail(`t14 census ${f14.events.length} ${JSON.stringify([...v14])}`);
  const vv14 = new Map<string, number>();
  for (const e of f14.events) { const k = String(e.velocity ?? 'def'); vv14.set(k, (vv14.get(k) ?? 0) + 1); }
  if (eq(Object.fromEntries([...vv14.entries()].sort()), { 120: 350, 127: 2, def: 1625 }))
    ok('t14 velocities 120x350 / 127x2 / default x1625 (§0b)');
  else fail(`t14 velocity census ${JSON.stringify([...vv14])}`);
  const v15 = new Map<string, number>();
  for (const e of f15.events) v15.set(e.voice, (v15.get(e.voice) ?? 0) + 1);
  const vv15 = new Map<string, number>();
  for (const e of f15.events) { const k = String(e.velocity ?? 'def'); vv15.set(k, (vv15.get(k) ?? 0) + 1); }
  if (f15.events.length === 953 && eq(Object.fromEntries([...v15.entries()]), { perc: 953 })
    && eq(Object.fromEntries([...vv15.entries()].sort()), { 60: 357, def: 596 }))
    ok('t15 Percution: 953 events, ALL voice perc, 60x357 (soft layer) / default x596 (§0b)');
  else fail(`t15 census ${f15.events.length} ${JSON.stringify([...v15])} ${JSON.stringify([...vv15])}`);
  const off14 = f14.events.filter((e) => Math.abs(e.beat * 4 - Math.round(e.beat * 4)) > 1e-6).length;
  const off15 = f15.events.filter((e) => Math.abs(e.beat * 4 - Math.round(e.beat * 4)) > 1e-6).length;
  if (off14 === 128 && off15 === 0) ok('off-grid 16th onsets: t14 128, t15 0 (§0b — the snap-fold budget)');
  else fail(`off-grid t14 ${off14} (want 128), t15 ${off15} (want 0)`);
  // Kid Koala's t16 is EXCLUDED by fork Q3 default; prove it carries nothing mapped.
  const f16 = flattenSongsterrDrums(load(16));
  if (f16.events.length === 0 && f16.unmapped === 742 && eq(f16.unmapped_numbers, { 29: 326, 30: 416 }))
    ok('t16 Scratch board: 0 mapped events, 742 unmapped hits (GM 29 scratch-push x326 / 30 scratch-pull x416) — EXCLUDED by fork Q3 default (no SPD-SX role)');
  else fail(`t16 census events ${f16.events.length} unmapped ${f16.unmapped} ${JSON.stringify(f16.unmapped_numbers)}`);
}

// ── B. drum union fold at staging ─────────────────────────────────────
console.log('\n=== B. drum union fold at staging (§2 drum lane) ===');
const FOLD: Readonly<Record<string, string>> = { timbale: 'tom' };
const GM12: Readonly<Record<string, number>> = {
  kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, perc: 68,
};
const KIT_VOICES = Object.keys(GM12);
const barOfBeat = (beat: number): number => {
  for (let i = measures.length - 1; i >= 0; i--) if (beat >= measures[i].startBeat - 1e-9) return i + 1;
  return 1;
};
/**
 * Velocity resolution at staging: the source's explicit dynamic, else the 100
 * base. Emitted EXPLICITLY on every token so the stored row never depends on a
 * compile-time default.
 *
 * DELIBERATELY NOT the Sugar/What I Got `ghost ? 40` branch. This song's flatten
 * flags 1078 union events as ghosts (t14 snare 61 + tom 64; t15 perc ALL 953,
 * of which 596 carry no explicit dynamic), so that branch would author a FOURTH
 * dynamic level on 721 hits — two thirds of the new perc lane among them. The
 * plan's dynamic model is three levels and names them twice: §0b "350x120,
 * 2x127, rest default" / "357x60 (soft layer), rest default", and the §5 ear
 * checklist "accented hits (120) vs base (100) vs the soft perc layer (60)".
 * The plan wins; the ghost flags are reported, not applied.
 */
const velOf = (e: { velocity?: number; ghost?: boolean; accent?: boolean }): number => e.velocity ?? 100;
interface Cell { vel: number; srcs: number }
const cells = new Map<string, Cell>();  // `${globalStep}|${voice}` -> winner
{
  const raw = [
    ...f14.events.map((e) => ({ ...e, src: 't14' })),
    ...f15.events.map((e) => ({ ...e, src: 't15' })),
  ];
  if (raw.length === 2930) ok('union 2930 events (1977 t14 + 953 t15, §0b)');
  else fail(`union ${raw.length} != 2930`);
  // §0b's collision census, reproduced BEFORE the timbale fold (the plan's "6").
  {
    const seen = new Map<string, number>();
    for (const e of raw) {
      const k = `${Math.round(e.beat * 4)}|${e.voice}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const collisionCells = [...seen.values()].filter((n) => n > 1).length;
    if (collisionCells === 6) ok('6 same-step same-voice collision CELLS on the raw union (§0b), loudest-wins');
    else fail(`raw collision cells ${collisionCells} != 6`);
  }
  let offGrid = 0; let crossers = 0; let folds = 0; let timbaleFolded = 0;
  const offGridList: string[] = [];
  const foldsByVoice = new Map<string, number>();
  for (const e of raw) {
    const exact = e.beat * 4;
    const stepG = Math.round(exact);
    if (Math.abs(exact - stepG) > 1e-6) {
      offGrid++;
      if (offGridList.length < 12) offGridList.push(`m${barOfBeat(e.beat)} ${e.voice}`);
    }
    const bar = barOfBeat(e.beat);
    if (stepG < barStartStep(bar) || stepG >= barStartStep(bar) + barSteps(bar)) crossers++;
    const voice = FOLD[e.voice] ?? e.voice;
    if (FOLD[e.voice] !== undefined) timbaleFolded++;
    const vel = velOf(e);
    const key = `${stepG}|${voice}`;
    const ex = cells.get(key);
    if (ex === undefined) { cells.set(key, { vel, srcs: 1 }); continue; }
    folds++;
    foldsByVoice.set(voice, (foldsByVoice.get(voice) ?? 0) + 1);
    ex.vel = Math.max(ex.vel, vel);   // loudest wins
    ex.srcs++;
  }
  {
    const g = raw.filter((e) => e.ghost === true).length;
    const gNoVel = raw.filter((e) => e.ghost === true && e.velocity === undefined).length;
    const a = raw.filter((e) => e.accent === true).length;
    info(`importer flags on the union: ghosts ${g} (${gNoVel} without an explicit dynamic), accents ${a}. ` +
      'NOT applied as a 40 layer — the plan\'s model is three levels (120 / 100 / 60); see velOf.');
    const vm = new Map<number, number>();
    for (const c of cells.values()) vm.set(c.vel, (vm.get(c.vel) ?? 0) + 1);
    const got = Object.fromEntries([...vm.entries()].sort((x, y) => x[0] - y[0]));
    if (eq(got, { 60: 357, 100: 2215, 120: 350, 127: 2 }))
      ok(`stored drum velocity multiset ${JSON.stringify(got)} — 120 accents / 127 pair / 60 perc soft layer / 100 base (§0b + §5)`);
    else fail(`stored drum velocity multiset ${JSON.stringify(got)} != the plan's three-level model`);
  }
  // OLD-CARD ORACLE (t14 leg only): the 2026-07-17 build stored t14 alone, flat
  // at velocity 100, after the same timbale->tom fold. Its per-note cell counts
  // are a device-made artifact this staging must reproduce exactly on the
  // non-perc voices — an independent check on the snap + loudest-wins fold.
  {
    const perNote = new Map<number, number>();
    for (const key of cells.keys()) {
      const v = key.split('|')[1];
      if (v === 'perc') continue;
      const n = GM12[v];
      perNote.set(n, (perNote.get(n) ?? 0) + 1);
    }
    const got = Object.fromEntries([...perNote.entries()].sort((x, y) => x[0] - y[0]));
    const want = { 48: 510, 50: 304, 54: 912, 57: 198, 58: 2, 61: 45 };
    if (eq(got, want))
      ok('OLD-CARD ORACLE: the t14 leg\'s per-note cell counts {kick 510, snare 304, hat 912, tom 198 (196+2 timbale), openhat 2, crash 45 (51-6 folds)} ' +
        'reproduce the 2026-07-29 backup\'s stored midi2 EXACTLY — the snap + fold are device-cross-checked');
    else fail(`old-card oracle mismatch: staged ${JSON.stringify(got)} != card ${JSON.stringify(want)}`);
    const percCells = [...cells.keys()].filter((k) => k.endsWith('|perc')).length;
    if (percCells === 953) ok('perc lane 953 cells — entirely NEW capability (the old build had no t15 layer, §3)');
    else fail(`perc cells ${percCells} != 953`);
  }
  if (offGrid === 128) ok(`128 off-grid onsets snapped to the nearest 16th (Love Song method; e.g. ${offGridList.slice(0, 6).join(', ')}…)`);
  else fail(`off-grid snaps ${offGrid} != 128`);
  if (crossers === 0) ok('ZERO snapped onsets cross a bar line');
  else fail(`${crossers} snapped onsets crossed a bar line — STOP`);
  if (timbaleFolded === 2) ok('timbale->tom fold: 2 hits (m49), sharing the tom pad with the 196 real toms (carry-over row 2)');
  else fail(`timbale folds ${timbaleFolded} != 2`);
  if (cells.size + folds === 2930) ok(`cells ${cells.size} + folds ${folds} == 2930 (nothing lost)`);
  else fail(`cells ${cells.size} + folds ${folds} != 2930`);
  info(`same-cell folds by voice: ${[...foldsByVoice.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ') || '(none)'}`);
  const voices = new Set([...cells.keys()].map((k) => k.split('|')[1]));
  if ([...voices].every((v) => KIT_VOICES.includes(v)) && !voices.has('timbale'))
    ok(`folded voice set [${[...voices].sort().join(', ')}] — NO timbale survives; stored notes {${[...voices].map((v) => GM12[v]).sort((a, b) => a - b).join(',')}}`);
  else fail(`folded voice set [${[...voices].sort().join(', ')}]`);
}

// ── C. the §1 part set ────────────────────────────────────────────────
console.log('\n=== C. the part set (§1) ===');
interface Part { slot: number; project_name: string; spans: Array<[number, number]>; pc: number; expect: string }
const PARTS: Part[] = [
  { slot: 27, project_name: 'Clint 01 Intro', spans: [[1, 15]], pc: 90, expect: 'A B C B C B C D' },
  { slot: 28, project_name: 'Clint 02 Verse 1', spans: [[16, 31]], pc: 91, expect: 'E F G H I J I K' },
  { slot: 29, project_name: 'Clint 03 Chorus 1', spans: [[32, 41]], pc: 92, expect: 'L M N M O' },
  { slot: 30, project_name: 'Clint 04 Verse 2', spans: [[42, 57]], pc: 93, expect: 'P Q R S E F G T' },
  { slot: 31, project_name: 'Clint 05 Cho2 Solo1', spans: [[58, 67], [68, 84]], pc: 94, expect: 'U V U V W X Y Z Y Z Y Z a0 a1' },
  { slot: 32, project_name: 'Clint 06 Solo 2', spans: [[85, 103]], pc: 95, expect: 'a2 a3 a2 a3 a4 a5 a6 a7 a6 a8' },
  { slot: 33, project_name: 'Clint 07 Solo 3', spans: [[104, 117]], pc: 96, expect: 'M N a9 N M N M' },
  { slot: 34, project_name: 'Clint 08 Outro', spans: [[118, 123]], pc: 97, expect: 'N a10 a11' },
];
for (const p of PARTS) if (p.project_name.length > 32) fail(`slot ${p.slot} project_name > 32 chars`);

const MEL: Array<{ part: SongsterrPart; track: string }> = [
  { part: p6, track: 'synth1' }, { part: p11, track: 'synth2' }, { part: p12, track: 'midi1' },
];
const isRest = (t: string): boolean => t === '~';
const tokensOf = (row: string): string[] => row.trim().split(/\s+/);

interface WinRows { label: string; from: number; to: number; steps: number; voices: Record<string, string> }
let offGridMel = 0; let chordOverflow = 0; let melCrossers = 0; let outOfWindow = 0;
const fidelityUnion = new Map<string, string>();

function buildWindow(f: number, t: number): WinRows {
  let steps = 0;
  for (let m = f; m <= t; m++) steps += barSteps(m);
  const w: WinRows = { label: t > f ? `m${f}-${t}` : `m${f}`, from: f, to: t, steps, voices: {} };
  for (const { part, track } of MEL) {
    const imp = importSongsterrMelodic(part, { stepsPerBeat: 4, fromMeasure: f, toMeasure: t });
    if (imp.step_count !== steps) fail(`${w.label} ${track}: step_count ${imp.step_count} != ${steps}`);
    offGridMel += imp.off_grid; chordOverflow += imp.chord_overflow; outOfWindow += imp.out_of_window;
    for (const c of imp.cells) if (c.step * 6 + (c.gate_sixths ?? 6) > steps * 6) melCrossers++;
    for (const [fld, d] of Object.entries(imp.dropped_fidelity.not_parsed)) fidelityUnion.set(`${track}:${fld}`, `not_parsed (${(d as { count: number }).count})`);
    for (const [fld, d] of Object.entries(imp.dropped_fidelity.parsed_not_authored)) fidelityUnion.set(`${track}:${fld}`, `parsed_not_authored (${JSON.stringify(d)})`);
    const toks = tokensOf(imp.notation);
    if (toks.length !== steps) fail(`${w.label} ${track}: row ${toks.length} tokens != ${steps}`);
    if (toks.some((x) => !isRest(x))) w.voices[track] = toks.join(' ');
  }
  const s0 = barStartStep(f);
  const rows: Record<string, (number | undefined)[]> = {};
  const present = new Set<string>();
  for (const [key, c] of cells) {
    const stepG = Number(key.split('|')[0]);
    if (stepG < s0 || stepG >= s0 + steps) continue;
    const voice = key.split('|')[1];
    const dst = rows[voice] ?? (rows[voice] = Array.from({ length: steps }, () => undefined));
    dst[stepG - s0] = c.vel;
    present.add(voice);
  }
  for (const [v, row] of Object.entries(rows)) {
    w.voices[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
  }
  return w;
}

// Build every window of every project, in slot order (the letter-registry order).
const winsBySlot = new Map<number, WinRows[]>();
for (const p of PARTS) {
  const wins: WinRows[] = [];
  for (const [f, t] of p.spans) {
    for (let m = f; m <= t; m += 2) wins.push(buildWindow(m, Math.min(m + 1, t)));
  }
  winsBySlot.set(p.slot, wins);
  const stepsList = wins.map((w) => w.steps);
  console.log(`  slot ${p.slot} "${p.project_name}": ${wins.length} windows [${wins.map((w) => w.label).join(' ')}] steps [${stepsList.join(',')}]`);
  for (const w of wins) if (Object.keys(w.voices).length === 0) fail(`slot ${p.slot} ${w.label}: window has NO voices (the writer requires >=1)`);
}
if (offGridMel === 0) ok('melodic import off_grid 0 across all 63 windows'); else fail(`melodic off_grid ${offGridMel}`);
if (chordOverflow === 0) ok('chord_overflow 0 (max 3 simultaneous <= the 6-note step cap)'); else fail(`chord_overflow ${chordOverflow}`);
if (outOfWindow === 0) ok('out_of_window 0 (no onset rounded off a window grid)'); else fail(`out_of_window ${outOfWindow}`);
info(`melodic cells whose gate reaches past their window end: ${melCrossers} (clamped by the row layout; the wrap is the section seam)`);

// ── D. THE CENSUS GATE: staged-row union letters == §1 ────────────────
console.log('\n=== D. census gate: staged-row union letters == §1 ===');
const letterOf = new Map<string, string>();
const sigOf = (w: WinRows): string => `${w.steps}|` + JSON.stringify(Object.fromEntries(Object.entries(w.voices).sort()));
const nextLetter = (): string => {
  const n = letterOf.size;
  return n < 26 ? String.fromCharCode(65 + n) : `a${n - 26}`;
};
const lettersBySlot = new Map<number, string[]>();
for (const p of PARTS) {
  const letters = winsBySlot.get(p.slot)!.map((w) => {
    const sig = sigOf(w);
    let l = letterOf.get(sig);
    if (l === undefined) { l = nextLetter(); letterOf.set(sig, l); }
    return l;
  });
  lettersBySlot.set(p.slot, letters);
  if (letters.join(' ') === p.expect) ok(`slot ${p.slot}: ${letters.join(' ')}  (${new Set(letters).size} cells / ${letters.length} plays) == §1`);
  else fail(`slot ${p.slot} letters "${letters.join(' ')}" != §1 "${p.expect}" — STOP, the fusion's cell budget is measured on §1`);
}
if (letterOf.size === 38) ok('38 global union cells across the part set (§1)');
else fail(`global union cells ${letterOf.size} != 38`);

// ── E. full-song coverage ─────────────────────────────────────────────
console.log('\n=== E. coverage ===');
{
  const served = new Map<number, number>();
  for (const wins of winsBySlot.values()) for (const w of wins) for (let m = w.from; m <= w.to; m++) served.set(m, (served.get(m) ?? 0) + 1);
  const missing: number[] = []; const doubled: number[] = [];
  for (let m = 1; m <= 123; m++) { const n = served.get(m) ?? 0; if (n === 0) missing.push(m); else if (n > 1) doubled.push(m); }
  if (missing.length === 0 && doubled.length === 0 && served.size === 123)
    ok('full-song coverage: 63 windows serve every bar m1..m123 exactly once, zero dropped content (carry-over row 5)');
  else fail(`coverage: missing [${missing.join(',')}] doubled [${doubled.join(',')}]`);
}

// ── F. sections + order per project (dedupe by staged-row identity) ───
console.log('\n=== F. sections + order (the writer\'s layout) ===');
interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface Staged {
  slot: number; project_name: string; pc: number; layout: 'chain' | 'scenes';
  order: string[]; sections: StagedSection[]; expect_letters: string;
}
const staged: Staged[] = [];
for (const p of PARTS) {
  const wins = winsBySlot.get(p.slot)!;
  const sections: StagedSection[] = [];
  const byLetter = new Map<string, string>();  // letter -> section name
  const letters = lettersBySlot.get(p.slot)!;
  const order: string[] = [];
  wins.forEach((w, i) => {
    const l = letters[i];
    let name = byLetter.get(l);
    if (name === undefined) {
      name = w.label;
      byLetter.set(l, name);
      sections.push({ name, steps: w.steps, voices: w.voices });
    } else {
      // Identity is what the letter MEANS; re-assert it on the staged rows.
      const first = sections.find((s) => s.name === name)!;
      if (!eq(first.voices, w.voices) || first.steps !== w.steps) fail(`slot ${p.slot} ${w.label}: letter ${l} but rows differ from ${name} — STOP`);
    }
    order.push(name);
  });
  const layout: 'chain' | 'scenes' = order.length <= 8 ? 'chain' : 'scenes';
  // Reproduce the writer's greedy run-compression so the plan's scene table is
  // asserted HERE, before any device contact.
  const idx = order.map((n) => sections.findIndex((s) => s.name === n));
  const runs: Array<{ start: number; end: number }> = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && i === last.end + 1) last.end = i; else runs.push({ start: i, end: i });
  }
  const runDesc = runs.map((r) => (r.start === r.end ? `[${r.start + 1}]` : `[${r.start + 1}-${r.end + 1}]`)).join('');
  if (layout === 'scenes') {
    const wantRuns = p.slot === 31 ? '[1-2][1-6][5-6][5-8]' : '[1-2][1-6][5][7]';
    if (runs.length <= 4 && runDesc === wantRuns)
      ok(`slot ${p.slot}: SCENES ${runDesc} (${runs.length} steps, ${sections.length} stored patterns, ${order.length} plays) == §1`);
    else fail(`slot ${p.slot} scene runs ${runDesc} (${runs.length} steps) != ${wantRuns} — STOP`);
  } else {
    ok(`slot ${p.slot}: CHAIN patterns 1..${order.length} (${sections.length} distinct cells, duplicated where a cell replays)`);
  }
  staged.push({ slot: p.slot, project_name: p.project_name, pc: p.pc, layout, order, sections, expect_letters: p.expect });
}

// Length bytes the device will store (steps-1 per authored pattern slot).
console.log('\n=== F2. stored pattern lengths (§4 step 13) ===');
for (const st of staged) {
  const lens = st.layout === 'chain'
    ? st.order.map((n) => st.sections.find((s) => s.name === n)!.steps)
    : st.sections.map((s) => s.steps);
  const bytes = lens.map((n) => n - 1);
  const want = st.slot === 27 ? [23, 31, 31, 31, 31, 31, 31, 15]
    : st.slot === 31 ? [31, 31, 31, 31, 31, 31, 31, 15]
      : st.slot === 32 ? [31, 31, 31, 31, 31, 31, 15]
        : st.slot === 29 ? [31, 31, 31, 31, 31]
          : st.slot === 33 ? [31, 31, 31, 31, 31, 31, 31]
            : st.slot === 34 ? [31, 31, 31]
              : [31, 31, 31, 31, 31, 31, 31, 31];
  if (eq(bytes, want)) ok(`slot ${st.slot} length bytes [${bytes.join(',')}] == §4 step 13`);
  else fail(`slot ${st.slot} length bytes [${bytes.join(',')}] != [${want.join(',')}]`);
}

// ── G. tails, crash placement, the m49 flourish ───────────────────────
console.log('\n=== G. tails + crash-61 placement + m49 flourish (§4 step 13) ===');
const cellHas = (w: WinRows, voice: string): boolean => w.voices[voice] !== undefined;
const drumBar = (w: WinRows, bar: number): string[] => {
  const off = barStartStep(bar) - barStartStep(w.from);
  const n = barSteps(bar);
  const out: string[] = [];
  for (const v of KIT_VOICES) {
    const row = w.voices[v];
    if (row === undefined) continue;
    tokensOf(row).forEach((tok, i) => {
      if (isRest(tok) || i < off || i >= off + n) return;
      const m = /@(\d+)/.exec(tok);
      out.push(`${v}@${i - off}${m ? `v${m[1]}` : ''}`);
    });
  }
  return out.sort();
};
{
  // Crash-bearing letters, per project, from the STAGED rows.
  const WANT_CRASH: Record<number, string[]> = {
    27: ['A', 'D'], 28: ['E', 'K'], 29: ['L', 'O'], 30: ['P', 'S', 'E'],
    31: ['W', 'X', 'a0', 'a1'], 32: ['a4'], 33: [], 34: ['a10', 'a11'],
  };
  for (const p of PARTS) {
    const wins = winsBySlot.get(p.slot)!;
    const letters = lettersBySlot.get(p.slot)!;
    const got = [...new Set(wins.map((w, i) => (cellHas(w, 'crash') ? letters[i] : '')).filter(Boolean))];
    const want = WANT_CRASH[p.slot];
    if (eq([...got].sort(), [...want].sort())) ok(`slot ${p.slot} crash-61 cells [${got.join(',') || '(none)'}] == §4 step 13`);
    else fail(`slot ${p.slot} crash cells [${got.join(',')}] != [${want.join(',')}]`);
  }
}
{
  // slot 27 pattern 8 = m15 ALONE: 16 steps, the bass pickup + a crash.
  const w = winsBySlot.get(27)![7];
  const d = drumBar(w, 15);
  if (w.label === 'm15' && w.steps === 16 && cellHas(w, 'synth1') && d.some((x) => x.startsWith('crash')))
    ok(`slot 27 pat 8 = m15 alone (16 steps): the bass pickup enters + crash [${d.join(' ')}]`);
  else fail(`slot 27 tail: ${w.label} steps ${w.steps} synth1=${cellHas(w, 'synth1')} drums [${d.join(' ')}]`);
  // The Intro head is the fused 2/4 pickup + m2 = 24 steps.
  const h = winsBySlot.get(27)![0];
  if (h.label === 'm1-2' && h.steps === 24 && drumBar(h, 1).some((x) => x.startsWith('crash')) && drumBar(h, 1).some((x) => x.startsWith('kick')))
    ok('slot 27 pat 1 = m1+m2 fused, 24 steps, the half-bar crash+kick pickup on the head (§0b)');
  else fail(`slot 27 head ${h.label} steps ${h.steps} m1 drums [${drumBar(h, 1).join(' ')}]`);
  // Bass silent until m15.
  const bassBefore = winsBySlot.get(27)!.slice(0, 7).some((x) => cellHas(x, 'synth1'));
  if (!bassBefore) ok('slot 27: synth1 (bass) silent m1-14, entering only at m15 (§0b, the interview P1 choice)');
  else fail('slot 27: bass sounds before m15');
}
{
  const w31 = winsBySlot.get(31)![13];
  if (w31.label === 'm84' && w31.steps === 16 && drumBar(w31, 84).some((x) => x.startsWith('crash')))
    ok('slot 31 pat 8 = m84 turnaround (16 steps, crash) — hands off to the Solo 2 stomp');
  else fail(`slot 31 tail ${w31.label} steps ${w31.steps} [${drumBar(w31, 84).join(' ')}]`);
  const w32 = winsBySlot.get(32)![9];
  if (w32.label === 'm103' && w32.steps === 16) ok('slot 32 pat 7 = m103 (16 steps)');
  else fail(`slot 32 tail ${w32.label} steps ${w32.steps}`);
  const w34 = winsBySlot.get(34)![2];
  const d = drumBar(w34, 122).concat(drumBar(w34, 123));
  if (w34.label === 'm122-123' && d.some((x) => x.startsWith('crash'))) ok(`slot 34 pat 3 = m122-123, the final crash pair [${d.filter((x) => x.startsWith('crash')).join(' ')}]`);
  else fail(`slot 34 tail ${w34.label} [${d.join(' ')}]`);
}
{
  // The m49 flourish: slot 30 pattern 4 (cell S) = tom + openhat + the timbale
  // fold + crash, all inside the one bar.
  const w = winsBySlot.get(30)![3];
  const d = drumBar(w, 49);
  const has = (v: string): boolean => d.some((x) => x.startsWith(v));
  if (w.label === 'm48-49' && has('tom') && has('openhat') && has('crash'))
    ok(`m49 flourish in slot 30 pat 4 (cell S): tom 57 + openhat 58 + timbale-fold + crash 61 [${d.join(' ')}]`);
  else fail(`m49 flourish: ${w.label} [${d.join(' ')}]`);
}
{
  // Strings: enter at m24 (slot 28 window 5), drop out after m96 (slot 32).
  const s28 = winsBySlot.get(28)!;
  const firstStr = s28.findIndex((w) => cellHas(w, 'midi1'));
  if (firstStr === 4 && s28[4].label === 'm24-25') ok('strings (midi1) enter at m24 — slot 28 window 5 (the ear checklist\'s "halfway")');
  else fail(`strings first appear at slot 28 window ${firstStr + 1} (${s28[firstStr]?.label})`);
  const s32 = winsBySlot.get(32)!;
  const lastStr = s32.map((w) => cellHas(w, 'midi1')).lastIndexOf(true);
  if (lastStr === 5 && s32[5].label === 'm95-96') ok('strings drop out after m96 — slot 32 window 6 is their last (source-true, §1 note)');
  else fail(`strings last sound in slot 32 window ${lastStr + 1} (${s32[lastStr]?.label})`);
  // Slot 30: piano (synth2) silent for the first half of Verse 2.
  const s30 = winsBySlot.get(30)!;
  const pianoFirst = s30.findIndex((w) => cellHas(w, 'synth2'));
  if (pianoFirst === 4) ok('slot 30: piano (synth2) drops out for the first half of Verse 2, back at m50 (source-true)');
  else fail(`slot 30 piano first window ${pianoFirst + 1}`);
  // Slot 33: drums hold ONE cell for all 14 bars.
  const s33 = winsBySlot.get(33)!;
  const drumSigs = new Set(s33.map((w) => KIT_VOICES.map((v) => w.voices[v] ?? '').join('|')));
  if (drumSigs.size === 1) ok('slot 33: the drum lane holds ONE groove across all 14 bars (the M/N alternation is bass+piano only, §1)');
  else fail(`slot 33 drum lane has ${drumSigs.size} distinct rows`);
}

// ── H. realized totals + emit ─────────────────────────────────────────
console.log('\n=== H. realized totals ===');
{
  const totals = new Map<string, number>();
  const vels = new Map<string, Map<string, number>>();
  const pitchesOfTok = (t: string): number => t.split(/[:@_]/)[0].split('+').length;
  for (const st of staged) {
    for (const name of st.order) {
      const sec = st.sections.find((s) => s.name === name)!;
      for (const track of ['synth1', 'synth2', 'midi1']) {
        const row = sec.voices[track];
        if (row === undefined) continue;
        for (const tok of tokensOf(row)) {
          if (isRest(tok)) continue;
          const n = pitchesOfTok(tok);
          totals.set(track, (totals.get(track) ?? 0) + n);
          const m = /@(\d+)/.exec(tok);
          const k = m ? m[1] : 'def';
          const vm = vels.get(track) ?? new Map<string, number>();
          vm.set(k, (vm.get(k) ?? 0) + n);
          vels.set(track, vm);
        }
      }
      for (const v of KIT_VOICES) {
        const row = sec.voices[v];
        if (row === undefined) continue;
        totals.set('midi2', (totals.get('midi2') ?? 0) + tokensOf(row).filter((x) => !isRest(x)).length);
      }
    }
  }
  for (const [k, n] of [...totals.entries()].sort()) info(`realized ${k}: ${n} segments/hits over the full 123-bar performance`);
  for (const [tr, vm] of [...vels.entries()].sort()) info(`  ${tr} velocity multiset: ${JSON.stringify(Object.fromEntries([...vm.entries()].sort()))}`);
  const s1 = totals.get('synth1') ?? 0;
  if (s1 >= 343) ok(`synth1 realized ${s1} segments >= 343 source onsets (${s1 - 343} ceiling/tie splits)`);
  else fail(`synth1 realized ${s1} < 343`);
  const m1 = totals.get('midi1') ?? 0;
  if (m1 >= 364) ok(`midi1 (strings) realized ${m1} >= 364 source onsets (${m1 - 364} splits)`);
  else fail(`midi1 realized ${m1} < 364`);
  const m2 = totals.get('midi2') ?? 0;
  if (m2 === cells.size) ok(`midi2 realized ${m2} == the folded timeline's ${cells.size} cells (every drum cell stored exactly once)`);
  else fail(`midi2 realized ${m2} != folded timeline ${cells.size}`);
}
{
  const stored = new Set<number>();
  for (const st of staged) for (const s of st.sections) for (const v of Object.keys(s.voices)) if (GM12[v] !== undefined) stored.add(GM12[v]);
  const notes = [...stored].sort((a, b) => a - b);
  if (eq(notes, [48, 50, 54, 57, 58, 61, 68]))
    ok('external note set {48,50,54,57,58,61,68} EXACT (kick/snare/hat/tom/openhat/crash/perc, GM+12)');
  else fail(`external note set [${notes.join(',')}]`);
}

console.log('\n=== dropped-fidelity union (melodic import) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);

writeFileSync(`${ROOT}/samples/_scratch/clint-staged.json`, JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : `${failures} FAILURES`} — staged JSON written to samples/_scratch/clint-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
