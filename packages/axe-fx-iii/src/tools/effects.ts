/**
 * Axe-Fx III block-level effect tools,channel + bypass read
 * using v1.4 spec Appendix 1 effect IDs.
 *
 * These operate on the ACTIVE scene only (per v1.4 spec,the III
 * has no per-scene bypass / channel writes in the public spec).
 *
 * `axefx3_set_bypass` was removed 2026-05-18,the unified
 * `set_bypass({port:'axe-fx-iii', block, bypassed})` covers it via
 * the descriptor writer.setBypass path.
 *
 * Tools registered:
 *   - axefx3_get_bypass(block)
 *   - axefx3_set_channel(block, channel)
 *   - axefx3_get_channel(block)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  buildGetBypass,
  buildSetChannel,
  buildGetChannel,
  isSetGetBypassResponse,
  isSetGetChannelResponse,
  parseBypassResponse,
  parseChannelResponse,
} from 'fractal-midi/axe-fx-iii';

import {
  BETA_NOTE,
  BETA_PREFIX,
  GET_RESPONSE_TIMEOUT_MS,
  NO_ACK_NOTE,
  ensureConn,
  formatMultipurposeError,
  resolveBlockOrThrow,
  sendAndWatchForError,
  toHex,
} from './shared.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

const BLOCK_INPUT_DESCRIPTION = [
  'Block reference. Accepts:',
  '  - "Reverb 1", "Drive 2", "Compressor 4",name + instance number',
  '  - "Reverb" (no instance defaults to instance 1)',
  '  - "REV", "DRV", "CMP",3-letter group code',
  '',
  "AMP / Dynamic Distortion / NAM / Global Block / Shunt aren't",
  "addressable from the v1.4 spec (no effect ID),these will refuse.",
  'Call axefx3_list_blocks for the full catalog.',
].join('\n');

const CHANNEL_VALUES = { A: 0, B: 1, C: 2, D: 3 } as const;

export function registerAxeFxIIIEffectTools(server: McpServer): void {

  server.registerTool('axefx3_get_bypass', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Read a block\'s current bypass state on the Axe-Fx III. Returns BYPASSED or ENGAGED.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      block: z.string().describe(BLOCK_INPUT_DESCRIPTION),
    },
    outputSchema: {
      block: z.string(),
      effect_id: z.number().int(),
      bypassed: z.boolean(),
    },
  }, async ({ block }) => {
    let effectId: number;
    try {
      effectId = resolveBlockOrThrow(block);
    } catch (err) {
      return asError(err);
    }
    const reqBytes = buildGetBypass(effectId);
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetGetBypassResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return asError(new Error(
        `axefx3_get_bypass(${block}) failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      ));
    }
    const parsed = parseBypassResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `${block} (effect ID ${parsed.effectId}) is ` +
          `${parsed.bypassed ? 'BYPASSED' : 'ENGAGED'}.\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
      structuredContent: {
        block,
        effect_id: parsed.effectId,
        bypassed: parsed.bypassed,
      },
    };
  });


  server.registerTool('axefx3_set_channel', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Switch a block\'s active channel (A/B/C/D) on the Axe-Fx III. Each block holds up to 4 independent param sets. Targets the ACTIVE scene only.',
      NO_ACK_NOTE,
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      block: z.string().describe(BLOCK_INPUT_DESCRIPTION),
      channel: z.enum(['A', 'B', 'C', 'D']).describe(
        'Target channel,A, B, C, or D.',
      ),
    },
    outputSchema: {
      block: z.string(),
      effect_id: z.number().int(),
      channel: z.enum(['A', 'B', 'C', 'D']),
      wire_channel: z.number().int(),
      rejected: z.boolean(),
      error_result_code: z.number().int().optional(),
    },
  }, async ({ block, channel }) => {
    let effectId: number;
    try {
      effectId = resolveBlockOrThrow(block);
    } catch (err) {
      return asError(err);
    }
    const wireChannel = CHANNEL_VALUES[channel];
    const bytes = buildSetChannel(effectId, wireChannel);
    const c = ensureConn();
    const errorReport = await sendAndWatchForError(c, bytes);
    const errorBlock = errorReport
      ? `\n${formatMultipurposeError(errorReport)}\n`
      : '';
    return {
      content: [{
        type: 'text',
        text:
          `Sent SET_CHANNEL → ${block} (effect ID ${effectId}) ` +
          `channel=${channel}.\n` +
          `Wrote ${bytes.length} bytes: ${toHex(bytes)}\n` +
          errorBlock +
          `\n${NO_ACK_NOTE}\n\n${BETA_NOTE}`,
      }],
      structuredContent: {
        block,
        effect_id: effectId,
        channel,
        wire_channel: wireChannel,
        rejected: errorReport !== undefined,
        ...(errorReport ? { error_result_code: errorReport.resultCode } : {}),
      },
    };
  });


  server.registerTool('axefx3_get_channel', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Read a block\'s current channel (A/B/C/D) on the Axe-Fx III.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      block: z.string().describe(BLOCK_INPUT_DESCRIPTION),
    },
    outputSchema: {
      block: z.string(),
      effect_id: z.number().int(),
      channel: z.string(),
      wire_channel: z.number().int(),
    },
  }, async ({ block }) => {
    let effectId: number;
    try {
      effectId = resolveBlockOrThrow(block);
    } catch (err) {
      return asError(err);
    }
    const reqBytes = buildGetChannel(effectId);
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetGetChannelResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return asError(new Error(
        `axefx3_get_channel(${block}) failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      ));
    }
    const parsed = parseChannelResponse(response);
    const channelName = ['A', 'B', 'C', 'D'][parsed.channel] ?? `(unknown wire ${parsed.channel})`;
    return {
      content: [{
        type: 'text',
        text:
          `${block} (effect ID ${parsed.effectId}) is on channel ${channelName}.\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
      structuredContent: {
        block,
        effect_id: parsed.effectId,
        channel: channelName,
        wire_channel: parsed.channel,
      },
    };
  });

}
