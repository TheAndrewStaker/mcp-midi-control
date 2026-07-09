/**
 * Device-neutral pattern model.
 *
 * A pattern is a step grid of abstract VOICES (`kick`/`snare`/`hat`/
 * `bass`/…). It deliberately carries NO device vocabulary, where a voice
 * fires (channel + note) is owned by the TARGET device's
 * `capabilities.voice_map`, resolved at realize time (see `voiceMap.ts`).
 * That separation is what lets one "four on the floor" drive a Circuit
 * Tracks, an SPD-SX, or any future groovebox unchanged.
 *
 * The internal truth is `Step[]` (not the char-grid authoring form), so
 * velocity / accent / probability are first-class from day one, the
 * phase-C `.ncs` compiler needs them and so does live-stream velocity.
 * Char grids ("x...x...") and mini-notation ("bd ~ ~ ~") are authoring
 * surfaces that both compile DOWN to `Step[]` (see `miniNotation.ts`).
 */

/** One grid cell of one voice. */
export interface Step {
  /** True = a hit fires on this step; false = rest. */
  on: boolean;
  /** 1..127 explicit velocity. Omitted ⇒ realize-time default (accent table). */
  velocity?: number;
  /** Accent flag (notation `X`). Bumps the default velocity when `velocity` is unset. */
  accent?: boolean;
  /** 0..1 trigger probability. Phase-C (.ncs); live realizers treat absent/≥1 as always-on. */
  probability?: number;
  /**
   * Micro-step ROLL: n = that many EVENLY-SPACED sub-hits within the step
   * (1/absent = a single plain hit, 6 = the full "buzz" — the trap hi-hat /
   * drum-roll feature). The whole 1..6 range is authorable: the Circuit drum
   * micro-hit mask is POSITIONAL and additive (HW-confirmed 2026-07-03 by the
   * on-device diff capture — see docs/design/circuit-microstep-placement.md),
   * so a partial roll fans to spaced ticks, never a front-loaded burst. Drum
   * voices realize it as the mask; note-track / external routing fans the same
   * spacing via per-slot delay. Authored with char-grid digits '1'..'6'
   * (`"x.x.x.x.6."`).
   */
  roll?: number;
  /**
   * Micro-tick PLACEMENT: the step's real onsets, in micro-ticks 0..5 (the
   * Circuit subdivides every step into six). `[0]` = one on-grid hit (same as
   * absent); an off-beat 32nd = `[3]`; a 16th + its 32nd "and" sharing the
   * cell = `[0, 3]`; the two triplet offsets inside a step = `[2, 4]`. Sorted,
   * unique. Distinct from `roll` (a buzz that FILLS the step): `micro` places
   * individual real onsets. B0-hardware-confirmed (2026-07-02): the Circuit's
   * MIDI-OUT transmits the note-track per-slot delay as true wire micro-timing
   * (measured 61.5ms vs 62.6ms predicted for delay 3 @120bpm), so placement
   * reaches external gear (SPD-SX). Internal Circuit DRUM tracks place them
   * too, as the positional micro-hit mask (bit k = tick k, HW-confirmed
   * 2026-07-03) — placement is now lossless on every route.
   */
  micro?: readonly number[];
  /**
   * Melodic pitch(es) this step plays: a single MIDI note or a chord (the
   * target caps the chord width — the Circuit note tracks hold up to 6).
   * Overrides the voice's `note_hint` / voice_map note for THIS step.
   * Absent ⇒ the voice's default note: drum voices and un-pitched rhythmic
   * hits (`x...x...`) leave it unset. Authored with note tokens
   * (`"c2"`, `"eb3"`, `"c3+eb3+g3"`) via the mini-notation parser, so a
   * bassline/lead/chord voice is one speakable string per voice row.
   */
  notes?: number | readonly number[];
}

/**
 * Abstract voice name. Open string (devices/genres add voices), but the
 * common drum + melodic set is documented for the LLM and the library.
 */
export type VoiceName =
  | 'kick' | 'snare' | 'hat' | 'openhat' | 'clap' | 'tom' | 'perc' | 'ride' | 'crash'
  | 'bass' | 'lead' | 'chord' | 'arp'
  | string;

/** One voice's full step row, plus an optional default melodic pitch. */
export interface Voice {
  steps: readonly Step[];
  /**
   * Melodic voices (bass/lead) may carry the note they play; drum voices
   * leave it unset and take their note from the target's `voice_map`.
   * When set, it overrides the voice_map note for this pattern.
   */
  note_hint?: number;
}

/** A complete, device-neutral pattern. */
export interface NeutralPattern {
  name: string;
  /** Grid resolution for one bar (8 / 16 / 32 …). Every `voices[].steps` has this length. */
  steps: number;
  /** Bars in the loop. Default 1. Multi-bar authoring is phase-C; phase 1 expects 1. */
  bars?: number;
  voices: Readonly<Record<string, Voice>>;
  /**
   * Advisory GM-ish default note per voice, documentation / authoring aid
   * only. Realize-time resolution uses the TARGET's `voice_map`, never this
   * (so device vocabulary stays out of resolution). Optional.
   */
  voice_hints?: Readonly<Record<string, number>>;
  tags?: readonly string[];
  description?: string;
}

/** Typed failure surface for the pattern module (mirrors RecipeMaterializeError). */
export class PatternError extends Error {
  readonly code:
    | 'unknown_pattern'
    | 'parse_error'
    | 'bad_grid'
    | 'unmapped_voice'
    | 'not_a_pattern_target'
    | 'realizer_not_supported'
    | 'not_implemented';
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(
    code: PatternError['code'],
    message: string,
    detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PatternError';
    this.code = code;
    this.detail = detail;
  }
}
