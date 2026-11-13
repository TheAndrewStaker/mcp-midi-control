/**
 * verify-song-author-variants: variant authoring and the dedup measurement (BK-SONG-AUTHOR-2).
 *
 * Two things, offline, no hardware:
 *
 *  1. VARIANT AUTHORING (patterns mechanism, Phase 1):
 *     (a) a SINGLE-pattern section with a `patterns` variant group → `buildProjectOps` authors the
 *         base as ONE pattern (not an arrangement), and the adapter's `renderVariantPatterns` produces
 *         one extra pattern slot per variation on the single differing track, with the swap gesture
 *         stated (loop vs one-shot).
 *     (b) a MULTI-pattern (arrangement) section with a `patterns` variant is REFUSED (throws
 *         SongAuthorError), routed to scenes, never silently mis-authored.
 *     (scenes) a `scenes` variant is accepted as a Phase-2 no-op.
 *
 *  2. DEDUP MEASURE-then-tune (review S3): the opt-in `fillTolerantReuse` planner flag, proven on a
 *     SYNTHETIC song to (i) merge two sections that differ ONLY on detected fill bars, and (ii) NOT
 *     merge when a melodic backing part differs on a non-fill bar. Then the chorus measurement of
 *     an invented song (Test Song B, `scripts/syntheticSong.ts`) is printed (fill-drag vs
 *     real-difference), with the verdict asserted: its choruses share a bass and end on fills, but
 *     are GENUINELY DIFFERENT (pad present only in Chorus B, a per-section cymbal-voice swap, a
 *     different Outro bass), so neither the strict default nor the opt-in collapses them.
 *
 * Run:  npx tsx scripts/verify-song-author-variants.ts   (and confirm scripts/verify-song-author.ts)
 */

import { testSongB, TEST_SONG_B_CHORUS_BARS, TEST_SONG_B_LIVE } from './syntheticSong.js';

import {
  buildProjectOps,
  resolveVariants,
  SongAuthorError,
} from '../packages/core/src/protocol-generic/patterns/songAuthor.js';
import {
  adaptOps,
  renderVariantPatterns,
  previewVariantPatterns,
  attachVariantPatterns,
  type ApplyPatternArgs,
  type CircuitToolCall,
} from '../packages/circuit-tracks/src/authorAdapter.js';
import {
  planSongProjects,
  type SongProjectPlan,
} from '../packages/core/src/protocol-generic/patterns/songPlanner.js';
import {
  toChopPart,
  type ChopPartFlat,
} from '../packages/core/src/protocol-generic/patterns/songChop.js';
import { buildPartWindow } from '../packages/core/src/protocol-generic/patterns/songPlanner.js';
import type { SongsterrPart, SsMeasure } from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import type {
  SectionAuthoring,
  SongRecipe,
} from '../packages/core/src/protocol-generic/patterns/songAuthorTypes.js';


// ── assertion harness ───────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { pass++; } else { fail++; failures.push(detail ? `${name}\n    ${detail}` : name); }
}

const apArgs = (call: CircuitToolCall | undefined): ApplyPatternArgs | undefined =>
  call?.tool === 'apply_pattern' ? call.args : undefined;

// ═══════════════════════════════════════════════════════════════════════
// 1. VARIANT AUTHORING
// ═══════════════════════════════════════════════════════════════════════

/** A single-pattern "Breakdown-shaped" section: base groove + one alternate fill on the `tom` lane. */
function fillVariantSection(playback: 'loop' | 'one-shot'): SectionAuthoring {
  return {
    section: 'Breakdown',
    role: 'author',
    slot: 1,
    projectName: 'Scratch Breakdown',
    drums: { layout: 'internal-condense', levels: { drum1: 100, drum2: 100, drum3: 100, drum4: 100 } },
    patterns: [
      { name: 'Groove', steps: 16, drumVoices: { kick: 'X...X...X...X...', snare: '....X.......X...', tom: 'X...............' } },
      // Differs from Groove ONLY on the tom lane (the fill track).
      { name: 'FillB', steps: 16, drumVoices: { kick: 'X...X...X...X...', snare: '....X.......X...', tom: 'X.X.X.X.X.X.X.X.' } },
    ],
    variants: [{ element: 'fill', base: 'Groove', variants: [{ name: 'FillB' }], mechanism: 'patterns' }],
    playback,
  };
}

// (a) SINGLE-pattern + patterns variant of 2 fills (base + 1 alternate).
{
  const section = fillVariantSection('loop');
  const recipe: SongRecipe = {
    globals: { pack: 5, template: 'blank.ncs', tempo: 120, colour: 'Red', soundingPitch: true },
    pool: [], sections: [section],
  };
  const ops = buildProjectOps(recipe);
  const authors = ops.filter((o) => o.kind === 'authorProject') as Extract<typeof ops[number], { kind: 'authorProject' }>[];

  check('(a) one authorProject emitted', authors.length === 1, `got ${authors.length}`);
  const proj = authors[0]?.project;
  check('(a) base authored as a SINGLE pattern (variation stripped, not an arrangement)',
    proj?.patterns.length === 1, `got ${proj?.patterns.length} patterns`);
  check('(a) the authored base is "Groove"', proj?.patterns[0]?.name === 'Groove', `got ${proj?.patterns[0]?.name}`);
  check('(a) base carries the base tom lane (X...............)',
    proj?.patterns[0]?.drumVoices.tom === 'X...............', `got ${proj?.patterns[0]?.drumVoices.tom}`);

  // The adapter renders the base as top-level voices (single pattern), NOT a global arrangement chain.
  const calls = adaptOps(ops, { pool: [], port: 'circuit' });
  const a = apArgs(calls[0]);
  check('(a) adapter renders base single-pattern (top-level voices, no arrangement)',
    a?.arrangement === undefined && a?.steps === 16 && a?.voices?.tom === 'X...............',
    JSON.stringify({ arrangement: a?.arrangement, steps: a?.steps }));

  // The extra fill pattern: one slot per variation, on the single differing track (tom).
  const renders = renderVariantPatterns(section);
  check('(a) exactly one variant group rendered', renders.length === 1, `got ${renders.length}`);
  const r = renders[0];
  check('(a) group element is "fill"', r?.element === 'fill', r?.element);
  check('(a) differing track resolved to the tom lane', r?.track === 'tom', r?.track);
  check('(a) base slot is the base tom line', r?.base.steps === 'X...............', r?.base.steps);
  check('(a) ONE extra fill pattern (one per variation)', r?.slots.length === 1, `got ${r?.slots.length}`);
  check('(a) the extra fill pattern is FillB on the tom lane',
    r?.slots[0]?.name === 'FillB' && r?.slots[0]?.steps === 'X.X.X.X.X.X.X.X.',
    JSON.stringify(r?.slots[0]));
  check('(a) the swap gesture is stated (mentions the tom track + loop queueing)',
    typeof r?.swap === 'string' && r.swap.includes('tom') && /loop/i.test(r.swap), r?.swap);

  // previewVariantPatterns states the swap; attachVariantPatterns merges the slots into the call.
  const preview = previewVariantPatterns(section);
  check('(a) preview states the swap and the fill track', preview.includes('swap:') && preview.includes('tom'), preview);
  const attached = attachVariantPatterns({ tool: 'apply_pattern', args: a! }, renders);
  check('(a) attachVariantPatterns puts variant_patterns on the apply_pattern call',
    attached.args.variant_patterns?.length === 1 && attached.args.variant_patterns[0].track === 'tom');
}

// (a-oneshot) the one-shot gesture differs: pre-select before Play, fires once.
{
  const section = fillVariantSection('one-shot');
  const r = renderVariantPatterns(section)[0];
  check('(a) one-shot swap gesture is PRE-select before Play (not mid-loop)',
    /pre-select/i.test(r.swap) && /before play/i.test(r.swap) && !/queues/i.test(r.swap), r.swap);
}

// (b) MULTI-pattern (arrangement) base + patterns variant → REFUSED.
{
  const section: SectionAuthoring = {
    section: 'Chorus',
    role: 'author',
    slot: 1,
    projectName: 'Chorus (arrangement)',
    drums: { layout: 'internal-condense', levels: { drum1: 100 } },
    patterns: [
      { name: 'ChorusA', steps: 32, drumVoices: { kick: 'X...' } },
      { name: 'ChorusB', steps: 32, drumVoices: { snare: 'X...' } },
      // FillX differs from the base ChorusA on exactly ONE track (tom) — so it clears the one-track
      // rule and the refusal is specifically about the MULTI-PATTERN (ChorusA+ChorusB) arrangement base.
      { name: 'FillX', steps: 32, drumVoices: { kick: 'X...', tom: 'X...' } },
    ],
    // A patterns variant against a 2-pattern ARRANGEMENT base — the mode conflict.
    variants: [{ element: 'fill', base: 'ChorusA', variants: [{ name: 'FillX' }], mechanism: 'patterns' }],
  };
  const recipe: SongRecipe = {
    globals: { pack: 5, template: 'blank.ncs', tempo: 120, colour: 'Blue', soundingPitch: true },
    pool: [], sections: [section],
  };
  let threw: unknown;
  try { buildProjectOps(recipe); } catch (e) { threw = e; }
  check('(b) buildProjectOps REFUSES a patterns variant on a multi-pattern section',
    threw instanceof SongAuthorError, `threw: ${threw === undefined ? 'nothing' : String(threw)}`);
  check('(b) the refusal names the single-pattern rule + routes to scenes (Phase 2)',
    threw instanceof Error && /SINGLE-pattern/i.test(threw.message) && /scenes/i.test(threw.message),
    threw instanceof Error ? threw.message : String(threw));
  let threwRender: unknown;
  try { renderVariantPatterns(section); } catch (e) { threwRender = e; }
  check('(b) the adapter render refuses it too (same SongAuthorError)', threwRender instanceof SongAuthorError);
}

// (b2) a variation that differs on >1 track → REFUSED (whole-snapshot = scene, not a patterns swap).
{
  const section: SectionAuthoring = {
    section: 'Verse', role: 'author', slot: 1, projectName: 'Verse',
    drums: { layout: 'internal-condense', levels: {} },
    patterns: [
      { name: 'Base', steps: 16, drumVoices: { kick: 'X...', snare: '..X.' } },
      { name: 'Var', steps: 16, drumVoices: { kick: 'XX..', snare: 'XX..' } }, // two tracks differ
    ],
    variants: [{ element: 'whole', base: 'Base', variants: [{ name: 'Var' }], mechanism: 'patterns' }],
  };
  let threw: unknown;
  try { resolveVariants(section); } catch (e) { threw = e; }
  check('(b2) a multi-track variation is REFUSED (route to scenes)',
    threw instanceof SongAuthorError && /tracks/i.test((threw as Error).message), threw instanceof Error ? threw.message : String(threw));
}

// (scenes) a scenes-mechanism variant is accepted as a Phase-2 no-op.
{
  const section: SectionAuthoring = {
    section: 'Chorus', role: 'author', slot: 1, projectName: 'Chorus',
    drums: { layout: 'internal-condense', levels: { drum1: 100 } },
    patterns: [{ name: 'Base', steps: 32, drumVoices: { kick: 'X...' } }],
    variants: [{ element: 'chorusVar', base: 'Base', variants: [{ name: 'alt' }], mechanism: 'scenes' }],
  };
  const recipe: SongRecipe = {
    globals: { pack: 5, template: 'blank.ncs', tempo: 120, colour: 'Green', soundingPitch: true },
    pool: [], sections: [section],
  };
  let threw: unknown;
  let ops: ReturnType<typeof buildProjectOps> = [];
  try { ops = buildProjectOps(recipe); } catch (e) { threw = e; }
  check('(scenes) a scenes variant does NOT throw (accepted, Phase 2)', threw === undefined,
    threw instanceof Error ? threw.message : String(threw));
  check('(scenes) the base is still authored', ops.some((o) => o.kind === 'authorProject'));
  check('(scenes) renderVariantPatterns is a no-op for scenes', renderVariantPatterns(section).length === 0);
  check('(scenes) preview notes scenes are Phase 2', /Phase 2/i.test(previewVariantPatterns(section)));
}

// ═══════════════════════════════════════════════════════════════════════
// 2a. DEDUP — SYNTHETIC PROOF of the opt-in fillTolerantReuse
// ═══════════════════════════════════════════════════════════════════════

// A 16-step (16th-grid, 4/4) drum measure from a per-step GM array (null = rest).
function drumMeasure(gm: (number | null)[], marker?: string, sig?: [number, number]): SsMeasure {
  const beats = gm.map((g) => (g === null
    ? { duration: [1, 16] as [number, number], rest: true }
    : { duration: [1, 16] as [number, number], notes: [{ fret: g }] }));
  const m: SsMeasure = { voices: [{ beats }] };
  if (marker !== undefined) m.marker = { text: marker };
  if (sig !== undefined) m.signature = sig;
  return m;
}
// A one-note (whole-note) bass measure at the given fret (pitch = tuning[0] + fret).
function bassMeasure(fret: number, marker?: string, sig?: [number, number]): SsMeasure {
  const m: SsMeasure = { voices: [{ beats: [{ duration: [1, 1] as [number, number], notes: [{ fret, string: 0 }] }] }] };
  if (marker !== undefined) m.marker = { text: marker };
  if (sig !== undefined) m.signature = sig;
  return m;
}

const KICK = 36; const SNARE = 38; const HAT = 42; const TOM = 45;
const GROOVE = [KICK, null, null, null, SNARE, null, null, null, KICK, null, null, null, SNARE, null, null, null]; // 4 hits
const TOMFILL_A = [TOM, null, TOM, null, TOM, null, null, null, KICK, null, KICK, null, KICK, null, null, null];   // 6 hits, tom
const TOMFILL_B = [TOM, null, null, TOM, null, null, TOM, null, KICK, null, null, KICK, null, null, KICK, null];   // 6 hits, tom, differs
const DENSE_A = [HAT, HAT, HAT, HAT, HAT, HAT, HAT, HAT, HAT, HAT, null, null, null, null, null, null];             // 10 hits, no tom
const DENSE_B = [null, null, null, null, null, null, HAT, HAT, HAT, HAT, HAT, HAT, HAT, HAT, HAT, HAT];             // 10 hits, no tom, differs

/** Two adjacent 5-bar sections A/B: identical groove on bars 1-2, differing FILLS on bars 3-5
 *  (bars 3-4 tom fills → flagged; bar 5 dense → flagged). `bassDiffersOnBar2` breaks the groove. */
function synthSong(bassDiffersOnBar2: boolean): { parts: ChopPartFlat[]; raw: Map<number, SongsterrPart> } {
  const drum: SongsterrPart = {
    tuningFlat: true,
    measures: [
      drumMeasure(GROOVE, 'A', [4, 4]), drumMeasure(GROOVE), drumMeasure(TOMFILL_A), drumMeasure(TOMFILL_A), drumMeasure(DENSE_A),
      drumMeasure(GROOVE, 'B'), drumMeasure(GROOVE), drumMeasure(TOMFILL_B), drumMeasure(TOMFILL_B), drumMeasure(DENSE_B),
    ],
  };
  const bass: SongsterrPart = {
    tuning: [45],
    measures: [
      bassMeasure(0, 'A', [4, 4]), bassMeasure(0), bassMeasure(0), bassMeasure(0), bassMeasure(0),
      bassMeasure(0, 'B'), bassMeasure(bassDiffersOnBar2 ? 2 : 0), bassMeasure(0), bassMeasure(0), bassMeasure(0),
    ],
  };
  const raw = new Map<number, SongsterrPart>([[0, drum], [1, bass]]);
  const parts = [toChopPart(0, 'Drums', drum), toChopPart(1, 'Bass', bass)];
  return { parts, raw };
}

function chorusRel(plan: SongProjectPlan, project: number): { relation: string; reuse?: number; diff: number[] } {
  const p = plan.projects.find((x) => x.project === project)!;
  return { relation: p.relation, reuse: p.reuse_of, diff: p.differing_bars };
}

// POSITIVE: groove shared, only the detected fill bars differ → opt-in merges, strict does not.
{
  const song = synthSong(false);
  const strict = planSongProjects(song.parts, song.raw, { live: [] });
  const opt = planSongProjects(song.parts, song.raw, { live: [], fillTolerantReuse: true });
  check('(2a+) STRICT keeps the two sections SEPARATE (agreement 0.4 < 0.5)',
    strict.authored_projects.length === 2, `authored ${JSON.stringify(strict.authored_projects)}`);
  check('(2a+) OPT-IN merges them (fills excluded → identical groove)',
    opt.authored_projects.length === 1, `authored ${JSON.stringify(opt.authored_projects)}`);
  const r = chorusRel(opt, 2);
  check('(2a+) the merged section reuses P1 as a shared-groove', r.relation === 'shared-groove' && r.reuse === 1,
    JSON.stringify(r));
  check('(2a+) the fill bars are recorded as differing_bars (the variation set) = m8,9,10',
    JSON.stringify(r.diff) === JSON.stringify([8, 9, 10]), JSON.stringify(r.diff));
}

// NEGATIVE: the bass (a melodic backing) differs on a NON-fill bar → NOT a fill case → no merge.
{
  const song = synthSong(true);
  const opt = planSongProjects(song.parts, song.raw, { live: [], fillTolerantReuse: true });
  check('(2a-) OPT-IN does NOT merge when a melodic backing differs on a non-fill bar (guards over-merge)',
    opt.authored_projects.length === 2, `authored ${JSON.stringify(opt.authored_projects)}`);
  check('(2a-) both sections stay unique', chorusRel(opt, 2).relation === 'unique');
}

// ═══════════════════════════════════════════════════════════════════════
// 2b. DEDUP: CHORUSES THAT MUST NOT MERGE (measured on Test Song B, printed for the integrator)
//
// Test Song B (scripts/syntheticSong.ts) has four 4-bar choruses on one kick / snare skeleton.
// A, B and C share a bass and each ends on a floor-tom fill, so they LOOK like one groove with
// differing fills. They are not: the cymbal voice changes per chorus on every bar, the pad plays
// in only two of them, and the last has its own bass. The opt-in must leave them apart.
// ═══════════════════════════════════════════════════════════════════════

{
const boRaw = new Map<number, SongsterrPart>();
const boParts: ChopPartFlat[] = [];
for (const p of testSongB()) {
  boRaw.set(p.partId, p.part);
  boParts.push(toChopPart(p.partId, p.label, p.part));
}
const BO_LIVE = TEST_SONG_B_LIVE; // the guitar is performed live

const boStrict = planSongProjects(boParts, boRaw, { live: BO_LIVE });
const boOpt = planSongProjects(boParts, boRaw, { live: BO_LIVE, fillTolerantReuse: true });

// Backing windows for the per-part decomposition.
let anchor = boParts[0];
for (const p of boParts) if (p.measures.length > anchor.measures.length) anchor = p;
const boMeasures = anchor.measures;
const backing = boStrict.parts.filter((p) => p.backing);
const boWin = new Map(backing.map((p) => [p.partId, buildPartWindow(p.partId, p.label, boRaw.get(p.partId)!, boMeasures, 4)]));
const labelOf = (id: number): string => boStrict.parts.find((p) => p.partId === id)!.label;
const tokRow = (id: number, mi: number): string => { const w = boWin.get(id)!; return `${w.bars[mi].sig}|${w.bars[mi].body}`; };

// The four chorus projects (the verses are 8 bars and not agreement-comparable to them).
const isChorus = (p: { section: string; bars: number }): boolean => /chorus/i.test(p.section) && p.bars === TEST_SONG_B_CHORUS_BARS;
const choruses = boStrict.projects.filter(isChorus);

console.log('\n════════════════════════════════════════════════════════════════════');
console.log('TEST SONG B (invented), guitar live');
console.log('DEDUP MEASUREMENT: why the choruses do NOT collapse to one project');
console.log('════════════════════════════════════════════════════════════════════');
console.log(`backing parts (authored): ${backing.map((p) => `${p.partId}=${p.label}`).join(', ')}`);
console.log(`${TEST_SONG_B_CHORUS_BARS}-bar chorus projects: ${choruses.map((c) => `P${c.project} ${c.section}`).join(', ')}`);
console.log('');

let anyMelodicDiff = false;
/** `A|B` section pair → bars each backing part differs on (by label). */
const pairDiff = new Map<string, Map<string, number>>();
for (let i = 0; i < choruses.length; i++) {
  for (let j = i + 1; j < choruses.length; j++) {
    const a = choruses[i]; const b = choruses[j];
    const n = a.to_measure - a.from_measure + 1;
    const fa = a.from_measure - 1; const fb = b.from_measure - 1;
    let same = 0; let melodicDiffBars = 0; let drumOnlyDiffBars = 0;
    const perPart = new Map<number, number>();
    for (let k = 0; k < n; k++) {
      const differ = backing.map((p) => p.partId).filter((id) => tokRow(id, fa + k) !== tokRow(id, fb + k));
      if (differ.length === 0) { same++; continue; }
      for (const id of differ) perPart.set(id, (perPart.get(id) ?? 0) + 1);
      const melodicDiffers = differ.some((id) => boWin.get(id)!.melodic);
      if (melodicDiffers) { melodicDiffBars++; anyMelodicDiff = true; } else drumOnlyDiffBars++;
    }
    console.log(`P${a.project} ${a.section}  vs  P${b.project} ${b.section}:  strict agreement ${(same / n).toFixed(2)}`);
    for (const p of backing) console.log(`    ${labelOf(p.partId).padEnd(36)} differs on ${perPart.get(p.partId) ?? 0}/${n} bars`);
    pairDiff.set(`${a.section}|${b.section}`, new Map(backing.map((p) => [labelOf(p.partId), perPart.get(p.partId) ?? 0])));
    console.log(`    → bars where a MELODIC backing (bass/pad) differs: ${melodicDiffBars}   (drum-only/fill-shaped: ${drumOnlyDiffBars})`);
  }
}

console.log('');
console.log('VERDICT: REAL-DIFFERENCE, not fill-drag.');
console.log('  - The PAD is present in Chorus B and absent in Chorus A / C (a real arrangement change).');
console.log('  - The DRUMS swap cymbal voice per section (A=closed hat, B=crash, C=open hat): a whole-');
console.log('    section timbral difference, NOT an end-of-phrase fill, so a fill-bar exclusion does not');
console.log('    rescue it (the disagreement is on every bar, not the few detected fill bars).');
console.log('  - The Outro Chorus additionally carries a DIFFERENT bass.');
console.log('  - The bass backbone IS shared A/B/C, but that alone does not make them one project.');
console.log('  DECISION: keep the choruses separate. Do NOT loosen the default dedup (that would be the');
console.log('  over-merge). A "4 choruses → 1 project" reading is refuted by measurement.');
console.log(`  strict authored=${boStrict.authored_projects.length}, fillTolerantReuse authored=${boOpt.authored_projects.length} (identical: the opt-in does NOT collapse them).`);
console.log('');

// Assertions locking the verdict in.
const diffOf = (a: string, b: string, part: string): number | undefined => pairDiff.get(`${a}|${b}`)?.get(part);
const N = TEST_SONG_B_CHORUS_BARS;
check('(2b) four chorus projects are measured (six pairs)', choruses.length === 4 && pairDiff.size === 6,
  `${choruses.length} choruses, ${pairDiff.size} pairs`);
// The input really is the tempting case: fills to exclude, and a shared bass under them.
check('(2b) choruses A, B and C each end on a detected fill bar (the opt-in has fill bars to exclude)',
  ['Chorus A', 'Chorus B', 'Chorus C'].every((s) => {
    const p = boOpt.projects.find((x) => x.section === s)!;
    return JSON.stringify(p.fill_candidates) === `[${p.to_measure}]`;
  }), boOpt.projects.filter(isChorus).map((p) => `${p.section}:${JSON.stringify(p.fill_candidates)}`).join(', '));
check('(2b) the bass is IDENTICAL across choruses A, B and C (a shared backbone)',
  diffOf('Chorus A', 'Chorus B', 'Bass') === 0 && diffOf('Chorus A', 'Chorus C', 'Bass') === 0 && diffOf('Chorus B', 'Chorus C', 'Bass') === 0);
// ...and the difference is on every bar, not confined to the fills.
check('(2b) the drums differ on EVERY bar of every chorus pair (the cymbal voice, not just the fill)',
  [...pairDiff.values()].every((m) => m.get('Drums') === N), [...pairDiff.entries()].map(([k, m]) => `${k}:${m.get('Drums')}`).join(', '));
check('(2b) the pad differs on every bar between Chorus B and A / C (present in one, absent in the other), and not between A and C',
  diffOf('Chorus A', 'Chorus B', 'Pad') === N && diffOf('Chorus B', 'Chorus C', 'Pad') === N && diffOf('Chorus A', 'Chorus C', 'Pad') === 0);
check('(2b) the Outro Chorus has its own bass on every bar', diffOf('Chorus C', 'Outro Chorus', 'Bass') === N, String(diffOf('Chorus C', 'Outro Chorus', 'Bass')));
check('(2b) at least one chorus pair differs on a MELODIC backing part (real-difference evidence)', anyMelodicDiff);
check('(2b) strict and fill-tolerant author the SAME number of projects (the opt-in does not over-merge)',
  boStrict.authored_projects.length === boOpt.authored_projects.length && boOpt.authored_projects.length === 7,
  `strict ${boStrict.authored_projects.length} vs opt ${boOpt.authored_projects.length}`);
check('(2b) every chorus stays its own project under the opt-in (none reuses another)',
  boOpt.projects.filter(isChorus).every((p) => p.relation === 'unique'),
  boOpt.projects.filter(isChorus).map((p) => `${p.section}:${p.relation}`).join(', '));
check('(2b) the dedup still works on this song: Verse 2 reuses Verse 1 in both plans',
  [boStrict, boOpt].every((pl) => pl.projects.find((p) => p.section === 'Verse 2')!.reuse_of === pl.projects.find((p) => p.section === 'Verse 1')!.project));
}

// ── report ───────────────────────────────────────────────────────────────
console.log(`verify-song-author-variants: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('All variant-authoring + dedup-measurement checks passed.');
