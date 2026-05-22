/**
 * Axe-Fx II grid-rendering helpers, ASCII / markdown / JSON / summary
 * formats for the 4×12 routing grid. Used by axefx2_get_grid_layout.
 */

import { BLOCK_BY_ID, type AxeFxIIBlock } from 'fractal-midi/axe-fx-ii';
import type { GridCell } from 'fractal-midi/axe-fx-ii';

export function describeCell(cell: GridCell): { label: string; kind: 'block' | 'shunt' | 'empty' } {
  if (cell.blockId === 0) return { label: '·', kind: 'empty' };
  if (cell.blockId >= 200 && cell.blockId <= 235) {
    return { label: `Sh${cell.blockId - 199}`, kind: 'shunt' };
  }
  const block = BLOCK_BY_ID[cell.blockId];
  if (block) {
    // Compact label: group code + instance number from the display name.
    // "Amp 1" → "AMP1", "Reverb 1" → "REV1", "Drive 2" → "DRV2".
    const m = block.name.match(/(\d+)\s*$/);
    const instance = m ? m[1] : '';
    return { label: `${block.groupCode}${instance}`, kind: 'block' };
  }
  return { label: `?${cell.blockId}`, kind: 'block' };
}

export function renderGridAscii(cells: GridCell[]): string {
  // Render columns left-to-right, rows 1..4 top-to-bottom. Each cell shows
  // a compact label (≤ 5 chars) plus the routing-mask hex digit when the
  // cell receives input from a previous column.
  const widths: number[] = Array(12).fill(0);
  const grid: string[][] = Array.from({ length: 4 }, () => Array(12).fill(''));
  for (const cell of cells) {
    const { label } = describeCell(cell);
    const mask = cell.routingFlags === 0 ? '' : `:${cell.routingFlags.toString(16)}`;
    const text = `${label}${mask}`;
    grid[cell.row - 1][cell.col - 1] = text;
    widths[cell.col - 1] = Math.max(widths[cell.col - 1], text.length, 5);
  }
  const lines: string[] = [];
  // Column header
  const header = '     ' + widths.map((w, i) => String(i + 1).padStart(w)).join(' ');
  lines.push(header);
  lines.push('     ' + widths.map((w) => '-'.repeat(w)).join(' '));
  for (let r = 0; r < 4; r++) {
    const row = `R${r + 1} | ` + grid[r].map((cell, c) => cell.padStart(widths[c])).join(' ');
    lines.push(row);
  }
  // Quick block roster, distinct (groupCode, instance) summary, so the
  // agent can reference what's actually placed without re-scanning the grid.
  const placed = cells
    .filter((c) => c.blockId >= 100 && c.blockId <= 170)
    .map((c) => {
      const b = BLOCK_BY_ID[c.blockId];
      return b ? `${b.name} (col ${c.col} row ${c.row})` : `?${c.blockId}`;
    });
  const shunts = cells
    .filter((c) => c.blockId >= 200 && c.blockId <= 235).length;
  const empty = cells.filter((c) => c.blockId === 0).length;
  lines.push('');
  lines.push(`Placed blocks (${placed.length}): ${placed.length === 0 ? '(none)' : placed.join(', ')}`);
  lines.push(`Shunts: ${shunts} | Empty cells: ${empty}`);
  lines.push('');
  lines.push('Routing mask: hex digit after \':\' lists which previous-column rows feed this cell\'s input.');
  lines.push('  e.g. AMP1:1 = receives input from row 1 of the previous column.');
  lines.push('       AMP1:5 = receives input from rows 1 AND 3 (bits 0+2).');
  return lines.join('\n');
}

/**
 * One-line-per-row summary, readable on any chat width, doesn't depend
 * on a fixed-width font, and surfaces the iconic "single serial chain
 * on row 2" case as natural prose. Best default for chat UX.
 *
 * Examples:
 *   "Row 2 (serial, 12 blocks): CPR1 → WAH1 → PHA1 → DRV1 → AMP1 → CAB1
 *    → CHO1 → FLG1 → DLY1 → MTD1 → ROT1 → REV1"
 *   "Row 1: AMP1 (cols 3-4), Row 3: AMP2 (cols 3-4), Row 2: REV1 (col 6)
 *    [parallel amps]"
 */
export function renderGridSummary(cells: GridCell[]): string {
    const lines: string[] = [];
    const placedByRow: Map<number, GridCell[]> = new Map();
    for (const cell of cells) {
        if (cell.blockId === 0) continue;
        if (!placedByRow.has(cell.row)) placedByRow.set(cell.row, []);
        placedByRow.get(cell.row)!.push(cell);
    }
    // Sort cells in each row left-to-right.
    for (const row of placedByRow.values()) row.sort((a, b) => a.col - b.col);

    const activeRows = [...placedByRow.keys()].sort();
    if (activeRows.length === 0) {
        return 'No blocks placed in the active preset.';
    }

    // Detect the iconic "single row, all serial" case for a cleaner summary line.
    if (activeRows.length === 1) {
        const row = activeRows[0];
        const rowCells = placedByRow.get(row)!;
        const blockCells = rowCells.filter((c) => c.blockId >= 100 && c.blockId <= 170);
        const shuntCount = rowCells.filter((c) => c.blockId >= 200 && c.blockId <= 235).length;
        const labels = blockCells.map((c) => describeCell(c).label);
        const shuntNote = shuntCount > 0 ? ` (+ ${shuntCount} shunt${shuntCount === 1 ? '' : 's'})` : '';
        lines.push(
            `Row ${row}, serial chain, ${blockCells.length} block${blockCells.length === 1 ? '' : 's'}${shuntNote}:`,
        );
        lines.push('  ' + labels.join(' → '));

        // Cable-health check: every cell past col 1 must have a non-zero
        // routing mask, otherwise the chain has a break and signal won't
        // reach OUTPUT. Surface broken cables explicitly so the agent
        // (and the founder) catch silent-preset bugs without relying on
        // AxeEdit's display, which can be stale and ambiguous.
        const broken = rowCells
            .filter((c) => c.col > 1 && c.routingFlags === 0)
            .sort((a, b) => a.col - b.col);
        if (broken.length > 0) {
            lines.push('');
            lines.push(
                `⚠ CHAIN BREAK, ${broken.length} cell${broken.length === 1 ? '' : 's'} in this chain ${broken.length === 1 ? 'has' : 'have'} no input cable (routing_mask = 0):`,
            );
            for (const c of broken) {
                const { label } = describeCell(c);
                lines.push(`  - ${label} at row ${c.row} col ${c.col}, expected mask 0x${(1 << (c.row - 1)).toString(16)} (feed from row ${c.row} of col ${c.col - 1})`);
            }
            lines.push(
                'Signal will not flow past the first break. If this is the result of an apply_preset_at, re-run the apply or surface the issue to the user.',
            );
        }
    } else {
        // Multi-row: list each row's contents on its own line. The routing
        // mask is what determines actual signal flow across rows; surface
        // any non-2 routing mask as a parallel-path hint.
        for (const row of activeRows) {
            const rowCells = placedByRow.get(row)!;
            const cellSummaries = rowCells.map((c) => {
                const { label } = describeCell(c);
                const mask = c.routingFlags === 0 ? '' : ` ←r${maskToRowList(c.routingFlags)}`;
                return `${label}@c${c.col}${mask}`;
            });
            lines.push(`Row ${row}: ${cellSummaries.join(', ')}`);
        }
        lines.push('');
        lines.push(
            'Multi-row layout, signal flow follows the routing masks (←rN = receives from row N of the previous column). Use `format: "markdown"` or `"ascii"` for a 2-D view.',
        );
    }

    // Roster of placed blocks (deduplicated by block) so the agent can
    // reference them by name when proposing tweaks.
    const placed = cells
        .filter((c) => c.blockId >= 100 && c.blockId <= 170)
        .map((c) => BLOCK_BY_ID[c.blockId])
        .filter((b): b is AxeFxIIBlock => !!b);
    if (placed.length > 0) {
        lines.push('');
        lines.push(`Placed blocks (${placed.length}): ${placed.map((b) => b.name).join(', ')}`);
    }
    lines.push('');
    lines.push(
        'NOTE: this read shows BLOCK PLACEMENT only. Bypass / scene state per block is a separate concern, most presets have several placed blocks bypassed in the active scene. A consolidated preset-state read is a planned next-session improvement.',
    );

    return lines.join('\n');
}

/** Decode a routing-flags mask into a comma-separated list of source row numbers. */
function maskToRowList(mask: number): string {
    const rows: number[] = [];
    if (mask & 0x01) rows.push(1);
    if (mask & 0x02) rows.push(2);
    if (mask & 0x04) rows.push(3);
    if (mask & 0x08) rows.push(4);
    return rows.length > 0 ? rows.join('+') : '?';
}

/**
 * Markdown table, renders as a real HTML table in Claude Desktop chat
 * and most MCP-host UIs (Cursor, Continue, etc. all render markdown).
 * Responsive to chat width because the host's table layout reflows.
 * Best when the grid is non-trivial (multi-row, parallel paths).
 */
export function renderGridMarkdown(cells: GridCell[]): string {
    const grid: string[][] = Array.from({ length: 4 }, () => Array(12).fill(''));
    for (const cell of cells) {
        const { label } = describeCell(cell);
        const mask = cell.routingFlags === 0 ? '' : `:${cell.routingFlags.toString(16)}`;
        grid[cell.row - 1][cell.col - 1] = `${label}${mask}`;
    }
    const lines: string[] = [];
    // Markdown table header: empty corner + col 1..12.
    lines.push('|   | ' + Array.from({ length: 12 }, (_, i) => String(i + 1)).join(' | ') + ' |');
    lines.push('|---' + '|---'.repeat(12) + '|');
    for (let r = 0; r < 4; r++) {
        lines.push(`| **R${r + 1}** | ` + grid[r].map((cell) => cell || '·').join(' | ') + ' |');
    }
    lines.push('');
    lines.push(
        '_Routing mask: hex digit after `:` lists which previous-column rows feed this cell\'s input (e.g. `AMP1:1` = receives from row 1; `AMP1:5` = receives from rows 1 AND 3)._',
    );
    return lines.join('\n');
}

export function renderGridJson(cells: GridCell[]): string {
  const annotated = cells.map((c) => {
    const { label, kind } = describeCell(c);
    const block = BLOCK_BY_ID[c.blockId];
    return {
      col: c.col,
      row: c.row,
      blockId: c.blockId,
      label,
      kind,
      blockName: block?.name,
      groupCode: block?.groupCode,
      routingFlags: c.routingFlags,
      receivesFromRows: [1, 2, 3, 4].filter((r) => (c.routingFlags >> (r - 1)) & 1),
    };
  });
  return JSON.stringify(annotated, null, 2);
}
