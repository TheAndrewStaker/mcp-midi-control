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
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

import {
  KNOWN_PARAMS,
  type AxeFxIIParam,
} from 'fractal-midi/axe-fx-ii';
import { AXE_FX_II_BLOCKS, type AxeFxIIBlock } from 'fractal-midi/axe-fx-ii';
import { PARAM_ALIASES_AXEFX2 } from 'fractal-midi/axe-fx-ii';

// ── Encode / Decode closures ────────────────────────────────────────
//
// The `paramKind` helper (core/protocol-generic/paramKind.ts) is the
// single source of truth for "what kind of knob is this, what's its
// display range, and how do we encode/decode it." Schema builders,
// the writer's reverse-display lookup, the reader's forward-display
// lookup, and the apply-path pre-encode all funnel through one
// `resolveParamKind('axe-fx-ii', block, name)` call. The Axe-Fx II
// resolver lives in `../calibration.ts`; it consults KNOWN_PARAMS
// first, then the AM4_SHARED / EDITOR_OBSERVED / SUFFIX_RULES overlay.

export function makeEncode(param: AxeFxIIParam): ParamSchema['encode'] {
  // Resolve once at closure-build time so each subsequent call is a
  // straight delegation. The resolver itself is pure + idempotent.
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  const encodeDisplay = kind.encodeDisplay;
  return (value: number | string): number => {
    if (encodeDisplay !== undefined) {
      return encodeDisplay(value);
    }
    // Uncalibrated path — wire pass-through. Validate integer + range.
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Expected a number for ${param.block}.${param.name}, got "${value}"`);
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
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  const decodeWire = kind.decodeWire;
  return (wire: number): number | string => {
    if (decodeWire !== undefined) {
      return decodeWire(wire);
    }
    return wire;
  };
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
    const kind = resolveParamKind('axe-fx-ii', block, name);
    blocks[block].params[name] = {
      display_name: param.xmlLabel ?? param.wikiName ?? name,
      unit: kind.unit,
      display_min: param.controlType === 'select' || param.controlType === 'switch' ? undefined : kind.displayMin,
      display_max: param.controlType === 'select' || param.controlType === 'switch' ? undefined : kind.displayMax,
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
