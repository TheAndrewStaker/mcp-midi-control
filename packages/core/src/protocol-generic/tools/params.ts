/**
 * Param tools, single- and batch-shaped reads and writes of named
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
      'Write one parameter, addressed by (block, name) in display units (knob 0..10, dB, ms, %, enum name or wire index). Call describe_device({port}) first for per-device idioms; agent_guidance covers relative-change, tempo sync, applicability gates, enum conventions.',
      'Pass `channel` to target a specific A/B/C/D or X/Y; server switches first, then writes.',
      'Aliases + enum matching auto-correct (drive.volume <-> drive.level on AM4; case + whitespace + concept-keys like "USA IIC+" <-> "USA MK IIC+"). Response echoes the canonical name; quote that back.',
      'Wire-ack is NOT audible confirmation. Unplaced blocks ack silently; type-gated knobs (amp.master on non-master Marshalls) silently no-op. Call find_compatible_types before writing a type + a specific knob.',
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
      'Nudge a continuous param up or down by one device-defined step. Use for conversational "turn it up a touch", "a hair less drive", "a lot more reverb". For a specific target ("set gain to 7"), use set_param.',
      'Granularity: "fine" (default) ≈ 1% of range (~0.1 on a 0..10 knob), maps to "a touch / a hair / a bit". "coarse" ≈ 10% of range (~1.0), maps to "a lot / way more / way less". Response carries the landed display value; no follow-up get_param needed.',
      'AM4 ONLY (wire-native action bytes 0x03 / 0x04 / 0x05 / 0x06, one round-trip ~50 ms). II / III / Hydra return capability_not_supported; fall back to get_param + set_param with a computed delta. Cross-device parity is filed under "Unrealized capabilities" in docs/TOOL-ARCHIVE.md.',
      'NOT idempotent (each call shifts by one step). Pass `channel` to target a specific A/B/C/D on channel-bearing blocks; omit to nudge the active channel.',
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
