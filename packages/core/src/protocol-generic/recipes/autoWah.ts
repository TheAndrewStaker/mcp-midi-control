/**
 * Auto-wah recipe library.
 *
 * Filed against the Session 99 install-test failure mode: the agent
 * placed a wah block, then explicitly DEFERRED envelope-follower
 * wiring to the user with "True envelope-follower behavior needs a
 * modifier wired from the envelope-follower source onto the wah's
 * control (position) param. That's a separate operation." This recipe
 * library closes that loop on AM4 (which has built-in auto-wah filter
 * types) and stages the II / III versions for BK-063 modifier wiring.
 *
 * Per-device implementation differs because of how each platform
 * models envelope-driven filtering:
 *
 *   - **AM4**: the FILTER block has built-in `Auto-Wah` / `Envelope
 *     Filter` / `Touch-Wah` types (FILTER_TYPES values 15-17). No
 *     modifier needed. The recipe sets `filter.type` + the supporting
 *     envelope knobs (sensitivity, attack/release, freq window). The
 *     recipe ships TODAY on AM4.
 *
 *   - **Axe-Fx II / III**: the FILTER block on II is a static filter
 *     (low/high/band/notch) — no built-in env-follower mode. To get
 *     auto-wah, you wire an envelope-follower modifier onto the wah
 *     block's `control` knob. Modifier decode is BK-063 (gated on
 *     founder captures). Until BK-063 ships, the recipe sets a sane
 *     starting position on the wah and marks `modifier_needed: true`
 *     so the agent surfaces the gap to the user instead of silently
 *     producing a parked wah tone.
 *
 * Recipe value provenance:
 *   - **funk** — fast attack, fast release, wide sweep. Source: BACKLOG
 *     BK-063 candidate table ("Fast attack, fast release, full sweep").
 *     AM4 filter values calibrated against the Blocks Guide envelope-
 *     filter section: attack 5-15 ms, release 80-150 ms.
 *   - **cantrell** — slow attack, narrow upper-third sweep. Sources:
 *     Jerry Cantrell's "Man in the Box" tone uses a slow-attack envelope
 *     filter so each note articulates its peak. Attack 30-50 ms,
 *     release 250-400 ms.
 *   - **subtle** — narrow band, low sensitivity. Used as a tonal
 *     shaper rather than overt wah motion. Sensitivity ~25 %.
 *   - **hendrix** — medium attack, full sweep. Slower than funk for
 *     vocal-style articulation rather than percussive bounce.
 *
 * Cross-device device parameter alignment:
 *   - AM4 (FILTER block, type=Auto-Wah):
 *     filter.type, filter.start_frequency, filter.stop_frequency,
 *     filter.sensitivity, filter.attack_time, filter.release_time,
 *     filter.q (resonance), filter.mix.
 *   - II / III (WAH block, static position, modifier_needed:true):
 *     wah.effect_type (II) / wah.type (AM4 alias), wah.control,
 *     wah.freq_min/freq_max, wah.resonance.
 */

import type { RecipePort } from './pitch.js';

export interface AutoWahRecipeSpec {
  readonly name: string;
  readonly description: string;
  readonly applicable_devices: readonly RecipePort[];
  /**
   * Per-device display-value params. AM4 entries target the FILTER
   * block with `type='Auto-Wah'`; II/III entries target the WAH block
   * with a static position + `modifier_needed: true`.
   */
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>>;
  /**
   * True on II / III where the recipe sets a static starting position
   * but a modifier (envelope follower) is needed to fully realize the
   * auto-wah motion. BK-063 lands the modifier surface.
   *
   * False on AM4 — the filter block's Auto-Wah type IS the envelope
   * follower; nothing else needs wiring.
   */
  readonly modifier_needed_on?: Readonly<Partial<Record<RecipePort, boolean>>>;
  /**
   * The target block this recipe applies to per port. Differs from
   * pitch / wah recipes which all target one block: auto-wah targets
   * FILTER on AM4 but WAH on II/III.
   */
  readonly target_block_per_device: Readonly<Partial<Record<RecipePort, string>>>;
}

export const AUTO_WAH_RECIPES: Readonly<Record<string, AutoWahRecipeSpec>> = Object.freeze({
  auto_wah_funk: {
    name: 'auto_wah_funk',
    description:
      'Funk auto-wah: fast attack, fast release, wide sweep. Each pick produces a sharp envelope-driven sweep.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    target_block_per_device: {
      am4: 'filter',
      'axe-fx-ii': 'wah',
      'axe-fx-iii': 'wah',
    },
    params_per_device: {
      am4: {
        type: 'Auto-Wah',
        start_frequency: 300,
        stop_frequency: 2200,
        sensitivity: 65,
        attack_time: 10,
        release_time: 120,
        q: 6,
        mix: 100,
      },
      'axe-fx-ii': {
        effect_type: 'WAH 1',
        freq_min: 300,
        freq_max: 2200,
        resonance: 6,
        control: 5,
      },
      'axe-fx-iii': {
        WAH_FSTART: 300,
        WAH_FSTOP: 2200,
        WAH_Q: 6,
        WAH_CONTROL: 5,
      },
    },
    modifier_needed_on: {
      am4: false,
      'axe-fx-ii': true,
      'axe-fx-iii': true,
    },
  },

  auto_wah_cantrell: {
    name: 'auto_wah_cantrell',
    description:
      'Jerry Cantrell-style auto-wah: slow attack, narrow upper-third sweep. Each note articulates its own peak.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    target_block_per_device: {
      am4: 'filter',
      'axe-fx-ii': 'wah',
      'axe-fx-iii': 'wah',
    },
    params_per_device: {
      am4: {
        type: 'Auto-Wah',
        start_frequency: 700,
        stop_frequency: 2400,
        sensitivity: 55,
        attack_time: 40,
        release_time: 320,
        q: 5,
        mix: 100,
      },
      'axe-fx-ii': {
        effect_type: 'WAH 1',
        freq_min: 700,
        freq_max: 2400,
        resonance: 5,
        control: 6,
      },
      'axe-fx-iii': {
        WAH_FSTART: 700,
        WAH_FSTOP: 2400,
        WAH_Q: 5,
        WAH_CONTROL: 6,
      },
    },
    modifier_needed_on: {
      am4: false,
      'axe-fx-ii': true,
      'axe-fx-iii': true,
    },
  },

  auto_wah_hendrix: {
    name: 'auto_wah_hendrix',
    description:
      'Vocal-style auto-wah: medium attack/release, full sweep. Slower articulation than funk; works for held notes.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    target_block_per_device: {
      am4: 'filter',
      'axe-fx-ii': 'wah',
      'axe-fx-iii': 'wah',
    },
    params_per_device: {
      am4: {
        type: 'Auto-Wah',
        start_frequency: 400,
        stop_frequency: 2800,
        sensitivity: 60,
        attack_time: 25,
        release_time: 200,
        q: 5,
        mix: 100,
      },
      'axe-fx-ii': {
        effect_type: 'WAH 1',
        freq_min: 400,
        freq_max: 2800,
        resonance: 5,
        control: 5,
      },
      'axe-fx-iii': {
        WAH_FSTART: 400,
        WAH_FSTOP: 2800,
        WAH_Q: 5,
        WAH_CONTROL: 5,
      },
    },
    modifier_needed_on: {
      am4: false,
      'axe-fx-ii': true,
      'axe-fx-iii': true,
    },
  },

  auto_wah_subtle: {
    name: 'auto_wah_subtle',
    description:
      'Subtle envelope-filter tone shaper: narrow band, low sensitivity. Adds animation without overt wah motion.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    target_block_per_device: {
      am4: 'filter',
      'axe-fx-ii': 'wah',
      'axe-fx-iii': 'wah',
    },
    params_per_device: {
      am4: {
        type: 'Envelope Filter',
        start_frequency: 500,
        stop_frequency: 1800,
        sensitivity: 25,
        attack_time: 30,
        release_time: 250,
        q: 3,
        mix: 70,
      },
      'axe-fx-ii': {
        effect_type: 'WAH 1',
        freq_min: 500,
        freq_max: 1800,
        resonance: 3,
        control: 5,
      },
      'axe-fx-iii': {
        WAH_FSTART: 500,
        WAH_FSTOP: 1800,
        WAH_Q: 3,
        WAH_CONTROL: 5,
      },
    },
    modifier_needed_on: {
      am4: false,
      'axe-fx-ii': true,
      'axe-fx-iii': true,
    },
  },
});

/**
 * Resolve an auto-wah recipe for a target port. Returns the per-device
 * params, the target block name, and the modifier-needed flag.
 *
 * The agent uses `target_block` to know which block to place (filter
 * on AM4 vs wah on II / III) and `modifier_needed` to know whether to
 * surface the BK-063 gap to the user.
 */
export function resolveAutoWahRecipe(
  recipeName: string,
  port: RecipePort,
): {
  params: Readonly<Record<string, number | string>>;
  target_block: string;
  modifier_needed: boolean;
} {
  const recipe = AUTO_WAH_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(AUTO_WAH_RECIPES).join(', ');
    throw new Error(
      `unknown auto-wah recipe '${recipeName}'. Known recipes: ${known}`,
    );
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `auto-wah recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  const params = recipe.params_per_device[port];
  const target_block = recipe.target_block_per_device[port];
  if (!params || Object.keys(params).length === 0 || !target_block) {
    throw new Error(
      `auto-wah recipe '${recipeName}' has no params_per_device or target_block entry ` +
        `for port '${port}' even though it lists '${port}' as applicable. ` +
        `This is a recipe-table bug.`,
    );
  }
  const modifier_needed = recipe.modifier_needed_on?.[port] ?? false;
  return { params, target_block, modifier_needed };
}
