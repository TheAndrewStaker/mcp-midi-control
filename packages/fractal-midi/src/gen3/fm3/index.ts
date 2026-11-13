export { FM3_PARAMS, FM3_PARAMS_BY_FAMILY, FM3_FAMILIES } from './params.js';
// Device-true display ranges mined from the FM3-Edit effectDefinitions cache
// (community capture 2026-06-27, fw 12.0; 1831 rows / 39 families). Cache
// bounds override the AM4-overlay-inferred displayMin/displayMax at the
// catalog layer. Community-beta; gate: scripts/verify-fm3-ranges.ts.
export {
  FM3_RANGES,
  FM3_RANGE_SECTIONS,
  FM3_UNMAPPED_SECTIONS,
  type Fm3ParamRange,
  type Fm3RangeFamilyMeta,
} from './ranges.generated.js';
// Family-join discrete-ordinal overlay (param firmware symbol -> maxOrdinal).
// The enum-flow correction the FM9/III already received, applied to the FM3
// by (family, SYMBOL) join against the sibling evidence (FM9 cache enum rows
// + FM9/III hardware roundtrips). Family-pattern evidence, community-beta;
// an FM3 SET→GET roundtrip is the pending hardware confirm.
export {
  FM3_FAMILY_JOIN_DISCRETE,
  FM3_FAMILY_JOIN_PROVENANCE,
  type Fm3FamilyJoinProvenance,
} from './familyJoinDiscrete.generated.js';
// Device-true model rosters (amp/cab/drive/reverb lineage), enum value
// labels, and cabinet IR names, mined from the FM3 editor's UI configuration
// data. Community-beta; ordinal IS the discrete-SET value, so these rosters
// are read labels AND settable by name.
export { FM3_ROSTERS, type Fm3TypeModel } from './rosters.generated.js';
export { FM3_ENUM_OVERRIDES } from './enumOverrides.js';
export { FM3_ENUM_OVERRIDES_BY_NAME } from './enumOverridesByName.js';
export { FM3_CAB_IRS } from './cabIrs.generated.js';
// FM3 effectId <-> family map (the addressing layer: (effectId, paramId) for
// any block, including virtual/system blocks Global/Controllers/Modifier/FC).
// See `effectIds.ts`.
export {
  FM3_EFFECT_ID_TABLE,
  FM3_EFFECT_IDS,
  FM3_FAMILY_BY_EFFECT_ID,
  fm3EffectId,
  type Fm3EffectIdEntry,
  type Fm3EffectAddressing,
} from './effectIds.js';
// Editor block-editor UI layouts (pages/tabs + labels + param mapping),
// keyed by catalog family. See `layouts.generated.ts`.
export {
  FM3_LAYOUTS,
  type Fm3BlockLayout,
  type Fm3LayoutPage,
  type Fm3LayoutControl,
} from './layouts.generated.js';
// Foot Controller (effectId 199) address model: (layout, view, switch) + field
// -> paramId, plus the per-category function/slot-role vocabulary. See
// `footController.ts` and `fcFunctions.ts` for the evidence chain.
export {
  FM3_FC_EFFECT_ID,
  FM3_FC_SWITCHES,
  FM3_FC_VIEWS,
  FM3_FC_LAYOUTS,
  FM3_FC_CONFIGS_PER_LAYOUT,
  FM3_FC_CONFIGS,
  FM3_FC_LABEL_LEN,
  FM3_FC_PARAMS_WIDTH,
  FM3_FC_FIELDS,
  FM3_FC_CATEGORIES,
  FM3_FC_COLORS,
  FM3_FC_LABEL_MODES,
  fm3FcConfigIndex,
  fm3FcParamId,
  fm3FcDecodeLabel,
  fm3FcEncodeLabel,
  type Fm3FcField,
  type Fm3FcFieldDef,
} from './footController.js';
export {
  FM3_FC_FUNCTIONS,
  FM3_FC_CHANNELS,
  fm3FcFunctions,
  type Fm3FcSlotType,
  type Fm3FcSlot,
  type Fm3FcFunctionDef,
} from './fcFunctions.js';
// Modifier (effectId 3, 32 slots) parameter map: field -> paramId, target-block
// binding, and the modulation-source enumeration. See `modifiers.ts` for which
// fields are wire-confirmed vs. editor-config-derived.
export {
  FM3_MOD_EFFECT_ID,
  FM3_MOD_SLOT_COUNT,
  FM3_MOD_SOURCE_PEDAL1,
  FM3_MOD_SOURCES,
  FM3_MOD_FIELDS,
  fm3ModSlotEid,
  fm3ModParamId,
  fm3ModBindFrames,
  type Fm3ModField,
  type Fm3ModFieldDef,
} from './modifiers.js';
// Block & parameter help — shared gen-3 catalog + FM3-specific overrides.
export { FM3_HELP_OVERRIDES } from './help.js';
export {
  GEN3_HELP,
  GEN3_COMMON_PARAM_HELP,
  blockHelpFor,
} from '../help.js';
export {
  resolveHelp,
  type BlockHelp,
  type ParamHelp,
  type BlockHelpEntry,
  type HelpCatalog,
  type BlockHelpOverride,
  type HelpOverrides,
} from '../helpTypes.js';
