/**
 * FM3 effectId ↔ family map — the missing addressing layer.
 *
 * Everything on the gen-3 wire is addressed as `(effectId, paramId)` in
 * fn=0x01 PARAMETER_SETGET frames. The per-family param dictionaries
 * (`FM3_PARAMS_BY_FAMILY`) give the `paramId` half; this module supplies
 * the `effectId` half so a consumer can do `(effectId, paramId)` ops on
 * any block — INCLUDING the virtual / system blocks (Global, Foot
 * Controller, Modifier/Controllers, Scene-MIDI) — purely by family name.
 *
 * ── Source of truth ──────────────────────────────────────────────────
 * The gen-3 effect-id roster (firstId per block) is the shared v1.4
 * Appendix-1 table that already lives in `AXE_FX_III_BLOCKS`
 * (axe-fx-iii/blockTypes.ts). The whole gen-3 family — III (0x10),
 * FM3 (0x11), FM9 (0x12), VP4 (0x14) — shares ONE block roster, so the
 * `firstId`s are device-independent.
 *
 * This FM3 table maps that roster onto the FM3 *param-family symbols*
 * (`'DISTORT'`, `'FUZZ'`, `'GLOBAL'`, …) that `FM3_PARAMS_BY_FAMILY`
 * keys on. Two family symbols carry the well-known gen-3 anomaly:
 *   - **`DISTORT` family → Amp block, firstId 58.** (The v1.4 enum has
 *     no `ID_AMP`; the amp tone-stack lives at `ID_DISTORT1..4`. See the
 *     `AXE_FX_III_BLOCKS` header for the FM9-hardware evidence.)
 *   - **`FUZZ` family → Drive block, firstId 118.** (`ID_FUZZ1..4` is
 *     the user-facing Drive / OD / Fuzz pedal.)
 *
 * ── Cross-validation (FM3-specific) ──────────────────────────────────
 * Every entry below was confirmed against the FM3 editor's effect-instance
 * table (`{effectId → effectType}`, eid 0..201). For each family the base
 * effectId's `effectType` matches the gen-3 cluster boundary exactly
 * (e.g. DISTORT→58→type 0x0a, FUZZ→118→type 0x19, FC→199→type 0x39,
 * CONTROLLERS→2→type 0x03). The Modifier/Controllers effectId 199 vs 2
 * split, and the universal "Modifier=199" note, are reconciled below
 * (see VIRTUAL section).
 *
 * ── Virtual-block addressing (FM3) ───────────────────────────────────
 * Three "virtual" families are param-addressable via fn=0x01 (the
 * spec-based map had them null): GLOBAL = effectId 1 (the Power-Amp-Modeling
 * toggle on the Global/Setup page is eid 1 / pid 4 / =1.0), Controllers = 2,
 * Modifier = effectId 3, Foot Controller = 199. GLOBAL and Modifier are set
 * to those effectIds below (Controllers/FC already matched), addressing them
 * as normal param effects.
 *
 * NOT a generated file — but the DATA is derived, not invented. If the
 * gen-3 roster changes, change it in `AXE_FX_III_BLOCKS` and mirror here.
 */

/** How a family is addressed on the wire. */
export type Fm3EffectAddressing =
  /** Placeable signal-chain block; `effectId = firstId + (instance-1)`. */
  | 'block'
  /** Virtual / system block at a fixed effectId (not grid-placeable). */
  | 'virtual'
  /** No wire effectId of its own (data rides another block or a system fn). */
  | 'none';

/** One family → effectId binding. */
export interface Fm3EffectIdEntry {
  /** FM3 param-family symbol, the key into `FM3_PARAMS_BY_FAMILY`. */
  family: string;
  /**
   * First-instance effectId. `null` for families with no wire effectId
   * of their own (GLOBAL/PRESET system data, MOD modifier sub-records).
   */
  firstId: number | null;
  /** Number of addressable instances (1 for singletons/virtual). */
  instances: number;
  /** Display name as shown in the FM3 editor. */
  name: string;
  /** Addressing class. */
  addressing: Fm3EffectAddressing;
  /**
   * gen-3 effectType the base effectId resolves to in the FM3 editor's
   * instance table — recorded as the cross-check anchor. `null` for
   * `addressing: 'none'` families. Not used on the wire (the wire keys
   * on effectId), but it is what was matched to prove each binding.
   */
  effectType: number | null;
}

/**
 * FM3 family → effectId table. Audio blocks first (instance-table
 * order), then the VIRTUAL / system blocks.
 *
 * Validated: every `firstId` here equals the corresponding
 * `AXE_FX_III_BLOCKS` entry, and every `effectType` equals the FM3 editor's
 * instance-table type for that effectId.
 */
export const FM3_EFFECT_ID_TABLE: readonly Fm3EffectIdEntry[] = [
  // ── Placeable signal-chain blocks ──────────────────────────────────
  { family: 'INPUT',       firstId: 37,  instances: 1, name: 'Input',                addressing: 'block',   effectType: 0x2a },
  { family: 'OUTPUT',      firstId: 42,  instances: 1, name: 'Output',               addressing: 'block',   effectType: 0x2f },
  { family: 'COMP',        firstId: 46,  instances: 4, name: 'Compressor',           addressing: 'block',   effectType: 0x07 },
  { family: 'GEQ',         firstId: 50,  instances: 4, name: 'Graphic EQ',           addressing: 'block',   effectType: 0x08 },
  { family: 'PEQ',         firstId: 54,  instances: 4, name: 'Parametric EQ',        addressing: 'block',   effectType: 0x09 },
  // DISTORT family IS the Amp block (no ID_AMP in the v1.4 enum).
  { family: 'DISTORT',     firstId: 58,  instances: 4, name: 'Amp',                  addressing: 'block',   effectType: 0x0a },
  { family: 'CABINET',     firstId: 62,  instances: 4, name: 'Cab',                  addressing: 'block',   effectType: 0x0b },
  { family: 'REVERB',      firstId: 66,  instances: 4, name: 'Reverb',               addressing: 'block',   effectType: 0x0c },
  { family: 'DELAY',       firstId: 70,  instances: 4, name: 'Delay',                addressing: 'block',   effectType: 0x0d },
  { family: 'MULTITAP',    firstId: 74,  instances: 4, name: 'Multitap Delay',       addressing: 'block',   effectType: 0x0e },
  { family: 'CHORUS',      firstId: 78,  instances: 4, name: 'Chorus',               addressing: 'block',   effectType: 0x10 },
  { family: 'FLANGER',     firstId: 82,  instances: 4, name: 'Flanger',              addressing: 'block',   effectType: 0x11 },
  { family: 'ROTARY',      firstId: 86,  instances: 4, name: 'Rotary',               addressing: 'block',   effectType: 0x12 },
  { family: 'PHASER',      firstId: 90,  instances: 4, name: 'Phaser',               addressing: 'block',   effectType: 0x13 },
  { family: 'WAH',         firstId: 94,  instances: 4, name: 'Wah',                  addressing: 'block',   effectType: 0x14 },
  { family: 'FORMANT',     firstId: 98,  instances: 4, name: 'Formant',              addressing: 'block',   effectType: 0x15 },
  { family: 'VOLUME',      firstId: 102, instances: 4, name: 'Volume/Pan',           addressing: 'block',   effectType: 0x28 },
  { family: 'TREMOLO',     firstId: 106, instances: 4, name: 'Pan/Tremolo',          addressing: 'block',   effectType: 0x16 },
  { family: 'PITCH',       firstId: 110, instances: 4, name: 'Pitch',                addressing: 'block',   effectType: 0x17 },
  { family: 'FILTER',      firstId: 114, instances: 4, name: 'Filter',               addressing: 'block',   effectType: 0x18 },
  // FUZZ family IS the user-facing Drive / OD / Fuzz pedal block.
  { family: 'FUZZ',        firstId: 118, instances: 4, name: 'Drive',                addressing: 'block',   effectType: 0x19 },
  { family: 'ENHANCER',    firstId: 122, instances: 4, name: 'Enhancer',             addressing: 'block',   effectType: 0x1a },
  { family: 'MIXER',       firstId: 126, instances: 4, name: 'Mixer',                addressing: 'block',   effectType: 0x1c },
  { family: 'SYNTH',       firstId: 130, instances: 4, name: 'Synth',                addressing: 'block',   effectType: 0x1f },
  { family: 'VOCODER',     firstId: 134, instances: 4, name: 'Vocoder',             addressing: 'block',   effectType: 0x20 },
  { family: 'MEGATAP',     firstId: 138, instances: 4, name: 'Megatap Delay',        addressing: 'block',   effectType: 0x21 },
  { family: 'CROSSOVER',   firstId: 142, instances: 4, name: 'Crossover',            addressing: 'block',   effectType: 0x22 },
  { family: 'GATE',        firstId: 146, instances: 4, name: 'Gate/Expander',        addressing: 'block',   effectType: 0x23 },
  { family: 'RINGMOD',     firstId: 150, instances: 4, name: 'Ring Modulator',       addressing: 'block',   effectType: 0x24 },
  { family: 'MULTICOMP',   firstId: 154, instances: 4, name: 'Multiband Compressor', addressing: 'block',   effectType: 0x25 },
  { family: 'TENTAP',      firstId: 158, instances: 4, name: 'Ten-Tap Delay',        addressing: 'block',   effectType: 0x26 },
  { family: 'RESONATOR',   firstId: 162, instances: 4, name: 'Resonator',            addressing: 'block',   effectType: 0x27 },
  { family: 'LOOPER',      firstId: 166, instances: 4, name: 'Looper',               addressing: 'block',   effectType: 0x32 },
  { family: 'TONEMATCH',   firstId: 170, instances: 4, name: 'Tone Match',           addressing: 'block',   effectType: 0x33 },
  { family: 'RTA',         firstId: 174, instances: 4, name: 'Real-Time Analyzer',   addressing: 'block',   effectType: 0x34 },
  { family: 'PLEX',        firstId: 178, instances: 4, name: 'Plex Delay',           addressing: 'block',   effectType: 0x0f },
  { family: 'FDBKSEND',    firstId: 182, instances: 4, name: 'Send',                 addressing: 'block',   effectType: 0x1d },
  { family: 'FDBKRET',     firstId: 186, instances: 4, name: 'Return',               addressing: 'block',   effectType: 0x1e },
  // Multiplexer shares effectType 0x36 with Scene-MIDI (190); the FM3
  // instance table runs Mux at eids 191..193 (Scene-MIDI is the 190 singleton).
  { family: 'MULTIPLEXER', firstId: 191, instances: 3, name: 'Multiplexer',          addressing: 'block',   effectType: 0x36 },
  { family: 'IRPLAYER',    firstId: 195, instances: 4, name: 'IR Player',            addressing: 'block',   effectType: 0x37 },

  // ── Virtual / system blocks (fixed effectId, not grid-placeable) ───
  // IR Capture utility (eid 36, type 0x29).
  { family: 'IRCAPTURE',   firstId: 36,  instances: 1, name: 'IR Capture',           addressing: 'virtual', effectType: 0x29 },
  // ID_CONTROL = 2 (type 0x03). Hosts the per-preset Controllers
  // (LFOs / ADSR / envelope / sequencer) the CONTROLLERS family describes.
  { family: 'CONTROLLERS', firstId: 2,   instances: 1, name: 'Controllers',          addressing: 'virtual', effectType: 0x03 },
  // ID_MIDIBLOCK = 190 (type 0x36). The per-scene MIDI / IA "Scene MIDI" block.
  { family: 'MIDIBLOCK',   firstId: 190, instances: 1, name: 'Scene MIDI',           addressing: 'virtual', effectType: 0x36 },
  // ID_FOOTCONTROLLER = 199 (type 0x39). The Foot Controller config block.
  // NB: the FM3 editor special-cases effectId 199's param-count lookup
  // (DAT table by effectType), and modifier edits address eid 199 heavily.
  // The `MOD_EFFECTID` string is a *param within the MOD family* (which
  // target a modifier points at), NOT evidence that 199 = "Modifier".
  { family: 'FC',          firstId: 199, instances: 1, name: 'Foot Controller',      addressing: 'virtual', effectType: 0x39 },

  // ── Virtual / system blocks proven param-addressable ──────────────────
  // GLOBAL / Controllers / Modifier are addressed as normal param effects
  // via fn=0x01 — they are NOT addressing:'none'. Toggling "Power Amp
  // Modeling" on the Global/Setup page writes effectId 1 / paramId 4 /
  // value 1.0, proving GLOBAL = effectId 1 (not null). The same evidence
  // pins Controllers = effectId 2 (already below) and Modifier = effectId 3.
  // This overrides the spec-based AXE_FX_III_BLOCKS null for GLOBAL/Modifier.
  { family: 'GLOBAL',      firstId: 1,    instances: 1, name: 'Global',              addressing: 'virtual', effectType: null },
  { family: 'MOD',         firstId: 3,    instances: 1, name: 'Modifier',            addressing: 'virtual', effectType: null },

  // ── Families with no wire effectId of their own ────────────────────
  // PRESET is preset-meta data (read via the preset dump function, not via a
  // placeable block or a fn=0x01 param effect).
  { family: 'PRESET',      firstId: null, instances: 1, name: 'Preset',              addressing: 'none',    effectType: null },
] as const;

/**
 * Quick lookup: FM3 param-family symbol → first-instance effectId
 * (`null` for `addressing: 'none'` families). Covers BOTH audio blocks
 * AND the virtual blocks (Global, FootController, Modifier/Controllers,
 * Scene-MIDI), so a consumer can do `(effectId, paramId)` ops by family.
 *
 * Example: `FM3_EFFECT_IDS.DISTORT` → 58 (Amp), `FM3_EFFECT_IDS.FC` → 199.
 */
export const FM3_EFFECT_IDS: Readonly<Record<string, number | null>> = Object.freeze(
  Object.fromEntries(FM3_EFFECT_ID_TABLE.map((e) => [e.family, e.firstId])),
);

/** Reverse lookup: base effectId → family symbol (audio + virtual). */
export const FM3_FAMILY_BY_EFFECT_ID: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    FM3_EFFECT_ID_TABLE.filter((e) => e.firstId !== null).map((e) => [e.firstId as number, e.family]),
  ),
);

/**
 * Resolve a `(family, instance)` to a concrete effectId.
 *
 * @param family FM3 param-family symbol (e.g. `'DISTORT'`, `'FC'`).
 * @param instance 1-based instance (default 1).
 * @returns the wire effectId, or `null` if the family has no wire
 *   effectId (`GLOBAL`/`PRESET`/`MOD`) or `instance` is out of range.
 */
export function fm3EffectId(family: string, instance = 1): number | null {
  const entry = FM3_EFFECT_ID_TABLE.find((e) => e.family === family);
  if (!entry || entry.firstId === null) return null;
  if (instance < 1 || instance > entry.instances) return null;
  return entry.firstId + (instance - 1);
}
