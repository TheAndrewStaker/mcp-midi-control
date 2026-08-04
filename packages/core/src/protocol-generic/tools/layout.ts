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

import { executeSetBlock, executeSetBypass } from '../dispatcher.js';

import { PORT_DESC, asError, asText, blockTypeSchema } from './shared.js';

export function registerLayoutTools(server: McpServer): void {
  // BK-086 Option A: capture the block-type union once at boot. See
  // tools/shared.ts for the rationale (runtime union from registered
  // descriptors, falls back to z.string() on empty registry).
  const blockTypeArg = blockTypeSchema();

  server.registerTool('set_block', {
    title: 'Place Block',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Place ONE block, or clear a slot (block_type "none"), on a single preset. Surgical primitive. For grid devices (Axe-Fx II / III / FM3 / FM9) or ANY multi-block build, use apply_preset, NOT set_block: set_block does not cable cells, propagate routing, or terminate the chain at the device output, whereas apply_preset auto-cables row 2 and terminates at col 12. On grid, set_block is safe only for post-apply_preset cleanup (e.g. swapping one cell\'s block_type). 60% of agent set_block failures were reaching for it on a grid device when apply_preset was right. block_type is a registered name ("amp", "drive", "reverb"); see describe_device.block_types. To silence without removing, use set_bypass.',
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      slot: z.union([
        z.number().int().min(1),
        z.object({ row: z.number().int().min(1), col: z.number().int().min(1) }),
      ]).describe(
        'Slot location. Linear devices (AM4): 1-based integer 1..4. Grid devices (Axe-Fx II / III): {row, col} 1-based. Mismatching the device shape errors with the canonical shape for the target port.',
      ),
      block_type: blockTypeArg.describe(
        'Block type to place. Pass "none" to clear the slot. See describe_device.block_types. ' +
        'Schema enum constrained to the union of every registered device\'s legal placements.',
      ),
      instance: z.number().int().min(1).optional().describe(
        'Block instance (1-indexed) for grid devices with multiple blocks of the same type ' +
        '(e.g. instance=2 places "Amp 2"). Default 1. Single-instance devices (AM4) reject anything > 1.',
      ),
    },
  }, async ({ port, slot, block_type, instance }) => {
    try {
      const result = await executeSetBlock({ port, slot, change: { block_type, instance } });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('set_bypass', {
    title: 'Bypass Block',
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
      instance: z.number().int().min(1).optional().describe(
        'Instance number for grid devices with multiple blocks of the same type (e.g. Amp 1 = instance 1, Amp 2 = instance 2). Default 1.',
      ),
    },
  }, async ({ port, block, bypassed, instance }) => {
    try {
      const result = await executeSetBypass({ port, block, bypassed, instance });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

}
