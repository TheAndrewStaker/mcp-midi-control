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
