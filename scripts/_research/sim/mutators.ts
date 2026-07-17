/**
 * Codec-backed gen-3 device simulator — write mutators.
 *
 * The editor's outbound writes arrive on the SAME input port as its reads. A
 * mutator updates the in-memory state so the editor's NEXT read (placed-flag /
 * bulk-read / layout) reflects the change, which is what makes the grid
 * re-render after a place / delete / param-set. Mutators return zero or the
 * small ack the editor tolerates (the gen-3 editor does not block on a synch
 * ack for these structural writes; it re-queries).
 *
 * Wire shapes (FM9-confirmed, primitives gen3-fn01-grid-set-position-insert /
 * gen3-fn01-store-preset):
 *   - sub=0x32 INSERT  : [effectId:14b @8..9] [gridPos:14b @12..13]; byte9 high
 *                        septet 0x08 marks a shunt, byte8 = shunt instance.
 *   - sub=0x30 SELECT  : [gridPos:14b @12..13] (cursor move; no state change).
 *   - sub=0x26 STORE   : [presetNum:14b LSB-first @12..13] (persist working buffer).
 *   - sub=0x35 ROUTING : partial decode (cable edge); recorded, not modeled.
 *   - sub=0x09 TYPED   : [effectId:14b @8..9] [paramId:14b @10..11] [value] — the
 *                        param/enum SET whose OUTBOUND frame carries the device-true
 *                        raw-id (the M3 harvest target). Mutates channel-A value.
 */
import {
  gen3Decode14,
  SUB_GRID_INSERT,
  SUB_CELL_SELECT,
  SUB_STORE_PRESET,
  SUB_ROUTING,
  SUB_TYPED_GET,
} from '@mcp-midi-control/fractal-gen3/simResponders.js';
import type { SimDeviceState, BlockState } from './types.js';

const SHUNT_HIGH_SEPTET = 0x08;
const NUM_CHANNELS = 4;

function newBlock(effectId: number): BlockState {
  return {
    effectId,
    channels: Array.from({ length: NUM_CHANNELS }, () => ({ paramValues: new Map() })),
    bulkValues: [],
    itemCount: 0,
    placedFlagBytes: [effectId & 0x7f, (effectId >> 7) & 0x7f],
    mutated: true,
  };
}

/** The fn=0x01 sub-actions that are WRITES (editor → device). */
export const WRITE_SUBS: ReadonlySet<number> = new Set([
  SUB_GRID_INSERT,
  SUB_CELL_SELECT,
  SUB_STORE_PRESET,
  SUB_ROUTING,
  SUB_TYPED_GET,
]);

export interface MutationResult {
  /** Frames to emit back to the editor (usually none for structural writes). */
  replies: number[][];
  /** Effect ids whose state changed (the simulator projects these from now on). */
  touched: number[];
  /** Human label for the emulator log. */
  label: string;
}

/** Apply a write sub-action to state. Returns the (usually empty) reply set. */
export function applyWrite(state: SimDeviceState, bytes: number[]): MutationResult {
  const sub = bytes[6];
  // grid is optional on the config (VP4 is a serial AM4-shape config with no
  // grid); gen-3 grid devices default to 6 rows.
  const rows = state.config.grid?.rows ?? 6;

  if (sub === SUB_GRID_INSERT) {
    const isShunt = (bytes[9] & 0x7f) === SHUNT_HIGH_SEPTET;
    const gridPos = gen3Decode14(bytes[12], bytes[13]);
    if (isShunt) {
      const instance = bytes[8] & 0x7f;
      state.active.grid.set(gridPos, { shunt: true, instance });
      return { replies: [], touched: [], label: `insert shunt#${instance} @gridPos ${gridPos}` };
    }
    const effectId = gen3Decode14(bytes[8], bytes[9]);
    state.active.grid.set(gridPos, { effectId });
    if (!state.active.blocks.has(effectId)) {
      state.active.blocks.set(effectId, newBlock(effectId));
    } else {
      state.active.blocks.get(effectId)!.mutated = true;
    }
    const col = Math.floor(gridPos / rows);
    const row = gridPos % rows;
    return {
      replies: [],
      touched: [effectId],
      label: `insert effect ${effectId} @ row ${row + 1} col ${col + 1} (gridPos ${gridPos})`,
    };
  }

  if (sub === SUB_CELL_SELECT) {
    const gridPos = gen3Decode14(bytes[12], bytes[13]);
    return { replies: [], touched: [], label: `select gridPos ${gridPos}` };
  }

  if (sub === SUB_STORE_PRESET) {
    const presetNum = gen3Decode14(bytes[12], bytes[13]);
    state.active.presetNumber = presetNum;
    return { replies: [], touched: [], label: `store working buffer -> preset ${presetNum}` };
  }

  if (sub === SUB_ROUTING) {
    // sub=0x35 routing edge. The 26-byte frame skeleton is fixed; only four
    // bytes vary. SOLVED by controlled single-cable triangulation (4 cables of
    // known source->dest geometry; see the primitives routing table):
    //   byte 12  : operation — 0x01 / 0x02 connect-vs-disconnect toggle (same
    //              endpoint appears with both; direction still to confirm).
    //   byte 19  : constant 0x02 (edge-record marker).
    //   byte 21  : SOURCE cell, = 3*col + row - 5 (1-based r/c); +1 per source
    //              row, +3 per source column (exact across all 4 cables).
    //   byte 22  : SOURCE cell low-bits companion (varies only with the source;
    //              disambiguates byte 21's column aliasing).
    //   byte 23  : DEST row << 5 (+0x20 per row). Dest COLUMN is implicit
    //              (always source col + 1 — routing is between adjacent columns).
    const op = bytes[12] & 0x7f;
    const srcHi = bytes[21] & 0x7f;
    const srcLo = bytes[22] & 0x7f;
    const destRow = (bytes[23] & 0x7f) >> 5;
    // Invert byte 21 = 3*col + row - 5 is under-determined alone; report the raw
    // source bytes + dest row (the fields the consumer correlates / models).
    return {
      replies: [],
      touched: [],
      label:
        `routing op=0x${op.toString(16)} src=[0x${srcHi.toString(16)},0x${srcLo.toString(16)}] ` +
        `destRow=${destRow} (source byte21=3col+row-5, dest col=src col+1)`,
    };
  }

  if (sub === SUB_TYPED_GET) {
    // Typed SET (the editor's enum/param write). Carries the device-true raw-id
    // in the value field — the M3 harvest target. Mutate channel-A param value.
    const effectId = gen3Decode14(bytes[8], bytes[9]);
    const paramId = gen3Decode14(bytes[10], bytes[11]);
    const value = (bytes[15] & 0x7f) | ((bytes[16] & 0x7f) << 7) | ((bytes[17] & 0x03) << 14);
    const block = state.active.blocks.get(effectId);
    if (block !== undefined) {
      block.channels[0].paramValues.set(paramId, value);
      const stride = block.itemCount > 0 ? Math.floor(block.itemCount / NUM_CHANNELS) : 0;
      if (stride > 0 && paramId < stride) block.bulkValues[paramId] = value;
      block.mutated = true;
      return {
        replies: [],
        touched: [effectId],
        label: `typed SET effect ${effectId} param ${paramId} = ${value} (raw-id harvest)`,
      };
    }
    return { replies: [], touched: [], label: `typed SET effect ${effectId} (not placed)` };
  }

  return { replies: [], touched: [], label: `unhandled write sub=0x${sub.toString(16)}` };
}
