/**
 * songAuthor — the deterministic song authoring engine core (BK-AUTHORING-ENGINE, Item A).
 *
 * `buildProjectOps(recipe)` turns a SongRecipe into a target-neutral `Operation[]`. It is PURE and
 * POLICY-FREE: the recipe is truth. No device I/O, no Circuit tool names, no dedup / drop / reuse
 * opinion. All opinion lives in the seeder (Item B) and arrives here already resolved to concrete
 * `role` decisions on each section. See docs/_private/PLAN-authoring-engine-2026-09-05.md.
 *
 * Emit order (plan rules 1-6):
 *   1. one `placeSample` per pool item whose `source` is a baked file (`{bakedFrom}`). A `'kit'`
 *      pool item is a precondition (already on the pack) and emits nothing.
 *   2. one `clearSlot` carrying every slot in `recipe.clearSlots`, ONLY when that list is non-empty.
 *   3. one `authorProject` per section whose `role` is `'author'`, in section order.
 *
 * Sections with role `'reuse'` or `'drop'` emit NO op, by design:
 *   - `'reuse'` is a play-order pointer only: its `reuseOf` names the section whose already-authored
 *     project slot the play order should land on. Nothing is authored for it here; that pointer is
 *     resolved downstream (by the adapter / performer / play-order layer), not by this engine.
 *   - `'drop'` is authored nowhere at all (the section is cut from the build).
 *
 * A section's `ResolvedProject` is assembled by passing the section's own material straight through
 * (`patterns` untouched, drum `binding` kept as sample NAMES, `external` route, mixer `levels`,
 * `projectName`) and layering the project-wide `globals` over it (`colour` / `tempo` /
 * `soundingPitch` / `template`). Nothing is transformed — sample names stay names (the adapter
 * resolves them to wire slots). The one computed field is `chainBeyondConfirmed`, set `true` when a
 * section chains more than two patterns (the HW-confirmed range is `[1,2]`); it is a FLAG for the
 * receipt to hedge on, NEVER a refusal.
 */
import type {
  Operation,
  PatternSpec,
  ResolvedProject,
  SectionAuthoring,
  SongGlobals,
  SongRecipe,
} from './songAuthorTypes.js';

/** Thrown when a section's variant group cannot be authored (mode conflict / bad reference). */
export class SongAuthorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SongAuthorError';
  }
}

/** Assemble one section's fully-resolved, target-neutral project payload (section + globals). */
function resolveProject(section: SectionAuthoring, globals: SongGlobals): ResolvedProject {
  // HW-confirmed chain range is [1,2]; a longer chain is decoded-beta → flag, never refuse.
  const chainBeyondConfirmed = section.patterns.length > 2 ? true : undefined;
  return {
    projectName: section.projectName,
    colour: globals.colour,
    tempo: globals.tempo,
    soundingPitch: globals.soundingPitch,
    template: globals.template,
    patterns: section.patterns,
    binding: section.drums.binding,
    external: section.drums.external,
    internalCondense: section.drums.layout === 'internal-condense' ? true : undefined,
    levels: section.drums.levels,
    chainBeyondConfirmed,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// VARIANT GROUPS (BK-SONG-AUTHOR-2, Item D — patterns-mechanism, Phase 1)
//
// A single-pattern section can carry `variants` (a base plus named variations the performer swaps
// live). The variation PATTERNS live in the section's `patterns` array alongside the base, matched by
// `PatternSpec.name` (`VariantGroup.base` names the base; each `VariantGroup.variants[].name` names an
// alternate). `resolveVariants` splits the two: the BASE is authored by `buildProjectOps` (kept a
// single pattern), and the per-variation extra pattern SLOTS are handed to the adapter to render as
// extra pattern slots on the one differing track.
//
// Two hard rules (review D):
//   - `mechanism:'patterns'` only applies to a SINGLE-pattern base. A multi-pattern (arrangement) base
//     plays as one global chain that advances all tracks together; swapping one track's range against
//     it is a different mode, so it is REFUSED and routed to scenes (Phase 2).
//   - a patterns variation must differ from the base on exactly ONE track (the fill track). Differing
//     on several tracks is a whole-snapshot swap → scenes (Phase 2).
//   - `mechanism:'scenes'` is accepted in the contract but is a Phase-2 no-op here.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Flatten a PatternSpec to a neutral `track → steps` map: drum voices, the legacy `bassVoice`
 * (== synth1), and each melodic voice on its `target.track`. Every key is a neutral contract track
 * name (a drum voice key, or synth1/synth2/midi1/midi2), so the diff below is target-agnostic.
 */
function flattenPatternVoices(p: PatternSpec): Record<string, string> {
  const v: Record<string, string> = { ...p.drumVoices };
  if (p.bassVoice !== undefined) v.synth1 = p.bassVoice;
  if (p.melodic !== undefined) for (const voice of Object.values(p.melodic)) v[voice.target.track] = voice.steps;
  return v;
}

/** Track keys whose step string differs between two flattened patterns (union of keys, sorted). */
function diffTracks(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) out.push(k);
  return out.sort();
}

/** One patterns-mechanism variant group resolved to renderable extra pattern slots on one track. */
export interface VariantPatternPlan {
  /** Which `VariantGroup.element` this realizes, e.g. "fill". */
  element: string;
  /** The ONE track whose active pattern the performer swaps live (a drum voice or a note track). */
  track: string;
  mechanism: 'patterns';
  /** The base variation: its pattern name and the differing track's base step string (pattern slot 1). */
  base: { name: string; steps: string };
  /** One alternate pattern slot per named variation, each differing from the base ONLY on `track`. */
  slots: { name: string; steps: string }[];
}

/** The split of a section's variants: the base to author, the patterns plans, the deferred scenes. */
export interface ResolvedVariants {
  /** `section.patterns` with the patterns-mechanism variation patterns removed (the base to author). */
  basePatterns: PatternSpec[];
  /** One plan per patterns-mechanism group. */
  patternPlans: VariantPatternPlan[];
  /** Elements of scenes-mechanism groups accepted but deferred to Phase 2 (no-op here). */
  scenesDeferred: string[];
}

/**
 * Resolve a section's `variants` into the base patterns to author plus the per-track variation plans.
 * Pure; throws `SongAuthorError` on a mode conflict (multi-pattern base with a patterns variant, a
 * variation that differs on more than one track, or a dangling name). A section with no variants
 * returns its patterns unchanged.
 */
export function resolveVariants(section: SectionAuthoring): ResolvedVariants {
  const groups = section.variants ?? [];
  if (groups.length === 0) return { basePatterns: section.patterns, patternPlans: [], scenesDeferred: [] };

  const byName = new Map(section.patterns.map((p) => [p.name, p]));
  const patternPlans: VariantPatternPlan[] = [];
  const scenesDeferred: string[] = [];
  const variationNames = new Set<string>(); // names removed from the authored base

  for (const g of groups) {
    if (g.mechanism === 'scenes') {
      // Phase 2: accepted in the contract, no-op here. A whole-snapshot swap is authored as scenes by
      // Item E, not as patterns; the section authors its base as-is.
      scenesDeferred.push(g.element);
      continue;
    }
    const base = byName.get(g.base);
    if (base === undefined) {
      throw new SongAuthorError(
        `section "${section.section}": variant group "${g.element}" names base pattern "${g.base}", ` +
        `not present in the section's patterns (${section.patterns.map((p) => p.name).join(', ') || 'none'}).`,
      );
    }
    const baseVoices = flattenPatternVoices(base);
    const slots: { name: string; steps: string }[] = [];
    let track: string | undefined;
    for (const v of g.variants) {
      const vp = byName.get(v.name);
      if (vp === undefined) {
        throw new SongAuthorError(
          `section "${section.section}": variant "${v.name}" (group "${g.element}") names no pattern in the section.`,
        );
      }
      variationNames.add(v.name);
      const differing = diffTracks(baseVoices, flattenPatternVoices(vp));
      if (differing.length === 0) {
        throw new SongAuthorError(
          `section "${section.section}": variant "${v.name}" is identical to base "${g.base}"; a variation must differ on exactly one track.`,
        );
      }
      if (differing.length > 1) {
        throw new SongAuthorError(
          `section "${section.section}": variant "${v.name}" differs from the base on ${differing.length} tracks (${differing.join(', ')}). ` +
          'A patterns-mechanism variant swaps ONE track; a whole-snapshot variation must be authored as a scene instead.',
        );
      }
      const t = differing[0];
      if (track === undefined) track = t;
      else if (track !== t) {
        throw new SongAuthorError(
          `section "${section.section}": variant group "${g.element}" swaps more than one track (${track}, ${t}). ` +
          'Keep one fill track per group; a whole-snapshot swap must be authored as a scene instead.',
        );
      }
      slots.push({ name: v.name, steps: flattenPatternVoices(vp)[t] ?? '' });
    }
    if (track === undefined) {
      throw new SongAuthorError(`section "${section.section}": variant group "${g.element}" has no variations.`);
    }
    patternPlans.push({ element: g.element, track, mechanism: 'patterns', base: { name: base.name, steps: baseVoices[track] ?? '' }, slots });
  }

  const basePatterns = section.patterns.filter((p) => !variationNames.has(p.name));
  // The single-pattern restriction (mode conflict, review D): the authored base must be ONE pattern.
  if (patternPlans.length > 0 && basePatterns.length !== 1) {
    throw new SongAuthorError(
      `section "${section.section}": patterns-mechanism variants require a SINGLE-pattern section, but the base is ` +
      `${basePatterns.length} pattern(s) (${basePatterns.map((p) => p.name).join(', ') || 'none'}). ` +
      'A multi-pattern (arrangement) section plays as one global chain; author whole-section variations as scenes instead.',
    );
  }
  return { basePatterns, patternPlans, scenesDeferred };
}

/**
 * Turn a recipe into the ordered list of authoring operations. Pure: no device, no policy, no side
 * effects. The recipe is the single source of truth.
 */
export function buildProjectOps(recipe: SongRecipe): Operation[] {
  const ops: Operation[] = [];
  const { globals } = recipe;

  // 1. placeSample for every baked pool item. 'kit' items are preconditions and emit nothing.
  for (const item of recipe.pool) {
    if (typeof item.source === 'object' && 'bakedFrom' in item.source) {
      ops.push({
        kind: 'placeSample',
        pack: globals.pack,
        sample: { name: item.name, wireSlot: item.wireSlot, file: item.source.bakedFrom },
        overwrite: true,
      });
    }
  }

  // 2. clearSlot for the orphan slots this recipe supersedes (only when there are any).
  if (recipe.clearSlots && recipe.clearSlots.length > 0) {
    ops.push({
      kind: 'clearSlot',
      pack: globals.pack,
      slots: recipe.clearSlots,
      confirmDelete: true,
    });
  }

  // 3. authorProject per 'author' section, in order. 'reuse' / 'drop' sections emit nothing.
  for (const section of recipe.sections) {
    if (section.role !== 'author') continue;
    // A section with patterns-mechanism variants authors ONLY its base pattern here; the extra
    // per-track variation slots are rendered by the adapter (renderVariantPatterns). resolveVariants
    // enforces the single-pattern restriction and REFUSES a multi-pattern (arrangement) base.
    const authoringSection = (section.variants !== undefined && section.variants.length > 0)
      ? { ...section, patterns: resolveVariants(section).basePatterns }
      : section;
    ops.push({
      kind: 'authorProject',
      pack: globals.pack,
      slot: section.slot,
      project: resolveProject(authoringSection, globals),
      overwrite: true,
      backupFirst: false,
    });
  }

  return ops;
}
