/**
 * Score → step-grid core for the Guitar Pro / MusicXML drum importer.
 *
 * This is the FORMAT-AGNOSTIC half of that importer (see
 * docs/design/guitar-pro-import.md): given timed drum events (already decoded
 * from a `.gp`/`.musicxml` file by a front-end), map General-MIDI percussion to
 * our neutral voices and QUANTIZE onsets onto a fixed step grid, producing the
 * same `{ voices, steps }` shape the ASCII-tab parser does — so everything
 * downstream (apply_pattern → the Circuit author → upload) is reused unchanged.
 *
 * Deliberately dependency-free and pure: the file-reading front-end (a ZIP +
 * XML reader for `.gp`/`.mxl`) is a separate, dependency-bearing layer. Building
 * this core first de-risks the hardest part (quantization + drum mapping) and is
 * fully unit-testable with synthetic events.
 */

import type { Step } from './types.js';

/**
 * General MIDI percussion note → neutral voice name (the same legend the ASCII
 * tab parser maps labels to). Full GM 35-81 coverage. A drum the target's
 * voice_map can't place (crash/ride/tom on the Circuit's 4 pads, congas
 * anywhere) still resolves to a voice here; at realize time the fold layer
 * (drumFold.ts) substitutes the nearest musical-function piece the target owns
 * and WARNS — a voice with no substitute errors honestly, never a silent drop.
 */
export const GM_DRUM_TO_VOICE: Readonly<Record<number, string>> = {
  35: 'kick', 36: 'kick',                 // bass drums
  37: 'perc',                              // side stick / cross-stick
  38: 'snare', 40: 'snare',                // snares
  39: 'clap',                              // hand clap
  41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', // toms
  42: 'hat', 44: 'hat',                    // closed / pedal hi-hat
  46: 'openhat',                           // open hi-hat
  49: 'crash', 57: 'crash', 52: 'crash', 55: 'crash', // crash / china / splash
  51: 'ride', 59: 'ride', 53: 'ride',      // ride / ride bell
  54: 'perc', 56: 'perc', 58: 'perc',      // tambourine / cowbell / vibraslap
  // GM 60-81 latin/aux percussion — FINE roles; a target that lacks them
  // folds to the nearest substitute at resolve time (drumFold.ts), warned.
  60: 'bongo', 61: 'bongo',                // hi / low bongo
  62: 'conga', 63: 'conga', 64: 'conga',   // mute hi / open hi / low conga
  65: 'timbale', 66: 'timbale',
  67: 'agogo', 68: 'agogo',
  69: 'cabasa', 70: 'maracas',
  71: 'whistle', 72: 'whistle',            // short / long whistle
  73: 'guiro', 74: 'guiro',                // short / long guiro
  75: 'claves',
  76: 'woodblock', 77: 'woodblock',        // hi / low wood block
  78: 'cuica', 79: 'cuica',                // mute / open cuica
  80: 'triangle', 81: 'triangle',          // mute / open triangle
};

/** Map a GM percussion note to a neutral voice (undefined = unknown, caller decides). */
export function gmDrumToVoice(note: number): string | undefined {
  return GM_DRUM_TO_VOICE[note];
}

/**
 * Velocity a GHOST (soft) hit sounds at when nothing more specific is given.
 *
 * A ghost note is PLAYED, quietly; it is never dropped. 40 is not arbitrary: it
 * is what the ASCII-tab `g` glyph already emits (`drumTab.ts`) and the threshold
 * the SMF front-end already reads back as a ghost (`midiFile.ts`, velocity <= 40),
 * so all three importers agree on one number. Against the compiler's ladder
 * (`compile.ts`: plain hit 100, accent 120) it lands at 40% of a normal hit:
 * clearly present, clearly under the backbeat.
 */
export const GHOST_HIT_VELOCITY = 40;

/** One timed drum hit decoded from a score, BEFORE quantization. */
export interface DrumEvent {
  /** Neutral voice name (kick/snare/hat/openhat/crash/ride/tom/perc/clap). */
  voice: string;
  /** Onset in BEATS from the section start (0-based). A triplet 8th = e.g. 0.333. */
  beat: number;
  accent?: boolean;
  ghost?: boolean;
  /**
   * Explicit MIDI velocity 1..127, when the source carries a dynamic finer than
   * the accent/ghost pair can express (a `p` or `mp` marking is softer than a
   * plain hit but louder than a ghost). Wins over both flags at quantize time;
   * omit it and the flags decide, which keeps a flag-only source unchanged.
   */
  velocity?: number;
  /** Micro roll: 2..6 evenly-spaced sub-hits (6 = buzz; positional mask HW-confirmed 2026-07-03). */
  roll?: number;
}

export interface QuantizeOptions {
  /** Total beats in the section (e.g. 4 = one 4/4 bar; 8 = two bars). */
  beats: number;
  /** Grid resolution: steps per beat. 4 = 16th-note grid (default); 8 = 32nd. */
  stepsPerBeat?: number;
}

export interface QuantizedDrums {
  voices: Record<string, Step[]>;
  steps: number;
  /** Non-fatal: rounded triplets/32nds, collisions, out-of-window drops. */
  warnings: string[];
}

const ONSET_TOLERANCE = 0.02; // beats; onsets within this of a grid line are "on-grid"
const MICROS_PER_STEP = 6;    // the Circuit subdivides every step into 6 micro-ticks

/**
 * Quantize decoded drum events onto a fixed step grid. On-grid onsets land as
 * plain hits (identity: no `micro` field). Off-grid onsets (32nds, triplets,
 * swung hits) are PLACED, not rounded: the hit keeps its position inside the
 * step as a micro-tick 0..5 (`Step.micro`), which note-track realization plays
 * as real wire micro-timing (B0-confirmed 2026-07-02; internal Circuit drum
 * tracks still round pending the Front-A mask capture). Several same-voice
 * onsets inside ONE step (a 16th + its 32nd "and", a triplet pair) union their
 * micro lists into the cell. Only two hits on the SAME micro-tick collide;
 * the LOUDEST wins (accent > plain > ghost — order of arrival is not musical
 * priority) and it warns. A buzz roll (roll 6) survives any merge (it is
 * content, not dynamics).
 */
export function quantizeDrumEvents(events: readonly DrumEvent[], opts: QuantizeOptions): QuantizedDrums {
  const spb = opts.stepsPerBeat ?? 4;
  if (!Number.isFinite(opts.beats) || opts.beats <= 0) {
    throw new RangeError(`beats must be positive, got ${opts.beats}`);
  }
  const steps = Math.max(1, Math.round(opts.beats * spb));
  const voices: Record<string, Step[]> = {};
  const warnings: string[] = [];
  const placed = new Set<string>();
  let dropped = 0;
  let collisions = 0;

  for (const e of events) {
    const exact = e.beat * spb;
    // On-grid (within tolerance of a step line) → that step, micro 0, no
    // `micro` field (identity invariant: pre-placement patterns are unchanged).
    // Off-grid → the containing step + the nearest of its 6 micro-ticks; a
    // fractional position that rounds past tick 5 carries into the next step.
    let step = Math.round(exact);
    let micro = 0;
    if (Math.abs(exact - step) > ONSET_TOLERANCE * spb) {
      placed.add(e.beat.toFixed(3));
      step = Math.floor(exact);
      micro = Math.round((exact - step) * MICROS_PER_STEP);
      if (micro >= MICROS_PER_STEP) { step += 1; micro = 0; }
    }
    if (step < 0 || step >= steps) { dropped++; continue; }
    if (!voices[e.voice]) voices[e.voice] = Array.from({ length: steps }, () => ({ on: false } as Step));
    const cell: Step = { on: true };
    if (e.accent) cell.accent = true;
    // An explicit velocity wins over the coarse flags: it is how a source's full
    // dynamic ladder (p / mp / mf, not just accent-plain-ghost) reaches the cell.
    if (e.velocity !== undefined) cell.velocity = Math.max(1, Math.min(127, Math.round(e.velocity)));
    else if (e.ghost) cell.velocity = GHOST_HIT_VELOCITY;
    // Rolls survive at their count (2..6 = evenly-spaced sub-hits; the drum
    // micro-mask is positional-confirmed, so partial rolls are authorable).
    if (e.roll !== undefined && e.roll > 1) cell.roll = Math.min(6, e.roll);
    if (micro > 0) cell.micro = [micro];
    const existing = voices[e.voice][step];
    if (existing.on) {
      const exMicros = existing.micro ?? [0];
      const newMicro = micro;
      const loudness = (c: Step): number => c.velocity ?? (c.accent ? 120 : 100);
      const mergedRoll = Math.max(cell.roll ?? 1, existing.roll ?? 1);
      if (exMicros.includes(newMicro)) {
        // True collision: two hits on the SAME micro-tick. Keep the loudest.
        collisions++;
        const winner = loudness(cell) > loudness(existing) ? cell : existing;
        if (mergedRoll > 1) winner.roll = mergedRoll; // a roll survives the merge either way
        // The winner keeps the cell's full onset set, whichever hit won.
        if (exMicros.length > 1 || exMicros[0] !== 0) winner.micro = exMicros;
        else delete winner.micro;
        voices[e.voice][step] = winner;
        continue;
      }
      // Distinct micro-ticks: DIFFERENT onsets sharing the cell — union them.
      // The cell's dynamics follow its loudest onset (one velocity per cell).
      const merged = loudness(cell) > loudness(existing) ? cell : existing;
      merged.micro = [...exMicros, newMicro].sort((a, b) => a - b);
      if (mergedRoll > 1) merged.roll = mergedRoll;
      voices[e.voice][step] = merged;
      continue;
    }
    voices[e.voice][step] = cell;
  }

  const gridName = spb === 4 ? '16th' : spb === 8 ? '32nd' : `1/${spb}-beat`;
  if (placed.size > 0) {
    warnings.push(
      `${placed.size} off-grid onset(s) (triplets / 32nds / swing) placed on micro-ticks within their ${gridName} step ` +
      `(true micro-timing on every route: note-track/external delay is B0-wire-confirmed, the internal drum micro-mask is positional-confirmed).`,
    );
  }
  if (collisions > 0) {
    // At a fine grid (32nd+), "raise stepsPerBeat" is wrong advice: it would
    // exceed the Circuit's 32-step ceiling AND can't separate sub-grid bursts
    // (64ths, micro-rolls) that physically stack inside one step.
    const advice = spb >= 8
      ? `These are a roll/burst denser than any device step can place: author a buzz roll (roll 6) or trigger a baked roll SAMPLE instead.`
      : `Raise stepsPerBeat (e.g. 8) or split the section; if hits still stack, it is a roll, so use a buzz roll or a roll sample.`;
    warnings.push(`${collisions} same-voice hit(s) collided on a step; kept the loudest. ${advice}`);
  }
  if (dropped > 0) warnings.push(`${dropped} event(s) fell outside the ${steps}-step window and were dropped.`);
  return { voices, steps, warnings };
}
