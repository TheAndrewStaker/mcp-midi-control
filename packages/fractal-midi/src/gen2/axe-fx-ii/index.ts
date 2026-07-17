// Barrel for fractal-midi/gen2/axe-fx-ii.
//
// Public surface for Axe-Fx II family data + codec. The II family uses
// a different wire envelope from the AM4 (function 0x02 GET/SET_BLOCK_
// PARAMETER_VALUE with 16-bit values packed across three 7-bit septets,
// vs. the AM4's function 0x01 with 14-bit pidLow/pidHigh + 32-bit float
// payload). The codec is independent — don't expect AM4 builders to
// interoperate.
//
// Hardware-verified on Axe-Fx II XL+ firmware Quantum 8.02.
//
// We re-export everything from each underlying module so this barrel
// can grow without churn as new helpers land. Curate later if a name
// conflict surfaces.

export * from './params.js';
export * from './blockTypes.js';
export * from './paramAliases.js';
export * from './setParam.js';
export * from './opcodes.js';
export * from './typeApplicability.js';
export * from './applicability.js';
export * from './presetImage/index.js';
