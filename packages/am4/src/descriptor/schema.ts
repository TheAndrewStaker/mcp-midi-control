/**
 * AM4 DeviceDescriptor — schema helpers + per-block/blocks builders.
 *
 * Pure utilities shared between writer.ts and reader.ts:
 *   - `makeEncode(param)` / `makeDecode(param)` — produces ParamSchema
 *     encode/decode closures for one AM4 param. Both honor the
 *     display-first contract (AM4 manual values in, wire-side scaling
 *     handled by the descriptor / setParam layer).
 *   - `buildBlocks()` / `buildBlockTypes()` — iterates KNOWN_PARAMS +
 *     BLOCK_TYPE_VALUES once at module load to produce the per-block
 *     schemas + block-type metadata the unified surface consumes.
 *   - `parseAm4Location(location)` — string ("A01".."Z04") or
 *     0..103 integer → 0..103 location index, with DispatchError for
 *     invalid input.
 *
 * Everything here is wire-free; the goldens exercise these encoders
 * directly without a MIDI handle.
 */

import type {
  BlockSchema,
  BlockTypeMeta,
  ParamSchema,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  KNOWN_PARAMS,
  PARAM_ALIASES,
  decode as am4Decode,
  findEnumCandidates,
  resolveEnumValue,
  type Param,
  type ParamKey,
} from 'fractal-midi/am4';
import { EnumAmbiguityError } from 'fractal-midi/am4';
import { BLOCK_TYPE_VALUES, BLOCK_NAMES_BY_VALUE } from 'fractal-midi/am4';
import {
  parseLocationCode,
  TOTAL_LOCATIONS,
} from 'fractal-midi/am4';
import { resolveBridge } from 'fractal-midi/am4';
import { describeApplicability } from 'fractal-midi/am4';

// ── Unit pass-through ───────────────────────────────────────────────
//
// AM4's unit names (`knob_0_10`, `pf`, `rotary_mic_spacing`,
// `amp_geq_band`, …) are the words the AM4 manual + front panel use,
// so the LLM should see those words in describe_device / list_params
// output. Open item #4 (Session 63 cont): the generic `Unit` is now
// `string`, so AM4 units pass through verbatim. The encode/decode
// closures still own all the scaling math — `unit` is purely a label.

// ── Encode helper ───────────────────────────────────────────────────
//
// Mirrors `resolveValue` from src/server/shared/paramHelpers.ts but
// scoped to a single Param so each schema entry can carry its own
// closure. Behavior is identical: numbers/strings for enums (with
// disambiguation), range-checked numerics for everything else. The
// returned number is the "display value" the AM4 wire layer expects
// — `buildSetParam` does its own display→packed-float conversion
// internally, so the dispatcher doesn't need to know about the wire
// encoding.

export function makeEncode(param: Param): ParamSchema['encode'] {
  return (value: number | string): number => {
    if (param.unit === 'enum') {
      const resolved = resolveEnumValue(param, value);
      if (resolved === undefined) {
        const candidates = typeof value === 'string'
          ? findEnumCandidates(param, value)
          : [];
        if (candidates.length >= 2) {
          throw new EnumAmbiguityError(String(value), candidates.map((c) => c.name));
        }
        const samples = Object.values(param.enumValues ?? {}).slice(0, 8).join(', ');
        throw new Error(`"${value}" is not a valid ${param.block}.${param.name} value. First few valid names: ${samples}… (call list_enum_values for the full list).`);
      }
      return resolved;
    }
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Expected a number for ${param.block}.${param.name}, got "${value}"`);
    }
    if (num < param.displayMin || num > param.displayMax) {
      throw new Error(`${param.block}.${param.name} out of range [${param.displayMin}..${param.displayMax}]: ${num}`);
    }
    return num;
  };
}

export function makeDecode(param: Param): ParamSchema['decode'] {
  return (wire: number): number | string => {
    if (param.unit === 'enum') {
      const idx = Math.round(wire);
      return param.enumValues?.[idx] ?? idx;
    }
    return am4Decode(param, wire);
  };
}

// ── Block schemas ───────────────────────────────────────────────────
//
// Iterate KNOWN_PARAMS once to build per-block schemas. The flat
// `{block}.{name}` map fans out into nested `blocks[block].params[name]`
// entries, with PARAM_ALIASES translated into per-block alias tables.

export function buildBlocks(): Record<string, BlockSchema> {
  const blocks: Record<string, { params: Record<string, ParamSchema>; aliases: Record<string, string> }> = {};
  for (const key of Object.keys(KNOWN_PARAMS) as ParamKey[]) {
    // KNOWN_PARAMS is a heterogenous `as const` literal — TS infers per-entry
    // shapes that lack the union'd optional fields like `enumValues`. Widen
    // to the shared `Param` interface so optional fields are accessible
    // uniformly. Same pattern as `paramHelpers.ts:resolveValue`.
    const param: Param = KNOWN_PARAMS[key];
    const block = param.block;
    const name = param.name;
    blocks[block] ??= { params: {}, aliases: {} };
    // Host-side annotations restored v0.3 audit (gap #7 from
    // SKEPTICAL-GUITARIST-REVIEW): the AM4-Edit UI label (canonical
    // wording the user sees on screen) and per-type applicability
    // (which amp/drive/reverb/etc. types audibly expose this knob)
    // are load-bearing for tone-building accuracy. The removed
    // `am4_list_params` surfaced both; restoring on the unified
    // `list_params` path so the LLM can avoid writing type-gated
    // params on incompatible types.
    const bridge = resolveBridge(block, name);
    const applicability = describeApplicability(key);
    // `display_name` is the friendly label the LLM sees in list_params /
    // describe_device output. Priority order:
    //   1. `param.displayLabel` — hand-set in params.ts from the
    //      AM4-Edit XML join (scripts/_research/add-display-labels.ts).
    //      Most accurate per-entry source.
    //   2. `bridge?.canonicalLabel` — resolver-derived label from
    //      parameterBridge.ts (XML + paramNames.ts merge).
    //   3. `name` — snake_case key as a last-resort fallback.
    // The wire-side key (used by the dispatcher's resolveParamName) is
    // still `name`; this change only affects what the LLM reads as the
    // friendly label. Mirrors the Axe-Fx II pattern at
    // packages/axe-fx-ii/src/descriptor/schema.ts:193.
    blocks[block].params[name] = {
      display_name: param.displayLabel ?? bridge?.canonicalLabel ?? name,
      unit: param.unit,                 // AM4-native name passes through
      display_min: param.unit === 'enum' ? undefined : param.displayMin,
      display_max: param.unit === 'enum' ? undefined : param.displayMax,
      enum_values: param.enumValues,
      encode: makeEncode(param),
      decode: makeDecode(param),
      host_label: bridge?.canonicalLabel,
      parameter_name: bridge?.parameterName,
      applies_only_when: applicability,
    };
  }
  // Per-block aliases: PARAM_ALIASES has fully-qualified keys
  // ('reverb.decay' → 'reverb.time'). Split into per-block dictionaries.
  for (const [aliasFq, canonicalFq] of Object.entries(PARAM_ALIASES)) {
    const [aliasBlock, aliasName] = aliasFq.split('.');
    const [canonicalBlock, canonicalName] = canonicalFq.split('.');
    // PARAM_ALIASES is well-formed (same block on both sides) by
    // construction in params.ts. Belt-and-suspenders check anyway.
    if (aliasBlock !== canonicalBlock) continue;
    if (!blocks[aliasBlock]) continue;
    if (!(canonicalName in blocks[aliasBlock].params)) continue;
    blocks[aliasBlock].aliases[aliasName] = canonicalName;
  }

  const result: Record<string, BlockSchema> = {};
  for (const [block, { params, aliases }] of Object.entries(blocks)) {
    result[block] = {
      display_name: block,
      params,
      aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    };
  }
  return result;
}

// ── Block types (for set_block(block_type=...)) ─────────────────────

export function buildBlockTypes(): Record<string, BlockTypeMeta> {
  const result: Record<string, BlockTypeMeta> = {};
  for (const [name, wire] of Object.entries(BLOCK_TYPE_VALUES)) {
    result[name] = {
      wire_value: wire,
      display_name: BLOCK_NAMES_BY_VALUE[wire] ?? name,
    };
  }
  return result;
}

// ── Location parser ────────────────────────────────────────────────

export function parseAm4Location(location: string | number): number {
  if (typeof location === 'number') {
    if (Number.isInteger(location) && location >= 0 && location < TOTAL_LOCATIONS) {
      return location;
    }
    throw new DispatchError(
      'bad_location',
      'Fractal AM4',
      `Location index ${location} is out of range on Fractal AM4 (valid: 0..${TOTAL_LOCATIONS - 1}).`,
    );
  }
  const normalized = location.trim().toUpperCase();
  try {
    return parseLocationCode(normalized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DispatchError(
      'bad_location',
      'Fractal AM4',
      `Location '${location}' is not valid on Fractal AM4. ${msg}. AM4 locations are A1..Z4 (104 total, 26 banks × 4).`,
      { retry_action: 'Pass a code like "A1" or "Z4" (zero-padded "A01" / "Z04" is also accepted).' },
    );
  }
}
