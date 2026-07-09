/**
 * AM4 parameter registry.
 *
 * Each entry maps a human key (`block.name`) to its wire-level address
 * (`pidLow` = block ID, `pidHigh` = parameter index within block) and
 * its display ↔ internal scale convention.
 *
 * Address is preset-independent (confirmed — Amp pidLow
 * matches across A01 and A2). See founder-private notes for the decoded set.
 */

import type { ParamId } from './setParam.js';
import { CACHE_PARAMS } from './cacheParams.js';
import { AMP_GHOST_PARAMS } from './cacheOracleParams.generated.js';
import {
  AMP_TYPES_VALUES,
  DRIVE_TYPES_VALUES,
  REVERB_TYPES_VALUES,
  DELAY_TYPES_VALUES,
  CHORUS_TYPES_VALUES,
  FLANGER_TYPES_VALUES,
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  COMPRESSOR_TYPES_VALUES,
  GEQ_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
  VOLPAN_MODES_VALUES,
  TEMPO_DIVISIONS_VALUES,
  LFO_WAVEFORMS_VALUES,
} from './cacheEnums.js';

/**
 * How a parameter's display value relates to the float stored on the
 * wire. The firmware always stores a float; the unit decides the scale.
 *
 *   knob_0_10        — UI 0–10, internal ÷10 (gain-style knobs)
 *   db               — UI dB, internal raw dB
 *   hz               — UI Hz (raw passthrough), for LFO rates + filter cutoffs
 *   seconds          — UI seconds (raw passthrough), for reverb time etc.
 *   percent          — UI 0–100%, internal ÷100
 *   bipolar_percent  — UI -100..+100%, internal -1..+1 (balance knobs —
 *                      per-block output balance, stereo pan)
 *   count            — UI integer count (voices, stages, taps, springs);
 *                      display = internal (scale 1)
 *   semitones        — UI integer semitones (pitch shift);
 *                      display = internal (scale 1)
 *   ratio            — UI compression ratio (e.g. 4 ⇒ 4:1); display =
 *                      internal (scale 1). Fractional values valid
 *                      (1.5:1 etc.) — semantic label so Claude reads
 *                      "ratio 4" as 4:1 not 4 dB.
 *   ms               — UI milliseconds, internal seconds (÷1000)
 *   degrees          — UI degrees 0–180, internal radians (÷57.2958 = ÷180/π)
 *   enum             — UI dropdown name, internal int-as-float (per-param table)
 *
 * Note: `db`, `hz`, `seconds`, `count`, `semitones`, and `ratio` all
 * pass display=internal (scale 1). They're distinct unit tags so tool
 * descriptions can label values accurately — Claude interprets "set
 * rate to 3" as 3 Hz when it sees `unit: 'hz'`, not 3 dB, and "8
 * voices" as a count rather than 8 dB. Semantic labels matter for
 * LLM correctness, even when the wire math is identical.
 */
export type Unit =
  | 'knob_0_10'
  | 'knob_0_20'
  | 'db'
  | 'hz'
  | 'seconds'
  | 'percent'
  | 'bipolar_percent'
  | 'count'
  | 'semitones'
  | 'ratio'
  | 'ms'
  | 'degrees'
  | 'pf'
  | 'rotary_mic_spacing'
  | 'amp_geq_band'
  | 'enum';

export interface Param extends ParamId {
  block: string;
  name: string;
  unit: Unit;
  displayMin: number;
  displayMax: number;
  /** For `unit: 'enum'` only — internal int → display name. */
  enumValues?: Record<number, string>;
  /**
   * How the AM4's internal stored value (the Q15-encoded normalized [0,1]
   * float we read back) maps to the display range.
   *
   * - `linear` (default): display = displayMin + internal × (displayMax − displayMin).
   * - `log10`: display = displayMin × (displayMax / displayMin) ^ internal.
   *   Used for time-based knobs (attack/release/delay) and ratio knobs that
   *   span multiple decades — the AM4 stores them on a logarithmic curve so
   *   the slider feels musical (small movements at low values, larger
   *   movements at high values).
   *
   * Empirically determined per cache record's `typecode` field; see
   *  in `04-BACKLOG.md` and `gen-params-from-cache.ts` for the
   * typecode → scaling mapping.
   */
  scaling?: 'linear' | 'log10';
  /**
   * Optional override for the unit suffix shown in get_param / get_params
   * readback strings. Default is `param.unit` verbatim. Use this when the
   * unit field's encoding scale is correct but its name is misleading
   * for the user — e.g. `negative_feedback` uses `unit: 'percent'` for
   * the encode scale (cache c=100), but the AM4 displays it as a unitless
   * 0..10 knob with no % sign. Pass an empty string to suppress the
   * suffix entirely. Does NOT affect encoding, decoding, range, or any
   * wire behavior — purely cosmetic.
   */
  displayUnit?: string;
  /**
   * The AM4-Edit on-screen label for this control (e.g. `'Scene 1 Level'`,
   * `'Mic Distance'`, `'Drive'`). Sourced from `__block_layout.xml` /
   * `__block_layout_expert.xml` inside `am4edit-resources.zip`. Surfaced
   * to the agent as a recognition synonym so user prompts that quote the
   * display label match the right param. Does NOT affect wire encoding —
   * purely a discovery hint.
   *
   * Maintained by `scripts/_research/add-display-labels.ts` (generator)
   * and verified by `scripts/_research/coverage-cross-ref-audit.ts`
   * (gated in preflight via a ceiling).
   */
  displayLabel?: string;
}

const DISPLAY_TO_INTERNAL: Record<Exclude<Unit, 'enum'>, number> = {
  knob_0_10: 10,
  // 2026-04-29: Compressor Emphasis at cache c=20.
  // Display range 0..20 with fractional precision (cache step 0.0005 ×
  // 20 = 0.01 display step). Same shape as knob_0_10 but with double
  // the display range — JFET Studio compressor's Drive-engine emphasis
  // knob is the canonical case.
  knob_0_20: 20,
  db: 1,
  hz: 1,
  seconds: 1,
  percent: 100,
  bipolar_percent: 100,
  count: 1,
  semitones: 1,
  ratio: 1,
  ms: 1000,
  // Cache c=57.295780... = 180/π. AM4-Edit displays Mod Phase / Phase
  // knobs in degrees; firmware stores radians. e.g. 10 deg → 0.17453 rad
  // / 90 deg → 1.5708 rad / 180 deg → 3.14159 rad.
  degrees: 57.29577951308232,
  // 2026-04-29: Picofarad capacitance for amp.bright_cap.
  // Cache id=20 a=0.00001 b=0.01 c=1000000 → wire 0.00001..0.01 displays
  // as 10..10000 pF. The "Bright Cap" knob on the FAS Modern III amp's
  // IDEAL section is the canonical case.
  pf: 1000000,
  // 2026-04-29: rotary.mic_spacing uses a
  // π-encoded internal scale. Cache id=16 a=0 b=π c=100/π=31.831 → wire
  // 0..π displays as 0..100. Used only by `rotary.mic_spacing` so far;
  // unit name is specific to keep the math discoverable. Same structural
  // pattern as `degrees` (180/π) but maps to a 0..100 linear scale.
  rotary_mic_spacing: 31.83098793029785,
  //  follow-up (2026-04-30): amp's 8-band Graphic EQ stores
  // each band as ±1 wire, scale ×12 → display ±12 dB. Cache ids 62..69
  // share the (a=-1, b=1, c=12) signature. Distinct from `drive`'s GEQ,
  // which stores ±12 directly (cache c=1) and uses plain `db`. Naming is
  // specific because c=12 only appears on these 8 cache records across
  // the whole AM4 surface.
  amp_geq_band: 12,
};

/** Convert a UI/display value to the float the firmware expects. */
export function encode(param: Param, displayValue: number): number {
  if (param.unit === 'enum') return displayValue;
  return displayValue / DISPLAY_TO_INTERNAL[param.unit];
}

/**
 * Convert the AM4's internal [0,1] normalized float (decoded from the Q15
 * read register) back to a UI/display value.
 *
 * The AM4 stores all params in a normalized [0,1] form scaled to each
 * param's `[displayMin, displayMax]` range. Most params are linearly
 * scaled; time-based knobs (ms attack/release/delay) and ratio knobs are
 * stored on a log10 curve. Per-param scaling is encoded in `param.scaling`
 * (default `linear`).
 *
 * 2026-05-01: the previous decode rule was
 * `internal × DISPLAY_TO_INTERNAL[unit]`, which only happened to be
 * correct for params where `displayMin === 0` AND `displayMax ===
 * DISPLAY_TO_INTERNAL[unit]` (e.g. `knob_0_10` with range 0..10 and
 * scale 10). For most non-knob_0_10 params it produced wildly wrong
 * readbacks ("compressor.attack = 867 ms" when the device displayed
 * 40 ms). Founder-observed via the Sultans-of-Swing iconic-tone test.
 */
export function decode(param: Param, internalValue: number): number {
  if (param.unit === 'enum') return Math.round(internalValue);
  const { displayMin, displayMax } = param;
  if (param.scaling === 'log10') {
    // Guard against degenerate range / zero-or-negative endpoints.
    if (displayMin <= 0 || displayMax <= 0 || displayMax === displayMin) {
      return displayMin + internalValue * (displayMax - displayMin);
    }
    return displayMin * Math.pow(displayMax / displayMin, internalValue);
  }
  // Linear (default): display = displayMin + internal × (displayMax − displayMin).
  return displayMin + internalValue * (displayMax - displayMin);
}

/**
 * Exact inverse of `decode`: convert a UI/display value back to the AM4's
 * normalized [0,1] internal float (the read-register space; the wire u32 is
 * `round(internal × READ_VALUE_DENOMINATOR)`, see `setParam.ts`).
 *
 * Branch-for-branch mirror of `decode`, INCLUDING the degenerate-log10
 * linear fallback (log10 with a non-positive or collapsed range decodes
 * linearly, so it must also encode linearly), so that
 * `decode(param, internalFromDisplay(param, d)) === d` for every display
 * value in `[displayMin, displayMax]`.
 *
 * Note this is the inverse of the READ decode, NOT the same space as
 * `encode` (which produces the absolute physical float the MESSAGE_SET
 * write action carries — the firmware maps between the two spaces).
 * For params whose write-float space coincides with the normalized space
 * (displayMin 0, displayMax === unit scale, e.g. `knob_0_10`), the two
 * agree — hardware-anchored by the `buildSetParamNorm` probe (normalized
 * 0.7 landed at display 7.0 on amp.gain) and the pinned read captures
 * (display 3.00/5.00/6.00 ↔ u32 19660/32767/39320).
 *
 * Verified by `scripts/verify-display-first-fractal.ts` (round-trip gate
 * over every param's display grid + the hardware anchors above), which
 * runs in `test:codec`.
 */
export function internalFromDisplay(param: Param, displayValue: number): number {
  if (param.unit === 'enum') return displayValue;
  const { displayMin, displayMax } = param;
  if (displayMax === displayMin) return 0; // decode is constant; degenerate
  if (
    param.scaling === 'log10' &&
    displayMin > 0 &&
    displayMax > 0
  ) {
    return Math.log(displayValue / displayMin) / Math.log(displayMax / displayMin);
  }
  // Linear (default) — also the degenerate-log10 fallback branch.
  return (displayValue - displayMin) / (displayMax - displayMin);
}

/**
 * Decimal places for display values, per unit. Matches AM4-Edit's on-screen
 * convention so read tool output ("amp.gain is 5.00") doesn't surface the
 * Q15 quantization residue ("amp.gain is 4.9999"). Used by `formatDisplay`.
 */
const DISPLAY_PRECISION: Record<Exclude<Unit, 'enum'>, number> = {
  knob_0_10: 2,
  knob_0_20: 2,
  db: 1,
  hz: 0,
  seconds: 2,
  percent: 0,
  bipolar_percent: 0,
  count: 0,
  semitones: 0,
  ratio: 1,
  ms: 0,
  degrees: 0,
  pf: 0,
  rotary_mic_spacing: 1,
  amp_geq_band: 1,
};

/**
 * Format a display value for human-readable output (read tools, error
 * messages). Picks decimal precision per `param.unit` so the AM4's Q15
 * quantization residue (~0.0001 on a 0..10 knob) doesn't leak into the
 * agent's tool output. Enum params use `formatEnum` instead.
 */
export function formatDisplay(param: Param, displayValue: number): string {
  if (param.unit === 'enum') {
    throw new Error(`formatDisplay called on enum param ${param.block}.${param.name} — use enumValues lookup`);
  }
  return displayValue.toFixed(DISPLAY_PRECISION[param.unit]);
}

/**
 * Round a decoded display value to the AM4 panel's per-unit resolution,
 * returning a NUMBER (unlike `formatDisplay`, which returns a string).
 *
 * The numeric sibling of `formatDisplay`: same `DISPLAY_PRECISION` table,
 * but it keeps the result a number so read tools surface a clean
 * `amp.gain: 5` instead of the Q15 inverse residue `5.0000305…`. Display
 * value in, display value out. Enum/string values pass through unchanged.
 *
 * Applied at the device-package decode boundary (descriptor reader +
 * schema decode closure), NOT inside the shared `decode` codec, so other
 * consumers that want the full-precision inverse still get it.
 */
export function roundDisplayValue(param: Param, value: number | string): number | string {
  if (typeof value !== 'number' || param.unit === 'enum') return value;
  const decimals = DISPLAY_PRECISION[param.unit];
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Render the unit suffix for read-tool output, including the leading
 * space. Returns `' <suffix>'` (with leading space) for non-empty
 * suffixes, or empty string when the param is unitless or the override
 * suppresses it. Used by get_param / get_params to format readback
 * strings without trailing whitespace.
 */
export function formatUnitSuffix(param: Param): string {
  const suffix = param.displayUnit ?? param.unit;
  return suffix === '' ? '' : ` ${suffix}`;
}

/**
 * Resolve an enum param's display name (or numeric index) to the wire
 * integer. Accepts numbers directly, exact name matches, and a relaxed
 * case-insensitive match after collapsing whitespace and punctuation —
 * `"Marshall 1959SLP"`, `"1959slp normal"`, and `0` all resolve the
 * same entry.
 *
 * Returns `undefined` if no match is found or the param is not an enum.
 * Callers should treat that as an invalid user input.
 */
export function resolveEnumValue(param: Param, input: number | string): number | undefined {
  if (param.unit !== 'enum' || !param.enumValues) return undefined;
  if (typeof input === 'number') {
    return param.enumValues[input] !== undefined ? input : undefined;
  }
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  // Exact match first (fast path + most accurate).
  for (const [idx, name] of Object.entries(param.enumValues)) {
    if (name === trimmed) return Number(idx);
  }

  // Relaxed match: lowercase, collapse non-alphanumeric to single space.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = normalize(trimmed);
  for (const [idx, name] of Object.entries(param.enumValues)) {
    if (normalize(name) === target) return Number(idx);
  }

  // Substring fallback: pick the entry whose normalized name contains
  // the query (or vice-versa). Only accept unambiguous matches — if
  // more than one entry qualifies, bail rather than pick arbitrarily.
  const hits: number[] = [];
  for (const [idx, name] of Object.entries(param.enumValues)) {
    const n = normalize(name);
    if (n.includes(target) || target.includes(n)) hits.push(Number(idx));
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Find every enum entry that matches the input under the substring rule
 * used by `resolveEnumValue`. Returns `[indices, names]` of all hits.
 *
 * Used by the validation error path to tell the agent EXACTLY which
 * candidates a partial name like "Room" or "Plate" matched, instead of
 * the previous "first 8 valid names from offset 0" hint that listed
 * names regardless of relevance. Founder-driven ( Lamb-of-God
 * test): agent passed `reverb.type = "Room"`, hit the ambiguous-bail
 * branch, and the error sample showed Room, Small / Room, Medium /
 * Room, Large / Hall, Small / Hall, Medium … — the Hall entries were
 * noise. With this helper we can show only the matched candidates.
 */
export function findEnumCandidates(
  param: Param,
  input: string,
): Array<{ index: number; name: string }> {
  if (param.unit !== 'enum' || !param.enumValues) return [];
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = normalize(input.trim());
  if (target === '') return [];
  const hits: Array<{ index: number; name: string }> = [];
  for (const [idx, name] of Object.entries(param.enumValues)) {
    const n = normalize(name);
    if (n.includes(target) || target.includes(n)) {
      hits.push({ index: Number(idx), name });
    }
  }
  return hits;
}

/**
 * Common-synonym aliases for parameter names. Maps a `${block}.${alias}`
 * key to the canonical `${block}.${name}` registered in KNOWN_PARAMS.
 *
 * Why this exists. AM4-Edit / Fractal docs use specific names ("time"
 * for both reverb decay and delay repeat time, "rate" for modulation
 * LFO speed, "feedback" for delay repeats). LLM agents reach for the
 * synonyms most common in the gear world ("decay" for reverb, "speed"
 * for modulation, "repeats" for delay) and hit unknown-param errors
 * even though the registered param does the same thing. This map
 * intercepts the well-established universal synonyms before the
 * unknown-param error fires, returning the canonical name silently so
 * the agent's first call lands.
 *
 * Conservative scope. Only synonyms that are universally accepted in
 * music gear documentation (Fractal manual, Boss/Roland docs, synth
 * world). No clever mapping — if there's any ambiguity ("size" could
 * be reverb size or chamber size or amp room size), don't add the
 * alias and let the agent's first error teach it.
 *
 * Founder-driven (2026-05-02): Lamb-of-God Mark Morton tone
 * test had the agent reach for `reverb.decay` (universal synthesizer
 * term) and `reverb.length` (less common but plausible) — both meant
 * `reverb.time`. Aliases prevent the round-trip-and-fix cost that this
 * test had to pay.
 */
export const PARAM_ALIASES: Record<string, string> = {
  // Reverb time = decay (universal synth/reverb-pedal term).
  'reverb.decay': 'reverb.time',
  'reverb.length': 'reverb.time',
  // Delay time = length (less common but plausible from compact-pedal docs).
  'delay.length': 'delay.time',
  // Delay feedback = repeats (Strymon / Eventide convention) or regen /
  // regeneration (the term Fractal's own Blocks Guide uses, "feedback
  // a.k.a. regeneration"). Same musician-vocabulary class as repeats.
  'delay.repeats': 'delay.feedback',
  'delay.regen': 'delay.feedback',
  'delay.regeneration': 'delay.feedback',
  // Modulation rate = speed (Boss / MXR convention).
  'chorus.speed': 'chorus.rate',
  'flanger.speed': 'flanger.rate',
  'phaser.speed': 'phaser.rate',
  'tremolo.speed': 'tremolo.rate',
  'rotary.speed': 'rotary.rate',
  // Phaser/flanger feedback = regen / regeneration — same alias class
  // as delay above. Fractal's Blocks Guide refers to flanger and phaser
  // feedback as "regeneration" / "resonance" in the prose for both
  // blocks (see param-descriptions.json flanger.feedback +
  // phaser.feedback entries in mcp-midi-control).
  'phaser.regen': 'phaser.feedback',
  'phaser.regeneration': 'phaser.feedback',
  'flanger.regen': 'flanger.feedback',
  'flanger.regeneration': 'flanger.feedback',
  // Panel-name vs AM4-name mismatches surfaced 2026-05-05:
  // vintage Fender amps display "Volume" on the front panel but AM4
  // calls the same knob `gain`; drive panels say "Drive" but agents
  // reach for "gain" by analogy with amp.
  'amp.volume': 'amp.gain',
  'drive.gain': 'drive.drive',
  // NOTE: 'reverb.pre_delay' alias removed — canonical key is now
  // 'reverb.pre_delay' itself (renamed from 'reverb.predelay' for
  // UI-label match, audit row REVERB 19).
};

/**
 * Scene-MIDI Type enum (PATCH family, pidHigh row 0x40..0x4F).
 *
 * AM4-Edit's UI exposes only Program Change and Control Change as
 * available message types ("The available message types are Program
 * Change (PC) and Control Change (CC)" — AM4-Edit Scene MIDI page
 * help text). The wire encoding folds the CC number into the Type
 * enum itself:
 *
 *   wire 0   → 'None'        (no message — Channel/Value greyed out)
 *   wire 1   → 'PC'          (Program Change — uses Channel + Value)
 *   wire N≥2 → 'CC #(N-2)'   (Control Change with CC# = N-2)
 *
 * Wire-confirmed against samples/captured/session-85-scene-midi.pcapng
 * (Type=1.0 for PC) and the founder's AM4-Edit screenshot showing
 * "CC #016" displayed when wire Type=18.0 (16 + 2 = 18).
 *
 * Display names use AM4-Edit's exact format: `CC #016` (zero-padded to
 * 3 digits, with a space and hash). Keep parity with what the user
 * reads on screen — `resolveEnumValue` matches by display string.
 */
export const SCENE_MIDI_TYPE_ENUM: Record<number, string> = (() => {
  const out: Record<number, string> = { 0: 'None', 1: 'PC' };
  for (let cc = 0; cc <= 127; cc++) {
    out[cc + 2] = `CC #${cc.toString().padStart(3, '0')}`;
  }
  return out;
})();

/**
 * Runtime parameter registry. Hand-authored entries (manual unit/range
 * overrides, out-of-band registers like `*.channel` / `*.level`,
 * hand-authored enum mappings, etc.) are listed explicitly below.
 * Resolver-derived entries flow in via `...CACHE_PARAMS` — that spread
 * imports the bulk auto-generated bindings synthesized by
 * `scripts/gen-params-from-cache.ts` from the AM4-Edit metadata cache,
 * with friendly names from `paramNames.ts` (hand-curated) merged with
 * `paramNamesGenerated.ts` (resolver-derived from AM4-Edit.exe). Order
 * matters: hand entries below shadow any same-key spread entry, so a
 * hand override always wins. `verify-cache-params.ts` enforces that
 * any hand override that COLLIDES with a CACHE_PARAMS entry must agree
 * byte-for-byte (pidLow/pidHigh/unit/displayMin/displayMax/scaling) —
 * pure additions are unconstrained.
 *
 * 2026-06-09 accuracy pass: the amp banks (pidLow 0x3a / 0x3e) and the
 * typecode family-4/5 taper set were corrected from the 2026-06-09
 * zero-resync cache walk (effectDefinitions_15_2p0, solved record
 * grammar). The log10 taper family is hardware-anchored: an Axe-Fx II
 * family-4 Hz knob reads exactly the geometric mean of its range at
 * 12 o'clock. Per-entry provenance comments predating that pass
 * describe observed VALUES (screenshots), which remain compatible
 * with the corrected ranges.
 */
export const KNOWN_PARAMS = {
  ...CACHE_PARAMS,
  // ====================================================================
  // Amp GHOST params from the cache oracle (DISTORT section 10, pidLow
  // 0x3a) — the 10 genuinely-unregistered HW-129 GHOSTs. Ranges/labels
  // sourced from the SOLVED effectDefinitions_15_2p0 cache walk (the
  // AM4-native oracle HW-129 said did not exist).
  //
  // HARDWARE-CONFIRMED 2026-06-10 (probe-am4-deep-verify, pass B): the 6
  // type-code enums (biastype/precomptype/cliptype2/drivetype/tonetype/
  // fbtype) each ROSTER-SIZE-CONFIRMED device-side — a write at the
  // cache's count clamps to count-1, matching the cache roster exactly
  // (n=3/2/13/8/138/69). The 4 continuous GHOSTs (xfleakage/offset1/
  // wshpf/pi_ratio) read back in-range (pass A). Spread here so a later
  // hand override could still win. Per the shipping bar these ship as
  // community-beta: ranges device-true, enum LABEL text is the cache's
  // (AM4 echoes no label over MIDI, so labels are untested by a glance);
  // type codes are amp-model-internal — recommend read-only use.
  ...AMP_GHOST_PARAMS,
  'amp.gain': {
    block: 'amp', name: 'gain',
    displayLabel: 'Gain',
    pidLow: 0x003a, pidHigh: 0x000b,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.bass': {
    block: 'amp', name: 'bass',
    displayLabel: 'Bass',
    pidLow: 0x003a, pidHigh: 0x000c,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // P1-010 Session B (2026-04-19) — AM4 tone stack completion. Cache
  // records at ids 13/14/15 have the identical signature to gain/bass
  // (knob_0_10, 0..1 range, display-scale 10). Named per AM4 Owner's
  // Manual line 1563 "Gain, Bass, Mid, Treble, Presence, Level" and
  // the Fractal Blocks Guide tone-stack order (§Tone Page, pp. 9–10).
  //  verified: mid / treble / presence / bass
  // all wrote and displayed correctly on hardware.
  'amp.mid': {
    block: 'amp', name: 'mid',
    displayLabel: 'Mid',
    pidLow: 0x003a, pidHigh: 0x000d,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.treble': {
    block: 'amp', name: 'treble',
    displayLabel: 'Tone',
    pidLow: 0x003a, pidHigh: 0x000e,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // `pidHigh=0x000f` was wrongly registered as
  // amp.presence based on cache signature alone. Two
  // wire captures on Marshall-family amps (unknown amp + Brit 800
  // #34) proved the register is Master. Real Presence is at
  // pidHigh=0x001e (below).
  'amp.master': {
    block: 'amp', name: 'master',
    displayLabel: 'Master',
    pidLow: 0x003a, pidHigh: 0x000f,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // full 0→10 sweep capture confirmed Depth at
  // pidHigh=0x001a. Knob_0_10 matches the cache signature.
  'amp.depth': {
    block: 'amp', name: 'depth',
    displayLabel: 'Depth',
    pidLow: 0x003a, pidHigh: 0x001a,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // Presence at pidHigh=0x001e (not 0x000f — see
  // amp.master above). Wire-verified on the same Marshall amp.
  'amp.presence': {
    block: 'amp', name: 'presence',
    displayLabel: 'Presence',
    pidLow: 0x003a, pidHigh: 0x001e,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // Out Boost Level on the Extras tab, dB knob
  // 0..4 dB with 0.05 dB steps.
  'amp.out_boost_level': {
    block: 'amp', name: 'out_boost_level',
    pidLow: 0x003a, pidHigh: 0x0008,
    unit: 'db', displayMin: 0, displayMax: 4,
  },
  // Out Boost ON/OFF toggle on the Extras tab.
  // Registered directly in KNOWN_PARAMS (out-of-band from the cache
  // generator because per-block non-Type enum imports aren't
  // supported). Wire-verified via session-29-amp-out-boost-toggle:
  // value=1.0 → ON.
  'amp.out_boost': {
    block: 'amp', name: 'out_boost',
    displayLabel: 'Out Boost',
    pidLow: 0x003a, pidHigh: 0x0096,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  //  cont: Amp Advanced-panel enums registered from Blocks
  // Guide text (structural — wire indexing assumed from cache enum
  // order). Out-of-band from the cache generator for the same reason
  // amp.out_boost is: the generator emits only the block's Type enum,
  // not its other enum records.  couldn't verify these from
  // the hardware display alone (both labels are hidden by the AM4
  // hardware UI); AM4-Edit would show them. Structural-only until
  // an AM4-Edit-side verification pass.
  //
  // Tonestack Location (not Type — Type is a separate 69-value enum).
  // Blocks Guide: "POST places the stack between the preamp and
  // power amp. MID places it between the last two triode stages.
  // END places it after the power amp (physically impossible with
  // a real amp)." PRE-MID is the 5th option.
  // renamed for UI-label match (audit row: DISTORT 24)
  'amp.location': {
    block: 'amp', name: 'location',
    displayLabel: 'Location',
    pidLow: 0x003a, pidHigh: 0x0018,
    unit: 'enum', displayMin: 0, displayMax: 4,
    enumValues: { 0: 'PRE', 1: 'POST', 2: 'MID', 3: 'END', 4: 'PRE-MID' },
  },
  // Master Volume Location. Blocks Guide §Advanced (p. 853):
  // "Master Vol Location — Sets the location of the Master Volume
  // control. Most amps have the Master Volume before the phase
  // inverter ('Pre PI'). On some amps (like the 'Class-A' types)
  // the Master Volume comes after the phase inverter ('PI'). A
  // third option, 'pre-triode,' is the default for 'Hipower' amp
  // types."
  'amp.master_vol_location': {
    block: 'amp', name: 'master_vol_location',
    displayLabel: 'Master Vol Location',
    pidLow: 0x003a, pidHigh: 0x0038,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'PRE-PI', 1: 'POST-PI', 2: 'PRE-TRIODE' },
  },
  // 2026-04-29: Amp Expert-Edit page from
  // session-40-amp-expert.pcapng + paired AM4-Edit screenshot
  // (FAS Modern III). 17 new params across BASIC + IDEAL + POST
  // BOOST + CHANNEL COLORS + OUTPUT COMPRESSOR + AMP EXTRAS + GEQ
  // sections. Wiggle-order timeline + screenshot column order
  // disambiguates the OFF/ON switches in the IDEAL column. Mirrored
  // from CACHE_PARAMS where applicable; hand-authored enums + the
  // cache-derived block of `bright_cap` / `input_trim` / GEQ bands /
  // `compressor_*` / `master_vol_trim` / `high_treble`.
  //
  // One open follow-up: pidHigh=0x0085 (cache id=133, enum [OFF,ON],
  // wire 1 = ON) is unmapped — wiggled between Master Vol Trim and
  // GEQ Type but doesn't fit a screenshot label cleanly. Likely a
  // POST BOOST related toggle or an amp-mode flag; needs a single
  // disambiguation capture to confirm.
  'amp.bypass_mode': {
    block: 'amp', name: 'bypass_mode',
    pidLow: 0x003a, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Thru', 1: 'Mute' },
  },
  'amp.bright_cap': {
    block: 'amp', name: 'bright_cap',
    displayLabel: 'Bright Cap',
    pidLow: 0x003a, pidHigh: 0x0014,
    // Cache id=20: float a=0.00001 b=0.01 c=1000000 → wire 0.00001..0.01
    // displays as 10..10000 pF. New `pf` unit (scale 1000000).
    unit: 'pf', displayMin: 10, displayMax: 10000,
    // typecode 72 = log10 —  hardware-confirmed (write 220 → AM4 220 ✓; linear readback gave 4480)
    scaling: 'log10',
  },
  'amp.input_select': {
    block: 'amp', name: 'input_select',
    displayLabel: 'Amp Input Select',
    pidLow: 0x003a, pidHigh: 0x0019,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'LEFT', 1: 'RIGHT', 2: 'SUM L+R' },
  },
  'amp.section': {
    block: 'amp', name: 'section',
    displayLabel: 'Amp Section',
    pidLow: 0x003a, pidHigh: 0x0023,
    // AMP EXTRAS.Amp Section toggle.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'ENGAGED', 1: 'BYPASSED' },
  },
  'amp.bright': {
    block: 'amp', name: 'bright',
    displayLabel: 'Bright',
    pidLow: 0x003a, pidHigh: 0x002e,
    // BASIC.Bright toggle. Wiggle-order adjacency pins this between
    // Depth (0x001a) and Master (0x000f) in the BASIC column.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'amp.cut_switch': {
    block: 'amp', name: 'cut_switch',
    displayLabel: 'Cut Switch',
    pidLow: 0x003a, pidHigh: 0x0034,
    // IDEAL.Cut Switch — wiggle adjacency pins it between High Treble
    // (0x0068) and Fat Switch (0x0055) in the IDEAL column.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'amp.input_trim': {
    block: 'amp', name: 'input_trim',
    displayLabel: 'Input Trim',
    pidLow: 0x003a, pidHigh: 0x0036,
    // Cache id=54: float a=0.1 b=10 c=1 raw 0.1..10. Same shape as
    // master_vol_trim; `count` here is structural (display = wire ×
    // 1) not integer-only.
    unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10',
  },
  // 8-band Graphic EQ — frequencies per the screenshot: 62/125/250/
  // 500/1K/2K/4K/8K Hz, each ±12 dB. Cache ids 62..69 share the
  // (a=-1, b=1, c=12) signature: wire stored as ±1, displayed as ±12 dB.
  // Uses the `amp_geq_band` unit (scale 12). Drive's GEQ uses plain `db`
  // because its cache stores ±12 directly (c=1).
  'amp.geq_band_1': { block: 'amp', name: 'geq_band_1', displayLabel: 'Bass', pidLow: 0x003a, pidHigh: 0x003e, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  'amp.geq_band_2': { block: 'amp', name: 'geq_band_2', displayLabel: 'Mid', pidLow: 0x003a, pidHigh: 0x003f, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  'amp.geq_band_3': { block: 'amp', name: 'geq_band_3', displayLabel: 'Treble', pidLow: 0x003a, pidHigh: 0x0040, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  'amp.geq_band_4': { block: 'amp', name: 'geq_band_4', displayLabel: 'Presence', pidLow: 0x003a, pidHigh: 0x0041, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  'amp.geq_band_5': { block: 'amp', name: 'geq_band_5', displayLabel: '1K', pidLow: 0x003a, pidHigh: 0x0042, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  'amp.geq_band_6': { block: 'amp', name: 'geq_band_6', displayLabel: '2K', pidLow: 0x003a, pidHigh: 0x0043, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  'amp.geq_band_7': { block: 'amp', name: 'geq_band_7', displayLabel: '4K', pidLow: 0x003a, pidHigh: 0x0044, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  'amp.geq_band_8': { block: 'amp', name: 'geq_band_8', displayLabel: '8K', pidLow: 0x003a, pidHigh: 0x0045, unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
  // renamed for UI-label match (audit row: DISTORT 77)
  'amp.clarity': {
    block: 'amp', name: 'clarity',
    displayLabel: 'Clarity',
    pidLow: 0x003a, pidHigh: 0x004d,
    // typecode 80 = log10. displayMin 0.1 per the corrected cache walk,
    // so the log10 decode actually fires (the old 0 floor forced the
    // linear fallback).
    unit: 'knob_0_10', displayMin: 0.1, displayMax: 10,
    scaling: 'log10',
  },
  // renamed for UI-label match (audit row: DISTORT 82)
  'amp.amount': {
    block: 'amp', name: 'amount',
    displayLabel: 'Amount',
    pidLow: 0x003a, pidHigh: 0x0052,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // renamed for UI-label match (audit row: DISTORT 83)
  'amp.threshold': {
    block: 'amp', name: 'threshold',
    displayLabel: 'Threshold',
    pidLow: 0x003a, pidHigh: 0x0053,
    unit: 'db', displayMin: -60, displayMax: 0,
  },
  'amp.master_vol_trim': {
    block: 'amp', name: 'master_vol_trim',
    displayLabel: 'Master Vol Trim',
    pidLow: 0x003a, pidHigh: 0x0054,
    unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10',
    //  readback surfaced "7 count" — misleading. AM4 displays
    // this as a unitless 0..10 knob; the `count` unit tag is
    // structural (encode scale 1, cache c=1). Suppress the suffix.
    displayUnit: '',
  },
  // renamed for UI-label match (audit row: DISTORT 85)
  'amp.fat': {
    block: 'amp', name: 'fat',
    displayLabel: 'Fat',
    pidLow: 0x003a, pidHigh: 0x0055,
    // IDEAL.Fat Switch — wiggle adjacency pins it right after Cut
    // Switch (0x0034) in the IDEAL column.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'amp.geq_type': {
    block: 'amp', name: 'geq_type',
    displayLabel: 'Type',
    pidLow: 0x003a, pidHigh: 0x0063,
    // Cache section 10 id=99: 11-entry enum (the old misframed parse saw 4).
    unit: 'enum', displayMin: 0, displayMax: 10,
    enumValues: {
      0: '8 BAND VAR Q', 1: '7 BAND VAR Q', 2: '5 BAND (MARK)', 3: '8 BAND CONST Q',
      4: '7 BAND CONST Q', 5: '5 BAND CONST Q', 6: '5 BAND PASSIVE', 7: '4 BAND PASSIVE',
      8: '3 BAND PASSIVE', 9: '3 BAND CONSOLE', 10: '4 BAND JMPRE-1',
    },
  },
  'amp.high_treble': {
    block: 'amp', name: 'high_treble',
    displayLabel: 'High Treble',
    pidLow: 0x003a, pidHigh: 0x0068,
    // IDEAL.High Treble — bipolar dB ±12 at cache id=104.
    unit: 'db', displayMin: -12, displayMax: 12,
  },
  'amp.compressor_type': {
    block: 'amp', name: 'compressor_type',
    displayLabel: 'Type',
    pidLow: 0x003a, pidHigh: 0x0074,
    // Cache id=116: 3-entry enum.
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OUTPUT', 1: 'FEEDBACK', 2: 'GAIN ENHANCER' },
  },
  'amp.output_mode': {
    block: 'amp', name: 'output_mode',
    displayLabel: 'Amp Output Mode',
    pidLow: 0x003a, pidHigh: 0x0083,
    // Cache id=131: 2-entry enum.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'FRFR', 1: 'SS PWR AMP + CAB' },
  },
  // 2026-04-25: hardware-verified at
  // +8 dB on a 1959SLP Normal — first non-default positive-value
  // datapoint for amp.level ( only tested at the default).
  'amp.level': {
    block: 'amp', name: 'level',
    pidLow: 0x003a, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'amp.channel': {
    block: 'amp', name: 'channel',
    pidLow: 0x003a, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    // : A→B→A and A→C→D→A captures confirmed all 4 indices.
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  'amp.type': {
    block: 'amp', name: 'type',
    pidLow: 0x003a, pidHigh: 0x000a,
    // : enum dictionary imported from cacheEnums.ts (248 models).
    // Wire indexing verified via drive.type ground truth; amp.type index
    // 0 in cache is "1959SLP Normal". Untested against capture — flag as
    // such when hardening.
    unit: 'enum', displayMin: 0, displayMax: 247,
    enumValues: AMP_TYPES_VALUES,
  },

  // ─── 2026-04-30: Amp Expert-Edit page (4 tabs) ───
  // Source: session-41-amp-{preamp,poweramp,cabinet,speaker}-expert.{pcapng,png}
  // + founder-confirmed audit-input JSONs at docs/audit-input/amp-*.json.
  // Audit script output: docs/audit-output/amp-*.md.
  //
  // The amp Expert page surfaces ~120 knobs across Preamp / Power Amp /
  // Cabinet / Speaker tabs — far more than the 16 BASIC params already
  // registered. Cabinet knobs use a SEPARATE block ID (pidLow=0x003e),
  // not the amp pidLow=0x003a; preamp/power-amp/speaker share 0x003a.
  // Block prefix is kept as `amp` since AM4 surfaces all four tabs as
  // one user-facing block, even though the protocol splits cabinet out.
  //
  // Naming: knobs are keyed by their AM4-Edit label, snake-cased, with
  // disambiguating prefixes where labels collide between sections (e.g.
  // `power_tube_hardness` vs preamp `tube_hardness`, `pi_bias_excursion`
  // vs `master_bias_excursion`, speaker `spkr_compression` vs the
  // amp Compressor section's `compressor_amount`/`compressor_clarity`).
  //
  // Verification: ⚠ unregistered rows from the audit table where the
  // wire×scale match was uniquely-on-the-label-side OR where ambiguity
  // was resolved by domain reasoning (scale plausibility + screenshot
  // section position). Ambiguous rows where neither candidate label is
  // unique on the label side were skipped — those need a follow-up
  // capture wiggling one of the colliding knobs in isolation.
  //
  // Skipped from audit (need follow-up):
  //   • Preamp 0x0082 (Input EQ Low Cut duplicate at scale ×10)
  //   • Power Amp 0x005d / 0x0090 (Cathode Resistance vs Master Bias
  //     Excursion duplicates at wire=1.0)
  //   • Power Amp 0x0026 / 0x0064 / 0x008d / 0x0093 (no screenshot match)
  //   • Cabinet 0x001c (audit guessed "Cab 1 Low Cut, log-Hz storage";
  //     the 2026-06-09 cache walk shows 0x1c is a percent register,
  //     raw 0..1 scale 100, so the audit label-join was wrong there)
  //   • Cabinet 0x0045 / 0x0046 (Cab 1/2 Position — bipolar -10..10
  //     range needs new unit, no existing fit)
  //   • Cabinet 0x0024 / 0x002c / 0x0030 / 0x0031 (LF/HF Damping —
  //     three pidHighs share value 8.0, can't disambiguate)
  //   • Cabinet 0x0011 + 0x0016 + 0x0017 + many wire=1.0 rows (no
  //     screenshot match or false-positive ×10 scale matches)
  //   • Speaker 0x0022 / 0x0033 / 0x0039 / 0x0048 / 0x0087 / 0x008e /
  //     0x0092 (Low/Hi Reso, Drive, others not wiggled or scale TBD)
  //
  // ── Preamp tab (pidLow=0x003a) ──
  'amp.in_boost_level': {
    block: 'amp', name: 'in_boost_level',
    displayLabel: 'In Boost Level',
    pidLow: 0x003a, pidHigh: 0x0081,
    // Preamp.Input Boost section. Screenshot 1.11 dB (no unit visible
    // but Boost knobs are conventionally dB on Fractal).
    unit: 'db', displayMin: 0, displayMax: 24,
  },
  'amp.saturation_drive': {
    block: 'amp', name: 'saturation_drive',
    displayLabel: 'Saturation Drive',
    pidLow: 0x003a, pidHigh: 0x0070,
    // Preamp.Saturation Mod.Saturation Drive. Screenshot 2.220, no
    // visible unit on AM4-Edit panel; treated as raw count.
    unit: 'count', displayMin: 1, displayMax: 10,
  },
  'amp.tonestack_frequency': {
    block: 'amp', name: 'tonestack_frequency',
    displayLabel: 'Frequency',
    pidLow: 0x003a, pidHigh: 0x0012,
    // Preamp.Tonestack.Frequency. Screenshot 333.0 Hz raw.
    unit: 'hz', displayMin: 200, displayMax: 2000,
    scaling: 'log10',
  },
  'amp.tube_hardness': {
    block: 'amp', name: 'tube_hardness',
    displayLabel: 'Tube Hardness',
    pidLow: 0x003a, pidHigh: 0x0037,
    // Preamp.Preamp.Tube Hardness — knob_0_10 (wire 0.444 → display 4.44).
    // Distinct from amp.power_tube_hardness on the Power Amp tab.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.triode_1_plate_freq': {
    block: 'amp', name: 'triode_1_plate_freq',
    displayLabel: 'Triode 1 Plate Freq',
    pidLow: 0x003a, pidHigh: 0x004a,
    unit: 'hz', displayMin: 400, displayMax: 40000,
    scaling: 'log10',
  },
  'amp.triode_2_plate_freq': {
    block: 'amp', name: 'triode_2_plate_freq',
    displayLabel: 'Triode 2 Plate Freq',
    pidLow: 0x003a, pidHigh: 0x0049,
    unit: 'hz', displayMin: 400, displayMax: 40000,
    scaling: 'log10',
  },
  'amp.preamp_bias': {
    block: 'amp', name: 'preamp_bias',
    displayLabel: 'Preamp Bias',
    pidLow: 0x003a, pidHigh: 0x0031,
    // Screenshot -0.700 raw — bipolar count.
    unit: 'count', displayMin: -1, displayMax: 1,
  },
  'amp.preamp_bias_excursion': {
    block: 'amp', name: 'preamp_bias_excursion',
    displayLabel: 'Bias Excursion',
    pidLow: 0x003a, pidHigh: 0x0071,
    // Preamp.Preamp.Bias Excursion — percent (wire 0.080 → display 8.0%).
    // Distinct from amp.power_tube_bias_excursion / amp.pi_bias_excursion
    // / amp.master_bias_excursion on the Power Amp tab.
    unit: 'percent', displayMin: 0, displayMax: 200,
  },
  // renamed for UI-label match (audit row: DISTORT 17)
  'amp.high_cut_frequency': {
    block: 'amp', name: 'high_cut_frequency',
    displayLabel: 'High Cut Frequency',
    pidLow: 0x003a, pidHigh: 0x0011,
    // Preamp.Preamp.High Cut Frequency — bottom row of the PREAMP
    // section. Screenshot 9999.1 Hz raw.
    unit: 'hz', displayMin: 400, displayMax: 40000,
    scaling: 'log10',
  },
  // renamed for UI-label match (audit row: DISTORT 16)
  'amp.low_cut': {
    block: 'amp', name: 'low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x003a, pidHigh: 0x0010,
    // Preamp.Input EQ.Low Cut. Screenshot 130.0 Hz raw.
    unit: 'hz', displayMin: 10, displayMax: 1000,
    scaling: 'log10',
  },
  'amp.input_eq_gain': {
    block: 'amp', name: 'input_eq_gain',
    displayLabel: 'Gain',
    pidLow: 0x003a, pidHigh: 0x0050,
    // Preamp.Input EQ.Gain. Screenshot 11.00 dB raw.
    unit: 'db', displayMin: -20, displayMax: 20,
  },
  // renamed for UI-label match (audit row: DISTORT 78)
  'amp.q': {
    block: 'amp', name: 'q',
    displayLabel: 'Q',
    pidLow: 0x003a, pidHigh: 0x004e,
    // Preamp.Input EQ.Q. Screenshot 0.120 raw count.
    unit: 'count', displayMin: 0.1, displayMax: 10,
    // typecode 64 = log10 ( cont audit)
    scaling: 'log10',
  },

  // ── Power Amp tab (pidLow=0x003a) ──
  'amp.supply_sag': {
    block: 'amp', name: 'supply_sag',
    displayLabel: 'Supply Sag',
    pidLow: 0x003a, pidHigh: 0x001d,
    // Power Amp.Power Supply.Supply Sag. Screenshot 2.20 (knob_0_10:
    // wire 0.220 → display 2.20). Disambiguated from Power Tubes Hardness
    // (which sits at 0x005f wire=0.700 → display 7.00).
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // renamed for UI-label match (audit row: DISTORT 31)
  'amp.negative_fb': {
    block: 'amp', name: 'negative_fb',
    displayLabel: 'Negative FB',
    pidLow: 0x003a, pidHigh: 0x001f,
    // Power Amp.Power Amp.Negative Feedback. Screenshot 4.44 — percent
    // ×100 (wire 0.0444 → 4.44%). NFB display has no visible unit on
    // AM4-Edit; ×100 scale fits the captured wire cleanly.
    unit: 'percent', displayMin: 0, displayMax: 10,
    //  readback surfaced "5 percent" — misleading. AM4 actually
    // displays NFB as a unitless 0..10 knob; the `percent` unit is
    // for encode-scale only (cache c=100). Suppress the suffix.
    displayUnit: '',
    //  cont audit: : cache b*c = 10, not 100. Hand entry was off by 10×; readback came out 50 instead of 5.
  },
  'amp.presence_freq': {
    block: 'amp', name: 'presence_freq',
    displayLabel: 'Presence Freq',
    pidLow: 0x003a, pidHigh: 0x0020,
    // 2026-05-04: cache record at id=32 has a=0.1, b=10, c=1.
    // The original  screenshot read "6.660 Hz raw" but the AM4
    // device actually displays the value as 0.1..10 (kHz on the device,
    // shown without explicit unit suffix). Earlier registration of
    // displayMin=20 displayMax=20000 was off by ~1000× and saturated
    // every write. Range corrected to match the cache truth; unit kept
    // as 'hz' so agent reads it as a frequency knob (the agent should
    // pass values in the 0.1..10 range, which AM4-Edit renders as kHz).
    unit: 'hz', displayMin: 0.1, displayMax: 10,
    //  readback surfaced "3 hz" — agent then mentally translated
    // to kHz, awkward. Override the suffix to 'kHz' so the readback
    // matches the user's mental model. Encoding is unaffected.
    displayUnit: 'kHz',
    // typecode 64 = log10 ( confirmed: write 3 → AM4 3.000 ✓ but readback was 7 with linear decode)
    scaling: 'log10',
  },
  'amp.depth_freq': {
    block: 'amp', name: 'depth_freq',
    displayLabel: 'Depth Freq',
    pidLow: 0x003a, pidHigh: 0x0024,
    // 2026-05-04: cache record at id=36 has a=50, b=500, c=1.
    // Same screenshot-misread pattern as presence_freq. Range corrected
    // to the cache truth (50..500 Hz, real Hz this time).
    unit: 'hz', displayMin: 50, displayMax: 500,
    scaling: 'log10',
  },
  // renamed for UI-label match (audit row: DISTORT 40)
  'amp.harmonics': {
    block: 'amp', name: 'harmonics',
    displayLabel: 'Harmonics',
    pidLow: 0x003a, pidHigh: 0x0028,
    // Power Amp.Cathode Follower.Harmonics. Screenshot 0.150 Hz —
    // raw value (label says "Hz" but the magnitude reads as a 0..1
    // ratio, likely a normalised knob despite the unit suffix).
    unit: 'count', displayMin: 0, displayMax: 1,
  },
  'amp.b_plus_time_constant': {
    block: 'amp', name: 'b_plus_time_constant',
    displayLabel: 'B+ Time Constant',
    pidLow: 0x003a, pidHigh: 0x002a,
    // Power Amp.Power Supply.B+ Time Constant. Screenshot 9.50 ms
    // (wire 0.0095 ×1000 = 9.5).
    // typecode 68 = log10 ( cont audit)
    unit: 'ms', displayMin: 1, displayMax: 100,
    scaling: 'log10',
  },
  'amp.grid_bias': {
    block: 'amp', name: 'grid_bias',
    displayLabel: 'Grid Bias',
    pidLow: 0x003a, pidHigh: 0x002b,
    // Power Amp.Power Tubes.Grid Bias. Screenshot 16.0 % (wire 0.160).
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.xformer_drive': {
    block: 'amp', name: 'xformer_drive',
    displayLabel: 'XFormer Drive',
    pidLow: 0x003a, pidHigh: 0x0035,
    // Power Amp.Transformer.XFormer Drive. Screenshot 0.120 raw count.
    // typecode 64 = log10 ( cont audit)
    unit: 'count', displayMin: 0.01, displayMax: 10,
    scaling: 'log10',
  },
  'amp.xformer_matching': {
    block: 'amp', name: 'xformer_matching',
    displayLabel: 'XFormer Matching',
    pidLow: 0x003a, pidHigh: 0x003a,
    // Power Amp.Transformer.XFormer Matching. Screenshot 1.300 raw.
    // typecode 64 = log10 ( cont audit)
    unit: 'count', displayMin: 0.5, displayMax: 2,
    scaling: 'log10',
  },
  'amp.screen_frequency': {
    block: 'amp', name: 'screen_frequency',
    displayLabel: 'Screen Frequency',
    pidLow: 0x003a, pidHigh: 0x003b,
    // 2026-05-04: cache record at id=59 has a=1, b=100, c=1.
    // The AM4 device displays this as a unitless 0..100 raw knob (the
    // founder confirmed "no units on device for Screen Frequency"). The
    // earlier "Hz" registration was a screenshot misread. Despite the
    // parameterName ending in "FREQ", the firmware exposes it as a raw
    // power-supply knob without a frequency unit on the device UI.
    unit: 'count', displayMin: 1, displayMax: 100,
    // typecode 64 = log10 ( cont audit)
    scaling: 'log10',
  },
  'amp.screen_q': {
    block: 'amp', name: 'screen_q',
    displayLabel: 'Screen Q',
    pidLow: 0x003a, pidHigh: 0x003c,
    // Power Amp.Power Supply.Screen Q. Screenshot 8.500 raw count.
    unit: 'count', displayMin: 0.1, displayMax: 10,
    // typecode 64 = log10 ( cont audit)
    scaling: 'log10',
  },
  'amp.power_tube_bias_excursion': {
    block: 'amp', name: 'power_tube_bias_excursion',
    displayLabel: 'Bias Excursion',
    pidLow: 0x003a, pidHigh: 0x0046,
    // Power Amp.Power Tubes.Bias Excursion. Screenshot 19.0 %.
    // Distinct from preamp_bias_excursion / pi_bias_excursion /
    // master_bias_excursion (4 separate "bias excursion" knobs).
    unit: 'percent', displayMin: 0, displayMax: 200,
  },
  'amp.ac_line_frequency': {
    block: 'amp', name: 'ac_line_frequency',
    displayLabel: 'AC Line Frequency',
    pidLow: 0x003a, pidHigh: 0x005e,
    // Power Amp.Power Supply.AC Line Frequency. Screenshot 65 Hz raw.
    // Typical range 50/60 Hz mains; AM4-Edit allows wider sweep.
    unit: 'hz', displayMin: 30, displayMax: 100,
  },
  // renamed for UI-label match (audit row: DISTORT 95)
  'amp.hardness': {
    block: 'amp', name: 'hardness',
    displayLabel: 'Hardness',
    pidLow: 0x003a, pidHigh: 0x005f,
    // Power Amp.Power Tubes.Hardness. Screenshot 7.00 (knob_0_10).
    // Distinct from preamp tube_hardness (separate knob, separate
    // wire address).
    // typecode 80 = log10 ( cont audit)
    unit: 'knob_0_10', displayMin: 2.5, displayMax: 40,
    scaling: 'log10',
  },
  'amp.cathode_time_const': {
    block: 'amp', name: 'cathode_time_const',
    displayLabel: 'Cathode Time Const',
    pidLow: 0x003a, pidHigh: 0x0065,
    // Power Amp.Power Amp.Cathode Time Const. Screenshot 10.00 ms
    // (wire 0.010 ×1000 = 10).
    // typecode 68 = log10 ( cont audit)
    unit: 'ms', displayMin: 1, displayMax: 100,
    scaling: 'log10',
  },
  'amp.mismatch': {
    block: 'amp', name: 'mismatch',
    displayLabel: 'Mismatch',
    pidLow: 0x003a, pidHigh: 0x0069,
    // Power Amp.Power Tubes.Mismatch. Screenshot 0.180 raw count.
    unit: 'count', displayMin: -1, displayMax: 1,
  },
  'amp.variac': {
    block: 'amp', name: 'variac',
    displayLabel: 'Variac',
    pidLow: 0x003a, pidHigh: 0x006c,
    // Power Amp.Power Supply.Variac. Screenshot 55.0 % (wire 0.550 ×100).
    unit: 'percent', displayMin: 50, displayMax: 150,
  },
  'amp.pi_bias_excursion': {
    block: 'amp', name: 'pi_bias_excursion',
    displayLabel: 'PI Bias Excursion',
    pidLow: 0x003a, pidHigh: 0x0079,
    // Power Amp.Power Amp.PI Bias Excursion (phase-inverter).
    // Screenshot 11.0 % (wire 0.110 ×100).
    unit: 'percent', displayMin: 0, displayMax: 200,
  },
  'amp.master_bias_excursion': {
    block: 'amp', name: 'master_bias_excursion',
    displayLabel: 'Master Bias Excursion',
    pidLow: 0x003a, pidHigh: 0x008b,
    // Power Amp.Power Tubes.Master Bias Excursion. Screenshot 20.0 %.
    unit: 'percent', displayMin: 0, displayMax: 100,
  },

  // ── Speaker tab (pidLow=0x003a) ──
  // Section breakdown: Impedance (top half — XFormer / Low / Hi knobs +
  // a frequency-response curve) and Speaker (bottom — speaker-emulation
  // character knobs).
  'amp.xformer_low_freq': {
    block: 'amp', name: 'xformer_low_freq',
    displayLabel: 'XFormer Low Freq',
    pidLow: 0x003a, pidHigh: 0x0016,
    // Speaker.Impedance.XFormer Low Freq. Screenshot 33.3 Hz (wire stores
    // 33.33; AM4-Edit display rounds to 1 decimal).
    unit: 'hz', displayMin: 5, displayMax: 500,
    scaling: 'log10',
  },
  'amp.low_freq': {
    block: 'amp', name: 'low_freq',
    displayLabel: 'Low Freq',
    pidLow: 0x003a, pidHigh: 0x0021,
    // Speaker.Impedance.Low Freq. Screenshot 44.4 Hz (wire 44.44).
    unit: 'hz', displayMin: 40, displayMax: 400,
    scaling: 'log10',
  },
  'amp.low_q': {
    block: 'amp', name: 'low_q',
    displayLabel: 'Low Q',
    pidLow: 0x003a, pidHigh: 0x0030,
    // Speaker.Impedance.Low Q. Screenshot 0.666 raw count.
    unit: 'count', displayMin: 0.1, displayMax: 10,
    // typecode 64 = log10 ( cont audit)
    scaling: 'log10',
  },
  'amp.xformer_hi_freq': {
    block: 'amp', name: 'xformer_hi_freq',
    displayLabel: 'XFormer Hi Freq',
    pidLow: 0x003a, pidHigh: 0x0017,
    // Speaker.Impedance.XFormer Hi Freq. Screenshot 12000 Hz raw.
    unit: 'hz', displayMin: 4000, displayMax: 40000,
    scaling: 'log10',
  },
  'amp.high_freq': {
    block: 'amp', name: 'high_freq',
    displayLabel: 'High Freq',
    pidLow: 0x003a, pidHigh: 0x0032,
    // Speaker.Impedance.High Freq. Screenshot 666.0 Hz raw.
    unit: 'hz', displayMin: 400, displayMax: 4000,
    scaling: 'log10',
  },
  'amp.hi_slope': {
    block: 'amp', name: 'hi_slope',
    displayLabel: 'Hi Slope',
    pidLow: 0x003a, pidHigh: 0x006b,
    // Speaker.Impedance.Hi Slope. Screenshot 8.880 (knob_0_10:
    // wire 0.888 ×10 = 8.88). Disambiguated from Speaker.Compression
    // (also wire 0.888) by section-position heuristic — Hi Slope is
    // higher in the AM4-Edit UI (Impedance > Speaker), and 0x006b
    // sits before 0x007a in pidHigh order.
    // typecode 64 = log10 ( cont audit)
    unit: 'knob_0_10', displayMin: 1, displayMax: 10,
    scaling: 'log10',
  },
  'amp.cab_resonance': {
    block: 'amp', name: 'cab_resonance',
    displayLabel: 'Cab Resonance',
    pidLow: 0x003a, pidHigh: 0x0088,
    // Speaker.Impedance.Cab Resonance. Screenshot 111.1 % (wire 1.111
    // ×100). Display can exceed 100% — set displayMax wider.
    unit: 'percent', displayMin: 0, displayMax: 200,
  },
  'amp.speaker_impedance': {
    block: 'amp', name: 'speaker_impedance',
    displayLabel: 'Speaker Impedance',
    pidLow: 0x003a, pidHigh: 0x0086,
    // Speaker.Impedance.Speaker Impedance. Screenshot 1.220 raw count.
    // typecode 64 = log10 ( cont audit)
    unit: 'count', displayMin: 0.5, displayMax: 2,
    scaling: 'log10',
  },
  'amp.spkr_compression': {
    block: 'amp', name: 'spkr_compression',
    displayLabel: 'Compression',
    pidLow: 0x003a, pidHigh: 0x007a,
    // Speaker.Speaker.Compression. Screenshot 8.88 (knob_0_10).
    // Named with `spkr_` prefix to distinguish from the Compressor
    // section's `compression` register (cacheParams.ts pidHigh=0x0057).
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.compliance': {
    block: 'amp', name: 'compliance',
    displayLabel: 'Compliance',
    pidLow: 0x003a, pidHigh: 0x0084,
    // Speaker.Speaker.Compliance. Screenshot 99.0 % (wire 0.990).
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // renamed for UI-label match (audit row: DISTORT 123)
  'amp.time_constant': {
    block: 'amp', name: 'time_constant',
    displayLabel: 'Time Constant',
    pidLow: 0x003a, pidHigh: 0x007b,
    // Speaker.Speaker.Time Constant. Screenshot 1000.0 ms (wire 1.000
    // ×1000). `spkr_` prefix to avoid confusion with cathode_time_const
    // on the Power Amp tab.
    // typecode 68 = log10 ( cont audit)
    unit: 'ms', displayMin: 100, displayMax: 10000,
    scaling: 'log10',
  },
  'amp.thump': {
    block: 'amp', name: 'thump',
    displayLabel: 'Thump',
    pidLow: 0x003a, pidHigh: 0x008f,
    // Speaker.Speaker.Thump. Screenshot 1.11 (knob_0_10).
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },

  // ── Cabinet tab (pidLow=0x003e — separate block ID from amp 0x003a) ──
  'amp.cab1_distance': {
    block: 'amp', name: 'cab1_distance',
    pidLow: 0x003e, pidHigh: 0x0002,
    // Cabinet.Cab 1.Distance. Screenshot 2.22 cm (wire 0.022 ×100).
    // Display unit on AM4-Edit is "cm"; firmware stores cm/100. Cache
    // says the register is bipolar (-100..100); suffix kept as cm.
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
    displayUnit: 'cm',
  },
  'amp.cab_mic_preamp_drive': {
    block: 'amp', name: 'cab_mic_preamp_drive',
    displayLabel: 'Drive',
    pidLow: 0x003e, pidHigh: 0x001a,
    // Cabinet.Cab Mic Preamp.Drive. Screenshot 6.60 (knob_0_10).
    unit: 'knob_0_10', displayMin: 0.01, displayMax: 10,
    scaling: 'log10',
  },
  'amp.cab_mic_preamp_saturation': {
    block: 'amp', name: 'cab_mic_preamp_saturation',
    displayLabel: 'Saturation',
    pidLow: 0x003e, pidHigh: 0x001b,
    // Cabinet.Cab Mic Preamp.Saturation. Screenshot 7.77 (knob_0_10).
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.cab_mic_preamp_treble': {
    block: 'amp', name: 'cab_mic_preamp_treble',
    displayLabel: 'Treble',
    pidLow: 0x003e, pidHigh: 0x0027,
    // Cabinet.Cab Mic Preamp.Treble. Screenshot 10.00 dB raw.
    // (Many wire=1.0 rows in the audit also matched this label via the
    // ×10 scale — those are false positives; the canonical pidHigh
    // is 0x0027 with wire=10.0 raw.)
    unit: 'db', displayMin: -12, displayMax: 12,
  },
  'amp.room_size': {
    block: 'amp', name: 'room_size',
    displayLabel: 'Room Size',
    pidLow: 0x003e, pidHigh: 0x001d,
    // Cabinet.Room.Room Size. Screenshot 5.55 m raw count.
    unit: 'count', displayMin: 3, displayMax: 30,
    scaling: 'log10',
  },
  'amp.mic_spacing': {
    block: 'amp', name: 'mic_spacing',
    displayLabel: 'Mic Spacing',
    pidLow: 0x003e, pidHigh: 0x001e,
    // Cabinet.Room.Mic Spacing. Screenshot 10.1 % (wire 0.101 ×100).
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.cab_master_high_cut': {
    block: 'amp', name: 'cab_master_high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x003e, pidHigh: 0x0020,
    // Cabinet.Cab Master EQ.Master High Cut. Screenshot 222 Hz
    // (founder-confirmed deliberate non-default value).
    // typecode 64 = log10 ( cont audit)
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'amp.cab_master_low_cut': {
    block: 'amp', name: 'cab_master_low_cut',
    displayLabel: 'Proximity Frequency',
    pidLow: 0x003e, pidHigh: 0x0022,
    // Cabinet.Cab Master EQ.Master Low Cut. Screenshot 33.3 Hz raw.
    unit: 'hz', displayMin: 20, displayMax: 200,
    scaling: 'log10',
  },
  'amp.cab_master_level': {
    block: 'amp', name: 'cab_master_level',
    displayLabel: 'Air',
    pidLow: 0x003e, pidHigh: 0x002d,
    // Cabinet.Cab Extras.Cab Master Level. Screenshot 1.1 dB
    // (wire 0.110 ×10 = 1.10). Stored as knob_0_10 even though the
    // display suffix is dB.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.air_frequency': {
    block: 'amp', name: 'air_frequency',
    displayLabel: 'Frequency',
    pidLow: 0x003e, pidHigh: 0x002e,
    // Cabinet.Air.Frequency. Screenshot 12121 Hz raw.
    unit: 'hz', displayMin: 2000, displayMax: 20000,
    scaling: 'log10',
  },
  'amp.room_diffusion': {
    block: 'amp', name: 'room_diffusion',
    displayLabel: 'Room Diffusion',
    pidLow: 0x003e, pidHigh: 0x0032,
    // Cabinet.Room.Room Diffusion. Screenshot 7.0 % (wire 0.070).
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.cab2_low_cut': {
    block: 'amp', name: 'cab2_low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x003e, pidHigh: 0x0036,
    // Cabinet.Cab 2.Low Cut. Screenshot 55.0 Hz raw.
    // typecode 64 = log10 ( cont audit)
    unit: 'hz', displayMin: 20, displayMax: 200,
    scaling: 'log10',
  },
  'amp.cab1_high_cut': {
    block: 'amp', name: 'cab1_high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x003e, pidHigh: 0x0037,
    // Cabinet.Cab 1.High Cut. Screenshot 5500.0 Hz raw.
    unit: 'hz', displayMin: 2000, displayMax: 20000,
    scaling: 'log10',
  },
  'amp.cab2_high_cut': {
    block: 'amp', name: 'cab2_high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x003e, pidHigh: 0x0038,
    // Cabinet.Cab 2.High Cut. Screenshot 4444.1 Hz raw.
    unit: 'hz', displayMin: 2000, displayMax: 20000,
    scaling: 'log10',
  },
  'amp.align_distance_1': {
    block: 'amp', name: 'align_distance_1',
    displayLabel: 'Mic Distance',
    pidLow: 0x003e, pidHigh: 0x0012,
    // Cabinet.Align modal.Distance 1. Screenshot 5.000 ms
    // (wire 0.005 ×1000). Distinct delay-trim knob from Cab 1 Distance.
    unit: 'ms', displayMin: 0, displayMax: 10,
  },
  'amp.align_distance_2': {
    block: 'amp', name: 'align_distance_2',
    displayLabel: 'Mic Distance',
    pidLow: 0x003e, pidHigh: 0x0013,
    // Cabinet.Align modal.Distance 2. Screenshot 6.000 ms.
    unit: 'ms', displayMin: 0, displayMax: 10,
  },

  // 2026-05-17 — CABINET  closeout. 25 new amp
  // params at pidLow=0x003e from the Ghidra CABINET catalog (Sessions
  // 82-83) cross-referenced against the 54-entry  list in
  // samples/captured/decoded/coverage-cross-ref-audit.md. Names chosen
  // to match the AM4-Edit XML display label after norm() (lowercase +
  // non-alphanumeric → _) so each new entry registers as WIRED-MATCHED
  // (not MISLABEL). For paired controls (Cab 1 / Cab 2 sharing a single
  // XML label like "Pan", "Bank", "Mute"), only the "_1" member is
  // added — the "_2" member would force a MISLABEL since both entries
  // can't simultaneously match the same display label and the drift
  // guard ceiling is at 112. Future capture batch may add the _2
  // variants once the renaming pass lowers the MISLABEL count.
  //
  // Units follow the brief: enum (no enumValues — needs capture) for
  // BANK / TYPE / MODE / INPUTSEL / PRETYPE / OVERSAMPLE / ROOMSHAPE;
  // OFF/ON enum for MUTE / AUTO_ALIGN / BYPASS; bipolar_percent for
  // PAN; hz for PROXIMITY / LO-HI-CUT / FREQ; db for LEVEL / DAMPING;
  // count for VU meter (read-only) and other dimensionless knobs.
  // Hand-authored (not via paramNames.ts / gen-params-from-cache.ts)
  // because the CABINET catalog ids live in the Ghidra dispatcher
  // table, not in any S2/S3 cache block — same hand-author pattern as
  // the existing 16 cab_* entries.
  //
  // SKIP rationale (per brief):
  //   - 33 CABINET_ZOOM, 65-68 DYNACAB_TYPE/MIC1/2 — XML display "—"
  //     (no UI evidence, no name to verify against).
  //   - 65000+ CABINET_NAME/LABEL/BTN/PICKER/COPY_MENU/ALIGN_GRAPH —
  //     firmware ghost registers (string-name slots, action buttons),
  //     not user-editable knobs.
  //   - 53 CABINET_LOCUT1 (XML "Low Cut") — would collide with the
  //     existing amp.low_cut at pidLow=0x003a, and using a different
  //     name would force MISLABEL.
  //   - 37 CABINET_BASS (XML "Bass"), 38 CABINET_MID (XML "Mid"),
  //     36 CABINET_PRETYPE (XML "Type") — name collisions with the
  //     existing amp.bass / amp.mid / amp.type at pidLow=0x003a.
  //   - "_2" pair members where the XML label is identical to the
  //     "_1" member's label (BANK2, TYPE2, PAN2, PROXIMITY2, MUTE2,
  //     LOSLOPE2, HISLOPE2, DYNACAB_R2, DYNACAB_Z2) — would force
  //     MISLABEL since both can't match the same display string.
  'amp.bank': {
    block: 'amp', name: 'bank',
    displayLabel: 'Bank',
    pidLow: 0x003e, pidHigh: 0x000a,
    // CABINET_BANK1 (catalog id=10). AM4-Edit "Bank" — cab IR-pack
    // selector. Cache roster has a single entry on this firmware.
    unit: 'enum', displayMin: 0, displayMax: 0,
    enumValues: { 0: 'USER' },
  },
  'amp.cab': {
    block: 'amp', name: 'cab',
    displayLabel: 'Cab #',
    pidLow: 0x003e, pidHigh: 0x000c,
    // CABINET_TYPE1 (catalog id=12). AM4-Edit "Cab #" — cab IR
    // selector within the active bank. Cache: integer 0..255.
    unit: 'count', displayMin: 0, displayMax: 255,
  },
  'amp.pan': {
    block: 'amp', name: 'pan',
    displayLabel: 'Pan',
    pidLow: 0x003e, pidHigh: 0x0010,
    // CABINET_PAN1 (catalog id=16). AM4-Edit "Pan" — cab 1 stereo pan.
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  // SKIP: CABINET_PROXIMITY1 (catalog id=20, XML "Proximity") would
  // collide with the existing CACHE_PARAMS entry `amp.proximity` at
  // pidLow=0x003a / pidHigh=0x15 (the cross-block addressing surfaced
  // by the variant resolver as DISTORT cache id=21). verify-cache-
  // params fails on duplicate-key with conflicting pidLow. Renaming
  // to e.g. `cab_proximity` would force a  since the
  // XML label is "Proximity"; the drift guard ceiling has no
  // headroom. Defer until a  review pass lowers the
  // ceiling and frees a slot.
  'amp.cab_mode': {
    block: 'amp', name: 'cab_mode',
    displayLabel: 'Cab Mode',
    pidLow: 0x003e, pidHigh: 0x0018,
    // CABINET_MODE (catalog id=24). AM4-Edit "Cab Mode" — selects
    // user-cab vs DynaCab routing.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'USER CAB', 1: 'DYNA-CAB' },
  },
  'amp.cab_section': {
    block: 'amp', name: 'cab_section',
    displayLabel: 'Cab Section',
    pidLow: 0x003e, pidHigh: 0x0019,
    // CABINET_BYPASS (catalog id=25). AM4-Edit "Cab Section" — section-
    // level bypass for the cab block (distinct from preset bypass).
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'ENGAGED', 1: 'BYPASSED' },
  },
  'amp.room_level': {
    block: 'amp', name: 'room_level',
    displayLabel: 'Room Level',
    pidLow: 0x003e, pidHigh: 0x001c,
    // CABINET_ROOMMIX (catalog id=28). AM4-Edit "Room Level" — wet/dry
    // mix of the room reflection model into the cab signal.
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.cab_input_mode': {
    block: 'amp', name: 'cab_input_mode',
    displayLabel: 'Cab Input Mode',
    pidLow: 0x003e, pidHigh: 0x0023,
    // CABINET_INPUTSEL (catalog id=35). AM4-Edit "Cab Input Mode" —
    // input routing into the cab block.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'STEREO', 1: 'LEFT', 2: 'RIGHT', 3: 'SUM L+R' },
  },
  'amp.mode': {
    block: 'amp', name: 'mode',
    displayLabel: 'Mode',
    pidLow: 0x003e, pidHigh: 0x0028,
    // CABINET_OVERSAMPLE (catalog id=40). AM4-Edit "Mode" — IR engine
    // quality mode.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'ECONOMY', 1: 'HIGH QUALITY' },
  },
  'amp.floor_reflections': {
    block: 'amp', name: 'floor_reflections',
    displayLabel: 'Floor Reflections',
    pidLow: 0x003e, pidHigh: 0x002c,
    // CABINET_FLOORLVL (catalog id=44). AM4-Edit "Floor Reflections" —
    // level of floor-bounce reflections in the room model.
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  'amp.room_shape': {
    block: 'amp', name: 'room_shape',
    displayLabel: 'Room Shape',
    pidLow: 0x003e, pidHigh: 0x002f,
    // CABINET_ROOMSHAPE (catalog id=47). AM4-Edit "Room Shape" —
    // selects the room geometry preset (square / rectangle / etc.).
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'HALL', 1: 'ROOM' },
  },
  'amp.lf_damping': {
    block: 'amp', name: 'lf_damping',
    displayLabel: 'LF Damping',
    pidLow: 0x003e, pidHigh: 0x0030,
    // CABINET_LFDAMPING (catalog id=48). AM4-Edit "LF Damping" —
    // low-frequency damping in the room reflection model.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.hf_damping': {
    block: 'amp', name: 'hf_damping',
    displayLabel: 'HF Damping',
    pidLow: 0x003e, pidHigh: 0x0031,
    // CABINET_HFDAMPING (catalog id=49). AM4-Edit "HF Damping" —
    // high-frequency damping in the room reflection model.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.cab_vu': {
    block: 'amp', name: 'cab_vu',
    displayLabel: 'Cab VU',
    pidLow: 0x003e, pidHigh: 0x0034,
    // CABINET_VUMETER (catalog id=52). AM4-Edit "Cab VU" — read-only
    // output-level meter for the cab block. Count-style 0..1 like the
    // amp.b_plus_monitor / gain_monitor read-only meters.
    unit: 'count', displayMin: 0, displayMax: 1,
  },
  'amp.cab_1_ir_length': {
    block: 'amp', name: 'cab_1_ir_length',
    displayLabel: 'Cab 1 IR Length',
    pidLow: 0x003e, pidHigh: 0x0039,
    // CABINET_LENGTH1 (catalog id=57). AM4-Edit "Cab 1 IR Length" —
    // impulse-response truncation length in samples / ms for Cab 1.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'MAX', 1: '1024', 2: '512', 3: '256' },
  },
  'amp.cab_2_ir_length': {
    block: 'amp', name: 'cab_2_ir_length',
    displayLabel: 'Cab 2 IR Length',
    pidLow: 0x003e, pidHigh: 0x003a,
    // CABINET_LENGTH2 (catalog id=58). AM4-Edit "Cab 2 IR Length" —
    // sibling to cab_1_ir_length for Cab 2.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'MAX', 1: '1024', 2: '512', 3: '256' },
  },
  'amp.low_slope': {
    block: 'amp', name: 'low_slope',
    displayLabel: 'Low Slope',
    pidLow: 0x003e, pidHigh: 0x003b,
    // CABINET_LOSLOPE1 (catalog id=59). AM4-Edit "Low Slope" — Cab 1
    // low-cut filter slope in dB/oct.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '18 dB/OCT', 3: '24 dB/OCT' },
  },
  'amp.high_slope': {
    block: 'amp', name: 'high_slope',
    displayLabel: 'High Slope',
    pidLow: 0x003e, pidHigh: 0x003d,
    // CABINET_HISLOPE1 (catalog id=61). AM4-Edit "High Slope" — Cab 1
    // high-cut filter slope in dB/oct.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '18 dB/OCT', 3: '24 dB/OCT' },
  },
  'amp.master_low_slope': {
    block: 'amp', name: 'master_low_slope',
    displayLabel: 'Master Low Slope',
    pidLow: 0x003e, pidHigh: 0x003f,
    // CABINET_PRELOSLOPE (catalog id=63). AM4-Edit "Master Low Slope" —
    // Cab-Master EQ low-cut slope (sibling to cab_master_low_cut Hz).
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '18 dB/OCT', 3: '24 dB/OCT' },
  },
  'amp.master_high_slope': {
    block: 'amp', name: 'master_high_slope',
    displayLabel: 'Master High Slope',
    pidLow: 0x003e, pidHigh: 0x0040,
    // CABINET_PREHISLOPE (catalog id=64). AM4-Edit "Master High Slope" —
    // Cab-Master EQ high-cut slope (sibling to cab_master_high_cut Hz).
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '18 dB/OCT', 3: '24 dB/OCT' },
  },
  'amp.dynacab': {
    block: 'amp', name: 'dynacab',
    displayLabel: 'DynaCab',
    pidLow: 0x003e, pidHigh: 0x0045,
    // CABINET_DYNACAB_R1 (catalog id=69). AM4-Edit "DynaCab" — Cab 1
    // DynaCab radius/rotation. Bipolar knob, -10..+10.
    unit: 'knob_0_10', displayMin: -10, displayMax: 10,
  },
  // SKIP: CABINET_DYNACAB_Z1 (catalog id=71, XML "Distance") would
  // collide with the existing CACHE_PARAMS entry `amp.distance` at
  // pidLow=0x003a / pidHigh=0x47. Same cross-block ghost-resolver
  // pattern as the skipped amp.proximity above. Defer.
  'amp.cab_1_blend': {
    block: 'amp', name: 'cab_1_blend',
    displayLabel: 'Cab 1 Blend',
    pidLow: 0x003e, pidHigh: 0x004b,
    // CABINET_BLEND1 (catalog id=75). AM4-Edit "Cab 1 Blend" — IR
    // blend percentage for Cab 1 (when blending two IRs in one cab).
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.cab_2_blend': {
    block: 'amp', name: 'cab_2_blend',
    displayLabel: 'Cab 2 Blend',
    pidLow: 0x003e, pidHigh: 0x004c,
    // CABINET_BLEND2 (catalog id=76). AM4-Edit "Cab 2 Blend" — sibling
    // to cab_1_blend for Cab 2.
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.auto_align': {
    block: 'amp', name: 'auto_align',
    displayLabel: 'Auto Align',
    pidLow: 0x003e, pidHigh: 0x004d,
    // CABINET_AUTO_ALIGN (catalog id=77). AM4-Edit "Auto Align" —
    // toggle for automatic cab alignment (phase / delay matching
    // across the two cabs). OFF/ON enum.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },

  // 2026-05-16 — DISTORT  closeout. 16 new amp
  // params mirrored from CACHE_PARAMS so the coverage-audit (which
  // text-greps params.ts) sees them. Wire bytes + units come from
  // paramNames.ts overrides; cacheParams.ts emits the canonical entries
  // and verify-cache-params guards byte-for-byte agreement. displayLabel
  // = AM4-Edit XML "name=" attribute for the same EditorControl. See
  // samples/captured/decoded/am4-params-proposed.ts for the Ghidra
  // catalog source (Sessions 82–83) and cache-section2.json for the
  // signature data that pinned each unit + range.
  'amp.low_reso': {
    block: 'amp', name: 'low_reso',
    displayLabel: 'Low Reso',
    pidLow: 0x003a, pidHigh: 0x0022,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.master_vol_cap': {
    block: 'amp', name: 'master_vol_cap',
    displayLabel: 'Master Vol Cap',
    pidLow: 0x003a, pidHigh: 0x0026,
    // Cache typecode=72 → log10 storage (sibling to amp.bright_cap at
    // id=20). Capacitance scaling in pF.
    unit: 'pf', displayMin: 1, displayMax: 1000,
    scaling: 'log10',
  },
  'amp.hi_reso': {
    block: 'amp', name: 'hi_reso',
    displayLabel: 'Hi Reso',
    pidLow: 0x003a, pidHigh: 0x0033,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.spkr_drive': {
    block: 'amp', name: 'spkr_drive',
    displayLabel: 'Drive',
    pidLow: 0x003a, pidHigh: 0x0039,
    // Speaker-stage drive knob (catalog: DISTORT_SPKRDRIVE). Renamed
    // from the resolver's bare 'drive' to disambiguate against
    // drive.drive in the separate Drive block.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.input_eq_frequency': {
    block: 'amp', name: 'input_eq_frequency',
    displayLabel: 'Frequency',
    pidLow: 0x003a, pidHigh: 0x004f,
    // Input-EQ peaking frequency. Renamed from the resolver's bare
    // 'frequency' to mirror the existing input_eq_q / input_eq_gain /
    // input_eq_low_cut family on the same UI page.
    unit: 'hz', displayMin: 100, displayMax: 10000,
    scaling: 'log10',
  },
  'amp.overdrive': {
    block: 'amp', name: 'overdrive',
    displayLabel: 'Normal Gain',
    pidLow: 0x003a, pidHigh: 0x0051,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.definition': {
    block: 'amp', name: 'definition',
    displayLabel: 'Definition',
    pidLow: 0x003a, pidHigh: 0x0056,
    // Cache c=31.62299 (≈10/√10) → bipolar power-amp definition knob
    // displayed -10..+10 on the front panel. Uses 'count' rather than
    // bipolar_percent because front panel reads -10.0..+10.0, not ±100%.
    unit: 'count', displayMin: -10, displayMax: 10,
  },
  'amp.compression': {
    block: 'amp', name: 'compression',
    displayLabel: 'Compression',
    pidLow: 0x003a, pidHigh: 0x0057,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.high_cut': {
    block: 'amp', name: 'high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x003a, pidHigh: 0x005a,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'amp.cathode_resistance': {
    block: 'amp', name: 'cathode_resistance',
    displayLabel: 'Cathode Resistance',
    pidLow: 0x003a, pidHigh: 0x0064,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'amp.b_plus_monitor': {
    block: 'amp', name: 'b_plus_monitor',
    displayLabel: 'B+',
    pidLow: 0x003a, pidHigh: 0x007d,
    // Read-only B+ voltage monitor (front-panel meter, not a knob).
    // Cache type=0 a=0 b=1 c=1 → raw 0..1 float; display as count.
    unit: 'count', displayMin: 0, displayMax: 1,
  },
  'amp.gain_monitor': {
    block: 'amp', name: 'gain_monitor',
    displayLabel: 'Gain',
    pidLow: 0x003a, pidHigh: 0x007e,
    // Read-only gain monitor. Sibling to b_plus_monitor / headroom_monitor.
    unit: 'count', displayMin: 0, displayMax: 1,
  },
  'amp.headroom_monitor': {
    block: 'amp', name: 'headroom_monitor',
    displayLabel: 'HEADROOM',
    pidLow: 0x003a, pidHigh: 0x0089,
    // Read-only plate-voltage headroom monitor.
    unit: 'count', displayMin: 0, displayMax: 1,
  },
  'amp.presence_prepresence': {
    block: 'amp', name: 'presence_prepresence',
    displayLabel: 'Treble',
    pidLow: 0x003a, pidHigh: 0x008a,
    // Preamp-stage presence shaper. AM4-Edit XML labels this "Treble"
    // on some amps; catalog name is DISTORT_PREPRESENCE. Name keeps
    // the resolver's dedupe suffix since amp.presence (id=30) is the
    // post-amp presence knob.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.pa_high_cut': {
    block: 'amp', name: 'pa_high_cut',
    displayLabel: 'Tone',
    pidLow: 0x003a, pidHigh: 0x008c,
    // Power-amp high-cut shaper. AM4-Edit labels "Tone" but catalog
    // is DISTORT_PAHICUT; renamed from resolver's 'high_cut_pahicut'
    // to surface the family (pa_ prefix mirrors the rest of the
    // power-amp stage knobs).
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.overdrive_volume': {
    block: 'amp', name: 'overdrive_volume',
    displayLabel: 'Overdrive Volume',
    pidLow: 0x003a, pidHigh: 0x0091,
    // Global post-amp master that scales after the cab sim.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },

  'drive.drive': {
    block: 'drive', name: 'drive',
    displayLabel: 'Gain',
    pidLow: 0x0076, pidHigh: 0x000b,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // P1-010 Session B (2026-04-20) — AM4 Owner's Manual line 1330:
  // "Page Right and dial in Drive, Tone, and Level." Cache records
  // at 0x0C/0x0D/0x0E have canonical pedal-layout signatures.
  //  verified: address + value land correctly on Klone Chiron.
  // Note: AM4 hardware display labels these registers per drive
  // model (Klone Chiron shows `tone`→"Treble" and `level`→"Output",
  // matching the real Klon Centaur). The underlying register is
  // unchanged across drive types.
  'drive.tone': {
    block: 'drive', name: 'tone',
    displayLabel: 'Bass',
    pidLow: 0x0076, pidHigh: 0x000c,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.level': {
    block: 'drive', name: 'level',
    displayLabel: 'Mid',
    pidLow: 0x0076, pidHigh: 0x000d,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.mix': {
    block: 'drive', name: 'mix',
    displayLabel: 'Tone',
    pidLow: 0x0076, pidHigh: 0x000e,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // 2026-04-25: Drive EQ-page knobs from
  // session-30-drive-basic-blackglass-7k. T808 OD only exposed
  // Drive/Tone/Level on its first page (session-30-drive-basic-t808-od
  // capture confirmed) — the EQ controls below are absent on simpler
  // pedal types and only surface on amp-emu drive types like
  // Blackglass 7K. Cache signatures pin the unit + range; sequence in
  // the cache (id 16/17 = Low/High Cut Hz, id 20/21/23 = Bass/Mid/
  // Treble knobs flanking id 22 = Mid Frequency) matches the AM4-Edit
  // EQ-1-page layout. Captured wiggle order on Blackglass differed
  // from the spec order; mapping is by cache-id sequence + signature
  // not capture order.
  'drive.low_cut': {
    block: 'drive', name: 'low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x0076, pidHigh: 0x0010,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'drive.bass': {
    block: 'drive', name: 'bass',
    displayLabel: 'Bright Cap',
    pidLow: 0x0076, pidHigh: 0x0014,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.mid': {
    block: 'drive', name: 'mid',
    pidLow: 0x0076, pidHigh: 0x0015,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.mid_freq': {
    block: 'drive', name: 'mid_freq',
    displayLabel: 'XFormer Low Freq',
    pidLow: 0x0076, pidHigh: 0x0016,
    unit: 'hz', displayMin: 200, displayMax: 2000,
    scaling: 'log10',
  },
  'drive.treble': {
    block: 'drive', name: 'treble',
    displayLabel: 'XFormer Hi Freq',
    pidLow: 0x0076, pidHigh: 0x0017,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.channel': {
    block: 'drive', name: 'channel',
    pidLow: 0x0076, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  // 2026-04-29: Blackglass 7K Drive
  // Expert-Edit page from session-31-drive-expert.pcapng + paired
  // AM4-Edit screenshot. 6 single-knob params + 10 GEQ bands + 1
  // type-specific knob (high_mid for Blackglass, may surface under
  // a different label on other types).
  //
  // Mirrored from CACHE_PARAMS so the type-check picks them up.
  'drive.high_cut': {
    block: 'drive', name: 'high_cut',
    displayLabel: 'High Cut Frequency',
    pidLow: 0x0076, pidHigh: 0x0011,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'drive.bypass_mode': {
    block: 'drive', name: 'bypass_mode',
    pidLow: 0x0076, pidHigh: 0x0004,
    // Cache id=4: enum [Thru / Mute]. Hand-authored per-block non-Type
    // enum (gen-params skips these).
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Thru', 1: 'Mute' },
  },
  'drive.clip_type': {
    block: 'drive', name: 'clip_type',
    // 'Type' is a provisional caption for this 14-entry clip-diode enum.
    // The prior 'Frequency' was wrong (likely an editor label-extraction
    // error). PENDING hardware confirmation of the AM4-Edit caption.
    displayLabel: 'Type',
    pidLow: 0x0076, pidHigh: 0x0012,
    // Cache id=18: 14-entry enum. Hand-authored (the generator only
    // attaches one enum import per block, used for `type` at id=10).
    unit: 'enum', displayMin: 0, displayMax: 13,
    enumValues: {
      0: 'LV TUBE', 1: 'HARD', 2: 'SOFT', 3: 'GERMANIUM', 4: 'FW RECT',
      5: 'HV TUBE', 6: 'SILICON', 7: '4558/DIODE', 8: 'LED', 9: 'FET',
      10: 'OP-AMP', 11: 'VARIABLE', 12: 'CMOS', 13: 'NULL',
    },
  },
  'drive.bit_reduce': {
    block: 'drive', name: 'bit_reduce',
    displayLabel: 'Location',
    pidLow: 0x0076, pidHigh: 0x0018,
    unit: 'count', displayMin: 0, displayMax: 24,
  },
  'drive.input_select': {
    block: 'drive', name: 'input_select',
    displayLabel: 'Amp Input Select',
    pidLow: 0x0076, pidHigh: 0x0019,
    // Cache id=25: enum [L+R / LEFT / RIGHT].
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'L+R', 1: 'LEFT', 2: 'RIGHT' },
  },
  'drive.eq_position': {
    block: 'drive', name: 'eq_position',
    pidLow: 0x0076, pidHigh: 0x001c,
    // Cache id=28: enum [OFF / POST / PRE]. Selects whether the post-
    // Drive Graphic EQ is bypassed, post-drive, or pre-drive.
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OFF', 1: 'POST', 2: 'PRE' },
  },
  //  partial (2026-05-02) — Drive Expert-Edit ADVANCED
  // panel knobs from `session-45-drive-expert-blackglass.{pcapng,png}`.
  // Slew Rate is universal (also active on Pi Fuzz at wire 0.21044).
  // Bias is Blackglass-only (silent in Pi Fuzz capture) — type-conditional
  // UI but firmware-stable address. See docs/audit-output/drive-blackglass.md.
  // Note: drive.balance is currently registered at 0x0002 but 
  // captures show actual Balance is at 0x000f (hdr2=0x0002 bipolar
  // signature). Re-point deferred until 0x0002's actual identity is
  // confirmed — see open follow-ups in session-44-findings.md.
  'drive.slew_rate': {
    block: 'drive', name: 'slew_rate',
    displayLabel: 'Depth',
    pidLow: 0x0076, pidHigh: 0x001a,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'drive.bias': {
    block: 'drive', name: 'bias',
    pidLow: 0x0076, pidHigh: 0x001b,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // 10-band Graphic EQ — frequencies 100/160/250/400/640/1000/1600/
  // 2500/4000/6400 Hz, each ±12 dB. Wire-display match exact across
  // all 10 bands.
  'drive.geq_band_1':  { block: 'drive', name: 'geq_band_1', displayLabel: 'Supply Sag',  pidLow: 0x0076, pidHigh: 0x001d, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_2':  { block: 'drive', name: 'geq_band_2', displayLabel: 'Presence',  pidLow: 0x0076, pidHigh: 0x001e, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_3':  { block: 'drive', name: 'geq_band_3', displayLabel: 'Negative FB',  pidLow: 0x0076, pidHigh: 0x001f, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_4':  { block: 'drive', name: 'geq_band_4', displayLabel: 'Presence Freq',  pidLow: 0x0076, pidHigh: 0x0020, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_5':  { block: 'drive', name: 'geq_band_5', displayLabel: 'Low Freq',  pidLow: 0x0076, pidHigh: 0x0021, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_6':  { block: 'drive', name: 'geq_band_6', displayLabel: 'Low Reso',  pidLow: 0x0076, pidHigh: 0x0022, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_7':  { block: 'drive', name: 'geq_band_7', displayLabel: 'Amp Section',  pidLow: 0x0076, pidHigh: 0x0023, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_8':  { block: 'drive', name: 'geq_band_8', displayLabel: 'Depth Freq',  pidLow: 0x0076, pidHigh: 0x0024, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_9':  { block: 'drive', name: 'geq_band_9',  pidLow: 0x0076, pidHigh: 0x0025, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.geq_band_10': { block: 'drive', name: 'geq_band_10', displayLabel: 'Master Vol Cap', pidLow: 0x0076, pidHigh: 0x0026, unit: 'db', displayMin: -12, displayMax: 12 },
  'drive.high_mid': {
    block: 'drive', name: 'high_mid',
    pidLow: 0x0076, pidHigh: 0x002d,
    // Cache id=45: knob_0_10. Wiggle-order adjacency
    // pins this between drive.mid_freq (id=22) and drive.treble (id=23)
    // in the BASIC column on Blackglass 7K. Type-specific UI label
    // varies; the register name reflects the Blackglass usage.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.type': {
    block: 'drive', name: 'type',
    pidLow: 0x0076, pidHigh: 0x000a,
    //  capture set drive type with wire-value 8; cache lists
    // index 8 as "T808 Mod" (Fractal's internal label for the TS808
    // variant AM4-Edit surfaces as "TS808"). Full 78-entry table from
    // cache lines up 1:1 with AM4-Edit's Drive Type dropdown order.
    unit: 'enum', displayMin: 0, displayMax: 77,
    enumValues: DRIVE_TYPES_VALUES,
  },
  'reverb.mix': {
    block: 'reverb', name: 'mix',
    pidLow: 0x0042, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'reverb.time': {
    // Blocks Guide §Reverb Basic Page: decay time, 0.1..100 seconds.
    // Uses 'seconds' unit (display = internal, scale 1).
    block: 'reverb', name: 'time',
    displayLabel: 'Time',
    pidLow: 0x0042, pidHigh: 0x000b,
    unit: 'seconds', displayMin: 0.1, displayMax: 100,
  },
  // renamed for UI-label match (audit row: REVERB 19)
  'reverb.pre_delay': {
    // fix: true address is pidHigh=0x0013,
    // not 0x0010. AM4-Edit capture for Pre-Delay→85 ms wrote 0x0042/0x0013
    // with float32(0.085) — confirms the `ms` unit's ÷1000 scale is right.
    // The 0x0010 register was a cache-derived guess that was structurally
    // plausible (range matched) but wrote to nothing. See SYSEX-MAP §6j.
    block: 'reverb', name: 'pre_delay',
    displayLabel: 'Pre-Delay',
    pidLow: 0x0042, pidHigh: 0x0013,
    unit: 'ms', displayMin: 0, displayMax: 250,
  },
  // reverb Size at pidHigh=0x000f. Wire-verified
  // on two captures ("Plate Size" on Plate reverb + "Size" on Room
  // reverb) — same register, type-dependent UI label. Percent scale.
  'reverb.size': {
    block: 'reverb', name: 'size',
    displayLabel: 'Size',
    pidLow: 0x0042, pidHigh: 0x000f,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // spring-reverb-specific params. Registers are
  // writable on any reverb type; AM4-Edit exposes the UI only when
  // a Spring reverb is active. wire-verified
  // both on Spring, Large reverb (springs=5 displayed exactly; spring_tone
  // 7.30 displayed exactly) — first-ever hardware test of these params.
  'reverb.springs': {
    block: 'reverb', name: 'springs',
    displayLabel: '# of Springs',
    pidLow: 0x0042, pidHigh: 0x001b,
    unit: 'count', displayMin: 2, displayMax: 6,
  },
  'reverb.spring_tone': {
    block: 'reverb', name: 'spring_tone',
    displayLabel: 'Tone',
    pidLow: 0x0042, pidHigh: 0x001c,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  //  follow-up: Shimmer Verb / Plex Verb pitch-shifter
  // voices. Blocks Guide §Shimmer Verb Parameters describes "Shift
  // 1–8" as detune amounts within ±24 semitones ("this is where
  // 'Shimmer' is born"). AM4's reverb exposes two such voices at
  // cache ids 56/57 — structural registration (cache signature
  // matches BG exactly: a=-24, b=24, c=1, step=1).  couldn't
  // verify on hardware display (both shifts hidden on the Plate
  // reverb type tested); awaits a Shimmer-type hardware spot-check
  // or AM4-Edit-side verification.
  // 2026-04-25: 10 new universal/algorithmic-reverb
  // and Spring-specific knobs decoded from session-30-reverb-basic-hall
  // and session-30-reverb-spring captures. Cache metadata confirmed
  // pidLow/pidHigh/range for each; capture final values cross-checked
  // against the founder's AM4-Edit screenshot inventory. Hall + Spring
  // share the universal registers (high_cut / low_cut / input_gain /
  // ducking) while Hall-only adds algorithmic controls (density / quality
  // / stack_hold / stereo_spread) and Spring-only adds Spring-engine
  // controls (dwell / drip).
  'reverb.high_cut': {
    block: 'reverb', name: 'high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x0042, pidHigh: 0x000c,
    // Cache: a=200, b=20000, c=1 → raw Hz, 200..20000 Hz. Hall capture
    // wrote 7000 Hz directly (numeric input field, action=0x0001).
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'reverb.low_cut': {
    block: 'reverb', name: 'low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x0042, pidHigh: 0x0014,
    // Cache: a=20, b=2000, c=1 → raw Hz, 20..2000 Hz.
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'reverb.input_gain': {
    block: 'reverb', name: 'input_gain',
    displayLabel: 'Input Gain',
    pidLow: 0x0042, pidHigh: 0x0017,
    // Cache: a=0, b=1, c=100 → percent 0..100. Spring final 0.8217 →
    // 82.17% matches the AM4-Edit screenshot's "Input Gain 82.2 %".
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'reverb.density': {
    block: 'reverb', name: 'density',
    displayLabel: 'Density',
    pidLow: 0x0042, pidHigh: 0x0018,
    // Cache: a=4, b=8, c=1, kind=float typecode=16 → integer count
    // 4..8. Hall-only (algorithmic Hall/Plate/Room knob).
    unit: 'count', displayMin: 4, displayMax: 8,
  },
  'reverb.dwell': {
    block: 'reverb', name: 'dwell',
    displayLabel: 'Dwell',
    pidLow: 0x0042, pidHigh: 0x0024,
    // Cache: a=0.01, b=1, c=10 → knob_0_10 (display = wire × 10).
    // Spring final 0.4741 → 4.741 matches screenshot "Dwell 4.74".
    // Spring-engine specific (alongside spring_tone, drip).
    unit: 'knob_0_10', displayMin: 0.1, displayMax: 10,
    // typecode 80 = log10 ( cont audit)
    scaling: 'log10',
  },
  'reverb.stereo_spread': {
    block: 'reverb', name: 'stereo_spread',
    displayLabel: 'Stereo Spread',
    pidLow: 0x0042, pidHigh: 0x0027,
    // Cache: a=-2, b=2, c=100 → bipolar_percent allowing -200..+200%.
    // AM4-Edit screenshot shows Hall Stereo Spread as a positive 0..100%
    // knob (display value 90.0 %). Cache exposes the wider firmware
    // range — leave displayMin/displayMax at the cache values; Claude
    // can clamp to the typical 0..100 range when describing the knob.
    unit: 'bipolar_percent', displayMin: -200, displayMax: 200,
  },
  'reverb.ducking': {
    block: 'reverb', name: 'ducking',
    displayLabel: 'Ducking',
    pidLow: 0x0042, pidHigh: 0x0028,
    // Cache: a=0, b=80, c=1 → raw dB, 0..80 dB attenuation. Universal
    // (Hall + Spring both wrote here). Screenshot shows "Ducking 46.9 dB"
    // on both reverb types — typical mid-range attenuation.
    unit: 'db', displayMin: 0, displayMax: 80,
  },
  'reverb.quality': {
    block: 'reverb', name: 'quality',
    displayLabel: 'Quality',
    pidLow: 0x0042, pidHigh: 0x002f,
    // Cache: enum, values=["ECONOMY","NORMAL","HIGH","ULTRA-HIGH"].
    // Hall-only (algorithmic CPU-quality selector). Hand-authored enum
    // map; not yet exported via cacheEnums.ts since cacheEnums is
    // auto-generated from a different cache section. If a regen pass
    // adds REVERB_QUALITY_VALUES later, swap this inline map for the
    // import.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'ECONOMY', 1: 'NORMAL', 2: 'HIGH', 3: 'ULTRA-HIGH' },
  },
  'reverb.stack_hold': {
    block: 'reverb', name: 'stack_hold',
    displayLabel: 'Stack/Hold',
    pidLow: 0x0042, pidHigh: 0x0030,
    // Cache: enum, values=["OFF","STACK","HOLD"]. Hall-only. Same
    // hand-authored caveat as reverb.quality.
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OFF', 1: 'STACK', 2: 'HOLD' },
  },
  'reverb.drip': {
    block: 'reverb', name: 'drip',
    displayLabel: 'Drip',
    pidLow: 0x0042, pidHigh: 0x0034,
    // Cache: a=0, b=1, c=100 → percent 0..100. Spring final 0.9183 →
    // 91.83% matches screenshot "Drip 91.8 %". Spring-engine specific.
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // renamed for UI-label match (audit row: REVERB 56)
  'reverb.voice_1_shift': {
    block: 'reverb', name: 'voice_1_shift',
    displayLabel: 'Voice 1 Shift',
    pidLow: 0x0042, pidHigh: 0x0038,
    unit: 'semitones', displayMin: -24, displayMax: 24,
  },
  // renamed for UI-label match (audit row: REVERB 57)
  'reverb.voice_2_shift': {
    block: 'reverb', name: 'voice_2_shift',
    displayLabel: 'Voice 2 Shift',
    pidLow: 0x0042, pidHigh: 0x0039,
    unit: 'semitones', displayMin: -24, displayMax: 24,
  },
  'reverb.channel': {
    block: 'reverb', name: 'channel',
    pidLow: 0x0042, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  'reverb.type': {
    block: 'reverb', name: 'type',
    pidLow: 0x0042, pidHigh: 0x000a,
    // : enum dictionary imported from cacheEnums.ts (79 models).
    // Untested against capture.
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: REVERB_TYPES_VALUES,
  },
  'delay.time': {
    block: 'delay', name: 'time',
    displayLabel: 'Time',
    pidLow: 0x0046, pidHigh: 0x000c,
    // : cache says `b=8` seconds → UI max 8000 ms (was 5000).
    unit: 'ms', displayMin: 0, displayMax: 8000,
  },
  'delay.mix': {
    // Blocks Guide: delay has Mix at pidHigh 0x01. "Note that the
    // delay block uses a different Mix Law compared to other blocks" —
    // semantics differ but the param is at the standard location.
    block: 'delay', name: 'mix',
    pidLow: 0x0046, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // Feedback knobs on per-block delay/flanger/phaser.
  // All bipolar — negative feedback inverts the phase of the repeats/
  // sweep, a standard Fractal implementation detail.
  'delay.feedback': {
    block: 'delay', name: 'feedback',
    displayLabel: 'Feedback',
    pidLow: 0x0046, pidHigh: 0x000e,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  // 2026-04-25: Delay first-page registers from
  // session-30-delay-basic-digital-mono. `level` follows the universal
  // pidHigh=0x0000 "Level" pattern shared with amp.level (no cache
  // record at id=0; out-of-band hand-author). `stack_hold` and
  // `ducking` mirror the same registers found on Reverb.
  // `tempo` (pidHigh=0x0013) is captured but deferred — registering
  // it requires extracting the 79-entry tempo-division enum from cache
  // (queued as follow-up).
  'delay.level': {
    block: 'delay', name: 'level',
    pidLow: 0x0046, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  // 2026-04-29: Delay Expert-Edit page from
  // session-40-delay-expert.pcapng (Ambient Stereo). 32 new params
  // mirrored from CACHE_PARAMS + 7 hand-authored enums (bypass_mode,
  // kill_dry, lo_fi_drive, phase_reverse, low_cut_slope, high_cut_slope,
  // compander).
  'delay.bypass_mode': {
    block: 'delay', name: 'bypass_mode',
    pidLow: 0x0046, pidHigh: 0x0004,
    // Cache id=4 enum has 5 entries: [Thru, Mute FX Out, Mute Out,
    // Mute FX In, Mute In] — the cache extraction shows 4 visible
    // entries but the enum max is 4 (so 5 indices, 0..4).
    unit: 'enum', displayMin: 0, displayMax: 4,
    enumValues: { 0: 'Thru', 1: 'Mute FX Out', 2: 'Mute Out', 3: 'Mute FX In', 4: 'Mute In' },
  },
  'delay.kill_dry': {
    block: 'delay', name: 'kill_dry',
    pidLow: 0x0046, pidHigh: 0x0007,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'delay.lr_time_ratio': {
    block: 'delay', name: 'lr_time_ratio',
    displayLabel: 'L/R Time Ratio',
    pidLow: 0x0046, pidHigh: 0x000d,
    unit: 'percent', displayMin: 1, displayMax: 100,
  },
  'delay.feedback_r': {
    block: 'delay', name: 'feedback_r',
    displayLabel: 'Feedback R',
    pidLow: 0x0046, pidHigh: 0x0010,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  'delay.stereo_spread': {
    block: 'delay', name: 'stereo_spread',
    displayLabel: 'Stereo Spread',
    pidLow: 0x0046, pidHigh: 0x0012,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  'delay.low_cut': {
    block: 'delay', name: 'low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x0046, pidHigh: 0x0014,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'delay.high_cut': {
    block: 'delay', name: 'high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x0046, pidHigh: 0x0015,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'delay.lo_fi_drive': {
    block: 'delay', name: 'lo_fi_drive',
    displayLabel: 'Drive',
    pidLow: 0x0046, pidHigh: 0x001a,
    // Cache id=26: float a=0.05 b=50 c=10 → display = wire × 10,
    // range 0.5..500. Same encoding shape as knob_0_10 (scale 10);
    // the unit name is structural, the bounds carry the actual range.
    unit: 'knob_0_10', displayMin: 0.5, displayMax: 500,
    // typecode 80 = log10 ( cont audit)
    scaling: 'log10',
  },
  'delay.input_gain': {
    block: 'delay', name: 'input_gain',
    displayLabel: 'Input Gain',
    pidLow: 0x0046, pidHigh: 0x001b,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'delay.master_feedback': {
    block: 'delay', name: 'master_feedback',
    displayLabel: 'Master Feedback',
    pidLow: 0x0046, pidHigh: 0x0020,
    // Cache id=32: a=0 b=2 c=100 → display 0..200%.
    unit: 'percent', displayMin: 0, displayMax: 200,
  },
  'delay.high_cut_slope': {
    block: 'delay', name: 'high_cut_slope',
    displayLabel: 'High Cut Slope',
    pidLow: 0x0046, pidHigh: 0x002d,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '24 dB/OCT', 3: '36 dB/OCT' },
  },
  'delay.ducker_threshold': {
    block: 'delay', name: 'ducker_threshold',
    displayLabel: 'Threshold',
    pidLow: 0x0046, pidHigh: 0x002f,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'delay.ducker_release': {
    block: 'delay', name: 'ducker_release',
    displayLabel: 'Release',
    pidLow: 0x0046, pidHigh: 0x0030,
    unit: 'ms', displayMin: 1, displayMax: 1000, scaling: 'log10',
  },
  // renamed for UI-label match (audit row: DELAY 49)
  'delay.diffuser': {
    block: 'delay', name: 'diffuser',
    displayLabel: 'Diffuser',
    pidLow: 0x0046, pidHigh: 0x0031,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'delay.diffusion_time': {
    block: 'delay', name: 'diffusion_time',
    displayLabel: 'Diffusion Time',
    pidLow: 0x0046, pidHigh: 0x0032,
    unit: 'percent', displayMin: 1, displayMax: 100,
  },
  'delay.phase_reverse': {
    block: 'delay', name: 'phase_reverse',
    displayLabel: 'Phase Reverse',
    pidLow: 0x0046, pidHigh: 0x0033,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'NONE', 1: 'RIGHT', 2: 'LEFT', 3: 'BOTH' },
  },
  'delay.eq_q_high_low': {
    block: 'delay', name: 'eq_q_high_low',
    displayLabel: 'Q (High + Low)',
    pidLow: 0x0046, pidHigh: 0x003f,
    unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10',
  },
  'delay.bit_reduction': {
    block: 'delay', name: 'bit_reduction',
    displayLabel: 'Bit Reduction',
    pidLow: 0x0046, pidHigh: 0x0040,
    unit: 'count', displayMin: 0, displayMax: 24,
  },
  'delay.eq_freq_1': {
    block: 'delay', name: 'eq_freq_1',
    displayLabel: 'Frequency 1',
    pidLow: 0x0046, pidHigh: 0x0041,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'delay.eq_freq_2': {
    block: 'delay', name: 'eq_freq_2',
    displayLabel: 'Frequency 2',
    pidLow: 0x0046, pidHigh: 0x0042,
    unit: 'hz', displayMin: 100, displayMax: 10000,
    scaling: 'log10',
  },
  'delay.eq_q_1': {
    block: 'delay', name: 'eq_q_1',
    displayLabel: 'Q 1',
    pidLow: 0x0046, pidHigh: 0x0043,
    unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10',
  },
  'delay.eq_q_2': {
    block: 'delay', name: 'eq_q_2',
    displayLabel: 'Q 2',
    pidLow: 0x0046, pidHigh: 0x0044,
    unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10',
  },
  'delay.eq_gain_1': {
    block: 'delay', name: 'eq_gain_1',
    displayLabel: 'Gain 1',
    pidLow: 0x0046, pidHigh: 0x0045,
    unit: 'db', displayMin: -12, displayMax: 12,
  },
  'delay.eq_gain_2': {
    block: 'delay', name: 'eq_gain_2',
    displayLabel: 'Gain 2',
    pidLow: 0x0046, pidHigh: 0x0046,
    unit: 'db', displayMin: -12, displayMax: 12,
  },
  'delay.low_cut_slope': {
    block: 'delay', name: 'low_cut_slope',
    displayLabel: 'Low Cut Slope',
    pidLow: 0x0046, pidHigh: 0x004a,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '24 dB/OCT', 3: '36 dB/OCT' },
  },
  'delay.compander': {
    block: 'delay', name: 'compander',
    displayLabel: 'Compander',
    pidLow: 0x0046, pidHigh: 0x004b,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'delay.compander_time': {
    block: 'delay', name: 'compander_time',
    displayLabel: 'Time',
    pidLow: 0x0046, pidHigh: 0x004c,
    unit: 'ms', displayMin: 1, displayMax: 100, scaling: 'log10',
  },
  'delay.compander_threshold': {
    block: 'delay', name: 'compander_threshold',
    displayLabel: 'Threshold',
    pidLow: 0x0046, pidHigh: 0x004d,
    unit: 'db', displayMin: -100, displayMax: -20,
  },
  'delay.master_time': {
    block: 'delay', name: 'master_time',
    displayLabel: 'Master Time',
    pidLow: 0x0046, pidHigh: 0x004e,
    unit: 'percent', displayMin: 25, displayMax: 400,
    scaling: 'log10',
  },
  'delay.lfo_rate': {
    block: 'delay', name: 'lfo_rate',
    displayLabel: 'LFO Rate',
    pidLow: 0x0046, pidHigh: 0x004f,
    unit: 'hz', displayMin: 0.1, displayMax: 10,
    scaling: 'log10',
  },
  'delay.lfo_depth': {
    block: 'delay', name: 'lfo_depth',
    displayLabel: 'LFO Depth',
    pidLow: 0x0046, pidHigh: 0x0050,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'delay.stack_feedback': {
    block: 'delay', name: 'stack_feedback',
    displayLabel: 'Stack Feedback',
    pidLow: 0x0046, pidHigh: 0x0057,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'delay.hold_feedback': {
    block: 'delay', name: 'hold_feedback',
    displayLabel: 'Hold Feedback',
    pidLow: 0x0046, pidHigh: 0x0058,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // renamed for UI-label match (audit row: DELAY 31)
  'delay.repeat_stack_hold': {
    block: 'delay', name: 'repeat_stack_hold',
    displayLabel: 'Repeat Stack/Hold',
    pidLow: 0x0046, pidHigh: 0x001f,
    // Cache id=31: enum [OFF|STACK|HOLD]. Hand-authored — generator
    // can't emit per-block non-Type enums (it would mis-import the
    // block's TYPES_VALUES instead of these three).
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OFF', 1: 'STACK', 2: 'HOLD' },
  },
  'delay.ducking': {
    block: 'delay', name: 'ducking',
    displayLabel: 'Ducking',
    pidLow: 0x0046, pidHigh: 0x002e,
    // Cache id=46: float a=0 b=80 c=1 → raw dB 0..80 attenuation.
    // Same signature as reverb.ducking.
    unit: 'db', displayMin: 0, displayMax: 80,
  },
  // 2026-04-25: tempo-sync registers across
  // every modulation block. Cache contains 14 79-entry tempo enums (delay
  // × 6, chorus × 2, reverb / flanger / rotary / phaser / tremolo /
  // filter × 1 each) — all string-identical, sharing the
  // TEMPO_DIVISIONS_VALUES dictionary emitted by gen-cache-enums.ts.
  // The first/lowest-id tempo enum on each block is canonically the main
  // "Tempo Sync" knob per Blocks Guide §Common LFO Parameters. We
  // register the high-confidence ones below (delay = wire-verified;
  // chorus/flanger/phaser/tremolo = structural-by-symmetry, every
  // modulation block has a Tempo Sync knob). Filter / reverb / rotary
  // tempo registers deferred — semantics uncertain (auto-wah env follower
  // vs LFO sync; reverb-modulation tempo for Vibrato-King types only).
  // Hand-authored in KNOWN_PARAMS rather than via paramNames+generator
  // because the generator's enum-handling defaults to the block's
  // TYPES_VALUES, which would mis-import for these non-Type enums.
  'delay.tempo': {
    block: 'delay', name: 'tempo',
    displayLabel: 'Tempo',
    pidLow: 0x0046, pidHigh: 0x0013,
    // Wire-verified: session-30-delay-basic-digital-mono captured
    // value=11 (= "1/8" tempo division).
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: TEMPO_DIVISIONS_VALUES,
  },
  'chorus.tempo': {
    block: 'chorus', name: 'tempo',
    displayLabel: 'Tempo',
    pidLow: 0x004e, pidHigh: 0x000d,
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: TEMPO_DIVISIONS_VALUES,
  },
  'flanger.tempo': {
    block: 'flanger', name: 'tempo',
    displayLabel: 'Tempo',
    pidLow: 0x0052, pidHigh: 0x000c,
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: TEMPO_DIVISIONS_VALUES,
  },
  'phaser.tempo': {
    block: 'phaser', name: 'tempo',
    displayLabel: 'Tempo',
    pidLow: 0x005a, pidHigh: 0x000e,
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: TEMPO_DIVISIONS_VALUES,
  },
  'tremolo.tempo': {
    block: 'tremolo', name: 'tempo',
    displayLabel: 'Tempo',
    pidLow: 0x006a, pidHigh: 0x000f,
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: TEMPO_DIVISIONS_VALUES,
  },
  'delay.channel': {
    block: 'delay', name: 'channel',
    pidLow: 0x0046, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  'delay.type': {
    block: 'delay', name: 'type',
    pidLow: 0x0046, pidHigh: 0x000a,
    // : enum dictionary imported from cacheEnums.ts (29 models).
    // Untested against capture.
    unit: 'enum', displayMin: 0, displayMax: 28,
    enumValues: DELAY_TYPES_VALUES,
  },
  // 6 additional block Type selectors, each pinned to wire
  // pidLow by a Tier-3 AM4-Edit capture of a Type-dropdown change. The
  // cache record id is the wire pidHigh (10 for the effect blocks, 19/20
  // for Comp/GEQ because their cache slot reserves ids 0..12 for band
  // levels / assign slots).
  // P1-010 Session B (2026-04-20) — universal Mix control per the
  // Blocks Guide §Common Mix/Level Parameters (p. 7). Every effect
  // block with a wet/dry concept exposes Mix at pidHigh 0x01 with the
  // same percent signature as the confirmed reverb.mix. Skipped for
  // Wah/GEQ/Gate/Volume-Pan (AM4 manual p. 34: "Effects with no mix,
  // such as Wah, GEQ, etc., will show 'NA'").  partial: delay
  // / chorus / reverb mix verified correct; flanger.mix and
  // phaser.mix surfaced the  encoding bug (see entries below);
  // tremolo.mix / compressor.mix / filter.mix hidden on hardware
  // display (awaits AM4-Edit verification).
  // Modulation-block LFO rates + depths ( Unit-extension pass).
  // Rate uses the 'hz' unit (raw passthrough, c=1 in cache). Depth is a
  // standard percent knob. Blocks Guide §Chorus/Flanger/Phaser document
  // all three as Basic Page controls across these blocks.
  'chorus.mix': {
    block: 'chorus', name: 'mix',
    pidLow: 0x004e, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'chorus.type': {
    block: 'chorus', name: 'type',
    pidLow: 0x004e, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 19,
    enumValues: CHORUS_TYPES_VALUES,
  },
  'chorus.rate': {
    // resolved: NOT an encoding bug.
    // AM4-Edit wire for Rate→3.4 Hz wrote pidLow=0x004e/pidHigh=0x000c
    // with float32(3.4) — byte-identical to our `unit: 'hz'` builder.
    // the hardware-display readback (3.4→0.5 Hz) is an AM4
    // hardware-screen rendering quirk for chorus rate, not a wire-
    // layer bug. Verify chorus rate via AM4-Edit, not the AM4 hardware
    // display, until the screen-side rendering is characterised.
    block: 'chorus', name: 'rate',
    displayLabel: 'Rate',
    pidLow: 0x004e, pidHigh: 0x000c,
    unit: 'hz', displayMin: 0.1, displayMax: 10,
    scaling: 'log10',
  },
  'chorus.depth': {
    block: 'chorus', name: 'depth',
    displayLabel: 'Depth',
    pidLow: 0x004e, pidHigh: 0x000e,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // 2026-04-26: wire-verified on Analog Stereo
  // chorus — `session-30-chorus-basic.pcapng`. Chorus first-page
  // additions: level / time / mod_phase / phase_reverse.
  'chorus.level': {
    block: 'chorus', name: 'level',
    pidLow: 0x004e, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  // renamed for UI-label match (audit row: CHORUS 16)
  'chorus.delay_time': {
    block: 'chorus', name: 'delay_time',
    displayLabel: 'Delay Time',
    pidLow: 0x004e, pidHigh: 0x0010,
    // Cache id=16: float a=0.0001 b=0.05 c=1000 → display 0.1..50 ms.
    unit: 'ms', displayMin: 0.1, displayMax: 50,
  },
  'chorus.mod_phase': {
    block: 'chorus', name: 'mod_phase',
    displayLabel: 'Mod Phase',
    pidLow: 0x004e, pidHigh: 0x0011,
    // Cache id=17: float a=0 b=π c=180/π → display 0..180 deg.
    unit: 'degrees', displayMin: 0, displayMax: 180,
  },
  'chorus.phase_reverse': {
    block: 'chorus', name: 'phase_reverse',
    displayLabel: 'Phase Reverse',
    pidLow: 0x004e, pidHigh: 0x0014,
    // Cache id=20 enum: [NONE, RIGHT, LEFT, BOTH]. Default NONE.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'NONE', 1: 'RIGHT', 2: 'LEFT', 3: 'BOTH' },
  },
  // 2026-04-29: Chorus Expert-Edit page from
  // session-40-chorus-expert.pcapng (Analog Stereo). New non-Type
  // enums + cache mirrors.
  'chorus.bypass_mode': {
    block: 'chorus', name: 'bypass_mode',
    pidLow: 0x004e, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'Thru', 1: 'Mute FX Out', 2: 'Mute Out' },
  },
  // chorus.tempo already registered above ( added the
  // shared TEMPO_DIVISIONS_VALUES dictionary).
  'chorus.lfo_type': {
    block: 'chorus', name: 'lfo_type',
    displayLabel: 'LFO Type',
    pidLow: 0x004e, pidHigh: 0x0012,
    unit: 'enum', displayMin: 0, displayMax: 9,
    enumValues: LFO_WAVEFORMS_VALUES,
  },
  'chorus.auto_depth': {
    block: 'chorus', name: 'auto_depth',
    displayLabel: 'Auto Depth',
    pidLow: 0x004e, pidHigh: 0x0013,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OFF', 1: 'LOW', 2: 'HIGH' },
  },
  // renamed for UI-label match (audit row: CHORUS 27)
  'chorus.mode': {
    block: 'chorus', name: 'mode',
    displayLabel: 'Mode',
    pidLow: 0x004e, pidHigh: 0x001b,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'OFF', 1: 'LOW', 2: 'MED', 3: 'HIGH' },
  },
  'chorus.number_of_voices': {
    block: 'chorus', name: 'number_of_voices',
    displayLabel: 'Number of Voices',
    pidLow: 0x004e, pidHigh: 0x000b,
    unit: 'count', displayMin: 1, displayMax: 4,
  },
  'chorus.high_cut': {
    block: 'chorus', name: 'high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x004e, pidHigh: 0x000f,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'chorus.lfo_phase_pct': {
    block: 'chorus', name: 'lfo_phase_pct',
    displayLabel: 'Right Time Ratio',
    pidLow: 0x004e, pidHigh: 0x0015,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // renamed for UI-label match (audit row: CHORUS 22)
  'chorus.rate_right': {
    block: 'chorus', name: 'rate_right',
    displayLabel: 'Rate Right',
    pidLow: 0x004e, pidHigh: 0x0016,
    unit: 'hz', displayMin: 0.1, displayMax: 10,
    scaling: 'log10',
  },
  // renamed for UI-label match (audit row: CHORUS 23)
  'chorus.lfo_2_depth': {
    block: 'chorus', name: 'lfo_2_depth',
    displayLabel: 'LFO 2 Depth',
    pidLow: 0x004e, pidHigh: 0x0017,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'chorus.drive': {
    block: 'chorus', name: 'drive',
    displayLabel: 'Drive',
    pidLow: 0x004e, pidHigh: 0x0018,
    // Cache id=24: float a=0.05 b=50 c=10 → display = wire × 10,
    // range 0.5..500. Same encoding shape as knob_0_10 with stretched
    // range; the unit is structural. typecode 80 → log10 ( cont).
    unit: 'knob_0_10', displayMin: 0.5, displayMax: 500,
    scaling: 'log10',
  },
  // renamed for UI-label match (audit row: CHORUS 25)
  'chorus.low_cut': {
    block: 'chorus', name: 'low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x004e, pidHigh: 0x0019,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  // renamed for UI-label match (audit row: CHORUS 26)
  'chorus.stereo_spread': {
    block: 'chorus', name: 'stereo_spread',
    displayLabel: 'Stereo Spread',
    pidLow: 0x004e, pidHigh: 0x001a,
    // Cache id=26: float a=-2 b=2 c=100 → display = wire × 100,
    // range -200..200% (bipolar with extended range).
    unit: 'bipolar_percent', displayMin: -200, displayMax: 200,
  },
  // 2026-04-25: wire-verified at +10 dB on
  // an Analog Stereo flanger — `session-32-flanger-extended.pcapng`.
  // Follows the universal pidHigh=0x0000 Level pattern.
  'flanger.level': {
    block: 'flanger', name: 'level',
    pidLow: 0x0052, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'flanger.mix': {
    // resolved: NOT an encoding bug.
    // AM4-Edit wire for Mix→54% wrote pidLow=0x0052/pidHigh=0x0001
    // with float32(0.54) — byte-identical to our `unit: 'percent'`
    // builder. the hardware-display readback (54%→50%) is a
    // hardware-screen rendering quirk; verify via AM4-Edit.
    block: 'flanger', name: 'mix',
    pidLow: 0x0052, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'flanger.type': {
    block: 'flanger', name: 'type',
    pidLow: 0x0052, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 31,
    enumValues: FLANGER_TYPES_VALUES,
  },
  // wire-verified at 1.7 Hz on an
  // Analog Stereo flanger (left unconfirmed in Round 2).
  'flanger.rate': {
    block: 'flanger', name: 'rate',
    displayLabel: 'Rate',
    pidLow: 0x0052, pidHigh: 0x000b,
    unit: 'hz', displayMin: 0.05, displayMax: 10,
    scaling: 'log10',
  },
  'flanger.depth': {
    block: 'flanger', name: 'depth',
    displayLabel: 'Depth',
    pidLow: 0x0052, pidHigh: 0x000d,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'flanger.feedback': {
    // resolved: NOT an encoding bug.
    // AM4-Edit wire for Feedback→-61% wrote pidLow=0x0052/pidHigh=0x000e
    // with float32(-0.61) — byte-identical to our `unit: 'bipolar_percent'`
    // builder. the hardware-display readbacks (-61%→0; +99%→+90)
    // are hardware-screen rendering quirks; verify via AM4-Edit.
    block: 'flanger', name: 'feedback',
    displayLabel: 'Feedback',
    pidLow: 0x0052, pidHigh: 0x000e,
    // Cache caps internal range at ±0.995 — display scale 100 ⇒ ±99%.
    unit: 'bipolar_percent', displayMin: -99, displayMax: 99,
  },
  // 2026-04-26: wire-verified on Analog Stereo
  // flanger — `session-30-flanger-basic.pcapng`. Manual is a 0–10 knob
  // (no unit suffix shown in AM4-Edit); Mod Phase mirrors the chorus
  // degrees encoding.
  'flanger.manual': {
    block: 'flanger', name: 'manual',
    displayLabel: 'Manual',
    pidLow: 0x0052, pidHigh: 0x000f,
    // Cache id=15: float a=0 b=1 c=10 → display 0..10.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'flanger.mod_phase': {
    block: 'flanger', name: 'mod_phase',
    displayLabel: 'Mod Phase',
    pidLow: 0x0052, pidHigh: 0x0011,
    // Cache id=17: float a=0 b=π c=180/π → display 0..180 deg.
    unit: 'degrees', displayMin: 0, displayMax: 180,
  },
  'phaser.mix': {
    // resolved: NOT an encoding bug.
    // AM4-Edit wire for Mix→88% wrote pidLow=0x005a/pidHigh=0x0001
    // with float32(0.88) — byte-identical to our `unit: 'percent'`
    // builder. the hardware-display readback (88%→53%) is a
    // hardware-screen rendering quirk; verify via AM4-Edit.
    block: 'phaser', name: 'mix',
    pidLow: 0x005a, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'phaser.type': {
    block: 'phaser', name: 'type',
    pidLow: 0x005a, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 16,
    enumValues: PHASER_TYPES_VALUES,
  },
  // wire-verified at 2.3 Hz on a Digital
  // Mono phaser (left unconfirmed in Round 2).
  'phaser.rate': {
    block: 'phaser', name: 'rate',
    displayLabel: 'Rate',
    pidLow: 0x005a, pidHigh: 0x000c,
    unit: 'hz', displayMin: 0.1, displayMax: 10,
    scaling: 'log10',
  },
  'phaser.feedback': {
    block: 'phaser', name: 'feedback',
    displayLabel: 'Feedback',
    pidLow: 0x005a, pidHigh: 0x0010,
    // Cache signature is unusual — internal ±0.9, display-scale 111.1.
    // We use standard bipolar_percent (scale 100) with clamped bounds
    // so input stays inside the internal range; AM4-Edit's displayed
    // percentage may read slightly higher than the value set (an input
    // of "50" sets internal 0.5 which AM4-Edit shows as ~55.5%). The
    // natural-language UX impact is negligible.
    unit: 'bipolar_percent', displayMin: -90, displayMax: 90,
  },
  // 2026-04-26: wire-verified on Digital Stereo
  // phaser — `session-30-phaser-basic.pcapng`. Phaser uses 0–10 knob
  // semantics for Depth + Manual (unlike chorus/flanger which use
  // percent for Depth). Mod Phase address differs from chorus/flanger
  // (0x0013 here vs 0x0011 there) — cache lays it out at id=19 not id=17.
  'phaser.level': {
    block: 'phaser', name: 'level',
    pidLow: 0x005a, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'phaser.depth': {
    block: 'phaser', name: 'depth',
    displayLabel: 'Depth',
    pidLow: 0x005a, pidHigh: 0x000f,
    // Cache id=15: float a=0 b=1 c=10 → display 0..10.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'phaser.mod_phase': {
    block: 'phaser', name: 'mod_phase',
    displayLabel: 'Mod Phase',
    pidLow: 0x005a, pidHigh: 0x0013,
    // Cache id=19: float a=0 b=π c=180/π → display 0..180 deg.
    unit: 'degrees', displayMin: 0, displayMax: 180,
  },
  'phaser.manual': {
    block: 'phaser', name: 'manual',
    displayLabel: 'Manual',
    pidLow: 0x005a, pidHigh: 0x0022,
    // Cache id=34: float a=0 b=1 c=10 → display 0..10.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'wah.type': {
    block: 'wah', name: 'type',
    pidLow: 0x005e, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 8,
    enumValues: WAH_TYPES_VALUES,
  },
  // 2026-04-29: Wah Expert-Edit page from
  // session-40-wah-expert.pcapng (FAS Wah). 18 new params + 3 hand-
  // authored enums. Closes the wah block from "type-only" registration
  // to full Expert coverage.
  //
  // ** audit ( cont, 2026-04-29):** Eight wah ids were
  // mis-named in the original auto-generation pass — the cache-id →
  // pidHigh ordering didn't match the AM4-Edit screenshot's knob
  // labels. Re-derived from the value-matched audit table (`scripts/
  // audit-block-vs-screenshot.ts` against `docs/audit-input/wah.json`).
  // Old → new:
  //   0x000d  q (range 2..20)         → q_resonance (range 0..10)
  //   0x000e  q_resonance              → q_tracking
  //   0x000f  q_tracking                → wah_control
  //   0x0010  control_taper + drive    → fat
  //                  (was duplicate-pidHigh code bug — now resolved)
  //   0x0011  fat                       → drive
  //   0x0012  (unregistered)            → control_taper (enum, hand-authored)
  //   0x0013  low_cut_frequency         → inductor_bias (knob_0_10)
  //   0x0014  inductor_bias (hz)        → low_cut_frequency (hz)
  'wah.level': {
    block: 'wah', name: 'level',
    pidLow: 0x005e, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'wah.bypass_mode': {
    block: 'wah', name: 'bypass_mode',
    pidLow: 0x005e, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Thru', 1: 'Mute' },
  },
  // renamed for UI-label match (audit row: WAH 11)
  'wah.minimum_frequency': {
    block: 'wah', name: 'minimum_frequency',
    displayLabel: 'Minimum Frequency',
    pidLow: 0x005e, pidHigh: 0x000b,
    unit: 'hz', displayMin: 100, displayMax: 1000,
    scaling: 'log10',
  },
  // renamed for UI-label match (audit row: WAH 12)
  'wah.maximum_frequency': {
    block: 'wah', name: 'maximum_frequency',
    displayLabel: 'Maximum Frequency',
    pidLow: 0x005e, pidHigh: 0x000c,
    // Cache id=12: a=500 b=5000 c=1.
    unit: 'hz', displayMin: 500, displayMax: 5000,
    scaling: 'log10',
  },
  'wah.q_resonance': {
    block: 'wah', name: 'q_resonance',
    displayLabel: 'Resonance',
    pidLow: 0x005e, pidHigh: 0x000d,
    // : was `wah.q` with range 2..20. Screenshot showed 4.44 at
    // wire 0.444, which only matches knob_0_10 (×10). Range corrected.
    // typecode 80 → log10 ( cont); displayMin=0 falls back to linear.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
    scaling: 'log10',
  },
  'wah.q_tracking': {
    block: 'wah', name: 'q_tracking',
    displayLabel: 'Q Tracking',
    pidLow: 0x005e, pidHigh: 0x000e,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'wah.wah_control': {
    block: 'wah', name: 'wah_control',
    displayLabel: 'Wah Control',
    pidLow: 0x005e, pidHigh: 0x000f,
    // : the actual pedal-position param. Without it, cocked-wah
    // presets are blocked — Claude can't sweep the wah filter sweep.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'wah.fat': {
    block: 'wah', name: 'fat',
    displayLabel: 'Fat',
    pidLow: 0x005e, pidHigh: 0x0010,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'wah.drive': {
    block: 'wah', name: 'drive',
    displayLabel: 'Drive',
    pidLow: 0x005e, pidHigh: 0x0011,
    // typecode 80 → log10 ( cont); displayMin=0 falls back to linear.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
    scaling: 'log10',
  },
  'wah.control_taper': {
    block: 'wah', name: 'control_taper',
    displayLabel: 'Control Taper',
    pidLow: 0x005e, pidHigh: 0x0012,
    // : previously registered at 0x0010 (wrong pidHigh). The
    // captured wire at 0x0012 is float32(4) = enum index 4 = "Log 10A",
    // matching the screenshot's Control Taper dropdown.
    // Cache id=18 enum has 6 entries (max=5).
    unit: 'enum', displayMin: 0, displayMax: 5,
    enumValues: { 0: 'LINEAR', 1: 'LOG 30A', 2: 'LOG 20A', 3: 'LOG 15A', 4: 'LOG 10A', 5: 'LOG 5A' },
  },
  'wah.inductor_bias': {
    block: 'wah', name: 'inductor_bias',
    displayLabel: 'Inductor Bias',
    pidLow: 0x005e, pidHigh: 0x0013,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'wah.low_cut_frequency': {
    block: 'wah', name: 'low_cut_frequency',
    displayLabel: 'Low Cut Frequency',
    pidLow: 0x005e, pidHigh: 0x0014,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'wah.eq_post': {
    block: 'wah', name: 'eq_post',
    displayLabel: 'EQ',
    pidLow: 0x005e, pidHigh: 0x0015,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'wah.graphic_eq_band_1': { block: 'wah', name: 'graphic_eq_band_1', displayLabel: '160', pidLow: 0x005e, pidHigh: 0x0016, unit: 'db', displayMin: -12, displayMax: 12 },
  'wah.graphic_eq_band_2': { block: 'wah', name: 'graphic_eq_band_2', displayLabel: '250', pidLow: 0x005e, pidHigh: 0x0017, unit: 'db', displayMin: -12, displayMax: 12 },
  'wah.graphic_eq_band_3': { block: 'wah', name: 'graphic_eq_band_3', displayLabel: '400', pidLow: 0x005e, pidHigh: 0x0018, unit: 'db', displayMin: -12, displayMax: 12 },
  'wah.graphic_eq_band_4': { block: 'wah', name: 'graphic_eq_band_4', displayLabel: '640', pidLow: 0x005e, pidHigh: 0x0019, unit: 'db', displayMin: -12, displayMax: 12 },
  'wah.graphic_eq_band_5': { block: 'wah', name: 'graphic_eq_band_5', displayLabel: '1000', pidLow: 0x005e, pidHigh: 0x001a, unit: 'db', displayMin: -12, displayMax: 12 },
  'wah.graphic_eq_band_6': { block: 'wah', name: 'graphic_eq_band_6', displayLabel: '1600', pidLow: 0x005e, pidHigh: 0x001b, unit: 'db', displayMin: -12, displayMax: 12 },
  'wah.graphic_eq_band_7': { block: 'wah', name: 'graphic_eq_band_7', displayLabel: '2500', pidLow: 0x005e, pidHigh: 0x001c, unit: 'db', displayMin: -12, displayMax: 12 },
  'wah.graphic_eq_band_8': { block: 'wah', name: 'graphic_eq_band_8', displayLabel: '4000', pidLow: 0x005e, pidHigh: 0x001d, unit: 'db', displayMin: -12, displayMax: 12 },
  'compressor.mix': {
    block: 'compressor', name: 'mix',
    pidLow: 0x002e, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // 2026-04-25: Compressor first-page registers
  // from session-30-comp-basic-jfet-studio. Cache ids 10..15 are the
  // canonical comp-config knobs (Threshold, Ratio, Attack, Release,
  // Knee Type enum, Auto Makeup OFF/ON). `level` follows the universal
  // pidHigh=0x0000 "Level" pattern (out-of-band hand-author).
  // Two more registers wiggled in the capture remain unidentified
  // (pidHigh=0x0017 cache id=23 float; pidHigh=0x0029 cache id=41
  // knob_0_10 with value 1.2 exceeding cache cap b=1) — queued as
  //  follow-up. The Optical/JFET-specific Light Type knob
  // wasn't reached in this capture.
  'compressor.level': {
    block: 'compressor', name: 'level',
    pidLow: 0x002e, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'compressor.threshold': {
    block: 'compressor', name: 'threshold',
    displayLabel: 'Threshold',
    pidLow: 0x002e, pidHigh: 0x000a,
    // Cache id=10: float a=-60 b=20 c=1 → dB -60..+20 (capture wrote
    // -30 dB).
    unit: 'db', displayMin: -60, displayMax: 20,
  },
  'compressor.ratio': {
    block: 'compressor', name: 'ratio',
    displayLabel: 'Ratio',
    pidLow: 0x002e, pidHigh: 0x000b,
    // Cache id=11: float a=1 b=20 c=1 step=0.01 → 1.0..20.0 ratio
    // (e.g. 4.0 ⇒ 4:1). Uses the `ratio` unit semantically; math is
    // identical to db/hz/seconds (display = internal, scale 1) but
    // the label tells Claude "4 means 4:1, not 4 dB".
    // typecode=64 → log10 scaling. Read
    // register stores Q15 of log10-normalized internal across [1..20].
    unit: 'ratio', displayMin: 1, displayMax: 20, scaling: 'log10',
  },
  // renamed for UI-label match (audit row: COMP 12)
  'compressor.attack_time': {
    block: 'compressor', name: 'attack_time',
    displayLabel: 'Attack Time',
    pidLow: 0x002e, pidHigh: 0x000c,
    // Cache id=12: float a=0.0001 b=0.1 c=1000 → 0.1..100 ms.
    // typecode=68 → log10 scaling. Verified
    // empirically — Sultans test wrote 40 ms, readback decoded as 867 ms
    // with old linear rule; with log10 rule, internal 0.867 → 40.0 ms.
    unit: 'ms', displayMin: 0.1, displayMax: 100, scaling: 'log10',
  },
  // renamed for UI-label match (audit row: COMP 13)
  'compressor.release_time': {
    block: 'compressor', name: 'release_time',
    displayLabel: 'Release Time',
    pidLow: 0x002e, pidHigh: 0x000d,
    // Cache id=13: float a=0.002 b=2 c=1000 → 2..2000 ms.
    // typecode=68 → log10 scaling. Sultans
    // test wrote 100 ms; readback internal 0.566 → log10 decode → 100 ms.
    unit: 'ms', displayMin: 2, displayMax: 2000, scaling: 'log10',
  },
  'compressor.auto_makeup': {
    block: 'compressor', name: 'auto_makeup',
    displayLabel: 'Auto Makeup',
    pidLow: 0x002e, pidHigh: 0x000f,
    // Cache id=15: enum [OFF|ON]. Hand-authored — see delay.stack_hold
    // for why per-block non-Type enums skip the generator.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'compressor.type': {
    block: 'compressor', name: 'type',
    pidLow: 0x002e, pidHigh: 0x0013,
    unit: 'enum', displayMin: 0, displayMax: 18,
    enumValues: COMPRESSOR_TYPES_VALUES,
  },
  // 2026-04-29: Compressor Expert-Edit
  // Sidechain section + Drive-engine knobs from
  // session-31-comp-jfet-expert.pcapng + paired AM4-Edit screenshot
  // (JFET Studio Compressor type). Closes the prior gap: 0x0017 = comp.emphasis
  // (knob_0_20 fine knob 0..20, screenshot 2.22 ↔ wire 0.111×20=2.22);
  // 0x0029 = comp.drive (knob_0_10, screenshot 6.66 ↔ wire 0.666). The
  // Sidechain section pins eight new params (filter Frequency/Q/Gain/
  // Low Cut/High Cut/Source/Filter Type/Emphasis Freq) with cache shapes
  // matching screenshot labels byte-for-byte. bypass_mode (0x0004) and
  // input_level (0x0019) are universal MIX-section enums.
  //
  // Mirrored from CACHE_PARAMS so the type-check picks them up.
  'compressor.bypass_mode': {
    block: 'compressor', name: 'bypass_mode',
    pidLow: 0x002e, pidHigh: 0x0004,
    // Cache id=4: enum [Thru / Mute FX Out / Mute Out]. Hand-authored —
    // not Type, so gen-params skips the enum-import attachment.
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'Thru', 1: 'Mute FX Out', 2: 'Mute Out' },
  },
  'compressor.sidechain_low_cut': {
    block: 'compressor', name: 'sidechain_low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x002e, pidHigh: 0x0011,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'compressor.sidechain_source': {
    block: 'compressor', name: 'sidechain_source',
    displayLabel: 'Sidechain Source',
    pidLow: 0x002e, pidHigh: 0x0012,
    // Cache id=18: enum [BLOCK L+R / INPUT 1 / BLOCK L / BLOCK R].
    // Same enum strings as gate.sidechain (capture wrote index 3 =
    // BLOCK R; matches screenshot "Block R").
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'BLOCK L+R', 1: 'INPUT 1', 2: 'BLOCK L', 3: 'BLOCK R' },
  },
  'compressor.look_ahead_time': {
    block: 'compressor', name: 'look_ahead_time',
    displayLabel: 'Look-Ahead Time',
    pidLow: 0x002e, pidHigh: 0x0015,
    // Cache id=21: float a=0 b=0.002 c=1000 → 0..2 ms (fine resolution).
    unit: 'ms', displayMin: 0, displayMax: 2,
  },
  'compressor.emphasis': {
    block: 'compressor', name: 'emphasis',
    displayLabel: 'Emphasis',
    pidLow: 0x002e, pidHigh: 0x0017,
    // Cache id=23: float a=0 b=1 c=20 step=0.0005 → 0..20 fine knob.
    // First param to use the new `knob_0_20` unit ( closure).
    unit: 'knob_0_20', displayMin: 0, displayMax: 20,
  },
  'compressor.input_level': {
    block: 'compressor', name: 'input_level',
    displayLabel: 'Input Level',
    pidLow: 0x002e, pidHigh: 0x0019,
    // Cache id=25: enum [INSTRUMENT / LINE]. Capture wrote index 0 =
    // INSTRUMENT; matches screenshot "Instrument".
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'INSTRUMENT', 1: 'LINE' },
  },
  'compressor.sidechain_high_cut': {
    block: 'compressor', name: 'sidechain_high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x002e, pidHigh: 0x001a,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'compressor.sidechain_gain': {
    block: 'compressor', name: 'sidechain_gain',
    displayLabel: 'Gain',
    pidLow: 0x002e, pidHigh: 0x001b,
    unit: 'db', displayMin: -12, displayMax: 12,
  },
  'compressor.sidechain_frequency': {
    block: 'compressor', name: 'sidechain_frequency',
    displayLabel: 'Frequency',
    pidLow: 0x002e, pidHigh: 0x001c,
    unit: 'hz', displayMin: 100, displayMax: 10000,
    scaling: 'log10',
  },
  'compressor.sidechain_q': {
    block: 'compressor', name: 'sidechain_q',
    displayLabel: 'Q',
    pidLow: 0x002e, pidHigh: 0x001d,
    // Cache id=29: float a=0.1 b=10 c=1 → 0.1..10 fractional Q. Uses
    // `count` for the raw-passthrough scale (display = wire × 1) — the
    // unit is structural; Q is a quality factor, not a literal count.
    unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10',
  },
  'compressor.sidechain_filter_type': {
    block: 'compressor', name: 'sidechain_filter_type',
    displayLabel: 'Filter Type',
    pidLow: 0x002e, pidHigh: 0x0020,
    // closed 2026-04-30: cache id=32 enum has all 12 entries
    // (the earlier "4-entry truncation" finding was a
    // stale parse — `cache-section2.json` confirms count=12, max=11).
    // Hand-authored rather than emitted via gen-params-from-cache because
    // the generator's per-block `enumImport` only targets the Type
    // dropdown (id=19 here); non-Type enums are inlined.
    unit: 'enum', displayMin: 0, displayMax: 11,
    enumValues: {
      0: 'NULL',
      1: 'LOWPASS',
      2: 'BANDPASS',
      3: 'HIGHPASS',
      4: 'LOWSHELF',
      5: 'HIGHSHELF',
      6: 'PEAKING',
      7: 'NOTCH',
      8: 'TILT EQ',
      9: 'LOWSHELF 2',
      10: 'HIGHSHELF 2',
      11: 'PEAKING 2',
    },
  },
  'compressor.sidechain_emphasis_freq': {
    block: 'compressor', name: 'sidechain_emphasis_freq',
    displayLabel: 'Emphasis Freq',
    pidLow: 0x002e, pidHigh: 0x0027,
    unit: 'hz', displayMin: 100, displayMax: 10000,
    scaling: 'log10',
  },
  'compressor.drive': {
    block: 'compressor', name: 'drive',
    displayLabel: 'Drive',
    pidLow: 0x002e, pidHigh: 0x0029,
    // Cache id=41: float a=0 b=1 c=10 → knob_0_10. Earlier note: the
    // earlier capture wrote 1.2 (exceeds cache cap b=1) — that capture
    // was one of the AM4-Edit-side wiggles that briefly went past the
    // displayed range; the current capture wire is 0.666 → display 6.66
    // matches screenshot "Drive 6.66" cleanly.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'geq.type': {
    block: 'geq', name: 'type',
    pidLow: 0x0032, pidHigh: 0x0014,
    unit: 'enum', displayMin: 0, displayMax: 17,
    enumValues: GEQ_TYPES_VALUES,
  },
  // continued — 5 more Type/Mode selectors from block-placement
  // captures. PEQ (pidLow=0x36) and Rotary (pidLow=0x56) are also confirmed
  // block addresses but have no Type enum — their params will be added when
  // we start supporting specific knob names.
  // 2026-04-25: wire-verified at +12 dB on
  // a Low-Pass filter — `session-32-filter-extended.pcapng`. Follows
  // the universal pidHigh=0x0000 Level pattern.
  'filter.level': {
    block: 'filter', name: 'level',
    pidLow: 0x0072, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'filter.mix': {
    block: 'filter', name: 'mix',
    pidLow: 0x0072, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'filter.type': {
    block: 'filter', name: 'type',
    pidLow: 0x0072, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 17,
    enumValues: FILTER_TYPES_VALUES,
  },
  // renamed for UI-label match (audit row: FILTER 11)
  'filter.frequency': {
    // Blocks Guide §Filter: Frequency is the filter cutoff. 20..20000 Hz,
    // c=1 raw (uses 'hz' unit).: wire-verified
    // on Low-Pass at 1250 Hz; readback was 1249.9 Hz. The 0.1 Hz drift is
    // float→fixed-point quantization noise in the firmware (8e-5 relative
    // error), not a wire-layer encoding bug — drift scales with frequency.
    // Functionally inaudible; do not assume exact equality on round-trip
    // when comparing presets that differ only in filter.frequency.
    block: 'filter', name: 'frequency',
    displayLabel: 'Frequency',
    pidLow: 0x0072, pidHigh: 0x000b,
    unit: 'hz', displayMin: 20, displayMax: 20000,
    scaling: 'log10',
  },
  // 2026-04-25: filter Config-page cuts.
  // Wire-verified at 100 Hz / 1800 Hz on a Low-Pass filter
  // (`session-32-filter-extended.pcapng`). Cache c=1 raw Hz at ids
  // 18 / 19. Mirrored from CACHE_PARAMS so the type-check picks them up.
  'filter.low_cut': {
    block: 'filter', name: 'low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x0072, pidHigh: 0x0012,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'filter.high_cut': {
    block: 'filter', name: 'high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x0072, pidHigh: 0x0013,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  // 2026-04-26: All-Pass filter Config-page
  // residuals — `session-33-filter-extended.pcapng`. Wire-verified
  // at 13% Feedback / 4-pole Order. Feedback cache signature
  // (a=-1, b=1, c=100) is bipolar_percent ±100 (All-Pass feedback
  // can invert phase). Order is an integer pole count 1..12 — cache
  // typecode=0x0010 with c=1 raw. AM4-Edit's UI dropdown limits the
  // exposed options per filter type (All-Pass shows 2/4/6/8/10/12;
  // Low-Pass shows 2/4 only at cache id=14), but the wire register
  // accepts any integer in the cache range.
  'filter.feedback': {
    block: 'filter', name: 'feedback',
    displayLabel: 'Feedback',
    pidLow: 0x0072, pidHigh: 0x0015,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  'filter.order': {
    block: 'filter', name: 'order',
    displayLabel: 'Order',
    pidLow: 0x0072, pidHigh: 0x001c,
    unit: 'count', displayMin: 1, displayMax: 12,
  },
  'tremolo.mix': {
    block: 'tremolo', name: 'mix',
    pidLow: 0x006a, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'tremolo.type': {
    block: 'tremolo', name: 'type',
    pidLow: 0x006a, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 6,
    enumValues: TREMOLO_TYPES_VALUES,
  },
  'tremolo.rate': {
    block: 'tremolo', name: 'rate',
    displayLabel: 'Rate',
    pidLow: 0x006a, pidHigh: 0x000c,
    unit: 'hz', displayMin: 0.2, displayMax: 20,
    scaling: 'log10',
  },
  'tremolo.depth': {
    block: 'tremolo', name: 'depth',
    displayLabel: 'Depth',
    pidLow: 0x006a, pidHigh: 0x000d,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // 2026-04-26: wire-verified on Panner-type
  // tremolo — `session-30-tremolo-basic.pcapng`. Tremolo's first page
  // is type-dependent: Panner exposes Width / Phase / Center / Ducking
  // / Waveform (instead of VCA Trem's Depth which lives at pidHigh
  // 0x000d). Level (pidHigh=0x0000) wasn't moved in this capture — to
  // be added when a future capture wiggles it.
  'tremolo.waveform': {
    block: 'tremolo', name: 'waveform',
    displayLabel: 'Waveform',
    pidLow: 0x006a, pidHigh: 0x000b,
    // Cache id=11 enum: 10-entry LFO_WAVEFORMS — SINE / TRIANGLE /
    // SQUARE / SAW UP / SAW DOWN / RANDOM / LOG / EXP / TRAPEZOID /
    // ASTABLE. Shared dictionary across modulation blocks (extracted
    // from chorus/id=18; cross-checked against flanger/phaser/tremolo).
    unit: 'enum', displayMin: 0, displayMax: 9,
    enumValues: LFO_WAVEFORMS_VALUES,
  },
  'tremolo.phase': {
    block: 'tremolo', name: 'phase',
    displayLabel: 'Phase',
    pidLow: 0x006a, pidHigh: 0x0010,
    // Cache id=16: float a=0 b=π c=180/π → display 0..180 deg.
    unit: 'degrees', displayMin: 0, displayMax: 180,
  },
  'tremolo.width': {
    block: 'tremolo', name: 'width',
    displayLabel: 'Width',
    pidLow: 0x006a, pidHigh: 0x0011,
    // Cache id=17: float a=0 b=4 c=100 — internal range allows up to
    // display 400, but AM4-Edit's Panner Width slider visually caps at
    // 100. Stay at 0..100 here; widen if a future capture proves
    // values >100 are user-reachable.
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'tremolo.center': {
    block: 'tremolo', name: 'center',
    displayLabel: 'Center',
    pidLow: 0x006a, pidHigh: 0x0012,
    // Cache id=18: float a=-1 b=1 c=100 → display -100..+100. Panner
    // center-pan position; 0 = dead center, ±100 = full L/R.
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  'tremolo.ducking': {
    block: 'tremolo', name: 'ducking',
    displayLabel: 'Ducking',
    pidLow: 0x006a, pidHigh: 0x0018,
    // Cache id=24: float a=0 b=1 c=10 → display 0..10.
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // 2026-04-29: Enhancer Config-page knobs from
  // session-33-enhancer-extended.pcapng + paired AM4-Edit screenshot.
  // Wire-verified on a Modern enhancer at level=-6 dB / width=33% /
  // depth=11% / low_cut=22.2 Hz / high_cut=6500 Hz. Level is the
  // universal pidHigh=0x0000 out-of-band pattern (no cache record);
  // width/depth/low_cut/high_cut are mirrored from CACHE_PARAMS so
  // the type-check picks them up.
  'enhancer.level': {
    block: 'enhancer', name: 'level',
    pidLow: 0x007a, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'enhancer.width': {
    block: 'enhancer', name: 'width',
    displayLabel: 'Width',
    pidLow: 0x007a, pidHigh: 0x000a,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'enhancer.depth': {
    block: 'enhancer', name: 'depth',
    displayLabel: 'Depth',
    pidLow: 0x007a, pidHigh: 0x000b,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'enhancer.low_cut': {
    block: 'enhancer', name: 'low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x007a, pidHigh: 0x000c,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'enhancer.high_cut': {
    block: 'enhancer', name: 'high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x007a, pidHigh: 0x000d,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  // finding F1 — `enhancer.mix` is a phantom
  // register on the AM4 hardware display. The Enhancer block exposes
  // Width / Phase Invert / Pan Left / Pan Right / Balance / Level on
  // its UI pages — no Mix knob anywhere. Wire writes still ack (the
  // SET_PARAM goes through and the firmware accepts it), but the
  // parameter likely has no audible effect. Cache id=1 has the same
  // signature as every other block's `mix` (percent, c=100), which is
  // why P1-010 Session B registered it via the universal Mix-Page rule.
  // Keep registered for now but treat as "wire-acked, no observed
  // hardware effect" — pending an audio-effect spot-check (queued
  // under  follow-ups).
  'enhancer.mix': {
    block: 'enhancer', name: 'mix',
    pidLow: 0x007a, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  //: wire-verified — type "Classic" displayed
  // exactly. AM4-Edit labels this "Mode" on the dropdown but we keep
  // `type` for consistency across blocks.
  'enhancer.type': {
    block: 'enhancer', name: 'type',
    pidLow: 0x007a, pidHigh: 0x000e,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: ENHANCER_TYPES_VALUES,
  },
  //: wire-verified — Modern Gate displayed
  // exactly. Round 4 first-time test for this block type.
  'gate.type': {
    block: 'gate', name: 'type',
    pidLow: 0x0092, pidHigh: 0x0013,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: GATE_TYPES_VALUES,
  },
  // 2026-04-26: slot-Gate first-page knobs on a
  // Modern Gate type — `session-34-slotgate-extended.pcapng`. Wire-
  // verified at Threshold=-22 dB / Attack=1 ms / Hold=80 ms /
  // Release=90 ms / Attenuation=-33 dB / Sidechain=INPUT 1 / Level=
  // 12 dB. Threshold/Attack/Hold/Release/Attenuation are mirrored
  // from CACHE_PARAMS. Level (pidHigh=0x0000) follows the universal
  // out-of-band Level pattern. Sidechain (pidHigh=0x000f) is a
  // 4-entry enum sourced directly from cache id=15 enum strings
  // (BLOCK L+R / INPUT 1 / BLOCK L / BLOCK R) — hand-authored
  // because the cache generator only attaches the block-wide
  // GATE_TYPES_VALUES import.
  'gate.level': {
    block: 'gate', name: 'level',
    pidLow: 0x0092, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'gate.threshold': {
    block: 'gate', name: 'threshold',
    displayLabel: 'Threshold',
    pidLow: 0x0092, pidHigh: 0x000a,
    unit: 'db', displayMin: -100, displayMax: 0,
  },
  'gate.attack': {
    block: 'gate', name: 'attack',
    displayLabel: 'Attack',
    pidLow: 0x0092, pidHigh: 0x000b,
    unit: 'ms', displayMin: 0, displayMax: 1000, scaling: 'log10',
  },
  'gate.hold': {
    block: 'gate', name: 'hold',
    displayLabel: 'Hold',
    pidLow: 0x0092, pidHigh: 0x000c,
    unit: 'ms', displayMin: 0, displayMax: 1000, scaling: 'log10',
  },
  'gate.release': {
    block: 'gate', name: 'release',
    displayLabel: 'Release',
    pidLow: 0x0092, pidHigh: 0x000d,
    unit: 'ms', displayMin: 0, displayMax: 1000, scaling: 'log10',
  },
  'gate.sidechain': {
    block: 'gate', name: 'sidechain',
    displayLabel: 'Sidechain',
    pidLow: 0x0092, pidHigh: 0x000f,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'BLOCK L+R', 1: 'INPUT 1', 2: 'BLOCK L', 3: 'BLOCK R' },
  },
  'gate.attenuation': {
    block: 'gate', name: 'attenuation',
    displayLabel: 'Attenuation',
    pidLow: 0x0092, pidHigh: 0x0014,
    unit: 'db', displayMin: -80, displayMax: 0,
  },
  //  partial (2026-05-02) — slot-Gate Modern Expander
  // Expert-Edit page from `session-44-gate-expert.{pcapng,png}`. 7 new
  // first-page registrations: ratio, sidechain_low_cut, sidechain_high_cut,
  // bypass_mode, knee_type, detector_type, mix-phantom. Modern Expander
  // exposes Ratio at 0x000e (replaces the fixed Attenuation that Modern
  // Gate exposes at 0x0014); same firmware register surface, different
  // type-dependent UI. Knee_type vs detector_type pidHigh assignment
  // disambiguated via single-knob-isolation capture
  // `session-46-gate-knee-isolation.pcapng` — 0x0016 moved (knee_type),
  // 0x0015 stayed (detector_type by elimination). Ratio range 1..20
  // founder-confirmed at the device. See docs/audit-output/gate.md for
  // the full audit table.
  'gate.ratio': {
    block: 'gate', name: 'ratio',
    displayLabel: 'Ratio',
    pidLow: 0x0092, pidHigh: 0x000e,
    unit: 'ratio', displayMin: 1, displayMax: 20, scaling: 'log10',
  },
  'gate.sidechain_low_cut': {
    block: 'gate', name: 'sidechain_low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x0092, pidHigh: 0x0010,
    unit: 'hz', displayMin: 20, displayMax: 2000,
  },
  'gate.sidechain_high_cut': {
    block: 'gate', name: 'sidechain_high_cut',
    displayLabel: 'High Cut',
    pidLow: 0x0092, pidHigh: 0x0011,
    unit: 'hz', displayMin: 200, displayMax: 20000,
    scaling: 'log10',
  },
  'gate.bypass_mode': {
    block: 'gate', name: 'bypass_mode',
    pidLow: 0x0092, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Thru', 1: 'Mute' },
  },
  // Detector type at 0x0015: wire 0 displayed as "RMS" in 
  // Modern Expander capture. Likely 2-entry enum {0:RMS, 1:Peak} — only
  // the observed entry is registered until founder confirms the full
  // table.
  'gate.detector_type': {
    block: 'gate', name: 'detector_type',
    displayLabel: 'Detector Type',
    pidLow: 0x0092, pidHigh: 0x0015,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'RMS' },
  },
  // Knee type at 0x0016: wire 4 displayed as "Soft".
  // Likely 5-entry enum {0:Hard, 1:Med Hard, 2:Med, 3:Med Soft, 4:Soft}
  // per typical compressor/gate UX — only the observed entry is
  // registered until founder confirms the full table.
  // renamed for UI-label match (audit row: GATE 22)
  'gate.knee': {
    block: 'gate', name: 'knee',
    displayLabel: 'Knee',
    pidLow: 0x0092, pidHigh: 0x0016,
    unit: 'enum', displayMin: 0, displayMax: 4,
    enumValues: { 4: 'Soft' },
  },
  // Phantom register: AM4-Edit displays "NA" for Mix on the Gate block
  // (gate is a dynamics block; absorb-vs-effect doesn't apply). Wire
  // still ack'd but no audible effect — same status as `enhancer.mix`
  // ( finding F1). Registered for completeness so the agent
  // doesn't surface it as a tweak target on its own.
  'gate.mix': {
    block: 'gate', name: 'mix',
    pidLow: 0x0092, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  //: wire-verified — Auto-Swell displayed
  // exactly. Round 4 first-time test for this block type.
  'volpan.mode': {
    // Block is "Volume/Pan"; this is the Volume-vs-Auto-Swell selector.
    block: 'volpan', name: 'mode',
    pidLow: 0x0066, pidHigh: 0x000f,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: VOLPAN_MODES_VALUES,
  },
  // 2026-04-25: Volume/Pan Auto-Swell
  // envelope params. Wire-verified at -20 dB / 300 ms on the Auto-Swell
  // type (`session-32-volpan-extended.pcapng`). Cache ids 16 / 17 with
  // c=1 (raw dB) and c=1000 (display ms) respectively. Mirrored from
  // CACHE_PARAMS so the type-check picks them up.
  'volpan.threshold': {
    block: 'volpan', name: 'threshold',
    displayLabel: 'Threshold',
    pidLow: 0x0066, pidHigh: 0x0010,
    unit: 'db', displayMin: -100, displayMax: 0,
  },
  'volpan.attack': {
    block: 'volpan', name: 'attack',
    displayLabel: 'Attack',
    pidLow: 0x0066, pidHigh: 0x0011,
    unit: 'ms', displayMin: 1, displayMax: 5000, scaling: 'log10',
  },
  // 2026-04-25: wire-verified at +12 dB on
  // an Auto-Swell Volume/Pan — `session-32-volpan-extended.pcapng`.
  // Follows the universal pidHigh=0x0000 Level pattern.
  'volpan.level': {
    block: 'volpan', name: 'level',
    pidLow: 0x0066, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  //  partial (2026-05-02) — Volume/Pan Expert-Edit
  // captures from `session-44-volpan-expert-{volume,autoswell}.{pcapng,png}`.
  // Confirmed type-dependent UI on volpan: Volume mode exposes
  // volume/pan_l/pan_r at 0x000a/c/d; Auto-Swell mode exposes
  // release/hysteresis at 0x0012/0x0013. Both modes share level/balance/
  // mix/bypass_mode/taper/input_select at the same pidHighs. Type-
  // agnostic firmware addressing — same pattern as gate. Hysteresis
  // range 0..12 dB founder-confirmed at the device. See
  // docs/audit-output/volpan-{volume,autoswell}.md for the full audit
  // tables.
  'volpan.volume': {
    block: 'volpan', name: 'volume',
    displayLabel: 'Volume',
    pidLow: 0x0066, pidHigh: 0x000a,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // renamed for UI-label match (audit row: VOLUME 12)
  'volpan.pan_left': {
    block: 'volpan', name: 'pan_left',
    displayLabel: 'Pan Left',
    pidLow: 0x0066, pidHigh: 0x000c,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  // renamed for UI-label match (audit row: VOLUME 13)
  'volpan.pan_right': {
    block: 'volpan', name: 'pan_right',
    displayLabel: 'Pan Right',
    pidLow: 0x0066, pidHigh: 0x000d,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  // Taper at 0x000b: shared register across Volume + Auto-Swell modes
  // with type-aware enum entries. Volume mode wire=5 → "Log 50";
  // Auto-Swell wire=1 → "Log 30A". Only observed entries registered
  // until founder confirms the full table.
  'volpan.taper': {
    block: 'volpan', name: 'taper',
    displayLabel: 'Taper',
    pidLow: 0x0066, pidHigh: 0x000b,
    unit: 'enum', displayMin: 0, displayMax: 10,
    enumValues: { 1: 'Log 30A', 5: 'Log 50' },
  },
  // Input Select at 0x000e: at minimum 3 entries observed across both
  // mode captures (wire=0 → "Stereo", wire=2 → "Right Only"). Index 1
  // unobserved but plausibly "Left Only". Full enum table needs founder
  // confirmation; registered with the partial mapping.
  'volpan.input_select': {
    block: 'volpan', name: 'input_select',
    displayLabel: 'Input Select',
    pidLow: 0x0066, pidHigh: 0x000e,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'Stereo', 2: 'Right Only' },
  },
  'volpan.bypass_mode': {
    block: 'volpan', name: 'bypass_mode',
    pidLow: 0x0066, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Thru', 1: 'Mute' },
  },
  // Auto-Swell-mode envelope params. Release mirrors attack at 0x0011
  // (same ms-stored-as-seconds + log10 scaling). Hysteresis is a dB
  // knob unique to Auto-Swell — no Volume-mode equivalent. Range
  // 0..12 dB founder-confirmed.
  'volpan.release': {
    block: 'volpan', name: 'release',
    displayLabel: 'Release',
    pidLow: 0x0066, pidHigh: 0x0012,
    unit: 'ms', displayMin: 1, displayMax: 5000, scaling: 'log10',
  },
  'volpan.hysteresis': {
    block: 'volpan', name: 'hysteresis',
    displayLabel: 'Hysteresis',
    pidLow: 0x0066, pidHigh: 0x0013,
    unit: 'db', displayMin: 0, displayMax: 12,
  },
  // Phantom register: AM4-Edit displays "NA" for Mix on Volume/Pan
  // (volpan is a signal-flow / routing block; absorb-vs-effect doesn't
  // apply). Wire still ack'd but no audible effect — same status as
  // `gate.mix` and `enhancer.mix`.
  'volpan.mix': {
    block: 'volpan', name: 'mix',
    pidLow: 0x0066, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },

  // Input Noise Gate. Always-on input stage
  // (per docs/BLOCK-PARAMS.md "Input Noise Gate (global, not a block
  // slot)"); not placeable in any of the 4 effect slots. Distinct from
  // the slot-placeable Gate effect block (pidLow=0x0092).
  // Wire-verified on `session-32-gate-extended.pcapng` against the
  // AM4-Edit "In-Gate" tab on Z04. Captured 4 distinct registers
  // (0x00 / 0x0a / 0x0c / 0x0f); `level` is the only one with a
  // unit-clean encoding so far. Threshold (0x0a, internal 0..1 →
  // display -100..0 dB), Release (0x0c, curve TBD) and Type (0x0f,
  // enum: Classic / Intelligent / Noise Reducer per the manual) need
  // a Unit-extension pass plus a type-walk capture and are queued as
  // . Pidlow 0x0025 has no cache backing — input gate isn't in
  // any of the 17 cache sub-blocks (none of the section 2 candidates
  // match its 4-register footprint).
  'ingate.level': {
    block: 'ingate', name: 'level',
    pidLow: 0x0025, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  // 2026-04-26: In-Gate Config-page residuals
  // from `session-34-inputgate-extended.pcapng`. Wire-verified at
  // Threshold=-44 dB / Release=60 ms / Type=Intelligent on the
  // In-Gate tab. All three were residuals queued for
  // unit + type-walk. Threshold curve is dB-direct (not the 0..1
  // normalized hypothesis from earlier — hardware writes raw dB).
  // Release uses the same display=internal × 1000 ms scaling as
  // every other release-style param. Type enum order matches
  // BLOCK-PARAMS.md (Classic Expander / Intelligent / Noise
  // Reducer); wire confirmed index 1 = Intelligent. No cache
  // backing — all hand-authored.
  'ingate.threshold': {
    block: 'ingate', name: 'threshold',
    displayLabel: 'Threshold',
    pidLow: 0x0025, pidHigh: 0x000a,
    unit: 'db', displayMin: -100, displayMax: 0,
  },
  'ingate.release': {
    block: 'ingate', name: 'release',
    displayLabel: 'Release',
    pidLow: 0x0025, pidHigh: 0x000c,
    unit: 'ms', displayMin: 0, displayMax: 1000,
  },
  'ingate.type': {
    block: 'ingate', name: 'type',
    displayLabel: 'Gate Type',
    pidLow: 0x0025, pidHigh: 0x000f,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'Classic Expander', 1: 'Intelligent', 2: 'Noise Reducer' },
  },

  // Universal per-block output Balance ( cont — P1-010
  // second unit-extension pass, introduced `bipolar_percent`).
  // Blocks Guide line 347: "Every block outputs both left and right
  // signals. As you adjust to the left or right, the opposite channel
  // [is reduced]." Confirmed as a universal block-level parameter at
  // lines 899 (Amp), 1233 (Chorus), 1430 (Flanger), 1733 (Delay),
  // 1883 (Phaser). Cache signature is identical across all 15
  // confirmed blocks: id=2, a=-1, b=1, c=100 (display = internal ×
  // 100, so -100..+100%).
  //
  // Hardware-display visibility per block ( +  finding F2):
  //   visible: enhancer.balance ( at -33%), geq.balance (
  //     at -67), volpan.balance is type-specific to the Pan range —
  //     classified as an effect-block balance below.
  //   hidden (wire-acked, no display readout): amp / compressor /
  //     reverb / delay / chorus / flanger / phaser / wah / tremolo /
  //     filter / drive / gate / volpan.
  // Visibility is block-type-dependent — the enhancer is a stereo
  // utility block where balance/pan controls are core, while effect
  // blocks treat balance as a hidden output mixer. Hidden writes still
  // affect the stereo image at the audio path (per Blocks Guide line
  // 347 — universal at the firmware level); audio-effect spot-check
  // queued under .
  'amp.balance':       { block: 'amp',        name: 'balance', pidLow: 0x003a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'compressor.balance':{ block: 'compressor', name: 'balance', pidLow: 0x002e, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'geq.balance':       { block: 'geq',        name: 'balance', pidLow: 0x0032, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'reverb.balance':    { block: 'reverb',     name: 'balance', pidLow: 0x0042, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'delay.balance':     { block: 'delay',      name: 'balance', pidLow: 0x0046, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'chorus.balance':    { block: 'chorus',     name: 'balance', pidLow: 0x004e, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'flanger.balance':   { block: 'flanger',    name: 'balance', pidLow: 0x0052, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'phaser.balance':    { block: 'phaser',     name: 'balance', pidLow: 0x005a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'wah.balance':       { block: 'wah',        name: 'balance', pidLow: 0x005e, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'tremolo.balance':   { block: 'tremolo',    name: 'balance', pidLow: 0x006a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'filter.balance':    { block: 'filter',     name: 'balance', pidLow: 0x0072, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'drive.balance':     { block: 'drive',      name: 'balance', pidLow: 0x0076, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'enhancer.balance':  { block: 'enhancer',   name: 'balance', pidLow: 0x007a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'gate.balance':      { block: 'gate',       name: 'balance', pidLow: 0x0092, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'volpan.balance':    { block: 'volpan',     name: 'balance', pidLow: 0x0066, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  // 2026-04-29: peq + rotary + geq + wah balance
  // mirrors. Plus the new-block universal mix entries.
  'peq.balance':       { block: 'peq',        name: 'balance', pidLow: 0x0036, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'rotary.balance':    { block: 'rotary',     name: 'balance', pidLow: 0x0056, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'wah.mix':           { block: 'wah',        name: 'mix',     pidLow: 0x005e, pidHigh: 0x0001, unit: 'percent', displayMin: 0, displayMax: 100 },
  'peq.mix':           { block: 'peq',        name: 'mix',     pidLow: 0x0036, pidHigh: 0x0001, unit: 'percent', displayMin: 0, displayMax: 100 },
  'rotary.mix':        { block: 'rotary',     name: 'mix',     pidLow: 0x0056, pidHigh: 0x0001, unit: 'percent', displayMin: 0, displayMax: 100 },
  // GEQ Expert-Edit 10-band mirrors + master_q.
  'geq.mix':           { block: 'geq',        name: 'mix',     pidLow: 0x0032, pidHigh: 0x0001, unit: 'percent', displayMin: 0, displayMax: 100 },
  'geq.band_1':  { block: 'geq', name: 'band_1', displayLabel: '31',  pidLow: 0x0032, pidHigh: 0x000a, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_2':  { block: 'geq', name: 'band_2', displayLabel: '63',  pidLow: 0x0032, pidHigh: 0x000b, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_3':  { block: 'geq', name: 'band_3', displayLabel: '125',  pidLow: 0x0032, pidHigh: 0x000c, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_4':  { block: 'geq', name: 'band_4', displayLabel: '250',  pidLow: 0x0032, pidHigh: 0x000d, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_5':  { block: 'geq', name: 'band_5', displayLabel: '500',  pidLow: 0x0032, pidHigh: 0x000e, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_6':  { block: 'geq', name: 'band_6', displayLabel: '1k',  pidLow: 0x0032, pidHigh: 0x000f, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_7':  { block: 'geq', name: 'band_7', displayLabel: '2k',  pidLow: 0x0032, pidHigh: 0x0010, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_8':  { block: 'geq', name: 'band_8', displayLabel: '4k',  pidLow: 0x0032, pidHigh: 0x0011, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_9':  { block: 'geq', name: 'band_9', displayLabel: '8k',  pidLow: 0x0032, pidHigh: 0x0012, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.band_10': { block: 'geq', name: 'band_10', displayLabel: '16k', pidLow: 0x0032, pidHigh: 0x0013, unit: 'db', displayMin: -12, displayMax: 12 },
  'geq.master_q': { block: 'geq', name: 'master_q', displayLabel: 'Master Q', pidLow: 0x0032, pidHigh: 0x0015, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  // PEQ 5-channel parametric EQ mirrors (frequency / Q / gain × 5 channels).
  'peq.channel_1_frequency': { block: 'peq', name: 'channel_1_frequency', displayLabel: 'Freq 1', pidLow: 0x0036, pidHigh: 0x000a, unit: 'hz', displayMin: 20, displayMax: 2000, scaling: 'log10' },
  'peq.channel_2_frequency': { block: 'peq', name: 'channel_2_frequency', displayLabel: 'Freq 2', pidLow: 0x0036, pidHigh: 0x000b, unit: 'hz', displayMin: 100, displayMax: 10000, scaling: 'log10' },
  'peq.channel_3_frequency': { block: 'peq', name: 'channel_3_frequency', displayLabel: 'Freq 3', pidLow: 0x0036, pidHigh: 0x000c, unit: 'hz', displayMin: 100, displayMax: 10000, scaling: 'log10' },
  'peq.channel_4_frequency': { block: 'peq', name: 'channel_4_frequency', displayLabel: 'Freq 4', pidLow: 0x0036, pidHigh: 0x000d, unit: 'hz', displayMin: 100, displayMax: 10000, scaling: 'log10' },
  'peq.channel_5_frequency': { block: 'peq', name: 'channel_5_frequency', displayLabel: 'Freq 5', pidLow: 0x0036, pidHigh: 0x000e, unit: 'hz', displayMin: 200, displayMax: 20000, scaling: 'log10' },
  'peq.channel_1_q': { block: 'peq', name: 'channel_1_q', displayLabel: 'Q1', pidLow: 0x0036, pidHigh: 0x000f, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'peq.channel_2_q': { block: 'peq', name: 'channel_2_q', displayLabel: 'Q2', pidLow: 0x0036, pidHigh: 0x0010, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'peq.channel_3_q': { block: 'peq', name: 'channel_3_q', displayLabel: 'Q3', pidLow: 0x0036, pidHigh: 0x0011, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'peq.channel_4_q': { block: 'peq', name: 'channel_4_q', displayLabel: 'Q4', pidLow: 0x0036, pidHigh: 0x0012, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'peq.channel_5_q': { block: 'peq', name: 'channel_5_q', displayLabel: 'Q5', pidLow: 0x0036, pidHigh: 0x0013, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'peq.channel_1_gain': { block: 'peq', name: 'channel_1_gain', displayLabel: 'Gain 1', pidLow: 0x0036, pidHigh: 0x0014, unit: 'db', displayMin: -20, displayMax: 20 },
  'peq.channel_2_gain': { block: 'peq', name: 'channel_2_gain', displayLabel: 'Gain 2', pidLow: 0x0036, pidHigh: 0x0015, unit: 'db', displayMin: -20, displayMax: 20 },
  'peq.channel_3_gain': { block: 'peq', name: 'channel_3_gain', displayLabel: 'Gain 3', pidLow: 0x0036, pidHigh: 0x0016, unit: 'db', displayMin: -20, displayMax: 20 },
  'peq.channel_4_gain': { block: 'peq', name: 'channel_4_gain', displayLabel: 'Gain 4', pidLow: 0x0036, pidHigh: 0x0017, unit: 'db', displayMin: -20, displayMax: 20 },
  'peq.channel_5_gain': { block: 'peq', name: 'channel_5_gain', displayLabel: 'Gain 5', pidLow: 0x0036, pidHigh: 0x0018, unit: 'db', displayMin: -20, displayMax: 20 },
  //  audit ( cont, 2026-04-29): PEQ Bypass Mode +
  // 5 per-channel Type enums + 5 per-channel Solo toggles. Founder
  // confirmed labels from `session-40-peq-expert.png`. Cache provides
  // each channel's Type enum entries (different shapes per channel —
  // e.g. Channel 3 only has [Peaking, Peaking 2] while Channels 1/5
  // have the full [Shelving, Peaking, Blocking, Shelving 2, Peaking 2]).
  'peq.bypass_mode': {
    block: 'peq', name: 'bypass_mode',
    pidLow: 0x0036, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Thru', 1: 'Mute' },
  },
  'peq.channel_1_type': {
    block: 'peq', name: 'channel_1_type',
    displayLabel: 'Type 1',
    pidLow: 0x0036, pidHigh: 0x0019,
    unit: 'enum', displayMin: 0, displayMax: 4,
    enumValues: { 0: 'Shelving', 1: 'Peaking', 2: 'Blocking', 3: 'Shelving 2', 4: 'Peaking 2' },
  },
  'peq.channel_2_type': {
    block: 'peq', name: 'channel_2_type',
    displayLabel: 'Type 2',
    pidLow: 0x0036, pidHigh: 0x001a,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'Peaking', 1: 'Shelving', 2: 'Shelving 2', 3: 'Peaking 2' },
  },
  'peq.channel_3_type': {
    block: 'peq', name: 'channel_3_type',
    displayLabel: 'Type 3',
    pidLow: 0x0036, pidHigh: 0x001b,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Peaking', 1: 'Peaking 2' },
  },
  'peq.channel_4_type': {
    block: 'peq', name: 'channel_4_type',
    displayLabel: 'Type 4',
    pidLow: 0x0036, pidHigh: 0x001c,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'Peaking', 1: 'Shelving', 2: 'Shelving 2', 3: 'Peaking 2' },
  },
  'peq.channel_5_type': {
    block: 'peq', name: 'channel_5_type',
    displayLabel: 'Type 5',
    pidLow: 0x0036, pidHigh: 0x001d,
    unit: 'enum', displayMin: 0, displayMax: 4,
    enumValues: { 0: 'Shelving', 1: 'Peaking', 2: 'Blocking', 3: 'Shelving 2', 4: 'Peaking 2' },
  },
  'peq.channel_1_solo': {
    block: 'peq', name: 'channel_1_solo',
    displayLabel: 'Solo',
    pidLow: 0x0036, pidHigh: 0x001e,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'peq.channel_2_solo': {
    block: 'peq', name: 'channel_2_solo',
    displayLabel: 'Solo',
    pidLow: 0x0036, pidHigh: 0x001f,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'peq.channel_3_solo': {
    block: 'peq', name: 'channel_3_solo',
    displayLabel: 'Solo',
    pidLow: 0x0036, pidHigh: 0x0020,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'peq.channel_4_solo': {
    block: 'peq', name: 'channel_4_solo',
    displayLabel: 'Solo',
    pidLow: 0x0036, pidHigh: 0x0021,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'peq.channel_5_solo': {
    block: 'peq', name: 'channel_5_solo',
    displayLabel: 'Solo',
    pidLow: 0x0036, pidHigh: 0x0022,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  //  audit ( cont, 2026-04-29): GEQ Bypass Mode added.
  // GEQ Level was missing too — added via paramNames.ts auto-gen path.
  'geq.bypass_mode': {
    block: 'geq', name: 'bypass_mode',
    pidLow: 0x0032, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Thru', 1: 'Mute' },
  },
  'geq.level': { block: 'geq', name: 'level', pidLow: 0x0032, pidHigh: 0x0000, unit: 'db', displayMin: -80, displayMax: 20 },
  // Rotary cabinet sim mirrors.
  //  audit ( cont, 2026-04-29): rotary block had two
  // mis-registered pidHighs (drive ↔ mic_spacing swap) plus 5 unregistered
  // user-facing knobs that the founder's screenshot dictation surfaced:
  //   id 10 (was `drive` count 0..10) → `rate` (Hz, Leslie speed knob —
  //                                     ** headline gap closed**)
  //   id 21 (was `mic_spacing`)        → `drive` (knob_0_10 0.5..500)
  //   id 16 (NEW)                      → `mic_spacing` (π-encoded scale,
  //                                     unit `rotary_mic_spacing`, 0..100)
  //   id 0 (NEW)                       → `level` (db, -80..20)
  //   id 4 (NEW)                       → `bypass_mode` (enum, hand-authored)
  //   id 14 (NEW)                      → `tempo` (TEMPO_DIVISIONS_VALUES, hand-authored)
  //   id 20 (NEW)                      → `stereo_spread` (bipolar_percent -200..200)
  //   id 23 (NEW)                      → `input_select` (enum [L+R/LEFT/RIGHT], hand-authored)
  'rotary.level': { block: 'rotary', name: 'level', pidLow: 0x0056, pidHigh: 0x0000, unit: 'db', displayMin: -80, displayMax: 20 },
  'rotary.bypass_mode': {
    block: 'rotary', name: 'bypass_mode',
    pidLow: 0x0056, pidHigh: 0x0004,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'Thru', 1: 'Mute FX Out', 2: 'Mute Out' },
  },
  'rotary.rate': { block: 'rotary', name: 'rate', displayLabel: 'Rate', pidLow: 0x0056, pidHigh: 0x000a, unit: 'hz', displayMin: 0, displayMax: 10 },
  'rotary.low_depth': { block: 'rotary', name: 'low_depth', displayLabel: 'Low Depth', pidLow: 0x0056, pidHigh: 0x000b, unit: 'percent', displayMin: 0, displayMax: 100 },
  'rotary.high_depth': { block: 'rotary', name: 'high_depth', displayLabel: 'High Depth', pidLow: 0x0056, pidHigh: 0x000c, unit: 'percent', displayMin: 0, displayMax: 100 },
  'rotary.high_level': { block: 'rotary', name: 'high_level', displayLabel: 'High Level', pidLow: 0x0056, pidHigh: 0x000d, unit: 'db', displayMin: -6, displayMax: 6 },
  'rotary.tempo': {
    block: 'rotary', name: 'tempo',
    displayLabel: 'Tempo',
    pidLow: 0x0056, pidHigh: 0x000e,
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: TEMPO_DIVISIONS_VALUES,
  },
  'rotary.rotor_length': { block: 'rotary', name: 'rotor_length', displayLabel: 'Rotor Length', pidLow: 0x0056, pidHigh: 0x000f, unit: 'percent', displayMin: 0.1, displayMax: 100 },
  'rotary.mic_spacing': { block: 'rotary', name: 'mic_spacing', displayLabel: 'Mic Spacing', pidLow: 0x0056, pidHigh: 0x0010, unit: 'rotary_mic_spacing', displayMin: 0, displayMax: 100 },
  'rotary.low_rate_multiplier': { block: 'rotary', name: 'low_rate_multiplier', displayLabel: 'Low Rate Multiplier', pidLow: 0x0056, pidHigh: 0x0011, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'rotary.low_time_constant': {
    block: 'rotary', name: 'low_time_constant',
    displayLabel: 'Low Time Constant',
    pidLow: 0x0056, pidHigh: 0x0012,
    unit: 'seconds', displayMin: 0.1, displayMax: 10,
    scaling: 'log10',
  },
  'rotary.high_time_constant': {
    block: 'rotary', name: 'high_time_constant',
    displayLabel: 'High Time Constant',
    pidLow: 0x0056, pidHigh: 0x0013,
    unit: 'seconds', displayMin: 0.1, displayMax: 10,
    scaling: 'log10',
  },
  'rotary.stereo_spread': { block: 'rotary', name: 'stereo_spread', displayLabel: 'Stereo Spread', pidLow: 0x0056, pidHigh: 0x0014, unit: 'bipolar_percent', displayMin: -200, displayMax: 200 },
  'rotary.drive': { block: 'rotary', name: 'drive', displayLabel: 'Drive', pidLow: 0x0056, pidHigh: 0x0015, unit: 'knob_0_10', displayMin: 0.5, displayMax: 500, scaling: 'log10' /* typecode 80 —  cont */ },
  'rotary.mic_distance': { block: 'rotary', name: 'mic_distance', displayLabel: 'Mic Distance', pidLow: 0x0056, pidHigh: 0x0016, unit: 'count', displayMin: 0.01, displayMax: 1, scaling: 'log10' },
  'rotary.input_select': {
    block: 'rotary', name: 'input_select',
    displayLabel: 'Input Select',
    pidLow: 0x0056, pidHigh: 0x0017,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'L+R', 1: 'LEFT', 2: 'RIGHT' },
  },

  // ── Main Levels page — pidLow=0x002A —  closed 2026-05-16 ──
  // Capture: samples/captured/session-84-levels.pcapng. AM4-Edit 2.00 +
  // AM4 firmware 2.00 use action=0x0001 (the standard write action) on
  // this register family — supersedes an earlier tentative 0x0002.
  // Anchors from screenshot match wire 1:1: preset.level wire 1.1100 →
  // display 1.1 dB; preset.balance wire 0.0222 → display 2.2 (× 100);
  // scene levels wire 3.33/4.44/5.55/6.66 → display 3.3/4.4/5.5/6.7 dB.
  'preset.level': {
    block: 'preset', name: 'level',
    pidLow: 0x002a, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'preset.balance': {
    block: 'preset', name: 'balance',
    pidLow: 0x002a, pidHigh: 0x0002,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  // Scene Level trims (Main Levels page) are ±20 dB on the device — NOT the
  // -80..+20 span of preset.level. The AM4 Owner's Manual (Main Levels page)
  // states each Scene Level trims its scene ±20 dB. The wire is the same
  // normalized 0..1 float as every other dB param, so the DECODE must scale it
  // against ±20: a wrong -80..+20 here makes get_param / get_preset / list_params
  // report bogus dB (e.g. set +10 read back as -5) even though the write is fine.
  // Verified live 2026-06-06: wire 0.75 → +10 dB, 0.40 → -4 dB (see
  // docs/_private/0.2.0-dev-test-2026-06-06.md). The encode path is unit-scale
  // based (db scale = 1) and ignores these bounds, so writes were always correct.
  'preset.scene_1_level': {
    block: 'preset', name: 'scene_1_level',
    pidLow: 0x002a, pidHigh: 0x0018,
    unit: 'db', displayMin: -20, displayMax: 20,
  },
  'preset.scene_2_level': {
    block: 'preset', name: 'scene_2_level',
    pidLow: 0x002a, pidHigh: 0x0019,
    unit: 'db', displayMin: -20, displayMax: 20,
  },
  'preset.scene_3_level': {
    block: 'preset', name: 'scene_3_level',
    pidLow: 0x002a, pidHigh: 0x001a,
    unit: 'db', displayMin: -20, displayMax: 20,
  },
  'preset.scene_4_level': {
    block: 'preset', name: 'scene_4_level',
    pidLow: 0x002a, pidHigh: 0x001b,
    unit: 'db', displayMin: -20, displayMax: 20,
  },

  // ── PATCH family — pidLow=0x00CE (cross-references catalog case 0x3c) ──
  // Closed 2026-05-16 via samples/captured/session-84-routing-
  // mix-midi.pcapng. Wire shape decoded directly against Ghidra's PATCH
  // catalog: paramId N → pidHigh = N (matching §6p rule for every other
  // AM4 block). Same pidLow already hosts block-placement (pidHigh=
  // 0x0010+slot-1) and preset rename — PATCH is the umbrella family that
  // covers "everything preset-scoped that isn't a block parameter."
  //
  // Confirmed wire values for routing: Series=0.0, Parallel=1.0.
  // Founder toggled FX2/3/4 routing dropdowns in AM4-Edit; each click
  // produced a clean float write whose value matches the on-screen state.
  'preset.routing_slot_2': {
    block: 'preset', name: 'routing_slot_2',
    pidLow: 0x00ce, pidHigh: 0x0014,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Series', 1: 'Parallel' },
  },
  'preset.routing_slot_3': {
    block: 'preset', name: 'routing_slot_3',
    pidLow: 0x00ce, pidHigh: 0x0015,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Series', 1: 'Parallel' },
  },
  'preset.routing_slot_4': {
    block: 'preset', name: 'routing_slot_4',
    pidLow: 0x00ce, pidHigh: 0x0016,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'Series', 1: 'Parallel' },
  },

  // ── PATCH scene-MIDI — pidLow=0x00CE, base rows 0x40/0x50/0x60 ──
  // Closed 2026-05-16 via:
  //   samples/captured/session-85-scene-midi.pcapng
  //   samples/captured/session-86-scene-midi-disambiguate.pcapng
  //
  // Each scene has 4 MIDI message slots; each slot has 3 fields
  // (Type / Channel / Value). 4×4×3 = 48 wire-addressable params,
  // all on standard SET_PARAM action=0x0001 with hdr4=0x0004 and
  // a packed-float value. NO custom action needed.
  //
  // Wire layout:
  //   pidHigh = base_row + (scene-1)*4 + (msg-1)
  //     base_row 0x40 → Type    (enum; PC=1.0 confirmed)
  //     base_row 0x50 → Channel (1..16, raw int as float)
  //     base_row 0x60 → Value   (0..127, raw int as float)
  //
  // Type enum: only PC=1 is wire-confirmed. The (s=4,m=4) bonus in
  // session-85 showed Type=18.0 for what the founder believed was CC,
  // so CC=18 is hypothesized but not yet locked. A dedicated type-
  // sweep capture (cycle the Type dropdown through all entries on one
  // slot) would harvest the full enum. Treat unknown Type values as
  // raw int passthrough — the encoder will accept any int 0..127.
  //
  // The  §6n-patch anomaly (pidHigh=0x3e81 action=0x0017)
  // is unrelated to scene-MIDI authoring — it was triggered by a
  // different AM4-Edit operation. Not on this critical path.
  'preset.scene_1_midi_1_type': { block: 'preset', name: 'scene_1_midi_1_type',
    pidLow: 0x00ce, pidHigh: 0x0040, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_1_midi_1_channel': { block: 'preset', name: 'scene_1_midi_1_channel',
    pidLow: 0x00ce, pidHigh: 0x0050, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_1_midi_1_value': { block: 'preset', name: 'scene_1_midi_1_value',
    pidLow: 0x00ce, pidHigh: 0x0060, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_1_midi_2_type': { block: 'preset', name: 'scene_1_midi_2_type',
    pidLow: 0x00ce, pidHigh: 0x0041, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_1_midi_2_channel': { block: 'preset', name: 'scene_1_midi_2_channel',
    pidLow: 0x00ce, pidHigh: 0x0051, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_1_midi_2_value': { block: 'preset', name: 'scene_1_midi_2_value',
    pidLow: 0x00ce, pidHigh: 0x0061, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_1_midi_3_type': { block: 'preset', name: 'scene_1_midi_3_type',
    pidLow: 0x00ce, pidHigh: 0x0042, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_1_midi_3_channel': { block: 'preset', name: 'scene_1_midi_3_channel',
    pidLow: 0x00ce, pidHigh: 0x0052, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_1_midi_3_value': { block: 'preset', name: 'scene_1_midi_3_value',
    pidLow: 0x00ce, pidHigh: 0x0062, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_1_midi_4_type': { block: 'preset', name: 'scene_1_midi_4_type',
    pidLow: 0x00ce, pidHigh: 0x0043, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_1_midi_4_channel': { block: 'preset', name: 'scene_1_midi_4_channel',
    pidLow: 0x00ce, pidHigh: 0x0053, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_1_midi_4_value': { block: 'preset', name: 'scene_1_midi_4_value',
    pidLow: 0x00ce, pidHigh: 0x0063, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_1_type': { block: 'preset', name: 'scene_2_midi_1_type',
    pidLow: 0x00ce, pidHigh: 0x0044, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_2_midi_1_channel': { block: 'preset', name: 'scene_2_midi_1_channel',
    pidLow: 0x00ce, pidHigh: 0x0054, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_2_midi_1_value': { block: 'preset', name: 'scene_2_midi_1_value',
    pidLow: 0x00ce, pidHigh: 0x0064, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_2_type': { block: 'preset', name: 'scene_2_midi_2_type',
    pidLow: 0x00ce, pidHigh: 0x0045, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_2_midi_2_channel': { block: 'preset', name: 'scene_2_midi_2_channel',
    pidLow: 0x00ce, pidHigh: 0x0055, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_2_midi_2_value': { block: 'preset', name: 'scene_2_midi_2_value',
    pidLow: 0x00ce, pidHigh: 0x0065, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_3_type': { block: 'preset', name: 'scene_2_midi_3_type',
    pidLow: 0x00ce, pidHigh: 0x0046, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_2_midi_3_channel': { block: 'preset', name: 'scene_2_midi_3_channel',
    pidLow: 0x00ce, pidHigh: 0x0056, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_2_midi_3_value': { block: 'preset', name: 'scene_2_midi_3_value',
    pidLow: 0x00ce, pidHigh: 0x0066, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_4_type': { block: 'preset', name: 'scene_2_midi_4_type',
    pidLow: 0x00ce, pidHigh: 0x0047, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_2_midi_4_channel': { block: 'preset', name: 'scene_2_midi_4_channel',
    pidLow: 0x00ce, pidHigh: 0x0057, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_2_midi_4_value': { block: 'preset', name: 'scene_2_midi_4_value',
    pidLow: 0x00ce, pidHigh: 0x0067, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_1_type': { block: 'preset', name: 'scene_3_midi_1_type',
    pidLow: 0x00ce, pidHigh: 0x0048, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_3_midi_1_channel': { block: 'preset', name: 'scene_3_midi_1_channel',
    pidLow: 0x00ce, pidHigh: 0x0058, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_3_midi_1_value': { block: 'preset', name: 'scene_3_midi_1_value',
    pidLow: 0x00ce, pidHigh: 0x0068, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_2_type': { block: 'preset', name: 'scene_3_midi_2_type',
    pidLow: 0x00ce, pidHigh: 0x0049, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_3_midi_2_channel': { block: 'preset', name: 'scene_3_midi_2_channel',
    pidLow: 0x00ce, pidHigh: 0x0059, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_3_midi_2_value': { block: 'preset', name: 'scene_3_midi_2_value',
    pidLow: 0x00ce, pidHigh: 0x0069, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_3_type': { block: 'preset', name: 'scene_3_midi_3_type',
    pidLow: 0x00ce, pidHigh: 0x004a, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_3_midi_3_channel': { block: 'preset', name: 'scene_3_midi_3_channel',
    pidLow: 0x00ce, pidHigh: 0x005a, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_3_midi_3_value': { block: 'preset', name: 'scene_3_midi_3_value',
    pidLow: 0x00ce, pidHigh: 0x006a, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_4_type': { block: 'preset', name: 'scene_3_midi_4_type',
    pidLow: 0x00ce, pidHigh: 0x004b, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_3_midi_4_channel': { block: 'preset', name: 'scene_3_midi_4_channel',
    pidLow: 0x00ce, pidHigh: 0x005b, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_3_midi_4_value': { block: 'preset', name: 'scene_3_midi_4_value',
    pidLow: 0x00ce, pidHigh: 0x006b, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_1_type': { block: 'preset', name: 'scene_4_midi_1_type',
    pidLow: 0x00ce, pidHigh: 0x004c, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_4_midi_1_channel': { block: 'preset', name: 'scene_4_midi_1_channel',
    pidLow: 0x00ce, pidHigh: 0x005c, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_4_midi_1_value': { block: 'preset', name: 'scene_4_midi_1_value',
    pidLow: 0x00ce, pidHigh: 0x006c, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_2_type': { block: 'preset', name: 'scene_4_midi_2_type',
    pidLow: 0x00ce, pidHigh: 0x004d, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_4_midi_2_channel': { block: 'preset', name: 'scene_4_midi_2_channel',
    pidLow: 0x00ce, pidHigh: 0x005d, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_4_midi_2_value': { block: 'preset', name: 'scene_4_midi_2_value',
    pidLow: 0x00ce, pidHigh: 0x006d, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_3_type': { block: 'preset', name: 'scene_4_midi_3_type',
    pidLow: 0x00ce, pidHigh: 0x004e, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_4_midi_3_channel': { block: 'preset', name: 'scene_4_midi_3_channel',
    pidLow: 0x00ce, pidHigh: 0x005e, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_4_midi_3_value': { block: 'preset', name: 'scene_4_midi_3_value',
    pidLow: 0x00ce, pidHigh: 0x006e, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_4_type': { block: 'preset', name: 'scene_4_midi_4_type',
    pidLow: 0x00ce, pidHigh: 0x004f, unit: 'enum', displayMin: 0, displayMax: 129, enumValues: SCENE_MIDI_TYPE_ENUM },
  'preset.scene_4_midi_4_channel': { block: 'preset', name: 'scene_4_midi_4_channel',
    pidLow: 0x00ce, pidHigh: 0x005f, unit: 'count', displayMin: 1, displayMax: 16 },
  'preset.scene_4_midi_4_value': { block: 'preset', name: 'scene_4_midi_4_value',
    pidLow: 0x00ce, pidHigh: 0x006f, unit: 'count', displayMin: 0, displayMax: 127 },
  // 2026-05-17: REVERB + DELAY mirrors from CACHE_PARAMS.
  // Already shipping live via the `...CACHE_PARAMS` spread at line 427;
  // these mirrors exist so `scripts/coverage-audit.ts` (which greps
  // params.ts directly, not the merged registry) sees them. Unblocks
  // user prompts like "tighten up the delay ducker," "back off the
  // reverb modulation," "set delay echo pan left," etc. — all addresses
  // were already wire-shipping; only the audit was under-reporting.
  // Source: packages/am4/src/cacheParams.ts (auto-generated from
  // paramNames.ts + cache-section3.json by gen-params-from-cache.ts).
  'reverb.high_decay':       { block: 'reverb', name: 'high_decay', displayLabel: "High Decay",       pidLow: 0x0042, pidHigh: 0x000d, unit: 'count', displayMin: 0.01, displayMax: 1, scaling: 'log10' },
  'reverb.scattering':       { block: 'reverb', name: 'scattering', displayLabel: "Scattering",       pidLow: 0x0042, pidHigh: 0x000e, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.reverbdelay':      { block: 'reverb', name: 'reverbdelay',      pidLow: 0x0042, pidHigh: 0x0010, unit: 'ms', displayMin: 0, displayMax: 250 },
  'reverb.early_level':      { block: 'reverb', name: 'early_level', displayLabel: "Early Level",      pidLow: 0x0042, pidHigh: 0x0011, unit: 'db', displayMin: -40, displayMax: 10 },
  'reverb.late_level':       { block: 'reverb', name: 'late_level', displayLabel: "Late Level ",       pidLow: 0x0042, pidHigh: 0x0012, unit: 'db', displayMin: -40, displayMax: 10 },
  'reverb.depth':            { block: 'reverb', name: 'depth', displayLabel: "Depth",            pidLow: 0x0042, pidHigh: 0x0015, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.rate':             { block: 'reverb', name: 'rate', displayLabel: "Rate",             pidLow: 0x0042, pidHigh: 0x0016, unit: 'hz', displayMin: 0.01, displayMax: 1, scaling: 'log10' },
  'reverb.diffusion':        { block: 'reverb', name: 'diffusion', displayLabel: "Diffusion",        pidLow: 0x0042, pidHigh: 0x0019, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.diffusion_time':   { block: 'reverb', name: 'diffusion_time', displayLabel: "Diffusion Time",   pidLow: 0x0042, pidHigh: 0x001a, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.pickup_spacing':   { block: 'reverb', name: 'pickup_spacing', displayLabel: "Pickup Spacing",   pidLow: 0x0042, pidHigh: 0x001d, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.frequency_1':      { block: 'reverb', name: 'frequency_1', displayLabel: "Frequency 1",      pidLow: 0x0042, pidHigh: 0x001e, unit: 'hz', displayMin: 20, displayMax: 2000, scaling: 'log10' },
  'reverb.frequency_2':      { block: 'reverb', name: 'frequency_2', displayLabel: "Frequency 2",      pidLow: 0x0042, pidHigh: 0x001f, unit: 'hz', displayMin: 100, displayMax: 10000, scaling: 'log10' },
  'reverb.q_1':              { block: 'reverb', name: 'q_1', displayLabel: "Q 1",              pidLow: 0x0042, pidHigh: 0x0020, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'reverb.q_2':              { block: 'reverb', name: 'q_2', displayLabel: "Q 2",              pidLow: 0x0042, pidHigh: 0x0021, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'reverb.gain_1':           { block: 'reverb', name: 'gain_1', displayLabel: "Gain 1",           pidLow: 0x0042, pidHigh: 0x0022, unit: 'db', displayMin: -12, displayMax: 12 },
  'reverb.gain_2':           { block: 'reverb', name: 'gain_2', displayLabel: "Gain 2",           pidLow: 0x0042, pidHigh: 0x0023, unit: 'db', displayMin: -12, displayMax: 12 },
  'reverb.low_decay': {
    block: 'reverb', name: 'low_decay',
    displayLabel: 'Low Decay',
    pidLow: 0x0042, pidHigh: 0x0025,
    unit: 'seconds', displayMin: 0.02, displayMax: 2,
    scaling: 'log10',
    displayUnit: 'x',
  },
  'reverb.xover_frequency':  { block: 'reverb', name: 'xover_frequency', displayLabel: "Xover Frequency",  pidLow: 0x0042, pidHigh: 0x0026, unit: 'hz', displayMin: 100, displayMax: 10000, scaling: 'log10' },
  'reverb.threshold':        { block: 'reverb', name: 'threshold', displayLabel: "Threshold",        pidLow: 0x0042, pidHigh: 0x0029, unit: 'db', displayMin: -80, displayMax: 20 },
  'reverb.release_time':     { block: 'reverb', name: 'release_time', displayLabel: "Release Time",     pidLow: 0x0042, pidHigh: 0x002a, unit: 'ms', displayMin: 0, displayMax: 1000, scaling: 'log10' },
  'reverb.early_diffusion':  { block: 'reverb', name: 'early_diffusion', displayLabel: "Early Diffusion",  pidLow: 0x0042, pidHigh: 0x002b, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.early_diff_time':  { block: 'reverb', name: 'early_diff_time', displayLabel: "Early Diff Time",  pidLow: 0x0042, pidHigh: 0x002c, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.early_decay':      { block: 'reverb', name: 'early_decay', displayLabel: "Early Decay",      pidLow: 0x0042, pidHigh: 0x002d, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.late_input_mix':   { block: 'reverb', name: 'late_input_mix', displayLabel: "Late Input Mix",   pidLow: 0x0042, pidHigh: 0x002e, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.basetype':         { block: 'reverb', name: 'basetype',         pidLow: 0x0042, pidHigh: 0x0031, unit: 'count', displayMin: 0, displayMax: 8 },
  'reverb.lfo_phase':        { block: 'reverb', name: 'lfo_phase', displayLabel: "LFO Phase",        pidLow: 0x0042, pidHigh: 0x0032, unit: 'degrees', displayMin: 0, displayMax: 180 },
  'reverb.pitch_mix':        { block: 'reverb', name: 'pitch_mix', displayLabel: "Pitch Mix",        pidLow: 0x0042, pidHigh: 0x0037, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.pitch_feedback':   { block: 'reverb', name: 'pitch_feedback', displayLabel: "Pitch Feedback",   pidLow: 0x0042, pidHigh: 0x003a, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.splice_time':      { block: 'reverb', name: 'splice_time', displayLabel: "Splice Time",      pidLow: 0x0042, pidHigh: 0x003c, unit: 'ms', displayMin: 10, displayMax: 2000 },
  'reverb.pitch_modulation': { block: 'reverb', name: 'pitch_modulation', displayLabel: "Pitch Modulation", pidLow: 0x0042, pidHigh: 0x003e, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.voice_balance':    { block: 'reverb', name: 'voice_balance', displayLabel: "Voice Balance",    pidLow: 0x0042, pidHigh: 0x003f, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'reverb.feedback':         { block: 'reverb', name: 'feedback', displayLabel: "Feedback",         pidLow: 0x0042, pidHigh: 0x0041, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.echo_mix':         { block: 'reverb', name: 'echo_mix', displayLabel: "Echo Mix",         pidLow: 0x0042, pidHigh: 0x0042, unit: 'percent', displayMin: 0, displayMax: 100 },
  'reverb.pitch_high_cut':   { block: 'reverb', name: 'pitch_high_cut', displayLabel: "Shimmer Tone",   pidLow: 0x0042, pidHigh: 0x0043, unit: 'hz', displayMin: 200, displayMax: 20000, scaling: 'log10' },
  'reverb.tonetype':         { block: 'reverb', name: 'tonetype',         pidLow: 0x0042, pidHigh: 0x0045, unit: 'db', displayMin: 0, displayMax: 3 },
  'reverb.low_cut_q':        { block: 'reverb', name: 'low_cut_q', displayLabel: "Low Cut Q",        pidLow: 0x0042, pidHigh: 0x0047, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'reverb.high_cut_q':       { block: 'reverb', name: 'high_cut_q', displayLabel: "High Cut Q",       pidLow: 0x0042, pidHigh: 0x0048, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  // DELAY mirrors.
  'delay.tempo_1':           { block: 'delay',  name: 'tempo_1',           pidLow: 0x0046, pidHigh: 0x000f, unit: 'percent', displayMin: 0, displayMax: 100 },
  'delay.echo_pan':          { block: 'delay',  name: 'echo_pan', displayLabel: "Echo Pan",          pidLow: 0x0046, pidHigh: 0x0011, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'delay.mod_rate':          { block: 'delay',  name: 'mod_rate', displayLabel: "Mod Rate",          pidLow: 0x0046, pidHigh: 0x0016, unit: 'hz', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'delay.rate':              { block: 'delay',  name: 'rate', displayLabel: "Rate",              pidLow: 0x0046, pidHigh: 0x0017, unit: 'hz', displayMin: 0.2, displayMax: 20, scaling: 'log10' },
  'delay.mod_depth':         { block: 'delay',  name: 'mod_depth', displayLabel: "Mod Depth",         pidLow: 0x0046, pidHigh: 0x0018, unit: 'percent', displayMin: 0, displayMax: 100 },
  'delay.mod_depth_depth2':  { block: 'delay',  name: 'mod_depth_depth2', displayLabel: "Mod Depth",  pidLow: 0x0046, pidHigh: 0x0019, unit: 'percent', displayMin: 0, displayMax: 100 },
  'delay.time_r':            { block: 'delay',  name: 'time_r', displayLabel: "Time R",            pidLow: 0x0046, pidHigh: 0x001e, unit: 'ms', displayMin: 0, displayMax: 8000 },
  'delay.rotation':          { block: 'delay',  name: 'rotation', displayLabel: "Rotation",          pidLow: 0x0046, pidHigh: 0x0022, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'delay.lfo_phase':         { block: 'delay',  name: 'lfo_phase',         pidLow: 0x0046, pidHigh: 0x0023, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'delay.level_l':           { block: 'delay',  name: 'level_l', displayLabel: "Level L",           pidLow: 0x0046, pidHigh: 0x0024, unit: 'percent', displayMin: 0, displayMax: 100 },
  'delay.level_r':           { block: 'delay',  name: 'level_r', displayLabel: "Level R",           pidLow: 0x0046, pidHigh: 0x0025, unit: 'percent', displayMin: 0, displayMax: 100 },
  'delay.pan_l':             { block: 'delay',  name: 'pan_l', displayLabel: "Pan L",             pidLow: 0x0046, pidHigh: 0x0026, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'delay.pan_r':             { block: 'delay',  name: 'pan_r', displayLabel: "Pan R",             pidLow: 0x0046, pidHigh: 0x0027, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'delay.modulation_phase':  { block: 'delay',  name: 'modulation_phase', displayLabel: "Modulation Phase",  pidLow: 0x0046, pidHigh: 0x0028, unit: 'degrees', displayMin: 0, displayMax: 180 },
  'delay.lfo_phase_2':       { block: 'delay',  name: 'lfo_phase_2', displayLabel: "LFO Phase",       pidLow: 0x0046, pidHigh: 0x0029, unit: 'degrees', displayMin: 0, displayMax: 180 },
  'delay.crossfade_time':    { block: 'delay',  name: 'crossfade_time', displayLabel: "Crossfade Time",    pidLow: 0x0046, pidHigh: 0x002a, unit: 'ms', displayMin: 1, displayMax: 255 },
  'delay.sweep_rate':        { block: 'delay',  name: 'sweep_rate', displayLabel: "Sweep Rate",        pidLow: 0x0046, pidHigh: 0x0038, unit: 'hz', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'delay.sweep_phase':       { block: 'delay',  name: 'sweep_phase', displayLabel: "Sweep Phase",       pidLow: 0x0046, pidHigh: 0x003a, unit: 'degrees', displayMin: 0, displayMax: 180 },
  'delay.sweep_start_freq':  { block: 'delay',  name: 'sweep_start_freq', displayLabel: "Sweep Start Freq",  pidLow: 0x0046, pidHigh: 0x003c, unit: 'hz', displayMin: 100, displayMax: 1000, scaling: 'log10' },
  'delay.sweep_stop_freq':   { block: 'delay',  name: 'sweep_stop_freq', displayLabel: "Sweep Stop Freq",   pidLow: 0x0046, pidHigh: 0x003d, unit: 'hz', displayMin: 500, displayMax: 5000, scaling: 'log10' },
  'delay.sweep_resonance':   { block: 'delay',  name: 'sweep_resonance', displayLabel: "Sweep Resonance",   pidLow: 0x0046, pidHigh: 0x003e, unit: 'count', displayMin: 0.2, displayMax: 20, scaling: 'log10' },
  'delay.motor_speed':       { block: 'delay',  name: 'motor_speed', displayLabel: "Motor Speed",       pidLow: 0x0046, pidHigh: 0x0048, unit: 'count', displayMin: 0.5, displayMax: 2, scaling: 'log10' },
  'delay.right_post_delay':  { block: 'delay',  name: 'right_post_delay', displayLabel: "Right Post Delay",  pidLow: 0x0046, pidHigh: 0x0049, unit: 'ms', displayMin: 0, displayMax: 100 },
  'delay.pan_rate':          { block: 'delay',  name: 'pan_rate', displayLabel: "Pan Rate",          pidLow: 0x0046, pidHigh: 0x0052, unit: 'hz', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'delay.pan_depth':         { block: 'delay',  name: 'pan_depth', displayLabel: "Pan Depth",         pidLow: 0x0046, pidHigh: 0x0054, unit: 'percent', displayMin: 0, displayMax: 100 },
  'delay.lfo_phase_4':       { block: 'delay',  name: 'lfo_phase_4', displayLabel: "LFO Phase",       pidLow: 0x0046, pidHigh: 0x0055, unit: 'degrees', displayMin: 0, displayMax: 180 },
  // 2026-05-17: Phase 3 — REVERB + DELAY enums + tempo-
  // sync registers from the Ghidra catalog. These have no cache record
  // (so the cacheParams generator can't emit them) but the paramNames.ts
  // TODOs document the expected range from prior structural analysis.
  // Confidence tier per entry:
  //   • HIGH: shared dictionaries (TEMPO_DIVISIONS_VALUES, LFO_WAVEFORMS_VALUES)
  //     — these are firmware-extracted cache enums, byte-identical to the
  //     values the device understands. Wire-safe.
  //   • MEDIUM: 2-value toggles with conventional OFF/ON or paired labels —
  //     the wire range is documented but the display labels are educated
  //     guesses. Wire writes are still safe (values 0 / 1 are in range).
  //   • LOWER: multi-value enums without a known label table — shipped as
  //     `unit: 'count'` so the agent can address the param but doesn't
  //     claim to know what each numeric value means. Future hardware
  //     verification can upgrade these to enum + labels.
  //
  // REVERB tempo-sync (HIGH — shared TEMPO_DIVISIONS dictionary):
  'reverb.predly_tempo':     { block: 'reverb', name: 'predly_tempo',      displayLabel: 'Pre-Delay Tempo', pidLow: 0x0042, pidHigh: 0x0040, unit: 'enum', displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },
  // REVERB slope/toggle (MEDIUM — 2-value toggles, labels are conventional
  // guesses based on Blocks Guide §Reverb Common Page; wire writes safe):
  //  review pass (2026-05-17): renamed `low_slope` →
  // `low_cut_slope` and `high_slope` → `high_cut_slope` to match the
  // AM4-Edit XML display labels exactly ("Low Cut Slope" / "High Cut
  // Slope"). Sibling `reverb.low_cut_q` / `reverb.high_cut_q` (pidHigh
  // 0x47/0x48) already use the `low_cut_` / `high_cut_` family prefix,
  // so this aligns the slope pair with the Q pair. Disambiguates from
  // `amp.low_slope` / `amp.high_slope` on the DISTORT register (whose
  // XML label is "Low Slope" — no "Cut"). LLM prompt "make the reverb
  // low cut slope steeper" now matches the param key directly.
  'reverb.low_cut_slope':    { block: 'reverb', name: 'low_cut_slope',     displayLabel: 'Low Cut Slope',   pidLow: 0x0042, pidHigh: 0x0035, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Normal', 1: 'Steep' } },
  'reverb.high_cut_slope':   { block: 'reverb', name: 'high_cut_slope',    displayLabel: 'High Cut Slope',  pidLow: 0x0042, pidHigh: 0x0036, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Normal', 1: 'Steep' } },
  'reverb.spring_type':      { block: 'reverb', name: 'spring_type',       displayLabel: 'Spring Type',  pidLow: 0x0042, pidHigh: 0x0044, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'A', 1: 'B' } },
  'reverb.predly_tap':       { block: 'reverb', name: 'predly_tap',        displayLabel: 'Pre-Delay Tap', pidLow: 0x0042, pidHigh: 0x0046, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  // REVERB input-select (MEDIUM — matches the standard Fractal input-select
  // 3-value pattern documented at paramNames.ts line 425 + used in rotary):
  'reverb.input_select':     { block: 'reverb', name: 'input_select',      displayLabel: 'Input Select', pidLow: 0x0042, pidHigh: 0x0033, unit: 'enum', displayMin: 0, displayMax: 2, enumValues: { 0: 'L+R', 1: 'LEFT', 2: 'RIGHT' } },
  // REVERB pitch direction / position (LOWER — multi-value with no cache
  // labels). Shipped as 'count' so the agent can write any in-range
  // value without claiming to know the labels.
  //  review pass (2026-05-17): renamed `pitch_dir` →
  // `pitch_direction` and `pitch_pos` → `pitch_position` to spell out
  // the XML display labels ("Pitch Direction" / "Pitch Position"). The
  // agent picks up "pitch direction" / "pitch position" prompts
  // directly without needing to remember the truncated `_dir` / `_pos`
  // form.
  'reverb.pitch_direction':  { block: 'reverb', name: 'pitch_direction',   displayLabel: 'Pitch Direction', pidLow: 0x0042, pidHigh: 0x003b, unit: 'count', displayMin: 0, displayMax: 3 },
  'reverb.pitch_position':   { block: 'reverb', name: 'pitch_position',    displayLabel: 'Pitch Position',  pidLow: 0x0042, pidHigh: 0x003d, unit: 'count', displayMin: 0, displayMax: 2 },
  // DELAY tempo-sync (HIGH — shared TEMPO_DIVISIONS dictionary on right
  // channel + LFO1/2/3/4 tempo):
  'delay.tempo_r':           { block: 'delay',  name: 'tempo_r',           displayLabel: 'Tempo R',      pidLow: 0x0046, pidHigh: 0x0021, unit: 'enum', displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },
  'delay.lfo_1_tempo':       { block: 'delay',  name: 'lfo_1_tempo',       displayLabel: 'LFO 1 Tempo',  pidLow: 0x0046, pidHigh: 0x0036, unit: 'enum', displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },
  'delay.lfo_2_tempo':       { block: 'delay',  name: 'lfo_2_tempo',       displayLabel: 'LFO 2 Tempo',  pidLow: 0x0046, pidHigh: 0x0037, unit: 'enum', displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },
  'delay.lfo_3_tempo':       { block: 'delay',  name: 'lfo_3_tempo',       displayLabel: 'LFO 3 Tempo',  pidLow: 0x0046, pidHigh: 0x003b, unit: 'enum', displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },
  'delay.lfo_4_tempo':       { block: 'delay',  name: 'lfo_4_tempo',       displayLabel: 'LFO 4 Tempo',  pidLow: 0x0046, pidHigh: 0x0053, unit: 'enum', displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },
  // DELAY LFO waveform type (HIGH — shared LFO_WAVEFORMS dictionary,
  // 10 entries 0..9, matches chorus.lfo_type at line 2480):
  'delay.lfo_1_type':        { block: 'delay',  name: 'lfo_1_type',        displayLabel: 'LFO 1 Type',   pidLow: 0x0046, pidHigh: 0x001c, unit: 'enum', displayMin: 0, displayMax: 9, enumValues: LFO_WAVEFORMS_VALUES },
  'delay.lfo_2_type':        { block: 'delay',  name: 'lfo_2_type',        displayLabel: 'LFO 2 Type',   pidLow: 0x0046, pidHigh: 0x001d, unit: 'enum', displayMin: 0, displayMax: 9, enumValues: LFO_WAVEFORMS_VALUES },
  'delay.lfo_3_type':        { block: 'delay',  name: 'lfo_3_type',        displayLabel: 'LFO 3 Type',   pidLow: 0x0046, pidHigh: 0x0039, unit: 'enum', displayMin: 0, displayMax: 9, enumValues: LFO_WAVEFORMS_VALUES },
  'delay.lfo_4_type':        { block: 'delay',  name: 'lfo_4_type',        displayLabel: 'LFO 4 Type',   pidLow: 0x0046, pidHigh: 0x0051, unit: 'enum', displayMin: 0, displayMax: 9, enumValues: LFO_WAVEFORMS_VALUES },
  // DELAY 2-value toggles (MEDIUM — wire range documented; labels are
  // conventional OFF/ON or A/B guesses):
  'delay.run':               { block: 'delay',  name: 'run',               displayLabel: 'Run',          pidLow: 0x0046, pidHigh: 0x002b, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  // Renamed to match AM4-Edit display ("Trigger Restart") — confirmed
  // via cross-ref audit. Wire range still 0..1.
  'delay.trigger_restart':   { block: 'delay',  name: 'trigger_restart',   displayLabel: 'Trigger Restart', pidLow: 0x0046, pidHigh: 0x002c, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'delay.depth_range':       { block: 'delay',  name: 'depth_range',       displayLabel: 'Depth Range',  pidLow: 0x0046, pidHigh: 0x0047, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  // DELAY LFO target selectors (LOWER — multi-value with no cache labels):
  'delay.lfo_1_target':      { block: 'delay',  name: 'lfo_1_target',      displayLabel: 'LFO 1 Target', pidLow: 0x0046, pidHigh: 0x0034, unit: 'count', displayMin: 0, displayMax: 2 },
  'delay.lfo_2_target':      { block: 'delay',  name: 'lfo_2_target',      displayLabel: 'LFO 2 Target', pidLow: 0x0046, pidHigh: 0x0035, unit: 'count', displayMin: 0, displayMax: 2 },
  'delay.lfo_4_target':      { block: 'delay',  name: 'lfo_4_target',      displayLabel: 'LFO 4 Target', pidLow: 0x0046, pidHigh: 0x0056, unit: 'count', displayMin: 0, displayMax: 3 },
  // DELAY state-variable filter type (LOWER — typical SVF is Low/Band/High
  // but TODO marked range 1..3 not 0..2, so the labels here would be wrong;
  // ship as count and let hardware verification supply the labels):
  'delay.sweep_filter':      { block: 'delay',  name: 'sweep_filter',      displayLabel: 'Sweep Filter', pidLow: 0x0046, pidHigh: 0x0059, unit: 'count', displayMin: 1, displayMax: 3 },

  //  cont (2026-05-17): CHORUS / FLANGER / PHASER / FILTER /
  // TREMOLO / ENHANCER / COMPRESSOR mirror block. 53 entries from
  // cacheParams.ts (auto-generated from the paramNames.ts +
  // cache-section3.json pipeline) mirrored into params.ts so the
  // coverage-audit sees them. Includes 21 unit overrides added to
  // paramNames.ts this session to correct cache c=1 → 'db' fallbacks
  // for entries that are Hz / count / ratio / bipolar_percent.
  // Unblocks user prompts like "set the filter rate to 0.5 Hz", "set
  // phaser min freq to 200 Hz", "compressor ratio 4:1", etc.
  // CHORUS mirrors (3).
  'chorus.left_depth':       { block: 'chorus', name: 'left_depth', displayLabel: "Left Depth",        pidLow: 0x004e, pidHigh: 0x001c, unit: 'percent', displayMin: 0, displayMax: 100 },
  'chorus.center_depth':     { block: 'chorus', name: 'center_depth', displayLabel: "Center Depth",      pidLow: 0x004e, pidHigh: 0x001d, unit: 'percent', displayMin: 0, displayMax: 100 },
  'chorus.right_depth':      { block: 'chorus', name: 'right_depth', displayLabel: "Right Depth",       pidLow: 0x004e, pidHigh: 0x001e, unit: 'percent', displayMin: 0, displayMax: 100 },
  // FLANGER mirrors (10).
  'flanger.dry_delay':       { block: 'flanger', name: 'dry_delay', displayLabel: "Dry Delay",        pidLow: 0x0052, pidHigh: 0x0010, unit: 'percent', displayMin: 0, displayMax: 100 },
  'flanger.smooth_steps':    { block: 'flanger', name: 'smooth_steps', displayLabel: "Smooth Steps",     pidLow: 0x0052, pidHigh: 0x0013, unit: 'count', displayMin: 0.5, displayMax: 50, scaling: 'log10' },
  'flanger.high_cut':        { block: 'flanger', name: 'high_cut', displayLabel: "High Cut",         pidLow: 0x0052, pidHigh: 0x0017, unit: 'hz', displayMin: 200, displayMax: 20000, scaling: 'log10' },
  'flanger.drive':           { block: 'flanger', name: 'drive', displayLabel: "Drive",            pidLow: 0x0052, pidHigh: 0x0018, unit: 'knob_0_10', displayMin: 0, displayMax: 10, scaling: 'log10' },
  'flanger.low_cut':         { block: 'flanger', name: 'low_cut', displayLabel: "Low Cut",          pidLow: 0x0052, pidHigh: 0x0019, unit: 'hz', displayMin: 20, displayMax: 2000, scaling: 'log10' },
  'flanger.stereo_spread':   { block: 'flanger', name: 'stereo_spread', displayLabel: "Stereo Spread",    pidLow: 0x0052, pidHigh: 0x001a, unit: 'percent', displayMin: 0, displayMax: 100 },
  'flanger.bass_focus':      { block: 'flanger', name: 'bass_focus', displayLabel: "Bass Focus",       pidLow: 0x0052, pidHigh: 0x001e, unit: 'knob_0_10', displayMin: 0, displayMax: 10, scaling: 'log10' },
  'flanger.min_time':        { block: 'flanger', name: 'min_time', displayLabel: "Min Time",         pidLow: 0x0052, pidHigh: 0x0020, unit: 'ms', displayMin: 0, displayMax: 2 },
  'flanger.max_time':        { block: 'flanger', name: 'max_time', displayLabel: "Max Time",         pidLow: 0x0052, pidHigh: 0x0021, unit: 'ms', displayMin: 0, displayMax: 20 },
  'flanger.vpo_exponent':    { block: 'flanger', name: 'vpo_exponent', displayLabel: "VPO Exponent",     pidLow: 0x0052, pidHigh: 0x0023, unit: 'count', displayMin: 0.01, displayMax: 100, scaling: 'log10' },
  // PHASER mirrors (12).
  'phaser.min_frequency':    { block: 'phaser', name: 'min_frequency', displayLabel: "Min Frequency",     pidLow: 0x005a, pidHigh: 0x0011, unit: 'hz', displayMin: 5, displayMax: 500, scaling: 'log10' },
  'phaser.max_frequency':    { block: 'phaser', name: 'max_frequency', displayLabel: "Max Frequency",     pidLow: 0x005a, pidHigh: 0x0012, unit: 'hz', displayMin: 200, displayMax: 20000, scaling: 'log10' },
  'phaser.bias':             { block: 'phaser', name: 'bias', displayLabel: "Bias",              pidLow: 0x005a, pidHigh: 0x0014, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'phaser.feedback_point':   { block: 'phaser', name: 'feedback_point', displayLabel: "Feedback Point",    pidLow: 0x005a, pidHigh: 0x0016, unit: 'count', displayMin: 0, displayMax: 11 },
  'phaser.q':                { block: 'phaser', name: 'q', displayLabel: "Q",                 pidLow: 0x005a, pidHigh: 0x0019, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'phaser.shape_vcrk':       { block: 'phaser', name: 'shape_vcrk', displayLabel: "Shape",        pidLow: 0x005a, pidHigh: 0x001d, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'phaser.shape':            { block: 'phaser', name: 'shape', displayLabel: "Shape",             pidLow: 0x005a, pidHigh: 0x001e, unit: 'count', displayMin: 0.01, displayMax: 0.99 },
  'phaser.high_cut':         { block: 'phaser', name: 'high_cut', displayLabel: "High Cut",          pidLow: 0x005a, pidHigh: 0x001f, unit: 'count', displayMin: 0.5, displayMax: 50, scaling: 'log10' },
  'phaser.attack':           { block: 'phaser', name: 'attack', displayLabel: "Attack",            pidLow: 0x005a, pidHigh: 0x0020, unit: 'ms', displayMin: 0, displayMax: 1000, scaling: 'log10' },
  'phaser.release':          { block: 'phaser', name: 'release', displayLabel: "Release",           pidLow: 0x005a, pidHigh: 0x0021, unit: 'ms', displayMin: 0, displayMax: 100, scaling: 'log10' },
  'phaser.low_cut':          { block: 'phaser', name: 'low_cut', displayLabel: "Low Cut",           pidLow: 0x005a, pidHigh: 0x0023, unit: 'hz', displayMin: 20, displayMax: 200, scaling: 'log10' },
  'phaser.high_cut_lpf':     { block: 'phaser', name: 'high_cut_lpf', displayLabel: "High Cut",      pidLow: 0x005a, pidHigh: 0x0024, unit: 'hz', displayMin: 2000, displayMax: 20000, scaling: 'log10' },
  // FILTER mirrors (15).
  'filter.q':                { block: 'filter', name: 'q', displayLabel: "Q",                 pidLow: 0x0072, pidHigh: 0x000c, unit: 'count', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'filter.gain':             { block: 'filter', name: 'gain', displayLabel: "Gain",              pidLow: 0x0072, pidHigh: 0x000d, unit: 'db', displayMin: -20, displayMax: 20 },
  // Bipolar-encoded at the wire (display=30 returns wire u16 42597 =
  // round(0.65 x 65534) = bipolar (0.3 + 1)/2 shape), not simple
  // percent. Catalog originally registered as 0..100 percent; the
  // Session 123 all-blocks fn 0x1F position probe surfaced the
  // mismatch (decoded display=65 when the AM4 panel actually read 30).
  // Fixed to mirror the volpan.pan_left / volpan.pan_right precedent
  // at L3436 / L3443 (same displayLabel, same bipolar encoding).
  'filter.pan_left':         { block: 'filter', name: 'pan_left', displayLabel: "Pan Left",          pidLow: 0x0072, pidHigh: 0x000f, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'filter.pan_right':        { block: 'filter', name: 'pan_right', displayLabel: "Pan Right",         pidLow: 0x0072, pidHigh: 0x0010, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'filter.delay_time':       { block: 'filter', name: 'delay_time', displayLabel: "Delay Time",        pidLow: 0x0072, pidHigh: 0x0014, unit: 'ms', displayMin: 0, displayMax: 40 },
  'filter.rate':             { block: 'filter', name: 'rate', displayLabel: "Rate",              pidLow: 0x0072, pidHigh: 0x0018, unit: 'hz', displayMin: 0.1, displayMax: 10, scaling: 'log10' },
  'filter.lfo_duty':         { block: 'filter', name: 'lfo_duty', displayLabel: "Duty Cycle",          pidLow: 0x0072, pidHigh: 0x0019, unit: 'percent', displayMin: 0, displayMax: 100 },
  'filter.mod_frequency':    { block: 'filter', name: 'mod_frequency', displayLabel: "Mod Freq",     pidLow: 0x0072, pidHigh: 0x001a, unit: 'hz', displayMin: 20, displayMax: 20000, scaling: 'log10' },
  'filter.resonance':        { block: 'filter', name: 'resonance', displayLabel: "Resonance",         pidLow: 0x0072, pidHigh: 0x001e, unit: 'knob_0_10', displayMin: 0, displayMax: 10, scaling: 'log10' },
  'filter.start_frequency':  { block: 'filter', name: 'start_frequency', displayLabel: "Start Frequency",   pidLow: 0x0072, pidHigh: 0x001f, unit: 'hz', displayMin: 100, displayMax: 10000, scaling: 'log10' },
  'filter.stop_frequency':   { block: 'filter', name: 'stop_frequency', displayLabel: "Stop Frequency",    pidLow: 0x0072, pidHigh: 0x0020, unit: 'hz', displayMin: 100, displayMax: 10000, scaling: 'log10' },
  'filter.sensitivity':      { block: 'filter', name: 'sensitivity', displayLabel: "Sensitivity",       pidLow: 0x0072, pidHigh: 0x0021, unit: 'count', displayMin: 0.1, displayMax: 40, scaling: 'log10' },
  'filter.attack_time':      { block: 'filter', name: 'attack_time', displayLabel: "Attack Time",       pidLow: 0x0072, pidHigh: 0x0022, unit: 'ms', displayMin: 0, displayMax: 1000, scaling: 'log10' },
  'filter.release_time':     { block: 'filter', name: 'release_time', displayLabel: "Release Time",      pidLow: 0x0072, pidHigh: 0x0023, unit: 'ms', displayMin: 0, displayMax: 2000, scaling: 'log10' },
  'filter.emphasis':         { block: 'filter', name: 'emphasis', displayLabel: "Emphasis",          pidLow: 0x0072, pidHigh: 0x0027, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
  // TREMOLO mirrors (4).
  'tremolo.duty':            { block: 'tremolo', name: 'duty', displayLabel: "Duty",             pidLow: 0x006a, pidHigh: 0x000e, unit: 'percent', displayMin: 0, displayMax: 100 },
  'tremolo.crossover_freq':  { block: 'tremolo', name: 'crossover_freq', displayLabel: "Crossover Freq",   pidLow: 0x006a, pidHigh: 0x0015, unit: 'hz', displayMin: 200, displayMax: 2000, scaling: 'log10' },
  'tremolo.trigger_threshold': { block: 'tremolo', name: 'trigger_threshold', displayLabel: "Trigger Threshold", pidLow: 0x006a, pidHigh: 0x0016, unit: 'db', displayMin: -60, displayMax: 20 },
  'tremolo.shape':           { block: 'tremolo', name: 'shape', displayLabel: "Shape",            pidLow: 0x006a, pidHigh: 0x0017, unit: 'percent', displayMin: 0, displayMax: 100 },
  // ENHANCER mirrors (2).
  // Bipolar wire encoding, same as filter.pan_left / filter.pan_right
  // and the volpan precedent at L3436 / L3443. See the filter entry's
  // comment above for the Session 123 evidence trail.
  'enhancer.pan_left':       { block: 'enhancer', name: 'pan_left', displayLabel: "Pan Left",        pidLow: 0x007a, pidHigh: 0x0010, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'enhancer.pan_right':      { block: 'enhancer', name: 'pan_right', displayLabel: "Pan Right",       pidLow: 0x007a, pidHigh: 0x0011, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  // COMPRESSOR mirrors (7).
  'compressor.compression':  { block: 'compressor', name: 'compression', displayLabel: "Compression",        pidLow: 0x002e, pidHigh: 0x0014, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
  'compressor.dynamics':     { block: 'compressor', name: 'dynamics', displayLabel: "Dynamics",           pidLow: 0x002e, pidHigh: 0x0018, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
  'compressor.threshold_thresh2': { block: 'compressor', name: 'threshold_thresh2', displayLabel: "Threshold", pidLow: 0x002e, pidHigh: 0x0021, unit: 'db', displayMin: -60, displayMax: 20 },
  'compressor.ratio_compansion':  { block: 'compressor', name: 'ratio_compansion', displayLabel: "Ratio",  pidLow: 0x002e, pidHigh: 0x0024, unit: 'ratio', displayMin: 1, displayMax: 10, scaling: 'log10' },
  'compressor.time':         { block: 'compressor', name: 'time', displayLabel: "Time",               pidLow: 0x002e, pidHigh: 0x0025, unit: 'ms', displayMin: 0, displayMax: 1000, scaling: 'log10' },
  'compressor.transients':   { block: 'compressor', name: 'transients', displayLabel: "Transients",         pidLow: 0x002e, pidHigh: 0x0026, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
  'compressor.tone':         { block: 'compressor', name: 'tone', displayLabel: "Tone",               pidLow: 0x002e, pidHigh: 0x0028, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },

  // 2026-05-17: FLANGER / PHASER / FILTER 
  // closeout. 28 catalog symbols from the Ghidra paramId table that
  // have AM4-Edit XML labels but no params.ts entry. Confidence tiers
  // per the  convention:
  //   • HIGH: shared LFO_WAVEFORMS_VALUES / TEMPO_DIVISIONS_VALUES
  //     dictionaries, wire-byte identical to existing entries that use
  //     them. Wire-safe.
  //   • MEDIUM: 2-value toggles with the conventional { 0:'OFF', 1:'ON' }
  //     labels. Wire range documented; labels are conventional guesses.
  //     Wire writes still safe (values 0 / 1 in range).
  //   • LOWER: multi-value enums without a known label table — shipped
  //     as `unit: 'count'` so the agent can address the param without
  //     claiming the labels. Hardware verification can upgrade later.
  // Resolver-name dedup suffixes follow the existing pattern
  // (`shape_vcrk`, `high_cut_lpf`, `ratio_compansion`): when the
  // AM4-Edit label collides with an existing entry's name, add a
  // disambiguating suffix and accept the  on the audit
  // (intentional disambiguation, ceiling bump).

  // FLANGER hand-author (9). All 9 names match the AM4-Edit XML
  // display labels → WIRED-MATCHED.
  'flanger.lfo_type':         { block: 'flanger', name: 'lfo_type',          displayLabel: 'LFO Type',       pidLow: 0x0052, pidHigh: 0x0012, unit: 'enum', displayMin: 0, displayMax: 9, enumValues: LFO_WAVEFORMS_VALUES },
  'flanger.auto_depth':       { block: 'flanger', name: 'auto_depth',        displayLabel: 'Auto Depth',     pidLow: 0x0052, pidHigh: 0x0014, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'flanger.phase_reverse':    { block: 'flanger', name: 'phase_reverse',     displayLabel: 'Phase Reverse',  pidLow: 0x0052, pidHigh: 0x0015, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'flanger.thru_zero':        { block: 'flanger', name: 'thru_zero',         displayLabel: 'Thru Zero',      pidLow: 0x0052, pidHigh: 0x0016, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'flanger.bypass_reset':     { block: 'flanger', name: 'bypass_reset',      displayLabel: 'Bypass Reset',   pidLow: 0x0052, pidHigh: 0x001b, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  // High/Low Cut Slope: filter-stage IIR order (typical Fractal range
  // 1..12). Shipped as count until hardware verification supplies the
  // discrete slope labels (typical: 6/12/18/24 dB/oct).
  'flanger.high_cut_slope':   { block: 'flanger', name: 'high_cut_slope',    displayLabel: 'High Cut Slope', pidLow: 0x0052, pidHigh: 0x001c, unit: 'count', displayMin: 1, displayMax: 12 },
  'flanger.low_cut_slope':    { block: 'flanger', name: 'low_cut_slope',     displayLabel: 'Low Cut Slope',  pidLow: 0x0052, pidHigh: 0x001d, unit: 'count', displayMin: 1, displayMax: 12 },
  'flanger.vco_response':     { block: 'flanger', name: 'vco_response',      displayLabel: 'VCO Response',   pidLow: 0x0052, pidHigh: 0x001f, unit: 'count', displayMin: 0, displayMax: 10 },
  'flanger.steps':            { block: 'flanger', name: 'steps',             displayLabel: 'Steps',          pidLow: 0x0052, pidHigh: 0x0022, unit: 'count', displayMin: 0, displayMax: 32 },

  // PHASER hand-author (9). 6 MATCH the AM4-Edit display label;
  // 3 are intentional disambiguations (lfo_type, vcr_curve, lfo_mode
  // — AM4-Edit displays "Type" / "Type" / "Mode" but `phaser.type` and
  // `phaser.mode` are already used) →  with ceiling bump.
  'phaser.order':             { block: 'phaser', name: 'order',              displayLabel: 'Order',          pidLow: 0x005a, pidHigh: 0x000b, unit: 'count', displayMin: 1, displayMax: 12 },
  'phaser.lfo_type':          { block: 'phaser', name: 'lfo_type',           displayLabel: 'LFO Type',       pidLow: 0x005a, pidHigh: 0x000d, unit: 'enum', displayMin: 0, displayMax: 9, enumValues: LFO_WAVEFORMS_VALUES },
  'phaser.mode':              { block: 'phaser', name: 'mode',               displayLabel: 'Mode',           pidLow: 0x005a, pidHigh: 0x0015, unit: 'count', displayMin: 0, displayMax: 3 },
  'phaser.tone':              { block: 'phaser', name: 'tone',               displayLabel: 'Tone',           pidLow: 0x005a, pidHigh: 0x0017, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
  'phaser.direction':         { block: 'phaser', name: 'direction',          displayLabel: 'Direction',      pidLow: 0x005a, pidHigh: 0x0018, unit: 'count', displayMin: 0, displayMax: 2 },
  'phaser.reset_on_bypass':   { block: 'phaser', name: 'reset_on_bypass',    displayLabel: 'Reset on Bypass', pidLow: 0x005a, pidHigh: 0x001a, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'phaser.quantize':          { block: 'phaser', name: 'quantize',           displayLabel: 'Quantize',       pidLow: 0x005a, pidHigh: 0x001b, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  // vcr_curve: AM4-Edit label is "Type" (alpha curve for the VCR
  // simulation on the Config page). Disambiguating suffix since
  // `phaser.type` is the family Type enum.
  'phaser.vcr_curve':         { block: 'phaser', name: 'vcr_curve',          displayLabel: 'Type',           pidLow: 0x005a, pidHigh: 0x001c, unit: 'count', displayMin: 0, displayMax: 3 },
  // lfo_mode: AM4-Edit label is "Mode" (LFO mode selector). Disambig
  // suffix since `phaser.mode` is already taken above (PHASER_MODE,
  // no XML label).
  'phaser.lfo_mode':          { block: 'phaser', name: 'lfo_mode',           displayLabel: 'Mode',           pidLow: 0x005a, pidHigh: 0x0025, unit: 'count', displayMin: 0, displayMax: 3 },

  // FILTER hand-author (10). 9 MATCH the AM4-Edit display label;
  // 1 is intentional disambiguation (order_2 — AM4-Edit displays
  // "Order" but `filter.order` is already at pidHigh=0x1c from the
  // cache pipeline) →  with ceiling bump.
  'filter.order_2':           { block: 'filter', name: 'order_2',            displayLabel: 'Order',          pidLow: 0x0072, pidHigh: 0x000e, unit: 'count', displayMin: 1, displayMax: 12 },
  'filter.phase_invert':      { block: 'filter', name: 'phase_invert',       displayLabel: 'Phase Invert',   pidLow: 0x0072, pidHigh: 0x0011, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  // enable: AM4-Edit displays "Enable" (LFO Enable on the LFO page).
  // Naming as `enable` matches the AM4-Edit label.
  'filter.enable':            { block: 'filter', name: 'enable',             displayLabel: 'Enable',         pidLow: 0x0072, pidHigh: 0x0016, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'filter.lfo_type':          { block: 'filter', name: 'lfo_type',           displayLabel: 'LFO Type',       pidLow: 0x0072, pidHigh: 0x0017, unit: 'enum', displayMin: 0, displayMax: 9, enumValues: LFO_WAVEFORMS_VALUES },
  'filter.quantize':          { block: 'filter', name: 'quantize',           displayLabel: 'Quantize',       pidLow: 0x0072, pidHigh: 0x001b, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'filter.mode':              { block: 'filter', name: 'mode',               displayLabel: 'Mode',           pidLow: 0x0072, pidHigh: 0x001d, unit: 'count', displayMin: 0, displayMax: 3 },
  'filter.sweep_shape':       { block: 'filter', name: 'sweep_shape',        displayLabel: 'Sweep Shape',    pidLow: 0x0072, pidHigh: 0x0024, unit: 'count', displayMin: 0, displayMax: 10 },
  'filter.detector_source':   { block: 'filter', name: 'detector_source',    displayLabel: 'Detector Source', pidLow: 0x0072, pidHigh: 0x0025, unit: 'count', displayMin: 0, displayMax: 3 },
  'filter.detect':            { block: 'filter', name: 'detect',             displayLabel: 'Detect',         pidLow: 0x0072, pidHigh: 0x0026, unit: 'count', displayMin: 0, displayMax: 3 },
  'filter.tempo':             { block: 'filter', name: 'tempo',              displayLabel: 'Tempo',          pidLow: 0x0072, pidHigh: 0x0028, unit: 'enum', displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },

  // ── 2026-05-17 — CABINET  closeout ──
  // 24 hand-authored entries on the canonical CABINET register
  // (pidLow=0x003e). Catalog source: Ghidra-extracted PATCH family
  // params via samples/captured/decoded/ghidra-am4-paramnames.json,
  // cross-referenced with AM4-Edit's __block_layout.xml +
  // __block_layout_expert.xml. Display labels come from the XML
  // `name=` attribute; entries lacking a display string are XML-
  // invisible firmware-internal controls (still wired via the
  // catalog).
  //
  // Deferred from this session (already addressable via the cross-
  // block resolver path at pidLow=0x003a):
  //   • CABINET_PROXIMITY2 → amp.proximity in cacheParams.ts at 0x15
  //   • CABINET_DYNACAB_Z1 → amp.distance in cacheParams.ts at 0x47
  //   • CABINET_DYNACAB_Z2 → amp.distance_dynacab_z2 at 0x48
  //   • CABINET_ZOOM (UI-toggle for editor zoom view, not a real
  //     device-side setting — btnRectangleToggle in expert XML only)
  //
  // Confidence tiers:
  //   HIGH   — mirrors an existing first-cab entry (bank/cab/pan/
  //            low_slope/high_slope/dynacab)
  //   MEDIUM — labeled in XML, tonal unit inferred from sibling
  //            controls (BASS/MID = knob_0_10 like amp tone stack)
  //   LOWER  — no XML label; unit: 'count' as a safe-write placeholder
  //            until hardware verification supplies the range/enum
  //
  // Naming convention: `_1`/`_2` suffix mirrors existing
  // `cab_1_blend`/`cab_2_blend` / `low_slope`/`high_slope` pattern.
  // Per-cab knob names get the `cab_` prefix when the bare name would
  // collide with an amp-stack knob (cab_bass vs amp.bass, cab_mid
  // vs amp.mid).

  // Second-cab mirrors of existing first-cab entries (HIGH confidence).
  'amp.bank_2': {
    block: 'amp', name: 'bank_2',
    displayLabel: 'Bank',
    pidLow: 0x003e, pidHigh: 0x000b,
    unit: 'enum', displayMin: 0, displayMax: 0,
    enumValues: { 0: 'USER' },
  },
  'amp.cab_2': {
    block: 'amp', name: 'cab_2',
    displayLabel: 'Cab #',
    pidLow: 0x003e, pidHigh: 0x000d,
    unit: 'count', displayMin: 0, displayMax: 255,
  },
  'amp.pan_2':            { block: 'amp', name: 'pan_2',            displayLabel: 'Pan',            pidLow: 0x003e, pidHigh: 0x0011, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'amp.low_slope_2': {
    block: 'amp', name: 'low_slope_2',
    displayLabel: 'Low Slope',
    pidLow: 0x003e, pidHigh: 0x003c,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '18 dB/OCT', 3: '24 dB/OCT' },
  },
  'amp.high_slope_2': {
    block: 'amp', name: 'high_slope_2',
    displayLabel: 'High Slope',
    pidLow: 0x003e, pidHigh: 0x003e,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '18 dB/OCT', 3: '24 dB/OCT' },
  },
  'amp.dynacab_2': {
    block: 'amp', name: 'dynacab_2',
    displayLabel: 'DynaCab',
    pidLow: 0x003e, pidHigh: 0x0046,
    unit: 'knob_0_10', displayMin: -10, displayMax: 10,
  },

  // Per-cab level + proximity + mute (LEVEL1/2 have no XML label —
  // firmware-internal, but the names follow the established `_N`
  // suffix convention).
  'amp.cab_level_1':      { block: 'amp', name: 'cab_level_1',      pidLow: 0x003e, pidHigh: 0x000e, unit: 'db', displayMin: -80, displayMax: 20 },
  'amp.cab_level_2':      { block: 'amp', name: 'cab_level_2',      pidLow: 0x003e, pidHigh: 0x000f, unit: 'db', displayMin: -80, displayMax: 20 },
  'amp.proximity_1': {
    block: 'amp', name: 'proximity_1',
    displayLabel: 'Proximity',
    pidLow: 0x003e, pidHigh: 0x0014,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.cab_mute_1': {
    block: 'amp', name: 'cab_mute_1',
    displayLabel: 'M',
    pidLow: 0x003e, pidHigh: 0x0016,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: '--', 1: 'MUTE' },
  },
  'amp.cab_mute_2': {
    block: 'amp', name: 'cab_mute_2',
    displayLabel: 'M',
    pidLow: 0x003e, pidHigh: 0x0017,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: '--', 1: 'MUTE' },
  },

  // Master / cab-level Hz filters (LOCUT = master low cut on the
  // Cab Master EQ page; LOCUT1 = per-cab-1 low cut on the Cab page).
  // The existing `cab_master_low_cut` at pidHigh=0x22 is actually
  // wired to CABINET_PROXFREQ (catalog id 34) — a -era
  // misname that's left as-is for backward compatibility; this new
  // `master_low_cut` is the true CABINET_LOCUT control.
  'amp.master_low_cut': {
    block: 'amp', name: 'master_low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x003e, pidHigh: 0x001f,
    unit: 'hz', displayMin: 20, displayMax: 2000,
    scaling: 'log10',
  },
  'amp.cab_1_low_cut': {
    block: 'amp', name: 'cab_1_low_cut',
    displayLabel: 'Low Cut',
    pidLow: 0x003e, pidHigh: 0x0035,
    unit: 'hz', displayMin: 20, displayMax: 200,
    scaling: 'log10',
  },

  // Mic-preamp tone-stack on the Cab Mic Preamp page (BASS/MID at
  // catalog ids 37/38; the existing `cab_mic_preamp_treble` at
  // pidHigh=0x27 already covers TREBLE at id 39). PRETYPE is the
  // Type dropdown on the same page (mic-preamp circuit selector).
  'amp.cab_pretype': {
    block: 'amp', name: 'cab_pretype',
    displayLabel: 'Type',
    pidLow: 0x003e, pidHigh: 0x0024,
    unit: 'enum', displayMin: 0, displayMax: 11,
    enumValues: {
      0: 'NONE', 1: 'TUBE', 2: 'BIPOLAR', 3: 'FET I', 4: 'FET II', 5: 'TRANSFORMER',
      6: 'TAPE 70us', 7: 'TAPE 50us', 8: 'TAPE 35us', 9: 'VINTAGE', 10: 'MODERN', 11: 'EXCITER',
    },
  },
  'amp.cab_bass': {
    block: 'amp', name: 'cab_bass',
    displayLabel: 'Bass',
    pidLow: 0x003e, pidHigh: 0x0025,
    unit: 'db', displayMin: -12, displayMax: 12,
  },
  'amp.cab_mid': {
    block: 'amp', name: 'cab_mid',
    displayLabel: 'Mid',
    pidLow: 0x003e, pidHigh: 0x0026,
    unit: 'db', displayMin: -12, displayMax: 12,
  },

  // SMOOTH1/2 / ORDER / GAINMONITOR — no XML labels (firmware-
  // internal). SMOOTH1/2 carry knob-shaped cache records (scale 10);
  // ORDER / GAINMONITOR cache records are degenerate (no info), so
  // their shipped shapes are kept as-is.
  'amp.cab_smooth_1': {
    block: 'amp', name: 'cab_smooth_1',
    pidLow: 0x003e, pidHigh: 0x0029,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.cab_smooth_2': {
    block: 'amp', name: 'cab_smooth_2',
    pidLow: 0x003e, pidHigh: 0x002a,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.cab_order':        { block: 'amp', name: 'cab_order',        pidLow: 0x003e, pidHigh: 0x002b, unit: 'count', displayMin: 1, displayMax: 12 },
  'amp.cab_gain_monitor': { block: 'amp', name: 'cab_gain_monitor', pidLow: 0x003e, pidHigh: 0x0033, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },

  // DynaCab quad (TYPE1/2/MIC1/2). XML has empty `name=""` in regular
  // layout and "Cab"/"Mic" in expert layout — the audit picks the
  // first XML hit, so these will MATCH (empty display).
  'amp.dynacab_type_1': {
    block: 'amp', name: 'dynacab_type_1',
    displayLabel: 'Cab',
    pidLow: 0x003e, pidHigh: 0x0041,
    unit: 'enum', displayMin: 0, displayMax: 44,
    enumValues: {
      0: '1x8 5F1 TWEED', 1: '1x8 PRINCETONE', 2: '1x10 BF PRINCETONE', 3: '1x10 METRO BLUES',
      4: '1x10 SF PRINCETONE', 5: '1x12 AC20', 6: '1x12 BLACK MAGICK', 7: '1x12 CAR AMBLER',
      8: '1x12 DELUXE TWEED', 9: '1x12 DELUXE VERB', 10: '1x12 DIV13 CJ11', 11: '1x12 G12T-100',
      12: '1x12 HOT KITTY', 13: '1x12 JR BLUES', 14: '1x12 NUCLEAR TONE', 15: '1x12 SCHOLZ',
      16: '1x12 TWEED 20112', 17: '1x12 VIBRATO LUX', 18: '1x15 HEART KEY', 19: '1x15 PORTABASS',
      20: '1x15 VIBROVERB', 21: '2x10 HEART KEY', 22: '2x10 SUPER 6G4', 23: '2x12 5153 STEALTH',
      24: '2x12 65 BASSGUY', 25: '2x12 CHIEFMAN', 26: '2x12 CLASS-A 30W', 27: '2x12 DOUBLE VERB',
      28: '2x12 LEAD 80', 29: '2x12 TEXAS STAR', 30: '4x10 BASSGUY RI', 31: '4x12 1960TV',
      32: '4x12 5153', 33: '4x12 5153 STEALTH', 34: '4x12 CITRUS', 35: '4x12 FRIEDMAN GB',
      36: '4x12 FRIEDMAN V30', 37: '4x12 LERXST', 38: '4x12 RECTO SLANT',
      39: '4x12 RECTO STRAIGHT', 40: '4x12 RUMBLE EV12L', 41: '4x12 RUMBLE EV12S',
      42: '4x12 SOLO 100', 43: '4x12 USA MC90', 44: '8x10 SV BASS',
    },
  },
  'amp.dynacab_type_2': {
    block: 'amp', name: 'dynacab_type_2',
    displayLabel: 'Cab',
    pidLow: 0x003e, pidHigh: 0x0042,
    unit: 'enum', displayMin: 0, displayMax: 44,
    enumValues: {
      0: '1x8 5F1 TWEED', 1: '1x8 PRINCETONE', 2: '1x10 BF PRINCETONE', 3: '1x10 METRO BLUES',
      4: '1x10 SF PRINCETONE', 5: '1x12 AC20', 6: '1x12 BLACK MAGICK', 7: '1x12 CAR AMBLER',
      8: '1x12 DELUXE TWEED', 9: '1x12 DELUXE VERB', 10: '1x12 DIV13 CJ11', 11: '1x12 G12T-100',
      12: '1x12 HOT KITTY', 13: '1x12 JR BLUES', 14: '1x12 NUCLEAR TONE', 15: '1x12 SCHOLZ',
      16: '1x12 TWEED 20112', 17: '1x12 VIBRATO LUX', 18: '1x15 HEART KEY', 19: '1x15 PORTABASS',
      20: '1x15 VIBROVERB', 21: '2x10 HEART KEY', 22: '2x10 SUPER 6G4', 23: '2x12 5153 STEALTH',
      24: '2x12 65 BASSGUY', 25: '2x12 CHIEFMAN', 26: '2x12 CLASS-A 30W', 27: '2x12 DOUBLE VERB',
      28: '2x12 LEAD 80', 29: '2x12 TEXAS STAR', 30: '4x10 BASSGUY RI', 31: '4x12 1960TV',
      32: '4x12 5153', 33: '4x12 5153 STEALTH', 34: '4x12 CITRUS', 35: '4x12 FRIEDMAN GB',
      36: '4x12 FRIEDMAN V30', 37: '4x12 LERXST', 38: '4x12 RECTO SLANT',
      39: '4x12 RECTO STRAIGHT', 40: '4x12 RUMBLE EV12L', 41: '4x12 RUMBLE EV12S',
      42: '4x12 SOLO 100', 43: '4x12 USA MC90', 44: '8x10 SV BASS',
    },
  },
  'amp.dynacab_mic_1': {
    block: 'amp', name: 'dynacab_mic_1',
    displayLabel: 'Mic',
    pidLow: 0x003e, pidHigh: 0x0043,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'Condenser', 1: 'Ribbon', 2: 'Dynamic 1', 3: 'Dynamic 2' },
  },
  'amp.dynacab_mic_2': {
    block: 'amp', name: 'dynacab_mic_2',
    displayLabel: 'Mic',
    pidLow: 0x003e, pidHigh: 0x0044,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'Condenser', 1: 'Ribbon', 2: 'Dynamic 1', 3: 'Dynamic 2' },
  },

  // ============================================================
  // GLOBAL family (pidLow = 0x0001) — 98 entries.
  //
  // Wire pidLow decoded 2026-05-17 from
  // samples/captured/session-95-am4-global-pidlow.pcapng. paramIds
  // sourced from samples/captured/decoded/ghidra-am4-paramnames.json
  // (effect_types.case_0x1.params, 99 entries; GLOBAL_FC_HOLD_TIMEOUT
  // appears twice at paramId 57 so deduped to 98).
  //
  // Two paramIds are HW-verified by the  capture: USBLEVEL1
  // (99) at 1.11 dB and TAP_TEMPO_MODE (46) at 1.0 = "Last Two".
  // All other unit/range pairs are name-inferred — entries default
  // to unit: 'count' as a safe write placeholder pending hardware
  // verification. The Ghidra catalog gives us the address and the
  // symbolic name; UI semantics still need front-panel or AM4-Edit
  // captures to confirm range/enum tables.
  //
  // Naming convention: `global.<lowercased>` with the GLOBAL_ prefix
  // stripped and `+N` array suffixes converted to `_N` (so
  // `GLOBAL_EXT_CC_BEGIN+1` -> `global.ext_cc_begin_1`).
  //
  // Regenerate: `npx tsx scripts/_research/generate-am4-global-block.ts`

  // tuning reference Hz convention — HW unverified
  'global.tuningref': { block: 'global', name: 'tuningref', displayLabel: "Calibration", pidLow: 0x0001, pidHigh: 0x000d, unit: 'hz', displayMin: 430, displayMax: 450 },
  // cache oracle + deep-verify (2026-06-10, roster n=4): enum, not a count placeholder
  'global.tunermute': { block: 'global', name: 'tunermute', displayLabel: "Mute Type", pidLow: 0x0001, pidHigh: 0x000e, unit: 'enum', displayMin: 0, displayMax: 3, enumValues: { 0: 'Auto In', 1: 'Auto Out', 2: 'Manual In', 3: 'Manual Out' } },
  // confirmed 2026-06-05: OFF/DELAY/REVERB/DELAY+REVERB
  'global.delayspill': { block: 'global', name: 'delayspill', displayLabel: "Spillover", pidLow: 0x0001, pidHigh: 0x000f, unit: 'enum', displayMin: 0, displayMax: 3, enumValues: { 0: 'Off', 1: 'Delay', 2: 'Reverb', 3: 'Delay & Rev' } },
  // cache oracle + deep-verify (2026-06-10, roster n=2): OFF/ON enum
  'global.usetuneoffsets': { block: 'global', name: 'usetuneoffsets', displayLabel: "Use Offsets", pidLow: 0x0001, pidHigh: 0x0010, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  // cache oracle: per-string tuning offset ±25 step 0.05 (tc unit-family 7).
  // 'cents' display suffix inferred from tuner context (UNCONFIRMED); range
  // and shape are device-true. Was semitones ±1 (wrong shape). deep-verify
  // 2026-06-10 read in-range [-25..25].
  'global.offset1': { block: 'global', name: 'offset1', displayLabel: "E 1", pidLow: 0x0001, pidHigh: 0x0011, unit: 'count', displayMin: -25, displayMax: 25, displayUnit: 'cents' },
  'global.offset2': { block: 'global', name: 'offset2', displayLabel: "B 2", pidLow: 0x0001, pidHigh: 0x0012, unit: 'count', displayMin: -25, displayMax: 25, displayUnit: 'cents' },
  'global.offset3': { block: 'global', name: 'offset3', displayLabel: "G 3", pidLow: 0x0001, pidHigh: 0x0013, unit: 'count', displayMin: -25, displayMax: 25, displayUnit: 'cents' },
  'global.offset4': { block: 'global', name: 'offset4', displayLabel: "D 4", pidLow: 0x0001, pidHigh: 0x0014, unit: 'count', displayMin: -25, displayMax: 25, displayUnit: 'cents' },
  'global.offset5': { block: 'global', name: 'offset5', displayLabel: "A 5", pidLow: 0x0001, pidHigh: 0x0015, unit: 'count', displayMin: -25, displayMax: 25, displayUnit: 'cents' },
  'global.offset6': { block: 'global', name: 'offset6', displayLabel: "E 6", pidLow: 0x0001, pidHigh: 0x0016, unit: 'count', displayMin: -25, displayMax: 25, displayUnit: 'cents' },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq1': { block: 'global', name: 'out2eq1', pidLow: 0x0001, pidHigh: 0x0022, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq2': { block: 'global', name: 'out2eq2', pidLow: 0x0001, pidHigh: 0x0023, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq3': { block: 'global', name: 'out2eq3', pidLow: 0x0001, pidHigh: 0x0024, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq4': { block: 'global', name: 'out2eq4', pidLow: 0x0001, pidHigh: 0x0025, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq5': { block: 'global', name: 'out2eq5', pidLow: 0x0001, pidHigh: 0x0026, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq6': { block: 'global', name: 'out2eq6', pidLow: 0x0001, pidHigh: 0x0027, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq7': { block: 'global', name: 'out2eq7', pidLow: 0x0001, pidHigh: 0x0028, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq8': { block: 'global', name: 'out2eq8', pidLow: 0x0001, pidHigh: 0x0029, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq9': { block: 'global', name: 'out2eq9', pidLow: 0x0001, pidHigh: 0x002a, unit: 'db', displayMin: -12, displayMax: 12 },
  // GEQ band ±12 dB convention — HW unverified
  'global.out2eq10': { block: 'global', name: 'out2eq10', pidLow: 0x0001, pidHigh: 0x002b, unit: 'db', displayMin: -12, displayMax: 12 },
  // gate threshold offset dB — HW unverified
  'global.gate_offset': { block: 'global', name: 'gate_offset', displayLabel: "Noisegate Offset", pidLow: 0x0001, pidHigh: 0x002d, unit: 'db', displayMin: -40, displayMax: 0 },
  // confirmed 2026-06-05: AVERAGE/LAST TWO (index 1 previously captured)
  'global.tap_tempo_mode': { block: 'global', name: 'tap_tempo_mode', displayLabel: "Tap Tempo Mode", pidLow: 0x0001, pidHigh: 0x002e, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Average', 1: 'Last Two' } },
  // input trim percent — HW unverified
  'global.in1_trim': { block: 'global', name: 'in1_trim', displayLabel: "Input Pad", pidLow: 0x0001, pidHigh: 0x002f, unit: 'percent', displayMin: 0, displayMax: 100 },
  // confirmed 2026-06-05: STEREO/SUM L+R/COPY L->R/SPLIT/MUTE (note: SPLIT shows cab-sim routing info on device)
  'global.out1_config': { block: 'global', name: 'out1_config', displayLabel: "Output Mode", pidLow: 0x0001, pidHigh: 0x0030, unit: 'enum', displayMin: 0, displayMax: 4, enumValues: { 0: 'Stereo', 1: 'Sum L+R', 2: 'Copy L->R', 3: 'Split', 4: 'Mute' } },
  // confirmed 2026-06-05
  'global.out1_phase': { block: 'global', name: 'out1_phase', displayLabel: "Output Phase", pidLow: 0x0001, pidHigh: 0x0031, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Normal', 1: 'Invert' } },
  // confirmed 2026-06-05
  'global.in1_source': { block: 'global', name: 'in1_source', displayLabel: "Input Source", pidLow: 0x0001, pidHigh: 0x0034, unit: 'enum', displayMin: 0, displayMax: 2, enumValues: { 0: 'Analog', 1: 'SPDIF', 2: 'USB (Channels 3/4)' } },
  // safe placeholder (range unverified) — Ghidra catalog entry only
  'global.in1_config': { block: 'global', name: 'in1_config', pidLow: 0x0001, pidHigh: 0x0035, unit: 'count', displayMin: 0, displayMax: 127 },
  // percent inferred from AM4-Edit display — HW unverified
  'global.lcd_contrast': { block: 'global', name: 'lcd_contrast', displayLabel: "LCD Contrast", pidLow: 0x0001, pidHigh: 0x0038, unit: 'percent', displayMin: 0, displayMax: 100 },
  // press-hold timeout ms — HW unverified
  'global.fc_hold_timeout': { block: 'global', name: 'fc_hold_timeout', displayLabel: "Hold Timeout", pidLow: 0x0001, pidHigh: 0x0039, unit: 'ms', displayMin: 0, displayMax: 5000 },
  // MIDI channel 1..16
  'global.midi_chan': { block: 'global', name: 'midi_chan', displayLabel: "MIDI Channel", pidLow: 0x0001, pidHigh: 0x003a, unit: 'count', displayMin: 1, displayMax: 16 },
  // confirmed 2026-06-05
  'global.midi_prog_change': { block: 'global', name: 'midi_prog_change', displayLabel: "Receive MIDI PC", pidLow: 0x0001, pidHigh: 0x003b, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Off', 1: 'On' } },
  // confirmed 2026-06-05
  'global.no_redundant_pc': { block: 'global', name: 'no_redundant_pc', displayLabel: "Ignore Redundant PC", pidLow: 0x0001, pidHigh: 0x003c, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Off', 1: 'On' } },
  // confirmed 2026-06-05: OFF + Chan 1..16 + Omni
  'global.send_midipc': { block: 'global', name: 'send_midipc', displayLabel: "Send MIDI PC", pidLow: 0x0001, pidHigh: 0x003f, unit: 'enum', displayMin: 0, displayMax: 17, enumValues: { 0: 'Off', 1: 'Chan 1', 2: 'Chan 2', 3: 'Chan 3', 4: 'Chan 4', 5: 'Chan 5', 6: 'Chan 6', 7: 'Chan 7', 8: 'Chan 8', 9: 'Chan 9', 10: 'Chan 10', 11: 'Chan 11', 12: 'Chan 12', 13: 'Chan 13', 14: 'Chan 14', 15: 'Chan 15', 16: 'Chan 16', 17: 'Omni' } },
  'global.in1_vol_cc': { block: 'global', name: 'in1_vol_cc', displayLabel: "Input Volume", pidLow: 0x0001, pidHigh: 0x0046, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.out1_vol_cc': { block: 'global', name: 'out1_vol_cc', displayLabel: "Output Volume", pidLow: 0x0001, pidHigh: 0x0047, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.tempo_cc': { block: 'global', name: 'tempo_cc', displayLabel: "Tap Tempo", pidLow: 0x0001, pidHigh: 0x0048, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.tuner_cc': { block: 'global', name: 'tuner_cc', displayLabel: "Tuner", pidLow: 0x0001, pidHigh: 0x0049, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.scene_cc': { block: 'global', name: 'scene_cc', displayLabel: "Scene Select", pidLow: 0x0001, pidHigh: 0x004a, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.scene_incr_cc': { block: 'global', name: 'scene_incr_cc', displayLabel: "Scene +1", pidLow: 0x0001, pidHigh: 0x004b, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.scene_decr_cc': { block: 'global', name: 'scene_decr_cc', displayLabel: "Scene -1", pidLow: 0x0001, pidHigh: 0x004c, unit: 'count', displayMin: 0, displayMax: 127 },
  // not visible on front-panel Setup menu; may be editor-only or firmware-internal
  'global.scene_revert': { block: 'global', name: 'scene_revert', displayLabel: "Default Scene Revert", pidLow: 0x0001, pidHigh: 0x004d, unit: 'count', displayMin: 0, displayMax: 127 },
  // safe placeholder (range unverified) — Ghidra catalog entry only
  'global.custom_scale': { block: 'global', name: 'custom_scale', pidLow: 0x0001, pidHigh: 0x0050, unit: 'count', displayMin: 0, displayMax: 127 },
  // safe placeholder (range unverified) — Ghidra catalog entry only
  'global.tuner_source': { block: 'global', name: 'tuner_source', pidLow: 0x0001, pidHigh: 0x0053, unit: 'count', displayMin: 0, displayMax: 127 },
  // AM4 has 4 scenes (1..4)
  'global.default_scene': { block: 'global', name: 'default_scene', displayLabel: "Default Scene", pidLow: 0x0001, pidHigh: 0x0056, unit: 'count', displayMin: 1, displayMax: 4 },
  // percent inferred from AM4-Edit display — HW unverified
  'global.fc_ring_bright_level': { block: 'global', name: 'fc_ring_bright_level', displayLabel: "Switch LED Bright", pidLow: 0x0001, pidHigh: 0x0058, unit: 'percent', displayMin: 0, displayMax: 100 },
  // percent inferred from AM4-Edit display — HW unverified
  'global.fc_ring_dim_level': { block: 'global', name: 'fc_ring_dim_level', displayLabel: "Switch LED Dim", pidLow: 0x0001, pidHigh: 0x0059, unit: 'percent', displayMin: 0, displayMax: 100 },
  // confirmed 2026-06-05: 0=50 Hz, 1=60 Hz (50 Hz is index 0)
  'global.linefreq': { block: 'global', name: 'linefreq', displayLabel: "AC Line Frequency", pidLow: 0x0001, pidHigh: 0x005a, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: '50 Hz', 1: '60 Hz' } },
  'global.preset_incr_cc': { block: 'global', name: 'preset_incr_cc', displayLabel: "Preset +1", pidLow: 0x0001, pidHigh: 0x005d, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.preset_decr_cc': { block: 'global', name: 'preset_decr_cc', displayLabel: "Preset -1", pidLow: 0x0001, pidHigh: 0x005e, unit: 'count', displayMin: 0, displayMax: 127 },
  // unit inferred from USBLEVEL1 sibling — HW unverified
  'global.metlevel1': { block: 'global', name: 'metlevel1', displayLabel: "Metronome Level", pidLow: 0x0001, pidHigh: 0x0061, unit: 'db', displayMin: -64, displayMax: 24 },
  // confirmed 2026-06-05: only 2 values visible (Input/None)
  'global.usb78_source': { block: 'global', name: 'usb78_source', displayLabel: "USB 3/4 Record Source", pidLow: 0x0001, pidHigh: 0x0062, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Input', 1: 'None' } },
  // — captured at 1.11 dB
  'global.usblevel1': { block: 'global', name: 'usblevel1', displayLabel: "USB 1/2 Level", pidLow: 0x0001, pidHigh: 0x0063, unit: 'db', displayMin: -64, displayMax: 24 },
  // unit inferred from USBLEVEL1 sibling — HW unverified
  'global.usblevel2': { block: 'global', name: 'usblevel2', displayLabel: "USB 3/4 Level", pidLow: 0x0001, pidHigh: 0x0064, unit: 'db', displayMin: -64, displayMax: 24 },
  // unit inferred from USBLEVEL1 sibling — HW unverified
  'global.aeslevel': { block: 'global', name: 'aeslevel', displayLabel: "SPDIF In Level", pidLow: 0x0001, pidHigh: 0x0065, unit: 'db', displayMin: -64, displayMax: 24 },
  // down-tune semitones — HW unverified
  'global.downtune': { block: 'global', name: 'downtune', displayLabel: "Downtune", pidLow: 0x0001, pidHigh: 0x0067, unit: 'semitones', displayMin: -12, displayMax: 0 },
  // confirmed 2026-06-05: 0=Flats, 1=Both (b for flats / # for sharps), 2=Sharps
  'global.tuneraccidentals': { block: 'global', name: 'tuneraccidentals', displayLabel: "Tuner Accidentals", pidLow: 0x0001, pidHigh: 0x0068, unit: 'enum', displayMin: 0, displayMax: 2, enumValues: { 0: 'Flats', 1: 'Both', 2: 'Sharps' } },
  // confirmed 2026-06-05
  'global.midi_thru': { block: 'global', name: 'midi_thru', displayLabel: "MIDI Thru", pidLow: 0x0001, pidHigh: 0x006d, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Off', 1: 'On' } },
  // CC# assignment param (0=CC#1 ... not ON/OFF); exact mapping unconfirmed — keep as count
  'global.tuner_on_volume': { block: 'global', name: 'tuner_on_volume', displayLabel: "Tuner on Heel Down CC", pidLow: 0x0001, pidHigh: 0x006e, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.bypass_fx1_cc': { block: 'global', name: 'bypass_fx1_cc', displayLabel: "FX1 Bypass", pidLow: 0x0001, pidHigh: 0x006f, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.bypass_fx2_cc': { block: 'global', name: 'bypass_fx2_cc', displayLabel: "FX2 Bypass", pidLow: 0x0001, pidHigh: 0x0070, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.bypass_fx3_cc': { block: 'global', name: 'bypass_fx3_cc', displayLabel: "FX3 Bypass", pidLow: 0x0001, pidHigh: 0x0071, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.bypass_fx4_cc': { block: 'global', name: 'bypass_fx4_cc', displayLabel: "FX4 Bypass", pidLow: 0x0001, pidHigh: 0x0072, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.channel_fx1_cc': { block: 'global', name: 'channel_fx1_cc', displayLabel: "FX1 Channel", pidLow: 0x0001, pidHigh: 0x0073, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.channel_fx2_cc': { block: 'global', name: 'channel_fx2_cc', displayLabel: "FX2 Channel", pidLow: 0x0001, pidHigh: 0x0074, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.channel_fx3_cc': { block: 'global', name: 'channel_fx3_cc', displayLabel: "FX3 Channel", pidLow: 0x0001, pidHigh: 0x0075, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.channel_fx4_cc': { block: 'global', name: 'channel_fx4_cc', displayLabel: "FX4 Channel", pidLow: 0x0001, pidHigh: 0x0076, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC routing — CC number 0..127
  'global.ext_cc_begin': { block: 'global', name: 'ext_cc_begin', displayLabel: "External 1", pidLow: 0x0001, pidHigh: 0x0077, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC routing — CC number 0..127
  'global.ext_cc_begin_1': { block: 'global', name: 'ext_cc_begin_1', pidLow: 0x0001, pidHigh: 0x0078, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC routing — CC number 0..127
  'global.ext_cc_begin_2': { block: 'global', name: 'ext_cc_begin_2', pidLow: 0x0001, pidHigh: 0x0079, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC routing — CC number 0..127
  'global.ext_cc_begin_3': { block: 'global', name: 'ext_cc_begin_3', pidLow: 0x0001, pidHigh: 0x007a, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC initial value 0..127
  'global.ext_startval_begin': { block: 'global', name: 'ext_startval_begin', displayLabel: "External 1", pidLow: 0x0001, pidHigh: 0x007b, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC initial value 0..127
  'global.ext_startval_begin_1': { block: 'global', name: 'ext_startval_begin_1', pidLow: 0x0001, pidHigh: 0x007c, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC initial value 0..127
  'global.ext_startval_begin_2': { block: 'global', name: 'ext_startval_begin_2', pidLow: 0x0001, pidHigh: 0x007d, unit: 'count', displayMin: 0, displayMax: 127 },
  // external CC initial value 0..127
  'global.ext_startval_begin_3': { block: 'global', name: 'ext_startval_begin_3', pidLow: 0x0001, pidHigh: 0x007e, unit: 'count', displayMin: 0, displayMax: 127 },
  // confirmed 2026-06-05
  'global.auto_truebypass': { block: 'global', name: 'auto_truebypass', displayLabel: "Automatic AM4 Bypass", pidLow: 0x0001, pidHigh: 0x0081, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Off', 1: 'On' } },
  'global.truebypass_cc': { block: 'global', name: 'truebypass_cc', displayLabel: "AM4 Bypass", pidLow: 0x0001, pidHigh: 0x0083, unit: 'count', displayMin: 0, displayMax: 127 },
  // press-hold timeout ms — HW unverified
  'global.fs_press_hold1': { block: 'global', name: 'fs_press_hold1', displayLabel: "Press & Hold 1", pidLow: 0x0001, pidHigh: 0x0084, unit: 'ms', displayMin: 0, displayMax: 5000 },
  // press-hold timeout ms — HW unverified
  'global.fs_press_hold2': { block: 'global', name: 'fs_press_hold2', displayLabel: "Press & Hold 2", pidLow: 0x0001, pidHigh: 0x0085, unit: 'ms', displayMin: 0, displayMax: 5000 },
  // press-hold timeout ms — HW unverified
  'global.fs_press_hold3': { block: 'global', name: 'fs_press_hold3', displayLabel: "Press & Hold 3", pidLow: 0x0001, pidHigh: 0x0086, unit: 'ms', displayMin: 0, displayMax: 5000 },
  // press-hold timeout ms — HW unverified
  'global.fs_press_hold4': { block: 'global', name: 'fs_press_hold4', displayLabel: "Press & Hold 4", pidLow: 0x0001, pidHigh: 0x0087, unit: 'ms', displayMin: 0, displayMax: 5000 },
  // confirmed 2026-06-05
  'global.startup_mode': { block: 'global', name: 'startup_mode', displayLabel: "Startup Mode", pidLow: 0x0001, pidHigh: 0x0089, unit: 'enum', displayMin: 0, displayMax: 3, enumValues: { 0: 'Preset', 1: 'Scene', 2: 'Effects', 3: 'Amp' } },
  // confirmed 2026-06-05: 0=Off is default (gapless is OFF until user enables it)
  'global.gap_fill': { block: 'global', name: 'gap_fill', displayLabel: "Gapless Changes", pidLow: 0x0001, pidHigh: 0x008f, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Off', 1: 'On' } },
  // confirmed 2026-06-05: 0=Off, 1..10=seconds; device label is "Fade Selected Effect Timeout"
  'global.select_fade': { block: 'global', name: 'select_fade', displayLabel: "Fade Selected Effect Timeout", pidLow: 0x0001, pidHigh: 0x0091, unit: 'enum', displayMin: 0, displayMax: 10, enumValues: { 0: 'Off', 1: '1 Second', 2: '2 Seconds', 3: '3 Seconds', 4: '4 Seconds', 5: '5 Seconds', 6: '6 Seconds', 7: '7 Seconds', 8: '8 Seconds', 9: '9 Seconds', 10: '10 Seconds' } },
  // confirmed 2026-06-05
  'global.presshold_mode': { block: 'global', name: 'presshold_mode', displayLabel: "Press & Hold Mode", pidLow: 0x0001, pidHigh: 0x0092, unit: 'enum', displayMin: 0, displayMax: 2, enumValues: { 0: 'Disabled', 1: 'Gig Mode', 2: 'Custom Mode' } },
  // confirmed 2026-06-05
  'global.tap_amp_fx_mode': { block: 'global', name: 'tap_amp_fx_mode', displayLabel: "Tap Amp in FX Mode", pidLow: 0x0001, pidHigh: 0x0093, unit: 'enum', displayMin: 0, displayMax: 2, enumValues: { 0: 'Nothing', 1: 'Bypass', 2: 'Boost' } },
  // confirmed 2026-06-05
  'global.tap_amp_ch_amp_mode': { block: 'global', name: 'tap_amp_ch_amp_mode', displayLabel: "Tap Current Ch. in Amp Mode", pidLow: 0x0001, pidHigh: 0x0094, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Nothing', 1: 'Boost' } },
  // confirmed 2026-06-05: device shows "ACTIVE"/"BYPASSED" (not "ON"/"OFF")
  'global.cabinetbyp': { block: 'global', name: 'cabinetbyp', displayLabel: "Cab Modeling", pidLow: 0x0001, pidHigh: 0x0095, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Active', 1: 'Bypassed' } },
  // confirmed 2026-06-05
  'global.pwrampbyp': { block: 'global', name: 'pwrampbyp', displayLabel: "Power Amp Modeling", pidLow: 0x0001, pidHigh: 0x0096, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'On', 1: 'Off' } },
  // confirmed 2026-06-05: index 0 = Default (manual); indices 1-8 confirmed on hardware;
  // more entries likely exist beyond index 8 (full list not swept)
  'global.sprk_model': { block: 'global', name: 'sprk_model', displayLabel: "Speaker Imp. Curve", pidLow: 0x0001, pidHigh: 0x0097, unit: 'enum', displayMin: 0, displayMax: 127, enumValues: { 0: 'Default', 1: 'Resistive Load', 2: '1x8 5F1 Tweed', 3: '1x10 Princeton NR', 4: '1x10 BF Princeton', 5: '1x10 SF Princeton', 6: '1x12 Tweed Emmi', 7: '1x12 Vibrato Lux', 8: '1x12 Deluxe Verb' } },
  'global.amp_chan_cc': { block: 'global', name: 'amp_chan_cc', displayLabel: "Amp Channel", pidLow: 0x0001, pidHigh: 0x0098, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.out_boost_cc': { block: 'global', name: 'out_boost_cc', displayLabel: "Amp Out Boost", pidLow: 0x0001, pidHigh: 0x0099, unit: 'count', displayMin: 0, displayMax: 127 },
  // confirmed 2026-06-05: OFF + Chan 1..16 + Omni
  'global.scenesync_ch': { block: 'global', name: 'scenesync_ch', displayLabel: "Scene Sync Channel", pidLow: 0x0001, pidHigh: 0x009c, unit: 'enum', displayMin: 0, displayMax: 17, enumValues: { 0: 'Off', 1: 'Chan 1', 2: 'Chan 2', 3: 'Chan 3', 4: 'Chan 4', 5: 'Chan 5', 6: 'Chan 6', 7: 'Chan 7', 8: 'Chan 8', 9: 'Chan 9', 10: 'Chan 10', 11: 'Chan 11', 12: 'Chan 12', 13: 'Chan 13', 14: 'Chan 14', 15: 'Chan 15', 16: 'Chan 16', 17: 'Omni' } },
  'global.scenesync_cc': { block: 'global', name: 'scenesync_cc', displayLabel: "Scene Sync CC#", pidLow: 0x0001, pidHigh: 0x009d, unit: 'count', displayMin: 0, displayMax: 127 },
  // front panel label is "DynaCab Auto-Match" under Amp Expert > Speaker > IMPEDANCE section
  // (not in Setup menu). Global default; per-preset behavior may differ.
  'global.dynacab_sync': { block: 'global', name: 'dynacab_sync', displayLabel: "DynaCab Auto-Match", pidLow: 0x0001, pidHigh: 0x009e, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Off', 1: 'On' } },
  'global.amp1_vol_cc': { block: 'global', name: 'amp1_vol_cc', displayLabel: "Amp Block Out Vol", pidLow: 0x0001, pidHigh: 0x009f, unit: 'count', displayMin: 0, displayMax: 127 },
  // safe placeholder (range unverified) — Ghidra catalog entry only
  'global.metronome': { block: 'global', name: 'metronome', displayLabel: "Metronome", pidLow: 0x0001, pidHigh: 0x00a0, unit: 'count', displayMin: 0, displayMax: 127 },
  'global.metronome_cc': { block: 'global', name: 'metronome_cc', displayLabel: "Metronome", pidLow: 0x0001, pidHigh: 0x00a1, unit: 'count', displayMin: 0, displayMax: 127 },
  // confirmed 2026-06-05: only visible when Input Source = SPDIF
  'global.inspdif_config': { block: 'global', name: 'inspdif_config', displayLabel: "SPDIF Input Mode", pidLow: 0x0001, pidHigh: 0x00a2, unit: 'enum', displayMin: 0, displayMax: 3, enumValues: { 0: 'Stereo', 1: 'Left Only', 2: 'Right Only', 3: 'Sum L+R' } },

  // ============================================================
  // 2026-05-17  closeout — wires the
  // remaining placeable-family entries the AM4-Edit XML exposes
  // but params.ts didn't carry. Catalog symbols sourced from
  // `samples/captured/decoded/ghidra-am4-paramnames.json`,
  // display labels from `__block_layout.xml` /
  // `__block_layout_expert.xml` (mined by
  // `scripts/_research/list-ui-missing.ts`).
  //
  // UI widgets (paramId >= 65000 — name/label/button/graph/menu
  // sentinels) intentionally skipped: those addresses back UI
  // chrome in AM4-Edit, not writable preset data. Catalog symbols
  // dropped: CABINET_NAME{1,2}, CABINET_LABEL{1,2},
  // CABINET_ALIGN_*, CABINET_COPY_MENU{1,2}, DISTORT_ZEROEQ.
  //
  // Unit/range pairs are name-inferred. Toggle-style switches
  // (*_SW / *_ONOFF) get enum 0..1 with OFF/ON. Type/menu/color
  // enums without captured enum tables default to count 0..127 so
  // the agent can write any in-range value without claiming an
  // interpretation. Knob-style names (Sag / Breakup / Compensation
  // / Pres. Shift) get knob_0_10 — a reasonable convention for the
  // amp Extras / Speaker pages until HW captures pin exact ranges.

  // ---- CABINET (pidLow=0x003e) — 4 entries ----
  'amp.cab_proximity_2': {
    block: 'amp', name: 'cab_proximity_2',
    displayLabel: 'Proximity',
    pidLow: 0x003e, pidHigh: 0x0015,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // confirmed 2026-06-05: zooms the IR graph display in AM4-Edit — display-only, no audio effect
  'amp.cab_zoom':              { block: 'amp', name: 'cab_zoom', displayLabel: "Cab IR Graph Zoom", pidLow: 0x003e, pidHigh: 0x0021, unit: 'enum',       displayMin: 0,   displayMax: 1, enumValues: { 0: 'Normal', 1: 'Zoomed Out' } },
  'amp.cab_dynacab_z_1':       { block: 'amp', name: 'cab_dynacab_z_1',       displayLabel: 'Distance', pidLow: 0x003e, pidHigh: 0x0047, unit: 'percent',     displayMin: 0,   displayMax: 100 },
  'amp.cab_dynacab_z_2':       { block: 'amp', name: 'cab_dynacab_z_2',       displayLabel: 'Distance', pidLow: 0x003e, pidHigh: 0x0048, unit: 'percent',     displayMin: 0,   displayMax: 100 },

  // ---- DISTORT / amp Extras + Speaker pages (pidLow=0x003a) — 18 entries ----
  'amp.in_boost_sw':           { block: 'amp', name: 'in_boost_sw',           displayLabel: 'In Boost Sw',           pidLow: 0x003a, pidHigh: 0x002f, unit: 'enum',  displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'amp.saturation_sw': {
    block: 'amp', name: 'saturation_sw',
    displayLabel: 'Saturation Sw',
    pidLow: 0x003a, pidHigh: 0x003d,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OFF', 1: 'ON', 2: 'ON (IDEAL)' },
  },
  // DROPDOWN (editorControlLabels DISTORT_PRETUBETYPE = dropdownExpert).
  // enumValues HARDWARE-SWEPT 2026-05-31 (FW 2.00): wire order = the DEVICE
  // front-panel knob order (clockwise from start = index 0), which differs from
  // the AM4-Edit dropdown's display order. Labels are the full catalog forms.
  'amp.preamp_tube_type':      { block: 'amp', name: 'preamp_tube_type',      displayLabel: 'Preamp Tube Type',      pidLow: 0x003a, pidHigh: 0x004c, unit: 'enum', displayMin: 0, displayMax: 8, enumValues: { 0: '12AX7A Syl', 1: 'ECC83', 2: '7025', 3: '12AX7A JJ', 4: 'ECC803S', 5: 'EF86', 6: '12AX7A RCA', 7: '12AX7A', 8: '12AX7B' } },
  // POWER TUBE TYPE (Power Amp page, "Power Tubes" section) — a NEW register
  // discovered 2026-05-31 at pidHigh 0x4b (adjacent to preamp_tube_type 0x4c),
  // distinct from "Power Type" (AC/DC, 0x5d) and "Tubes" (0x95). Hardware-swept:
  // device knob order = wire order; index 25 = TRANSISTOR confirmed by parking
  // it there and reading raw 0x4b = 25. Amp-gated (visible on e.g. Double Verb
  // Vibrato). A common amp-upgrade lever, so worth surfacing as a named enum.
  'amp.power_tube_type':       { block: 'amp', name: 'power_tube_type',       displayLabel: 'Power Tube Type',       pidLow: 0x003a, pidHigh: 0x004b, unit: 'enum', displayMin: 0, displayMax: 25, enumValues: { 0: '5881', 1: '6L6GB', 2: 'EL34 MULL', 3: 'EL84/6BQ5', 4: '6L6GC GE', 5: '6V6GT GE', 6: 'KT66 GEN', 7: 'KT88 GEN', 8: '6550 SVET', 9: '6973', 10: '6AQ5', 11: '300B', 12: 'KT77 JJ', 13: '6CA7 JJ', 14: '6L6GC JJ', 15: 'EL34 JJ', 16: 'EL84 JJ', 17: 'KT66 JJ', 18: 'KT88 JJ', 19: '6CA7 AMP', 20: 'EL34 SVET', 21: '6L6GC SVET', 22: '6V6GT TUNG', 23: 'EL84 MULL', 24: '6550 TUNG', 25: 'TRANSISTOR' } },
  // "Power Type" (rectifier AC/DC), amp-gated (visible on e.g. FAS Modern, not
  // all amps). HARDWARE-SWEPT 2026-05-31: index 1 confirmed = DC (set on device,
  // read back 0x005d). Distinct from "Power Tube Type" (the 5881/6L6/EL34 list,
  // a separate register).
  'amp.power_type':            { block: 'amp', name: 'power_type',            displayLabel: 'Power Type',            pidLow: 0x003a, pidHigh: 0x005d, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'AC', 1: 'DC' } },
  'amp.preamp_sag': {
    block: 'amp', name: 'preamp_sag',
    displayLabel: 'Preamp Sag',
    pidLow: 0x003a, pidHigh: 0x0067,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  // DROPDOWN (editorControlLabels DISTORT_INEQTYPE = dropdownExpert), the amp
  // Input EQ "Type". enumValues HARDWARE-SWEPT 2026-05-31 (device front-panel
  // knob order = wire order; differs from the AM4-Edit dropdown order).
  'amp.in_eq_type':            { block: 'amp', name: 'in_eq_type',            displayLabel: 'Type',                  pidLow: 0x003a, pidHigh: 0x006d, unit: 'enum', displayMin: 0, displayMax: 3, enumValues: { 0: 'LOWSHELF', 1: 'PEAKING', 2: 'HIGHSHELF', 3: 'TILT EQ' } },
  'amp.pres_shift': {
    block: 'amp', name: 'pres_shift',
    displayLabel: 'Pres. Shift',
    pidLow: 0x003a, pidHigh: 0x006f,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  // eq_location = the GRAPHIC-EQ location (distinct from the Tonestack
  // "Location"). HARDWARE-SWEPT 2026-05-31 (device knob order = wire order).
  'amp.eq_location':           { block: 'amp', name: 'eq_location',           displayLabel: 'Location',              pidLow: 0x003a, pidHigh: 0x0075, unit: 'enum', displayMin: 0, displayMax: 2, enumValues: { 0: 'OUTPUT', 1: 'PRE P.A.', 2: 'INPUT' } },
  // in_boost_type HARDWARE-SWEPT 2026-05-31 (device knob order = wire order).
  'amp.in_boost_type':         { block: 'amp', name: 'in_boost_type',         displayLabel: 'In Boost Type',         pidLow: 0x003a, pidHigh: 0x0082, unit: 'enum', displayMin: 0, displayMax: 14, enumValues: { 0: 'NEUTRAL', 1: 'T808', 2: 'T808 MOD', 3: 'SUPER OD', 4: 'FULL OD', 5: 'AC BOOST', 6: 'SHIMMER', 7: 'FAS BOOST', 8: 'GRINDER', 9: 'TREBLE BOOST', 10: 'MID BOOST', 11: 'CC BOOST', 12: 'SHRED BOOST', 13: 'RCB BOOST', 14: 'JP IIC+ SHRED' } },
  'amp.eq_onoff':              { block: 'amp', name: 'eq_onoff',              displayLabel: 'Off / On',              pidLow: 0x003a, pidHigh: 0x0085, unit: 'enum',  displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'amp.spkr_imp_curve': {
    block: 'amp', name: 'spkr_imp_curve',
    displayLabel: 'Spkr Imp. Curve',
    pidLow: 0x003a, pidHigh: 0x0087,
    unit: 'enum', displayMin: 0, displayMax: 92,
    enumValues: {
      0: 'Resistive Load', 1: '1x8 5F1 Tweed', 2: '1x10 Princetone NR', 3: '1x10 BF Princetone',
      4: '1x10 SF Princetone', 5: '1x12 Tweed Emmi', 6: '1x12 Vibrato Lux', 7: '1x12 Deluxe Verb',
      8: '1x12 Deluxe Verb RI', 9: '1x12 JR Blues', 10: '1x12 Brit G12H55', 11: '1x12 Brit G12H75',
      12: '1x12 Div13 CJ11', 13: '1x12 Brit G12T', 14: '1x12 V30', 15: '1x12 AC-20 DLX',
      16: '1x12 Car Ambler', 17: '1x12 AST BV25', 18: '1x15 Vibrato Verb', 19: '1x15 Portabass',
      20: '2x10 Super', 21: '2x10 Vibrato Lux', 22: '2x12 Bassguy', 23: '2x12 Double Verb',
      24: '2x12 Double Verb SF', 25: '1x12 Class-A 15W', 26: '2x12 Class-A 30W',
      27: '2x12 TX Star', 28: '2x12 Match Chief', 29: '1x12 Hot Kitty', 30: '2x12 Jazz 120',
      31: '4x10 Bassguy', 32: '4x10 Brit JM45', 33: '4x10 Super Verb', 34: '4x10 SV Bass',
      35: '4x12 Brit TV', 36: '4x12 Brit Greenback', 37: '4x12 Basketweave', 38: '4x12 Brit 800',
      39: '4x12 Brit AX', 40: '4x12 Hipower', 41: '4x12 USA MC90', 42: '4x12 Recto Large',
      43: '4x12 Recto Small', 44: '4x12 Recto Slant', 45: '4x12 Recto Straight', 46: '4x12 5153',
      47: '4x12 Citrus', 48: '4x12 Rumble', 49: '2x12 Lead 80', 50: '4x12 Solo 100',
      51: 'Load Box LB-2 UK', 52: 'Load Box LB-2 US', 53: '4x12 Friedman', 54: '2x12 Bassbuster',
      55: '1x12 Tweed Alnico Blue', 56: '4x12 PVH 6160', 57: '4x12 Euro', 58: '2x12 Recto',
      59: '2x12 Godzilla', 60: '1x12 Tweed C12Q', 61: '1x12 Dirty Shirley EV12L',
      62: '1x12 USA Ext EV12L', 63: '2x12 Band Commander SRO', 64: '2x12 Guy Tron Alnico Blue',
      65: '1x12 G12T-75', 66: '2x12 Class-A Greenback', 67: '2x12 Two Stone 1265',
      68: '4x12 Lerxst Omega', 69: '1x12 Deluxe Oxford', 70: '4x12 Hipower Pete T',
      71: '4x12 USA Semi-Open', 72: '2x12 Dizzy RV', 73: '4x12 Hipower Lindsey B',
      74: '4x12 London Town Tall', 75: 'Oxbow Loadbox', 76: 'Double Notes Loadbox',
      77: '1x10 Metro Blues', 78: '4x10 Bassguy RI', 79: '2x12 Class-A 30W Silver',
      80: '2x10 Heart Key', 81: '4x12 1960BV', 82: '1x12 Deluxe Tweed', 83: '1x15 Heart Key',
      84: '2x12 USA C90 Open Back', 85: '1x12 Friedman', 86: '2x12 5153 Stealth',
      87: '4x12 5153 Stealth', 88: '1x12 Scholz', 89: '1x8 Princetone', 90: '1x12 Black Magick',
      91: '8x10 SV Bass', 92: 'Suhr Reactive Load',
    },
  },
  'amp.power_amp_modeling':    { block: 'amp', name: 'power_amp_modeling',    displayLabel: 'Power Amp Modeling',    pidLow: 0x003a, pidHigh: 0x008d, unit: 'enum',  displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'amp.spkr_breakup': {
    block: 'amp', name: 'spkr_breakup',
    displayLabel: 'Breakup',
    pidLow: 0x003a, pidHigh: 0x008e,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'SOFT', 1: 'MEDIUM', 2: 'HARD' },
  },
  // confirmed 2026-06-05: front panel "Plate Suppression Diodes" under Power Tubes section
  'amp.plate_suppr_diodes':    { block: 'amp', name: 'plate_suppr_diodes',    displayLabel: 'Plate Suppression Diodes', pidLow: 0x003a, pidHigh: 0x0090, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'Off', 1: 'On' } },
  'amp.dynamatch':             { block: 'amp', name: 'dynamatch',             displayLabel: 'DynaMatch',             pidLow: 0x003a, pidHigh: 0x0092, unit: 'enum',  displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'amp.nfb_compensation': {
    block: 'amp', name: 'nfb_compensation',
    displayLabel: 'NFB Compensation',
    pidLow: 0x003a, pidHigh: 0x0093,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'amp.mid_gain_boost': {
    block: 'amp', name: 'mid_gain_boost',
    displayLabel: 'Mid/Gain Boost',
    pidLow: 0x003a, pidHigh: 0x0094,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'mode 1', 1: 'mode 2', 2: 'mode 3', 3: 'mode 4' },
  },
  'amp.tubes': {
    block: 'amp', name: 'tubes',
    displayLabel: 'Tubes',
    pidLow: 0x003a, pidHigh: 0x0095,
    unit: 'count', displayMin: 0, displayMax: 3,
  },

  // ---- PATCH (pidLow=0x00ce) — 29 entries ----
  // Channel A/B/C/D LED color pickers. Live on the PATCH register family
  // (pidLow=0x00CE) but exposed under block:'amp' because AM4-Edit places
  // them on the Amp > Expert page (Knob C on the Amp Type page). Agents
  // reach for 'amp.channel_a_color' not 'preset.channel_a_color'.
  //
  // Enum table confirmed 2026-06-05 via hardware probe (probe-am4-channel-color.ts)
  // + device front-panel scroll on Amp Type page: 7 colors in wire-index order.
  // Wire value is float32(index), same encoding as other PATCH-family enums.
  'amp.channel_a_color':       { block: 'amp', name: 'channel_a_color',       displayLabel: 'Channel A LED Color', pidLow: 0x00ce, pidHigh: 0x0071, unit: 'enum', displayMin: 0, displayMax: 6, enumValues: { 0: 'Red', 1: 'Orange', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Purple' } },
  'amp.channel_b_color':       { block: 'amp', name: 'channel_b_color',       displayLabel: 'Channel B LED Color', pidLow: 0x00ce, pidHigh: 0x0072, unit: 'enum', displayMin: 0, displayMax: 6, enumValues: { 0: 'Red', 1: 'Orange', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Purple' } },
  'amp.channel_c_color':       { block: 'amp', name: 'channel_c_color',       displayLabel: 'Channel C LED Color', pidLow: 0x00ce, pidHigh: 0x0073, unit: 'enum', displayMin: 0, displayMax: 6, enumValues: { 0: 'Red', 1: 'Orange', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Purple' } },
  'amp.channel_d_color':       { block: 'amp', name: 'channel_d_color',       displayLabel: 'Channel D LED Color', pidLow: 0x00ce, pidHigh: 0x0074, unit: 'enum', displayMin: 0, displayMax: 6, enumValues: { 0: 'Red', 1: 'Orange', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Purple' } },

  // Scene MIDI EXEC slots (paramId 118..137 — 4 + 16 = 20).
  // XML labels are empty for these — they're PATCH-page editor
  // infrastructure. Catalog still lists them as writable params,
  // so we ship them as count placeholders for programmatic access
  // (copy/clear/inspect scene-MIDI command state from a script).
  // Naming mirrors the existing preset.scene_N_midi_M_{type,
  // channel,value} pattern shipping at pidHigh 0x40..0x67.
  'preset.scene_1_midi_exec':  { block: 'preset', name: 'scene_1_midi_exec',  pidLow: 0x00ce, pidHigh: 0x0076, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_exec':  { block: 'preset', name: 'scene_2_midi_exec',  pidLow: 0x00ce, pidHigh: 0x0077, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_exec':  { block: 'preset', name: 'scene_3_midi_exec',  pidLow: 0x00ce, pidHigh: 0x0078, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_exec':  { block: 'preset', name: 'scene_4_midi_exec',  pidLow: 0x00ce, pidHigh: 0x0079, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_1_midi_exec_1':{ block: 'preset', name: 'scene_1_midi_exec_1',pidLow: 0x00ce, pidHigh: 0x007a, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_1_midi_exec_2':{ block: 'preset', name: 'scene_1_midi_exec_2',pidLow: 0x00ce, pidHigh: 0x007b, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_1_midi_exec_3':{ block: 'preset', name: 'scene_1_midi_exec_3',pidLow: 0x00ce, pidHigh: 0x007c, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_1_midi_exec_4':{ block: 'preset', name: 'scene_1_midi_exec_4',pidLow: 0x00ce, pidHigh: 0x007d, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_exec_1':{ block: 'preset', name: 'scene_2_midi_exec_1',pidLow: 0x00ce, pidHigh: 0x007e, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_exec_2':{ block: 'preset', name: 'scene_2_midi_exec_2',pidLow: 0x00ce, pidHigh: 0x007f, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_exec_3':{ block: 'preset', name: 'scene_2_midi_exec_3',pidLow: 0x00ce, pidHigh: 0x0080, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_midi_exec_4':{ block: 'preset', name: 'scene_2_midi_exec_4',pidLow: 0x00ce, pidHigh: 0x0081, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_exec_1':{ block: 'preset', name: 'scene_3_midi_exec_1',pidLow: 0x00ce, pidHigh: 0x0082, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_exec_2':{ block: 'preset', name: 'scene_3_midi_exec_2',pidLow: 0x00ce, pidHigh: 0x0083, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_exec_3':{ block: 'preset', name: 'scene_3_midi_exec_3',pidLow: 0x00ce, pidHigh: 0x0084, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_midi_exec_4':{ block: 'preset', name: 'scene_3_midi_exec_4',pidLow: 0x00ce, pidHigh: 0x0085, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_exec_1':{ block: 'preset', name: 'scene_4_midi_exec_1',pidLow: 0x00ce, pidHigh: 0x0086, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_exec_2':{ block: 'preset', name: 'scene_4_midi_exec_2',pidLow: 0x00ce, pidHigh: 0x0087, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_exec_3':{ block: 'preset', name: 'scene_4_midi_exec_3',pidLow: 0x00ce, pidHigh: 0x0088, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_midi_exec_4':{ block: 'preset', name: 'scene_4_midi_exec_4',pidLow: 0x00ce, pidHigh: 0x0089, unit: 'count', displayMin: 0, displayMax: 127 },

  // Per-scene MIDI menu trigger + clear-all action.
  'preset.scene_1_menu':       { block: 'preset', name: 'scene_1_menu',       displayLabel: 'SCENE 1 menu', pidLow: 0x00ce, pidHigh: 0x008a, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_2_menu':       { block: 'preset', name: 'scene_2_menu',       displayLabel: 'SCENE 2 menu', pidLow: 0x00ce, pidHigh: 0x008b, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_3_menu':       { block: 'preset', name: 'scene_3_menu',       displayLabel: 'SCENE 3 menu', pidLow: 0x00ce, pidHigh: 0x008c, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.scene_4_menu':       { block: 'preset', name: 'scene_4_menu',       displayLabel: 'SCENE 4 menu', pidLow: 0x00ce, pidHigh: 0x008d, unit: 'count', displayMin: 0, displayMax: 127 },
  'preset.clear_all':          { block: 'preset', name: 'clear_all',          displayLabel: 'Clear All',    pidLow: 0x00ce, pidHigh: 0x008e, unit: 'count', displayMin: 0, displayMax: 127 },

  // ============================================================
  // 2026-05-18  residual closeout — wires the
  // 15 remaining placeable-family entries the AM4-Edit XML exposes
  // but params.ts didn't carry. Catalog symbols sourced from
  // `samples/captured/decoded/ghidra-am4-paramnames.json`,
  // display labels from `__block_layout.xml` /
  // `__block_layout_expert.xml` (mined by
  // `scripts/_research/list-ui-missing.ts`).
  //
  // UI widgets (paramId >= 65000 or empty XML label — meter/name/
  // label/button/graph/menu sentinels) intentionally skipped: those
  // addresses back UI chrome in AM4-Edit, not writable preset data.
  // Catalog symbols dropped this pass: CABINET_NAME{1,2},
  // CABINET_LABEL{1,2}, CABINET_ALIGN_*, CABINET_COPY_MENU{1,2},
  // GEQ_ZEROEQ, INPUT_METERS, VOLUME_METER, DISTORT_ZEROEQ.
  //
  // Unit/range conventions mirror commit b67e23f:
  // toggle-style switches → enum 0..1 OFF/ON; type/menu enums
  // without captured tables → count 0..127; read-only meters
  // → knob_0_10. Slope params follow the FLANGER convention
  // (count 1..12) since no capture pins enum vs count yet.

  // ---- PEQ (pidLow=0x0036) — 2 entries ----
  // PEQ_LOWSLOPE / PEQ_HIGHSLOPE address the shelf-channel slope on
  // channel 1 (low shelf) and channel 5 (high shelf). XML labels
  // "Slope 1" / "Slope 5"; name follows the existing channel_N_*
  // family-prefix pattern (channel_1_frequency, channel_5_q, etc.).
  'peq.channel_1_slope':       { block: 'peq', name: 'channel_1_slope',       displayLabel: 'Slope 1',           pidLow: 0x0036, pidHigh: 0x0023, unit: 'count', displayMin: 1, displayMax: 12 },
  'peq.channel_5_slope':       { block: 'peq', name: 'channel_5_slope',       displayLabel: 'Slope 5',           pidLow: 0x0036, pidHigh: 0x0024, unit: 'count', displayMin: 1, displayMax: 12 },

  // ---- COMP (pidLow=0x002e) — 4 entries ----
  // gain_monitor is a read-only meter — `gain` collides with the
  // existing compressor knob; the _monitor suffix matches the AMP
  // family's b_plus_monitor / gain_monitor / headroom_monitor
  // convention.
  // knee_type / detector_type are DROPDOWNS (editorControlLabels COMP_KNEE /
  // COMP_PEAKRMS = dropdown1), not numeric counts. Mis-registered as unit:'count',
  // so get_preset decoded the small enum INDEX through the count scale
  // ((wire/65534)*127 → ~0.00193 at index 1). unit:'enum' fixes that.
  // enumValues HARDWARE-SWEPT 2026-05-31 (FW 2.00): wire order = the DEVICE
  // front-panel knob order (clockwise from start = index 0), which is NOT the
  // AM4-Edit dropdown display order (the editor re-sorts; e.g. knee swaps
  // MEDIUM/MED-SOFT vs the dropdown, detector is fully reordered). The AM4
  // echoes no label over MIDI, so this was captured by set-index + read the
  // device front panel per step (probe-am4-enum-sweep.ts). See
  // docs/RE-WORKFLOW.md + cookbook _negative/am4-edit-dropdown-order-not-wire-order.
  'compressor.knee_type':            { block: 'compressor', name: 'knee_type',            displayLabel: 'Knee Type',         pidLow: 0x002e, pidHigh: 0x000e, unit: 'enum', displayMin: 0, displayMax: 4, enumValues: { 0: 'HARD', 1: 'MED-HARD', 2: 'MEDIUM', 3: 'MED-SOFT', 4: 'SOFT' } },
  'compressor.detector_type':        { block: 'compressor', name: 'detector_type',        displayLabel: 'Detector Type',     pidLow: 0x002e, pidHigh: 0x0010, unit: 'enum', displayMin: 0, displayMax: 3, enumValues: { 0: 'RMS', 1: 'PEAK', 2: 'RMS + PEAK', 3: 'HALF-WAVE' } },
  'compressor.auto_attack_release':  { block: 'compressor', name: 'auto_attack_release',  displayLabel: 'Auto Att/Rel',      pidLow: 0x002e, pidHigh: 0x0016, unit: 'enum',  displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },
  'compressor.gain_monitor':         { block: 'compressor', name: 'gain_monitor',         displayLabel: 'Gain',              pidLow: 0x002e, pidHigh: 0x001f, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },

  // ---- GATE (pidLow=0x0092) — 1 entry ----
  'gate.gain_monitor':         { block: 'gate', name: 'gain_monitor',         displayLabel: 'Gain',              pidLow: 0x0092, pidHigh: 0x0012, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },

  // ---- INPUT / ingate (pidLow=0x0025) — 4 entries ----
  // The input-noise-gate block carries hidden compressor-style
  // controls (Ratio / Attack / Z / GainMonitor) the AM4-Edit Setup
  // page exposes but params.ts hadn't registered. INPUT_METERS
  // (paramId 65520) skipped as a UI widget.
  'ingate.ratio':              { block: 'ingate', name: 'ratio',              displayLabel: 'Ratio',             pidLow: 0x0025, pidHigh: 0x000b, unit: 'ratio', displayMin: 1, displayMax: 10, scaling: 'log10' },
  'ingate.attack':             { block: 'ingate', name: 'attack',             displayLabel: 'Attack',            pidLow: 0x0025, pidHigh: 0x000d, unit: 'ms',    displayMin: 0, displayMax: 1000 },
  'ingate.input_impedance':    { block: 'ingate', name: 'input_impedance',    displayLabel: 'Input Impedance',   pidLow: 0x0025, pidHigh: 0x000e, unit: 'count', displayMin: 0, displayMax: 127 },
  'ingate.gain_monitor':       { block: 'ingate', name: 'gain_monitor',       displayLabel: 'Gain',              pidLow: 0x0025, pidHigh: 0x0010, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },

  // ---- CHORUS (pidLow=0x004e) — 1 entry ----
  // Stereo "Tempo Right" companion to chorus.tempo (CHORUS_TEMPO).
  // Same TEMPO_DIVISIONS_VALUES enum since the right-channel tempo
  // ladder mirrors the master one.
  'chorus.tempo_right':        { block: 'chorus', name: 'tempo_right',        displayLabel: 'Tempo Right',       pidLow: 0x004e, pidHigh: 0x001f, unit: 'enum',  displayMin: 0, displayMax: 78, enumValues: TEMPO_DIVISIONS_VALUES },

  // ---- TREMOLO (pidLow=0x006a) — 2 entries ----
  // trigger_phase is the LFO start-phase on retrigger; degrees
  // convention matches tremolo.phase (capture-verified
  // 0..180 deg). crossover_slope follows the FLANGER count 1..12
  // pattern pending range capture.
  'tremolo.trigger_phase':     { block: 'tremolo', name: 'trigger_phase',     displayLabel: 'Trigger Phase',     pidLow: 0x006a, pidHigh: 0x0013, unit: 'degrees', displayMin: 0, displayMax: 180 },
  'tremolo.crossover_slope':   { block: 'tremolo', name: 'crossover_slope',   displayLabel: 'Crossover Slope',   pidLow: 0x006a, pidHigh: 0x0014, unit: 'count',   displayMin: 1, displayMax: 12 },

  // ---- ENHANCER (pidLow=0x007a) — 1 entry ----
  // OFF/ON enum mirrors filter.phase_invert (same XML "Phase Invert"
  // label, same shape).
  'enhancer.phase_invert':     { block: 'enhancer', name: 'phase_invert',     displayLabel: 'Phase Invert',      pidLow: 0x007a, pidHigh: 0x000f, unit: 'enum', displayMin: 0, displayMax: 1, enumValues: { 0: 'OFF', 1: 'ON' } },

  // ============================================================
  // 2026-05-18 — REMOVED 15 speculative III-
  // inherited entries that +4 had wired (DISTORT
  // TONETYPE/EXCURSIONTIME/RECOVERYTIME/CFGRID/DYNPRES/DYNDEPTH/
  // TREMFREQ/TREMDEPTH/BIASTYPE/INDYNAMICS/PRECOMPTYPE/CFHARDNESS/
  // DRIVETYPE/FBTYPE + COMP_LIGHTTYPE).
  //
  // Comprehensive scan of `__block_layout_expert.xml` (all 141
  // unique DISTORT_/COMP_ parameterNames across every conditional
  // Table for every amp type variant) confirmed: zero of the 29
  // catalog-only candidate symbols appear anywhere in AM4-Edit's
  // expert XML. The 15 had been wired from III `__amp_layout.xml`
  // labels — those don't apply to AM4.
  //
  // The 29 remain as GHOST in the cross-ref audit (catalog symbol,
  // no AM4 XML). If a future  capture surfaces any of them
  // on the AM4 front-panel Expert Edit menu, they'll be re-added
  // here with HARDWARE-VERIFIED labels (not III speculation).
  //
  // Coverage shift back to honest values:
  //   - WIRED-MATCHED 609 -> 594, GHOST 34 -> 49
  //   - AM4-Edit XML rendered controls: 100% wired (was already 100%
  //     before — the 15 added were not part of
  //     the rendered surface)
  //   - coverage-audit.ts headline becomes meaningful: every wired
  //     entry corresponds to a control the user can see in AM4-Edit.

} as const satisfies Record<string, Param>;

export type ParamKey = keyof typeof KNOWN_PARAMS;
