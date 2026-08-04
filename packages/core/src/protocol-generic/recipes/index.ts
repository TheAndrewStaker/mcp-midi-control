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

export {
  AMP_RECIPES,
  resolveAmpRecipe,
  type AmpRecipeSpec,
} from './amp.js';

export {
  REVERB_RECIPES,
  resolveReverbRecipe,
  type ReverbRecipeSpec,
} from './reverb.js';

export {
  AUTO_WAH_RECIPES,
  resolveAutoWahRecipe,
  type AutoWahRecipeSpec,
} from './autoWah.js';

export {
  SCENE_LEVELING_RECIPES,
  resolveSceneLevelingRecipe,
  lookupSceneRoleOffset,
  type SceneLevelingRecipeSpec,
  type SceneRole,
} from './sceneLeveling.js';

export {
  BLOCK_STACK_RECIPES,
  resolveBlockStackRecipe,
  type BlockStackRecipeSpec,
  type BlockStackSlotSpec,
} from './blockStack.js';

export {
  summarizeRecipesForPort,
  describeRecipeForPort,
  type RecipeSummaryEntry,
  type RecipeDetailEntry,
} from './summary.js';

export {
  materializeBlockStackRecipe,
  RecipeMaterializeError,
} from './materialize.js';

export {
  HYDRA_PATCH_RECIPES,
  resolveHydraPatchRecipe,
  materializeHydraPatchRecipe,
  type HydraCategory,
  type HydraModRoute,
  type HydraMacroRoute,
  type PatchRecipeSpec,
  type MaterializedHydraPatch,
} from './patchArchetype.js';
