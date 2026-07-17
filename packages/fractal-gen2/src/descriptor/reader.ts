/**
 * Axe-Fx II family DeviceReader: `createReader(config)` factory.
 *
 * BK-094 / BK-GEN2-FACTORY: converted from a single XL+-only `reader`
 * object literal into `createReader(config: AxeFxIIConfig)` so the AX8 (and
 * any future Axe-Fx II family model) binds the SAME reader logic to its own
 * model byte + block-availability filter. `export const reader` below
 * preserves the pre-existing XL+ singleton for every caller that imports it
 * by that name; behavior is byte-identical to before this change.
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
 *
 * MODEL-BYTE THREADING. Every outbound builder call passes `{ modelId:
 * config.modelByte }`, and every inbound response PREDICATE that checks the
 * frame's own model byte (`isGetBlockParameterResponse`, `isGetPresetNameResponse`,
 * `isGetGridLayoutResponse`, `isSceneNumberResponse`, `isGetBlockChannelResponse`,
 * `isQueryStatesResponse`, plus this file's own `isFn` used by the fn=0x1F
 * bulk-read triple) is called with `config.modelByte` as `expectedModelId`.
 * Missing this on a non-XL+ config would silently drop every real response
 * (the predicate would never match), turning every read into a timeout:
 * this is the single most safety-critical part of this file's config
 * threading. Reads are NEVER gated (no `gateWrite` here: every read op
 * works identically on every config; only `writer.ts`'s two multi-step
 * build ops are gated on AX8).
 */

import type {
  BlockLayoutSnapshot,
  DeviceReader,
  DispatchCtx,
  PresetBinaryDump,
  PresetSlotSpec,
  PresetSnapshot,
  PresetSnapshotMeta,
  PresetSnapshotSlot,
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

import {
  AXE_FX_II_BLOCKS,
  BLOCK_BY_ID,
  IDS_BY_GROUP,
  resolveBlock,
  type AxeFxIIBlock,
} from 'fractal-midi/gen2/axe-fx-ii';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';
import {
  buildGetAllParams,
  buildGetBlockChannel,
  buildGetBlockParameterValue,
  buildGetGridLayout,
  buildGetPresetName,
  buildGetPresetNumber,
  buildGetSceneNumber,
  buildQueryStates,
  buildSetBlockChannel,
  buildSwitchPreset,
  isGetBlockChannelResponse,
  isGetBlockParameterResponse,
  isGetGridLayoutResponse,
  isGetPresetNameResponse,
  isGetPresetNumberResponse,
  isQueryStatesResponse,
  isSceneNumberResponse,
  mapQueryStatesToBlocks,
  parseGetBlockChannelResponse,
  parseGetBlockParameterResponse,
  parseGetGridLayoutResponse,
  parseGetPresetNameResponse,
  parseGetPresetNumberResponse,
  parseQueryStatesResponse,
  parseSceneNumberResponse,
  type AxeFxIIBlockState,
  type AxeFxIIChannel,
  type GridCell,
} from 'fractal-midi/gen2/axe-fx-ii';
import {
  AXE_FX_II_LINEAGE_BLOCKS,
  formatAxeFxIILineageRecord,
  runAxeFxIILineageLookup,
  type AxeFxIILineageBlock,
} from '../lineageLookup.js';
import { checkAudibility } from '../tools/audibility.js';
import { findParamFuzzy } from 'fractal-midi/gen2/axe-fx-ii';

import { findBlockBySlug, parseAxeFxIILocation } from './schema.js';
import { dumpWorkingBufferBytes, PATCH_DUMP_FRAME_COUNT } from './patchDumpIo.js';
import { decodeGroupValues } from './paramGroupIndex.js';
import { readPresetImageSnapshot } from './presetImageRead.js';
import type { AxeFxIIConfig } from './config.js';
import { AXE_FX_II_XL_PLUS_CONFIG } from '../configs/xl-plus.js';

const GET_RESPONSE_TIMEOUT_MS = 800;
const CHANNEL_SWITCH_SETTLE_MS = 20;

/**
 * BK-081: `_meta` fields not yet promoted into the core `PresetSnapshotMeta`
 * contract (out of this session's touch scope: `packages/core/src/**` is
 * off-limits). Structurally assignable to `PresetSnapshotMeta` (superset of
 * optional fields), so the extra keys ride along on the wire/JSON response
 * without a core type change; a future session that touches core can fold
 * these into `PresetSnapshotMeta` proper.
 */
type PresetSnapshotMetaWithReadPath = PresetSnapshotMeta & {
  /**
   * 'preset-image': every placed block's params came from the ONE atomic
   * whole-preset dump (0x77/0x78/0x79), closing the cross-block tear window
   * the per-block fn=0x1F loop has. 'per-block-fn1f': the legacy per-block
   * round-trip path. 'preset-image-partial': some blocks used the atomic
   * image, others fell back (still correct, just not uniformly tear-free).
   */
  read_path?: 'preset-image' | 'preset-image-partial' | 'per-block-fn1f';
  /** Why the atomic image path was skipped/partial, when it was. */
  image_read_fallback_reason?: string;
};

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

/**
 * Build a `DeviceReader` bound to one Axe-Fx II family config. See the
 * module docstring above for the model-byte-threading contract every
 * config gets for free.
 */
export function createReader(config: AxeFxIIConfig): DeviceReader {
  const DEVICE_LABEL = config.displayName;
  const modelOpts = { modelId: config.modelByte };

  function checkBlockAvailable(block: AxeFxIIBlock): void {
    if (config.isBlockAvailable !== undefined && !config.isBlockAvailable(block)) {
      throw new DispatchError(
        'unknown_block',
        DEVICE_LABEL,
        `Block '${block.name}' is not present on ${DEVICE_LABEL} (single-instance-only or absent on this model). ` +
        `Call list_params or describe_device to see the blocks this device actually exposes.`,
      );
    }
  }

  function resolveBlockOrThrow(slugOrName: string): AxeFxIIBlock {
    const fromSlug = findBlockBySlug(slugOrName);
    const resolved = fromSlug ?? resolveBlock(slugOrName);
    if (!resolved) {
      const sample = AXE_FX_II_BLOCKS.slice(0, 6).map((b) => `"${b.name}"`).join(', ');
      throw new DispatchError(
        'unknown_block',
        DEVICE_LABEL,
        `Block '${slugOrName}' is not valid on ${DEVICE_LABEL}. First few: ${sample}…`,
      );
    }
    checkBlockAvailable(resolved);
    return resolved;
  }

  function resolveBlockWithInstance(slugOrName: string, instance?: number): AxeFxIIBlock {
    const base = resolveBlockOrThrow(slugOrName);
    if (instance === undefined || instance === 1) return base;
    const idsInGroup = IDS_BY_GROUP[base.groupCode];
    const targetId = idsInGroup?.[instance - 1];
    if (targetId === undefined) {
      const max = idsInGroup?.length ?? 1;
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        `Block '${slugOrName}' instance ${instance} out of range on ${DEVICE_LABEL} (max instances for ${base.groupCode}: ${max}).`,
      );
    }
    const target = BLOCK_BY_ID[targetId];
    if (target === undefined) {
      throw new DispatchError(
        'unknown_block',
        DEVICE_LABEL,
        `Block '${slugOrName}' instance ${instance}: effectId ${targetId} not found in block table.`,
      );
    }
    checkBlockAvailable(target);
    return target;
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
  //     F0 00 01 74 [model] 74 [t_lo t_hi] [c_lo c_hi] [op] [cs] F7
  //     - targetId  = decode14(t_lo, t_hi)   → outgoing effectId echoed
  //     - itemCount = decode14(c_lo, c_hi)   → number of 16-bit values
  //     - op        = 0x01 (block-state) or 0x00 (preset-structure edit)
  //   Chunks (fn 0x75):
  //     F0 00 01 74 [model] 75 [n_lo n_hi] [N × 3 packed septets] [cs] F7
  //     - n = decode14(n_lo, n_hi)  → values in this chunk (max ~340)
  //     - each value = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14)
  //   Footer (fn 0x76):
  //     F0 00 01 74 [model] 76 [cs] F7 (empty; marks end of triple).
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
      && bytes[4] === config.modelByte
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
    // listener registration (state-broadcast triples are bursty; header +
    // chunks land within a single USB callback frame on Q8.02).
    let header: DecodedTriple | undefined;
    const values: number[] = [];
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
        if (header !== undefined) return; // already saw one; ignore duplicates
        header = {
          targetId: tId,
          itemCount: decode14(bytes[8], bytes[9]),
          opFlag: bytes[10],
          values: [],
        };
      } else if (isFn(bytes, 0x75)) {
        if (header === undefined) return; // chunk before header; drop
        for (const v of decodeChunk(bytes)) values.push(v);
      } else if (isFn(bytes, 0x76)) {
        if (header === undefined) return; // footer before header; drop
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
      ctx.conn.send(buildGetAllParams(effectId, modelOpts));
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
   * Split a grid into a deduplicated list of placed blocks with their
   * canonical (block_type, instance, slot) coordinates. Skips empty cells
   * (blockId=0) and shunts (200..235); skips duplicate cells (multi-cell
   * blocks span multiple grid positions but the device returns the same
   * blockId once per cell).
   */
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

  /**
   * One fn 0x0E QUERY_STATES read → per-block active-scene state map keyed
   * by effectId. The grid's `placedEffectIds` (placed, non-shunt blocks)
   * pins the record-to-block zip (sort by address, zip ascending; see
   * the ii-fn0e-query-states primitive). Replaces N per-block bypass (fn 0x02
   * paramId=255) + N channel (fn 0x11) round-trips with a single read;
   * hardware-verified 11/11 equivalent on Q8.02. Best-effort: returns an
   * empty map on any failure or a record/block count mismatch, so callers
   * fall back to the per-block reads transparently.
   */
  async function readActiveBlockStates(
    ctx: DispatchCtx,
    placedEffectIds: number[],
  ): Promise<Map<number, AxeFxIIBlockState>> {
    const byId = new Map<number, AxeFxIIBlockState>();
    if (placedEffectIds.length === 0) return byId;
    try {
      const promise = ctx.conn.receiveSysExMatching((bytes) => isQueryStatesResponse(bytes, config.modelByte), GET_RESPONSE_TIMEOUT_MS);
      ctx.conn.send(buildQueryStates(modelOpts));
      const records = parseQueryStatesResponse(await promise);
      if (records.length !== placedEffectIds.length) return byId; // count mismatch → fall back
      for (const s of mapQueryStatesToBlocks(records, placedEffectIds)) byId.set(s.effectId, s);
    } catch {
      // best-effort; empty map → callers fall back to per-block reads
    }
    return byId;
  }

  function normalizeChannel(channel: string | number | undefined): AxeFxIIChannel | undefined {
    if (channel === undefined) return undefined;
    if (typeof channel === 'number') {
      if (channel === 0) return 'X';
      if (channel === 1) return 'Y';
      throw new DispatchError(
        'bad_channel',
        DEVICE_LABEL,
        `Channel index ${channel} is out of range on ${DEVICE_LABEL} (valid: 0=X, 1=Y).`,
      );
    }
    const upper = channel.trim().toUpperCase();
    if (upper === 'X' || upper === 'Y') return upper as AxeFxIIChannel;
    throw new DispatchError(
      'bad_channel',
      DEVICE_LABEL,
      `Channel '${channel}' is not valid on ${DEVICE_LABEL} (channels are X/Y).`,
    );
  }

  const reader: DeviceReader = {
    async getParam(ctx: DispatchCtx, blockSlug, name, channel, instance): Promise<ReadResult> {
      const block = resolveBlockWithInstance(blockSlug, instance);
      const param = findParamOrThrow(block, name);
      const channelWire = normalizeChannel(channel);

      if (channelWire !== undefined && block.canBypass) {
        ctx.conn.send(buildSetBlockChannel(block.id, channelWire, modelOpts));
        await new Promise((res) => setTimeout(res, CHANNEL_SWITCH_SETTLE_MS));
      }

      const targetId = { effectId: block.id, paramId: param.paramId };
      const responsePromise = ctx.conn.receiveSysExMatching(
        (bytes) => isGetBlockParameterResponse(bytes, targetId, config.modelByte),
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildGetBlockParameterValue(targetId, modelOpts));
      let response: number[];
      try {
        response = await responsePromise;
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          DEVICE_LABEL,
          `get_param: no response from device within ${GET_RESPONSE_TIMEOUT_MS}ms; ${err instanceof Error ? err.message : String(err)}. ` +
          `Likely causes: block '${block.name}' not placed on the active preset grid (device silently absorbs reads on absent blocks), ` +
          `a stale MIDI handle (try reconnect_midi), or another program holding the device's MIDI IN port ` +
          `(a second MCP server instance from another Claude session, a stale node.exe, or a manufacturer editor; ` +
          `if reconnect_midi doesn't recover, close those or fully restart the host app).`,
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
          reads.push(await reader.getParam(ctx, q.block, q.name, q.channel, q.instance));
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

    async dumpActivePresetBinary(ctx: DispatchCtx): Promise<PresetBinaryDump> {
      // 1. Active preset number, for the source string's display-slot
      //    context only (the dump itself is buffer-addressed).
      let wirePreset: number | undefined;
      try {
        const numPromise = ctx.conn.receiveSysExMatching(isGetPresetNumberResponse, GET_RESPONSE_TIMEOUT_MS);
        ctx.conn.send(buildGetPresetNumber(modelOpts));
        wirePreset = parseGetPresetNumberResponse(await numPromise).presetNumber;
      } catch {
        wirePreset = undefined;
      }
      // 2. Request + collect the 66-frame EDIT-BUFFER dump (fn 0x03 with
      //    the 0x7F 0x7F sentinel; hardware-confirmed buffer-true with no
      //    reload side effect, HW-132). Shared with the BK-081 atomic image
      //    read + atomic-apply RMW orchestration via `patchDumpIo.js`.
      let bytes: Uint8Array;
      try {
        bytes = await dumpWorkingBufferBytes(ctx, { modelId: config.modelByte });
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          DEVICE_LABEL,
          `export_preset: ${err instanceof Error ? err.message : String(err)}. Check the ${DEVICE_LABEL} is connected and AxeEdit isn't holding the port (try reconnect_midi).`,
        );
      }
      // 3. Working-buffer name for the backup filename. The sentinel dump
      //    has no reload side effect, so this still reads the buffer the
      //    file contains.
      let name: string | undefined;
      try {
        const namePromise = ctx.conn.receiveSysExMatching((bytes2) => isGetPresetNameResponse(bytes2, config.modelByte), GET_RESPONSE_TIMEOUT_MS);
        ctx.conn.send(buildGetPresetName(modelOpts));
        name = parseGetPresetNameResponse(await namePromise, config.modelByte).trimEnd() || undefined;
      } catch {
        name = undefined;
      }
      return {
        bytes,
        byte_length: bytes.length,
        frame_count: PATCH_DUMP_FRAME_COUNT,
        format: 'axe-fx-ii-patch-dump',
        name,
        source: `active working buffer (edit-buffer dump, includes unsaved edits${wirePreset !== undefined ? `; device at display slot ${wirePreset + 1}` : ''})`,
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
     * one tool call instead of 22 (that's the BK-070 win).
     *
     * Returns `PresetSnapshot`, distinct from `PresetSpec`, so callers
     * can statically tell "snapshot, don't feed back into apply_preset
     * wholesale." Slots carry `channel_status` so partial-info state
     * (channel read failed) is programmatically detectable. `_meta`
     * envelope carries device label, timestamp, and partial-info flags.
     *
     * Scope: full X/Y per-channel state (both channels decoded from the one
     * channel-blocked fn 0x1F dump). Routing edges + per-scene snapshots are
     * deferred and will land via additional `PresetSnapshot` fields without a
     * tool-shape change.
     */
    async getBlockLayoutSnapshot(ctx: DispatchCtx): Promise<BlockLayoutSnapshot> {
      // BK-075 phantom-param pre-flight: single grid read → unique placed
      // block-type slugs. Reuses the same wire envelope as `get_preset`'s
      // first step but skips the per-block param dump (~150ms each vs the
      // grid read's ~50ms total). Result is cached for 5s by the
      // dispatcher; subsequent set_param calls within the burst pay 0ms.
      const responsePromise = ctx.conn.receiveSysExMatching(
        (bytes) => isGetGridLayoutResponse(bytes, config.modelByte),
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildGetGridLayout(modelOpts));
      let cells: GridCell[];
      try {
        const response = await responsePromise;
        cells = parseGetGridLayoutResponse(response, config.modelByte);
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          DEVICE_LABEL,
          `getBlockLayoutSnapshot: grid read failed; ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      const placed = collectPlacedBlocks(cells);
      const placedBlocks = new Set<string>(placed.map((p) => p.blockType));
      // BK-076: compute the "block is placed but no cable feeds it" set.
      // Walk every cell with a placed block-id and group by block_type;
      // a block_type lands in `unroutedBlocks` only when EVERY one of its
      // cells is unrouted (col 1 cells are always treated as routed; the
      // device's global input feeds row-2 col-1 implicitly). If at least
      // one cell of a given block_type has routing, the param write
      // reaches a live signal path and we stay silent.
      const cellsByBlockType = new Map<string, GridCell[]>();
      for (const cell of cells) {
        if (cell.blockId === 0) continue;
        if (cell.blockId >= 200 && cell.blockId <= 235) continue;
        const block = BLOCK_BY_ID[cell.blockId];
        if (block === undefined) continue;
        const m = /^(.+?)\s+(\d+)$/.exec(block.name);
        const blockType = (m ? m[1] : block.name).toLowerCase();
        const list = cellsByBlockType.get(blockType) ?? [];
        list.push(cell);
        cellsByBlockType.set(blockType, list);
      }
      const unroutedBlocks = new Set<string>();
      for (const [blockType, list] of cellsByBlockType) {
        const anyRouted = list.some((c) => c.col === 1 || c.routingFlags !== 0);
        if (!anyRouted) unroutedBlocks.add(blockType);
      }
      return { placedBlocks, unroutedBlocks };
    },

    async getPreset(ctx: DispatchCtx, options?: { include_channel_state?: boolean }): Promise<PresetSnapshot> {
      // Default OFF on II. include_channel_state now adds NO extra wire round-
      // trips: the fn 0x1F dump is CHANNEL-BLOCKED x2 (quarter 0 = X, quarter 1
      // = Y), so include_channel_state:true reads Y from the SAME dump already
      // read for X (it used to cost ~419 per-param fn 0x02 GETs / ~37 s plus a
      // channel-state mutation). Default OFF still returns only X to keep the
      // response small. The ACTIVE channel is attributed from the fn 0x0E
      // QUERY_STATES map read once below (zero extra round-trips), so channel-
      // bearing blocks return params_by_channel:{X} with channel_status:'active'
      // on the default path. (AM4 defaults OFF for the same reason.)
      const includeChannelState = options?.include_channel_state ?? false;
      // Server-side timer around the whole SysEx read loop. Surfaced as
      // _meta.read_duration_ms: the only client-independent measure of read
      // cost (the agent's JSON-handling time swamps any client-side timer;
      // alpha.17 finding).
      const readStartedMs = Date.now();
      // 1. Grid read so we know which blocks are placed and at what slot.
      const gridResponsePromise = ctx.conn.receiveSysExMatching(
        (bytes) => isGetGridLayoutResponse(bytes, config.modelByte),
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildGetGridLayout(modelOpts));
      let cells: GridCell[];
      try {
        const gridResponse = await gridResponsePromise;
        cells = parseGetGridLayoutResponse(gridResponse, config.modelByte);
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          DEVICE_LABEL,
          `get_preset: grid read failed; ${err instanceof Error ? err.message : String(err)}. Check that the ${DEVICE_LABEL} is connected and AxeEdit isn't holding the port.`,
        );
      }
      const placed = collectPlacedBlocks(cells);

      // 1b. One fn 0x0E QUERY_STATES read → per-block active-scene engaged +
      //     channel for EVERY placed block in a single round-trip. This
      //     replaces the N per-block bypass reads (fn 0x02 paramId=255) and
      //     the N channel reads (fn 0x11) below with map lookups
      //     (hardware-verified 11/11 equivalent on Q8.02). Best-effort: an
      //     empty map falls back to the per-block reads transparently.
      const blockStateById = await readActiveBlockStates(ctx, placed.map((p) => p.effectId));

      // 2. Preset name (best-effort, non-blocking on failure).
      let presetName: string | undefined;
      try {
        const namePromise = ctx.conn.receiveSysExMatching(
          (bytes) => isGetPresetNameResponse(bytes, config.modelByte),
          GET_RESPONSE_TIMEOUT_MS,
        );
        ctx.conn.send(buildGetPresetName(modelOpts));
        presetName = parseGetPresetNameResponse(await namePromise, config.modelByte);
      } catch {
        presetName = undefined;
      }

      // 2b. BK-081: one atomic whole-preset-image dump attempt (edit-buffer
      //     sentinel, no reload side effect). Success means EVERY placed
      //     block's X/Y param values below come from the SAME captured
      //     instant, closing the cross-block tear window the per-block
      //     fn=0x1F loop has (a scene switch / front-panel edit between
      //     block K and K+1's request could otherwise produce a composite
      //     snapshot that never existed at any single instant on the
      //     device). Never throws; a failure (wire timeout, TLV walk
      //     failure, round-trip-identity mismatch) falls back to the
      //     existing per-block loop transparently, block by block. Skipped
      //     entirely on an empty grid: nothing to decode, so the dump
      //     round-trip would be pure overhead.
      const imageSnapshot = placed.length > 0
        ? await readPresetImageSnapshot(ctx, config.modelByte)
        : { ok: false as const, reason: 'no placed blocks; image read skipped.' };
      let imagePathBlockCount = 0;

      // 3. Per-block atomic param dump. When `imageSnapshot.ok` and the
      //    block is present in its chain, source X/Y from the ONE image
      //    dump above (zero extra wire round-trips). Otherwise fall back to
      //    one fn 0x1F SYSEX_GET_ALL_PARAMS round-trip per block, as before.
      //    Loop serially: the device returns one state-broadcast triple
      //    per request, and concurrent fn 0x1F bursts would interleave
      //    0x75 chunks across different headers in the inbound stream (no
      //    per-request tag).
      //
      //    For channel-bearing blocks the source carries BOTH X and Y
      //    (channel-blocked x2, or the image's X/Y halves). `include_
      //    channel_state` controls only whether Y is decoded and surfaced;
      //    it adds no extra round-trips either way. The active channel for
      //    the default-path label comes from the fn 0x0E map read once
      //    above. The common get_preset use case is "tell me what's on the
      //    device" (X is enough), so the default stays X-only.
      const slots: PresetSnapshotSlot[] = [];
      const errors: string[] = [];
      // Audibility walker inputs: filled per-block as we decode the param
      // dump. Bypass is a per-block wire bool (paramName 'bypass'); bypass
      // mode is per-block enum (paramName 'bypass_mode') with display
      // labels like 'THRU' / 'MUTE' / 'MUTE OUT' / 'MUTE IN'. Both come
      // from the same fn 0x1F dump we already issue for params, so the
      // audibility report costs zero extra round-trips.
      const bypassByBlockId = new Map<number, boolean>();
      const bypassModeByBlockId = new Map<number, string>();
      for (const block of placed) {
        try {
          // Attribute the active channel for EVERY channel-bearing block.
          // The fn 0x0E QUERY_STATES map (read once above) carries it at zero
          // extra round-trips, so this runs on the default path too and yields
          // params_by_channel:{<active>} + channel_status:'active' (matching
          // AM4). The per-block fn 0x11 fallback (~50 ms each) is only worth
          // paying when the caller opted into the full channel walk; on the
          // default path a fn 0x0E map miss leaves activeChannel undefined and
          // the block falls back to flat params with channel_status:'unknown'
          // so callers can detect the partial-info state programmatically.
          let activeChannel: AxeFxIIChannel | undefined;
          if (block.canBypass) {
            // Prefer the fn 0x0E map (one read covered all blocks).
            activeChannel = blockStateById.get(block.effectId)?.channel;
            if (activeChannel === undefined && includeChannelState) {
              // Opt-in only: pay a per-block fn 0x11 read on a map miss.
              try {
                const chPromise = ctx.conn.receiveSysExMatching(
                  (bytes) => isGetBlockChannelResponse(bytes, block.effectId, config.modelByte),
                  GET_RESPONSE_TIMEOUT_MS,
                );
                ctx.conn.send(buildGetBlockChannel(block.effectId, modelOpts));
                activeChannel = parseGetBlockChannelResponse(await chPromise);
              } catch {
                activeChannel = undefined;
              }
            }
          }

          // BK-081: prefer the atomic whole-preset image for this block when
          // the image dump succeeded AND this block's wire_id is present in
          // its TLV chain. Falls back per-block (not all-or-nothing) so one
          // unregistered wire_id doesn't discard the atomic win for every
          // OTHER block in the same preset.
          const imageEntry = imageSnapshot.ok ? imageSnapshot.blockParams.get(block.effectId) : undefined;

          // Decode the fn=0x1F bulk dump (legacy fallback path only). Track
          // the params that fell through to a raw wire integer (no display
          // resolver + not an enum table) so a follow-up per-param fn=0x02 GET
          // could one day replace them with the device's own ASCII display
          // label. Delegates to the shared `decodeGroupValues` (paramGroupIndex.ts)
          // so this path and the image path can never decode a param differently.
          const decodeParamDump = (
            triple: { values: number[] },
          ): {
            out: Record<string, number | string>;
            opaqueParamIds: number[];
          } => {
            const groupCode = BLOCK_BY_ID[block.effectId].groupCode;
            const decoded = decodeGroupValues(groupCode, triple.values);
            if (decoded.bypass !== undefined) bypassByBlockId.set(block.effectId, decoded.bypass);
            if (decoded.bypassMode !== undefined) bypassModeByBlockId.set(block.effectId, decoded.bypassMode);
            return { out: decoded.out, opaqueParamIds: decoded.opaqueParamIds };
          };

          // X and Y both come from the SAME source (the fn 0x1F dump's `0x75`
          // body, CHANNEL-BLOCKED x2 at `channel * stride + paramId`; or the
          // image's baseWord / baseWord+xToYOffset halves; same shape,
          // structurally identical to the AM4 x4 dump, live-hardware-confirmed
          // 2026-06-04). Delegates to `decodeGroupValues` on a stride-sliced
          // view so the arithmetic can't drift from the X-channel decode.
          const decodeYQuarter = (triple: { itemCount: number; values: number[] }): Record<string, number | string> | undefined => {
            if (!(triple.itemCount > 0 && triple.itemCount % 2 === 0)) return undefined;
            const stride = triple.itemCount / 2;
            const groupCode = BLOCK_BY_ID[block.effectId].groupCode;
            return decodeGroupValues(groupCode, triple.values.slice(stride)).out;
          };

          let flatParams: Record<string, number | string>;
          let opaqueParamIds: number[];
          let yChannelParams: Record<string, number | string> | undefined;
          // Fallback source for the (includeChannelState===false, activeChannel==='Y')
          // branch below, which needs to decode Y on demand even when the caller
          // didn't opt into the full X+Y walk. Image path: the value is already
          // decoded. Per-block path: re-decode from the SAME triple already read.
          let decodeYOnDemand: () => Record<string, number | string> | undefined;

          if (imageEntry !== undefined) {
            flatParams = imageEntry.x;
            opaqueParamIds = [];
            if (imageEntry.bypass !== undefined) bypassByBlockId.set(block.effectId, imageEntry.bypass);
            if (imageEntry.bypassMode !== undefined) bypassModeByBlockId.set(block.effectId, imageEntry.bypassMode);
            yChannelParams = (includeChannelState && block.canBypass) ? imageEntry.y : undefined;
            decodeYOnDemand = () => imageEntry.y;
            imagePathBlockCount++;
          } else {
            const triple = await readAllParams(ctx, block.effectId);
            const decoded = decodeParamDump(triple);
            flatParams = decoded.out;
            opaqueParamIds = decoded.opaqueParamIds;
            yChannelParams = (includeChannelState && block.canBypass) ? decodeYQuarter(triple) : undefined;
            decodeYOnDemand = () => decodeYQuarter(triple);
          }

          // Opaque-param label resolution was attempted in alpha.12 (the "#4
          // X-channel opaque decode" fix): for params with no calibration
          // (controlType "knob" without displayMin/Max, or "unknown") we
          // issued a per-param fn=0x02 GET and stored `parsed.label` as the
          // display value. The 2026-05-28 alpha.13 desktop session caught
          // that this is structurally unsound: the device's `label` field
          // in fn=0x02 responses renders the wire value using whichever
          // formatter is currently focused on the front panel, NOT the
          // queried param's own formatter. So consecutive get_preset calls
          // returned different display strings for the same param ("1/4" →
          // "68.0 ms" for amp.xformer_grind, "100.0 %" → "0.707" for
          // amp.bypass, etc.) as the front-panel context drifted between
          // calls. Bug A in the alpha.13 report.
          //
          // The right fix is to add calibration overlays in
          // `packages/fractal-gen2/src/calibration.ts` for the misbehaving
          // params (xformer_grind, supply_sag, etc.) so they decode via
          // kind.decodeWire: stable and correct. Until then, return the
          // raw wire integer so the agent sees a stable number rather than
          // a misleading transient label. The opaqueParamIds array is left
          // intact so a future re-introduction with a stable wire→display
          // mapping has a hook.
          void opaqueParamIds;

          // Shape decision:
          //   - non-channel block: flat `params: {...}`, channel_status omitted.
          //   - channel block + both channels read (include_channel_state):
          //     `params_by_channel: {X: {...}, Y: {...}}` so the snapshot
          //     round-trips through apply_preset's schema.
          //   - channel block + active only (default): `params_by_channel`
          //     keyed by the ACTIVE channel from the fn 0x0E map: quarter 0
          //     of the dump when it's X, quarter 1 when it's Y. (The 0.3.0
          //     dev test caught the prior behavior: quarter 0 was always
          //     emitted as `{X}` labeled 'active' even when the scene had the
          //     block on Y, so agents state-anchored edits against the wrong
          //     channel's values.)
          //   - channel block + active channel unresolved: fall back to flat
          //     `params` (the X quarter) with channel_status='unknown'.
          // X = quarter 0 and Y = quarter 1 of the channel-blocked fn 0x1F dump,
          // FIXED order (not sliding-with-active), so both are labelled directly
          // without an active-channel read.
          let params: PresetSlotSpec['params'];
          let paramsByChannel: PresetSlotSpec['params_by_channel'];
          let channelStatus: PresetSnapshotSlot['channel_status'];
          if (!block.canBypass) {
            params = flatParams;
            paramsByChannel = undefined;
            channelStatus = undefined;
          } else if (yChannelParams !== undefined) {
            params = undefined;
            paramsByChannel = { X: flatParams, Y: yChannelParams };
            channelStatus = 'all_channels';
          } else if (activeChannel === 'Y') {
            const yActive = decodeYOnDemand();
            if (yActive !== undefined) {
              params = undefined;
              paramsByChannel = { Y: yActive };
              channelStatus = 'active';
            } else {
              // Y quarter undecodable (odd itemCount, not expected on channel
              // blocks). The X quarter would be the WRONG channel, so label it
              // honestly rather than as active.
              params = flatParams;
              paramsByChannel = undefined;
              channelStatus = 'unknown';
            }
          } else if (activeChannel === 'X') {
            params = undefined;
            paramsByChannel = { X: flatParams };
            channelStatus = 'active';
          } else {
            params = flatParams;
            paramsByChannel = undefined;
            channelStatus = 'unknown';
          }

          // Scene-resolved bypass: fn=0x1F returns the base/global bypass
          // flag, not the active scene's state. Prefer the fn 0x0E map
          // (one read, active-scene engaged bit; hardware-verified 11/11
          // equal to the fn 0x02 paramId=255 scene-resolved value). Fall
          // back to a per-block fn 0x02 GET paramId=255 (~50ms) when the
          // block is absent from the map (e.g. fn 0x0E read failed).
          let isBypassed = bypassByBlockId.get(block.effectId) ?? false;
          if (block.canBypass) {
            const state = blockStateById.get(block.effectId);
            if (state !== undefined) {
              isBypassed = !state.engaged;
              bypassByBlockId.set(block.effectId, isBypassed);
            } else {
              try {
                const bypassTarget = { effectId: block.effectId, paramId: 255 };
                const bypassPromise = ctx.conn.receiveSysExMatching(
                  (bytes) => isGetBlockParameterResponse(bytes, bypassTarget, config.modelByte),
                  GET_RESPONSE_TIMEOUT_MS,
                );
                ctx.conn.send(buildGetBlockParameterValue(bypassTarget, modelOpts));
                const bypassResp = parseGetBlockParameterResponse(await bypassPromise);
                isBypassed = bypassResp.value !== 0;
                bypassByBlockId.set(block.effectId, isBypassed);
              } catch {
                // Fall back to fn=0x1F value on timeout (block may not be placed)
              }
            }
          }
          const slotId = block.instance > 1
            ? `${block.blockType}_${block.instance}`
            : block.blockType;
          slots.push({
            slot: block.slot,
            block_type: block.blockType,
            instance: block.instance,
            id: slotId,
            bypassed: isBypassed,
            ...(params !== undefined ? { params } : {}),
            ...(paramsByChannel !== undefined ? { params_by_channel: paramsByChannel } : {}),
            channel_status: channelStatus,
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

      // Best-effort active-scene read so the snapshot tells callers which
      // scene's state they're looking at. Failure is non-blocking.
      let activeScene: number | undefined;
      try {
        const scenePromise = ctx.conn.receiveSysExMatching(
          (bytes) => isSceneNumberResponse(bytes, config.modelByte),
          GET_RESPONSE_TIMEOUT_MS,
        );
        ctx.conn.send(buildGetSceneNumber(modelOpts));
        const sceneWire = parseSceneNumberResponse(await scenePromise, config.modelByte);
        activeScene = sceneWire + 1; // wire 0..7 to display 1..8
      } catch {
        activeScene = undefined;
      }

      // Audibility check over the same grid + param dump we already
      // collected. Pure post-processing; zero extra wire ops.
      const audibility = checkAudibility({
        cells,
        bypassByBlockId,
        bypassModeByBlockId,
      });
      const chainIntegrity = {
        ok: audibility.ok,
        breaks: audibility.breaks,
        ...(audibility.notes.length > 0 ? { notes: audibility.notes } : {}),
        summary: audibility.summary,
        extra_round_trips: 0,
      };

      // Channel-omission nudge: when the caller did NOT opt into the full walk
      // and at least one channel-bearing block is placed, the inactive channel
      // (Y) is absent. Surface the existing opt-in in the response so the agent
      // doesn't have to already know it exists (alpha.17 finding).
      const hasChannelBearing = placed.some((p) => p.canBypass);
      const channelStateHint = (!includeChannelState && hasChannelBearing)
        ? "Only each block's ACTIVE channel (per the current scene) is included; see the params_by_channel key on each slot. Pass include_channel_state:true to get_preset for the full X/Y per-channel read (decoded from the same fn 0x1F dump; no extra round-trips)."
        : undefined;
      // BK-081: read-path honesty. 'preset-image' = every placed block's
      // params came from the ONE atomic whole-preset dump (no cross-block
      // tear window). 'per-block-fn1f' = the legacy N-serial-round-trip
      // path (either the image dump failed outright, or its TLV chain had
      // zero of this preset's placed blocks). 'preset-image-partial' means
      // SOME blocks used the atomic image and others fell back; the
      // snapshot is still correct, just not uniformly tear-free.
      const readPath: 'preset-image' | 'preset-image-partial' | 'per-block-fn1f' =
        !imageSnapshot.ok || placed.length === 0 || imagePathBlockCount === 0
          ? 'per-block-fn1f'
          : imagePathBlockCount === placed.length
            ? 'preset-image'
            : 'preset-image-partial';
      const meta: PresetSnapshotMetaWithReadPath = {
        device: DEVICE_LABEL,
        read_at_ms: Date.now(),
        active_scene_only: true,
        routing_omitted: true,
        channel_state_omitted: !includeChannelState && hasChannelBearing,
        both_channels_read: includeChannelState,
        read_duration_ms: Date.now() - readStartedMs,
        read_path: readPath,
        ...(channelStateHint !== undefined ? { channel_state_hint: channelStateHint } : {}),
        // BK-081: when the atomic image path was skipped or only partially
        // used, name why: surfaces the round-trip-identity refusal reason
        // (or wire failure) rather than silently degrading to the legacy path.
        ...(!imageSnapshot.ok ? { image_read_fallback_reason: imageSnapshot.reason } : {}),
        // Partial-snapshot honesty: blocks that failed to read are OMITTED
        // from slots[]; name them so the agent can't mistake a partial
        // snapshot for the whole preset (0.3.0 final-signoff finding).
        ...(errors.length > 0 ? { blocks_failed: errors } : {}),
      };
      return {
        name: presetName,
        slots,
        active_scene: activeScene,
        chain_integrity: chainIntegrity,
        _meta: meta,
      };
    },

    async scanLocations(ctx, from, to) {
      const fromN = parseAxeFxIILocation(from, DEVICE_LABEL);
      const toN = parseAxeFxIILocation(to, DEVICE_LABEL);
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
          `Scan range ${fromN}..${toN} is ${span} presets; exceeds the ${MAX_SCAN_RANGE}-preset cap (each entry round-trips ~80ms, so a 64-slot scan takes ~5s). Narrow the range and try again.`,
        );
      }

      // Capture the active preset so we can restore at the end.
      let originalPreset: number | undefined;
      try {
        const ackPromise = ctx.conn.receiveSysExMatching(
          isGetPresetNumberResponse,
          GET_RESPONSE_TIMEOUT_MS,
        );
        ctx.conn.send(buildGetPresetNumber(modelOpts));
        const ack = await ackPromise;
        originalPreset = parseGetPresetNumberResponse(ack).presetNumber;
      } catch {
        // Continue without restore; we'll still scan but won't bounce
        // the user back to their starting preset.
      }

      const scanned: ScannedLocation[] = [];
      let failed_at: string | undefined;
      let failed_reason: string | undefined;
      for (let n = fromN; n <= toN; n++) {
        try {
          ctx.conn.send(buildSwitchPreset(n, modelOpts));
          // 150ms: long enough for Q8.02 to actually load the new preset
          // before GET_PRESET_NAME runs. The original 20ms raced the load
          // and returned the previous preset's name for every iteration.
          await new Promise((res) => setTimeout(res, SCAN_PRESET_SETTLE_MS));
          const ackPromise = ctx.conn.receiveSysExMatching(
            (bytes) => isGetPresetNameResponse(bytes, config.modelByte),
            GET_RESPONSE_TIMEOUT_MS,
          );
          ctx.conn.send(buildGetPresetName(modelOpts));
          const ack = await ackPromise;
          const name = parseGetPresetNameResponse(ack, config.modelByte);
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
          ctx.conn.send(buildSwitchPreset(originalPreset, modelOpts));
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
        (h) => `${h.axefx2Name}\n${formatAxeFxIILineageRecord(h.record, withQuotes, 3)}`,
      );
      return {
        ok: true,
        text: `${result.hits.length} ${blockType} match(es)${result.hits.length > 10 ? ' (showing top 10)' : ''}:\n\n${blocks.join('\n\n')}`,
      };
    },
  };

  return reader;
}

/** One placed block's canonical coordinates. Internal to `createReader`. */
interface PlacedBlock {
  effectId: number;
  blockType: string;       // slug like "amp", "drive"
  instance: number;        // 1-indexed
  slot: { row: number; col: number };
  displayName: string;     // "Amp 1" / "Reverb 2"
  canBypass: boolean;
}

/** The XL+ reader: preserved name/shape for every existing caller. */
export const reader: DeviceReader = createReader(AXE_FX_II_XL_PLUS_CONFIG);

// Re-export for verify-dispatcher.ts byte-equivalence callers.
export { BLOCK_BY_ID };
