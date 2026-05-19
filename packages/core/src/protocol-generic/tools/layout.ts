/**
 * Layout tools — block placement and bypass writes.
 *
 * Tools registered here:
 *   - `set_block(port, slot, block_type)` — place / clear a block at a slot
 *   - `set_bypass(port, block, bypassed)` — silence / activate a placed block
 *
 * `set_block` mutates the signal-chain layout; `set_bypass` mutates the
 * active scene's per-block bypass register. To set bypass on a non-active
 * scene, call `switch_scene` first.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executeSetBlock, executeSetBypass } from '../dispatcher.js';

import { PORT_DESC, asError, asText } from './shared.js';

export function registerLayoutTools(server: McpServer): void {
  server.registerTool('set_block', {
    description: [
      'Place or clear a block at a slot in the signal chain. Use to build a preset layout before tuning per-block params with set_param.',
      '- Slot is 1-based on linear devices (AM4: 1..4).',
      '- block_type takes a registered block name ("amp", "drive", "reverb") or "none" to clear. See describe_device.block_types.',
      '- For bypass (silence without removing), use set_bypass instead.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      slot: z.number().int().describe(
        'Slot index (1-based) on linear devices. Grid-device support is Wave 2.',
      ),
      block_type: z.string().describe(
        'Block type to place. Pass "none" to clear the slot. See describe_device.block_types.',
      ),
    },
  }, async ({ port, slot, block_type }) => {
    try {
      const result = await executeSetBlock({ port, slot, change: { block_type } });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('set_bypass', {
    description: [
      'Silence (bypassed=true) or activate (bypassed=false) a block on the currently-active scene. Params stay intact; the block just passes signal through.',
      '- Scene scope: writes land on the active scene. To bypass on a different scene, switch_scene first.',
      '- Diagnostic pattern: when chasing an unwanted artifact, bypass one suspect block at a time and re-audition before changing params.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.string().describe('Block name to bypass / activate (e.g. "amp", "drive", "reverb").'),
      bypassed: z.boolean().describe('true = silence the block; false = activate.'),
    },
  }, async ({ port, block, bypassed }) => {
    try {
      const result = await executeSetBypass({ port, block, bypassed });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
