/**
 * Compile a NeutralPattern into a device-agnostic RealizePlan: a flat,
 * voice_map-resolved, time-stamped note-event list a realizer can stream
 * without knowing the pattern grammar.
 *
 * Timing assumes 4/4: `stepMs = (60000 / bpm) * (BEATS_PER_BAR / steps)`.
 * Worked golden: four-on-the-floor (16 steps) @120 BPM ⇒ stepMs = 125 ⇒
 * kick (steps 0,4,8,12) at 0/500/1000/1500 ms (≡ 0/24/48/72 ticks @24 PPQN).
 */

import type {
  DeviceCapabilities,
  RealizeNoteEvent,
  RealizePlan,
  RealizerMode,
  VoiceTarget,
} from '../types.js';
import type { NeutralPattern } from './types.js';
import {
  GATE_SIXTHS_PER_STEP,
  MAX_GATE_SIXTHS,
  MIN_GATE_SIXTHS,
  PatternError,
} from './types.js';
import { resolvePatternVoices } from './voiceMap.js';

const BEATS_PER_BAR = 4;
const DEFAULT_HIT_VELOCITY = 100;
const DEFAULT_ACCENT_VELOCITY = 120;

export interface CompileOptions {
  bpm: number;
  mode: RealizerMode;
  /** Loop count over the whole pattern. Default 1. Capped by the tool layer. */
  repeat?: number;
  /** Realize-time arm flag for record_capture (forwarded to the plan). */
  armed?: boolean;
  /**
   * ncs_upload only: template project + target slot + optional scale + per-step
   * sample flips (by slot AND by role) + drum-track sample binding + stored drum
   * levels + overwrite gate + dry_run. Forwarded to the plan verbatim, so it
   * takes the plan's own shape rather than a second copy that can drift.
   */
  upload?: NonNullable<RealizePlan['upload']>;
  /**
   * Semitone transpose applied to AUTHORED pitches only (`Step.notes`), so the
   * C-based library recipes play in any key. Drum triggers and un-pitched hits
   * (which take the voice_map note) are deliberately left untouched — shifting
   * them would re-route a drum pad. Default 0.
   */
  transpose?: number;
  /**
   * Per-voice target overrides that BYPASS the target `caps.voice_map`. Used for
   * external-instrument routing (`apply_pattern external_targets`): a voice in
   * this map resolves to the given list of `{channel, note}` destinations instead
   * of its host voice_map entry, and the step is emitted ONCE PER destination. So
   * external-only routing is `[external]` (the voice plays only on the external
   * device) and "both at once" is `[internal, external]` (the same beat on the
   * host's own track AND the external device) — no synthetic voice cloning needed.
   * Voices NOT in this map resolve against `caps` as usual. Absent = no overrides.
   */
  overrides?: Readonly<Record<string, readonly VoiceTarget[]>>;
}

/**
 * Compile to a plan. `caps` supplies the target's `voice_map`; voices that
 * the target can't place raise a typed PatternError (no silent drop).
 */
export function compileToPlan(
  pattern: NeutralPattern,
  caps: DeviceCapabilities,
  opts: CompileOptions,
): RealizePlan {
  if (!Number.isFinite(opts.bpm) || opts.bpm <= 0) {
    throw new PatternError('bad_grid', `BPM must be positive, got ${opts.bpm}.`);
  }
  const steps = pattern.steps;
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new PatternError('bad_grid', `Pattern "${pattern.name}" has a bad step count: ${steps}.`);
  }
  const bars = pattern.bars ?? 1;
  // Multi-bar timing is phase-C (the grid is one bar today). Fail loudly
  // rather than silently realize only the first bar.
  if (bars !== 1) {
    throw new PatternError('bad_grid', `Multi-bar patterns are phase-C; bars must be 1, got ${bars}.`, { bars });
  }
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));

  // Voices routed to an external instrument bypass the host voice_map; the rest
  // resolve against `caps` as usual. Resolve only the non-overridden voices (and
  // only when there are any — an all-overridden pattern must not trip the
  // no-voice_map gate); each voice maps to a LIST of destinations (external-only
  // = one, "both at once" = internal + external), and the step is emitted per
  // destination.
  const overrides = opts.overrides ?? {};
  const baseVoices = Object.fromEntries(
    Object.entries(pattern.voices).filter(([v]) => !(v in overrides)),
  );
  const resolvedBase = Object.keys(baseVoices).length > 0
    ? resolvePatternVoices({ ...pattern, voices: baseVoices }, caps)
    : {};
  const resolved: Record<string, readonly VoiceTarget[]> = {};
  for (const v of Object.keys(pattern.voices)) {
    resolved[v] = v in overrides ? overrides[v] : [resolvedBase[v]];
  }
  const stepMs = (60000 / opts.bpm) * (BEATS_PER_BAR / steps);
  const transpose = opts.transpose ?? 0;

  const events: RealizeNoteEvent[] = [];
  for (const [voice, voiceData] of Object.entries(pattern.voices)) {
    const targets = resolved[voice];
    const row = voiceData.steps;
    for (let i = 0; i < row.length; i++) {
      const step = row[i];
      if (!step.on) continue;
      const velocity = step.velocity ?? (step.accent ? DEFAULT_ACCENT_VELOCITY : DEFAULT_HIT_VELOCITY);
      const time_ms = Math.round(i * stepMs);
      // Note LENGTH. A step that states one gets EXACTLY that length; a step
      // that doesn't gets the historical one-step-minus-10% gate: long enough
      // to sound, short enough not to overhang the next hit. The 10% shave is
      // deliberately NOT applied to a stated length: it is the right hedge when
      // we picked the length ourselves, and an audible stutter in the middle of
      // a tied 16-step drone when the caller asked for the full hold.
      const gate = step.gate_sixths;
      if (gate !== undefined
        && (!Number.isInteger(gate) || gate < MIN_GATE_SIXTHS || gate > MAX_GATE_SIXTHS)) {
        throw new PatternError(
          'bad_grid',
          `Voice '${voice}' step ${i + 1}: gate_sixths must be a whole number of sixths of a step, ` +
          `${MIN_GATE_SIXTHS}..${MAX_GATE_SIXTHS} (${GATE_SIXTHS_PER_STEP} = one step, ${MAX_GATE_SIXTHS} = sixteen), got ${gate}.`,
          { voice, step: i, gate_sixths: gate },
        );
      }
      if (step.tie !== undefined && typeof step.tie !== 'boolean') {
        throw new PatternError('bad_grid', `Voice '${voice}' step ${i + 1}: tie must be a boolean.`, { voice, step: i });
      }
      const duration_ms = gate !== undefined
        ? Math.max(20, Math.round((stepMs * gate) / GATE_SIXTHS_PER_STEP))
        : Math.max(20, Math.round(stepMs * 0.9));
      // A pitched step carries its own note(s) — a chord emits one event per
      // note at the same instant (so both live_stream and the .ncs author see a
      // chord), and `transpose` shifts those authored pitches. An un-pitched
      // (drum / default) step uses the destination's note and is NOT transposed.
      const pitched = step.notes !== undefined
        ? (Array.isArray(step.notes) ? step.notes : [step.notes]).map((n) => {
          const t = n + transpose;
          if (t < 0 || t > 127) {
            throw new PatternError(
              'bad_grid',
              `Transposing note ${n} by ${transpose} leaves the MIDI range 0..127 (got ${t}). Pick a smaller transpose or a closer key.`,
              { note: n, transpose, result: t },
            );
          }
          return t;
        })
        : undefined;
      // Micro-step roll (drum hits): carry the count onto the event so the NCS
      // author can write the Circuit's micro-hit mask and live realizers can
      // expand it. Only meaningful on un-pitched (drum) steps; a melodic step
      // never sets `roll`, so this stays absent there.
      const micro_hits = step.roll !== undefined && step.roll > 1 ? step.roll : undefined;
      // Micro-tick PLACEMENT: a step carrying explicit micro onsets emits one
      // event per onset (like a chord emits one per note), each at its TRUE
      // time (step + micro/6) with the tick on `micro` so the .ncs author can
      // write the per-slot delay without re-deriving it from time_ms. Absent ⇒
      // one on-grid hit (micro stays off the event: identity for old patterns).
      const micros: readonly number[] = step.micro ?? [0];
      // Emit the hit once per destination (external-only = 1; both = internal + external).
      for (const target of targets) {
        const notes = pitched ?? [target.note];
        for (const note of notes) {
          for (const micro of micros) {
            events.push({
              channel: target.channel, note, velocity,
              time_ms: micro > 0 ? Math.round((i + micro / 6) * stepMs) : time_ms,
              duration_ms,
              ...(micro_hits !== undefined ? { micro_hits } : {}),
              ...(micro > 0 ? { micro } : {}),
              // Carried verbatim (not re-derived from duration_ms): a stored
              // sequencer's gate field is a magnitude in sixths of a step, and
              // going back through milliseconds would need the BPM and lose the
              // exact value the caller asked for.
              ...(gate !== undefined ? { gate_sixths: gate } : {}),
              ...(step.tie ? { tie: true } : {}),
            });
          }
        }
      }
    }
  }
  events.sort((a, b) => a.time_ms - b.time_ms);

  return {
    pattern_name: pattern.name,
    bpm: opts.bpm,
    steps,
    bars,
    repeat,
    mode: opts.mode,
    events,
    cycle_ms: Math.round(stepMs * steps),
    ...(opts.armed !== undefined ? { armed: opts.armed } : {}),
    ...(opts.upload !== undefined ? { upload: opts.upload } : {}),
  };
}
