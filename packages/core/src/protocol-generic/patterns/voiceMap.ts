/**
 * Resolve an abstract pattern voice to a concrete `{channel, note}` on a
 * specific target device. The target's `capabilities.voice_map` owns this
 * mapping, that's what keeps device vocabulary out of the neutral pattern.
 *
 * Honesty rule: an unmapped voice is a typed error, never a silent drop.
 * DRUM voices get one softening: before erroring, the fold layer
 * (`drumFold.ts`) tries the nearest musical-function substitute the target
 * owns (china→crash, conga→tom, open_hat→closed_hat on a 4-voice kit) and
 * every fold is REPORTED — warn-and-play, never silent. A voice with no
 * substitute (and every melodic voice) still errors.
 */

import type { DeviceCapabilities, VoiceTarget } from '../types.js';
import type { NeutralPattern } from './types.js';
import { PatternError } from './types.js';
import { foldVoice, indexMapByRole, type FoldDecision } from './drumFold.js';

/** Full resolution result: targets plus the fold decisions that made them. */
export interface VoiceResolution {
  targets: Record<string, VoiceTarget>;
  /** Voices that resolved via the fold layer (incl. dialect-spelling matches). */
  folds: FoldDecision[];
  /** Per voice: the voice_map key it resolved to (its own name, or the fold's). */
  map_keys: Record<string, string>;
}

/**
 * Resolve one voice. A pattern's `voices[v].note_hint` overrides the
 * voice_map note (melodic voices that carry their own pitch), but the
 * CHANNEL always comes from the target's voice_map, the device owns where
 * its sounds live.
 */
export function resolveVoiceTarget(
  voice: string,
  caps: DeviceCapabilities,
  noteHint?: number,
): VoiceTarget {
  const map = caps.voice_map;
  if (!map) {
    throw new PatternError('not_a_pattern_target', 'Target device declares no voice_map.', { voice });
  }
  let entry = map[voice];
  if (!entry) {
    const fold = foldVoice(voice, indexMapByRole(Object.keys(map)));
    if (fold) entry = map[fold.map_key];
  }
  if (!entry) {
    throw new PatternError(
      'unmapped_voice',
      `Target has no voice_map entry (or drum-role substitute) for "${voice}".`,
      { voice, available: Object.keys(map) },
    );
  }
  return noteHint !== undefined ? { channel: entry.channel, note: noteHint } : entry;
}

/**
 * Resolve every voice in a pattern against a target's capabilities,
 * reporting fold decisions. Collects ALL unresolvable voices into one
 * error so the agent fixes them in one pass (mirrors the apply_preset
 * batch-validation philosophy).
 */
export function resolvePatternVoicesDetailed(
  pattern: NeutralPattern,
  caps: DeviceCapabilities,
): VoiceResolution {
  const map = caps.voice_map;
  if (!map) {
    throw new PatternError('not_a_pattern_target', 'Target device declares no voice_map.', {
      pattern: pattern.name,
    });
  }
  const roleIndex = indexMapByRole(Object.keys(map));
  const targets: Record<string, VoiceTarget> = {};
  const folds: FoldDecision[] = [];
  const mapKeys: Record<string, string> = {};
  const unmapped: string[] = [];
  for (const voice of Object.keys(pattern.voices)) {
    let key = voice;
    if (!map[key]) {
      const fold = foldVoice(voice, roleIndex);
      if (fold) { key = fold.map_key; folds.push(fold); }
      else { unmapped.push(voice); continue; }
    }
    const entry = map[key];
    const hint = pattern.voices[voice].note_hint;
    targets[voice] = hint !== undefined ? { channel: entry.channel, note: hint } : entry;
    mapKeys[voice] = key;
  }
  if (unmapped.length > 0) {
    throw new PatternError(
      'unmapped_voice',
      `Target cannot place voice(s): ${unmapped.join(', ')} (no entry and no drum-role substitute). ` +
      `Available: ${Object.keys(map).join(', ')}.`,
      { unmapped, available: Object.keys(map) },
    );
  }
  return { targets, folds, map_keys: mapKeys };
}

/** Resolve every voice; targets only (see resolvePatternVoicesDetailed for folds). */
export function resolvePatternVoices(
  pattern: NeutralPattern,
  caps: DeviceCapabilities,
): Record<string, VoiceTarget> {
  return resolvePatternVoicesDetailed(pattern, caps).targets;
}
