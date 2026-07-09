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
  type PresetClass,
  type PresetSpec,
  type SupportTier,
  type TransportKind,
} from '../types.js';
import { listRegisteredDevices } from '../registry.js';
import { getRigLinks, type RigLinks } from '../rigLinks.js';
import { listMidiPorts } from '../../midi/transport.js';
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
 * One device in the `describe_rig` roster: enough for an orchestrating agent to
 * see the whole stage and plan against what is actually present, without opening
 * any handle. `port` is `id` / `name` (either drives the unified tools).
 */
export interface RigDevice {
  id: string;
  name: string;
  /** Best-effort: a matching MIDI port is present, or a storage drive is mounted. */
  connected: boolean;
  /** How `connected` was determined (the matched MIDI port name, or the mounted root). */
  via?: string;
  transport: TransportKind;
  preset_class: PresetClass;
  support_tier: SupportTier;
  /** True when the device accepts `apply_pattern` (has pattern realizers). */
  pattern_target: boolean;
  /** One-line capability summary (first sentence of the device's agent guidance). */
  summary?: string;
}

/** First sentence of a guidance blob, bounded, for the rig overview. */
function firstSentence(s: string): string {
  const m = s.match(/^[\s\S]*?[.!?](\s|$)/);
  const out = (m ? m[0] : s).trim();
  return out.length > 200 ? `${out.slice(0, 197)}...` : out;
}

/**
 * Whole-rig overview for `describe_rig`. Pure introspection over the device
 * registry plus a NON-OPENING port scan (`listMidiPorts` opens and immediately
 * releases short-lived enumeration handles) and a mounted-drive check
 * (`transport.resolveRoot`). Opens no device handle, so it never contends with a
 * live connection. The orchestrating agent calls this first to see every device
 * it can drive + which are present, then drives each by `port` (= id / name).
 */
export function executeDescribeRig(): {
  total_registered: number;
  connected_count: number;
  devices: readonly RigDevice[];
  /** Configured external-instrument wiring (host track → device), when set via MCP_RIG_LINKS. */
  rig_links?: RigLinks;
  note: string;
} {
  // A serial-only environment (no native MIDI binding) makes listMidiPorts throw;
  // degrade to "no MIDI ports visible" rather than failing the whole overview.
  let ports: { name: string }[] = [];
  try {
    const { inputs, outputs } = listMidiPorts();
    ports = [...inputs, ...outputs];
  } catch {
    ports = [];
  }
  const portMatches = (desc: DeviceDescriptor, name: string): boolean =>
    desc.port_match.some((m) =>
      m.pattern instanceof RegExp
        ? m.pattern.test(name)
        : name.toLowerCase().includes(String(m.pattern).toLowerCase()),
    );

  const devices: RigDevice[] = listRegisteredDevices().map((desc) => {
    const transport = desc.transport?.kind ?? 'midi';
    let connected = false;
    let via: string | undefined;
    if (transport === 'storage' || transport === 'hybrid') {
      const root = desc.transport?.resolveRoot?.();
      if (root !== undefined) {
        connected = true;
        via = `mounted drive (${root})`;
      }
    }
    if (!connected && transport !== 'storage') {
      const hit = ports.find((p) => portMatches(desc, p.name));
      if (hit) {
        connected = true;
        via = `MIDI port "${hit.name}"`;
      }
    }
    const summary = desc.agent_guidance?.capability_summary;
    return {
      id: desc.id,
      name: desc.display_name,
      connected,
      via,
      transport,
      preset_class: desc.preset_class ?? 'layout',
      support_tier: desc.capabilities.support_tier ?? 'verified',
      pattern_target: (desc.capabilities.pattern_realizers?.length ?? 0) > 0,
      summary: summary !== undefined ? firstSentence(summary) : undefined,
    };
  });

  const rigLinks = getRigLinks();
  const hasLinks = Object.keys(rigLinks).length > 0;
  return {
    total_registered: devices.length,
    connected_count: devices.filter((d) => d.connected).length,
    devices,
    ...(hasLinks ? { rig_links: rigLinks } : {}),
    note:
      (hasLinks
        ? 'rig_links records external-instrument wiring (a host MIDI track → the device it drives); '
          + 'apply_pattern external_targets defaults a target\'s track from it. '
        : '')
      + 'connected is best-effort from a non-opening port scan plus a mounted-drive check; it opens no handles. '
      + 'Serial devices (FM3) are not visible to the MIDI scan, so a plugged-in FM3 can read connected:false here; '
      + 'confirm with describe_device(port) or list_midi_ports. Drive any device by passing its id or name as `port`.',
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
  block?: readonly string[];
  name?: readonly string[];
  include_descriptions?: boolean;
}): {
  device: string;
  blocks: readonly string[];
  params: readonly ListParamsEntry[];
} {
  const desc = requireDevice(args.port);
  const entries: ListParamsEntry[] = [];

  // `block` and `name` are arrays-only (batch-only). Pass `["amp"]` for one
  // block, `["amp","drive","reverb"]` for many. Single-string form was
  // removed to keep one consistent schema and discourage the N+1 pattern.
  let wantBlocks: Set<string> | undefined;
  if (args.block !== undefined) {
    if (args.block.length === 0) {
      throw new DispatchError(
        'value_out_of_range',
        desc.display_name,
        'list_params: `block` must be a non-empty array. Omit the field to list every block, or pass at least one block name (e.g. `["amp"]`).',
      );
    }
    wantBlocks = new Set(args.block.map((b) => resolveBlockName(desc, b)));
  }

  // When `name` is set, the response includes enum tables for every
  // matching name (per the BK-051 convention that an explicit name request
  // returns the full enum payload).
  let wantNames: Set<string> | undefined;
  if (args.name !== undefined) {
    if (args.name.length === 0) {
      throw new DispatchError(
        'value_out_of_range',
        desc.display_name,
        'list_params: `name` must be a non-empty array. Omit the field to list every param in the matched block(s), or pass at least one name (e.g. `["type"]`).',
      );
    }
    if (wantBlocks === undefined) {
      throw new DispatchError(
        'value_out_of_range',
        desc.display_name,
        'list_params: `name` requires `block` so the dispatcher knows where to look up the param. Pass both, or omit `name`.',
      );
    }
    wantNames = new Set(args.name);
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
  // Fallback: surface the type-enum list from the block's type-selector param
  // with applicability_known=false so the agent knows no filtering happened.
  // Device dialects name the type-enum knob differently — AM4/III call it
  // `type`, Axe-Fx II calls it `effect_type` — so try both (BUG-9: II falsely
  // reported "no type enum for reverb" because only `type` was checked).
  const blockSchema = desc.blocks[canonicalBlock];
  const typeParam = blockSchema?.params['type'] ?? blockSchema?.params['effect_type'];
  const enumValues = typeParam?.enum_values;
  const fullList = enumValues !== undefined ? Object.values(enumValues) : [];
  // Bug J in the alpha.13 report: the note used to claim "returned the
  // full type list" even when fullList was empty (blocks without a
  // type-enum surface — e.g. Hydrasynth's reverb is a single FX block
  // with sub-params, not a typed slot). Make the note honest by case-
  // splitting on whether a list was actually returned.
  const note = fullList.length > 0
    ? `${desc.display_name} has no structured applicability data for ${canonicalBlock} — returned the full type list (no filtering by the params you queried). Fall back to list_params + the applies_only_when field on each param.`
    : `${desc.display_name} doesn't expose a typed "type" enum for ${canonicalBlock}. No type list available to filter; call list_params({port:"${desc.id}", block:"${canonicalBlock}"}) to see the full param surface and the per-param applies_only_when gates.`;
  return {
    device: desc.display_name,
    block: canonicalBlock,
    params_queried: args.params,
    compatible_types: fullList,
    total_types: fullList.length,
    applicability_known: false,
    note,
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
export interface LookupLineageEntry {
  name: string;
  ok: boolean;
  text: string;
  loudness?: AmpLoudnessEntry | DriveLoudnessEntry;
  loudness_kind?: 'amp' | 'drive';
}

export function executeLookupLineage(args: {
  port: string;
  block_type: string;
  name?: readonly string[];
  real_gear?: string;
  manufacturer?: string;
  model?: string;
  include_quotes?: boolean;
}): {
  device: string;
  ok: boolean;
  text: string;
} | {
  device: string;
  entries: readonly LookupLineageEntry[];
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

  // Forward-by-name lookup is array-only — every forward call returns
  // `{ entries: [...] }` with one entry per requested name, even when N=1.
  // Single-string was removed to keep one response shape per branch (the
  // schema's signal that batching is the path, not an optional optimization).
  if (args.name !== undefined) {
    if (args.name.length === 0) {
      throw new DispatchError(
        'value_out_of_range',
        descriptor.display_name,
        'lookup_lineage: `name` must be a non-empty array. Pass at least one name (e.g. `["USA IIC+"]`), or omit `name` to use real_gear / manufacturer / model.',
      );
    }
    const entries: LookupLineageEntry[] = args.name.map((n) => {
      const result = descriptor.reader.lookupLineage!({
        block_type: args.block_type,
        name: n,
        include_quotes: args.include_quotes,
      });
      const { loudness, loudness_kind } = computeLoudnessAttachment(args.port, args.block_type, n);
      return {
        name: n,
        ok: result.ok,
        text: result.text,
        ...(loudness !== undefined ? { loudness, loudness_kind } : {}),
      };
    });
    return { device: descriptor.display_name, entries };
  }

  // Reverse (real_gear) and structured (manufacturer/model) branches
  // match at most one record by design — they return the flat shape.
  const result = descriptor.reader.lookupLineage({
    block_type: args.block_type,
    real_gear: args.real_gear,
    manufacturer: args.manufacturer,
    model: args.model,
    include_quotes: args.include_quotes,
  });
  return {
    ...result,
    device: descriptor.display_name,
  };
}

// T-24 (cross-device fix, 2026-05-21 follow-up): attach structured
// loudness data when the caller's name+block resolve to a corpus entry.
// The corpus is keyed by AM4 display names, so II / III callers passing
// a device-local enum string (e.g. "USA IIC+" on II vs "USA MK IIC+" on
// AM4) need translation through the cross-device enum alias table first.
function computeLoudnessAttachment(
  port: string,
  blockType: string,
  name: string,
): { loudness?: AmpLoudnessEntry | DriveLoudnessEntry; loudness_kind?: 'amp' | 'drive' } {
  const blockTypeLower = blockType.toLowerCase();
  const isAmpQuery = blockTypeLower === 'amp' || blockTypeLower.startsWith('amp ');
  const isDriveQuery = blockTypeLower === 'drive' || blockTypeLower.startsWith('drive ');
  if (!isAmpQuery && !isDriveQuery) return {};
  const am4Label = port === 'am4'
    ? name
    : resolveEnumAlias('am4', isAmpQuery ? 'amp' : 'drive', 'type', name).canonical;
  const entry = isAmpQuery
    ? lookupAmpLoudness(am4Label) ?? lookupAmpLoudness(name)
    : lookupDriveLoudness(am4Label) ?? lookupDriveLoudness(name);
  if (entry === undefined) return {};
  return { loudness: entry, loudness_kind: isAmpQuery ? 'amp' : 'drive' };
}
