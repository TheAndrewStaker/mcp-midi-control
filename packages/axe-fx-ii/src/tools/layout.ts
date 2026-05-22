/**
 * Axe-Fx II layout tools, bypass writes, grid reads, and per-cell
 * block placement on the 4×12 routing grid.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { BLOCK_BY_ID } from 'fractal-midi/axe-fx-ii';
import {
  buildGetGridLayout,
  buildSetCellRouting,
  buildSetGridCell,
  isGetGridLayoutResponse,
  isSetCellRoutingResponse,
  isSetGridCellResponse,
  parseGetGridLayoutResponse,
  parseSetCellRoutingResponse,
  parseSetGridCellResponse,
} from 'fractal-midi/axe-fx-ii';

import { invalidateBlockLayoutCache } from '@mcp-midi-control/core/protocol-generic/dispatcher/blockLayoutCache.js';

import { renderGridAscii, renderGridJson, renderGridMarkdown, renderGridSummary } from './gridRender.js';
import {
  GET_RESPONSE_TIMEOUT_MS,
  NO_ACK_NOTE,
  ensureConn,
  findBlock,
  toHex,
} from './shared.js';

export function registerAxeFxIILayoutTools(server: McpServer): void {


  // axefx2_set_block_bypass removed v0.3, use unified
  // set_bypass({ port: 'axe-fx-ii', block, bypassed }) which routes
  // through descriptor.writer.setBypass (same paramId-255 wire write).

  server.registerTool('axefx2_get_grid_layout', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Read the active preset\'s 4-row x 12-column block-placement grid on the Axe-Fx II. Call FIRST before suggesting any tweak so you know which blocks are placed and which are absent.',
      'If a block the user named isn\'t on the grid, say so and ask them to add it via the device or AxeEdit; this tool surface does not yet add/remove grid blocks.',
      '- Cell blockId: 0=empty, 100..170=placed block (Amp 1=106, Reverb 1=110, etc), 200..235=shunt.',
      '- Routing mask is 4 bits, one per source row of the previous column (0x01=row 1, 0x02=row 2, ...). mask=0 means no input.',
      '- format: "summary" (default; one-line-per-row prose), "markdown" (chat-rendered table), "ascii" (fixed-width 4x12 grid), "json" (raw cells).',
    ].join('\n'),
    inputSchema: {
      format: z.enum(['summary', 'markdown', 'ascii', 'json']).optional().describe(
        'Output rendering. "summary" (default) for one-line-per-row prose; "markdown" for a chat-rendered table; "ascii" for fixed-width grid; "json" for raw cell array.',
      ),
    },
  }, async ({ format }) => {
    const reqBytes = buildGetGridLayout();
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isGetGridLayoutResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx2_get_grid_layout failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const cells = parseGetGridLayoutResponse(response);
    const rendered = format === 'json'
      ? renderGridJson(cells)
      : format === 'ascii'
        ? renderGridAscii(cells)
        : format === 'markdown'
          ? renderGridMarkdown(cells)
          : renderGridSummary(cells);
    return {
      content: [{
        type: 'text',
        text:
          `Axe-Fx II grid layout (4 rows × 12 columns, 48 cells):\n\n${rendered}\n\n`,
      }],
    };
  });


  server.registerTool('axefx2_set_block_at_cell', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Place (or clear) a block at a grid cell (row 1..4, col 1..12) on the Axe-Fx II. Wire-level analog of AxeEdit drag-onto-grid.',
      'WARNING: placement alone does NOT cable the cell. New cells land with mask=0 (no input). To form an audible chain, follow with axefx2_set_cell_routing on the downstream cell, OR use apply_preset which places + cables in one call.',
      '- block: name ("Amp 1"), numeric effect ID, "empty"/"clear"/0 to clear, "shunt" or 200..235 for pass-through.',
      '- If the named block is already on the grid, the device MOVES it (clears previous position).',
      '- Replacing within an existing cabled chain preserves the downstream input mask; use this for single-block swaps.',
    ].join('\n'),
    inputSchema: {
      row: z.number().int().min(1).max(4).describe(
        'Grid row 1..4 (1 = top row, 2 = main signal lane on most factory presets).',
      ),
      col: z.number().int().min(1).max(12).describe(
        'Grid column 1..12 (1 = leftmost / chain start).',
      ),
      block: z.union([z.string(), z.number()]).describe(
        'Block to place. Display name (e.g. "Amp 1"), numeric effect ID, "empty"/"clear" to clear the cell, or "shunt" for a pass-through. Shunt IDs 200..235 also accepted as numbers.',
      ),
    },
  }, async ({ row, col, block }) => {
    // Resolve block reference to a numeric ID.
    let blockId: number;
    let displayName: string;
    if (typeof block === 'number') {
      blockId = block;
      if (blockId === 0) {
        displayName = '<empty>';
      } else if (blockId >= 200 && blockId <= 235) {
        displayName = `Shunt (ID ${blockId})`;
      } else {
        const named = BLOCK_BY_ID[blockId];
        displayName = named ? `${named.name} (ID ${blockId})` : `Block ID ${blockId}`;
      }
    } else {
      const norm = block.trim().toLowerCase();
      if (norm === 'empty' || norm === 'clear' || norm === 'none') {
        blockId = 0;
        displayName = '<empty>';
      } else if (norm === 'shunt') {
        blockId = 200;
        displayName = 'Shunt';
      } else {
        const named = findBlock(block);
        blockId = named.id;
        displayName = `${named.name} (ID ${named.id})`;
      }
    }

    const bytes = buildSetGridCell({ row, col, blockId });
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetGridCellResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(bytes);

    let ackText: string;
    try {
      const ack = await responsePromise;
      const parsed = parseSetGridCellResponse(ack);
      if (parsed.ok) {
        ackText =
          `Device ACK: 0x64 echoed_fn=0x05 result_code=0x00 (OK).\n` +
          `Recv (${ack.length}B): ${toHex(ack)}`;
      } else {
        ackText =
          `Device NACK: 0x64 echoed_fn=0x05 result_code=0x` +
          `${parsed.resultCode.toString(16).padStart(2, '0')} ` +
          `(NOT OK, the device parsed the frame but rejected it).\n` +
          `Recv (${ack.length}B): ${toHex(ack)}\n` +
          `Common cause: device firmware refused the placement. The` +
          ` working buffer is likely unchanged; verify with` +
          ` axefx2_get_grid_layout.`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ackText =
        `No 0x64 ACK arrived within ${GET_RESPONSE_TIMEOUT_MS}ms: ${msg}.\n` +
        `The SET_GRID_CELL bytes were sent successfully; verify the` +
        ` change with axefx2_get_grid_layout.`;
    }

    invalidateBlockLayoutCache('axe-fx-ii');

    const cellIdx = (col - 1) * 4 + (row - 1);
    return {
      content: [{
        type: 'text',
        text:
          `Placed ${displayName} at row ${row}, col ${col} ` +
          `(cell index ${cellIdx}).\n` +
          `Wire (${bytes.length}B): ${toHex(bytes)}\n\n` +
          ackText + '\n\n' +
          `Next step: call axefx2_get_grid_layout to see the new grid` +
          ` state. Note: routing/cabling is NOT auto-propagated to` +
          ` downstream cells, if you modified an existing chain, you` +
          ` may need to re-place downstream blocks to restore their` +
          ` input masks.`,
      }],
    };
  });

  server.registerTool('axefx2_set_cell_routing', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Add or remove a cable between two adjacent-column grid cells on the Axe-Fx II. Use for incremental tweaks. For building a fresh chain prefer apply_preset with a routing array, which places + cables in one call.',
      'Use cases: parallel chains (one source -> multiple destination rows), FX loops (row 1 -> row 3 across columns), mergers (multiple source rows -> one mixer cell), surgical cable removal.',
      '- connect=true (default) sets the destination\'s input bit; connect=false clears it.',
      '- dstCol MUST equal srcCol + 1 (device rejects off-column cables). Cross-row pairs are fine.',
      '- Both endpoints must hold a block or shunt; cabling to/from an empty cell is a silent no-op.',
    ].join('\n'),
    inputSchema: {
      srcRow: z.number().int().min(1).max(4).describe(
        'Source row 1..4 (the cell the cable comes FROM).',
      ),
      srcCol: z.number().int().min(1).max(11).describe(
        'Source column 1..11 (must be one less than dstCol).',
      ),
      dstRow: z.number().int().min(1).max(4).describe(
        'Destination row 1..4 (the cell the cable goes TO).',
      ),
      dstCol: z.number().int().min(2).max(12).describe(
        'Destination column 2..12. MUST equal srcCol + 1 (device rejects off-column cables).',
      ),
      connect: z.boolean().optional().describe(
        'true (default) adds the cable; false removes it.',
      ),
    },
  }, async ({ srcRow, srcCol, dstRow, dstCol, connect }) => {
    const cable = connect ?? true;
    let bytes: number[];
    try {
      bytes = buildSetCellRouting({ srcRow, srcCol, dstRow, dstCol, connect: cable });
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: err instanceof Error ? err.message : String(err),
        }],
        isError: true,
      };
    }

    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetCellRoutingResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(bytes);

    const action = cable ? 'Added' : 'Removed';
    const cableLabel = `R${srcRow}C${srcCol} → R${dstRow}C${dstCol}`;
    let ackText: string;
    try {
      const ack = await responsePromise;
      const parsed = parseSetCellRoutingResponse(ack);
      if (parsed.ok) {
        ackText =
          `Device ACK: 0x64 echoed_fn=0x06 result_code=0x00 (OK).\n` +
          `Recv (${ack.length}B): ${toHex(ack)}`;
      } else {
        ackText =
          `Device NACK: 0x64 echoed_fn=0x06 result_code=0x` +
          `${parsed.resultCode.toString(16).padStart(2, '0')} ` +
          `(NOT OK, frame parsed, write rejected).\n` +
          `Recv (${ack.length}B): ${toHex(ack)}\n` +
          `Common cause: dstCol !== srcCol+1, or one of the cells is empty.`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ackText =
        `No 0x64 ACK arrived within ${GET_RESPONSE_TIMEOUT_MS}ms: ${msg}.\n` +
        `The SET_CELL_ROUTING bytes were sent; verify with axefx2_get_grid_layout.`;
    }

    invalidateBlockLayoutCache('axe-fx-ii');

    return {
      content: [{
        type: 'text',
        text:
          `${action} cable ${cableLabel}.\n` +
          `Wire (${bytes.length}B): ${toHex(bytes)}\n\n` +
          ackText + '\n\n' +
          `Next step: axefx2_get_grid_layout shows the destination cell's input mask.`,
      }],
    };
  });

}
