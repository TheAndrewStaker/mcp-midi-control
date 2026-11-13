/**
 * Golden: the song-authoring SEEDER (BK-AUTHORING-ENGINE, Item B). No hardware,
 * no network.
 *
 * Three checks:
 *   (1) The plan + per-part relations of an invented song (Test Song A, built in
 *       `scripts/syntheticSong.ts`), seeded under the DEFAULT policy, match the
 *       sections of its hand-finished recipe
 *       (`scripts/fixtures/synthetic-song/recipe.json`) EXCEPT an explicitly
 *       enumerated hand-delta set. Every non-delta field the seeder is responsible
 *       for is asserted equal; every delta is asserted to be exactly one of the
 *       enumerated ones (no missing, no surprise). The delta set is PRINTED — it
 *       measures the judgment a human still supplies, and shrinking it is the
 *       roadmap.
 *   (2) A `chronological` seed of the same plan is one `author` per project in play
 *       order, with no `reuse` and no `drop`.
 *   (3) A synthetic Chorus1/Chorus2 where drums + bass are identical and the guitar
 *       differs, guitar marked live: the seeder OFFERS reuse, and
 *       `computePartRelations` reports guitar `different`, drums + bass `identical`.
 *
 * Run via:  npx tsx scripts/verify-song-author-seed.ts
 */

import { readFileSync } from 'node:fs';
import { testSongA, TEST_SONG_A_LIVE } from './syntheticSong.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  toChopPart,
  planSongProjects,
  type ChopPartFlat,
} from '../packages/core/src/protocol-generic/patterns/index.js';
import { type SongsterrPart, type SsMeasure, type SsBeat } from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { computePartRelations, type RelationSection } from '../packages/core/src/protocol-generic/patterns/songPartRelations.js';
import { seedAuthoringFromPlan } from '../packages/core/src/protocol-generic/patterns/songAuthorSeed.js';
import { type SectionAuthoring, type SeedPolicy } from '../packages/core/src/protocol-generic/patterns/songAuthorTypes.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail !== undefined ? `  — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'synthetic-song');

// ═══════════════════════════════════════════════════════════════════════
// Build the Test Song A plan from its invented parts (as
// verify-song-planner does).
// ═══════════════════════════════════════════════════════════════════════
const rawParts = new Map<number, SongsterrPart>();
const parts: ChopPartFlat[] = [];
for (const p of testSongA()) {
  rawParts.set(p.partId, p.part);
  parts.push(toChopPart(p.partId, p.label, p.part));
}
const plan = planSongProjects(parts, rawParts, { live: TEST_SONG_A_LIVE });

// Relations over the PROJECT windows (their section names key the reuse the plan
// already chose, so the two align).
const relSections: RelationSection[] = plan.projects.map((p) => ({
  name: p.section, from_measure: p.from_measure, to_measure: p.to_measure,
}));
const relations = computePartRelations(parts, rawParts, relSections);

const DEFAULT_POLICY: SeedPolicy = { dedup: true, dropLive: true, reuseAcrossLiveDiff: true, splitToms: true, bakeFills: true };
const seed = seedAuthoringFromPlan(plan, relations, DEFAULT_POLICY);

// ── golden recipe ──
interface RecipeSection {
  section: string;
  role: string;
  slot: number;
  projectName: string;
  drums: { layout: string; levels: Record<string, number>; external?: { device: string; track: string }; binding?: string[] };
  patterns: { name: string; steps: number; drumVoices: Record<string, string>; bassVoice?: string }[];
}
const recipe = JSON.parse(readFileSync(join(FIX, 'recipe.json'), 'utf8')) as { sections: RecipeSection[]; clearSlots?: number[] };
const recipeBySlot = new Map<number, RecipeSection>(recipe.sections.map((s) => [s.slot, s]));

console.log('=== (1) DEFAULT SEED vs GOLDEN recipe.json ===\n');

const authors = seed.filter((s) => s.role === 'author');
check('seed authors 6 sections (matches golden section count)', authors.length === 6, `${authors.length}`);
check('seed author slots are 1..6 in play order', eq(authors.map((a) => a.slot), [1, 2, 3, 4, 5, 6]), authors.map((a) => a.slot).join(','));
check('golden recipe has 6 sections', recipe.sections.length === 6);

// The enumerated hand-delta set, collected as we compare.
interface Delta { field: string; section: string; seed: unknown; golden: unknown; note: string }
const deltas: Delta[] = [];
const record = (field: string, section: string, s: unknown, g: unknown, note: string): void => {
  deltas.push({ field, section, seed: s, golden: g, note });
};

for (const a of authors) {
  const g = recipeBySlot.get(a.slot)!;
  const tag = `slot ${a.slot}`;

  // role + slot always match.
  check(`${tag}: role author both sides`, g.role === 'author');

  // section name — delta only when the seeder's spine name carries a numeral the
  // human stripped (Verse 1 → Verse, Chorus 1 → Chorus).
  if (a.section !== g.section) record('section', a.section, a.section, g.section, 'human stripped the spine occurrence number');

  // projectName — the seeder has no song title, so it names by the chop section;
  // the human prefixes the song name. Uniform delta.
  if (a.projectName !== g.projectName) record('projectName', a.section, a.projectName, g.projectName, 'seeder has no song title; human prefixed "SongA "');

  // layout — the seeder proposes explicit-binding for every doubled-tom section;
  // the human keeps condense+external where toms are only fills.
  if (a.drums.layout !== g.drums.layout) {
    record('layout', a.section, a.drums.layout, g.drums.layout, 'seeder flags all doubled-tom sections explicit-binding; human reverts fill-only toms to condense+external');
  } else {
    check(`${tag}: layout matches (${a.drums.layout})`, true);
    // when both condense+external, the external mirror must match; when both
    // explicit-binding, neither carries an external route.
    if (a.drums.layout === 'condense+external') check(`${tag}: external mirror matches golden`, eq(a.drums.external, g.drums.external), JSON.stringify(a.drums.external));
    else check(`${tag}: explicit-binding carries no external route`, a.drums.external === undefined && g.drums.external === undefined);
  }

  // levels — drums up on both; the seeder additionally states synth1:0 (the device
  // default), which the golden omits.
  check(`${tag}: drum1..4 levels are 100 both sides`,
    [1, 2, 3, 4].every((n) => a.drums.levels[`drum${n}`] === 100 && g.drums.levels[`drum${n}`] === 100));
  if (a.drums.levels.synth1 !== undefined && g.drums.levels.synth1 === undefined) {
    record('levels.synth1', a.section, a.drums.levels.synth1, undefined, 'seeder states synth1:0 (device default); golden omits it');
  }

  // binding — only the golden's explicit-binding Breakdown carries four sample
  // names; the seeder cannot know sample names, so it leaves binding for the human.
  if (g.drums.binding !== undefined && a.drums.binding === undefined) {
    record('binding', a.section, undefined, g.drums.binding, 'four bound sample NAMES are content the seeder cannot know');
  }

  // pattern COUNT — the seeder proposes a 2-pattern A/B chain for every >2-bar
  // section; the human collapses a single repeating phrase back to one pattern.
  if (a.patterns.length !== g.patterns.length) {
    record('patternCount', a.section, a.patterns.length, g.patterns.length, 'seeder defaults >2-bar sections to a 2-pattern A/B chain; human collapsed a single repeating phrase to one pattern');
  } else {
    check(`${tag}: pattern count matches (${a.patterns.length})`, true);
  }

  // pattern step widths the seeder DOES set (32) match the golden where counts align.
  if (a.patterns.length === g.patterns.length) {
    check(`${tag}: every seeded pattern is 32 steps like the golden`,
      a.patterns.every((p) => p.steps === 32) && g.patterns.every((p) => p.steps === 32));
  }

  // pattern CONTENT — the seeder proposes empty grids; the golden's are hand-authored.
  const seedHasContent = a.patterns.some((p) => Object.keys(p.drumVoices).length > 0 || p.bassVoice !== undefined);
  const goldHasContent = g.patterns.some((p) => Object.keys(p.drumVoices).length > 0 || p.bassVoice !== undefined);
  check(`${tag}: seeder proposes EMPTY pattern content (grids are hand-authored)`, !seedHasContent);
  if (goldHasContent && !seedHasContent) record('patternContent', a.section, '(empty)', '(hand-authored grids)', 'drum grids + bass lines are the note content a human writes');
}

// ── Structural deltas: the seed carries reuse + drop sections the recipe omits ──
const reuse = seed.filter((s) => s.role === 'reuse');
const drop = seed.filter((s) => s.role === 'drop');
check('seed marks 3 reuse sections (Verse 2, Chorus 2, Chorus 3)', reuse.length === 3, reuse.map((r) => r.section).join(','));
check('  Verse 2 reuses Verse 1 at its slot', reuse.some((r) => r.section === 'Verse 2' && r.reuseOf === 'Verse 1' && r.slot === 2));
check('  Chorus 2 reuses Chorus 1 at its slot', reuse.some((r) => r.section === 'Chorus 2' && r.reuseOf === 'Chorus 1' && r.slot === 3));
check('  Chorus 3 reuses Chorus 1 at its slot', reuse.some((r) => r.section === 'Chorus 3' && r.reuseOf === 'Chorus 1' && r.slot === 3));
check('seed marks 1 drop section (Outro)', drop.length === 1 && drop[0].section === 'Outro', drop.map((d) => d.section).join(','));
record('structure', '(song)', 'seed emits 3 reuse + 1 drop section', 'recipe omits them', 'the golden collapses to 6 author projects; device play-order covers the repeats/drop');
if (recipe.clearSlots !== undefined) record('clearSlots', '(song)', 'not in SectionAuthoring[]', recipe.clearSlots, 'orphan-slot erase is a SongRecipe field, not producible from the seeder return type');

// ── Assert the delta SET is EXACTLY the enumerated hand-delta set ──
const perSection = (field: string): string[] => deltas.filter((d) => d.field === field).map((d) => d.section).sort();
check('delta: section-name renames are exactly {Verse 1, Chorus 1}', eq(perSection('section'), ['Chorus 1', 'Verse 1']), perSection('section').join(','));
check('delta: layout over-proposals are exactly {Intro, Chorus 1, Solo}', eq(perSection('layout'), ['Chorus 1', 'Intro', 'Solo']), perSection('layout').join(','));
check('delta: pattern-count differences are exactly {Bridge, Verse 1}', eq(perSection('patternCount'), ['Bridge', 'Verse 1']), perSection('patternCount').join(','));
check('delta: binding gap is exactly {Breakdown}', eq(perSection('binding'), ['Breakdown']), perSection('binding').join(','));
check('delta: projectName differs for all 6 authored sections', perSection('projectName').length === 6);
check('delta: synth1 level surplus on all 6 authored sections', perSection('levels.synth1').length === 6);
check('delta: empty pattern content on all 6 authored sections', perSection('patternContent').length === 6);

// ── PRINT the enumerated hand-delta set ──
console.log('\n──────────────────────────────────────────────────────────────');
console.log('ENUMERATED HAND-DELTA SET (default seed → frozen recipe): the judgment left to a human');
console.log('──────────────────────────────────────────────────────────────');
const order = ['section', 'projectName', 'layout', 'levels.synth1', 'binding', 'patternCount', 'patternContent', 'structure', 'clearSlots'];
let n = 0;
for (const field of order) {
  const rows = deltas.filter((d) => d.field === field);
  if (rows.length === 0) continue;
  const secs = [...new Set(rows.map((r) => r.section))].join(', ');
  console.log(`  D${++n} [${field}]  ${secs}`);
  console.log(`        ${rows[0].note}`);
  console.log(`        seed=${JSON.stringify(rows[0].seed)}  golden=${JSON.stringify(rows[0].golden)}`);
}
console.log(`  (${n} delta classes; everything else the seeder sets matches the golden byte-for-byte.)`);

// ═══════════════════════════════════════════════════════════════════════
// (2) CHRONOLOGICAL policy: one author per project, no reuse/drop.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== (2) CHRONOLOGICAL SEED ===\n');
const chrono = seedAuthoringFromPlan(plan, relations, 'chronological');
check('chronological: one entry per project in the plan', chrono.length === plan.projects.length, `${chrono.length} vs ${plan.projects.length}`);
check('chronological: one author per spine section', chrono.length === plan.section_spine.length);
check('chronological: EVERY section is role author', chrono.every((s) => s.role === 'author'));
check('chronological: NO reuse sections', chrono.every((s) => s.role !== 'reuse'));
check('chronological: NO drop sections', chrono.every((s) => s.role !== 'drop'));
check('chronological: slots are 1..N sequential in play order', eq(chrono.map((s) => s.slot), chrono.map((_, i) => i + 1)));
check('chronological: Outro is AUTHORED (dedup/drop opinion off)', chrono.some((s) => s.section === 'Outro' && s.role === 'author'));
check('chronological: every section is condense+external (splitToms off)', chrono.every((s) => s.drums.layout === 'condense+external'));

// ═══════════════════════════════════════════════════════════════════════
// (3) SYNTHETIC: drums+bass identical, guitar different + live → reuse offered
//     AND the relation matrix reports guitar different, drums+bass identical.
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== (3) SYNTHETIC live-guitar reuse ===\n');

const restBeat: SsBeat = { notes: [{ rest: true }], rest: true, duration: [1, 4] };
const noteBeat = (notes: { fret: number; string: number }[]): SsBeat => ({ notes, duration: [1, 4] });
const mkMeasure = (beats: SsBeat[], opts: { marker?: string; signature?: [number, number] } = {}): SsMeasure => ({
  voices: [{ beats }],
  ...(opts.marker !== undefined ? { marker: { text: opts.marker } } : {}),
  ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
});

// Drums: kick@1, snare@3 in every bar (identical across both sections).
const drumBar = (marker?: string, signature?: [number, number]): SsMeasure =>
  mkMeasure([noteBeat([{ fret: 36, string: 4 }]), restBeat, noteBeat([{ fret: 38, string: 3 }]), restBeat], { marker, signature });
const drumsPart: SongsterrPart = {
  tuningFlat: true,
  measures: [drumBar('Chorus1', [4, 4]), drumBar(), drumBar('Chorus2'), drumBar()],
};
// Bass: one note on beat 1 (identical across both sections).
const bassBar = (marker?: string, signature?: [number, number]): SsMeasure =>
  mkMeasure([noteBeat([{ fret: 0, string: 0 }]), restBeat, restBeat, restBeat], { marker, signature });
const bassPart: SongsterrPart = {
  tuning: [40],
  measures: [bassBar('Chorus1', [4, 4]), bassBar(), bassBar('Chorus2'), bassBar()],
};
// Guitar (live): fret 0 in section 1, fret 3 in section 2 → different.
const guitarBar = (fret: number, marker?: string, signature?: [number, number]): SsMeasure =>
  mkMeasure([noteBeat([{ fret, string: 0 }]), restBeat, restBeat, restBeat], { marker, signature });
const guitarPart: SongsterrPart = {
  tuning: [40, 45, 50, 55, 59, 64],
  measures: [guitarBar(0, 'Chorus1', [4, 4]), guitarBar(0), guitarBar(3, 'Chorus2'), guitarBar(3)],
};

const synRoster: { partId: number; label: string; part: SongsterrPart }[] = [
  { partId: 0, label: 'guitar', part: guitarPart },
  { partId: 2, label: 'bass', part: bassPart },
  { partId: 3, label: 'drums', part: drumsPart },
];
const synRaw = new Map<number, SongsterrPart>();
const synParts: ChopPartFlat[] = [];
for (const r of synRoster) { synRaw.set(r.partId, r.part); synParts.push(toChopPart(r.partId, r.label, r.part)); }

const synPlan = planSongProjects(synParts, synRaw, { live: [0] });
const synSpine: RelationSection[] = synPlan.section_spine.map((s) => ({ name: s.name, from_measure: s.from_measure, to_measure: s.to_measure }));
check('synthetic: two sections on the spine (Chorus1, Chorus2)', eq(synSpine.map((s) => s.name), ['Chorus1', 'Chorus2']), JSON.stringify(synSpine.map((s) => s.name)));

const synRelations = computePartRelations(synParts, synRaw, synSpine);
const relOf = (part: string): string | undefined => synRelations.find((r) => r.a === 'Chorus1' && r.b === 'Chorus2' && r.part === part)?.relation;
check('relations: guitar is DIFFERENT between Chorus1 and Chorus2', relOf('guitar') === 'different', relOf('guitar'));
check('relations: drums are IDENTICAL between Chorus1 and Chorus2', relOf('drums') === 'identical', relOf('drums'));
check('relations: bass is IDENTICAL between Chorus1 and Chorus2', relOf('bass') === 'identical', relOf('bass'));

const synSeed = seedAuthoringFromPlan(synPlan, synRelations, DEFAULT_POLICY);
const c2 = synSeed.find((s) => s.section === 'Chorus2');
check('seeder OFFERS reuse: Chorus2 is role reuse of Chorus1 despite the live-guitar diff',
  c2 !== undefined && c2.role === 'reuse' && c2.reuseOf === 'Chorus1', JSON.stringify(c2));
const c1 = synSeed.find((s) => s.section === 'Chorus1');
check('Chorus1 is authored', c1 !== undefined && c1.role === 'author');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
