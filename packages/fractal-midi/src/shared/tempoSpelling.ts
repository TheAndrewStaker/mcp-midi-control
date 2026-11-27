/**
 * Tempo-division spelling: maps the ways a person or an agent writes a
 * dotted / triplet note division onto a Fractal tempo roster's own form
 * ("1/8 DOT", "1/4 TRIP").
 *
 * Why it exists: enum resolvers do a relaxed match that strips
 * punctuation, so "1/8." collapsed to plain "1/8" and the dot was silently
 * lost (found 2026-11-27 on the AM4). A modifier must either survive into
 * the roster's spelling or the value must be refused; it is never dropped.
 *
 * Roster-driven: it only engages when the roster has "<div> DOT" or
 * "<div> TRIP" entries, so it cannot affect a non-tempo enum.
 */

const WORD_DIVISIONS: Readonly<Record<string, string>> = {
  whole: '1',
  half: '1/2',
  quarter: '1/4',
  eighth: '1/8',
  '8th': '1/8',
  sixteenth: '1/16',
  '16th': '1/16',
  'thirty second': '1/32',
  '32nd': '1/32',
  'sixty fourth': '1/64',
  '64th': '1/64',
};

const DOT_WORDS = new Set(['.', 'd', 'dot', 'dots', 'dotted']);
const TRIP_WORDS = new Set(['t', 'trip', 'triplet', 'triplets']);

export interface TempoSpelling {
  /** The roster-form spelling ("1/8 DOT"), or undefined when a modifier was given but the roster has no such form. */
  readonly canonical: string | undefined;
  /** The modifier the input carried, if any. */
  readonly modifier?: 'DOT' | 'TRIP';
}

/** True when `roster` is a tempo-division list (has DOT/TRIP entries). */
export function isTempoRoster(roster: readonly string[]): boolean {
  return roster.some((r) => /^\s*\d+(\/\d+)?\s+(DOT|TRIP)\s*$/i.test(r));
}

/**
 * Parse a tempo-division spelling. Returns undefined when the input is not
 * a division spelling at all (or the roster is not a tempo roster), so the
 * caller's ordinary matching runs unchanged.
 */
export function spellTempoDivision(input: string, roster: readonly string[]): TempoSpelling | undefined {
  if (!isTempoRoster(roster)) return undefined;
  let s = input.trim().toLowerCase();
  if (s === '') return undefined;
  // "1/8." / "1/8d" / "1/8t": attach-style modifiers.
  s = s.replace(/^(\d+(?:\/\d+)?)\s*\.$/, '$1 dot').replace(/^(\d+(?:\/\d+)?)(d|t)$/, '$1 $2');
  s = s.replace(/[-_,()]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\bnotes?\b/g, '').replace(/\s+/g, ' ').trim();

  let division: string | undefined;
  let rest: string[] = [];
  const tokens = s.split(' ');
  // Division as a fraction token, or a word ("eighth", "dotted eighth", "8th note").
  const fracIdx = tokens.findIndex((t) => /^\d+(\/\d+)?$/.test(t));
  if (fracIdx >= 0) {
    division = tokens[fracIdx];
    rest = tokens.filter((_, i) => i !== fracIdx);
  } else {
    for (const [word, div] of Object.entries(WORD_DIVISIONS)) {
      const re = new RegExp(`\\b${word}\\b`);
      if (re.test(s)) {
        division = div;
        rest = s.replace(re, ' ').split(' ').filter((t) => t !== '');
        break;
      }
    }
  }
  if (division === undefined) return undefined;

  let modifier: 'DOT' | 'TRIP' | undefined;
  for (const t of rest) {
    if (DOT_WORDS.has(t)) modifier = 'DOT';
    else if (TRIP_WORDS.has(t)) modifier = 'TRIP';
    else return undefined; // unknown token: not a plain division spelling, leave it to the caller
  }
  // A bare integer like "3" with no modifier is a roster value of its own; let the caller match it.
  if (modifier === undefined && fracIdx >= 0) return undefined;

  const wanted = modifier === undefined ? division : `${division} ${modifier}`;
  const hit = roster.find((r) => r.trim().toLowerCase() === wanted.toLowerCase());
  return { canonical: hit?.trim(), ...(modifier !== undefined ? { modifier } : {}) };
}
