/**
 * Axe-Fx II navigation tools, v0.3 cleanup.
 *
 * Surviving device-namespaced tools (unique semantics, no unified
 * equivalent):
 *   - axefx2_get_preset_name       , name read (function 0x0F)
 *   - axefx2_get_active_preset_number, slot read (function 0x14)
 *   - axefx2_set_block_channel     , X/Y channel write (function 0x11)
 *   - axefx2_get_block_channel     , X/Y channel read (function 0x11 action 0)
 *
 * Removed v0.3 (use unified equivalents):
 *   - axefx2_switch_preset      → switch_preset({port:'axe-fx-ii',location,on_active_preset_edited?})
 *   - axefx2_switch_scene       → switch_scene({port:'axe-fx-ii',scene})
 *   - axefx2_set_preset_name    → rename({port:'axe-fx-ii',target:'preset',name}) then save_preset
 *   - axefx2_save_preset        → save_preset({port:'axe-fx-ii',location,name?})
 *   - axefx2_scan_preset_range  → scan_locations({port:'axe-fx-ii',from,to})
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  buildGetBlockChannel,
  buildGetPresetName,
  buildGetPresetNumber,
  buildSetBlockChannel,
  isGetBlockChannelResponse,
  isGetPresetNameResponse,
  isGetPresetNumberResponse,
  parseGetBlockChannelResponse,
  parseGetPresetNameResponse,
  parseGetPresetNumberResponse,
  type AxeFxIIChannel,
} from 'fractal-midi/axe-fx-ii';

import {
  GET_RESPONSE_TIMEOUT_MS,
  NO_ACK_NOTE,
  ensureConn,
  findBlock,
  toHex,
} from './shared.js';
import { asError, asText } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

export function registerAxeFxIINavigationTools(server: McpServer): void {

  server.registerTool('axefx2_get_preset_name', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Read the active preset name from the Axe-Fx II working buffer (matches the front-panel display). Returns a 32-char ASCII string, space-padded.',
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const reqBytes = buildGetPresetName();
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isGetPresetNameResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx2_get_preset_name failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const name = parseGetPresetNameResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `Active preset name: "${name}".\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n`,
      }],
    };
  });


  server.registerTool('axefx2_get_active_preset_number', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Read the active preset slot (1..16384) on the Axe-Fx II, matching the front-panel display.',
      'For the preset NAME use axefx2_get_preset_name; for the full grid use axefx2_get_grid_layout.',
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const reqBytes = buildGetPresetNumber();
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isGetPresetNumberResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx2_get_active_preset_number failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const { presetNumber, displaySlot } = parseGetPresetNumberResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `Active preset: display slot ${displaySlot}.\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n`,
      }],
    };
  });


  server.registerTool('axefx2_set_block_channel', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Switch a block between its X and Y channels on the Axe-Fx II. Each block holds two independent param sets; switching changes which set is active.',
      'Per-block channel is independent of scenes (scenes pick which channel each block uses; the block itself only has X and Y).',
      '- block: display name ("Amp 1", "Reverb 1") or numeric effectId.',
      '- No-ack protocol; verify with axefx2_get_block_channel.',
    ].join('\n'),
    inputSchema: {
      block: z.union([z.string(), z.number()]).describe(
        'Block instance, display name ("Amp 1" / "Reverb 1") or numeric effectId.',
      ),
      channel: z.enum(['X', 'Y']).describe(
        'Target channel, "X" or "Y". Each block has these two channels and only these two.',
      ),
    },
    outputSchema: {
      block: z.string(),
      group_code: z.string(),
      effect_id: z.number().int(),
      channel: z.enum(['X', 'Y']),
    },
  }, async ({ block, channel }) => {
    try {
      const target = findBlock(block);
      const bytes = buildSetBlockChannel(target.id, channel as AxeFxIIChannel);
      const c = ensureConn();
      c.send(bytes);
      return {
        content: [{
          type: 'text',
          text:
            `Sent SET_BLOCK_CHANNEL → ${target.name} (${target.groupCode}, ` +
            `effectId ${target.id}) channel=${channel}.\n` +
            `Wrote ${bytes.length} bytes: ${toHex(bytes)}\n` +
            `\n${NO_ACK_NOTE}`,
        }],
        structuredContent: {
          block: target.name,
          group_code: target.groupCode,
          effect_id: target.id,
          channel,
        },
      };
    } catch (err) {
      return asError(err);
    }
  });


  server.registerTool('axefx2_get_block_channel', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Read a block\'s current channel (X or Y) on the Axe-Fx II. Call before switching to know the starting state, or after to confirm the change landed.',
    ].join('\n'),
    inputSchema: {
      block: z.union([z.string(), z.number()]).describe(
        'Block instance, display name or numeric effectId.',
      ),
    },
    outputSchema: {
      block: z.string(),
      group_code: z.string(),
      effect_id: z.number().int(),
      channel: z.enum(['X', 'Y']),
    },
  }, async ({ block }) => {
    let target;
    try {
      target = findBlock(block);
    } catch (err) {
      return asError(err);
    }
    const reqBytes = buildGetBlockChannel(target.id);
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      (bytes) => isGetBlockChannelResponse(bytes, target.id),
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return asError(new Error(
        `axefx2_get_block_channel failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      ));
    }
    const chan = parseGetBlockChannelResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `${target.name} (${target.groupCode}, effectId ${target.id}) is on channel ${chan}.\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n`,
      }],
      structuredContent: {
        block: target.name,
        group_code: target.groupCode,
        effect_id: target.id,
        channel: chan,
      },
    };
  });
}
