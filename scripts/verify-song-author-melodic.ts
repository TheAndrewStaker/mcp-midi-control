/**
 * Item-0 verify (BK-SONG-AUTHOR-2): the melodic-routing + internal-condense contract additions.
 * A recipe with a bass on synth1, a pad on midi1, and drums as `internal-condense` must emit an
 * apply_pattern with the two melodic voices on their tracks and condense_drums:true + NO external.
 */
import { buildProjectOps } from '../packages/core/src/protocol-generic/patterns/songAuthor.js';
import { adaptOps } from '../packages/circuit-tracks/src/authorAdapter.js';
import type { SongRecipe } from '../packages/core/src/protocol-generic/patterns/songAuthorTypes.js';

const recipe: SongRecipe = {
  globals: { pack: 5, template: 'blank.ncs', tempo: 155, colour: 'Cyan', soundingPitch: true },
  pool: [
    { name: 'kick', wireSlot: 0, source: 'kit' },
    { name: 'snare', wireSlot: 1, source: 'kit' },
  ],
  sections: [
    {
      section: 'Verse',
      role: 'author',
      slot: 1,
      projectName: 'Test Song Verse',
      drums: { layout: 'internal-condense', levels: { drum1: 100, drum2: 100, drum3: 100, drum4: 100 } },
      patterns: [
        {
          name: 'Verse',
          steps: 32,
          drumVoices: { kick: 'X...X...X...X...X...X...X...X...', snare: '....X.......X...' },
          melodic: {
            bass: { steps: 'c2:4@100 ~ ~ ~', target: { track: 'synth1' } },
            pad: { steps: 'g5:16@90 ~ ~ ~', target: { track: 'midi1' } },
          },
        },
      ],
      playback: 'loop',
    },
  ],
};

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${label}`);
  else { failed++; console.error(`  FAIL ${label}${detail ? `: ${detail}` : ''}`); }
}

const ops = buildProjectOps(recipe);
const calls = adaptOps(ops, { pool: recipe.pool, port: 'circuit' });
const author = calls.find((c) => c.tool === 'apply_pattern');
const a = (author as { args: Record<string, unknown> } | undefined)?.args ?? {};
const voices = (a.voices ?? {}) as Record<string, string>;

check('internal-condense → condense_drums:true', a.condense_drums === true, JSON.stringify(a.condense_drums));
check('internal-condense → NO external_targets', a.external_targets === undefined);
check('internal-condense → NO drum_binding', a.drum_binding === undefined);
check('bass melodic voice on synth1', voices.synth1 === 'c2:4@100 ~ ~ ~', JSON.stringify(voices.synth1));
check('pad melodic voice on midi1 (Sugar-arp path)', voices.midi1 === 'g5:16@90 ~ ~ ~', JSON.stringify(voices.midi1));
check('drum voices still present', voices.kick !== undefined && voices.snare !== undefined);
check('single pattern → top-level voices (not arrangement)', a.arrangement === undefined && a.steps === 32);

if (failed > 0) { console.error(`\nsong-author-melodic: ${failed} FAILED`); process.exit(1); }
console.log('\nsong-author-melodic: all checks passed');
