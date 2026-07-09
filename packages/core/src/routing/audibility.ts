/**
 * Device-agnostic audibility walker. Pure function over a parsed routing
 * grid + optional bypass state. Caller supplies a GridAudibilityConfig
 * binding the device-specific constants (output column, output block IDs,
 * send/return block IDs, shunt predicate, block label formatter).
 *
 * Graph building, BFS reachability, cut-vertex analysis, and all
 * detection logic are device-agnostic and live here. Per-device
 * adapters (packages/fractal-gen2, packages/fractal-gen3) import
 * checkAudibility and pass a config.
 *
 * v1 scope (locked 2026-05-22 after wiki research):
 *   - Missing shunt mid-chain: cell past col 1 with routing_flags=0
 *   - Dead leg: cell points to an empty / non-existent source
 *   - No-path-to-output: rightmost-placed column has no input-reachable cell
 *   - Bypassed-MUTE-on-only-path: block bypassed with bypass_mode in
 *     {MUTE, MUTE OUT, MUTE IN} AND every audible input-to-output path
 *     traverses it
 *   - Output block bypassed: bypass_mode is hardware-forced to MUTE
 *   - Send/Return block engaged on active path: soft note only
 *
 * Explicitly OUT of scope:
 *   - Bypassed-amp-leg as a tone judgement.
 *   - Mixer block with every input row at -inf.
 *   - External send/return rig state.
 *   - Global I/O menu mute.
 */

/**
 * A single cell in the routing grid. Structural type: compatible with
 * fractal-midi GridCell shapes without importing from that package.
 */
export interface GridCell {
  row: number;
  col: number;
  /** 14-bit block ID. 0 = empty. */
  blockId: number;
  /** Routing-input mask. Bit N (0..3) set means row N+1 of previous column connects to this input. */
  routingFlags: number;
}

/** Device-specific constants and helpers for the audibility walker. */
export interface GridAudibilityConfig {
  /** The hardware-fixed output column (e.g. 12 for II, 14 for III/FM9). */
  deviceOutputCol: number;
  /** Block IDs that act as chain terminators wired to the hardware output. */
  outputBlockIds: ReadonlySet<number>;
  /** Block IDs for send/return (FX Loop) blocks: emit a soft note when engaged. */
  sendReturnBlockIds: ReadonlySet<number>;
  /** Returns true when the given blockId is a shunt (signal pass-through wire). */
  isShunt: (blockId: number) => boolean;
  /** Human-readable description of the block at (blockId, row, col). */
  blockLabel: (blockId: number, row: number, col: number) => string;
}

/** A break carries enough context for the agent to surface the offending cell to the user. */
export interface AudibilityBreak {
  slot_ref: { row: number; col: number };
  reason: string;
}

export interface AudibilityNote {
  slot_ref: { row: number; col: number };
  note: string;
}

export interface AudibilityReport {
  ok: boolean;
  breaks: readonly AudibilityBreak[];
  notes: readonly AudibilityNote[];
  summary: string;
}

export interface AudibilityInput {
  cells: readonly GridCell[];
  /** True when the block is currently bypassed. Keyed by effectId (the cell's blockId). */
  bypassByBlockId?: ReadonlyMap<number, boolean>;
  /** Display label of the block's bypass_mode param (e.g. "THRU", "MUTE", "MUTE OUT"). Keyed by effectId. */
  bypassModeByBlockId?: ReadonlyMap<number, string>;
}

/** Bypass-mode display labels that kill signal entirely. */
export const MUTING_BYPASS_MODES = new Set(['MUTE', 'MUTE OUT', 'MUTE IN']);

function isPlaced(cell: GridCell | undefined): cell is GridCell {
  return cell !== undefined && cell.blockId !== 0;
}

interface Graph {
  /** Lookup by `${row}:${col}` -> GridCell (placed cells only). */
  byPos: Map<string, GridCell>;
  /** For each placed cell, the placed cells in col-1 that feed its input per routing_flags. */
  predecessors: Map<string, GridCell[]>;
  /** Reverse of predecessors. */
  successors: Map<string, GridCell[]>;
}

function posKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function buildGraph(cells: readonly GridCell[]): Graph {
  const byPos = new Map<string, GridCell>();
  for (const cell of cells) {
    if (!isPlaced(cell)) continue;
    byPos.set(posKey(cell.row, cell.col), cell);
  }
  const predecessors = new Map<string, GridCell[]>();
  const successors = new Map<string, GridCell[]>();
  for (const cell of byPos.values()) {
    if (cell.col === 1) continue;
    for (let bit = 0; bit < 4; bit++) {
      if ((cell.routingFlags & (1 << bit)) === 0) continue;
      const sourceRow = bit + 1;
      const source = byPos.get(posKey(sourceRow, cell.col - 1));
      if (source === undefined) continue;
      const key = posKey(cell.row, cell.col);
      const sourceKeyInverse = posKey(source.row, source.col);
      const preds = predecessors.get(key) ?? [];
      preds.push(source);
      predecessors.set(key, preds);
      const succs = successors.get(sourceKeyInverse) ?? [];
      succs.push(cell);
      successors.set(sourceKeyInverse, succs);
    }
  }
  return { byPos, predecessors, successors };
}

/** Cells reachable forward from any non-empty col-1 cell. */
function computeInputReachable(graph: Graph, excludeKey?: string): Set<string> {
  const reachable = new Set<string>();
  const queue: GridCell[] = [];
  for (const cell of graph.byPos.values()) {
    if (cell.col !== 1) continue;
    const key = posKey(cell.row, cell.col);
    if (key === excludeKey) continue;
    reachable.add(key);
    queue.push(cell);
  }
  while (queue.length > 0) {
    const cell = queue.shift()!;
    const succs = graph.successors.get(posKey(cell.row, cell.col)) ?? [];
    for (const succ of succs) {
      const succKey = posKey(succ.row, succ.col);
      if (succKey === excludeKey) continue;
      if (reachable.has(succKey)) continue;
      reachable.add(succKey);
      queue.push(succ);
    }
  }
  return reachable;
}

function rightmostPlacedCol(graph: Graph): number {
  let max = 0;
  for (const cell of graph.byPos.values()) {
    if (cell.col > max) max = cell.col;
  }
  return max;
}

/**
 * True when removing `cell` from the graph causes the rightmost
 * placed column to lose every input-reachable member. In a single
 * serial chain every cell is a cut vertex; in parallel paths the
 * answer is per-cell.
 */
function isCutVertex(graph: Graph, cell: GridCell, lastCol: number): boolean {
  const excludeKey = posKey(cell.row, cell.col);
  const reachable = computeInputReachable(graph, excludeKey);
  for (const c of graph.byPos.values()) {
    if (c.col !== lastCol) continue;
    if (posKey(c.row, c.col) === excludeKey) continue;
    if (reachable.has(posKey(c.row, c.col))) return false;
  }
  return true;
}

/** Pure check, no I/O. Caller assembles wire reads and passes the parsed data. */
export function checkAudibility(input: AudibilityInput, config: GridAudibilityConfig): AudibilityReport {
  const { cells, bypassByBlockId, bypassModeByBlockId } = input;
  const { deviceOutputCol, outputBlockIds, sendReturnBlockIds, isShunt, blockLabel } = config;
  const graph = buildGraph(cells);
  const breaks: AudibilityBreak[] = [];
  const notes: AudibilityNote[] = [];

  if (graph.byPos.size === 0) {
    return {
      ok: true,
      breaks: [],
      notes: [],
      summary: 'Grid is empty: no placed blocks or shunts. Signal passes through but the preset is acoustically a wire.',
    };
  }

  // Detection 1: routing breaks. Every placed cell past col 1 needs
  // routing_flags pointing to a non-empty source in col-1.
  for (const cell of graph.byPos.values()) {
    if (cell.col === 1) continue;
    const preds = graph.predecessors.get(posKey(cell.row, cell.col)) ?? [];
    if (preds.length === 0) {
      const label = isShunt(cell.blockId)
        ? `shunt at row ${cell.row} col ${cell.col}`
        : blockLabel(cell.blockId, cell.row, cell.col);
      if (cell.routingFlags === 0) {
        breaks.push({
          slot_ref: { row: cell.row, col: cell.col },
          reason: `${label} has routing_mask=0: no input cable. Signal cannot enter this cell. Likely a missing shunt or a deliberate disconnect that left the chain broken.`,
        });
      } else {
        breaks.push({
          slot_ref: { row: cell.row, col: cell.col },
          reason: `${label} has routing_mask=0x${cell.routingFlags.toString(16)} but every source row it points to in col ${cell.col - 1} is empty. Dead leg: signal cannot reach this cell.`,
        });
      }
    }
  }

  // Detection 2: no input-to-output path.
  // The chain is audible when EITHER:
  //   (a) deviceOutputCol has at least one input-reachable cell, OR
  //   (b) a placed output block (per outputBlockIds) is input-reachable.
  const inputReachable = computeInputReachable(graph);
  const lastPlacedCol = rightmostPlacedCol(graph);
  const reachableAtOutputCol = [...graph.byPos.values()].filter(
    (c) => c.col === deviceOutputCol && inputReachable.has(posKey(c.row, c.col)),
  );
  const reachableOutputBlocks = [...graph.byPos.values()].filter(
    (c) => outputBlockIds.has(c.blockId) && inputReachable.has(posKey(c.row, c.col)),
  );
  // Anchor for cut-vertex / bypass-mute analysis: if a placed output
  // block is reachable, use its col as the sink column.
  const sinkCol = reachableOutputBlocks.length > 0
    ? reachableOutputBlocks[0].col
    : deviceOutputCol;
  const reachableAtSink = reachableOutputBlocks.length > 0
    ? reachableOutputBlocks
    : reachableAtOutputCol;
  if (reachableAtSink.length === 0) {
    // Only surface this as a top-level break when the routing-break
    // detection didn't already explain it.
    if (breaks.length === 0) {
      const gapSize = deviceOutputCol - lastPlacedCol;
      if (lastPlacedCol < deviceOutputCol && lastPlacedCol > 0) {
        breaks.push({
          slot_ref: { row: 1, col: deviceOutputCol },
          reason: `Chain ends at col ${lastPlacedCol}; the device output is at col ${deviceOutputCol}. ${gapSize} empty cell(s) separate the last placed block from the output sink, so no signal reaches the hardware output. Extend the chain with shunts (or audio blocks) through col ${deviceOutputCol}, OR add explicit routing edges that span cols ${lastPlacedCol + 1}..${deviceOutputCol}, OR place an Output block at the chain's end as the terminator.`,
        });
      } else {
        breaks.push({
          slot_ref: { row: 1, col: deviceOutputCol },
          reason: `No input-reachable cell in col ${deviceOutputCol} (the device output column) and no placed Output block reachable. The chain has placed blocks but the routing-mask graph leaves the output sink unfed. Check for routing-mask gaps.`,
        });
      }
    }
  }

  // Detection 3: bypassed-MUTE blocks on every audible path. Requires
  // bypass state + bypass_mode lookups. Without them, this pass is a
  // no-op and the verifyChain path falls back to routing breaks only.
  if (bypassByBlockId !== undefined && bypassModeByBlockId !== undefined && reachableAtSink.length > 0) {
    for (const cell of graph.byPos.values()) {
      if (isShunt(cell.blockId)) continue;
      const key = posKey(cell.row, cell.col);
      if (!inputReachable.has(key)) continue;
      const isBypassed = bypassByBlockId.get(cell.blockId) === true;
      if (!isBypassed) continue;

      // Output block: bypass mode is hardware-forced to MUTE regardless
      // of what the bypass_mode param shows.
      if (outputBlockIds.has(cell.blockId)) {
        if (isCutVertex(graph, cell, sinkCol)) {
          breaks.push({
            slot_ref: { row: cell.row, col: cell.col },
            reason: `Output block at row ${cell.row} col ${cell.col} is bypassed. The Output block's bypass mode is hardware-forced to MUTE, so signal will not reach this output. Engage the block (clear bypass) or route around it.`,
          });
        }
        continue;
      }

      const mode = bypassModeByBlockId.get(cell.blockId);
      if (mode === undefined) continue;
      if (!MUTING_BYPASS_MODES.has(mode)) continue;
      if (!isCutVertex(graph, cell, sinkCol)) continue;
      breaks.push({
        slot_ref: { row: cell.row, col: cell.col },
        reason: `${blockLabel(cell.blockId, cell.row, cell.col)} is bypassed with bypass_mode="${mode}", which kills signal. Every audible path goes through this cell, so the preset is silent. Either engage the block, change bypass_mode to "THRU", or add a parallel route.`,
      });
    }
  }

  // Notes: Send/Return block engaged on an input-reachable path.
  for (const cell of graph.byPos.values()) {
    if (!sendReturnBlockIds.has(cell.blockId)) continue;
    if (!inputReachable.has(posKey(cell.row, cell.col))) continue;
    const isBypassed = bypassByBlockId?.get(cell.blockId) === true;
    if (isBypassed) continue;
    notes.push({
      slot_ref: { row: cell.row, col: cell.col },
      note: `${blockLabel(cell.blockId, cell.row, cell.col)} is engaged and sits on the active signal path. Audibility also depends on whatever's wired into the device's physical Send/Return jacks; nothing in the Return jack falls back to dry pass-through (hardware sense), but a powered-down external rig will go silent.`,
    });
  }

  const ok = breaks.length === 0;
  let summary: string;
  if (ok && notes.length === 0) {
    // Report the BLOCK count, not the raw placed-cell count. A full chain to
    // the output fills every cell with blocks PLUS shunts — Fractal's term
    // (Axe-Fx III manual) for the "sonically transparent" connector that
    // spans empty grid locations (blockId 200..235). So `graph.byPos.size`
    // reads e.g. "12" for a preset with only 5 blocks; surfacing that as
    // "N placed cells" reads like "N blocks survived" and led to a false
    // ghost-block report (2026-07-04). Split blocks vs shunts. "block"
    // follows Fractal usage: amp / cab / effect are all blocks; a shunt is
    // called out separately as it carries no processing.
    const shuntCount = [...graph.byPos.values()].filter((c) => isShunt(c.blockId)).length;
    const blockCount = graph.byPos.size - shuntCount;
    const shuntClause = shuntCount > 0
      ? ` (+${shuntCount} shunt${shuntCount === 1 ? '' : 's'})`
      : '';
    summary = `Audibility check: input-to-output path is intact across ${blockCount} block${blockCount === 1 ? '' : 's'}${shuntClause}.`;
  } else if (ok) {
    summary = `Audibility check: path intact, ${notes.length} informational note${notes.length === 1 ? '' : 's'} (see notes[]).`;
  } else {
    const first = breaks[0];
    summary = `Audibility check: ${breaks.length} issue${breaks.length === 1 ? '' : 's'} found; first is at row ${first.slot_ref.row} col ${first.slot_ref.col}.`;
  }

  return { ok, breaks, notes, summary };
}
