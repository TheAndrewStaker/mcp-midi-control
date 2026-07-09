// Barrel for fractal-midi/am4.
//
// Public surface for AM4 data and codec. Sibling subpaths (`./shared`,
// future `./axe-fx-ii`, `./axe-fx-iii`) follow the same shape: param
// dictionary + block-type table + wire builders + parsers.
//
// Pure code — no MIDI transport dependency. Bring your own.

// Data — parameter dictionary, block-type table, location parsing.
export {
  KNOWN_PARAMS,
  PARAM_ALIASES,
  SCENE_MIDI_TYPE_ENUM,
  encode,
  decode,
  internalFromDisplay,
  formatDisplay,
  roundDisplayValue,
  formatUnitSuffix,
  resolveEnumValue,
  findEnumCandidates,
} from './params.js';
export type { Param, ParamKey, Unit } from './params.js';
export {
  RAW_INT_NONE_SENTINEL,
  isRawIntRegister,
  rawIntRegisterHasNone,
  decodeRawIntRegister,
  encodeRawIntRegister,
} from './midiRegisters.js';
export {
  PARAM_NAMES,
} from './paramNames.js';
export type { ParamNameEntry } from './paramNames.js';
export {
  GENERATED_PARAM_NAMES,
  GENERATED_PARAM_NAMES_FIRMWARE,
} from './paramNamesGenerated.js';
export {
  BLOCK_TYPE_VALUES,
  BLOCK_NAMES_BY_VALUE,
  resolveBlockType,
} from './blockTypes.js';
export type { BlockTypeName } from './blockTypes.js';
export {
  buildBlockLayoutSnapshot,
  isBlockPlaced,
} from './blockLayout.js';
export type { BlockLayoutSnapshot } from './blockLayout.js';
export {
  parseLocationCode,
  formatLocationCode,
  formatLocationDisplay,
  TOTAL_LOCATIONS,
} from './locations.js';

// Codec — wire-byte builders + parsers.
export {
  AM4_MODEL_ID,
  buildSetFloatParam,
  buildSetParam,
  buildSetParamNorm,
  buildNudgeParam,
  buildToggleBlockBypass,
  buildSetBlockType,
  buildSetBlockBypass,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchScene,
  buildSwitchPreset,
  buildSaveToLocation,
  buildGetPresetName,
  buildGetAllParams,
  buildReadParam,
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  isCommandAck,
  isWriteEcho,
  isReadResponse,
  isReadResponseLong,
  parseReadResponse,
  parseLongReadBypassFlag,
  parseGetPresetNameResponse,
  BLOCK_SLOT_PID_LOW,
  BLOCK_SLOT_PID_HIGH_BASE,
  READ_TYPE_LONG,
  LONG_READ_BYPASS_FLAG_BYTE,
  READ_VALUE_DENOMINATOR,
  PRESET_NAME_EMPTY_SENTINEL,
} from './setParam.js';
export type { ParamId, ReadResponse, GetPresetNameResponse } from './setParam.js';

// Preset binary — field decoders for the 12,352-byte stored-form
// (active export + factory bank slices).
export {
  AM4_PRESET_FRAME_SIZE,
  AM4_PRESET_NAME_OFFSET,
  AM4_PRESET_NAME_WIRE_LENGTH,
  AM4_PRESET_NAME_CHAR_COUNT,
  decodeAm4PresetName,
  encodeAm4PresetName,
  decodeAm4PresetNameFromFrame,
} from './presetBinary.js';

// Preset CONTAINER decode — the 0x77/0x78/0x79 dump body IS the gen-3
// preset container (4 chunks, 8,192-byte raw_patch): CRC-validated,
// footer-XOR-checked, Huffman-decompressed. Body field map partial.
export {
  AM4_CONTAINER_CHUNK_COUNT,
  AM4_RAW_PATCH_SIZE,
  AM4_RAW_PATCH_NAME_OFFSET,
  AM4_RAW_PATCH_NAME_LENGTH,
  AM4_RAW_PATCH_MAGIC,
  AM4_CHUNK_DISCRIMINATOR,
  AM4_FW_WORD_1P01,
  AM4_FW_WORD_2P00,
  AM4_SCENE_COUNT,
  AM4_BODY_SCENE_NAME_OFFSET,
  AM4_BODY_SCENE_RECORD_STRIDE,
  AM4_BODY_SCENE_NAME_LENGTH,
  AM4_BODY_AMP_GAIN_CHA_OFFSET,
  AM4_BODY_VOLATILE_WORD_OFFSET,
  parseAm4PresetDump,
  decodeAm4RawPatch,
} from './presetContainer.js';
export type { ParsedAm4PresetDump, Am4DecodedPreset } from './presetContainer.js';

// Decoded-body block-record chain — walk the body to the AMP block record and
// surface its per-channel (A/B/C/D) param VALUES. Amp block only (validated
// record shape); other blocks stay omitted pending per-block captures.
export {
  AM4_BODY_CHANNEL_STRIDE,
  AM4_BODY_BLOCK_HEADER_BYTES,
  AM4_BODY_AMP_CHANNEL_COUNT,
  locateAm4AmpBlock,
  decodeAm4AmpBlock,
} from './bodyChain.js';
export type { Am4AmpBlockValues } from './bodyChain.js';

// Data tables — cache + type-applicability + enums.
export { CACHE_PARAMS } from './cacheParams.js';
export type { CacheParamKey } from './cacheParams.js';
export {
  AMP_TYPES,
  DRIVE_TYPES,
  REVERB_TYPES,
  DELAY_TYPES,
  CHORUS_TYPES,
  FLANGER_TYPES,
  PHASER_TYPES,
  WAH_TYPES,
  COMPRESSOR_TYPES,
  GEQ_TYPES,
  FILTER_TYPES,
  TREMOLO_TYPES,
  ENHANCER_TYPES,
  GATE_TYPES,
  VOLPAN_MODES,
  TEMPO_DIVISIONS,
  LFO_WAVEFORMS,
  AMP_TYPES_VALUES,
  DRIVE_TYPES_VALUES,
  REVERB_TYPES_VALUES,
  DELAY_TYPES_VALUES,
  CHORUS_TYPES_VALUES,
  FLANGER_TYPES_VALUES,
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  COMPRESSOR_TYPES_VALUES,
  GEQ_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
  VOLPAN_MODES_VALUES,
  TEMPO_DIVISIONS_VALUES,
  LFO_WAVEFORMS_VALUES,
} from './cacheEnums.js';
export {
  TYPE_APPLICABILITY,
  TYPE_APPLICABILITY_FIRMWARE,
} from './typeApplicability.js';
export type { Applicability, ApplicabilityGate } from './typeApplicability.js';
export {
  getApplicability,
  describeApplicability,
  checkApplicability,
  findCompatibleTypes,
} from './applicability.js';
export type { ActiveTypeContext, ApplicabilityCheck } from './applicability.js';

// Editor / bridge labels (RE'd from AM4-Edit binary).
export {
  EDITOR_CONTROLS,
  EDITOR_CONTROL_FIRMWARE,
  EDITOR_CONTROL_PARAMETER_NAMES,
  resolveEditorControlLabel,
} from './editorControlLabels.js';
export type {
  EditorControlContext,
  EditorControlEntry,
} from './editorControlLabels.js';
export { SYMBOLIC_IDS_BY_BLOCK } from './symbolicIds.js';
export {
  PARAMETER_BRIDGE,
  PARAMETER_BRIDGE_FIRMWARE,
  resolveBridge,
  preferredDisplayLabel,
} from './parameterBridge.js';
export type { ParameterBridgeEntry } from './parameterBridge.js';

// Variant resolver — block.parameterName → cache-id mappings.
export {
  VARIANT_RESOLVER_FIRMWARE,
  VARIANT_RESOLVER_BY_EFFECT_TYPE,
  VARIANT_RESOLVER_FALLBACK,
  PARAMETER_NAME_TO_CACHE_ID,
  UNIVERSAL_BLOCK_PARAMETERS,
  resolveCacheId,
  resolveAllCacheIds,
} from './variantResolverTables.js';
export type { ResolverEntry } from './variantResolverTables.js';

// Intermediate representation — preset model + transpiler.
export { transpile } from './ir/transpile.js';
export type { WorkingBufferIR } from './ir/preset.js';

// Shared helpers (paramHelpers — the channel-aware resolver lives in
// the consumer because it needs a MIDI connection).
export {
  DEFAULT_SCRATCH_LOCATION,
  EnumAmbiguityError,
  suggestParamName,
  paramKey,
  resolveValue,
} from './shared/paramHelpers.js';
