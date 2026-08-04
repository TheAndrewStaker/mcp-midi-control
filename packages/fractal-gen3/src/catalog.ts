/**
 * Modern Fractal family — per-device block roster + parameter catalog.
 *
 * `createModernCatalog` builds a device's `blocks` map + resolve helpers
 * from THREE inputs:
 *   - `blocks`          the block roster (the III's `AXE_FX_III_BLOCKS`;
 *                       effect IDs are shared across the gen-3 family per
 *                       tysonlt `AxeEffectEnum.h`, so all devices reuse it).
 *   - `paramsByFamily`  the per-family param table. THIS is device-specific:
 *                       the Axe-Fx III, FM3, and FM9 each pass their OWN
 *                       table, because paramIds are firmware-specific
 *                       ordinals (reusing the III's mis-addresses FM3 13.4%
 *                       / FM9 24% of the symbols they share with the III, see
 *                       the `_negative/gen3-paramid-reuse-across-model-bytes` primitive).
 *   - `resolveEffectId` block-name -> effect ID (shared; the III's).
 *
 * The III passes the III catalog and, with `dropEmptyMappedBlocks: false`,
 * gets byte-identical output to the pre-factory module. That invariant is
 * enforced by `scripts/verify-axe-fx-iii-identity.ts` (in preflight), which
 * snapshots the III's catalog + describe_device surface and fails on any drift.
 * FM3/FM9 pass their device-true tables + `dropEmptyMappedBlocks: true`
 * so blocks whose mapped family has zero device params (e.g. DYNDIST, absent
 * on the floor units) drop off the describe_device surface.
 */
import type {
  BlockSchema,
  ParamSchema,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import {
  type AxeFxIIIBlock,
  resolveEnumValues,
  resolveEffectTypeEnum,
  enumLabelForms,
  normalizeLabel,
} from 'fractal-midi/gen3/axe-fx-iii';
import { type Param as AxeFxIIIParam } from 'fractal-midi/gen3/axe-fx-iii';
import { displayToWire, wireToDisplay } from 'fractal-midi/shared';

export type { AxeFxIIIBlock, AxeFxIIIParam };

/** The resolved per-device catalog the factory wires into reader/writer. */
export interface ModernCatalog {
  /** `describe_device` block roster (slug -> BlockSchema). */
  blocks: Readonly<Record<string, BlockSchema>>;
  resolveBlockOrThrow(
    slug: string,
    deviceLabel: string,
    instance?: number,
  ): { block: AxeFxIIIBlock; effectId: number };
  resolveParamOrThrow(
    slug: string,
    name: string,
    deviceLabel: string,
  ): { family: string; param: AxeFxIIIParam };
  /**
   * Resolve a (block, param) and coerce a DISPLAY value to its wire integer via
   * the param's schema `encode` closure — the same closure `set_param` runs at
   * the dispatcher boundary (`encodeValue`). `apply_preset` must call this so a
   * spec value like `treble: 5.5` becomes a wire int instead of reaching
   * `packValue16` raw (which rejects non-integers). Calibrated knobs map through
   * the display range; enums resolve name→ordinal (or pass a numeric through);
   * uncalibrated params still require a raw wire int, surfacing a clear error.
   */
  encodeParamOrThrow(
    slug: string,
    name: string,
    value: number | string,
    deviceLabel: string,
  ): number;
}

// ── Block-slug ↔ catalog-family mapping ────────────────────────────
//
// AxeFxIIIBlock entries use 3-letter groupCodes (CMP, REV, DLY, etc.);
// the PARAMS catalog families are spelled-out (COMP, REVERB, DELAY).
// Keep the mapping explicit so missing entries fail loud instead of
// silently producing empty BlockSchemas.

const GROUP_TO_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  CMP: 'COMP',
  GEQ: 'GEQ',
  PEQ: 'PEQ',
  AMP: 'DISTORT',  // gen-3 amp tone-stack + power section (ID_DISTORT1=58)
  CAB: 'CABINET',
  REV: 'REVERB',
  DLY: 'DELAY',
  MTD: 'MULTITAP',
  CHO: 'CHORUS',
  FLG: 'FLANGER',
  ROT: 'ROTARY',
  PHA: 'PHASER',
  WAH: 'WAH',
  FRM: 'FORMANT',
  PTR: 'TREMOLO',
  PIT: 'PITCH',
  FIL: 'FILTER',
  FUZ: 'FUZZ',
  ENH: 'ENHANCER',
  MIX: 'MIXER',
  SYN: 'SYNTH',
  VOC: 'VOCODER',
  MGD: 'MEGATAP',
  XOV: 'CROSSOVER',
  GAT: 'GATE',
  RNG: 'RINGMOD',
  MBC: 'MULTICOMP',
  TTD: 'TENTAP',
  RES: 'RESONATOR',
  VOL: 'VOLUME',
  PLX: 'PLEX',
  SND: 'FDBKSEND',
  RTN: 'FDBKRET',
  LPR: 'LOOPER',
  TMA: 'TONEMATCH',
  RTA: 'RTA',
  MUX: 'MULTIPLEXER',
  IRP: 'IRPLAYER',
  IN: 'INPUT',
  OUT: 'OUTPUT',
  SMI: 'MIDIBLOCK',
  FC: 'FC',
  PFC: 'PRESET',
  DYD: 'DYNDIST',
  // Blocks with NO catalog family: NAM (post-v1.13 addition), CTR
  // (Controllers), TUN (Tuner), IRC (IR Capture utility), GBK (Global
  // Block), SHT (Shunt). These get empty params and set_param refuses
  // with "no params catalogued for <block>". (AMP now maps to DISTORT.)
});

export function blockSlug(b: AxeFxIIIBlock): string {
  return b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Param schema builders ──────────────────────────────────────────
//
// Display-first where the catalog carries a calibrated range. A gen-3
// param that has BOTH `displayMin` and `displayMax` (AM4 symbol-name join
// at catalog-generation time) gets encode/decode wired through the shared
// display resolver (`displayToWire` / `wireToDisplay` from
// `fractal-midi/shared`, hardware-proven on the Axe-Fx II; linear or log10)
// over the 16-bit 0..65534 field: callers pass the panel reading (0..10
// knob, dB, ms, Hz) and the wire integer is derived here. This is the same
// 16-bit-linear-wire model the II uses for both linear and log10 display
// scales.
//
// Params WITHOUT a calibrated range (most `unit: 'unverified'` entries) and
// enum params keep PASSTHROUGH encode/decode: callers move the raw 16-bit
// wire integer and the same integer reaches the wire. As FM3/FM9 ranges are
// filled in (A7 overlay), more params cross from passthrough to display-first
// automatically.

export function stripFamilyPrefix(family: string, paramName: string): string {
  const prefix = `${family}_`;
  if (paramName.startsWith(prefix)) {
    return paramName.slice(prefix.length).toLowerCase();
  }
  return paramName.toLowerCase();
}

function humanize(snake: string): string {
  return snake
    .split('_')
    .filter((s) => s.length > 0)
    .map((s) => s[0].toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

function makePassthroughEncode(family: string, paramKey: string): ParamSchema['encode'] {
  return (value: number | string): number => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(
        `${family}.${paramKey}: expected a number (raw wire 0..65534), got "${value}". ` +
          'This param has no calibrated display range; pass the 16-bit wire integer directly.',
      );
    }
    if (!Number.isInteger(num) || num < 0 || num > 65534) {
      throw new Error(
        `${family}.${paramKey} expects wire 0..65534 (uncalibrated): ${num}`,
      );
    }
    return num;
  };
}

/**
 * Discrete enum encode: resolve a NAME to its read-roster ORDINAL (the value a
 * gen-3 discrete SET carries as float32(ordinal) at pos 12). The ordinal IS the
 * set value — there is no separate raw-id space (verified 2026-06-08, FM3 +
 * FM9). Resolves against the SAME merged `enum_values` table the read leg
 * decodes with (case + word-order tolerant), so amp/drive/reverb names from the
 * shared rosters AND device-captured overrides all set by name. A number (or
 * numeric string) passes through as the ordinal directly.
 */
function makeEnumEncode(
  family: string,
  paramKey: string,
  enumValues: Readonly<Record<number, string>>,
): ParamSchema['encode'] {
  // name (normalized + word-order variants) → ordinal. Built once. Lowest
  // ordinal wins a collision so a canonical name maps deterministically.
  const reverse = new Map<string, number>();
  for (const [ordStr, label] of Object.entries(enumValues)) {
    const ord = Number(ordStr);
    for (const form of enumLabelForms(label)) {
      const existing = reverse.get(form);
      if (existing === undefined || ord < existing) reverse.set(form, ord);
    }
  }
  return (value: number | string): number => {
    const asNum = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'number' || (value.trim() !== '' && Number.isFinite(asNum))) {
      if (!Number.isInteger(asNum) || asNum < 0 || asNum > 65534) {
        throw new Error(`${family}.${paramKey} expects an ordinal 0..65534 or a type name: ${value}`);
      }
      return asNum;
    }
    let ord = reverse.get(normalizeLabel(value));
    if (ord === undefined) {
      for (const f of enumLabelForms(value)) {
        const o = reverse.get(f);
        if (o !== undefined) { ord = o; break; }
      }
    }
    if (ord !== undefined) return ord;
    throw new Error(`unknown ${paramKey} value "${value}"`);
  };
}

/**
 * Discrete ordinal encode for an enum param whose COUNT is device-true (mined
 * from the editor cache) but whose name vocabulary has not been correlated yet.
 * Accepts a numeric ordinal (or numeric string) bounded to 0..maxOrdinal and
 * refuses a name with a clear message (no vocab to resolve against). The wire
 * form is DISCRETE (float32(ordinal), sub 09 00) — the whole point of this path
 * is that a count-known enum must NOT fall through to the continuous float wire.
 */
function makeOrdinalEncode(
  family: string,
  paramKey: string,
  maxOrdinal: number,
): ParamSchema['encode'] {
  return (value: number | string): number => {
    const asNum = typeof value === 'number' ? value : Number(value);
    const isNumeric =
      typeof value === 'number' || (value.trim() !== '' && Number.isFinite(asNum));
    if (!isNumeric) {
      throw new Error(
        `${family}.${paramKey} is a discrete selector with ${maxOrdinal + 1} options but no ` +
          `name table yet; pass a numeric ordinal 0..${maxOrdinal}, not "${value}".`,
      );
    }
    if (!Number.isInteger(asNum) || asNum < 0 || asNum > maxOrdinal) {
      throw new Error(
        `${family}.${paramKey} expects an ordinal 0..${maxOrdinal}: ${value}`,
      );
    }
    return asNum;
  };
}

/** Resolved display↔wire calibration for one param, or undefined if none. */
interface CalibrationOpts {
  readonly displayMin: number;
  readonly displayMax: number;
  readonly displayScale: 'linear' | 'log10';
}

/**
 * One device-true display range row, as emitted by a device's editor-cache
 * codegen (`fractal-midi/gen3/fm9` `Fm9ParamRange`). Only the fields the catalog
 * needs are required here, so the codec package's generated type structurally
 * satisfies it without an import coupling. `displayMin`/`displayMax` are in
 * front-panel units (cache value already × scale).
 */
export interface DeviceParamRange {
  readonly kind: 'enum' | 'float';
  readonly displayMin: number;
  readonly displayMax: number;
  /**
   * Enum-kind rows only: the number of valid ordinals (0..enumCount-1), mined
   * from the device's editor cache. Lets the catalog route an enum param as
   * DISCRETE (sub 09 00, float32(ordinal)) even when no name vocabulary has
   * been correlated yet — sending it CONTINUOUS (the prior default for any
   * param the AM4/XML overlay missed) makes the device store the wrong ordinal
   * (confirmed by the FM9 full-roundtrip hardware sweep, 2026-06-18: ~49 FM9
   * type/mode selectors the overlay missed were stored wrong as continuous).
   */
  readonly enumCount?: number;
}

/** Device-true ranges keyed family → paramId → range (e.g. `FM9_RANGES`). */
export type DeviceRangeTable = Readonly<Record<string, Readonly<Record<number, DeviceParamRange>>>>;

/**
 * Decide whether a param's catalog range yields a usable display↔wire
 * calibration. Requires a finite displayMin < displayMax; for log10 scaling
 * both bounds must be positive (the II resolver throws otherwise). Returns
 * undefined for anything that can't calibrate, so the caller falls back to
 * passthrough rather than emitting a closure that throws at call time.
 *
 * Device-true precedence: when `deviceRange` is supplied (a `float` row from
 * the device's own editor cache, e.g. FM9_RANGES), its bounds OVERRIDE the
 * catalog's AM4-overlay-inferred displayMin/displayMax. The cache range is
 * the device's real front-panel range, so it corrects the ~36 FM9 float
 * params whose inherited bounds contradict the hardware (DELAY_TIME 0..8000 →
 * 1..16000, REVERB_PREDELAY 0..250 → 0..1000, etc.). Enum cache rows are NOT
 * used for calibration (discrete selectors keep their ordinal handling); we
 * fall through to the catalog range only where the cache has no float row.
 */
function resolveCalibration(
  param: AxeFxIIIParam,
  deviceRange?: DeviceParamRange,
): CalibrationOpts | undefined {
  // Cache-derived device-true range wins when present and float-kind. Round the
  // cache bounds to display precision (roundDisplay, 2 dp) so the calibrated
  // decode endpoints match the schema's reported bounds AND the 2-decimal front
  // panel: a cache displayMin like 0.3162 Hz reports and decodes as 0.32, not a
  // sub-precision value the decode (which rounds) would quantize away and fail
  // the endpoint round-trip gate against.
  let displayMin = param.displayMin;
  let displayMax = param.displayMax;
  if (deviceRange !== undefined && deviceRange.kind === 'float') {
    displayMin = roundDisplay(deviceRange.displayMin);
    displayMax = roundDisplay(deviceRange.displayMax);
  } else {
    // Catalog-inferred bounds get the SAME precision rounding as cache rows:
    // the mined tables carry float32 artifacts (III/FM3 DISTORT_TREMFREQ
    // displayMin 0.20000000298023224 = float32(0.2)), and an unrounded bound
    // makes encode REFUSE the panel's own endpoint (set_param tremfreq 0.2
    // errored "out of range [0.20000000298023224..20]"). Rounding here keeps
    // decode's endpoints, the schema's advertised bounds, and encode's range
    // check on the same 2-decimal panel grid (caught by
    // scripts/verify-display-first-fractal.ts GATE B). If rounding degrades a
    // range below usability (collapsed span, log10 bound hitting 0), the
    // checks below return undefined and the param falls back to passthrough.
    if (displayMin !== undefined) displayMin = roundDisplay(displayMin);
    if (displayMax !== undefined) displayMax = roundDisplay(displayMax);
  }
  const { scaling } = param;
  if (displayMin === undefined || displayMax === undefined) return undefined;
  if (!Number.isFinite(displayMin) || !Number.isFinite(displayMax)) return undefined;
  if (displayMin >= displayMax) return undefined;
  const displayScale: 'linear' | 'log10' = scaling === 'log10' ? 'log10' : 'linear';
  if (displayScale === 'log10' && (displayMin <= 0 || displayMax <= 0)) return undefined;
  return { displayMin, displayMax, displayScale };
}

/**
 * Round a decoded display value to the panel's natural resolution, stripping
 * the float noise the wire→display inverse leaves behind (7.0000305 → 7).
 * Mirrors the Axe-Fx II decode boundary; two decimals preserves every
 * observed panel resolution.
 */
function roundDisplay(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function makeCalibratedEncode(
  family: string,
  paramKey: string,
  cal: CalibrationOpts,
): ParamSchema['encode'] {
  return (value: number | string): number => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`${family}.${paramKey}: expected a number, got "${value}"`);
    }
    if (num < cal.displayMin || num > cal.displayMax) {
      throw new Error(
        `${family}.${paramKey} out of range [${cal.displayMin}..${cal.displayMax}]: ${num}`,
      );
    }
    return displayToWire(num, cal);
  };
}

function makeCalibratedDecode(cal: CalibrationOpts): ParamSchema['decode'] {
  return (wire: number): number => roundDisplay(wireToDisplay(wire, cal));
}

/**
 * Params whose wire REGISTER is a raw signed int16 (a native semitone count),
 * not the standard normalized-0..65534-across-range field every other
 * calibrated continuous param uses. SET already works via the standard
 * normalized-continuous wire form (`makeCalibratedEncode`) — the device's own
 * param-set microcode rescales the normalized value onto its native register
 * — only READ needs a different decode.
 *
 * Evidence: a real hardware SET->GET roundtrip across the full FM9 (fw 11.0)
 * and Axe-Fx III (fw 25.04) catalogs (issue #6, 2026-06-18). Sending the
 * normalized-continuous wire endpoints 0 / 65534 (i.e. displayMin/displayMax
 * = -24/+24 semitones) read back as raw wire 65512 / 24 — int16(65512) =
 * -24, matching the SENT value exactly, so this is a read-side decode
 * mismatch, not a wire/write bug: 65512 self-evidently ISN'T "-24 renormalized
 * to 0..65534" (that would decode to +24, the wrong sign), it's -24 as a
 * raw two's-complement int16. Every intermediate wire step in the sweep
 * (16384->-11, 49151->12) round-trips the same way. Golden:
 * `scripts/verify-fractal-gen3-family.ts#C13`. Family-wide list (same
 * firmware symbols on FM3/FM9/III, sharing one gen-3 effect codec).
 */
export const SIGNED_RAW_SEMITONE_PARAMS: ReadonlySet<string> = new Set([
  'PITCH_SHIFT1', 'PITCH_SHIFT2', 'PITCH_SHIFT3', 'PITCH_SHIFT4',
  'PITCH_STEP1', 'PITCH_STEP2', 'PITCH_STEP3', 'PITCH_STEP4', 'PITCH_STEP5', 'PITCH_STEP6',
  'PITCH_STEP7', 'PITCH_STEP8', 'PITCH_STEP9', 'PITCH_STEP10', 'PITCH_STEP11', 'PITCH_STEP12',
  'PITCH_STEP13', 'PITCH_STEP14', 'PITCH_STEP15', 'PITCH_STEP16',
  'PLEX_SHIFT1', 'PLEX_SHIFT2', 'PLEX_SHIFT3', 'PLEX_SHIFT4',
  'PLEX_SHIFT5', 'PLEX_SHIFT6', 'PLEX_SHIFT7', 'PLEX_SHIFT8',
  'SYNTH_SHIFT1', 'SYNTH_SHIFT2', 'SYNTH_SHIFT3',
  'REVERB_SHIFT1', 'REVERB_SHIFT2',
]);

function makeSignedRawSemitoneDecode(cal: CalibrationOpts): ParamSchema['decode'] {
  return (wire: number): number => {
    const signed = wire > 32767 ? wire - 65536 : wire;
    return roundDisplay(Math.min(cal.displayMax, Math.max(cal.displayMin, signed)));
  };
}

function buildParamSchema(
  family: string,
  param: AxeFxIIIParam,
  deviceEnumOverrides?: Readonly<Record<string, Readonly<Record<number, string>>>>,
  sharedEnumRosters?: Readonly<Record<string, Readonly<Record<number, string>>>>,
  deviceRange?: DeviceParamRange,
  roundtripDiscreteOrdinals?: Readonly<Record<string, number>>,
): {
  key: string;
  schema: ParamSchema;
} {
  const key = stripFamilyPrefix(family, param.name);
  // Gen-3 read leg: if the param's firmware symbol has an enum vocabulary in
  // the shared overlay, attach the ordinal->label table so get_param /
  // get_preset / broadcast and list_params surface NAMES, not raw indices.
  // The SAME ordinal table drives set-by-name: a discrete SET carries
  // float32(read-ordinal) at pos 12 (sub 09 00), so the name->ordinal the read
  // leg decodes with IS the set value (verified 2026-06-08, FM3 + FM9). No
  // separate raw-id space, no gating.
  //
  // Unit-aware to avoid over-matching: only a param the catalog actually tags
  // `unit: 'enum'` (the III) gets the FULL overlay (effect-type lists +
  // universal Fractal suffix conventions). The FM3/FM9 device-true catalogs
  // are all `unit: 'unverified'`, so for them we attach ONLY the byte-anchored
  // effect-type lists, never the broad suffix conventions that would wrongly
  // label + gate a continuous param sharing a suffix (_HOLD/_TEMPO/_SLOPE/...).
  const overlay = param.unit === 'enum'
    ? resolveEnumValues(param.name)
    : resolveEffectTypeEnum(param.name);
  // Per-device enum override: a device-true {ordinal -> name} table captured
  // from this specific model's hardware (e.g. the FM9 amp roster, which the
  // family-shared overlay deliberately leaves numeric because amp ordinals
  // differ per model). Takes precedence over the family overlay. Partial by
  // construction (only captured ordinals) — the decode below labels known
  // ordinals and passes unknown ones through as numbers. These ordinals double
  // as the set-by-name values (float32(ordinal) discrete SET).
  const deviceOverlayValues = deviceEnumOverrides?.[param.name];
  // Shared gen-3 read roster (factory-correlated name table, e.g. the 284 amp
  // models). LOWEST precedence: it fills params the family overlay leaves
  // numeric (notably amp), but must NOT override the overlay's canonical
  // spellings. Layered precedence (later spread wins):
  //   shared roster < family overlay < device-captured (hardware truth).
  const sharedRoster = sharedEnumRosters?.[param.name];
  const enumValues =
    deviceOverlayValues !== undefined || overlay?.values !== undefined || sharedRoster !== undefined
      ? { ...(sharedRoster ?? {}), ...(overlay?.values ?? {}), ...(deviceOverlayValues ?? {}) }
      : undefined;

  // Device-cache enum WITHOUT a correlated name table: the editor cache marks
  // this paramId enum (kind:'enum' + enumCount) but the AM4/XML/roster overlays
  // gave it no vocabulary. It MUST still route DISCRETE — sending a known enum
  // as a continuous float makes the device store the wrong ordinal (the FM9
  // full-roundtrip sweep, 2026-06-18, caught ~49 such selectors). We route it
  // discrete with a numeric-ordinal encode bounded by the cache's enumCount;
  // names drop in later (roster mining) without changing the wire path.
  const deviceEnumNoNames =
    enumValues === undefined &&
    deviceRange?.kind === 'enum' &&
    typeof deviceRange.enumCount === 'number' &&
    deviceRange.enumCount > 1;

  // Roundtrip-derived discrete selector: the editor-cache enum path missed this
  // param (no enumValues, no kind:'enum' cache row), but the device's OWN full
  // roundtrip sweep showed it QUANTIZES a continuous SET to a small ordinal —
  // i.e. the device treats it as a discrete ordinal (type/model/mode selector or
  // integer count), so sending it continuous stores the WRONG value. Route it
  // DISCRETE bounded by the observed maxOrdinal. Precedence: an explicit enum
  // table, a cache kind:'enum' row, or a deviceEnumNoNames classification all
  // win; this only fills params currently routed continuous. (Same wire form as
  // deviceEnumNoNames: float32(ordinal), sub 09 00 — the wire builder is
  // unchanged, only the kind-classification differs.)
  const roundtripDiscrete =
    enumValues === undefined &&
    !deviceEnumNoNames &&
    deviceRange?.kind !== 'enum' &&
    roundtripDiscreteOrdinals?.[param.name] !== undefined;

  // Display-first: a non-enum param with a calibrated range encodes/decodes
  // through the II resolver. Enum params encode name→ordinal (the discrete-SET
  // value, float32(ordinal)) and decode ordinal→label; numeric wire passes
  // through either way. When a device-true cache range is present (FM9), it
  // overrides the catalog's AM4-overlay bounds inside resolveCalibration. A
  // count-known device-cache enum (deviceEnumNoNames) skips calibration too, as
  // does a roundtrip-derived discrete selector (it is an ordinal, not a knob).
  const cal = enumValues === undefined && !deviceEnumNoNames && !roundtripDiscrete
    ? resolveCalibration(param, deviceRange)
    : undefined;

  // Surface the device-true bounds (not the inherited inference) on the schema
  // so list_params / describe_device report the FM9's real range. Only a
  // float-kind cache row overrides; otherwise the catalog value stands.
  const displayMin = deviceRange?.kind === 'float' ? roundDisplay(deviceRange.displayMin) : param.displayMin;
  const displayMax = deviceRange?.kind === 'float' ? roundDisplay(deviceRange.displayMax) : param.displayMax;

  let encode: ParamSchema['encode'];
  let decode: ParamSchema['decode'];
  if (enumValues !== undefined) {
    // Set-by-name = float32(read-ordinal): encode resolves a NAME to the same
    // ordinal the decode labels with. The wire form is DISCRETE (sub 09 00).
    encode = makeEnumEncode(family, key, enumValues);
    decode = (wire: number): number | string => enumValues[wire] ?? wire;
  } else if (deviceEnumNoNames) {
    // Count-known device-cache enum, no names yet: discrete numeric-ordinal
    // wire (the ordinal passes straight through on decode).
    encode = makeOrdinalEncode(family, key, deviceRange!.enumCount! - 1);
    decode = (wire: number): number => wire;
  } else if (roundtripDiscrete) {
    // Roundtrip-derived discrete selector, no names yet: discrete numeric-ordinal
    // wire bounded by the observed maxOrdinal (the ordinal passes through on decode).
    encode = makeOrdinalEncode(family, key, roundtripDiscreteOrdinals![param.name]);
    decode = (wire: number): number => wire;
  } else if (cal !== undefined) {
    encode = makeCalibratedEncode(family, key, cal);
    decode = SIGNED_RAW_SEMITONE_PARAMS.has(param.name)
      ? makeSignedRawSemitoneDecode(cal)
      : makeCalibratedDecode(cal);
  } else {
    encode = makePassthroughEncode(family, key);
    decode = (wire: number): number => wire;
  }

  return {
    key,
    schema: {
      display_name: humanize(key),
      // A count-known device-cache enum (and a roundtrip-derived discrete
      // selector) reports 'enum' even though its catalog entry was 'unverified' —
      // the device's own behaviour is the authority on kind.
      unit: deviceEnumNoNames || roundtripDiscrete ? 'enum' : param.unit,
      display_min: displayMin,
      display_max: displayMax,
      enum_values: enumValues,
      // gen-3 SET wire form: enum/type selectors are DISCRETE (float32(ordinal),
      // sub 09 00); every other param is CONTINUOUS (float32(normalized), 52 00).
      // A device-cache enum routes discrete by COUNT, and a roundtrip-derived
      // selector by its observed maxOrdinal, even with no name table.
      wire_kind: enumValues !== undefined || deviceEnumNoNames || roundtripDiscrete ? 'discrete' : 'continuous',
      // A captured/correlated table is partial (only some ordinals named), so
      // numeric ordinals outside it must pass through, not error. A pure family
      // overlay (no device/shared contribution) stays a complete vocab. A
      // count-known enum (or roundtrip-derived selector) with NO names is partial
      // by definition (numeric only).
      enum_partial:
        (deviceOverlayValues !== undefined || sharedRoster !== undefined || deviceEnumNoNames || roundtripDiscrete)
          ? true
          : undefined,
      encode,
      decode,
      parameter_name: param.name,
    },
  };
}

// ── Per-device catalog factory ─────────────────────────────────────

export function createModernCatalog(opts: {
  blocks: readonly AxeFxIIIBlock[];
  paramsByFamily: Readonly<Record<string, readonly AxeFxIIIParam[]>>;
  resolveEffectId: (name: string, instance?: number) => number;
  /**
   * When true, a block whose groupCode maps to a catalog family that has
   * ZERO params on this device drops off the `blocks` surface (device-true
   * roster: e.g. FM3/FM9 lack DYNDIST, so the Dynamic Distortion block drops;
   * blocks whose tables the editor still ships, like TONEMATCH, are kept).
   * The III passes false so its surface is unchanged (byte-identity anchor).
   * Structural blocks with no mapped family (AMP, Shunt, Tuner, ...) are kept.
   */
  dropEmptyMappedBlocks?: boolean;
  /**
   * Per-device enum override tables, keyed by param firmware symbol name then
   * broadcast ordinal -> display name. Device-true points captured from THIS
   * model's hardware (e.g. FM9 amp models). Layered over the family-shared
   * overlay in `buildParamSchema`; partial tables are fine (unknown ordinals
   * pass through numerically). Omit for devices with no captured overrides.
   */
  deviceEnumOverrides?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /**
   * Shared gen-3 read rosters (read-ordinal -> name), keyed by param firmware
   * symbol. Factory-correlated name tables shared across III/FM3/FM9, layered
   * BELOW the family overlay + device-captured points (fills params the overlay
   * leaves numeric, notably amp). The ordinal doubles as the set-by-name value
   * (float32(ordinal) discrete SET). Omit for serial gen-3 (VP4) until validated.
   */
  sharedEnumRosters?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /**
   * Block slugs (lower-case) the physical device does NOT expose, dropped
   * unconditionally even when their mapped family carries params. The mined
   * catalog is shared across the gen-3 editor family, so a device-true table
   * can list params for a block a given unit lacks (VP4 carries DISTORT /
   * CABINET params from the shared editor binary but has no amp/cab blocks).
   * `dropEmptyMappedBlocks` only removes EMPTY families, so non-empty-but-
   * absent blocks need this explicit list.
   */
  excludeBlocks?: readonly string[];
  /**
   * Device-true display ranges keyed family → paramId → range, mined from the
   * device's OWN editor cache (e.g. `FM9_RANGES` from the FM9-Edit
   * effectDefinitions cache). When supplied, a float-kind row's
   * displayMin/displayMax OVERRIDES the catalog's AM4-overlay-inferred bounds
   * for display↔wire calibration AND the reported schema range; the inference
   * is used only as the fallback where the cache has no row. This corrects the
   * FM9 float params whose inherited bounds contradict the real front panel
   * (DELAY_TIME, REVERB_PREDELAY, etc.). Omit for devices with no device-true
   * range table (III/FM3/VP4 still use the catalog inference).
   */
  deviceRanges?: DeviceRangeTable;
  /**
   * Discrete-ordinal overlay (param firmware symbol → maxOrdinal). For the III
   * and FM9 this is generated from that device's OWN full roundtrip hardware
   * sweep (`scripts/generate-gen3-roundtrip-discrete.ts`); for the FM3 (no
   * roundtrip capture, no synced cache) it is the FAMILY-JOIN overlay
   * (`scripts/generate-fm3-family-join-discrete.ts`: sibling FM9-cache/roundtrip
   * evidence joined by (family, SYMBOL) — community-beta, FM3 roundtrip pending).
   * Params the editor-cache enum path missed but the oracle proves the device
   * QUANTIZES (so it treats them as ordinals): they route DISCRETE
   * (float32(ordinal), sub 09 00) bounded by maxOrdinal instead of continuous,
   * which would store the wrong ordinal. Pass each device ITS OWN overlay
   * (III ≠ FM9 ≠ FM3 — never cross-wire by paramId). Omit for VP4 (no oracle).
   * Precedence: explicit enum table / cache kind:'enum' / deviceEnumNoNames all
   * win; this only fills params currently routed continuous.
   */
  roundtripDiscreteOrdinals?: Readonly<Record<string, number>>;
}): ModernCatalog {
  const { blocks, paramsByFamily, resolveEffectId, dropEmptyMappedBlocks = false, deviceEnumOverrides, sharedEnumRosters, excludeBlocks, deviceRanges, roundtripDiscreteOrdinals } = opts;
  const excluded = new Set((excludeBlocks ?? []).map((s) => s.toLowerCase()));

  const slugToFamily: Record<string, string> = {};
  const slugToBlock: Record<string, AxeFxIIIBlock> = {};
  for (const b of blocks) {
    const slug = blockSlug(b);
    if (excluded.has(slug)) continue; // device lacks this block (e.g. VP4 amp/cab)
    slugToBlock[slug] = b;
    const family = GROUP_TO_FAMILY[b.groupCode];
    if (family !== undefined) slugToFamily[slug] = family;
  }

  const blockSchemas: Record<string, BlockSchema> = {};
  for (const b of blocks) {
    const slug = blockSlug(b);
    if (excluded.has(slug)) continue; // keep consistent with slugToBlock above
    const family = GROUP_TO_FAMILY[b.groupCode];
    const params: Record<string, ParamSchema> = {};
    const aliases: Record<string, string> = {};
    if (family !== undefined) {
      const catalogEntries = paramsByFamily[family] ?? [];
      for (const p of catalogEntries) {
        // Skip firmware-internal sentinels (paramId >= 0x3fff are *_SET_ALL /
        // *_VAL_ALL — documentary only, not wire-addressable).
        if (p.paramId >= 0x3fff) continue;
        // Device-true range precedence: look up this (family, paramId) in the
        // device's editor-cache range table; a float row overrides the
        // AM4-overlay inference inside buildParamSchema.
        const deviceRange = deviceRanges?.[family]?.[p.paramId];
        const { key, schema } = buildParamSchema(family, p, deviceEnumOverrides, sharedEnumRosters, deviceRange, roundtripDiscreteOrdinals);
        // First wins on key collision (e.g. FLANGER_TYPE vs FLANGER_OLD_TYPE).
        if (!(key in params)) {
          params[key] = schema;
          if (p.name.toLowerCase() !== key) {
            aliases[p.name.toLowerCase()] = key;
          }
        }
      }
      // Device-true roster: a mapped family with zero wire-addressable
      // params means this device doesn't ship the block — drop it.
      if (dropEmptyMappedBlocks && Object.keys(params).length === 0) continue;
    }
    blockSchemas[slug] = {
      display_name: b.name,
      params,
      aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    };
  }
  const frozenBlocks = Object.freeze(blockSchemas);

  function resolveBlockOrThrow(
    slug: string,
    deviceLabel: string,
    instance?: number,
  ): { block: AxeFxIIIBlock; effectId: number } {
    const block = slugToBlock[slug];
    if (block === undefined) {
      throw new DispatchError(
        'unknown_block',
        deviceLabel,
        `Block slug '${slug}' is not registered on ${deviceLabel}.`,
      );
    }
    let effectId: number;
    try {
      // `resolveEffectId` returns block.firstId + (instance - 1) and range-
      // checks against block.instances; gen-3 amp/reverb/delay carry 2..4
      // instances, so instance 2 addresses the second block (e.g. Amp 2 =
      // effect id 59). Default 1 keeps single-instance callers unchanged.
      effectId = resolveEffectId(block.name, instance ?? 1);
    } catch (err) {
      throw new DispatchError(
        'capability_not_supported',
        deviceLabel,
        err instanceof Error ? err.message : String(err),
      );
    }
    return { block, effectId };
  }

  function resolveParamOrThrow(
    slug: string,
    name: string,
    deviceLabel: string,
  ): { family: string; param: AxeFxIIIParam } {
    const family = slugToFamily[slug];
    if (family === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        deviceLabel,
        `Block '${slug}' has no parameter catalog on ${deviceLabel}. The modern ` +
          `Fractal groupCode-to-family map has no entry for this block (likely ` +
          `NAM / Tuner / Global Block / Shunt). set_param / get_param refuse for these.`,
      );
    }
    const catalogEntries = paramsByFamily[family] ?? [];
    for (const p of catalogEntries) {
      if (stripFamilyPrefix(family, p.name) === name && p.paramId < 0x3fff) {
        return { family, param: p };
      }
    }
    const knownNames: string[] = [];
    for (const p of catalogEntries) {
      if (p.paramId < 0x3fff) {
        const stripped = stripFamilyPrefix(family, p.name);
        if (!knownNames.includes(stripped)) knownNames.push(stripped);
      }
    }
    throw new DispatchError(
      'unknown_param',
      deviceLabel,
      formatUnknownParamError({
        deviceName: deviceLabel,
        block: slug,
        badParam: name,
        knownNames,
      }) + ` (family ${family})`,
    );
  }

  /**
   * Resolve + display→wire encode in one step, so apply_preset coerces spec
   * values the same way set_param's `encodeValue` boundary does. Resolves the
   * param (clean error on unknown name), then runs the catalog schema's encode
   * closure (the schema lives at `blocks[slug].params[<stripped key>]`).
   */
  function encodeParamOrThrow(
    slug: string,
    name: string,
    value: number | string,
    deviceLabel: string,
  ): number {
    const { family, param } = resolveParamOrThrow(slug, name, deviceLabel);
    const key = stripFamilyPrefix(family, param.name);
    const schema = blockSchemas[slug]?.params[key];
    if (schema === undefined) {
      // resolveParamOrThrow succeeded, so this is unreachable in practice;
      // fall back to a numeric passthrough rather than crashing.
      const n = typeof value === 'number' ? value : Number(value);
      return n;
    }
    return schema.encode(value);
  }

  return { blocks: frozenBlocks, resolveBlockOrThrow, resolveParamOrThrow, encodeParamOrThrow };
}
