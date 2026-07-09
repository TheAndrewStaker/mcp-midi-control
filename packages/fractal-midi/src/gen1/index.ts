// Barrel for fractal-midi/gen1.
//
// Axe-Fx Standard / Ultra (gen-1). Its OWN codec: model byte 0x01, function
// 0x02, every field nibble-split (8-bit -> two nibble bytes, low first), fixed
// 0x01 trailer (no checksum). Independent of the gen-2 (axe-fx-ii, septet-
// packed) and gen-3 (modern, sub-action) codecs.
//
// Wire decoded byte-exactly from the published Ultra SysEx doc + its 0..255
// conversion table; NOT hardware-verified (community-beta).

export * from './types.js';
export * from './nibble.js';
export * from './setParam.js';
export * from './readParam.js';
export * from './patchDump.js';
export * from './params.js';
export * from './blockTypes.js';
