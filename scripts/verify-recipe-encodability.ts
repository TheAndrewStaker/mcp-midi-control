// Every recipe value must actually ENCODE on every device the recipe claims.
//
// The gap this closes: `verify-recipe-tables.ts` validates that recipe param
// NAMES resolve and that enum STRINGS encode, but never encodes a numeric value.
// So a recipe could ship a number outside its target param's declared display
// range and nothing caught it until a user ran it against hardware.
//
// It had already happened, twice, on a device the maintainer owns:
//
//   1. `PITCH_RECIPES.octave_down` passes `voice_1_shift: -12` for the Axe-Fx II,
//      whose `pitch.voice_1_shift` is declared `displayMin: 0, displayMax: 48`.
//      The encoder throws "out of range [0..48]: -12", so the recipe could never
//      have run on that device.
//   2. `PITCH_RECIPES.detune_thicken` passes `voice_2_detune: -10`, and that
//      param is an uncalibrated Axe-Fx II knob taking a raw 0..65534.
//
// ## STATUS: both defects are fixed; this gate is green and IS in preflight
//
// `octave_down` no longer claims the Axe-Fx II (the II's shift range is
// declared over the wiki's 0..48 WIRE-ordinal column, so no downward interval
// can be expressed there), and `detune_thicken` is parked entirely (no
// registered device has a cents calibration on its detune params). See the
// module docstring of `packages/core/src/protocol-generic/recipes/pitch.ts`
// for the hardware evidence and the revival conditions.
//
// The sibling `octave_up` passes `12` and encodes cleanly. That is NOT the
// wrong interval: the Axe-Fx II write path is fn=0x2e SET_PARAM_DIRECT, which
// carries a float32 of the DISPLAY value and lets the device do its own
// display->internal conversion, so 12 reaches the device as 12 in the device's
// own display unit. The device's own rendered labels for the sibling
// `pitch.voice_1_harmony` (wire 25 -> "2", 26 -> "3", 27 -> "4", 48 -> "25",
// captured on an II XL+ on Q8.02) prove that display unit is a SIGNED domain
// centred on wire 24, not the 0..48 index — so +12 is +12 semitones.
//
// ## Scope: this script is the DIAGNOSTIC, not the gate
//
// The enforcing check moved into `scripts/verify-recipe-tables.ts` (already in
// preflight), which covers all five single-block recipe families across all
// five ports and resolves names through the REAL dispatcher resolver against
// the REAL descriptor. This script covers only PITCH_RECIPES and resolves
// names by literal key lookup, so it silently skips every gen-3 param (whose
// descriptor key is `shift1`, not `PITCH_SHIFT1`). It is kept for its
// signed-interval WARN heuristic, which the enforcing gate does not have:
// it flags a param that looks like a signed musical interval but is declared
// on an unsigned range — the smell that started BK-PITCH-II.
//
// This gate asserts only what can be asserted without hardware: that every value
// a recipe ships is ACCEPTED by the target param's own encoder. It deliberately
// does NOT assert musical correctness, which needs a device.
//
// Run: npx tsx scripts/verify-recipe-encodability.ts

import { PITCH_RECIPES } from '@mcp-midi-control/core/protocol-generic/recipes/pitch.js';
import type { DeviceDescriptor, ParamSchema } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/descriptor.js';

let failures = 0;
let warnings = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.log(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
}
function warn(label: string, detail = ''): void {
  warnings++;
  console.log(`WARN: ${label}${detail ? `\n  ${detail}` : ''}`);
}

/** Device id -> descriptor, for the ids recipes use in `applicable_devices`. */
const DEVICES: Readonly<Record<string, DeviceDescriptor>> = {
  'axe-fx-ii': AXEFX2_DESCRIPTOR,
  'axe-fx-iii': AXEFX3_DESCRIPTOR,
};

/**
 * Resolve a recipe param against its OWN block first.
 *
 * A bare-name search across all blocks is wrong and produced four false
 * failures on the first run: `effect_type` exists on many blocks, so a pitch
 * recipe's `effect_type: "INTEL HARM"` resolved against `amp.effect_type` and
 * was reported as an invalid amp model. The recipe was fine; the lookup was not.
 * Recipes are block-scoped by construction, so scope the lookup the same way and
 * only fall back to a search for a param the block does not carry.
 */
function findParam(
  desc: DeviceDescriptor,
  name: string,
  preferredBlock: string,
): { block: string; schema: ParamSchema } | undefined {
  const own = desc.blocks[preferredBlock]?.params[name];
  if (own !== undefined) return { block: preferredBlock, schema: own };
  for (const [block, bs] of Object.entries(desc.blocks)) {
    const schema = bs.params[name];
    if (schema !== undefined) return { block, schema };
  }
  return undefined;
}

for (const [recipeId, recipe] of Object.entries(PITCH_RECIPES)) {
  const perDevice = recipe.params_per_device as Readonly<Record<string, Readonly<Record<string, number | string>>>>;
  for (const deviceId of recipe.applicable_devices) {
    const desc = DEVICES[deviceId];
    if (desc === undefined) {
      warn(`${recipeId}: no descriptor wired for '${deviceId}', values unchecked`);
      continue;
    }
    const params = perDevice[deviceId];
    check(
      `${recipeId}/${deviceId}: declares params for the device it claims`,
      params !== undefined,
      'applicable_devices lists it but params_per_device has no entry',
    );
    if (params === undefined) continue;

    for (const [name, value] of Object.entries(params)) {
      // PITCH_RECIPES are pitch-block recipes by construction.
      const found = findParam(desc, name, 'pitch');
      if (found === undefined) {
        // Not this gate's job to police naming; verify-recipe-tables covers it.
        continue;
      }
      const { block, schema } = found;
      let encoded: number | undefined;
      let threw: string | undefined;
      try {
        encoded = schema.encode(value);
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      check(
        `${recipeId}/${deviceId}: ${block}.${name} = ${JSON.stringify(value)} encodes`,
        threw === undefined,
        threw === undefined ? '' : threw,
      );
      if (threw !== undefined) continue;
      check(
        `${recipeId}/${deviceId}: ${block}.${name} encodes to a finite wire value`,
        Number.isFinite(encoded),
        `got ${String(encoded)}`,
      );

      // A SIGNED musical quantity (a semitone shift) declared on a range with no
      // negative half is a display-first smell: the caller cannot express "down".
      // Warn rather than fail, because a legitimately unsigned param exists too,
      // and only hardware settles which this is.
      if (
        /shift|transpose|semitone|detune/i.test(name)
        && typeof value === 'number'
        && (schema.display_min ?? 0) >= 0
        && schema.unit !== 'semitones'
      ) {
        warn(
          `${recipeId}/${deviceId}: ${block}.${name} looks like a signed interval but is declared `
          + `[${schema.display_min}..${schema.display_max}] unit '${schema.unit}'`,
          'A negative interval cannot be expressed, and a positive one may mean the opposite '
          + 'direction if the range is an offset encoding. Confirm against the front panel.',
        );
      }
    }
  }
}

console.log(
  failures === 0
    ? `verify-recipe-encodability: all checks passed (${warnings} warning(s))`
    : `verify-recipe-encodability: ${failures} FAILED (${warnings} warning(s))`,
);
process.exit(failures === 0 ? 0 : 1);
