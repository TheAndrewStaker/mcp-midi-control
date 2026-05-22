/**
 * Layout tools, block placement and bypass writes.
 *
 * Tools registered here:
 *   - `set_block(port, slot, block_type)`, place / clear a block at a slot
 *   - `set_bypass(port, block, bypassed)`, silence / activate a placed block
 *
 * `set_block` mutates the signal-chain layout; `set_bypass` mutates the
 * active scene's per-block bypass register. To set bypass on a non-active
 * scene, call `switch_scene` first.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executeSetBlock, executeSetBypass, executeToggleBypass } from '../dispatcher.js';

import { PORT_DESC, asError, asText, blockTypeSchema } from './shared.js';

export function registerLayoutTools(server: McpServer): void {
  // BK-086 Option A: capture the block-type union once at boot. See
  // tools/shared.ts for the rationale (runtime union from registered
  // descriptors, falls back to z.string() on empty registry).
  const blockTypeArg = blockTypeSchema();

  server.registerTool('set_block', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      block_type: blockTypeArg.describe(
        'Block type to place. Pass "none" to clear the slot. See describe_device.block_types. ' +
        'BK-086: schema enum constrained to the union of every registered device\'s legal placements.',
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

  server.registerTool('toggle_bypass', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: [
      'Atomically flip a block\'s bypass state in one wire round-trip, no value to pass. Prefer this over read-then-set_bypass when the user says "turn it off / on", "kick the reverb in", or "kill the delay".',
      '- Scene scope: writes land on the active scene. To toggle bypass on a different scene, switch_scene first.',
      '- NOT idempotent: each call flips state. Two calls = back to original. If you need a specific state (definitely-on, definitely-off), use set_bypass.',
      '- AM4 quirk: the AMP slot has no bypass register; the toggle wire hits the BOOST register instead. Use set_bypass on AMP to avoid the surprise.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.string().describe('Block name to toggle (e.g. "reverb", "drive", "delay").'),
    },
  }, async ({ port, block }) => {
    try {
      const result = await executeToggleBypass({ port, block });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
