/**
 * Cross-device param-kind resolver.
 *
 * One source of truth for "what kind of knob is this and how do we
 * translate display values to/from wire integers." Every device-side
 * call site (writer.setParam display reverse-coercion, reader.getParam
 * forward coercion, schema encode/decode closure builders, apply-path
 * pre-encode in applyExecutor) consults this helper instead of
 * re-implementing the catalog-first / overlay-second / suffix-rule
 * fallback ladder.
 *
 * Architecture:
 *
 *   - The helper is a registry: each device package registers a
 *     resolver function at module load via `registerParamKindResolver`.
 *     The registry is keyed by `descriptor.id` ('axe-fx-ii', 'am4',
 *     'hydrasynth', 'axe-fx-iii') so per-device wire encoding stays
 *     in the device package (where it belongs) and the core protocol
 *     layer never imports device-specific codecs.
 *
 *   - `resolveParamKind(deviceId, block, name)` looks up the resolver
 *     for `deviceId` and delegates. When no resolver is registered the
 *     helper returns `{ unit: 'opaque', source: 'unknown' }` so callers
 *     can treat the param as wire pass-through without a special case.
 *
 *   - `ResolvedParamKind` carries optional `encodeDisplay` / `decodeWire`
 *     closures (round-trip-safe within float rounding) and the lineage
 *     of the calibration (`codec_catalog`, `overlay`, `suffix_rule`,
 *     `unknown`). Consumers pick whichever pieces they need: schema
 *     builders use the closures, unit classifiers use `unit`, audit
 *     scripts use `source`.
 *
 * The registry-of-resolvers approach was chosen over importing every
 * device package into core because:
 *
 *   1. Core stays device-agnostic (no `fractal-midi` import, no
 *      hydrasynth NRPN coupling, no III community wire format).
 *   2. Device packages remain composable — adding a new device means
 *      registering a resolver at descriptor-build time, not editing
 *      core.
 *   3. The III's `unit: 'opaque'` default surface "just works" without
 *      requiring the III package to ship a resolver yet.
 */

/**
 * The classification the LLM sees in `describe_device` / `list_params`
 * output. Same vocabulary as `Unit` in `./types.ts`; restated here as
 * a closed enum because `ResolvedParamKind` callers typically want to
 * pattern-match on a small set rather than free-form string.
 */
export type ParamUnit =
  | 'knob'
  | 'db'
  | 'ms'
  | 'percent'
  | 'hz'
  | 'seconds'
  | 'enum'
  | 'bool'
  | 'count'
  | 'semitones'
  | 'ratio'
  | 'degrees'
  | 'bipolar_percent'
  | 'opaque'
  // Device-native unit words that AM4 surfaces verbatim. Listed so
  // resolvers can pass them through without re-encoding to a generic.
  | 'knob_0_10'
  | 'knob_0_20'
  | 'pf'
  | 'rotary_mic_spacing'
  | 'amp_geq_band'
  // Allow extension by string for any future device-native unit.
  | (string & {});

/**
 * Where the calibration / unit data came from. Audit scripts use this
 * to prove that any "0..10 knob" claim on the agent surface is backed
 * by either a hardware-verified codec entry, a documented overlay row,
 * or a Fractal-convention suffix rule — never plain guesswork.
 */
export type ParamKindSource =
  | 'codec_catalog'   // catalog ships displayMin/displayMax (codec layer)
  | 'overlay'         // device overlay (e.g. AM4_SHARED / EDITOR_OBSERVED)
  | 'suffix_rule'     // convention rule matched on the param name
  | 'unknown';        // no calibration anywhere — wire pass-through

export interface ResolvedParamKind {
  /** What unit shape the LLM sees on `list_params` / `describe_device`. */
  unit: ParamUnit;
  /** Display range lower bound when calibrated, else undefined. */
  displayMin?: number;
  /** Display range upper bound when calibrated, else undefined. */
  displayMax?: number;
  /**
   * When the param has a display range, this closure converts a display
   * value to the device's wire integer. Throws on out-of-range or
   * unresolvable enum input.
   *
   * Calibrated params: round-trips `encodeDisplay(decodeWire(w)) === w`
   * and `decodeWire(encodeDisplay(d)) === d` within float rounding.
   *
   * Uncalibrated params (`source: 'unknown'`): the closure is omitted;
   * callers fall back to wire pass-through (validate 0..max integer).
   */
  encodeDisplay?: (display: number | string) => number;
  /**
   * Wire integer → display value. For enum params returns the label
   * string; for switch params returns 'on' / 'off'; otherwise returns
   * the numeric display reading. Omitted when no calibration is known.
   */
  decodeWire?: (wire: number) => number | string;
  /** Provenance — where the calibration / unit came from. */
  source: ParamKindSource;
}

/**
 * Resolver contract — one function per device, registered at module
 * load. The resolver returns `undefined` when it has nothing to say
 * about `(block, name)`; the helper then emits the standard "unknown"
 * envelope. Returning a partial envelope (e.g. just `unit: 'opaque'`
 * with no closures) is also valid for devices that recognize the param
 * but don't calibrate it.
 */
export type ParamKindResolver = (
  block: string,
  name: string,
) => ResolvedParamKind | undefined;

const RESOLVERS = new Map<string, ParamKindResolver>();

/**
 * Register a per-device resolver. Devices call this once at module
 * load (typically alongside the descriptor export). Subsequent calls
 * with the same `deviceId` replace the previous resolver — useful for
 * test seams; production code registers exactly once per device.
 */
export function registerParamKindResolver(
  deviceId: string,
  resolver: ParamKindResolver,
): void {
  RESOLVERS.set(deviceId, resolver);
}

/** Audit-friendly accessor — returns true when a resolver is registered. */
export function hasParamKindResolver(deviceId: string): boolean {
  return RESOLVERS.has(deviceId);
}

/**
 * The default "we don't know this knob" envelope. Returned when no
 * resolver is registered, or when the registered resolver returns
 * undefined. Callers fall back to wire pass-through.
 */
const UNKNOWN: ResolvedParamKind = Object.freeze({
  unit: 'opaque' as const,
  source: 'unknown' as const,
});

/**
 * One source of truth for "what is this knob and how do we encode it."
 *
 * Lookup order:
 *   1. Device-specific resolver registered via
 *      `registerParamKindResolver`. Returns whatever the resolver
 *      decides (catalog / overlay / suffix / partial).
 *   2. Fallback `{ unit: 'opaque', source: 'unknown' }` when no
 *      resolver is registered or the resolver punts.
 *
 * Pure: no MIDI I/O, no side effects. Safe to call from hot paths.
 */
export function resolveParamKind(
  deviceId: string,
  block: string,
  name: string,
): ResolvedParamKind {
  const resolver = RESOLVERS.get(deviceId);
  if (resolver === undefined) return UNKNOWN;
  const result = resolver(block, name);
  return result ?? UNKNOWN;
}
