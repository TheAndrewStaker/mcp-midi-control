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
  GetPresetOptions,
  LocationRef,
  OverwriteTargetInfo,
  PresetBinaryDump,
  PresetSnapshot,
  PresetSnapshotSlot,
  PresetSlotSpec,
  ReadResult,
  SavedSnapshot,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { receivePresetDumpStream } from '../presetDump.js';

import {
  BLOCK_NAMES_BY_VALUE,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  BLOCK_TYPE_VALUES,
  KNOWN_PARAMS,
  buildBlockLayoutSnapshot,
  buildReadParam,
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  decodeAm4RawPatch,
  decodeAm4AmpBlock,
  formatLocationCode,
  decode as am4Decode,
  roundDisplayValue,
  isRawIntRegister,
  decodeRawIntRegister,
  isReadResponseLong,
  parseLongReadBypassFlag,
  READ_TYPE_LONG,
  type BlockTypeName,
  type Param,
  type ParamKey,
} from 'fractal-midi/am4';
import { formatLocationDisplay } from 'fractal-midi/am4';
import { readAllParams, READ_RESPONSE_TIMEOUT_MS, readPresetName, sendReadAndParse, sendReadAndParseRaw } from '../shared/readOps.js';
import {
  CHANNEL_BLOCKS,
  channelLetter,
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
import { isDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { AM4_DIRTY_LABEL } from '../tools/safeEdit.js';

// Active-location state register (mirrors safeEdit.ts) — read by
// checkOverwriteTarget to tell a refresh-of-current from a clobber-of-other.
const LOCATION_STATE_PID_LOW = 0x00ce;
const LOCATION_STATE_PID_HIGH = 0x000a;

/**
 * Per-block pidLow list, derived once from KNOWN_PARAMS. Most blocks
 * have a single pidLow (e.g. drive = 0x76); amp spans two (0x3a tone
 * stack + 0x3e cab section). Used by `getPreset` to know which chunks
 * to read for each placed slot.
 */
const PID_LOWS_BY_BLOCK: ReadonlyMap<string, readonly number[]> = (() => {
  const acc = new Map<string, Set<number>>();
  for (const param of Object.values(KNOWN_PARAMS)) {
    const p = param as Param;
    if (!acc.has(p.block)) acc.set(p.block, new Set());
    acc.get(p.block)!.add(p.pidLow);
  }
  const out = new Map<string, readonly number[]>();
  for (const [block, set] of acc) out.set(block, [...set].sort((a, b) => a - b));
  return out;
})();

function pidLowsForBlock(blockType: string): readonly number[] {
  return PID_LOWS_BY_BLOCK.get(blockType) ?? [];
}

const SCENE_STATE_PID_LOW = 0x00ce;
const SCENE_STATE_PID_HIGH = 0x000d;
const BYPASS_STATE_PID_HIGH = 0x0003;

/**
 * Decode a `<block>.channel` selector read into an A/B/C/D letter.
 *
 * reverb / delay / drive read the channel index back as a clean raw u32
 * (0..3), so the direct `enumValues[asUInt32LE]` lookup succeeds. The AMP
 * channel selector at (0x003A, 0x07D2) is different: it reads back derived
 * /cached firmware state, not the index (HW archive: 11244 / 19968 observed
 * with no clean enum fit). The SYSEX-MAP records the SET side as "enum int
 * 0..3 packed as float32", so we try a float32 interpretation as a
 * best-effort fallback. This is NOT a guaranteed-correct decode of the
 * active amp channel; on hardware it must be confirmed against the front
 * panel for non-A channels. `get_preset(include_channel_state:true)` does
 * not rely on it; it reads all four channels from the channel-blocked dump
 * in FIXED A/B/C/D order.
 */
function decodeChannelSelector(
  parsed: { asUInt32LE(): number; rawValue: Uint8Array },
  enumValues: Record<number, string> | undefined,
): { letter?: string; failureReason?: string } {
  const wire = parsed.asUInt32LE();
  const direct = enumValues?.[Math.round(wire)];
  if (typeof direct === 'string') return { letter: direct };
  const floatView = new DataView(parsed.rawValue.buffer, parsed.rawValue.byteOffset, 4);
  const asFloat = floatView.getFloat32(0, true);
  const rounded = Math.round(asFloat);
  if (Number.isFinite(asFloat) && rounded >= 0 && rounded <= 3) {
    const floatName = enumValues?.[rounded];
    if (typeof floatName === 'string') return { letter: floatName };
    return {
      failureReason:
        `channel float read ${asFloat} (rounded ${rounded}) not in enumValues ` +
        `(have ${Object.keys(enumValues ?? {}).join(',')})`,
    };
  }
  return {
    failureReason:
      `channel wire ${wire} (0x${wire.toString(16)}) not in enumValues ` +
      `(have ${Object.keys(enumValues ?? {}).join(',')}); float32 interpretation = ${asFloat}`,
  };
}

async function readBypassState(
  conn: import('@mcp-midi-control/core/midi/transport.js').MidiConnection,
  blockType: string,
): Promise<boolean | undefined> {
  const pidLow = BLOCK_TYPE_VALUES[blockType as BlockTypeName];
  if (pidLow === undefined || pidLow === BLOCK_TYPE_VALUES.none) return undefined;
  try {
    const readBytes = buildReadParam(
      { pidLow, pidHigh: BYPASS_STATE_PID_HIGH },
      READ_TYPE_LONG,
    );
    const respPromise = conn.receiveSysExMatching(
      (resp) => isReadResponseLong(readBytes, resp),
      READ_RESPONSE_TIMEOUT_MS,
    );
    conn.send(readBytes);
    const resp = await respPromise;
    return parseLongReadBypassFlag(resp);
  } catch {
    return undefined;
  }
}

/**
 * Decode one chunk u16 to its display value. Mirrors the per-paramId
 * `get_param` decode path:
 *   - enum: look up `enumValues[wire]`, fall back to raw int
 *   - non-enum: internal = u16 / 65534 (Q16 → [0..1]), then `am4Decode`
 *     applies the per-unit scale (knob_0_10 / percent / log10-ratio / etc.)
 *
 * Wire-encoding rule cited in `[[am4-fn1f-atomic-read]]` cookbook entry.
 */
function decodeChunkValue(param: Param, wire: number): number | string {
  if (param.unit === 'enum') {
    const enumValues = param.enumValues as Record<number, string> | undefined;
    return enumValues?.[wire] ?? wire;
  }
  const internal = wire / 65534;
  return roundDisplayValue(param, am4Decode(param, internal));
}

/**
 * Decode every registered param of `blockType` for one channel directly
 * from the fn 0x1F chunk dump already in hand.
 *
 * The AM4 `0x75` body is CHANNEL-BLOCKED: it packs four contiguous copies
 * of every paramId slot, one per channel, in FIXED order A/B/C/D (quarter 0
 * = channel A), so `value index = channel * stride + pidHigh` with
 * `stride = itemCount / 4`. Confirmed on live AM4 hardware 2026-06-04
 * (`probe-am4-channel-{blocked,orientation,switch-test}.ts`): channel-bearing
 * blocks all have `itemCount % 4 === 0` with DISTINCT quarters, and a
 * reversible A->B->A switch left the quarters invariant (FIXED, not sliding).
 * See `readOps.ts` and cookbook `am4-fn1f-atomic-read`.
 *
 * Non-channel-blocked chunks (`itemCount % 4 !== 0`, every non-channel
 * register) degrade safely: only channel index 0 reads a value (at `pidHigh`),
 * other channel indices return nothing for that chunk.
 */
function decodeChannelParams(
  blockType: string,
  chunks: ReadonlyMap<number, { itemCount: number; values: readonly number[] }>,
  channelIndex: number,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [, param] of Object.entries(KNOWN_PARAMS)) {
    const p = param as Param;
    if (p.block !== blockType) continue;
    const chunk = chunks.get(p.pidLow);
    if (chunk === undefined) continue;
    const { itemCount, values } = chunk;
    let idx: number;
    if (itemCount > 0 && itemCount % 4 === 0) {
      const stride = itemCount / 4;
      idx = channelIndex * stride + p.pidHigh;
    } else {
      // Not channel-blocked: a single copy at pidHigh; only channel A is real.
      if (channelIndex !== 0) continue;
      idx = p.pidHigh;
    }
    if (idx >= values.length) continue;
    out[p.name] = decodeChunkValue(p, values[idx]);
  }
  return out;
}

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
      `(real-amp parity: these knobs do NOT exist on this model; the AM4 silently no-ops writes to them; ` +
      `do not include in apply_preset / set_params calls when this type is active)`,
    );
  }
  return lines.join('\n');
}

/**
 * Save receipt. After a save persists, read back the working buffer with
 * TARGETED deterministic reads only — the same primitives get_param /
 * get_block_layout use, never the non-deterministic fn-0x1F bulk dump (whose
 * chunk-to-paramId map is undecoded). Returns the 4-slot block chain plus the
 * amp/drive MODEL NAMES (the bytes that distinguish one preset from another),
 * and the persisted preset name at the just-saved location.
 *
 * Reads (worst case 7, ~350 ms): 4 block-slot reads + amp.type + drive.type
 * + readPresetName(target). Each model read is gated on its block being placed
 * (no wasted read when there's no drive). Every field but block_chain is
 * best-effort: a thrown read omits the field, never throws. The caller
 * (savePreset) treats the whole call as best-effort too — a failure here must
 * not fail a save that already landed.
 *
 * `missing` collects field names whose read failed so the caller can surface
 * an honest "could not confirm X" line instead of silently dropping it.
 */
export async function readSaveSnapshot(
  ctx: DispatchCtx,
  locationIndex: number,
): Promise<{ snapshot: SavedSnapshot; missing: string[] }> {
  const missing: string[] = [];

  // 1. Block chain — 4 deterministic slot-register reads (same wire shape as
  //    getBlockLayoutSnapshot). A failed slot read records 'none' for that
  //    slot rather than aborting the chain.
  const block_chain: string[] = [];
  for (const position of [1, 2, 3, 4] as const) {
    try {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      block_chain.push(BLOCK_NAMES_BY_VALUE[u32] ?? 'none');
    } catch {
      block_chain.push('none');
      missing.push(`block_chain[slot ${position}]`);
    }
  }

  // 2/3. Amp + drive MODEL NAME via targeted single-param enum reads (the
  //      get_param path: deterministic fn 0x02 GET, NOT the opaque fn-0x1F
  //      chunk dump). Only read the type when the block is actually placed.
  const readModel = async (
    key: ParamKey,
    blockName: string,
    enumTable: readonly string[],
    fieldLabel: string,
  ): Promise<string | undefined> => {
    if (!block_chain.includes(blockName)) return undefined; // block not placed
    try {
      const param = KNOWN_PARAMS[key] as Param;
      const parsed = await sendReadAndParse(ctx.conn, param.pidLow, param.pidHigh);
      const wire = parsed.asUInt32LE();
      const name = enumTable[wire];
      if (typeof name === 'string') return name;
      missing.push(fieldLabel);
      return undefined;
    } catch {
      missing.push(fieldLabel);
      return undefined;
    }
  };
  const amp_model = await readModel('amp.type' as ParamKey, 'amp', AMP_TYPES, 'amp_model');
  const drive_model = await readModel('drive.type' as ParamKey, 'drive', DRIVE_TYPES, 'drive_model');

  // 4. Persisted preset name at the target (non-destructive, action 0x0012).
  let preset_name: string | undefined;
  try {
    const parsed = await readPresetName(ctx.conn, locationIndex);
    preset_name = parsed.isEmpty ? undefined : (parsed.name?.trim() || undefined);
  } catch {
    missing.push('preset_name');
  }

  return {
    snapshot: {
      block_chain,
      ...(amp_model !== undefined ? { amp_model } : {}),
      ...(drive_model !== undefined ? { drive_model } : {}),
      ...(preset_name !== undefined ? { preset_name } : {}),
    },
    missing,
  };
}

/** AM4 model byte, surfaced on the whole_preset view (matches descriptor). */
const AM4_MODEL_ID = 0x15;

/**
 * STORED get_preset by location (A01..Z04). Requests the flash dump for the
 * given location (fn 0x03 [bank, sub, 0x00]; hardware-confirmed 2026-06-10 to
 * answer the canonical 6-frame / 12,352-byte 0x77/0x78/0x79 stream WITHOUT
 * touching the working buffer), reassembles the multi-fragment dump (the
 * ~3,082 B × 4 chunks arrive as separate SysEx messages — `receivePresetDumpStream`
 * owns the reassembly, the same createSysExAssembler-style collector
 * `export_preset` uses), and decodes the container via `decodeAm4RawPatch`
 * (the AM4 body IS the gen-3 preset container: 3→16 unpack → CRC-16/CCITT +
 * footer-XOR validation → Huffman decompress). The decode is byte-validated
 * offline against the 104-preset factory bank + hardware exports.
 *
 * Latency: ONE stored-dump round-trip — ~150-200 ms on hardware (Session 51
 * capture: the 6 frames arrive within ~250 ms of the request). Well inside the
 * performance budget for an overt single-preset read; no per-param loop.
 *
 * Read-only: the stored-dump request issues no write and touches no write gate
 * (working buffer untouched), but it follows the same subscribe-before-send
 * read pattern the other readers use so the response can't outrace the listener.
 *
 * LABELED OMISSION: the decoded body's per-param word->knob VALUES are NOT
 * surfaced — the body field map is only partially pinned (preset name + the 4
 * scene names + amp.gain chA so far). Decoding every block/param value is the
 * follow-on field-map decode (a separate in-flight task), so the snapshot
 * honestly says so rather than guessing. `whole_preset` carries name + scene
 * names + the self-validating CRC flag; `paramBlockBytes` (decompressed body
 * size) is surfaced as evidence the body actually decoded.
 */
async function getStoredPresetSnapshot(
  ctx: DispatchCtx,
  location: string | number,
): Promise<PresetSnapshot> {
  const readStartedMs = Date.now();
  const locationIndex = parseAm4Location(location);
  const code = formatLocationDisplay(locationIndex);

  // Subscribe to the 6-message dump stream BEFORE sending the request.
  const streamPromise = receivePresetDumpStream(ctx.conn, { timeoutMs: 2000 });
  ctx.conn.send(buildRequestStoredPresetDump(locationIndex));
  let stream;
  try {
    stream = await streamPromise;
  } catch (err) {
    throw new DispatchError(
      'no_ack',
      'Fractal AM4',
      `get_preset(${code}): stored-location dump got no response; ${err instanceof Error ? err.message : String(err)}. ` +
        `Check the AM4 is connected (try reconnect_midi) and an editor isn't holding the port.`,
    );
  }

  // Concatenate header + 4 chunks + footer in wire order → a valid .syx dump.
  const flat: number[] = [...stream.headerBytes];
  for (const chunk of stream.chunkBytes) for (const b of chunk) flat.push(b);
  for (const b of stream.footerBytes) flat.push(b);

  let decoded;
  try {
    decoded = decodeAm4RawPatch(Uint8Array.from(flat));
  } catch (err) {
    throw new DispatchError(
      'no_ack',
      'Fractal AM4',
      `get_preset(${code}): the stored dump from the AM4 did not decode as a preset container ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const paramBlockBytes = decoded.decompressedBody.length;

  // Walk the decoded body's block-record chain to the AMP block and surface
  // its per-channel (A/B/C/D) param VALUES. Amp block only: it is the one block
  // with a validated record shape + ordinal-bounded TYPE enum to reject
  // false-positive markers (cab/FX share the chain structure but their per-block
  // stride/formula is unverified — an honest omission until a per-block capture
  // confirms transfer). The walker locates the config-dependent marker (0x0934
  // vs 0x0A92 vs absent) — never a hardcoded offset. See fractal-midi bodyChain.ts.
  const ampBlock = decodeAm4AmpBlock(decoded.decompressedBody, decoded.decompSize);

  const read_warnings: string[] = [
    `Snapshot source: STORED preset at location ${code} (fn 0x03 flash dump; working buffer untouched). ` +
      `Container decoded, CRC ${decoded.crcValid ? 'valid' : 'INVALID (the dump may be corrupt; values unreliable)'}, ` +
      `footer XOR ${decoded.footerXorValid ? 'matches' : 'MISMATCH'}, ` +
      `Huffman body ${decoded.huffmanComplete ? 'terminated cleanly' : 'did NOT terminate at decompSize'} ` +
      `(${paramBlockBytes} B decompressed, fw word 0x${decoded.fwWord.toString(16).padStart(4, '0')}).`,
    ampBlock !== undefined
      ? 'AMP param VALUES are surfaced (whole_preset.amp), all four channels A/B/C/D, decoded byte-exact from ' +
        'the body block-record chain. The four warm-pair-anchored fields (amp.type, amp.gain chA/chB, amp.master chA) ' +
        'are CONFIRMED against hardware captures; the remaining amp knobs ride the SAME confirmed record geometry ' +
        '(marker + 0x130 channel stride + pidHigh-rule) and are formula-extrapolated from those anchors. ' +
        'NON-amp block VALUES (cab / drive / delay / reverb / etc.) are NOT surfaced: those blocks share the chain ' +
        'structure but their per-block param formula is not yet capture-confirmed, so they are honestly omitted ' +
        'rather than guessed. For any live value use get_param / get_params, or read the ACTIVE buffer with ' +
        'get_preset (no location); that path returns full per-block params from the fn 0x1F poll.'
      : 'This preset has NO amp block (empty location or an intentional no-amp DI patch), so no amp values are ' +
        'surfaced. NON-amp block VALUES are not decoded from the stored dump yet (field map pending); use ' +
        'get_param / get_params or read the ACTIVE buffer with get_preset (no location) for live values.',
    'AM4 stored get_preset is community-beta: the container decode is byte-validated offline against the ' +
      '104-preset factory bank + hardware exports (self-validating CRC + footer XOR), and the stored-dump request ' +
      'is hardware-confirmed (2026-06-10, no working-buffer side effect); confirm the name + scene names ' +
      '(and amp model/knobs, if present) against the front panel and report the result.',
  ];

  return {
    name: decoded.name,
    // The body's slot-assignment (which block sits in slot 1..4) is not yet
    // decoded, so no positioned `slots[]` are surfaced. The amp block's VALUES
    // ride on whole_preset.amp (the gen-3 stored path does the same via amp1).
    slots: [],
    whole_preset: {
      source: 'stored-dump',
      model: 'Fractal AM4',
      model_id: AM4_MODEL_ID,
      preset_name: decoded.name,
      crc_valid: decoded.crcValid,
      scene_names: decoded.sceneNames,
      ...(ampBlock !== undefined ? { amp: ampBlock.channels } : {}),
    },
    read_warnings,
    _meta: {
      device: 'Fractal AM4',
      read_at_ms: Date.now(),
      // The stored dump carries all four scene NAMES, not a single active
      // scene's state — so it is not scoped to one active scene.
      active_scene_only: false,
      routing_omitted: true,
      read_duration_ms: Date.now() - readStartedMs,
    },
  };
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
    const { parsed, raw_response } = await sendReadAndParseRaw(ctx.conn, param.pidLow, param.pidHigh);
    // The MIDI-config registers (global map + per-scene MIDI slots) store a
    // literal integer in the read u32; every other non-enum param is a
    // normalized Q16 float. Reading a raw-int register through the Q16 path
    // divides by 65534 and displays ~0 (BUG-6). See midiRegisters.ts.
    const rawInt = isRawIntRegister(param);
    const wire = param.unit === 'enum' || rawInt
      ? parsed.asUInt32LE()
      : parsed.asInternalFloat();
    let display: number | string;
    if (param.unit === 'enum') {
      const enumValues = param.enumValues as Record<number, string> | undefined;
      const direct = enumValues?.[Math.round(wire)];
      if (direct !== undefined) {
        display = direct;
      } else if (name === 'channel' && CHANNEL_BLOCKS.has(block)) {
        // amp's channel selector reads back derived/cached firmware state
        // (raw u32 like 19968, not 0..3); fall back to the float32-packed-enum
        // interpretation so it resolves to a letter. See decodeChannelSelector.
        display = decodeChannelSelector(parsed, enumValues).letter ?? Math.round(wire);
      } else {
        display = Math.round(wire);
      }
    } else if (rawInt) {
      display = decodeRawIntRegister(param, wire);
    } else {
      display = roundDisplayValue(param, am4Decode(param, wire));
    }
    return {
      block,
      name,
      wire_value: wire,
      display_value: display,
      unit: param.unit,
      raw_response,
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

  async dumpActivePresetBinary(ctx: DispatchCtx): Promise<PresetBinaryDump> {
    // Byte-exact backup of the active working buffer via the fn 0x03
    // request → 6-message PRESET_DUMP stream (0x77 header + 4× 0x78 chunks
    // + 0x79 footer, 12,352 bytes). The concatenated frames are a valid
    // `.syx`. The AM4 encoder is non-deterministic between identical dumps
    // (its inner bytes are not byte-stable), so we can't decode the blob,
    // but a verbatim backup still round-trips to the same location. Restore
    // is a separate (not-yet-shipped) path; export is read-only and safe.
    // The listener must be registered before the request is sent.
    const streamPromise = receivePresetDumpStream(ctx.conn, { timeoutMs: 2000 });
    ctx.conn.send(buildRequestActiveBufferDump());
    let stream;
    try {
      stream = await streamPromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        'Fractal AM4',
        `export_preset: ${err instanceof Error ? err.message : String(err)}. Check the AM4 is connected (try reconnect_midi).`,
      );
    }
    // Concatenate header + chunks + footer in wire order.
    const flat: number[] = [...stream.headerBytes];
    for (const chunk of stream.chunkBytes) for (const b of chunk) flat.push(b);
    for (const b of stream.footerBytes) flat.push(b);
    const bytes = Uint8Array.from(flat);
    return {
      bytes,
      byte_length: bytes.length,
      frame_count: stream.messageCount,
      format: 'am4-preset-dump',
      // AM4's working-buffer name read needs a stored-location index the
      // active buffer doesn't have, so the name is omitted here; the
      // backup filename falls back to device + timestamp.
      source: 'active working buffer',
    };
  },

  async dumpStoredPresetBinary(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> {
    // Byte-exact backup of a STORED preset location via the fn 0x03
    // [bank, sub, 0x00] request (H1 encoding, hardware-confirmed
    // 2026-06-10: A01/A02/Z04 each answered the canonical 6-frame /
    // 12,352-byte stream with the [bank, sub] echoed in the 0x77
    // header, and NO working-buffer side effect). `location` is the
    // 0-based index 0..103 (A01..Z04).
    if (!Number.isInteger(location) || location < 0 || location > 103) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `export_preset: location index ${location} out of range; the AM4 has 104 stored locations, index 0..103 (A01..Z04).`,
      );
    }
    const code = formatLocationCode(location);
    const streamPromise = receivePresetDumpStream(ctx.conn, { timeoutMs: 2000 });
    ctx.conn.send(buildRequestStoredPresetDump(location));
    let stream;
    try {
      stream = await streamPromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        'Fractal AM4',
        `export_preset: stored-location dump of ${code} got no response; ${err instanceof Error ? err.message : String(err)}. Check the AM4 is connected (try reconnect_midi).`,
      );
    }
    const flat: number[] = [...stream.headerBytes];
    for (const chunk of stream.chunkBytes) for (const b of chunk) flat.push(b);
    for (const b of stream.footerBytes) flat.push(b);
    const bytes = Uint8Array.from(flat);
    // Best-effort stored-name read for the backup filename (same
    // helper scanLocations uses).
    let name: string | undefined;
    try {
      const parsed = await readPresetName(ctx.conn, location);
      name = parsed.name?.trimEnd() || undefined;
    } catch {
      name = undefined;
    }
    return {
      bytes,
      byte_length: bytes.length,
      frame_count: stream.messageCount,
      format: 'am4-preset-dump',
      name,
      source: `stored preset at location ${code} (fn 0x03 flash dump; working buffer untouched)`,
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

  // Overwrite pre-check capability — backs the dispatcher's confirmable
  // overwrite gate. Reads the active location + the target's name, both
  // non-destructively. Returns undefined when occupancy can't be determined
  // (a read failed) so the dispatcher degrades rather than guessing.
  async checkOverwriteTarget(ctx: DispatchCtx, location: LocationRef): Promise<OverwriteTargetInfo | undefined> {
    const locationIndex = parseAm4Location(location);
    const target_display = formatLocationDisplay(locationIndex);
    let activeIndex: number | undefined;
    try {
      const parsed = await sendReadAndParse(ctx.conn, LOCATION_STATE_PID_LOW, LOCATION_STATE_PID_HIGH);
      const idx = parsed.asUInt32LE();
      if (idx >= 0 && idx <= 103) activeIndex = idx;
    } catch {
      activeIndex = undefined;
    }
    if (activeIndex !== undefined && activeIndex === locationIndex) {
      // Saving over the location we're editing is a refresh, not a clobber.
      return { target_display, is_active_location: true };
    }
    try {
      const resp = await readPresetName(ctx.conn, locationIndex);
      const occupant = resp.isEmpty ? undefined : (resp.name?.trim() || undefined);
      return { target_display, is_active_location: false, ...(occupant ? { occupant_name: occupant } : {}) };
    } catch {
      return undefined; // name read failed → let the dispatcher degrade
    }
  },

  // Read-after-save receipt capability — delegates to the module-scope
  // readSaveSnapshot() above (object-method names don't shadow module bindings).
  async readSaveSnapshot(ctx: DispatchCtx, location: LocationRef): Promise<{ snapshot: SavedSnapshot; missing: readonly string[] }> {
    return readSaveSnapshot(ctx, parseAm4Location(location));
  },

  async getPreset(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
    // STORED-PRESET path: when a location is given (A01..Z04), dump that stored
    // slot (fn 0x03 flash dump) and container-decode its name + scene names.
    // This is the byte-exact stored snapshot; the ACTIVE-buffer path below
    // (no location) keeps its fn 0x1F per-block param read. See
    // getStoredPresetSnapshot for the latency + labeled-omission notes.
    if (options?.location !== undefined) {
      return getStoredPresetSnapshot(ctx, options.location);
    }

    // ALL FOUR channels are returned for every channel-bearing block. The
    // fn 0x1F `0x75` body is CHANNEL-BLOCKED: it already carries A/B/C/D
    // (FIXED order, quarter 0 = A) at `channel * stride + pidHigh` (stride =
    // itemCount / 4), so the full per-channel snapshot costs no extra wire
    // round-trips beyond the chunk read every block needs anyway. This is
    // also the BUG-1 fix: the old default returned only one channel and
    // labeled it 'active' from the block's channel-selector register, which
    // reads back derived/cached firmware state on the amp and mis-attributed
    // the active tone. The `include_channel_state` option is now a no-op (all
    // channels always returned). Channel-blocked layout confirmed on live AM4
    // hardware 2026-06-04 (cookbook am4-fn1f-atomic-read).
    // Server-side timer around the SysEx read loop — surfaced as
    // _meta.read_duration_ms (client-independent; alpha.17 finding).
    const readStartedMs = Date.now();

    // 1. Block layout (4 slot reads).
    const layoutSlots: BlockTypeName[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      layoutSlots.push(BLOCK_NAMES_BY_VALUE[u32] ?? ('none' as BlockTypeName));
    }

    // 2. Per placed slot: chunk-based read via fn 0x1F + bypass read.
    //    Performance: ~50 ms per pidLow chunk, ~50 ms per bypass read. All
    //    channels come from the chunk(s) already read (channel-blocked), so
    //    include_channel_state adds no extra wire round-trips.
    const slots: PresetSnapshotSlot[] = [];
    const errors: string[] = [];
    let totalPlaced = 0;
    for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
      const blockType = layoutSlots[slotIdx];
      if (blockType === 'none') continue;
      totalPlaced++;

      try {
        const pidLows = pidLowsForBlock(blockType);
        if (pidLows.length === 0) {
          errors.push(`slot ${slotIdx + 1} (${blockType}): no documented params`);
          continue;
        }
        const chunks = new Map<number, { itemCount: number; values: number[] }>();
        for (const pidLow of pidLows) {
          const triple = await readAllParams(ctx.conn, pidLow);
          chunks.set(pidLow, { itemCount: triple.itemCount, values: triple.values });
        }

        const bypassed = await readBypassState(ctx.conn, blockType);

        // Shape decision: must match II reader so the response is consistent
        // across every channel-bearing block on every device. Non-channel
        // blocks use flat `params`; channel blocks surface ALL FOUR channels
        // under `params_by_channel`.
        //
        // BUG-1 (2026-07-04 AM4 session): we no longer try to name a single
        // "active" channel from the block's channel-selector register. The
        // amp selector reads back derived/cached firmware state, not the
        // channel index, so decodeChannelSelector produced a false-confident
        // channel A while the active scene was on B — an agent state-anchored
        // on the wrong tone. The fn 0x1F `0x75` dump is channel-blocked and
        // already carries all four channels (A/B/C/D, FIXED order, quarter 0 =
        // A) at `channel * stride + pidHigh`, so returning every channel is
        // FREE (no extra wire read) and hides nothing. Which channel the
        // active scene selects is derivable from `active_scene` + a live
        // get_param read (a plain get_param with no channel arg returns the
        // active channel's value). Channel-blocked layout confirmed on live
        // AM4 hardware 2026-06-04 (cookbook am4-fn1f-atomic-read).
        let params: PresetSlotSpec['params'];
        let paramsByChannel: PresetSlotSpec['params_by_channel'];
        let channelStatus: PresetSnapshotSlot['channel_status'];
        if (!CHANNEL_BLOCKS.has(blockType)) {
          params = decodeChannelParams(blockType, chunks, 0);
        } else {
          const allChannelParams: Record<string, Record<string, number | string>> = {};
          for (let c = 0; c < 4; c++) {
            const chParams = decodeChannelParams(blockType, chunks, c);
            if (Object.keys(chParams).length > 0) allChannelParams[channelLetter(c)] = chParams;
          }
          paramsByChannel = allChannelParams;
          channelStatus = 'all_channels';
        }

        slots.push({
          slot: (slotIdx + 1) as 1 | 2 | 3 | 4,
          block_type: blockType,
          id: blockType,
          ...(bypassed !== undefined ? { bypassed } : {}),
          ...(params !== undefined ? { params } : {}),
          ...(paramsByChannel !== undefined ? { params_by_channel: paramsByChannel } : {}),
          channel_status: channelStatus,
        });
      } catch (err) {
        errors.push(`slot ${slotIdx + 1} (${blockType}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length === totalPlaced && totalPlaced > 0) {
      throw new DispatchError(
        'no_ack',
        'Fractal AM4',
        `get_preset: read failed on every placed block (${totalPlaced} blocks). First error: ${errors[0]}`,
      );
    }

    // Active scene read (best-effort, non-blocking on failure).
    let activeScene: number | undefined;
    try {
      const parsed = await sendReadAndParse(ctx.conn, SCENE_STATE_PID_LOW, SCENE_STATE_PID_HIGH);
      const sceneIndex = parsed.asUInt32LE();
      if (sceneIndex >= 0 && sceneIndex <= 3) activeScene = sceneIndex + 1;
    } catch {
      activeScene = undefined;
    }

    // GAP-1: current stored-location pointer (best-effort, one read) + the
    // in-memory dirty flag. Lets an agent plan navigation / dirty-buffer
    // gating from the same call. `is_dirty` sees edits made through this
    // server only (the AM4 emits no dirty push), so front-panel edits are
    // invisible to it.
    let currentLocation: string | undefined;
    try {
      const parsed = await sendReadAndParse(ctx.conn, LOCATION_STATE_PID_LOW, LOCATION_STATE_PID_HIGH);
      const idx = parsed.asUInt32LE();
      if (idx >= 0 && idx <= 103) currentLocation = formatLocationDisplay(idx);
    } catch {
      currentLocation = undefined;
    }
    const dirty = isDirty(AM4_DIRTY_LABEL);

    return {
      slots,
      active_scene: activeScene,
      ...(errors.length > 0 ? { read_warnings: errors } : {}),
      _meta: {
        device: 'Fractal AM4',
        read_at_ms: Date.now(),
        active_scene_only: true,
        routing_omitted: true,
        channel_state_omitted: false,
        both_channels_read: true,
        read_duration_ms: Date.now() - readStartedMs,
        ...(currentLocation !== undefined ? { current_location: currentLocation } : {}),
        is_dirty: dirty,
      },
    };
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
      return `${am4Name}\n${parts.join('\n')}`;
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
        return `${rec.am4Name}\n${parts.join('\n')}`;
      });
      out[blockType] = `${records.length} ${blockType} records:\n\n${blocks.join('\n\n')}`;
    }
    return out;
  },
};
