/**
 * Drum-role FOLD layer — reduce a dense kit onto a small one, loudly.
 *
 * A real-song groove (GM `.mid`, Songsterr, a 30+ piece drum-VST export)
 * names pieces no small device owns: china, splash, six toms, congas,
 * guiro. Before this layer, any such voice was a hard `unmapped_voice`
 * error; the agent had to hand-re-map every piece. This layer folds an
 * unplaceable drum role onto the nearest MUSICAL-FUNCTION substitute the
 * target actually has, and reports every fold decision — warn-and-play
 * instead of refuse, without ever folding silently.
 *
 * Design rules (docs/design/groove-instrument-mapping.md):
 *  - Chains are hand-authored, ORDERED, and pre-flattened (no recursion):
 *    each entry lists every acceptable substitute, best first.
 *  - Folds stay within musical function: timekeepers fold to timekeepers
 *    (ride→hat), accent cymbals to accent cymbals (china→crash), texture
 *    percussion to perc/clap. `kick` and `snare` are TERMINAL — a groove's
 *    backbone is never re-voiced; a target without them errors honestly.
 *  - Melodic voices (bass/chord/lead/…) never fold — only names that
 *    resolve to a canonical drum role are eligible.
 *
 * Used at RESOLUTION time (`voiceMap.ts` + external routing), so the same
 * fold serves the host's voice_map and an external device's map alike.
 */

import { canonicalRole, type DrumRole } from './drumRoles.js';

/**
 * Ordered substitutes per canonical role, best-fit first. Pre-flattened:
 * the resolver tries each candidate against the target map in order and
 * takes the first hit. A role absent here (or with an empty list) is
 * terminal — no fold, honest error.
 */
export const ROLE_FOLDS: Readonly<Partial<Record<DrumRole, readonly DrumRole[]>>> = {
  // hats / timekeepers
  open_hat: ['closed_hat', 'perc'],
  busy_hat: ['closed_hat'],
  ride: ['closed_hat', 'crash', 'perc'],
  ride_bell: ['ride', 'closed_hat', 'perc'],
  // accent cymbals (last-resort closed_hat keeps the accent audible on a
  // 4-voice kit — warned, never silent)
  crash: ['ride', 'open_hat', 'closed_hat'],
  china: ['crash', 'ride', 'closed_hat'],
  // drums / hands. tom prefers SNARE (fills carry their rhythmic emphasis on
  // the snare on stripped kits — the standard drummer move); perc is last
  // resort because its slot holds an arbitrary texture sample (cowbell,
  // shaker) that can voice a fill wrong.
  tom: ['snare', 'perc'],
  clap: ['snare', 'perc'],
  sticks: ['perc', 'clap', 'snare'],
  snare_roll: ['snare'],
  perc: ['clap', 'tom', 'closed_hat'],
  // fine percussion (GM 60-81)
  bongo: ['conga', 'tom', 'perc', 'clap'],
  conga: ['tom', 'perc', 'clap'],
  timbale: ['tom', 'snare', 'perc'],
  agogo: ['perc', 'clap'],
  cabasa: ['perc', 'closed_hat', 'clap'],
  maracas: ['perc', 'closed_hat', 'clap'],
  whistle: ['perc', 'clap'],
  guiro: ['perc', 'clap'],
  claves: ['woodblock', 'sticks', 'perc', 'clap'],
  woodblock: ['sticks', 'perc', 'clap'],
  cuica: ['perc', 'clap'],
  triangle: ['perc', 'clap'],
  // kick / snare / closed_hat are deliberately terminal.
};

/** One fold decision, for the honesty report. */
export interface FoldDecision {
  /** The pattern's voice name as authored (dialect form). */
  voice: string;
  /** The canonical role it resolved to. */
  role: DrumRole;
  /** The substitute role that landed. */
  folded_to: DrumRole;
  /** The target voice_map key that substitute matched (the map's own dialect). */
  map_key: string;
}

/**
 * Index a target voice_map's keys by canonical role, so a fold candidate
 * ("closed_hat") finds the map's own spelling ("hat"). Non-drum keys
 * (melodic voices, drum1..4 aliases) don't canonicalize and are skipped.
 * First key wins on a canonical collision (maps list their primary
 * spelling first; aliases follow).
 */
export function indexMapByRole(mapKeys: readonly string[]): ReadonlyMap<DrumRole, string> {
  const idx = new Map<DrumRole, string>();
  for (const key of mapKeys) {
    const role = canonicalRole(key);
    if (role !== undefined && !idx.has(role)) idx.set(role, key);
  }
  return idx;
}

/**
 * Fold one voice onto a target map. Returns the fold decision, or
 * `undefined` when the voice is not a drum role, is terminal, or no
 * substitute exists in the map. Assumes the caller already tried (and
 * missed) the direct `map[voice]` lookup.
 *
 * Note the CANONICAL-IDENTITY case: a voice spelled `closed_hat` against a
 * map keyed `hat` is the same role in another dialect — that resolves here
 * too (folded_to === role), and callers may report it as a spelling match
 * rather than a musical substitution.
 */
export function foldVoice(
  voice: string,
  roleIndex: ReadonlyMap<DrumRole, string>,
): FoldDecision | undefined {
  const role = canonicalRole(voice);
  if (role === undefined) return undefined;
  // Same role, different dialect spelling.
  const identity = roleIndex.get(role);
  if (identity !== undefined) return { voice, role, folded_to: role, map_key: identity };
  for (const candidate of ROLE_FOLDS[role] ?? []) {
    const key = roleIndex.get(candidate);
    if (key !== undefined) return { voice, role, folded_to: candidate, map_key: key };
  }
  return undefined;
}

/** Human line for one fold decision (dispatcher warning text). */
export function describeFold(f: FoldDecision): string {
  return f.folded_to === f.role
    ? `voice "${f.voice}" matched the target's "${f.map_key}" (same role, different spelling).`
    : `voice "${f.voice}" (${f.role}) has no slot on this target — folded to "${f.map_key}" (${f.folded_to}). Re-map explicitly if that substitution is wrong.`;
}
