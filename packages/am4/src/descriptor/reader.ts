/**
 * AM4 DeviceDescriptor — `DeviceReader` implementation.
 *
 * 4 read operations:
 *   - `getParam` — single-value read via `sendReadAndParse` with optional
 *     pre-read channel switch (so callers can target A/B/C/D without a
 *     separate switch call).
 *   - `getParams` — batch wrapper around `getParam`; collects errors per
 *     entry instead of throwing.
 *   - `scanLocations` — readPresetName loop across a contiguous range,
 *     returning name + is_empty per slot.
 *   - `lookupLineage` — Fractal-authored lineage lookup against the
 *     shared corpus (amps / drives / reverbs / delays).
 *
 * All wire-side I/O is delegated to `sendReadAndParse` / `readPresetName`
 * from `@/server/shared/readOps.js`; the runLineageLookup pipeline is
 * file-only.
 */

import type {
  BlockLayoutSnapshot,
  DeviceReader,
  DispatchCtx,
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  BLOCK_NAMES_BY_VALUE,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  KNOWN_PARAMS,
  buildBlockLayoutSnapshot,
  decode as am4Decode,
  type BlockTypeName,
  type Param,
  type ParamKey,
} from 'fractal-midi/am4';
import { formatLocationDisplay } from 'fractal-midi/am4';
import { readPresetName, sendReadAndParse } from '../shared/readOps.js';
import {
  CHANNEL_BLOCKS,
  switchBlockChannel,
} from '../shared/channels.js';
import {
  LINEAGE_BLOCKS,
  formatLineageRecord,
  loadLineage,
  runLineageLookup,
} from 'fractal-midi/shared';
import { formatLoudnessAppendix } from '@mcp-midi-control/core/fractal-shared/loudness.js';
import { TYPE_APPLICABILITY } from 'fractal-midi/am4';
import { checkApplicability } from 'fractal-midi/am4';
import {
  AMP_TYPES,
  COMPRESSOR_TYPES,
  DELAY_TYPES,
  DRIVE_TYPES,
  REVERB_TYPES,
} from 'fractal-midi/am4';

import { parseAm4Location } from './schema.js';

/**
 * Map a lineage block type → its wire-index enum array. Used by the
 * lineage applicability annotation to look up the wire index from the
 * `am4Name` field on the record.
 *
 * Returns undefined for block types that don't have a type enum (most
 * filter / modulation blocks — those records exist but applicability
 * filtering wouldn't add value).
 */
function typeEnumFor(blockType: string): readonly string[] | undefined {
  switch (blockType) {
    case 'amp':        return AMP_TYPES;
    case 'drive':      return DRIVE_TYPES;
    case 'reverb':     return REVERB_TYPES;
    case 'delay':      return DELAY_TYPES;
    case 'compressor': return COMPRESSOR_TYPES;
    default:           return undefined;
  }
}

/**
 * Tone-building knobs typically displayed on each block's front-panel
 * "main page" — the ones a tone-builder reaches for first. We surface
 * applicability for these in the lookup_lineage annotation to keep the
 * output focused on what the agent needs to decide whether to write a
 * param. The full applicability matrix for every internal param is
 * available via list_params.
 */
const FRONT_PANEL_PARAMS: Record<string, readonly string[]> = {
  amp:        ['type', 'gain', 'bass', 'mid', 'treble', 'presence', 'master', 'level', 'depth'],
  drive:      ['type', 'drive', 'tone', 'level', 'mix'],
  reverb:     ['type', 'mix', 'time', 'predelay', 'size', 'low_cut', 'high_cut'],
  delay:      ['type', 'time', 'tempo', 'feedback', 'mix', 'low_cut', 'high_cut'],
  compressor: ['type', 'amount', 'attack', 'release', 'level'],
};

/**
 * For a single lineage record, return a human-readable summary of which
 * front-panel knobs apply on this specific block-type wire index. Lets
 * the agent reason about "does this amp have a master?" without a
 * separate list_params call — the answer is right next to the
 * basedOn / lineage data the lookup already returns.
 *
 * Returns `undefined` when applicability annotation isn't meaningful
 * (block type without a type enum, or am4Name not found in the enum).
 */
function formatApplicableKnobs(blockType: string, am4Name: string): string | undefined {
  const enumValues = typeEnumFor(blockType);
  if (enumValues === undefined) return undefined;
  const wireIndex = enumValues.indexOf(am4Name);
  if (wireIndex < 0) return undefined;
  const knobs = FRONT_PANEL_PARAMS[blockType];
  if (knobs === undefined) return undefined;

  const applies: string[] = [];
  const doesNotApply: string[] = [];
  for (const knob of knobs) {
    const key = `${blockType}.${knob}`;
    if (!(key in TYPE_APPLICABILITY)) continue;
    const result = checkApplicability(key, {
      currentTypes: { [blockType]: wireIndex },
    });
    if (result.applicable === true) applies.push(knob);
    else if (result.applicable === false) doesNotApply.push(knob);
    // 'unknown' → omit; we can't make a strong claim either way.
  }
  if (applies.length === 0 && doesNotApply.length === 0) return undefined;

  const lines: string[] = [];
  if (applies.length > 0) {
    lines.push(`frontPanelKnobs: ${applies.join(', ')}`);
  }
  if (doesNotApply.length > 0) {
    lines.push(
      `notExposed: ${doesNotApply.join(', ')}  ` +
      `(real-amp parity — these knobs do NOT exist on this model; the AM4 silently no-ops writes to them; ` +
      `do not include in apply_preset / set_params calls when this type is active)`,
    );
  }
  return lines.join('\n');
}

// ── Reader adapter ──────────────────────────────────────────────────
//
// `getParam` wraps the existing `sendReadAndParse` + `decode` pipeline
// from the legacy `am4_get_param` handler. The dispatcher pre-resolves
// the canonical (block, name); this method does the wire round-trip
// and returns the display value. Optional channel switch happens
// before the read so callers can target A/B/C/D explicitly without
// a separate switch tool call.

export const reader: DeviceReader = {
  async getParam(
    ctx: DispatchCtx,
    block: string,
    name: string,
    channel?: string | number,
  ): Promise<ReadResult> {
    const key = `${block}.${name}` as ParamKey;
    const param: Param = KNOWN_PARAMS[key];
    if (channel !== undefined && CHANNEL_BLOCKS.has(block)) {
      await switchBlockChannel(ctx.conn, block, channel);
    }
    const parsed = await sendReadAndParse(ctx.conn, param.pidLow, param.pidHigh);
    const wire = param.unit === 'enum'
      ? parsed.asUInt32LE()
      : parsed.asInternalFloat();
    const display = param.unit === 'enum'
      ? ((param.enumValues as Record<number, string> | undefined)?.[Math.round(wire)] ?? Math.round(wire))
      : am4Decode(param, wire);
    return {
      block,
      name,
      wire_value: wire,
      display_value: display,
      unit: param.unit,
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

  async getBlockLayoutSnapshot(ctx: DispatchCtx): Promise<BlockLayoutSnapshot> {
    // 4 slot-register reads → block-type names per slot. Identical wire
    // shape to the `am4_get_block_layout` tool (HW-044); kept duplicated
    // rather than refactored to delegate because the tool surface returns
    // formatted text while this method returns structured data.
    const slots: BlockTypeName[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      slots.push(BLOCK_NAMES_BY_VALUE[u32] ?? ('none' as BlockTypeName));
    }
    return buildBlockLayoutSnapshot([slots[0], slots[1], slots[2], slots[3]]);
  },

  async scanLocations(ctx, from, to) {
    const fromIdx = parseAm4Location(from);
    const toIdx = parseAm4Location(to);
    if (fromIdx > toIdx) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `Scan range invalid: ${from} (idx ${fromIdx}) is after ${to} (idx ${toIdx}). Pass from <= to.`,
      );
    }
    const scanned: ScannedLocation[] = [];
    let failed_at: string | undefined;
    let failed_reason: string | undefined;
    for (let i = fromIdx; i <= toIdx; i++) {
      try {
        const parsed = await readPresetName(ctx.conn, i);
        scanned.push({
          location: formatLocationDisplay(i),
          name: parsed.name,
          is_empty: parsed.isEmpty,
        });
      } catch (err) {
        failed_at = formatLocationDisplay(i);
        failed_reason = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    return { scanned, failed_at, failed_reason };
  },

  lookupLineage(query) {
    const blockType = query.block_type;
    if (!LINEAGE_BLOCKS.includes(blockType as typeof LINEAGE_BLOCKS[number])) {
      return {
        ok: false,
        text: `Block type '${blockType}' has no Fractal-authored lineage corpus. Valid: ${LINEAGE_BLOCKS.join(', ')}.`,
      };
    }
    const result = runLineageLookup({
      block_type: blockType as typeof LINEAGE_BLOCKS[number],
      name: query.name,
      real_gear: query.real_gear,
      manufacturer: query.manufacturer,
      model: query.model,
    });
    if (!result.found) {
      const detail = result.shape === 'structured'
        ? [
            query.manufacturer && `manufacturer="${query.manufacturer}"`,
            query.model && `model="${query.model}"`,
          ].filter(Boolean).join(', ')
        : (query.name ?? query.real_gear ?? '(unknown query)');
      return {
        ok: false,
        text: `No ${blockType} lineage records match ${detail}. ${result.totalScanned} records scanned.`,
      };
    }
    const withQuotes = query.include_quotes ?? true;
    if (result.shape === 'forward') {
      const rec = result.hits[0].record;
      const baseText = formatLineageRecord(rec, withQuotes);
      const knobs = formatApplicableKnobs(blockType, rec.am4Name);
      const loudness = formatLoudnessAppendix(rec.am4Name);
      const parts = [baseText, knobs, loudness].filter((s): s is string => Boolean(s));
      return { ok: true, text: parts.join('\n') };
    }
    const blocks = result.hits.map((h) => {
      const am4Name = 'am4Name' in h ? h.am4Name : '?';
      const recordText = formatLineageRecord(h.record, withQuotes, 3);
      const knobs = formatApplicableKnobs(blockType, am4Name);
      const loudness = formatLoudnessAppendix(am4Name);
      const parts = [recordText, knobs, loudness].filter((s): s is string => Boolean(s));
      return `── ${am4Name} ──\n${parts.join('\n')}`;
    });
    return {
      ok: true,
      text: `${result.hits.length} ${blockType} match(es)${result.hits.length > 10 ? ' (showing top 10)' : ''}:\n\n${blocks.join('\n\n')}`,
    };
  },

  lineageCorpus() {
    // One text blob per block type containing every record in the
    // corpus, each formatted with `formatLineageRecord`. Includes the
    // applicable-knobs footer so the agent reading this resource gets
    // the same context-rich view as a `lookup_lineage` reverse hit.
    // include_quotes defaults to true (matching `lookupLineage`'s
    // default), with a tight per-record cap of 3 quotes so the corpus
    // blob stays under MCP resource size limits.
    const out: Record<string, string> = {};
    for (const blockType of LINEAGE_BLOCKS) {
      const records = loadLineage(blockType);
      if (records.length === 0) continue;
      const blocks = records.map((rec) => {
        const recordText = formatLineageRecord(rec, true, 3);
        const knobs = formatApplicableKnobs(blockType, rec.am4Name);
        const loudness = formatLoudnessAppendix(rec.am4Name);
        const parts = [recordText, knobs, loudness].filter((s): s is string => Boolean(s));
        return `── ${rec.am4Name} ──\n${parts.join('\n')}`;
      });
      out[blockType] = `${records.length} ${blockType} records:\n\n${blocks.join('\n\n')}`;
    }
    return out;
  },
};
