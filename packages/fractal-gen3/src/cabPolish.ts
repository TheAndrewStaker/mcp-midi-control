/**
 * Gen-3 cab-polish default enforcement (BK-103c, extending the AM4's
 * BK-103b to the modern Fractal grid family).
 *
 * Close-mic'd IRs carry excess lows + highs; the validated mix-ready
 * starting point (cloudkake field report + Fractal's own published
 * practice; see BK-103 in the private backlog) is a low cut ~80 Hz /
 * high cut ~6.5 kHz plus a little cab room. On the AM4 the cab section
 * lives INSIDE the amp block; on the gen-3 grid devices the CAB is its
 * OWN block, so injection keys on the spec placing a cab block (never
 * on the amp, and blocks are never auto-placed).
 *
 * Guidance-only defaults failed the 2026-07-16 AM4 bench test, so the
 * executor ENFORCES them: a fresh cab-bearing apply_preset gets the
 * defaults appended to every cab channel window the spec writes, unless
 * the spec expresses any cab cut/room/slope opinion of its own or
 * bypasses the cab block (the 4CM / real-cab case). Explicit values
 * always win. The injected writes ride the SAME community-beta
 * set_param path the spec's own params use.
 *
 * EVIDENCE GATE (why this is capability-probed per device, not
 * unconditional): the gen-3 continuous SET wire carries
 * float32(wire16/65534), so a display value like "80 Hz" is only
 * expressible when the param carries a calibrated display range in the
 * device's own catalog. Today that is TRUE on the FM9 (device-true
 * ranges mined from its own FM9-Edit editor cache: CABINET_LOCUT
 * 20..2000 Hz, CABINET_HICUT 200..20000 Hz, CABINET_ROOMMIX 0..100) and
 * FALSE on the III and FM3 (their cab cut/room params are registered
 * but uncalibrated raw-wire passthrough), so the III and FM3 inject
 * NOTHING until their own range evidence lands; guessing the normalized
 * wire for 80 Hz would violate the no-guessed-wire-values rule. The
 * probe below reads the catalog schema, so a future device-true range
 * table lights injection up without touching this module.
 *
 * The filter-slope selector (CABINET_ORDER, stripped key `order`) is
 * deliberately NEVER injected on gen-3: no device catalog carries a name
 * vocabulary or a discrete classification for it yet, so a slope write
 * would be a guessed ordinal on an unverified wire kind. The II and AM4
 * inject their slope params; gen-3 ships cuts + room only.
 */

import type {
  BlockSchema,
  ParamSchema,
  PresetSlotSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';

/** What the executor injected, for `auto_applied` response reporting. */
export interface Gen3CabPolishReport {
  /** Cab channel windows written (letters; 'current' for a flat-shape window). */
  channels: string[];
  /** Display-shaped values injected, keyed by (stripped) param name. */
  params: Record<string, string>;
  /** Relay-ready note incl. the undo phrase. */
  note: string;
}

/**
 * Defaults in the gen-3 catalogs' stripped-key spelling (CABINET_LOCUT ->
 * `locut`, etc.). Values are display units; the apply path encodes them
 * through the same catalog schema the spec's own params use.
 */
const GEN3_CAB_POLISH_DEFAULTS: ReadonlyArray<readonly [name: string, value: number, display: string]> = [
  ['locut', 80, '80 Hz'],
  ['hicut', 6500, '6500 Hz'],  // assertive/mix-safe; Fractal's published start is 7500
  ['roommix', 8, '8%'],        // validated band 5-10%
];

/**
 * Canonical (stripped) cab-param keys that count as "the caller has cab
 * opinions": any of them anywhere on any cab slot suppresses injection
 * entirely. Includes the slope selector and the per-IR-slot cut/slope
 * variants (III/FM9/FM3 catalogs register them per IR slot). Aliases
 * (full firmware symbols like `cabinet_locut`) canonicalize through the
 * block schema's alias map before this check.
 */
const GEN3_CAB_POLISH_TRIGGERS: ReadonlySet<string> = new Set([
  'locut', 'hicut', 'roommix', 'order',
  'locut1', 'locut2', 'locut3', 'locut4',
  'hicut1', 'hicut2', 'hicut3', 'hicut4',
  'loslope1', 'loslope2', 'loslope3', 'loslope4',
  'hislope1', 'hislope2', 'hislope3', 'hislope4',
  'preloslope', 'prehislope',
]);

type FlatParams = Record<string, number | string>;
type NestedParams = Record<string, Readonly<Record<string, number | string>>>;

/**
 * True when `value` (display units) is expressible through this param's
 * schema encode: a continuous, non-enum param with a usable calibrated
 * display range covering the value. Mirrors the catalog's
 * `resolveCalibration` acceptance conditions; an uncalibrated param's
 * passthrough encode would misread the display value as raw wire.
 */
function displayEncodable(schema: ParamSchema | undefined, value: number): boolean {
  return (
    schema !== undefined &&
    schema.enum_values === undefined &&
    schema.wire_kind !== 'discrete' &&
    typeof schema.display_min === 'number' &&
    typeof schema.display_max === 'number' &&
    schema.display_min < schema.display_max &&
    value >= schema.display_min &&
    value <= schema.display_max
  );
}

/** Classify a slot's params shape the same way the gen-3 apply path does. */
function classifyShape(params: PresetSlotSpec['params']): 'empty' | 'flat' | 'nested' | 'mixed' {
  if (params === undefined) return 'empty';
  const entries = Object.entries(params);
  if (entries.length === 0) return 'empty';
  let nested = 0;
  let flat = 0;
  for (const [, v] of entries) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) nested++;
    else flat++;
  }
  if (nested > 0 && flat > 0) return 'mixed';
  return nested > 0 ? 'nested' : 'flat';
}

/**
 * Inject the gen-3 cab-polish defaults into a fresh cab-bearing slot list.
 * Pure function: returns NEW slot objects (the input spec is never
 * mutated) plus the `auto_applied` report, or the input untouched when
 * nothing injects (no cab placed, caller has cab opinions, or this
 * device's catalog cannot display-encode the cuts, the III/FM3 case).
 *
 * Ordering: defaults are appended AFTER each channel window's own spec
 * params (insertion order is write order on the gen-3 apply path), so a
 * spec that also sets the cab type/IR selector writes it first. A bare
 * cab placement injects channel-nested under the device's first channel
 * (A), pinning a deterministic window, mirroring the AM4's bare-amp
 * channel-A pin.
 */
export function injectGen3CabPolish(
  slots: readonly PresetSlotSpec[],
  cabSchema: BlockSchema | undefined,
  firstChannelName: string,
): { slots: readonly PresetSlotSpec[]; cabPolish: Gen3CabPolishReport | undefined } {
  const unchanged = { slots, cabPolish: undefined };
  if (cabSchema === undefined) return unchanged;

  // Evidence gate: the cuts must be display-encodable on THIS device's
  // catalog or the whole device skips (no partial cut injection; a lone
  // room write is not the validated default). roommix rides along only
  // when it too is encodable.
  const injectable = GEN3_CAB_POLISH_DEFAULTS.filter(([name, value]) =>
    displayEncodable(cabSchema.params[name], value),
  );
  const injectableNames = new Set(injectable.map(([n]) => n));
  if (!injectableNames.has('locut') || !injectableNames.has('hicut')) return unchanged;

  const cabSlotIndices: number[] = [];
  slots.forEach((slot, i) => {
    if (slot.block_type.trim().toLowerCase() === 'cab') cabSlotIndices.push(i);
  });
  if (cabSlotIndices.length === 0) return unchanged;

  // Canonicalize a spec param spelling through the block schema's alias
  // map (full firmware symbols like `cabinet_locut` count as opinions).
  const aliases = cabSchema.aliases ?? {};
  const canonical = (name: string): string => {
    const lower = name.trim().toLowerCase();
    return aliases[lower] ?? lower;
  };

  // Any cab cut/room/slope opinion (or a bypassed cab: 4CM / real-cab
  // intent, injected cuts would be dead writes) anywhere suppresses the
  // whole injection. Explicit values always win.
  const hasCabOpinion = cabSlotIndices.some((i) => {
    const slot = slots[i];
    if (slot.bypassed === true) return true;
    if (slot.params === undefined) return false;
    const names: string[] = [];
    for (const [key, value] of Object.entries(slot.params)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        names.push(...Object.keys(value)); // channel-nested: inner keys are params
      } else {
        names.push(key);
      }
    }
    return names.some((n) => GEN3_CAB_POLISH_TRIGGERS.has(canonical(n)));
  });
  if (hasCabOpinion) return unchanged;

  const defaultsMap = Object.fromEntries(
    injectable.map(([name, value]) => [name, value]),
  ) as Record<string, number>;
  const injectedChannels: string[] = [];
  const channelLabel = (slot: PresetSlotSpec, ch: string): string =>
    cabSlotIndices.length > 1 ? `cab ${slot.instance ?? 1} ${ch}` : ch;

  const nextSlots = slots.map((slot, i) => {
    if (!cabSlotIndices.includes(i)) return slot;
    const shape = classifyShape(slot.params);
    if (shape === 'mixed') return slot; // the apply path rejects mixed shapes; nothing to ride on
    if (shape === 'nested') {
      // Append inside EACH written channel window, after its spec params.
      const merged: NestedParams = {};
      for (const [chKey, channelParams] of Object.entries(slot.params as NestedParams)) {
        merged[chKey] = { ...channelParams, ...defaultsMap };
        injectedChannels.push(channelLabel(slot, chKey.trim().toUpperCase()));
      }
      return { ...slot, params: merged };
    }
    if (shape === 'flat') {
      // Flat writes target the block's current channel; append after the
      // spec's own params in that same window.
      injectedChannels.push(channelLabel(slot, 'current'));
      return { ...slot, params: { ...(slot.params as FlatParams), ...defaultsMap } };
    }
    // Bare cab placement (no params): pin a deterministic channel window
    // (the device's first channel) and inject there.
    injectedChannels.push(channelLabel(slot, firstChannelName));
    return { ...slot, params: { [firstChannelName]: defaultsMap } as NestedParams };
  });

  if (injectedChannels.length === 0) return unchanged;

  const withRoom = injectableNames.has('roommix');
  const note =
    'Mix-ready cab defaults were auto-applied to the cab block (low cut 80 Hz, ' +
    `high cut 6.5 kHz${withRoom ? ', 8% room' : ''}; display-calibrated on this device) ` +
    'because the spec set no cab cut/room param. TELL THE USER this was applied and give ' +
    'the undo: on "wide open" (or similar) set cab locut 20, hicut 20000' +
    `${withRoom ? ', roommix 0' : ''}. To build without them, pass any explicit cab ` +
    'cut/room/slope value in the spec, or bypass the cab block for a 4CM / real-cab rig. ' +
    'No filter-slope write was made (the gen-3 slope selector has no verified value table yet).';

  return {
    slots: nextSlots,
    cabPolish: {
      channels: injectedChannels,
      params: Object.fromEntries(injectable.map(([name, , display]) => [name, display])),
      note,
    },
  };
}
