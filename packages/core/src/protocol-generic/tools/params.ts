/**
 * Param tools — single- and batch-shaped reads and writes of named
 * parameters within a device's block schema.
 *
 * Tools registered here:
 *   - `get_param(port, block, name, channel?)`
 *   - `set_param(port, block, name, value, channel?)`
 *   - `get_params(port, queries[])`
 *   - `set_params(port, ops[])`
 *
 * Display-first contract: numeric values are display units (knob 0–10, dB,
 * ms, %), enum values are dropdown name strings. The dispatcher's encoder
 * step handles display → wire conversion before the descriptor's writer
 * sees the value.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  executeGetParam,
  executeGetParams,
  executeNudgeParam,
  executeSetParam,
  executeSetParams,
} from '../dispatcher.js';

import { PORT_DESC, asError, asText } from './shared.js';

export function registerParamTools(server: McpServer): void {
  server.registerTool('get_param', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Read one parameter from a device in display units (knob 0..10, dB, ms, %, enum name).',
      'Call before set_param when the user says "more / less / a bit" so the relative change has a baseline.',
      '- Pass `channel` for channel-bearing blocks (AM4 A/B/C/D; II X/Y); omit to read the active channel.',
      '- Nearby names resolve silently: cross-device aliases (drive.volume ↔ drive.level, amp.master ↔ amp.master_volume) and tolerant enum matching (case + whitespace) auto-correct; the response echoes the canonical name.',
      '- `include_description: true` attaches a Blocks-Guide / Owner\'s-Manual excerpt; default false.',
      '- One wire round-trip, < 200 ms.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.string().describe('Block name (e.g. "amp", "reverb", "delay").'),
      name: z.string().describe('Parameter name within the block (e.g. "gain", "time", "mix").'),
      channel: z.union([z.string(), z.number()]).optional().describe(
        'Optional channel selector. Only valid for channel-bearing blocks; see describe_device.capabilities.channel_blocks.',
      ),
      include_description: z.boolean().optional().describe(
        'When true, the response carries a `description` field (verbatim Blocks Guide / Owner\'s Manual excerpt). Default false.',
      ),
    },
  }, async ({ port, block, name, channel, include_description }) => {
    try {
      const result = await executeGetParam({ port, block, name, channel, include_description });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('set_param', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Write one parameter on a device, addressed by (block, name) in display units (knob 0..10, dB, ms, %, enum name or wire index).',
      'Call describe_device({port}) once per session first; its agent_guidance covers relative-change, tempo/time sync, applicability gates, and enum-naming conventions that decide whether the write actually does anything.',
      '- Pass `channel` to target a specific A/B/C/D or X/Y; the server switches first, then writes.',
      '- Nearby names resolve silently: cross-device aliases (drive.volume ↔ drive.level on AM4, amp.master ↔ amp.master_volume on II) and tolerant enum matching (case + whitespace, plus concept-key normalisation like "USA IIC+" ↔ "USA MK IIC+") auto-correct. The response echoes the canonical name; quote that back in user-facing summaries.',
      '- Wire-ack confirms the device received the bytes; it does NOT confirm audible change. A param on an unplaced block acks silently with no sound.',
      '- Type-gated params silently no-op when the active block.type doesn\'t expose them (e.g. amp.master on a non-master Marshall). Use find_compatible_types before writing a type + a specific knob.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.string().describe('Block name (e.g. "amp", "drive", "reverb", "delay").'),
      name: z.string().describe('Parameter name within the block (e.g. "gain", "type", "mix").'),
      value: z.union([z.number(), z.string()]).describe(
        'Display value. Numbers for knobs / dB / ms / %, strings for enum dropdown names.',
      ),
      channel: z.union([z.string(), z.number()]).optional().describe(
        'Optional channel selector. Only valid for channel-bearing blocks; see describe_device.capabilities.channel_blocks.',
      ),
    },
  }, async ({ port, block, name, value, channel }) => {
    try {
      const result = await executeSetParam({ port, block, name, value, channel });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('set_params', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Batch-write parameters on a device. Prefer this over many set_param calls when applying a scene, preset, or any grouped change.',
      '- Per-entry shape mirrors set_param: (block, name, value, channel?). Writes go in the order provided.',
      '- Validation is atomic: a bad value in any entry rejects the whole call with nothing sent.',
      '- Same ack caveat as set_param: a wire-ack is not audible confirmation. Same describe_device guidance applies.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      ops: z.array(z.object({
        block: z.string(),
        name: z.string(),
        value: z.union([z.number(), z.string()]),
        channel: z.union([z.string(), z.number()]).optional(),
      })).describe('Ordered list of (block, name, value, channel?) writes.'),
    },
  }, async ({ port, ops }) => {
    try {
      const result = await executeSetParams({ port, ops });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('nudge_param', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: [
      'Nudge a continuous param up or down by one step — for the conversational "turn it up a touch / a hair less" UX. The device knows its own step size per param, so no target value is computed.',
      'When the user says "a bit / a touch / a hair", default to granularity="fine" (~0.01 on a 0..10 knob, ~1% of full range). When they say "a lot / much more", use "coarse" (~0.1, ~10% of full range).',
      '- For a specific target ("set gain to 7"), use set_param with the explicit value.',
      '- NOT idempotent: each call shifts state by one step. The wire is payload-free so it\'s cheap to call in a tight UX loop.',
      '- Channel-bearing blocks: pass `channel` to nudge a specific A/B/C/D / X/Y; omit for the active channel.',
      '- AM4 quantum (hardware-verified on AMP.GAIN): fine = 66/65534 ≈ 0.001 internal, coarse = 655/65534 ≈ 0.01 internal. Display step = 10× internal for the standard 0..10 knob.',
      '- Currently only AM4 implements this; II/III error with capability_not_supported.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.string().describe('Block name (e.g. "amp", "reverb", "delay").'),
      name: z.string().describe('Parameter name within the block (e.g. "gain", "time", "mix").'),
      direction: z.enum(['up', 'down']).describe('"up" = increment, "down" = decrement.'),
      granularity: z.enum(['fine', 'coarse']).optional().describe(
        '"fine" (default) ≈ one click of the knob; "coarse" ≈ 10×. Map "a touch / a hair" → fine, "a lot / way more" → coarse.',
      ),
      channel: z.union([z.string(), z.number()]).optional().describe(
        'Optional channel selector for channel-bearing blocks; see describe_device.capabilities.channel_blocks.',
      ),
    },
  }, async ({ port, block, name, direction, granularity, channel }) => {
    try {
      const result = await executeNudgeParam({ port, block, name, direction, granularity, channel });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('get_params', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Batch-read parameters from a device. Useful for state-anchoring before a tone-edit (read amp gain + master + bass + mid + treble, then propose changes).',
      '- Per-query shape: (block, name, channel?). Returns display units.',
      '- Reads continue past individual failures; the response lists which queries failed.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      queries: z.array(z.object({
        block: z.string(),
        name: z.string(),
        channel: z.union([z.string(), z.number()]).optional(),
      })).describe('List of (block, name, channel?) queries to read.'),
    },
  }, async ({ port, queries }) => {
    try {
      const result = await executeGetParams({ port, queries });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
