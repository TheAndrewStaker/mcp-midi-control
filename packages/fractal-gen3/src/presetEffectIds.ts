/**
 * Gen-3 grid effect ids: the family base table and the id -> name / family
 * lookups shared by the stored-body decoder (presetBody.ts), its modifier
 * table (presetModifiers.ts) and the live grid reader.
 *
 * Effect ids are family-shared across the Axe-Fx III / FM3 / FM9 (the III's
 * published "MIDI for 3rd Party Devices" Appendix 1 roster). Instances 1..4
 * of a family are base..base+3; Input has five instances (37..41).
 */

/** Grid effect-id -> block family base. */
export const EFFECT_BASES: Readonly<Record<number, string>> = {
  37: 'Input', 42: 'Output', 46: 'Comp', 50: 'GEQ', 54: 'PEQ', 58: 'Amp',
  62: 'Cab', 66: 'Reverb', 70: 'Delay', 74: 'MultiTap', 78: 'Chorus',
  82: 'Flanger', 86: 'Rotary', 90: 'Phaser', 94: 'Wah', 98: 'Formant',
  102: 'Vol/Pan', 106: 'Tremolo', 110: 'Pitch', 114: 'Filter', 118: 'Drive',
  122: 'Enhancer', 126: 'Mixer', 130: 'Synth', 138: 'Megatap', 142: 'Crossover', 146: 'Gate',
  150: 'RingMod', 154: 'MultiComp', 158: 'Ten-Tap', 162: 'Resonator',
  166: 'Looper', 170: 'Tone Match', 174: 'RTA', 178: 'Plex Delay', 182: 'Send', 186: 'Return',
  191: 'Multiplexer', 195: 'IR Player',
};

/** Effect id 202 is placed in two factory presets and named by no published list. */
export const UNNAMED_202 = 'eid_202';

/** Split an effect id into its family and 1-based instance. */
export function effectFamily(eid: number): { family: string; instance: number } | undefined {
  for (const [baseStr, family] of Object.entries(EFFECT_BASES)) {
    const d = eid - Number(baseStr);
    // Four instances per family, except Input, which has five (37..41).
    if (d >= 0 && d <= (family === 'Input' ? 4 : 3)) return { family, instance: d + 1 };
  }
  if (eid === 202) return { family: UNNAMED_202, instance: 1 };
  return undefined;
}

/**
 * Resolve a gen-3 effect ID to its display name + instance (e.g. 58 -> "Amp 1",
 * 119 -> "Drive 2"). The LIVE grid reader (sub=0x2E) labels cells with this
 * same convention as the stored-dump grid decode.
 */
export function effectName(eid: number): string | undefined {
  if (eid in EFFECT_BASES) return `${EFFECT_BASES[eid]} 1`;
  for (const [baseStr, name] of Object.entries(EFFECT_BASES)) {
    const base = Number(baseStr);
    const d = eid - base;
    if (d > 0 && d <= (name === 'Input' ? 4 : 3)) return `${name} ${d + 1}`;
  }
  return undefined;
}
