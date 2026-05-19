/**
 * Filter block recipe library (BK-062, filter lane).
 *
 * Hardcoded library of named filter-block configurations. Each recipe
 * sets a filter type + frequency / Q / cutoff for a common tonal-
 * shaping use case. Static (non-modifier) filtering today; expression-
 * driven sweeps land with BK-063.
 *
 * Frequency / type values follow standard EQ convention:
 *   - High-cut dark : Lowpass @ 4 kHz, gentle slope (2nd order on II/
 *     III, narrow Q on AM4). Tames brittle pick attack without
 *     swallowing the body of the tone. Common "darken bright single-
 *     coil" use.
 *   - Low-cut bright : Highpass @ 200 Hz. Removes sub-bass mud below
 *     low E (82 Hz fundamental) while preserving the bottom-end body
 *     of standard-tuned guitar. Common direct-DI / amp-front cleanup.
 *   - Telephone : Bandpass 500..3000 Hz centered around 1.2 kHz.
 *     Vocal-style mid coloration — the "lo-fi", "AM radio", "old
 *     intercom" sound. Pairs well with light distortion + reverb for
 *     bridge-section verse effects.
 *
 * Type-value mapping convention (per device):
 *   - AM4 (cacheEnums FILTER_TYPES): strings `'Low-Pass'`,
 *     `'Band-Pass'`, `'High-Pass'`.
 *   - II  (cacheEnums FILTER_EFFECT_TYPE_VALUES): strings `'LOWPASS'`,
 *     `'BANDPASS'`, `'HIGHPASS'`.
 *   - III : strings unverified in the catalog (`FILTER_TYPE` is
 *     `unit: 'enum'` with no published enumValues yet). The wire-int
 *     ordering on III matches the AM4 enum table (1=Lowpass, 2=Bandpass,
 *     3=Highpass per the inferred-from-AM4 calibration), so we ship
 *     numeric type codes for III until the enum vocabulary lands.
 *
 * Param name mapping:
 *   - AM4 : `type`, `freq`, `q`, `low_cut`, `high_cut` (cacheParams
 *     filter.*).
 *   - II  : `effect_type`, `frequency`, `q`, `low_cut`, `hi_cut`
 *     (KNOWN_PARAMS filter.*). Note `hi_cut` not `high_cut`.
 *   - III : `FILTER_TYPE`, `FILTER_FREQ`, `FILTER_Q`, `FILTER_LOWCUT`,
 *     `FILTER_HICUT`.
 */

import type { RecipePort } from './pitch.js';

export interface FilterRecipeSpec {
  readonly name: string;
  readonly description: string;
  readonly applicable_devices: readonly RecipePort[];
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>>;
  readonly modifier_needed?: boolean;
}

export const FILTER_RECIPES: Readonly<Record<string, FilterRecipeSpec>> = Object.freeze({
  // Lowpass @ 4 kHz: tames bright single-coil top-end.
  // AM4 q displayMin..Max = 0.1..10 (log10). Q=0.7 is the "Butterworth"
  // gentle slope — flattest passband, no resonant peak at cutoff.
  filter_high_cut_dark: {
    name: 'filter_high_cut_dark',
    description: 'Lowpass at 4 kHz with gentle Q. Darkens bright top-end.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      am4: {
        type: 'Low-Pass',
        freq: 4000,
        q: 0.7,
      },
      'axe-fx-ii': {
        effect_type: 'LOWPASS',
        frequency: 4000,
        q: 0.7,
      },
      'axe-fx-iii': {
        FILTER_TYPE: 1,
        FILTER_FREQ: 4000,
        FILTER_Q: 0.7,
      },
    },
  },

  // Highpass @ 200 Hz: cuts sub-bass mud below low-E fundamental.
  filter_low_cut_bright: {
    name: 'filter_low_cut_bright',
    description: 'Highpass at 200 Hz. Removes muddiness below the guitar low-E.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      am4: {
        type: 'High-Pass',
        freq: 200,
        q: 0.7,
      },
      'axe-fx-ii': {
        effect_type: 'HIGHPASS',
        frequency: 200,
        q: 0.7,
      },
      'axe-fx-iii': {
        FILTER_TYPE: 3,
        FILTER_FREQ: 200,
        FILTER_Q: 0.7,
      },
    },
  },

  // Bandpass 500..3000 Hz: "telephone" / lo-fi vocal coloration.
  // Center freq ~1200 Hz, Q ~1.5 for the classic AM-radio band.
  filter_telephone: {
    name: 'filter_telephone',
    description: 'Bandpass 500-3000 Hz, vocal-style mid coloration. "AM radio" / "old intercom" tone.',
    applicable_devices: ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      am4: {
        type: 'Band-Pass',
        freq: 1200,
        q: 1.5,
        low_cut: 500,
        high_cut: 3000,
      },
      'axe-fx-ii': {
        effect_type: 'BANDPASS',
        frequency: 1200,
        q: 1.5,
        low_cut: 500,
        hi_cut: 3000,
      },
      'axe-fx-iii': {
        FILTER_TYPE: 2,
        FILTER_FREQ: 1200,
        FILTER_Q: 1.5,
        FILTER_LOWCUT: 500,
        FILTER_HICUT: 3000,
      },
    },
  },
});

/**
 * Resolve a filter recipe for a target port. Same contract as
 * `resolvePitchRecipe` / `resolveWahRecipe`.
 */
export function resolveFilterRecipe(
  recipeName: string,
  port: RecipePort,
): { params: Readonly<Record<string, number | string>>; modifier_needed: boolean } {
  const recipe = FILTER_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(FILTER_RECIPES).join(', ');
    throw new Error(
      `unknown filter recipe '${recipeName}'. Known recipes: ${known}`,
    );
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `filter recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  const params = recipe.params_per_device[port];
  if (!params || Object.keys(params).length === 0) {
    throw new Error(
      `filter recipe '${recipeName}' has no params_per_device entry for port '${port}' ` +
        `even though it lists '${port}' as applicable. This is a recipe-table bug.`,
    );
  }
  return { params, modifier_needed: recipe.modifier_needed ?? false };
}
