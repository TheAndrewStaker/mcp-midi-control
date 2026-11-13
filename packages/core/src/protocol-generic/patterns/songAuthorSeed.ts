/**
 * songAuthorSeed — turn a `SongProjectPlan` + the per-part relations into a
 * DEFAULT `SectionAuthoring[]` proposal under a policy (BK-AUTHORING-ENGINE, Item B).
 *
 * This is the seeder in the architecture diagram: it produces the recipe a web UI
 * (or a session) then edits before the engine turns it into operations. It PRODUCES
 * a proposal; it never reads the frozen golden recipe. Everything opinionated lives
 * here, not in the engine core: the engine treats the recipe as truth, and the
 * policy only changes what THIS proposes.
 *
 * The opinions, all defaulting ON (the 'chronological' preset turns them all OFF):
 *  - `levels` drums-up: {drum1..4:100, synth1:0}.
 *  - `dedup` / `reuseAcrossLiveDiff`: a section is `reuse` of an earlier one when
 *    the plan's dedup (which keys on the MAPPED = non-live backing parts) points its
 *    play order at that earlier project. A live part differing does NOT block reuse
 *    while `reuseAcrossLiveDiff` is on; with it off, a live part that is not
 *    identical/superset/prefix (per the relations) demotes the section back to
 *    `author`. This is why the relations are an INPUT: they are the reuse evidence
 *    and the live-diff gate.
 *  - `dropLive`: sections the plan dropped (only live/decorative content) become
 *    `drop`; with it off they are authored anyway.
 *  - `splitToms`: a doubled-tom section (`SongProject.doubled_toms`) is proposed as
 *    `explicit-binding` (internal-only, per-track sample binding); otherwise
 *    `condense+external`.
 *  - `bakeFills`: recognized; it governs per-use fill baking, which is a `pool` +
 *    trigger concern (the engine/recipe pool layer), so it does not change the
 *    section STRUCTURE this returns.
 *
 * Pattern strategy is bar-count driven: <=2 bars is one pattern; more is an
 * arrangement chain. Without per-section periodicity in the plan the chain defaults
 * to the HW-confirmed [1,2] two-pattern A/B, which the human refines (collapsing a
 * single repeating phrase back to one pattern is one of the measured hand-deltas).
 * The seeder cannot know pattern CONTENT (drum grids / bass lines) or sample NAMES,
 * so those are left empty for the human to fill; that gap is the point of the
 * enumerated hand-delta set the verify prints.
 */

import { STEPS_PER_PATTERN } from './songChop.js';
import { type SongProject, type SongProjectPlan } from './songPlanner.js';
import { findRelation } from './songPartRelations.js';
import {
  type PartRelation,
  type PatternSpec,
  type SectionAuthoring,
  type SectionDrums,
  type SeedPolicy,
} from './songAuthorTypes.js';

/** Normalized policy flags; the 'chronological' preset is all-off. */
interface SeedFlags {
  dedup: boolean;
  dropLive: boolean;
  reuseAcrossLiveDiff: boolean;
  splitToms: boolean;
  bakeFills: boolean;
  /** Every section its own author in play order, no reuse/drop. */
  chronological: boolean;
}

function resolveFlags(policy: SeedPolicy): SeedFlags {
  if (policy === 'chronological') {
    return { dedup: false, dropLive: false, reuseAcrossLiveDiff: false, splitToms: false, bakeFills: false, chronological: true };
  }
  return { ...policy, chronological: false };
}

/** The stored mixer levels: drums up (100), bass on synth1 down (0). */
function drumsUpLevels(): Record<string, number> {
  return { drum1: 100, drum2: 100, drum3: 100, drum4: 100, synth1: 0 };
}

/**
 * Bar count → pattern strategy.
 *  - <=2 bars: one pattern covering the section (steps = bars x steps/bar, capped).
 *  - >2 bars: a two-pattern A/B arrangement (the HW-confirmed [1,2] chain), each 2
 *    bars. The count is a deliberate default: without periodicity in the plan the
 *    seeder cannot tell a single repeating phrase from a two-phrase cell, so it
 *    proposes the safe chain and lets the human collapse it.
 *
 * Content is empty (the seeder does not know the grids); names are section-local.
 */
function seedPatterns(project: SongProject, stepsPerBar: number): PatternSpec[] {
  const cap = (n: number): number => Math.min(n, STEPS_PER_PATTERN);
  if (project.bars <= 2) {
    return [{ name: project.section, steps: cap(project.bars * stepsPerBar), drumVoices: {} }];
  }
  const perPattern = cap(2 * stepsPerBar);
  return [
    { name: `${project.section}A`, steps: perPattern, drumVoices: {} },
    { name: `${project.section}B`, steps: perPattern, drumVoices: {} },
  ];
}

/** Build the drums block for an authored section under the flags. */
function seedDrums(project: SongProject, flags: SeedFlags): SectionDrums {
  const explicit = flags.splitToms && project.doubled_toms;
  if (explicit) {
    // Internal-only per-track binding. The four sample NAMES are content the seeder
    // cannot know, so `binding` is left for the human to fill; no external mirror,
    // because the voice-abuse that needs explicit binding breaks the external GM map.
    return { layout: 'explicit-binding', levels: drumsUpLevels() };
  }
  return {
    layout: 'condense+external',
    external: { device: 'spd-sx', track: 'midi2' },
    levels: drumsUpLevels(),
  };
}

/** Build one authored/live SectionAuthoring (full derived structure). */
function buildAuthorSection(project: SongProject, slot: number, flags: SeedFlags, stepsPerBar: number): SectionAuthoring {
  return {
    section: project.section,
    role: 'author',
    slot,
    projectName: project.name,
    drums: seedDrums(project, flags),
    patterns: seedPatterns(project, stepsPerBar),
  };
}

/**
 * Seed a `SectionAuthoring[]` proposal from a plan + relations under a policy.
 *
 * Default policy (all opinion on): authors the plan's kept-and-unique projects,
 * marks the plan's deduped projects `reuse` (pointing at the earlier project's
 * slot), and marks the plan's dropped projects `drop`. `chronological`: every
 * project its own `author` in play order, no reuse/drop.
 *
 * Slots are 1-based and assigned in play order: each authored project takes the
 * next slot; a reuse takes the slot already given to its target; a drop takes 0
 * (unplaced). Sections are returned in the plan's play order.
 */
export function seedAuthoringFromPlan(
  plan: SongProjectPlan,
  partRelations: PartRelation[],
  policy: SeedPolicy,
): SectionAuthoring[] {
  const flags = resolveFlags(policy);
  const stepsPerBar = plan.ceiling.steps_per_bar > 0 ? plan.ceiling.steps_per_bar : STEPS_PER_PATTERN / 2;

  const nameOfProject = new Map<number, string>(plan.projects.map((p) => [p.project, p.section]));
  const liveLabels = plan.parts.filter((p) => p.live).map((p) => p.label);

  // Assigned slot per project number, so a reuse can point at its target's slot.
  const slotOf = new Map<number, number>();
  let nextSlot = 1;

  const out: SectionAuthoring[] = [];

  for (const project of plan.projects) {
    // ── chronological: everything authored, in order, no reuse/drop ──
    if (flags.chronological) {
      const slot = nextSlot++;
      slotOf.set(project.project, slot);
      out.push(buildAuthorSection(project, slot, flags, stepsPerBar));
      continue;
    }

    // ── DROP: only live/decorative content backs this section ──
    if (project.drop && flags.dropLive) {
      slotOf.set(project.project, 0);
      out.push({
        section: project.section,
        role: 'drop',
        slot: 0,
        projectName: project.name,
        drums: { layout: 'condense+external', levels: drumsUpLevels() },
        patterns: [],
      });
      continue;
    }

    // ── REUSE: the plan deduped this onto an earlier project (keyed on the
    //    mapped/non-live backing parts). A live diff blocks it only when
    //    reuseAcrossLiveDiff is off. ──
    if (flags.dedup && project.reuse_of !== undefined) {
      const targetName = nameOfProject.get(project.reuse_of);
      const targetSlot = slotOf.get(project.reuse_of);
      const liveBlocks = !flags.reuseAcrossLiveDiff && targetName !== undefined
        && liveLabels.some((label) => {
          const rel = findRelation(partRelations, targetName, project.section, label);
          return rel !== undefined && rel.relation === 'different';
        });
      if (targetName !== undefined && targetSlot !== undefined && !liveBlocks) {
        slotOf.set(project.project, targetSlot);
        out.push({
          section: project.section,
          role: 'reuse',
          reuseOf: targetName,
          slot: targetSlot,
          projectName: project.name,
          drums: { layout: 'condense+external', levels: drumsUpLevels() },
          patterns: [],
        });
        continue;
      }
      // fall through to author when a live diff blocks reuse
    }

    // ── AUTHOR: kept, unique (or a demoted reuse / un-dropped live section) ──
    const slot = nextSlot++;
    slotOf.set(project.project, slot);
    out.push(buildAuthorSection(project, slot, flags, stepsPerBar));
  }

  return out;
}
