/**
 * Axe-Fx II per-block per-scene state + per-block param layout map
 * within the 12,951-byte preset binary.
 *
 * Each entry maps a block's effectId to:
 *
 *   sceneState: (chunk, ushort) where the per-scene state ushort lives.
 *     bits 0..7   = scene 1..8 BYPASS bitmap (1 = bypassed)
 *     bits 8..15  = scene 1..8 CHANNEL-Y bitmap (1 = on Y, else X)
 *
 *   paramBase (optional): (chunk, ushort) where paramId 0's value lives.
 *     Subsequent paramIds live at consecutive ushort offsets.
 *     Wraps across chunk boundaries at ushort 64 (chunks are 64 ushorts).
 *
 * Recovered Session 115 via paired-dump experiments
 * (`scripts/_research/bk070-channel-experiment-v2.ts` for sceneState,
 *  `scripts/_research/bk070-amp-param-mapper.ts` for paramBase).
 *
 * ⚠️ SESSION 116 FINDING: paramBase entries are LAYOUT-DEPENDENT.
 *
 * These entries were probed against the exact 6-block Test Crunch
 * composition (compressor / drive / amp / cab / delay / reverb at
 * row 2). Adding even one block to the preset shifts every existing
 * block's paramBase. Hardware-verified: Test Crunch + Chorus 1 at
 * (2,7) shifted Compressor 1's X paramBase from c7:u2 to c7:u52, and
 * Chorus 1 claimed c7:u2.
 *
 * Block records (chunk 0 stride-8 region) carry block_id + a flag
 * ushort, but ushort[2..7] are all zero — paramBase is NOT encoded
 * there. The firmware computes the allocation from the placed-block
 * set via an algorithm not visible in the binary.
 *
 * `axefx2_atomic_apply` therefore only handles presets with the
 * Test Crunch composition correctly. General-purpose atomic apply
 * requires either Ghidra-mining AxeEdit's encoder or a per-preset
 * dynamic probe; see `docs/_private/BK-070-DECODE-NOTES.md` §"Session
 * 116 — paramBase is LAYOUT-DEPENDENT" for the path forward.
 *
 * sceneState entries may also be layout-dependent — not yet verified.
 * Treat them with the same caveat until a multi-composition probe
 * confirms stability.
 */

export interface BlockLocation {
  /** Block name for diagnostics. */
  readonly blockName: string;
  /** Chunk index of the per-scene state ushort. */
  readonly sceneStateChunk: number;
  /** Native-ushort offset of the per-scene state ushort within that chunk. */
  readonly sceneStateUshort: number;
  /** Chunk index of channel-X paramId 0's value ushort, if known. */
  readonly paramBaseChunkX?: number;
  /** Native-ushort offset of channel-X paramId 0's value within that chunk. */
  readonly paramBaseUshortX?: number;
  /** Chunk index of channel-Y paramId 0's value ushort, if known. */
  readonly paramBaseChunkY?: number;
  /** Native-ushort offset of channel-Y paramId 0's value within that chunk. */
  readonly paramBaseUshortY?: number;
  /**
   * Backward-compat aliases for the single-channel param map (Session 115
   * v0.1). Equivalent to paramBaseChunkX/paramBaseUshortX when known.
   */
  readonly paramBaseChunk?: number;
  readonly paramBaseUshort?: number;
}

/** effectId → block layout map.
 *
 * ⚠️ See Session 116 caveat in the module docstring: paramBase
 * entries are CALIBRATED FOR TEST CRUNCH'S 6-BLOCK COMPOSITION ONLY.
 * Adding or removing blocks shifts paramBase. Do not extend with new
 * Tier-2 entries from single-block placement probes — those values
 * land at c2:u4 because single-block presets serialize differently
 * than multi-block ones (an artifact of empty-chunk packing).
 *
 * Tier-1a entries below are correct ONLY when the live preset's block
 * composition matches Test Crunch (compressor / drive / amp / cab /
 * delay / reverb at row 2, nothing else placed).
 */
export const BLOCK_LAYOUT_MAP: ReadonlyMap<number, BlockLocation> = new Map([
  // Tier 1a: sceneState + X/Y paramBase verified.
  [106, { blockName: 'Amp 1', sceneStateChunk: 2, sceneStateUshort: 32,
          paramBaseChunkX: 2, paramBaseUshortX: 4,
          paramBaseChunkY: 3, paramBaseUshortY: 58,
          paramBaseChunk: 2, paramBaseUshort: 4 }],
  [108, { blockName: 'Cab 1', sceneStateChunk: 5, sceneStateUshort: 63,
          paramBaseChunkX: 5, paramBaseUshortX: 50,
          paramBaseChunkY: 6, paramBaseUshortY: 25,
          paramBaseChunk: 5, paramBaseUshort: 50 }],
  [110, { blockName: 'Reverb 1', sceneStateChunk: 10, sceneStateUshort: 60,
          paramBaseChunkX: 10, paramBaseUshortX: 38,
          paramBaseChunkY: 11, paramBaseUshortY: 19,
          paramBaseChunk: 10, paramBaseUshort: 38 }],
  [133, { blockName: 'Drive 1', sceneStateChunk: 10, sceneStateUshort: 1,
          paramBaseChunkX: 9, paramBaseUshortX: 58,
          paramBaseChunkY: 10, paramBaseUshortY: 15,
          paramBaseChunk: 9, paramBaseUshort: 58 }],
  // Tier 1a (continued): Comp + Delay X/Y verified Session 115 cont 2.
  [100, { blockName: 'Compressor 1', sceneStateChunk: 7, sceneStateUshort: 11,
          paramBaseChunkX: 7, paramBaseUshortX: 2,
          paramBaseChunkY: 7, paramBaseUshortY: 22,
          paramBaseChunk: 7, paramBaseUshort: 2 }],
  [112, { blockName: 'Delay 1', sceneStateChunk: 8, sceneStateUshort: 2,
          paramBaseChunkX: 7, paramBaseUshortX: 44,
          paramBaseChunkY: 8, paramBaseUshortY: 50,
          paramBaseChunk: 7, paramBaseUshort: 44 }],
  // Tier 2: sceneState only — paramBase not yet mapped.
  [102, { blockName: 'Graphic EQ 1', sceneStateChunk: 3, sceneStateUshort: 7 }],
  [104, { blockName: 'Parametric EQ 1', sceneStateChunk: 3, sceneStateUshort: 52 }],
  [114, { blockName: 'Multi Delay 1', sceneStateChunk: 6, sceneStateUshort: 24 }],
  [116, { blockName: 'Chorus 1', sceneStateChunk: 2, sceneStateUshort: 19 }],
  [118, { blockName: 'Flanger 1', sceneStateChunk: 3, sceneStateUshort: 22 }],
  [120, { blockName: 'Rotary Speaker 1', sceneStateChunk: 7, sceneStateUshort: 31 }],
  [122, { blockName: 'Phaser 1', sceneStateChunk: 4, sceneStateUshort: 8 }],
  [124, { blockName: 'Wah 1', sceneStateChunk: 8, sceneStateUshort: 8 }],
  [126, { blockName: 'Formant', sceneStateChunk: 2, sceneStateUshort: 28 }],
  [127, { blockName: 'Volume/Pan 1', sceneStateChunk: 4, sceneStateUshort: 52 }],
  [128, { blockName: 'Tremolo/Panner 1', sceneStateChunk: 4, sceneStateUshort: 29 }],
  [130, { blockName: 'Pitch 1', sceneStateChunk: 5, sceneStateUshort: 5 }],
  [131, { blockName: 'Filter 1', sceneStateChunk: 2, sceneStateUshort: 62 }],
  [135, { blockName: 'Enhancer', sceneStateChunk: 2, sceneStateUshort: 9 }],
  [136, { blockName: 'FX Loop', sceneStateChunk: 2, sceneStateUshort: 50 }],
]);

/**
 * Backward-compat alias for the prior SCENE_CHANNEL_MAP. Same data
 * surfaced as `{ chunk, ushort }` for callers that only need the
 * per-scene state ushort.
 */
export const SCENE_CHANNEL_MAP: ReadonlyMap<number, { blockName: string; chunk: number; ushort: number }> = new Map(
  Array.from(BLOCK_LAYOUT_MAP.entries()).map(([id, loc]) => [
    id,
    { blockName: loc.blockName, chunk: loc.sceneStateChunk, ushort: loc.sceneStateUshort },
  ]),
);

/**
 * Bit position within the per-scene state ushort for the given scene
 * number's CHANNEL-Y flag (1-indexed scene).
 */
export function sceneChannelYBit(sceneNumber: number): number {
  if (sceneNumber < 1 || sceneNumber > 8) {
    throw new Error(`Scene must be 1..8; got ${sceneNumber}`);
  }
  return 7 + sceneNumber;
}

/**
 * Bit position within the per-scene state ushort for the given scene
 * number's BYPASS flag (1-indexed scene).
 */
export function sceneBypassBit(sceneNumber: number): number {
  if (sceneNumber < 1 || sceneNumber > 8) {
    throw new Error(`Scene must be 1..8; got ${sceneNumber}`);
  }
  return sceneNumber - 1;
}

/**
 * Build the new per-scene state ushort.
 *
 * Bits 0..7 = bypass bitmap (1 = bypassed for that scene)
 * Bits 8..15 = channel-Y bitmap (1 = on Y for that scene)
 *
 * Original byte values are NOT preserved by default — callers pass the
 * intended bitmap. To partially update only one half, mask + OR the
 * existing value yourself.
 */
export function buildSceneStateUshort(
  scenesBypassed: ReadonlyArray<number>,
  scenesOnY: ReadonlyArray<number>,
): number {
  let bypassMap = 0;
  for (const scene of scenesBypassed) bypassMap |= 1 << sceneBypassBit(scene);
  let yMap = 0;
  for (const scene of scenesOnY) yMap |= 1 << sceneChannelYBit(scene);
  return (bypassMap & 0x00ff) | (yMap & 0xff00);
}

/** Backward-compat — preserves bypass low byte while updating channel-Y high byte. */
export function buildSceneChannelUshort(
  originalUshort: number,
  scenesOnY: ReadonlyArray<number>,
): number {
  let yBitmap = 0;
  for (const scene of scenesOnY) {
    yBitmap |= 1 << sceneChannelYBit(scene);
  }
  return (originalUshort & 0x00ff) | (yBitmap & 0xff00);
}

/**
 * Compute the absolute (chunk, ushort) location of a param value within
 * the preset binary, given the block's paramBase and the param's paramId.
 *
 * Each chunk holds 64 native ushorts. Params overflow into the next
 * chunk when (paramBaseUshort + paramId) >= 64.
 *
 * Returns undefined if the block doesn't have a known paramBase yet
 * (the block-layout table is partial — Session 115 only mapped amp + drive).
 */
export function paramLocation(
  effectId: number,
  paramId: number,
): { chunk: number; ushort: number } | undefined {
  const loc = BLOCK_LAYOUT_MAP.get(effectId);
  if (loc?.paramBaseChunk === undefined || loc.paramBaseUshort === undefined) return undefined;
  const globalUshort = loc.paramBaseUshort + paramId;
  return {
    chunk: loc.paramBaseChunk + Math.floor(globalUshort / 64),
    ushort: globalUshort % 64,
  };
}

/**
 * Per-channel param location lookup. Returns the (chunk, ushort) for
 * the specified channel's storage of `paramId` in this block.
 *
 * Channels 'X' and 'Y' are explicit. If the block doesn't have per-channel
 * paramBase mapped (Tier 1b or Tier 2), falls back to the channel-
 * agnostic `paramLocation` for backward compat.
 *
 * Returns undefined if the requested channel's paramBase is unknown.
 */
export function paramLocationForChannel(
  effectId: number,
  paramId: number,
  channel: 'X' | 'Y',
): { chunk: number; ushort: number } | undefined {
  const loc = BLOCK_LAYOUT_MAP.get(effectId);
  if (!loc) return undefined;
  const baseChunk = channel === 'X' ? loc.paramBaseChunkX : loc.paramBaseChunkY;
  const baseUshort = channel === 'X' ? loc.paramBaseUshortX : loc.paramBaseUshortY;
  if (baseChunk === undefined || baseUshort === undefined) {
    // Fallback: if asking for X and X explicit isn't set but legacy
    // paramBase is, use it. Same for Y if it shares storage.
    if (channel === 'X' && loc.paramBaseChunk !== undefined && loc.paramBaseUshort !== undefined) {
      const globalUshort = loc.paramBaseUshort + paramId;
      return {
        chunk: loc.paramBaseChunk + Math.floor(globalUshort / 64),
        ushort: globalUshort % 64,
      };
    }
    return undefined;
  }
  const globalUshort = baseUshort + paramId;
  return {
    chunk: baseChunk + Math.floor(globalUshort / 64),
    ushort: globalUshort % 64,
  };
}
