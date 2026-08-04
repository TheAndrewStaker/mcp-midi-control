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
 *     shaper rather than overt wah motion. Lowest sensitivity of the
 *     four, roughly a quarter of the way up the knob.
 *   - **hendrix** — medium attack, full sweep. Slower than funk for
 *     vocal-style articulation rather than percussive bounce.
 *
 * AM4 type: TOUCH-WAH, not "Auto-Wah". Corrected 2026-08-02.
 *   Three of these recipes shipped `type: 'Auto-Wah'` (FILTER_TYPES index
 *   16), which sounds like the obvious choice for a recipe family called
 *   auto_wah and is the wrong block. On the AM4, "Auto-Wah" is the
 *   LFO-SWEPT wah: the Fractal wiki's Filter block page says it "is based
 *   on the same circuit as the Envelope Filter but REPLACES THE DETECTOR
 *   WITH AN LFO", and the device's own applicability data agrees exactly:
 *   type 16 exposes `rate` and `lfo_duty` and NO detector params, while
 *   types 15 (Envelope Filter) and 17 (Touch-Wah) expose
 *   `sensitivity` / `attack_time` / `release_time` and no LFO params.
 *
 *   So a user who trusted the recipe verbatim got a filter wobbling
 *   continuously between its start and stop frequency at the block's
 *   default rate, completely deaf to the pick, with FOUR of its eight
 *   params refused. Confirmed on hardware 2026-08-02: two real-device
 *   agent runs both hit "Skipped (does not apply): filter.sensitivity is
 *   not exposed on filter.type wire 16", diagnosed it themselves, and
 *   switched to Touch-Wah before finishing. Nothing was silently wrong;
 *   the applicability gate refused every inapplicable write loudly. The
 *   recipe was simply asking for the wrong model.
 *
 *   NOT SETTLED, and an ear question: 15 vs 17. Both follow the envelope.
 *   The wiki distinguishes them only as "a different type of detector and
 *   voltage-to-frequency converter", calling 17 "touch-sensitive".
 *   `auto_wah_subtle` has always used 15; the other three now use 17,
 *   which is where both hardware runs independently landed. If 15 sounds
 *   better for these three, change them; there is no evidence either way.
 *
 * `filter.q` applies to NO wah type. Use `filter.resonance`.
 *   All four recipes sent `q`, whose FILTER_TYPE gates are [1,2,3,7]
 *   (Low-Pass, Band-Pass, High-Pass, Notch), so it was dropped on every
 *   wah type including the one they were already using. The resonance
 *   knob these recipes meant is a DIFFERENT register: `filter.q` is
 *   pidHigh 0x000c, `unit: 'count'`, 0.1..10; `filter.resonance` is
 *   pidHigh 0x001e, `unit: 'knob_0_10'`, 0..10, and it gates on [15,17]
 *   AND [16]. This file's own header used to write "filter.q (resonance)",
 *   which is the conflation that produced the bug.
 *
 *   The numeric values were carried across unchanged (6/5/5/3). That is a
 *   judgement, not a measurement: the two params have different units and
 *   tapers, so "q 6" and "resonance 6" are not known to be the same
 *   sound. Both are 0..10-shaped and the ordering between recipes is
 *   preserved, which is the property the recipes exist to express, but if
 *   the resonance reads wrong by ear this is the number to move.
 *
 * `filter.sensitivity` is a COUNT on a log taper, not a percent.
 *   The four recipes originally shipped sensitivity as a 0..100 percent
 *   (funk 65, hendrix 60, cantrell 55, subtle 25). The AM4 has no percent
 *   sensitivity: `filter.sensitivity` is `unit: 'count'`, display range
 *   **0.1 .. 40**, `scaling: 'log10'` (params.ts / cacheParams.ts, taken
 *   from the AM4-Edit cache's own a=0.1 b=40 c=10 typecode=80 row). Three
 *   of the four values were therefore refused outright by the display-value
 *   boundary — `filter.sensitivity out of range [0.1..40]: 65` reproduces
 *   19 times across `scripts/agent-regression/traces/`, after which the
 *   agent invents a replacement. `subtle` (25) only escaped the range check
 *   by accident and was musically wrong in the other direction: on a log
 *   0.1..40 taper, 25 sits at ~92 % of knob travel, i.e. nearly MAXIMUM
 *   sensitivity on the recipe that is documented as the least sensitive.
 *
 *   This is NOT a cross-device scale mismatch. Only the AM4 declares this
 *   param at all: the II / III entries target the WAH block, which has no
 *   envelope follower and no sensitivity knob (there is no
 *   `filter.sensitivity` in the II's `KNOWN_PARAMS`, and the gen-3
 *   `FILTER.FILTER_SENS` carries no display range). So there is nothing to
 *   split per-device — the fix is to express the authored intent on the
 *   one scale that exists.
 *
 *   Values below are the authored percent read as **percent of knob
 *   travel** and pushed through the param's own taper, rather than clamped
 *   to the 40 ceiling (a clamp would put funk, hendrix and cantrell within
 *   a few percent of each other at the top of the knob and erase the
 *   relative ordering the recipes exist to express):
 *
 *       sensitivity = 0.1 x (40 / 0.1) ^ (percent / 100)
 *
 *       funk      65 % -> 4.9    (most aggressive, most pick-responsive)
 *       hendrix   60 % -> 3.6
 *       cantrell  55 % -> 2.7
 *       subtle    25 % -> 0.45   (well below the 2.0 taper midpoint)
 *
 *   Ordering funk > hendrix > cantrell > subtle is preserved, the spacing
 *   stays even in the perceptual (log) domain the knob is tapered in, and
 *   every value now lands inside [0.1 .. 40]. Absolute sensitivities remain
 *   hardware-unverified — this fixes a refused write and a documented
 *   intent inversion, it does not claim an ear-checked setting.
 *
 * `wah.effect_type` on the Axe-Fx II is a MODEL, not an instance.
 *   All four recipes originally shipped `effect_type: 'WAH 1'` on the II.
 *   No such value exists: `WAH_EFFECT_TYPE_VALUES` is an 8-entry roster of
 *   wah MODELS (FAS STANDARD / CLYDE / CRY BABE / VX846 / COLOR-TONE /
 *   FUNK / MORTAL / VX845). "Wah 1" is the II's name for the first WAH
 *   BLOCK INSTANCE on the grid — a block address, not a voicing — so every
 *   one of these recipes would have been refused by the enum boundary on
 *   the II, the same way `sensitivity` was on the AM4. Both defects
 *   survived because nothing walked this family. Replacements are picked
 *   off the real roster by the association each recipe already claims:
 *
 *       funk      -> FUNK          (the roster's funk-voiced wah)
 *       cantrell  -> CRY BABE      (Cantrell plays a signature Cry Baby)
 *       hendrix   -> VX846         (the Vox V846 of that era)
 *       subtle    -> FAS STANDARD  (Fractal's neutral voicing)
 *
 *   The III entries deliberately set NO type: gen-3 enum set-by-name is
 *   gated, so a model string there would be refused by design.
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
        type: 'Touch-Wah',
        start_frequency: 300,
        stop_frequency: 2200,
        // 65 % of knob travel on the 0.1..40 log taper. See the header.
        sensitivity: 4.9,
        attack_time: 10,
        release_time: 120,
        resonance: 6,
        mix: 100,
      },
      'axe-fx-ii': {
        // FUNK: the roster's funk-voiced wah. See the header note on
        // wah.effect_type.
        effect_type: 'FUNK',
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
        type: 'Touch-Wah',
        start_frequency: 700,
        stop_frequency: 2400,
        // 55 % of knob travel on the 0.1..40 log taper. See the header.
        sensitivity: 2.7,
        attack_time: 40,
        release_time: 320,
        resonance: 5,
        mix: 100,
      },
      'axe-fx-ii': {
        // CRY BABE: the roster's Cry Baby model. Cantrell plays a
        // signature Dunlop Cry Baby. See the header note.
        effect_type: 'CRY BABE',
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
        type: 'Touch-Wah',
        start_frequency: 400,
        stop_frequency: 2800,
        // 60 % of knob travel on the 0.1..40 log taper. See the header.
        sensitivity: 3.6,
        attack_time: 25,
        release_time: 200,
        resonance: 5,
        mix: 100,
      },
      'axe-fx-ii': {
        // VX846: the roster's Vox V846, the wah of the Hendrix era.
        // See the header note.
        effect_type: 'VX846',
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
        // 25 % of knob travel on the 0.1..40 log taper. The old literal
        // 25 was IN range but sat at ~92 % of travel — the opposite of
        // this recipe's "low sensitivity" intent. See the header.
        sensitivity: 0.45,
        attack_time: 30,
        release_time: 250,
        resonance: 3,
        mix: 70,
      },
      'axe-fx-ii': {
        // FAS STANDARD: Fractal's own neutral voicing, the least
        // characterful of the eight — right for a tone shaper that is
        // not supposed to announce itself. See the header note.
        effect_type: 'FAS STANDARD',
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
