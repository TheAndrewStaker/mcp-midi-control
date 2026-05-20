/**
 * Recipe-discovery summary for `describe_device`.
 *
 * Background (senior MCP review 2026-05-20): per-block recipes
 * (auto_wah_funk, octave_up, wah_cocked_mid, filter_telephone,
 * arrangement_balanced_metal, etc.) ship as pure-data tables in
 * `recipes/*.ts` but are unreachable from the MCP tool surface. The
 * Session 105 sweep failure `am4-recipe-auto-wah` documents an agent
 * that knew the tone vocabulary ("envelope-follower behavior,
 * sweeping with my pick attack") but had no signal that FILTER block
 * is the answer on AM4, and bailed after five reads.
 *
 * No `apply_recipe` tool exists by design (founder-confirmed): recipes
 * are reference data the agent pastes into a single `apply_preset`
 * call. To make that possible from one `describe_device` response, the
 * summary embeds the per-port params dict + the target block so the
 * agent can paste without a second lookup.
 *
 * Shape per entry:
 *   { id, family, description, target_block, params, modifier_needed? }
 *
 * `params` is pre-filtered to the requested port. `applicable_devices`
 * is collapsed (a recipe absent on this port is not listed at all),
 * so the agent sees exactly what's safe to apply.
 */

import { AUTO_WAH_RECIPES } from './autoWah.js';
import { BLOCK_STACK_RECIPES, type BlockStackSlotSpec } from './blockStack.js';
import { FILTER_RECIPES } from './filter.js';
import { PITCH_RECIPES, type RecipePort } from './pitch.js';
import { SCENE_LEVELING_RECIPES } from './sceneLeveling.js';
import { WAH_RECIPES } from './wah.js';

export interface RecipeSummaryEntry {
  /** Stable id (snake_case). Same string the recipe is keyed by. */
  readonly id: string;
  /**
   * Recipe family. Useful when the agent wants to filter recipes by
   * vocabulary domain (e.g. all `pitch` recipes when the user asks
   * for "harmony" or "octave").
   */
  readonly family: 'auto_wah' | 'pitch' | 'wah' | 'filter' | 'scene_leveling' | 'block_stack';
  /** One-line description for the agent to surface. */
  readonly description: string;
  /**
   * The block this recipe targets on this device. `auto_wah` is the
   * cross-family case: target is `filter` on AM4 but `wah` on II/III.
   * `scene_leveling` is device-agnostic (target is the device's main
   * level surface: AM4 `volpan.volume`, II/III `output.level`); we
   * leave it `undefined` and let the agent decide. `block_stack`
   * recipes target MULTIPLE blocks (see `slots` field) and leave this
   * undefined.
   */
  readonly target_block?: string;
  /**
   * Per-device params dict pre-filtered to the requested port. Display-
   * value shape (numbers in display units, strings for enum values),
   * ready to paste into `apply_preset({ port, spec: { slots: [...] } })`.
   *
   * For `scene_leveling` recipes the params are role-keyed dB offsets,
   * not slot params; the agent uses them when authoring per-scene
   * `output.level` writes. Documented in the recipe family's source
   * (`recipes/sceneLeveling.ts`).
   *
   * For `block_stack` recipes this is an empty object; the actual
   * payload lives in `slots` (multi-block).
   */
  readonly params: Readonly<Record<string, number | string>>;
  /**
   * `block_stack` family only — pre-built apply_preset.spec.slots[]
   * entries. Paste these into apply_preset directly. For single-block
   * families this is undefined and the caller uses `params` /
   * `target_block` instead.
   */
  readonly slots?: readonly BlockStackSlotSpec[];
  /**
   * `block_stack` family only — public-source citation for the recipe's
   * knob values. Surfaced so the agent can answer "where do these
   * settings come from?" without guessing.
   */
  readonly source_notes?: string;
  /**
   * True when this recipe sets a static starting position but a
   * modifier (envelope follower / expression pedal / LFO) is needed
   * to fully realize the intent. Surface to the user; modifier wiring
   * is BK-063 (not yet shipped on II/III).
   */
  readonly modifier_needed?: boolean;
}

/**
 * Collapsed cross-family recipe list filtered to `port`. The describe
 * _device executor calls this once per request; cheap (pure-data scan).
 *
 * Returns an empty array on ports that have no recipes registered
 * (e.g. Hydrasynth) so the field is always an array and the agent
 * doesn't branch on undefined.
 */
export function summarizeRecipesForPort(port: string): readonly RecipeSummaryEntry[] {
  const portKey = port.trim().toLowerCase() as RecipePort;
  if (portKey !== 'am4' && portKey !== 'axe-fx-ii' && portKey !== 'axe-fx-iii') {
    return [];
  }
  const entries: RecipeSummaryEntry[] = [];

  for (const recipe of Object.values(AUTO_WAH_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    const target_block = recipe.target_block_per_device[portKey];
    const modifier_needed = recipe.modifier_needed_on?.[portKey];
    entries.push({
      id: recipe.name,
      family: 'auto_wah',
      description: recipe.description,
      target_block,
      params,
      modifier_needed: modifier_needed === true ? true : undefined,
    });
  }

  for (const recipe of Object.values(PITCH_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'pitch',
      description: recipe.description,
      target_block: 'pitch',
      params,
      modifier_needed: recipe.modifier_needed === true ? true : undefined,
    });
  }

  for (const recipe of Object.values(WAH_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'wah',
      description: recipe.description,
      target_block: 'wah',
      params,
    });
  }

  for (const recipe of Object.values(FILTER_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'filter',
      description: recipe.description,
      target_block: 'filter',
      params,
    });
  }

  for (const recipe of Object.values(BLOCK_STACK_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const slots = recipe.slots_per_device[portKey];
    if (slots === undefined || slots.length === 0) continue;
    entries.push({
      id: recipe.name,
      family: 'block_stack',
      description: recipe.description,
      params: {},
      slots,
      source_notes: recipe.source_notes,
    });
  }

  for (const recipe of Object.values(SCENE_LEVELING_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    // Scene-leveling offsets are role-keyed dB, not slot params. Map
    // each role to its display dB offset under a `<role>_offset_db`
    // key so the shape matches `Record<string, number | string>`.
    const params: Record<string, number> = {};
    for (const [role, offset] of Object.entries(recipe.offsets_db)) {
      if (typeof offset === 'number') {
        params[`${role}_offset_db`] = offset;
      }
    }
    if (Object.keys(params).length === 0) continue;
    entries.push({
      id: recipe.name,
      family: 'scene_leveling',
      description: recipe.description,
      params,
    });
  }

  return entries;
}
