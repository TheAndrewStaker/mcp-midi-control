/**
 * OpenRig Phase C: the server-side surface that binds the zero-dependency
 * `openrig` package to this reference implementation (the descriptor -> seed
 * adapter and the rig-manifest loader). The domain model, validator, and JSON
 * schema live in the `openrig` package itself.
 */
export { descriptorToSeed, bootstrapRigFromRegistry } from './adapter.js';
export { descriptorCapabilityLookup } from './capabilities.js';
export { executeRigEdit, type RigEditExecResult } from './edit.js';
export {
  loadRigInventory,
  clearRigInventoryCache,
  RIG_INVENTORY_ENV,
  type LoadedInventory,
} from './inventory.js';
export {
  loadRigManifest,
  clearRigManifestCache,
  writeRigManifest,
  rigManifestSource,
  RIG_MANIFEST_ENV,
  type LoadedRigManifest,
} from './manifest.js';
