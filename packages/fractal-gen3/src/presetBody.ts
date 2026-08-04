/**
 * Gen-3 decompressed-patch-body decoder: turns the flat body image produced by
 * `decodeRawPatch().body` (presetHuffman.ts) into a structured whole-preset
 * snapshot — preset/scene names, the routing grid, the placed-block chain with
 * per-channel (A/B/C/D) effect types + scene bypass/channel state, the amp model
 * and its per-channel knobs, modifier routing, and scene-controller values.
 *
 * STRUCTURE SOURCE: the layout (block-chain walk, header-word semantics, grid
 * stride, per-device type-extraction offsets) is reimplemented from the
 * BoodieTraps Apache-2.0 `fractal-syx-codec` reference decoder
 * (fm3_syx_decoder.py: walk_blocks / parse_grid / parse_decompressed /
 * extract_*). Reimplemented from structure, not line-ported; every offset is
 * grounded with a comment. The block type rosters + param maps are generated
 * into gen3BodyTables.ts. See the repo NOTICE + README Credits.
 *
 * DISCIPLINE: this is intricate offset parsing — unlike presetHuffman.ts it is
 * NOT self-validating (no CRC over the parse). Every field this module emits is
 * cross-checked byte-for-byte against the reference decoder across all 384
 * Axe-Fx III factory presets (+ an FM9 export) by
 * `scripts/verify-gen3-preset-body.ts`. The output here is deliberately a
 * SUPERSET-free match of the reference: it decodes exactly what the reference
 * validates and no more. Generic per-block named-knob VALUE extraction over the
 * full PARAM_MAPPINGS is intentionally NOT done here — there is no in-repo
 * value-scale ground truth to validate it against, and wrong body offsets give
 * plausible-but-wrong values. Amp knobs ARE decoded (FM3/FM9), because the
 * reference decoder extracts them and so they are cross-validated.
 */

import { TYPE_BINARY_IDS } from './gen3BodyTables.js';
import { decodeRawPatch } from './presetHuffman.js';
import { parsePresetDump } from './presetDump.js';
import { GEN3_READ_ROSTERS } from 'fractal-midi/gen3/axe-fx-iii';

// ── Device model ids (raw_patch / SysEx model byte) ───────────────────
export const MODEL_AXE_FX_III = 0x10;
export const MODEL_FM3 = 0x11;
export const MODEL_FM9 = 0x12;

const MODEL_NAMES: Record<number, string> = {
  [MODEL_AXE_FX_III]: 'Axe-Fx III',
  [MODEL_FM3]: 'FM3',
  [MODEL_FM9]: 'FM9',
};

/** Each placed block opens with a 23-word header before its per-channel param
 *  array; header word 15 = cols, word 16 = rows, word 17 = (header-located)
 *  type id. (fm3_syx_decoder BLOCK_HEADER_WORDS) */
const BLOCK_HEADER_WORDS = 23;

// Type-location rule: where a block's effect-type id lives.
//   ['header', n] -> header word n (shared across channels at that word)
//   ['param', n]  -> per-channel param-array word n (repeats at +cols stride)
type TypeLoc = readonly ['header' | 'param', number];
const TYPE_H17: TypeLoc = ['header', 17];
const TYPE_P0: TypeLoc = ['param', 0];
const TYPE_P4: TypeLoc = ['param', 4];
const TYPE_P6: TypeLoc = ['param', 6];

/** Per-channel amp knobs, by BYTE offset from the channel's type word. The
 *  names are the display knob labels; values are 0..10 (raw/65535*10). Matches
 *  the reference decoder's AMP_PARAM_OFFSETS so amp knobs cross-validate. */
const AMP_PARAM_OFFSETS: Record<string, number> = {
  type: 0,
  drive: 2,
  bass: 4,
  mid: 6,
  treble: 8,
  master_volume: 10,
  depth: 32,
  sag: 38,
  presence: 40,
  negative_feedback: 42,
};

// Block cols -> block name. The number of param columns identifies the block.
// Shared across devices, with a handful of per-device/per-firmware overrides.
const SHARED_BLOCK_COLS: Record<number, string> = {
  96: 'Plex Delay',
  48: 'Ten-Tap',
  40: 'Resonator',
  37: 'Comp',
  35: 'Phaser',
  33: 'Flanger',
  29: 'Chorus',
  26: 'PEQ',
  25: 'Wah',
  24: 'Looper',
  22: 'Tremolo',
  21: 'Rotary',
  20: 'GEQ',
  19: 'Gate',
  17: 'Mixer',
  13: 'RingMod',
  12: 'Enhancer',
  11: 'Enhancer',
  10: 'Vol/Pan',
  7: 'Multiplexer',
  6: 'Return',
  2: 'Send',
};

const SHARED_TYPE_LOCS: Record<string, TypeLoc> = {
  Chorus: TYPE_H17,
  Drive: TYPE_H17,
  Filter: TYPE_H17,
  Flanger: TYPE_H17,
  Phaser: TYPE_H17,
  Tremolo: TYPE_H17,
  Wah: TYPE_H17,
  Enhancer: TYPE_H17,
  Rotary: TYPE_H17,
};

interface DeviceProfile {
  readonly name: string;
  readonly gridRows: number;
  readonly gridCols: number;
  readonly blockColsMap: Readonly<Record<number, string>>;
  readonly typeLocations: Readonly<Record<string, TypeLoc>>;
}

const DEVICE_PROFILES: Record<number, DeviceProfile> = {
  [MODEL_FM3]: {
    name: 'FM3',
    gridRows: 4,
    gridCols: 12,
    blockColsMap: {
      ...SHARED_BLOCK_COLS,
      144: 'Amp',
      121: 'MultiTap',
      114: 'Pitch',
      113: 'Pitch', // firmware 10.0
      106: 'Cab',
      101: 'Cab', // firmware 10.0
      88: 'Delay',
      71: 'Reverb',
      43: 'Drive',
      42: 'Drive', // firmware 10.0 (was Synth on old firmware)
    },
    typeLocations: { ...SHARED_TYPE_LOCS, Amp: TYPE_P0, Delay: TYPE_P0, Reverb: TYPE_H17, Comp: TYPE_P6 },
  },
  [MODEL_FM9]: {
    name: 'FM9',
    gridRows: 6,
    gridCols: 14,
    blockColsMap: {
      ...SHARED_BLOCK_COLS,
      147: 'Amp',
      121: 'MultiTap',
      113: 'Pitch',
      101: 'Cab',
      90: 'Delay',
      73: 'Reverb',
      42: 'Drive',
    },
    typeLocations: { ...SHARED_TYPE_LOCS, Amp: TYPE_P4, Delay: TYPE_P4, Reverb: TYPE_P4, Comp: TYPE_P6 },
  },
  [MODEL_AXE_FX_III]: {
    name: 'Axe-Fx III',
    gridRows: 6,
    gridCols: 14,
    blockColsMap: {
      ...SHARED_BLOCK_COLS,
      142: 'Amp',
      121: 'MultiTap',
      113: 'Pitch',
      105: 'Cab',
      88: 'Delay',
      71: 'Reverb',
      42: 'Drive',
    },
    typeLocations: { ...SHARED_TYPE_LOCS, Amp: TYPE_H17, Delay: TYPE_H17, Reverb: TYPE_H17, Comp: TYPE_P6 },
  },
};

export function getProfile(modelId: number): DeviceProfile {
  return DEVICE_PROFILES[modelId] ?? DEVICE_PROFILES[MODEL_FM3];
}

export type { DeviceProfile, TypeLoc };

/**
 * Byte offset, inside the decompressed body, of a block's effect-TYPE id for a
 * given channel — the exact location `walkBlocks` READS, so a write here is
 * read-after-write consistent (re-decoding the edited body reports the new
 * type). This is the inverse of the type-extraction in `walkBlocks`; the
 * authoring helper (`presetAuthor.ts`) pokes a u16 here.
 *
 * `block` is a `Gen3Block` from `decodeGen3Body(...).blocks`. Cab is not a
 * simple type swap (DynaCab bank/id indices) and is rejected. For type fields
 * that are shared across channels (header-located on a <4-row block, or a
 * param-located <4-row block) the `channel` argument is ignored and the single
 * shared location is returned.
 */
export function typeFieldByteOffset(
  block: Gen3Block,
  channel: string,
  profile: DeviceProfile,
): number {
  if (block.block === 'Cab') {
    throw new Error('Cab type is not swappable (uses DynaCab bank/id indices)');
  }
  const loc = profile.typeLocations[block.block];
  if (!loc) {
    throw new Error(`No type-location rule for block "${block.block}" on ${profile.name}`);
  }
  const ch = CHANNEL_LETTERS.indexOf(channel.toUpperCase() as (typeof CHANNEL_LETTERS)[number]);
  if (ch < 0) throw new Error(`Invalid channel "${channel}" (expected A/B/C/D)`);
  const [kind, off] = loc;

  if (kind === 'header') {
    // Per-channel header-type blocks (rows>=4, cols>6): channel A at header
    // word 17; channels B/C/D at the PREVIOUS channel's param word (cols-6).
    if (block.rows >= 4 && block.cols > 6) {
      if (ch === 0) return block.offset + 17 * 2;
      return block.params_offset + (ch - 1) * block.cols * 2 + (block.cols - 6) * 2;
    }
    return block.offset + off * 2; // shared across channels
  }
  // param-located
  if (block.block === 'Amp' || block.rows >= 4) {
    return block.params_offset + ch * block.cols * 2 + off * 2;
  }
  return block.params_offset + off * 2; // shared across channels
}

// Grid effect-id -> block family base. Instances 1..4 are base..base+3.
const EFFECT_BASES: Record<number, string> = {
  37: 'Input', 42: 'Output', 46: 'Comp', 50: 'GEQ', 54: 'PEQ', 58: 'Amp',
  62: 'Cab', 66: 'Reverb', 70: 'Delay', 74: 'MultiTap', 78: 'Chorus',
  82: 'Flanger', 86: 'Rotary', 90: 'Phaser', 94: 'Wah', 98: 'Formant',
  102: 'Vol/Pan', 106: 'Tremolo', 110: 'Pitch', 114: 'Filter', 118: 'Drive',
  122: 'Enhancer', 126: 'Mixer', 130: 'Synth', 138: 'Megatap', 146: 'Gate',
  150: 'RingMod', 154: 'MultiComp', 158: 'Ten-Tap', 162: 'Resonator',
  166: 'Looper', 178: 'Plex Delay', 182: 'Send', 186: 'Return', 191: 'Multiplexer',
};

/**
 * Resolve a gen-3 effect ID to its display name + instance (e.g. 58 → "Amp 1",
 * 119 → "Drive 2"). Exported so the LIVE grid reader (sub=0x2E) labels cells
 * with the SAME convention as the stored-dump grid decode.
 */
export function effectName(eid: number): string | undefined {
  if (eid in EFFECT_BASES) return `${EFFECT_BASES[eid]} 1`;
  for (const [baseStr, name] of Object.entries(EFFECT_BASES)) {
    const base = Number(baseStr);
    const d = eid - base;
    if (d > 0 && d <= 3) return `${name} ${d + 1}`;
  }
  return undefined;
}

const MODIFIER_SOURCE_NAMES: Record<number, string> = {
  1: 'LFO 1A', 2: 'LFO 1B', 3: 'LFO 2A', 4: 'LFO 2B', 5: 'ADSR 1', 6: 'ADSR 2',
  7: 'Sequencer', 8: 'Envelope Follower', 9: 'Pitch Follower', 10: 'Pedal 1',
  14: 'External 1', 15: 'External 2', 16: 'External 3', 17: 'External 4',
  18: 'External 5', 30: 'Scene Controller 1', 31: 'Scene Controller 2',
  32: 'Scene Controller 3', 33: 'Scene Controller 4', 34: 'FC Pedal 1',
  35: 'FC Pedal 2', 50: 'Control Switch 1', 51: 'Control Switch 2',
  56: 'Manual 1', 57: 'Manual 2', 58: 'Manual 3', 59: 'Manual 4', 60: 'Manual 5',
};

const CAB_BANK_NAMES: Record<number, string> = { 0: 'FACTORY 1', 1: 'FACTORY 2', 3: 'LEGACY' };
const CAB_MODE_NAMES: Record<number, string> = { 0: 'LEGACY', 1: 'DYNA-CAB' };
const CAB_MIC_NAMES: Record<number, string> = { 0: 'Condenser', 1: 'Ribbon', 2: 'Dynamic 1', 3: 'Dynamic 2' };

// ── low-level reads ───────────────────────────────────────────────────
function u16(data: Uint8Array, off: number): number {
  return ((data[off] ?? 0) | ((data[off + 1] ?? 0) << 8)) & 0xffff;
}
/** wire 0..65535 -> 0..10 knob, 2 decimals (reference _scale_param). */
function scale10(raw: number): number {
  return Math.round((raw / 65535) * 1000) / 100;
}
// TYPE_BINARY_IDS (BoodieTraps-sourced) has real gaps — e.g. Amp is missing
// ordinal 132 "FAS Modern II", confirmed against a live FM9 front panel
// (issue #16). GEN3_READ_ROSTERS is the live read/set roster: for these same
// families it is a UNION of the BoodieTraps table with our own device-true
// FM9-Edit cache rosters (amp/drive/reverb) or wiki gap-fill (comp/wah),
// verified byte-identical to TYPE_BINARY_IDS on every ordinal both carry — so
// falling back to it only ever FILLS a gap, never overrides an existing name.
const TYPE_BINARY_FALLBACK_ROSTER: Readonly<Record<string, keyof typeof GEN3_READ_ROSTERS>> = {
  Amp: 'DISTORT_TYPE',
  Chorus: 'CHORUS_TYPE',
  Comp: 'COMP_TYPE',
  Delay: 'DELAY_TYPE',
  Drive: 'FUZZ_TYPE',
  Filter: 'FILTER_TYPE',
  Flanger: 'FLANGER_TYPE',
  Phaser: 'PHASER_TYPE',
  Reverb: 'REVERB_TYPE',
  Tremolo: 'TREMOLO_TYPE',
  Wah: 'WAH_TYPE',
};

/** Exported for the issue #16 regression golden (verify-gen3-preset-body.ts) — otherwise internal to decodeGen3Body. */
export function typeName(block: string, id: number): string | undefined {
  const name = TYPE_BINARY_IDS[block]?.[id];
  if (name) return name;
  const fallbackKey = TYPE_BINARY_FALLBACK_ROSTER[block];
  return fallbackKey ? GEN3_READ_ROSTERS[fallbackKey]?.[id] : undefined;
}

// ── public output shapes ──────────────────────────────────────────────
export interface Gen3GridCell {
  effect_id: number;
  row: number;
  col: number;
  route_flag: number;
  name: string;
  from_rows?: number[];
  is_shunt?: boolean;
}
export interface Gen3BlockChannel {
  type_id?: number;
  type?: string;
  /** Amp-only per-channel knobs (0..10), present on FM3/FM9 amp blocks. */
  [knob: string]: number | string | undefined;
}
export interface Gen3Block {
  block: string;
  cols: number;
  rows: number;
  /** Byte offset of the block header inside the decompressed body. */
  offset: number;
  /** Byte offset of the per-channel param array (offset + 23 words). */
  params_offset: number;
  /** Per-scene (8) channel letter, header words [-1,0..6]. */
  scene_channels?: string[];
  /** Per-scene (8) bypass state, header words [7..14]. */
  scene_bypass?: boolean[];
  type_id?: number;
  type?: string;
  bank1?: string;
  cab1?: number;
  bank2?: string;
  cab2?: number;
  channels?: Record<string, Gen3BlockChannel>;
}
export interface Gen3Modifier {
  source: string;
  target: string;
  param: number;
  origin: 'pre-chain' | 'chain';
}
export interface Gen3SceneController {
  controller: string;
  values: number[];
  raw: number[];
}
export interface Gen3PresetBody {
  scene_names?: string[];
  grid?: Gen3GridCell[];
  blocks?: Gen3Block[];
  /** Convenience: the first Amp block's per-channel map. */
  amp1?: Record<string, Gen3BlockChannel>;
  modifiers?: Gen3Modifier[];
  scene_controllers?: Gen3SceneController[];
}

const CHANNEL_LETTERS = ['A', 'B', 'C', 'D'] as const;

// ── grid (column-major, 2 words/cell: effect id + routing flag) ────────
const GRID_BASE = 0x104;
function parseGrid(data: Uint8Array, rows: number, cols: number): Gen3GridCell[] {
  const wordsPerCol = rows * 2;
  const out: Gen3GridCell[] = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const idx = col * wordsPerCol + row * 2; // word index within the grid table
      const eid = u16(data, GRID_BASE + idx * 2);
      const flag = u16(data, GRID_BASE + (idx + 1) * 2);
      if (eid === 0) continue;
      const cell: Gen3GridCell = { effect_id: eid, row, col, route_flag: flag, name: '' };
      if (eid > 1000) {
        cell.name = `Shunt ${eid - 1023}`;
        cell.is_shunt = true;
      } else {
        cell.name = effectName(eid) ?? `eid_${eid}`;
      }
      const fromRows: number[] = [];
      for (let r = 0; r < rows; r++) if (flag & (1 << r)) fromRows.push(r);
      if (fromRows.length) cell.from_rows = fromRows;
      out.push(cell);
    }
  }
  return out;
}

// ── block-chain start: first of two consecutive 25x1 modifier blocks ───
function findBlockChainStart(data: Uint8Array): number {
  const size = (BLOCK_HEADER_WORDS + 25) * 2;
  for (let off = 0x200; off < data.length - 70; off += 2) {
    if (u16(data, off + 30) !== 25 || u16(data, off + 32) !== 1) continue;
    const next = off + size;
    if (next + 34 <= data.length && u16(data, next + 30) === 25 && u16(data, next + 32) === 1) {
      return off;
    }
  }
  return -1;
}

// cols=37 disambiguation: MultiComp / Filter / Comp (reference _classify_cols37)
function classifyCols37(data: Uint8Array, paramsStart: number): string {
  if (u16(data, paramsStart) >= 32767) return 'MultiComp';
  if (u16(data, paramsStart + 4 * 2) >= 100) return 'Filter';
  return 'Comp';
}
// cols=33 disambiguation: Flanger vs a system block (reference _classify_cols33)
function classifyCols33(data: Uint8Array, pos: number): string | undefined {
  return u16(data, pos + 17 * 2) <= 28 ? 'Flanger' : undefined;
}

function walkBlocks(data: Uint8Array, chainStart: number, profile: DeviceProfile): Gen3Block[] {
  const { blockColsMap, typeLocations } = profile;
  const results: Gen3Block[] = [];
  let pos = chainStart;
  while (pos + BLOCK_HEADER_WORDS * 2 + 2 <= data.length) {
    const cols = u16(data, pos + 30); // header word 15
    const rows = u16(data, pos + 32); // header word 16
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    const size = (BLOCK_HEADER_WORDS + cols * rows) * 2;
    if (cols === 25 && rows === 1) { pos += size; continue; } // modifier slot

    let blockName = blockColsMap[cols];
    if (!blockName) { pos += size; continue; }

    const paramsStart = pos + BLOCK_HEADER_WORDS * 2;

    if (blockName === 'Comp' && cols === 37 && rows === 4) blockName = classifyCols37(data, paramsStart);
    if (blockName === 'Flanger' && cols === 33 && rows === 4) {
      const c = classifyCols33(data, pos);
      if (c === undefined) { pos += size; continue; }
      blockName = c;
    }

    const block: Gen3Block = { block: blockName, cols, rows, offset: pos, params_offset: paramsStart };

    // Per-scene channel + bypass: header words [-1,0..6] = channel, [7..14] = bypass.
    if (pos >= 2) {
      const sceneCh: number[] = [u16(data, pos - 2)];
      for (let i = 0; i < 7; i++) sceneCh.push(u16(data, pos + i * 2));
      const sceneByp: number[] = [];
      for (let i = 0; i < 8; i++) sceneByp.push(u16(data, pos + (7 + i) * 2));
      block.scene_channels = sceneCh.map((v) => (v < 4 ? CHANNEL_LETTERS[v] : `ch_${v}`));
      block.scene_bypass = sceneByp.map((v) => Boolean(v));
    }

    // NOTE: the reference decoder reads an amp "level" (dB) at header word 18 via
    // raw*100/65535-80. We deliberately DO NOT surface it: across the 128 III
    // factory presets that word yields a median of -30 dB (only 2% near 0 dB),
    // which is implausible for an amp output-level trim (near-0 by default). The
    // word-18 interpretation is unverified against device ground truth and almost
    // certainly mislabeled, so omitting it beats shipping a confident wrong dB.
    // Re-introduce only with a front-panel / get_param oracle confirming the field.

    if (blockName === 'Cab') {
      const bank1 = u16(data, pos + 17 * 2);
      const bank2 = u16(data, pos + 18 * 2);
      const cab1 = u16(data, pos + 21 * 2);
      const cab2 = u16(data, pos + 22 * 2);
      block.bank1 = CAB_BANK_NAMES[bank1] ?? `bank_${bank1}`;
      block.cab1 = cab1;
      if (cab2) { block.bank2 = CAB_BANK_NAMES[bank2] ?? `bank_${bank2}`; block.cab2 = cab2; }
      const dynaIds = TYPE_BINARY_IDS.DynaCab ?? {};
      const channels: Record<string, Gen3BlockChannel> = {};
      for (let ch = 0; ch < 4; ch++) {
        const base = paramsStart + ch * cols * 2;
        const modeId = u16(data, base + 25 * 2);
        const c: Gen3BlockChannel = { mode: CAB_MODE_NAMES[modeId] ?? `mode_${modeId}` };
        if (modeId === 1) {
          const dc1 = u16(data, base + 79 * 2);
          c.dynacab1_id = dc1;
          if (dynaIds[dc1]) c.dynacab1 = dynaIds[dc1];
          const dc2 = u16(data, base + 80 * 2);
          if (dynaIds[dc2]) c.dynacab2 = dynaIds[dc2];
          const mic = u16(data, base + 83 * 2);
          c.mic = CAB_MIC_NAMES[mic] ?? `mic_${mic}`;
        }
        channels[CHANNEL_LETTERS[ch]] = c;
      }
      block.channels = channels;
    } else if (blockName in typeLocations) {
      const [locKind, locOffset] = typeLocations[blockName];
      if (locKind === 'header') {
        const typeId = u16(data, pos + locOffset * 2);
        block.type_id = typeId;
        const tn = typeName(blockName, typeId);
        if (tn) block.type = tn;
        if (rows >= 4 && cols > 6) {
          // Per-channel header-type: channel ch's type id lives at the PREVIOUS
          // channel's param word (cols-6); channel A uses the header type id.
          const nextChTypeIdx = cols - 6;
          const channels: Record<string, Gen3BlockChannel> = {};
          for (let ch = 0; ch < 4; ch++) {
            let tid: number;
            if (ch === 0) tid = typeId;
            else { const prevBase = paramsStart + (ch - 1) * cols * 2; tid = u16(data, prevBase + nextChTypeIdx * 2); }
            const c: Gen3BlockChannel = { type_id: tid };
            const n = typeName(blockName, tid);
            if (n) c.type = n;
            channels[CHANNEL_LETTERS[ch]] = c;
          }
          block.channels = channels;
        }
      } else if (blockName === 'Amp') {
        // Param-located amp (FM3/FM9): per-channel type + knobs by name.
        const shift = locOffset * 2; // byte shift to the channel's type word
        const channels: Record<string, Gen3BlockChannel> = {};
        for (let ch = 0; ch < 4; ch++) {
          const base = paramsStart + ch * cols * 2;
          const tid = u16(data, base + shift + AMP_PARAM_OFFSETS.type);
          const c: Gen3BlockChannel = { type_id: tid };
          const n = typeName('Amp', tid);
          if (n) c.type = n;
          for (const [param, off] of Object.entries(AMP_PARAM_OFFSETS)) {
            if (param === 'type') continue;
            c[param] = scale10(u16(data, base + shift + off));
          }
          channels[CHANNEL_LETTERS[ch]] = c;
        }
        block.channels = channels;
      } else if (rows >= 4) {
        // Param-located per-channel type (non-amp).
        const channels: Record<string, Gen3BlockChannel> = {};
        for (let ch = 0; ch < 4; ch++) {
          const base = paramsStart + ch * cols * 2;
          const tid = u16(data, base + locOffset * 2);
          const c: Gen3BlockChannel = { type_id: tid };
          const n = typeName(blockName, tid);
          if (n) c.type = n;
          channels[CHANNEL_LETTERS[ch]] = c;
        }
        block.channels = channels;
      } else {
        const typeId = u16(data, paramsStart + locOffset * 2);
        block.type_id = typeId;
        const tn = typeName(blockName, typeId);
        if (tn) block.type = tn;
      }
    }

    results.push(block);
    pos += size;
  }
  return results;
}

// ── modifiers ─────────────────────────────────────────────────────────
const MODIFIER_PRE_CHAIN_START = 0x240;
const MODIFIER_FIRST_WORD = 502;
const MODIFIER_ENTRY_SIZE = 48;
const MODIFIER_MAX_ENTRIES = 12;

function extractPreChainModifiers(data: Uint8Array): Gen3Modifier[] {
  const out: Gen3Modifier[] = [];
  for (let i = 0; i < MODIFIER_MAX_ENTRIES; i++) {
    const wordStart = MODIFIER_FIRST_WORD + i * MODIFIER_ENTRY_SIZE;
    const abs = MODIFIER_PRE_CHAIN_START + wordStart * 2;
    if (abs + 12 * 2 > data.length) break;
    if (u16(data, abs) !== 25) break; // marker
    const sourceId = u16(data, abs + 2 * 2);
    const targetEid = u16(data, abs + 10 * 2);
    const paramNum = u16(data, abs + 11 * 2);
    if (targetEid === 0 && paramNum === 0 && sourceId === 0) continue;
    out.push({
      source: MODIFIER_SOURCE_NAMES[sourceId] ?? `source_${sourceId}`,
      target: effectName(targetEid) ?? `eid_${targetEid}`,
      param: paramNum,
      origin: 'pre-chain',
    });
  }
  return out;
}

function extractChainModifiers(data: Uint8Array, chainStart: number): Gen3Modifier[] {
  const out: Gen3Modifier[] = [];
  let pos = chainStart;
  while (pos + BLOCK_HEADER_WORDS * 2 + 2 <= data.length) {
    const cols = u16(data, pos + 30);
    const rows = u16(data, pos + 32);
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    const size = (BLOCK_HEADER_WORDS + cols * rows) * 2;
    if (cols === 25 && rows === 1) {
      const paramsStart = pos + BLOCK_HEADER_WORDS * 2;
      const targetEid = u16(data, paramsStart + 2 * 2);
      if (targetEid !== 0) {
        const sourceId = u16(data, pos + 17 * 2);
        out.push({
          source: MODIFIER_SOURCE_NAMES[sourceId] ?? `source_${sourceId}`,
          target: effectName(targetEid) ?? `eid_${targetEid}`,
          param: u16(data, paramsStart + 3 * 2),
          origin: 'chain',
        });
      }
    }
    pos += size;
  }
  return out;
}

// ── scene controllers: pre-chain block 0, 4 controllers x 8 scenes ─────
const SCENE_CTRL_BLOCK_START = 0x240;
const SCENE_CTRL_VALUE_OFFSET = 42;
function extractSceneControllers(data: Uint8Array): Gen3SceneController[] {
  const out: Gen3SceneController[] = [];
  for (let sc = 0; sc < 4; sc++) {
    const off = SCENE_CTRL_BLOCK_START + (SCENE_CTRL_VALUE_OFFSET + sc * 8) * 2;
    if (off + 16 > data.length) break;
    const raw: number[] = [];
    for (let i = 0; i < 8; i++) raw.push(u16(data, off + i * 2));
    if (raw.some((v) => v !== 0)) {
      out.push({
        controller: `Scene Controller ${sc + 1}`,
        values: raw.map((v) => Math.round((v / 65535) * 1000) / 10),
        raw,
      });
    }
  }
  return out;
}

function asciiName(data: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = data[start + i] ?? 0;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.trim();
}

/**
 * Decode a gen-3 decompressed patch body into a structured snapshot. `body` is
 * `decodeRawPatch(...).body`; `modelId` is the SysEx model byte (0x10/0x11/0x12).
 */
export function decodeGen3Body(body: Uint8Array, modelId: number): Gen3PresetBody {
  const profile = getProfile(modelId);
  const out: Gen3PresetBody = {};

  // Scene names: 8 x 32-byte ASCII starting at body offset 4.
  if (body.length >= 0x104) {
    const scenes: string[] = [];
    for (let i = 0; i < 8; i++) scenes.push(asciiName(body, 4 + i * 32, 32));
    out.scene_names = scenes;
  }

  if (body.length >= 0x1c4) out.grid = parseGrid(body, profile.gridRows, profile.gridCols);

  const chainStart = findBlockChainStart(body);
  if (chainStart >= 0) {
    out.blocks = walkBlocks(body, chainStart, profile);
    const amp = out.blocks.find((b) => b.block === 'Amp');
    if (amp?.channels) out.amp1 = amp.channels;
  }

  // Merge pre-chain + chain modifiers, de-duping on (target, param).
  const pre = extractPreChainModifiers(body);
  const chain = chainStart >= 0 ? extractChainModifiers(body, chainStart) : [];
  const seen = new Set(pre.map((m) => `${m.target} ${m.param}`));
  const merged = [...pre];
  for (const m of chain) {
    const key = `${m.target} ${m.param}`;
    if (!seen.has(key)) { merged.push(m); seen.add(key); }
  }
  if (merged.length) out.modifiers = merged;

  if (body.length >= SCENE_CTRL_BLOCK_START + SCENE_CTRL_VALUE_OFFSET * 2 + 64) {
    const sc = extractSceneControllers(body);
    if (sc.length) out.scene_controllers = sc;
  }

  return out;
}

export function modelName(modelId: number): string {
  return MODEL_NAMES[modelId] ?? `model_0x${modelId.toString(16)}`;
}

/** A fully-decoded gen-3 preset: dump framing + raw-patch CRC status + the
 *  structured body. */
export interface Gen3DecodedPreset extends Gen3PresetBody {
  model_id: number;
  model_name: string;
  /** ASCII preset name from the raw_patch header (offset 0x08), NOT the body. */
  preset_name: string;
  /** True when the stored CRC matches the recomputed CRC (device-validity gate). */
  crc_valid: boolean;
  decompressed_size: number;
}

/** Preset name lives in the uncompressed raw_patch header at 0x08..0x28. */
function rawPatchName(rawPatch: Uint8Array): string {
  return asciiName(rawPatch, 0x08, 32);
}

/**
 * Full gen-3 preset decode: parse the 0x77/0x78/0x79 dump, unpack + decompress
 * the raw patch (CRC-checked), and decode the body into structured params. Pass
 * the dump bytes (an exported `.syx` or a stored-preset dump) and optionally the
 * expected model byte. Throws if the dump framing is invalid; a CRC mismatch is
 * reported via `crc_valid` (the body is still decoded best-effort).
 */
export function decodeGen3PresetDump(bytes: Uint8Array, expectedModelId?: number): Gen3DecodedPreset {
  const parsed = parsePresetDump(bytes, 0, expectedModelId);
  const decoded = decodeRawPatch(parsed.chunkPayloads);
  const body = decodeGen3Body(decoded.body, parsed.modelId);
  return {
    model_id: parsed.modelId,
    model_name: modelName(parsed.modelId),
    preset_name: rawPatchName(decoded.rawPatch),
    crc_valid: decoded.crcValid,
    decompressed_size: decoded.decompSize,
    ...body,
  };
}
