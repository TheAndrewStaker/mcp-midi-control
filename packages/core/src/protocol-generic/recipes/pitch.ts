/**
 * Pitch block recipe library (BK-061).
 *
 * Hardcoded library of named pitch-block configurations the agent can
 * apply by intent instead of authoring params from scratch. Each recipe
 * is a static display-value dict per device, keyed by the device's
 * native param names (e.g. II's `voice_1_shift`, III's `PITCH_SHIFT1`).
 * Pure data + lookup. No wire encoding, no tool registration.
 *
 * Display-first convention (per CLAUDE.md "Tool API conventions"):
 *   Numbers are display units. Semitone shifts in semitones, detunes
 *   in cents, mix in 0..100 percent. The downstream `apply_preset`
 *   executor is responsible for display->wire conversion.
 *
 * Device coverage:
 *   - Axe-Fx II  : full coverage, downward shifts included since the
 *     2026-08-02 hardware measurement, see "Axe-Fx II shift range"
 *     below. Catalog at
 *     fractal-midi/gen2/axe-fx-ii KNOWN_PARAMS `pitch.*`
 *     (voice_1_shift, voice_2_shift, voice_1_detune, voice_2_detune,
 *     mix, voice_1_level, voice_2_level, control).
 *   - Axe-Fx III : full coverage. Catalog at fractal-midi/gen3/axe-fx-iii
 *     PARAMS family=PITCH (PITCH_SHIFT1, PITCH_SHIFT2, PITCH_DETUNE1,
 *     PITCH_DETUNE2, PITCH_MIX, PITCH_LEVEL1, PITCH_LEVEL2,
 *     PITCH_CTRL). The gen-3 names resolve through the descriptor's
 *     `pitch_shift1` -> `shift1` alias (case-insensitive), so the
 *     SCREAMING_SNAKE catalog symbol is what an agent may paste and is
 *     what this table stores.
 *   - AM4        : not applicable. AM4 has no standalone pitch block
 *     (reverb has a pitch-mix knob but that is not a pitch block).
 *     `applicable_devices` omits 'am4' on every recipe.
 *
 * Recipe value provenance:
 *   Octave shifts (+/-12, +/-7, +/-3) and detune cents are universal
 *   pitch-shifter conventions; no Fractal-specific source needed. Mix
 *   ratios are 50/50 for octave-up (classic blend), 30/70 dry-heavy
 *   for octave-down (avoids muddiness, common forum advice on Fractal
 *   forum pitch-block threads), 40/60 for harmonies (lead/harmony
 *   balance), 35/65 for power-chord stacks (root dominant).
 *
 * ── Axe-Fx II shift range (BK-PITCH-II) ────────────────────────────
 *
 * `pitch.voice_N_shift` and `pitch.voice_N_harmony` are declared
 * `displayMin: 0, displayMax: 48, step: 1` in
 * fractal-midi/gen2/axe-fx-ii params.ts. That 0..48 is NOT the device's
 * display domain: it is the WIRE ordinal domain, copied from the
 * Fractal wiki's MIDI_SysEx min/max column. Hardware proof, from the
 * II XL+ (Q8.02) session captured in the maintainer's release-test log
 * (2026-05-17): reading `pitch.voice_1_harmony` back, the device
 * renders its OWN label alongside the wire value, and the labels come
 * back wire 25 -> "2", 26 -> "3", 27 -> "4", 48 -> "25". So the display
 * a musician reads is `wire - 23`, a signed domain centred on wire 24,
 * not the 0..48 index. The sibling gen-3 catalog agrees on the concept:
 * `pitch.shift1` on the III is declared `unit: 'semitones', -24..+24`,
 * and the AM4's `reverb.voice_N_shift` is `semitones, -24..+24` from
 * the Blocks Guide.
 *
 * SETTLED ON HARDWARE 2026-08-02, and the paragraph above needs one
 * correction: the offset is 24, not 23. `scripts/probe-ii-pitch-domain.ts
 * --sweep` drove an XL+ over USB and read the device's OWN rendered label
 * back out of the GET frame, five points per param, both voices identical:
 * sent 0/1/3/7/12 landed on wire 24/25/27/31/36 and the device called them
 * "0"/"1"/"3"/"7"/"12". So `voice_N_shift` is display = wire - 24, unison
 * at wire 24, and the write round-trips exactly as predicted. The wire - 23
 * figure above comes from the 2026-05-17 log and is `voice_N_harmony`,
 * which is a DIFFERENT param with a different offset and, on today's data,
 * an unstable one (see the calibration note); do not conflate them.
 *
 * Consequence for these recipes: both directions now work on the II.
 * `pitch.voice_1_shift` / `voice_2_shift` are declared signed semitones
 * -24..+24 via ORDINAL_OFFSET in packages/fractal-gen2/src/calibration.ts,
 * so `octave_down` is claimed for the II again. The write path is
 * fn=0x2e SET_PARAM_DIRECT, which carries a float32 of the DISPLAY value
 * and lets the device do its own conversion, so `voice_1_shift: -12` puts
 * -12 semitones on the wire and lands one octave down.
 *
 * STILL OPEN, and deliberately not fixed here: `voice_N_harmony`,
 * `stage_N_shift` and `multidelay.shift_N` all carry the same suspect
 * `[0..48]` declaration. Harmony measured wire - 25 this session against
 * the log's wire - 23, so something else varies (likely the block's
 * key/scale, a harmony being a scale degree); the other two were never
 * measured at all. Measure before touching. Note for whoever does: the
 * sweep NEEDS a settle window between write and read-back (250 ms is
 * enough). Without one the reads lag their writes and two voices of the
 * same family disagree at the same input, which looks like a device
 * quantization story and is purely the instrument.
 *
 * ── Voice levels are deliberately absent ───────────────────────────
 *
 * These recipes used to ship `voice_1_level: 0` / `PITCH_LEVEL1: 0`
 * intending "unity". Both devices read that as the BOTTOM of the range,
 * not unity: `pitch.voice_N_level` is uncalibrated on the II (the
 * device's own hardware-verified cheat sheet in the gen-2 descriptor's
 * `pitch_block` agent guidance reads "wire 0 = 0% (muted)"), and every
 * uncalibrated gen-3 param takes a raw 0..65534 wire integer where 0 is
 * likewise the floor. So the recipes were muting the very voice they
 * had just configured. There is no calibrated display value for a pitch
 * voice level on either device, so the honest move is to write nothing
 * and leave the block's own level alone; add a level with `set_param`
 * once `pitch.voice_N_level` gets a calibrated display range.
 *
 * The whammy_expression recipe is marked `modifier_needed: true` —
 * BK-063 (modifier system decode) hasn't landed yet, so an agent that
 * applies this recipe gets the base PITCH_CTRL=0 starting position
 * but the user (or BK-063 follow-on) still needs to wire an
 * expression-pedal modifier onto pitch.control / PITCH_CTRL.
 */

export type RecipePort = 'am4' | 'axe-fx-ii' | 'axe-fx-iii' | 'fm3' | 'fm9';

export interface PitchRecipeSpec {
  /** Stable recipe key (snake_case). */
  readonly name: string;
  /** One-line human-readable description for tool surfacing. */
  readonly description: string;
  /** Ports this recipe targets. AM4 is never in this list (no pitch block). */
  readonly applicable_devices: readonly RecipePort[];
  /**
   * Per-device display-value param dict. Numbers are display units; the
   * apply_preset executor coerces to wire format. Strings are display-
   * shape enum values (e.g. `'LOWPASS'`) for `select` params; the
   * unified apply_preset `params` slot accepts `number | string`.
   */
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>>;
  /**
   * When true, the recipe sets a starting position but a modifier
   * (expression pedal, envelope follower, LFO) must be attached
   * to fully realize the intent. BK-063 lands the modifier surface;
   * until then the agent should tell the user.
   */
  readonly modifier_needed?: boolean;
}

export const PITCH_RECIPES: Readonly<Record<string, PitchRecipeSpec>> = Object.freeze({
  // Octave up: classic +12 semitone blend. 50/50 mix is the canonical
  // "12-string" / Mike Kerr (Royal Blood) octave-up tone.
  octave_up: {
    name: 'octave_up',
    description: 'Whole octave up, 50/50 blend. Classic +12 semitone shimmer.',
    applicable_devices: ['axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      'axe-fx-ii': { voice_1_shift: 12, mix: 50 },
      'axe-fx-iii': { PITCH_SHIFT1: 12, PITCH_MIX: 50 },
    },
  },

  // Octave down: dry-heavy mix avoids muddiness from sub-octave content.
  // Fractal forum advice on octave-down threads converges on ~30% wet.
  //
  // Axe-Fx II is NOT claimed: `pitch.voice_1_shift` is declared over the
  // wiki's 0..48 wire-ordinal column, so -12 is refused at the tool
  // boundary and no downward shift can be expressed. See the "Axe-Fx II
  // shift range" section in the module docstring for the hardware
  // evidence and the one-write test that unblocks it. Listing the II
  // here would ship a recipe that can only throw.
  octave_down: {
    name: 'octave_down',
    description:
      'Whole octave down, dry-heavy 30/70 blend. Adds weight without mud.',
    // The Axe-Fx II is back, on hardware evidence taken 2026-08-02: five
    // measured points on an XL+ put `pitch.voice_N_shift` at display =
    // wire - 24 with the write round-tripping, so the panel domain is signed
    // semitones and the old `[0..48]` declaration (the WIRE domain, copied
    // from the wiki's MIDI_SysEx column) was what refused every negative
    // value before a byte was sent. See ORDINAL_OFFSET in
    // packages/fractal-gen2/src/calibration.ts for the measurement.
    applicable_devices: ['axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      'axe-fx-ii': { voice_1_shift: -12, mix: 30 },
      'axe-fx-iii': { PITCH_SHIFT1: -12, PITCH_MIX: 30 },
    },
  },

  // Major-third harmony: +3 semitones is a minor-third; +4 is a major-third.
  // BK-061 spec says "+3" so we ship that literal (minor-third = sad/somber).
  // Caller can pick harmony_fifth for the bright "+7" power-blend.
  harmony_third: {
    name: 'harmony_third',
    description: 'Minor-third up harmony, 40/60 blend. Adds melodic harmony voice.',
    applicable_devices: ['axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      'axe-fx-ii': { voice_1_shift: 3, mix: 40 },
      'axe-fx-iii': { PITCH_SHIFT1: 3, PITCH_MIX: 40 },
    },
  },

  // Perfect-fifth harmony: +7 semitones. Classic Eddie Van Halen / Brian
  // May "harmony riff" interval.
  harmony_fifth: {
    name: 'harmony_fifth',
    description: 'Perfect-fifth up harmony, 40/60 blend. Iconic guitar-harmony interval.',
    applicable_devices: ['axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      'axe-fx-ii': { voice_1_shift: 7, mix: 40 },
      'axe-fx-iii': { PITCH_SHIFT1: 7, PITCH_MIX: 40 },
    },
  },

  // Power-chord stack: root + fifth + octave. Voice 1 fifth, voice 2
  // octave. 35/65 keeps the dry root dominant. Voice levels are left
  // alone (see "Voice levels are deliberately absent" above).
  power_chord_stack: {
    name: 'power_chord_stack',
    description: 'Root + fifth + octave stack. Big "5-power-chord" texture from a single note.',
    applicable_devices: ['axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      'axe-fx-ii': {
        voice_1_shift: 7,
        voice_2_shift: 12,
        mix: 35,
      },
      'axe-fx-iii': {
        PITCH_SHIFT1: 7,
        PITCH_SHIFT2: 12,
        PITCH_MIX: 35,
      },
    },
  },

  // PARKED: detune_thicken (+/-10 cents stereo doubling).
  //
  // It is not in the table because no registered device can express a
  // cent value today, so every port it could claim would throw:
  //
  //   - Axe-Fx II  : `pitch.voice_N_detune` is uncalibrated, so the tool
  //     boundary demands an integer 0..65534 and rejects -10 outright.
  //   - gen-3      : `pitch.detune1/2` are likewise uncalibrated, and the
  //     documented gen-3 contract for an uncalibrated param is a RAW
  //     0..65534 wire integer (midpoint 32767) — so -10 is rejected and
  //     +10 would write ~0, the bottom of the sweep, not +10 cents.
  //
  // Reviving it needs a cents display calibration on
  // `pitch.voice_N_detune` (II) and `pitch.detune1/2` (gen-3). Until
  // then a recipe here would only ever NACK, which is worse for the
  // agent than the recipe not existing. Convention for the values when
  // it returns: +/-10 cents, 30% wet so the detune sits behind the dry
  // signal.

  // Diatonic harmonies — INTEL HARM mode. Session 88 failure was the
  // agent writing voice_1_harmony as a +27 semitone offset because it
  // had no way to disambiguate FIXED HARM (chromatic semitone offset)
  // vs INTEL HARM (scale degree). These recipes set effect_type +
  // key + scale + voice_1_harmony explicitly so the agent gets the
  // diatonic third / fifth without reasoning about wire modes.
  //
  // voice_1_harmony semantics in INTEL HARM mode: 1=unison, 2=second,
  // 3=third, 4=fourth, 5=fifth, 6=sixth, 7=seventh. Set per the
  // pitch_block agent_guidance section in
  // packages/fractal-gen2/src/descriptor/agentGuidance.ts. III mirrors
  // the same semantics; we mirror PITCH_HARMONY1 + PITCH_KEY +
  // PITCH_SCALE + PITCH_EFFECT_TYPE in the III column.

  // III is omitted from these recipes until the III PITCH catalog gains
  // `PITCH_EFFECT_TYPE` and `PITCH_HARMONY1/2`. The current III pitch
  // catalog (XML-inferred) ships KEY / SCALE / SHIFT but not the harmony
  // mode-selector or the scale-degree harmony knobs. Re-add III when
  // those land via the AxeEdit III XML extractor or a III enum dump.

  harmony_third_diatonic_major: {
    name: 'harmony_third_diatonic_major',
    description:
      'Diatonic third up, C major scale. INTEL HARM mode: the harmony bends with the scale (major third on C, minor third on D, major on E, etc.). Pass the song key via apply_preset to override.',
    applicable_devices: ['axe-fx-ii'] as const,
    params_per_device: {
      'axe-fx-ii': {
        effect_type: 'INTEL HARM',
        key: 'C',
        scale: 'IONIAN MAJ',
        voice_1_harmony: 3,
        mix: 40,
      },
    },
  },

  harmony_fifth_diatonic_major: {
    name: 'harmony_fifth_diatonic_major',
    description:
      'Diatonic fifth up, C major scale. INTEL HARM mode: power-chord-style fifth that stays in key (perfect fifth on C/F/G, diminished on B). Override key via apply_preset for non-C songs.',
    applicable_devices: ['axe-fx-ii'] as const,
    params_per_device: {
      'axe-fx-ii': {
        effect_type: 'INTEL HARM',
        key: 'C',
        scale: 'IONIAN MAJ',
        voice_1_harmony: 5,
        mix: 40,
      },
    },
  },

  harmony_third_diatonic_minor: {
    name: 'harmony_third_diatonic_minor',
    description:
      'Diatonic third up, A natural minor. INTEL HARM mode: melancholic harmony that follows the minor scale. Override key for non-A songs.',
    applicable_devices: ['axe-fx-ii'] as const,
    params_per_device: {
      'axe-fx-ii': {
        effect_type: 'INTEL HARM',
        key: 'A',
        scale: 'AEOLIAN MIN',
        voice_1_harmony: 3,
        mix: 40,
      },
    },
  },

  harmony_third_and_fifth_diatonic_major: {
    name: 'harmony_third_and_fifth_diatonic_major',
    description:
      'Diatonic third + fifth stack, C major. INTEL HARM mode on both voices: three-note diatonic chord from a single guitar note (Brian May / Queen-style). Override key for non-C songs.',
    applicable_devices: ['axe-fx-ii'] as const,
    params_per_device: {
      'axe-fx-ii': {
        effect_type: 'INTEL HARM',
        key: 'C',
        scale: 'IONIAN MAJ',
        voice_1_harmony: 3,
        voice_2_harmony: 5,
        mix: 45,
      },
    },
  },

  // Whammy expression pedal: full octave-down to octave-up sweep
  // driven by an external expression pedal. The pedal-to-PITCH_CTRL
  // wiring is a modifier (BK-063); this recipe seeds the base
  // pitch-control position at 0 and sets a full-octave shift range
  // so when BK-063 lands, attaching the modifier produces the
  // DigiTech Whammy effect immediately.
  whammy_expression: {
    name: 'whammy_expression',
    description:
      'Expression-pedal whammy: full octave-down to octave-up sweep. ' +
      'Requires a modifier on pitch.control / PITCH_CTRL.',
    applicable_devices: ['axe-fx-ii', 'axe-fx-iii'] as const,
    params_per_device: {
      'axe-fx-ii': {
        voice_1_shift: 12,
        control: 0,
        mix: 100,
      },
      'axe-fx-iii': {
        PITCH_SHIFT1: 12,
        PITCH_CTRL: 0,
        PITCH_MIX: 100,
      },
    },
    modifier_needed: true,
  },
});

/**
 * Resolve a pitch recipe for a target port. Returns the per-device
 * params dict + modifier-needed flag, or throws when the recipe is
 * unknown / not applicable.
 *
 * The thrown errors are display-shape (CLAUDE.md tool API convention):
 * the caller can surface them to the agent verbatim.
 */
export function resolvePitchRecipe(
  recipeName: string,
  port: RecipePort,
): { params: Readonly<Record<string, number | string>>; modifier_needed: boolean } {
  const recipe = PITCH_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(PITCH_RECIPES).join(', ');
    throw new Error(
      `unknown pitch recipe '${recipeName}'. Known recipes: ${known}`,
    );
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `pitch recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  const params = recipe.params_per_device[port];
  if (!params || Object.keys(params).length === 0) {
    throw new Error(
      `pitch recipe '${recipeName}' has no params_per_device entry for port '${port}' ` +
        `even though it lists '${port}' as applicable. This is a recipe-table bug.`,
    );
  }
  return { params, modifier_needed: recipe.modifier_needed ?? false };
}
