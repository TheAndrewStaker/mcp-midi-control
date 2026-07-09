/**
 * Axe-Fx II display calibration overlay (BK-060).
 *
 * The `fractal-midi/gen2/axe-fx-ii` KNOWN_PARAMS catalog ships
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
 *   - Entries are keyed by exact match; the `compressor.threshold`
 *     entry pins the device-observed -80..0 dB range (the suffix-rule
 *     default would overestimate the span).
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
} from 'fractal-midi/gen2/axe-fx-ii';

export type CalibrationProvenance =
  | 'am4-shared'
  | 'editor-observed'
  | 'fractal-convention'
  // Direct 5-point wire sweep on the II under test (wire 0 / 16383 /
  // 32767 / 49151 / 65534), with the device echoing its own rendered
  // display label at each point. Scale decided by the midpoint test
  // (geometric mean → log10, arithmetic mean → linear). Strongest tier:
  // measured on the II itself, so it overrides am4-shared / convention
  // on conflict (e.g. amp.ac_line_freq is LINEAR Hz, not the bare-'freq'
  // log10 convention). Evidence:
  //   samples/captured/decoded/ii-opaque-amp-sweep.json
  //   samples/captured/decoded/ii-opaque-amp-fit.json
  | 'hardware-swept';

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
  /**
   * Explicit display unit, when the device's rendered suffix is known
   * (hardware-swept tier). When set, the resolver uses this verbatim
   * instead of inferring via `classifyUnit`; the inference cannot tell
   * ms from hz (both log10, max > 30) or dB from a bare knob (both
   * linear), so without this the time-constant and dB knobs surface the
   * wrong suffix. Omitted for the AM4-shared / convention tiers, which
   * fall back to `classifyUnit` as before.
   */
  readonly unit?: ResolvedParamKind['unit'];
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
  'compressor.attack': { displayMin: 1, displayMax: 100, displayScale: 'log10', provenance: 'editor-observed' },
  'compressor.comp': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'compressor.dynamics': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
  'compressor.filter': { displayMin: 10, displayMax: 1000, displayScale: 'log10', provenance: 'editor-observed' },
  // fn 0x16 GET_PARAM_INFO device-reported -20..20 (2026-06-10), NOT the -80..20
  // the *level suffix rule assumes. Confirms the II compressor calibration
  // divergence: comp ranges differ from the convention. Overlay overrides suffix.
  'compressor.level': { displayMin: -20, displayMax: 20, provenance: 'hardware-swept' },
  'compressor.look_ahead': { displayMin: 0, displayMax: 2, provenance: 'am4-shared' },
  'compressor.emphasis': { displayMin: 0, displayMax: 20, provenance: 'am4-shared' },
  'compressor.mix': { displayMin: 0, displayMax: 100, provenance: 'am4-shared' },
  'compressor.ratio': { displayMin: 1, displayMax: 20, displayScale: 'log10', provenance: 'am4-shared' },
  'compressor.release': { displayMin: 10, displayMax: 1000, displayScale: 'log10', provenance: 'editor-observed' },
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
  // AM4 volpan.volume is a founder-audited 0..10 knob (audit-output
  // volpan-volume.md); the II's Vol/Pan VOLUME is the same Fractal
  // control (taper is the separate `taper` param). Without this the
  // read side returned raw wire (65534 for a max'd knob) while the
  // write side scaled display 0..10 — 0.3.0 dev-test finding.
  'volpan.volume': { displayMin: 0, displayMax: 10, provenance: 'am4-shared' },
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
  // II compressor threshold: device raw_response proves range is -80..0 dB
  // (AM4 uses -60..+20; the suffix-rule default of -80..+20 overestimates
  // the span by 25%, producing miscalibrated writes like tool -22 landing
  // as -33.6 dB on the hardware).
  'compressor.threshold': { displayMin: -80, displayMax: 0, provenance: 'editor-observed' },
};

/**
 * Hardware-swept entries: Axe-Fx II `amp` block opaque knobs calibrated
 * by a direct 5-point wire sweep with the device echoing its own display
 * label at each point (see `scripts/_research/probe-ii-opaque-amp-sweep.ts`
 * → `fit-ii-opaque-amp-calibration.ts`; verified by the
 * `ii-amp-calibration-verify` workflow). These params previously surfaced
 * as raw wire integers in `get_preset` (the deep-amp-decode bug) because
 * none of the catalog / AM4-shared / convention layers calibrated them.
 *
 * `unit` is the device-rendered suffix (the strongest evidence: the
 * device literally printed `Hz` / `ms` / `dB` / `pF` / `%` or a bare
 * number), so the resolver uses it verbatim rather than inferring.
 *
 * Edge cases worth noting:
 *   - `ac_line_freq` is LINEAR Hz (30..100, mains band), NOT the bare
 *     `freq` log10 convention; this tier overrides the suffix rule.
 *   - `supply_sag` is LINEAR 0..10; wire 0 renders as "P.A. OFF" on the
 *     device (the off state, value 0). Confirmed: wire 13107 → "2.00"
 *     (= 10 × 13107/65534).
 *   - `triode2rectime` tops at 100 ms on the II (clean unclamped log10
 *     0.1..100, identical to its `triode2extime` sibling). AM4/III put
 *     it at 200 ms, a genuine cross-device divergence; the II's own
 *     hardware reading is authoritative for the II.
 */
const HARDWARE_SWEPT: Record<string, CalibrationEntry> = {
  // ── frequencies (Hz, log10) ──
  'amp.tone_freq': { displayMin: 200, displayMax: 2000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.wslpf': { displayMin: 400, displayMax: 40000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.xformer_low_freq': { displayMin: 10, displayMax: 1000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.xformer_hi_freq': { displayMin: 4000, displayMax: 40000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.low_res_freq': { displayMin: 40, displayMax: 400, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.depth_freq': { displayMin: 50, displayMax: 500, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.hi_freq': { displayMin: 400, displayMax: 4000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.character_freq': { displayMin: 100, displayMax: 10000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.triode_1_plate_freq': { displayMin: 400, displayMax: 40000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.triode_2_plate_freq': { displayMin: 400, displayMax: 40000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  'amp.wshpf': { displayMin: 2, displayMax: 2000, displayScale: 'log10', unit: 'hz', provenance: 'hardware-swept' },
  // LINEAR Hz, overrides the bare-'freq' log10 suffix convention.
  'amp.ac_line_freq': { displayMin: 30, displayMax: 100, unit: 'hz', provenance: 'hardware-swept' },
  // screenfreq renders a bare number (no Hz suffix) → numeric, not hz.
  'amp.screenfreq': { displayMin: 1, displayMax: 100, displayScale: 'log10', unit: 'numeric', provenance: 'hardware-swept' },

  // ── decibels (dB, linear) ──
  'amp.out_comp_threshold': { displayMin: -60, displayMax: 0, unit: 'db', provenance: 'hardware-swept' },
  'amp.bright': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_1': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_2': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_3': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_4': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_5': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_6': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_7': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },
  'amp.geq_band_8': { displayMin: -12, displayMax: 12, unit: 'db', provenance: 'hardware-swept' },

  // ── percents (linear) ──
  'amp.bias_excursion': { displayMin: 0, displayMax: 100, unit: 'percent', provenance: 'hardware-swept' },
  'amp.preamp_cf_compress': { displayMin: 0, displayMax: 100, unit: 'percent', provenance: 'hardware-swept' },
  'amp.preamp_cf_time': { displayMin: 0, displayMax: 100, unit: 'percent', provenance: 'hardware-swept' },
  'amp.cathode_resist': { displayMin: 0, displayMax: 100, unit: 'percent', provenance: 'hardware-swept' },
  'amp.crunch': { displayMin: 0, displayMax: 100, unit: 'percent', provenance: 'hardware-swept' },
  'amp.pi_bias_shift': { displayMin: 0, displayMax: 100, unit: 'percent', provenance: 'hardware-swept' },
  'amp.gridhardness': { displayMin: 10, displayMax: 100, unit: 'percent', provenance: 'hardware-swept' },
  'amp.variac': { displayMin: 50, displayMax: 150, unit: 'percent', provenance: 'hardware-swept' },
  'amp.pickattack': { displayMin: -100, displayMax: 100, unit: 'bipolar_percent', provenance: 'hardware-swept' },
  'amp.triode1ratio': { displayMin: -100, displayMax: 100, unit: 'bipolar_percent', provenance: 'hardware-swept' },

  // ── times (ms, log10) ──
  'amp.b_time_const': { displayMin: 1, displayMax: 100, displayScale: 'log10', unit: 'ms', provenance: 'hardware-swept' },
  'amp.excursiontime': { displayMin: 1, displayMax: 100, displayScale: 'log10', unit: 'ms', provenance: 'hardware-swept' },
  'amp.recoverytime': { displayMin: 1, displayMax: 100, displayScale: 'log10', unit: 'ms', provenance: 'hardware-swept' },
  'amp.cbtime': { displayMin: 1, displayMax: 100, displayScale: 'log10', unit: 'ms', provenance: 'hardware-swept' },
  'amp.triode2extime': { displayMin: 0.1, displayMax: 100, displayScale: 'log10', unit: 'ms', provenance: 'hardware-swept' },
  'amp.triode2rectime': { displayMin: 0.1, displayMax: 100, displayScale: 'log10', unit: 'ms', provenance: 'hardware-swept' },
  'amp.motor_time_const': { displayMin: 20, displayMax: 2000, displayScale: 'log10', unit: 'ms', provenance: 'hardware-swept' },

  // ── signed-decimal bias (-1..1, linear, no suffix → numeric) ──
  'amp.offset1': { displayMin: -1, displayMax: 1, unit: 'numeric', provenance: 'hardware-swept' },
  'amp.preamp_bias': { displayMin: -1, displayMax: 1, unit: 'numeric', provenance: 'hardware-swept' },
  'amp.pwr_amp_bias': { displayMin: -1, displayMax: 1, unit: 'numeric', provenance: 'hardware-swept' },

  // ── unipolar ratio (0..1, linear) ──
  'amp.tube_grid_bias': { displayMin: 0, displayMax: 1, unit: 'ratio', provenance: 'hardware-swept' },
  'amp.harmonics': { displayMin: 0, displayMax: 1, unit: 'ratio', provenance: 'hardware-swept' },
  'amp.pi_ratio': { displayMin: 0, displayMax: 1, unit: 'ratio', provenance: 'hardware-swept' },

  // ── 0..10 knobs (linear) ──
  'amp.low_res': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.hi_resonance': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.preamp_hardness': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.speaker_drive': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.out_comp_clarity': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.out_comp_amount': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.pwr_amp_hardness': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.preamp_cf_hardness': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.motor_drive': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.saturation_drive': { displayMin: 1, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  // bipolar -10..10 knobs (no suffix → knob)
  'amp.character_amt': { displayMin: -10, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.dynamic_presence': { displayMin: -10, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },
  'amp.preamp_dynamics': { displayMin: -10, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },

  // ── log10 ratios ──
  'amp.presence_freq': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },
  'amp.low_res_q': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },
  'amp.xformer_drive': { displayMin: 0.01, displayMax: 10, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },
  'amp.xformer_match': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },
  'amp.screenq': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },
  'amp.character_q': { displayMin: 0.1, displayMax: 10, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },
  'amp.hi_freq_slope': { displayMin: 1, displayMax: 10, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },
  'amp.preamp_cf_ratio': { displayMin: 0.02, displayMax: 2, displayScale: 'log10', unit: 'ratio', provenance: 'hardware-swept' },

  // ── supply_sag: LINEAR 0..10 (wire 0 = "P.A. OFF"). ──
  'amp.supply_sag': { displayMin: 0, displayMax: 10, unit: 'knob', provenance: 'hardware-swept' },

  // ── picofarads (log10) ──
  'amp.mv_cap': { displayMin: 1, displayMax: 1000, displayScale: 'log10', unit: 'pf', provenance: 'hardware-swept' },
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
  // Compressor / gate attack (0.1..100 ms). compressor.attack in
  // AM4_SHARED carries log10; this is a linear fallback for other blocks.
  {
    test: (n) => n === 'attack' || n === 'duck_attn',
    entry: { displayMin: 0.1, displayMax: 100, provenance: 'fractal-convention' },
  },
  // Compressor / gate release (2..2000 ms). compressor.release in
  // AM4_SHARED carries log10; this is a linear fallback for other blocks.
  {
    test: (n) => n === 'release' || n === 'duck_release',
    entry: { displayMin: 2, displayMax: 2000, provenance: 'fractal-convention' },
  },
  // Compressor / gate ratio (1..20 — matches AM4 compressor.ratio).
  // Note: compressor.ratio in AM4_SHARED carries log10; this suffix rule
  // is a linear fallback for non-compressor blocks that use 'ratio'.
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
  // Hardware-swept measured on the II itself, authoritative over the
  // AM4 port and the convention suffix rules.
  if (key in HARDWARE_SWEPT) return HARDWARE_SWEPT[key];
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
  for (const tbl of [EDITOR_OBSERVED, HARDWARE_SWEPT, AM4_SHARED]) {
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
  hardwareSwept: number;
  suffixRules: number;
} {
  return {
    am4Shared: Object.keys(AM4_SHARED).length,
    editorObserved: Object.keys(EDITOR_OBSERVED).length,
    hardwareSwept: Object.keys(HARDWARE_SWEPT).length,
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
  if (displayScale === 'log10') {
    if (displayMin < 10 && displayMax <= 30) return 'knob';
    return 'hz';
  }
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
  let overlayUnit: ResolvedParamKind['unit'] | undefined;
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
      overlayUnit = overlay.unit;
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

  // Prefer the device-rendered unit (hardware-swept tier) when present;
  // classifyUnit can't tell ms from hz or dB from a bare knob.
  const unit = overlayUnit ?? classifyUnit(param.controlType, displayMin, displayMax, displayScale);
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
      roundDisplay(
        wireToDisplay(wire, {
          displayMin: displayMin as number,
          displayMax: displayMax as number,
          displayScale,
        }),
      ),
  };
};

/**
 * Round a decoded display value to the panel's natural resolution,
 * stripping the float noise the wire→display linear/log inverse leaves
 * behind (e.g. 7.000030518 → 7, -0.000305 → 0, 28.000732 → 28).
 *
 * Display-first contract: what get_param / get_preset return must equal
 * what the front panel shows, and "nudge treble up one" must start from a
 * clean 6, not 5.99994. Rounded here at the II decode boundary, NOT inside
 * the shared `wireToDisplay` codec (other consumers may want full
 * precision). Two decimals preserves every observed II panel resolution
 * (1-decimal dB, 2-decimal ratio) while removing the sub-0.001 inverse
 * noise; per-unit resolution is a future refinement if a finer-grained
 * param ever appears. Encode (display→wire) is untouched, so the
 * calibration round-trip goldens (tolerance-based) stay green.
 */
function roundDisplay(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

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
    const shown = matches.slice(0, 6).map((m) => `"${m.label}"`).join(' / ');
    const more = matches.length > 6 ? ` (and ${matches.length - 6} more — call list_params for the full list)` : '';
    throw new Error(
      `"${value}" is ambiguous — matched ${matches.length} entries: ${shown}${more}. Pick one verbatim.`,
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
