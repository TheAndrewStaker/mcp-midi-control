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
  executeSetParam,
  executeSetParams,
} from '../dispatcher.js';

import { PORT_DESC, asError, asText } from './shared.js';

export function registerParamTools(server: McpServer): void {
  server.registerTool('get_param', {
    description: [
      'Read one parameter from a device in display units (knob 0..10, dB, ms, %, enum name).',
      'Call before set_param when the user says "more / less / a bit" so the relative change has a baseline.',
      '- Pass `channel` for channel-bearing blocks (AM4 A/B/C/D; II X/Y); omit to read the active channel.',
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
    description: [
      'Write one parameter on a device, addressed by (block, name) in display units (knob 0..10, dB, ms, %, enum name or wire index).',
      'Call describe_device({port}) once per session first; its agent_guidance covers relative-change, tempo/time sync, applicability gates, and enum-naming conventions that decide whether the write actually does anything.',
      '- Pass `channel` to target a specific A/B/C/D or X/Y; the server switches first, then writes.',
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

  server.registerTool('get_params', {
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
