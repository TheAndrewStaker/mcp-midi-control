/**
 * FM9 effectId ↔ family map — see `../fm3/effectIds.ts` for the full
 * rationale and evidence chain.
 *
 * The gen-3 effect-id roster (`AXE_FX_III_BLOCKS`) is shared across
 * III / FM3 / FM9 / VP4, and the FM9 param-family symbols are identical
 * to the FM3's (verified: `FM9_FAMILIES` === `FM3_FAMILIES`, 47 families).
 * Cross-validated against the FM9 editor's effect-instance table, which
 * matches the FM3's eid 0..201 layout.
 *
 * The FM9 has the same Modifier/Controllers split (`ID_CONTROL` = 2,
 * `ID_FOOTCONTROLLER` = 199) and the same DISTORT=Amp / FUZZ=Drive
 * family anomaly as the FM3.
 */

import {
  FM3_EFFECT_ID_TABLE,
  FM3_EFFECT_IDS,
  FM3_FAMILY_BY_EFFECT_ID,
  fm3EffectId,
  type Fm3EffectIdEntry,
  type Fm3EffectAddressing,
} from '../fm3/effectIds.js';

/** One family → effectId binding (same shape as FM3). */
export type Fm9EffectIdEntry = Fm3EffectIdEntry;
export type Fm9EffectAddressing = Fm3EffectAddressing;

/**
 * FM9 family → effectId table. Identical to the FM3 table — the gen-3
 * block roster and the FM9 family set are the same as the FM3's.
 */
export const FM9_EFFECT_ID_TABLE: readonly Fm9EffectIdEntry[] = FM3_EFFECT_ID_TABLE;

/** FM9 param-family symbol → first-instance effectId (`null` if none). */
export const FM9_EFFECT_IDS: Readonly<Record<string, number | null>> = FM3_EFFECT_IDS;

/** Reverse lookup: base effectId → family symbol (audio + virtual). */
export const FM9_FAMILY_BY_EFFECT_ID: Readonly<Record<number, string>> = FM3_FAMILY_BY_EFFECT_ID;

/** Resolve `(family, instance)` → effectId. See `fm3EffectId`. */
export const fm9EffectId = fm3EffectId;
