export { FM3_PARAMS, FM3_PARAMS_BY_FAMILY, FM3_FAMILIES } from './params.js';
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
// Device-true FM3 data (FM3 editor, firmware 12.0), vendored from
// sKuhLight/forgefx-midi (Apache-2.0). Ranges carry the display bounds and the
// typecode taper field; rosters are the device's own model lists; modifiers is
// the 32-slot modifier / scene-controller map.
export { FM3_RANGES, FM3_RANGE_SECTIONS, FM3_UNMAPPED_SECTIONS, type Fm3ParamRange } from './ranges.generated.js';
export { FM3_ROSTERS, type Fm3TypeModel } from './rosters.generated.js';
export * from './modifiers.js';
