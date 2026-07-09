/**
 * Round-robin voice spreading — defeat per-track monophonic choke.
 *
 * Each Circuit Tracks drum track is ONE monophonic voice: a new hit retriggers
 * (chokes) the previous hit on the SAME track, so a fast ringing sound (hats,
 * ride, cymbal) cuts itself off and sounds unnaturally abrupt. The classic
 * workaround is to alternate consecutive hits across TWO (or more) drum tracks
 * loaded with the same sample: hit N keeps ringing on track A while hit N+1
 * plays on track B, so the tails overlap and bleed like an acoustic kit.
 *
 * This transform automates that distribution at the neutral-pattern layer
 * (before voice_map resolution): a source voice's hits are dealt out across its
 * target voices in time order. The targets are ordinary voices, so the existing
 * realizers / voice_map place them with no special-casing. Tedious to author by
 * hand (you'd hand-split every other hit onto a second track); one line here.
 */

import { PatternError, type NeutralPattern, type Step, type Voice } from './types.js';

/** Map a source voice to the >=2 target voices to rotate its hits across. */
export type RoundRobinSpec = Record<string, readonly string[]>;

const rest = (): Step => ({ on: false });

export interface RoundRobinResult {
  pattern: NeutralPattern;
  warnings: string[];
}

/**
 * Spread each source voice's consecutive hits across its target voices in
 * rotation. The source voice is consumed (its hits now live on the targets).
 * A round-robin hit that lands on a step a target already used overwrites it
 * (the round-robin pattern wins) and is counted in a warning.
 */
export function applyRoundRobin(pattern: NeutralPattern, spec: RoundRobinSpec | undefined): RoundRobinResult {
  if (!spec || Object.keys(spec).length === 0) return { pattern, warnings: [] };
  const len = pattern.steps;
  const warnings: string[] = [];

  // Mutable working copy of every voice's step row.
  const work = new Map<string, Step[]>();
  for (const [name, v] of Object.entries(pattern.voices)) work.set(name, v.steps.map((s) => ({ ...s })));

  for (const [source, targetsRaw] of Object.entries(spec)) {
    const targets = [...targetsRaw];
    if (targets.length < 2) {
      throw new PatternError('parse_error',
        `round_robin["${source}"] needs at least 2 target tracks to alternate across (got ${targets.length}). Example: {"${source}":["drum3","drum4"]}.`);
    }
    if (targets.includes(source)) {
      throw new PatternError('parse_error',
        `round_robin["${source}"] lists the source voice "${source}" as a target; rotate across DIFFERENT drum tracks (e.g. drum3/drum4).`);
    }
    if (new Set(targets).size !== targets.length) {
      throw new PatternError('parse_error', `round_robin["${source}"] has duplicate target tracks: ${targets.join(', ')}.`);
    }
    const src = work.get(source);
    if (!src) {
      throw new PatternError('unmapped_voice',
        `round_robin source voice "${source}" is not in the pattern. Pattern voices: ${[...work.keys()].filter((k) => k !== source).join(', ') || '(none)'}.`);
    }
    // Each target gets a step row (created empty if it had none of its own).
    for (const t of targets) {
      if (!work.has(t)) work.set(t, Array.from({ length: len }, rest));
    }
    // Deal the source's hits across the targets, in time order.
    let hit = 0;
    let collisions = 0;
    for (let i = 0; i < src.length; i++) {
      if (!src[i].on) continue;
      const dst = work.get(targets[hit % targets.length])!;
      if (dst[i].on) collisions++;
      dst[i] = { ...src[i] }; // carry velocity / accent / roll / notes
      hit++;
    }
    work.delete(source); // source voice consumed
    warnings.push(
      `Round-robin: spread ${hit} "${source}" hit(s) across ${targets.join(' / ')} so they ring through instead of choking. ` +
      `Load the SAME sample on each of those drum tracks for it to sound like one instrument.` +
      (collisions > 0 ? ` ${collisions} hit(s) overwrote an existing hit on a target track.` : ''),
    );
  }

  const voices: Record<string, Voice> = {};
  for (const [name, steps] of work) {
    const prior = pattern.voices[name];
    voices[name] = prior?.note_hint !== undefined ? { steps, note_hint: prior.note_hint } : { steps };
  }
  return { pattern: { ...pattern, voices }, warnings };
}
