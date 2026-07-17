/**
 * @mcp-midi-control/boss-rc
 *
 * Boss RC looper family support. Ships the pure `.RC0` storage codec (byte-exact,
 * dialect-agnostic) + the RC-505mk2 field dictionary and author helpers, the
 * storage transport layer (mounted-drive discovery + A/B `<count>` memory
 * read/write), and the hybrid device descriptor (live memory recall + CC-driven
 * looper control on the RX CTL channel, plus mass-storage `.RC0` memory reading /
 * Assign authoring). Sibling configs (RC-600 / RC-500 / RC-505mk1) come as added
 * configs to the shared factory.
 */

export * from './codec/rc0.js';
export * from './codec/mk2.js';
export * as rc600 from './codec/rc600.js';
export * from './storage/discovery.js';
export * from './storage/memoryStore.js';
export * from './descriptor.js';
