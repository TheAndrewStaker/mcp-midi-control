/**
 * Shared error-message formatter — produces consistent "unknown param" /
 * "unknown enum value" prose across every device and every entry point
 * (preflight walker, per-device writers, per-device readers).
 *
 * Goal: a single canonical shape so the agent never has to learn one
 * format per device. AM4's `apply_preset` preflight has historically
 * produced the friendliest message:
 *
 *   slots[0] (position 1, wah): unknown param "effect_type" for block
 *   "wah". Known params for wah: wah.mix, wah.balance, wah.type, ...
 *
 * II / III / Hydra used to bypass that path and just say:
 *
 *   Parameter 'Drive 1.type' (group DRV) is not registered on Fractal
 *   Axe-Fx II.
 *
 * Every emission site now routes through the helpers in this file. The
 * resulting string:
 *   - cites the device + block + offending param
 *   - lists known params for the block, ordered by edit distance from
 *     the bad input (closest first), capped at 12 names
 *   - appends a "did you mean…?" line when any candidate sits within
 *     Levenshtein distance ≤ 3 (top 3 only)
 *
 * The same pattern applies to unknown enum values: list 5-10 candidate
 * labels ordered by edit distance, plus a top-3 "did you mean…?" line.
 */

/**
 * Standard Levenshtein distance (iterative two-row form). Standalone
 * so device packages can import it without pulling in preflight.ts.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const al = a.length;
  const bl = b.length;
  let prev: number[] = new Array(bl + 1);
  let curr: number[] = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bl];
}

/**
 * Rank a list of candidates by case-insensitive Levenshtein distance
 * from `input`. Substring containment scores as distance 1 (close
 * enough to surface). Returns every candidate in ascending-distance
 * order; the caller slices to its preferred cap.
 */
export function rankCandidates(
  input: string,
  candidates: readonly string[],
): Array<{ value: string; distance: number }> {
  const i = input.trim().toLowerCase();
  const scored: Array<{ value: string; distance: number }> = [];
  for (const c of candidates) {
    const lc = c.trim().toLowerCase();
    if (lc === i) continue;
    const d = levenshteinDistance(i, lc);
    const contains = lc.includes(i) || i.includes(lc);
    const distance = contains ? Math.min(d, 1) : d;
    scored.push({ value: c, distance });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored;
}

/**
 * Top-N closest candidates as plain strings. Convenience for the
 * `suggestions[]` field on ValidationError, where we only need the
 * names (not the distances).
 *
 * `maxDistance` defaults to 3 — anything past that is noise. Pass
 * `Infinity` to keep every candidate regardless of distance.
 */
export function topClosest(
  input: string,
  candidates: readonly string[],
  max = 5,
  maxDistance = 3,
): string[] {
  if (candidates.length === 0) return [];
  const ranked = rankCandidates(input, candidates);
  return ranked
    .filter((r) => r.distance <= maxDistance)
    .slice(0, max)
    .map((r) => r.value);
}

/**
 * Format a complete "unknown param" error string in the canonical
 * AM4-style shape, usable from preflight, per-device writers, and
 * per-device readers.
 *
 * Layout (single string, multi-line via period-then-space joins):
 *
 *   <slot context, optional>: unknown param "<bad>" for block
 *   "<block>". Known params for <block>: <name1>, <name2>, …
 *   (<N> names). Did you mean: <c1>, <c2>, <c3>?
 *
 * - `slotContext` is the AM4-style "slots[i] (position P, block_type)"
 *   prefix or an empty string when the call is single-param (set_param
 *   / get_param paths).
 * - `knownNames` is the full list of valid param names for the block.
 *   We sort by Levenshtein-closeness to the bad input and surface up
 *   to 12; if there are more, we append "… (N names)".
 * - Top-3 "Did you mean" suffix appears when any candidate sits
 *   within Levenshtein distance 3.
 */
export interface UnknownParamErrorParts {
  /** AM4-style slot/position prefix (or undefined for single-param calls). */
  slotContext?: string;
  /** Display device name (e.g. "Fractal Axe-Fx II XL+"). */
  deviceName: string;
  /** Block slug or display name. */
  block: string;
  /** The offending param name the agent typed. */
  badParam: string;
  /** All valid param names on this block. */
  knownNames: readonly string[];
}

export function formatUnknownParamError(parts: UnknownParamErrorParts): string {
  const { slotContext, deviceName, block, badParam, knownNames } = parts;
  const prefix = slotContext !== undefined && slotContext.length > 0
    ? `${slotContext}: `
    : '';
  const head =
    `${prefix}unknown param "${badParam}" for block "${block}" on ${deviceName}`;
  if (knownNames.length === 0) {
    return `${head}. No params registered for ${block}.`;
  }
  const ranked = rankCandidates(badParam, knownNames);
  // Ordered list: closest first; cap at 12 so the message stays
  // readable. If we cap, surface the total.
  const orderedNames = ranked.map((r) => r.value);
  const shownCap = 12;
  const shown = orderedNames.slice(0, shownCap);
  const totalSuffix = orderedNames.length > shownCap
    ? ` ... (${orderedNames.length} names total)`
    : '';
  const knownLine = `Known params for ${block}: ${shown.join(', ')}${totalSuffix}.`;
  // "Did you mean" — top 3 within distance 3.
  const close = ranked.filter((r) => r.distance <= 3).slice(0, 3);
  const didYouMean = close.length > 0
    ? ` Did you mean: ${close.map((c) => c.value).join(', ')}?`
    : '';
  return `${head}. ${knownLine}${didYouMean}`;
}

/**
 * Format an "unknown enum value" error in the same shape. Used when
 * the agent types an enum label that doesn't resolve (after the
 * BK-066 four-tier cascade has already given up).
 *
 *   <slot context>: <block>.<param>: unknown enum value "<bad>".
 *   Candidates: <c1>, <c2>, … (<N> options). Did you mean: <c1>, …?
 */
export interface UnknownEnumErrorParts {
  slotContext?: string;
  block: string;
  paramName: string;
  badValue: string;
  validValues: readonly string[];
}

export function formatUnknownEnumError(parts: UnknownEnumErrorParts): string {
  const { slotContext, block, paramName, badValue, validValues } = parts;
  const prefix = slotContext !== undefined && slotContext.length > 0
    ? `${slotContext}: `
    : '';
  const head = `${prefix}${block}.${paramName}: unknown enum value "${badValue}"`;
  if (validValues.length === 0) {
    return `${head}. No options registered.`;
  }
  const ranked = rankCandidates(badValue, validValues);
  const ordered = ranked.map((r) => r.value);
  const shownCap = 10;
  const shown = ordered.slice(0, shownCap);
  const totalSuffix = ordered.length > shownCap
    ? ` ... (${ordered.length} options total)`
    : '';
  const candidatesLine = `Candidates: ${shown.join(', ')}${totalSuffix}.`;
  const close = ranked.filter((r) => r.distance <= 3).slice(0, 3);
  const didYouMean = close.length > 0
    ? ` Did you mean: ${close.map((c) => c.value).join(', ')}?`
    : '';
  return `${head}. ${candidatesLine}${didYouMean}`;
}
