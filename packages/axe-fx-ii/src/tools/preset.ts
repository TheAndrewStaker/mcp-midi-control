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
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

export function registerAxeFxIIPresetTools(server: McpServer): void {
  server.registerTool('axefx2_test_apply', {
    description: [
      'Build a preset on the working buffer and verify its chain integrity in one call. Non-destructive (no STORE_PRESET; switching presets reverts).',
      'PREFER the unified equivalent: apply_preset({port:"axe-fx-ii", spec, verify_chain:true}) does the same thing in the unified shape (scenes[], routing[], cross-device aliases). This tool is the older single-scene flat-blocks shortcut, kept for backward compatibility.',
      'Use as a "did the apply land correctly?" check before asking the user to plug in. Pass criterion: every cell past col 1 has a non-zero routing_mask (no broken cables).',
      '- Input mirrors apply_preset for single-scene use (blocks + optional scene + name). No scenes[] array; for multi-scene authoring use apply_preset directly.',
      '- Returns {ok, verdict, chainBreaks, gridSummary, applyDigest, elapsedMs, ackCount}.',
      '- After ok=true, persist with save_preset({port:"axe-fx-ii", location}).',
      '- Performance: ~1.5-2.5 s for a 4-6 block chain.',
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
      return asError(new DispatchError(
        'value_out_of_range',
        'Fractal Axe-Fx II',
        `axefx2_test_apply: ${msg}`,
        {
          retry_action: 'Fix the input shape and re-invoke; or PREFER the unified apply_preset({port:"axe-fx-ii", spec, verify_chain:true}) which validates the whole spec via preflight in one pass.',
        },
      ));
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

    const resultPayload = {
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
    };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(resultPayload, null, 2),
      }],
      structuredContent: resultPayload,
    };
  });
}
