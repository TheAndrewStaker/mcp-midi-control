/**
 * Named pattern library (pure data), the rhythmic analog of `recipes/`.
 *
 * Most spoken requests ("give me a boom-bap beat") land here directly.
 * Authored as dense char grids so the data reads at a glance; each grid
 * compiles to `Step[]` through `charGridToSteps`, the same internal truth
 * the mini-notation parser produces.
 *
 * Genre note: these are conventional, widely-taught patterns (not copied
 * from any product's preset bank). Voices use the abstract names the
 * target's `voice_map` resolves (kick/snare/hat/openhat/clap).
 */

import type { NeutralPattern } from './types.js';
import { charGridToSteps, parseVoice } from './miniNotation.js';

/** Build a NeutralPattern from char grids; validates equal lengths. */
function pattern(
  name: string,
  description: string,
  tags: readonly string[],
  grids: Record<string, string>,
): NeutralPattern {
  const voices: Record<string, { steps: ReturnType<typeof charGridToSteps> }> = {};
  let steps = 0;
  for (const [voice, grid] of Object.entries(grids)) {
    const parsed = charGridToSteps(grid);
    if (steps === 0) steps = parsed.length;
    else if (parsed.length !== steps) {
      throw new Error(`Pattern "${name}" voice "${voice}" has ${parsed.length} steps, expected ${steps}.`);
    }
    voices[voice] = { steps: parsed };
  }
  return { name, steps, bars: 1, voices, tags, description };
}

/**
 * Build a MELODIC NeutralPattern from note-token lines (one per voice). Unlike
 * the drum `pattern()` helper (char grids), each line carries pitch:
 * `"c2 ~ g2 ~"`, `"c3+eb3+g3 ~ ~ ~"`. Voices use the neutral melodic names
 * (bass/lead/chord/arp) a target's voice_map routes onto its note tracks.
 * Pitched in C (minor/major as noted); the agent transposes to the asked key.
 */
function melodic(
  name: string,
  description: string,
  tags: readonly string[],
  steps: number,
  lines: Record<string, string>,
): NeutralPattern {
  const voices: Record<string, { steps: ReturnType<typeof parseVoice> }> = {};
  for (const [voice, line] of Object.entries(lines)) {
    const parsed = parseVoice(line, steps);
    if (parsed.length !== steps) {
      throw new Error(`Pattern "${name}" voice "${voice}" has ${parsed.length} steps, expected ${steps}.`);
    }
    voices[voice] = { steps: parsed };
  }
  return { name, steps, bars: 1, voices, tags, description };
}

export const PATTERN_RECIPES: Readonly<Record<string, NeutralPattern>> = Object.freeze({
  four_on_the_floor: pattern(
    'four_on_the_floor',
    'House/disco staple: kick on every quarter, snare on the backbeat, steady eighth hats.',
    ['house', 'disco', 'four-four'],
    {
      kick:  'x...x...x...x...',
      snare: '....x.......x...',
      hat:   'x.x.x.x.x.x.x.x.',
    },
  ),
  boom_bap: pattern(
    'boom_bap',
    'Classic hip-hop: kick on 1 and the "and" of 2, snare on 2 and 4, swung-feel eighth hats.',
    ['hip-hop', 'boom-bap'],
    {
      kick:  'x.....x.x.......',
      snare: '....x.......x...',
      hat:   'x.x.x.x.x.x.x.x.',
    },
  ),
  half_time: pattern(
    'half_time',
    'Half-time feel: snare lands on beat 3 (instead of 2 and 4), giving a slow, heavy groove.',
    ['half-time', 'trap', 'rock'],
    {
      kick:  'x.......x.......',
      snare: '........x.......',
      hat:   'x.x.x.x.x.x.x.x.',
    },
  ),
  two_step: pattern(
    'two_step',
    'UK garage two-step: skippy kick, snare on the backbeat, broken offbeat hats.',
    ['garage', 'two-step', 'uk'],
    {
      kick:  'x......x..x.....',
      snare: '....x.......x...',
      hat:   '..x..x..x..x..x.',
    },
  ),
  amen: pattern(
    'amen',
    'Amen-break flavored 16th pattern: the canonical jungle/DnB kick-snare interplay.',
    ['breakbeat', 'dnb', 'jungle'],
    {
      kick:  'x.x.....x.x.....',
      snare: '....x..x..x..x..',
      hat:   'xxxxxxxxxxxxxxxx',
    },
  ),
  trap_hats: pattern(
    'trap_hats',
    'Trap skeleton: sparse booming kick, clap on the backbeat, rolling hats with a triplet burst.',
    ['trap', 'hats'],
    {
      kick:  'x.....x.....x...',
      clap:  '....x.......x...',
      hat:   'x.x.x.xxxx.x.x.x',
    },
  ),

  // ── Melodic building blocks (note tracks) ──────────────────────────
  minor_triad: melodic(
    'minor_triad',
    'A C-minor triad held on the downbeat then again on beat 3 — a simple two-stab chord bed (chord voice).',
    ['chord', 'minor', 'pad'],
    16,
    { chord: 'c3+eb3+g3 ~ ~ ~ ~ ~ ~ ~ c3+eb3+g3 ~ ~ ~ ~ ~ ~ ~' },
  ),
  major_triad: melodic(
    'major_triad',
    'A C-major triad on beats 1 and 3 — bright two-stab chord bed (chord voice).',
    ['chord', 'major', 'pad'],
    16,
    { chord: 'c3+e3+g3 ~ ~ ~ ~ ~ ~ ~ c3+e3+g3 ~ ~ ~ ~ ~ ~ ~' },
  ),
  octave_bass: melodic(
    'octave_bass',
    'A driving sixteenth-note bass on the root (C2) with an octave lift (C3) on each eighth-note off-beat — electronic/synthwave staple (bass voice).',
    ['bass', 'electronic', 'octave'],
    16,
    { bass: 'c2 c2 c3 c2 c2 c2 c3 c2 c2 c2 c3 c2 c2 c2 c3 c2' },
  ),
  minor_arp_up: melodic(
    'minor_arp_up',
    'An ascending C-minor arpeggio (root, b3, 5, octave) repeated each beat — classic sequenced-synth motion (arp voice).',
    ['arp', 'minor', 'sequence'],
    16,
    { arp: 'c3 eb3 g3 c4 c3 eb3 g3 c4 c3 eb3 g3 c4 c3 eb3 g3 c4' },
  ),
  lead_hook: melodic(
    'lead_hook',
    'A short syncopated minor-pentatonic lead hook over one bar — a singable topline to build on (lead voice).',
    ['lead', 'melody', 'minor-pentatonic'],
    16,
    { lead: 'g3 ~ bb3 c4 ~ bb3 g3 ~ f3 ~ g3 ~ eb3 ~ ~ ~' },
  ),
});

export function resolvePatternRecipe(id: string): NeutralPattern | undefined {
  return PATTERN_RECIPES[id];
}

export function listPatternRecipeIds(): readonly string[] {
  return Object.keys(PATTERN_RECIPES);
}
