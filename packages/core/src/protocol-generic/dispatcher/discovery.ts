/**
 * Discovery executors — pure-introspection helpers that surface device
 * schema and lineage corpus without any MIDI I/O.
 *
 * Routes for the `describe_device`, `list_params`, and `lookup_lineage`
 * MCP tools.
 */

import { getParamDescription } from '../param-descriptions.js';
import {
  DispatchError,
  type CompatibleTypesResult,
  type DeviceDescriptor,
  type PresetSpec,
} from '../types.js';
import {
  lookupAmpLoudness,
  lookupDriveLoudness,
  type AmpLoudnessEntry,
  type DriveLoudnessEntry,
} from '../../fractal-shared/loudness.js';
import { resolveEnumAlias } from '../cross-device-enums.js';
import { resolveParamAlias } from '../cross-device-aliases.js';
import { summarizeRecipesForPort, type RecipeSummaryEntry } from '../recipes/index.js';

import { requireDevice } from './core.js';
import { resolveBlockName } from './resolvers.js';

/**
 * Pure descriptor-introspection helper for `describe_device`. No I/O —
 * returns the registered capabilities + canonical terms + block roster.
 * The dynamic identity (firmware version, model byte echo) comes from
 * `send_identity_request` (BK-049 Layer 0) and is merged on top of this
 * by the tool handler when available.
 */
export function describeDevice(port: string): {
  device: string;
  id: string;
  capabilities: Omit<DeviceDescriptor['capabilities'], 'preset_location_format'> & {
    preset_location_format?: string;
  };
  canonical_terms: DeviceDescriptor['canonical_terms'];
  blocks: readonly string[];
  block_types: readonly string[];
  agent_guidance?: DeviceDescriptor['agent_guidance'];
  example_spec?: PresetSpec;
  block_params_summary?: DeviceDescriptor['block_params_summary'];
  concept_keys?: DeviceDescriptor['concept_keys'];
  recipes?: readonly RecipeSummaryEntry[];
} {
  const desc = requireDevice(port);
  // RegExp objects serialize to `{}` through JSON.stringify, so MCP agents
  // reading describe_device see an empty capability instead of the actual
  // pattern. Surface the regex source as a string so the field is
  // human-readable in the wire response.
  const { preset_location_format, ...restCapabilities } = desc.capabilities;
  const recipes = summarizeRecipesForPort(desc.id);
  return {
    device: desc.display_name,
    id: desc.id,
    capabilities: {
      ...restCapabilities,
      preset_location_format: preset_location_format?.source,
    },
    canonical_terms: desc.canonical_terms,
    blocks: Object.keys(desc.blocks),
    block_types: desc.block_types ? Object.keys(desc.block_types) : [],
    agent_guidance: desc.agent_guidance,
    example_spec: desc.example_spec,
    block_params_summary: desc.block_params_summary,
    concept_keys: desc.concept_keys,
    recipes: recipes.length > 0 ? recipes : undefined,
  };
}

/**
 * Pure introspection for `list_params(port, block?, name?)`. When `name`
 * is supplied AND the param is an enum, the response carries the full
 * enum table — collapses the legacy `*_list_enum_values` tools into the
 * same surface per BK-051 audit (Session 63).
 *
 * Both `block` and `name` accept either a single string or an array.
 * Passing an array of blocks lets one call cover the multi-block survey
 * an agent does at the start of a tone-build (amp + drive + pitch +
 * reverb in one round-trip instead of four). Passing an array of names
 * returns enum tables for all of them in one call — replaces the
 * per-enum sequential `list_params(block, enumName)` loop the agent
 * was forced into pre-Session 88 (founder's 20-minute harmonized-lead
 * preset session, where 7 of ~40 tool calls were `list_params` for
 * one enum each).
 */
export interface ListParamsEntry {
  block: string;
  name: string;
  display_name: string;
  unit: string;
  display_min?: number;
  display_max?: number;
  has_aliases?: readonly string[];
  enum_values?: Readonly<Record<number, string>>;
  /** Manufacturer UI label (e.g. AM4-Edit's "Master Volume" for `amp.master`). */
  host_label?: string;
  /** Firmware-internal symbolic identifier (e.g. `DISTORT_MASTER`). */
  parameter_name?: string;
  /**
   * Per-block-type applicability annotation when the param is type-gated
   * (e.g. "applies only when amp.type ∈ [Plexi100W, 1959SLP]"). Absent
   * when the param applies universally. Load-bearing for type-gated
   * params on AM4 — writing a gated param on an incompatible type
   * silently no-ops on the device.
   */
  applies_only_when?: string;
  /**
   * Verbatim Blocks Guide / Owner's Manual excerpt describing this
   * param. Present only when the caller passed
   * `include_descriptions: true` AND the maintainer-time extractor
   * produced a clean (block, param) join. Absent (not empty string)
   * otherwise so the agent's JSON parser doesn't render
   * "Description: " with nothing after it.
   *
   * Source: `packages/core/src/protocol-generic/param-descriptions.json`,
   * derived by `scripts/extract-param-descriptions.ts`.
   */
  description?: string;
  /**
   * Per-enum-value loudness offset in dB vs the reference amp/drive,
   * keyed by enum display label (e.g. `"USA IIC+": 6`). Present only
   * when:
   *   - block is `amp` (or `drive`) AND `name` is `type`;
   *   - the caller asked for enum values (passing `name`);
   *   - the lineage loudness corpus has an entry for the
   *     AM4-equivalent label.
   * Reference anchors: amp = Double Verb Normal (Twin Reverb) at
   * master=6 = 0 dB; drive = T808 OD at level=7 = +6 dB.
   *
   * Agents should add this offset on top of the conventional
   * scene-leveling spread when balancing per-amp loudness across
   * scenes (Session 102 bucket 7).
   */
  enum_value_loudness_offsets_db?: Readonly<Record<string, number>>;
}

/**
 * For an `amp.type` or `drive.type` enum table, look up each enum
 * label's loudness offset via the cross-device alias table → AM4
 * canonical name → loudness corpus. Returns `undefined` when no enum
 * label has a corpus hit (so the field is omitted entirely rather
 * than rendered as `{}`).
 *
 * The corpus is keyed by AM4 display names; for II/III labels the
 * concept-key alias table translates first. Devices not in the alias
 * table (no AM4 column) get no offset.
 */
function loudnessOffsetsForEnum(
  port: string,
  block: string,
  paramName: string,
  enumValues: Readonly<Record<number, string>>,
): Readonly<Record<string, number>> | undefined {
  // Each device names the type-enum knob differently (AM4: `type`,
  // II: `effect_type`, III: `type`). Match all known type-knob names so
  // the loudness offsets surface regardless of device dialect.
  if (paramName !== 'type' && paramName !== 'effect_type') return undefined;
  if (block !== 'amp' && block !== 'drive') return undefined;
  const lookup =
    block === 'amp' ? lookupAmpLoudness : lookupDriveLoudness;
  const offsets: Record<string, number> = {};
  for (const label of Object.values(enumValues)) {
    // Translate this device's label to its AM4 canonical form (the
    // corpus key). For AM4 itself the resolver returns the label
    // unchanged when it's already AM4-canonical. Devices missing
    // from the cross-device table fall through to lookup-by-original-
    // label (the corpus might still have a direct match for AM4).
    const am4Label = port === 'am4'
      ? label
      : resolveEnumAlias('am4', block, paramName, label).canonical;
    const entry = lookup(am4Label);
    if (entry === undefined) continue;
    const offset = block === 'amp'
      ? (entry as { relative_loudness_dB: number }).relative_loudness_dB
      : (entry as { boost_response_dB: number }).boost_response_dB;
    offsets[label] = offset;
  }
  return Object.keys(offsets).length > 0 ? offsets : undefined;
}

export function listParams(args: {
  port: string;
  block?: string | readonly string[];
  name?: string | readonly string[];
  include_descriptions?: boolean;
}): {
  device: string;
  blocks: readonly string[];
  params: readonly ListParamsEntry[];
} {
  const desc = requireDevice(args.port);
  const entries: ListParamsEntry[] = [];

  // Resolve the block filter to a canonical-name Set, or undefined for
  // "all blocks". Each input goes through resolveBlockName so callers
  // can pass either canonical slugs or fuzzy display names per device.
  let wantBlocks: Set<string> | undefined;
  if (args.block !== undefined) {
    const inputs = Array.isArray(args.block) ? args.block : [args.block];
    if (inputs.length === 0) {
      throw new DispatchError(
        'value_out_of_range',
        desc.display_name,
        'list_params: `block` array must not be empty. Omit the field to list every block, or pass at least one block name.',
      );
    }
    wantBlocks = new Set(inputs.map((b) => resolveBlockName(desc, b)));
  }

  // Resolve the name filter similarly. When set, the response includes
  // enum tables for every matching name (per the BK-051 convention that
  // an explicit name request returns the full enum payload).
  let wantNames: Set<string> | undefined;
  if (args.name !== undefined) {
    const inputs = Array.isArray(args.name) ? args.name : [args.name];
    if (inputs.length === 0) {
      throw new DispatchError(
        'value_out_of_range',
        desc.display_name,
        'list_params: `name` array must not be empty. Omit the field to list every param in the matched block(s), or pass at least one name.',
      );
    }
    if (wantBlocks === undefined) {
      throw new DispatchError(
        'value_out_of_range',
        desc.display_name,
        'list_params: `name` requires `block` (single or array) so the dispatcher knows where to look up the param. Pass both, or omit `name`.',
      );
    }
    wantNames = new Set(inputs);
  }

  for (const [block, schema] of Object.entries(desc.blocks)) {
    if (wantBlocks !== undefined && !wantBlocks.has(block)) continue;
    const aliasReverse: Record<string, string[]> = {};
    for (const [alias, canonical] of Object.entries(schema.aliases ?? {})) {
      aliasReverse[canonical] ??= [];
      aliasReverse[canonical].push(alias);
    }
    // Build a per-block canonical-name set from the wantNames input,
    // running each requested name through the cross-device alias table
    // so callers using cross-device vocabulary land on the local param.
    // Example: `list_params({port:"axe-fx-ii", block:"amp", name:"type"})`
    // resolves "type" → "effect_type" before the filter runs.
    let canonicalWantNames: Set<string> | undefined;
    if (wantNames !== undefined) {
      canonicalWantNames = new Set<string>();
      for (const input of wantNames) {
        const aliased = resolveParamAlias(args.port, block, input);
        canonicalWantNames.add(aliased.canonical);
      }
    }
    for (const [name, param] of Object.entries(schema.params)) {
      if (canonicalWantNames !== undefined && !canonicalWantNames.has(name)) continue;
      const aliasList = aliasReverse[name];
      const includeEnum =
        wantNames !== undefined && param.enum_values !== undefined;
      const description = args.include_descriptions
        ? getParamDescription(args.port, block, name)
        : undefined;
      const loudnessOffsets = includeEnum && param.enum_values !== undefined
        ? loudnessOffsetsForEnum(args.port, block, name, param.enum_values)
        : undefined;
      entries.push({
        block,
        name,
        display_name: param.display_name,
        unit: param.unit,
        display_min: param.display_min,
        display_max: param.display_max,
        has_aliases: aliasList && aliasList.length > 0 ? aliasList : undefined,
        enum_values: includeEnum ? param.enum_values : undefined,
        host_label: param.host_label,
        parameter_name: param.parameter_name,
        applies_only_when: param.applies_only_when,
        description,
        enum_value_loudness_offsets_db: loudnessOffsets,
      });
    }
  }
  return {
    device: desc.display_name,
    blocks: Object.keys(desc.blocks),
    params: entries,
  };
}

/**
 * Pure introspection for `find_compatible_types`. Given a block and a
 * list of param names, return the subset of `block.type` enum values
 * that expose every listed param.
 *
 * Devices implementing `descriptor.findCompatibleTypes` get the
 * structured answer (AM4 — uses its per-type applicability table).
 * Devices without it fall back to returning the full enum list with
 * `applicability_known: false` so the agent can still see the type
 * roster and treat the result as "unknown — try and see."
 */
export function findCompatibleTypes(args: {
  port: string;
  block: string;
  params: readonly string[];
}): CompatibleTypesResult & { device: string } {
  const desc = requireDevice(args.port);
  const canonicalBlock = resolveBlockName(desc, args.block);
  if (args.params.length === 0) {
    throw new DispatchError(
      'value_out_of_range',
      desc.display_name,
      'find_compatible_types: params array must not be empty. Pass at least one param name to narrow by.',
    );
  }
  if (desc.findCompatibleTypes !== undefined) {
    const result = desc.findCompatibleTypes({
      block: canonicalBlock,
      params: args.params,
    });
    return { ...result, device: desc.display_name };
  }
  // Fallback: surface the type-enum list from descriptor.blocks[block].params.type
  // with applicability_known=false so the agent knows no filtering happened.
  const blockSchema = desc.blocks[canonicalBlock];
  const typeParam = blockSchema?.params['type'];
  const enumValues = typeParam?.enum_values;
  const fullList = enumValues !== undefined ? Object.values(enumValues) : [];
  return {
    device: desc.display_name,
    block: canonicalBlock,
    params_queried: args.params,
    compatible_types: fullList,
    total_types: fullList.length,
    applicability_known: false,
    note: `${desc.display_name} has no structured applicability data for ${canonicalBlock} — returned the full type list. Fall back to list_params + the applies_only_when field.`,
  };
}

/**
 * Pure lookup for `lookup_lineage`. No MIDI I/O — purely a query against
 * the descriptor's static lineage corpus.
 *
 * T-24 (2026-05-21): when `args.name` resolves to an entry in the
 * cross-device loudness corpus (per-amp master sweet-spot + relative
 * loudness, per-drive default level + boost response dB), the response
 * carries structured `loudness` data alongside the text blob. Closes
 * the apply_preset description's loudness-discipline paragraph: agents
 * can call `lookup_lineage` once per amp/drive to get the numbers
 * directly instead of reading the prose from the apply_preset tool
 * description on every session.
 */
export function executeLookupLineage(args: {
  port: string;
  block_type: string;
  name?: string;
  real_gear?: string;
  manufacturer?: string;
  model?: string;
  include_quotes?: boolean;
}): {
  device: string;
  ok: boolean;
  text: string;
  loudness?: AmpLoudnessEntry | DriveLoudnessEntry;
  loudness_kind?: 'amp' | 'drive';
} {
  const descriptor = requireDevice(args.port);
  if (!descriptor.capabilities.supports_lineage) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} does not have a lineage corpus.`,
    );
  }
  if (descriptor.reader.lookupLineage === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `lookup_lineage is not implemented for ${descriptor.display_name}.`,
    );
  }
  const result = descriptor.reader.lookupLineage(args);
  // T-24 (cross-device fix, 2026-05-21 follow-up): attach structured
  // loudness data when the caller's name+block resolve to a corpus
  // entry. The corpus is keyed by AM4 display names, so II / III
  // callers passing a device-local enum string (e.g. "USA IIC+" on
  // II vs "USA MK IIC+" on AM4) need translation through the
  // cross-device enum alias table first. Mirrors the
  // listParams.loudnessOffsetsForEnum pattern at line 154 of this file.
  let loudness: AmpLoudnessEntry | DriveLoudnessEntry | undefined;
  let loudnessKind: 'amp' | 'drive' | undefined;
  if (typeof args.name === 'string' && args.name.length > 0) {
    const blockTypeLower = args.block_type.toLowerCase();
    const isAmpQuery = blockTypeLower === 'amp' || blockTypeLower.startsWith('amp ');
    const isDriveQuery = blockTypeLower === 'drive' || blockTypeLower.startsWith('drive ');
    if (isAmpQuery || isDriveQuery) {
      // Translate this device's enum label to its AM4 canonical form
      // (the corpus key). For AM4 callers the resolver returns the
      // label unchanged when it's already AM4-canonical. Devices
      // missing from the cross-device table fall through to lookup-
      // by-original-label so a direct match still hits.
      const paramName = isAmpQuery ? 'type' : 'type';
      const am4Label = args.port === 'am4'
        ? args.name
        : resolveEnumAlias('am4', isAmpQuery ? 'amp' : 'drive', paramName, args.name).canonical;
      const entry = isAmpQuery
        ? lookupAmpLoudness(am4Label) ?? lookupAmpLoudness(args.name)
        : lookupDriveLoudness(am4Label) ?? lookupDriveLoudness(args.name);
      if (entry !== undefined) {
        loudness = entry;
        loudnessKind = isAmpQuery ? 'amp' : 'drive';
      }
    }
  }
  return {
    ...result,
    device: descriptor.display_name,
    ...(loudness !== undefined ? { loudness, loudness_kind: loudnessKind } : {}),
  };
}
