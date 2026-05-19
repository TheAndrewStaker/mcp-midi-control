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
