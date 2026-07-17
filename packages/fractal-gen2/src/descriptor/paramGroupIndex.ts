/**
 * Axe-Fx II group-param decode, shared between the per-block fn=0x1F
 * (`readAllParams`) read path and the BK-081 atomic whole-preset-image
 * read path (`presetImageRead.ts`).
 *
 * Both paths ultimately have "a flat array of wire values, indexed by
 * paramId for one block's group" (the fn=0x1F state-broadcast triple's
 * `.values`, or a slice of the de-framed preset image's words for one
 * channel of one block); this module is the ONE decode routine both
 * consume, so a display-decode fix or a housekeeping-suppression change
 * can't drift between the two read paths.
 *
 * Extracted from `descriptor/reader.ts` on 2026-07-09.
 */

import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';

import { decodeEnumWire } from '../calibration.js';

/**
 * Firmware-internal housekeeping params suppressed from get_preset's params
 * map. They are redundant or device-internal, and their raw fn 0x1F dump value
 * is misleading:
 *   - 'bypass' is the inner per-block bypass flag. The canonical per-block
 *     bypass is surfaced on slot.bypassed (fn 0x0E engaged bit); the inner
 *     flag is redundant and its raw form is inconsistent (live read 2026-05-30
 *     showed 0/1/3 across blocks; the alpha.16 report saw larger values like
 *     2054/14/3081/1536), so an agent would misread it as a display value.
 *   - 'globalmix' (rotary speaker) reads a raw internal int; the user-facing
 *     mix is the separate 'mix' param. (The string-enum 'global_mix' on multi
 *     delay and 'global' on time-based blocks are NOT in this set and pass
 *     through normally.)
 *   - 'spare'/'spare1..3' are reserved slots on some block types.
 * Conservative set, confirmed against a live "Top Boost" get_preset
 * (2026-05-30). Real-but-uncalibrated knobs (e.g. reverb 'reverbdelay', the cab
 * opaque knobs) are deliberately NOT suppressed; they are calibration targets.
 */
export const HOUSEKEEPING_OPAQUE: ReadonlySet<string> = new Set([
  'bypass',
  'globalmix',
  'spare',
  'spare1',
  'spare2',
  'spare3',
]);

/**
 * Index every KNOWN_PARAMS entry for a given groupCode by its paramId,
 * so the (position i → paramId i) overlay can look up the param's name +
 * decode function in one map access.
 */
export function buildGroupParamIndex(groupCode: string): Map<number, AxeFxIIParam> {
  const out = new Map<number, AxeFxIIParam>();
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    if (p.groupCode === groupCode) out.set(p.paramId, p);
  }
  return out;
}

export interface DecodedGroupValues {
  /** Public params map (housekeeping entries excluded). */
  readonly out: Record<string, number | string>;
  /** paramIds that decoded to a raw wire integer (no calibration + not an enum). */
  readonly opaqueParamIds: number[];
  /** The block's 'bypass' housekeeping wire value, decoded to a bool, when present. */
  readonly bypass?: boolean;
  /** The block's 'bypass_mode' enum label, when present. */
  readonly bypassMode?: string;
}

/**
 * Decode one channel's worth of wire values for a block's group. `values`
 * is indexed by paramId (index 0 = paramId 0, etc.): the fn=0x1F triple's
 * `.values` array for channel X, or a `stride`-sliced sub-array for channel
 * Y, or a slice of the preset image's words for either channel.
 */
export function decodeGroupValues(groupCode: string, values: readonly number[]): DecodedGroupValues {
  const paramIndex = buildGroupParamIndex(groupCode);
  const out: Record<string, number | string> = {};
  const opaqueParamIds: number[] = [];
  let bypass: boolean | undefined;
  let bypassMode: string | undefined;
  for (const [paramId, p] of paramIndex) {
    if (paramId >= values.length) continue;
    const wire = values[paramId];
    const kind = resolveParamKind('axe-fx-ii', p.block, p.name);
    let display: number | string;
    if (kind.decodeWire !== undefined) {
      display = kind.decodeWire(wire);
    } else if (p.controlType === 'select') {
      // Defense-in-depth: the axe-fx-ii resolver (calibration.ts) always
      // supplies decodeWire for select-type params, so this branch is
      // normally unreached. Kept + hardened so a future resolver change
      // that punts on a select param still can't leak a bare wire int.
      display = decodeEnumWire(p.enumValues, wire);
    } else {
      display = wire;
      opaqueParamIds.push(p.paramId);
    }
    if (p.name === 'bypass') {
      bypass = wire !== 0;
    } else if (p.name === 'bypass_mode') {
      const label = p.enumValues?.[wire];
      if (label !== undefined) bypassMode = label;
    }
    if (HOUSEKEEPING_OPAQUE.has(p.name)) continue;
    out[p.name] = display;
  }
  return { out, opaqueParamIds, bypass, bypassMode };
}
