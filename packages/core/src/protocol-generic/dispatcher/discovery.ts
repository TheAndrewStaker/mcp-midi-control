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
} from '../types.js';

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
} {
  const desc = requireDevice(port);
  // RegExp objects serialize to `{}` through JSON.stringify, so MCP agents
  // reading describe_device see an empty capability instead of the actual
  // pattern. Surface the regex source as a string so the field is
  // human-readable in the wire response.
  const { preset_location_format, ...restCapabilities } = desc.capabilities;
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
    for (const [name, param] of Object.entries(schema.params)) {
      if (wantNames !== undefined && !wantNames.has(name)) continue;
      const aliasList = aliasReverse[name];
      const includeEnum =
        wantNames !== undefined && param.enum_values !== undefined;
      const description = args.include_descriptions
        ? getParamDescription(args.port, block, name)
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
 */
export function executeLookupLineage(args: {
  port: string;
  block_type: string;
  name?: string;
  real_gear?: string;
  manufacturer?: string;
  model?: string;
  include_quotes?: boolean;
}): { device: string; ok: boolean; text: string } {
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
  return { ...result, device: descriptor.display_name };
}
