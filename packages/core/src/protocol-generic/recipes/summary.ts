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
 * Two-tier shape (2026-05-22 MCP migration):
 *
 *   - Single-block families (auto_wah, pitch, wah, filter,
 *     scene_leveling) ship INLINE: `params` is the full knob dict
 *     ready to paste into `apply_preset.spec.slots[].params` or
 *     `set_block`. Cheap and direct.
 *   - Block-stack recipes ship SLIM: `slot_count` + `signature_params`
 *     only. The full slots[] payload (10-30 KB per recipe across both
 *     devices) is no longer inline. The agent applies via
 *     `apply_preset({recipe_id})` — server-side resolution materializes
 *     the slots without a second discovery round-trip. The apply_preset
 *     response carries `applied_spec` echoing what the writer consumed
 *     (recipe + overrides merge resolved).
 *   - Patch archetypes (Hydrasynth) ship SLIM TOO, and the slim part is
 *     the PROSE, not the params. See the `hydrasynth` branch below.
 *
 * `params` (single-block) and `signature_params` (block_stack) are
 * pre-filtered to the requested port. `applicable_devices` is
 * collapsed (a recipe absent on this port is not listed at all), so
 * the agent sees exactly what's safe to apply.
 *
 * WHAT A SUMMARY ENTRY IS FOR. Everything here is read at MATCH time —
 * the agent is deciding WHICH recipe answers the request. A field earns
 * its bytes only if it helps make that choice (description, category,
 * cultural_reference, tags, signature_params) or is needed to act on it
 * (id, requires_nrpn). Anything an agent would only want AFTER choosing
 * belongs on the detail path (`describeRecipeForPort`), not here: the
 * whole surface is charged against a hard host delivery ceiling, and
 * post-choice reference material spent inline is paid for by every
 * recipe on every device question.
 *
 * THE FRACTAL BLOCK-STACK TRIAGE (2026-08-02), the same pass the
 * Hydrasynth got, run per FIELD over the 14 `block_stack` entries the
 * Axe-Fx II ships (its whole recipes[] is 16,885 chars of a 47,921-char
 * response with only 3,279 to spare under the host cliff):
 *
 *   description       2,475   26%   MATCH  — the primary match signal
 *   target_blocks     2,499   26%   after  — see below
 *   source_notes      1,982   21%   after  — "where did these come from?"
 *   signature_params  1,499   16%   MATCH  — disambiguates siblings
 *   params              182    2%   never  — `{}` on every entry
 *
 * `target_blocks` looked like match-time data and is not. It answers
 * "which blocks does this place, and at which slot refs", and BOTH
 * halves are already covered:
 *
 *   - The block roster is in `description`, in English, on 14 of 14 II
 *     recipes ("noise gate + T808 OD sub-cut + 5150 III Red + parametric
 *     EQ + short room"). It was a machine-readable restatement of prose
 *     the agent is already reading.
 *   - The slot REFS are the post-choice half. They exist to key
 *     `apply_preset.overrides.slots[]`, which is something you write
 *     only after choosing a recipe, and the detail path's `slots` is a
 *     strict superset of them.
 *
 * Capacity ("does this fit in the AM4's 4 slots?") is `slot_count`,
 * which stays. On a grid device each slot ref serializes as
 * `{"row":2,"col":1}`, which is why the II paid 178 chars/entry for
 * this and the linear AM4 paid 119.
 *
 * READ THIS BEFORE PUTTING A FIELD BACK. Anything you add here is paid
 * on every device question by every recipe, and the II has ~4 KB of
 * total margin. Run `npx tsx scripts/verify-describe-device-budget.ts`.
 */

import { AMP_RECIPES } from './amp.js';
import { AUTO_WAH_RECIPES } from './autoWah.js';
import { BLOCK_STACK_RECIPES } from './blockStack.js';
import { FILTER_RECIPES } from './filter.js';
import { HYDRA_PATCH_RECIPES } from './patchArchetype.js';
import { PITCH_RECIPES, type RecipePort } from './pitch.js';
import { REVERB_RECIPES } from './reverb.js';
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
  readonly family: 'auto_wah' | 'pitch' | 'wah' | 'filter' | 'amp' | 'reverb' | 'scene_leveling' | 'block_stack' | 'patch_archetype';
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
   * SINGLE-BLOCK FAMILIES ONLY (auto_wah, pitch, wah, filter, amp,
   * reverb, scene_leveling). For `scene_leveling` the params are
   * role-keyed dB offsets, not slot params; the agent uses them when
   * authoring per-scene `output.level` writes. Documented in the recipe
   * family's source (`recipes/sceneLeveling.ts`).
   *
   * OMITTED on `block_stack` and `patch_archetype`, where it was `{}`
   * on every entry (182 chars on the II, 432 on the Hydrasynth) and
   * read as "this recipe sets no params". Those apply via
   * `apply_preset({recipe_id})` / `apply_patch({recipe_id})` and are
   * materialized server-side; the apply response carries `applied_spec`
   * echoing the merge result, and the detail path
   * (`describe_device({port, recipe})`) carries the authored knobs.
   */
  readonly params?: Readonly<Record<string, number | string>>;
  /**
   * `block_stack` family only — number of slots the recipe places when
   * applied. Lets the agent budget chain real estate (AM4: 4 max;
   * II/III: row capacity). This is the match-time capacity question and
   * is why `target_blocks` could leave: "does it fit" is a count, not a
   * roster.
   */
  readonly slot_count?: number;
  /**
   * `block_stack` family only — hand-authored distinctive picks that
   * disambiguate this recipe from siblings. Dot-paths to display-shape
   * values (`amp.type`, `delay.feedback`). Validated at CI to be a
   * subset of the materialized recipe's slots, so the slim summary
   * never drifts from the actual wire values.
   */
  readonly signature_params?: Readonly<Record<string, number | string>>;
  /**
   * Public-source citation for the recipe's knob values, so the agent
   * can answer "where do these settings come from?" without guessing.
   *
   * NEVER EMITTED IN THE SUMMARY — on any family, as of 2026-08-02.
   * Provenance is a question about a recipe the agent has ALREADY
   * chosen, and it is expensive: 687 chars x 36 on the Hydrasynth
   * (24.7 KB, 53% of that device's whole recipes[] surface), 141 x 14
   * on the Axe-Fx II. It is still authored on every recipe and served
   * in full by `describeRecipeForPort` / `describe_device({port,
   * recipe})`. The field stays declared here because `RecipeDetailEntry`
   * extends this interface and that is where it lands.
   */
  readonly source_notes?: string;
  /**
   * True when this recipe sets a static starting position but a
   * modifier (envelope follower / expression pedal / LFO) is needed
   * to fully realize the intent. Surface to the user; modifier wiring
   * is BK-063 (not yet shipped on II/III).
   */
  readonly modifier_needed?: boolean;
  /**
   * `patch_archetype` (Hydrasynth) family only — the device category tag
   * (Bass / Pad / Lead / E-piano / …) the recipe belongs to. Lets the
   * agent map "give me a bass" directly to candidate ids.
   */
  readonly category?: string;
  /**
   * `patch_archetype` family only — recognizable cultural reference for
   * the tone (e.g. "Fender Rhodes Mark I suitcase EP").
   */
  readonly cultural_reference?: string;
  /**
   * `patch_archetype` family only — true when the recipe wires mod-matrix
   * / macro-page routes after the SysEx dump. Those routes need
   * Param TX/RX = NRPN on the device; the base patch lands regardless.
   */
  readonly requires_nrpn?: boolean;
  /**
   * Free-text tags for cross-recipe vocabulary queries ('80s','warm',
   * 'bright','cinematic','percussive'). Present on `patch_archetype`.
   */
  readonly tags?: readonly string[];
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
  const normalized = port.trim().toLowerCase();

  // Hydrasynth patch-archetype family (BK-074). Different shape from the
  // Fractal families — applied via apply_patch({recipe_id}), not
  // apply_preset. Every registered recipe surfaces here; inclusion is a
  // curation decision made before a recipe lands, not a runtime tier.
  //
  // `params` was `{}` here from the day the family landed until
  // 2026-08-02, when it stopped being emitted at all — apply_patch
  // materializes the sparse override map server-side from `recipe_id`,
  // exactly as apply_preset does for block_stack, so an empty dict was
  // 432 chars saying "no params" about a recipe that is all params. What
  // was NOT slimmed, and what actually made this the largest discovery
  // payload in the rig, is the PROSE. Measured across the 36 archetypes:
  //
  //   source_notes        24,737   687/entry   53% of recipes[]
  //   description          6,754   188/entry
  //   cultural_reference   5,015   139/entry
  //   signature_params     3,734   104/entry
  //   tags                 2,536    70/entry
  //   params                 432    12/entry   (all `{}`)
  //
  // So `source_notes` alone was 50% of the device's entire response, and
  // it is the one field on the list that answers a question the agent
  // cannot be asked until AFTER it has picked a recipe ("where did these
  // settings come from?"). Dropping it from the SUMMARY took the payload
  // from 49,814 chars (1,386 under the host delivery cliff, with all 13
  // guidance topics withheld to stay there) to ~41.6 KB with every topic
  // inline — including `device_precondition`, the warning that NRPN
  // writes are inert unless Param TX/RX is set, which a user hits on
  // their first engine-param write.
  //
  // The citations are NOT deleted: `PatchRecipeSpec.source_notes` still
  // carries every one, and `describe_device({port:"hydrasynth",
  // recipe:"<id>"})` returns the full authored record on demand. Keep it
  // that way — the reason this field is affordable at all is that nobody
  // pays for it until somebody asks.
  if (normalized === 'hydrasynth') {
    const entries: RecipeSummaryEntry[] = [];
    for (const recipe of Object.values(HYDRA_PATCH_RECIPES)) {
      entries.push({
        id: recipe.name,
        family: 'patch_archetype',
        description: recipe.description,
        signature_params: recipe.signature_params,
        category: recipe.category,
        cultural_reference: recipe.cultural_reference,
        requires_nrpn: recipe.requires_nrpn === true ? true : undefined,
        tags: recipe.tags,
      });
    }
    return entries;
  }

  const portKey = normalized as RecipePort;
  if (
    portKey !== 'am4' &&
    portKey !== 'axe-fx-ii' &&
    portKey !== 'axe-fx-iii' &&
    portKey !== 'fm3' &&
    portKey !== 'fm9'
  ) {
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

  for (const recipe of Object.values(AMP_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'amp',
      description: recipe.description,
      target_block: 'amp',
      params,
    });
  }

  for (const recipe of Object.values(REVERB_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'reverb',
      description: recipe.description,
      target_block: 'reverb',
      params,
    });
  }

  for (const recipe of Object.values(BLOCK_STACK_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const slots = recipe.slots_per_device[portKey];
    if (slots === undefined || slots.length === 0) continue;
    // Slim shape (2026-05-22 MCP migration, narrowed to match-time-only
    // 2026-08-02): block_stack summaries surface description +
    // signature_params + slot_count, and NOTHING an agent reads after it
    // has already chosen. The full slots[], the per-slot refs that were
    // `target_blocks`, and `source_notes` all live on
    // describe_device({port, recipe:id}); `slots` there is a strict
    // superset of `target_blocks`. The agent applies via
    // apply_preset({recipe_id, overrides?}), which resolves the recipe
    // server-side, and the committed apply's `applied_spec` echoes the
    // merged spec so the agent never needs a write-to-inspect round-trip.
    const signatureParams = recipe.signature_params_per_device[portKey] ?? {};
    entries.push({
      id: recipe.name,
      family: 'block_stack',
      description: recipe.description,
      slot_count: slots.length,
      signature_params: signatureParams,
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

/**
 * ONE recipe, in full — the detail path behind `describe_device({port,
 * recipe})`.
 *
 * The summary above is deliberately match-time-only, because every byte
 * in it is charged against a hard host tool-result ceiling on every
 * device question. This is where the rest lives, and nobody pays for it
 * until they ask:
 *
 *   - `source_notes`, which the summary now omits on EVERY family. This
 *     is the answer to "where do these settings come from?", which is a
 *     question about a recipe the agent has ALREADY chosen.
 *   - the full authored knobs: `params` + `mod_routes` / `macro_routes`
 *     for a Hydrasynth archetype, `slots` for a block stack. Both apply
 *     server-side from the id alone, so this is for INSPECTION — reading
 *     what a recipe will do before committing to it, or explaining what
 *     it just did. It is not a payload to paste back; passing the id is
 *     always the correct way to apply.
 *   - the block stack's per-slot REFS, which used to ride the summary as
 *     `target_blocks`. `slots` is a strict superset (ref + block_type +
 *     the authored params), and it is the field to read before writing
 *     `apply_preset.overrides.slots[]`: overrides match a recipe slot by
 *     ref equality, and a ref that matches nothing is APPENDED rather
 *     than merged, so a guessed ref silently adds a block instead of
 *     changing one.
 *
 * Single-block families already ship everything they have inline, so
 * their detail is the summary entry unchanged.
 *
 * Returns `undefined` when the id is not a recipe on this port. The
 * caller is responsible for turning that into an error that lists what
 * IS available (a bare "not found" on a recipe id is how an agent ends
 * up hand-authoring the tone instead).
 */
export interface RecipeDetailEntry extends RecipeSummaryEntry {
  /** Full authored knob map (Hydrasynth archetypes; display values). */
  readonly full_params?: Readonly<Record<string, number | string>>;
  /** Mod-matrix routes the recipe wires after the patch dump (needs NRPN). */
  readonly mod_routes?: readonly { source: string; target: string; depth: number }[];
  /** Macro-page assignments the recipe wires after the patch dump (needs NRPN). */
  readonly macro_routes?: readonly { macro: number; target: string; depth: number }[];
  /** Full per-device slot list for a `block_stack` recipe on this port. */
  readonly slots?: readonly unknown[];
}

export function describeRecipeForPort(
  port: string,
  recipeId: string,
): RecipeDetailEntry | undefined {
  const normalized = port.trim().toLowerCase();
  const entry = summarizeRecipesForPort(port).find((r) => r.id === recipeId);
  if (entry === undefined) return undefined;

  if (normalized === 'hydrasynth') {
    const recipe = HYDRA_PATCH_RECIPES[recipeId];
    if (recipe === undefined) return entry;
    return {
      ...entry,
      full_params: recipe.params,
      ...(recipe.mod_routes !== undefined ? { mod_routes: recipe.mod_routes } : {}),
      ...(recipe.macro_routes !== undefined ? { macro_routes: recipe.macro_routes } : {}),
      source_notes: recipe.source_notes,
    };
  }

  if (entry.family === 'block_stack') {
    const recipe = BLOCK_STACK_RECIPES[recipeId];
    if (recipe !== undefined) {
      const slots = recipe.slots_per_device[normalized as RecipePort];
      return {
        ...entry,
        source_notes: recipe.source_notes,
        ...(slots !== undefined ? { slots } : {}),
      };
    }
  }

  return entry;
}
