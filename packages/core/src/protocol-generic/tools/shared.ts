/**
 * Shared helpers and zod sub-schemas for the BK-051 unified tool surface.
 *
 * Every family file under `src/protocol/generic/tools/` imports these helpers
 *, `PORT_DESC` (the canonical description string for the `port` argument),
 * `asText` / `asError` (MCP response shapers), and `presetSlotShape` /
 * `presetSceneShape` / `presetShape` (zod schemas reused by apply_preset and
 * apply_setlist).
 */

import * as z from 'zod/v4';

import { DispatchError } from '../types.js';
import { listRegisteredDevices } from '../registry.js';

/**
 * `port` is on THIRTY tools, so every character here is paid thirty times in
 * `tools/list` — 8,100 chars at its old length, the largest single duplication
 * on the surface and 4.7% of everything the model reads before it can call
 * anything.
 *
 * Kept: the three accepted forms, with one example each, because that is what
 * the agent needs to fill the argument in. Dropped: "call describe_device(port)
 * to confirm capabilities", which is not about this argument at all — it is a
 * session-start instruction, already stated (more forcefully) in the server
 * `instructions` block and again in describe_device's own description. It was
 * being re-sent on twenty-nine tools that are not describe_device.
 */
export const PORT_DESC =
  'Which device to address: its id ("am4", "axe-fx-ii"), display name ' +
  '("Fractal AM4"), or a MIDI port-name substring ("AM4 MIDI 1"). ' +
  'list_midi_ports shows what is connected.';

/**
 * THE `pack` ARGUMENT, stated once for the seven tools that take one.
 *
 * Seven copies of this concept measured ~5,000 chars of `tools/list` between
 * them, restating the same four facts in seven different orders, and every
 * session paid for all seven before the first tool call. What stays here is
 * only what the agent needs to CHOOSE the argument: how the number maps to the
 * front panel, the default, that packs do not share slots, and that the server
 * cannot read the selection off the device.
 *
 * What was REMOVED is not lost — it was already stated where it is actually
 * needed, and was duplicated here:
 *   - the ~6-8 s manifest-flush read-back window lives in the Circuit's
 *     `agentGuidance.ts`, in `descriptor.ts`, AND in the `list_samples` result
 *     text itself, which is where an agent hits it;
 *   - the drum-binding/pool alignment rule lives in the `drum_binding`
 *     argument, which is the argument it constrains.
 * Per-tool clauses below add only what is genuinely tool-specific.
 *
 * The consolidation also CORRECTED two of the seven copies. `scan_locations`
 * and `list_samples` both claimed `pack` is "ignored on packless devices"; it
 * is not. `openCtx` calls `assertPackSupported` on every pack-addressed op, so
 * a packless device REFUSES pack > 1 with `capability_not_supported`. Seven
 * hand-written copies of one behaviour is how two of them end up describing
 * behaviour the server does not have.
 */
export const PACK_DESC =
  'Circuit Tracks microSD pack, numbered as the front panel shows it (pack:5 = "Pack 5"). ' +
  'Default 1. Packs are separate worlds: the same slot number in another pack is a ' +
  'different project. The server cannot see which pack the device has selected, so pass it ' +
  'explicitly; list_packs names them. Packless devices refuse pack > 1.';

/**
 * Shared snippet for tools whose description references the curated top-N
 * knob list on `describe_device.block_params_summary`. Single source so
 * the wording stays in sync across tools (describe_device tool itself,
 * list_params, set_param, apply_preset, etc.).
 */
export const BLOCK_PARAMS_SUMMARY_HINT =
  'For the most-commonly-used knobs per block (first-page knobs the player ' +
  'adjusts daily), read `describe_device(port).block_params_summary` first; ' +
  'it covers ~80% of tone-building writes in one round-trip. Call ' +
  '`list_params(port, block)` for the full universe (advanced page params, ' +
  'GEQ bands, modifier wiring, exhaustive enum tables).';

/**
 * Shape a unified-surface tool result. Returns both:
 *   - `content`, human-readable text (the stringified payload), kept
 *     for back-compat with agents that read text responses verbatim.
 *   - `structuredContent`, the typed object payload, per the 2025
 *     MCP spec. Agents that consume structuredContent get the typed
 *     object directly instead of having to re-parse a JSON string.
 *
 * String payloads (already textual, no structure) skip structuredContent.
 *
 * BOTH COPIES STAY. The MCP spec asks a server returning structuredContent to
 * also return functionally-equivalent unstructured content for hosts that do
 * not read the structured field. Dropping the text block would save local
 * stdio bytes and nothing else, at the cost of breaking every such host.
 *
 * THE TEXT COPY IS COMPACT, NOT PRETTY-PRINTED (2026-08-02). It carried a
 * 2-space indent until this change. Measured consequences of removing it:
 *
 *   - Model-facing: NONE. Claude Code discards this text block whenever
 *     `structuredContent` is present and hands the model
 *     `JSON.stringify(structuredContent)` instead. Measured over the 661-trace
 *     corpus in `scripts/agent-regression/traces/`: 1,783 of 1,783 results
 *     carrying structuredContent had host content byte-identical to the
 *     COMPACT serialization, and not one of the 1,760 JSON results the model
 *     actually received was indented. The indent has never reached a model.
 *   - Size accounting: NONE, in the same host. Both size limits Claude Code
 *     enforces quote the compact length back at us — the 13 token-limit
 *     errors in the corpus state a character count that matches
 *     compact(structuredContent) exactly, 13 for 13, and never the indented
 *     length (which runs 20-24% higher on those payloads).
 *
 * SO WHY CHANGE IT. Because "the host counts the structured copy" was an
 * assumption the whole `describe_device` budget rested on, and it is only
 * verified for ONE host. Indented, this text block ran 2.2-24% larger than the
 * number `verify-describe-device-budget.ts` gates on — and axe-fx-ii, the
 * largest device, sat at 47,921 compact but 59,165 indented, i.e. comfortably
 * under the 50,000-char delivery cliff on one metric and well over it
 * on the other. Any host that counts or forwards the TEXT copy instead would
 * have blacked out the II with the budget gate still reporting green.
 *
 * Emitting the text copy compact collapses that divergence to zero: both
 * copies are now the same length, so the gate's number is correct no matter
 * which field a host measures. That is the reason for this change. The ~15%
 * saving on the local stdio pipe is real but worth nothing on its own.
 */
export function asText(payload: unknown): {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
} {
  if (typeof payload === 'string') {
    return { content: [{ type: 'text', text: payload }] };
  }
  const text = JSON.stringify(payload);
  // structuredContent must be a JSON object (record). Arrays and
  // primitives don't qualify per the spec, only emit the field when
  // the payload is a plain object.
  const isPlainObject = typeof payload === 'object'
    && payload !== null
    && !Array.isArray(payload);
  return isPlainObject
    ? { content: [{ type: 'text', text }], structuredContent: payload as Record<string, unknown> }
    : { content: [{ type: 'text', text }] };
}

/**
 * Duck-typed structured-candidates check. Device packages throw their
 * own typed errors (e.g. AM4's `EnumAmbiguityError`) that core can't
 * `instanceof`-check without importing them. The shape contract is:
 * `err.candidates: readonly string[]` is the structured candidate list
 * the agent should pick from. When present, surface it as
 * `Valid options:` in the response text (same shape DispatchError uses).
 *
 * DO NOT "clean this up" with `instanceof EnumAmbiguityError`. Core
 * (this package) sits below the device packages in the dependency
 * graph; importing AM4's / II's / III's / Hydra's error classes here
 * would invert the layering and create a cycle. The duck-typed shape
 * check is the cross-package import boundary; T-16 (Session
 * 2026-05-21) marked this comment after a senior review flagged the
 * pattern as cleanup-bait. Future agents reading this: leave it alone.
 */
function structuredCandidates(err: unknown): readonly string[] | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const c = (err as { candidates?: unknown }).candidates;
  if (!Array.isArray(c)) return undefined;
  return c.every((x) => typeof x === 'string') ? (c as string[]) : undefined;
}

export function asError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  let text: string;
  if (err instanceof DispatchError) {
    const parts = [`${err.message}`];
    if (err.details?.suggestion) parts.push(`Suggestion: ${err.details.suggestion}.`);
    if (err.details?.valid_options) parts.push(`Valid options: ${err.details.valid_options.join(', ')}.`);
    if (err.details?.valid_options_tool) parts.push(`See: ${err.details.valid_options_tool}.`);
    if (err.details?.retry_action) parts.push(err.details.retry_action);
    if (err.details?.validation_errors && err.details.validation_errors.length > 0) {
      const lines = err.details.validation_errors.map((e, i) => {
        const optsClause = e.valid_options && e.valid_options.length > 0
          ? ` (valid_options: ${e.valid_options.join(', ')})`
          : '';
        return `  [${i + 1}] ${e.path}: ${e.error}${optsClause}`;
      });
      parts.push(`Validation errors (${err.details.validation_errors.length}):\n${lines.join('\n')}`);
    }
    text = parts.join(' ');
  } else if (err instanceof Error) {
    const parts = [err.message];
    const candidates = structuredCandidates(err);
    if (candidates !== undefined && candidates.length > 0) {
      parts.push(`Valid options: ${candidates.join(', ')}.`);
    }
    text = parts.join(' ');
  } else {
    text = String(err);
  }
  return { content: [{ type: 'text', text }], isError: true };
}

// ── Block-type schema union (BK-086 Option A) ───────────────────────
//
// At server boot, after every device descriptor is registered (see
// `packages/server-all/src/server/index.ts` — `registerMcpDevice`
// runs BEFORE `registerUnifiedTools`), we union every registered
// descriptor's legal `block_type` inputs into a single Zod enum and
// stamp it onto every tool that takes a `block_type` argument.
//
// Why a runtime union, not a static list:
//   - Each device contributes its own `block_types` (AM4: bare slugs
//     like 'amp'; Axe-Fx II: indexed slugs like 'amp 1'). The legal
//     set is the union of both forms across every registered device.
//   - New devices added later get picked up automatically the next
//     time the server boots. No hand-maintained list to fall stale.
//
// What goes in:
//   - `Object.keys(desc.block_types)` for every descriptor that
//     declares a non-empty `block_types`. Devices with empty
//     `block_types` (Axe-Fx III, Hydrasynth) don't support set_block
//     today, so they contribute nothing to the placement vocabulary.
//   - `Object.keys(desc.blocks)` for those same descriptors, to
//     cover the bare-slug form (II's `block_types` only carries
//     indexed slugs; bare `amp` resolves at the writer via group-
//     code lookup but is still a valid agent input).
//
// What this catches vs. the prior `z.string()` shape:
//   - Schema-layer rejects unknown block_type strings BEFORE the
//     dispatcher allocates a writer / opens a port. The error path
//     today is "tool call → dispatcher → preflight reject"; with
//     the enum the rejection lands in the MCP layer itself with
//     valid-options surfaced inline by Zod.
//   - Reduces the "agent guesses a block_type name" retry loop
//     measured in prod logs (~13/1005 tool calls = 1.3%).
//
// Edge case: if NO devices are registered (e.g. unit-test boot with
// an empty registry), fall back to `z.string()` so we don't crash
// the boot loop with an empty z.enum.

/**
 * Indexed display-form slugs (e.g. "amp 1" / "amp 2" / "reverb 2") were
 * historically pulled from device.block_types into the cross-device
 * block_type union. They misled agents: a `block_type: "amp 2"` parses
 * cleanly through the schema but the preflight resolver only knows the
 * bare slug `amp` (with `instance: 2` for the second instance). Real-
 * world failure 2026-05-23: agent authored `block_type: "amp 2"` after
 * the schema accepted it, then hit "unknown block_type 'amp 2'" at
 * preflight.
 *
 * The canonical path is `block_type: "amp"` + `instance: 2`. The space-
 * separated indexed form remains accepted in error-message
 * SUGGESTIONS (so the descriptor's resolver still teaches the agent
 * what to use), but is NOT in the schema enum.
 */
function isIndexedDisplaySlug(slug: string): boolean {
  return / \d+$/.test(slug);
}

export function buildBlockTypeUnion(): readonly string[] {
  const out = new Set<string>();
  for (const desc of listRegisteredDevices()) {
    if (!desc.block_types) continue;
    const placementKeys = Object.keys(desc.block_types);
    if (placementKeys.length === 0) continue;
    for (const k of placementKeys) {
      // Skip indexed display-form slugs (`"amp 1"`, `"reverb 2"`,
      // etc.). Canonical authoring path is `(block_type, instance)`.
      if (isIndexedDisplaySlug(k)) continue;
      out.add(k);
    }
    // Add bare-slug forms (II canonical input is 'amp'; block_types
    // for II carries indexed 'amp 1' / 'amp 2' but the writer
    // accepts the bare slug via group-code resolution). Restricted
    // to descriptors that already declare block_types so we don't
    // pollute the union with synth-voice / param-only blocks from
    // Hydra or III.
    for (const k of Object.keys(desc.blocks)) out.add(k);
  }
  return [...out].sort();
}

/**
 * Convenience: return a Zod schema for `block_type` that's a strict
 * enum when at least one device is registered, or a plain string
 * (legacy behavior) when the registry is empty. Callers should use
 * this AT TOOL REGISTRATION TIME so the union reflects every
 * registered device.
 */
export function blockTypeSchema(): z.ZodEnum<Record<string, string>> | z.ZodString {
  const union = buildBlockTypeUnion();
  if (union.length === 0) return z.string();
  return z.enum(union as [string, ...string[]]);
}

// ── BK-086 Option B: per-block params.type enum union ───────────────
//
// Option A enum-constrained `block_type` itself. Option B extends the
// constraint into the slot's `params.type` field: when the block_type
// is one with a known type-knob enum (AM4 amp/drive/reverb/delay/
// chorus/flanger/phaser/wah/compressor/geq/filter/tremolo/enhancer/
// gate/ingate), the schema rejects type values that aren't in the
// device's `params.type.enum_values` table.
//
// Cross-device contract:
//   - The discriminator is `block_type` per variant. Each AM4-
//     canonical block_type with a typed `params.type` gets its own
//     variant carrying the enum. Indexed II/III slugs ('amp 1',
//     'reverb 2') fall through to the fallback variant (loose params
//     shape) because II/III use different param names (II reverb
//     uses `effect_type`, not `type`); the cross-device alias layer
//     (BK-065) resolves those at the dispatcher. Schema-typing II's
//     effect_type is a separate refinement (tracked as Option C).
//
// Edge case: if NO devices are registered, fall back to the flat
// shape with z.string() block_type and loose params (same as the
// pre-BK-086 behavior).
//
// Token budget: founder confirmed not a concern. Variant for amp.type
// carries the full 248-entry enum; this is the load-bearing win.

/**
 * Collect every block_type with a `params.type` enum across registered
 * devices, keyed by block_type slug. Values are the cross-device union
 * of legal type strings, deduped and sorted.
 *
 * Devices that don't expose `params.type.enum_values` for a block
 * (e.g. Axe-Fx II uses `effect_type` instead) contribute nothing for
 * that block; their callers go through the fallback variant.
 */
export function buildBlockTypeParamEnums(): ReadonlyMap<string, readonly string[]> {
  const acc = new Map<string, Set<string>>();
  for (const desc of listRegisteredDevices()) {
    for (const [blockKey, blockSchema] of Object.entries(desc.blocks)) {
      const typeParam = blockSchema.params?.type;
      if (!typeParam || typeParam.unit !== 'enum') continue;
      const enumValues = typeParam.enum_values;
      if (!enumValues) continue;
      const values = Object.values(enumValues);
      if (values.length === 0) continue;
      const set = acc.get(blockKey) ?? new Set<string>();
      for (const v of values) set.add(v);
      acc.set(blockKey, set);
    }
  }
  const out = new Map<string, readonly string[]>();
  for (const [k, s] of acc) out.set(k, [...s].sort());
  return out;
}

/**
 * Type-knob enum collector that handles cross-device naming divergence.
 * AM4 uses `params.type` for the sub-effect picker (amp model, reverb
 * algorithm, drive pedal). Axe-Fx II uses `params.effect_type` for the
 * same semantic. III is research-phase (no enum_values registered yet).
 *
 * This helper scans BOTH names per block_type and returns, per block,
 * the set of (paramName, values[]) pairs that carry enum constraints.
 * The schema builder uses this to surface the canonical type-knob
 * enums at the schema layer (SEP-1330 EnumSchema pattern), so the
 * model constrains its own output during sampling instead of authoring
 * a free string and bouncing off the dispatcher's post-hoc Levenshtein
 * matcher.
 *
 * Only the type-knob is surfaced (one-or-two params per block). Other
 * enum-typed params (tone_stack, mic, lfo_type, etc.) stay loose
 * because (a) they're rarely authored cold by agents and (b) listing
 * every enum would inflate the schema payload by ~50-100 KB.
 */
const TYPE_KNOB_PARAM_NAMES = ['type', 'effect_type'] as const;

export function buildBlockTypeKnobEnums(): ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> {
  const acc = new Map<string, Map<string, Set<string>>>();
  for (const desc of listRegisteredDevices()) {
    for (const [blockKey, blockSchema] of Object.entries(desc.blocks)) {
      for (const paramName of TYPE_KNOB_PARAM_NAMES) {
        const param = blockSchema.params?.[paramName];
        if (!param || param.unit !== 'enum') continue;
        const enumValues = param.enum_values;
        if (!enumValues) continue;
        const values = Object.values(enumValues);
        if (values.length === 0) continue;
        const perBlock = acc.get(blockKey) ?? new Map<string, Set<string>>();
        const set = perBlock.get(paramName) ?? new Set<string>();
        for (const v of values) set.add(v);
        perBlock.set(paramName, set);
        acc.set(blockKey, perBlock);
      }
    }
  }
  const out = new Map<string, ReadonlyMap<string, readonly string[]>>();
  for (const [blockKey, perBlock] of acc) {
    const inner = new Map<string, readonly string[]>();
    for (const [paramName, valueSet] of perBlock) {
      inner.set(paramName, [...valueSet].sort());
    }
    out.set(blockKey, inner);
  }
  return out;
}

// ── PresetSpec zod schemas (shared by apply_preset + apply_setlist) ─
//
// `presetSlotShape` and `presetShape` are FACTORIES rather than
// constants so the embedded enums (block_type union + per-block
// params.type) pick up the current registry state at tool-
// registration time. See `buildBlockTypeUnion` /
// `buildBlockTypeParamEnums` above for the rationale.

// Common describe text reused across slot variants. Kept as constants
// so a future tweak doesn't require touching every variant in lockstep.
const SLOT_LOCATION_DESC =
  'Slot location. Linear devices (AM4): 1-based slot index 1..4. ' +
  'Grid devices (Axe-Fx II): {row,col} 1-based, or a bare number as ' +
  'shorthand for {row:2, col:N} (row-2 linear chain).';

const PARAMS_BY_CHANNEL_DESC =
  'Per-channel param maps for channel blocks (`{ A: { gain: 6 }, D: { gain: 8 } }` on AM4; `X` / `Y` on II / III). ' +
  'Each top-level key is a channel name; each value is a flat param map for that channel. ' +
  'See describe_device.capabilities.channel_blocks for the per-device channel list. ' +
  'Non-channel blocks reject this field; use `params` (flat) there.';

const ID_DESC =
  'v0.4: stable identifier for this block, used by routing edges and scene maps. ' +
  'Default: auto-derived `<block_type>_<instance>` (e.g. amp_1). ' +
  'Required when two blocks of the same type exist in the same preset.';

const INSTANCE_DESC =
  'v0.4: instance number on grid devices that support multiple of the same block type ' +
  '(Amp 1, Amp 2). Default 1. AM4 only accepts 1.';

const PARAMS_LOOSE_DESC =
  'Flat param map for non-channel blocks OR the active channel of channel blocks ' +
  '(`{ rate: 0.8, depth: 35 }`). For multi-channel authoring on channel blocks ' +
  '(amp / drive / reverb / delay on AM4; every block on II / III), use ' +
  '`params_by_channel` instead. T-5 (2026-05-21): nested-in-params (`{A:{...}}`) ' +
  'used to be accepted; pass that shape via `params_by_channel` now. Setting both ' +
  '`params` and `params_by_channel` on the same slot is rejected.';

const PARAMS_TYPED_DESC =
  'Flat param map with `type` enum-constrained to the device catalog for this ' +
  'block_type. Other knobs flow through loosely. For multi-channel authoring, ' +
  'use `params_by_channel` instead.';

/**
 * Build the inner per-channel param shape for `params_by_channel`. When
 * `knobEnums` is supplied (typed variant), the named type-knob params
 * are z.enum-constrained at schema level so the model picks valid
 * spellings during sampling. Other params flow through loosely.
 */
function buildPerChannelParamShape(
  knobEnums: ReadonlyMap<string, readonly string[]> | undefined,
): z.ZodTypeAny {
  if (!knobEnums || knobEnums.size === 0) {
    return z.record(z.string(), z.union([z.number(), z.string()]));
  }
  const inner: Record<string, z.ZodTypeAny> = {};
  for (const [paramName, values] of knobEnums) {
    // Same union pattern as the top-level params shape (see
    // buildPresetSlotShape): string-enum for display-vocab devices,
    // number arm for III-style wire-integer authoring.
    inner[paramName] = z.union([
      z.enum(values as [string, ...string[]]),
      z.number(),
    ]).optional();
  }
  return z.object(inner).catchall(z.union([z.number(), z.string()]));
}

function commonSlotFields(
  knobEnums?: ReadonlyMap<string, readonly string[]>,
) {
  return {
    slot: z.union([
      z.number().int().min(1),
      z.object({ row: z.number().int().min(1), col: z.number().int().min(1) }),
    ]).describe(SLOT_LOCATION_DESC),
    params_by_channel: z.record(
      z.string(),
      buildPerChannelParamShape(knobEnums),
    ).optional().describe(PARAMS_BY_CHANNEL_DESC),
    bypassed: z.boolean().optional(),
    id: z.string().optional().describe(ID_DESC),
    instance: z.number().int().min(1).optional().describe(INSTANCE_DESC),
  };
}

export function buildPresetSlotShape(): z.ZodTypeAny {
  // Flat shape: block_type accepts any string, params accepts any
  // key-value map. The agent learns valid block types and enum values
  // from describe_device / list_params / find_compatible_types, not
  // from the JSON Schema. Server-side validation in the dispatcher
  // catches invalid values with structured error messages.
  //
  // This replaced a discriminated-union schema that inlined every
  // device's full enum catalog (~180k chars per tool using this shape).
  // The union consumed ~100k context tokens before the user typed a
  // word, triggering "conversation too long" on Claude Desktop.
  return z.object({
    ...commonSlotFields(),
    block_type: z.string().describe(
      'Block to place (e.g. "amp", "drive", "reverb", "none"). See describe_device.block_types.',
    ),
    params: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe(PARAMS_LOOSE_DESC),
  });
}

export const presetSceneShape = z.object({
  scene: z.number().int().min(1).describe('Scene number (1-indexed).'),
  channels: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe(
    'Per-block channel selection: { "amp": "A", "drive": "A" }. Optional; supply at least one of channels / bypassed / name per entry.',
  ),
  bypassed: z.record(z.string(), z.boolean()).optional().describe(
    'Per-block bypass: { "drive": true } silences drive on this scene.',
  ),
  name: z.string().max(32).optional(),
});

export const routingEdgeShape = z.object({
  from: z.string().describe(
    'Source block id. Either the explicit `id` on a slots[] entry, or the auto-derived id: the BARE block type for a single instance (`amp`, `delay`; `amp_1` is accepted as an alias), `<block_type>_<instance>` from the second instance up (`amp_2`).',
  ),
  to: z.string().describe(
    'Destination block id. Same naming rules as `from`.',
  ),
  connect: z.boolean().optional().describe(
    'true (default) adds the cable; false removes it.',
  ),
});

/**
 * Build the top-level `spec` schema used by apply_preset. Factory so
 * the embedded slot shape can be constructed at registration time.
 */
export function buildPresetShape(): z.ZodObject {
  // `looseObject`, not `object`, for the SAME reason apply_preset's
  // `overrides` is loose: on an INPUT schema `z.object` silently STRIPS an
  // unrecognised key rather than rejecting it, so a misnamed top-level field
  // vanishes before the handler can say anything about it. Loose lets it
  // through to `rejectUnknownSpecKeys` (dispatcher/preset.ts), which names it.
  // Measured clean first: 0 unknown top-level keys across 351 corpus
  // apply_preset calls carrying a `spec`, so this closes the class without
  // turning any observed agent behaviour red.
  return z.looseObject({
    slots: z.array(buildPresetSlotShape()).min(1),
    scenes: z.array(presetSceneShape).optional(),
    name: z.string().max(32).optional(),
    landingScene: z.number().int().min(1).optional().describe(
      'Scene the device lands on after the build (1-indexed, device-clamped). ' +
      'Default 1. Lets the agent preview a specific scene-section ' +
      '(e.g. land on solo scene for an immediate lead test). Devices without scenes ignore this.',
    ),
    routing: z.array(routingEdgeShape).optional().describe(
      'v0.4: explicit routing edges for grid devices (parallel chains, FX loops, wet/dry splits). When omitted on a grid device, the descriptor infers a row-2 linear chain. Linear devices (AM4) reject this field; they route implicitly by slot order. See docs/FRACTAL-PRESET-SCHEMA.md for worked examples.',
    ),
  });
}

// Legacy const exports — kept for any direct importer outside the tool
// registration path. These freeze the union at module load time (when
// the registry is empty), so they fall back to z.string() for
// block_type. Tool registrations use `buildPresetShape()` to capture
// the live union at boot.
export const presetSlotShape = buildPresetSlotShape();
export const presetShape = buildPresetShape();
