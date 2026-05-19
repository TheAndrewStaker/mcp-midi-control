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
      'Read a single parameter from a device. Returns the display-shaped',
      'value (knob 0–10, dB, ms, %, enum dropdown name) — never raw wire',
      'bytes. Use this before set_param when you need to know the current',
      'value (the user said "more gain" — read first so you know what',
      '"more" is relative to).',
      'For channel-bearing blocks on devices that have channels (AM4 amp /',
      'drive / reverb / delay; Axe-Fx II X/Y blocks), pass `channel` to',
      'target a specific A/B/C/D (or X/Y). Without `channel`, reads',
      'whichever channel is currently active on that block.',
      'OPTIONAL PROSE: pass `include_description: true` to attach a',
      '`description` field (verbatim Blocks Guide / Owner\'s Manual',
      'excerpt) to the response when one is on file. Default false to',
      'keep the response low-bandwidth; turn on when answering the',
      'user\'s "what does X do" or disambiguating two similarly-named',
      'knobs. Params without a prose entry omit the field entirely.',
      'One wire round-trip, < 200 ms on healthy MIDI.',
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
      'Write a single parameter on a device. The parameter is addressed by',
      '(block, name) — e.g. block="amp", name="gain". Numeric params take',
      'the display value (0–10 knob, dB, ms, %); enum params take the',
      'dropdown name ("Plexi 100W High") or a numeric wire index.',
      'For channel-bearing blocks on devices that have channels (AM4 amp /',
      'drive / reverb / delay; Axe-Fx II X/Y blocks), pass `channel` to',
      'target a specific A/B/C/D (or X/Y). The server switches the block\'s',
      'channel selector first, then writes the param. Without `channel`,',
      'writes to whichever channel is currently active.',
      'IMPORTANT: the wire-ack confirms the device received the write — it',
      'does NOT confirm an audible change. If the target block isn\'t',
      'placed in the active preset, the device still acks but produces no',
      'sound. Check describe_device.capabilities and call get_param to',
      'verify the read-back if the user reports an unexpected outcome.',
      'CRITICAL — call describe_device({port}) ONCE at session start before',
      'any complex tone-building. Its `agent_guidance` field carries the',
      'device-specific idioms that decide whether your writes have the',
      'intended audible effect: AM4 RELATIVE-CHANGE discipline (read-before-',
      '"more"/"less"/"a bit"), TEMPO/TIME sync rules (set tempo=NONE before',
      'writing absolute time/rate, otherwise silently overridden), per-block',
      'applicability (writing a type-gated param on an incompatible amp',
      'model silently no-ops), enum-name conventions (reverb.type "Room,',
      'Medium" not "Medium Room"), channel/scene semantics. Skipping this',
      'lookup is the most common cause of "the AI changed something but I',
      'don\'t hear the difference" — the agent wrote the wrong knob.',
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
      'Write multiple parameters on a device in one call. Prefer this over',
      'many set_param calls when applying a scene, preset, or any grouped',
      'change — fewer round-trips, and validation is atomic (a bad value in',
      'one entry rejects the whole call with nothing sent).',
      'Per-entry shape matches set_param: numeric display values for knobs /',
      'dB / ms / %, strings or wire indices for enum dropdowns, optional',
      'channel selector for channel-bearing blocks. Writes are sent in the',
      'order provided.',
      'Same ack caveat as set_param: an ack is wire-level confirmation, not',
      'audible confirmation. If the user reports no change, target blocks',
      'may not be placed in the active preset.',
      'Same describe_device guidance applies — call describe_device({port})',
      'once at session start to load tone-building idioms (relative-change,',
      'tempo/time sync, applicability gates). Batching writes that violate',
      'those rules (e.g. setting absolute delay.time while tempo != NONE)',
      'wastes the round-trip.',
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
      'Read multiple parameters from a device in one call. Useful for',
      'state-anchoring before a tone-edit conversation (read current amp',
      'gain + master + bass + mid + treble, then propose a change). Per-',
      'query shape: (block, name, channel?). Reads continue past',
      'individual failures — a failed read for query[3] does NOT abort',
      'query[4..N]; the response lists which queries failed.',
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
