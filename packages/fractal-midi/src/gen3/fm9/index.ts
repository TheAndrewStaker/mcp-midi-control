export { FM9_PARAMS, FM9_PARAMS_BY_FAMILY, FM9_FAMILIES } from './params.js';
export { FM9_ENUM_OVERRIDES } from './enumOverrides.js';
export {
  FM9_RANGES,
  FM9_RANGE_SECTIONS,
  FM9_UNMAPPED_SECTIONS,
  type Fm9ParamRange,
  type Fm9RangeFamilyMeta,
} from './ranges.generated.js';
// Roundtrip-derived discrete-ordinal overlay (param firmware symbol -> maxOrdinal).
// Params the editor-cache enum path missed but the device treats as ORDINALS;
// routed DISCRETE instead of continuous so the device stores the right ordinal.
export { FM9_ROUNDTRIP_DISCRETE } from './roundtripDiscrete.generated.js';
// CABINET factory cab/IR rosters (FM9-Edit cache, cross-validated across six
// firmware walks) + name -> (bank, TYPE ordinal) resolution. BANK-CONDITIONED
// data: deliberately NOT flat enum_values on CABINET_TYPEn — see cabResolve.ts.
export {
  FM9_CAB_BANK_NAMES,
  FM9_CAB_FACTORY1_ROSTER,
  FM9_CAB_FACTORY2_ROSTER,
  FM9_CAB_LEGACY_ROSTER,
  FM9_CAB_ROSTERS_BY_BANK,
} from './cabRosters.generated.js';
export { resolveFm9CabName, type Fm9CabMatch } from './cabResolve.js';
