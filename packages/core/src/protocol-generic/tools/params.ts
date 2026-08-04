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
  executeSetParam,
  executeSetParams,
  GET_PARAMS_MAX_QUERIES,
} from '../dispatcher.js';

import { PORT_DESC, asError, asText } from './shared.js';

export function registerParamTools(server: McpServer): void {
  server.registerTool('get_param', {
    title: 'Read Parameter',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Read one parameter from a device in display units (knob 0..10, dB, ms, %, enum name).',
      'Call before set_param when the user says "more / less / a bit" so the relative change has a baseline.',
      '- Pass `channel` for channel-bearing blocks (AM4 A/B/C/D; II X/Y); omit to read the active channel.',
      '- Pass `instance` for grid devices with multiple blocks of the same type (e.g. instance=2 targets Amp 2 on Axe-Fx II). Default 1.',
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
      instance: z.number().int().min(1).optional().describe(
        'Block instance (1-indexed) for grid devices with multiple blocks of the same type. E.g. instance=2 targets "Amp 2". Default 1.',
      ),
      include_description: z.boolean().optional().describe(
        'When true, the response carries a `description` field (verbatim Blocks Guide / Owner\'s Manual excerpt). Default false.',
      ),
    },
  }, async ({ port, block, name, channel, instance, include_description }) => {
    try {
      const result = await executeGetParam({ port, block, name, channel, instance, include_description });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('set_param', {
    title: 'Set Parameter',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Write one parameter by (block, name) in display units (knob 0..10, dB, ms, %, enum name or wire index). Call describe_device({port}) first; its agent_guidance, inline plus any topics it lists as withheld, covers relative-change, tempo sync, applicability gates, enum conventions. `channel` targets a specific A/B/C/D or X/Y (server switches first, then writes); `instance` targets duplicate blocks on grid devices (instance=2 = Amp 2 on Axe-Fx II, default 1). Aliases + enum matching auto-correct (drive.volume<->drive.level on AM4; case, whitespace, concept-keys like "USA IIC+"<->"USA MK IIC+"); the response echoes the canonical name, quote that back. Wire-ack is NOT audible confirmation: unplaced blocks and type-gated knobs (amp.master on non-master Marshalls) ack silently then no-op; call find_compatible_types before writing a type plus a specific knob. Tempo lock (AM4/II): a delay.time/rate write is silently ignored while tempo is synced; clear tempo to NONE first.',
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
      instance: z.number().int().min(1).optional().describe(
        'Block instance (1-indexed) for grid devices with multiple blocks of the same type. E.g. instance=2 targets "Amp 2". Default 1.',
      ),
    },
  }, async ({ port, block, name, value, channel, instance }) => {
    try {
      const result = await executeSetParam({ port, block, name, value, channel, instance });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('set_params', {
    title: 'Set Parameters',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Batch-write parameters on a device. Prefer this over many set_param calls when applying a scene, preset, or any grouped change.',
      '- Per-entry shape mirrors set_param: (block, name, value, channel?, instance?). Writes go in the order provided.',
      '- Pass `instance` for grid devices with multiple blocks of the same type (e.g. instance=2 targets Amp 2). Default 1.',
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
        instance: z.number().int().min(1).optional(),
      })).describe('Ordered list of (block, name, value, channel?, instance?) writes.'),
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
    title: 'Read Parameters',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Batch-read parameters from a device. Useful for state-anchoring before a tone-edit (read amp gain + master + bass + mid + treble, then propose changes).',
      '- Per-query shape: (block, name, channel?, instance?). Returns display units.',
      '- Pass `instance` for grid devices with multiple blocks of the same type (e.g. instance=2 reads from Amp 2). Default 1.',
      '- Reads continue past individual failures; the response lists which queries failed.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      queries: z.array(z.object({
        block: z.string(),
        name: z.string(),
        channel: z.union([z.string(), z.number()]).optional(),
        instance: z.number().int().min(1).optional(),
      // NOT `.max(GET_PARAMS_MAX_QUERIES)`. A zod ceiling here rejects at the
      // MCP boundary with "Too big: expected array to have <=100 items", which
      // names the constraint and nothing else: not that zero reads happened,
      // not how to split the call, not that list_params answers the same
      // question with no device I/O. The dispatcher refuses with all of that,
      // and it cannot be reached if zod refuses first. Same reasoning as the
      // `overrides` fix (2026-08-02): a bare zod rejection names the key but
      // not the shape the caller should have used. The cap is still ADVERTISED
      // here, because a client that reads the description can avoid the call.
      })).describe(`List of (block, name, channel?, instance?) queries to read. Max ${GET_PARAMS_MAX_QUERIES}: one round-trip each.`),
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
