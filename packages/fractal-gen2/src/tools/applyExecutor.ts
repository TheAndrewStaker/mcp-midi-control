/**
 * Axe-Fx II apply-preset executor, builds the wire-op sequence for a
 * single preset entry and runs it against a live connection. Shared by
 * axefx2_apply_preset, axefx2_apply_preset_at, axefx2_apply_setlist, AND
 * the BK-051 unified Axe-Fx II descriptor's `applyPreset` writer method
 * (which wraps both the working-buffer-only path via
 * `buildApplyPresetOps` and the slot-targeted path via
 * `buildApplyPresetAtOps`).
 */

import type { AxeFxIIBlock } from 'fractal-midi/gen2/axe-fx-ii';
import {
  buildGetBlockChannel,
  buildGetBlockParameterValue,
  buildGetGridLayout,
  buildGetSceneNumber,
  buildSetBlockBypass as buildSetBlockBypassEnvelope,
  buildSetBlockChannel,
  buildSetBlockParameterValue,
  buildSetBlockParameterValueInteger,
  buildSetCellRouting,
  buildSetGridCell,
  buildSetPresetName,
  buildSetSceneNumber,
  buildStorePreset,
  buildSwitchPreset,
  isGetBlockChannelResponse,
  isGetBlockParameterResponse,
  isGetGridLayoutResponse,
  isSceneNumberResponse,
  isSetCellRoutingResponse,
  isSetGridCellResponse,
  isStorePresetResponse,
  parseGetBlockChannelResponse,
  parseGetBlockParameterResponse,
  parseGetGridLayoutResponse,
  parseSceneNumberResponse,
  parseSetCellRoutingResponse,
  parseSetGridCellResponse,
  parseStorePresetResponse,
  type AxeFxIIChannel,
} from 'fractal-midi/gen2/axe-fx-ii';

import { GET_RESPONSE_TIMEOUT_MS, findBlock, findParam } from './shared.js';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

/**
 * Enumerate valid param names on a block by walking `KNOWN_PARAMS`
 * and filtering on `groupCode`. Used to seed the shared
 * "unknown param" error formatter so the message lists every valid
 * knob name for the block, ordered by closeness to the bad input.
 */
function listParamNamesForBlockGroup(groupCode: string): string[] {
  const out: string[] = [];
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    if (p.groupCode === groupCode && !out.includes(p.name)) {
      out.push(p.name);
    }
  }
  return out;
}

/**
 * Convert a wire integer to a display float for fn=0x2e SET_PARAM_DIRECT.
 * Used only by the wireMode=true path (legacy callers that pass pre-
 * encoded wire integers). The unified writer's apply path no longer
 * uses wireMode; display values flow through directly via
 * `pp.displayValue`. Calibrated params decode via their display scale;
 * uncalibrated params pass through as-is (wire=display assumption).
 */
function wireToDisplayForBuilder(blockName: string, paramName: string, wire: number): number {
  // findBlock resolves display names ("Amp 1") to AxeFxIIBlock, then
  // findParam gets the AxeFxIIParam with its .block group code, which
  // is what resolveParamKind expects (lowercase "amp", not "Amp 1").
  let resolvedBlockName = blockName;
  try {
    const block = findBlock(blockName);
    const param = findParam(block, paramName);
    if (param) resolvedBlockName = param.block;
  } catch {
    // Fall through with the original blockName.
  }
  const kind = resolveParamKind('axe-fx-ii', resolvedBlockName, paramName);
  if (kind.decodeWire !== undefined) {
    const decoded = kind.decodeWire(wire);
    if (typeof decoded === 'number') return decoded;
  }
  return wire;
}

// Group codes whose firmware rejects fn=0x2e (SET_PARAM_DIRECT) for
// continuous/knob params. Shared constant with writer.ts.
const FN02_ONLY_GROUPS = new Set(['CPR']);

/**
 * Pick the right SET builder for a pending param write.
 *
 * Enum/select params (effect_type, bypass_mode, sidechain, etc.) use
 * fn=0x02 with an integer wire value. Continuous/knob params use
 * fn=0x2e with a float display value, EXCEPT for blocks in
 * FN02_ONLY_GROUPS (compressor) where fn=0x2e no-ops on all param
 * types. Hardware-confirmed 2026-05-26: compressor.effect_type
 * rejected fn=0x2e; alpha.7 field test showed all compressor knobs
 * (threshold, ratio, attack, release, level) also no-op via fn=0x2e.
 */
function buildParamBytes(
  effectId: number,
  pp: { paramId: number; wire: number; displayValue: number; paramName: string; isEnum: boolean },
  wireMode: boolean,
  blockName: string,
  groupCode?: string,
): number[] {
  if (pp.isEnum || (groupCode !== undefined && FN02_ONLY_GROUPS.has(groupCode))) {
    return buildSetBlockParameterValueInteger(
      { effectId, paramId: pp.paramId },
      pp.wire,
    );
  }
  const displayVal = wireMode
    ? wireToDisplayForBuilder(blockName, pp.paramName, pp.wire)
    : pp.displayValue;
  return buildSetBlockParameterValue(
    { effectId, paramId: pp.paramId },
    displayVal,
  );
}

/**
 * Minimal connection contract used by the executor, both
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
 * Shape of a single preset entry, used by both axefx2_apply_preset_at
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
 * `srcCol + 1`, the device rejects off-column cables.
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
   *   1. Places each block at its explicit (row, col), every entry in
   *      `blocks` must include `row` and `col`.
   *   2. Skips the auto-shunt-extension and auto-row-2-cabling.
   *   3. Emits a fn 0x06 SET_CELL_ROUTING write for each edge.
   * When omitted, the legacy row-2 linear-chain pipeline runs.
   */
  routing?: ApplyPresetAtRoutingEdge[];
  /**
   * Single-scene shortcut, switch to this scene (0..7) before writing
   * block params. Kept for back-compat with pre-Session-68 callers.
   * For full per-scene authoring, use `scenes` instead.
   */
  scene?: number;
  /**
   * Per-scene state authoring (HW-106 closure, Session 68). The
   * Axe-Fx II carries per-scene state inside the preset's stored bytes
   * via the switch-write-switch-back pattern, there's no separate
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
   * 1, user can audition the song's opening scene immediately. Override
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
  awaitResponse?: 'set_grid_cell' | 'set_cell_routing' | 'store_preset' | 'channel_verify' | 'scene_verify';
  /** For channel ops: the effectId to verify via GET after the SET. */
  effectId?: number;
  /** For channel ops: the expected channel after the switch. */
  expectedChannel?: AxeFxIIChannel;
  /** For scene_verify ops: the expected scene (1..8 display) after the switch. */
  expectedScene?: number;
  // For 'clear_cell' ops only, the (row, col) being cleared. The
  // runtime uses this to skip clears for cells the device's GET_GRID_
  // LAYOUT read confirms are already empty (no point emitting ~40
  // grid writes when the target slot was an empty preset to begin with).
  cellRef?: { row: number; col: number };
}

/**
 * Pure-builder options. `wire: true` short-circuits the display/wire
 * auto-detect path, every param value is treated as a pre-encoded
 * wire integer (0..65534). Legacy `axefx2_apply_preset[_at]` callers
 * may still pass this flag. The unified descriptor's `applyPreset`
 * no longer uses wireMode: since fn=0x2e takes display floats
 * directly, display values flow through without wire encoding.
 */
export interface BuildOptions {
  wire?: boolean;
}

/**
 * Build the full wire-op sequence for one preset entry. Pure function,
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
  // no routing array) auto-fill row=2, col=index+1, byte-identical to
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
          `blocks[${i}]: too many shunts (max ${SHUNT_MAX} per preset, firmware reserves blockIds ${SHUNT_BASE_ID_LOCAL}..${SHUNT_BASE_ID_LOCAL + SHUNT_MAX - 1}).`,
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
      // auto-derive includes a 1-indexed counter, but then the schema
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

  // Set of (row, col) cells the user explicitly placed, used by the
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
    displayValue: number;
    modeNote: string;
    channel?: AxeFxIIChannel;
    isEnum: boolean;
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
        formatUnknownParamError({
          deviceName: 'Fractal Axe-Fx II',
          block: r.target.name,
          badParam: paramName,
          knownNames: listParamNamesForBlockGroup(r.target.groupCode),
        }),
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
      // Display-value path: values are genuine display units (the
      // unified writer's translateSpec resolves enum strings to numeric
      // indices and validates display range; numeric display values pass
      // through as-is). Compute the wire integer for the `pp.wire` field
      // (validation/logging) but store the original display value in
      // `pp.displayValue` for direct use by the fn=0x2e builder.
      const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
      if (kind.encodeDisplay !== undefined) {
        wire = kind.encodeDisplay(value);
        modeNote = `display ${value} (wire ${wire})`;
      } else {
        // Uncalibrated param: display=wire assumption. Validate as integer.
        if (!Number.isInteger(value) || value < 0 || value > 65534) {
          throw new Error(
            `value out of range for ${r.target.name}.${paramName}: ${value} ` +
            `(valid 0..65534, or display value if param is calibrated).`,
          );
        }
        wire = value;
        modeNote = `display ${wire}`;
      }
    }
    const isEnum = param.controlType === 'select' || 'enumValues' in param;
    pendingParams.push({ blockIdx, paramName, paramId: param.paramId, wire, displayValue: value, modeNote, channel, isEnum });
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
  // The previous occupant's blocks on rows 1/3/4, or on row 2 beyond
  // the chain end, would otherwise stay in the saved preset. HW-105
  // attempt (2026-05-12) surfaced this: a target slot whose previous
  // occupant had MultiDly + Chorus on a non-row-2 position kept those
  // blocks in the saved "Test Clean" preset, even though the user's
  // spec only mentioned Comp + Amp + Cab + Reverb. Wiping every cell
  // first guarantees a fresh canvas; the placement loop then fills
  // row 2 cols 1..N with the user's chain. ~48 grid-cell writes at
  // ~30ms each = ~1.4s of extra wall time per preset, acceptable for
  // the "load before the show" workflow that apply_preset_at is for.
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 12; col++) {
      // Skip cells we're about to place INTO, placement overwrites.
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
  // Place every block AND bypass it in the same step, interleaved, so no
  // block is ever engaged while the grid is being cabled or params written.
  //
  // Anti-screech (hardware-reproduced 2026-06-07). The screech is a transient
  // of the incremental build, NOT the final preset. A half-built high-gain
  // amp sits at default EXTREME gain for the seconds before its EQ/level
  // params land, feeding a delay/reverb whose feedback loop is being cabled
  // live; over a multi-second multi-amp/multi-scene build that runaway loop
  // self-oscillates into a screech. The output mute can't fix it because a
  // self-sustaining oscillation does not drain: it energizes while muted and
  // is still ringing when the mute releases. Isolation test confirmed the
  // delay/reverb feedback path is required (amps alone only pop).
  //
  // Placement itself is safe (blocks are placed UNCABLED — the device does
  // not auto-route fn 0x05 placements, so a placed-but-uncabled block has no
  // signal path), but bypassing each block the instant it lands removes even
  // that window: by the time the cabling phase forms the feedback loop, every
  // block is already bypassed = dry pass-through = silent. Params + channels
  // still store fine while bypassed (bypass gates the signal path, not
  // storage). The finalization (flat) and the per-scene walk below re-engage
  // each block at its FINAL params — a single clean transition into the
  // stable preset, exactly like a normal preset load (which is silent).
  // Shunts (canBypass=false) are pass-through cells with nothing to bypass.
  for (const r of resolved) {
    ops.push({
      kind: 'place_block',
      bytes: buildSetGridCell({ row: r.row, col: r.col, blockId: r.target.id }),
      summary: `PLACE ${r.target.name} at row ${r.row} col ${r.col}`,
      awaitResponse: 'set_grid_cell',
    });
    if (r.target.canBypass) {
      ops.push({
        kind: 'bypass',
        bytes: buildSetBlockBypassEnvelope(r.target.id, true),
        summary: `build-safe BYPASS ${r.target.name} (anti-screech; re-engaged after params)`,
      });
    }
  }

  // Silent-preset fix, wire row 2 end-to-end with explicit cables.
  //
  // The device's OUTPUT pulls from col 12 of the routing grid. Two
  // separate cabling problems must be solved for a fresh-empty slot
  // to produce audio:
  //
  //   (1) Content-block cabling: cols 1→2, 2→3, ..., N-1→N. Despite
  //       earlier assumptions, the device does NOT auto-route content
  //       blocks placed via fn 0x05, Session 70 hardware test
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
  // Sets dst_cell's input-mask bit at src_row_index, for all-row-2
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
  // the device's "move on duplicate" behavior, only the LAST
  // placement persists, all earlier cells get cleared as a side
  // effect, leaving the row-2 chain riddled with empty cells (silent
  // preset even after cabling). Confirmed by AxeEdit's session-71
  // in-to-out-route capture: 6 shunt placements at cols 7-12 used
  // blockIds 200, 201, 202, 203, 204, 205, one unique instance per
  // cell.
  const SHUNT_BASE_ID = 200;
  const OUTPUT_COL = 12;
  if (explicitRouting) {
    // v0.4 explicit-routing mode. The agent supplied the full topology
    // via routing[]; we trust it verbatim for explicit edges.
    //
    // 2026-05-23 OUTPUT-sentinel addition: a routing edge with
    // `to: "OUTPUT"` is a logical marker meaning "this block is the
    // chain end; auto-extend with shunts + cables through col 12 so
    // signal reaches the hardware output sink." Pre-fix, explicit-
    // routing mode SKIPPED the auto-extension entirely, leaving the
    // chain end disconnected from col 12 — the empirical 2026-05-23
    // failure mode. With OUTPUT sentinel:
    //   1. Each non-OUTPUT edge becomes one SET_CELL_ROUTING write
    //      (adjacency check, the usual).
    //   2. For each edge with `to: "OUTPUT"`, the source block's col
    //      defines `tail_start_col`. We auto-emit shunts at every
    //      empty row-2 cell from tail_start_col+1 through col 12,
    //      then row-2 cables for each adjacent pair from
    //      tail_start_col through col 12.
    //
    // Each routing edge becomes one fn 0x06 SET_CELL_ROUTING write
    // unless its `to` is the OUTPUT sentinel. We resolve src/dst by
    // block id (the auto-derived `<slug>` or explicit `id` field),
    // look up their (row, col) from `resolved`, and emit the cable.
    const blocksById = new Map(resolved.map((r) => [r.id, r]));
    // Tolerant id lookup: a single-instance block auto-derives the bare
    // slug (`amp`), but the schema long documented `<block_type>_<instance>`
    // (`amp_1`), so agents reach for the `_1` form. Accept it as an alias
    // for the bare id (and only `_1` — higher instances are real distinct
    // ids). 0.3.0 dev-test finding.
    const lookupBlockId = (id: string) => {
      const direct = blocksById.get(id);
      if (direct !== undefined) return direct;
      if (id.endsWith('_1')) return blocksById.get(id.slice(0, -2));
      return undefined;
    };
    const outputTailStartCols: number[] = [];
    for (let i = 0; i < routing!.length; i++) {
      const edge = routing![i];

      // OUTPUT sentinel: defer to the auto-extension pass below.
      if (edge.to === 'OUTPUT') {
        const src = lookupBlockId(edge.from);
        if (src === undefined) {
          throw new Error(
            `routing[${i}].from="${edge.from}": no block with that id (and "to: OUTPUT" requires a real source). ` +
            `Known ids: ${Array.from(blocksById.keys()).join(', ')}`,
          );
        }
        outputTailStartCols.push(src.col);
        continue;
      }

      const src = lookupBlockId(edge.from);
      const dst = lookupBlockId(edge.to);
      if (src === undefined) {
        throw new Error(
          `routing[${i}].from="${edge.from}": no block with that id. ` +
          `Known ids: ${Array.from(blocksById.keys()).join(', ')}`,
        );
      }
      if (dst === undefined) {
        throw new Error(
          `routing[${i}].to="${edge.to}": no block with that id. ` +
          `Known ids: ${Array.from(blocksById.keys()).join(', ')}. ` +
          `For the device output sink, use the reserved id "OUTPUT": ` +
          `the writer auto-extends with shunts + cables through col ${OUTPUT_COL}.`,
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

    // OUTPUT-sentinel auto-extension. The earliest OUTPUT-anchored
    // source defines the tail start (most builds have one OUTPUT
    // sentinel; multiple sources merging to OUTPUT take the leftmost).
    if (outputTailStartCols.length > 0) {
      const tailStartCol = Math.min(...outputTailStartCols);
      // Track placed cells in row 2 so we don't re-place over existing
      // content blocks. `resolved` carries every placed slot; we only
      // need to extend past the rightmost row-2 placement.
      const row2PlacedCols = new Set<number>();
      for (const r of resolved) {
        if (r.row === 2) row2PlacedCols.add(r.col);
      }
      let shuntIndex = 0;
      for (let col = tailStartCol + 1; col <= OUTPUT_COL; col++) {
        if (row2PlacedCols.has(col)) continue;
        const shuntBlockId = SHUNT_BASE_ID + shuntIndex;
        shuntIndex++;
        ops.push({
          kind: 'place_block',
          bytes: buildSetGridCell({ row: 2, col, blockId: shuntBlockId }),
          summary: `PLACE SHUNT (id ${shuntBlockId}) at row 2 col ${col} (OUTPUT tail extension)`,
          awaitResponse: 'set_grid_cell',
        });
      }
      for (let col = tailStartCol + 1; col <= OUTPUT_COL; col++) {
        ops.push({
          kind: 'cable',
          bytes: buildSetCellRouting({ srcRow: 2, srcCol: col - 1, dstRow: 2, dstCol: col, connect: true }),
          summary: `CABLE row 2 col ${col - 1} → row 2 col ${col} (OUTPUT tail extension)`,
          awaitResponse: 'set_cell_routing',
        });
      }
    }
  } else {
    // Legacy row-2 auto-chain mode. Pre-v0.4 callers don't supply
    // routing[]; we auto-extend with shunts to col 12 and cable every
    // adjacent pair on row 2.
    //
    // Pass 1: fill every EMPTY row-2 cell (cols 1..12) with a unique
    // shunt. Skip cells the user explicitly placed content into.
    //
    // Why walk cols 1..12 rather than `resolved.length+1..12` (pre-fix):
    // hardware probe 2026-05-24 (`probe-axefx2-col1-cable.ts`) confirmed
    // that fn 0x06 SET_CELL_ROUTING rejects with `result_code=0x0e`
    // when the SOURCE cell is empty (blockId 0). The old loop assumed
    // user content packed contiguously into cols 1..N; agents typically
    // start placement at col 2 (matching AxeEdit's INPUT-at-col-1
    // convention), leaving col 1 empty. Cable col 1 to col 2 then NACKs
    // and the whole chain is silent. The new loop guarantees col 1
    // always has SOMETHING (user content if present, otherwise a shunt)
    // so the row-2 cable chain reaches the device output. Also closes
    // the symmetrical bug where the old loop placed shunts at cols
    // `N+1..12` regardless of whether the user had explicit content
    // there: amp@C2 + cab@C3 (N=2) saw a shunt stomp the cab at C3.
    const row2PlacedCols = new Set<number>();
    for (const r of resolved) {
      if (r.row === 2) row2PlacedCols.add(r.col);
    }
    let shuntIndex = 0;
    for (let col = 1; col <= 12; col++) {
      if (row2PlacedCols.has(col)) continue;
      const shuntBlockId = SHUNT_BASE_ID + shuntIndex;
      shuntIndex++;
      ops.push({
        kind: 'place_block',
        bytes: buildSetGridCell({ row: 2, col, blockId: shuntBlockId }),
        summary: `PLACE SHUNT ${shuntIndex} (id ${shuntBlockId}) at row 2 col ${col}`,
        awaitResponse: 'set_grid_cell',
      });
    }
    // Pass 2: cable every adjacent pair in row 2. Col 1's source is now
    // guaranteed non-empty (user content OR shunt placed above); every
    // cable col-1 to col is therefore acceptable to the device.
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
    // NOTE: the flat per-block `bypass` is intentionally NOT emitted here.
    // Every block was build-safe-bypassed at placement (anti-screech); the
    // final bypass state is set AFTER all params land — by the flat
    // finalization below (no-scenes case) or the per-scene walk (scenes
    // case). Engaging a block mid-param-write would re-open the screech
    // window this fix closes.
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
          awaitResponse: 'channel_verify',
          effectId: r.target.id,
          expectedChannel: ch,
        });
        for (const pp of pendingParams.filter((p) => p.blockIdx === i && p.channel === ch)) {
          ops.push({
            kind: 'param',
            bytes: buildParamBytes(r.target.id, pp, wireMode, r.target.name, r.target.groupCode),
            summary: `${r.target.name}.${pp.paramName} [${ch}] = ${pp.modeNote}`,
          });
        }
      }
    } else {
      const blockParams = pendingParams.filter((p) => p.blockIdx === i);
      if (r.channel !== undefined) {
        ops.push({
          kind: 'channel',
          bytes: buildSetBlockChannel(r.target.id, r.channel),
          summary: `${r.target.name}: channel=${r.channel}`,
          awaitResponse: 'channel_verify',
          effectId: r.target.id,
          expectedChannel: r.channel,
        });
      } else if (blockParams.length > 0 && r.target.canBypass) {
        // BUG-4 fix (AM4/II parity): flat params with no explicit `channel`
        // must land somewhere deterministic, not whatever channel the
        // device happens to have active. Default to channel X; the
        // per-scene channel completion below defaults every placed
        // channel-capable block to X on any scene that doesn't explicitly
        // map it elsewhere, so a fresh build is audible on landing without
        // the caller doing anything special.
        ops.push({
          kind: 'channel',
          bytes: buildSetBlockChannel(r.target.id, 'X'),
          summary: `${r.target.name}: channel=X (default, no explicit channel supplied)`,
          awaitResponse: 'channel_verify',
          effectId: r.target.id,
          expectedChannel: 'X',
        });
      }
      for (const pp of blockParams) {
        ops.push({
          kind: 'param',
          bytes: buildParamBytes(r.target.id, pp, wireMode, r.target.name),
          summary: `${r.target.name}.${pp.paramName} = ${pp.modeNote}`,
        });
      }
    }
  }

  // ── Finalize bypass (flat, no-scenes case) ──────────────────────
  //
  // Every placeable block was build-safe-bypassed at placement. When the
  // spec has no per-scene authoring, re-engage each block now (params are
  // final) to its intended state: ENGAGED unless the block's flat `bypass`
  // flag says otherwise. This is a single clean transition into the stable
  // preset on the active scene. The scenes[] walk below owns this instead
  // when per-scene authoring is present (it re-engages per scene).
  if (input.scenes === undefined || input.scenes.length === 0) {
    for (const r of resolved) {
      if (!r.target.canBypass) continue;
      const finalBypass = r.bypass ?? false;
      ops.push({
        kind: 'bypass',
        bytes: buildSetBlockBypassEnvelope(r.target.id, finalBypass),
        summary: `${r.target.name}: bypass=${finalBypass ? 'BYPASSED' : 'ENGAGED'} (final)`,
      });
    }
  }

  // ── Per-scene state authoring ────────────────────────────────────
  //
  // Closes HW-106 (Session 68): the Axe-Fx II carries per-scene state
  // inside the preset's stored bytes. Writes always target the active
  // scene only, there's no separate per-scene envelope. To author
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
  // Scene-name writes are deferred, Q8.02 surfaces scene names in
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
    // Resolve all referenced block names up front, fail before any wire.
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
        summary: `SET_SCENE → ${wireScene} (display: scene ${s.index}), per-scene state walk`,
      });
      // Author this scene's COMPLETE bypass state. Every block was build-
      // safe-bypassed at placement (anti-screech), so we set each placed
      // block directly to its final value for this scene: bypassed if the
      // scene's (sparse) map says so, else engaged. Completeness is required
      // — a sparse override would leave unnamed blocks stuck in the build-safe
      // bypass and silence them. Setting final values directly (rather than
      // engage-all-then-override) also avoids any transient where a block is
      // momentarily engaged when this scene wants it off. Params are already
      // final and bypass is stored per active scene, so each write is a clean
      // transition into a stable state (no screech).
      const sceneBypassById = new Map<number, boolean>();
      for (const [blockKey, bypassed] of Object.entries(s.bypass ?? {})) {
        const target = sceneBlockResolutions.get(blockKey)!;
        sceneBypassById.set(target.id, bypassed);
      }
      for (const r of resolved) {
        if (!r.target.canBypass) continue;
        // Default for a block this scene doesn't name: its flat per-block
        // `bypass` intent (a slot-level `bypassed:true` carried via r.bypass),
        // falling back to ENGAGED. Plain `?? false` would silently override a
        // slot-level bypass for every scene that omits the block.
        const bypassed = sceneBypassById.get(r.target.id) ?? (r.bypass ?? false);
        ops.push({
          kind: 'bypass',
          bytes: buildSetBlockBypassEnvelope(r.target.id, bypassed),
          summary: `[scene ${s.index}] ${r.target.name}: bypass=${bypassed ? 'BYPASSED' : 'ENGAGED'}`,
        });
      }
      // Walk this scene's channel map.
      const explicitlyMappedChannelIds = new Set<number>();
      for (const [blockKey, channel] of Object.entries(s.channels ?? {})) {
        const target = sceneBlockResolutions.get(blockKey)!;
        if (!target.canBypass) {
          throw new Error(
            `scenes[${s.index}].channels: block '${blockKey}' does not expose X/Y channels on Axe-Fx II`,
          );
        }
        explicitlyMappedChannelIds.add(target.id);
        ops.push({
          kind: 'channel',
          bytes: buildSetBlockChannel(target.id, channel),
          summary: `[scene ${s.index}] ${target.name}: channel=${channel}`,
          awaitResponse: 'channel_verify',
          effectId: target.id,
          expectedChannel: channel,
        });
      }
      // BUG-4 completeness (AM4/II parity): any placed channel-capable
      // block this scene doesn't explicitly map defaults to channel X,
      // deterministic regardless of whatever channel the device inherited
      // from the previous preset/scene. Mirrors the bypass-completeness
      // pass above.
      for (const r of resolved) {
        if (!r.target.canBypass) continue;
        if (explicitlyMappedChannelIds.has(r.target.id)) continue;
        ops.push({
          kind: 'channel',
          bytes: buildSetBlockChannel(r.target.id, 'X'),
          summary: `[scene ${s.index}] ${r.target.name}: channel=X (default, not explicitly mapped)`,
          awaitResponse: 'channel_verify',
          effectId: r.target.id,
          expectedChannel: 'X',
        });
      }
    }
    // Land on the requested landingScene (default: scene 1) so the
    // user can audition the opening scene immediately after save.
    const landing = input.landingScene ?? 1;
    if (!Number.isInteger(landing) || landing < 1 || landing > 8) {
      throw new Error(`landingScene must be 1..8 (display), got ${landing}`);
    }
    // The final landing op is the one users observe via get_preset right
    // after apply_preset returns. Per-scene authoring above visits scene
    // 4 last, so a fire-and-forget switch to landingScene can race the
    // device's still-processing per-scene writes and leave the pointer
    // on scene 4. Verify the landing took (mirrors writer.switchScene's
    // F12 pattern: send → settle 20ms → GET_SCENE_NUMBER → retry once on
    // mismatch).
    ops.push({
      kind: 'switch_scene',
      bytes: buildSetSceneNumber(landing - 1),
      summary: `SET_SCENE → ${landing - 1} (display: scene ${landing}), landing scene`,
      awaitResponse: 'scene_verify',
      expectedScene: landing,
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
 * target location is supplied, i.e. the CLAUDE.md MVP "conversational
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

export interface NackedStep {
  /** Index in the ops[] array that NACKed. */
  index: number;
  /** Per-op summary string (the same one used in summaries[]). */
  summary: string;
  /** Device-returned result code (0x00 = OK; non-zero = rejection). */
  resultCode: number;
  /** What kind of op was rejected (set_grid_cell / set_cell_routing / store_preset). */
  kind: 'set_grid_cell' | 'set_cell_routing' | 'store_preset';
}

export interface RunOpsResult {
  ok: boolean;
  totalBytes: number;
  acks: number;
  elapsedMs: number;
  summaries: string[];
  /**
   * Every mid-sequence NACK captured during the run. Empty when all ops
   * acked OK. Replaces the original `lastNack` (which silently
   * overwrote each new failure, hiding earlier rejections from the
   * agent). The dispatcher surfaces this array in chain_integrity /
   * applied_spec response so the agent sees every cable/cell that
   * rejected.
   *
   * Why aggregate instead of just track the first: in the real-world
   * 2026-05-23 trace, the apply emitted ~10 cable writes and 2 NACKed
   * (col2→col3 amp→amp_2 same-type series + col6→col7 reverb→reverb_2
   * same-type series). The original lastNack only retained the
   * second; the first never reached the agent's response.
   */
  nackedSteps: NackedStep[];
  /** @deprecated use nackedSteps; this is the last entry kept for back-compat. */
  lastNack?: { summary: string; resultCode: number };
}

/**
 * Execute a sequence of wire ops against the device. Awaits ACKs for
 * grid-cell and store-preset ops; sends others fire-and-forget. Returns
 * a summary suitable for both single-preset (apply_preset_at) and batch
 * (apply_setlist) callers.
 *
 * `ok` semantics (post-2026-05-23 fix):
 *   - Working-buffer-only sequences (no save): ok = (no cable NACKs).
 *     Mid-sequence NACKs flip ok=false. Pre-fix this only flipped on
 *     the final save op, which silently hid broken cables on
 *     non-saving applies — exactly the chain_integrity false-positive
 *     vector. Audibility verify catches the chain-shape side; this
 *     catches the wire-failure side.
 *   - Save sequences: ok = (no cable NACKs) AND store_preset acked OK.
 *
 * The agent gets `nackedSteps[]` listing every rejection so they can
 * surface all to the user, not just the most recent one.
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
  const nackedSteps: NackedStep[] = [];
  // Working-buffer sequences (buildApplyPresetOps) have no `save` op,
  // for those, `ok` reduces to "no non-recoverable failures along the
  // way." When a `save` op IS in the sequence (apply_preset_at /
  // apply_setlist), `ok` only flips true once STORE_PRESET acks 0x00.
  const expectsSave = ops.some((o) => o.kind === 'save');
  let finalSaveOk = !expectsSave;
  const summaries: string[] = [];

  // After switch_preset (if present), read the grid layout once and
  // build a "skip set" of already-empty cells. Clear_cell ops targeting
  // those cells are no-ops on the device, skipping them is pure
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
        // Settle: switch_preset is async, must wait for load before read.
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
        `  GRID_READ (skip-empty optimization): ${emptyCells.size}/48 cells already empty, those clears will be skipped`,
      );
    } catch (err) {
      // Fall through; we'll emit all clears defensively.
      summaries.push(
        `  GRID_READ failed (${err instanceof Error ? err.message : String(err)}), emitting all clears defensively`,
      );
    }
  }

  // Safety mute: silence the Output block before the sequential write
  // process to prevent dangerous volume from partial preset states.
  // Only applied when the sequence contains param-writing ops (skip for
  // trivial/empty sequences). Output block effectId=140, paramId=0
  // (level_1) is a dB knob: -80 is silent, 0 is unity.
  //
  // The mute and the later restore are VERIFIED, not fire-and-forget. On a
  // flaky USB link SysEx sends drop silently (observed 2026-06-06: four
  // `MidiOutWinMM::sendMessage` errors in one session, and an Output block
  // left at -80 dB after a dropped unmute). A dropped MUTE leaves the whole
  // multi-step build audible — a half-built high-gain amp with no cab load
  // self-oscillates into a screech. A dropped RESTORE leaves the rig silent.
  // Read-back + single retry closes both holes. We also capture the
  // pre-apply level and restore it exactly, instead of clobbering the
  // player's mix to a hardcoded 0 dB.
  const OUTPUT_LEVEL_PARAM = { effectId: 140, paramId: 0 } as const;
  const SAFETY_SETTLE_MS = 60;

  /** GET the Output level (dB). undefined on timeout / unparseable label. */
  async function readOutputLevelDb(): Promise<number | undefined> {
    const p = conn.receiveSysExMatching(
      (b) => isGetBlockParameterResponse(b, OUTPUT_LEVEL_PARAM),
      GET_RESPONSE_TIMEOUT_MS,
    );
    // If the send throws (transport drop), the receive promise would dangle as
    // an unhandled rejection; consume it explicitly.
    p.catch(() => undefined);
    try {
      conn.send(buildGetBlockParameterValue(OUTPUT_LEVEL_PARAM));
      const parsed = parseFloat(parseGetBlockParameterResponse(await p).label);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Set the Output level (dB) and confirm it landed, retrying once. The
   * post-set GET also acts as a drain barrier: because the device's SysEx
   * handler is single-threaded and in-order, a GET response proves every
   * preceding fire-and-forget param write has been processed, so the
   * restore lands only after the chain has settled.
   */
  const SAFETY_MAX_ATTEMPTS = 2;
  async function setOutputLevelVerified(targetDb: number, what: string): Promise<void> {
    for (let attempt = 1; attempt <= SAFETY_MAX_ATTEMPTS; attempt++) {
      const bytes = buildSetBlockParameterValue(OUTPUT_LEVEL_PARAM, targetDb);
      conn.send(bytes);
      totalBytes += bytes.length;
      await new Promise((res) => setTimeout(res, SAFETY_SETTLE_MS));
      const got = await readOutputLevelDb();
      const confirmed = got !== undefined && Math.abs(got - targetDb) <= 1.0;
      const tag = attempt > 1 ? ` [retry ${attempt - 1}]` : '';
      if (confirmed) {
        summaries.push(`  SAFETY: ${what} (output level_1 = ${targetDb} dB)${tag} ✓  (${bytes.length}B)`);
        return;
      }
      const lastAttempt = attempt === SAFETY_MAX_ATTEMPTS;
      if (!lastAttempt) {
        // Re-send on BOTH a read-back mismatch AND a verify timeout. A
        // correlated dropped-SET + timed-out-GET is exactly the failure this
        // path guards (a silently dropped mute leaves the rig audible; a
        // dropped restore leaves it muted), so a timeout must still retry.
        summaries.push(
          `  SAFETY: ${what} unconfirmed (${got === undefined ? 'verify timed out' : `device reads ${got} dB`}); retrying`,
        );
        continue;
      }
      // Final attempt: accept but flag honestly. A timeout means the SET very
      // likely landed (we just can't confirm); a mismatch means it didn't.
      summaries.push(
        got === undefined
          ? `  SAFETY: ${what} (output level_1 = ${targetDb} dB)${tag} (unverified — verify timed out after retry)  (${bytes.length}B)`
          : `  SAFETY: ${what} STILL unconfirmed (device reads ${got} dB) after retry`,
      );
      return;
    }
  }

  const needsSafetyMute = ops.some((o) => o.kind === 'param');
  // A save-to-location sequence (apply_preset_at) leads with a switch_preset
  // that RELOADS the target preset — which resets Output level to the target's
  // stored value. Muting BEFORE that switch is undone by it, and reading
  // priorOutputDb before it captures the PREVIOUS preset's level (then wrongly
  // restores it onto the target). So for those sequences the mute is deferred
  // until right AFTER the switch (in the loop below). Working-buffer sequences
  // have no leading switch and mute up front.
  const hasLeadingSwitch = ops.length > 0 && ops[0].kind === 'switch_preset';
  let priorOutputDb: number | undefined;
  let muteApplied = false;
  async function applySafetyMute(): Promise<void> {
    if (!needsSafetyMute || muteApplied) return;
    muteApplied = true;
    priorOutputDb = await readOutputLevelDb();
    await setOutputLevelVerified(-80, 'muting output during preset apply');
  }
  if (!hasLeadingSwitch) {
    await applySafetyMute();
  }

  try {
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex];
      // After the switch_preset op (if it ran), do a grid read so we can
      // skip clear_cell ops that target already-empty cells. This is the
      // "merge empty values" optimization, one ~100ms read replaces up
      // to 42 wasted clear writes for a freshly-empty target slot.
      if (op.kind === 'switch_preset' && !gridReadDone) {
        // Fire the switch first (so the device starts loading), THEN read
        // with a 150ms settle so we see the new preset's grid, not the old.
        conn.send(op.bytes);
        totalBytes += op.bytes.length;
        summaries.push(`  ${op.summary}  (${op.bytes.length}B)`);
        await readGridIntoSkipSet(/* afterSwitch */ true);
        // Mute NOW (post-switch): the target preset is loaded, so priorOutputDb
        // captures the target's real Output level and the mute survives (the
        // switch that would have reset it has already run).
        await applySafetyMute();
        continue;
      }
      // For working-buffer-only sequences (no switch_preset op), still do
      // the grid read once before the first clear_cell, no settle needed
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
            nackedSteps.push({ index: opIndex, summary: op.summary, resultCode: parsed.resultCode, kind: 'set_grid_cell' });
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
            nackedSteps.push({ index: opIndex, summary: op.summary, resultCode: parsed.resultCode, kind: 'set_cell_routing' });
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
        // Restore the Output level BEFORE storing. The safety mute holds
        // through the whole (dry) build, but STORE_PRESET snapshots the live
        // edit buffer — and Output level is per-preset stored, so storing
        // while muted would bake -80 dB into the SAVED preset (silent on
        // reload, even though the immediate audition sounds fine). Re-assert
        // the captured pre-apply level here; the build is already complete and
        // in its final stable state, so this is the same unmute the working-
        // buffer path does in `finally` (which then becomes a no-op).
        if (muteApplied) {
          await setOutputLevelVerified(priorOutputDb ?? 0, 'restoring output before save');
          muteApplied = false;
        }
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
            nackedSteps.push({ index: opIndex, summary: op.summary, resultCode: parsed.resultCode, kind: 'store_preset' });
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
      } else if (op.awaitResponse === 'scene_verify' && op.expectedScene !== undefined) {
        // Send the SET_SCENE, settle, then GET_SCENE_NUMBER to confirm the
        // device committed the switch. Without this, a fire-and-forget
        // landingScene write can race the device's still-processing
        // per-scene authoring writes and leave the pointer on the last-
        // authored scene (scene 4 in the canonical 4-scene preset).
        // Mirrors writer.switchScene's F12 verify pattern.
        conn.send(op.bytes);
        totalBytes += op.bytes.length;
        await new Promise((res) => setTimeout(res, 20));
        const scenePromise = conn.receiveSysExMatching(
          isSceneNumberResponse,
          GET_RESPONSE_TIMEOUT_MS,
        );
        conn.send(buildGetSceneNumber());
        totalBytes += 11;
        try {
          const ack = await scenePromise;
          const actual = parseSceneNumberResponse(ack) + 1;
          if (actual === op.expectedScene) {
            acks++;
            summaries.push(`  ${op.summary}  ✓ verified scene ${actual}`);
          } else {
            // Retry once. Per-scene writes may still be settling; a single
            // re-send with a slightly longer settle catches the case.
            summaries.push(`  ${op.summary}  ⚠ expected scene ${op.expectedScene}, got ${actual}; retrying`);
            await new Promise((res) => setTimeout(res, 50));
            conn.send(op.bytes);
            totalBytes += op.bytes.length;
            await new Promise((res) => setTimeout(res, 50));
            const retryPromise = conn.receiveSysExMatching(
              isSceneNumberResponse,
              GET_RESPONSE_TIMEOUT_MS,
            );
            conn.send(buildGetSceneNumber());
            totalBytes += 11;
            try {
              const retryAck = await retryPromise;
              const retryActual = parseSceneNumberResponse(retryAck) + 1;
              if (retryActual === op.expectedScene) {
                acks++;
                summaries.push(`    retry ✓ verified scene ${retryActual}`);
              } else {
                summaries.push(`    retry ⚠ device still on scene ${retryActual}`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              summaries.push(`    retry verify timeout (${msg})`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summaries.push(`  ${op.summary}  ⚠ verify timeout (${msg}), settling 100ms`);
          await new Promise((res) => setTimeout(res, 100));
        }
      } else if (op.awaitResponse === 'channel_verify' && op.effectId !== undefined && op.expectedChannel !== undefined) {
        // Channel-switch serialization barrier: send SET, then GET to
        // confirm the device committed the switch before param writes
        // land. The GET response is the timing signal (the device's SysEx
        // handler is single-threaded; processing the GET proves the
        // preceding SET completed).
        conn.send(op.bytes);
        totalBytes += op.bytes.length;
        const verifyPromise = conn.receiveSysExMatching(
          (bytes) => isGetBlockChannelResponse(bytes, op.effectId!),
          GET_RESPONSE_TIMEOUT_MS,
        );
        conn.send(buildGetBlockChannel(op.effectId));
        totalBytes += 11;
        try {
          const ack = await verifyPromise;
          const actual = parseGetBlockChannelResponse(ack);
          if (actual === op.expectedChannel) {
            acks++;
            summaries.push(`  ${op.summary}  ✓ verified`);
          } else {
            summaries.push(`  ${op.summary}  ⚠ expected ${op.expectedChannel}, got ${actual}; retrying`);
            await new Promise((res) => setTimeout(res, 50));
            conn.send(op.bytes);
            totalBytes += op.bytes.length;
            await new Promise((res) => setTimeout(res, 50));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summaries.push(`  ${op.summary}  ⚠ verify timeout (${msg}), settling 100ms`);
          await new Promise((res) => setTimeout(res, 100));
        }
      } else {
        conn.send(op.bytes);
        totalBytes += op.bytes.length;
        summaries.push(`  ${op.summary}  (${op.bytes.length}B)`);
        if (op.kind === 'switch_preset' || op.kind === 'switch_scene') {
          await new Promise((res) => setTimeout(res, 20));
        }
      }
    }
  } finally {
    // Safety unmute: restore the Output level after all ops, even on error.
    // Restore the EXACT pre-apply level when we captured it (no surprise mix
    // change); fall back to 0 dB unity if the pre-read failed. Verified +
    // retried so a dropped restore SET can't leave the rig muted. Gated on
    // muteApplied (not needsSafetyMute): if the deferred mute never ran — e.g.
    // a leading-switch sequence that errored before the switch — there is
    // nothing to restore and priorOutputDb was never captured.
    if (muteApplied) {
      const restoreDb = priorOutputDb ?? 0;
      await setOutputLevelVerified(
        restoreDb,
        priorOutputDb !== undefined
          ? `restoring output to pre-apply level`
          : `restoring output to unity`,
      );
    }
  }

  // Mid-sequence cable NACKs flip ok=false. Pre-fix, only the final
  // save-op NACK flipped this — leaving working-buffer-only sequences
  // with broken cables reporting ok=true. That's the audibility
  // false-positive vector on the wire side (the audibility walker
  // catches it on the chain-shape side; this catches it on the wire-
  // failure side).
  const hadMidSequenceNack = nackedSteps.length > 0;
  return {
    ok: finalSaveOk && !hadMidSequenceNack,
    totalBytes,
    acks,
    elapsedMs: Date.now() - startMs,
    summaries,
    nackedSteps,
    lastNack,
  };
}
