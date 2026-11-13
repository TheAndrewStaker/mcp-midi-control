/**
 * FM3 enum labels keyed by PARAM NAME, the shape the gen-3 catalog takes as
 * per-device `enum_overrides` (the same shape as `FM9_ENUM_OVERRIDES`).
 *
 * Built from `FM3_ENUM_OVERRIDES` (family -> paramId -> labels, from the FM3
 * editor's UI configuration data) joined to the FM3's own param catalog by
 * (family, paramId). Every joined entry is an enum in the FM3's own editor
 * cache (`FM3_RANGES`) with an enumCount equal to its label count (441 of 441),
 * so the join is checked, not positional. The cab IR name tables and the
 * GLOBAL rows with no catalog param are left out (no param to label).
 *
 * FIRMWARE 13 DELTA (issue #22, FM3 fw 13.00, hardware-confirmed by numeric
 * writes on the FM3 screen): amp ordinal 283 reads "Deluxe Tweed Bright"
 * (fw 12: "Deluxe Tweed") and ordinals 331-335 are new. Applied on top of the
 * fw 12 data so the current firmware's names resolve.
 */
import { FM3_ENUM_OVERRIDES } from './enumOverrides.js';
import { FM3_PARAMS_BY_FAMILY } from './params.js';

const FW13_AMP_DELTA: Readonly<Record<number, string>> = {
  283: 'Deluxe Tweed Bright',
  331: 'Deluxe Tweed Normal',
  332: 'PVH 6160 Block Clean',
  333: 'Brit JVM Crunch Green',
  334: 'Brit JVM Crunch Orange',
  335: 'Brit JVM Crunch Red',
};

function build(): Readonly<Record<string, Readonly<Record<number, string>>>> {
  const out: Record<string, Record<number, string>> = {};
  for (const [family, byParamId] of Object.entries(FM3_ENUM_OVERRIDES)) {
    const params = FM3_PARAMS_BY_FAMILY[family] ?? [];
    for (const [paramIdStr, labels] of Object.entries(byParamId)) {
      const param = params.find((p) => p.paramId === Number(paramIdStr));
      if (param === undefined) continue;
      out[param.name] = Object.fromEntries(labels.map((label, ordinal) => [ordinal, label]));
    }
  }
  if (out['DISTORT_TYPE'] !== undefined) {
    out['DISTORT_TYPE'] = { ...out['DISTORT_TYPE'], ...FW13_AMP_DELTA };
  }
  return out;
}

/** FM3 enum labels by param name (ordinal -> label), fw 12 data + the fw 13 amp delta. */
export const FM3_ENUM_OVERRIDES_BY_NAME = build();
