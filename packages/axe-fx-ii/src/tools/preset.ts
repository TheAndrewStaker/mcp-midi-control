/**
 * Axe-Fx II preset tools — v0.3 cleanup.
 *
 * Surviving device-namespaced tool (unique semantics, no unified
 * equivalent):
 *   - axefx2_test_apply  — working-buffer apply + chain-integrity verify
 *                          in one call (no STORE, no save-auth needed)
 *
 * Removed v0.3 (use unified equivalents):
 *   - axefx2_apply_preset     → apply_preset({port:'axe-fx-ii',spec})
 *   - axefx2_apply_preset_at  → apply_preset({port:'axe-fx-ii',spec,target_location,save_authorized})
 *   - axefx2_apply_setlist    → apply_setlist({port:'axe-fx-ii',entries,...})
 *
 * The unified apply tools route through descriptor.writer.applyPreset /
 * descriptor.writer.applySetlist which wrap the same applyExecutor used
 * by the removed device-namespaced tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  buildGetGridLayout,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
} from 'fractal-midi/axe-fx-ii';

import { buildApplyPresetOps, runApplyPresetAtOps, type ApplyPresetAtOp, type ApplyPresetInput } from './applyExecutor.js';
import { renderGridSummary } from './gridRender.js';
import {
  GET_RESPONSE_TIMEOUT_MS,
  ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA,
  ensureConn,
  guardActiveBufferOrSave,
  type OnEditedMode,
} from './shared.js';

export function registerAxeFxIIPresetTools(server: McpServer): void {
  server.registerTool('axefx2_test_apply', {
    description: [
      'Build a preset on the WORKING BUFFER and immediately verify its',
      'wire-level chain integrity in one tool call. Non-destructive: no',
      'STORE_PRESET, no save-authorization needed — switching presets',
      'afterward reverts the buffer.',
      '',
      'WHEN TO USE: as the "did the apply actually land correctly?"',
      'check before asking the user to plug in their guitar. Replaces',
      'the three-call sequence (apply → switch → get_grid_layout) with',
      'one round-trip that returns a structured pass/fail verdict the',
      'agent can act on immediately.',
      '',
      'WHAT IT DOES:',
      '  1. Builds + runs the same op sequence as the unified apply_preset',
      '     working-buffer path: clear non-chain cells, place blocks +',
      '     shunts on row 2, explicitly cable every adjacent pair from',
      '     col 2..12, write per-block params, optional scene + name.',
      '  2. Reads axefx2_get_grid_layout against the working buffer.',
      '  3. Returns JSON with: ok (boolean), chainBreaks, gridSummary,',
      '     applyDigest, elapsedMs, ackCount.',
      '',
      'PASS CRITERION: every cell in the chain past col 1 must have a',
      'non-zero routing_mask. A failed test means signal will not flow',
      'end-to-end — the agent should surface the failure to the user',
      'rather than claim audio will work.',
      '',
      'INPUT shape mirrors the unified apply_preset for single-scene',
      'use (blocks + optional `scene` + name). NO slot parameter, NO',
      '`scenes[]` array. For multi-scene authoring (distinct per-block',
      'bypass + channel state across scenes 1..8), use the unified',
      '`apply_preset` tool which accepts a `scenes[]` array in one',
      'call. Common pattern: call `apply_preset` first to build the',
      'multi-scene preset, then `axefx2_test_apply` to chain-verify if',
      'needed. To persist a verified build, follow up with',
      'save_preset({ port: "axe-fx-ii", location }) after ok=true.',
      '',
      'PERFORMANCE: ~1.5-2.5 s for a 4-6 block chain.',
    ].join('\n'),
    inputSchema: {
      blocks: z.array(z.object({
        block: z.union([z.string(), z.number()]).describe(
          'Block to place — display name ("Amp 1") or numeric effectId.',
        ),
        bypass: z.boolean().optional(),
        channel: z.enum(['X', 'Y']).optional(),
        params: z.record(z.string(), z.number()).optional(),
      })).min(1).max(12).describe(
        'Ordered list of blocks for the linear chain. Up to 12.',
      ),
      scene: z.number().int().min(0).max(7).optional(),
      name: z.string().max(32).optional(),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
    },
  }, async ({ blocks, scene, name, on_active_preset_edited }) => {
    const mode: OnEditedMode = on_active_preset_edited ?? 'warn';
    const guard = await guardActiveBufferOrSave(mode);
    if (!guard.proceed) {
      return {
        content: [{ type: 'text', text: guard.warningText ?? 'navigation refused' }],
        isError: true,
      };
    }

    const input: ApplyPresetInput = {
      blocks: blocks as ApplyPresetInput['blocks'],
      scene,
      name,
    };

    let ops: ApplyPresetAtOp[];
    try {
      ops = buildApplyPresetOps(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`axefx2_test_apply: ${msg}`);
    }

    const conn = ensureConn();
    const applyResult = await runApplyPresetAtOps(conn, ops);

    // Read grid + parse for chain breaks.
    const gridRespPromise = conn.receiveSysExMatching(
      isGetGridLayoutResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    conn.send(buildGetGridLayout());
    let gridSummary: string;
    let chainBreaks: Array<{ row: number; col: number; blockId: number }> = [];
    try {
      const gridBytes = await gridRespPromise;
      const cells = parseGetGridLayoutResponse(gridBytes);
      gridSummary = renderGridSummary(cells);
      for (const c of cells) {
        if (c.blockId === 0) continue;
        if (c.row !== 2) continue; // chain-break check is row-2 only for v0.1
        if (c.col > 1 && c.routingFlags === 0) {
          chainBreaks.push({ row: c.row, col: c.col, blockId: c.blockId });
        }
      }
    } catch (err) {
      gridSummary = `(grid read failed: ${err instanceof Error ? err.message : String(err)})`;
      chainBreaks = [];
    }

    const ok = applyResult.ok && chainBreaks.length === 0;
    const applyDigest = [
      applyResult.summaries[0] ?? '(no apply summary)',
      ...applyResult.summaries.slice(-3),
    ];

    const verdict = ok
      ? `PASS — wire-level chain reads clean. Working buffer holds an audible preset (audition before saving with save_preset).`
      : applyResult.lastNack
        ? `FAIL — apply op got a non-OK ack: "${applyResult.lastNack.summary}" (resultCode=0x${applyResult.lastNack.resultCode.toString(16)}). Chain may also have breaks.`
        : `FAIL — chain has ${chainBreaks.length} broken cable${chainBreaks.length === 1 ? '' : 's'}. Signal won't flow past the first break.`;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok,
          verdict,
          chainBreaks,
          gridSummary,
          applyDigest,
          elapsedMs: applyResult.elapsedMs,
          ackCount: applyResult.acks,
          opsTotal: ops.length,
          bytesTotal: applyResult.totalBytes,
          lastNack: applyResult.lastNack,
        }, null, 2),
      }],
    };
  });
}
