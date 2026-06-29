/**
 * FM3 Foot Controller (effectId 199) parameter address model.
 *
 * Derived from the device's editor configuration data. The footswitch config space is a flat
 * `(effectId 199, paramId)` array; this module gives its layout so a consumer can address any
 * switch's tap/hold action, color and label by `(layout, view, switch)` and a field name —
 * without hard-coding paramIds.
 *
 * ── Addressing ───────────────────────────────────────────────────────
 *   pid = field.base + config * field.stride
 *   config = layout * CONFIGS_PER_LAYOUT + view * SWITCHES + switch
 *     layout 0..8  (9 layouts; index 8 = "Master")
 *     view   0..3  (4 views per layout)
 *     switch 0..2  (FM3 hardware = 3 switches per view)
 *   → 12 configs per layout, 108 configs total.
 *
 * Writes/reads use the standard gen-3 frame
 *   `F0 00 01 74 11 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   sub = `09 00` discrete SET · `52 00` continuous SET. (eid 199; values are float32.)
 *
 * ── Confidence ───────────────────────────────────────────────────────
 * CONFIRMED: the `config` formula + the `tapCategory` field (config-major, stride 1) are verified
 * (tapCategory pid == config for L1V1S1=0, L1V2S1=3, L2V2S1=15). The frame format, eid 199, the
 * 11-char ASCII label regions, and the field BASE paramIds (observed at config 0) are confirmed.
 * INFERRED (marked `verified:false`): per-field STRIDE for the non-category fields, and the
 * primary/secondary "value" pairing (bases 324/325 and 1296/1297 are adjacent ⇒ a 2-wide pair).
 * These should be cross-checked before relying on them for arbitrary configs.
 */

export const FM3_FC_EFFECT_ID = 199;
export const FM3_FC_SWITCHES = 3; // FM3 hardware switches per view
export const FM3_FC_VIEWS = 4;
export const FM3_FC_LAYOUTS = 9; // incl. index 8 = Master
export const FM3_FC_CONFIGS_PER_LAYOUT = FM3_FC_VIEWS * FM3_FC_SWITCHES; // 12
export const FM3_FC_CONFIGS = FM3_FC_LAYOUTS * FM3_FC_CONFIGS_PER_LAYOUT; // 108
export const FM3_FC_LABEL_LEN = 11; // custom labels are 11 ASCII chars

export type Fm3FcField =
  | 'tapCategory'
  | 'tapFunction'
  | 'tapPrimary'
  | 'tapSecondary'
  | 'holdPrimary'
  | 'holdSecondary'
  | 'color'
  | 'tapLabel'
  | 'holdLabel';

export interface Fm3FcFieldDef {
  /** paramId of this field for config 0 (Layout 1 / View 1 / Switch 1). */
  base: number;
  /** pids this field occupies per config (1 = scalar, 11 = ASCII label). */
  width: number;
  /** per-config paramId step. config-major scalar = 1; label = 11; value-pair member = 2. */
  stride: number;
  /** true = formula cross-checked against the device; false = base known, stride inferred. */
  verified: boolean;
}

export const FM3_FC_FIELDS: Record<Fm3FcField, Fm3FcFieldDef> = {
  tapCategory: { base: 0, width: 1, stride: 1, verified: true },
  tapFunction: { base: 108, width: 1, stride: 1, verified: false },
  tapPrimary: { base: 324, width: 1, stride: 2, verified: false },
  tapSecondary: { base: 325, width: 1, stride: 2, verified: false },
  holdPrimary: { base: 1296, width: 1, stride: 2, verified: false },
  holdSecondary: { base: 1297, width: 1, stride: 2, verified: false },
  color: { base: 4618, width: 1, stride: 1, verified: false },
  tapLabel: { base: 2241, width: FM3_FC_LABEL_LEN, stride: FM3_FC_LABEL_LEN, verified: false },
  holdLabel: { base: 3429, width: FM3_FC_LABEL_LEN, stride: FM3_FC_LABEL_LEN, verified: false },
};

/** config index from (layout, view, switch), all 0-based. */
export function fm3FcConfigIndex(layout: number, view: number, sw: number): number {
  return layout * FM3_FC_CONFIGS_PER_LAYOUT + view * FM3_FC_SWITCHES + sw;
}

/** paramId of a field for a given switch config (label fields return the FIRST of their 11 pids). */
export function fm3FcParamId(field: Fm3FcField, layout: number, view: number, sw: number): number {
  const f = FM3_FC_FIELDS[field];
  return f.base + fm3FcConfigIndex(layout, view, sw) * f.stride;
}

/**
 * Switch-category ordinals (the tap/hold "Category" enum value).
 * Partial — confirmed values only; extend as more are decoded.
 */
export const FM3_FC_CATEGORIES: Readonly<Record<number, string>> = {
  1: 'Bank',
  2: 'Preset',
};

/** Switch LED colour ordinals (the `color` field). Partial — confirmed values only. */
export const FM3_FC_COLORS: Readonly<Record<number, string>> = {
  5: 'Dark Blue',
};

/** Decode an 11-pid label region (float ASCII codes) to a string. */
export function fm3FcDecodeLabel(codes: readonly number[]): string {
  return codes
    .slice(0, FM3_FC_LABEL_LEN)
    .map((c) => Math.round(c))
    .filter((c) => c > 0)
    .map((c) => String.fromCharCode(c))
    .join('');
}

/** Encode a label string to 11 ASCII codes (zero-padded) for writing to the label region. */
export function fm3FcEncodeLabel(label: string): number[] {
  const out = new Array(FM3_FC_LABEL_LEN).fill(0);
  for (let i = 0; i < Math.min(label.length, FM3_FC_LABEL_LEN); i++) out[i] = label.charCodeAt(i);
  return out;
}
