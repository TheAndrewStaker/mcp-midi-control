/**
 * Golden: the CONTENT MERGE (songAuthorMerge, BK-SONG-AUTHOR-2 Item C).
 *
 * Self-contained (no hardware, no network): builds a seeded `SectionAuthoring[]` (empty
 * grids, as `seedAuthoringFromPlan` produces) + SYNTHETIC imported content inline, runs
 * `mergeContent`, and asserts the recipe is now COMPLETE:
 *
 *   - each authored section's `patterns[].drumVoices` holds the imported drum grids;
 *   - each melodic voice lands on its routed track (bass → synth1, pad → midi1);
 *   - the drums block is `internal-condense` with drums-up (100) levels + stored-silent synths;
 *   - STRUCTURE is reconciled: a 2-pattern seed given one window collapses to one pattern; a
 *     1-pattern seed given two windows expands to two — the imported window shape wins;
 *   - a reuse / drop section (and an authored section with no content) is left untouched;
 *   - an `internalAudible` route raises its synth track's stored level;
 *   - an imported melodic voice with no routing entry is REFUSED (MergeError).
 *
 * Run via:  npx tsx scripts/verify-song-author-merge.ts
 */

import {
  mergeContent,
  MergeError,
  type SectionContent,
  type RoutingConfig,
} from '../packages/core/src/protocol-generic/patterns/songAuthorMerge.js';
import { type SectionAuthoring } from '../packages/core/src/protocol-generic/patterns/songAuthorTypes.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail !== undefined ? `  — ${detail}` : ''}`); }
}

// ── Seeded input: the empty-grid structure the seeder emits ───────────────────
// Author sections carry the seeder's condense+external drums + empty drumVoices, so
// the merge visibly FLIPS them to internal-condense and fills the grids.
const seededExternal = () => ({
  layout: 'condense+external' as const,
  external: { device: 'spd-sx', track: 'midi2' },
  levels: { drum1: 100, drum2: 100, drum3: 100, drum4: 100, synth1: 0 },
});

const sections: SectionAuthoring[] = [
  // seeded ONE pattern (a <=2-bar section)
  {
    section: 'Verse A', role: 'author', slot: 1, projectName: 'Verse A',
    drums: seededExternal(),
    patterns: [{ name: 'Verse A', steps: 32, drumVoices: {} }],
  },
  // seeded TWO patterns (A/B guess) — content arrives as ONE window → collapse to 1
  {
    section: 'Chorus', role: 'author', slot: 2, projectName: 'Chorus',
    drums: seededExternal(),
    patterns: [
      { name: 'ChorusA', steps: 32, drumVoices: {} },
      { name: 'ChorusB', steps: 32, drumVoices: {} },
    ],
  },
  // seeded ONE pattern — content arrives as TWO windows → expand to 2
  {
    section: 'Bridge', role: 'author', slot: 3, projectName: 'Bridge',
    drums: seededExternal(),
    patterns: [{ name: 'Bridge', steps: 32, drumVoices: {} }],
  },
  // reuse: must be returned untouched (no content)
  {
    section: 'Verse B', role: 'reuse', reuseOf: 'Verse A', slot: 1, projectName: 'Verse B',
    drums: seededExternal(),
    patterns: [],
  },
  // drop: must be returned untouched
  {
    section: 'Outro', role: 'drop', slot: 0, projectName: 'Outro',
    drums: seededExternal(),
    patterns: [],
  },
];

// ── Synthetic imported content ────────────────────────────────────────────────
const VERSE_KICK = 'X...X...X...X...';
const VERSE_SNARE = '....X.......X...';
const VERSE_HAT = 'X.X.X.X.X.X.X.X.';
const VERSE_BASS = 'c1:4 e1:4 g1:4 e1:4';
const VERSE_PAD = 'c4:16';

const content: SectionContent = {
  'Verse A': {
    drumVoices: { kick: VERSE_KICK, snare: VERSE_SNARE, hat: VERSE_HAT },
    melodic: { bass: VERSE_BASS, pad: VERSE_PAD },
  },
  // single window although seeded as A/B → structure reconciles to ONE pattern
  'Chorus': {
    drumVoices: { kick: VERSE_KICK, snare: VERSE_SNARE },
    melodic: { bass: 'g1:8 g1:8' },
  },
  // two windows although seeded as one → structure reconciles to TWO patterns
  'Bridge': [
    { drumVoices: { kick: 'X.......X.......' }, melodic: { pad: 'a4:16' } },
    { drumVoices: { kick: 'X...X...X...X...' }, melodic: { pad: 'f4:16' } },
  ],
};

const routing: RoutingConfig = { bass: 'synth1', pad: 'midi1' };

const merged = mergeContent(sections, content, routing);
const bySection = (name: string): SectionAuthoring => {
  const s = merged.find((x) => x.section === name);
  if (s === undefined) throw new Error(`no merged section ${name}`);
  return s;
};

console.log('CONTENT MERGE — assertions\n');

// ── Verse A: the primary fill + routing + internal-condense case ──────────────
{
  const v = bySection('Verse A');
  check('Verse A stays one pattern', v.patterns.length === 1, `len=${v.patterns.length}`);
  const p = v.patterns[0];
  check('Verse A drum grids merged (kick)', p.drumVoices.kick === VERSE_KICK, JSON.stringify(p.drumVoices.kick));
  check('Verse A drum grids merged (snare)', p.drumVoices.snare === VERSE_SNARE);
  check('Verse A drum grids merged (hat)', p.drumVoices.hat === VERSE_HAT);
  check('Verse A melodic.bass.target.track === synth1', p.melodic?.bass.target.track === 'synth1', JSON.stringify(p.melodic?.bass));
  check('Verse A melodic.bass.steps preserved', p.melodic?.bass.steps === VERSE_BASS);
  check('Verse A melodic.pad.target.track === midi1', p.melodic?.pad.target.track === 'midi1', JSON.stringify(p.melodic?.pad));
  check('Verse A melodic.pad.steps preserved', p.melodic?.pad.steps === VERSE_PAD);
  check('Verse A drums layout === internal-condense', v.drums.layout === 'internal-condense', v.drums.layout);
  check('Verse A no external route after merge', v.drums.external === undefined);
  check('Verse A drum levels all 100',
    [v.drums.levels.drum1, v.drums.levels.drum2, v.drums.levels.drum3, v.drums.levels.drum4].every((l) => l === 100),
    JSON.stringify(v.drums.levels));
  check('Verse A synth tracks stored-silent (0)', v.drums.levels.synth1 === 0 && v.drums.levels.synth2 === 0, JSON.stringify(v.drums.levels));
}

// ── Chorus: structure reconciliation 2 → 1 ────────────────────────────────────
{
  const c = bySection('Chorus');
  check('Chorus collapses A/B guess to ONE pattern (single window)', c.patterns.length === 1, `len=${c.patterns.length}`);
  check('Chorus lone pattern is named for the section', c.patterns[0].name === 'Chorus', c.patterns[0].name);
  check('Chorus drum grid merged', c.patterns[0].drumVoices.kick === VERSE_KICK);
  check('Chorus bass routed to synth1', c.patterns[0].melodic?.bass.target.track === 'synth1');
  check('Chorus drums internal-condense', c.drums.layout === 'internal-condense');
}

// ── Bridge: structure reconciliation 1 → 2 ────────────────────────────────────
{
  const b = bySection('Bridge');
  check('Bridge expands one seeded pattern to TWO (two windows)', b.patterns.length === 2, `len=${b.patterns.length}`);
  check('Bridge patterns named A/B', b.patterns[0].name === 'BridgeA' && b.patterns[1].name === 'BridgeB',
    `${b.patterns[0].name}, ${b.patterns[1].name}`);
  check('Bridge window 0 drum grid', b.patterns[0].drumVoices.kick === 'X.......X.......');
  check('Bridge window 1 drum grid', b.patterns[1].drumVoices.kick === 'X...X...X...X...');
  check('Bridge pad on both patterns routed to midi1',
    b.patterns[0].melodic?.pad.target.track === 'midi1' && b.patterns[1].melodic?.pad.target.track === 'midi1');
  check('Bridge window melodic content distinct', b.patterns[0].melodic?.pad.steps === 'a4:16' && b.patterns[1].melodic?.pad.steps === 'f4:16');
}

// ── reuse / drop untouched ────────────────────────────────────────────────────
{
  const vb = bySection('Verse B');
  check('Verse B (reuse) has NO content authored (patterns empty)', vb.patterns.length === 0);
  check('Verse B (reuse) drums untouched (still condense+external)', vb.drums.layout === 'condense+external', vb.drums.layout);
  check('Verse B (reuse) is the same object identity (unchanged)', vb === sections[3]);
  const o = bySection('Outro');
  check('Outro (drop) untouched', o.patterns.length === 0 && o.drums.layout === 'condense+external');
  check('Outro (drop) is the same object identity (unchanged)', o === sections[4]);
}

// ── input not mutated ─────────────────────────────────────────────────────────
{
  check('seeded input left empty (not mutated)', sections[0].patterns[0].drumVoices.kick === undefined && sections[0].drums.layout === 'condense+external');
}

// ── internal-audible route raises the synth track ─────────────────────────────
{
  const audibleRouting: RoutingConfig = { bass: { track: 'synth1', internalAudible: true }, pad: 'midi1' };
  const m = mergeContent(sections, content, audibleRouting);
  const v = m.find((x) => x.section === 'Verse A')!;
  check('internalAudible raises synth1 level to 100', v.drums.levels.synth1 === 100, JSON.stringify(v.drums.levels));
  check('internalAudible leaves synth2 silent', v.drums.levels.synth2 === 0);
  check('external-only (default) still routes bass to synth1', v.patterns[0].melodic?.bass.target.track === 'synth1');
}

// ── an unrouted melodic voice is REFUSED, never guessed ───────────────────────
{
  const badContent: SectionContent = {
    'Verse A': { drumVoices: { kick: VERSE_KICK }, melodic: { lead: 'e5:16' } },
  };
  let threw = false;
  let isMergeError = false;
  try {
    mergeContent(sections, badContent, routing);
  } catch (e) {
    threw = true;
    isMergeError = e instanceof MergeError;
  }
  check('an unrouted melodic voice throws', threw);
  check('the throw is a MergeError', isMergeError);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
