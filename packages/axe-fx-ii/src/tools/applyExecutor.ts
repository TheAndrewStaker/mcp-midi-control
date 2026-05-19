/**
 * Axe-Fx II apply-preset executor — builds the wire-op sequence for a
 * single preset entry and runs it against a live connection. Shared by
 * axefx2_apply_preset, axefx2_apply_preset_at, axefx2_apply_setlist, AND
 * the BK-051 unified Axe-Fx II descriptor's `applyPreset` writer method
 * (which wraps both the working-buffer-only path via
 * `buildApplyPresetOps` and the slot-targeted path via
 * `buildApplyPresetAtOps`).
 */

import type { AxeFxIIBlock } from 'fractal-midi/axe-fx-ii';
import {
  buildGetGridLayout,
  buildSetBlockBypass as buildSetBlockBypassEnvelope,
  buildSetBlockChannel,
  buildSetBlockParameterValue,
  buildSetCellRouting,
  buildSetGridCell,
  buildSetPresetName,
  buildSetSceneNumber,
  buildStorePreset,
  buildSwitchPreset,
  displayToWire,
  isGetGridLayoutResponse,
  isSetCellRoutingResponse,
  isSetGridCellResponse,
  isStorePresetResponse,
  parseGetGridLayoutResponse,
  parseSetCellRoutingResponse,
  parseSetGridCellResponse,
  parseStorePresetResponse,
  type AxeFxIIChannel,
} from 'fractal-midi/axe-fx-ii';

import { GET_RESPONSE_TIMEOUT_MS, findBlock, findParam } from './shared.js';

/**
 * Minimal connection contract used by the executor — both
 * `AxeFxIIConnection` (legacy `ensureConn()` callers) and `MidiConnection`
 * (BK-051 unified descriptor's `ctx.conn`) satisfy this. The executor only
 * needs `send` + `receiveSysExMatching`, so a narrow interface lets both
 * call sites pass their native connection type without casts.
 */
export interface ApplyConn {
  send: (bytes: number[]) => void;
  receiveSysExMatching: (
    predicate: (bytes: number[]) => boolean,
    timeoutMs?: number,
  ) => Promise<number[]>;
}

// -- apply_preset_at + apply_setlist shared helpers ------------------------

/**
 * Shape of a single preset entry — used by both axefx2_apply_preset_at
 * (one entry at a time) and axefx2_apply_setlist (array of entries).
 * Mirrors the inputSchema of apply_preset_at minus the zod wrappers.
 */
/**
 * One placed block in a preset spec. v0.4 adds optional `id`, `row`,
 * `col` for explicit-routing builds (parallel chains, FX loops, wet/dry
 * splits). When omitted, the legacy row-2 sequential placement applies.
 */
export interface ApplyPresetAtBlockEntry {
  block: string | number;
  bypass?: boolean;
  channel?: 'X' | 'Y';
  params?: Record<string, number>;
  /**
   * BK-058: per-channel param writes for blocks with X/Y splits. When
   * present, the executor emits a channel-switch op + the channel's
   * params for each channel listed, in iteration order. Single-channel
   * callers continue to use the flat `params` + optional `channel`
   * shape above; the two shapes are mutually exclusive per block (the
   * translator picks `paramsByChannel` whenever the unified
   * PresetSpec slot uses channel-nested params).
   */
  paramsByChannel?: Partial<Record<'X' | 'Y', Record<string, number>>>;
  /**
   * v0.4: stable identifier for this block within the preset. Routing
   * edges reference blocks by id. When omitted, auto-derived as
   * `<block_lower>_<instance?? 1>` (e.g. amp_1, drive_2).
   */
  id?: string;
  /** v0.4: grid row 1..4. Omitted → row 2 (legacy linear-chain placement). */
  row?: number;
  /**
   * v0.4: grid column 1..12. Omitted → sequential position in the
   * blocks[] array (legacy behavior). When routing is supplied, every
   * block MUST have an explicit col.
   */
  col?: number;
}

/**
 * v0.4: explicit cable between two placed blocks. Resolved by `id`
 * (auto-derived if omitted) at op-build time. `dstCol` MUST equal
 * `srcCol + 1` — the device rejects off-column cables.
 */
export interface ApplyPresetAtRoutingEdge {
  from: string;
  to: string;
  /** Add the cable (default true) or remove it. */
  connect?: boolean;
}

export interface ApplyPresetAtInput {
  preset_number: number;
  blocks: ApplyPresetAtBlockEntry[];
  /**
   * v0.4: explicit cabling. When supplied, the executor:
   *   1. Places each block at its explicit (row, col) — every entry in
   *      `blocks` must include `row` and `col`.
   *   2. Skips the auto-shunt-extension and auto-row-2-cabling.
   *   3. Emits a fn 0x06 SET_CELL_ROUTING write for each edge.
   * When omitted, the legacy row-2 linear-chain pipeline runs.
   */
  routing?: ApplyPresetAtRoutingEdge[];
  /**
   * Single-scene shortcut — switch to this scene (0..7) before writing
   * block params. Kept for back-compat with pre-Session-68 callers.
   * For full per-scene authoring, use `scenes` instead.
   */
  scene?: number;
  /**
   * Per-scene state authoring (HW-106 closure, Session 68). The
   * Axe-Fx II carries per-scene state inside the preset's stored bytes
   * via the switch-write-switch-back pattern — there's no separate
   * envelope for it. Each entry switches to its scene then writes the
   * per-block bypass + channel state for that scene.
   *
   * Scene `index` is 1-indexed (1..8) matching the device front panel
   * and AxeEdit display. Wire is 0-indexed; conversion happens at the
   * executor boundary.
   */
  scenes?: Array<{
    index: number;                              // 1..8 (display)
    bypass?: Record<string, boolean>;           // block-slug → bypassed
    channels?: Record<string, 'X' | 'Y'>;       // block-slug → channel
  }>;
  /**
   * Scene the device lands on after the build (1..8, display). Default
   * 1 — user can audition the song's opening scene immediately. Override
   * for previewing a specific scene-section (e.g. land on solo scene
   * for an immediate lead test).
   */
  landingScene?: number;
  name?: string;
}

export interface ApplyPresetAtOp {
  kind: 'switch_preset' | 'clear_cell' | 'place_block' | 'cable' | 'switch_scene' | 'channel' | 'bypass' | 'param' | 'name' | 'save';
  bytes: number[];
  summary: string;
  awaitResponse?: 'set_grid_cell' | 'set_cell_routing' | 'store_preset';
  // For 'clear_cell' ops only — the (row, col) being cleared. The
  // runtime uses this to skip clears for cells the device's GET_GRID_
  // LAYOUT read confirms are already empty (no point emitting ~40
  // grid writes when the target slot was an empty preset to begin with).
  cellRef?: { row: number; col: number };
}

/**
 * Pure-builder options. `wire: true` short-circuits the display/wire
 * auto-detect path — every param value is treated as a pre-encoded
 * wire integer (0..65534). The BK-051 unified descriptor's
 * `applyPreset` always passes `wire: true` because the schema's
 * `encode` closure is the canonical display→wire path; legacy
 * `axefx2_apply_preset[_at]` omit the flag and keep the auto-detect
 * behavior intact for back-compat.
 */
export interface BuildOptions {
  wire?: boolean;
}

/**
 * Build the full wire-op sequence for one preset entry. Pure function —
 * no I/O, no connection required. Throws on validation errors (unknown
 * block name, unknown param, out-of-range value).
 */
export function buildApplyPresetAtOps(
  input: ApplyPresetAtInput,
  opts: BuildOptions = {},
): ApplyPresetAtOp[] {
  const { preset_number, blocks, scene, name, routing } = input;
  const wireMode = opts.wire ?? false;
  const explicitRouting = routing !== undefined && routing.length > 0;

  // 1. Resolve blocks (catches typos before any op is built).
  // v0.4: each resolved entry now carries its (row, col) and `id` so
  // explicit-routing builds can address blocks by id and place them
  // away from row 2. Legacy callers (no explicit row/col on any block,
  // no routing array) auto-fill row=2, col=index+1 — byte-identical to
  // the pre-v0.4 behavior.
  type ResolvedEntry = {
    target: AxeFxIIBlock;
    bypass?: boolean;
    channel?: AxeFxIIChannel;
    params?: Record<string, number>;
    paramsByChannel?: Partial<Record<AxeFxIIChannel, Record<string, number>>>;
    id: string;
    row: number;
    col: number;
  };
  const resolved: ResolvedEntry[] = [];
  const idsSeen = new Set<string>();
  // BK-054: shunt support in explicit-routing mode. Shunts aren't in
  // AXE_FX_II_BLOCKS (they're pass-through cells, not effects), so
  // `findBlock("shunt")` would throw. Instead, synthesize a unique
  // shunt descriptor per occurrence: SHUNT_BASE_ID..SHUNT_BASE_ID+35
  // are reserved for shunt instances by the device firmware (Session
  // 71 wire capture). Re-using the same blockId across positions
  // triggers the device's "move on duplicate" behavior, so each
  // shunt cell gets a distinct id.
  let shuntCounter = 0;
  const SHUNT_BASE_ID_LOCAL = 200;
  const SHUNT_MAX = 36;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const isShunt =
      (typeof b.block === 'string' && b.block.trim().toLowerCase() === 'shunt') ||
      (typeof b.block === 'number' && b.block >= 200 && b.block <= 235);
    let target: AxeFxIIBlock;
    if (isShunt) {
      if (shuntCounter >= SHUNT_MAX) {
        throw new Error(
          `blocks[${i}]: too many shunts (max ${SHUNT_MAX} per preset — firmware reserves blockIds ${SHUNT_BASE_ID_LOCAL}..${SHUNT_BASE_ID_LOCAL + SHUNT_MAX - 1}).`,
        );
      }
      const shuntId =
        typeof b.block === 'number'
          ? b.block
          : SHUNT_BASE_ID_LOCAL + shuntCounter;
      target = {
        id: shuntId,
        name: `Shunt ${shuntCounter + 1}`,
        groupCode: 'SHUNT',
        canBypass: false,
        availableOnAX8: false,
      };
      shuntCounter++;
    } else {
      target = findBlock(b.block);
    }

    // Resolve row/col. Explicit-routing mode requires both on every
    // block. Legacy mode lets them default to (2, i+1).
    let row: number;
    let col: number;
    if (explicitRouting) {
      if (b.row === undefined || b.col === undefined) {
        throw new Error(
          `blocks[${i}] (${target.name}): routing[] supplied, so every block needs explicit row + col. Pass slot:{row,col} on every PresetSpec.slots entry.`,
        );
      }
      row = b.row;
      col = b.col;
    } else {
      row = b.row ?? 2;
      col = b.col ?? (i + 1);
    }
    if (!Number.isInteger(row) || row < 1 || row > 4) {
      throw new Error(`blocks[${i}] (${target.name}): row ${row} out of range (1..4).`);
    }
    if (!Number.isInteger(col) || col < 1 || col > 12) {
      throw new Error(`blocks[${i}] (${target.name}): col ${col} out of range (1..12).`);
    }

    // Resolve id. Explicit wins; auto-derive from `<lower_name>_1` or
    // `<lower_name>_N` based on whether this is the first instance of
    // that block type in the spec.
    let id = b.id;
    if (id === undefined) {
      const baseSlug = target.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      // If only one instance of this slug exists in the entire blocks[]
      // array, the auto-derived id is just the slug. If multiple, the
      // auto-derive includes a 1-indexed counter — but then the schema
      // requires the caller to disambiguate by supplying explicit ids
      // (we can't pick a stable counter from inspection alone). For
      // now: error if the same auto-slug shows up twice without explicit ids.
      id = baseSlug;
    }
    if (idsSeen.has(id)) {
      throw new Error(
        `blocks[${i}] (${target.name}): block id "${id}" is already used by an earlier block. ` +
        `Two blocks of the same block_type need explicit \`id\` fields to disambiguate ` +
        `(e.g. id:"rhythm_amp" + id:"lead_amp" for two Amp instances).`,
      );
    }
    idsSeen.add(id);

    // BK-058: multi-channel param writes (X+Y). When the unified-surface
    // translator supplies `paramsByChannel`, the executor walks each
    // entry to emit a channel-switch + that channel's params in order.
    // Mutually exclusive with the flat `channel`+`params` shape; the
    // translator picks one based on PresetSpec.params being flat vs
    // channel-nested.
    let paramsByChannel:
      | Partial<Record<AxeFxIIChannel, Record<string, number>>>
      | undefined;
    if (b.paramsByChannel !== undefined) {
      if (b.params !== undefined || b.channel !== undefined) {
        throw new Error(
          `blocks[${i}] (${target.name}): paramsByChannel is mutually exclusive with the flat params/channel shape. Pick one per block.`,
        );
      }
      paramsByChannel = {};
      for (const [chKey, paramMap] of Object.entries(b.paramsByChannel)) {
        const ch = chKey as AxeFxIIChannel;
        if (ch !== 'X' && ch !== 'Y') {
          throw new Error(
            `blocks[${i}] (${target.name}): paramsByChannel has unknown channel "${chKey}" (valid: X, Y).`,
          );
        }
        if (paramMap !== undefined) {
          paramsByChannel[ch] = paramMap;
        }
      }
    }

    resolved.push({
      target,
      bypass: b.bypass,
      channel: b.channel as AxeFxIIChannel | undefined,
      params: b.params as Record<string, number> | undefined,
      paramsByChannel,
      id,
      row,
      col,
    });
  }

  // Set of (row, col) cells the user explicitly placed — used by the
  // clear-cell pre-pass to skip cells we're about to overwrite.
  const placedCells = new Set<string>();
  for (const r of resolved) placedCells.add(`${r.row},${r.col}`);

  // 2. Pre-validate every param + value.
  //
  // BK-058: `channel` is set when the param write belongs to a specific
  // channel from `paramsByChannel`. Single-channel writes (legacy
  // `params` field) leave it undefined and emit alongside the block's
  // optional top-level `channel` switch op (existing behavior).
  interface PendingParamWrite {
    blockIdx: number;
    paramName: string;
    paramId: number;
    wire: number;
    modeNote: string;
    channel?: AxeFxIIChannel;
  }
  const pendingParams: PendingParamWrite[] = [];
  function validateParam(
    blockIdx: number,
    r: ResolvedEntry,
    paramName: string,
    value: number,
    channel: AxeFxIIChannel | undefined,
  ): void {
    const param = findParam(r.target, paramName);
    if (!param) {
      throw new Error(
        `unknown param "${paramName}" for ${r.target.name} ` +
        `(group ${r.target.groupCode}). ` +
        (r.target.groupCode === 'AMP'
          ? `Common amp param names: input_drive (the gain knob, 0..10), master_volume (the master knob, 0..10), bass, middle, treble, presence. "gain"/"master"/"mid" also accepted as aliases.`
          : `Call axefx2_list_params for the full set.`),
      );
    }
    let wire: number;
    let modeNote: string;
    if (wireMode) {
      if (!Number.isInteger(value) || value < 0 || value > 65534) {
        throw new Error(
          `wire value out of range for ${r.target.name}.${paramName}: ${value} ` +
          `(wire mode expects 0..65534 integer).`,
        );
      }
      wire = value;
      modeNote = `wire ${wire}`;
    } else {
      const hasCalibration = param.displayMin !== undefined && param.displayMax !== undefined;
      const useDisplay = hasCalibration && value <= (param.displayMax ?? 0);
      if (useDisplay) {
        wire = displayToWire(value, {
          displayMin: param.displayMin as number,
          displayMax: param.displayMax as number,
          displayScale: param.displayScale,
        });
        modeNote = `${value} → wire ${wire}`;
      } else {
        if (!Number.isInteger(value) || value < 0 || value > 65534) {
          throw new Error(
            `wire value out of range for ${r.target.name}.${paramName}: ${value} ` +
            `(valid 0..65534, or display value if param is calibrated).`,
          );
        }
        wire = value;
        modeNote = `wire ${wire}`;
      }
    }
    pendingParams.push({ blockIdx, paramName, paramId: param.paramId, wire, modeNote, channel });
  }
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (r.paramsByChannel) {
      for (const [chKey, paramMap] of Object.entries(r.paramsByChannel)) {
        const ch = chKey as AxeFxIIChannel;
        if (!paramMap) continue;
        if (!r.target.canBypass) {
          throw new Error(
            `${r.target.name}: paramsByChannel specifies channel ${ch} but this block does not expose X/Y channels on Axe-Fx II.`,
          );
        }
        for (const [paramName, value] of Object.entries(paramMap)) {
          validateParam(i, r, paramName, value, ch);
        }
      }
      continue;
    }
    if (!r.params) continue;
    for (const [paramName, value] of Object.entries(r.params)) {
      validateParam(i, r, paramName, value, undefined);
    }
  }

  // 3. Build the op sequence.
  const ops: ApplyPresetAtOp[] = [];

  ops.push({
    kind: 'switch_preset',
    bytes: buildSwitchPreset(preset_number),
    summary: `LOAD_PRESET → ${preset_number} (target slot)`,
  });

  // Clear ALL 48 cells (4 rows × 12 cols) BEFORE placing the chain.
  //
  // Why all cells, not just row 2 beyond chain length:
  //
  // The previous occupant's blocks on rows 1/3/4 — or on row 2 beyond
  // the chain end — would otherwise stay in the saved preset. HW-105
  // attempt (2026-05-12) surfaced this: a target slot whose previous
  // occupant had MultiDly + Chorus on a non-row-2 position kept those
  // blocks in the saved "Test Clean" preset, even though the user's
  // spec only mentioned Comp + Amp + Cab + Reverb. Wiping every cell
  // first guarantees a fresh canvas; the placement loop then fills
  // row 2 cols 1..N with the user's chain. ~48 grid-cell writes at
  // ~30ms each = ~1.4s of extra wall time per preset — acceptable for
  // the "load before the show" workflow that apply_preset_at is for.
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 12; col++) {
      // Skip cells we're about to place INTO — placement overwrites.
      if (placedCells.has(`${row},${col}`)) continue;
      ops.push({
        kind: 'clear_cell',
        bytes: buildSetGridCell({ row, col, blockId: 0 }),
        summary: `CLEAR row ${row} col ${col}`,
        awaitResponse: 'set_grid_cell',
        cellRef: { row, col },
      });
    }
  }

  // Place every resolved block at its (row, col). Legacy mode populates
  // row 2 cols 1..N; v0.4 explicit-routing mode places blocks at any
  // (row, col) the caller specified.
  for (const r of resolved) {
    ops.push({
      kind: 'place_block',
      bytes: buildSetGridCell({ row: r.row, col: r.col, blockId: r.target.id }),
      summary: `PLACE ${r.target.name} at row ${r.row} col ${r.col}`,
      awaitResponse: 'set_grid_cell',
    });
  }

  // Silent-preset fix — wire row 2 end-to-end with explicit cables.
  //
  // The device's OUTPUT pulls from col 12 of the routing grid. Two
  // separate cabling problems must be solved for a fresh-empty slot
  // to produce audio:
  //
  //   (1) Content-block cabling: cols 1→2, 2→3, ..., N-1→N. Despite
  //       earlier assumptions, the device does NOT auto-route content
  //       blocks placed via fn 0x05 — Session 70 hardware test
  //       (slot 601) showed Comp/Amp/Cab/Reverb sitting in row 2 with
  //       all routing_mask=0 even after fn 0x05 placement. The agent
  //       pinpointed it: AxeEdit fires fn 0x06 SET_CELL_ROUTING on
  //       every cable-drag, including between content blocks.
  //
  //   (2) Shunt-chain extension: cols N+1..12 must hold SHUNT blocks
  //       (blockId 201) cabled left-to-right so signal reaches the
  //       col-12 OUTPUT terminator.
  //
  // Both are solved by the same primitive: `buildSetCellRouting({
  // srcRow, srcCol, dstRow, dstCol, connect: true})` writes fn 0x06
  // (decoded Session 70, captured from AxeEdit Amp→Cab click-to-connect).
  // Sets dst_cell's input-mask bit at src_row_index — for all-row-2
  // chains, that's 0x02 ("feed from row 2 of prev col") on every cell.
  //
  // Op ordering: place all cells first (chain blocks already done +
  // shunts below), then issue all cables in one pass. Decoupling
  // placement from cabling avoids any place→cable→place interactions
  // that could disturb earlier writes' masks.
  //
  // The clear_cell pre-pass above wiped cols N+1..12; the shunt loop
  // below fills them.
  //
  // Each shunt position needs a UNIQUE block instance ID. SHUNT 1 =
  // blockId 200, SHUNT 2 = 201, ..., SHUNT 36 = 235 (per Q8.02 wire
  // capture range). Reusing the same blockId across positions triggers
  // the device's "move on duplicate" behavior — only the LAST
  // placement persists, all earlier cells get cleared as a side
  // effect, leaving the row-2 chain riddled with empty cells (silent
  // preset even after cabling). Confirmed by AxeEdit's session-71
  // in-to-out-route capture: 6 shunt placements at cols 7-12 used
  // blockIds 200, 201, 202, 203, 204, 205 — one unique instance per
  // cell.
  const SHUNT_BASE_ID = 200;
  if (explicitRouting) {
    // v0.4 explicit-routing mode. The agent supplied the full topology
    // via routing[]; we trust it verbatim. Auto-shunt-extension and
    // row-2 auto-cabling are SKIPPED — the caller is responsible for
    // any shunts and cables needed to reach col 12 (OUTPUT terminator).
    //
    // Each routing edge becomes one fn 0x06 SET_CELL_ROUTING write.
    // We resolve src/dst by block id (the auto-derived `<slug>` or
    // explicit `id` field), look up their (row, col) from `resolved`,
    // and emit the cable.
    const blocksById = new Map(resolved.map((r) => [r.id, r]));
    for (let i = 0; i < routing!.length; i++) {
      const edge = routing![i];
      const src = blocksById.get(edge.from);
      const dst = blocksById.get(edge.to);
      if (src === undefined) {
        throw new Error(
          `routing[${i}].from="${edge.from}": no block with that id. ` +
          `Known ids: ${Array.from(blocksById.keys()).join(', ')}`,
        );
      }
      if (dst === undefined) {
        throw new Error(
          `routing[${i}].to="${edge.to}": no block with that id. ` +
          `Known ids: ${Array.from(blocksById.keys()).join(', ')}`,
        );
      }
      if (dst.col !== src.col + 1) {
        throw new Error(
          `routing[${i}] (${edge.from} → ${edge.to}): src col ${src.col} → dst col ${dst.col} not adjacent. ` +
          `The device requires dst_col = src_col + 1. ` +
          `Insert a shunt at the intermediate column(s), or check the placement.`,
        );
      }
      const connect = edge.connect ?? true;
      ops.push({
        kind: 'cable',
        bytes: buildSetCellRouting({
          srcRow: src.row, srcCol: src.col,
          dstRow: dst.row, dstCol: dst.col,
          connect,
        }),
        summary: `${connect ? 'CABLE' : 'UNCABLE'} ${edge.from} (R${src.row}C${src.col}) → ${edge.to} (R${dst.row}C${dst.col})`,
        awaitResponse: 'set_cell_routing',
      });
    }
  } else {
    // Legacy row-2 auto-chain mode. Pre-v0.4 callers don't supply
    // routing[]; we auto-extend with shunts to col 12 and cable every
    // adjacent pair on row 2. Byte-identical to the pre-v0.4
    // behavior — every existing test (slot 600/601/602/608/609) stays
    // green.
    //
    // Pass 1: place all shunts (content blocks were placed above).
    for (let col = resolved.length + 1; col <= 12; col++) {
      const shuntIndex = col - resolved.length;
      const shuntBlockId = SHUNT_BASE_ID + (shuntIndex - 1);
      ops.push({
        kind: 'place_block',
        bytes: buildSetGridCell({ row: 2, col, blockId: shuntBlockId }),
        summary: `PLACE SHUNT ${shuntIndex} (id ${shuntBlockId}) at row 2 col ${col}`,
        awaitResponse: 'set_grid_cell',
      });
    }
    // Pass 2: cable every adjacent pair in row 2 — content blocks AND
    // shunts. Col 1 (first cell) receives input from the implicit INPUT
    // column and needs no cable. All other cells (cols 2..12) need a
    // cable from their left neighbor.
    for (let col = 2; col <= 12; col++) {
      ops.push({
        kind: 'cable',
        bytes: buildSetCellRouting({ srcRow: 2, srcCol: col - 1, dstRow: 2, dstCol: col, connect: true }),
        summary: `CABLE row 2 col ${col - 1} → row 2 col ${col}`,
        awaitResponse: 'set_cell_routing',
      });
    }
  }

  if (scene !== undefined) {
    ops.push({
      kind: 'switch_scene',
      bytes: buildSetSceneNumber(scene),
      summary: `SET_SCENE → ${scene} (display: scene ${scene + 1})`,
    });
  }

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    if (r.bypass !== undefined) {
      ops.push({
        kind: 'bypass',
        bytes: buildSetBlockBypassEnvelope(r.target.id, r.bypass),
        summary: `${r.target.name}: bypass=${r.bypass ? 'BYPASSED' : 'ENGAGED'}`,
      });
    }
    if (r.paramsByChannel !== undefined) {
      // BK-058: walk every channel in iteration order. Each channel emits
      // its own channel-switch op followed by every param targeted at
      // that channel. AM4's executor handles all 4 channels this way; II
      // previously dropped everything but the first channel.
      const channelsInOrder: AxeFxIIChannel[] = [];
      for (const chKey of Object.keys(r.paramsByChannel)) {
        const ch = chKey as AxeFxIIChannel;
        if (ch === 'X' || ch === 'Y') channelsInOrder.push(ch);
      }
      for (const ch of channelsInOrder) {
        ops.push({
          kind: 'channel',
          bytes: buildSetBlockChannel(r.target.id, ch),
          summary: `${r.target.name}: channel=${ch}`,
        });
        for (const pp of pendingParams.filter((p) => p.blockIdx === i && p.channel === ch)) {
          ops.push({
            kind: 'param',
            bytes: buildSetBlockParameterValue({ effectId: r.target.id, paramId: pp.paramId }, pp.wire),
            summary: `${r.target.name}.${pp.paramName} [${ch}] = ${pp.modeNote}`,
          });
        }
      }
    } else {
      if (r.channel !== undefined) {
        ops.push({
          kind: 'channel',
          bytes: buildSetBlockChannel(r.target.id, r.channel),
          summary: `${r.target.name}: channel=${r.channel}`,
        });
      }
      for (const pp of pendingParams.filter((p) => p.blockIdx === i)) {
        ops.push({
          kind: 'param',
          bytes: buildSetBlockParameterValue({ effectId: r.target.id, paramId: pp.paramId }, pp.wire),
          summary: `${r.target.name}.${pp.paramName} = ${pp.modeNote}`,
        });
      }
    }
  }

  // ── Per-scene state authoring ────────────────────────────────────
  //
  // Closes HW-106 (Session 68): the Axe-Fx II carries per-scene state
  // inside the preset's stored bytes. Writes always target the active
  // scene only — there's no separate per-scene envelope. To author
  // each scene's bypass + channel state, walk scenes one at a time:
  //
  //   for each scene:
  //     switch_scene(scene.index - 1)   # 1-indexed → 0-indexed wire
  //     for each block in bypass map:    setBlockBypass
  //     for each block in channels map:  setBlockChannel
  //
  // This pattern is confirmed family-wide by Fractal's official Axe-Fx
  // III MIDI spec: "all writes target the active scene only." The
  // captured 0x29 echoes in session-68-scene-broadcast.syx confirm the
  // device accepts back-to-back scene switches without ack delay.
  //
  // Scene-name writes are deferred — Q8.02 surfaces scene names in
  // AxeEdit but the SET envelope isn't documented in any OSS corpus.
  // Add later once decoded.

  if (input.scenes !== undefined && input.scenes.length > 0) {
    // Pre-validate scene indices to fail fast (rather than mid-wire).
    for (const s of input.scenes) {
      if (!Number.isInteger(s.index) || s.index < 1 || s.index > 8) {
        throw new Error(
          `scenes[].index must be 1..8 (display scene number), got ${s.index}`,
        );
      }
    }
    // Resolve all referenced block names up front — fail before any wire.
    const sceneBlockResolutions = new Map<string, AxeFxIIBlock>();
    for (const s of input.scenes) {
      for (const blockKey of Object.keys({ ...(s.bypass ?? {}), ...(s.channels ?? {}) })) {
        if (sceneBlockResolutions.has(blockKey)) continue;
        sceneBlockResolutions.set(blockKey, findBlock(blockKey));
      }
    }
    for (const s of input.scenes) {
      const wireScene = s.index - 1;
      ops.push({
        kind: 'switch_scene',
        bytes: buildSetSceneNumber(wireScene),
        summary: `SET_SCENE → ${wireScene} (display: scene ${s.index}) — per-scene state walk`,
      });
      // Walk this scene's bypass map.
      for (const [blockKey, bypassed] of Object.entries(s.bypass ?? {})) {
        const target = sceneBlockResolutions.get(blockKey)!;
        ops.push({
          kind: 'bypass',
          bytes: buildSetBlockBypassEnvelope(target.id, bypassed),
          summary: `[scene ${s.index}] ${target.name}: bypass=${bypassed ? 'BYPASSED' : 'ENGAGED'}`,
        });
      }
      // Walk this scene's channel map.
      for (const [blockKey, channel] of Object.entries(s.channels ?? {})) {
        const target = sceneBlockResolutions.get(blockKey)!;
        if (!target.canBypass) {
          throw new Error(
            `scenes[${s.index}].channels: block '${blockKey}' does not expose X/Y channels on Axe-Fx II`,
          );
        }
        ops.push({
          kind: 'channel',
          bytes: buildSetBlockChannel(target.id, channel),
          summary: `[scene ${s.index}] ${target.name}: channel=${channel}`,
        });
      }
    }
    // Land on the requested landingScene (default: scene 1) so the
    // user can audition the opening scene immediately after save.
    const landing = input.landingScene ?? 1;
    if (!Number.isInteger(landing) || landing < 1 || landing > 8) {
      throw new Error(`landingScene must be 1..8 (display), got ${landing}`);
    }
    ops.push({
      kind: 'switch_scene',
      bytes: buildSetSceneNumber(landing - 1),
      summary: `SET_SCENE → ${landing - 1} (display: scene ${landing}) — landing scene`,
    });
  }

  if (name !== undefined) {
    ops.push({
      kind: 'name',
      bytes: buildSetPresetName(name),
      summary: `SET_PRESET_NAME → "${name}"`,
    });
  }
  ops.push({
    kind: 'save',
    bytes: buildStorePreset(preset_number),
    summary: `STORE_PRESET → slot ${preset_number} (display: slot ${preset_number + 1})`,
    awaitResponse: 'store_preset',
  });

  return ops;
}

/**
 * Working-buffer-only variant of {@link buildApplyPresetAtOps}. Same
 * grid-place + per-block param / channel / bypass / scene / name shape,
 * MINUS the leading switch_preset and the trailing STORE_PRESET. Used
 * by the BK-051 unified descriptor's `applyPreset(spec)` path when no
 * target location is supplied — i.e. the CLAUDE.md MVP "conversational
 * preset, working buffer only" workflow.
 *
 * Re-uses {@link buildApplyPresetAtOps} by passing a stub preset_number
 * and stripping the head + tail ops; the param-validation / wire-mode
 * branch / channel-walk logic stays in one place.
 */
export type ApplyPresetInput = Omit<ApplyPresetAtInput, 'preset_number'>;

export function buildApplyPresetOps(
  input: ApplyPresetInput,
  opts: BuildOptions = {},
): ApplyPresetAtOp[] {
  // Re-use the full builder, then strip the switch_preset head + save tail.
  const full = buildApplyPresetAtOps(
    { preset_number: 0, ...input },
    opts,
  );
  return full.filter((op) => op.kind !== 'switch_preset' && op.kind !== 'save');
}

export interface RunOpsResult {
  ok: boolean;
  totalBytes: number;
  acks: number;
  elapsedMs: number;
  summaries: string[];
  lastNack?: { summary: string; resultCode: number };
}

/**
 * Execute a sequence of wire ops against the device. Awaits ACKs for
 * grid-cell and store-preset ops; sends others fire-and-forget. Returns
 * a summary suitable for both single-preset (apply_preset_at) and batch
 * (apply_setlist) callers.
 *
 * `ok` is false iff the FINAL store_preset op got a non-OK ACK (or no
 * ACK at all). Mid-sequence NACKs don't flip ok=false on their own
 * because some grid-cell rejections (e.g. "clear an already-empty cell")
 * may report non-zero result codes but still leave the eventual save
 * functional.
 */
// Post-switch settle window before reading grid layout. The Axe-Fx II
// takes ~100-150ms to actually load a preset after switch_preset; reading
// the grid sooner returns the OLD preset's layout (same race that hit
// scan_preset_range in Session 67). 150ms matches the scan fix.
const POST_SWITCH_SETTLE_MS = 150;
const GRID_LAYOUT_TIMEOUT_MS = 800;

export async function runApplyPresetAtOps(
  conn: ApplyConn,
  ops: ApplyPresetAtOp[],
): Promise<RunOpsResult> {
  const startMs = Date.now();
  let totalBytes = 0;
  let acks = 0;
  let lastNack: { summary: string; resultCode: number } | undefined;
  // Working-buffer sequences (buildApplyPresetOps) have no `save` op —
  // for those, `ok` reduces to "no non-recoverable failures along the
  // way." When a `save` op IS in the sequence (apply_preset_at /
  // apply_setlist), `ok` only flips true once STORE_PRESET acks 0x00.
  const expectsSave = ops.some((o) => o.kind === 'save');
  let finalSaveOk = !expectsSave;
  const summaries: string[] = [];

  // After switch_preset (if present), read the grid layout once and
  // build a "skip set" of already-empty cells. Clear_cell ops targeting
  // those cells are no-ops on the device — skipping them is pure
  // wall-time savings. An empty target preset goes from 42 writes →
  // 0 writes (~1.3s saved); a fully-loaded slot pays only the one-time
  // ~100ms grid read.
  const emptyCells = new Set<string>(); // key: "row,col"
  let gridReadDone = false;

  async function readGridIntoSkipSet(afterSwitch: boolean): Promise<void> {
    if (gridReadDone) return;
    gridReadDone = true;
    try {
      if (afterSwitch) {
        // Settle: switch_preset is async — must wait for load before read.
        await new Promise((res) => setTimeout(res, POST_SWITCH_SETTLE_MS));
      }
      const ackP = conn.receiveSysExMatching(
        isGetGridLayoutResponse,
        GRID_LAYOUT_TIMEOUT_MS,
      );
      conn.send(buildGetGridLayout());
      const ack = await ackP;
      const cells = parseGetGridLayoutResponse(ack);
      for (const c of cells) {
        if (c.blockId === 0) emptyCells.add(`${c.row},${c.col}`);
      }
      summaries.push(
        `  GRID_READ (skip-empty optimization): ${emptyCells.size}/48 cells already empty — those clears will be skipped`,
      );
    } catch (err) {
      // Fall through; we'll emit all clears defensively.
      summaries.push(
        `  GRID_READ failed (${err instanceof Error ? err.message : String(err)}) — emitting all clears defensively`,
      );
    }
  }

  for (const op of ops) {
    // After the switch_preset op (if it ran), do a grid read so we can
    // skip clear_cell ops that target already-empty cells. This is the
    // "merge empty values" optimization — one ~100ms read replaces up
    // to 42 wasted clear writes for a freshly-empty target slot.
    if (op.kind === 'switch_preset' && !gridReadDone) {
      // Fire the switch first (so the device starts loading), THEN read
      // with a 150ms settle so we see the new preset's grid, not the old.
      conn.send(op.bytes);
      totalBytes += op.bytes.length;
      summaries.push(`  ${op.summary}  (${op.bytes.length}B)`);
      await readGridIntoSkipSet(/* afterSwitch */ true);
      continue;
    }
    // For working-buffer-only sequences (no switch_preset op), still do
    // the grid read once before the first clear_cell — no settle needed
    // because the working buffer is already current.
    if (op.kind === 'clear_cell' && !gridReadDone) {
      await readGridIntoSkipSet(/* afterSwitch */ false);
    }

    if (op.kind === 'clear_cell' && op.cellRef !== undefined) {
      const key = `${op.cellRef.row},${op.cellRef.col}`;
      if (emptyCells.has(key)) {
        // Cell is already empty in the loaded preset; skip the wire op.
        summaries.push(`  ${op.summary}  ⊘ already empty (skipped)`);
        continue;
      }
    }

    if (op.awaitResponse === 'set_grid_cell') {
      const ackPromise = conn.receiveSysExMatching(
        isSetGridCellResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      conn.send(op.bytes);
      totalBytes += op.bytes.length;
      try {
        const ack = await ackPromise;
        const parsed = parseSetGridCellResponse(ack);
        if (!parsed.ok) {
          lastNack = { summary: op.summary, resultCode: parsed.resultCode };
          summaries.push(`  ${op.summary}  ❌ result=0x${parsed.resultCode.toString(16)}`);
        } else {
          acks++;
          summaries.push(`  ${op.summary}  ✓`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summaries.push(`  ${op.summary}  ⚠ no ACK (${msg})`);
      }
    } else if (op.awaitResponse === 'set_cell_routing') {
      const ackPromise = conn.receiveSysExMatching(
        isSetCellRoutingResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      conn.send(op.bytes);
      totalBytes += op.bytes.length;
      try {
        const ack = await ackPromise;
        const parsed = parseSetCellRoutingResponse(ack);
        if (!parsed.ok) {
          lastNack = { summary: op.summary, resultCode: parsed.resultCode };
          summaries.push(`  ${op.summary}  ❌ result=0x${parsed.resultCode.toString(16)}`);
        } else {
          acks++;
          summaries.push(`  ${op.summary}  ✓`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summaries.push(`  ${op.summary}  ⚠ no ACK (${msg})`);
      }
    } else if (op.awaitResponse === 'store_preset') {
      const ackPromise = conn.receiveSysExMatching(
        isStorePresetResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      conn.send(op.bytes);
      totalBytes += op.bytes.length;
      try {
        const ack = await ackPromise;
        const parsed = parseStorePresetResponse(ack);
        if (!parsed.ok) {
          lastNack = { summary: op.summary, resultCode: parsed.resultCode };
          summaries.push(`  ${op.summary}  ❌ result=0x${parsed.resultCode.toString(16)} (SAVE FAILED)`);
        } else {
          acks++;
          finalSaveOk = true;
          summaries.push(`  ${op.summary}  ✓ saved`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summaries.push(`  ${op.summary}  ⚠ no ACK (${msg}) (SAVE STATE UNKNOWN)`);
      }
    } else {
      conn.send(op.bytes);
      totalBytes += op.bytes.length;
      summaries.push(`  ${op.summary}  (${op.bytes.length}B)`);
      if (op.kind === 'switch_preset' || op.kind === 'switch_scene' || op.kind === 'channel') {
        await new Promise((res) => setTimeout(res, 20));
      }
    }
  }

  return {
    ok: finalSaveOk,
    totalBytes,
    acks,
    elapsedMs: Date.now() - startMs,
    summaries,
    lastNack,
  };
}
