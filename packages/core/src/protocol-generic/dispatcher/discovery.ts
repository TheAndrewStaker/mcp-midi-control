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
import { resolveRigLinks, rigLinksSource, type RigLinks } from '../rigLinks.js';
import { loadRigManifest } from '../openrig/manifest.js';
import { loadRigInventory } from '../openrig/inventory.js';
import { descriptorCapabilityLookup } from '../openrig/capabilities.js';
import {
  validateRig, checkRigCompatibility, checkAudioOutput, checkRigCapacity, validateInventory, crossReferenceInventory,
  type ValidationIssue, type CompatibilityReport, type AudioOutputReport, type CapacityReport,
  type InventoryIssue, type InventoryReport,
} from 'openrig';
import { listMidiPorts } from '../../midi/transport.js';
import {
  lookupAmpLoudness,
  lookupDriveLoudness,
  type AmpLoudnessEntry,
  type DriveLoudnessEntry,
} from '../../fractal-shared/loudness.js';
import { resolveEnumAlias } from '../cross-device-enums.js';
import { resolveParamAlias } from '../cross-device-aliases.js';
import {
  summarizeRecipesForPort,
  describeRecipeForPort,
  type RecipeDetailEntry,
  type RecipeSummaryEntry,
} from '../recipes/index.js';

import { requireDevice } from './core.js';
import { resolveBlockName } from './resolvers.js';

/**
 * MODEL-FACING SIZE CEILING for one `describe_device` response, measured in
 * COMPACT JSON characters (`JSON.stringify(response).length` — no indentation,
 * because that is what a host actually counts).
 *
 * THIS IS NOT A STYLE BUDGET. It is a hard cliff:
 *
 *   A tool result over 50,000 characters is not delivered to the model at all.
 *   The host replaces the WHOLE result with a path to a sidecar file, and an
 *   MCP-only agent (Claude Desktop, and this repo's own regression harness,
 *   which runs `claude -p --tools ""`) has no filesystem tool with which to
 *   open it.
 *
 * 50,000 IS MEASURED, TO THE CHARACTER (2026-08-02, by
 * `scripts/probe-host-delivery-cliff.ts`): a synthetic MCP server returning
 * exactly N compact chars, driven through `claude -p`, bisects to 50,000
 * delivered / 50,001 not, identically for low- and high-entropy payloads. It
 * supersedes an inferred 51,200 that was 1,200 chars too high. Every one of the
 * 24 replaced results in 651 traces came from this one tool.
 *
 * WHAT IT COST. `cab_polish` was added to the AM4's guidance on 2026-07-17 and
 * pushed its response from 46,000 to 51,233 chars. From that run onward the
 * model received 2,000 characters of a 51 KB payload — the AM4's entire 36 KB
 * of curated `agent_guidance` and its whole `recipes[]` surface stopped
 * reaching the model, silently, on every AM4 session. The visible symptom was
 * `am4-recipe-block-stack-pickup` going from five passes at 2-3 tool calls to
 * 17 / 9 / 13 calls with the prompt byte-identical: the agent announced it
 * would look for a curated recipe, called `describe_device`, and never
 * mentioned recipes again. It had not ignored them. It had never seen them.
 *
 * THIS BUDGET HAS ZERO MARGIN: it IS the cliff, exactly. Safe by construction
 * rather than by luck — the loop below measures `JSON.stringify(candidate)
 * .length` over the WHOLE assembled response, which is the same quantity the
 * host counts (it quotes our own character count back in its refusal), and
 * nothing is merged onto the response after this function returns. But know it
 * before you touch it: there is nothing spare for a host that counts even
 * slightly differently. If this ever needs a cushion, take it HERE, by lowering
 * this number — never by loosening the gate that checks it.
 *
 * Raising it is not an option. 50,001 delivers nothing.
 *
 * Going over this budget costs you ONE named guidance topic, and the agent is
 * told which one and how to fetch it. Going over the host's costs you the
 * entire response with no error and no signal.
 */
const DESCRIBE_DEVICE_BUDGET_CHARS = 50_000;

/**
 * Guidance topics, ordered for delivery. `recipe_usage` leads: it is the topic
 * that tells the agent to match the request against `recipes[]` and apply by
 * id in one call, so it is the topic whose burial the whole recipe-pickup
 * defect is about. On the AM4 it had drifted to key #23 of 24. Everything
 * else keeps its authored order.
 */
function orderGuidanceTopics(
  guidance: Readonly<Record<string, string>>,
): [string, string][] {
  const entries = Object.entries(guidance);
  const lead = entries.filter(([k]) => k === 'recipe_usage');
  const rest = entries.filter(([k]) => k !== 'recipe_usage');
  return [...lead, ...rest];
}

/**
 * Pure descriptor-introspection helper for `describe_device`. No I/O —
 * returns the registered capabilities + canonical terms + block roster.
 * The dynamic identity (firmware version, model byte echo) comes from
 * `send_identity_request` (BK-049 Layer 0) and is merged on top of this
 * by the tool handler when available.
 *
 * When a device's guidance does not fit the budget above, the withheld topics
 * are named in `agent_guidance_withheld` and fetched via
 * `describeDeviceGuidance` (`describe_device({port, guidance:true})`).
 */
export function describeDevice(port: string): {
  // KEY ORDER HERE MIRRORS EMISSION ORDER. This type is the closest thing to a
  // spec for a response whose field order is load-bearing (see below); keep the
  // two in step so the declaration cannot quietly disagree with the wire.
  device: string;
  id: string;
  agent_guidance_withheld?: { topics: readonly string[]; note: string };
  recipes?: readonly RecipeSummaryEntry[];
  capabilities: Omit<DeviceDescriptor['capabilities'], 'preset_location_format'> & {
    preset_location_format?: string;
  };
  canonical_terms: DeviceDescriptor['canonical_terms'];
  blocks: readonly string[];
  block_types: readonly string[];
  example_spec?: PresetSpec;
  block_params_summary?: DeviceDescriptor['block_params_summary'];
  concept_keys?: DeviceDescriptor['concept_keys'];
  agent_guidance?: DeviceDescriptor['agent_guidance'];
} {
  const desc = requireDevice(port);
  // RegExp objects serialize to `{}` through JSON.stringify, so MCP agents
  // reading describe_device see an empty capability instead of the actual
  // pattern. Surface the regex source as a string so the field is
  // human-readable in the wire response.
  const { preset_location_format, ...restCapabilities } = desc.capabilities;
  const recipes = summarizeRecipesForPort(desc.id);
  // FIELD ORDER IS LOAD-BEARING. `describe_device` is the mandatory first call
  // for any device question, and JSON.stringify emits keys in insertion order,
  // so this literal decides where each surface lands in a 25-50 KB response.
  // `recipes[]` is the ONE surface an agent must act on immediately (match the
  // request to a curated id, then `apply_preset({recipe_id})` in a single
  // call); everything below it is reference material the agent consults after
  // it has decided what to do.
  //
  // Emitted last, recipes[] sat 71-78% into the payload on am4/fm3/fm9 and
  // pickup went dark. Moving it here — zero bytes added, zero content removed —
  // took `fm9-recipe-platform-pickup` from fail to pass at 4 tool calls and
  // `am4-recipe-block-stack-pickup` from 17/9/13 calls to 4. Keep `recipes`
  // immediately after the two identity fields; do NOT reorder it back down for
  // tidiness. Ordering is also what the MCP spec (rev 2026-07-28) is
  // acknowledging when it asks servers to return tools deterministically.
  return fitGuidanceToBudget(
    desc,
    { device: desc.display_name, id: desc.id },
    {
      ...(recipes.length > 0 ? { recipes } : {}),
      capabilities: {
        ...restCapabilities,
        preset_location_format: preset_location_format?.source,
      },
      canonical_terms: desc.canonical_terms,
      blocks: Object.keys(desc.blocks),
      block_types: desc.block_types ? Object.keys(desc.block_types) : [],
      example_spec: desc.example_spec,
      block_params_summary: desc.block_params_summary,
      concept_keys: desc.concept_keys,
    },
  );
}

/**
 * Assemble the final response, admitting as much `agent_guidance` as fits
 * under DESCRIBE_DEVICE_BUDGET_CHARS.
 *
 * Withholding is largest-topic-first, so the fewest topics are held back: on
 * the AM4 exactly one (`loudness`, 10.8 KB, whose numbers `lookup_lineage`
 * already returns as structured data) buys 10 KB of headroom and the other 23
 * topics ship inline. Nothing is deleted or rewritten — the withheld topics
 * are named and one call away.
 *
 * The guidance block is emitted AFTER `concept_keys` (it is prose the agent
 * consults while authoring, not something it acts on immediately), and the
 * withheld notice is emitted immediately before it so the agent meets the
 * pointer at the same place it would have met the missing text.
 */
function fitGuidanceToBudget(
  desc: DeviceDescriptor,
  head: { device: string; id: string },
  tail: Record<string, unknown>,
): ReturnType<typeof describeDevice> {
  const guidance = desc.agent_guidance;
  const assemble = (
    kept: readonly [string, string][],
    withheld: readonly string[],
  ): Record<string, unknown> => ({
    ...head,
    // The notice goes THIRD, ahead of everything it points past. Emitted next
    // to the guidance it replaces it landed 98.5% into the Hydrasynth's
    // payload — the exact position this whole change exists to stop shipping
    // things at. It costs ~450 bytes and pushes recipes[] from 0.1% to 1.2%.
    ...(withheld.length > 0
      ? {
        agent_guidance_withheld: {
          topics: [...withheld],
          note:
            `${withheld.length} guidance topic(s) are not inline here: this response would otherwise exceed the `
            + `tool-result size limit some MCP hosts enforce, above which the host replaces the WHOLE payload with a `
            + `2,000-character preview and you would lose everything below it, recipes[] included. Read them by `
            + `passing the topics array above: describe_device({port:"${desc.id}", guidance:[...topics]}). Do that `
            + `before authoring a tone if one of them bears on what you are about to change.`,
        },
      }
      : {}),
    ...tail,
    ...(kept.length > 0 ? { agent_guidance: Object.fromEntries(kept) } : {}),
  });

  if (guidance === undefined) {
    return assemble([], []) as ReturnType<typeof describeDevice>;
  }

  const kept = orderGuidanceTopics(guidance);
  const withheld: string[] = [];
  for (;;) {
    const candidate = assemble(kept, withheld);
    // Measure COMPACT, not pretty-printed: a host counts the payload, not our
    // indentation, and `asText` re-serializes for the wire anyway.
    if (JSON.stringify(candidate).length <= DESCRIBE_DEVICE_BUDGET_CHARS) {
      return candidate as ReturnType<typeof describeDevice>;
    }
    // `recipe_usage` is exempt. It is the topic `orderGuidanceTopics` force-
    // leads BECAUSE it is the one that tells the agent to match recipes[] and
    // apply by id, so evicting it to save ~1.2 KB would spend the exact
    // capability this change was made to restore. Ordering a topic first for
    // importance and then evicting it purely by size is a contradiction.
    let biggest = -1;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i][0] === 'recipe_usage') continue;
      if (biggest === -1 || kept[i][1].length > kept[biggest][1].length) biggest = i;
    }
    // Nothing left that may be evicted. Returning over budget is wrong but it
    // is the honest outcome: the excess is no longer in guidance, so the fix
    // is elsewhere (on the Hydrasynth, 93% of the payload is recipes[]).
    // `scripts/verify-describe-device-budget.ts` runs in preflight and fails
    // hard on exactly this, so it cannot ship unnoticed.
    if (biggest === -1) return candidate as ReturnType<typeof describeDevice>;
    withheld.push(kept[biggest][0]);
    kept.splice(biggest, 1);
  }
}

/**
 * The fetch path for guidance the budget withheld:
 * `describe_device({port, guidance:true})` for everything, or
 * `describe_device({port, guidance:["loudness"]})` for named topics.
 *
 * PREFER THE NAMED FORM, and the withheld notice hands the agent exactly the
 * list to pass. `true` re-sends the whole corpus: on the AM4 that is 36 KB to
 * recover the one 10.8 KB topic the budget held back, so blanket refetch costs
 * MORE than the unbudgeted response it replaced. The named form costs what the
 * missing topic costs.
 *
 * Returns the notes and nothing else, so the rest of the payload cannot push
 * this path over any limit. An unknown topic name is reported rather than
 * silently dropped, so a typo does not read as "the device has no such
 * guidance."
 */
export function describeDeviceGuidance(port: string, topics?: readonly string[]): {
  device: string;
  id: string;
  agent_guidance: DeviceDescriptor['agent_guidance'];
  unknown_topics?: readonly string[];
  note?: string;
} {
  const desc = requireDevice(port);
  const guidance = desc.agent_guidance;
  if (guidance === undefined) {
    return {
      device: desc.display_name,
      id: desc.id,
      agent_guidance: undefined,
      note: `${desc.display_name} declares no agent_guidance. Call describe_device({port:"${desc.id}"}) for its capabilities, blocks and recipes.`,
    };
  }
  const ordered = orderGuidanceTopics(guidance);
  const wanted = topics === undefined || topics.length === 0
    ? ordered
    : ordered.filter(([k]) => topics.includes(k));
  const unknown = (topics ?? []).filter((t) => guidance[t] === undefined);
  return {
    device: desc.display_name,
    id: desc.id,
    agent_guidance: Object.fromEntries(wanted),
    ...(unknown.length > 0 ? { unknown_topics: unknown } : {}),
    ...(unknown.length > 0
      ? { note: `No such guidance topic on ${desc.display_name}: ${unknown.join(', ')}. Known topics: ${Object.keys(guidance).join(', ')}.` }
      : {}),
  };
}

/**
 * The detail path for what the recipe SUMMARY leaves out:
 * `describe_device({port, recipe:"<id>"})`.
 *
 * Same bargain as `describeDeviceGuidance`, one surface over. `recipes[]`
 * in the default response is sized for MATCHING — enough to choose an id and
 * apply it. This returns everything else the recipe was authored with, for the
 * two questions that only arise once an id is chosen:
 *
 *   - "where did these settings come from?" → `source_notes`, the maintainer's
 *     citation provenance. It is authored on every Hydrasynth archetype but
 *     costs 687 chars each, so it is served here rather than 36 times inline.
 *   - "what will this actually do before I commit?" → the full authored knobs
 *     (`full_params` + `mod_routes` / `macro_routes` on a Hydrasynth archetype,
 *     `slots` on a block stack).
 *
 * APPLYING still goes by id — `apply_patch({recipe_id})` /
 * `apply_preset({recipe_id})` materialize server-side. Nothing returned here
 * needs to be echoed back, and re-authoring it by hand is the failure mode the
 * recipe surface exists to prevent.
 *
 * An unknown id lists the ids that ARE available on this port rather than
 * refusing flatly: an agent that gets a bare "no such recipe" reliably falls
 * back to hand-authoring the tone.
 */
export function describeDeviceRecipe(port: string, recipeId: string): {
  device: string;
  id: string;
  recipe?: RecipeDetailEntry;
  available_recipe_ids?: readonly string[];
  note: string;
} {
  const desc = requireDevice(port);
  const detail = describeRecipeForPort(desc.id, recipeId);
  if (detail === undefined) {
    const available = summarizeRecipesForPort(desc.id).map((r) => r.id);
    return {
      device: desc.display_name,
      id: desc.id,
      available_recipe_ids: available,
      note: available.length === 0
        ? `${desc.display_name} has no curated recipes, so there is no '${recipeId}' to describe. Author the tone directly.`
        : `No recipe '${recipeId}' on ${desc.display_name}. The ids above are what this device ships; pick one, or author the tone directly. Do not retry with a guessed id.`,
    };
  }
  return {
    device: desc.display_name,
    id: desc.id,
    recipe: detail,
    note:
      `Full authored definition of '${recipeId}'. This is for reading. To APPLY it, pass the id `
      + `(${desc.id === 'hydrasynth' ? 'apply_patch({recipe_id})' : 'apply_preset({recipe_id})'}) and the server `
      + 'materializes these values itself; re-sending them by hand is slower and drifts. `source_notes` is the '
      + "maintainer's citation provenance for the knob values, and is the field to quote when the user asks where a "
      + 'tone comes from.',
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
 * The OpenRig rig manifest as `describe_rig` surfaces it (OPENRIG-SCHEMA.md §6):
 * a summary of the declared rig plus its validation and an HONESTLY-SCOPED drift
 * report. The server can only confirm registered-device PRESENCE; it cannot see
 * cables, channels, opaque nodes, or audio, so drift is presence-only and never
 * claims to "validate topology".
 */
export interface RigManifestSummary {
  /** True when MCP_RIG_MANIFEST is set (even if the file failed to load). */
  configured: boolean;
  /** The manifest path, when configured. */
  source?: string;
  /** Set when the configured file could not be read / parsed. */
  error?: string;
  id?: string;
  name?: string;
  node_count?: number;
  edge_count?: number;
  binding_count?: number;
  /** Pure structural + graph validation of the manifest (openrig validateRig). */
  validation?: { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };
  /**
   * Cross-device binding COMPATIBILITY (openrig checkRigCompatibility, §4): do
   * the declared cross-device contracts line up (channels/CC/notes agree at both
   * ends), and are they legal for the gear (a CC the RC-505 can source, a note
   * an SPD-SX pad answers)? Distinct from `validation` (graph well-formedness):
   * this is whether the coordination will actually WORK. Per-binding status +
   * a flat issue list; capability-legality runs against the registered
   * descriptors (voice_map / external_tracks / control_sources). Static only:
   * it never reads a device; live hardware verify is a separate opt-in surface.
   */
  compatibility?: CompatibilityReport;
  /**
   * The easy "will I actually hear this instrument?" check (openrig
   * checkAudioOutput): for each sound-producing instrument, does its audio reach
   * the rig's output stage (a monitor / front-of-house node) following the
   * patched audio cables? Catches a synth/sampler whose audio out is not plugged
   * in (no_output) or whose chain dead-ends before front-of-house (dead_end).
   * Pure topology; audio cables are declared, not server-observable, so this
   * checks the DECLARED wiring, not the physical patch.
   */
  audio?: AudioOutputReport;
  /**
   * "Where is there room to plug something in" (openrig checkRigCapacity):
   * free-vs-used-vs-reserved for every port, plus `free_by_kind` so "is there a
   * spare midi_din_out anywhere" is a lookup rather than a graph walk. READ THIS
   * BEFORE proposing a daisy chain, a thru box, or any other fan-out workaround:
   * a free port on an existing device is a shorter path than all of them, and
   * missing one is exactly the 2026-07-25 failure this check was added for (a
   * sequencer's second DIN out sat free and labelled "unused" while the answer
   * given was to chain through another synth). A port claimed only by a
   * `[planned]` (enabled:false) cable reads `reserved`, not free, so it is never
   * double-booked. Advisory: a fully patched rig is normal, so issues are
   * warnings and `ok:false` is not a failure.
   */
  capacity?: CapacityReport;
  /** Presence-only declared-vs-connected drift (§6). */
  drift?: {
    /** Manifest devices whose descriptor is registered AND connected right now. */
    declared_present: string[];
    /** Manifest devices registered but not connected (planned/off/unplugged; FM3 serial reads absent). */
    declared_absent: string[];
    /** Manifest server_device_ids with no registered descriptor (renamed/absent → node degrades to opaque). */
    unresolved_server_device_ids: string[];
    /** Connected registered devices the manifest does not declare. */
    connected_not_declared: string[];
    /** Opaque nodes (no server_device_id): passive/unsupported gear the server can't see. */
    opaque_node_count: number;
  };
}

/**
 * The OpenRig INVENTORY as `describe_rig` surfaces it (§11): what the user OWNS,
 * independent of the rig's wiring, plus (when a rig manifest is also loaded) a
 * cross-reference of which owned gear is IN the active rig vs SPARE. Configured
 * via `MCP_RIG_INVENTORY`. Inventory is the superset; a rig is one wiring of a
 * subset of it. The rig PROPOSER (owned gear -> candidate rigs -> scored by the
 * checks) is deliberately NOT a tool: the agent composes it from these facts.
 */
export interface RigInventorySummary {
  configured: boolean;
  source?: string;
  error?: string;
  id?: string;
  name?: string;
  device_count?: number;
  validation?: { ok: boolean; errors: InventoryIssue[]; warnings: InventoryIssue[] };
  /** In-rig vs spare cross-reference. Present only when a rig manifest is also loaded. */
  report?: InventoryReport;
}

/**
 * Build the manifest summary for `describe_rig`. Returns undefined when no
 * manifest is configured (the field is then omitted). `devices` is the already
 * computed rig roster, so presence checks reuse it without a second scan.
 */
function buildRigManifestSummary(devices: readonly RigDevice[]): RigManifestSummary | undefined {
  const loaded = loadRigManifest();
  if (loaded.status === 'unconfigured') return undefined;
  if (loaded.status === 'error') return { configured: true, source: loaded.source, error: loaded.error };

  const rig = loaded.rig;
  const validation = validateRig(rig);
  const compatibility = checkRigCompatibility(rig, { capabilities: descriptorCapabilityLookup() });
  const audio = checkAudioOutput(rig);
  const capacity = checkRigCapacity(rig);
  const connectedIds = new Set(devices.filter((d) => d.connected).map((d) => d.id));
  const registeredIds = new Set(devices.map((d) => d.id));

  const declared_present: string[] = [];
  const declared_absent: string[] = [];
  const unresolved: string[] = [];
  const declaredDeviceIds = new Set<string>();
  let opaque = 0;
  for (const node of rig.nodes) {
    const sid = node.server_device_id ?? undefined;
    if (sid === undefined) {
      opaque++;
      continue;
    }
    // Drift is keyed per DEVICE (server_device_id), not per node: two physical
    // units of one supported model are two nodes sharing one server_device_id
    // (validateRig only requires node.id to be unique), so classify each distinct
    // sid once to avoid an inflated ['am4','am4'] present/absent list.
    if (declaredDeviceIds.has(sid)) continue;
    declaredDeviceIds.add(sid);
    if (!registeredIds.has(sid)) unresolved.push(sid);
    else if (connectedIds.has(sid)) declared_present.push(sid);
    else declared_absent.push(sid);
  }
  const connected_not_declared = [...connectedIds].filter((id) => !declaredDeviceIds.has(id));

  return {
    configured: true,
    source: loaded.source,
    id: rig.id,
    name: rig.name,
    node_count: rig.nodes.length,
    edge_count: rig.edges.length,
    binding_count: rig.bindings?.length ?? 0,
    validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
    compatibility,
    audio,
    capacity,
    drift: {
      declared_present,
      declared_absent,
      unresolved_server_device_ids: unresolved,
      connected_not_declared,
      opaque_node_count: opaque,
    },
  };
}

/**
 * Build the inventory summary for `describe_rig` (§11). Returns undefined when
 * `MCP_RIG_INVENTORY` is unset. When a rig manifest is ALSO loaded, includes the
 * in-rig-vs-spare cross-reference so the agent can see which owned gear is wired
 * and which is on the shelf (the raw material for an agent-composed proposer).
 */
function buildRigInventorySummary(): RigInventorySummary | undefined {
  const loaded = loadRigInventory();
  if (loaded.status === 'unconfigured') return undefined;
  if (loaded.status === 'error') return { configured: true, source: loaded.source, error: loaded.error };

  const inventory = loaded.inventory;
  const validation = validateInventory(inventory);
  const manifest = loadRigManifest();
  const report = manifest.status === 'loaded' ? crossReferenceInventory(inventory, manifest.rig) : undefined;
  return {
    configured: true,
    source: loaded.source,
    id: inventory.id,
    name: inventory.name,
    device_count: inventory.devices.length,
    validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
    report,
  };
}

/**
 * Whole-rig overview for `describe_rig`. Pure introspection over the device
 * registry plus a NON-OPENING port scan (`listMidiPorts` opens and immediately
 * releases short-lived enumeration handles) and a mounted-drive check
 * (`transport.resolveRoot`). Opens no device handle, so it never contends with a
 * live connection. The orchestrating agent calls this first to see every device
 * it can drive + which are present, then drives each by `port` (= id / name).
 *
 * When an OpenRig rig manifest is configured (MCP_RIG_MANIFEST), the response
 * also carries `manifest` (the declared rig + validation + presence-only drift)
 * and `rig_links` is DERIVED from it rather than the MCP_RIG_LINKS env var
 * (OPENRIG-SCHEMA.md §4).
 */
export function executeDescribeRig(): {
  total_registered: number;
  connected_count: number;
  devices: readonly RigDevice[];
  /** The declared OpenRig rig (manifest + validation + drift), when MCP_RIG_MANIFEST is set. */
  manifest?: RigManifestSummary;
  /** What the user OWNS (+ in-rig-vs-spare cross-reference), when MCP_RIG_INVENTORY is set. */
  inventory?: RigInventorySummary;
  /** External-instrument wiring (host track → device): manifest-derived, else MCP_RIG_LINKS. */
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

  const manifest = buildRigManifestSummary(devices);
  const inventory = buildRigInventorySummary();
  const rigLinks = resolveRigLinks();
  const hasLinks = Object.keys(rigLinks).length > 0;
  const linksSource = rigLinksSource() === 'manifest' ? 'the rig manifest' : 'MCP_RIG_LINKS';

  let manifestNote: string;
  if (manifest === undefined) {
    manifestNote =
      'No rig manifest is configured. Set MCP_RIG_MANIFEST to an OpenRig rig.json (or run `npm run openrig:bootstrap` '
      + 'to seed one from the connected devices) to declare the cabling, channels, and cross-device bindings the '
      + 'server cannot see. ';
  } else if (manifest.error !== undefined) {
    manifestNote = `A rig manifest is configured but failed to load: ${manifest.error}. `;
  } else {
    const v = manifest.validation;
    const health = v?.ok === false
      ? `${v.errors.length} error(s)`
      : (v && v.warnings.length > 0 ? `${v.warnings.length} warning(s)` : 'clean');
    const c = manifest.compatibility;
    let compatNote = '';
    // An ungoverned cable carries no binding, so its legality issues are keyed by
    // edge (`ref`, no `binding`) and no bindings[] entry counts them. Surface them
    // alongside, or a binding-less rig reads "clean" while a cable is illegal.
    const cableIssues = c?.issues.filter((i) => i.binding === undefined && i.severity === 'error').length ?? 0;
    if (c !== undefined && (c.bindings.length > 0 || cableIssues > 0)) {
      const parts: string[] = [];
      if (c.bindings.length > 0) {
        const mismatched = c.bindings.filter((b) => b.status === 'mismatch').length;
        parts.push(mismatched > 0
          ? `${mismatched} of ${c.bindings.length} cross-device binding(s) DO NOT line up`
          : `all ${c.bindings.length} cross-device binding(s) line up`);
      }
      if (cableIssues > 0) parts.push(`${cableIssues} cable(s) carry a mapping the receiving device cannot use`);
      compatNote =
        `Compatibility: ${parts.join(', and ')}; see manifest.compatibility (per-binding status + capability-legality against `
        + `the descriptors). This is whether the coordination will WORK, not just whether the graph is well-formed. `;
    }
    const a = manifest.audio;
    let audioNote = '';
    if (a !== undefined && a.instruments.length > 0) {
      if (a.has_output_node === false) {
        audioNote =
          'Audio: no front-of-house / output (monitor) node is declared, so instrument audio reachability could not '
          + 'be judged; add an OUT node to the manifest to check. See manifest.audio. ';
      } else {
        const unheard = a.instruments.filter((i) => i.status !== 'reaches_output').length;
        audioNote = unheard > 0
          ? `Audio: ${unheard} of ${a.instruments.length} instrument(s) will NOT reach front-of-house (audio unpatched, or the chain dead-ends before the output); see manifest.audio. `
          : `Audio: all ${a.instruments.length} instrument(s) reach front-of-house; see manifest.audio. `;
      }
    }
    manifestNote =
      `A rig manifest "${manifest.name}" is loaded (${manifest.node_count} devices, ${manifest.edge_count} connections, `
      + `${manifest.binding_count} binding(s), validation ${health}); see manifest.validation + manifest.drift. `
      + compatNote
      + audioNote
      + `Drift is presence-only: the server confirms registered-device presence, not cables/channels/opaque gear/audio. `;
  }

  let inventoryNote = '';
  if (inventory !== undefined && inventory.error !== undefined) {
    inventoryNote = `A gear inventory is configured but failed to load: ${inventory.error}. `;
  } else if (inventory !== undefined && inventory.report !== undefined) {
    inventoryNote = `Inventory "${inventory.name ?? inventory.id}": you own ${inventory.device_count} device(s); ${inventory.report.in_rig} wired into this rig, ${inventory.report.spare} spare. See inventory.report for owned gear + in-rig-vs-spare (the raw material for proposing rigs from what you own). `;
  } else if (inventory !== undefined) {
    inventoryNote = `Inventory "${inventory.name ?? inventory.id}" loaded (${inventory.device_count} owned device(s)); no rig manifest to cross-reference against. `;
  }

  return {
    total_registered: devices.length,
    connected_count: devices.filter((d) => d.connected).length,
    devices,
    ...(manifest !== undefined ? { manifest } : {}),
    ...(inventory !== undefined ? { inventory } : {}),
    ...(hasLinks ? { rig_links: rigLinks } : {}),
    note:
      manifestNote
      + inventoryNote
      + (hasLinks
        ? `rig_links records external-instrument wiring (a host MIDI track → the device it drives), sourced from ${linksSource}; `
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
   * Per-block-type applicability annotation when the param is type-gated.
   * Absent when the param applies universally. Load-bearing for type-gated
   * params on AM4: writing a gated param on an incompatible type silently
   * no-ops on the device.
   *
   * The example here used to read "applies only when amp.type ∈ [Plexi100W,
   * 1959SLP]", a format nothing has ever emitted; a census of all 440 AM4
   * applicability keys returns six real shapes and none of them is that one.
   * The live shapes, so this comment can be checked rather than trusted:
   *
   *   "applies on 9 of 248 amp types: Friedman BE | Friedman HBE | ..."
   *   "applies on 246 of 248 amp types, every type EXCEPT: USA JP IIC+ Red | ..."
   *   "applies on 166 of 248 amp types. Call find_compatible_types(...) ..."
   *   "applies to any amp type; behaviour varies by sub-mode (CABINET_MODE)"
   *
   * TWO RENDERINGS SHARE THIS KEY, keyed off `scope`: block scope gets the
   * match-time form (which may replace a long roster with a pointer), param
   * scope gets the lossless one that names every applicable type. Values are
   * joined with " | " and NOT with commas, because enum names contain commas
   * (69 of the AM4's 79 reverb types do) and these strings must be
   * reproducible verbatim as `set_param` arguments.
   */
  applies_only_when?: string;
  /**
   * Caveat about the strength of the evidence for this param's wire address
   * (e.g. a CC number transcribed from a third-party mirror rather than the
   * vendor's own table). Absent when the address is vendor-documented or
   * hardware-confirmed.
   */
  evidence_note?: string;
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

/**
 * MODEL-FACING SIZE CEILING for one `list_params` response, in compact JSON
 * characters, the same quantity `describeDevice` budgets and the same
 * quantity the host counts.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT 50,000. Measured 2026-08-02, before the
 * projection below landed: TEN of sixteen registered devices returned MORE
 * than the host's 50,000-char delivery cliff on the unfiltered call (fm9
 * 280,045; axe-fx-iii 264,553; fm3 254,289; am4 219,691; …), and the AM4
 * exceeded it on a correctly-FILTERED one: `block:["amp"]` alone was 67,731.
 * Past the cliff the model receives none of it: no error, no warning, a
 * sidecar path an MCP-only agent has no tool to open. `list_params` is the
 * tool the agent is told to call "when unsure of an enum spelling", and on
 * the two devices with the deepest catalogs it had never once answered.
 * (Corroborated independently: all 13 token-capped results in the trace
 * corpus are `list_params`.)
 *
 * `describe_device` budgets at exactly the cliff because its ration loop
 * trades margin against a named guidance topic, so spending margin there costs
 * the user something. Nothing is traded here: this response is reference
 * data with a natural continuation (`offset`), so a page boundary costs one
 * cheap follow-up call and buys 10,000 characters of headroom against a host
 * that counts even slightly differently. Take the margin.
 */
const LIST_PARAMS_BUDGET_CHARS = 40_000;

/** Serialized size of one entry, including the comma that joins it. */
function entryCost(entry: ListParamsEntry): number {
  return JSON.stringify(entry).length + 1;
}

/**
 * Room held back for the `truncated` block itself. It is only emitted once the
 * rows have already been fitted, so without a reservation the note could push
 * a response that just fit back over the budget. That is the classic off-by-one that
 * makes a size gate pass while the host still drops the payload. ~420 chars of
 * note plus the counts; 600 covers it with room for the longest device id.
 */
const TRUNCATION_NOTE_RESERVE = 600;

/**
 * Per-block census for the no-filter call. Answers "what is on this device
 * and roughly how big is it", which is enough to choose a `block`, without
 * serializing a single param row.
 */
export interface ListParamsBlockSummary {
  block: string;
  display_name: string;
  param_count: number;
  /**
   * The name of this block's type-selector knob (`type` / `effect_type`),
   * when it has one. The agent needs it to ask for the enum roster, and the
   * two spellings are a real cross-device divergence (BUG-9).
   */
  type_selector?: string;
  /** Number of values in that type selector's enum, when it has one. */
  type_count?: number;
}

export interface ListParamsResult {
  device: string;
  blocks: readonly string[];
  /**
   * Which projection produced this response.
   *   `summary`     no `block` filter: per-block census, no param rows.
   *   `block`       `block` given: match-time param rows.
   *   `param`       `block` + `name`: everything, including enum tables.
   */
  scope: 'summary' | 'block' | 'param';
  /** How to get the next level of detail. Present on every response. */
  next: string;
  params: readonly ListParamsEntry[];
  block_summary?: readonly ListParamsBlockSummary[];
  /**
   * How many params THIS CALL'S FILTER MATCHED. Never how many the response
   * carried, and never unconditionally the device total.
   *
   * At `summary` scope the filter is empty, so it matches the whole device
   * (AM4: 894). At `block` / `param` scope it is the count for the requested
   * blocks and names (AM4 `amp`: 217). One definition, but the number moves a
   * lot between scopes, so read `scope` alongside it. When `truncated` is
   * present, `truncated.total` restates this same figure next to how many rows
   * actually shipped.
   */
  total_params?: number;
  truncated?: {
    returned: number;
    total: number;
    next_offset: number;
    note: string;
  };
}

export function listParams(args: {
  port: string;
  block?: readonly string[];
  name?: readonly string[];
  include_descriptions?: boolean;
  offset?: number;
  limit?: number;
}): ListParamsResult {
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

  // ── scope `summary`: no block filter ──────────────────────────────────
  //
  // The unfiltered call used to serialize EVERY param on the device, which on
  // ten of sixteen devices produced a response the model never received. A
  // census answers the question the unfiltered call is actually asked
  // ("what's on here, where do I look next?") in ~2% of the characters, and
  // is a real answer rather than a refusal. `am4-discovery-amp-models`
  // tolerates a no-filter call as a fallback path, so erroring here would
  // turn a working-if-wasteful route into a dead one.
  if (wantBlocks === undefined) {
    const summary: ListParamsBlockSummary[] = [];
    let totalParams = 0;
    for (const [block, schema] of Object.entries(desc.blocks)) {
      const names = Object.keys(schema.params);
      totalParams += names.length;
      // Device dialects name the type knob differently (AM4/gen-3 `type`,
      // Axe-Fx II `effect_type`), and checking only one is BUG-9.
      const selector = schema.params['type'] !== undefined
        ? 'type'
        : (schema.params['effect_type'] !== undefined ? 'effect_type' : undefined);
      const enumValues = selector === undefined ? undefined : schema.params[selector].enum_values;
      summary.push({
        block,
        display_name: schema.display_name,
        param_count: names.length,
        type_selector: selector,
        type_count: enumValues === undefined ? undefined : Object.keys(enumValues).length,
      });
    }
    return {
      device: desc.display_name,
      // `blocks` carries the device's full roster at EVERY scope, including
      // this one, where it duplicates `block_summary[].block`.
      //
      // It was briefly emitted as `[]` here to avoid that duplication (~900
      // chars on the VE-500's 68 blocks). That was wrong: `resolvers.ts`
      // answers an unknown-block error with `valid_options_tool:
      // "list_params(port)"` and "call list_params for the full block list",
      // so an agent arriving from that error found the key it was sent for,
      // empty. One key meaning two things across scopes costs an agent more
      // than the bytes save.
      blocks: Object.keys(desc.blocks),
      scope: 'summary',
      next: `Census only, no param rows. Pass \`block\` for the knobs in one or more blocks (e.g. list_params({port:"${desc.id}", block:["${summary[0]?.block ?? 'amp'}"]})), and \`block\`+\`name\` for a specific param's full enum table and applicability. Batch several blocks in one call.`,
      params: [],
      block_summary: summary,
      total_params: totalParams,
    };
  }

  for (const [block, schema] of Object.entries(desc.blocks)) {
    if (!wantBlocks.has(block)) continue;
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
      // POST-CHOICE FIELDS, served only at `param` scope. `host_label` (the
      // vendor editor's wording) and `parameter_name` (the firmware symbol,
      // `DISTORT_LEVEL`) are for cross-referencing a knob you have ALREADY
      // identified against a manual or a capture; neither is needed to write
      // one, and neither helps pick between two knobs by name. They are also
      // 15-16% of a gen-3 param-scope row. `parameter_name` alone is 26,358 chars
      // across the FM9 and 27,713 across the III. `evidence_note` is
      // provenance, read after a value looks wrong, not while choosing.
      const paramScope = wantNames !== undefined;
      entries.push({
        block,
        name,
        display_name: param.display_name,
        unit: param.unit,
        display_min: param.display_min,
        display_max: param.display_max,
        has_aliases: aliasList && aliasList.length > 0 ? aliasList : undefined,
        enum_values: includeEnum ? param.enum_values : undefined,
        host_label: paramScope ? param.host_label : undefined,
        parameter_name: paramScope ? param.parameter_name : undefined,
        // At param scope give the lossless gate; at block scope the
        // match-time one. See ParamSchema.applies_only_when_full.
        //
        // `|| undefined` because a CONFIRMED-universal param renders as the
        // empty string (that is `describeApplicability`'s way of saying "data
        // exists, no gate"), and serializing `"applies_only_when":""` both
        // contradicts this field's documented "absent when it applies
        // universally" contract and spends 24 characters per row saying
        // nothing: 61 of the AM4 amp block's 96 annotated params are in that
        // state.
        applies_only_when: (paramScope
          ? (param.applies_only_when_full ?? param.applies_only_when)
          : param.applies_only_when) || undefined,
        evidence_note: paramScope ? param.evidence_note : undefined,
        description,
        enum_value_loudness_offsets_db: loudnessOffsets,
      });
    }
  }

  // ── budget + pagination ───────────────────────────────────────────────
  //
  // Projection alone is not a guarantee: a device can register a block whose
  // rows exceed the budget on their own, and a silent overflow here is
  // exactly the failure this whole change is about. So the rows are FITTED,
  // and what did not fit is REPORTED with the argument that fetches it. An
  // agent that reads `truncated` can continue; one that ignores it still got
  // a complete, well-formed prefix rather than nothing at all.
  const total = entries.length;
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const limit = args.limit === undefined ? undefined : Math.max(1, Math.trunc(args.limit));
  const requested = entries.slice(offset, limit === undefined ? undefined : offset + limit);

  const scope: 'block' | 'param' = wantNames !== undefined ? 'param' : 'block';
  const next = scope === 'param'
    ? 'Full detail for the named param(s). `enum_values` here are the exact strings set_param accepts; copy one verbatim.'
    : `Match-time rows. For one param's enum table, applicability in full, and its vendor/firmware labels, add \`name\` (e.g. list_params({port:"${desc.id}", block:["${[...wantBlocks][0]}"], name:["type"]})).`;

  // Everything outside `params` is fixed-size; measure it once and spend the
  // remainder on rows.
  const envelope: ListParamsResult = {
    device: desc.display_name,
    blocks: Object.keys(desc.blocks),
    scope,
    next,
    params: [],
    total_params: total,
  };
  let budget = LIST_PARAMS_BUDGET_CHARS - JSON.stringify(envelope).length - TRUNCATION_NOTE_RESERVE;
  const fitted: ListParamsEntry[] = [];
  for (const entry of requested) {
    const cost = entryCost(entry);
    // Always emit at least one row: a single param bigger than the whole
    // budget is a catalog problem to surface, not a reason to return silence.
    if (budget - cost < 0 && fitted.length > 0) break;
    budget -= cost;
    fitted.push(entry);
  }

  const consumedTo = offset + fitted.length;
  const result: ListParamsResult = { ...envelope, params: fitted };

  // An `offset` past the end returns zero rows, and zero rows with no
  // explanation is indistinguishable from "this block has no params", which is the
  // exact silent-empty shape `verify-list-params-budget.ts` calls a failure
  // when it sees it on the paging path. Say what happened and how to recover,
  // rather than letting a mis-paged agent conclude the catalog is empty.
  if (fitted.length === 0 && total > 0) {
    result.truncated = {
      returned: 0,
      total,
      next_offset: 0,
      note:
        `No rows: offset ${offset} is past the last of ${total} matching params. `
        + 'Re-read from offset:0, or drop `offset` entirely. A `truncated.next_offset` is only '
        + 'valid for the SAME filter that produced it; changing `block` or `name` renumbers the rows.',
    };
    return result;
  }

  if (consumedTo < total) {
    // Name the ACTUAL cause. `limit` cutting the page is the caller getting
    // what they asked for; the budget cutting it is the response hitting a
    // ceiling they did not set. Telling an agent its own `limit:3` was a size
    // problem invites it to "fix" the call by narrowing further.
    const byLimit = limit !== undefined && fitted.length >= limit;
    result.truncated = {
      returned: fitted.length,
      total,
      next_offset: consumedTo,
      note:
        `Showing params ${offset + 1}-${consumedTo} of ${total}; `
        + (byLimit
          ? `stopped at the \`limit\` of ${limit} you passed. `
          : `the rest did not fit the ${LIST_PARAMS_BUDGET_CHARS}-character response budget. `)
        + `Call again with offset:${consumedTo} for the next page, `
        + 'or narrow the request: a `block` filter with fewer blocks, or `name` for the specific knobs you need, '
        + 'is usually faster than paging.',
    };
  }
  return result;
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

/**
 * The forward path's share of the host's 50,000-char delivery cliff.
 *
 * WHY THIS EXISTS AT ALL. The REVERSE branch has been capped at 10 hits since
 * it was written (`matches.slice(0, 10)`, fractal-midi/src/shared/
 * lineageLookup.ts) and measures 8-12 KB even on a one-letter substring. The
 * FORWARD branch, the one the tool description tells agents to batch, had no
 * cap of any kind: it materialised one full record per requested name. The
 * whole AM4 amp roster measured 219,171 chars, the Axe-Fx II and AX8 rosters
 * 182,114, and the crossing is at FORTY-TWO amp names, which is a smaller
 * batch than the description invites. Past the cliff the host hands the model
 * a sidecar path it has no tool to open, so those calls returned nothing at
 * all. `include_quotes:false` did not rescue it either (117,451 on the same
 * AM4 roster).
 *
 * 40,000 rather than the cliff itself, matching LIST_PARAMS_BUDGET_CHARS and
 * for the same reason: this is reference data with a natural continuation, so
 * a page boundary costs one cheap follow-up call, and 10,000 characters of
 * headroom is worth buying against a host that may count slightly differently.
 * `describe_device` is the one surface that budgets at exactly the cliff,
 * because every character IT gives back costs a named guidance topic.
 */
const LOOKUP_LINEAGE_BUDGET_CHARS = 40_000;

/**
 * Room held back for the `truncated` block, which is composed only after the
 * entries have been fitted and would otherwise push a just-fitting response
 * back over. Same off-by-one that TRUNCATION_NOTE_RESERVE guards on
 * `list_params`, sized the same way.
 */
const LINEAGE_TRUNCATION_RESERVE = 600;

export interface LookupLineageForwardResult {
  device: string;
  entries: readonly LookupLineageEntry[];
  truncated?: {
    returned: number;
    total: number;
    next_offset: number;
    note: string;
  };
}

export function executeLookupLineage(args: {
  port: string;
  block_type: string;
  name?: readonly string[];
  real_gear?: string;
  manufacturer?: string;
  model?: string;
  include_quotes?: boolean;
  offset?: number;
}): {
  device: string;
  ok: boolean;
  text: string;
} | LookupLineageForwardResult {
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
    const total = args.name.length;
    const offset = Math.min(Math.max(0, Math.trunc(args.offset ?? 0)), total);

    // Fit rather than project. A roster small enough to fit today is one
    // authored quote away from not fitting tomorrow, and the failure mode is
    // silent: the agent asks for 42 amps and receives nothing, with no error
    // to react to. So the entries are built one at a time and stopped at the
    // budget, and what did not fit is reported WITH the argument that fetches
    // it. An agent that reads `truncated` continues; one that ignores it still
    // holds a complete, well-formed prefix instead of a blackout.
    const envelope = { device: descriptor.display_name, entries: [] as LookupLineageEntry[] };
    let budget = LOOKUP_LINEAGE_BUDGET_CHARS - JSON.stringify(envelope).length - LINEAGE_TRUNCATION_RESERVE;
    const entries: LookupLineageEntry[] = [];
    for (let i = offset; i < total; i++) {
      const n = args.name[i];
      const result = descriptor.reader.lookupLineage!({
        block_type: args.block_type,
        name: n,
        include_quotes: args.include_quotes,
      });
      const { loudness, loudness_kind } = computeLoudnessAttachment(args.port, args.block_type, n);
      const entry: LookupLineageEntry = {
        name: n,
        ok: result.ok,
        text: result.text,
        ...(loudness !== undefined ? { loudness, loudness_kind } : {}),
      };
      const cost = JSON.stringify(entry).length + 1;
      // Always emit at least one entry: a single record larger than the whole
      // budget is a corpus problem to surface, not a reason to return silence.
      if (budget - cost < 0 && entries.length > 0) break;
      budget -= cost;
      entries.push(entry);
    }

    const consumedTo = offset + entries.length;
    const result: LookupLineageForwardResult = { device: descriptor.display_name, entries };

    // An `offset` past the last requested name returns zero entries, and zero
    // entries with no explanation reads as "none of these have lineage", which
    // is a different and wrong answer. Say what happened.
    if (entries.length === 0 && total > 0) {
      result.truncated = {
        returned: 0,
        total,
        next_offset: 0,
        note:
          `No entries: offset ${offset} is past the last of the ${total} names you passed. `
          + 'Re-read from offset:0, or drop `offset`. A `truncated.next_offset` is only valid for the '
          + 'SAME `name` array that produced it; changing the array renumbers the entries.',
      };
      return result;
    }

    if (consumedTo < total) {
      result.truncated = {
        returned: entries.length,
        total,
        next_offset: consumedTo,
        note:
          `Showing names ${offset + 1}-${consumedTo} of the ${total} you passed; the rest did not fit the `
          + `${LOOKUP_LINEAGE_BUDGET_CHARS}-character response budget. Call again with offset:${consumedTo} for the next page. `
          + 'Batching is still the right instinct, and nothing was lost: this is a response ceiling, not a request one. '
          + 'If you only need the level numbers, `include_quotes:false` fits noticeably more names per page.',
      };
    }
    return result;
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
