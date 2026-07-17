// Barrel for the Axe-Fx II preset-image encode-lane codec.
//
// One family per file:
//   frames.ts         dump frame codec + image buffer + footer hash
//   tlv.ts            strict TLV chain walk + bounded word accessors
//   grid.ts           grid + routing cell matrix (words 34..129)
//   discretePatch.ts  rostered-select ordinal word patch
//   sceneWords.ts     per-scene bypass / channel-Y state words
//   structure.ts      chain splice: PLACE / REMOVE a block
//   defaultRecords.ts generated corpus data (modal records, len census)
//   dumpOps.ts        dump-level wrappers (round-trip gate + footer)
//
// Everything here is Q8.02 / XL+ scoped and community-beta /
// hardware-unverified on the push side; see per-module docstrings.

export * from './frames.js';
export * from './tlv.js';
export * from './grid.js';
export * from './discretePatch.js';
export * from './sceneWords.js';
export * from './structure.js';
export * from './defaultRecords.js';
export * from './dumpOps.js';
