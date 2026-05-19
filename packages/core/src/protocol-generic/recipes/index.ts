/**
 * Recipe library re-exports (BK-061 + BK-062).
 *
 * Pure-data per-block recipe tables + per-block `resolveXxxRecipe`
 * lookup helpers. No tools registered here yet — the unified
 * `apply_preset` integration lands in a follow-on after Stream A's
 * writer changes merge. See per-file headers for design + provenance.
 */

export {
  PITCH_RECIPES,
  resolvePitchRecipe,
  type PitchRecipeSpec,
  type RecipePort,
} from './pitch.js';

export {
  WAH_RECIPES,
  resolveWahRecipe,
  type WahRecipeSpec,
} from './wah.js';

export {
  FILTER_RECIPES,
  resolveFilterRecipe,
  type FilterRecipeSpec,
} from './filter.js';
