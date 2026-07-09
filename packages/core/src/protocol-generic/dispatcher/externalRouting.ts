/**
 * External-instrument routing for `apply_pattern` (the `external_targets` arg).
 *
 * A host sequencer (Circuit Tracks) can drive an EXTERNAL device (Roland SPD-SX)
 * through its outward MIDI 1/2 tracks. This resolves the chosen pattern voices
 * against the EXTERNAL device's `voice_map` (so "kick" → the SPD-SX's kick pad
 * note) but pins the CHANNEL to the host's outward MIDI-track channel
 * (`capabilities.external_tracks`, e.g. the Circuit's `{midi1:3, midi2:4}`).
 *
 * Each voice resolves to a LIST of destinations (see `CompileOptions.overrides`):
 *   - external-only (default): `[external]` — the voice plays ONLY on the device.
 *   - also_internal: `[internal, external]` — the same beat on the host's own
 *     track AND the external device. No synthetic voice cloning; the compiler
 *     emits the step once per destination.
 *
 * Honesty: explicit `voices` are validated against BOTH the pattern and the
 * device map, so a voice that would send nothing is a typed error, never a
 * silent no-op with a "Routed X" hint that lies.
 */

import { PatternError, describeFold, foldVoice, indexMapByRole, type FoldDecision } from '../patterns/index.js';
import type { VoiceTarget } from '../types.js';

/** How one externally-routed voice resolved (for the piece-compression report). */
export interface ExternalVoiceResolution {
  /** The external device's display name. */
  device: string;
  /** The external voice_map key the voice landed on. */
  map_key: string;
  /** The final AUTHORED note (incl. pin + note_offset) — the physical pad identity. */
  note: number;
  /** The fold that got it there, when it wasn't a direct entry. */
  fold?: FoldDecision;
}
import { trackForDevice } from '../rigLinks.js';
import { requireDevice } from './core.js';

/** One external-instrument routing for `apply_pattern external_targets`. */
export interface ExternalTarget {
  /** External device port (id or name), e.g. "spd-sx". */
  device: string;
  /** Host outward MIDI track ("midi1"/"midi2"). Defaults from the rig links. */
  track?: string;
  /** Voices to route externally. Defaults to every pattern voice the device maps. */
  voices?: string[];
  /**
   * Whether the routed voices ALSO keep playing the host's own internal sounds.
   * Default false: "put the beat on MIDI 2" routes those voices ONLY to the
   * external device. Set true to play them on the host's internal tracks (the
   * Circuit's own drums) AND the external device — "on the drum tracks AND MIDI 2".
   */
  also_internal?: boolean;
  /**
   * Semitone shift added to every externally-routed note (clamped 0..127).
   * Compensates a host that transmits MIDI-track notes at a different octave
   * than the authored value. The Novation Circuit Tracks transmits MIDI-track
   * notes ONE OCTAVE BELOW the stored note (confirmed 2026-06-28 by USB capture:
   * an authored note 60 left the device as wire note 48). So to land on the
   * external device's pad note, pass `note_offset: 12`. Default 0 (no shift) —
   * a host/template without that quirk needs none.
   */
  note_offset?: number;
  /**
   * Per-voice PAD PINNING: route a voice to an explicit note on the external
   * device, bypassing its voice_map AND the fold layer. The idle-pad recovery
   * move: a dense groove whose busy_hat would fold onto the hat pad plays a
   * kit whose clap pad is idle — load a hat sample there and pin
   * `{"busy_hat": 39}` so the piece keeps its own pad. `note_offset` still
   * applies (the pin is the AUTHORED note). The pinned voice must exist in
   * the pattern; it does not need a voice_map entry.
   */
  voice_notes?: Record<string, number>;
}

const sameTarget = (a: VoiceTarget, b: VoiceTarget): boolean => a.channel === b.channel && a.note === b.note;
const clampNote = (n: number): number => Math.max(0, Math.min(127, n));

/**
 * Build the per-voice destination lists for `external_targets`. Returns the
 * override map (voice → [destinations]) the compiler consumes, plus human hints.
 * Throws a typed PatternError on any misconfiguration (no silent drop).
 */
export function buildExternalOverrides(
  targets: readonly ExternalTarget[],
  hostCaps: { external_tracks?: Readonly<Record<string, number>>; voice_map?: Readonly<Record<string, VoiceTarget>> },
  patternVoices: readonly string[],
): { overrides: Record<string, VoiceTarget[]>; hints: string[]; resolutions: Record<string, ExternalVoiceResolution> } {
  const tracks = hostCaps.external_tracks;
  if (tracks === undefined || Object.keys(tracks).length === 0) {
    throw new PatternError(
      'not_a_pattern_target',
      'This device has no outward MIDI tracks, so external_targets cannot route to it. ' +
      'external_targets is for a host sequencer (Circuit Tracks) whose MIDI 1/2 tracks drive external gear.',
    );
  }
  const overrides: Record<string, VoiceTarget[]> = {};
  const hints: string[] = [];
  const resolutions: Record<string, ExternalVoiceResolution> = {};
  const hostRoleIndex = indexMapByRole(Object.keys(hostCaps.voice_map ?? {}));
  for (const t of targets) {
    const track = (t.track ?? trackForDevice(t.device))?.toLowerCase();
    if (track === undefined) {
      throw new PatternError(
        'bad_grid',
        `external_targets: no track for device "${t.device}". Pass track ("${Object.keys(tracks).join('"/"')}") ` +
        'or set MCP_RIG_LINKS so the device\'s wiring is known.',
        { device: t.device, available_tracks: Object.keys(tracks) },
      );
    }
    const channel = tracks[track];
    if (channel === undefined) {
      throw new PatternError(
        'bad_grid',
        `external_targets: unknown host track "${track}". Available: ${Object.keys(tracks).join(', ')}.`,
        { track, available_tracks: Object.keys(tracks) },
      );
    }
    const extDescriptor = requireDevice(t.device);
    const extMap = extDescriptor.capabilities.voice_map;
    if (extMap === undefined) {
      throw new PatternError(
        'not_a_pattern_target',
        `external_targets: ${extDescriptor.display_name} has no voice_map, so its pads can't be addressed by role.`,
        { device: t.device },
      );
    }
    // Honesty gate (M1): an explicit voice must exist in the PATTERN too, else it
    // would send nothing while the hint claims it was routed.
    if (t.voices) {
      const missing = t.voices.filter((v) => !patternVoices.includes(v));
      if (missing.length > 0) {
        throw new PatternError(
          'unmapped_voice',
          `external_targets: voice(s) ${missing.join(', ')} are not in the pattern (its voices: ${patternVoices.join(', ') || '(none)'}), ` +
          'so routing them would send nothing. Remove them or fix the pattern.',
          { missing, pattern_voices: patternVoices },
        );
      }
    }
    // Per-voice pad pins (idle-pad recovery) validate before anything routes.
    const pins = t.voice_notes ?? {};
    for (const [v, n] of Object.entries(pins)) {
      if (!Number.isInteger(n) || n < 0 || n > 127) {
        throw new PatternError('bad_grid', `external_targets: voice_notes.${v} must be a MIDI note 0..127, got ${n}.`, { voice: v, note: n });
      }
      if (!patternVoices.includes(v)) {
        throw new PatternError(
          'unmapped_voice',
          `external_targets: voice_notes pins "${v}", which is not in the pattern (its voices: ${patternVoices.join(', ') || '(none)'}).`,
          { voice: v, pattern_voices: patternVoices },
        );
      }
    }
    // Default routing includes voices the device places directly, drum voices
    // the fold layer can substitute (china→its crash pad; folds warn), AND
    // pinned voices (which need no voice_map entry at all).
    const extRoleIndex = indexMapByRole(Object.keys(extMap));
    const resolveExt = (v: string): { entry: VoiceTarget; key: string; fold?: FoldDecision } | undefined => {
      const pin = pins[v];
      if (pin !== undefined) return { entry: { channel: 0, note: pin }, key: `note ${pin} (pinned)` };
      const direct = extMap[v];
      if (direct !== undefined) return { entry: direct, key: v };
      const fold = foldVoice(v, extRoleIndex);
      if (fold === undefined) return undefined;
      return { entry: extMap[fold.map_key], key: fold.map_key, fold };
    };
    // Explicit `voices` UNIONS with the pin keys: a validated pin must never be
    // silently dropped just because the caller also narrowed `voices` (the
    // silent-no-op this file's honesty rule forbids).
    const voices = t.voices
      ? [...new Set([...t.voices, ...Object.keys(pins)])]
      : patternVoices.filter((v) => resolveExt(v) !== undefined);
    if (voices.length === 0) {
      throw new PatternError(
        'unmapped_voice',
        `external_targets: none of the pattern's voices (${patternVoices.join(', ') || '(none)'}) map on ${extDescriptor.display_name} ` +
        `(directly or via a drum-role substitute). Its voices: ${Object.keys(extMap).join(', ')}.`,
        { available: Object.keys(extMap) },
      );
    }
    for (const v of voices) {
      const resolvedExt = resolveExt(v);
      if (resolvedExt === undefined) {
        throw new PatternError(
          'unmapped_voice',
          `external_targets: ${extDescriptor.display_name} has no voice_map entry (or drum-role substitute) for "${v}". Available: ${Object.keys(extMap).join(', ')}.`,
          { voice: v, available: Object.keys(extMap) },
        );
      }
      const { entry, key, fold } = resolvedExt;
      const finalNote = clampNote(entry.note + (t.note_offset ?? 0));
      resolutions[v] = { device: extDescriptor.display_name, map_key: key, note: finalNote, ...(fold ? { fold } : {}) };
      const ext: VoiceTarget = { channel, note: clampNote(entry.note + (t.note_offset ?? 0)) };
      const arr = overrides[v] ?? [];
      // also_internal: include the host's own destination once (so the voice also
      // plays the Circuit's internal sound). If the host can't place this voice,
      // say so rather than silently giving the same "external-only" result.
      if (t.also_internal) {
        let internal = hostCaps.voice_map?.[v];
        if (!internal && hostCaps.voice_map) {
          const fold = foldVoice(v, hostRoleIndex);
          if (fold) { internal = hostCaps.voice_map[fold.map_key]; hints.push(`host: ${describeFold(fold)}`); }
        }
        if (internal && !arr.some((x) => sameTarget(x, internal))) arr.push(internal);
        else if (!internal) hints.push(`note: "${v}" has no internal sound on the host (even via a drum-role substitute), so also_internal routed it external only.`);
      }
      if (!arr.some((x) => sameTarget(x, ext))) arr.push(ext);
      overrides[v] = arr;
    }
    const off = t.note_offset ?? 0;
    hints.push(
      `Routed ${voices.join(', ')} to ${extDescriptor.display_name} via the host's ${track} track` +
      `${t.also_internal ? ' AND the host\'s internal tracks (both at once)' : ' (external only)'}` +
      `${off !== 0 ? ` with a ${off > 0 ? '+' : ''}${off}-semitone note shift` : ''}. ` +
      `VERIFY the host actually transmits ${track} on ch${channel} and at the authored octave — the Circuit ` +
      `Tracks can transmit MIDI-track notes an octave LOW (pass note_offset:12) and its MIDI-2 channel is a ` +
      `project/Setup-View setting, not ch${channel} by assumption. Confirm with \`npm run capture-midi -- <host>\` ` +
      `(reads the exact channel + note), then set ${extDescriptor.display_name} to receive on that channel; ` +
      'its pad notes must match its voice_map.',
    );
  }
  return { overrides, hints, resolutions };
}
