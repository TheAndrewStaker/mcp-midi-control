/**
 * FM3 Foot Controller (effectId 199) parameter address model.
 *
 * Derived from the device's editor configuration data. The footswitch config space is a flat
 * `(effectId 199, paramId)` array; this module gives its layout so a consumer can address any
 * switch's tap/hold action, color and label by `(layout, view, switch)` and a field name.
 *
 * ── Addressing ───────────────────────────────────────────────────────
 *   pid = field.base + config * field.stride  (+ index, for multi-wide value/label fields)
 *   config = layout * CONFIGS_PER_LAYOUT + view * SWITCHES + switch
 *     layout 0..8  (9 layouts; index 8 = "Master")
 *     view   0..3  (4 views per layout)
 *     switch 0..2  (FM3 hardware = 3 switches per view)
 *   → 12 configs per layout, 108 configs total.
 *
 * Wire frame: `F0 00 01 74 11 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   sub = `09 00` discrete · `52 00` continuous. eid = 199. values are float32.
 *
 * ── Field structure (CACHE-CONFIRMED bases) ──────────────────────────
 * The field-region bases are the FC `*_BEGIN` markers from the device's own param table:
 *   TAP  FUNCS 0 · SUBFUNCS 108 · DISPFUNCS 216 · PARAMS 324
 *   HOLD FUNCS 972 · SUBFUNCS 1080 · DISPFUNCS 1188 · PARAMS 1296
 *   LAYOUT_NAME 1944 · CUR_LAYOUT 2237 · CUR_WINDOW 5640
 * funcs/subfuncs/dispfuncs are 1 pid per config (108 wide each); PARAMS is 6 pids per config
 * (324→972 = 648 = 108×6) — index 0 = primary value, 1 = secondary. The tapCategory (= TAP FUNCS)
 * config formula is device-VERIFIED (pid == config at 0/3/15). Labels (11-char ASCII) + color base
 * are capture-located. What's NOT yet decoded: the enum VOCABULARY/ordinals for category, function,
 * color and label-mode (only a few ordinals are capture-confirmed; see FM3_FC_CATEGORIES etc.).
 */

export const FM3_FC_EFFECT_ID = 199;
export const FM3_FC_SWITCHES = 3; // FM3 hardware switches per view
export const FM3_FC_VIEWS = 4;
export const FM3_FC_LAYOUTS = 9; // incl. index 8 = Master
export const FM3_FC_CONFIGS_PER_LAYOUT = FM3_FC_VIEWS * FM3_FC_SWITCHES; // 12
export const FM3_FC_CONFIGS = FM3_FC_LAYOUTS * FM3_FC_CONFIGS_PER_LAYOUT; // 108
export const FM3_FC_LABEL_LEN = 11; // custom labels are 11 ASCII chars
export const FM3_FC_PARAMS_WIDTH = 6; // PARAMS region: pids per config (idx0=primary, idx1=secondary)

export type Fm3FcField =
  | 'tapCategory' // TAP FUNCS  — the action category
  | 'tapFunction' // TAP SUBFUNCS — function within the category
  | 'tapDisplay' // TAP DISPFUNCS — mini-display / label mode
  | 'tapParams' // TAP PARAMS — 6-wide value block (preset#/scene#/channel/limits…)
  | 'holdCategory'
  | 'holdFunction'
  | 'holdDisplay'
  | 'holdParams'
  | 'color'
  | 'tapLabel'
  | 'holdLabel';

export interface Fm3FcFieldDef {
  /** paramId of this field for config 0 (Layout 1 / View 1 / Switch 1). */
  base: number;
  /** pids this field occupies per config (1 = scalar, 6 = value block, 11 = ASCII label). */
  width: number;
  /** per-config paramId step (equals width here — fields are config-major and contiguous). */
  stride: number;
  /** 'cache' = base from the device param table; 'verified' = formula confirmed on-device;
   *  'capture' = base located from a capture; 'inferred' = derived from region arithmetic. */
  evidence: 'verified' | 'cache' | 'capture' | 'inferred';
}

export const FM3_FC_FIELDS: Record<Fm3FcField, Fm3FcFieldDef> = {
  tapCategory: { base: 0, width: 1, stride: 1, evidence: 'verified' },
  tapFunction: { base: 108, width: 1, stride: 1, evidence: 'cache' },
  tapDisplay: { base: 216, width: 1, stride: 1, evidence: 'cache' },
  tapParams: { base: 324, width: FM3_FC_PARAMS_WIDTH, stride: FM3_FC_PARAMS_WIDTH, evidence: 'cache' },
  holdCategory: { base: 972, width: 1, stride: 1, evidence: 'cache' },
  holdFunction: { base: 1080, width: 1, stride: 1, evidence: 'cache' },
  holdDisplay: { base: 1188, width: 1, stride: 1, evidence: 'cache' },
  holdParams: { base: 1296, width: FM3_FC_PARAMS_WIDTH, stride: FM3_FC_PARAMS_WIDTH, evidence: 'cache' },
  color: { base: 4618, width: 1, stride: 1, evidence: 'capture' },
  tapLabel: { base: 2241, width: FM3_FC_LABEL_LEN, stride: FM3_FC_LABEL_LEN, evidence: 'capture' },
  holdLabel: { base: 3429, width: FM3_FC_LABEL_LEN, stride: FM3_FC_LABEL_LEN, evidence: 'capture' },
};

/** config index from (layout, view, switch), all 0-based. */
export function fm3FcConfigIndex(layout: number, view: number, sw: number): number {
  return layout * FM3_FC_CONFIGS_PER_LAYOUT + view * FM3_FC_SWITCHES + sw;
}

/** paramId of a field for a switch config; `index` selects within a value/label block (default 0). */
export function fm3FcParamId(field: Fm3FcField, layout: number, view: number, sw: number, index = 0): number {
  const f = FM3_FC_FIELDS[field];
  return f.base + fm3FcConfigIndex(layout, view, sw) * f.stride + index;
}

/**
 * Switch-category ordinals (the tap/hold FUNCS enum value). Full FM3 vocabulary, capture-confirmed:
 * the wire ordinal is the editor's dropdown index, 0..13.
 */
export const FM3_FC_CATEGORIES: Readonly<Record<number, string>> = {
  0: 'Unassigned',
  1: 'Bank',
  2: 'Preset',
  3: 'Scene',
  4: 'Effect',
  5: 'Utility',
  6: 'Layout',
  7: 'Control Switch',
  8: 'Looper',
  9: 'Per-Preset',
  10: 'View',
  11: 'Setlist',
  12: 'Song',
  13: 'Song Section',
};

/**
 * Switch LED colour ordinals (the `color` field). Capture-confirmed ordinals 1..12 in the editor's
 * palette reading order; `hex` is for rendering the swatch (approximate where the exact device
 * shade isn't pinned). Blue=5 matches the independently-captured "Dark Blue"=5.
 */
export const FM3_FC_COLORS: Readonly<Record<number, { name: string; hex: string }>> = {
  1: { name: 'Red', hex: '#e23b3b' },
  2: { name: 'Orange', hex: '#f5871f' },
  3: { name: 'Yellow', hex: '#f5c518' },
  4: { name: 'Green', hex: '#33c46b' },
  5: { name: 'Blue', hex: '#2f6bd0' },
  6: { name: 'Cyan', hex: '#35c9d6' },
  7: { name: 'Purple', hex: '#9b59f5' },
  8: { name: 'White', hex: '#ffffff' },
  9: { name: 'Pink', hex: '#ec4f9c' },
  10: { name: 'Turquoise', hex: '#2fd6c2' },
  11: { name: 'Lime', hex: '#9ad11f' },
  12: { name: 'Off', hex: '#3a3a44' },
};

/**
 * Mini-display label modes (the DISPLAY field, pid 216 / 1188). Ordinals 0..2 capture-confirmed.
 * Note: a category's first label option varies (Name vs Function), but the wire ordinals are stable;
 * 0 is the category-default label, 1 the numeric/function variant, 2 a user Custom string.
 */
export const FM3_FC_LABEL_MODES: Readonly<Record<number, string>> = {
  0: 'Name',
  1: 'Number',
  2: 'Custom',
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
