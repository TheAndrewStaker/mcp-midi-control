/**
 * Axe-Fx II DeviceDescriptor — `DeviceReader` implementation.
 *
 * 4 read operations:
 *   - `getParam` — single-value read via GET_BLOCK_PARAMETER_VALUE
 *     (function 0x02). Optional pre-read channel switch so callers can
 *     target X/Y without a separate switch call.
 *   - `getParams` — batch wrapper around `getParam`; collects errors
 *     per entry instead of throwing.
 *   - `scanLocations` — switch_preset + GET_PRESET_NAME loop across a
 *     contiguous range; always restores the originally-active preset
 *     at the end.
 *   - `lookupLineage` — Fractal-authored lineage corpus
 *     (amp / drive / reverb / delay).
 *
 * All wire-side I/O uses `ctx.conn.receiveSysExMatching` /
 * `ctx.conn.send`; the lineage pipeline is file-only.
 */

import type {
  DeviceReader,
  DispatchCtx,
  PresetSlotSpec,
  PresetSpec,
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

import {
  AXE_FX_II_BLOCKS,
  AXE_FX_II_XL_PLUS_MODEL_ID,
  BLOCK_BY_ID,
  resolveBlock,
  type AxeFxIIBlock,
} from 'fractal-midi/axe-fx-ii';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/axe-fx-ii';
import {
  buildGetAllParams,
  buildGetBlockParameterValue,
  buildGetGridLayout,
  buildGetPresetName,
  buildGetPresetNumber,
  buildSetBlockChannel,
  buildSwitchPreset,
  isGetBlockParameterResponse,
  isGetGridLayoutResponse,
  isGetPresetNameResponse,
  isGetPresetNumberResponse,
  parseGetBlockParameterResponse,
  parseGetGridLayoutResponse,
  parseGetPresetNameResponse,
  parseGetPresetNumberResponse,
  type AxeFxIIChannel,
  type GridCell,
} from 'fractal-midi/axe-fx-ii';
import {
  AXE_FX_II_LINEAGE_BLOCKS,
  formatAxeFxIILineageRecord,
  runAxeFxIILineageLookup,
  type AxeFxIILineageBlock,
} from '../lineageLookup.js';
import { findParamFuzzy } from 'fractal-midi/axe-fx-ii';

import { findBlockBySlug, parseAxeFxIILocation } from './schema.js';

const DEVICE_LABEL = 'Fractal Axe-Fx II XL+';
const GET_RESPONSE_TIMEOUT_MS = 800;
const CHANNEL_SWITCH_SETTLE_MS = 20;
const MAX_SCAN_RANGE = 64;
// BK-070: fn 0x1F SYSEX_GET_ALL_PARAMS responds with a 1+N+1 state-broadcast
// triple (header 0x74 + N×chunk 0x75 + footer 0x76). Probe-axefx2-fn1f-sweep
// measured ~150 ms per round-trip for the largest blocks; 2 s gives the
// kernel scheduler + USB stack comfortable headroom. Unplaced or shunt
// blocks return a zero-item triple in well under 200 ms.
const FN1F_TRIPLE_TIMEOUT_MS = 2000;
// scan_preset_range only — switch_preset is async on the Axe-Fx II,
// and a 20ms post-switch settle was racing the GET_PRESET_NAME response
// (the device echoed the stale working-buffer name instead of the
// newly-loaded preset's name). 150ms is what AxeEdit waits between
// scene-walk reads in passive captures, and Q8.02 finishes a preset
// load comfortably inside that window.
const SCAN_PRESET_SETTLE_MS = 150;

function resolveBlockOrThrow(slugOrName: string): AxeFxIIBlock {
  const fromSlug = findBlockBySlug(slugOrName);
  if (fromSlug) return fromSlug;
  const fromName = resolveBlock(slugOrName);
  if (fromName) return fromName;
  const sample = AXE_FX_II_BLOCKS.slice(0, 6).map((b) => `"${b.name}"`).join(', ');
  throw new DispatchError(
    'unknown_block',
    DEVICE_LABEL,
    `Block '${slugOrName}' is not valid on Fractal Axe-Fx II. First few: ${sample}…`,
  );
}

/**
 * Enumerate valid param names on a block by walking `KNOWN_PARAMS`
 * and filtering on `groupCode`. Mirrors writer.ts; kept duplicate
 * here so this file doesn't grow a `../descriptor/writer.js` import
 * cycle.
 */
function listParamNamesForBlock(block: AxeFxIIBlock): string[] {
  const out: string[] = [];
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    if (p.groupCode === block.groupCode && !out.includes(p.name)) {
      out.push(p.name);
    }
  }
  return out;
}

function findParamOrThrow(block: AxeFxIIBlock, name: string): AxeFxIIParam {
  const p = findParamFuzzy(block, name);
  if (p) return p;
  throw new DispatchError(
    'unknown_param',
    DEVICE_LABEL,
    formatUnknownParamError({
      deviceName: DEVICE_LABEL,
      block: block.name,
      badParam: name,
      knownNames: listParamNamesForBlock(block),
    }),
  );
}

function unitFor(param: AxeFxIIParam): string {
  // Cross-device source of truth for "what unit does the LLM see."
  // Same resolver schema.ts/writer.ts use, so the unit reported on
  // get_param matches what set_param's encode closure expects.
  return resolveParamKind('axe-fx-ii', param.block, param.name).unit;
}

// ── BK-070: bulk per-block atomic read via fn 0x1F ──────────────────
//
// `readAllParams` issues a SYSEX_GET_ALL_PARAMS request and reassembles
// the device's 0x74 / N×0x75 / 0x76 state-broadcast triple into a
// (paramId → wireValue) map. Codec primitive lives in fractal-midi
// (`buildGetAllParams`); the inbound-triple parser is inline here for
// now and could be lifted into the codec on the next alpha bump.
//
// Wire shape (Session 60 decode + Session 103 hardware-verification):
//   Header (fn 0x74):
//     F0 00 01 74 07 74 [t_lo t_hi] [c_lo c_hi] [op] [cs] F7
//     - targetId  = decode14(t_lo, t_hi)   → outgoing effectId echoed
//     - itemCount = decode14(c_lo, c_hi)   → number of 16-bit values
//     - op        = 0x01 (block-state) or 0x00 (preset-structure edit)
//   Chunks (fn 0x75):
//     F0 00 01 74 07 75 [n_lo n_hi] [N × 3 packed septets] [cs] F7
//     - n = decode14(n_lo, n_hi)  → values in this chunk (max ~340)
//     - each value = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14)
//   Footer (fn 0x76):
//     F0 00 01 74 07 76 [cs] F7 — empty; marks end of triple.
//
// Position-as-paramId pattern (Session 60): values[i] is the wire value
// of paramId i for that block's group. Catalog lookup via KNOWN_PARAMS
// filtered by groupCode.

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}

interface DecodedTriple {
  targetId: number;
  itemCount: number;
  opFlag: number;
  values: number[];
}

function isFn(bytes: number[], fn: number): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === 0xf0
    && bytes[1] === 0x00
    && bytes[2] === 0x01
    && bytes[3] === 0x74
    && bytes[4] === AXE_FX_II_XL_PLUS_MODEL_ID
    && bytes[5] === fn
  );
}

function decodeChunk(bytes: number[]): number[] {
  // bytes[6..7] = item count septet pair; bytes[8..] = N × 3 packed septets
  const itemCount = decode14(bytes[6], bytes[7]);
  const out: number[] = [];
  const start = 8;
  const end = bytes.length - 2; // exclude checksum + F7
  for (let i = 0; i < itemCount; i++) {
    const off = start + i * 3;
    if (off + 2 >= end) break;
    out.push(decode16Packed(bytes[off], bytes[off + 1], bytes[off + 2]));
  }
  return out;
}

async function readAllParams(
  ctx: DispatchCtx,
  effectId: number,
): Promise<DecodedTriple> {
  // Collect inbound triples by listening for fn 0x74 header matching our
  // targetId, then accumulating subsequent fn 0x75 chunks until fn 0x76.
  // Subscribe BEFORE send so the device's response can't outrace the
  // listener registration (state-broadcast triples are bursty — header +
  // chunks land within a single USB callback frame on Q8.02).
  let header: DecodedTriple | undefined;
  const values: number[] = [];
  let footerSeen = false;
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const donePromise = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const unsubscribe = ctx.conn.onMessage((bytes) => {
    if (isFn(bytes, 0x74)) {
      const tId = decode14(bytes[6], bytes[7]);
      if (tId !== effectId) return; // unrelated broadcast (e.g. front-panel edit)
      if (header !== undefined) return; // already saw one — ignore duplicates
      header = {
        targetId: tId,
        itemCount: decode14(bytes[8], bytes[9]),
        opFlag: bytes[10],
        values: [],
      };
    } else if (isFn(bytes, 0x75)) {
      if (header === undefined) return; // chunk before header — drop
      for (const v of decodeChunk(bytes)) values.push(v);
    } else if (isFn(bytes, 0x76)) {
      if (header === undefined) return; // footer before header — drop
      footerSeen = true;
      resolveDone();
    }
  });
  const timer = setTimeout(() => {
    // Some shunts / unplaced blocks return only the header + footer with
    // zero chunks; that's a valid triple. Resolve if we at least saw a
    // header, otherwise reject as a real timeout.
    if (header !== undefined) resolveDone();
    else rejectDone(new Error(`fn 0x1F triple timeout for effectId ${effectId}`));
  }, FN1F_TRIPLE_TIMEOUT_MS);
  try {
    ctx.conn.send(buildGetAllParams(effectId));
    await donePromise;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  if (header === undefined) {
    throw new DispatchError(
      'no_ack',
      DEVICE_LABEL,
      `readAllParams(${effectId}): no state-broadcast header arrived within ${FN1F_TRIPLE_TIMEOUT_MS}ms. The block may not be placed (fn 0x1F rejects empty effectIds with a multipurpose-NACK) or the MIDI handle may be stale.`,
    );
  }
  return { ...header, values };
}

/**
 * Index every KNOWN_PARAMS entry for a given groupCode by its paramId,
 * so the (position i → paramId i) overlay can look up the param's name +
 * decode function in one map access.
 */
function buildGroupParamIndex(groupCode: string): Map<number, AxeFxIIParam> {
  const out = new Map<number, AxeFxIIParam>();
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    if (p.groupCode === groupCode) out.set(p.paramId, p);
  }
  return out;
}

/**
 * Split a grid into a deduplicated list of placed blocks with their
 * canonical (block_type, instance, slot) coordinates. Skips empty cells
 * (blockId=0) and shunts (200..235); skips duplicate cells (multi-cell
 * blocks span multiple grid positions but the device returns the same
 * blockId once per cell).
 */
interface PlacedBlock {
  effectId: number;
  blockType: string;       // slug like "amp", "drive"
  instance: number;        // 1-indexed
  slot: { row: number; col: number };
  displayName: string;     // "Amp 1" / "Reverb 2"
  canBypass: boolean;
}

function collectPlacedBlocks(cells: readonly GridCell[]): PlacedBlock[] {
  const seen = new Set<number>();
  const placed: PlacedBlock[] = [];
  for (const cell of cells) {
    if (cell.blockId === 0) continue;
    if (cell.blockId >= 200 && cell.blockId <= 235) continue; // shunt
    if (seen.has(cell.blockId)) continue;
    seen.add(cell.blockId);
    const block = BLOCK_BY_ID[cell.blockId];
    if (block === undefined) continue;
    // "Amp 1" → slug "amp", instance 1. The trailing number on each
    // block.name encodes the instance; the slug is everything before.
    const m = /^(.+?)\s+(\d+)$/.exec(block.name);
    const blockType = (m ? m[1] : block.name).toLowerCase();
    const instance = m ? Number(m[2]) : 1;
    placed.push({
      effectId: cell.blockId,
      blockType,
      instance,
      slot: { row: cell.row, col: cell.col },
      displayName: block.name,
      canBypass: block.canBypass,
    });
  }
  return placed;
}

function normalizeChannel(channel: string | number | undefined): AxeFxIIChannel | undefined {
  if (channel === undefined) return undefined;
  if (typeof channel === 'number') {
    if (channel === 0) return 'X';
    if (channel === 1) return 'Y';
    throw new DispatchError(
      'bad_channel',
      DEVICE_LABEL,
      `Channel index ${channel} is out of range on Fractal Axe-Fx II (valid: 0=X, 1=Y).`,
    );
  }
  const upper = channel.trim().toUpperCase();
  if (upper === 'X' || upper === 'Y') return upper as AxeFxIIChannel;
  throw new DispatchError(
    'bad_channel',
    DEVICE_LABEL,
    `Channel '${channel}' is not valid on Fractal Axe-Fx II (channels are X/Y).`,
  );
}

export const reader: DeviceReader = {
  async getParam(ctx: DispatchCtx, blockSlug, name, channel): Promise<ReadResult> {
    const block = resolveBlockOrThrow(blockSlug);
    const param = findParamOrThrow(block, name);
    const channelWire = normalizeChannel(channel);

    if (channelWire !== undefined && block.canBypass) {
      ctx.conn.send(buildSetBlockChannel(block.id, channelWire));
      await new Promise((res) => setTimeout(res, CHANNEL_SWITCH_SETTLE_MS));
    }

    const targetId = { effectId: block.id, paramId: param.paramId };
    const responsePromise = ctx.conn.receiveSysExMatching(
      (bytes) => isGetBlockParameterResponse(bytes, targetId),
      GET_RESPONSE_TIMEOUT_MS,
    );
    ctx.conn.send(buildGetBlockParameterValue(targetId));
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        DEVICE_LABEL,
        `get_param: no response from device within ${GET_RESPONSE_TIMEOUT_MS}ms — ${err instanceof Error ? err.message : String(err)}. ` +
        `Likely causes: block '${block.name}' not placed on the active preset grid (device silently absorbs reads on absent blocks), or a stale MIDI handle (try reconnect_midi).`,
      );
    }
    const parsed = parseGetBlockParameterResponse(response);
    const wire = parsed.value;
    // Cross-device source of truth: same wire->display closure schema's
    // decode + writer's reverse-display use. For uncalibrated knobs the
    // resolver omits decodeWire; fall back to the device's own label
    // string from the GET response, then to the raw wire integer.
    const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
    let display: number | string;
    if (kind.decodeWire !== undefined) {
      display = kind.decodeWire(wire);
    } else if (param.controlType === 'select') {
      // Enum without resolver decodeWire (defensive) - prefer label.
      display = parsed.label ?? wire;
    } else {
      display = parsed.label || wire;
    }
    return {
      block: blockSlug,
      name: param.name,
      wire_value: wire,
      display_value: display,
      unit: unitFor(param),
      raw_response: response,
    };
  },

  async getParams(ctx: DispatchCtx, queries) {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        reads.push(await reader.getParam(ctx, q.block, q.name, q.channel));
      } catch (err) {
        failed_indices.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices,
      errors: failed_indices.length > 0 ? errors : undefined,
    };
  },

  /**
   * BK-070: atomic read of the active working buffer. One grid read +
   * one fn 0x1F per placed block; the device's existing state-broadcast
   * triples carry the full param state per block in a single round-trip.
   *
   * Wall-time on Q8.02 XL+ with a 12-block preset: ~1.8 s. The same
   * coverage via per-param get_param round-trips would be ~22 calls × ~80
   * ms each = ~1.8 s as well, but the AGENT-side latency advantage is
   * one tool call instead of 22 — that's the BK-070 win.
   *
   * Scope (v1): active-channel state only. Routing edges + per-scene
   * snapshots + per-X-vs-Y decomposition are deferred to v2.
   */
  async getPreset(ctx: DispatchCtx): Promise<PresetSpec> {
    // 1. Grid read so we know which blocks are placed and at what slot.
    const gridResponsePromise = ctx.conn.receiveSysExMatching(
      isGetGridLayoutResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    ctx.conn.send(buildGetGridLayout());
    let cells: GridCell[];
    try {
      const gridResponse = await gridResponsePromise;
      cells = parseGetGridLayoutResponse(gridResponse);
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        DEVICE_LABEL,
        `get_preset: grid read failed — ${err instanceof Error ? err.message : String(err)}. Check that the Axe-Fx II is connected and AxeEdit isn't holding the port.`,
      );
    }
    const placed = collectPlacedBlocks(cells);

    // 2. Preset name (best-effort — non-blocking on failure).
    let presetName: string | undefined;
    try {
      const namePromise = ctx.conn.receiveSysExMatching(
        isGetPresetNameResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildGetPresetName());
      presetName = parseGetPresetNameResponse(await namePromise);
    } catch {
      presetName = undefined;
    }

    // 3. Per-block atomic param dump via fn 0x1F. Loop serially — the
    //    device returns one state-broadcast triple per request, and
    //    concurrent fn 0x1F bursts would interleave 0x75 chunks across
    //    different headers in the inbound stream (no per-request tag).
    const slots: PresetSlotSpec[] = [];
    const errors: string[] = [];
    for (const block of placed) {
      try {
        const triple = await readAllParams(ctx, block.effectId);
        const groupCode = BLOCK_BY_ID[block.effectId].groupCode;
        const paramIndex = buildGroupParamIndex(groupCode);
        const params: Record<string, number | string> = {};
        for (let i = 0; i < triple.values.length; i++) {
          const p = paramIndex.get(i);
          if (p === undefined) continue; // undocumented paramId — skip
          const wire = triple.values[i];
          // Decode wire → display via the schema's resolver (same path
          // get_param uses, so the values round-trip through encode).
          const kind = resolveParamKind('axe-fx-ii', p.block, p.name);
          let display: number | string;
          if (kind.decodeWire !== undefined) {
            display = kind.decodeWire(wire);
          } else if (p.controlType === 'select') {
            // Enum without resolver decode — surface the wire integer
            // (the wire index is meaningful even without a label; the
            // schema's enum_values can resolve it agent-side).
            display = wire;
          } else {
            display = wire;
          }
          params[p.name] = display;
        }
        slots.push({
          slot: block.slot,
          block_type: block.blockType,
          instance: block.instance,
          params,
        });
      } catch (err) {
        errors.push(`${block.displayName} @ row ${block.slot.row} col ${block.slot.col}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errors.length === placed.length && placed.length > 0) {
      // Every block failed. Hard surface as no_ack so the caller can
      // diagnose (probably stale handle or device-busy).
      throw new DispatchError(
        'no_ack',
        DEVICE_LABEL,
        `get_preset: read failed on every placed block (${placed.length} blocks). First error: ${errors[0]}`,
      );
    }
    return {
      name: presetName,
      slots,
    };
  },

  async scanLocations(ctx, from, to) {
    const fromN = parseAxeFxIILocation(from);
    const toN = parseAxeFxIILocation(to);
    if (fromN > toN) {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `Scan range invalid: ${from} (${fromN}) is after ${to} (${toN}). Pass from <= to.`,
      );
    }
    const span = toN - fromN + 1;
    if (span > MAX_SCAN_RANGE) {
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        `Scan range ${fromN}..${toN} is ${span} presets — exceeds the ${MAX_SCAN_RANGE}-preset cap (each entry round-trips ~80ms, so a 64-slot scan takes ~5s). Narrow the range and try again.`,
      );
    }

    // Capture the active preset so we can restore at the end.
    let originalPreset: number | undefined;
    try {
      const ackPromise = ctx.conn.receiveSysExMatching(
        isGetPresetNumberResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildGetPresetNumber());
      const ack = await ackPromise;
      originalPreset = parseGetPresetNumberResponse(ack).presetNumber;
    } catch {
      // Continue without restore — we'll still scan but won't bounce
      // the user back to their starting preset.
    }

    const scanned: ScannedLocation[] = [];
    let failed_at: string | undefined;
    let failed_reason: string | undefined;
    for (let n = fromN; n <= toN; n++) {
      try {
        ctx.conn.send(buildSwitchPreset(n));
        // 150ms — long enough for Q8.02 to actually load the new preset
        // before GET_PRESET_NAME runs. The original 20ms raced the load
        // and returned the previous preset's name for every iteration.
        await new Promise((res) => setTimeout(res, SCAN_PRESET_SETTLE_MS));
        const ackPromise = ctx.conn.receiveSysExMatching(
          isGetPresetNameResponse,
          GET_RESPONSE_TIMEOUT_MS,
        );
        ctx.conn.send(buildGetPresetName());
        const ack = await ackPromise;
        const name = parseGetPresetNameResponse(ack);
        scanned.push({
          // n is the 0-indexed wire preset; emit the 1-indexed display
          // slot so callers stay in the user-facing addressing space.
          location: String(n + 1),
          name,
          is_empty: name === '' || /^new preset$/i.test(name),
        });
      } catch (err) {
        failed_at = String(n + 1);
        failed_reason = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    // Restore the originally-active preset if we know it.
    if (originalPreset !== undefined) {
      try {
        ctx.conn.send(buildSwitchPreset(originalPreset));
      } catch {
        // Best-effort restore; don't surface.
      }
    }

    return { scanned, failed_at, failed_reason };
  },

  lookupLineage(query) {
    const blockType = query.block_type;
    if (!AXE_FX_II_LINEAGE_BLOCKS.includes(blockType as AxeFxIILineageBlock)) {
      return {
        ok: false,
        text: `Block type '${blockType}' has no Axe-Fx II lineage corpus. Valid: ${AXE_FX_II_LINEAGE_BLOCKS.join(', ')}.`,
      };
    }
    const result = runAxeFxIILineageLookup({
      block_type: blockType as AxeFxIILineageBlock,
      name: query.name,
      real_gear: query.real_gear,
      manufacturer: query.manufacturer,
      model: query.model,
    });
    const withQuotes = query.include_quotes ?? true;
    if (!result.found) {
      return {
        ok: false,
        text: `No ${blockType} lineage records match the query. ${result.totalScanned} records scanned.`,
      };
    }
    if (result.shape === 'forward') {
      return { ok: true, text: formatAxeFxIILineageRecord(result.hits[0].record, withQuotes) };
    }
    const blocks = result.hits.map(
      (h) => `── ${h.axefx2Name} ──\n${formatAxeFxIILineageRecord(h.record, withQuotes, 3)}`,
    );
    return {
      ok: true,
      text: `${result.hits.length} ${blockType} match(es)${result.hits.length > 10 ? ' (showing top 10)' : ''}:\n\n${blocks.join('\n\n')}`,
    };
  },
};

// Re-export for verify-dispatcher.ts byte-equivalence callers.
export { BLOCK_BY_ID };
