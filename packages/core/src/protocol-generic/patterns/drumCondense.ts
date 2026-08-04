/**
 * CONDENSE a full drum arrangement onto a 4-voice kit.
 *
 * The motivating case: a song's detailed drums are authored to an external
 * multi-pad sampler (SPD-SX on MIDI 2) while the sequencer's own four drum
 * tracks sit empty. Those four tracks are wasted capacity — condensing the same
 * groove onto them lets the player dial internal samples in underneath the
 * external kit from the mixer, without re-authoring anything.
 *
 * ## Why this is not just `foldVoice` in a loop
 *
 * `drumFold` answers "this voice has no slot on the target — what is the
 * nearest substitute?", one voice at a time. Condensation is a different
 * question: a 12-voice groove is being squeezed onto FOUR tracks, so many
 * voices land on the SAME track and then compete for individual steps. The hard
 * part is the per-step contention, which `foldVoice` has no view of.
 *
 * The fold table is still the only source of musical adjacency — this module
 * derives its families FROM `ROLE_FOLDS` rather than declaring a second table.
 * A second table would drift out of sync with the first, and a fold policy
 * disagreeing with itself between two code paths is a bug that presents as
 * "the ride went to the wrong track sometimes".
 *
 * ## Identity survives via per-step sample flips
 *
 * Folding a crash onto the ride track would normally lose the crash. It does
 * not have to: the Circuit picks a sample PER STEP (`drum_choice`), so a step
 * that carries a folded voice also carries a flip back to that voice's own
 * sample. The track is just the lane; the sample is still the original voice.
 * This module reports flips as ROLES (`'crash'`), never as device sample slots
 * — resolving a role to a slot number is the device layer's job, and keeping
 * that out of here is what lets a non-Circuit target reuse the same condenser.
 *
 * ## What it deliberately does NOT do
 *
 * It never spills a voice onto an unrelated family's track to avoid a drop. A
 * crash pushed onto the kick track because the ride track was busy is worse
 * than a missing crash: it corrupts the pulse, which is the one thing a
 * listener tracks. Contention losers are DROPPED and reported, never rehomed.
 */
import type { NeutralPattern, Step, Voice } from './types.js';
import { type DrumRole, canonicalRole } from './drumRoles.js';
import { ROLE_FOLDS, indexMapByRole, foldVoice } from './drumFold.js';

/**
 * How a single authored voice was routed onto the condensed kit.
 * `track` indexes `kit`, so it is the caller's track order, not a device slot.
 */
export interface CondenseRouting {
  /** The pattern's voice name as authored. */
  voice: string;
  /** Canonical role it resolved to. */
  role: DrumRole;
  /** Kit index it landed on (0-based index INTO `kit`). */
  track: number;
  /** The kit role owning that track. */
  track_role: DrumRole;
  /** True when the voice IS the track's own role (no substitution). */
  exact: boolean;
  /** Hits placed, and hits lost to a same-family collision. */
  placed: number;
  dropped: number;
}

/** One step where two voices of the same family competed; the loser is dropped. */
export interface CondenseCollision {
  step: number;
  track: number;
  /** The voice that kept the step. */
  winner: string;
  /** The voice that lost it. */
  loser: string;
}

export interface CondenseResult {
  /** The condensed pattern: exactly `kit.length` voices, named for their roles. */
  pattern: NeutralPattern;
  /**
   * Per-step sample flips that preserve folded identity, keyed
   * `flips[trackIndex][stepIndex] = role`. A step is absent when the voice
   * that landed there is the track's own role (no flip needed).
   */
  flips: ReadonlyMap<number, ReadonlyMap<number, DrumRole>>;
  routings: readonly CondenseRouting[];
  collisions: readonly CondenseCollision[];
  /** Voices that are not drums (bass/lead/chord) — untouched, never condensed. */
  ignored: readonly string[];
  /** Drum voices with no family on this kit at all. Nothing was placed for them. */
  unroutable: readonly string[];
}

/**
 * The default 4-voice kit: the roles a stock Circuit Tracks kit loads into
 * Drum 1..4. Callers with a differently-loaded kit pass their own.
 */
export const DEFAULT_CONDENSE_KIT: readonly DrumRole[] = ['kick', 'snare', 'closed_hat', 'ride'];

/**
 * Distance from `role` to `target` through the fold table: 0 = same role, n =
 * n-th choice in the fold chain, `undefined` = unreachable.
 *
 * Breadth-first rather than a direct scan of `ROLE_FOLDS[role]`, because folds
 * CHAIN: `ride_bell -> ride -> closed_hat` is a real path that a one-level scan
 * would miss, and missing it silently drops a voice that has a perfectly good
 * home two steps away.
 */
function foldDistance(role: DrumRole, target: DrumRole): number | undefined {
  if (role === target) return 0;
  const seen = new Set<DrumRole>([role]);
  let frontier: DrumRole[] = [role];
  for (let depth = 1; depth <= 8 && frontier.length > 0; depth++) {
    const next: DrumRole[] = [];
    for (const r of frontier) {
      for (const cand of ROLE_FOLDS[r] ?? []) {
        if (seen.has(cand)) continue;
        if (cand === target) return depth;
        seen.add(cand);
        next.push(cand);
      }
    }
    frontier = next;
  }
  return undefined;
}

/** Effective velocity for contention ranking (accent counts, absent = mid). */
function weightOf(s: Step): number {
  if (s.velocity !== undefined) return s.velocity;
  return s.accent === true ? 110 : 80;
}

/**
 * Condense `pattern`'s drum voices onto a `kit`-sized set of tracks.
 *
 * Melodic voices are passed over untouched (they belong to note tracks, not the
 * drum kit) and reported in `ignored`, so a caller can tell "no bass here" from
 * "the bass was silently eaten".
 */
export function condenseToKit(
  pattern: NeutralPattern,
  kit: readonly DrumRole[] = DEFAULT_CONDENSE_KIT,
): CondenseResult {
  if (kit.length === 0) throw new RangeError('condenseToKit needs at least one kit role.');
  const stepCount = pattern.steps;
  const roleIndex = indexMapByRole(kit as readonly string[]);

  const ignored: string[] = [];
  const unroutable: string[] = [];

  // ---- 1. Assign every drum voice to a kit track, with its fold distance. ----
  interface Assigned { voice: string; role: DrumRole; track: number; distance: number; steps: readonly Step[] }
  const assigned: Assigned[] = [];

  for (const [voiceName, voice] of Object.entries(pattern.voices)) {
    const role = canonicalRole(voiceName);
    if (role === undefined) { ignored.push(voiceName); continue; }
    // Reuse the shared resolver so family membership matches `apply_pattern`'s
    // own fold decisions exactly. `foldVoice` handles the identity case too.
    const decision = foldVoice(voiceName, roleIndex);
    if (decision === undefined) { unroutable.push(voiceName); continue; }
    const trackRole = canonicalRole(decision.map_key)!;
    const track = kit.indexOf(trackRole);
    if (track < 0) { unroutable.push(voiceName); continue; }
    assigned.push({
      voice: voiceName, role, track,
      distance: foldDistance(role, trackRole) ?? 99,
      steps: voice.steps,
    });
  }

  // ---- 2. Per step, per track, resolve contention. ----
  // Closer fold wins; then the louder hit (an accent surviving over a ghost note
  // is the musically right call); then voice name, purely so the result is
  // deterministic across runs rather than dependent on object key order.
  const winners = new Map<number, Map<number, Assigned>>();
  const collisions: CondenseCollision[] = [];
  const placedBy = new Map<string, number>();
  const droppedBy = new Map<string, number>();

  for (let step = 0; step < stepCount; step++) {
    for (let track = 0; track < kit.length; track++) {
      const contenders = assigned.filter((a) => a.track === track && a.steps[step]?.on === true);
      if (contenders.length === 0) continue;
      contenders.sort((x, y) =>
        x.distance - y.distance
        || weightOf(y.steps[step]!) - weightOf(x.steps[step]!)
        || x.voice.localeCompare(y.voice));
      const [win, ...lost] = contenders;
      if (!winners.has(track)) winners.set(track, new Map());
      winners.get(track)!.set(step, win!);
      placedBy.set(win!.voice, (placedBy.get(win!.voice) ?? 0) + 1);
      for (const l of lost) {
        droppedBy.set(l.voice, (droppedBy.get(l.voice) ?? 0) + 1);
        collisions.push({ step, track, winner: win!.voice, loser: l.voice });
      }
    }
  }

  // ---- 3. Emit one voice per kit track, plus the identity-preserving flips. ----
  const voices: Record<string, Voice> = {};
  const flips = new Map<number, Map<number, DrumRole>>();

  for (let track = 0; track < kit.length; track++) {
    const trackRole = kit[track]!;
    const byStep = winners.get(track);
    const steps: Step[] = [];
    for (let step = 0; step < stepCount; step++) {
      const win = byStep?.get(step);
      if (win === undefined) { steps.push({ on: false }); continue; }
      // Carry the source step verbatim: velocity, accent, micro placement, roll
      // and probability are all part of the groove's feel, and re-deriving them
      // would quietly flatten it.
      steps.push({ ...win.steps[step]! });
      if (win.role !== trackRole) {
        if (!flips.has(track)) flips.set(track, new Map());
        flips.get(track)!.set(step, win.role);
      }
    }
    voices[trackRole] = { steps };
  }

  const routings: CondenseRouting[] = assigned.map((a) => ({
    voice: a.voice,
    role: a.role,
    track: a.track,
    track_role: kit[a.track]!,
    exact: a.role === kit[a.track],
    placed: placedBy.get(a.voice) ?? 0,
    dropped: droppedBy.get(a.voice) ?? 0,
  }));

  return {
    pattern: {
      ...pattern,
      name: pattern.name,
      voices,
      // The source's melodic hints describe voices that no longer exist here.
      voice_hints: undefined,
    },
    flips,
    routings,
    collisions,
    ignored,
    unroutable,
  };
}

/** Human summary lines for the tool response (one per routed voice + drops). */
export function describeCondense(r: CondenseResult): string[] {
  const lines: string[] = [];
  for (const rt of r.routings) {
    if (rt.placed === 0 && rt.dropped > 0) {
      lines.push(`"${rt.voice}" (${rt.role}) was fully masked on the ${rt.track_role} track — ${rt.dropped} hits dropped to same-family collisions.`);
    } else if (rt.exact) {
      lines.push(`"${rt.voice}" → ${rt.track_role} track, ${rt.placed} hits.`);
    } else {
      lines.push(`"${rt.voice}" (${rt.role}) → ${rt.track_role} track, ${rt.placed} hits, sample flipped back to ${rt.role} per step${rt.dropped > 0 ? ` (${rt.dropped} dropped)` : ''}.`);
    }
  }
  if (r.unroutable.length > 0) {
    lines.push(`No home on this kit, nothing placed: ${r.unroutable.join(', ')}.`);
  }
  return lines;
}
