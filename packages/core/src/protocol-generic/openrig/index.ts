/**
 * OpenRig Phase C: the server-side surface that binds the zero-dependency
 * `openrig` package to this reference implementation (the descriptor -> seed
 * adapter and the rig-manifest loader). The domain model, validator, and JSON
 * schema live in the `openrig` package itself.
 */
export { descriptorToSeed, bootstrapRigFromRegistry } from './adapter.js';
export { descriptorCapabilityLookup } from './capabilities.js';
export { onRigStoreWrite, emitRigStoreWrite, type RigStoreWrite } from './events.js';
export { executeRigEdit, type RigEditExecResult } from './edit.js';
export { buildRigEditOp, RIG_EDIT_SCHEMA, type RigEditArgs } from './editArgs.js';
export {
  loadRigInventory,
  clearRigInventoryCache,
  RIG_INVENTORY_ENV,
  type LoadedInventory,
} from './inventory.js';
export {
  loadRigManifest,
  invalidateRigManifest,
  clearRigManifestCache,
  writeRigManifest,
  createRigManifest,
  rigManifestSource,
  loadedRigManifestStamp,
  RigManifestChangedError,
  RIG_MANIFEST_ENV,
  type LoadedRigManifest,
} from './manifest.js';
export {
  loadRepertoire,
  clearRepertoireCache,
  buildRepertoireSummary,
  executeSetlistPlan,
  executeSongPlan,
  RIG_REPERTOIRE_ENV,
  REPERTOIRE_LIST_MAX,
  type LoadedRepertoire,
  type RepertoireSummary,
  type SongPlanResponse,
} from './repertoire.js';
export { stampFile, sameStamp, type FileStamp } from './fileStamp.js';
