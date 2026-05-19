/**
 * Axe-Fx II layout tools — bypass writes, grid reads, and per-cell
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

import { renderGridAscii, renderGridJson, renderGridMarkdown, renderGridSummary } from './gridRender.js';
import {
  GET_RESPONSE_TIMEOUT_MS,
  NO_ACK_NOTE,
  ensureConn,
  findBlock,
  toHex,
} from './shared.js';

export function registerAxeFxIILayoutTools(server: McpServer): void {


  // axefx2_set_block_bypass removed v0.3 — use unified
  // set_bypass({ port: 'axe-fx-ii', block, bypassed }) which routes
  // through descriptor.writer.setBypass (same paramId-255 wire write).

  server.registerTool('axefx2_get_grid_layout', {
    description: [
      'Use this tool to read the active preset\'s 4-row × 12-column block-',
      'placement grid on the user\'s Axe-Fx II. Sends GET_GRID_LAYOUT_AND_',
      'ROUTING (function 0x20) and parses the 48-cell response. Each cell',
      'reports a block ID + a routing-input mask saying which rows of the',
      'previous column connect to its input.',
      '',
      'CRITICAL FOR HONEST AGENT BEHAVIOR — the MVP does NOT support',
      'changing the grid layout (no add/remove/rearrange/cabling). When',
      'the user asks for a tone change, call this FIRST so you know which',
      'blocks are actually placed in the chain. Don\'t suggest tweaks to a',
      'block ("more reverb decay") if it\'s not on the grid — instead say',
      '"I don\'t see a reverb in the chain; please add Reverb 1 to the',
      'grid via the device or AxeEdit, then I can dial it in".',
      '',
      'Cell semantics:',
      '- blockId 100..170 = a placed block (Amp 1 = 106, Reverb 1 = 110, etc).',
      '  Cross-reference axefx2_list_block_types output.',
      '- blockId 200..235 = a shunt (signal pass-through, no effect, used',
      '  to draw cabling around or through a column).',
      '- blockId 0 = empty cell.',
      '',
      'Routing mask: 4 bits, one per row of the previous column.',
      '- mask & 0x01 → connect from row 1 of previous column',
      '- mask & 0x02 → connect from row 2',
      '- mask & 0x04 → connect from row 3',
      '- mask & 0x08 → connect from row 4',
      '- mask = 0    → no input (start of a new chain or empty cell)',
      '',
      'Output formats:',
      '  - `summary` (default) — one-line-per-row prose. Reads well on any',
      '    chat width, surfaces the iconic single-serial-row case as natural',
      '    "CPR1 → WAH1 → ... → REV1" prose. Best for chat UX.',
      '  - `markdown` — markdown table that renders as a real HTML table in',
      '    Claude Desktop / Cursor / Continue. Use when the grid is non-trivial',
      '    (multi-row, parallel paths) and the spatial layout matters.',
      '  - `ascii` — fixed-width 4×12 grid. Useful in terminal-based MCP',
      '    clients or wide monitors. Wraps badly in narrow chat windows.',
      '  - `json` — raw cell array for machine parsing.',
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
    description: [
      'Place a block at a specific grid cell on the Axe-Fx II — the wire-',
      'level write that AxeEdit fires when you drag a block from its',
      'palette onto a grid position. Sends function 0x05 SET_GRID_CELL.',
      '',
      'WHAT IT DOES:',
      '  - Places a block at the specified (row, col) cell.',
      '  - If the block was already on the grid elsewhere, the device',
      '    MOVES it (clears its previous position).',
      '  - Pass `block: "empty"` (or numeric 0) to CLEAR the cell.',
      '',
      'CHAIN ROUTING — placement alone does NOT cable cells:',
      '  fn 0x05 SET_GRID_CELL only PLACES a block; it does not set the',
      '  cell\'s input routing. The cell lands with mask 0 (no input).',
      '  To form a chain, the downstream cell\'s input must be explicitly',
      '  cabled to the upstream cell via fn 0x06 SET_CELL_ROUTING (see',
      '  `axefx2_apply_preset_at` which does this end-to-end). Earlier',
      '  versions of this tool documented an "auto-route on row 2"',
      '  behavior; that was inherited wiring from pre-existing presets,',
      '  not device behavior. Fresh-empty cells start unwired regardless',
      '  of row. (Hardware-verified; see SYSEX-MAP-AXE-FX-II.md § 5c.)',
      '',
      'RECOMMENDED USAGE PATTERNS:',
      '  - Building a preset from scratch: use `axefx2_apply_preset_at`',
      '    instead — it places blocks + shunts AND cables every adjacent',
      '    pair, producing an audible end-to-end chain on a fresh slot.',
      '  - Modifying an existing layout: this tool is fine for single-',
      '    block replacements within an existing cabled chain (the',
      '    downstream cell\'s input mask is preserved as long as you',
      '    replace the upstream block with another in the SAME cell).',
      '  - Building parallel paths or multi-row chains: not yet covered',
      '    by a high-level tool; combine this with explicit `fn 0x06`',
      '    routing writes (no dedicated tool yet — tracked).',
      '',
      'POSITION CONVENTION:',
      '  - `row`: 1..4 (1-indexed, matches device front-panel display).',
      '  - `col`: 1..12 (1-indexed).',
      '  - Wire format uses col-major cell index = (col-1)*4 + (row-1).',
      '    The tool handles the conversion.',
      '',
      'BLOCK REFERENCE:',
      '  - Named blocks (preferred): "Amp 1", "Compressor 1", "Reverb 2"',
      '    etc. — case-insensitive, matched against the blockTypes',
      '    catalog (IDs 100..170).',
      '  - Numeric IDs: pass the 14-bit effect ID directly. Useful for',
      '    Shunts (IDs 200..235, not in the named catalog) — pass 200',
      '    for a generic pass-through cell.',
      '  - "empty" or 0: clears the cell.',
      '',
      'Status: 🟢 wire format hardware-validated on Q8.02 XL+',
      '(session-63 probe sequence, 2026-05-11). Probe-and-observe decode',
      'using passive capture; no bridge required. Routing auto-restore',
      'limitation documented above and queued as a follow-up decode.',
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
          `(NOT OK — the device parsed the frame but rejected it).\n` +
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
          ` downstream cells — if you modified an existing chain, you` +
          ` may need to re-place downstream blocks to restore their` +
          ` input masks.`,
      }],
    };
  });

  server.registerTool('axefx2_set_cell_routing', {
    description: [
      'Add or remove a cable between two adjacent-column grid cells on',
      'the Axe-Fx II — the wire-level write AxeEdit fires when you',
      'click-drag a cable between cells. Sends fn 0x06 SET_CELL_ROUTING.',
      '',
      'WHAT IT DOES:',
      '  - With `connect: true` (default), sets a bit in the destination',
      '    cell\'s input mask so the destination cell receives signal',
      '    from the source cell\'s row.',
      '  - With `connect: false`, clears that bit.',
      '',
      'WHEN TO USE:',
      '  - Parallel chains: cable a single source row into multiple',
      '    destination rows (wet/dry splits, doubled drives, stereo',
      '    splits). After placing the destination blocks at different',
      '    rows of the same column, call this tool once per cable.',
      '  - FX loops: cable from row 1 of one column into row 3 of the',
      '    next column (or any cross-row pair).',
      '  - Mergers: cable multiple source rows into a single destination',
      '    cell (e.g. dry path on row 2, delay on row 1, reverb on row',
      '    3, all cabled into a mixer block at row 2 of the next col).',
      '  - Surgical edits: remove a cable without re-doing the layout.',
      '',
      'CONSTRAINTS:',
      '  - `dstCol` MUST equal `srcCol + 1`. The device only allows',
      '    cables between adjacent columns. Off-column cables (col 2 →',
      '    col 5) are rejected — the device sends a NACK.',
      '  - Cross-row cables are fine: row 1 → row 3 is allowed.',
      '  - The source and destination cells must already hold blocks',
      '    (or shunts) — cabling to/from an empty cell is a no-op on',
      '    the audible signal even if the device acks.',
      '',
      'POSITION CONVENTION:',
      '  - `srcRow` / `dstRow`: 1..4 (1-indexed).',
      '  - `srcCol`: 1..11. `dstCol`: 2..12.',
      '  - Internal wire encoding: col-major cell index = (col-1)*4 +',
      '    (row-1). The tool handles the conversion.',
      '',
      'PREFERRED HIGH-LEVEL ALTERNATIVE:',
      '  - `apply_preset` with a `routing: [...]` array does this for',
      '    you across an entire preset build — one call places every',
      '    block AND wires every cable. Use this single-cable tool for',
      '    incremental tweaks to an existing layout.',
      '',
      'Status: hardware-decoded on Q8.02 XL+ (2026-05-13).',
      'Wire format byte-exact against AxeEdit\'s outbound capture.',
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
          `(NOT OK — frame parsed, write rejected).\n` +
          `Recv (${ack.length}B): ${toHex(ack)}\n` +
          `Common cause: dstCol !== srcCol+1, or one of the cells is empty.`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ackText =
        `No 0x64 ACK arrived within ${GET_RESPONSE_TIMEOUT_MS}ms: ${msg}.\n` +
        `The SET_CELL_ROUTING bytes were sent; verify with axefx2_get_grid_layout.`;
    }

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
