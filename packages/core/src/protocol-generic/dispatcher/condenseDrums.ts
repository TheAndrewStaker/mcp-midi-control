/**
 * Wire the drum CONDENSER into the authoring path (`apply_pattern condense_drums`).
 *
 * `patterns/drumCondense.ts` owns the musical question: squeeze a 12-voice kit
 * onto four tracks, resolve per-step contention, preserve identity with per-step
 * sample flips. It is deliberately device-blind: it reports flips as ROLES and
 * knows nothing about channels, notes, or sample slots. This module is the thin
 * layer that turns that result into something the compiler and the device writer
 * can consume, and nothing more.
 *
 * ## Why synthetic voices instead of rewriting the pattern
 *
 * The motivating case authors the SAME groove twice: in full on an external
 * multi-pad sampler (Circuit MIDI 2 → SPD-SX) and condensed onto the host's own
 * four drum tracks. Both copies want the voice named "crash", so the condensed
 * copy is carried as SYNTHETIC voices (`condense:drum1`…) pinned by compile
 * `overrides` to the host's own drum destinations. That keeps one compile pass,
 * one event list, and leaves the caller's pattern untouched for the piece-
 * compression report.
 *
 * ## Why the source drum voices lose their internal destination
 *
 * With `condense_drums` on, the host's drum tracks carry the CONDENSED kit. If
 * the source voices also kept their own voice_map destinations they would author
 * a second, un-condensed copy on top of it: a folded crash landing on the ride
 * track alongside the condensed crash, doubling hits and defeating the per-step
 * flips. So each drum voice is overridden to its external destinations only
 * (an empty list when it has none), and the condensed tracks are the single
 * internal copy. Melodic voices are never touched.
 */

import {
  PatternError, canonicalRole, condenseToKit, describeCondense, resolveVoiceTarget,
  type NeutralPattern, type Voice,
} from '../patterns/index.js';
import type { DeviceCapabilities, VoiceTarget } from '../types.js';

/**
 * Stored mixer level written to every condensed drum track. Zero on purpose: a
 * condensed kit laid under an external kit must be INAUDIBLE until the player
 * dials it up from the mixer, and the level has to be the stored byte because a
 * project change overwrites the live value (see the Circuit `DRUM_LEVEL_BASE`
 * decode).
 */
const CONDENSED_DRUM_LEVEL = 0;

/** Prefix of the synthetic per-track voice names. Contains ':' so it can never collide with an authored voice or a canonical role. */
const SYNTHETIC_PREFIX = 'condense:';

/** What `buildCondensedDrums` hands the caller to fold into one compile pass. */
export interface CondensedDrums {
  /** Synthetic voices to add to the pattern being compiled (one per drum track). */
  voices: Record<string, Voice>;
  /**
   * Compile overrides: the synthetic voices pinned to the host's own drum
   * destinations, plus every source drum voice stripped of its internal one.
   */
  overrides: Record<string, VoiceTarget[]>;
  /** Per-step flips as ROLES, keyed "drum1".."drumN" → 1-based step → role. */
  flip_roles: Record<string, Record<string, string>>;
  /** Stored level for each drum track, in track order. */
  levels: number[];
  /** The roles the tracks carry, in track order (for receipts). */
  kit: readonly string[];
  /** Steps where two same-family pieces competed for one track and the loser was dropped. */
  collisions: number;
  /** Human report lines (routings, drops, collisions). */
  hints: string[];
}

/**
 * Build the condensed-drum wiring for one pattern, or `undefined` when the
 * pattern has no drum voices at all (a drumless section of a song is normal,
 * not an error, it simply contributes no condensed tracks).
 *
 * `externalOverrides` is the already-built `external_targets` map; a drum voice
 * present there keeps exactly its external destinations.
 */
export function buildCondensedDrums(
  pattern: NeutralPattern,
  caps: DeviceCapabilities,
  externalOverrides?: Readonly<Record<string, readonly VoiceTarget[]>>,
): CondensedDrums | undefined {
  const roster = caps.drum_track_roles;
  if (roster === undefined || roster.length === 0) {
    throw new PatternError(
      'not_a_pattern_target',
      'condense_drums needs a device with its own internal drum tracks (capability drum_track_roles); this target declares none. ' +
      'It is for a host sequencer such as the Circuit Tracks, whose four drum tracks would otherwise sit empty while the groove plays an external kit.',
    );
  }
  const kit = roster.map((r) => {
    const role = canonicalRole(r);
    if (role === undefined) {
      throw new PatternError('not_a_pattern_target', `Target declares drum track role "${r}", which is not a canonical drum role.`, { role: r });
    }
    return role;
  });

  const drumVoices = Object.keys(pattern.voices).filter((v) => canonicalRole(v) !== undefined);
  if (drumVoices.length === 0) return undefined;

  const condensed = condenseToKit(pattern, kit);

  // Pin each synthetic track voice to the destination the HOST plays that role
  // on. Resolved through the normal voice_map path (so `closed_hat` finds the
  // Circuit's `hat` pad via the fold layer) rather than by index, because the
  // track order and the voice_map are separate device facts.
  const voices: Record<string, Voice> = {};
  const overrides: Record<string, VoiceTarget[]> = {};
  for (let track = 0; track < kit.length; track++) {
    const role = kit[track]!;
    const row = condensed.pattern.voices[role];
    if (row === undefined) continue;
    const name = `${SYNTHETIC_PREFIX}drum${track + 1}`;
    voices[name] = row;
    overrides[name] = [resolveVoiceTarget(role, caps)];
  }

  // Strip the source drum voices' internal destinations; keep their external
  // ones. An empty list is a real answer (compile emits nothing for it), not a
  // missing one, so a drum voice routed nowhere externally simply stops
  // authoring a second internal copy.
  for (const v of drumVoices) {
    overrides[v] = [...(externalOverrides?.[v] ?? [])];
  }

  const flip_roles: Record<string, Record<string, string>> = {};
  for (const [track, byStep] of condensed.flips) {
    const key = `drum${track + 1}`;
    const steps: Record<string, string> = {};
    for (const [step, role] of byStep) steps[String(step + 1)] = role;   // 1-based, as drum_flips is
    flip_roles[key] = steps;
  }

  const hints = [
    `Condensed the drum part onto the ${kit.length} internal drum tracks (${kit.join(' / ')}) at level ${CONDENSED_DRUM_LEVEL}, ` +
    'so it is stored silently under the routed kit and the player dials it up from the mixer. ' +
    `${describeCondense(condensed).join(' ')}`,
  ];
  if (condensed.collisions.length > 0) {
    hints.push(`${condensed.collisions.length} step(s) had two same-family pieces competing for one track; the louder hit kept the step.`);
  }

  return {
    voices,
    overrides,
    flip_roles,
    levels: kit.map(() => CONDENSED_DRUM_LEVEL),
    kit,
    collisions: condensed.collisions.length,
    hints,
  };
}
