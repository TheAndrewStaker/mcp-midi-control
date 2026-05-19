/**
 * BK-064 part 2: scene-leveling recipe library.
 *
 * Named recipes that describe a per-scene dB offset profile keyed by
 * scene-role (clean / rhythm / build / solo / breakdown / intro).
 * Apply by writing the recipe's dB offset to the Output 1 block's
 * level knob on each scene, tone-preserving — the amp/drive/cab
 * voicing stays put; only the master output level shifts per scene.
 *
 * Why Output-block offsets, not amp masters: amp master changes the
 * tone (push the tubes harder = different distortion character).
 * Output 1 block changes only the post-effects level, so the scenes
 * sound like louder/quieter versions of the same preset rather than
 * different tones. This is the canonical "scene leveling for
 * dynamics" approach Fractal players use.
 *
 * Source of truth: docs/_private/04-BACKLOG.md BK-064 sub-deliverable
 * 2. Profile values were authored from the BACKLOG's reference table:
 *
 *   arrangement_dynamic_rock — clean -6, rhythm 0, build -2, solo +3, breakdown -8
 *   arrangement_balanced_metal — intro -4, rhythm 0, solo +3, breakdown -3
 *   arrangement_loud_solo — rhythm 0, solo +5  (Metallica / lead-on-top mix)
 *   arrangement_modern_mix — rhythm 0, solo +2 (modern mix, solos sit in)
 *
 * Application:
 *   The recipe table is pure data. To apply, the agent maps each
 *   scene index to a scene-role (the agent decides which scene is
 *   "rhythm" vs "solo" — the recipe is intent-keyed, not scene-
 *   indexed) and writes the matching dB offset to the Output 1
 *   block's level knob via `set_param` after switching to that
 *   scene, OR via per-scene Output 1 channel params if the device
 *   supports it.
 *
 * Pure data. No I/O. Cross-device by construction — dB offsets are
 * device-agnostic; the Output 1 block exists on every Fractal
 * device, and Hydrasynth has VOICE_AMP_VOLUME for the analogous role.
 */

import type { RecipePort } from './pitch.js';

/**
 * Scene roles. Recipe authors pick offsets per role; the agent
 * decides which scene index maps to which role at apply time.
 */
export type SceneRole =
  | 'intro'
  | 'clean'
  | 'rhythm'
  | 'build'
  | 'solo'
  | 'breakdown';

export interface SceneLevelingRecipeSpec {
  readonly name: string;
  readonly description: string;
  /** Per-role dB offset. Roles not listed are not part of this recipe. */
  readonly offsets_db: Readonly<Partial<Record<SceneRole, number>>>;
  /** Recipes here are device-agnostic dB offsets; every Fractal device
   *  exposes an Output block with a level knob. Field present for
   *  parity with the other recipe families. */
  readonly applicable_devices: readonly RecipePort[];
}

/**
 * Recipe table. Keys are kebab-case `arrangement_<style>`.
 *
 * Numbers are display dB (signed). Apply by adding the offset to the
 * Output 1 block's level on the matching scene. Devices vary in how
 * Output 1 levels are addressed:
 *
 *   AM4: no separate Output block; use the Volume block (`volpan`)
 *     `volume` param. AM4 has 4 scenes, so the recipe can map up to
 *     4 of the 6 roles.
 *
 *   Axe-Fx II / III: dedicated Output 1 block. Most direct path is
 *     per-scene level (II: scene levels live in OUT1_LEVEL_SCENE_N;
 *     III: same with the corresponding III param). 8 scenes available.
 *
 *   Hydrasynth: no scenes. The agent can still use the recipe's role
 *     dB offsets to bake them into snapshots (Hydra "patches"), but
 *     this is informational rather than directly applicable.
 */
export const SCENE_LEVELING_RECIPES: Readonly<Record<string, SceneLevelingRecipeSpec>> =
  Object.freeze({
    arrangement_dynamic_rock: {
      name: 'arrangement_dynamic_rock',
      description:
        'Dynamic rock arrangement: clean intro pulls back, rhythm sits at unity, build climbs, solo on top, breakdown drops.',
      offsets_db: {
        clean: -6,
        rhythm: 0,
        build: -2,
        solo: 3,
        breakdown: -8,
      },
      applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    },
    arrangement_balanced_metal: {
      name: 'arrangement_balanced_metal',
      description:
        'Balanced metal arrangement: intro slightly down, rhythm at unity, solo +3 dB to cut, breakdown back.',
      offsets_db: {
        intro: -4,
        rhythm: 0,
        solo: 3,
        breakdown: -3,
      },
      applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    },
    arrangement_loud_solo: {
      name: 'arrangement_loud_solo',
      description:
        'Metallica / lead-on-top mix: rhythm at unity, solo +5 dB. Two-role recipe; use for 2-scene presets.',
      offsets_db: {
        rhythm: 0,
        solo: 5,
      },
      applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    },
    arrangement_modern_mix: {
      name: 'arrangement_modern_mix',
      description:
        'Modern mix style: rhythm at unity, solo +2 dB. Solos sit IN the mix rather than on top.',
      offsets_db: {
        rhythm: 0,
        solo: 2,
      },
      applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    },
  });

/**
 * Resolve a scene-leveling recipe for a target port. Same contract as
 * the other resolver helpers: throws on unknown name / non-applicable
 * port, returns the per-role offset table on success.
 */
export function resolveSceneLevelingRecipe(
  recipeName: string,
  port: RecipePort,
): Readonly<Partial<Record<SceneRole, number>>> {
  const recipe = SCENE_LEVELING_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(SCENE_LEVELING_RECIPES).join(', ');
    throw new Error(
      `unknown scene-leveling recipe '${recipeName}'. Known recipes: ${known}`,
    );
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `scene-leveling recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  return recipe.offsets_db;
}

/**
 * Look up a single role's dB offset within a recipe. Returns
 * `undefined` when the recipe does not define that role (so the agent
 * can decide whether to skip that scene or fall back to unity).
 */
export function lookupSceneRoleOffset(
  recipeName: string,
  port: RecipePort,
  role: SceneRole,
): number | undefined {
  const offsets = resolveSceneLevelingRecipe(recipeName, port);
  return offsets[role];
}
