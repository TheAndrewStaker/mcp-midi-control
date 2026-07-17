// Barrel for roland-midi/ve-500 — the Boss VE-500 codec layer.
//
// Pure protocol: device constants, the param catalog (generated from the
// editor's own address map), and the read/write wire builders. No transport.

export {
  VE500_MODEL_ID,
  VE500_DEVICE_ID,
  VE500_TARGET,
  ve500Target,
  TEMP_PATCH_ADDR,
  USER_PATCH_ADDR,
  USER_PATCH_STRIDE,
  NUM_USER_PATCHES,
  NUM_PRESET_PATCHES,
  PC_MIN_USER,
  PC_MAX_USER,
  PC_MIN_PRESET,
  PC_MAX_PRESET,
  userPatchAddr,
} from './model.js';
export {
  findParam,
  blockParams,
  allBlocks,
  VE500_PARAMS,
  VE500_SYSTEM_PARAMS,
} from './catalog.js';
export type { Ve500ParamDef } from './catalog.generated.js';
export {
  buildSetParam,
  buildGetParam,
  decodeParam,
  decodeParamReply,
  paramReplyMatcher,
} from './setParam.js';
export type { WireOptions } from './setParam.js';
export {
  buildSavePreset,
  buildCommMode,
  buildSetPatchName,
  saveAckMatcher,
} from './save.js';
export { buildSwitchPatch, CURRENT_PATCH_ADDR } from './patch.js';
