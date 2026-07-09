// Barrel for fractal-midi/gen3/axe-fx-iii.
//
// **Status: 🟡 community beta.** The III protocol layer is scaffolded
// from Fractal's published "Axe-Fx III MIDI for Third-Party Devices"
// v1.4 PDF and the AxeEdit III editor assets. Wire envelopes are
// byte-verified against 10 public captures (FC-12 and a public
// forum capture); per-effect param-ID calibration is sparse (~11%) because
// Fractal deliberately omits per-block param IDs from the public
// spec. Use with that caveat.

// Data — block roster + flat param table (2017 params from AxeEdit
// III's `__block_layout.xml` mining).
export {
  AXE_FX_III_BLOCKS,
  resolveBlock,
  resolveEffectId,
} from './blockTypes.js';
export type { AxeFxIIIBlock, ConfidenceTag } from './blockTypes.js';
export { PARAMS, PARAMS_BY_FAMILY, PARAM_BY_KEY, FAMILIES } from './params.js';
export type { Unit, Param } from './params.js';

// Roundtrip-derived discrete-ordinal overlay (param firmware symbol -> maxOrdinal).
// Params the editor-cache enum path missed but the device treats as ORDINALS;
// routed DISCRETE instead of continuous so the device stores the right ordinal.
export { III_ROUNDTRIP_DISCRETE } from './roundtripDiscrete.generated.js';

// Enum vocabulary overlay — universal Fractal conventions + AM4-
// verified shared symbols + III-specific direct overrides. See
// `enumOverlay.ts` for evidence chain and provenance tagging.
export { resolveEnumValues, resolveEffectTypeEnum, enumOverlayStats } from './enumOverlay.js';
export type { EnumOverlayEntry, EnumProvenance } from './enumOverlay.js';

// Gen-3 enum set-by-name resolver: name → read-roster ORDINAL (the float32(ordinal)
// set value). The ordinal IS the set value; there is no raw-id space. See `enumRawId.ts`.
export {
  resolveGen3EnumOrdinal,
  normalizeLabel,
  enumLabelForms,
} from './enumRawId.js';
export { GEN3_READ_ROSTERS, mergeGen3EnumOverrides } from './gen3ReadRosters.js';

// Codec — wire-byte builders + parsers. Function-code constants
// re-exported for callers building custom envelopes.
export {
  AXE_FX_III_MODEL_ID,
  FN_SET_GET_BYPASS,
  FN_SET_GET_CHANNEL,
  FN_SET_GET_SCENE,
  FN_QUERY_PATCH_NAME,
  FN_QUERY_SCENE_NAME,
  FN_SET_GET_LOOPER,
  FN_TEMPO_TAP,
  FN_TUNER_ON_OFF,
  FN_STATUS_DUMP,
  FN_SET_GET_TEMPO,
  FN_MULTIPURPOSE_RESPONSE,
  FN_PARAMETER_SETGET,
  QUERY_SENTINEL,
  packValue16,
  unpackValue16,
  pack5Septet32,
  unpack5Septet32,
  decode5SeptetFloat32,
  encode5SeptetFloat32,
  SUB_ACTION_SET_CONTINUOUS,
  parseGen3SetValueEcho,
  buildSetParameter,
  buildSetParameterContinuous,
  buildGetParameter,
  buildRequestCurrentTypeName,
  SUB_ACTION_GET_TYPE_NAME,
  buildSetParameterBypass,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
  isGetParameterResponse,
  parseGetParameterResponse,
  buildSetGridCell,
  buildSetGridRouting,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT,
  SUB_ACTION_CLEAR_BLOCK,
  SUB_ACTION_CLEAR_BLOCK_COMPANION,
  buildClearBlock,
  buildClearBlockCompanion,
  SUB_ACTION_SET_PRESET_NAME,
  SUB_ACTION_SET_SCENE_NAME,
  buildRenamePreset,
  buildSetSceneName,
  buildClearAllSceneNames,
  FN_SCENE_BLOB_HEADER,
  FN_SCENE_BLOB_CHECKSUM,
  buildSceneBlobHeader,
  buildSceneBlobChecksum,
  xorChecksum32Words,
  buildSetPresetName,
  buildStorePreset,
  buildSwitchPresetPC,
  buildSwitchPresetSysEx,
  SUB_ACTION_SWITCH_PRESET,
  buildSetBypass,
  buildGetBypass,
  buildSetChannel,
  buildGetChannel,
  buildSetScene,
  buildGetScene,
  buildQueryPatchName,
  buildQuerySceneName,
  buildSetLooper,
  buildGetLooperState,
  buildTempoTap,
  buildSetTuner,
  buildStatusDump,
  buildSetTempo,
  buildGetTempo,
  isSetGetBypassResponse,
  isSetGetChannelResponse,
  isSetGetSceneResponse,
  isQueryPatchNameResponse,
  isQuerySceneNameResponse,
  isSetGetLooperResponse,
  isStatusDumpResponse,
  isSetGetTempoResponse,
  isMultipurposeResponse,
  parseBypassResponse,
  parseChannelResponse,
  parseSceneResponse,
  parseQueryPatchNameResponse,
  parseQuerySceneNameResponse,
  parseLooperStateResponse,
  parseTempoResponse,
  parseMultipurposeResponse,
  describeMultipurposeResultCode,
  parseStatusDumpResponse,
  parseStateBroadcast,
  parseGen3StateBroadcastHead,
  parseGen3StateBroadcastBody,
  buildBlockBulkReadPoll,
  buildRequestPresetDump,
  isGen3BroadcastFrame,
  assembleGen3BlockBulkRead,
  FN_BLOCK_BULK_READ,
  FN_REQUEST_PRESET_DUMP,
  createModernFractalCodec,
} from './setParam.js';
export type {
  LooperAction,
  LooperState,
  StatusDumpEntry,
  AxeFxIIIParameterFrameKind,
  Gen3BlockBulkRead,
  ModernFractalCodec,
  Gen3BankSelectMode,
} from './setParam.js';

// Live routing-grid read (fn=0x01 sub=0x2E). Cross-validated against our
// FM9 capture vs blockTypes.ts; community beta. See `gridLayout.ts`.
export {
  SUB_ACTION_GRID_LAYOUT,
  GRID_COLS,
  buildRequestGridLayout,
  parseGen3GridLayout,
} from './gridLayout.js';
export type { Gen3GridLayoutCell } from './gridLayout.js';

// Live telemetry (CPU + stereo output meters) carried in the SAME fn=0x01
// sub=0x2E frame as the routing grid. FM9-cross-validated; community beta.
// See `liveMeters.ts` for the evidence chain and the omitted-input rationale.
export { parseGen3LiveMeters } from './liveMeters.js';
export type { Gen3LiveMeters } from './liveMeters.js';

// Per-amp-model valid-DISTORT-param table (powers findCompatibleTypes for the
// amp block). See `ampTypeValidParams.generated.ts`.
export {
  AMP_TYPE_VALID_PARAMS,
  AMP_ALL_PARAMS,
  ampOrdinalsExposingParams,
} from './ampTypeValidParams.generated.js';
