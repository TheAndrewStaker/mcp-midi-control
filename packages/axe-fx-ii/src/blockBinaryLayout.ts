/**
 * Axe-Fx II preset-binary per-block-name layout table.
 *
 * The 12,951-byte preset binary places each placed block-type's data
 * at a (chunk, ushort) location determined dynamically by the firmware
 * from the set of placed blocks. This table holds the empirically-
 * measured WIDTH (ushorts per block-name in the binary) and X→Y channel
 * OFFSET (ushorts between channel-X paramBase and channel-Y paramBase)
 * for each block-name.
 *
 * Status — 2026-05-22 (Session 116 cont 2, BK-070):
 *
 *   Widths measured across 5 hardware batches (see
 *   `scripts/_research/bk070-measure-widths.ts`). Cross-batch
 *   consistency verified: Reverb=92 (Batch C+E), Chorus=50 (A+E),
 *   Compressor=42 (A+E), Flanger=50 (B+E), GraphicEQ=40 (B+E),
 *   ParametricEQ=50 (C+E), Pitch=172 (C+E), Rotary=40 (C+D),
 *   RingMod=12 (C+D). Same number every time the block is placed,
 *   regardless of what else is in the preset.
 *
 * Sort algorithm — partially cracked:
 *
 *   The binary order is NOT a simple sort. Several heuristics
 *   explored (cascade order, alphabetical by cascade key, alphabetical
 *   by display name, groupCode alphabetical, block_id ascending) each
 *   match SOME batches but fail others. Empirical observations:
 *
 *   - Batches A, C, E follow cascade-order EXCEPT EffectsLoop in
 *     Batch A lands after Filter (its cascade position) but BEFORE
 *     it alphabetically would suggest.
 *   - Batch D has PanTrem appearing BEFORE Vocoder/VolPan, even
 *     though cascade order puts Vocoder(30) + VolPan(31) before
 *     PanTrem(32). This matches alphabetical-by-cascade-key
 *     (P < V), but contradicts Batch A.
 *   - Batch B has Mixer (canBypass=false) always sorted to the END,
 *     regardless of cascade position (Mixer is cascade pos 18,
 *     observed last in Batch B).
 *
 * Until the algorithm is fully reverse-engineered (likely via more
 * Ghidra mining of AxeEdit.exe), use this table for known-composition
 * presets only. For general atomic_apply against arbitrary
 * compositions, a per-preset calibration probe is the safest path
 * (probe each target block once, derive its actual paramBase from
 * the diff, then patch the binary).
 */

/** Axe-Fx II canonical block-name as used by AxeEdit's FUN_00595260
 * string-compare cascade. See `docs/_private/BK-070-DECODE-NOTES.md`
 * §"Session 116 cont — Ghidra confirms" for the full extracted table. */
export type AxeFxIIBlockName =
  | 'Amp' | 'Cab' | 'Chorus' | 'Compressor' | 'Crossover' | 'Delay'
  | 'Drive' | 'EffectsLoop' | 'Enhancer' | 'FeedbackReturn' | 'FeedbackSend'
  | 'Filter' | 'Flanger' | 'Formant' | 'GateExpander' | 'GraphicEQ'
  | 'Looper' | 'MegaTap' | 'Mixer' | 'MultibandComp' | 'MultiDelay'
  | 'Noisegate' | 'Output' | 'Controllers' | 'ParametricEQ' | 'PanTrem'
  | 'Phaser' | 'Pitch' | 'QuadChorus' | 'Resonator' | 'Reverb' | 'RingMod'
  | 'Rotary' | 'Synth' | 'Vocoder' | 'VolPan' | 'Wah';

/**
 * Per-block-name binary footprint within the 12,951-byte preset.
 *
 *   widthUshorts: total ushorts the block-name reserves in the binary,
 *     measured between consecutive placed blocks. STABLE across
 *     compositions (verified Session 116 cont 2 cross-batch).
 *
 *   xToYOffsetUshorts: ushorts between channel-X paramBase and
 *     channel-Y paramBase for this block. Per-block-name constant.
 *
 *   wireIds: array of wire ids this block-name reserves (1 / 2 / 4
 *     elements). Extracted from AxeEdit.exe FUN_00595260 cascade.
 *
 *   cascadePosition: 0-indexed position in FUN_00595260's if-else
 *     chain. Hint for binary ordering; not always equal to binary
 *     position (see module docstring).
 *
 *   canBypass: true for normal effect blocks, false for system blocks
 *     (Mixer, Noisegate, Output, Controllers). System blocks tend
 *     to sort AFTER all normal blocks in the binary.
 */
export interface BlockBinaryLayout {
  readonly widthUshorts?: number;
  readonly xToYOffsetUshorts?: number;
  readonly wireIds: readonly number[];
  readonly cascadePosition: number;
  readonly canBypass: boolean;
}

/**
 * Empirically-measured per-block-name binary layout.
 *
 * `widthUshorts` and `xToYOffsetUshorts` are populated for blocks
 * verified against hardware. `undefined` means not yet measured.
 *
 * Sources:
 *   Width:        scripts/_research/bk070-measure-widths.ts (batches A-E)
 *   X→Y offset:   scripts/_research/bk070-map-xy-paramBase-v2.ts +
 *                 BLOCK_LAYOUT_MAP in sceneChannelMap.ts (Tier 1a)
 *   Wire ids:     AxeEdit.exe FUN_00595260 decompile
 *   Cascade pos:  AxeEdit.exe FUN_00595260 if-else order
 */
export const BLOCK_BINARY_LAYOUT: Readonly<Record<AxeFxIIBlockName, BlockBinaryLayout>> = {
  Amp:            { widthUshorts: 238, xToYOffsetUshorts: 118, wireIds: [106, 107],        cascadePosition: 0,  canBypass: true  },
  Cab:            { widthUshorts: 80,  xToYOffsetUshorts: 39,  wireIds: [108, 109],        cascadePosition: 1,  canBypass: true  },
  Chorus:         { widthUshorts: 50,                          wireIds: [116, 117],        cascadePosition: 2,  canBypass: true  },
  Compressor:     { widthUshorts: 42,  xToYOffsetUshorts: 20,  wireIds: [100, 101],        cascadePosition: 3,  canBypass: true  },
  Crossover:      { widthUshorts: 17,                          wireIds: [148, 149],        cascadePosition: 4,  canBypass: true  },
  Delay:          { widthUshorts: 142, xToYOffsetUshorts: 70,  wireIds: [112, 113],        cascadePosition: 5,  canBypass: true  },
  Drive:          { widthUshorts: 44,  xToYOffsetUshorts: 21,  wireIds: [133, 134],        cascadePosition: 6,  canBypass: true  },
  Enhancer:       { widthUshorts: 13,                          wireIds: [135],             cascadePosition: 7,  canBypass: true  },
  FeedbackSend:   {                                            wireIds: [142],             cascadePosition: 8,  canBypass: false },
  FeedbackReturn: {                                            wireIds: [143],             cascadePosition: 9,  canBypass: false },
  Filter:         { widthUshorts: 16,                          wireIds: [131, 132, 164, 165], cascadePosition: 10, canBypass: true  },
  Flanger:        { widthUshorts: 50,                          wireIds: [118, 119],        cascadePosition: 11, canBypass: true  },
  Formant:        { widthUshorts: 14,                          wireIds: [126],             cascadePosition: 12, canBypass: true  },
  GateExpander:   { widthUshorts: 28,                          wireIds: [150, 151],        cascadePosition: 13, canBypass: true  },
  GraphicEQ:      { widthUshorts: 40,                          wireIds: [102, 103, 160, 161], cascadePosition: 14, canBypass: true  },
  EffectsLoop:    { widthUshorts: 22,                          wireIds: [136],             cascadePosition: 15, canBypass: true  },
  MegaTap:        { widthUshorts: 19,                          wireIds: [147],             cascadePosition: 16, canBypass: true  },
  Mixer:          {                                            wireIds: [137, 138],        cascadePosition: 17, canBypass: false },
  MultibandComp:  { widthUshorts: 30,                          wireIds: [154, 155],        cascadePosition: 18, canBypass: true  },
  MultiDelay:     { widthUshorts: 120,                         wireIds: [114, 115],        cascadePosition: 19, canBypass: true  },
  ParametricEQ:   { widthUshorts: 50,                          wireIds: [104, 105, 162, 163], cascadePosition: 20, canBypass: true  },
  Phaser:         { widthUshorts: 48,                          wireIds: [122, 123],        cascadePosition: 21, canBypass: true  },
  Pitch:          { widthUshorts: 172,                         wireIds: [130, 153],        cascadePosition: 22, canBypass: true  },
  QuadChorus:     {                                            wireIds: [156, 157],        cascadePosition: 23, canBypass: true  },
  Resonator:      { widthUshorts: 42,                          wireIds: [158, 159],        cascadePosition: 24, canBypass: true  },
  Reverb:         { widthUshorts: 92,  xToYOffsetUshorts: 45,  wireIds: [110, 111],        cascadePosition: 25, canBypass: true  },
  RingMod:        { widthUshorts: 12,                          wireIds: [152],             cascadePosition: 26, canBypass: true  },
  Rotary:         { widthUshorts: 40,                          wireIds: [120, 121],        cascadePosition: 27, canBypass: true  },
  Synth:          { widthUshorts: 42,                          wireIds: [144, 145],        cascadePosition: 28, canBypass: true  },
  Vocoder:        { widthUshorts: 52,                          wireIds: [146],             cascadePosition: 29, canBypass: true  },
  VolPan:         { widthUshorts: 11,                          wireIds: [127, 166, 167, 168], cascadePosition: 30, canBypass: true  },
  PanTrem:        { widthUshorts: 34,                          wireIds: [128, 129],        cascadePosition: 31, canBypass: true  },
  Wah:            {                                            wireIds: [124, 125],        cascadePosition: 32, canBypass: true  },
  Looper:         {                                            wireIds: [169],             cascadePosition: 33, canBypass: true  },
  Noisegate:      {                                            wireIds: [139],             cascadePosition: 34, canBypass: false },
  Output:         {                                            wireIds: [140],             cascadePosition: 35, canBypass: false },
  Controllers:    {                                            wireIds: [141],             cascadePosition: 36, canBypass: false },
};

/**
 * Reverse lookup: effectId → BlockName. Built from `BLOCK_BINARY_LAYOUT`
 * by walking each entry's `wireIds`.
 */
export const EFFECT_ID_TO_BLOCK_NAME: ReadonlyMap<number, AxeFxIIBlockName> = (() => {
  const map = new Map<number, AxeFxIIBlockName>();
  for (const [name, layout] of Object.entries(BLOCK_BINARY_LAYOUT) as [AxeFxIIBlockName, BlockBinaryLayout][]) {
    for (const id of layout.wireIds) map.set(id, name);
  }
  return map;
})();
