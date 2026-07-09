/**
 * Canonical drum-ROLE vocabulary — the shared spine of the groove→instrument
 * mapping (docs/design/groove-instrument-mapping.md).
 *
 * A groove names its hits in one of several dialects: GM import yields `hat`,
 * `openhat`; the Circuit binding speaks `closed_hat`, `open_hat`, `busy_hat`;
 * the SPD-SX voice_map speaks `hat`, `openhat`. Without a reconciliation layer a
 * groove's "hat" voice never finds the Circuit's "closed_hat" slot. This module
 * is that layer: ONE canonical role set + an alias table, so every device map and
 * every import keys off the same role.
 *
 * Device target maps (role → Circuit pool slot, role → SPD-SX pad note, …) live
 * in their device packages and look up by CANONICAL role; callers normalize an
 * incoming voice name with `canonicalRole()` first.
 */

/**
 * The canonical roles. Superset of the GM, Circuit, and SPD-SX dialects.
 * The second group is the FINE percussion vocabulary (GM 60-81 latin/aux
 * pieces): no device today places them directly, but keeping them distinct
 * preserves what the source groove *meant* — the fold layer (`drumFold.ts`)
 * reduces them to what a small kit can actually play, loudly.
 */
export const DRUM_ROLES = [
  'kick', 'snare', 'snare_roll', 'sticks', 'clap',
  'closed_hat', 'open_hat', 'busy_hat',
  'ride', 'ride_bell', 'crash', 'china',
  'tom', 'perc',
  // fine percussion (GM 60-81 + common kit extras)
  'bongo', 'conga', 'timbale', 'agogo', 'cabasa', 'maracas',
  'whistle', 'guiro', 'claves', 'woodblock', 'cuica', 'triangle',
] as const;

export type DrumRole = (typeof DRUM_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(DRUM_ROLES);

/**
 * Dialect aliases → canonical role. Keys are already normalized (lower-case,
 * non-alphanumerics collapsed to `_`), so `canonicalRole` can match after the
 * same normalization. Identity roles are NOT listed (they hit ROLE_SET directly).
 */
const ROLE_ALIASES: Readonly<Record<string, DrumRole>> = {
  // hi-hats — the big cross-dialect divergence
  hat: 'closed_hat',
  hihat: 'closed_hat',
  closedhat: 'closed_hat',
  closed_hihat: 'closed_hat',
  pedalhat: 'closed_hat',     // GM 44 pedal hat folds into closed (no separate Circuit pad)
  pedal_hat: 'closed_hat',
  openhat: 'open_hat',
  open_hihat: 'open_hat',
  // cymbals / extras
  ridebell: 'ride_bell',
  bell: 'ride_bell',
  splash: 'crash',
  snareroll: 'snare_roll',
  roll: 'snare_roll',
  sidestick: 'sticks',
  side_stick: 'sticks',
  rim: 'sticks',
  rimshot: 'sticks',
  cowbell: 'perc',
  tambourine: 'perc',
  shaker: 'perc',
  // fine-percussion spellings (GM names + common variants)
  hi_bongo: 'bongo',
  low_bongo: 'bongo',
  hi_conga: 'conga',
  low_conga: 'conga',
  mute_conga: 'conga',
  open_conga: 'conga',
  high_timbale: 'timbale',
  low_timbale: 'timbale',
  high_agogo: 'agogo',
  low_agogo: 'agogo',
  wood_block: 'woodblock',
  hi_wood_block: 'woodblock',
  low_wood_block: 'woodblock',
  vibraslap: 'perc',
};

/** Normalize a free-form voice/role name: lower-case, collapse non-alphanumerics to `_`. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Resolve any voice/role name (any dialect) to its canonical role, or `undefined`
 * if unknown. `canonicalRole('hat') === 'closed_hat'`,
 * `canonicalRole('Open Hat') === 'open_hat'`, `canonicalRole('kick') === 'kick'`.
 */
export function canonicalRole(name: string): DrumRole | undefined {
  const n = normalize(name);
  if (ROLE_SET.has(n)) return n as DrumRole;
  return ROLE_ALIASES[n];
}

/** True iff `name` resolves to a known canonical role. */
export function isKnownRole(name: string): boolean {
  return canonicalRole(name) !== undefined;
}
