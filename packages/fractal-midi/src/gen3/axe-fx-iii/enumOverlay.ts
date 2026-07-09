/**
 * Axe-Fx III enum vocabulary overlay.
 *
 * The III params catalog (`params.ts`) tags each enum-typed parameter
 * with `unit: 'enum'` but cannot ship a `enumValues: {0: 'OFF', ...}`
 * table inline — III enum vocabularies are not in the public v1.4 spec
 * and have not been mined from the Axe-Edit III binary's `.rdata`
 * string pools yet (a substantial Ghidra workstream).
 *
 * This overlay fills the gap with three layers of evidence-tagged data:
 *
 *   1. **Hardware-verified AM4 join**. Symbols whose stem matches an
 *      AM4 entry with a confirmed `enumValues` table are reused
 *      verbatim. Tag: `'am4-shared'`. Caveat: III firmware may extend
 *      these (e.g. adding amp models post-AM4); the AM4 vocabulary
 *      is the verified *subset*, not necessarily the complete list.
 *   2. **Universal Fractal convention** (suffix-driven). Every
 *      Fractal device uses the same vocabulary for binary toggles
 *      (`_BYP`, `_MUTE`, `_ENABLE`), channel pickers (A/B/C/D),
 *      slope tables, and standard LFO waveforms. Tag: `'fractal-
 *      convention'`. Confidence: high — these vocabularies are
 *      stable across every Fractal product since the original
 *      Axe-Fx Standard (2006).
 *   3. **III-specific direct entries**. Hand-curated for III-only
 *      params with values lifted from the v1.4 PDF (where it documents
 *      a vocabulary inline) or from the AxeEdit III XML when
 *      `<EditorControl type="dropdown*">` carries an inline value
 *      list. Tag: `'iii-spec'`.
 *
 * Consumers use `resolveEnumValues(paramName)` to look up the
 * vocabulary; the function checks direct names first, then suffix
 * conventions.
 *
 * **Hardware verification is the user's responsibility.** A wrong
 * label in this overlay produces a misleading display but does NOT
 * misroute wire bytes (the codec layer uses raw integer values). File
 * a GitHub issue with a capture if your III shows a different label
 * for a given wire value.
 */

import {
  REVERB_TYPES_VALUES,
  DELAY_TYPES_VALUES,
  CHORUS_TYPES_VALUES,
  FLANGER_TYPES_VALUES,
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  COMPRESSOR_TYPES_VALUES,
  GEQ_TYPES_VALUES,
  DRIVE_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
} from '../../am4/cacheEnums.js';

/** Provenance tag for each overlay entry. */
export type EnumProvenance = 'am4-shared' | 'fractal-convention' | 'iii-spec';

/** Overlay entry — values map + provenance. */
export interface EnumOverlayEntry {
  values: Readonly<Record<number, string>>;
  provenance: EnumProvenance;
  /** Optional note explaining the entry's limitations / sources. */
  note?: string;
}

// ── Universal Fractal vocabularies ───────────────────────────────

/** Binary OFF/ON toggle — every Fractal product uses this. */
const BINARY_OFF_ON: EnumOverlayEntry = {
  values: { 0: 'OFF', 1: 'ON' },
  provenance: 'fractal-convention',
};

/** Bypassed/engaged toggle — bypass state. */
const BYPASS_STATE: EnumOverlayEntry = {
  values: { 0: 'ENGAGED', 1: 'BYPASSED' },
  provenance: 'fractal-convention',
};

/** Channel A/B/C/D picker — block-channel selector. */
const CHANNEL_PICKER: EnumOverlayEntry = {
  values: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  provenance: 'fractal-convention',
};

/** Slope table — filter slopes in dB/octave. */
const FILTER_SLOPE: EnumOverlayEntry = {
  values: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '24 dB/OCT', 3: '36 dB/OCT' },
  provenance: 'fractal-convention',
};

/** Reverb low/high cut slope — Normal/Steep (AM4-verified, shared with III). */
const REVERB_CUT_SLOPE: EnumOverlayEntry = {
  values: { 0: 'Normal', 1: 'Steep' },
  provenance: 'am4-shared',
};

/** Input-select stereo picker (L+R / L / R). */
const INPUT_SELECT_3WAY: EnumOverlayEntry = {
  values: { 0: 'L+R', 1: 'LEFT', 2: 'RIGHT' },
  provenance: 'fractal-convention',
};

/** Input-select stereo picker (LEFT / RIGHT / SUM L+R). */
const INPUT_SELECT_SUM: EnumOverlayEntry = {
  values: { 0: 'LEFT', 1: 'RIGHT', 2: 'SUM L+R' },
  provenance: 'fractal-convention',
};

/** Mute/thru toggle. */
const MUTE_THRU: EnumOverlayEntry = {
  values: { 0: 'Thru', 1: 'Mute' },
  provenance: 'fractal-convention',
};

/** Pre/Post/Mid/End/Pre-Mid block placement. */
const PRE_POST_MID: EnumOverlayEntry = {
  values: { 0: 'PRE', 1: 'POST', 2: 'MID', 3: 'END', 4: 'PRE-MID' },
  provenance: 'fractal-convention',
};

/** Pan / NONE / RIGHT / LEFT / BOTH. */
const PAN_4WAY: EnumOverlayEntry = {
  values: { 0: 'NONE', 1: 'RIGHT', 2: 'LEFT', 3: 'BOTH' },
  provenance: 'fractal-convention',
};

/**
 * Standard LFO waveform table — shared across every Fractal block that
 * uses an LFO. Order is the AM4 / II / III canonical layout (verified
 * against AM4 hardware ; III uses the same ordering per
 * AxeEdit III's XML `dropdownLFOType` control).
 */
const LFO_WAVEFORMS: EnumOverlayEntry = {
  values: {
    0: 'Sine',
    1: 'Triangle',
    2: 'Square',
    3: 'Saw Up',
    4: 'Saw Down',
    5: 'Random',
    6: 'Smooth',
    7: 'Log',
    8: 'Exp',
    9: 'Pulse',
  },
  provenance: 'am4-shared',
  note: 'LFO_WAVEFORMS_VALUES from AM4; III preserves the ordering per AxeEdit III XML.',
};

/**
 * Tempo divisions — 79-entry table (0..78) shared across every Fractal
 * tempo-sync widget. AM4-verified.
 */
const TEMPO_DIVISIONS_PARTIAL: EnumOverlayEntry = {
  values: {
    0: 'None',
    1: '4x Whole', 2: '2x Whole', 3: 'Whole', 4: 'Whole Triplet',
    5: 'Half Dotted', 6: 'Half', 7: 'Half Triplet',
    8: 'Quarter Dotted', 9: 'Quarter', 10: 'Quarter Triplet',
    11: '8th Dotted', 12: '8th', 13: '8th Triplet',
    14: '16th Dotted', 15: '16th', 16: '16th Triplet',
    17: '32nd Dotted', 18: '32nd', 19: '32nd Triplet',
    20: '64th Dotted', 21: '64th', 22: '64th Triplet',
  },
  provenance: 'am4-shared',
  note: 'Top 23 entries from AM4 TEMPO_DIVISIONS_VALUES; full 79-entry table available via AM4 import.',
};

// ── Suffix → vocabulary map ─────────────────────────────────────
//
// Order matters: more-specific suffixes first, then catch-alls.
// Each tuple is [suffix, entry] — matched against the *end* of a
// param's `name` field. The first match wins.

const SUFFIX_RULES: Array<readonly [string, EnumOverlayEntry]> = [
  // Most specific first.
  ['_LOWCUTSLOPE', REVERB_CUT_SLOPE],
  ['_HIGHCUTSLOPE', REVERB_CUT_SLOPE],
  ['_LOW_CUT_SLOPE', REVERB_CUT_SLOPE],
  ['_HIGH_CUT_SLOPE', REVERB_CUT_SLOPE],

  ['_LFO1TYPE', LFO_WAVEFORMS],
  ['_LFO2TYPE', LFO_WAVEFORMS],
  ['_LFO3TYPE', LFO_WAVEFORMS],
  ['_LFO4TYPE', LFO_WAVEFORMS],
  ['_LFO_1_TYPE', LFO_WAVEFORMS],
  ['_LFO_2_TYPE', LFO_WAVEFORMS],
  ['_LFO_3_TYPE', LFO_WAVEFORMS],
  ['_LFO_4_TYPE', LFO_WAVEFORMS],
  ['_LFO_TYPE', LFO_WAVEFORMS],
  ['_LFOTYPE', LFO_WAVEFORMS],

  ['_TEMPO', TEMPO_DIVISIONS_PARTIAL],

  ['_SLOPE', FILTER_SLOPE],

  ['_CHANNEL', CHANNEL_PICKER],
  ['_CHAN', CHANNEL_PICKER],

  ['_INPUT_SELECT', INPUT_SELECT_3WAY],
  ['_INPUTSELECT', INPUT_SELECT_3WAY],
  ['_INSEL', INPUT_SELECT_3WAY],

  // Binary toggles — catch-all suffix tail. Apply last so more-specific
  // suffixes win.
  ['_BYP', BYPASS_STATE],
  ['_BYPASS', BYPASS_STATE],
  ['_MUTE', MUTE_THRU],
  ['_MUTE1', MUTE_THRU],
  ['_MUTE2', MUTE_THRU],
  ['_MUTE3', MUTE_THRU],
  ['_MUTE4', MUTE_THRU],
  ['_ENABLE', BINARY_OFF_ON],
  ['_DISABLE', BINARY_OFF_ON],
  ['_AUTOON', BINARY_OFF_ON],
  ['_AUTOENABLE', BINARY_OFF_ON],
  ['_AUTO', BINARY_OFF_ON],
  ['_INVERT', BINARY_OFF_ON],
  ['_HOLD', BINARY_OFF_ON],
];

// ── Effect-type model lists (gen-3 read leg, BK-093) ─────────────
//
// Each effect block's `*_TYPE` selector is an enum whose ORDINAL index
// joins to AM4's verified model table for that family (the gen-3
// state-broadcast / GET wire carries this same ordinal). This is the
// READ leg of BK-093: it labels what the device reports.
//
// Byte-anchored for REVERB_TYPE: the 2026-06-03 FM9 capture proved the
// gen-3 broadcast ordinal 16 == AM4 REVERB_TYPES[16] == 'Spring, Medium'
// (and ordinal 1 == 'Room, Medium'). The other effect-type lists are
// reused from AM4 by family and are high-confidence at the low ordinals
// (shared Fractal heritage), but gen-3 firmware may EXTEND a list with
// models AM4 never shipped, so treat a missing high-ordinal label as
// "newer than AM4," not an error.
//
// Set-by-name works: a gen-3 discrete SET carries float32(read-ordinal) at
// payload pos 12 (sub 09 00), so the read ordinal these tables decode with IS
// the set value (verified 2026-06-08, FM3 + FM9). The catalog encodes name ->
// ordinal directly. Numeric wire values also pass through.

const EFFECT_TYPE_NOTE =
  'Effect-type ordinals reused from AM4 by family (byte-anchored for Reverb; ' +
  'gen-3 firmware may extend the list). The ordinal is also the discrete-SET value, so these set by name.';

function effectType(values: Readonly<Record<number, string>>): EnumOverlayEntry {
  return { values, provenance: 'am4-shared', note: EFFECT_TYPE_NOTE };
}

const EFFECT_TYPE_OVERRIDES: Record<string, EnumOverlayEntry> = {
  REVERB_TYPE: effectType(REVERB_TYPES_VALUES), // byte-anchored: ordinal 16 == 'Spring, Medium'
  DELAY_TYPE: effectType(DELAY_TYPES_VALUES),
  CHORUS_TYPE: effectType(CHORUS_TYPES_VALUES),
  FLANGER_TYPE: effectType(FLANGER_TYPES_VALUES),
  PHASER_TYPE: effectType(PHASER_TYPES_VALUES),
  WAH_TYPE: effectType(WAH_TYPES_VALUES),
  // DISTORT_TYPE deliberately has NO entry. On gen-3 the DISTORT family is
  // the AMP block, so DISTORT_TYPE is the amp MODEL selector, not a drive-
  // pedal picker. The AM4 DRIVE/AMP_TYPES tables are NOT a valid ordinal
  // oracle for gen-3 amp ordinals (FM9 ordinals 65/179/264 exceed AM4's 248
  // entries and the names disagree), so labeling it from AM4 would fabricate
  // wrong amp model names. The amp model names come from the SHARED gen-3 read
  // roster (gen3ReadRosters, the complete 331 DISTORT models: factory-correlated
  // base unioned with the device-true FM9 cache roster) layered
  // at the catalog, and the ordinal IS the discrete-SET value, so amp set-by-name
  // resolves off that roster. This overlay just stays out of amp's way.
  //
  // FUZZ_TYPE (eff=118) IS the user-facing drive/fuzz pedal type selector —
  // NOT the amp. AM4's DRIVE_TYPES ordinals match byte-for-byte against FM9
  // hw captures: ordinal 15 = Blues OD and ordinal 36 = Blackglass 7K both
  // confirmed via fn=0x1F→0x75 + sub=0x1a label polls (2026-06-04 capture).
  FUZZ_TYPE: effectType(DRIVE_TYPES_VALUES),
  COMP_TYPE: effectType(COMPRESSOR_TYPES_VALUES),
  GEQ_TYPE: effectType(GEQ_TYPES_VALUES),
  FILTER_TYPE: effectType(FILTER_TYPES_VALUES),
  TREMOLO_TYPE: effectType(TREMOLO_TYPES_VALUES),
  ENHANCER_TYPE: effectType(ENHANCER_TYPES_VALUES),
  GATE_TYPE: effectType(GATE_TYPES_VALUES),
};

// ── Direct-name overrides ────────────────────────────────────────
//
// Hand-curated entries for III-specific params where a suffix rule
// would be wrong or where the vocabulary is non-standard.

const DIRECT_OVERRIDES: Record<string, EnumOverlayEntry> = {
  ...EFFECT_TYPE_OVERRIDES,
  GLOBAL_CABINETBYP: BYPASS_STATE,
  GLOBAL_PWRAMPBYP: BYPASS_STATE,
  GLOBAL_TUNERMUTE: BINARY_OFF_ON,
  GLOBAL_DELAYSPILL: BINARY_OFF_ON,
  GLOBAL_USETUNEOFFSETS: BINARY_OFF_ON,
  REVERB_HOLD: {
    values: { 0: 'OFF', 1: 'STACK', 2: 'HOLD' },
    provenance: 'am4-shared',
  },
  REVERB_NUMSPRINGS: {
    values: { 0: '1', 1: '2', 2: '3' },
    provenance: 'iii-spec',
    note: 'Inferred from spring-reverb editor presentation; III-untested.',
  },
  PRESET_BAND: {
    values: { 0: 'Low', 1: 'Mid', 2: 'High' },
    provenance: 'iii-spec',
    note: 'Multiband processor band-index — inferred from editor layout.',
  },
};

// ── Public API ────────────────────────────────────────────────────

/**
 * Look up an enum vocabulary for an III parameter by its symbol name.
 *
 *   resolveEnumValues('GLOBAL_TUNERMUTE')
 *     → { values: { 0: 'OFF', 1: 'ON' }, provenance: 'fractal-convention' }
 *
 *   resolveEnumValues('REVERB_LFO1TYPE')
 *     → { values: { 0: 'Sine', ... }, provenance: 'am4-shared', note: ... }
 *
 *   resolveEnumValues('NOT_A_REAL_PARAM')
 *     → undefined
 *
 * Lookup order: direct overrides first, then suffix rules in
 * declaration order.
 */
export function resolveEnumValues(name: string): EnumOverlayEntry | undefined {
  const direct = DIRECT_OVERRIDES[name];
  if (direct) return direct;
  for (const [suffix, entry] of SUFFIX_RULES) {
    if (name.endsWith(suffix)) return entry;
  }
  return undefined;
}

/**
 * Strict effect-type-only resolver: returns the byte-anchored `*_TYPE` model
 * list for a param ONLY if its symbol is one of the curated effect-type
 * overrides. Unlike `resolveEnumValues`, it does NOT apply the broad suffix
 * conventions (`_BYP`, `_CHAN`, `_TEMPO`, `_SLOPE`, ...).
 *
 * Consumers that wire enum labels onto a catalog whose params are NOT reliably
 * tagged `unit: 'enum'` (the FM3/FM9 device-true catalogs are all
 * `unit: 'unverified'`) use this to label the high-confidence effect-type
 * selectors without over-matching a continuous param that merely shares a
 * suffix. The full `resolveEnumValues` is correct only when the param is known
 * to be an enum (e.g. the III, whose catalog tags `unit: 'enum'`).
 */
export function resolveEffectTypeEnum(name: string): EnumOverlayEntry | undefined {
  return EFFECT_TYPE_OVERRIDES[name];
}

/**
 * Audit-friendly statistics for a calibration verifier or coverage
 * report. Returns the number of entries in each tier.
 */
export function enumOverlayStats(): {
  directOverrides: number;
  suffixRules: number;
} {
  return {
    directOverrides: Object.keys(DIRECT_OVERRIDES).length,
    suffixRules: SUFFIX_RULES.length,
  };
}
