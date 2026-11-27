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
 *
 * DELIBERATE DIVERGENCE (2026-11-25): modifiers and scene-controller values
 * are decoded in presetModifiers.ts and no longer match the reference
 * decoder, which reports freed (source NONE) modifier slots as live and reads
 * scene controllers from a window that holds LFO parameters on the III. The
 * evidence for the corrected layout is in that module; the gate checks it
 * against the reference by explaining every difference.
 */

import { TYPE_BINARY_IDS } from './gen3BodyTables.js';
import { decodeRawPatch } from './presetHuffman.js';
import { parsePresetDump } from './presetDump.js';
import { GEN3_READ_ROSTERS } from 'fractal-midi/gen3/axe-fx-iii';
import { effectFamily, effectName, UNNAMED_202 } from './presetEffectIds.js';
import {
  extractModifiers,
  extractSceneControllers,
  findRecordWalkStart,
  RECORD_SIGNATURE_GAP,
} from './presetModifiers.js';
import type { Gen3Modifier, Gen3SceneController } from './presetModifiers.js';

export { effectName };
export type { Gen3Modifier, Gen3SceneController };

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
  // Rotary is deliberately absent: the block has no Type, and header word 17
  // holds a knob value there (it read back as "type_id 42597").
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

/**
 * The order the unit writes a preset's blocks into the stored block chain.
 *
 * The chain carries no effect id, only each block's parameter-table size, and
 * that size changes with firmware (an Axe-Fx III Delay is 88 columns on one
 * firmware and something else on the next), so a size-to-name table mislabels
 * or drops blocks as firmware moves. What does not move is the ORDER: the chain
 * holds exactly the blocks placed on the grid, one entry each, in this fixed
 * family order (instances ascending inside a family), followed by one system
 * block. The grid does carry effect ids, so pairing the two names every block.
 *
 * Evidence: all 384 Axe-Fx III factory presets pair this way with no
 * exception (entry count = grid blocks + 1 in every one, and every family
 * lands on a single table size), and an FM9 export and an FM3 capture pair
 * the same way. Pairs of families that never share a factory preset are in
 * `CHAIN_ORDER_UNSETTLED`: their relative order here is unproven.
 */
const CHAIN_ORDER: readonly string[] = [
  'Amp', 'Cab', 'Chorus', 'Comp', 'Crossover', 'Delay', 'Enhancer', 'Return', 'Send',
  'Filter', 'Flanger', 'Formant', 'Drive', 'Gate', 'GEQ', 'MultiTap', 'Input', 'Megatap',
  'Mixer', 'Multiplexer', 'MultiComp', 'Output', 'PEQ', 'Pitch', 'Phaser', 'Plex Delay',
  'Reverb', 'RingMod', 'Rotary', 'Synth', 'Ten-Tap', 'Tremolo', 'Resonator', 'Vol/Pan',
  'Wah', 'Tone Match', 'RTA', 'Looper', UNNAMED_202,
];

/** Family pairs whose relative chain order no preset on hand settles. */
const CHAIN_ORDER_UNSETTLED: ReadonlyArray<readonly [string, string]> = [
  ['Megatap', 'Mixer'], ['Megatap', 'Multiplexer'], ['Megatap', 'MultiComp'], ['Mixer', 'Multiplexer'],
  ['Mixer', 'MultiComp'], ['Phaser', 'Resonator'], ['Plex Delay', 'Resonator'], ['Reverb', 'Resonator'],
  ['RingMod', 'Ten-Tap'], ['RingMod', 'Resonator'], ['RingMod', UNNAMED_202], ['Rotary', 'Ten-Tap'],
  ['Rotary', 'Resonator'], ['Rotary', UNNAMED_202], ['Synth', 'Ten-Tap'], ['Synth', 'Resonator'],
  ['Synth', UNNAMED_202], ['Ten-Tap', 'Resonator'], ['Ten-Tap', UNNAMED_202], ['Tremolo', 'Resonator'],
  ['Tremolo', UNNAMED_202], ['Resonator', UNNAMED_202], ['Vol/Pan', UNNAMED_202], ['Wah', UNNAMED_202],
  ['Tone Match', 'RTA'], ['Tone Match', UNNAMED_202], ['RTA', 'Looper'], ['RTA', UNNAMED_202],
  ['Looper', UNNAMED_202],
];

const CAB_BANK_NAMES: Record<number, string> = { 0: 'FACTORY 1', 1: 'FACTORY 2', 3: 'LEGACY' };
const CAB_MODE_NAMES: Record<number, string> = { 0: 'LEGACY', 1: 'DYNA-CAB' };
const CAB_MIC_NAMES: Record<number, string> = { 0: 'Condenser', 1: 'Ribbon', 2: 'Dynamic 1', 3: 'Dynamic 2' };

/** FM3 fw 13 hardware-capture anchor for CABINET_PROXFREQ (live paramId 41).
 * In the stored-preset Cab channel array it is word/index 35, a u16 LE value
 * normalized logarithmically across 20..200 Hz. This stored-body index is a
 * SEPARATE decode from the live SET/GET paramId — it has no evidence of its
 * own on the live wire path (params.ts deliberately does not calibrate
 * paramId 41 from this). Evidence: 100 Hz -> 45806, 120 Hz -> 50995
 * (samples/captured/proximity-frequency-{100,120}hz.syx). */
export const FM3_CAB_PROXIMITY_FREQUENCY_PARAM_ID = 41;
export const FM3_CAB_PROXIMITY_FREQUENCY_BODY_INDEX = 35;

export function fm3CabProximityFrequencyFieldByteOffset(
  block: Gen3Block,
  channel: string,
): number {
  if (block.block !== 'Cab' || block.cols !== 106 || block.rows !== 4) {
    throw new Error('Proximity Frequency stored-body offset is validated only for an FM3 106x4 Cab block');
  }
  const ch = CHANNEL_LETTERS.indexOf(channel.toUpperCase() as (typeof CHANNEL_LETTERS)[number]);
  if (ch < 0) throw new Error(`Invalid channel "${channel}" (expected A/B/C/D)`);
  return block.params_offset + ch * block.cols * 2 + FM3_CAB_PROXIMITY_FREQUENCY_BODY_INDEX * 2;
}

function decodeFm3CabProximityFrequency(raw: number): number {
  return Math.round(20 * Math.pow(10, raw / 65534));
}

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
  Delay: 'DELAY_MODEL',
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
  /** 1-based instance within the family, and the grid effect id. Set when the block was named from the grid. */
  instance?: number;
  effect_id?: number;
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
export interface Gen3PresetBody {
  scene_names?: string[];
  grid?: Gen3GridCell[];
  blocks?: Gen3Block[];
  /**
   * How `blocks` were named. 'grid': named from the grid's effect ids, by each
   * chain record's own effect-id signature (or, failing that, by pairing with
   * the fixed chain order), so every placed block is present and correctly
   * named whatever the firmware. An empty grid is 'grid' with no blocks.
   * 'table-size': neither held and blocks were named by parameter-table size,
   * which can miss or mislabel blocks.
   */
  blocks_identified_by?: 'grid' | 'table-size';
  /** Family pairs present whose relative order is unproven; their two entries may be swapped. */
  block_order_unsettled?: string[];
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

interface ChainEntry { pos: number; cols: number; rows: number }

/** Every non-modifier entry of the block chain, in stored order. */
function chainEntries(data: Uint8Array, chainStart: number): ChainEntry[] {
  const out: ChainEntry[] = [];
  let pos = chainStart;
  while (pos + BLOCK_HEADER_WORDS * 2 + 2 <= data.length) {
    const cols = u16(data, pos + 30); // header word 15
    const rows = u16(data, pos + 32); // header word 16
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    if (!(cols === 25 && rows === 1)) out.push({ pos, cols, rows }); // 25x1 = modifier slot
    pos += (BLOCK_HEADER_WORDS + cols * rows) * 2;
  }
  return out;
}

interface GridLabel { family: string; instance: number; effectId: number }

/**
 * Name the chain entries from the grid (see CHAIN_ORDER). Returns undefined
 * when the pairing does not hold: a grid block of a family with no known
 * place in the order, or an entry count that is not the grid's block count
 * (plus the one trailing system block). The caller then falls back to naming
 * by table size.
 */
function labelsFromGrid(entries: readonly ChainEntry[], grid: readonly Gen3GridCell[] | undefined): GridLabel[] | undefined {
  if (!grid) return undefined;
  const ids = [...new Set(grid.filter((c) => !c.is_shunt).map((c) => c.effect_id))];
  if (ids.length === 0) return undefined;
  const labels: GridLabel[] = [];
  for (const effectId of ids) {
    const f = effectFamily(effectId);
    if (!f || !CHAIN_ORDER.includes(f.family)) return undefined;
    labels.push({ ...f, effectId });
  }
  if (entries.length !== labels.length + 1 && entries.length !== labels.length) return undefined;
  return labels.sort((a, b) => CHAIN_ORDER.indexOf(a.family) - CHAIN_ORDER.indexOf(b.family) || a.effectId - b.effectId);
}

/**
 * Name the chain entries by each record's own effect-id SIGNATURE: the u16
 * twelve bytes before the record header (RECORD_SIGNATURE_GAP), gated to the
 * effect ids the grid places. Returns one label per entry (undefined for an
 * entry whose signature is not a placed block, i.e. the trailing system
 * record), or undefined when the signatures do not name every placed block
 * exactly once (the caller then falls back to the chain-order pairing).
 *
 * Evidence: on all 414 non-empty bodies on disk (384 III factory presets, FM9
 * / FM3 exports and captures, the fractone / forgefx-midi fixtures) the
 * signature agrees with the chain-order pairing on every one of 4,973 blocks,
 * each placed block has exactly one signed record, and exactly one record per
 * body carries a non-placed signature. Unlike the pairing it needs no family
 * order, so it also settles the CHAIN_ORDER_UNSETTLED pairs. Same rule as
 * forgefx-midi (Apache-2.0) commit ee48f18; fractone reads Amp records the
 * same way (Fm9PresetWriteVerifier.AmpRecords).
 */
function labelsFromSignatures(
  data: Uint8Array,
  entries: readonly ChainEntry[],
  grid: readonly Gen3GridCell[] | undefined,
): (GridLabel | undefined)[] | undefined {
  if (!grid) return undefined;
  const placed = new Set(grid.filter((c) => !c.is_shunt).map((c) => c.effect_id));
  const seen = new Set<number>();
  const out: (GridLabel | undefined)[] = [];
  for (const { pos } of entries) {
    const sig = pos >= RECORD_SIGNATURE_GAP ? u16(data, pos - RECORD_SIGNATURE_GAP) : 0;
    const f = placed.has(sig) ? effectFamily(sig) : undefined;
    if (!f || seen.has(sig)) { out.push(undefined); continue; }
    seen.add(sig);
    out.push({ ...f, effectId: sig });
  }
  return seen.size === placed.size ? out : undefined;
}

function walkBlocks(
  data: Uint8Array,
  chainStart: number,
  profile: DeviceProfile,
  grid?: readonly Gen3GridCell[],
): { blocks: Gen3Block[]; identifiedBy: 'grid' | 'table-size'; unsettled: string[] } {
  const { blockColsMap, typeLocations } = profile;
  const results: Gen3Block[] = [];
  const entries = chainEntries(data, chainStart);
  const unsettled: string[] = [];
  let labels = labelsFromSignatures(data, entries, grid);
  if (!labels) {
    const ordered = labelsFromGrid(entries, grid);
    if (ordered) {
      labels = entries.map((_, i) => ordered[i]);
      const present = new Set(ordered.map((l) => l.family));
      for (const [a, b] of CHAIN_ORDER_UNSETTLED) if (present.has(a) && present.has(b)) unsettled.push(`${a} / ${b}`);
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const { pos, cols, rows } = entries[i];
    const paramsStart = pos + BLOCK_HEADER_WORDS * 2;
    let blockName: string | undefined;
    const label = labels?.[i];
    if (labels) {
      if (!label) continue; // the trailing system block
      blockName = label.family;
    } else {
      blockName = blockColsMap[cols];
      if (!blockName) continue;
      if (blockName === 'Comp' && cols === 37 && rows === 4) blockName = classifyCols37(data, paramsStart);
      if (blockName === 'Flanger' && cols === 33 && rows === 4) {
        const c = classifyCols33(data, pos);
        if (c === undefined) continue;
        blockName = c;
      }
    }

    const block: Gen3Block = { block: blockName, cols, rows, offset: pos, params_offset: paramsStart };
    if (label) { block.instance = label.instance; block.effect_id = label.effectId; }

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
        // Hardware-validated only on the FM3's 106x4 Cab body layout (two real
        // captures, 100/120 Hz). Keep the evidence scoped instead of assuming
        // sibling-device (III/FM9) body indices match.
        if (profile === DEVICE_PROFILES[MODEL_FM3] && cols === 106 && rows === 4) {
          const proxRaw = u16(data, base + FM3_CAB_PROXIMITY_FREQUENCY_BODY_INDEX * 2);
          c.proximity_frequency_hz = decodeFm3CabProximityFrequency(proxRaw);
        }
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
  }
  return { blocks: results, identifiedBy: labels ? 'grid' : 'table-size', unsettled };
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

  // The record walk starts with the modifier table (25x1 records), then the
  // block chain; chainEntries skips the 25x1 records.
  const chainStart = findRecordWalkStart(body);
  if (chainStart >= 0) {
    const walked = walkBlocks(body, chainStart, profile, out.grid);
    out.blocks = walked.blocks;
    out.blocks_identified_by = walked.identifiedBy;
    if (walked.unsettled.length) out.block_order_unsettled = walked.unsettled;
    const amp = out.blocks.find((b) => b.block === 'Amp');
    if (amp?.channels) out.amp1 = amp.channels;
  }

  // Modifiers in use (source != NONE, target resolves) and scene-controller
  // values: presetModifiers.ts carries the layout and its evidence.
  const placed = out.grid ? new Set(out.grid.filter((c) => !c.is_shunt).map((c) => c.effect_id)) : undefined;
  const modifiers = chainStart >= 0 ? extractModifiers(body, modelId, chainStart, placed) : [];
  if (modifiers.length) out.modifiers = modifiers;

  const sc = extractSceneControllers(body, modelId);
  if (sc.length) out.scene_controllers = sc;

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
/**
 * A stored-preset dump whose container holds no compressed body: an empty or
 * never-written preset location. Not a decode failure, so it has its own
 * class and the reader reports the location as empty.
 */
export class Gen3EmptyPresetError extends Error {
  constructor() {
    super('the dump holds no preset body (an empty location)');
    this.name = 'Gen3EmptyPresetError';
  }
}

export function decodeGen3PresetDump(bytes: Uint8Array, expectedModelId?: number): Gen3DecodedPreset {
  const parsed = parsePresetDump(bytes, 0, expectedModelId);
  const decoded = decodeRawPatch(parsed.chunkPayloads);
  if (decoded.empty) throw new Gen3EmptyPresetError();
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
