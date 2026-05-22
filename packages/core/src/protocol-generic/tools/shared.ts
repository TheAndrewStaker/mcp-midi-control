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

export const PORT_DESC =
  'Device port. Accepts the device id (e.g. "am4", "axe-fx-ii"), display ' +
  'name ("Fractal AM4"), or any MIDI port-name substring matching a ' +
  'registered device (e.g. "AM4 MIDI 1"). Call list_midi_ports to see ' +
  'connected ports; call describe_device(port) to confirm capabilities.';

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
 */
export function asText(payload: unknown): {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
} {
  if (typeof payload === 'string') {
    return { content: [{ type: 'text', text: payload }] };
  }
  const text = JSON.stringify(payload, null, 2);
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

// ── PresetSpec zod schemas (shared by apply_preset + apply_setlist) ─

export const presetSlotShape = z.object({
  slot: z.union([
    z.number().int().min(1),
    z.object({ row: z.number().int().min(1), col: z.number().int().min(1) }),
  ]).describe(
    'Slot location. Linear devices (AM4): 1-based slot index 1..4. Grid devices (Axe-Fx II): {row,col} 1-based, or a bare number as shorthand for {row:2, col:N} (row-2 linear chain).',
  ),
  block_type: z.string().describe(
    'Block to place (e.g. "amp", "drive", "reverb", "none"). See describe_device.block_types.',
  ),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe(
    'Flat param map for non-channel blocks OR the active channel of channel blocks (`{ rate: 0.8, depth: 35 }`). For multi-channel authoring on channel blocks (amp / drive / reverb / delay on AM4; every block on II / III), use `params_by_channel` instead. T-5 (2026-05-21): nested-in-params (`{A:{...}}`) used to be accepted; pass that shape via `params_by_channel` now. Setting both `params` and `params_by_channel` on the same slot is rejected.',
  ),
  params_by_channel: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))).optional().describe(
    'Per-channel param maps for channel blocks (`{ A: { gain: 6 }, D: { gain: 8 } }` on AM4; `X` / `Y` on II / III). Each top-level key is a channel name; each value is a flat param map for that channel. See describe_device.capabilities.channel_blocks for the per-device channel list. Non-channel blocks reject this field; use `params` (flat) there.',
  ),
  bypassed: z.boolean().optional(),
  id: z.string().optional().describe(
    'v0.4: stable identifier for this block, used by routing edges and scene maps. Default: auto-derived `<block_type>_<instance>` (e.g. amp_1). Required when two blocks of the same type exist in the same preset.',
  ),
  instance: z.number().int().min(1).optional().describe(
    'v0.4: instance number on grid devices that support multiple of the same block type (Amp 1, Amp 2). Default 1. AM4 only accepts 1.',
  ),
});

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
    'Source block id. Either the explicit `id` on a slots[] entry, or the auto-derived `<block_type>_<instance>` (e.g. amp_1, drive_2).',
  ),
  to: z.string().describe(
    'Destination block id. Same naming rules as `from`.',
  ),
  connect: z.boolean().optional().describe(
    'true (default) adds the cable; false removes it.',
  ),
});

export const presetShape = z.object({
  slots: z.array(presetSlotShape).min(1),
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
