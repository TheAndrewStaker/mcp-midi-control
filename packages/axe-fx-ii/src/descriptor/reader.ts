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
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

import {
  AXE_FX_II_BLOCKS,
  BLOCK_BY_ID,
  resolveBlock,
  type AxeFxIIBlock,
} from 'fractal-midi/axe-fx-ii';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/axe-fx-ii';
import {
  buildGetBlockParameterValue,
  buildGetPresetName,
  buildGetPresetNumber,
  buildSetBlockChannel,
  buildSwitchPreset,
  isGetBlockParameterResponse,
  isGetPresetNameResponse,
  isGetPresetNumberResponse,
  parseGetBlockParameterResponse,
  parseGetPresetNameResponse,
  parseGetPresetNumberResponse,
  type AxeFxIIChannel,
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
