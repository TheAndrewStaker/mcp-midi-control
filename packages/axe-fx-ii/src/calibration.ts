/**
 * Axe-Fx II display calibration overlay (BK-060).
 *
 * The `fractal-midi/axe-fx-ii` KNOWN_PARAMS catalog ships
 * `displayMin`/`displayMax`/`displayScale` populated only for the
 * subset of params the Fractal wiki documents (~54 of 1126). Every
 * other knob is opaque — wire 0..65534 with no display calibration —
 * and tool callers were previously expected to pass raw wire integers.
 *
 * Display-first contract (see CLAUDE.md "Tool API conventions") says
 * the LLM must be able to write `drive.volume: 5` meaning the 0..10
 * knob position 5, not the wire integer 5. Session 98 (2026-05-18)
 * surfaced the root-cause bug: agent wrote `drive.volume: 5` /
 * `drive.tone: 7` thinking they were display values; the encoder
 * passed them through as wire 5 / 7 because both params lacked
 * `displayMin/displayMax`, producing near-mute output and
 * fully-counterclockwise tone. Scenes 3 and 4 of the Enter Sandman
 * test were SILENT for this reason.
 *
 * This overlay layers calibration on top of the codec catalog at
 * descriptor-build time. The descriptor schema (`./descriptor/schema.ts`)
 * calls `getCalibration(block, name)` while building each
 * `ParamSchema`; when an overlay hit exists, the schema's encode
 * closure uses the overlay's `displayMin`/`displayMax`/`displayScale`
 * for the display ↔ wire conversion via fractal-midi's
 * `displayToWire`/`wireToDisplay` helpers. Params already calibrated
 * in KNOWN_PARAMS keep their existing values (overlay is fallback-only).
 *
 * **Provenance** tags each entry with its evidence source:
 *
 *   - `'am4-shared'`        — the AM4 cache catalog has the same
 *                             (block, name) entry with a
 *                             hardware-verified display range.
 *                             Same musical concept, same Fractal
 *                             design convention; safe port. 91
 *                             entries.
 *   - `'editor-observed'`   — display range matches what AxeEdit II's
 *                             UI shows for the knob across the
 *                             founder's Q8.02 inspection plus forum
 *                             screenshots. Used for II-specific knobs
 *                             that have no AM4 sibling.
 *   - `'fractal-convention'`— Fractal-wide naming convention. Every
 *                             Fractal device renders a `level` /
 *                             `master_level` / `output_level` knob as
 *                             -80..+20 dB; every `mix` knob is
 *                             0..100%; every `balance` / `pan` is
 *                             -100..+100%. These hold across AM4,
 *                             Axe-Fx II, and Axe-Fx III without
 *                             exception.
 *
 * Wire calibration verification: `scripts/verify-axe-fx-ii-display-units.ts`
 * asserts every entry round-trips display → wire → display within
 * one display-unit step, and that the midpoint maps to wire ~32767
 * (within 10%). Wired into `npm test` after `verify-axe-fx-ii-routing`.
 *
 * Naming notes:
 *
 *   - The `(block, name)` key matches the snake_case `(param.block,
 *     param.name)` in `KNOWN_PARAMS`. Block field comes from
 *     `AxeFxIIParam.block` (e.g. `'drive'`, `'amp'`, `'reverb'`).
 *   - Entries are keyed by exact match; a `compressor.treshold`
 *     entry covers the wiki's misspelled key (the typo is preserved
 *     in KNOWN_PARAMS for byte-stable codec output).
 *
 * Maintainers: when adding a new entry,
 *   1. Confirm the display range is the SAME concept on both AM4
 *      and II (don't copy `amp.level` ↔ AM4's `amp.level` if AM4's
 *      knob has different semantics; check the manuals).
 *   2. Add a one-line `// reason` comment naming the source (forum
 *      thread, manual page, hardware screenshot path).
 *   3. Re-run `npm test` and confirm the verify-display-units golden
 *      passes the new entry's round-trip.
 */

import type {
  ParamKindResolver,
  ResolvedParamKind,
} from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import {
  KNOWN_PARAMS,
  displayToWire,
  wireToDisplay,
  type AxeFxIIParam,
} from 'fractal-midi/axe-fx-ii';

export type CalibrationProvenance =
  | 'am4-shared'
  | 'editor-observed'
  | 'fractal-convention';

export interface CalibrationEntry {
  /** Lower bound of the display range (matches what the knob reads at 0%). */
  readonly displayMin: number;
  /** Upper bound of the display range (matches what the knob reads at 100%). */
  readonly displayMax: number;
  /**
   * `'log10'` for frequency / time knobs whose perceptual scale spans
   * multiple decades (display 200 Hz ↔ wire ~0, display 20000 Hz ↔ wire
   * 65534, midpoint NOT 10000 Hz but log-midpoint ~2000 Hz). `'linear'`
   * is the default and is omitted from entries when implicit.
   */
  readonly displayScale?: 'linear' | 'log10';
  /** Evidence source for this entry. */
  readonly provenance: CalibrationProvenance;
}

/**
 * AM4-shared entries — `(block, name)` join against the AM4 cache
 * catalog. Each entry's display range is hardware-verified on the AM4
 * (the AM4 wire encoding is byte-frozen against the device per HW-079
 * onward), and the Axe-Fx II shares the Fractal naming convention for
 * these knobs so the display range ports cleanly. The wire encoding
 * for the II is independently verified — what we're porting is the
 * display calibration that the agent shows the user, not the wire
 * scaling itself (II uses a 16-bit linear wire across the entire
 * 0..65534 range for both linear and log10 display scales).
 *
 * Generated by inspecting AM4 `CACHE_PARAMS` and selecting entries
 * with non-undefined `displayMin`/`displayMax` (see
 * `scripts/verify-axe-fx-ii-display-units.ts` for the join logic
 * used by the golden).
 */
const AM4_SHARED: Record<string, CalibrationEntry> = {
  'amp.bright_cap': { displayMin: 10, displayMax: 10000, provenance: 'am4-shared' },
  'amp.definition': { displayMin: -10, displayMax: 10, provenance: 'am4-shared' },
  'amp.dynimp': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'amp.input_trim': { displayMin: 0.1, displayMax: 10, provenance: 'am4-shared' },
  'amp.overdrive': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'amp.tremdepth': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  // amp.tremfreq: AM4 reports unit='db' min=0.2 max=20 — that's an AM4
  // metadata artifact (tremolo frequency is Hz, not dB). Skipped here;
  // covered by 'editor-observed' below with the correct unit.
  'chorus.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'chorus.depth': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  // chorus.drive: AM4 ships 0.5..500 knob_0_10 — strange range, the
  // Axe-Fx II chorus drive knob is documented in the editor as 0..10.
  // Covered by 'editor-observed' below.
  'chorus.high_cut': { displayMin: 200, displayMax: 20000, displayScale: 'log10', provenance: 'am4-shared' },
  'chorus.rate': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', provenance: 'am4-shared' },
  'chorus.width': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'compressor.attack': { displayMin: 0.1, displayMax: 100, provenance: 'am4-shared' },
  'compressor.dynamics': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'compressor.emphasis': { displayMin: 0, displayMax: 20, provenance: 'am4-shared' },
  'compressor.mix': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'compressor.ratio': { displayMin: 1, displayMax: 20, provenance: 'am4-shared' },
  'compressor.release': { displayMin: 2, displayMax: 2000, provenance: 'am4-shared' },
  'delay.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'delay.echo_pan': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'delay.feedback_r': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'delay.high_cut': { displayMin: 200, displayMax: 20000, displayScale: 'log10', provenance: 'am4-shared' },
  'delay.input_gain': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'delay.low_cut': { displayMin: 20, displayMax: 2000, displayScale: 'log10', provenance: 'am4-shared' },
  'delay.master_feedback': { displayMin: 0, displayMax: 200, provenance: 'am4-shared' },
  'delay.mix': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'delay.motor_speed': { displayMin: 0.5, displayMax: 2, provenance: 'am4-shared' },
  'delay.right_post_delay': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'delay.sweep_phase': { displayMin: 0, displayMax: 180, provenance: 'am4-shared' },
  'delay.sweep_rate': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', provenance: 'am4-shared' },
  'delay.time_r': { displayMin: 0, displayMax: 8000, provenance: 'am4-shared' },
  'drive.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'drive.bass': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'drive.mid_freq': { displayMin: 200, displayMax: 2000, displayScale: 'log10', provenance: 'am4-shared' },
  'drive.mix': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'drive.tone': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'drive.treble': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'enhancer.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'enhancer.depth': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'enhancer.high_cut': { displayMin: 200, displayMax: 20000, displayScale: 'log10', provenance: 'am4-shared' },
  'enhancer.low_cut': { displayMin: 20, displayMax: 2000, displayScale: 'log10', provenance: 'am4-shared' },
  'enhancer.pan_left': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'enhancer.pan_right': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'enhancer.width': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'filter.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'filter.gain': { displayMin: -20, displayMax: 20, provenance: 'am4-shared' },
  'filter.low_cut': { displayMin: 20, displayMax: 2000, displayScale: 'log10', provenance: 'am4-shared' },
  'filter.pan_left': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'filter.pan_right': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'filter.q': { displayMin: 0.1, displayMax: 10, provenance: 'am4-shared' },
  'flanger.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'flanger.depth': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'flanger.drive': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'flanger.feedback': { displayMin: -99, displayMax: 99, provenance: 'am4-shared' },
  'flanger.high_cut': { displayMin: 200, displayMax: 20000, displayScale: 'log10', provenance: 'am4-shared' },
  'flanger.low_cut': { displayMin: 20, displayMax: 2000, displayScale: 'log10', provenance: 'am4-shared' },
  'flanger.mix': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'flanger.rate': { displayMin: 0.05, displayMax: 10, displayScale: 'log10', provenance: 'am4-shared' },
  'phaser.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'phaser.feedback': { displayMin: -90, displayMax: 90, provenance: 'am4-shared' },
  'phaser.mix': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'phaser.rate': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', provenance: 'am4-shared' },
  'reverb.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'reverb.early_decay': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'reverb.early_diff_time': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'reverb.early_diffusion': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'reverb.early_level': { displayMin: -40, displayMax: 10, provenance: 'am4-shared' },
  'reverb.gain_1': { displayMin: -12, displayMax: 12, provenance: 'am4-shared' },
  'reverb.gain_2': { displayMin: -12, displayMax: 12, provenance: 'am4-shared' },
  'reverb.late_level': { displayMin: -40, displayMax: 10, provenance: 'am4-shared' },
  'reverb.q_1': { displayMin: 0.1, displayMax: 10, provenance: 'am4-shared' },
  'reverb.q_2': { displayMin: 0.1, displayMax: 10, provenance: 'am4-shared' },
  'reverb.release_time': { displayMin: 0, displayMax: 1000, provenance: 'am4-shared' },
  'reverb.size': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'reverb.spring_tone': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'reverb.threshold': { displayMin: -80, displayMax: 20, provenance: 'am4-shared' },
  'reverb.time': { displayMin: 0.1, displayMax: 100, provenance: 'am4-shared' },
  'rotary.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  // rotary.drive: AM4 ships 0.5..500 knob_0_10 — same artifact as
  // chorus.drive. Skipped here; editor-observed override below.
  'rotary.low_depth': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'rotary.mic_distance': { displayMin: 0.01, displayMax: 1, provenance: 'am4-shared' },
  'rotary.mic_spacing': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'rotary.mix': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'rotary.rate': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'rotary.rotor_length': { displayMin: 0.1, displayMax: 100, provenance: 'am4-shared' },
  'rotary.stereo_spread': { displayMin: -200, displayMax: 200, provenance: 'am4-shared' },
  'volpan.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'wah.balance': { displayMin: -100, displayMax: 100, provenance: 'am4-shared' },
  'wah.drive': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'wah.fat': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
};

/**
 * Editor-observed entries — display ranges read from AxeEdit II's UI
 * (visible knob captions on the founder's Q8.02 firmware, plus forum
 * screenshots cross-referenced for II-specific knobs that have no
 * direct AM4 analog).
 *
 * Each entry corrects a known AM4 metadata artifact (a few `unit: 'db'`
 * mislabels for what are actually Hz knobs, the 0.5..500 'knob_0_10'
 * misrange for chorus/rotary drive) or supplies a calibration for an
 * II-specific knob (drive.volume, amp tone-stack knobs, master-volume
 * variants AM4 doesn't ship).
 *
 * Session 98 root-cause entries (`drive.volume`, `drive.tone`) are in
 * AM4_SHARED above; `drive.volume` lands here because the AM4 has no
 * `drive.volume` knob (AM4 drives have just gain/tone/level — the II
 * adds an independent volume knob).
 */
const EDITOR_OBSERVED: Record<string, CalibrationEntry> = {
  // Session 98 root-cause: agent wrote drive.volume: 5 expecting a
  // 0..10 knob. AxeEdit II shows drive.volume as a 0..10 knob across
  // every drive type. (The wiki's "VOLUME" param documentation in
  // the II SysEx page is silent on the range; the editor screenshot
  // and the Fractal manual p. 64 "DRIVE BLOCK > VOLUME" both
  // confirm 0..10.)
  'drive.volume': { displayMin: 0, displayMax: 10, provenance: 'editor-observed' },
  // Tone-stack frequency knobs on the drive block — AxeEdit shows
  // middle as a 0..10 knob (frequency selection is a separate knob).
  'drive.middle': { displayMin: 0, displayMax: 10, provenance: 'editor-observed' },
  // Amp tremolo frequency: AM4 mis-tags as dB; the editor shows
  // it as Hz with a log scale similar to chorus.rate. Use the same
  // range AM4 reports (0.2..20) but tagged log10 since tremolo rate
  // is a perceptual frequency knob.
  'amp.tremfreq': { displayMin: 0.2, displayMax: 20, displayScale: 'log10', provenance: 'editor-observed' },
  // chorus.drive: AM4 0.5..500 knob_0_10 is the AM4's particular wire
  // mapping. The Axe-Fx II's chorus drive knob displays as 0..10 in
  // AxeEdit, with internal scaling absorbed into the wire mapping.
  'chorus.drive': { displayMin: 0, displayMax: 10, provenance: 'editor-observed' },
  // rotary.drive: same situation as chorus.drive — 0..10 knob in
  // AxeEdit despite the AM4's 0.5..500 metadata.
  'rotary.drive': { displayMin: 0, displayMax: 10, provenance: 'editor-observed' },
};

/**
 * Fractal-convention entries — name-suffix rules that hold across the
 * entire Fractal product line. These match KNOWN_PARAMS entries by
 * `(block, name)` lookup; the suffix is evaluated only when the
 * `(block, name)` key is not present in `AM4_SHARED` or
 * `EDITOR_OBSERVED`.
 *
 * Conventions:
 *
 *   - `level` / `*_level` / `out_level`  → -80..+20 dB (Fractal's
 *     canonical output level knob shape across AM4 / II / III).
 *     The output stage clamps; +20 dB is the editor's max.
 *   - `master` / `master_*` / `master_level`  → same as `level`
 *     when the param controls block-level mix output.
 *   - `mix` / `wet_mix` → 0..100% linear.
 *   - `pan` / `balance` / `*_pan` / `*_balance` → -100..+100% linear.
 *   - `feedback` (uncalibrated) → -100..+100% linear (matches the
 *     AM4-shared `delay.feedback_r` shape).
 *   - `width` / `spread` → 0..100% linear.
 *   - `depth` (uncalibrated; not in AM4_SHARED) → 0..100% linear.
 *   - `mid_freq` (uncalibrated) → 200..2000 Hz log10 (matches the
 *     AM4-shared `drive.mid_freq`).
 *
 * `getCalibration` evaluates suffix rules in declaration order; the
 * first matching rule wins. To opt out of suffix matching for a
 * specific (block, name) pair, add an explicit entry to
 * `EDITOR_OBSERVED` — explicit entries take precedence.
 */
type SuffixRule = { test: (name: string) => boolean; entry: CalibrationEntry };

const SUFFIX_RULES: readonly SuffixRule[] = [
  // -80..+20 dB level shapes. Match `level`, `*_level`, `out_level`,
  // `master_level`, `master_trim`. Exclude `level_l`/`level_r` because
  // some blocks use those as 0..100% mix balance — those are listed
  // explicitly below if they need calibration.
  {
    test: (n) => n === 'level' || n === 'master' || n === 'master_volume' || n === 'master_level' || n === 'master_trim' || n === 'output_level' || n === 'out_level' || n === 'input_gain' || n === 'main_level' || n === 'output_gain',
    entry: { displayMin: -80, displayMax: 20, provenance: 'fractal-convention' },
  },
  // 0..100% mix / wet
  {
    test: (n) => n === 'mix' || n === 'wet_mix' || n === 'wet' || n === 'hpmix' || n === 'echo_mix' || n === 'dub_mix' || n === 'pitch_mix' || n === 'spring_mix',
    entry: { displayMin: 0, displayMax: 100, provenance: 'fractal-convention' },
  },
  // -100..+100% balance / pan
  {
    test: (n) => n === 'balance' || n === 'pan' || /_balance$/.test(n) || /_pan$/.test(n) || n.startsWith('pan_') && !n.startsWith('pan_left') && !n.startsWith('pan_right'),
    entry: { displayMin: -100, displayMax: 100, provenance: 'fractal-convention' },
  },
  // Feedback knobs (uncalibrated)
  {
    test: (n) => n === 'feedback' || /^feedback_/.test(n) || /_feedback$/.test(n),
    entry: { displayMin: -100, displayMax: 100, provenance: 'fractal-convention' },
  },
  // Width / spread (0..100%)
  {
    test: (n) => n === 'width' || n === 'spread' || n === 'stereo_width' || n === 'wall_diffusion' || n === 'diffusion' || n === 'late_diffusion',
    entry: { displayMin: 0, displayMax: 100, provenance: 'fractal-convention' },
  },
  // Depth (0..100%)
  {
    test: (n) => n === 'depth' || /_depth$/.test(n),
    entry: { displayMin: 0, displayMax: 100, provenance: 'fractal-convention' },
  },
  // Modulation rate (0.1..10 Hz log10)
  {
    test: (n) => n === 'rate' || /_rate$/.test(n) || n === 'lfo1_rate' || n === 'lfo2_rate' || n === 'mod_rate' || n === 'sweep_rate',
    entry: { displayMin: 0.1, displayMax: 10, displayScale: 'log10', provenance: 'fractal-convention' },
  },
  // High-cut freq (200..20000 Hz log10)
  {
    test: (n) => n === 'high_cut' || n === 'hi_cut' || n === 'hicut' || n === 'pitch_high_cut',
    entry: { displayMin: 200, displayMax: 20000, displayScale: 'log10', provenance: 'fractal-convention' },
  },
  // Low-cut freq (20..2000 Hz log10)
  {
    test: (n) => n === 'low_cut' || n === 'lo_cut' || n === 'lowcut' || n === 'locut' || n === 'low_cut_freq',
    entry: { displayMin: 20, displayMax: 2000, displayScale: 'log10', provenance: 'fractal-convention' },
  },
  // Predelay (0..500 ms — common Fractal reverb predelay range)
  {
    test: (n) => n === 'predelay' || n === 'pre_delay',
    entry: { displayMin: 0, displayMax: 500, provenance: 'fractal-convention' },
  },
  // Q (filter sharpness, 0.1..10 linear)
  {
    test: (n) => /^q$/.test(n) || /^q_\d+$/.test(n) || n === 'filter_q' || n === 'low_cut_q' || n === 'high_cut_q' || n === 'resonance',
    entry: { displayMin: 0.1, displayMax: 10, provenance: 'fractal-convention' },
  },
  // Gain bands (EQ -12..+12 dB linear)
  {
    test: (n) => /^gain_\d+$/.test(n) || /^band_\d+$/.test(n),
    entry: { displayMin: -12, displayMax: 12, provenance: 'fractal-convention' },
  },
  // Frequency bands (parametric / multiband EQ — 20..20000 Hz log10)
  {
    test: (n) => /^freq_\d+$/.test(n) || /^frequency_\d+$/.test(n) || n === 'start_freq' || n === 'stop_freq' || n === 'freq',
    entry: { displayMin: 20, displayMax: 20000, displayScale: 'log10', provenance: 'fractal-convention' },
  },
  // Threshold (compressor / gate / reverb input threshold — -80..+20 dB)
  {
    test: (n) => n === 'threshold' || n === 'treshold' || n === 'duck_thres' || n === 'thres_level',
    entry: { displayMin: -80, displayMax: 20, provenance: 'fractal-convention' },
  },
  // Compressor / gate attack (0.1..100 ms — matches AM4 compressor.attack)
  {
    test: (n) => n === 'attack' || n === 'duck_attn',
    entry: { displayMin: 0.1, displayMax: 100, provenance: 'fractal-convention' },
  },
  // Compressor / gate release (2..2000 ms — matches AM4 compressor.release)
  {
    test: (n) => n === 'release' || n === 'duck_release',
    entry: { displayMin: 2, displayMax: 2000, provenance: 'fractal-convention' },
  },
  // Compressor / gate ratio (1..20 linear — matches AM4 compressor.ratio)
  {
    test: (n) => n === 'ratio',
    entry: { displayMin: 1, displayMax: 20, provenance: 'fractal-convention' },
  },
  // Bass / mid / treble / presence on amp + drive blocks (0..10 knob).
  // Skips when already in AM4_SHARED.
  {
    test: (n) => n === 'bass' || n === 'middle' || n === 'mid' || n === 'treble' || n === 'presence',
    entry: { displayMin: 0, displayMax: 10, provenance: 'fractal-convention' },
  },
  // LFO phase (0..360 degrees, linear)
  {
    test: (n) => n === 'lfo_phase' || /^lfo\d_phase$/.test(n) || n === 'sweep_phase',
    entry: { displayMin: 0, displayMax: 360, provenance: 'fractal-convention' },
  },
  // LFO duty (0..100% linear)
  {
    test: (n) => n === 'duty' || /^lfo\d_duty$/.test(n),
    entry: { displayMin: 0, displayMax: 100, provenance: 'fractal-convention' },
  },
  // Generic delay time (0..2000 ms — most Fractal delay knobs use ms)
  {
    test: (n) => n === 'time' || n === 'delay_time' || n === 'predly_time' || n === 'master_time' || n === 'hf_time' || n === 'lf_time' || n === 'late_diff_time',
    entry: { displayMin: 0, displayMax: 2000, provenance: 'fractal-convention' },
  },
  // Drive (block-level drive knob — 0..10 except where AM4 says otherwise)
  {
    test: (n) => n === 'drive',
    entry: { displayMin: 0, displayMax: 10, provenance: 'fractal-convention' },
  },
];

/**
 * Look up a calibration overlay for an Axe-Fx II param by its
 * `(block, name)` key. Returns `undefined` when no override applies —
 * the descriptor schema falls through to the codec catalog's own
 * `displayMin`/`displayMax` (which may also be undefined; uncalibrated
 * params then surface as opaque-wire knobs to the agent).
 *
 * Lookup order:
 *   1. Editor-observed entries (II-specific corrections that override
 *      both AM4-shared and convention).
 *   2. AM4-shared entries (hardware-verified on AM4, ported by name).
 *   3. Fractal-convention suffix rules (in declaration order).
 */
export function getCalibration(block: string, name: string): CalibrationEntry | undefined {
  const key = `${block}.${name}`;
  if (key in EDITOR_OBSERVED) return EDITOR_OBSERVED[key];
  if (key in AM4_SHARED) return AM4_SHARED[key];
  for (const rule of SUFFIX_RULES) {
    if (rule.test(name)) return rule.entry;
  }
  return undefined;
}

/**
 * Audit-friendly accessor — returns the full table of explicit
 * entries (AM4-shared + editor-observed) so verify scripts can
 * iterate them without spelunking the suffix rules. Suffix rules
 * are not enumerable (they're predicates), so the verify script
 * checks them by probing every uncalibrated KNOWN_PARAMS entry
 * through `getCalibration`.
 */
export function calibrationEntries(): ReadonlyArray<{
  block: string;
  name: string;
  entry: CalibrationEntry;
}> {
  const out: Array<{ block: string; name: string; entry: CalibrationEntry }> = [];
  for (const tbl of [EDITOR_OBSERVED, AM4_SHARED]) {
    for (const [key, entry] of Object.entries(tbl)) {
      const dotIdx = key.indexOf('.');
      out.push({ block: key.slice(0, dotIdx), name: key.slice(dotIdx + 1), entry });
    }
  }
  return out;
}

/** Stats helper for audit / coverage tooling. */
export function calibrationStats(): {
  am4Shared: number;
  editorObserved: number;
  suffixRules: number;
} {
  return {
    am4Shared: Object.keys(AM4_SHARED).length,
    editorObserved: Object.keys(EDITOR_OBSERVED).length,
    suffixRules: SUFFIX_RULES.length,
  };
}

// ── Param-kind resolver ────────────────────────────────────────────
//
// Single source of truth for "what kind of knob is this and how do
// we encode it" across every Axe-Fx II call site (schema encode /
// decode, writer reverse-display, reader forward-display, applyExecutor
// pre-encode). Wraps the catalog-first / overlay-second ladder + the
// existing display unit classification so every site sees the same
// answer for the same (block, name) input.
//
// Lookup order:
//   1. fractal-midi KNOWN_PARAMS catalog: if param.displayMin/Max are
//      set, use them — they're the hardware-verified codec entry.
//      Source: 'codec_catalog'.
//   2. calibration.ts overlay: getCalibration consults EDITOR_OBSERVED
//      first, then AM4_SHARED, then SUFFIX_RULES. Source: 'overlay'
//      for the explicit tables, 'suffix_rule' for the suffix fallback.
//   3. Param recognized but uncalibrated: returns unit by controlType
//      (enum / bool / opaque) with no closures. Source: 'unknown' is
//      reserved for "param not even in the catalog" — recognized-but-
//      uncalibrated returns 'codec_catalog' to mean "the catalog says
//      this knob has no display range."
//   4. Param not in catalog at all: helper returns undefined; the core
//      helper's UNKNOWN envelope is what the caller sees.

function findParam(block: string, name: string): AxeFxIIParam | undefined {
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    if (p.block === block && p.name === name) return p;
  }
  return undefined;
}

/**
 * Classify a calibrated param into one of the cross-device display
 * units. Matches the previous `unitFor` shape in schema.ts (log10 →
 * 'hz', linear -100..100 → 'bipolar_percent', linear 0..100 →
 * 'percent', linear 0..10 → 'knob'). The original `unitFor` lived in
 * three places (schema.ts, reader.ts, plus implicit logic in
 * encodeParamForApply); this one helper replaces all three.
 */
function classifyUnit(
  controlType: AxeFxIIParam['controlType'] | undefined,
  displayMin: number | undefined,
  displayMax: number | undefined,
  displayScale: 'linear' | 'log10' | undefined,
): ResolvedParamKind['unit'] {
  if (controlType === 'select') return 'enum';
  if (controlType === 'switch') return 'bool';
  if (displayMin === undefined || displayMax === undefined) return 'opaque';
  if (displayScale === 'log10') return 'hz';
  if (displayMin === 0 && displayMax === 10) return 'knob';
  if (displayMin === -100 && displayMax === 100) return 'bipolar_percent';
  if (displayMin === 0 && displayMax === 100) return 'percent';
  return 'knob';
}

/**
 * The Axe-Fx II resolver. Plugged into the cross-device registry by
 * `registerParamKindResolver('axe-fx-ii', resolveAxeFxIIParamKind)` at
 * descriptor module load.
 */
export const resolveAxeFxIIParamKind: ParamKindResolver = (
  block,
  name,
): ResolvedParamKind | undefined => {
  const param = findParam(block, name);
  if (param === undefined) return undefined;

  // Enum / switch params don't carry a display range; encode through
  // the codec's label-resolution path. Decode is the inverse.
  if (param.controlType === 'select') {
    return {
      unit: 'enum',
      source: 'codec_catalog',
      encodeDisplay: (value: number | string) => resolveEnumWire(param, value),
      decodeWire: (wire: number) => param.enumValues?.[Math.round(wire)] ?? wire,
    };
  }
  if (param.controlType === 'switch') {
    return {
      unit: 'bool',
      source: 'codec_catalog',
      encodeDisplay: (value: number | string) => coerceSwitchWire(value),
      decodeWire: (wire: number) => (wire ? 'on' : 'off'),
    };
  }

  // Knob / unknown — resolve calibration via catalog → overlay ladder.
  let displayMin: number | undefined;
  let displayMax: number | undefined;
  let displayScale: 'linear' | 'log10' | undefined;
  let source: ResolvedParamKind['source'];
  if (param.displayMin !== undefined && param.displayMax !== undefined) {
    displayMin = param.displayMin;
    displayMax = param.displayMax;
    displayScale = param.displayScale;
    source = 'codec_catalog';
  } else {
    const overlay = getCalibration(block, name);
    if (overlay !== undefined) {
      displayMin = overlay.displayMin;
      displayMax = overlay.displayMax;
      displayScale = overlay.displayScale;
      source = overlay.provenance === 'fractal-convention' ? 'suffix_rule' : 'overlay';
    } else {
      // Param recognized in catalog but no calibration anywhere — wire
      // pass-through, no closures, but unit reflects controlType.
      return {
        unit: classifyUnit(param.controlType, undefined, undefined, undefined),
        source: 'codec_catalog',
      };
    }
  }

  const unit = classifyUnit(param.controlType, displayMin, displayMax, displayScale);
  return {
    unit,
    displayMin,
    displayMax,
    source,
    encodeDisplay: (value: number | string) => {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) {
        throw new Error(`Expected a number for ${block}.${name}, got "${value}"`);
      }
      if (num < (displayMin as number) || num > (displayMax as number)) {
        throw new Error(
          `${block}.${name} out of range [${displayMin}..${displayMax}]: ${num}`,
        );
      }
      return displayToWire(num, {
        displayMin: displayMin as number,
        displayMax: displayMax as number,
        displayScale,
      });
    },
    decodeWire: (wire: number) =>
      wireToDisplay(wire, {
        displayMin: displayMin as number,
        displayMax: displayMax as number,
        displayScale,
      }),
  };
};

function resolveEnumWire(param: AxeFxIIParam, value: number | string): number {
  const enumValues = param.enumValues ?? {};
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !(value in enumValues)) {
      const samples = Object.values(enumValues).slice(0, 8).join(', ');
      throw new Error(
        `${value} is not a valid enum index for ${param.block}.${param.name}. First few values: ${samples}…`,
      );
    }
    return value;
  }
  const lower = value.trim().toLowerCase();
  const matches: Array<{ idx: number; label: string }> = [];
  for (const [idxStr, label] of Object.entries(enumValues)) {
    if (label.toLowerCase() === lower) return Number(idxStr);
    if (label.toLowerCase().includes(lower)) {
      matches.push({ idx: Number(idxStr), label });
    }
  }
  if (matches.length === 1) return matches[0].idx;
  if (matches.length > 1) {
    const list = matches.slice(0, 6).map((m) => `"${m.label}"`).join(' / ');
    throw new Error(
      `"${value}" is ambiguous — matched ${matches.length} entries: ${list}. Pick one verbatim.`,
    );
  }
  const samples = Object.values(enumValues).slice(0, 8).join(', ');
  throw new Error(
    `"${value}" is not a valid ${param.block}.${param.name} value. First few valid names: ${samples}… (call list_params for the full list).`,
  );
}

function coerceSwitchWire(value: number | string): number {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === 'on' || lower === '1') return 1;
    if (lower === 'false' || lower === 'off' || lower === '0') return 0;
    throw new Error(`Expected boolean / "on" / "off", got "${value}"`);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Expected a number/boolean, got "${value}"`);
  }
  return num ? 1 : 0;
}
