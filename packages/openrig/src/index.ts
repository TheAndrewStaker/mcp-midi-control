/**
 * OpenRig: a portable schema for a musician's rig. L1 (topology) surface.
 *
 * This package is the reference implementation of the OpenRig spec, incubating
 * inside the mcp-midi-control monorepo (design doc: docs/design/OPENRIG-SCHEMA.md).
 * Pure TypeScript, zero runtime dependencies, authored to be extractable to a
 * standalone `openrig` repo at graduation (spec §9).
 */
export * from './types.js';
export * from './routing.js';
export * from './validate.js';
export * from './compat.js';
export * from './audio.js';
export * from './capacity.js';
export * from './attach.js';
export * from './edit.js';
export * from './inventory.js';
export * from './bootstrap.js';
export * from './cytoscape.js';
export { LOOPER_HUB_RIG } from './examples/looperHub.js';
