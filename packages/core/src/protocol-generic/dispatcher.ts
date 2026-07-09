/**
 * BK-051 dispatcher — barrel re-export.
 *
 * Implementation is split across per-family modules under
 * `src/protocol/generic/dispatcher/`:
 *
 *   - `core.ts`        — port resolution (`requireDevice`) + connection
 *                        setup (`openCtx`). Step-1 and step-5 of the
 *                        6-step request lifecycle.
 *   - `resolvers.ts`   — block / param / channel name resolution +
 *                        display→wire value encoding. Steps 3 and 4.
 *                        Also exports the pure-side `encodeSetParam`
 *                        used by goldens.
 *   - `discovery.ts`   — `describeDevice`, `listParams`,
 *                        `executeLookupLineage`. Pure introspection.
 *   - `params.ts`      — `executeSetParam`, `executeGetParam`,
 *                        `executeSetParams`, `executeGetParams`.
 *   - `layout.ts`      — `executeSetBlock`, `executeSetBypass`.
 *   - `navigation.ts`  — `executeSwitchPreset`, `executeSavePreset`,
 *                        `executeSwitchScene`, `executeRename`,
 *                        `executeScanLocations`.
 *   - `preset.ts`      — `executeApplyPreset`, `executeApplySetlist`.
 *
 * Consumers continue to import from `@/protocol/generic/dispatcher.js`;
 * the per-family layout is an internal detail. The 6-step request
 * lifecycle (Session 63 design §3) is preserved verbatim — each
 * execute wrapper runs:
 *
 *   1. resolveDevice(port) → descriptor                       [core]
 *   2. capability gate (e.g. has_scenes for switch_scene)     [per family]
 *   3. argument normalization (block / param / channel)       [resolvers]
 *   4. value validation + display→wire encoding               [resolvers]
 *   5. ensureConnection(label)                                [core]
 *   6. hand-off to descriptor.writer / descriptor.reader      [per family]
 */

export { openCtx, requireDevice } from './dispatcher/core.js';
export {
  encodeSetParam,
  encodeValue,
  resolveBlockName,
  resolveChannel,
  resolveParamName,
  type EncodedSetParam,
} from './dispatcher/resolvers.js';
export {
  describeDevice,
  executeDescribeRig,
  executeLookupLineage,
  findCompatibleTypes,
  listParams,
  type ListParamsEntry,
  type RigDevice,
} from './dispatcher/discovery.js';
export {
  executeGetParam,
  executeGetParams,
  executeSetParam,
  executeSetParams,
} from './dispatcher/params.js';
export { executeSetBlock, executeSetBypass } from './dispatcher/layout.js';
export {
  executeRename,
  executeSavePreset,
  executeScanLocations,
  executeSwitchPreset,
  executeSwitchScene,
} from './dispatcher/navigation.js';
export {
  executeApplyPreset,
  executeApplySetlist,
  executeExportActivePreset,
  executeExportStoredPreset,
  executeGetPreset,
  executePortPreset,
  executeReadSampleDirectory,
  executeRestorePreset,
  type PortPresetResult,
} from './dispatcher/preset.js';
export {
  collectApplyPresetErrors,
  collectApplyPresetPreflight,
  type PreflightResult,
} from './dispatcher/preflight.js';
export {
  dispatchSetModRoute,
  dispatchSetMacroRoute,
  type SetModRouteArgs,
  type SetMacroRouteArgs,
} from './dispatcher/navigation-modroute.js';
export { resetModRouteState } from './dispatcher/modRouteState.js';
export {
  executeApplyPattern,
  executeListPatternRecipes,
  type ApplyPatternArgs,
  type ApplyPatternResult,
  type ListPatternRecipesResult,
} from './dispatcher/patterns.js';
