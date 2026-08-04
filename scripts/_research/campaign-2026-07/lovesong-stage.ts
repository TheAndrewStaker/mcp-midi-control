/**
 * Love Song (311's Cure cover, s671 r3982169) Phase-0 staging — mirror of
 * smooth-stage.ts machinery, SINGLE-part drums. READ-ONLY: no device, no
 * network. Run: npx tsx samples/_scratch/lovesong-stage.ts
 *
 * Builds the FIVE per-project `arrangement` payloads (Pack 4 slots 25-29)
 * from the PINNED cache (samples/songsterr-cache/s671, rev 3982169) via:
 *   - p5 Tim Mahoney Rhythm 2 (Electric Guitar jazz) -> synth2 via the EXACT
 *     import path (importSongsterrMelodic), stored SILENT (universal 0/0).
 *   - p7 Chad Sexton kit -> midi2 external + condensed internal. FLATTEN,
 *     SNAP (nearest 16th), FOLD AT STAGING (deterministic loudest-wins, the
 *     Smooth dev.3 discipline): (i) the tab's doubled kicks collapse
 *     same-cell; (ii) the two 32nd snare drags merge onto their 16th cells
 *     (plan §0b: one v40 ghost pickup + the full backbeat). timbale -> tom
 *     (the Clint precedent; a DEDICATED pad, the kit has no other toms).
 * Asserts (plan §4 Phase 0 step 2): source census (§0a/§0b); packing per §1;
 * t5 census (2142 notes, max chord 4, off_grid 0, chord_overflow 0, 28 ties,
 * velocity multiset == §0f); kit fold census (doubled-kick same-cell folds
 * counted exactly, drag-collapse cells enumerated, ghost absorption counted);
 * external note set == §2b {48,50,54,57,58,61,63}; per-hit velocity multisets
 * exact; §0e elision (zero sustain crossers, zero seam ties/end clips); every
 * §3 tail decode assertion incl. m61 all-rest; the m1 pickup's 8-step form.
 * Emits samples/_scratch/lovesong-staged.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, flattenSongsterrDrums, flattenSongsterrMelodic,
  pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s671';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const p5 = load(5);  // Tim Mahoney Rhythm 2 (jazz) -> synth2
const p7 = load(7);  // Chad Sexton kit -> midi2 + condensed internal

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── A. source census gates (plan §0a/§0b — source drift detection) ────
console.log('=== A. source census gates ===');
const kit = flattenSongsterrDrums(p7);
const t5 = flattenSongsterrMelodic(p5);
const measures = kit.measures;
if (measures.length === 61 && eq(measures[0].signature, [2, 4])
  && measures.slice(1).every((m) => m.signature[0] === 4 && m.signature[1] === 4))
  ok('61 measures: 2/4 x1 (m1 pickup) + 4/4 x60');
else fail(`measures ${measures.length}, signature drift`);
if (kit.events.length === 2018 && kit.ghosts === 7 && kit.accents === 0 && kit.unmapped === 0
  && kit.flams_collapsed === 0 && kit.graces_folded === 0)
  ok('kit p7: 2018 events, 7 ghosts, 0 accents/flams/graces/unmapped');
else fail(`kit census ${kit.events.length}/${kit.ghosts}/${kit.accents}/${kit.unmapped}/${kit.flams_collapsed}/${kit.graces_folded}`);
{
  const kv = new Map<string, number>();
  for (const e of kit.events) kv.set(e.voice, (kv.get(e.voice) ?? 0) + 1);
  const want = { kick: 910, ride: 412, hat: 399, snare: 119, timbale: 112, crash: 41, openhat: 25 };
  if (eq(Object.fromEntries([...kv.entries()].sort()), Object.fromEntries(Object.entries(want).sort())))
    ok('kit voices kick910/ride412/hat399/snare119/timbale112/crash41/openhat25');
  else fail(`kit voice census ${JSON.stringify([...kv])}`);
  const vv = new Map<string, number>();
  for (const e of kit.events) { const k = String(e.velocity ?? 'default'); vv.set(k, (vv.get(k) ?? 0) + 1); }
  if (eq(Object.fromEntries([...vv.entries()].sort()), { '112': 250, '90': 725, default: 1043 }))
    ok('kit velocity census 112 x250 / 90 x725 / default x1043 (§0b)');
  else fail(`kit velocity census ${JSON.stringify([...vv])}`);
  // DEVIATION FROM PLAN §0b (found at staging): the probe's velocity census
  // conflated true-plain hits with fff-marked ones — the flatten omits the
  // velocity NUMBER when the ladder value equals the accent flag default
  // (fff = 120 = ACCENT_HIT_VELOCITY), leaving accent=true only. The wire
  // path (quantize + Smooth velOfStep) stores those at 120. The tab DOES
  // carry a third loud class on the kit: fff x30. Named + enumerated here.
  const fffEvents = kit.events.filter((e) => e.accent === true && e.velocity === undefined);
  const ghostVel = kit.events.filter((e) => e.ghost === true && e.velocity !== undefined).length;
  if (fffEvents.length === 30) {
    const byBar = new Map<string, number>();
    for (const e of fffEvents) {
      let mi = 0;
      while (mi < measures.length - 1 && measures[mi + 1].startBeat <= e.beat + 1e-9) mi++;
      const k = `m${mi + 1}:${e.voice}`;
      byBar.set(k, (byBar.get(k) ?? 0) + 1);
    }
    ok(`fff class: 30 velocity-less accent events store at 120 (the wire-path value; plan §0b's "default x1043" split is really 30 fff + 7 ghosts + 1006 plain)`);
    info(`fff hits by bar: ${[...byBar.entries()].sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
  } else fail(`fff-class census ${fffEvents.length} != 30`);
  if (ghostVel === 0) ok('every ghost is velocity-less (stores 40)');
  else fail(`${ghostVel} ghosts carry explicit velocity`);
}
{
  const vels = new Map<string, number>();
  for (const n of t5.notes) { const k = String(n.velocity ?? 'def'); vels.set(k, (vels.get(k) ?? 0) + 1); }
  const ties = t5.notes.filter((n) => n.tie === true).length;
  const lo = Math.min(...t5.notes.map((n) => n.pitch)); const hi = Math.max(...t5.notes.map((n) => n.pitch));
  const byBeat = new Map<number, number>();
  for (const n of t5.notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const maxChord = Math.max(...byBeat.values());
  const offT5 = t5.notes.filter((n) => Math.abs(n.beat * 4 - Math.round(n.beat * 4)) > 1e-6).length;
  if (t5.notes.length === 2142 && maxChord === 4 && ties === 28 && offT5 === 0
    && pitchToken(lo) === 'd3' && pitchToken(hi) === 'a4')
    ok('t5: 2142 notes, max chord 4, 28 ties folded, off-grid 0, range d3-a4 (§0a)');
  else fail(`t5 census notes ${t5.notes.length} chord ${maxChord} ties ${ties} off ${offT5} range ${pitchToken(lo)}-${pitchToken(hi)}`);
  if (eq(Object.fromEntries([...vels.entries()].sort()), { '42': 1142, '60': 16, '63': 12, '90': 7, def: 965 }))
    ok('t5 velocity multiset 42 x1142 / 60 x16 / 63 x12 / 90 x7 / def x965 (§0f)');
  else fail(`t5 velocity multiset ${JSON.stringify([...vels])}`);
}

// ── B. kit SNAP (nearest 16th) + FOLD (staging, loudest-wins) ─────────
console.log('\n=== B. kit snap + fold at staging (§0b/§2b) ===');
const FOLD: Readonly<Record<string, string>> = { timbale: 'tom' };
interface Cell { vel: number; srcs: number; ghostAbsorbed: number; velDiffer: boolean }
const barStartStep = (m1based: number): number => Math.round(measures[m1based - 1].startBeat * 4);
const barEndStep = (m1based: number): number =>
  m1based < measures.length ? barStartStep(m1based + 1) : Math.round(kit.totalBeats * 4);
const cells = new Map<string, Cell>();  // `${stepG}|${voice}` -> winner
let offGridKit = 0; let crossers = 0;
let folds = 0; let velDiffFolds = 0; let ghostAbsorbed = 0;
const foldsByVoice = new Map<string, number>();
const dragCells: string[] = [];
const kickBeats = new Map<string, number>();
for (const e of kit.events) {
  if (e.voice === 'kick') kickBeats.set(e.beat.toFixed(6), (kickBeats.get(e.beat.toFixed(6)) ?? 0) + 1);
}
const kickExactDoubles = [...kickBeats.values()].reduce((a, n) => a + (n - 1), 0);
for (const e of kit.events) {
  const exact = e.beat * 4;
  const stepG = Math.round(exact);
  const offG = Math.abs(exact - stepG) > 1e-6;
  if (offG) offGridKit++;
  // bar containing the RAW beat vs bar containing the snapped step
  let rawBar = 0;
  while (rawBar < measures.length - 1 && measures[rawBar + 1].startBeat <= e.beat + 1e-9) rawBar++;
  if (stepG < barStartStep(rawBar + 1) - 0 || stepG >= barEndStep(rawBar + 1)) {
    // snapped into a different bar: only a problem if it changes WINDOW (all
    // windows are bar-aligned, so a bar change IS a potential window change)
    crossers++;
  }
  const voice = FOLD[e.voice] ?? e.voice;
  // The exact wire-path effective velocity (quantizeDrumEvents loudness /
  // Smooth velOfStep): explicit number > ghost 40 > accent 120 > plain 100.
  const vel = e.velocity ?? (e.ghost === true ? 40 : e.accent === true ? 120 : 100);
  const key = `${stepG}|${voice}`;
  const ex = cells.get(key);
  if (ex === undefined) {
    cells.set(key, { vel, srcs: 1, ghostAbsorbed: 0, velDiffer: false });
  } else {
    folds++;
    foldsByVoice.set(voice, (foldsByVoice.get(voice) ?? 0) + 1);
    if (ex.vel !== vel) { velDiffFolds++; ex.velDiffer = true; }
    if (Math.min(ex.vel, vel) === 40 && (ex.vel !== 40 || vel !== 40)) { ghostAbsorbed++; ex.ghostAbsorbed++; }
    if (ex.vel === 40 && vel === 40) { ghostAbsorbed++; ex.ghostAbsorbed++; } // ghost-into-ghost fold
    ex.vel = Math.max(ex.vel, vel);
    ex.srcs++;
    if (offG || e.ghost === true) dragCells.push(`${key} (m${rawBar + 1})`);
  }
}
if (offGridKit === 16) ok('kit off-grid onsets 16 of 2018 (0.8%, §0b) — snapped to nearest 16th');
else fail(`kit off-grid ${offGridKit} != 16`);
if (crossers === 0) ok('ZERO snaps cross a bar line (no window-crossing rounds; §0e-adjacent)');
else fail(`${crossers} snapped onsets crossed a bar line — window content would shift`);
if (cells.size + folds === 2018) ok(`cells ${cells.size} + folds ${folds} == 2018 (nothing lost)`);
else fail(`cells ${cells.size} + folds ${folds} != 2018`);
info(`same-cell folds: ${folds} total (velocity-differing ${velDiffFolds}); by voice: ${[...foldsByVoice.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
info(`kick folds from EXACT-same-beat doubles (flatten lens): ${kickExactDoubles}; snap-lens kick folds: ${foldsByVoice.get('kick') ?? 0} (difference = snap-induced merges)`);
if ((foldsByVoice.get('kick') ?? 0) >= kickExactDoubles) ok('kick fold count >= exact-beat double count (consistent lenses)');
else fail('kick folds fewer than exact-beat doubles — impossible');
info(`ghost absorption at fold: ${ghostAbsorbed} of 7 source ghosts absorbed/merged; drag-collapse fold cells: ${[...new Set(dragCells)].join(', ') || '(none)'}`);
{
  const multiset = new Map<number, number>();
  for (const c of cells.values()) multiset.set(c.vel, (multiset.get(c.vel) ?? 0) + 1);
  info(`post-fold cell velocity multiset: ${[...multiset.entries()].sort((a, b) => b[0] - a[0]).map(([v, n]) => `${v} x${n}`).join(', ')}`);
}

// ── C. project set (plan §1: Pack 4 slots 25-29) ─────────────────────
const win2 = (from: number, to: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let m = from; m <= to; m += 2) out.push([m, m + 1]);
  return out;
};
interface Proj { slot: number; project_name: string; windows: Array<[number, number]>; expectSteps: number[] }
const PROJECTS: Proj[] = [
  { slot: 25, project_name: 'Love Song 1 Intro', windows: [[1, 1], ...win2(2, 9)], expectSteps: [8, 32, 32, 32, 32] },
  { slot: 26, project_name: 'Love Song 2 Vrs1Intl', windows: win2(10, 21), expectSteps: Array(6).fill(32) },
  { slot: 27, project_name: 'Love Song 3 Vrs2Cho1', windows: [...win2(22, 35), [36, 36]], expectSteps: [...Array(7).fill(32), 16] },
  { slot: 28, project_name: 'Love Song 4 SoloVrs3', windows: win2(37, 52), expectSteps: Array(8).fill(32) },
  { slot: 29, project_name: 'Love Song 5 Chorus2', windows: [...win2(53, 60), [61, 61]], expectSteps: [32, 32, 32, 32, 16] },
];
for (const pr of PROJECTS) if (pr.project_name.length > 32) fail(`slot ${pr.slot} name > 32 chars`);

// token helpers (verbatim smooth/billiejean-stage)
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
const edgeInstances: string[] = [];
let offGridT5 = 0; let totChordOverflow = 0;
const winsBySlot = new Map<number, WinVoices[]>();
const fidelityUnion = new Map<string, string>();
const t5StagedVels = new Map<string, number>();
let t5StagedPitches = 0;
const drumStagedVels = new Map<number, Map<number, number>>(); // slot -> vel -> count
const KIT_VOICES = ['kick', 'snare', 'hat', 'openhat', 'crash', 'ride', 'tom'];

for (const pr of PROJECTS) {
  console.log(`\n=== slot ${pr.slot} "${pr.project_name}" ===`);
  const wins: WinVoices[] = pr.windows.map(([f, t]) => ({
    name: `m${f}${t !== f ? '-' + t : ''}`,
    steps: barEndStep(t) - barStartStep(f), from: f, to: t, voices: {},
  }));
  const steps = wins.map((w) => w.steps);
  if (eq(steps, pr.expectSteps)) ok(`packing [${steps}]`);
  else fail(`slot ${pr.slot} packing [${steps}] != [${pr.expectSteps}]`);

  // drums: folded cells -> per-window rows with per-hit @vel
  const slotVels = new Map<number, number>();
  drumStagedVels.set(pr.slot, slotVels);
  for (const w of wins) {
    const s0 = barStartStep(w.from); const s1 = s0 + w.steps;
    const rows: Record<string, (number | undefined)[]> = {};
    for (const [key, c] of cells) {
      const [stepS, voice] = key.split('|');
      const stepG = Number(stepS);
      if (stepG < s0 || stepG >= s1) continue;
      const dst = rows[voice] ?? (rows[voice] = Array.from({ length: w.steps }, () => undefined));
      dst[stepG - s0] = c.vel;
      slotVels.set(c.vel, (slotVels.get(c.vel) ?? 0) + 1);
    }
    for (const [v, row] of Object.entries(rows)) {
      if (!KIT_VOICES.includes(v)) fail(`slot ${pr.slot} ${w.name}: unexpected folded voice "${v}"`);
      w.voices[v] = row.map((x) => (x === undefined ? '~' : `${v}@${x}`)).join(' ');
    }
  }

  // melodic t5 -> synth2 with the cross-window edge-tie machinery (expect ZERO)
  {
    let carry: Carry | undefined;
    const rows: string[][] = [];
    for (let wi = 0; wi < wins.length; wi++) {
      const w = wins[wi];
      const imp = importSongsterrMelodic(p5, { stepsPerBeat: 4, fromMeasure: w.from, toMeasure: w.to });
      if (imp.step_count !== w.steps) fail(`slot ${pr.slot} synth2 ${w.name} step_count ${imp.step_count} != ${w.steps}`);
      offGridT5 += imp.off_grid; totChordOverflow += imp.chord_overflow;
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.not_parsed)) fidelityUnion.set(`p5:${fld}`, `not_parsed (${(d as { count: number }).count})`);
      for (const [fld, d] of Object.entries(imp.dropped_fidelity.parsed_not_authored)) fidelityUnion.set(`p5:${fld}`, `parsed_not_authored (${JSON.stringify(d)})`);
      const toks = tokensOf(imp.notation);
      if (toks.length !== w.steps) fail(`slot ${pr.slot} synth2 ${w.name} row has ${toks.length} tokens != ${w.steps}`);

      if (carry !== undefined) {
        let remain = carry.sixths; let at = 0;
        while (remain > 0) {
          if (at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (!isRest(toks[at])) { fail(`slot ${pr.slot} synth2 ${w.name} continuation collision at step ${at}`); remain = 0; break; }
          const toEdge = (w.steps - at) * SIX;
          const piece = Math.min(96, remain, toEdge);
          const cont = remain > piece;
          toks[at] = mkTok(carry.pitches, piece, carry.vel, cont);
          edgeInstances.push(`slot ${pr.slot} synth2 ${w.name} step ${at}: continuation`);
          remain -= piece; at += 16;
          if (remain > 0 && at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (remain === 0) carry = undefined;
        }
      }
      for (const c of imp.cells) {
        const gs = (c as { gate_sixths?: number }).gate_sixths ?? (c as { duration_steps: number }).duration_steps * SIX;
        const endSixth = (c as { step: number }).step * SIX + gs;
        if (endSixth <= w.steps * SIX) continue;
        edgeInstances.push(`slot ${pr.slot} synth2 ${w.name} step ${(c as { step: number }).step}: CROSSER (${gs / SIX} steps)`);
      }
      rows.push(toks);
    }
    if (carry !== undefined) fail(`slot ${pr.slot} synth2: carry left past the last window`);
    for (let wi = 0; wi < wins.length; wi++) {
      if (rows[wi].some((t2) => !isRest(t2))) wins[wi].voices.synth2 = rows[wi].join(' ');
      for (const t of rows[wi]) {
        if (isRest(t)) continue;
        const nP = pitchesOf(t).split('+').length;
        t5StagedPitches += nP;
        const m = /@(\d+)/.exec(t);
        const k = m ? m[1] : 'def';
        t5StagedVels.set(k, (t5StagedVels.get(k) ?? 0) + nP);
      }
    }
  }
  // The writer's contract: a section must carry >= 1 voice ("`voices` must
  // have at least one voice", dry-run-confirmed). An ALL-REST window (m61,
  // the ring-out) is staged as an explicit all-rest synth2 row — parses to
  // zero onsets, stores an empty pattern, identical content.
  for (const w of wins) {
    if (Object.keys(w.voices).length === 0) {
      w.voices.synth2 = Array(w.steps).fill('~').join(' ');
      info(`slot ${pr.slot} ${w.name}: all-rest window staged as an explicit rest row (writer requires >=1 voice)`);
    }
  }
  winsBySlot.set(pr.slot, wins);
  const slotMs = [...slotVels.entries()].sort((a, b) => b[0] - a[0]).map(([v, n]) => `${v} x${n}`).join(', ');
  info(`slot ${pr.slot} staged drum-cell velocity multiset: ${slotMs || '(none)'}`);
}

// ── D. global melodic + external-set assertions ──────────────────────
console.log('\n=== D. global assertions ===');
if (offGridT5 === 0) ok('t5 import off_grid 0 (§0a)'); else fail(`t5 off_grid ${offGridT5}`);
if (totChordOverflow === 0) ok('chord_overflow 0 (max chord 4 <= 6 ceiling)'); else fail(`chord_overflow ${totChordOverflow}`);
if (edgeInstances.length === 0) ok('ZERO seam ties / end clips / crossers (§0e: the first build with no seam ledger)');
else { for (const e of edgeInstances) fail(e); }
if (t5StagedPitches === 2142) ok('staged t5 pitch-onsets 2142 == flatten (full coverage, zero drops)');
else fail(`staged t5 pitch-onsets ${t5StagedPitches} != 2142`);
if (eq(Object.fromEntries([...t5StagedVels.entries()].sort()), { '42': 1142, '60': 16, '63': 12, '90': 7, def: 965 }))
  ok('staged t5 velocity multiset == §0f EXACT');
else fail(`staged t5 velocity multiset ${JSON.stringify([...t5StagedVels])}`);
{
  const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63 };
  const seen = new Set<string>();
  for (const wins of winsBySlot.values()) for (const w of wins)
    for (const v of Object.keys(w.voices)) if (v !== 'synth2') seen.add(v);
  const notes = [...seen].map((v) => GM12[v]).sort((a, b) => a - b);
  if (eq([...seen].sort(), ['crash', 'hat', 'kick', 'openhat', 'ride', 'snare', 'tom'])
    && eq(notes, [48, 50, 54, 57, 58, 61, 63]))
    ok('external-leg note set {48,50,54,57,58,61,63} — timbale on the DEDICATED tom pad 57, no perc (§2b EXACT)');
  else fail(`folded voice set [${[...seen].sort()}] -> notes [${notes}]`);
  // total staged drum cells across slots == post-fold cell count
  let total = 0;
  for (const sv of drumStagedVels.values()) for (const n of sv.values()) total += n;
  if (total === cells.size) ok(`staged drum cells ${total} == post-fold cell count (full 61-bar coverage)`);
  else fail(`staged drum cells ${total} != ${cells.size}`);
}

// ── E. tail decode assertions (§3, staged lens) ──────────────────────
console.log('\n=== E. tail assertions (§3) ===');
const rowSlice = (w: WinVoices, voice: string, from: number, to: number): string[] => {
  const row = w.voices[voice];
  if (row === undefined) return Array(to - from).fill('~');
  return tokensOf(row).slice(from, to);
};
const onsets = (toks: string[]): number[] => toks.flatMap((t, i) => (isRest(t) ? [] : [i]));
{
  // m1 pickup: EXACT 8-step form
  const w = winsBySlot.get(25)![0];
  const want: Record<string, string> = {
    snare: '~ ~ ~ snare@40 snare@100 ~ ~ ~',
    tom: '~ ~ ~ ~ tom@100 ~ ~ ~',
    hat: '~ ~ ~ ~ hat@100 hat@100 hat@100 hat@100',
    kick: '~ ~ ~ ~ kick@100 kick@100 kick@100 kick@100',
  };
  if (eq(w.voices, want))
    ok('m1 pickup EXACT: snare ghost@40 step3 + backbeat snare/tom@100 step4 + driving hat+kick 16ths 4-7; t5 rest (§0b: the drag survives as a single ghost pickup)');
  else fail(`m1 staged form ${JSON.stringify(w.voices)}`);
}
const closer = (slot: number, winIdx: number, barOffset: number): Record<string, string[]> => {
  const w = winsBySlot.get(slot)![winIdx];
  const out: Record<string, string[]> = {};
  for (const v of [...KIT_VOICES, 'synth2']) out[v] = rowSlice(w, v, barOffset, barOffset + 16);
  return out;
};
{
  // slot 25 m9 (win 5, bar 2): hat-led closer, no ride; t5 = B cell
  const c25 = closer(25, 4, 16);
  if (onsets(c25.hat).length > 0 && onsets(c25.ride).length === 0) ok('slot 25 m9: hat-led intro closer (hat sounds, no ride)');
  else fail(`slot 25 m9 hat ${onsets(c25.hat).length} ride ${onsets(c25.ride).length}`);
  const bBar = c25.synth2.join(' ');
  if (onsets(c25.synth2).length > 0) ok('slot 25 m9: t5 B-cell bar present');
  else fail('slot 25 m9 t5 empty');
  // slot 26 m21 (win 6, bar 2): ride-led interlude closer; t5 == B
  const c26 = closer(26, 5, 16);
  if (onsets(c26.ride).length > 0 && onsets(c26.hat).length === 0) ok('slot 26 m21: ride-led interlude closer');
  else fail(`slot 26 m21 ride ${onsets(c26.ride).length} hat ${onsets(c26.hat).length}`);
  if (c26.synth2.join(' ') === bBar) ok('slot 26 m21 t5 == the B cell (identical to slot 25 m9)');
  else fail('slot 26 m21 t5 differs from B');
  // slot 27 m36 (win 8, 16-step): kick/ride@112 turnaround + t5 G figure (unique)
  const c27 = closer(27, 7, 0);
  if (c27.kick.includes('kick@112') && c27.ride.includes('ride@112'))
    ok('slot 27 m36: the kick/ride@112 turnaround present');
  else fail(`slot 27 m36 turnaround missing: kick[${c27.kick}] ride[${c27.ride}]`);
  if (c27.crash[0] !== '~') ok('slot 27 m36: crash at step 0');
  else fail('slot 27 m36 crash@0 missing');
  const gBar = c27.synth2.join(' ');
  if (onsets(c27.synth2).length > 0 && gBar !== bBar)
    ok('slot 27 m36: t5 G chorus figure (differs from B — the bar that distinguishes Chorus 1 from Chorus 2)');
  else fail('slot 27 m36 t5 G figure missing or == B');
  // slot 28 m52 (win 8, bar 2): openhat verse bar; t5 == B
  const c28 = closer(28, 7, 16);
  if (onsets(c28.openhat).length > 0) ok('slot 28 m52: openhat verse closer');
  else fail('slot 28 m52 openhat missing');
  if (c28.synth2.join(' ') === bBar) ok('slot 28 m52 t5 == the B cell');
  else fail('slot 28 m52 t5 differs from B');
  // slot 28 dropout: win 5 (m45-46) crash ring + silence; win 6 (m47-48) silence + drag re-entry
  const w5 = winsBySlot.get(28)![4];
  const kit45 = KIT_VOICES.flatMap((v) => onsets(rowSlice(w5, v, 0, 16)).map((s) => `${v}@${s}`)).sort();
  if (eq(kit45, ['crash@0', 'kick@0'])) ok('slot 28 m45: crash ring (crash+kick at step 0, nothing else — the doubled crash folded)');
  else fail(`slot 28 m45 kit [${kit45}]`);
  const kit46 = KIT_VOICES.flatMap((v) => onsets(rowSlice(w5, v, 16, 32))).length;
  const kit47 = KIT_VOICES.flatMap((v) => onsets(rowSlice(winsBySlot.get(28)![5], v, 0, 16))).length;
  if (kit46 === 0 && kit47 === 0) ok('slot 28 m46-47: drums OUT (two all-rest kit bars, the tab\'s own breakdown)');
  else fail(`slot 28 dropout kit m46 ${kit46} m47 ${kit47}`);
  const t46 = onsets(rowSlice(w5, 'synth2', 16, 32)).length;
  if (t46 > 0) ok('slot 28 m46: t5 vamp CONTINUES through the dropout (drums out, layer on)');
  else fail('slot 28 m46 t5 empty — the vamp should continue');
  const w6 = winsBySlot.get(28)![5];
  const s27 = rowSlice(w6, 'snare', 27, 29);
  const tom28 = rowSlice(w6, 'tom', 28, 29)[0];
  if (s27[0] === 'snare@40' && s27[1] === 'snare@100' && tom28 === 'tom@100')
    ok('slot 28 m48: drag re-entry (ghost@40 step 27 -> backbeat snare+timbale @28, the m1 shape)');
  else fail(`slot 28 m48 drag [${s27}] tom ${tom28}`);
  // slot 29 m60 (win 4, bar 2): the stop hit ONLY; t5 H cadence
  const w29 = winsBySlot.get(29)![3];
  const kit60 = KIT_VOICES.flatMap((v) => onsets(rowSlice(w29, v, 16, 32)).map((s) => `${v}@${s}`)).sort();
  if (eq(kit60, ['crash@0', 'kick@0'])) ok('slot 29 m60: crash+kick stop hit at step 0, nothing else (doubles folded)');
  else fail(`slot 29 m60 kit [${kit60}]`);
  const h60 = rowSlice(w29, 'synth2', 16, 32);
  if (onsets(h60).length > 0 && h60.join(' ') !== bBar) ok('slot 29 m60: t5 H cadence present (differs from B)');
  else fail('slot 29 m60 t5 H cadence missing');
  // slot 29 m61: ALL-REST on every track (the ring-out pattern; staged as an
  // explicit rest row because the writer requires >= 1 voice per section)
  const w61 = winsBySlot.get(29)![4];
  const w61Rest = eq(Object.keys(w61.voices), ['synth2']) && tokensOf(w61.voices.synth2).every(isRest)
    && tokensOf(w61.voices.synth2).length === 16;
  if (w61Rest) ok('slot 29 m61: ALL-REST ring-out pattern (explicit 16-step rest row, zero onsets — the song ends itself)');
  else fail(`slot 29 m61 voices [${Object.keys(w61.voices)}] not the all-rest row`);
}

// ── F. dedupe into sections/order + emit staged JSON ─────────────────
console.log('\n=== F. staged sections/order ===');
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
  if (eq(plays, [5, 6, 8, 8, 5]))
    ok('plays per slot [5,6,8,8,5] == §1 (chains [0,4]/[0,5]/[0,7]/[0,7]/[0,4])');
  else fail(`plays [${plays}]`);
}

console.log('\n=== dropped-fidelity union (melodic import) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);

writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/lovesong-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/lovesong-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
