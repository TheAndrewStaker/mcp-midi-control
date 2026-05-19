/**
 * Axe-Fx II navigation tools — v0.3 cleanup.
 *
 * Surviving device-namespaced tools (unique semantics, no unified
 * equivalent):
 *   - axefx2_get_preset_name        — name read (function 0x0F)
 *   - axefx2_get_active_preset_number — slot read (function 0x14)
 *   - axefx2_set_block_channel      — X/Y channel write (function 0x11)
 *   - axefx2_get_block_channel      — X/Y channel read (function 0x11 action 0)
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

export function registerAxeFxIINavigationTools(server: McpServer): void {

  server.registerTool('axefx2_get_preset_name', {
    description: [
      'Read the active preset name on the Axe-Fx II. Returns the preset',
      'name string currently held in the working buffer — the same string',
      'shown on the device front panel.',
      '',
      'Sends GET_PRESET_NAME (function 0x0F). The device responds with',
      'a 32-byte ASCII payload (space-padded) inside the same 0x0F',
      'envelope. Working-buffer scope: this returns the working buffer\'s',
      'name, which after a save-to-slot equals the persisted slot name.',
      '',
      'Status: hardware-verified on Q8.02 XL+ (2026-05-10).',
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
    description: [
      'Read the active preset slot on the Axe-Fx II. Returns the',
      '1-indexed display slot (1..16384) — the same number that appears',
      'on the device front panel and in AxeEdit.',
      '',
      'Sends GET_PRESET_NUMBER (function 0x14). Device responds with a',
      '2-byte payload encoding the 14-bit preset number MSB-first.',
      '',
      'NOTE: this returns the preset NUMBER. For the preset NAME, use',
      'axefx2_get_preset_name. For the FULL grid layout of the active',
      'preset, use axefx2_get_grid_layout.',
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
          `Active preset: display slot ${displaySlot} (wire ${presetNumber}).\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n`,
      }],
    };
  });


  server.registerTool('axefx2_set_block_channel', {
    description: [
      'Switch a block on the Axe-Fx II between its two channels — X and Y.',
      'Each block (Amp, Drive, Reverb, Delay, Chorus, etc.) holds TWO',
      'independent sets of params in X and Y; switching changes which set',
      'is active. Distinct from AM4\'s four-channel A/B/C/D model.',
      '',
      'Per-block channel state is independent of scene switching: scenes',
      'select which channel each block uses on a given scene, but the',
      'block itself only holds X and Y.',
      '',
      'Wire format (function 0x11): F0 00 01 74 07 11 [eff_lo] [eff_hi]',
      '[chan: 0=X, 1=Y] [01=set] [cs] F7',
      '',
      'NO-ACK PROTOCOL. Verify by the device\'s response.',
      '',
      'Status: hardware-verified on Q8.02 (2026-05-11).',
    ].join('\n'),
    inputSchema: {
      block: z.union([z.string(), z.number()]).describe(
        'Block instance — display name ("Amp 1" / "Reverb 1") or numeric effectId.',
      ),
      channel: z.enum(['X', 'Y']).describe(
        'Target channel — "X" or "Y". Each block has these two channels and only these two.',
      ),
    },
  }, async ({ block, channel }) => {
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
    };
  });


  server.registerTool('axefx2_get_block_channel', {
    description: [
      'Read the current channel (X or Y) of a block on the Axe-Fx II.',
      'Sends GET_BLOCK_CHANNEL (function 0x11, action 0) and waits for',
      'the device\'s response.',
      '',
      'Call this BEFORE switching channels to know the starting state, or',
      'after switching to confirm the change landed.',
    ].join('\n'),
    inputSchema: {
      block: z.union([z.string(), z.number()]).describe(
        'Block instance — display name or numeric effectId.',
      ),
    },
  }, async ({ block }) => {
    const target = findBlock(block);
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
      throw new Error(
        `axefx2_get_block_channel failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
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
    };
  });
}
