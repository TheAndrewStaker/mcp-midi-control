/**
 * Gen-3 stored-preset MODIFIER table and SCENE-CONTROLLER values, decoded from
 * the decompressed patch body (`decodeRawPatch(...).body`).
 *
 * ── Record word convention ────────────────────────────────────────────
 * Every record of the body's record walk opens with a 23-word header; header
 * word 15 = parameter columns, word 16 = rows. A record's parameter id `n`
 * (channel row 0) lives at record word `17 + n`, so params 0..5 sit inside the
 * "header" and the per-channel array that starts at word 23 continues from
 * id 6. This is the convention of both independent decoders consulted
 * (fractone Fm9ChannelParameterStorage FirstRowWord = 17; forgefx-midi's
 * Controllers window), and our own type-location table agrees with it on all
 * three devices: the amp TYPE is III id 0 (header word 17), FM3 id 6 (param
 * word 0), FM9 id 10 (param word 4), matching each device's DISTORT_TYPE
 * paramId in its own catalog.
 *
 * ── Modifiers ─────────────────────────────────────────────────────────
 * A preset holds its modifiers as the LEADING run of 25x1 records of the
 * record walk, one per modifier slot. Each slot is its own effect id 3..34
 * (FM3 catalog: ID_MODIFIER1 = 3, 32 slots), and that id is stored as the u16
 * twelve bytes before the record (the same "signature" word chain blocks carry
 * their grid effect id in). Slot fields, by param id: 0 = source, 8 = target
 * effect id, 9 = target param id (FM3 modifiers.ts pid 0 / 8 / 9).
 *
 * A slot whose SOURCE is 0 (NONE) is UNUSED. Freeing a modifier writes only
 * source = 0 and leaves the target words behind (fractone
 * Fm9PresetModifiers.Write), which is why the previous decode (target != 0)
 * reported "phantom" modifiers on `<EMPTY>` slots and on hundreds of factory
 * presets. A slot is reported only when its source is non-zero AND its target
 * resolves to a grid effect id.
 *
 * Evidence (offline, our decode of fixtures on disk): all 384 Axe-Fx III
 * factory presets carry exactly 32 such records with self-index 3..34
 * contiguous and no 25x1 record later in the walk; 268 of them held at least
 * one source-0 slot with stale target words. Every one of the 560 source !=
 * NONE slots across the III banks, an FM9 export, ten FM3 captures and the
 * fractone / forgefx-midi fixtures targets a block that is placed on that
 * preset's grid. An FM9 fw 11 export holds 30 records (ids 4 and 14 absent),
 * so the run is read by marker + self-index, never as a fixed 32. Corroborated
 * by fractone (MIT) Fm9PresetModifiers.cs (32 slots, NONE = unused) and
 * forgefx-midi (Apache-2.0) commit f916875 (32 x 96-byte entries at the walk
 * start, marker (25,1), self-index, target must resolve).
 *
 * SOURCE NAMES are device-true: each device's own MOD_CTRLID roster from its
 * editor cache (the three rosters differ: Scene Controller 1 is 28 on the
 * III, 30 on the FM3, 29 on the FM9). The previous single table was the FM3's
 * and misnamed III / FM9 sources.
 *
 * ── Scene controllers ─────────────────────────────────────────────────
 * The Controllers record sits at a fixed per-model body offset, guarded by its
 * own (cols, rows) header: (178, 4) on the III, (130, 4) on FM3 / FM9. Scene
 * controller n's value for scene s is CONTROLLERS param id 72 + (n-1)*8 +
 * (s-1) (CONTROLLERS_SCENE1_VAL1 = 72 .. SCENE4_VAL8 = 103 in all three of our
 * catalogs). Evidence: the guard header matches in every one of 411 bodies
 * decoded (III factory + FM3 / FM9 fixtures), and every scene controller that
 * a modifier actually uses (35 cases) has a non-trivial value row there. The
 * previous fixed window (body 0x240 + 84) read LFO parameters on the III.
 * Source: forgefx-midi commit f916875.
 * LIMITATION: values are read from the record's channel row 0 only; the
 * per-scene channel selector is not decoded.
 */
import { III_CACHE_ENUM_NAMES } from 'fractal-midi/gen3/axe-fx-iii';
import { FM3_CACHE_ENUM_NAMES } from 'fractal-midi/gen3/fm3';
import { FM9_CACHE_ENUM_NAMES } from 'fractal-midi/gen3/fm9';
import { effectName } from './presetEffectIds.js';

const MODEL_AXE_FX_III = 0x10;
const MODEL_FM3 = 0x11;
const MODEL_FM9 = 0x12;

const BLOCK_HEADER_WORDS = 23;
/** A record's param id n (channel row 0) is at record word 17 + n. */
const FIRST_PARAM_WORD = 17;
const MODIFIER_COLS = 25;
const MODIFIER_RECORD_BYTES = (BLOCK_HEADER_WORDS + MODIFIER_COLS) * 2; // 96
/** The u16 this many bytes before a record holds its effect id ("signature"). */
export const RECORD_SIGNATURE_GAP = 12;
export const FIRST_MODIFIER_EID = 3;
export const MAX_MODIFIER_SLOTS = 32;

const MOD_PARAM_SOURCE = 0;
const MOD_PARAM_TARGET_EID = 8;
const MOD_PARAM_TARGET_PARAM = 9;

export interface Gen3Modifier {
  source: string;
  target: string;
  param: number;
  /** Kept for the view contract: every stored modifier is in the table that
   *  precedes the block chain, so this is always 'pre-chain' now. */
  origin: 'pre-chain' | 'chain';
  /** 1-based modifier slot (effect id 3 = slot 1). */
  slot?: number;
}

export interface Gen3SceneController {
  controller: string;
  values: number[];
  raw: number[];
}

/** One raw modifier record, used or not. Exported for the regression gate. */
export interface Gen3ModifierSlotRecord {
  /** 1-based slot. */
  slot: number;
  /** The slot's own effect id (3..34). */
  effectId: number;
  /** Byte offset of the record header in the body. */
  offset: number;
  sourceId: number;
  targetEffectId: number;
  targetParam: number;
}

function u16(data: Uint8Array, off: number): number {
  return ((data[off] ?? 0) | ((data[off + 1] ?? 0) << 8)) & 0xffff;
}

function paramWord(data: Uint8Array, recordOffset: number, paramId: number): number {
  return u16(data, recordOffset + (FIRST_PARAM_WORD + paramId) * 2);
}

/**
 * Start of the body's record walk: the first of two consecutive 25x1 records
 * (the modifier table), searched from 0x200. -1 when absent.
 */
export function findRecordWalkStart(data: Uint8Array): number {
  for (let off = 0x200; off < data.length - 70; off += 2) {
    if (u16(data, off + 30) !== MODIFIER_COLS || u16(data, off + 32) !== 1) continue;
    const next = off + MODIFIER_RECORD_BYTES;
    if (next + 34 <= data.length && u16(data, next + 30) === MODIFIER_COLS && u16(data, next + 32) === 1) {
      return off;
    }
  }
  return -1;
}

/** Every modifier record of the leading 25x1 run (used and unused). */
export function readModifierSlots(data: Uint8Array, walkStart: number): Gen3ModifierSlotRecord[] {
  const out: Gen3ModifierSlotRecord[] = [];
  if (walkStart < 0) return out;
  let pos = walkStart;
  while (pos + MODIFIER_RECORD_BYTES <= data.length) {
    if (u16(data, pos + 30) !== MODIFIER_COLS || u16(data, pos + 32) !== 1) break;
    const effectId = pos >= RECORD_SIGNATURE_GAP ? u16(data, pos - RECORD_SIGNATURE_GAP) : 0;
    if (effectId >= FIRST_MODIFIER_EID && effectId < FIRST_MODIFIER_EID + MAX_MODIFIER_SLOTS) {
      out.push({
        slot: effectId - FIRST_MODIFIER_EID + 1,
        effectId,
        offset: pos,
        sourceId: paramWord(data, pos, MOD_PARAM_SOURCE),
        targetEffectId: paramWord(data, pos, MOD_PARAM_TARGET_EID),
        targetParam: paramWord(data, pos, MOD_PARAM_TARGET_PARAM),
      });
    }
    pos += MODIFIER_RECORD_BYTES;
  }
  return out;
}

/** Byte offset just past the leading modifier run (where the block chain begins). */
export function modifierRunEnd(data: Uint8Array, walkStart: number): number {
  let pos = walkStart;
  while (pos >= 0 && pos + MODIFIER_RECORD_BYTES <= data.length
    && u16(data, pos + 30) === MODIFIER_COLS && u16(data, pos + 32) === 1) {
    pos += MODIFIER_RECORD_BYTES;
  }
  return pos;
}

const SOURCE_ROSTERS: Readonly<Record<number, Readonly<Record<number, string>> | undefined>> = {
  [MODEL_AXE_FX_III]: III_CACHE_ENUM_NAMES.MOD_CTRLID,
  [MODEL_FM3]: FM3_CACHE_ENUM_NAMES.MOD_CTRLID,
  [MODEL_FM9]: FM9_CACHE_ENUM_NAMES.MOD_CTRLID,
};

/** Device-true modifier source name (each device's own MOD_CTRLID roster). */
export function modifierSourceName(modelId: number, sourceId: number): string {
  return SOURCE_ROSTERS[modelId]?.[sourceId] ?? `source_${sourceId}`;
}

/**
 * The modifiers in use: source != NONE, a source the device's own roster
 * names (fractone skips ids past the roster: they are not live sources), and
 * a target that resolves, and, when `placedEffectIds` is given (the grid),
 * whose target block is actually placed (a modifier on an absent block does
 * nothing).
 */
export function extractModifiers(
  data: Uint8Array,
  modelId: number,
  walkStart: number,
  placedEffectIds?: ReadonlySet<number>,
): Gen3Modifier[] {
  const out: Gen3Modifier[] = [];
  const roster = SOURCE_ROSTERS[modelId];
  for (const s of readModifierSlots(data, walkStart)) {
    if (s.sourceId === 0) continue; // NONE: an unused slot (stale target words)
    if (roster && roster[s.sourceId] === undefined) continue;
    const target = effectName(s.targetEffectId);
    if (!target) continue;
    if (placedEffectIds && !placedEffectIds.has(s.targetEffectId)) continue;
    out.push({
      source: modifierSourceName(modelId, s.sourceId),
      target,
      param: s.targetParam,
      origin: 'pre-chain',
      slot: s.slot,
    });
  }
  return out;
}

/** Per-model Controllers record: `base` = byte offset of record word 17
 *  (param id 0); its (cols, rows) header words sit at base-4 / base-2. */
const CONTROLLERS_LAYOUTS: Readonly<Record<number, { base: number; cols: number }>> = {
  [MODEL_FM3]: { base: 0x1f2, cols: 130 },
  [MODEL_AXE_FX_III]: { base: 0x282, cols: 178 },
  [MODEL_FM9]: { base: 0xe9a, cols: 130 },
};
/** CONTROLLERS_SCENE1_VAL1 paramId (72) .. SCENE4_VAL8 (103). */
export const SCENE_CONTROLLER_FIRST_PARAM = 72;

/** True when the model's Controllers record header is where the layout says. */
export function controllersRecordPresent(data: Uint8Array, modelId: number): boolean {
  const layout = CONTROLLERS_LAYOUTS[modelId];
  if (!layout) return false;
  const lastValue = layout.base + (SCENE_CONTROLLER_FIRST_PARAM + 31) * 2;
  return lastValue + 2 <= data.length
    && u16(data, layout.base - 4) === layout.cols
    && u16(data, layout.base - 2) === 4;
}

/** Raw per-scene values of the four scene controllers (channel row 0), or
 *  undefined when the Controllers record is not where it is expected. */
export function readSceneControllerRaw(data: Uint8Array, modelId: number): number[][] | undefined {
  if (!controllersRecordPresent(data, modelId)) return undefined;
  const { base } = CONTROLLERS_LAYOUTS[modelId];
  const rows: number[][] = [];
  for (let sc = 0; sc < 4; sc++) {
    const raw: number[] = [];
    for (let scene = 0; scene < 8; scene++) {
      raw.push(u16(data, base + (SCENE_CONTROLLER_FIRST_PARAM + sc * 8 + scene) * 2));
    }
    rows.push(raw);
  }
  return rows;
}

/** Scene controllers with any non-zero value, as 0..100 % per scene. */
export function extractSceneControllers(data: Uint8Array, modelId: number): Gen3SceneController[] {
  const rows = readSceneControllerRaw(data, modelId);
  if (!rows) return [];
  const out: Gen3SceneController[] = [];
  rows.forEach((raw, sc) => {
    if (!raw.some((v) => v !== 0)) return;
    out.push({
      controller: `Scene Controller ${sc + 1}`,
      values: raw.map((v) => Math.round((v / 65535) * 1000) / 10),
      raw,
    });
  });
  return out;
}
