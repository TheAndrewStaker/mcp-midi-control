/**
 * Wah block recipe library (BK-062, static-position lane).
 *
 * Hardcoded library of named static-position wah configurations. These
 * are "parked" wah tones: the WAH_CONTROL / wah.control knob is set
 * to a fixed value rather than expression-pedal-driven. No modifier
 * required, ships today (vs. BK-063 envelope/expression wiring).
 *
 * Display-first convention: control position is 0..10 (Fractal's
 * native wah-control knob scale, confirmed AM4 cacheParams
 * `wah.wah_control` displayMax=10 and II's wah.control is a
 * modifierAssignable knob in the same convention). Cocked positions
 * map to 25% / 50% / 75% of that range: 2.5 / 5.0 / 7.5.
 *
 * Frequency / Q values follow Fractal-forum cocked-wah guidance:
 *   - Low-cocked: narrow freq window (300..1500 Hz), high Q (resonance
 *     ~7), darker color. Classic Mick Ronson / "Voodoo Child" sustained
 *     midrange parked tone.
 *   - Mid-cocked: standard wah window (400..2000 Hz), Q ~5, balanced.
 *     The default cocked-wah lead tone (Mick Jones, Michael Schenker).
 *   - High-cocked: wider top-end window (500..3500 Hz), Q ~4, bright.
 *     Treble-emphasized "trumpet" cocked-wah, common on Mark Knopfler
 *     studio tones.
 *
 * Device coverage: all three Fractal devices (AM4, II, III). Param
 * names differ across devices:
 *   - AM4 (cacheParams): `min_frequency`, `max_frequency`, `q_resonance`,
 *     `wah_control`.
 *   - II (KNOWN_PARAMS): `freq_min`, `freq_max`, `resonance`, `control`.
 *   - III (PARAMS family=WAH): `WAH_FSTART`, `WAH_FSTOP`, `WAH_Q`,
 *     `WAH_CONTROL`.
 */

import type { RecipePort } from './pitch.js';

export interface WahRecipeSpec {
  /** Stable recipe key. */
  readonly name: string;
  /** One-line human-readable description. */
  readonly description: string;
  /** Ports this recipe targets. */
  readonly applicable_devices: readonly RecipePort[];
  /**
   * Per-device display-value param dict. Numbers are display units;
   * strings are display-shape enum values (kept here for parity with
   * filter recipes — wah recipes ship only numbers today).
   */
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>>;
  /** Recipes here are static; no modifier required. Field kept for parity with PitchRecipeSpec. */
  readonly modifier_needed?: boolean;
}

export const WAH_RECIPES: Readonly<Record<string, WahRecipeSpec>> = Object.freeze({
  // Low-cocked: parked at 25% of pedal travel, narrow freq window for
  // a sustained dark midrange voice. The frequencies here are the
  // start/stop range bounds; the static `control` position parks the
  // wah within that range.
  wah_cocked_low: {
    name: 'wah_cocked_low',
    description: 'Cocked-wah parked at 25%, narrow Q, dark midrange voice.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      am4: {
        min_frequency: 300,
        max_frequency: 1500,
        q_resonance: 7,
        wah_control: 2.5,
      },
      'axe-fx-ii': {
        freq_min: 300,
        freq_max: 1500,
        resonance: 7,
        control: 2.5,
      },
      'axe-fx-iii': {
        WAH_FSTART: 300,
        WAH_FSTOP: 1500,
        WAH_Q: 7,
        WAH_CONTROL: 2.5,
      },
    },
  },

  // Mid-cocked: classic Michael Schenker / Mick Jones parked tone.
  // 50% pedal position with standard wah freq window.
  wah_cocked_mid: {
    name: 'wah_cocked_mid',
    description: 'Cocked-wah parked at 50%, classic mid-cocked lead tone.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      am4: {
        min_frequency: 400,
        max_frequency: 2000,
        q_resonance: 5,
        wah_control: 5,
      },
      'axe-fx-ii': {
        freq_min: 400,
        freq_max: 2000,
        resonance: 5,
        control: 5,
      },
      'axe-fx-iii': {
        WAH_FSTART: 400,
        WAH_FSTOP: 2000,
        WAH_Q: 5,
        WAH_CONTROL: 5,
      },
    },
  },

  // High-cocked: parked at 75%, wider top-end window, brighter Q.
  // Mark Knopfler / treble-emphasized "trumpet" cocked-wah.
  wah_cocked_high: {
    name: 'wah_cocked_high',
    description: 'Cocked-wah parked at 75%, bright treble-emphasized voice.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      am4: {
        min_frequency: 500,
        max_frequency: 3500,
        q_resonance: 4,
        wah_control: 7.5,
      },
      'axe-fx-ii': {
        freq_min: 500,
        freq_max: 3500,
        resonance: 4,
        control: 7.5,
      },
      'axe-fx-iii': {
        WAH_FSTART: 500,
        WAH_FSTOP: 3500,
        WAH_Q: 4,
        WAH_CONTROL: 7.5,
      },
    },
  },
});

/**
 * Resolve a wah recipe for a target port. Same contract as
 * `resolvePitchRecipe`: throws on unknown name / non-applicable port,
 * returns `{ params, modifier_needed }` on success.
 */
export function resolveWahRecipe(
  recipeName: string,
  port: RecipePort,
): { params: Readonly<Record<string, number | string>>; modifier_needed: boolean } {
  const recipe = WAH_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(WAH_RECIPES).join(', ');
    throw new Error(
      `unknown wah recipe '${recipeName}'. Known recipes: ${known}`,
    );
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `wah recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  const params = recipe.params_per_device[port];
  if (!params || Object.keys(params).length === 0) {
    throw new Error(
      `wah recipe '${recipeName}' has no params_per_device entry for port '${port}' ` +
        `even though it lists '${port}' as applicable. This is a recipe-table bug.`,
    );
  }
  return { params, modifier_needed: recipe.modifier_needed ?? false };
}
