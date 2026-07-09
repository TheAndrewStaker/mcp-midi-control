/**
 * Circuit Tracks — resolve a loaded SAMPLE POOL to drum ROLES by name.
 *
 * `read_sample_directory` (sampleDirectory.ts) returns each slot's stored name.
 * This module reads meaning out of those names: it strips an index prefix
 * (`01_kick` → `kick`), runs the canonical-role resolver, and answers "which slot
 * holds the kick?" — so a groove can bind/flip by ROLE even for a kit we did not
 * upload ourselves. This is Layer 3 of the groove→instrument mapping
 * (docs/design/groove-instrument-mapping.md): role → the slot that actually holds
 * that sound, vs the canonical-layout assumption.
 *
 * Name matching is best-effort and honest: a slot whose name doesn't resolve to a
 * role is simply unmatched (never force-fit), and `bindingFromDirectory` reports
 * which tracks fell back to the canonical default so the caller can warn.
 */

import { canonicalRole, type DrumRole } from '@mcp-midi-control/core/protocol-generic/patterns/drumRoles.js';

import { CIRCUIT_VOICE_SLOT, DRUM_TRACK_BASE_VOICES, NUM_DRUM_TRACKS } from './drumBinding.js';
import type { SampleDirectoryResult } from './sampleDirectory.js';

/** Strip a leading index/kit prefix from a sample name: `01_kick`, `3-snare`, `80s_1_03_snr` → tail. */
function stripIndexPrefix(name: string): string {
  // Drop any run of leading "<digits/short-token><sep>" groups (e.g. "80s_1_03_").
  return name.replace(/^(?:[0-9a-z]{1,3}[_\-\s]+)*[0-9]+[_\-\s]+/i, '').trim() || name.trim();
}

/** Resolve one sample name to its canonical role, or undefined. */
export function roleOfSampleName(name: string): DrumRole | undefined {
  return canonicalRole(name) ?? canonicalRole(stripIndexPrefix(name));
}

/**
 * Map every occupied slot in a directory to its role (best-effort by name).
 * Returns role → the slots holding it (first occurrence first); a role may map to
 * several slots (e.g. two kicks), and slots whose name doesn't resolve are omitted.
 */
export function rolesByDirectory(dir: SampleDirectoryResult): Map<DrumRole, number[]> {
  const byRole = new Map<DrumRole, number[]>();
  for (const s of dir.slots) {
    if (!s.name) continue;
    const role = roleOfSampleName(s.name);
    if (!role) continue;
    const list = byRole.get(role) ?? [];
    list.push(s.slot);
    byRole.set(role, list);
  }
  return byRole;
}

export interface DirectoryBinding {
  /** 4 drum-track slots (Drum 1..4), 0-based, ready for setDrumSampleBinding. */
  binding: number[];
  /** Per track: the role we bound it to. */
  roles: DrumRole[];
  /** Tracks (0..3) that found no name match and fell back to the canonical slot. */
  fallbacks: number[];
}

/**
 * Derive a 4-track drum binding from a read sample directory by NAME-matching the
 * track base voices (default kick/snare/closed_hat/ride). For each track, bind the
 * first slot whose name means that role; if none is found, fall back to the
 * canonical slot for that role and record the track in `fallbacks`.
 */
export function bindingFromDirectory(
  dir: SampleDirectoryResult,
  trackVoices: readonly string[] = DRUM_TRACK_BASE_VOICES,
): DirectoryBinding {
  if (trackVoices.length !== NUM_DRUM_TRACKS) {
    throw new RangeError(`expected ${NUM_DRUM_TRACKS} track voices, got ${trackVoices.length}`);
  }
  const byRole = rolesByDirectory(dir);
  const binding: number[] = [];
  const roles: DrumRole[] = [];
  const fallbacks: number[] = [];
  trackVoices.forEach((voice, track) => {
    const role = canonicalRole(voice);
    if (role === undefined) throw new RangeError(`unknown track voice "${voice}"`);
    roles.push(role);
    const found = byRole.get(role);
    if (found && found.length > 0) {
      binding.push(found[0]);
    } else {
      binding.push(CIRCUIT_VOICE_SLOT[role]); // canonical fallback
      fallbacks.push(track);
    }
  });
  return { binding, roles, fallbacks };
}
