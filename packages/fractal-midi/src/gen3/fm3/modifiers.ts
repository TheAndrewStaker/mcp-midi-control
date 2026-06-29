/**
 * FM3 Modifier (effectId 3) parameter map.
 *
 * Derived from the device's editor configuration data. A modifier attaches a modulation source to
 * a target parameter and shapes it (range + transfer curve). Its settings are addressed as
 * `(effectId 3, paramId)` via the standard gen-3 SET frame
 *   `F0 00 01 74 11 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   sub = `09 00` discrete · `52 00` continuous (knob drag). Scalar fields are normalized float32 0..1
 *   (except `source`, an ordinal). The target parameter is named separately by the host context.
 *
 * ── Confidence ───────────────────────────────────────────────────────
 * CONFIRMED: `start` = pid 3 and `slope` = pid 6 (entered 29 / 71 → 0.29 / 0.71). The mapping
 * curve order on the editor (Min, Max, Start, Mid, End, Slope, Scale, Offset) lines up with
 * sequential pids 1..8 around those two anchors, so `min`..`offset` are encoded on that basis
 * (`verified:false`). `source` (pid 0) carries the modulation-source ordinal. The remaining
 * fields (attack/release/damping/channel/pcReset/updateRate/autoEngage/offValue) live at higher
 * pids and are not yet pinned — TODO from a one-field-at-a-time pass.
 */

export const FM3_MOD_EFFECT_ID = 3;

export type Fm3ModField =
  | 'source'
  | 'min'
  | 'max'
  | 'start'
  | 'mid'
  | 'end'
  | 'slope'
  | 'scale'
  | 'offset';

export interface Fm3ModFieldDef {
  pid: number;
  /** 'ordinal' = enum index; 'norm' = normalized float 0..1. */
  kind: 'ordinal' | 'norm';
  verified: boolean;
}

export const FM3_MOD_FIELDS: Record<Fm3ModField, Fm3ModFieldDef> = {
  source: { pid: 0, kind: 'ordinal', verified: false },
  min: { pid: 1, kind: 'norm', verified: false },
  max: { pid: 2, kind: 'norm', verified: false },
  start: { pid: 3, kind: 'norm', verified: true },
  mid: { pid: 4, kind: 'norm', verified: false },
  end: { pid: 5, kind: 'norm', verified: false },
  slope: { pid: 6, kind: 'norm', verified: true },
  scale: { pid: 7, kind: 'norm', verified: false },
  offset: { pid: 8, kind: 'norm', verified: false },
};

/** paramId for a modifier field. */
export function fm3ModParamId(field: Fm3ModField): number {
  return FM3_MOD_FIELDS[field].pid;
}
