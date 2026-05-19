/**
 * Hydrasynth Explorer DeviceDescriptor — schema helpers.
 *
 * Builds the BlockSchema (modules → params) from the NRPN table and CC
 * chart. Hydrasynth is the only non-Fractal device in the codebase;
 * most descriptor capabilities collapse:
 *
 *   - No grid (slot_model: 'linear')
 *   - No scenes (has_scenes: false)
 *   - No per-block channels (has_channels: false)
 *   - No factory restore primitive — Hydrasynth has "init patch"
 *     instead, which we surface via the existing hydra_apply_init flow.
 *   - No Fractal-authored lineage corpus (supports_lineage: false).
 *
 * The descriptor's `blocks` map mirrors Hydrasynth's modular layout:
 * one entry per synthesis module (osc1/2/3, filter1/2, mixer, voice,
 * env1..4, lfo1..5, mutator1..4, prefx, postfx, delay, reverb, macros,
 * arp, system). Param names are the `module.param` form — same shape
 * as Fractal block.param — derived from the NRPN aliases and CC ids.
 *
 * Coverage caveat: HYDRASYNTH_NRPNS has 1655 entries; many are
 * multi-slot families (osc1mode/osc2mode/osc3mode share an NRPN
 * address with `dataMsb` selecting the slot). The BlockSchema lists
 * each (module, param) pair once — the slot index is implicit in the
 * module prefix.
 */

import type {
  BlockSchema,
  BlockTypeMeta,
  ParamSchema,
  Unit,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import { HYDRASYNTH_NRPNS, type HydrasynthNrpn } from '../nrpn.js';
import { HYDRASYNTH_PARAMS } from '../params.js';
import { resolveNrpnValue } from '../encoding.js';
import { HYDRASYNTH_ENUMS } from '../enums.js';

const DEVICE_LABEL = 'ASM Hydrasynth Explorer';

// ── Module-name extraction ─────────────────────────────────────────
//
// Hydrasynth NRPN names are smushed lowercase ("osc1mode", "filter1cutoff",
// "env1attack"). We split them at the first letter→digit→letter boundary
// to derive (module, param) pairs. Aliases (when present) already use
// the dotted form ("mixer.osc1_vol", "env1.attack") — we prefer those.

const MODULE_PREFIXES: readonly string[] = [
  'osc1', 'osc2', 'osc3',
  'filter1', 'filter2',
  'env1', 'env2', 'env3', 'env4',
  'lfo1', 'lfo2', 'lfo3', 'lfo4', 'lfo5',
  'mutator1', 'mutator2', 'mutator3', 'mutator4',
  'macros',
  'mixer',
  'voice',
  'arp',
  'delay',
  'reverb',
  'prefx', 'postfx',
  'system',
  'amp', 'ampenv',
  'modmatrix',
  'ribbon',
  'mod', // generic mod-slot fallback
];

interface ModulePair {
  module: string;
  param: string;
}

function splitModule(nrpnName: string): ModulePair | undefined {
  // Try longest prefix first so 'filter1' wins over 'filt'.
  for (const prefix of [...MODULE_PREFIXES].sort((a, b) => b.length - a.length)) {
    if (nrpnName.startsWith(prefix)) {
      const rest = nrpnName.slice(prefix.length);
      if (rest.length === 0) return undefined;
      return { module: prefix, param: rest };
    }
  }
  return undefined;
}

function splitFromAlias(alias: string): ModulePair | undefined {
  const idx = alias.indexOf('.');
  if (idx <= 0) return undefined;
  const module = alias.slice(0, idx);
  const param = alias.slice(idx + 1).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  return { module, param };
}

// ── Unit / encoding inference ──────────────────────────────────────

function unitFor(entry: HydrasynthNrpn): Unit {
  if (entry.enumTable) return 'enum';
  const max = entry.wireMax ?? 127;
  if (entry.displayMin !== undefined && entry.displayMax !== undefined) {
    if (entry.displayMin === -100 && entry.displayMax === 100) return 'bipolar_percent';
    if (entry.displayMin === 0 && entry.displayMax === 100) return 'percent';
    if (entry.displayMin === 0 && entry.displayMax === 127) return 'count';
    return 'count';
  }
  // 14-bit linear ramp (wireMax 8192 etc.) → percent-style knob
  if (max >= 1000) return 'percent';
  return 'count';
}

function makeEncode(entry: HydrasynthNrpn): ParamSchema['encode'] {
  return (value: number | string): number => {
    const resolved = resolveNrpnValue(entry, value);
    return resolved.wire;
  };
}

function makeDecode(entry: HydrasynthNrpn): ParamSchema['decode'] {
  return (wire: number): number | string => {
    if (entry.enumTable) {
      const table = HYDRASYNTH_ENUMS[entry.enumTable];
      const label = table?.[wire];
      if (label !== undefined) return label;
      return wire;
    }
    const max = entry.wireMax ?? 127;
    if (entry.displayMin !== undefined && entry.displayMax !== undefined) {
      // Linear remap from wire 0..max → displayMin..displayMax.
      const span = entry.displayMax - entry.displayMin;
      return entry.displayMin + (wire / max) * span;
    }
    return wire;
  };
}

// ── Block schemas ───────────────────────────────────────────────────
//
// Build from NRPN entries (master list) + supplement with CC params
// for any not covered. Each (module, param) pair appears once even if
// multiple NRPN entries map to it (different slots of a multi-slot
// family — those collapse to a single descriptor entry; the executor
// resolves the slot from the canonical name at write time).

export function buildBlocks(): Record<string, BlockSchema> {
  const blocks: Record<string, {
    params: Record<string, ParamSchema>;
    aliases: Record<string, string>;
    displayName: string;
  }> = {};

  for (const entry of HYDRASYNTH_NRPNS) {
    // Prefer the dotted alias when present — it's the human-friendly
    // form. Fall back to module-prefix splitting for entries without
    // an alias (most engine NRPN-only params).
    let pair: ModulePair | undefined;
    if (entry.aliases && entry.aliases.length > 0) {
      for (const alias of entry.aliases) {
        const fromAlias = splitFromAlias(alias);
        if (fromAlias) { pair = fromAlias; break; }
      }
    }
    if (!pair) pair = splitModule(entry.name);
    if (!pair) continue; // unparseable — skip; agent can use legacy hydra_set_engine_param

    blocks[pair.module] ??= {
      params: {},
      aliases: {},
      displayName: pair.module,
    };
    // First wins (NRPN list order). Later collisions are alternative
    // slot indices of the same param family.
    if (!(pair.param in blocks[pair.module].params)) {
      blocks[pair.module].params[pair.param] = {
        display_name: entry.aliases?.[0] ?? entry.name,
        unit: unitFor(entry),
        display_min: entry.displayMin,
        display_max: entry.displayMax,
        encode: makeEncode(entry),
        decode: makeDecode(entry),
      };
    }
  }

  // Supplement with CC chart entries (covers macros + system + a few
  // engine knobs that have nicer human names in the CC chart than in
  // the NRPN smushed-name form).
  for (const cc of HYDRASYNTH_PARAMS) {
    const pair = splitFromAlias(cc.id);
    if (!pair) continue;
    blocks[pair.module] ??= {
      params: {},
      aliases: {},
      displayName: pair.module,
    };
    if (!(pair.param in blocks[pair.module].params)) {
      blocks[pair.module].params[pair.param] = {
        display_name: cc.parameter,
        unit: 'count',
        display_min: 0,
        display_max: 127,
        encode: (value) => {
          const num = typeof value === 'number' ? value : Number(value);
          if (!Number.isFinite(num) || num < 0 || num > 127) {
            throw new Error(`${pair.module}.${pair.param} (CC ${cc.cc}): expected 0..127, got ${value}`);
          }
          return Math.round(num);
        },
        decode: (wire) => wire,
      };
    }
  }

  const result: Record<string, BlockSchema> = {};
  for (const [module, { params, aliases, displayName }] of Object.entries(blocks)) {
    result[module] = {
      display_name: displayName,
      params,
      aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    };
  }
  return result;
}

// ── Block types — Hydrasynth has no swap-the-block-type primitive ──

export function buildBlockTypes(): Record<string, BlockTypeMeta> {
  // No-op — synthesizer modules aren't interchangeable. Each module is
  // structurally fixed. Return an empty table; the unified `set_block`
  // tool will return capability_not_supported via the descriptor's
  // `supports_save: false` for block-type swaps.
  return {};
}

// ── Location parser ────────────────────────────────────────────────
//
// Hydrasynth Explorer addresses patches with "A001".."H128" — letter
// bank + 3-digit patch number (1-indexed display). The unified
// surface's LocationRef is `string | number`. We translate the string
// form into a flat 0..1023 wire index for the descriptor's internal
// use; tools surface the user-facing "A001" form in result strings.

export function parseHydrasynthLocation(location: string | number): {
  bank: number;
  patch: number;
  display: string;
  flatIndex: number;
} {
  if (typeof location === 'number') {
    if (!Number.isInteger(location) || location < 0 || location > 1023) {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `Patch index ${location} out of range on ASM Hydrasynth Explorer (valid: 0..1023, or use "A001".."H128").`,
      );
    }
    const bank = Math.floor(location / 128);
    const patch = location % 128;
    return {
      bank,
      patch,
      display: `${String.fromCharCode('A'.charCodeAt(0) + bank)}${(patch + 1).toString().padStart(3, '0')}`,
      flatIndex: location,
    };
  }
  const m = location.trim().toUpperCase().match(/^([A-H])(\d{1,3})$/);
  if (!m) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `Location "${location}" must be "A001".."H128" (letter A..H + patch 1..128) on ASM Hydrasynth Explorer.`,
      { retry_action: 'Pass a slot like "A001" or "H128", or a 0..1023 flat index.' },
    );
  }
  const bank = m[1]!.charCodeAt(0) - 'A'.charCodeAt(0);
  const num = Number.parseInt(m[2]!, 10);
  if (num < 1 || num > 128) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `Location "${location}" patch must be 1..128, got ${num}.`,
    );
  }
  const patch = num - 1;
  return {
    bank,
    patch,
    display: `${m[1]}${num.toString().padStart(3, '0')}`,
    flatIndex: bank * 128 + patch,
  };
}
