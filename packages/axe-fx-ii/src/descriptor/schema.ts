/**
 * Axe-Fx II DeviceDescriptor — schema helpers + per-block/blocks builders.
 *
 * Pure utilities shared between writer.ts and reader.ts:
 *   - `makeEncode(param)` / `makeDecode(param)` — produces ParamSchema
 *     encode/decode closures for one Axe-Fx II param. Encode returns
 *     the 0..65534 wire integer; decode returns the display unit (or
 *     enum label).
 *   - `buildBlocks()` / `buildBlockTypes()` — iterates KNOWN_PARAMS +
 *     AXE_FX_II_BLOCKS once at module load to produce the per-block
 *     schemas + block-type metadata the unified surface consumes.
 *   - `parseAxeFxIILocation(location)` — string ("0".."16383") or
 *     0..16383 integer → 0..16383 wire preset number, with
 *     DispatchError for invalid input.
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
  type AxeFxIIParam,
} from 'fractal-midi/axe-fx-ii';
import { AXE_FX_II_BLOCKS, type AxeFxIIBlock } from 'fractal-midi/axe-fx-ii';
import { displayToWire, wireToDisplay } from 'fractal-midi/axe-fx-ii';
import { PARAM_ALIASES_AXEFX2 } from 'fractal-midi/axe-fx-ii';

import { getCalibration, type CalibrationEntry } from '../calibration.js';

// ── Calibration resolution ───────────────────────────────────────────
//
// The codec catalog (`fractal-midi/axe-fx-ii` KNOWN_PARAMS) carries
// `displayMin`/`displayMax`/`displayScale` for the subset of params the
// Fractal wiki documents (~54 of 1126). For every other knob the
// `calibration.ts` overlay supplies a defensible display range with
// `provenance` evidence — AM4-shared, editor-observed, or
// fractal-convention. Catalog values always win; the overlay is a
// pure fallback. This keeps the codec layer's hardware-verified
// calibrations sacred while closing the display-first gap for the
// uncalibrated tail (Session 98 root-cause class).

interface ResolvedCalibration {
  readonly displayMin: number;
  readonly displayMax: number;
  readonly displayScale?: 'linear' | 'log10';
}

function resolveCalibration(param: AxeFxIIParam): ResolvedCalibration | undefined {
  if (param.displayMin !== undefined && param.displayMax !== undefined) {
    return {
      displayMin: param.displayMin,
      displayMax: param.displayMax,
      displayScale: param.displayScale,
    };
  }
  const overlay: CalibrationEntry | undefined = getCalibration(param.block, param.name);
  if (overlay !== undefined) {
    return {
      displayMin: overlay.displayMin,
      displayMax: overlay.displayMax,
      displayScale: overlay.displayScale,
    };
  }
  return undefined;
}

// ── Encode / Decode closures ────────────────────────────────────────
//
// Axe-Fx II params are addressed by (effectId, paramId) where paramId
// is shared across instances of a block group. Encode returns the
// 16-bit wire integer the SET_BLOCK_PARAMETER_VALUE envelope expects.
// Three shapes:
//   - select / enum → resolve display name to wire index (case-
//     insensitive, with ambiguity detection)
//   - switch / bool → boolean coerced to 0/1
//   - knob → calibrated (displayToWire) or wire pass-through

function resolveEnumValue(param: AxeFxIIParam, value: number | string): number {
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

export function makeEncode(param: AxeFxIIParam): ParamSchema['encode'] {
  return (value: number | string): number => {
    if (param.controlType === 'select') {
      return resolveEnumValue(param, value);
    }
    if (param.controlType === 'switch') {
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true' || lower === 'on' || lower === '1') return 1;
        if (lower === 'false' || lower === 'off' || lower === '0') return 0;
        throw new Error(`Expected boolean / "on" / "off" for ${param.block}.${param.name}, got "${value}"`);
      }
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new Error(`Expected a number/boolean for ${param.block}.${param.name}, got "${value}"`);
      }
      return num ? 1 : 0;
    }
    // knob / unknown — calibrated or wire pass-through.
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Expected a number for ${param.block}.${param.name}, got "${value}"`);
    }
    const cal = resolveCalibration(param);
    if (cal !== undefined) {
      const { displayMin: min, displayMax: max, displayScale } = cal;
      if (num < min || num > max) {
        throw new Error(`${param.block}.${param.name} out of range [${min}..${max}]: ${num}`);
      }
      return displayToWire(num, {
        displayMin: min,
        displayMax: max,
        displayScale,
      });
    }
    if (!Number.isInteger(num) || num < 0 || num > 65534) {
      throw new Error(
        `${param.block}.${param.name} expects wire 0..65534 (uncalibrated): ${num}`,
      );
    }
    return num;
  };
}

export function makeDecode(param: AxeFxIIParam): ParamSchema['decode'] {
  return (wire: number): number | string => {
    if (param.controlType === 'select') {
      const idx = Math.round(wire);
      return param.enumValues?.[idx] ?? idx;
    }
    if (param.controlType === 'switch') {
      return wire ? 'on' : 'off';
    }
    const cal = resolveCalibration(param);
    if (cal !== undefined) {
      return wireToDisplay(wire, {
        displayMin: cal.displayMin,
        displayMax: cal.displayMax,
        displayScale: cal.displayScale,
      });
    }
    return wire;
  };
}

// ── Unit mapping ────────────────────────────────────────────────────

function unitFor(param: AxeFxIIParam): string {
  if (param.controlType === 'select') return 'enum';
  if (param.controlType === 'switch') return 'bool';
  const cal = resolveCalibration(param);
  if (param.controlType === 'knob') {
    if (cal === undefined) return 'opaque';
    const { displayMin: min, displayMax: max, displayScale } = cal;
    // Frequency knobs are log10 — surface as 'hz' so the LLM sees the
    // device's unit. Linear ranges fall through to generic shapes.
    if (displayScale === 'log10') return 'hz';
    if (min === 0 && max === 10) return 'knob';            // amp 0..10
    if (min === -100 && max === 100) return 'bipolar_percent';
    if (min === 0 && max === 100) return 'percent';
    return 'knob';
  }
  if (param.controlType === 'unknown') {
    if (cal === undefined) return 'opaque';
    return 'count';
  }
  return 'opaque';
}

// ── Block schemas ───────────────────────────────────────────────────

/**
 * Walk KNOWN_PARAMS once to build per-block schemas. Registry keys are
 * `<block-slug>.<param-name>`; we fan out into nested
 * `blocks[block-slug].params[param-name]`. Multi-instance addressing
 * (amp_1 / amp_2) is out of scope for MVP — the descriptor exposes the
 * canonical group via block-slug, and the writer/reader resolve to
 * instance 1 by default through `findBlock` (block-slug → first
 * `AxeFxIIBlock` in `AXE_FX_II_BLOCKS` whose lowercased name starts
 * with the slug).
 */
export function buildBlocks(): Record<string, BlockSchema> {
  const blocks: Record<string, {
    params: Record<string, ParamSchema>;
    aliases: Record<string, string>;
    groupCode: string;
  }> = {};
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const param = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    const block = param.block;
    const name = param.name;
    blocks[block] ??= { params: {}, aliases: {}, groupCode: param.groupCode.toUpperCase() };
    const cal = resolveCalibration(param);
    blocks[block].params[name] = {
      display_name: param.xmlLabel ?? param.wikiName ?? name,
      unit: unitFor(param),
      display_min: param.controlType === 'select' || param.controlType === 'switch' ? undefined : cal?.displayMin,
      display_max: param.controlType === 'select' || param.controlType === 'switch' ? undefined : cal?.displayMax,
      enum_values: param.enumValues,
      encode: makeEncode(param),
      decode: makeDecode(param),
    };
    // Auto-generate aliases from human display fields (AxeEdit xmlLabel,
    // wiki uppercase wikiName) so the unified surface's resolveParamName
    // accepts "Input Drive" / "INPUT DRIVE" without a hardcoded entry.
    const autoAliases = collectAutoAliases(param, name);
    for (const a of autoAliases) {
      if (a !== name) blocks[block].aliases[a] = name;
    }
  }

  // Layer in the per-group hardcoded English aliases (e.g. amp's
  // "gain" → "input_drive") on top of the auto-derived ones.
  for (const [groupCode, aliasMap] of Object.entries(PARAM_ALIASES_AXEFX2)) {
    for (const [block, blockData] of Object.entries(blocks)) {
      if (blockData.groupCode !== groupCode) continue;
      for (const [aliasName, canonicalName] of Object.entries(aliasMap)) {
        if (canonicalName in blockData.params) {
          blockData.aliases[aliasName] = canonicalName;
        }
      }
    }
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

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function collectAutoAliases(param: AxeFxIIParam, canonicalName: string): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>([canonicalName]);
  // wikiName: "INPUT DRIVE" → "input_drive" (== canonical, skipped)
  // xmlLabel: "Input Drive" / "Speaker\nDrive" → normalized form
  // parameterName: "DISTORT_DRIVE" → "distort_drive" (a useful alias —
  //   someone might paste the firmware name from AxeEdit's XML dump)
  for (const candidate of [param.wikiName, param.xmlLabel, param.parameterName]) {
    if (!candidate) continue;
    const normalized = normalizeName(candidate);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      aliases.push(normalized);
    }
  }
  return aliases;
}

// ── Block types (for set_block(block_type=...)) ─────────────────────
//
// Axe-Fx II blocks are keyed by 14-bit effectId. The unified
// `set_block` lets the LLM pass either the display name ("Amp 1") or
// the block-slug ("amp"); the descriptor maps both → effectId.

export function buildBlockTypes(): Record<string, BlockTypeMeta> {
  const result: Record<string, BlockTypeMeta> = {};
  for (const block of AXE_FX_II_BLOCKS) {
    const slug = block.name.toLowerCase();
    result[slug] = {
      wire_value: block.id,
      display_name: block.name,
    };
  }
  return result;
}

// ── findBlock — block-slug → first AxeFxIIBlock instance ────────────
//
// Resolves a descriptor-style block-slug (e.g. "amp", "reverb") to its
// canonical AxeFxIIBlock for wire builders. MVP: instance 1 only.
// Looks up by groupCode first (case-insensitive) then by block field
// match against `AxeFxIIParam.block`.

export function findBlockBySlug(slug: string): AxeFxIIBlock | undefined {
  const lower = slug.trim().toLowerCase();
  // Try matching against AXE_FX_II_BLOCKS via groupCode of any KNOWN_PARAMS
  // entry that uses this block field — that's the canonical mapping.
  let groupCode: string | undefined;
  for (const k of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[k as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    if (p.block === lower) {
      groupCode = p.groupCode;
      break;
    }
  }
  if (groupCode === undefined) {
    // Fallback: direct slug match against block.name (lower-cased "Amp 1").
    return AXE_FX_II_BLOCKS.find((b) => b.name.toLowerCase().startsWith(lower));
  }
  return AXE_FX_II_BLOCKS.find((b) => b.groupCode === groupCode);
}

// ── Location parser ────────────────────────────────────────────────
//
// **Display-first contract.** Axe-Fx II tools accept 1-indexed display
// slot numbers (1..16384) — the same numbers that appear on the device
// front panel and in AxeEdit's preset list. The wire protocol uses
// 0-indexed integers (0..16383); this parser translates display → wire
// at the descriptor boundary so callers stay in the user-facing
// addressing space.
//
// Slot 1 (display) ⇄ wire 0. Slot 700 (display) ⇄ wire 699. The wire
// builders below the descriptor still operate on the 0-indexed integer.
//
// Accepts integer or all-digits string. No letter codes (that's the
// AM4 A01..Z04 encoding).

export function parseAxeFxIILocation(location: string | number): number {
  let n: number;
  if (typeof location === 'number') {
    n = location;
  } else {
    const trimmed = location.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new DispatchError(
        'bad_location',
        'Fractal Axe-Fx II XL+',
        `Slot '${location}' is not valid on Fractal Axe-Fx II — expected a 1-indexed display slot (1..16384), not a bank/letter code.`,
        { retry_action: 'Pass an integer or string-of-digits slot number (e.g. 700 for display slot 700).' },
      );
    }
    n = Number(trimmed);
  }
  if (!Number.isInteger(n) || n < 1 || n > 16384) {
    throw new DispatchError(
      'bad_location',
      'Fractal Axe-Fx II XL+',
      `Slot ${n} is out of range on Fractal Axe-Fx II (valid: 1..16384, 1-indexed display slot matching the device front panel).`,
    );
  }
  return n - 1;
}
