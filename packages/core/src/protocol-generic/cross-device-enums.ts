/**
 * BK-066 Phase 1: tolerant enum value matcher.
 *
 * The agent that learned one Fractal device's amp vocabulary hits
 * sequential validation errors when it tries another. AM4 calls a
 * Mesa amp "USA Pre Clean"; Axe-Fx II calls the same family member
 * "USA PRE CLEAN" (all-caps wiki name) and the closely related
 * variant "USA CLEAN". A naive exact-match enum lookup rejects
 * "USA CLEAN" on AM4 as invalid even though the closest match is
 * one space and a casing change away.
 *
 * `findEnumMatch` walks four tiers in increasing tolerance:
 *
 *   1. **exact**: bit-for-bit equality. Fast path.
 *   2. **case_or_space**: case-insensitive + whitespace-collapsed.
 *      "usa clean" matches "USA CLEAN".
 *   3. **fuzzy**: Levenshtein distance <= 2 against any valid value
 *      after normalization. "USA CLEAN" against `["USA Pre Clean",
 *      "USA Clean Reverb"]` is distance 4 against the normalized
 *      form, which is too far for strict tolerance, so the caller
 *      gets `none` plus the top-3 candidates for the disambiguation
 *      message instead.
 *   4. **none**: nothing within tolerance. Returns the top-3
 *      closest candidates so the caller can render a useful
 *      "did you mean ..." error.
 *
 * Phase 2 (BK-066 Phase 2, deferred) layers a cross-device concept
 * key on top: `"mesa-mark-iic-plus"` maps to `"USA IIC+"` (II) and
 * `"USA MK IIC+"` (AM4). That table is a data-gathering exercise
 * across every amp + drive + cab + reverb enum per device and lives
 * outside this file.
 *
 * Pure function. No descriptor lookups, no global state, no I/O.
 */

/**
 * Confidence tier of the resolution.
 *
 *   - `exact`         : returned value is bit-equal to the input.
 *   - `case_or_space` : returned value matches input ignoring case
 *                       and whitespace runs.
 *   - `fuzzy`         : returned value is within Levenshtein <= 2 of
 *                       the input after case + whitespace
 *                       normalization. Closest single candidate; top
 *                       3 by distance also surfaced.
 *   - `none`          : nothing within tolerance. `match` is
 *                       `undefined`; `candidates` carries the 3
 *                       closest values to display in the error.
 */
export type EnumMatchCertainty = 'exact' | 'case_or_space' | 'fuzzy' | 'none';

export interface EnumMatchResult {
  /** The canonical valid value, or `undefined` if nothing was close enough. */
  match: string | undefined;
  /** Top 3 closest candidates by Levenshtein distance, useful for error messages. */
  candidates: string[];
  /** How confident the resolution is (see EnumMatchCertainty). */
  certainty: EnumMatchCertainty;
}

/** Maximum Levenshtein distance allowed for the `fuzzy` tier. */
const FUZZY_MAX_DISTANCE = 2;

/**
 * Collapse runs of whitespace, strip leading and trailing whitespace,
 * and lowercase. Preserves all other characters (punctuation,
 * hyphens, plus signs) verbatim so "USA IIC+" still keeps the `+`.
 */
function normalizeForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Standard iterative Levenshtein. Both inputs are short (enum value
 * labels are typically under 32 chars), so the O(m*n) DP table is
 * trivially cheap. We allocate a single rolling row to save the
 * usual table allocation.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      let m = del;
      if (ins < m) m = ins;
      if (sub < m) m = sub;
      curr[j] = m;
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Return up to 3 candidate strings from `validValues`, sorted by
 * Levenshtein distance against the normalized input ascending.
 * Stable for ties (insertion order from `validValues`).
 */
function topCandidates(input: string, validValues: readonly string[]): string[] {
  const normalizedInput = normalizeForMatch(input);
  const scored = validValues.map((v, idx) => ({
    value: v,
    distance: levenshtein(normalizedInput, normalizeForMatch(v)),
    idx,
  }));
  scored.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.idx - b.idx;
  });
  return scored.slice(0, 3).map((s) => s.value);
}

/**
 * Resolve a user-supplied enum value to its canonical form.
 *
 * `validValues` is the set of legal strings for the target param
 * (in declaration order; ties in the fuzzy-match step are broken by
 * that order). The function does not mutate `validValues`.
 *
 * Returned `match` echoes the EXACT string from `validValues` for
 * `exact`, `case_or_space`, and `fuzzy` tiers, so the caller can
 * pass `match` straight through to the wire codec without
 * re-normalizing.
 */
export function findEnumMatch(
  input: string,
  validValues: readonly string[],
): EnumMatchResult {
  // Tier 1: bit-equal.
  for (const v of validValues) {
    if (v === input) {
      return { match: v, candidates: [v], certainty: 'exact' };
    }
  }

  const normalizedInput = normalizeForMatch(input);

  // Tier 2: case + whitespace collapse.
  for (const v of validValues) {
    if (normalizeForMatch(v) === normalizedInput) {
      return { match: v, candidates: [v], certainty: 'case_or_space' };
    }
  }

  // Tier 3 + 4: fuzzy distance. Compute distances once, decide tier
  // from the closest score.
  let bestDistance = Number.MAX_SAFE_INTEGER;
  let bestValue: string | undefined;
  let bestIdx = -1;
  for (let i = 0; i < validValues.length; i++) {
    const v = validValues[i];
    if (v === undefined) continue;
    const d = levenshtein(normalizedInput, normalizeForMatch(v));
    if (d < bestDistance || (d === bestDistance && i < bestIdx)) {
      bestDistance = d;
      bestValue = v;
      bestIdx = i;
    }
  }

  const candidates = topCandidates(input, validValues);

  if (bestValue !== undefined && bestDistance <= FUZZY_MAX_DISTANCE) {
    return { match: bestValue, candidates, certainty: 'fuzzy' };
  }

  return { match: undefined, candidates, certainty: 'none' };
}

// ============================================================
// BK-066 Phase 2: cross-device enum concept-key resolution.
//
// Phase 1 (above) handles case, whitespace, and Levenshtein-2 fuzz.
// Phase 2 (here) handles the case where the SAME conceptual model
// has different display names on different devices that no amount
// of casing or fuzz can reconcile. `"USA IIC+"` on Axe-Fx II is
// the same Mesa Mark IIC+ as `"USA MK IIC+"` on AM4, but the strings
// are too far apart for the Phase 1 fuzzy tier (distance 4).
//
// Resolution flow inside the dispatcher's enum validator:
//
//   1. Run `findEnumMatch(input, validValues)` first (Phase 1).
//   2. If `certainty === 'exact' | 'case_or_space'`, ship it.
//   3. If `certainty === 'fuzzy'`, ship it but surface the
//      substitution to the agent.
//   4. If `certainty === 'none'`, try `resolveEnumAlias(port,
//      block, paramName, input)`. If it returns a `canonical` that
//      is in `validValues`, ship it and surface the aliasUsed.
//      Otherwise return the Phase 1 error (with top-3 candidates).
//
// The order matters: Phase 1's exact / case tiers are cheap, and we
// want most inputs to short-circuit there before ever consulting
// the concept-key table. Phase 2 is for the "agent learned device
// A's word, then tried device B" case only.
//
// The table is pure data, frozen. Entries are keyed by concept-key
// (kebab-case `<vendor>-<model>-<variant>`). Per-device columns are
// the EXACT runtime enum strings each device accepts on the wire.
//
// Source of truth: docs/_private/bk066-phase2-enum-mapping-research.md
// (2026-05-19), generated by mining `node_modules/fractal-midi/dist/
// shared/lineage/axefx2-*-lineage.json` against
// `fractal-midi/dist/{am4/cacheEnums,axe-fx-ii/params}.js`. Only
// HIGH-confidence rows are committed; UNCERTAIN rows are held in
// the research doc until founder verifies via AxeEdit + AM4 panel.
// ============================================================

/**
 * Phase 2 result. `canonical` is the per-port display string the
 * caller should send to the wire codec; `aliasUsed` is the original
 * input string echoed back so the dispatcher can surface the
 * correction; `conceptKey` is the BK-066 Phase 2 row that matched
 * (useful for telemetry and for the dispatcher's "did you know
 * these are the same amp" hint).
 */
export interface ResolvedEnumAlias {
  /** The exact display string the target device accepts. */
  canonical: string;
  /** Present only when a substitution occurred. */
  aliasUsed?: string;
  /** The Phase 2 concept-key that resolved the alias. */
  conceptKey?: string;
}

/**
 * One row in the cross-device enum concept map.
 *
 *   block       : block type (`amp`, `drive`, `reverb`, ...) — the
 *                 first key in the table's nested lookup.
 *   paramName   : parameter name within that block (`type` /
 *                 `effect_type`). Use the AM4-canonical name; the
 *                 BK-065 alias resolver normalizes incoming param
 *                 names before this table is consulted.
 *   am4         : exact string from AM4's runtime enum table, or
 *                 `null` when AM4 does not carry this model.
 *   axeFxII     : exact string from II's `*_EFFECT_TYPE_VALUES`,
 *                 or `null`.
 *   axeFxIII    : exact string from III's catalog (when shipped),
 *                 or `null`.
 *   description : free-text identification. Not used by the
 *                 resolver; surfaced in dispatcher logs and dev tools.
 */
export interface CrossDeviceEnumRow {
  readonly block: string;
  readonly paramName: string;
  readonly am4: string | null;
  readonly axeFxII: string | null;
  readonly axeFxIII: string | null;
  readonly description: string;
}

/**
 * Phase 2 concept-key table. See research doc §4 for the kebab-case
 * naming convention.
 *
 * HIGH-confidence entries only. UNCERTAIN rows from the research doc
 * §3 are left commented out at the bottom of each section until
 * founder confirms. Adding a wrong row produces a silent cross-device
 * misroute, worse than the BK-066 fuzzy-tier warning the agent gets
 * without the alias.
 */
export const CROSS_DEVICE_ENUMS: Readonly<Record<string, CrossDeviceEnumRow>> =
  Object.freeze({
    // ---------- AMP MODELS ----------
    'fender-65-bassguy-normal': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: '65 Bassguy Normal',
      axeFxII: '65 BASSGUY NRML',
      axeFxIII: null,
      description: 'Fender AB165 Bassman head (normal channel)',
    }),
    'fender-deluxe-verb-vibrato': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Deluxe Verb Vibrato',
      axeFxII: 'DELUXE VERB VIB',
      axeFxIII: null,
      description: 'Fender AB763 Deluxe Reverb (vibrato channel)',
    }),
    'fender-double-verb-vibrato': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Double Verb Vibrato',
      axeFxII: 'DOUBLE VERB VIB',
      axeFxIII: null,
      description: 'Fender Twin Reverb (vibrato channel)',
    }),
    'marshall-plexi-50w-normal': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Plexi 50W Normal',
      axeFxII: 'PLEXI 50W NRML',
      axeFxIII: null,
      description: 'Marshall 50W Plexi (normal channel)',
    }),
    'marshall-plexi-50w-high-1': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Plexi 50W High 1',
      axeFxII: 'PLEXI 50W HI 1',
      axeFxIII: null,
      description: 'Marshall 50W Plexi (high-treble channel, var 1)',
    }),
    'mesa-mark-iic-plus': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'USA MK IIC+',
      axeFxII: 'USA IIC+',
      axeFxIII: null,
      description: 'Mesa/Boogie Mark IIC+',
    }),
    'mesa-mark-iic-plus-plus': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'USA MK IIC++',
      axeFxII: 'USA IIC++',
      axeFxIII: null,
      description: 'Mesa/Boogie Mark IIC++ (modded)',
    }),
    'mesa-recto2-orange-vintage': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Recto2 Orange Vintage',
      axeFxII: 'RECTO2 ORG VNTG',
      axeFxIII: null,
      description: 'Mesa Dual Rectifier (3ch, orange, vintage)',
    }),
    'mesa-recto2-orange-modern': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Recto2 Orange Modern',
      axeFxII: 'RECTO2 ORG MDRN',
      axeFxIII: null,
      description: 'Mesa Dual Rectifier (3ch, orange, modern)',
    }),
    'mesa-recto2-red-vintage': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Recto2 Red Vintage',
      axeFxII: 'RECTO2 RED VNTG',
      axeFxIII: null,
      description: 'Mesa Dual Rectifier (3ch, red, vintage)',
    }),
    'mesa-recto2-red-modern': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Recto2 Red Modern',
      axeFxII: 'RECTO2 RED MDRN',
      axeFxIII: null,
      description: 'Mesa Dual Rectifier (3ch, red, modern)',
    }),
    'mesa-recto1-orange-modern': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Recto1 Orange Modern',
      axeFxII: 'RECTO1 ORG MDRN',
      axeFxIII: null,
      description: 'Mesa Dual Rectifier (2ch, orange, modern)',
    }),
    'soldano-slo-100-rhythm': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Solo 100 Rhythm',
      axeFxII: 'SOLO 100 RHY',
      axeFxIII: null,
      description: 'Soldano SLO-100 (rhythm channel)',
    }),
    'ca3-plus-rhythm': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'CA3+ Rhythm',
      axeFxII: 'CA3+ RHY',
      axeFxIII: null,
      description: 'Carol-Ann CA3+ (rhythm channel)',
    }),
    'mesa-lone-star-lead': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Texas Star Lead',
      axeFxII: 'TX STAR LEAD',
      axeFxIII: null,
      description: 'Mesa Lone Star (lead channel)',
    }),
    'mesa-lone-star-clean': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Texas Star Clean',
      axeFxII: 'TX STAR CLEAN',
      axeFxIII: null,
      description: 'Mesa Lone Star (clean channel)',
    }),
    'fender-super-verb-vibrato': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Super Verb Vibrato',
      axeFxII: 'SUPER VERB VIB',
      axeFxIII: null,
      description: 'Fender AB763 Super Reverb (vibrato channel)',
    }),
    'fender-super-verb-normal': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Super Verb Normal',
      axeFxII: 'SUPER VERB NRM',
      axeFxIII: null,
      description: 'Fender AB763 Super Reverb (normal channel)',
    }),
    'fender-deluxe-verb-normal': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Deluxe Verb Normal',
      axeFxII: 'DELUXE VERB NRM',
      axeFxIII: null,
      description: 'Fender AB763 Deluxe Reverb (normal channel)',
    }),
    'fender-double-verb-normal': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Double Verb Normal',
      axeFxII: 'DOUBLE VERB NRM',
      axeFxIII: null,
      description: 'Fender Twin Reverb (normal channel)',
    }),
    'peavey-6160-plus-lead': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'PVH 6160+ Lead',
      axeFxII: 'PVH 6160+ LD',
      axeFxIII: null,
      description: 'Peavey 6505+ / EVH 5150-II (lead channel)',
    }),
    'mesa-triaxis-ld2-yellow': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'USA Pre LD2 Yellow',
      axeFxII: 'USA PRE LD2 YLW',
      axeFxIII: null,
      description: 'Mesa TriAxis (lead 2 yellow)',
    }),
    'marshall-plexi-100w-normal': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Plexi 100W Normal',
      axeFxII: 'PLEXI 100W NRML',
      axeFxIII: null,
      description: 'Marshall 100W Plexi (normal channel)',
    }),
    'marshall-plexi-50w-jumped': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Plexi 50W Jumped',
      axeFxII: 'PLEXI 50W JUMP',
      axeFxIII: null,
      description: 'Marshall 50W Plexi (jumped channels)',
    }),
    'marshall-plexi-100w-jumped': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Plexi 100W Jumped',
      axeFxII: 'PLEXI 100W JUMP',
      axeFxIII: null,
      description: 'Marshall 100W Plexi (jumped channels)',
    }),
    'marshall-jtm45-jumped': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Brit JM45 Jumped',
      axeFxII: 'BRIT JM45 JUMP',
      axeFxIII: null,
      description: 'Marshall JTM 45 (jumped channels)',
    }),
    'marshall-1987x-jumped': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: '1987X Jumped',
      axeFxII: '1987X JUMP',
      axeFxIII: null,
      description: 'Marshall 50W 1987X (jumped channels)',
    }),
    'marshall-1959-super-lead-jumped': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: '1959SLP Jumped',
      axeFxII: '1959SLP JUMP',
      axeFxIII: null,
      description: 'Marshall 1959 Super Lead Plexi (jumped)',
    }),
    'trainwreck-liverpool': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Wrecker Liverpool',
      axeFxII: 'WRECKER LVRPOOL',
      axeFxIII: null,
      description: 'Trainwreck Liverpool',
    }),
    'orange-ad30htc-clean': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Citrus A30 Clean',
      axeFxII: 'CITRUS A30 CLN',
      axeFxIII: null,
      description: 'Orange AD30HTC (clean channel)',
    }),
    'diezel-vh4-silver-2': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Dizzy V4 Silver 2',
      axeFxII: 'DIZZY V4 SLVR 2',
      axeFxIII: null,
      description: 'Diezel VH4 (silver, channel 2)',
    }),
    'diezel-vh4-silver-3': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Dizzy V4 Silver 3',
      axeFxII: 'DIZZY V4 SLVR 3',
      axeFxIII: null,
      description: 'Diezel VH4 (silver, channel 3)',
    }),
    'diezel-vh4-silver-4': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Dizzy V4 Silver 4',
      axeFxII: 'DIZZY V4 SLVR 4',
      axeFxIII: null,
      description: 'Diezel VH4 (silver, channel 4)',
    }),
    'friedman-smallbox': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Friedman Small Box',
      axeFxII: 'FRIEDMAN SM BOX',
      axeFxIII: null,
      description: 'Friedman Smallbox',
    }),
    'vox-ac30-bright': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Class-A 30W Bright',
      axeFxII: 'CLASS-A 30W BRT',
      axeFxIII: null,
      description: 'Vox AC30 (top boost / bright)',
    }),
    'marshall-plexi-50w-high-2': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: 'Plexi 50W High 2',
      axeFxII: 'PLEXI 50W HI 2',
      axeFxIII: null,
      description: 'Marshall 50W Plexi (high-treble, var 2)',
    }),
    'fender-5f1-tweed-ec-champlifier': Object.freeze({
      block: 'amp',
      paramName: 'type',
      am4: '5F1 Tweed EC Champlifier',
      axeFxII: '5F1 TWEED EC',
      axeFxIII: null,
      description: 'Fender EC Vibro-Champ (5F1 + Eric Clapton)',
    }),
    // UNCERTAIN, held back until founder confirms via AxeEdit panel.
    // See docs/_private/bk066-phase2-enum-mapping-research.md §3.
    //   marshall-jcm800-2204         AM4="Brit 800 2204 High" II="BRIT 800"
    //   ampeg-svt-bass-1             AM4="SV Bass 1"          II="SV BASS"
    //   fender-5f1-tweed-champlifier AM4="5F1 Tweed Champlifier" II="5F1 TWEED"
    //   fender-5f8-tweed-bright      AM4="5F8 Tweed Bright"   II="5F8 TWEED"

    // ---------- DRIVE MODELS ----------
    'proco-rat': Object.freeze({
      block: 'drive',
      paramName: 'type',
      am4: 'Rat Distortion',
      axeFxII: 'RAT DIST',
      axeFxIII: null,
      description: 'Pro Co RAT',
    }),
    'butler-tube-driver-3-knob': Object.freeze({
      block: 'drive',
      paramName: 'type',
      am4: 'Tube Drive 3-Knob',
      axeFxII: 'TUBE DRV 3-KNOB',
      axeFxIII: null,
      description: 'Butler Tube Driver (3-knob)',
    }),
    'butler-tube-driver-4-knob': Object.freeze({
      block: 'drive',
      paramName: 'type',
      am4: 'Tube Drive 4-Knob',
      axeFxII: 'TUBE DRV 4-KNOB',
      axeFxIII: null,
      description: 'Butler Tube Driver (4-knob)',
    }),
    'tycobrahe-octavia': Object.freeze({
      block: 'drive',
      paramName: 'type',
      am4: 'Octave Distortion',
      axeFxII: 'OCTAVE DIST',
      axeFxIII: null,
      description: 'Tycobrahe Octavia',
    }),
    'tape-distortion-generic': Object.freeze({
      block: 'drive',
      paramName: 'type',
      am4: 'Tape Distortion',
      axeFxII: 'TAPE DIST',
      axeFxIII: null,
      description: 'Generic tape distortion',
    }),
    'marshall-shredmaster': Object.freeze({
      block: 'drive',
      paramName: 'type',
      am4: 'Shred Distortion',
      axeFxII: 'SHRED DIST',
      axeFxIII: null,
      description: 'Marshall Shredmaster',
    }),
    'boss-mt2-metal-zone': Object.freeze({
      block: 'drive',
      paramName: 'type',
      am4: 'M-Zone Distortion',
      axeFxII: 'M-ZONE DIST',
      axeFxIII: null,
      description: 'Boss MT-2 Metal Zone',
    }),
    // UNCERTAIN, see research doc §3.
    //   cochrane-timmy  AM4="Timothy Down"  II="TIMOTHY"

    // ---------- REVERB ALGORITHMS ----------
    'room-small': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Room, Small',
      axeFxII: 'SMALL ROOM',
      axeFxIII: null,
      description: 'Small room reverb',
    }),
    'room-medium': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Room, Medium',
      axeFxII: 'MEDIUM ROOM',
      axeFxIII: null,
      description: 'Medium room reverb',
    }),
    'room-large': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Room, Large',
      axeFxII: 'LARGE ROOM',
      axeFxIII: null,
      description: 'Large room reverb',
    }),
    'hall-small': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Hall, Small',
      axeFxII: 'SMALL HALL',
      axeFxIII: null,
      description: 'Small hall reverb',
    }),
    'hall-medium': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Hall, Medium',
      axeFxII: 'MEDIUM HALL',
      axeFxIII: null,
      description: 'Medium hall reverb',
    }),
    'hall-large': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Hall, Large',
      axeFxII: 'LARGE HALL',
      axeFxIII: null,
      description: 'Large hall reverb',
    }),
    'chamber-small': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Chamber, Small',
      axeFxII: 'SMALL CHAMBER',
      axeFxIII: null,
      description: 'Small chamber reverb',
    }),
    'chamber-medium': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Chamber, Medium',
      axeFxII: 'MEDIUM CHAMBER',
      axeFxIII: null,
      description: 'Medium chamber reverb',
    }),
    'chamber-large': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Chamber, Large',
      axeFxII: 'LARGE CHAMBER',
      axeFxIII: null,
      description: 'Large chamber reverb',
    }),
    'plate-small': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Plate, Small',
      axeFxII: 'SMALL PLATE',
      axeFxIII: null,
      description: 'Small plate reverb',
    }),
    'plate-medium': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Plate, Medium',
      axeFxII: 'MEDIUM PLATE',
      axeFxIII: null,
      description: 'Medium plate reverb',
    }),
    'plate-large': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Plate, Large',
      axeFxII: 'LARGE PLATE',
      axeFxIII: null,
      description: 'Large plate reverb',
    }),
    'spring-small': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Spring, Small',
      axeFxII: 'SMALL SPRING',
      axeFxIII: null,
      description: 'Small spring reverb',
    }),
    'spring-medium': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Spring, Medium',
      axeFxII: 'MEDIUM SPRING',
      axeFxIII: null,
      description: 'Medium spring reverb',
    }),
    'spring-large': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Spring, Large',
      axeFxII: 'LARGE SPRING',
      axeFxIII: null,
      description: 'Large spring reverb',
    }),
    'hall-concert': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Hall, Concert',
      axeFxII: 'CONCERT HALL',
      axeFxIII: null,
      description: 'Concert hall reverb',
    }),
    'plate-london-emt140': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Plate, London',
      axeFxII: 'LONDON PLATE',
      axeFxIII: null,
      description: 'EMT 140 (London plate)',
    }),
    'plate-sun': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Plate, Sun',
      axeFxII: 'SUN PLATE',
      axeFxIII: null,
      description: 'Sun plate reverb',
    }),
    'room-huge': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Room, Huge',
      axeFxII: 'HUGE ROOM',
      axeFxIII: null,
      description: 'Huge room reverb',
    }),
    'room-drum': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Room, Drum',
      axeFxII: 'DRUM ROOM',
      axeFxIII: null,
      description: 'Drum room reverb',
    }),
    'chamber-deep': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Chamber, Deep',
      axeFxII: 'DEEP CHAMBER',
      axeFxIII: null,
      description: 'Deep chamber reverb',
    }),
    'hall-asylum': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Hall, Asylum',
      axeFxII: 'ASYLUM HALL',
      axeFxIII: null,
      description: 'Asylum hall reverb',
    }),
    'plate-vocal': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Plate, Vocal',
      axeFxII: 'VOCAL PLATE',
      axeFxIII: null,
      description: 'Vocal plate reverb',
    }),
    'hall-wide': Object.freeze({
      block: 'reverb',
      paramName: 'type',
      am4: 'Hall, Wide',
      axeFxII: 'WIDE HALL',
      axeFxIII: null,
      description: 'Wide hall reverb',
    }),
  });

/**
 * Internal reverse-lookup cache: per (port, block, paramName), a
 * Map from normalized display string to concept-key.
 *
 * Built lazily on first call to `resolveEnumAlias` for a given
 * (port, block, paramName) triple. The full table is small so the
 * lazy build is cheap; eager-building at module load wastes startup
 * time when most calls come from device code paths that never query
 * this resolver.
 */
const REVERSE_INDEX = new Map<string, Map<string, string>>();

function indexKey(port: string, block: string, paramName: string): string {
  return `${port}|${block}|${paramName}`;
}

function normalizeIndexValue(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildReverseIndex(
  port: string,
  block: string,
  paramName: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [conceptKey, row] of Object.entries(CROSS_DEVICE_ENUMS)) {
    if (row.block !== block) continue;
    // Intentionally do NOT filter on `row.paramName`. The BK-065 alias
    // table renames the same enum-typed knob differently across
    // devices (`type` on AM4 ↔ `effect_type` on II ↔ `type` on III),
    // so a strict filter would miss rows after the dispatcher has
    // already aliased the param name to the target's canonical form.
    // In practice each block has one enum-typed `type` knob, so the
    // (block, value) pair uniquely identifies a concept-key; the
    // `paramName` field stays on `CrossDeviceEnumRow` as documentation.
    if (row.am4) map.set(normalizeIndexValue(row.am4), conceptKey);
    if (row.axeFxII) map.set(normalizeIndexValue(row.axeFxII), conceptKey);
    if (row.axeFxIII) map.set(normalizeIndexValue(row.axeFxIII), conceptKey);
  }
  REVERSE_INDEX.set(indexKey(port, block, paramName), map);
  return map;
}

/**
 * Map port slug to the column on a `CrossDeviceEnumRow`.
 *
 * Returns `null` for ports that don't have a column (e.g. `hydrasynth`,
 * the Phase 2 table is Fractal-only).
 */
function rowFieldForPort(
  port: string,
  row: CrossDeviceEnumRow,
): string | null {
  switch (port) {
    case 'am4':
      return row.am4;
    case 'axe-fx-ii':
      return row.axeFxII;
    case 'axe-fx-iii':
      return row.axeFxIII;
    default:
      return null;
  }
}

/**
 * Resolve a user-supplied enum value to the target port's
 * canonical display string by walking the cross-device concept-key
 * table.
 *
 * Returns an unchanged `canonical: input` when:
 *   - the port is unknown to the table (e.g. `hydrasynth`);
 *   - the (block, paramName) pair has no entries in the table;
 *   - the input string isn't recognized as ANY device's display
 *     value for this concept;
 *   - the matched concept exists but the target port's column is
 *     `null` (the target device doesn't carry the model).
 *
 * Returns `{ canonical, aliasUsed, conceptKey }` when a substitution
 * happens. Case-insensitive on the lookup side; canonical strings
 * are returned exactly as the target device's runtime enum stores
 * them.
 *
 * Pure function. The reverse-index Map is module-scoped memoization,
 * no I/O, no global state mutation visible outside this file.
 */
export function resolveEnumAlias(
  port: string,
  blockType: string,
  paramName: string,
  enumValue: string,
): ResolvedEnumAlias {
  const portKey = port.trim().toLowerCase();
  const blockKey = blockType.trim().toLowerCase();
  const paramKey = paramName.trim().toLowerCase();

  const cacheKey = indexKey(portKey, blockKey, paramKey);
  let reverse = REVERSE_INDEX.get(cacheKey);
  if (!reverse) {
    reverse = buildReverseIndex(portKey, blockKey, paramKey);
  }

  const conceptKey = reverse.get(normalizeIndexValue(enumValue));
  if (!conceptKey) return { canonical: enumValue };

  const row = CROSS_DEVICE_ENUMS[conceptKey];
  if (!row) return { canonical: enumValue };

  const targetString = rowFieldForPort(portKey, row);
  if (targetString === null) return { canonical: enumValue };

  // Same string on both sides, no substitution happened.
  if (normalizeIndexValue(targetString) === normalizeIndexValue(enumValue)) {
    return { canonical: targetString };
  }

  return { canonical: targetString, aliasUsed: enumValue, conceptKey };
}
