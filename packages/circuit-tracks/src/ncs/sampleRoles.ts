/**
 * Circuit Tracks — resolve a loaded SAMPLE POOL to drum ROLES by name.
 *
 * `read_sample_directory` (sampleDirectory.ts) returns each slot's stored name.
 * This module reads meaning out of those names and answers "which slot holds the
 * kick?", so a groove binds/flips against the pool the project will actually
 * load, not against an assumed layout. This is Layer 3 of the groove→instrument
 * mapping (docs/design/groove-instrument-mapping.md).
 *
 * Name matching is honest, never positional (BK-CIRCUIT-DRUMBIND): the old
 * canonical [0,1,2,3] default bound WRONG on the factory-shaped pool (Novation
 * ships a `00_PCM.wav` placeholder at slot 0, shifting the whole kit up one) and
 * the failure was silent because condensed levels are stored at 0. A slot whose
 * name resolves to no role is simply unmatched (never force-fit), and a track
 * role with no name match is reported UNRESOLVED for the caller to refuse on;
 * there is no canonical-slot fallback anywhere in this module any more.
 *
 * Real pool names are compound (`01_stoken_4_02_kick2.wav`), so matching walks
 * the name's trailing tokens: extension stripped, then the last 1..3 tokens
 * joined and resolved via the canonical role spine, with a trailing-digit
 * variant pass (`kick2` → kick, reported as a substitution).
 */

import { canonicalRole, type DrumRole } from '@mcp-midi-control/core/protocol-generic/patterns/drumRoles.js';

import { DRUM_TRACK_BASE_VOICES, NUM_DRUM_TRACKS } from './drumBinding.js';
import type { SampleDirectoryResult } from './sampleDirectory.js';

/** How a sample name matched a role: exactly, or via a trailing-digit variant. */
export interface NameRoleMatch {
  role: DrumRole;
  /** True when the match needed the trailing-digit strip (`kick2` → kick). */
  variant: boolean;
}

/**
 * Resolve one stored sample name to the canonical role it means, or undefined.
 * Handles the real pool shapes: `.wav` extension, index/kit prefixes
 * (`01_stoken_4_02_kick2.wav`), multi-token roles (`closed_hat`), and numbered
 * variants (`kick2`, reported via `variant: true`). Longer token suffixes win
 * over shorter ones and an exact match wins over a variant, so `snare_roll`
 * resolves to snare_roll rather than to a "roll" alias of something else.
 */
export function matchSampleName(name: string): NameRoleMatch | undefined {
  const base = name.trim().replace(/\.[a-z0-9]{1,4}$/i, '');
  const tokens = base.split(/[_\-\s]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  // Try the whole name first (covers plain names like "closed hat"), then the
  // trailing 3..1 tokens, longest suffix first. Exact beats variant per suffix.
  const candidates: string[] = [base];
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    candidates.push(tokens.slice(tokens.length - n).join('_'));
  }
  let variantHit: DrumRole | undefined;
  for (const c of candidates) {
    const exact = canonicalRole(c);
    if (exact !== undefined) return { role: exact, variant: false };
    if (variantHit === undefined) {
      const stripped = c.replace(/[_\-\s]*[0-9]+$/, '');
      if (stripped.length > 0 && stripped !== c) {
        variantHit = canonicalRole(stripped);
      }
    }
  }
  return variantHit !== undefined ? { role: variantHit, variant: true } : undefined;
}

/** Resolve one sample name to its canonical role, or undefined (variant-blind form). */
export function roleOfSampleName(name: string): DrumRole | undefined {
  return matchSampleName(name)?.role;
}

/**
 * Map every occupied slot in a directory to its role (by name). Returns role →
 * the slots holding it, exact matches first then variants, each group in slot
 * order; slots whose name resolves to no role are omitted (never force-fit).
 */
export function rolesByDirectory(dir: SampleDirectoryResult): Map<DrumRole, number[]> {
  const exact = new Map<DrumRole, number[]>();
  const variant = new Map<DrumRole, number[]>();
  for (const s of dir.slots) {
    if (!s.name) continue;
    const m = matchSampleName(s.name);
    if (!m) continue;
    const bucket = m.variant ? variant : exact;
    const list = bucket.get(m.role) ?? [];
    list.push(s.slot);
    bucket.set(m.role, list);
  }
  const merged = new Map<DrumRole, number[]>();
  for (const [role, slots] of exact) merged.set(role, [...slots]);
  for (const [role, slots] of variant) merged.set(role, [...(merged.get(role) ?? []), ...slots]);
  return merged;
}

/** One drum track's name-resolved binding. */
export interface ResolvedTrackBinding {
  /** Drum track index 0..3 (Drum 1..4). */
  track: number;
  /** The role this track plays (kick/snare/closed_hat/ride by default). */
  role: DrumRole;
  /** The pool slot bound (0-based; device "Sample N" = slot N-1). */
  slot: number;
  /** The stored sample name that matched. */
  name: string;
  /** True when the match was a numbered variant (`kick2` standing in for kick). */
  substituted: boolean;
}

export interface NamedBindingResolution {
  /** 4 drum-track slots (Drum 1..4), 0-based, ready for setDrumSampleBinding. Present only when every role resolved. */
  binding?: number[];
  /** Per-track detail for the tracks that DID resolve. */
  resolved: ResolvedTrackBinding[];
  /** Track roles with NO name match in this pool (the caller must refuse, never guess a position). */
  unresolved: { track: number; role: DrumRole }[];
  /** Every role the pool can locate by name → its slot (exact matches preferred). Feeds per-step flip resolution. */
  role_slots: Record<string, number>;
}

/**
 * Resolve the 4-track drum binding by NAME against a read sample directory.
 * For each track role, bind the first pool slot whose stored name means that
 * role (exact match preferred, then a numbered variant such as `kick2`, which
 * is reported as a substitution). A role with no name match lands in
 * `unresolved` and `binding` is withheld: the caller REFUSES rather than
 * emitting a positional guess. `role_slots` carries every role the pool can
 * locate, so per-step sample flips resolve against the real pool too.
 */
export function resolveDrumBindingByName(
  dir: SampleDirectoryResult,
  trackVoices: readonly string[] = DRUM_TRACK_BASE_VOICES,
): NamedBindingResolution {
  if (trackVoices.length !== NUM_DRUM_TRACKS) {
    throw new RangeError(`expected ${NUM_DRUM_TRACKS} track voices, got ${trackVoices.length}`);
  }
  const byRole = rolesByDirectory(dir);
  const nameOf = new Map(dir.slots.filter((s) => s.name).map((s) => [s.slot, s.name!]));
  const role_slots: Record<string, number> = {};
  for (const [role, slots] of byRole) {
    if (slots.length > 0) role_slots[role] = slots[0];
  }
  const resolved: ResolvedTrackBinding[] = [];
  const unresolved: { track: number; role: DrumRole }[] = [];
  trackVoices.forEach((voice, track) => {
    const role = canonicalRole(voice);
    if (role === undefined) throw new RangeError(`unknown track voice "${voice}"`);
    const found = byRole.get(role);
    if (found === undefined || found.length === 0) {
      unresolved.push({ track, role });
      return;
    }
    const slot = found[0];
    const name = nameOf.get(slot) ?? '';
    resolved.push({
      track, role, slot, name,
      substituted: matchSampleName(name)?.variant === true,
    });
  });
  return {
    ...(unresolved.length === 0 ? { binding: resolved.map((r) => r.slot) } : {}),
    resolved,
    unresolved,
    role_slots,
  };
}
